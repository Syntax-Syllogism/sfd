# Help topics

`sfd help` shows command manuals and concept guides. Like `--help`, it never
contacts or starts the daemon.

Source: `src/help-topics.mjs` (guide discovery, manual assembly, link rewriting,
unknown-topic suggestions, the startup mapping check), the `help` branch of
`run()` in `bin/sfd.mjs`, and the `help` entry and the `docs` fields in
`src/commands.mjs`. Tests: `test/help-topics.test.mjs` (mappings, guide names,
section extraction, link rewriting) and `test/cli.test.mjs` (output, exit codes).

## Invocations

| Invocation | Output |
| --- | --- |
| `sfd help` | The `Commands:` list and the `Guides:` list, then a footer. |
| `sfd help -a`, `sfd help --all` | The same as `sfd help`. |
| `sfd help -g`, `sfd help --guides` | The `Guides:` list only, without the footer. |
| `sfd help <command>` | The command manual. Multi-word commands are passed as separate words, as in `sfd help logs get`. |
| `sfd help <guide>` | The guide's Markdown, with relative links rewritten. |
| `sfd help --help` | The usage for `sfd help`. |

Usage errors exit 2:

- `-a` or `-g` with a topic, or both `-a` and `-g`.
- An unknown flag, such as `--csv`. Node's argument parser reports these.
- An unknown topic. The message goes to stderr, suggests up to three close
  names (edit distance of at most `max(2, length / 3)`), and points to
  `sfd help -a`.

A topic is resolved in order: a command name (`COMMANDS`) first, then a guide
name. A name cannot be both, because `assertManualMappings()` throws when a guide
name equals a command name, and the test suite runs that check.

## Guides

Every `docs/*.md` file is a guide. There is no list to update. `listGuides()`
reads the directory, sorts the files and takes the guide's name and description
from the file:

- **Name**: the file's base name, with two rules. `query.md` is named
  `query-output`. A file whose base name matches a command name gets a `-guide`
  suffix, so `discover.md` is `discover-guide`. Both rules avoid collisions with
  commands.
- **Title**: the first H1. A file without one throws.
- **Description**: the first sentence of the first paragraph, with backticks
  removed. Write that paragraph as a one-line summary, because it appears in the
  index.

Guides ship in the npm package (`docs` is in `files` in `package.json`), so each
one must stand alone: no references to private tooling, notes or internal
workflow.

Relative links to other `.md` files are rewritten in guides and mapped command
documentation. Each
link becomes `` `<label>: sfd help <guide>` ``, or `` `<label>: sfd help -a` `` if
the target is not a guide. Fragments such as `#keeping-it-in-sync` are dropped,
so the link goes to the whole guide. External `http(s)` links are left as they
are.

## Command manuals

A command's manual is built from its `COMMANDS` entry (`renderCommandManual()`).
The sections, in order, are:

1. The usage block from `commandUsage()` (see [cli-help.md](cli-help.md)).
2. `## Tips for agents` with the entry's `agentTip`, when it has one.
3. Each file in the entry's `docs` array, in order.
4. `See also: sfd help <guide>, ...` for those files, or `sfd help -a` when there
   are none.

A `docs` item is `{ "file": "query.md" }`. It may also set `heading`, which
includes only that section of the file. `extractSection()` matches the heading
case-insensitively and ignores backticks. It skips headings inside fenced code,
and ends the section at the next heading of the same or a higher level. No entry
uses `heading` yet.

Mapped documentation passes through `rewriteDocLinks()` after any section
extraction, so command manuals use the same CLI help references as guides.
Agent tips omit the leading `: ` separator used by entries without arguments.

Plugin tables add grouped commands to the index and flag manuals to topic
resolution. Namespace topics list their commands. Descriptor summaries and
effects are refreshed by `sfd plugin list`; see [plugins.md](plugins.md).

## Keeping it in sync

- New concept guide: add `docs/<name>.md` with an H1 and a one-line first
  paragraph. It is listed by `sfd help -a` with no other change.
- New command documentation: add a `docs` entry to the command's `COMMANDS` row.
  Prefer the one file that covers the command, so the manual stays short.
- Name a guide so that it cannot match a command name. Otherwise
  `assertManualMappings()` throws, and `npm test` fails.
- Run `npm test` before committing.
- Keep [cli-help.md](cli-help.md) and this file in step when the help output or
  the `help` branch changes.
