# Agent snippet

`sfd agents-snippet` prints a short Markdown block that tells coding agents to
prefer `sfd` over `sf`. With `--write`, it keeps that block in a project's
`AGENTS.md` or `CLAUDE.md`. Use it for agents without a rewrite hook and for
project onboarding. For automatic rewriting, see
[agent-hooks.md](agent-hooks.md).

Source: `src/snippet.mjs` (block text and marker upsert), `src/commands.mjs`
(the `COMMANDS` table that feeds both `--help` and the block), and the
`agents-snippet` branch of `bin/sfd.mjs` (argument checks and file selection).
Tests: `test/snippet.test.mjs`. The command needs no org and never starts the
daemon.

## Output

The block starts with `<!-- sfd:start -->` and ends with `<!-- sfd:end -->`. In
between are a preamble, one bullet per command or command group, and a footer
with the `-o` rule, the exit codes and the `sf … --json` fallback. Run
`sfd agents-snippet` to see the current text.

The block must stay at 15 lines or fewer (tested). Agents load it into every
session, so keep each tip short.

## Command metadata

Each `COMMANDS` entry in `src/commands.mjs` has these fields:

| Field | Used by | Notes |
| --- | --- | --- |
| `name` | `--help`, snippet | Subcommand words. May contain spaces (`logs get`) or a literal alternation (`start \| stop \| status \| reload`). |
| `args` | `--help`, snippet fallback | Usage placeholder, such as `<soql>`. Empty is allowed. |
| `summary` | `--help`, snippet fallback | Help text. Newlines are allowed: they become continuation lines in help and spaces in the snippet. |
| `agentTip` | snippet | Optional. Format `<usage>: <description>`. |
| `agentGroup` | snippet | Optional. Consecutive entries with the same group share one bullet, joined by `; `. |

Snippet line rules:

- Without `agentTip`, the tip is `${args}: ${summary}`.
- The text before the first `": "` becomes the usage after `sfd <name>`. The
  text after it is the description. Use `": description"` when there is no
  usage. **Every tip must contain `": "`**. Snippet generation rejects invalid
  tips with an error naming the command.
- `commandHelp()` builds the `--help` command list from the same table. Syntax
  is padded to 22 columns. Longer syntax moves the description to its own line.
- Adding a command means adding an entry to `COMMANDS`. Both `--help` and the
  snippet pick it up. The `--help` text is pinned by a test in
  `test/snippet.test.mjs`, so update that test when the help text changes on
  purpose.

## Writing into a file

`sfd agents-snippet --write [file]` chooses its target like this:

- With a path, the path resolves from the current directory.
- Without a path, the target is the project root (`findProjectDir(cwd)`, or the
  current directory outside a project). It is the first existing `AGENTS.md`,
  then `CLAUDE.md`. If neither exists, `AGENTS.md` is created.

`upsertSnippet(text, block)` in `src/snippet.mjs` applies these rules:

- Both markers present, start before end: only that range (markers included) is
  replaced. Every other byte is kept.
- No markers: the block is appended after the existing text, trimmed of trailing
  whitespace, with one blank line between them and a trailing newline. An empty
  file gets just the block.
- Only one marker, markers in the wrong order, more than one block, or nested
  markers: the upsert throws. The CLI exits 2 with
  `Malformed sfd block in <file>: <reason>` and leaves the file unchanged.

The file is written only when its content changes. The CLI prints `Created
<file>`, `Updated <file>`, or `<file> already up to date`.
Target read or write failures are usage errors (exit 2), with the target path
and filesystem error in the message. A missing file is created if its parent
directory exists.

Argument rules: without `--write`, the command takes no positional argument.
With `--write`, it takes at most one path. Anything else is a usage error
(exit 2).

## Keeping it in sync

- Change command wording in `COMMANDS`. Change the preamble or footer in
  `src/snippet.mjs`. The footer's exit codes must match `bin/sfd.mjs`.
- When the command list changes, update the README command table and the
  "Using sfd with coding agents" section.
- Run `npm test` before committing. It covers the upsert rules, file selection,
  malformed-block errors, the no-daemon guarantee and the help text.
