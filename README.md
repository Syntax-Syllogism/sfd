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

## Install

```bash
npm install --global @syntax-syllogism/sfd
sfd query "SELECT Id, Name FROM Account LIMIT 5" -o my-org
```

## Commands

| Command | Does | `sf` equivalent |
| --- | --- | --- |
| `sfd query "<soql>"` | SOQL, all pages by default, `attributes` stripped. `--limit <n>` caps rows; `--csv` prints CSV. `--tooling`, `--all`, `--raw` for the unstripped result | `sf data query` |
| `sfd apex [file]` | Anonymous Apex from a file, `-f`, or stdin. Prints `USER_DEBUG` and fatal lines; `--log` for the full log | `sf apex run` |
| `sfd rest <path>` | REST call. `-X <method>`, `--body <json\|@file>` | `sf api request rest` |
| `sfd list-metadata-types` | Supported metadata types, folder markers and child types; cached per org and API version | `sf org list metadata-types` |
| `sfd list-metadata -m <Type>[,<Type>…]` | Live member names; `--details` for audit fields, `--folder <name>` for folder contents | `sf org list metadata` |
| `sfd describe <sobject>` | Compact describe; `--raw` for the full one. `--tooling` | `sf sobject describe` |
| `sfd deploy -d <path> \| -m <Type[:Name]>` | Deploy source. `--check-only`, `-l <level>`, `-t <test>`, `-w <minutes>` | `sf project deploy start` |
| `sfd retrieve [-d <path> \| -m <Type[:Name]> \| -x <package.xml>]` | Retrieve source; no selector pulls tracked remote changes. `--ignore-conflicts`, `-w <minutes>` | `sf project retrieve start` |
| `sfd tracking [--local \| --remote] [--conflicts]` | List local, remote and conflicting source-tracked changes; `--conflicts` shows only conflicts | |
| `sfd test` | Run Apex tests. `-n <class>`, `-t <Class.method>`, `-s <suite>`, `-l <level>`, `-c` (coverage), `-w <minutes>`, `--logs` | `sf apex run test --wait` |
| `sfd logs [--count 10] [--user <username>]` | Recent debug logs, one line each; `--limit` aliases `--count` | `sf apex list log` |
| `sfd logs get <id\|latest>` | Debug, exception, validation, Flow error and high limit usage lines. `--full` prints raw text | `sf apex get log` |
| `sfd org list [--all] [--status]` | Local authenticated orgs; `--all` includes expired scratch orgs, `--status` adds live checks | `sf org list --skip-connection-status` |
| `sfd org` | Resolved username, org id, instance URL and API version | `sf org display` |
| `sfd hook <agent>`, `check`, `install`, `uninstall` | Agent integration: rewrite `sf` commands before an agent runs them. See [docs/agent-hooks.md](docs/agent-hooks.md) | |
| `sfd agents-snippet [--write [file]]` | Print agent instructions, or write them into `AGENTS.md` or `CLAUDE.md`. See [Using sfd with coding agents](#using-sfd-with-coding-agents) | |
| `sfd discover [--since 30d]` | Report missed sfd opportunities and adoption from local agent transcripts. See [docs/discover.md](docs/discover.md) | |
| `sfd start \| stop \| status \| reload` | Daemon lifecycle; `reload` drops cached orgs and auth state | |

For agents, `--csv --limit 200` is the cheapest way to read rows. The limit,
CSV layout, output by flag and truncation trailer are described in
[docs/query.md](docs/query.md).

`-d`, `-m`, `-n`, `-t` and `-s` repeat or take comma-separated lists. The org
commands take `-o <alias>` (except `org list`), and `--json` prints the raw daemon response. Without `-o`
the org resolves like `sf`: `SF_TARGET_ORG`, then the nearest
`.sf/config.json`, then the global config.

`--sf-json` prints sf-compatible JSON for `query`, `describe`, `apex`, `org`
and `org list`, including warnings and error envelopes. It cannot be combined
with `--json`, `--csv` or `--limit`. Org secrets use sf's redaction placeholder;
queries fetch all pages. See [agent hooks](docs/agent-hooks.md#sf-compatible-json).

`sfd list-metadata-types` sorts supported types, marks folder-based types with
`(folder)` and shows up to six child names. Its daemon cache is scoped to the org
and connection API version, and cleared by `sfd reload`, auth changes or session
reconnection. `--json` includes `result.cached` and `result.apiVersion`.

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
`--status` checks non-scratch connections in parallel with a 10-second deadline
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
a failed deploy, or a failing test), `2` usage error, `3` the daemon could
not be reached or started, or a request timed out. Unreadable input files are
usage errors and include the file path.

Use `sf` (with `--json` when scripting) for anything sfd does not cover (org creation, package
commands, data import).

## Daemon lifecycle

The first command starts the daemon detached; there is nothing to set up. It
listens on a Unix socket in `$XDG_RUNTIME_DIR/sfd-<uid>/` (or the system temp
directory), in a directory with mode `0700` and a socket with mode `0600`.
On Windows it listens on a per-user named pipe (`\\.\pipe\sfd-<hash>`), and
the log and pid files go in `%LOCALAPPDATA%\sfd\`.
Access tokens stay in daemon memory and are never written to disk. The daemon
log is `sfd.log` in the same directory; `sfd status` prints its path.

The daemon exits on its own when:

- it has been idle for 60 minutes (`SFD_IDLE_MINUTES` overrides),
- a client with different sfd code connects (including lifecycle commands;
  the protocol version includes the source mtime, so an upgrade or local edit
  takes effect on the next call), or
- the `sf` install changes (an `sf update` rewrites its `package.json`).

In each case it stops accepting connections at once, finishes in-flight
requests (a running deploy or test run is not cut off), and the next call
starts a fresh daemon.

Auth changes made with `sf org login` or `sf alias set` are picked up
automatically. An expired session is rebuilt once and the call retried. Run
`sfd reload` if org state still looks stale. Lifecycle commands replace an
older daemon before reporting it as running or reloading it; `stop` shuts
it down even if its protocol differs.

## Behavior notes

- Queries fetch every page unless `--limit` is given. Compact results preserve
  `done` and any continuation URL supplied by Salesforce; see
  [docs/query.md](docs/query.md) for the limit rules.
- Deploys, retrieves and `tracking` share one queue per daemon, so they run
  one at a time. Deploys reload `sfdx-project.json` on every call.
- Retrieve conflicts, changes-only retrieves, and how `tracking` and deploys
  update source tracking are described in
  [docs/source-tracking.md](docs/source-tracking.md).
- `deploy` without `-l` uses the Metadata API default. `-t` alone implies
  `RunSpecifiedTests`.
- `test` without selectors runs `RunLocalTests`. A non-matching method is
  reported as skipped, as with `sf`.
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

## Environment

| Variable | Purpose |
| --- | --- |
| `SFD_TIMEOUT_SECONDS` | Positive request deadline in seconds, including connection time. Overrides defaults: 3 seconds for health/lifecycle requests; 120 seconds for other operations, extended to at least the deploy/retrieve/test `-w` wait plus 60 seconds (default waits: 33/33/60 minutes). Increase this for long queries or queued deploys. Timeout exits 3. |
| `SFD_IDLE_MINUTES` | Idle timeout, default 60. |
| `SFD_RUNTIME_DIR` | Socket, log and pid directory (on Windows, log and pid only; the pipe name is derived from it). |
| `SFD_SF_ROOT` | `@salesforce/cli` install to load libraries from, instead of the `sf` on `PATH`. |
| `SFD_HANDLERS_MODULE` | Test seam: stub handlers module used by the CLI tests. |

## Testing

`npm test` covers project and org resolution, output formatting, the socket
protocol (dispatch, version restart, drain, idle, stale socket), and the CLI
end to end against stub handlers, and the agent hook adapters and `sf` rewrite
rules. Injected Salesforce modules cover handler
paging, auth refresh, deployment, retrieve, source tracking and test orchestration without an org.
A real-org check is opt-in:

```bash
SFD_TEST_ORG=<alias> npm test
```

For local development, `npm run build` syntax-checks every source file and
`npm test` runs the suite. sfd has no runtime or dev dependencies, so there is
nothing to install; the Salesforce libraries come from your `sf` install.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## License

[MIT](LICENSE) © Jacob Richter

## Agent integration

`sfd hook` rewrites supported `sf` shell commands before a coding agent runs
them, so they reach the warm daemon. Install an adapter for Claude Code, Codex
CLI or Gemini CLI (user scope by default):

```bash
sfd hook install --agent claude
sfd hook install --agent codex
sfd hook install --agent gemini
```

Add `--project` to install into the current project instead. Preview a rewrite
with `sfd hook check '<sf command>'`. Query result format `-r csv` (or
`--result-format csv`) maps to `sfd query --csv`. The supported commands,
adapter details, skip rules and the `SFD_HOOK_DISABLE=1` switch are in
[docs/agent-hooks.md](docs/agent-hooks.md).

## Using sfd with coding agents

The rewrite hook supports shell lists and pipelines. Eligible piped or redirected
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

For automatic command rewriting, install a hook with
`sfd hook install --agent <agent>` (see [Agent integration](#agent-integration)).
