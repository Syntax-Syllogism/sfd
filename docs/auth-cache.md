---
title: Auth and cache invalidation
description: "How the daemon decides when cached orgs, connections, traces, metadata types, safety types and plugin worker connections are dropped: the auth stamp, the global and per-username scopes, the read/write gate, and the soak test."
---

Source: `src/org-session.mjs` (`authStamp`, `rwlock`, `invalidate`,
`refreshIfAuthChanged`, `getOrg`, `withConn`), `src/handlers.mjs` (`projectQueue`,
`clearProjects`, and the `sizes` test hook), `src/plugin/supervisor.mjs` (`authChanged`),
`src/plugin/worker.mjs` (the `auth-changed` message) and `src/daemon.mjs` (the
`onAuthChanged` wiring). Tests: `test/org-session.test.mjs` (the auth stamp, reload
race, scoped session error and cache-size cases). The soak case runs with
`npm run test:soak`, which passes `--expose-gc`.

## What is cached

| State | Key | Cleared by a global (`all`) invalidation | Cleared by a scoped `{ alias, username }` invalidation |
| --- | --- | --- | --- |
| `orgs` (`Org` objects, which hold connections) | alias | yes | the alias, and any alias for the same username |
| `usernames` (alias to username) | alias | yes | the same keys |
| `traces` (TraceFlag state) | alias | yes | the same keys |
| `typeCache` (metadata type lists) | alias | yes | the same keys |
| `safetyTypes`, `cachedTypes`, `cachedUsernames`, `org-types.json` | username | only on `sfd reload`; an auth change keeps known types and drops alias entries whose alias now names another username | no; org types are kept |
| `apiUsage` (last-seen API usage) | alias or username | yes | no |
| `StateAggregator` instance | process | yes | no |
| `SfProject` instances | process | only through `clearProjects()` | not applicable |
| Plugin worker connections | username | all of them | that username (or all, if the username is unknown) |

Every clear goes through `invalidate(scope)`. Do not add a new direct clear of
these maps elsewhere; add it to `invalidate` so the lock and the plugin
forwarding apply.

## Scopes

- **`"all"`** runs for `sfd reload` and whenever the auth stamp changes.
  `refreshIfAuthChanged` runs at the start of `getOrg` and of `orgList`. The
  global path forwards `onAuthChanged()` with no username, which clears every
  plugin worker connection, then clears every map in the table and calls
  `StateAggregator.clearInstanceAsync()`. Safety types depend on the trigger:
  `sfd reload` calls `clearSafetyTypes()`, while an auth stamp change calls
  `pruneAliases()`. A username's org type never changes, so `pruneAliases()`
  keeps every known (`scratch`, `sandbox`, `production`) username entry, drops
  unknown or pending lookups so they are retried, and removes any alias entry
  whose alias no longer resolves to the recorded username. If the alias file
  cannot be read, it removes every alias entry.
- **Startup.** A new daemon seeds `cachedTypes` and `cachedUsernames` with the
  known types in an existing `org-types.json`, so a restart does not discard
  them. The first `getOrg` or `orgList` call runs `pruneAliases()` before using
  them. The in-process `safetyTypes` lookups are not seeded, so policy checks
  still detect the type once per daemon.
