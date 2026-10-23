# Query output

`sfd query`: the row limit, the CSV layout, the output mode for each flag
combination, the sf-compatible `--sf-json` envelope, and the truncation trailer.
Source: `src/handlers.mjs` (the `query` handler and its paging loop),
`src/format.mjs` (`compactQuery`, `flattenRecord`, `toCsv`), `src/sf-json.mjs`
(`sfJson.query`, `sfEnvelope`), and `bin/sfd.mjs` (`queryLimit`, the query case in
`run`, and the trailer). Tests: `test/handlers.test.mjs` (limit paging and
slicing), `test/format.test.mjs` (`toCsv`, `flattenRecord`), `test/cli.test.mjs`
(stdout and stderr by mode, `--limit` validation) and `test/sf-json.test.mjs`.

```bash
sfd query "SELECT Id, Name, Owner.Name FROM Account" --csv --limit 200
sfd query "SELECT Id FROM Account" --limit 50
sfd query "SELECT Id FROM Account" --limit 50 --json
```

## Limits

- Without `--limit`, every page is fetched and the output is the compact JSON
  (`totalSize`, `done`, `nextRecordsUrl` when Salesforce supplies one, and
  `records` with `attributes` stripped).
- `--limit <n>` must be a positive safe integer. Anything else is a usage error
  (exit 2) with `--limit must be a positive integer.`
- Paging stops once at least `n` records are fetched, and the records are then
  sliced to exactly `n`. No `queryMore` call is made after that point.
- A SOQL `LIMIT` and `--limit` can coexist; the smaller one wins.
- `totalSize` stays the server's total, not `n`.
- `truncated: true` is set when paging stopped early or records were cut. It is
  absent otherwise.
- `nextRecordsUrl` is kept as Salesforce returned it. It points past the last
  fetched page. When records were cut by the limit, it does not resume at the
  row after the last one returned, so rows that were fetched but not shown are
  skipped. Do not use it to resume a limited query.

## Output by mode

| Flags | stdout | stderr |
| --- | --- | --- |
| none | Compact JSON, then the trailer line if truncated | Trace notice, if one was written |
| `--csv` | CSV only. Nothing at all when there are no rows | Trace notice, if one was written, then the trailer if truncated |
| `--json` | The daemon response (`status`, `result` with `truncated`) | Trace notice, if one was written |

`--json` takes precedence over `--csv`. It returns the daemon response with
truncated records and the `truncated` flag, and it prints no trailer.

## CSV layout

- The header row lists the union of flattened keys across the returned records,
  in first-seen order. An empty result has no header, because there are no
  columns to infer.
- A parent relationship flattens to dotted columns: `Owner.Name`, and
  `Owner.Manager.Name` for a deeper parent.
- A child subquery becomes compact JSON in one cell, with `attributes` stripped
  (for example `[{"Name":"Kid"}]`).
- A null relationship produces empty cells in the dotted columns of the other
  rows, not an extra parent column. If every returned row has the relationship
  null, the parent column is kept with empty cells.
- Quoting follows RFC 4180. A field containing `,`, `"`, CR or LF is quoted and
  embedded quotes are doubled. Numbers and booleans use their JavaScript string
  form. Null and undefined are empty. Lines end with `\n`.

## Truncation trailer

```text
… 5,011 more rows not shown (totalSize 5,012); raise --limit or narrow the query
```

The count is `totalSize` minus the rows returned, and numbers use en-US
separators. In the default mode the line is written to stdout after the JSON.
With `--csv` it goes to stderr so stdout stays valid CSV.

## Agent hook

The hook rewrites `sf data query -q "SELECT Id FROM Account" -r csv` to
`sfd query 'SELECT Id FROM Account' --csv`. `--result-format=csv` works too.
The `human` and `json` result formats are accepted and dropped, as described in
[agent-hooks.md](agent-hooks.md). Other result formats are left for `sf`.

## Changing this area

- Keep the paging and truncation rules above in sync with the `query` handler
  in `src/handlers.mjs`. The limit-stopping condition, the slicing, and the
  `truncated` flag all live there.
- CSV changes belong in `toCsv` or `flattenRecord` in `src/format.mjs`. Add a
  case to `test/format.test.mjs` for each new rule.
- The trailer and output-mode rules are in `run` in `bin/sfd.mjs`. Keep the
  stdout and stderr split as the table describes, and keep the README and
  `USAGE` flags in sync.

## sf-compatible JSON

`--sf-json` requests raw records (including relationship `attributes`) and
prints `{status: 0, result, warnings: []}`. A completed query omits
`nextRecordsUrl`. It fetches every page, even beyond sf's configurable fetch
cap. It cannot be combined with `--limit`, `--csv` or `--json`. Consumed
`sf data query --json` calls use this mode through the rewrite hook.
