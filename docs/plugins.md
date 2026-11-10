---
title: Plugins
description: "sfd runs experimental v0 plugin operations in isolated warm worker processes."
---

sfd runs experimental v0 plugin operations in isolated warm worker processes.

## Commands

```sh
sfd plugin init [<plugin-root>] [--ops <id,…>] [--write]
sfd plugin list
sfd plugin list --json
sfd op warden.access --options-json '{"users":["a@b.c"]}' -o warden-dev
sfd op example.change --options-json @options.json --plan
```

Use `sfd plugin init --help` for generator usage and `sfd help plugin-api`
for the authoring guide. `plugin init` is not a separate `sfd help` topic.

`--options-json` accepts JSON, `@file` relative to the caller's directory, or
`-` for stdin. Without it, options are `{}`. Org selection uses `-o`,
`SF_TARGET_ORG`, local sf config, then global sf config. Operations declaring
`requiresOrg: none` do not load auth, even when a default org is configured.
Required orgs without a target produce a usage error.

Reads run directly. Writes plan and apply in one request; `--plan` returns only
the plan. Both the worker and host reject effects outside the descriptor's
ceiling before applying. The host then evaluates the [safety policy](safety.md)
using the detected org type and exact plan. Production writes require
`--confirm <hash>`; `--plan` returns the plan and policy decision, including an
approval hash when needed. `--plan` on a read exits 2.

Default output is compact JSON data. Warnings and a truncation trailer go to
stderr; plain plans print warnings before the `policy:` line. `--json` prints the
complete `{ok,data,warnings,...}` or
`{ok:false,code,message,actions,retryable}` envelope. Failures exit 1 and usage
errors exit 2. A success with `failures > 0` (reported through
`ctx.reportFailures`, see [plugin API](plugin-api.md)) also exits 1. It still
prints its data and warnings, and plain mode adds a `failed: <n> item(s)` line
to stderr. Approval requirements and policy denials exit 4 and print the
status-4 shapes described in [safety policy](safety.md), not the envelope.
Plugin list shows roots, versions, operation IDs, effects, worker state, RSS and
validation problems; `--json` returns full objects.

## Discovery

Only installed sf plugins with an `sfd` manifest are eligible. Discovery reads
sf's data directory `package.json`, without importing plugin code: dependencies
resolve under its `node_modules`, and `oclif.plugins[].root` includes linked
plugins. Roots are deduplicated by real path. `SF_DATA_DIR` overrides the
registry path; otherwise Linux/macOS use `${XDG_DATA_HOME:-~/.local/share}/sf`
and Windows uses `%LOCALAPPDATA%/sf`. These are host lookup conventions;
set the override if the sf installation uses another registry location.

- `SFD_PLUGIN_PATHS`: additional plugin roots, separated by the platform path
  delimiter (`:` on POSIX, `;` on Windows). Explicit roots take precedence.
- `SFD_PLUGIN_PATHS_ONLY=1`: ignore the sf registry and use only explicit roots.
- `SFD_PLUGIN_IDLE_MINUTES`: worker idle lifetime, default 30 minutes.

The operations module must stay within the real plugin root, including through
symlinks. Manifest `requires.sfd` supports only `>=x.y.z` in v0. Invalid
manifests and unsupported ranges appear as problems in plugin list and cannot
run. Duplicate IDs use the first discovered plugin; list reports conflicts.
A matching package name speeds initial lookup; unrecognized namespaces require
searching descriptors from other plugins. Earlier candidates are checked before
accepting an ID so duplicate ownership follows discovery order. Registry
discovery is cached until registry/package metadata changes; list forces a fresh
scan, and every operation still checks its module mtime.

## Direct commands and agent integration

A plugin declaring `sfd.cli` exposes its static `cli.json` commands directly,
for example `sfd echo say --text hi`. Flags map to operation option keys;
integers must be safe integers, file/directory values resolve from the caller's
cwd, and repeated flags build arrays. Required flags and unknown flags produce
usage errors. Host flags include `-o`/`--target-org`, `--api-version`,
`--confirm`, `--json`, `--plan`, `--quiet` and `-h`/`--help`. Direct commands
pass the same safety gate as `op`: exit code 4 with a `--confirm` hash. A
`cli.json` table cannot declare `confirm`, and rewritten sf commands never
carry it. Built-in namespaces win collisions;
otherwise the first discovered command wins. `plugin list` reports conflicts
and invalid tables. Operations without a valid table still work through `op`.

`sfd help` groups direct commands by plugin. `sfd help echo say` and
`sfd echo say --help` show flags and summary. Effects and descriptor summaries
are cached when `sfd plugin list` runs; a cold cache directs readers there for
effects. `sfd help echo` lists that namespace's commands. Help never imports
plugin code or starts a daemon.

