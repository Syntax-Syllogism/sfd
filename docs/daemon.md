---
title: Daemon
description: "The sfd daemon: its socket protocol, request limits, shutdown and crash safety."
---

The sfd daemon is a long-lived process that answers client requests over a local
socket. The client starts it detached on first use. This guide covers how it
frames and validates requests, how it counts work and drains, how it handles
signals and unexpected errors, and what an agent must keep true when changing it.
The user-facing lifecycle (when the daemon exits, how auth changes are picked
up) is in the README's "Daemon lifecycle" section.

Source: `src/server.mjs` (socket server: framing, envelope validation, dispatch,
the active count, the per-connection abort signal, idle and drain), `src/daemon.mjs` (entry point: process error
handlers, handler and supervisor wiring, logger, signal drain, pid file), `src/client.mjs`
(writes one request line), `src/paths.mjs` (runtime directory, socket, pid and log
locations), and the worker eviction in `src/plugin/supervisor.mjs`. Tests:
`test/server.test.mjs` (protocol, against an in-process server), `test/cli.test.mjs`
(end to end, including a SIGTERM drain), `test/plugin-worker.test.mjs` (worker
replacement), `test/paths.test.mjs` (runtime directory checks and memoization) and
`test/client.test.mjs` (boot log truncation at spawn). The daemon log, its access
records and rotation are in [logging.md](logging.md).

## Files and runtime state

