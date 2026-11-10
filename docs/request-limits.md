---
title: Request limits
description: "How sfd bounds Salesforce API fan-out, retries reads that hit a request limit, and reports the last-seen API usage per org."
---

How sfd bounds Salesforce API fan-out, retries read calls that hit a request
limit, and reports the last-seen API usage per org. Source: `src/limit.mjs`
(`limiter`, `withBackoff`, `LIMIT_ERRORS`), `src/org-session.mjs` (`withConn`),
`src/ops/` (`org-list.mjs`, `list-metadata.mjs`, `status.mjs`, `reload.mjs`), and the `status` branch of `run()`
in `bin/sfd.mjs`. Tests: `test/limit.test.mjs`, and in `test/ops-org.test.mjs`,
`test/ops-metadata.test.mjs` and `test/org-session.test.mjs` the cases "org list holds timed-out slots until the work settles", "metadata
listing bounds concurrent chunks" and "limit retries apply to reads and usage is
reported and cleared".

## Bounded fan-out

| Path | Concurrency | Scope |
| --- | --- | --- |
| `org list --status`: non-scratch refresh checks and Dev Hub `ScratchOrgInfo` queries, combined | 4 | One `orgList` call |
| `list-metadata`: one `metadata.list` per chunk of three types | 2 | One `listMetadata` call |

- `limiter(max)` in `src/limit.mjs` returns `run(fn)`. It queues work and starts
  it when a slot is free. Metadata listing drains all chunks before retrying,
  keeping their results in order and the bound across attempts.
- In `--status`, the 10 s deadline starts when a check starts, not when it is
  queued. With 40 non-scratch orgs the worst case is `ceil(40 / 4) × 10 s`,
  about 100 s, which is inside the 120 s minimum request timeout in
  `src/client.mjs`.
- A timed-out check reports `Timeout` at its deadline, but keeps its slot until
  the underlying call settles. A later exhausted Dev Hub limit is logged by the
  daemon.
- The bound applies only to these two fan-outs. It is not a global per-org
  limiter. Plugin workers use their own connections and are not covered.

## Retrying limit errors

The limit errors are `REQUEST_LIMIT_EXCEEDED`, `ConcurrentPerOrgLongTxn` and
`ExceededQuota` (`LIMIT_ERRORS`). They are matched on `errorCode`, then `name`.

- `withConn` runs the call through `withBackoff` when its `backoff` option is
  true. `backoff` defaults to `retry`, so every call that passes `retry: true`
  also backs off.
- Up to two retries, three attempts in all. Before retry *n* the daemon waits
  `1000 ms × 3^n × (0.7 + 0.6 × random)`, so about 1 s and then 3 s, each within
  ±30%.
- Backed-off calls: `query`, `describe`, `org`, `listMetadataTypes`,
  `listMetadata`, `tracking`, `logs`, `logGet`, and `rest` when the method is a
  read, plus Dev Hub `ScratchOrgInfo` queries in `org list`.
- Not backed off: `apex`, `deploy`, `retrieve`, `rest` writes, and `test`
  (`backoff: false`, since Apex test execution polls on its own). The non-scratch
  `org list --status` refresh checks do not back off; a limit error there becomes
  the org's status, which is the error name.
- Session retry is a separate rule governed by the same `retry` option. See
  [Safety policy](safety.md#session-expiry).
- Every limit error that leaves `withConn` is decorated, including errors that
  were not retried. A missing code is prefixed to the message (`CODE: ...`), and
  the usage is appended when known: `(API usage 42/100)`. The error keeps its
  `name` and `errorCode`.

## API usage

- After each `withConn` call, success or failure, the daemon copies
  `conn.limitInfo.apiUsage` into an in-memory map. The key is the org alias, or
  the username when no alias was given.
- `sfd status` adds an `API usage: <org> <used>/<limit>, ...` line after the log
  path, but only when at least one org has reported usage. `sfd status --json`
  always includes `apiUsage`, an object keyed by org that is empty when nothing
  has been seen.
- The values are last seen, not live. A global invalidation clears them: `sfd
  reload`, or a login, logout, alias or config change. A session error for one
  org does not. Stopping the daemon discards them. See
  [auth-cache.md](auth-cache.md). Nothing is written to disk, so the map holds no tokens.
- Usage never refuses a call. There is no proactive throttling.

## Known limits

- A call that never settles holds its limiter slot indefinitely. Queued
  `--status` checks wait behind it. This follows the four-call bound. The
  alternative, releasing the slot after 30 s, was considered and not adopted.
- The limit error names and the `limitInfo.apiUsage` property are checked only
  against mocked connections in the test suite. Confirm them against a live org
  when one is available.

## Changing this area

- Keep `LIMIT_ERRORS` in step with the codes that `withBackoff` matches.
- A new read path that should back off passes `retry: true`. A call that must
  not be replayed passes `retry: true, backoff: false` only with a reason written
  next to it, as `test` does. Writes never back off.
- Create a new `limiter` per operation call, so each bound is per fan-out.
- Keep `sleep` and `random` injectable, as `withBackoff` does, so tests stay fast
  and deterministic.
- Keep the summaries in [Safety policy](safety.md#request-limits), the
  `sfd status` line in the README, and the concurrency numbers in
  [Org list](org-list.md#--status) and [Metadata listing](metadata-list.md) in
  step with the code.