- **`{ alias, username }`** runs when `withConn` sees `INVALID_SESSION_ID` or
  `INVALID_AUTH_HEADER`. The username comes from the `Org` that failed. When the
  failure happened during `Org.create`, the username is unknown, so the alias
  alone is cleared and plugin workers clear all connections. Only that
  username's state goes, and safety types, the `StateAggregator` and the other
  orgs stay. Retry behavior is in [safety.md](safety.md#session-expiry).

## The auth stamp

`authStamp(home)` runs on every `getOrg` and `orgList` call. It is a JSON string
built from:

1. The sorted names of the `*.json` files in `~/.sfdx`. A login adds
   `<username>.json`, a logout removes it, and `alias.json` is in the list too.
2. The `mtime` and `size` of `~/.sfdx/alias.json`, `~/.sf/alias.json`,
   `~/.sf/config.json` and `~/.sfdx/sfdx-config.json`. Each is `null` when the
   file is missing.

It deliberately leaves out the `~/.sfdx` directory mtime, which changes whenever
`@salesforce/core` renames a temp file into place, and it leaves out the
contents of `<username>.json`. Those contents change on every token refresh.
A token refresh rewrites an existing `<username>.json` under the same name, so
it changes nothing the stamp reads and invalidates nothing. The design relies on
the cached `Org` picking up refreshed tokens through `AuthInfo` on its own. That
is `@salesforce/core` behavior, which sfd does not re-check.

Consequences:

- A changed `<username>.json` never invalidates anything, including only that
  user's state. Per-user stamps were considered and rejected, because telling
  our own refresh apart from an external change is not reliable.
- Login, logout, `sf alias set`, and creating or changing `~/.sf/config.json`
  (for example through `sf config set`) all invalidate globally.
- The stat calls and the `readdirSync` run per request, with no watcher. The
  design relies on the handful of entries in these directories being cheap to
  read.

A live check on 2026-11-09 forced a 401 using an invalid in-memory access token
and called `Org.refreshAuth()` against an authenticated org. Core replaced the
token and rewrote the auth file, changing the directory metadata; the JSON
filename list and all four configuration-file stamp inputs remained unchanged.
The fixture test also checks that rewriting an existing auth file does not
invalidate cached orgs. This observation covers the installed core and the
tested org; other core versions or authentication methods may behave differently.

## Read/write gate

`rwlock()` lives in `src/org-session.mjs`. It has two entry points, `read(fn)` and
`write(fn)`:

- Readers are admitted together while no writer is active or queued.
- A queued writer blocks new readers and waits for the active readers to
  finish. Writers come first, so a steady stream of reads cannot starve
  `reload`.

`getOrg` calls `refreshIfAuthChanged()` before it takes the read lock, and the
read lock covers only the cache lookup and the `Org.create` await. The lock is
not held during the operation itself, because deploys can run for 30 minutes.
This ordering matters: calling `invalidate` (a write) from inside a read would
wait on itself and deadlock. So never call `invalidate` while holding the lock.

Effects:

- A global invalidation never runs while an `Org.create` is in flight. It waits
  for the pending creation to settle, and new `getOrg` calls wait until it
  finishes.
- `invalidate` compares the observed stamp again after it gets the write lock.
  Several requests that see the same change therefore clear once.

## Plugin workers

`onAuthChanged(username?)` in the handlers goes to
`supervisor.authChanged(username)`. The supervisor sends each live worker
`{ t: "auth-changed", username }`. The worker deletes that username's cached
connection, or clears all of them when no username is sent. Workers key their
connections by org username, so the host and the worker agree on the key. The
host never sends tokens. Invalidating plugin workers any further than this is
out of scope.

## SfProject guard

`SfProject.clearInstances()` is process-wide, so it is only safe while the
built-in deploy, retrieve and tracking handlers hold the project queue.
`projectQueue` sets a flag while its function runs, and `clearProjects()` throws
`SfProject.clearInstances outside projectQueue` when the flag is not set. All
three handlers call `clearProjects()` inside `withConn`, which is inside the
queued function. Retries therefore stay inside the queue too. A new caller of
`SfProject.clearInstances()` must go through `clearProjects()`.

## Testing and soak

- `test/org-session.test.mjs` covers: the stamp (rewriting an existing `user.json`
  does not invalidate, while adding or removing a `.json` file, changing
  `~/.sfdx/alias.json`, and creating `~/.sf/config.json` or `~/.sf/alias.json`
  each do); a reload waiting for an in-flight `Org.create` while blocking later
  readers, and the `clearProjects()` guard throwing outside the queue; a scoped
  session error that keeps another org's `Org` and all safety types; and the
  soak case.
- The soak case runs 5,000 queries over 20 aliases. Every 500 iterations it
  runs `reload`, every 1,000 it adds a `.json` file to `~/.sfdx`, and every 50 it
  simulates a session error. It asserts that every `sizes()` count stays at or
  below 20. With `global.gc` available (`npm run test:soak`) it also asserts
  that `heapUsed` grows by less than 20 MB between iterations 1,000 and 5,000.
  Plain `npm test` runs the size checks and skips the heap check.
- `sizes()` and `clearProjects` are non-enumerable test hooks on the handlers
  object. Do not rely on them from production code.

## Known limits

- `reload` does not record the stamp it saw. If auth files changed since the
  last request, the next request runs one more global invalidation. The cost is
  one extra clear and one extra `onAuthChanged()`.
- Stamp-triggered global invalidation clears `apiUsage`, as `reload` already
  did. Login, logout and alias changes therefore reset the last-seen usage
  shown by `sfd status`. Session errors do not.
- Any write to `~/.sf/config.json`, not only auth changes, flushes every org's
  caches. It is a rare write and the cost is one reconnect per org.
- The read lock is held across `Org.create`. A slow creation holds back a
  queued `reload`, and any `getOrg` that arrives after that `reload` waits
  behind it as well.

## Changing this area

Read this doc, then `docs/safety.md#session-expiry` if you change retries, and
`docs/request-limits.md` if you change `apiUsage`. Keep the table above, the
`invalidate` branches and the `authStamp` comment in step. Keep the test names
that describe the stamp inputs accurate, because the test names are the
behavior record.
