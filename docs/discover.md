# Discover

`sfd discover`: which local transcripts are read, how each shell call is
classified, how the savings estimates are derived, the text and `--json`
output, and the diagnostics. Source: `src/discover/index.mjs` (`discoverOptions`,
`classify`, `discover`, `formatReport`), `src/discover/shared.mjs` (file
selection, streaming lines, timestamp filter, output sizing),
`src/discover/claude.mjs`, `src/discover/codex.mjs` and
`src/discover/gemini.mjs` (readers), `src/discover/worker.mjs` (one worker thread
per agent), the `discover` branch in `bin/sfd.mjs` (before the daemon switch),
the `discover` entry in `COMMANDS` (`src/commands.mjs`), and `lex` and `rewrite`
in `src/rewrite.mjs`. Tests: `test/discover.test.mjs` with fixtures in
`test/fixtures/discover/`. `test/snippet.test.mjs` also excludes the discover
line when it checks that help output is unchanged.

```bash
sfd discover
sfd discover --since 12h --agent claude --agent codex --project /path/to/project
sfd discover --top 5 --json
```

`sfd discover` never starts or contacts the daemon, needs no org or auth, makes
no network calls and writes nothing. It does not run the commands it finds.

## Flags

| Flag | Meaning |
| --- | --- |
| `--since <n>d\|<n>h` | Window. Default `30d`. Any other value is a usage error (exit 2). |
| `--agent claude\|codex\|gemini` | Repeatable. Default: all three. Duplicates are ignored. Any other name is a usage error. |
| `--project <path>` | Keep only records whose working directory is this path or below it. Relative paths resolve from the current directory. |
| `--top <n>` | Text output only: how many items each ranked list shows. Positive safe integer, default `10`. |
| `--json` | Print the full report object instead of the text summary. |
| `-h`, `--help` | Print the usage line. |

Positional arguments are a usage error.

## Stores and readers

Each reader is an async generator that yields records shaped as
`{ agent, ts, command, cwd, session, durationMs?, outputChars? }`. `session` is
the transcript file path. Missing stores are treated as empty.

| Agent | Store | Shell calls read | Duration | Output size |
| --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` | `tool_use` with `name: "Bash"` and a string `input.command` | Result line timestamp minus call line timestamp, paired by `id` and `tool_use_id` | `tool_result.content` length; a non-string value is measured as its JSON text |
| Codex CLI | `~/.codex/sessions/**/*.jsonl` | `response_item` `function_call` named `shell`, `shell_command` or `exec_command`, with JSON `arguments` | Output line timestamp minus call line timestamp, paired by `call_id` | `function_call_output.output` length |
| Gemini CLI | `~/.gemini/tmp/**/chats/*.json` and `~/.gemini/tmp/**/logs.json` | `messages[].toolCalls[]` named `run_shell_command` with `args.command` | None today. The reader sets no duration | `toolCalls[].result` length |

- **Claude:** A call with no matching result is still yielded, without a
  duration or output size. Only calls that mention `sf`, `sfd` or `sfdx` are
  tracked.
- **Codex:** `command` or `cmd` is accepted. An argv array is joined into one
  quoted string, except that `bash`/`sh` with `-lc`/`-c` and exactly three
  elements is unwrapped to its script. The working directory is `arguments.workdir`,
  or the last `cwd` seen in a `session_meta` or `turn_context` line. Custom tools,
  including JavaScript `exec` tools, are ignored, so `sf` calls made through them
  are not counted.
- **Gemini:** The file is read whole and may be a bare array or an object with
  `messages`. The timestamp is `toolCalls[].timestamp`, falling back to the
  message timestamp. The working directory is `args.directory`, then the message
  `cwd`, then the document `cwd`. Gemini's formats vary, so only the shapes above
  are supported. A `logs.json` with only user messages has no shell calls.

### Selection and time filter

1. Store files are found recursively. Files with a modification time older than
   `--since` are skipped without being opened.
2. JSONL is streamed line by line, so large files are never held whole. Each
   record's timestamp must be at or after the window start. A record with an
   missing or unparseable timestamp is dropped and counted as malformed.
3. `--project` requires a string `cwd`. Records without one are excluded when the
   filter is set.

Agents are read in parallel, one worker thread each. The worker classifies every
record and returns only aggregate-ready observations to the main thread.

## Classification

Each shell tool call is classified once, from its command string:

- Words before the command are skipped: leading `VAR=value` assignments, and
  `env`, `rtk`, `proxy` and `command`. Splitting happens at `&&`, `||`, `;`, `|`,
  newline and `&`.
- A call's subcommand is its longest recognized command path. The allowlist in
  `src/discover/index.mjs` covers sf commands and common legacy paths; sfd paths
  come from `COMMANDS`. Trailing positional values are omitted. Unknown paths
  use `(unrecognized subcommand)`; a call with no path uses `(no subcommand)`.
- The invocation is the first `sf` or `sfdx` in the command. If there is none,
  it is the first `sfd`. A compound call is therefore counted once, by its first
  `sf`/`sfdx`. Its later segments are not counted separately.

Then each call falls into one class:

| Class | Rule |
| --- | --- |
| `adopted` | The invocation is `sfd`. |
| `legacy` | The invocation is `sfdx force:*`. Other `sfdx` calls follow the rewrite engine and are skipped as unsupported invocations. |
| `rewritable` | `rewrite(command)` on the whole original command returns a command. The hook would rewrite it. |
| `unsupported` | `rewrite` skips with `unsupported sf command`. |
| `skipped` | `rewrite` skips with any other reason. Calls are grouped by that reason, with command values removed and flag names retained. |

Because the classifier is `rewrite()`, changing a mapping or skip rule in
`src/rewrite.mjs` changes the counts. `docs/agent-hooks.md` covers the rewrite
rules.

## Estimates

- **Time saved:** the sum over rewritable calls with a duration of
  `max(0, duration - 300 ms)`. The 300 ms is the assumed cost of an sfd call.
  Durations include permission wait, so this is an upper-bound estimate.
- **Output tokens:** the sum of output characters over rewritable calls with an
  output size, divided by four. This is potential savings before sfd's own output,
  which is not measured.
- **Unknowns:** a missing duration or output size stays unknown and is never
  extrapolated. The text output says `time unknown` or `output unknown` when a
  total has no samples. It also prints the sample count when it has one.
- **Medians:** each group in `commands` reports a median duration and median
  output size from its own samples. Output tokens are the median characters
  divided by four. Groups that are not rewritable have medians but do not feed
  the totals.

## Output

### Text

```
sfd discover: <window>, <agents> agents, <sf calls> sf/sfdx calls in <sessions> sessions
  rewritable now  <n>  (~<min> min saved (<samples> samples); ~<tokens> output tokens (<samples> samples))
  skipped         <n>  <reason> <count> · …
  not in sfd      <n>  <subcommand> <count> · … (legacy <n>)
  already sfd     <n>
