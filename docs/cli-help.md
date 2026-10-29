# CLI help and version

`sfd --help`, `sfd <command> --help` and `sfd --version` are generated from the
`COMMANDS` table in `src/commands.mjs`. None of them contacts or starts the
daemon. `sfd help` (command manuals and concept guides) is a separate feature,
documented in [help-topics.md](help-topics.md).

Source: `src/commands.mjs` (the `COMMANDS` table, `commandHelp()` and
`commandUsage()`), the `USAGE` string and the `--help`/`--version` branches of
`bin/sfd.mjs`, and `src/version.mjs`. `bin/sfd.mjs` imports `VERSION` through
`src/client.mjs`, which re-exports it. Tests: `test/cli.test.mjs` (per-command
help, `--version`) and `test/snippet.test.mjs` (the top-level list).

## The COMMANDS table

Each entry in `src/commands.mjs` has these fields:

| Field | Used by | Notes |
| --- | --- | --- |
| `name` | help, snippet | Subcommand words. May contain spaces (`logs get`, `org list`). |
| `args` | help, snippet fallback | Usage placeholder, such as `<soql>`. Empty is allowed. |
| `summary` | help, snippet fallback | Help text. Newlines are allowed: they become continuation lines in help and spaces in the snippet. |
| `agentTip` | snippet | Optional. Format `<usage>: <description>`. See [agents-snippet.md](agents-snippet.md). |
| `agentGroup` | snippet | Optional. Consecutive entries with the same group share one bullet, joined by `; `. |
| `targetOrg` | per-command help | Optional. `false` omits the `-o, --target-org` line from `sfd <name> --help`. Set it on commands that take no org (`org list`, `agents-snippet`, `start`, `stop`, `status`, `reload`). Absent means the line is shown. |
| `json` | per-command help | Optional. `false` omits `--json` for commands without JSON output (`agents-snippet`, `start`, `stop`, `reload`). Absent means the line is shown; `status` supports JSON. |

The four lifecycle commands (`start`, `stop`, `status`, `reload`) each have their
own entry, so each has specific help. They share `agentGroup: "lifecycle"`, so
the agent snippet joins them into one bullet.

## Top-level help

`sfd --help` prints the `USAGE` string in `bin/sfd.mjs` with `commandHelp()`
inserted under `Commands:`.

- `commandHelp()` lists every entry except the lifecycle group, then appends one
  hardcoded row, `start | stop | status | reload`. The top-level list keeps that
  combined row. A new lifecycle command also needs that row updated.
- The `help` entry is a regular row. Its syntax is `help [-a | -g] [<command|guide>]`.
- Below the list, the top-level help ends with `Run 'sfd help <command|guide>' for
  full documentation.` and then the exit codes.
- Syntax is padded to 22 columns. Longer syntax moves the description to the
  next line, indented to the description column.
- `test/snippet.test.mjs` compares the top-level list against a snapshot.
  Update the snapshot when the text changes on purpose.

## Per-command help

`sfd <command> --help` prints `commandUsage(name)` from `src/commands.mjs`:

```
Usage: sfd <name> <args> [options]

<summary, line breaks kept>

Common options:
  -o, --target-org <alias>  Select the target org
  --json                    Print the raw JSON response
  -h, --help                Show this help

Run 'sfd help <command|guide>' for full documentation.
```

The `-o` line is omitted when the entry sets `targetOrg: false`, and the
`--json` line is omitted when it sets `json: false`. The `--help` line is
shown for every entry. The footer line is appended to every usage block.

The `help` entry adds an `Options:` block with `-a, --all` and `-g, --guides`.
Its manual, `sfd help <command>`, is a separate output. See
[help-topics.md](help-topics.md).

- `bin/sfd.mjs` picks the key. The `["logs get", "org list"]` list is matched as
  one key first; otherwise the first word is used.
- `hook` and `discover` print their own usage line and do not use
  `commandUsage`.
- An unknown command with `--help` exits 2. The message `Unknown command: <name>.
  Run sfd --help.` goes to stderr, and stdout is empty. It does not fall back to
  the top-level help.

## Version

`sfd --version` and `sfd <command> --version` both print `sfd <VERSION>` and exit
0. The check runs first in `run()` in `bin/sfd.mjs`, before any dispatch, so it
wins over commands, `--sf-json`, and the `hook` and `discover` branches.

`VERSION` is read from `package.json` in `src/version.mjs`. The same module
exports `PROTOCOL` (the version plus the newest source mtime). `PROTOCOL` is the
daemon handshake value, not the printed version.

## Keeping it in sync

- Adding a command means adding a `COMMANDS` entry with a `": "` tip (see
  [agents-snippet.md](agents-snippet.md)). Set `targetOrg: false` if it takes no
  org, and `json: false` if it has no JSON output. `test/cli.test.mjs` then
  checks its `--help` output.
- A new two-word command also needs its name in the `["logs get", "org list"]`
  list in `bin/sfd.mjs`. Without it, `sfd <a> <b> --help` shows the first word's
  help.
- A new lifecycle command also needs the combined row in `commandHelp()` updated.
- A command with documentation gets a `docs` field in its entry. That field
  feeds `sfd help <command>` and is described in [help-topics.md](help-topics.md).
  The usage block here is only the first part of that manual.
- When the command list changes, update the README command table and the
  "Using sfd with coding agents" section.
- Run `npm test` before committing.
