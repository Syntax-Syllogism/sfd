# Debug logs

`sfd logs`, `sfd logs get` and `sfd test --logs`: listing and reading Apex
debug logs, the TraceFlag setup they trigger, and the filtered output format.
Source: `src/handlers.mjs` (`logs`, `logGet`, the `test` handler, `ensureTrace`,
`traceFor`, `afterTrace`, `logRows`, `logBody`), `src/format.mjs` (`filterLog`,
`formatLog`, `formatLogList`, `formatTests`), `bin/sfd.mjs` (options and the
stderr notice), `src/server.mjs` (returns `trace` with error responses) and
`src/rewrite.mjs` (`apex list log`, `apex get log`). Tests:
`test/handlers.test.mjs`, `test/format.test.mjs`, `test/cli.test.mjs`,
`test/rewrite.test.mjs`. `test/org.test.mjs` has an opt-in check of `logs` and
`logs get latest` against a real org (`SFD_TEST_ORG=<alias> npm test`).

## Commands

```bash
sfd logs [--count 10] [--user <username>]   # one line per log, newest first
sfd logs get <id|latest>                    # filtered body with a header
sfd logs get latest --full                  # raw body text
sfd test --logs                             # run tests, then attach logs
```

- `--limit` is an alias of `--count`. The count must be a positive integer.
- `logs get` takes a 15- or 18-character `07L` ApexLog ID, or `latest`, which
  is the authenticated user's most recent log.
- `--user` filters the list only. It never enables tracing for another user.
- `--no-trace` skips TraceFlag setup for one call.

## TraceFlag setup

`logs`, `logs get` and `test --logs` need a developer TraceFlag for the
authenticated user. Before each of these calls, sfd ensures one:

1. It looks for a `DEVELOPER_LOG` TraceFlag on the user that has started and
   expires more than five minutes from now. If one exists, nothing is written.
2. Otherwise it updates an existing `DEVELOPER_LOG` TraceFlag for the user, or
   creates one if none exists. The window is 30 minutes from now.
3. Creating a flag needs a `DebugLevel` named `SFD`. If none exists, sfd creates
   it once and reuses it: ApexCode `FINE`, System `DEBUG`, Apex profiling,
   callout, database, validation and workflow `INFO`, and Visualforce, Wave and
   Nba `NONE`. Flags that sfd extends keep their existing level.

Setup needs Tooling API permission to manage TraceFlag and DebugLevel records.

When sfd writes a TraceFlag, it prints one notice on stderr:

```text
sfd: enabled debug logging for <username> until <expiry> (TraceFlag <id>)
```

The notice appears even with `--json`, so stdout stays parseable. If a later
step fails (for example, `logs get` finds no logs), the error response still
carries the notice (`trace` in the daemon response).

### Serialization and caching

- TraceFlag setup runs in its own queue (`traceQueue` in `src/handlers.mjs`),
  separate from the deploy/retrieve/tracking queue. Concurrent calls therefore
  create at most one flag.
- A successful check is cached in daemon memory per org alias, with the user id
  and expiry. Later calls skip the query while the cached expiry is more than five
  minutes away.
- The cache is cleared by an auth refresh, by a retried session error for that
  alias, and by `sfd reload`.

## Filtered output

`sfd logs get` and `sfd test --logs` use `filterLog`. It keeps these lines and
drops the rest:

| Log event | Rendered as |
| --- | --- |
| `USER_DEBUG` | `[<line>] <message>` (includes `EXTERNAL` debug lines) |
| `FATAL_ERROR` | `FATAL: <message>` |
| `EXCEPTION_THROWN` | `EXCEPTION <message>` |
| `VALIDATION_FAIL`, `VALIDATION_ERROR` | `VALIDATION <message>` |
| `FLOW_ELEMENT_ERROR` | `FLOW <fields>` |
| Limit usage at or above 50% of the maximum (`LIMIT_USAGE_FOR_NS` block) | `LIMIT <name> <used>/<max>` |

Flow limit-summary events (`FLOW_INTERVIEW_FINISHED_LIMIT_USAGE`) are omitted;
they do not indicate Flow errors. Limit diagnostics come from the thresholded
`LIMIT_USAGE_FOR_NS` block.

Consecutive identical lines collapse into one line with a `×N` suffix. The
`logs get` output starts with a header, `<operation> <status> <duration>ms
<size>`. `logs` lists one line per log: `<Id> <start time> <operation>
<status> <size> <duration>ms`.

`logs get --full` prints the original body with no header or filtering. The JSON
output always contains the original body.

Anonymous Apex (`sfd apex`) uses a narrower rule in `formatApex`: only
`USER_DEBUG` lines (not `EXTERNAL`) and `FATAL_ERROR` lines, with no
deduplication and no limit or exception lines. `--log` prints the full log. Keep
that behavior when changing `filterLog`; `test/format.test.mjs` covers it.

Example, from `test/fixtures/sample.log`:

```text
Test Failed 12ms 2.0 KB
[3] hello
EXCEPTION [9] System.NullPointerException: boom ×2
FATAL: System.NullPointerException: boom
VALIDATION
VALIDATION Bad value
FLOW bad flow UpdateRecords
LIMIT SOQL 87/100
LIMIT CPU time 5000/10000
```

## `test --logs`

With `--logs`, the test handler:

1. Ensures TraceFlag setup (unless `--no-trace`) before the run starts.
2. Records the client-side start and finish times around the run, subtracting
   five minutes from the start and adding five minutes to the finish to allow
   for clock skew with Salesforce. Rounds the start down and the finish up to
   whole seconds for SOQL UTC datetime literals.
3. Queries up to ten `ApexLog` rows for the current user whose `StartTime` falls
   in that window, newest first.

Output depends on the result:

- If the run has no failures, the summary lists only the log IDs.
- If any test fails or any setup failure occurs, every listed log includes its
  filtered body.

Other operations by the same user during the padded window can also appear in
the list. The allowance covers clock differences of up to five minutes in
either direction; larger differences can still omit logs.

## Changing this area

- Keep the TraceFlag rules above in sync with `ensureTrace` and `traceFor`.
  `test/handlers.test.mjs` covers creation, extension, active flags, concurrent
  setup, caching and notices after errors.
- Filter changes belong in `filterLog` in `src/format.mjs`. Add cases to
  `test/format.test.mjs`, and update the example above if the output changes.
- The agent hook maps `apex list log` and `apex get log`. Keep their rows in the
  table in [agent-hooks.md](agent-hooks.md) and in `mappings` in
  `src/rewrite.mjs` in sync, with cases in `test/rewrite.test.mjs`.
- The README's debug-log summary and command table must match the flags in
  `bin/sfd.mjs`.
