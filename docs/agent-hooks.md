# Agent hooks

`sfd hook` lets coding agents run `sf` commands through the warm daemon. Before
an agent runs a shell command, the hook rewrites a supported `sf` invocation to
the equivalent `sfd` command. Anything the rewriter does not recognize runs
unchanged.

Source: `src/hooks.mjs` (adapters, settings install and uninstall, `check`) and
`src/rewrite.mjs` (the `sf` to `sfd` rewriter). Tests: `test/hooks.test.mjs`
and `test/rewrite.test.mjs`.

## Install

```bash
sfd hook install --agent claude
sfd hook install --agent codex
sfd hook install --agent gemini
```

Installs go to user scope, under your home directory, by default. Add
`--project` to write the current project's settings instead:

```bash
sfd hook install --agent claude --project
sfd hook uninstall --agent claude [--project]
```

Settings are merged, not replaced. Existing settings and other hooks, including
RTK, are preserved. The first change to an existing file saves a `<file>.bak`;
later changes keep that backup. Malformed settings are never overwritten.

| Agent | Settings file (user / `--project`) | Event | Tool matched | Response |
| --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/settings.json` / `.claude/settings.json` | `PreToolUse` | `Bash` | Modified input and reason; Claude's normal permission flow is kept |
| Codex CLI | `~/.codex/hooks.json` / `.codex/hooks.json` | `PreToolUse` | `Bash` | Modified input with `permissionDecision: "allow"` |
| Gemini CLI | `~/.gemini/settings.json` / `.gemini/settings.json` | `BeforeTool` | `run_shell_command` | Modified input, no allow decision |

Codex requires you to review and trust new or changed hooks with `/hooks`
before they can run. Its
[hook contract](https://learn.chatgpt.com/docs/hooks) requires an allow decision
with modified input; older Codex versions may not support rewriting. See also
[Gemini's hook reference](https://geminicli.com/docs/hooks/reference/).

Remove an adapter with `sfd hook uninstall --agent <agent> [--project]`.

## Adapters

`sfd hook claude|codex|gemini` reads hook JSON on stdin. It writes a response
only for a supported rewrite, and otherwise writes nothing. It exits 0 on
malformed or unsupported input. It never starts or contacts the daemon. Adapter
errors must never change whether the original tool call runs, so they are
swallowed on purpose.

Set `SFD_HOOK_DISABLE=1` in the agent's environment to turn rewriting off.

## Preview a rewrite

```bash
sfd hook check 'sf data query -q "SELECT Id FROM Account" -o dev --json'
# → sfd query 'SELECT Id FROM Account' -o 'dev'
```

`check` runs the same rewriter as the adapters. It exits 0 for a rewrite and 1
for a skip, printing the skip reason. It never contacts the daemon.

## Supported rewrites

| `sf` command | `sfd` command | Notes |
| --- | --- | --- |
| `data query` | `query` | `-q` / `--query` is required. `-t` / `--use-tooling-api` becomes `--tooling`; `--all-rows` becomes `--all`. `-r csv` / `--result-format csv` becomes `--csv`; `-r human` and `-r json` are accepted and dropped. |
| `apex run test` | `test` | Needs a positive `-w` / `--wait`, or `--synchronous`. `-n`, `-t`, `-s`, `-l`, `-c` and `-w` map directly. `--synchronous` is dropped, because `sfd test` always waits for the run. |
| `apex list log` | `logs` | Lists recent logs; automatic TraceFlag setup applies. |
| `apex get log` | `logs get` | `-i` / `--log-id` or `-n` / `--number 1` required. Output directory options stay with `sf`. Filtered output. |
| `apex run` | `apex` | `-f <file>` maps directly. Code can also come from a pipeline into the command (`cat x.apex \| sf apex run`) or a heredoc. |
| `project deploy start` | `deploy` | Needs `-d` or `-m`. `--dry-run` becomes `--check-only`. `-d`, `-m`, `-l`, `-t` and `-w` map directly. |
| `project retrieve start` | `retrieve` | `-d`, `-m`, `-x` / `--manifest`, `-w` and `-c` / `--ignore-conflicts` map directly. No selector pulls remote changes. Selectors are mutually exclusive. |
| `sobject describe` | `describe` | `-s` is required. `-t` becomes `--tooling`. |
| `api request rest` | `rest` | Exactly one path. `-X` and `--body` map directly. A body needs an explicit method other than GET, because `sf` ignores bodies with GET while `sfd` infers POST from a body. |
| `org list metadata-types` | `list-metadata-types` | `-o` supported; API-version and output-file flags stay with `sf`. |
| `org list metadata` | `list-metadata` | `-m` / `--metadata-type` required; `--folder` supported. API-version and output-file flags stay with `sf`. |
| `org list` | `org list --status` | `--skip-connection-status` omits `--status`; `--all` and `--json` carry through. `--clean`, `--verbose`, `-p` and `--no-prompt` stay on `sf`. No target-org flag. |
| `org display` | `org` | `-o` and `--json` only. |

Mapped commands except `org list` keep `-o <alias>`. The `--json` flag is dropped
except for `org list`, which returns its compact public fields as JSON. Dropping it
means the rewritten command prints sfd's compact output, not sf's JSON
envelope. `SF_TARGET_ORG=<alias>` as a leading env assignment is kept in front
of the rewritten command.

Rewritten commands keep a trailing `2>&1` or `2>/dev/null`. A leading
`cd <directory> &&` is kept too.

## Left unchanged

The rewriter skips these, and the agent runs the original command:

- Retrieve output-directory, metadata-directory, package and zip options
  (`-r`, `--output-dir`, `-t`, `--target-metadata-dir`, `-n`, `--package-name`,
  `-z`, `--unzip`). Retrieve/deploy preview commands remain unmapped: they
  preview selected operations and ignored files, rather than list all tracked changes.
- Commands not in the table, legacy `sfdx` commands, and executable paths.
- Env prefixes other than `SF_TARGET_ORG=`.
- Output redirection (`>`, `>>`, `<` other than a heredoc into `apex run`), and
  `2>&1` anywhere but the end of the command.
- Output piped into another command, such as `sf ... | jq`. Piping into
  `sf apex run` is supported.
- Chains other than a leading `cd <dir> &&` (`;`, `||`, `&`, and so on).
- Shell expansion: `$` and backticks, even inside double quotes, and
  `( ) { } [ ] * ? ~ #` outside quotes. Single-quoted text is literal.