Top rewritable: <subcommand> <count> · …
Scan: <malformed> malformed, <ignored> ignored entries, <unreadable> unreadable files.
Durations include permission wait; savings assume 0.3 s/call. Tokens are chars/4.
Output tokens are potential savings before sfd output, which is not measured. Missing samples are not extrapolated.
Counts classify shell tool calls once; compound calls use the first sf/sfdx invocation.
```

- `sf calls` is every non-`adopted` call. `sessions` is every transcript file
  with at least one observed call, including ones that only used `sfd`.
- Each list shows the first `--top` items, or `(none)`. The `not in sfd` list
  includes `legacy` subcommands.
- The time and output parts show `time unknown` or `output unknown` when there
  are no samples.

### JSON

`--json` prints the report object, pretty-printed. Its fields are:

- `since` (ISO timestamp), `window`, `agents`, `project` (or `null`) and `top`.
  `top` is echoed back but does not limit any list in the JSON.
- `sfCalls`, `sessions` and `counts` (`rewritable`, `skipped`, `unsupported`,
  `legacy`, `adopted`).
- `estimates`: `timeSavedMs`, `durationSamples`, `outputChars`, `outputSamples`
  and `outputTokens`. These cover rewritable calls only.
- `diagnostics`: `malformedEntries`, `ignoredEntries` and `unreadableFiles`.
- `commands`: one entry per group, keyed by class, subcommand and, for skipped
  calls, reason. Each has `classification`, `subcommand`, `reason` (skipped only),
  `count`, `medianDurationMs`, `durationSamples`, `medianOutputChars`,
  `medianOutputTokens` and `outputSamples`. Medians are `null` with no samples.
- `skipReasons`, `unsupported` and `rewritable`: ranked `{ name, count }` lists,
  unlimited in JSON.

The report holds no command text, output text, or file contents. Groups are keyed
by subcommand and reason. The only path it contains is the `--project` value.

## Diagnostics

- `malformedEntries`: a JSONL line that does not parse, a Codex `arguments`
  string that does not parse, a Gemini document with a syntax error, or a candidate
  call with a missing or invalid timestamp.
- `unreadableFiles`: a store directory or file that cannot be read, other than
  missing. Also a stat failure or a stream error during reading.
- `ignoredEntries`: unrelated messages and items, non-shell tools, and results
  with no pending call. Shell calls that do not mention `sf`, `sfd` or `sfdx` are
  not counted here.

A missing store is not a diagnostic.

## Known limits

- Codex custom tools, including JavaScript `exec` tools, are ignored.
- Gemini records never have a duration, so its time estimate never contributes.
  Its output sizes do contribute when present.
- Gemini's transcript format is only partly verified. The fixtures cover the
  documented shapes, and a user-only `logs.json` has no shell calls.
- Claude calls that never receive a result are counted without a duration or
  output size.
- Output sizes are character counts, not tokens. Non-string Claude output is
  measured as JSON, so it can be larger than the text an agent saw.

## Changing this area

- To add an agent, write a reader that yields the record shape above. Then add it
  to the `readers` map in `src/discover/index.mjs` and to the map in
  `src/discover/worker.mjs`. Both maps must match, and `discoverOptions` validates
  `--agent` against the first one. Update the `--agent` text in the `discover`
  branch of `bin/sfd.mjs` and the table above.
- Keep classification in `rewrite()`, and do not copy its rules into the readers.
  Reader changes should only extract commands and sizes.
- Do not add command text, output text or file contents to the report. Keep to
  subcommand names and reasons, so `--json` stays safe to share.
- New fixtures go in `test/fixtures/discover/`. Add a `test/discover.test.mjs`
  case for each new reader shape, malformed line and classification rule.