`agents-snippet` preserves the built-in block when there are no plugin
commands. With plugins, it adds a separate budget: six commands per plugin and
20 overall, sorted by package name, with omitted commands summarized through
`sfd help <namespace>`. This adds lines beyond the built-in 15-line budget.

The rewrite hook appends plugin sf mappings after built-ins, preserving the
strict shell/unknown-flag skip rules. Plugin `--help` stays with sf, as do
pipelines consuming plugin output. A merged `plugin-table.json` in the runtime
directory avoids worker startup or imports. Warm loads stat known inputs;
registry/package/operations/table changes or discovery environment changes
invalidate it. Missing or corrupt caches rebuild synchronously from metadata.
Cache write failures fall back to an in-memory table.

## Lifecycle and auth

Each plugin runs in a lazily forked process and resolves its own dependencies.
The host resolves aliases with sf's core and passes username/API metadata to
the worker. The worker creates and caches connections using the plugin's own
`@salesforce/core`; auth tokens never cross IPC or get written by the host.
Auth changes and `sfd reload` clear every worker connection. A host session error
clears only the affected username's connection. An expired session invalidates a
connection; only safe operations (or failures during connection creation) are
retried once. Unsafe operations are never replayed after starting. The host-side
rules are in [auth-cache.md](auth-cache.md).

Concurrent operations share a worker. Project-bound operations use the same
host queue as built-in deploy and tracking operations. Workers receive the
caller's cwd and project root; they never change process cwd.

Idle workers exit; daemon drain and termination stop all workers. A worker crash
fails its in-flight calls with `worker-crashed`, and the next request respawns
it. A worker stopped for a start timeout, a plugin change or idle exit leaves the
pool before its child exits, so a stopping worker is never handed to a new
request. A worker killed after an ignored cancellation also leaves the pool
before it is killed. The daemon-side rules are in
[daemon.md](daemon.md#plugin-worker-eviction).

Requests recheck plugin versions and operations-file mtimes. A changed
plugin restarts its worker and refreshes descriptors; the daemon stays warm.
This replaces folding plugin versions into the client `PROTOCOL`: clients
cannot cheaply know plugin mtimes. The protocol still includes recursive sfd
source and contract-module mtimes, so host code changes replace the daemon.

Progress and notices travel as NDJSON event lines ahead of the final socket
response. CLI progress goes to stderr, limited to one line per 250 ms;
`--quiet` suppresses progress. Closing the client socket aborts the operation's
signal. A worker that ignores cancellation is killed after five seconds; a
subsequent call starts a fresh worker. The usual `SFD_TIMEOUT_SECONDS` applies
(default operation timeout at least 120 seconds).

## Measurements

Measured 2026-11-05 on Linux, Node v24.14.0, using the hermetic echo fixture
and a warm daemon. Values are a single local run, not latency guarantees.

| Measurement | Result |
| --- | ---: |
| First `sfd op` (CLI + worker spawn/import; daemon already warm) | 74.052 ms |
| First socket operation (worker spawn/import; no CLI process) | 41.123 ms |
| First org call (fixture auth stub, already warm worker) | 1.641 ms |
| Warm org call (fixture auth stub) | 0.675 ms |
| Warm socket call, mean of 9 | 0.986 ms |
| Direct in-process operation, mean of 100 | 0.00297 ms |
| Warm CLI call, mean of 10 | 44.807 ms |
| Worker RSS after 1 / 10 / 100 calls | 47.11 / 47.86 / 48.98 MiB |

Warm socket overhead over the direct fixture call was approximately 0.983 ms.
The fixture's auth module performs no network I/O; these figures measure host
and worker setup, not real Salesforce authentication. No installed real plugin
declared an `sfd` manifest during this run, so real-plugin auth and memory
measurements remain unavailable. The development benchmark is
`scripts/measure-plugins.mjs` in the source checkout (not shipped in npm).

## Troubleshooting

- `missing-salesforce-core`: add `@salesforce/core` to the plugin's dependencies;
  the daemon's copy is deliberately not used by workers.
- `invalid-plugin`: inspect `sfd plugin list --json` and check the manifest,
  API version, module descriptors and operations path.
- `worker-crashed`: check the daemon log, fix the plugin, and retry. The host
  does not automatically replay a call whose worker crashed.
- `plan-exceeds-effects`: fix the operation's plan or declared ceiling; apply
  did not run.
- Exit 1 with `failed: <n> item(s)`: the operation finished, and its data and
  warnings were printed. Some items failed, so check the data before you retry.
  `--json` shows the same count as `failures` in the envelope.
- Exit 4 `approval required`: review the printed plan, then repeat the same
  command with `--confirm <hash>` within ten minutes. A changed plan issues a new
  hash. Exit 4 `policy denied` has no hash and cannot be confirmed.

See the [operation contract](plugin-api.md) for authoring and validation.