- Multi-line commands, other than a heredoc feeding `sf apex run` with a
  literal delimiter.
- Flags not in the table (for example test report output options), duplicate
  flags, missing values, and values that start with `-`.
- Result formats other than `human` or `json` (also `csv` for queries), and
  `--verbose` on `org display`.

## Extending the rewriter

1. Add an entry to `mappings` in `src/rewrite.mjs`. Each entry has the `sf`
   command words, the `sfd` subcommand, and a flag table. Each flag is
   `[sf names, sfd flag or "" to drop, takes a value, repeatable]`. Flags not
   in the table are skipped. Required-flag and value checks live in `mapArgs`.
2. If the `sfd` subcommand is new, add it to `bin/sfd.mjs` first (`options`
   and the request switch). Then add its entry to `COMMANDS` in
   `src/commands.mjs`, which generates its `--help` line and its agent snippet
   line.
3. Add rewrite cases to `test/rewrite.test.mjs`. Add adapter cases to
   `test/hooks.test.mjs` if the response shape changes.
4. Update the table above and the command table in the [README](../README.md).

`sfd discover` also calls `rewrite()` and `lex()` to classify commands from
local transcripts. A rule change therefore moves its rewritable and skipped
counts. See [discover.md](discover.md).

Run `npm test` before committing.
