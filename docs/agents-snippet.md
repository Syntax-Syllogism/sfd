# Agent snippet

`sfd agents-snippet` prints a short Markdown block that tells coding agents to
prefer `sfd` over `sf`. With `--write`, it keeps that block in a project's
`AGENTS.md` or `CLAUDE.md`. Use it for agents without a rewrite hook and for
project onboarding. For automatic rewriting, see
[agent-hooks.md](agent-hooks.md).

Source: `src/snippet.mjs` (block text and marker upsert), and the
`agents-snippet` branch of `bin/sfd.mjs` (argument checks and file selection).
The tips come from the `COMMANDS` table in `src/commands.mjs`, documented in
[cli-help.md](cli-help.md). Tests: `test/snippet.test.mjs`. The command needs no
org and never starts the daemon.

## Output

The block starts with `<!-- sfd:start -->` and ends with `<!-- sfd:end -->`. In
between are a preamble, one bullet per command or command group, and a footer
with the `sfd help <command>` pointer, the `-o` rule, the exit codes and the
`sf … --json` fallback. The `help` entry in `COMMANDS` gets no bullet: its
`agentTip` is not used. Run `sfd agents-snippet` to see the current text.

The built-in block must stay at 15 lines or fewer (tested). Plugin commands
use an additional budget of six per plugin and 20 overall; omitted commands
collapse to a namespace help pointer. Without plugins, output is unchanged.
Agents load it into every session, so keep each tip short.

## Snippet line rules

- Without `agentTip`, the tip is `${args}: ${summary}`.
- The text before the first `": "` becomes the usage after `sfd <name>`. The
  text after it is the description. Use `": description"` when there is no
  usage. **Every tip must contain `": "`**. Snippet generation rejects invalid
  tips with an error naming the command.
- `agentGroup` entries that are adjacent in `COMMANDS` share one bullet, joined
  by `; `. The four lifecycle entries form one bullet this way.
- Without `agentTip`, newlines in `summary` become spaces in the snippet.

Plugin tips use the same separator. A missing tip or one without `": "`
falls back to the command summary with no usage suffix, so a malformed plugin
tip cannot prevent the snippet from rendering.

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
  "Using sfd with coding agents" section. Other steps for adding a command are
  in [cli-help.md](cli-help.md#keeping-it-in-sync).
- Run `npm test` before committing. It covers the upsert rules, file selection,
  malformed-block errors, the no-daemon guarantee and the snippet's line limit.