| File | Location | Notes |
| --- | --- | --- |
| Socket `sfd.sock` | `$XDG_RUNTIME_DIR/sfd-<uid>/` or the system temp directory | Directory mode `0700`, socket mode `0600`. Removed when the server drains. A dead socket left by a crash is replaced on the next start. |
| Named pipe | `\\.\pipe\sfd-<hash>` on Windows | Disappears with its owner, so it is never unlinked. Windows default pipe permissions grant other local users read access; the pipe name is not an access control. |
| Pid file `sfd.pid` | Runtime directory (`%LOCALAPPDATA%\sfd\` on Windows) | Written after the server listens. Removed on exit only if it still holds this process's pid. |
| Log `sfd.log` | Same directory | JSON lines written by the daemon's logger (`src/log.mjs`). Rotated to `sfd.log.1` while running. See [logging.md](logging.md). |
| Boot log `sfd.boot.log` | Same directory | The spawned daemon's stdout and stderr, truncated by `startDaemon()` at each spawn. Holds startup failures that happen before the logger opens. See [logging.md](logging.md#the-boot-log). |

`SFD_RUNTIME_DIR` moves the socket, pid and log files. Access tokens are never
written to these files.

## Runtime directory

`runtimeDir()` in `src/paths.mjs` creates the runtime directory and checks it once
per process for each combination of `SFD_RUNTIME_DIR`, `XDG_RUNTIME_DIR` and
`LOCALAPPDATA` (and the platform). Later calls return the cached path with no
filesystem calls. Tests pass custom environments, so the cache key includes them.

On POSIX, a directory you own is always reset to mode `0700` first, so a
group- or world-readable runtime dir (for example `chmod 0750`) is tightened and
used, not refused. The check refuses a directory that:

- is a symbolic link or is not a directory;
- is owned by another uid;
- still has group or other permission bits after that `chmod 0700`.

The refusal is a `RuntimeDirError` that names the directory. The CLI exits with code 3.
Without `--sf-json`, the CLI prints it as `sfd daemon error: ...` on stderr with no
log line. With `--sf-json` it prints the sf-style error envelope instead. Beyond that mode
reset, a refused directory is not repaired automatically, because silently
fixing a symlink or a directory another user owns would hide the problem. Remove the directory or point `SFD_RUNTIME_DIR` at one you own. A
refused directory is checked again on the next call. On Windows the directory is
only created and is not checked for owner or ACL.

## Logging

The daemon log format, access records, rotation at 5 MiB, the shutdown flush,
plugin worker stderr capture and the boot log are described in
[logging.md](logging.md). The socket-level rules that the log depends on (one
access record per valid request, rejected frames logged as warnings, no payloads)
are set here: see [Request framing](#request-framing) and
[Envelope validation and dispatch](#envelope-validation-and-dispatch).

## Request framing

- One connection carries one request: a single JSON object on one line, ended
  by `\n`. The client writes it at once.
- The reply is one JSON line, `{status: 0, result}`, `{status: 1, name, message, ...}`
  or `{restart: true}`. Progress and notice events are NDJSON lines written
  before the reply (`emit`), and the server then closes the connection.
- **Size cap.** A request line may be `maxRequestBytes` bytes long, 8 MiB by
  default. `SFD_MAX_REQUEST_BYTES` overrides it (a positive integer; tests use it
  to make the cap small). The check runs on every chunk, so a line over the cap is
  refused before its newline arrives. The client gets
  `{status: 1, name: "BadRequest", message: "Request too large"}` and the
  connection closes. The request never counts as active and does not touch the
  idle timer.
- **Read deadline.** A connection has `readTimeoutMs` (30 s) from the moment it
  opens to deliver its first complete line. The deadline is absolute, so
  trickling bytes do not extend it. Once the line is complete the timer is
  cleared, so a long-running operation is never cut off by it. A connection that
  misses the deadline is destroyed.
- Multibyte characters split across chunks are safe because the socket uses
  `setEncoding("utf8")`.

## Envelope validation and dispatch

`respond()` in `src/server.mjs` checks the request in this order. The order is
part of the contract:

1. **Shape.** Anything that is not a non-array object with a string `op` returns
   `BadRequest` ("Malformed sfd request"). That covers invalid JSON (the parse
   failure leaves `req` undefined, not `{}`), an empty line, `null`, numbers,
   strings, arrays, and objects whose `op` is missing or not a string (such as
   `{"op":null}` or `{"op":1}`). A malformed request never drains the server.
2. **`stop`.** `{op: "stop"}` replies `{stopping: true}` whatever its version, so
   `sfd stop` works across a version mismatch. The server then drains with reason
   `stop`.
3. **Version.** A request whose `v` is not the daemon's `PROTOCOL` returns
   `{restart: true}`. The server drains with reason `version`, and the next call
   starts a fresh daemon. `PROTOCOL` includes the newest recursive source mtime
   (`src/version.mjs`), so any edit to sfd code replaces the daemon. The envelope
   shape has not changed.
4. **Dispatch.** The handler is looked up with `Object.hasOwn(handlers, op)`. A
   missing or non-function entry returns `UnknownOperation`. Inherited names such
   as `constructor` and `__proto__` never dispatch.
5. **Handler.** A thrown error becomes `{status: 1, name, message, ...}`, with the
   approval fields for exit 4 and the trace when present. A result that cannot be
   serialized (circular, BigInt) becomes `{status: 1, name: "SerializeError"}`.

## Active count, idle and drain

- `active` counts requests from the first complete line until the reply has been
  written. It is incremented before the request runs and decremented in a
  `finally`, so an error during serialization or reply cannot leak it. A leaked
  count would keep the idle timer from ever re-arming.
- After every counted request, the `finally` block decides the next state: `stop`
  drains with reason `stop`; a version restart drains with `version`; `isStale()`
  (the `sf` install's `package.json` mtime changed) drains with `stale`. Otherwise
  the daemon re-arms the idle timer when no request is active.
- A client disconnect aborts built-in deploy, retrieve and test waits and releases
  the active count. Their org jobs continue; the daemon log records the job ID
  when known. The library poll is not cancelled and can keep running after the
  reply is gone. Queue and tracking effects are in
  [source-tracking.md](source-tracking.md#serialization).
- The idle timer (`SFD_IDLE_MINUTES`, default 60) drains with reason `idle` only
  when `active` is zero.
- `drain(reason)` stops accepting connections, removes the socket file and calls
  `onExit` once `active` reaches zero. In-flight requests finish first. `onExit`
  in `src/daemon.mjs` shuts down the plugin supervisor (all workers), logs
  `exiting (<reason>)`, removes the pid file and flushes the log before exit, with a one-second deadline.

## Signals

`SIGTERM` and `SIGINT` are registered after the server listens. Before that point
the default signal action applies, so a signal during startup ends the process at
once.

- **First signal:** log `<SIG>: draining`, call `drain("signal")`, and arm a
  10-second deadline. The timer is unref'd, so it does not keep the process
  alive. Requests in flight may finish within the deadline. Then the daemon exits
  as above.
- **Deadline passed:** log `drain deadline passed; exiting`, remove the pid file
  and exit with status 0. Work still in flight is dropped.
- **Second signal:** log `<SIG> again; exiting now`, remove the pid file and flush the log before exiting with status 1.
- On Windows `process.kill` does not deliver `SIGTERM`; `SIGINT` still works. The
  registration is harmless where it does not fire.

`cleanupPid()` is shared by `onExit`, the deadline and the second-signal paths.

## Unexpected errors

`src/daemon.mjs` installs `unhandledRejection` and `uncaughtException` handlers
after startup. Each logs an `error` entry (`unhandled rejection` or `uncaught
exception`) with the error and its stack, and the daemon keeps running. Keeping
the daemon up is deliberate: exiting would drop every in-flight request on every
connection, which is the failure these handlers prevent.
Startup exceptions, before the logger opens, retain Node's non-zero failure exit
and their output goes to `sfd.boot.log`.

- The handlers live in `src/daemon.mjs`, not in `src/server.mjs`, because tests
  import the server into the test process.
- Never log request bodies or auth fields. The stack is enough.
- Worker errors are handled separately; see [Plugins](plugins.md).

## Plugin worker eviction

`stop()` in `src/plugin/supervisor.mjs` removes the worker from the pool before
its pending calls fail and before its child exits. A worker stopped after a start
timeout, an ignored cancellation, a plugin change, an idle exit or a shutdown is therefore never handed to
a new request, and the next call spawns a fresh worker. A worker that exits on its
own is removed by its exit handler. See [Plugins](plugins.md) for the worker
lifecycle.

## Changing this area

- Keep the shape check before the version check. A garbage writer must not be able
  to make the daemon restart or drain.
- Dispatch only through `Object.hasOwn`. Do not read handlers from a prototype.
- Keep the `active--` and the drain, stale and idle decisions in the `finally`
  block. Add new early returns only after `active++` if they run that `finally`.
- Do not install process-level handlers in `src/server.mjs`.
- `src/server.mjs` aborts a per-connection `AbortSignal` when the client closes
  before replying, and passes it to the handler in the `{ signal }` option.
  Built-in deploy, retrieve and test honour it; read
  [source-tracking.md](source-tracking.md#serialization) before changing that
  path, because an orphaned library poll keeps running.
- Hook code never contacts the daemon. Only `src/client.mjs` and the tests speak
  the envelope, so a shape change needs the client, the envelope types in
  `src/types.d.ts` and `test/server.test.mjs` updated together.
- Keep the limits (`maxRequestBytes`, `readTimeoutMs`, the 10-second drain
  deadline) in step with this guide and the README environment table.
- Keep the runtime directory checks in `src/paths.mjs` and the README's daemon
  lifecycle section in step. Any new check needs a case in `test/paths.test.mjs`.
