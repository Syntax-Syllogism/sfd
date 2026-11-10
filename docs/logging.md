---
title: Logging
description: "The sfd daemon log: JSON-lines format, per-request access records, runtime rotation, the boot log, and plugin worker stderr."
---

The sfd daemon writes a JSON-lines log, `sfd.log`, with one access record per
request and rotates it while it runs. Early startup output goes to a separate
`sfd.boot.log`, truncated at each spawn. This guide covers the format, what is
and is not recorded, rotation, shutdown flush, and the boot log.

Source: `src/log.mjs` (`createLogger`: the write queue, levels, rotation and
`close()`), `src/daemon.mjs` (creates the root logger, passes `log.warn` to the
handlers and the plugin supervisor, logs lifecycle events, flushes on exit),
`src/server.mjs` (the `request` access record, `reqId`, rejected-frame warnings),
`src/sf-util.mjs` (`disconnected`), `src/ops/org-list.mjs` (`orgList`
warnings), `src/plugin/supervisor.mjs` (worker stderr capture), `src/client.mjs` (`startDaemon` and the boot log),
`src/paths.mjs` (`log` and runtime locations). Tests: `test/log.test.mjs`
(format, levels, rotation order), `test/server.test.mjs` (access records, payload
omission), `test/plugin-worker.test.mjs` (worker stderr), `test/client.test.mjs`
(boot log truncation) and `test/cli.test.mjs` (end-to-end log writes).

## Files

