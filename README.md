# sfd

Fast Salesforce CLI operations through a warm local daemon.

sfd runs common Salesforce CLI operations through a
long-lived local daemon, so each call skips the 5–20 seconds `sf` spends
loading oclif and its plugins. A warm call answers in about 0.2 seconds. It is
meant for agents and scripts that make many small org calls in a row.

Requires Node 22 or newer and an installed, authenticated Salesforce CLI. sfd
has no Salesforce dependencies of its own: the daemon loads
`@salesforce/core`, source-deploy-retrieve, apex-node and source-tracking from
the `sf` install on `PATH`. Auth, aliases, API versions and the metadata
registry therefore always match what `sf` uses.

Run installed plugin operations with [the plugin host](docs/plugins.md).
Plugin authors: see the [experimental v0 operation contract](docs/plugin-api.md).

The guides are also published at <https://syntax-syllogism.com/sfd/docs/>.

## Install

```bash
npm install --global @syntax-syllogism/sfd
sfd query "SELECT Id, Name FROM Account LIMIT 5" -o my-org
```

## Commands

Run `sfd --help` for the full command list, `sfd <command> --help` for short
command usage, and `sfd help <command>` for the full manual. `sfd help -g`
lists concept guides built from the installed documentation. These help commands
work without starting the daemon. Run `sfd --version` to print the installed
version.