| File | Location | Written by |
| --- | --- | --- |
| `sfd.log` | Runtime directory (see the README's daemon lifecycle section) | The daemon, through `src/log.mjs`, for the whole life of the process |
| `sfd.log.1` | Same directory | Rotation: the previous `sfd.log`, replaced on each rotation |
| `sfd.boot.log` | Same directory | The spawn's stdout and stderr, opened with `"w"` by `startDaemon()` |

`SFD_RUNTIME_DIR` moves all three. `sfd status` prints the path of `sfd.log`
(and `sfd status --json` reports it as `log`). There is no `sfd logs` command for
the daemon log; read the file directly.

## Line format

Each line is one JSON object terminated by `\n`:

```json
{"ts":"2026-11-09T19:03:35.120Z","level":"info","msg":"request","reqId":"r7","op":"query","org":"dev","qLen":42,"ms":318,"status":0,"aborted":false}
```

- `ts`: ISO-8601 time of the call, in UTC.
- `level`: `debug`, `info`, `warn` or `error`.
- `msg`: a short fixed message such as `request`, `exiting (idle)`, or
  `plugin stderr`.
- Further fields come from the call site and from `child()` (for example
  `reqId`). `undefined` values are omitted.
- An `Error` field is written as `{name, message, stack}`. A value that cannot be
  serialized (circular or BigInt) turns the whole line into
  `{"level":"error","msg":"unserializable log entry"}`, so one bad field never
  throws into the caller.

Levels are `info`, `warn` and `error`. There is no debug level.

## Access records

`src/server.mjs` writes one `request` line for every frame that parses as a
request object (an object with a string `op`). It is written after the reply is
sent:

| Field | Meaning |
| --- | --- |
| `reqId` | `r1`, `r2`, … from a counter in the server. Unique only within one daemon run. |
| `op` | The operation name, such as `query` or `deploy`. |
| `org` | The `org` argument, when it is a string. |
| `qLen` | The length of the `q` argument, when it is a string. The text is never logged. |
| `ms` | Wall time from just before dispatch to just after the reply is written, rounded to milliseconds. |
| `status` | The reply's `status` (`0` or `1`), or `"restart"` for a version-mismatch reply. |
| `error` | The reply's error name (`res.name`), when there is one. The message is not logged. |
| `aborted` | `true` when the client disconnected before the reply and the handler's signal fired. |

A frame that is not a request object gets a `warn` line `rejected request` with
`error: "BadRequest"`, and no reqId. An oversized line (over the
`maxRequestBytes` cap) is refused the same way, before any parsing. The payload is
never logged in either case.

## Redaction

The logger does not scrub fields. Redaction is done at the call site, by choosing
fields: access records carry only `op`, the org alias, booleans and numbers, and
timings. Request bodies, SOQL text, Apex source and auth fields never reach the
log. Handlers do not log vendor error messages, because they can contain secrets.

Plugin worker stderr content is discarded; only an occurrence and plugin source
metadata are logged.

**Unhandled errors** need care: `unhandled rejection` and `uncaught exception`
lines include the error's stack, and the stack can contain values from an error
message.

## Handler log lines

Handlers use the request-scoped transport logger for warnings, so their lines
carry the same `reqId` as the access record. Direct callers without a transport
logger fall back to the injected warning function. Current messages:

- `client disconnected: <op> org <alias>; <detail>` for deploy, retrieve and test
  waits that the client abandoned. The detail includes the job or test-run ID when
  it is known. The org job keeps running.
- `orgList: skipping unreadable local authorization`, with no alias or file name.
- `orgList: Dev Hub query exhausted retries: <code>`.

## Rotation

The daemon rotates while it runs. `createLogger` (`src/log.mjs`) is called with
`maxBytes` 5 MiB and `keep` 1, so:

- Before a line is written, if the current file already has bytes and the line
  would take it past 5 MiB, the file is moved to `sfd.log.1` (replacing an earlier
  `sfd.log.1`) and writing continues in a new `sfd.log`.
- Size starts from the file's size when the daemon opens it, then grows by the
  bytes written.
- Writes go through one queue. Lines that arrive while a rotation is in progress
  wait in the queue and land in the new file, so the order across `sfd.log.1` and
  `sfd.log` is preserved.
- Only one earlier file is kept. Older lines are discarded when the next rotation
  replaces `sfd.log.1`.
- Rotation never runs at spawn; `startDaemon()` only truncates the boot log.

The daemon's disk use for logs is therefore about 10 MiB plus the boot log.

## Writing, shutdown and flush

Writes are asynchronous through an `fs.createWriteStream` with `flags: "a"`, so a
burst of logging does not block the event loop. A stream error (for example, the
file cannot be opened) is swallowed, and the affected lines are dropped without
an error. The daemon keeps running.

Every exit path in `src/daemon.mjs` calls `log.close()` before `process.exit`:

- `onExit` (idle, stale, stop, or any other drain reason, after the
  `exiting (<reason>)` line);
- the first signal's 10-second drain deadline;
- the second signal (`<SIG> again; exiting now`).

`close()` marks the logger closed, so later writes are dropped, and resolves when
the queue has drained. The daemon waits at most one second. A hard crash (a
SIGKILL, or a crash inside native code) can lose queued lines.

## Plugin worker stderr

`src/plugin/supervisor.mjs` starts each plugin worker with stdio
`["ignore", "ignore", "pipe", "ipc"]`. Stdout is discarded. Stderr is read line by line
and drained without retaining its content. The first output from each worker
produces `log.warn("plugin stderr", { source: "plugin", root })`.
Plugin operations return their results through the IPC channel, so a plugin
should not rely on stdout.

## The boot log

`startDaemon()` in `src/client.mjs` opens `sfd.boot.log` with `"w"`, which
truncates it, and gives the detached daemon that file as both stdout and stderr.
The parent closes its copy after the spawn. The file therefore holds:

- anything the daemon writes before `src/daemon.mjs` has created the logger
  (import failures, for example);
- any output that still goes to `console.*`, such as the `could not write org
  types` message in `src/org-session.mjs`, and the default `log` option that
  `createHandlers` and the supervisor use if no logger is passed;
- the stack of any crash that happens before the logger is open.

If the daemon does not answer within the start timeout, the client error says
`sfd did not start within <ms> ms (...); see sfd.boot.log in the runtime directory.`
The boot log is truncated at the next spawn, so read it promptly.

## Known limits

- Some output still uses `console.*` (for example `src/org-session.mjs` for org
  types, and the default `log` option in `createHandlers` and the supervisor).
  That output goes to `sfd.boot.log`, not `sfd.log`.
- There are no environment variables for log level, size or retention, and
  no log shipping. These are deliberate non-goals for now.
- `reqId` restarts at `r1` in each daemon process. Use the `ts` and the startup
  line (`sfd <version> listening on … (pid …)`) to tell runs apart.

## Changing this area

- Log only fixed messages, the fields listed above, and booleans, numbers and
  aliases. Never add a request argument such as `q`, `body`, `apex` or any auth
  value to a log call. If a field is needed, add it as a length or a flag.
- Use the injected `log` in handlers and the server. Do not add `console.*` calls
  to code that runs in the daemon.
- Keep `log.close()` on every exit path in `src/daemon.mjs`. Do not reintroduce a
  fixed `setTimeout` before `process.exit`.
- Keep the access record in `src/server.mjs` in step with this guide. A new field
  changes the log format that people grep.
- The line format changed from plain text to JSON lines. Note any further format
  change in `CHANGELOG.md`, because people grep `sfd.log`.
- Keep the README's log paragraph in step with this guide and the rotation limits
  in [daemon.md](daemon.md#files-and-runtime-state).
- Add tests in `test/log.test.mjs` for logger behaviour, in `test/server.test.mjs`
  for access-record fields, and in `test/plugin-worker.test.mjs` for worker stderr.