| Command | Does | `sf` equivalent |
| --- | --- | --- |
| `sfd query "<soql>"` | SOQL, first 2,000 rows by default (`--no-limit` for all), `attributes` stripped. `--limit <n>` caps rows; `--csv` prints CSV. `--tooling`, `--all`, `--raw` for the unstripped result | `sf data query` |
| `sfd apex [file]` | Anonymous Apex from a file, `-f`, or stdin. Prints `USER_DEBUG` and fatal lines; `--log` for the full log | `sf apex run` |
| `sfd rest <path>` | REST call. `-X <method>`, `--body <json\|@file>` | `sf api request rest` |
| `sfd list-metadata-types` | Supported metadata types, folder markers and child types; cached per org and API version | `sf org list metadata-types` |
| `sfd list-metadata -m <Type>[,<Type>…]` | Live member names; `--details` for audit fields, `--folder <name>` for folder contents | `sf org list metadata` |
| `sfd describe <sobject>` | Compact describe; `--raw` for the full one. `--tooling` | `sf sobject describe` |
| `sfd deploy -d <path> \| -m <Type[:Name]>` | Deploy source. `--check-only`, `-l <level>`, `-t <test>`, `-w <minutes>` | `sf project deploy start` |
| `sfd retrieve [-d <path> \| -m <Type[:Name]> \| -x <package.xml>]` | Retrieve source; no selector pulls tracked remote changes. `--ignore-conflicts`, `-w <minutes>` | `sf project retrieve start` |
| `sfd tracking [--local \| --remote] [--conflicts]` | List local, remote and conflicting source-tracked changes; `--conflicts` shows only conflicts | |
| `sfd test` | Run Apex tests. `-n <class>`, `-t <Class.method>`, `-s <suite>`, `-l <level>`, `-c` (coverage), `-w <minutes>`, `--logs`, `--no-trace`, `-y/--synchronous` (one class) | `sf apex run test --wait` |
| `sfd logs [--count 10] [--user <username>]` | Recent debug logs, one line each; `--limit` aliases `--count` | `sf apex list log` |
| `sfd logs get <id\|latest>` | Debug, exception, validation, Flow error and high limit usage lines. `--full` prints raw text | `sf apex get log` |
| `sfd org list [--all] [--status]` | Local authenticated orgs; `--all` includes expired scratch orgs, `--status` adds live checks | `sf org list --skip-connection-status` |
| `sfd org` | Resolved username, org id, instance URL and API version | `sf org display` |
| `sfd hook <agent>`, `check`, `install`, `uninstall` | Agent integration: rewrite `sf` commands before an agent runs them. See [docs/agent-hooks.md](docs/agent-hooks.md) | |
| `sfd agents-snippet [--write [file]]` | Print agent instructions, or write them into `AGENTS.md` or `CLAUDE.md`. See [Using sfd with coding agents](#using-sfd-with-coding-agents) | |
| `sfd discover [--since 30d]` | Report missed sfd opportunities and adoption from local agent transcripts. See [docs/discover.md](docs/discover.md) | |
| `sfd op <id> [--options-json <json\|@file\|->] [--plan]` | Run a plugin operation or preview its plan; `--quiet` suppresses progress | |
| `sfd plugin list [--json]` | Plugins, operations, effects and worker memory | |
| `sfd plugin init [<plugin-root>] [--ops <id,…>] [--write]` | Draft a plugin's `cli.json` from its operations and oclif manifest; review notes go to stderr. See [plugin command tables](#plugin-command-tables) | |
| `sfd start \| stop \| status \| reload` | Daemon lifecycle; `reload` drops cached orgs and auth state | |

For agents, `--csv --limit 200` is the cheapest way to read rows. The limit,
CSV layout, output by flag and truncation trailer are described in
[docs/query.md](docs/query.md).

`-d`, `-m`, `-n`, `-t` and `-s` repeat or take comma-separated lists. The org
commands take `-o <alias>` (except `org list`). `--json` prints the raw daemon
response; `org list --json` has its own shape (see below). Without `-o` the org
resolves like `sf`: `SF_TARGET_ORG`, then the nearest `.sf/config.json`, then the
global config.

`--sf-json` prints sf-compatible JSON for `query`, `describe`, `apex`, `org`
and `org list`, including warnings and error envelopes. It cannot be combined
with `--json`, `--csv` or `--limit`. Org secrets use sf's redaction placeholder;
queries fetch all pages. See [agent hooks](docs/agent-hooks.md#sf-compatible-json).

`sfd list-metadata-types` sorts supported types, marks folder-based types with
`(folder)` and shows up to six child names. Its daemon cache is scoped to the org
and connection API version. It is cleared for every org by `sfd reload` or an
auth change, and for the affected org by a session expiry.
`--json` includes `result.cached` and `result.apiVersion`.

`sfd list-metadata -m Flow,Layout` lists sorted names grouped by requested type.
Repeat `-m` to add types. `--details` adds the modification date, modifying user,
namespace and manageable state, omitting empty fields. Member lists are always
live; empty groups print `(none)`. Unknown types exit 2 with a suggestion when
available. Listings have the coverage and limits of the Metadata API
`listMetadata` operation; they do not enumerate special cases separately.

For folder-based types, omitting `--folder` lists folders with a hint. Choose a
folder to list its members; `--folder` accepts exactly one metadata type:

```bash
sfd list-metadata -m Report
sfd list-metadata -m Report --folder Public_Reports
sfd list-metadata -m ApexClass --details
```

`sfd org list` reads local auth without network calls. It shows aliases, usernames,
`*` for the default org, `H` for the default Dev Hub, org types and scratch expiry.
Expired scratch orgs are hidden with a count hint; use `--all` to include them.
`--status` runs at most four non-scratch checks and Dev Hub queries at a time, with a 10-second deadline
per org, and queries scratch status once per Dev Hub (also bounded to 10 seconds).
Unavailable Dev Hubs leave scratch status blank. New logins and logouts are picked
up automatically. This command rejects `-o`.

```bash
sfd org list
sfd org list --all --status
sfd org list --json
```

For `org list`, `--json` returns `{ "orgs": [...] }` directly, with alias,
username, orgId, instanceUrl, type, isDefault, isDefaultDevHub, and optional
expirationDate, expired and status. The command never includes access tokens,
refresh tokens or client secrets in any output, including `--json`. Primary-user
filtering, status checks and the JSON allowlist are described in
[docs/org-list.md](docs/org-list.md).

Exit codes: `0` success, `1` the operation failed (including a compile error,
a failed deploy, a failing test, or a plugin operation that reported failed items),
`2` usage error, `3` the daemon could
not be reached or started, or a request timed out, `4` approval required or policy denied.
Production writes require a single-use `--confirm <hash>`; see
[Safety policy](docs/safety.md). Unreadable input files are
usage errors and include the file path.

Use `sf` (with `--json` when scripting) for anything sfd does not cover (org creation, package
commands, data import).

## Daemon lifecycle

The first command starts the daemon detached; there is nothing to set up. It
listens on a Unix socket in `$XDG_RUNTIME_DIR/sfd-<uid>/` (or the system temp
directory). sfd sets that directory to mode `0700` and the socket to `0600`.
sfd refuses a runtime directory that is a symbolic link, is not a directory, or is
owned by another user (exit 3); remove it or set `SFD_RUNTIME_DIR` to a directory
you own. See [docs/daemon.md](docs/daemon.md#runtime-directory).
On Windows it listens on a named pipe (`\\.\pipe\sfd-<hash>`). The pipe name is not
an access control. The log and pid files go in `%LOCALAPPDATA%\sfd\`.
Access tokens stay in daemon memory and are never written to disk. The daemon
log is `sfd.log` in the same directory; `sfd status` prints its path and any last-seen API usage per org. The log contains JSON lines, including request timings and status; request bodies and SOQL text are omitted. It rotates at 5 MiB to `sfd.log.1` (one previous log is kept). Early startup errors go to `sfd.boot.log`, which is truncated at each spawn.

The daemon exits on its own when:

- it has been idle for 60 minutes (`SFD_IDLE_MINUTES` overrides),
- a client with different sfd code connects (including lifecycle commands;
  the protocol version includes the source mtime, so an upgrade or local edit
  takes effect on the next call), or
- the `sf` install changes (an `sf update` rewrites its `package.json`).

In each case it stops accepting connections at once, finishes in-flight
requests (a running deploy or test run is not cut off), and the next call
starts a fresh daemon.

`SIGTERM` or `SIGINT` (Ctrl-C) takes the same path: in-flight requests get up to
10 seconds to finish, then the daemon removes its socket and pid file and exits.
A second signal exits at once. Requests over 8 MiB, and connections that send no
complete line within 30 seconds, are refused without affecting the idle timer.
The socket protocol, its limits and the signal rules are described in
[docs/daemon.md](docs/daemon.md).

Auth changes made with `sf org login` or `sf alias set` are picked up
automatically. An expired session is rebuilt, and read-only calls are retried
once. Read calls that hit a Salesforce request limit are retried up to twice with
backoff. Writes, `apex` and `retrieve` are not retried after they start; the error
says the change may or may not have applied. See
[docs/safety.md](docs/safety.md#session-expiry) and
[docs/request-limits.md](docs/request-limits.md). Run `sfd reload` if org state
still looks stale. Lifecycle commands replace an
older daemon before reporting it as running or reloading it; `stop` shuts
it down even if its protocol differs.

## Behavior notes

- Queries return at most 2,000 rows by default; `--no-limit` fetches every page,
  and `--sf-json` is uncapped for compatibility. Compact results preserve
  `done` and any continuation URL supplied by Salesforce; see
  [docs/query.md](docs/query.md) for the limit rules.
- Deploys, retrieves and `tracking` share one queue per daemon, so they run
  one at a time. Deploys reload `sfdx-project.json` on every call.
- If the client stops waiting (Ctrl-C, or an agent's tool timeout) during a
  `deploy`, `retrieve` or `test`, the daemon stops waiting and frees the queue.
  The org job keeps running. The daemon log records its deploy, retrieve or test
  run ID when known, so you can check it with `sf`. Source tracking is not updated
  for that wait. See [docs/source-tracking.md](docs/source-tracking.md#serialization).
- Retrieve conflicts, changes-only retrieves, and how `tracking` and deploys
  update source tracking are described in
  [docs/source-tracking.md](docs/source-tracking.md).
- `deploy` without `-l` uses the Metadata API default. `-t` alone implies
  `RunSpecifiedTests`.
- `test` without selectors runs `RunLocalTests`. A non-matching method is
  reported as skipped, as with `sf`.
- `test -y/--synchronous` uses the Tooling API synchronous runner for one
  class: `sfd test -y -n MyTest` or `sfd test -y -t MyTest.one -t MyTest.two`.
  Suites and test levels other than `RunSpecifiedTests` are usage errors.
  `-w` still controls the client socket timeout, but does not limit the sync run.
  Sync results omit the run ID suffix; JSON may have an empty or absent `testRunId`.
- Paths in `-d` and the project directory resolve from the client's working
  directory, not the daemon's.

### Debug logs

`logs`, `logs get` and `test --logs` create or extend the current user's
developer TraceFlag for 30 minutes when it is missing, expired or has less than
five minutes left, and print one notice on stderr when they do. `--no-trace`
skips that setup. `logs --user` only filters the list. Setup needs Tooling API
permission to manage TraceFlag and DebugLevel records. The TraceFlag rules,
filtered output format and `test --logs` behavior are in
[docs/debug-logs.md](docs/debug-logs.md).

## Agent integration

`sfd hook` rewrites supported `sf` shell commands before a coding agent runs
them, so they reach the warm daemon. Install an adapter for Claude Code, Codex
CLI or Gemini CLI (user scope by default):

```bash
sfd hook install --agent claude
sfd hook install --agent codex
sfd hook install --agent gemini
```

Add `--project` to install into the current project instead. For Claude Code,
install also adds deny rules to `permissions.deny` so an agent cannot approve its
own `--confirm` prompts; pass `--no-deny-confirm` to skip them. Preview a rewrite
with `sfd hook check '<sf command>'`. Query result format `-r csv` (or
`--result-format csv`) maps to `sfd query --csv`. The supported commands,
adapter details, skip rules and the `SFD_HOOK_DISABLE=1` switch are in
[docs/agent-hooks.md](docs/agent-hooks.md).

On Windows, Gemini uses a conservative PowerShell mode; Codex needs
`SFD_HOOK_SHELL=powershell` for PowerShell sessions. Preview it with
`sfd hook check --shell powershell '<sf command>'`. See
[Windows and PowerShell](docs/agent-hooks.md#windows-and-powershell).

## Using sfd with coding agents

In POSIX mode, the rewrite hook supports shell lists and pipelines. Eligible piped or redirected
`sf --json` calls use `--sf-json` so jq consumers retain sf's result shape.

`sfd discover` scans local Claude Code, Codex CLI and Gemini CLI transcripts for
shell tool calls using `sf`, legacy `sfdx`, or `sfd`. It uses the hook's rewrite
engine to report rewritable calls, skip reasons, unsupported commands and adoption.
It reads local files only, without an org, daemon, network calls or writes.

```bash
sfd discover
sfd discover --since 12h --agent claude --agent codex --project /path/to/project
sfd discover --top 5 --json
```

`--since` takes days (`d`) or hours (`h`), default `30d`. `--agent` is repeatable,
and all three agents are scanned by default. Time and output-token savings are
estimates from observed timings and output sizes; they are never extrapolated.
The stores read, how each call is classified, the JSON shape and the limits are
described in [docs/discover.md](docs/discover.md).

The agent reference includes metadata type discovery and member listing alongside
query, source and log operations. Print a compact command reference with
`sfd agents-snippet`, or add it to your project's agent instructions:

```bash
sfd agents-snippet --write
sfd agents-snippet --write docs/CLAUDE.md
```

`--write` uses the first existing `AGENTS.md` or `CLAUDE.md` in the Salesforce
project root (or the current directory outside a project), creating `AGENTS.md`
if neither exists. Explicit paths resolve from the current directory. Only the
block between `<!-- sfd:start -->` and `<!-- sfd:end -->` is replaced on later
runs; other instructions are preserved. This command needs no org or daemon.
The block's contents and marker rules are described in
[docs/agents-snippet.md](docs/agents-snippet.md).

## Plugin command tables

Plugins with an `sfd.cli` table expose direct commands, help, agent tips and
strict `sf` hook rewrites, such as `sfd echo say --text hi`. Authors can run
`sfd plugin init [root] [--ops <id,…>] [--write]` to draft a table from their
operations and oclif manifest. Review its stderr notes before committing it.
See [plugins](docs/plugins.md) and the [CLI contract](docs/plugin-api.md#cli-table).

## Environment

| Variable | Purpose |
| --- | --- |
| `SFD_TIMEOUT_SECONDS` | Positive request deadline in seconds, including connection time. Overrides defaults: 3 seconds for health/lifecycle requests; 120 seconds for other operations, extended to at least the deploy/retrieve/test `-w` wait plus 60 seconds (default waits: 33/33/60 minutes). Increase this for long queries or queued deploys. Timeout exits 3. |
| `SFD_IDLE_MINUTES` | Idle timeout, default 60. |
| `SFD_RUNTIME_DIR` | Socket, log and pid directory (on Windows, log and pid only; the pipe name is derived from it). |
| `SFD_MAX_REQUEST_BYTES` | Largest request line the daemon accepts, in bytes; default 8 MiB. Larger requests get `BadRequest`. Mainly for tests. |
| `SFD_POLICY` | Safety policy file path, default `~/.config/sfd/policy.json`. See [Safety policy](docs/safety.md). |
| `SFD_SF_ROOT` | `@salesforce/cli` install to load libraries from, instead of the `sf` on `PATH`. |
| `SFD_HANDLERS_MODULE` | Test seam: stub handlers module used by the CLI tests. |
| `SFD_HOOK_SHELL` | Force hook parsing and quoting to `posix` or `powershell`. Invalid values disable rewriting. Gemini defaults to PowerShell on Windows; Codex on native Windows requires an explicit override. |
| `SFD_HOOK_DISABLE` | Set to `1` to make every agent hook return no opinion (no rewrite, no permission decision). `sfd hook check` reports `skip: SFD_HOOK_DISABLE=1`. |
| `SFD_PLUGIN_PATHS` | Extra plugin roots, separated by the platform path separator. See [plugins](docs/plugins.md). |
| `SFD_PLUGIN_PATHS_ONLY` | Set to `1` to ignore the sf plugin registry and use only the `SFD_PLUGIN_PATHS` roots. |
| `SFD_PLUGIN_IDLE_MINUTES` | Idle lifetime of a plugin worker in minutes, default 30. |
| `SF_DATA_DIR` | Overrides the sf data directory that the plugin registry is read from. |

## Testing

`npm test` covers project and org resolution, output formatting, the socket
protocol (dispatch, malformed requests, version restart, drain, idle, stale
socket, size cap, read deadline, serialization errors), the signal drain, and the
CLI end to end against stub handlers, and the agent hook adapters and `sf` rewrite
rules. Injected Salesforce modules cover handler
paging, auth refresh, deployment, retrieve, source tracking and test orchestration without an org.
A real-org check is opt-in:

```bash
SFD_TEST_ORG=<alias> npm test
```

For local development, `npm run build` syntax-checks every source file,
`npm run typecheck` runs the four TypeScript configs, and `npm test` runs the
suite. sfd has no runtime dependencies. Its dev dependencies (TypeScript and
`@types/node`) are only used for type checking. The Salesforce libraries come
from your `sf` install.
`npm run test:soak` runs the cache-bounds soak case with `--expose-gc`, which
also checks heap growth; see [docs/auth-cache.md](docs/auth-cache.md#testing-and-soak).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## License

[MIT](LICENSE) © Jacob Richter
