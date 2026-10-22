# Metadata listing

`sfd list-metadata-types` and `sfd list-metadata`: the supported type list and
its daemon cache, how member listings are queried, folder-based types, unknown
type suggestions, output formats and the `--json` shape. Source:
`src/handlers.mjs` (`metadataTypes`, `metadataSuggestion`, `listMetadataTypes`,
`listMetadata`, and the `typeCache` clears in `refreshIfAuthChanged`, `reload`
and `withConn`), `src/format.mjs` (`formatMetadataTypes`, `formatMetadataList`),
`bin/sfd.mjs` (the `list-metadata-types` and `list-metadata` cases, `--folder`
and `--details`), `src/commands.mjs` (their `COMMANDS` entries) and
`src/rewrite.mjs` (the `org list metadata-types` and `org list metadata`
mappings). Tests: `test/handlers.test.mjs` (the metadata cases),
`test/format.test.mjs`, `test/cli.test.mjs`, `test/rewrite.test.mjs`, and the
opt-in real-org case in `test/org.test.mjs` (needs `SFD_TEST_ORG`).

```bash
sfd list-metadata-types
sfd list-metadata -m Flow,Layout
sfd list-metadata -m Report --folder Public_Reports --details
```

## Type list and cache

- `listMetadataTypes` calls `conn.metadata.describe(apiVersion)` and keeps each
  `metadataObjects` entry as `{ name: xmlName, inFolder, children }`, sorted by
  name. Child names are flattened to an array.
- The cache is in daemon memory. It is keyed by org alias, then by the
  connection's API version. A pending describe is stored, so simultaneous
  callers share one request. A failed describe is removed, so the next call
  retries.
- The cache is cleared for every org when the auth stamp changes
  (`refreshIfAuthChanged`) or on `sfd reload`. It is cleared for one alias when
  `withConn` rebuilds an expired or revoked session.
- The JSON result includes `cached`, which is `true` when the type list was
  already in memory.
- Member lists are never cached. Every `list-metadata` call is live.

## Member listing

`listMetadata` runs in this order. Nothing is listed until every check passes.

1. `-m` is required, and repeated or comma-separated types are de-duplicated.
   `--folder` with more than one type is a usage error.
2. Each type must be in the cached type list. Child type names count, because
   describe advertises them. Whether the Metadata API accepts a given child type
   in `listMetadata` is up to the server.
3. For an unknown type, the error names it and adds `Did you mean <Name>?` when a
   suggestion exists. A known name that starts with the input (case-insensitive)
   wins. Otherwise the closest name within Levenshtein distance 2 is used.
4. Each type becomes one query. A folder-based type (`inFolder`) with no
   `--folder` queries its folder type instead: `<Type>Folder`. `EmailTemplate`
   uses `EmailTemplateFolder` when describe advertises it, and `EmailFolder`
   otherwise. That group is marked `folders` and gets a hint. With `--folder`,
   the query is `{ type, folder }` for the type itself.
5. `conn.metadata.list` accepts at most three queries per call. Queries are
   split into chunks of three, and the chunks run with `Promise.all`.
6. The response is normalized with `asArray`, because the server may return
   nothing, one object or an array. Members are matched to their group by
   `type` and sorted by `fullName`. Each member keeps `fullName`,
   `lastModifiedDate`, `lastModifiedByName`, `namespacePrefix` and
   `manageableState`.

Without `--folder`, a folder-based type lists folders only. To list the members
of one folder, pass `--folder <name>`. Listing every folder at once is not
supported.

## Output

`formatMetadataTypes`:

- Header: `N metadata types (API vXX.0)`.
- One line per type: `Name`, then ` (folder)` for folder-based types, then
  ` [child, child, …+N]` when children exist. At most six children are shown.

`formatMetadataList`:

- One group, not a folder group, without `--details`: bare names, one per line.
- Several groups: a `Type (N):` header for each group, with names indented by
  two spaces.
- A folder group: `<FolderType> (N): use --folder <name> to list members`,
  followed by the folder names.
- `--details` joins the name with the optional fields, separated by two spaces:
  `fullName  YYYY-MM-DD  modifier  ns:<prefix>  <manageableState>`. Empty fields
  are omitted, and the date is cut to `YYYY-MM-DD`.
- An empty group prints `(none)`.

Exit codes: 0 on success. Usage errors (missing `-m`, `--folder` with several
types, unknown type) exit 2. A Salesforce failure exits 1. A daemon failure
exits 3.

## JSON

`--json` prints the raw response. The result for `list-metadata-types` has
`types`, `apiVersion` and `cached`. The result for `list-metadata` has `groups`.
Each group has `type`, `members` (with the fields above), and, for a folder
group, `folders: true` and `folderType`.

## Rewrite hook

- `sf org list metadata-types` maps to `list-metadata-types`.
- `sf org list metadata -m|--metadata-type <Type> [--folder <name>]` maps to
  `list-metadata`. Without `-m`, the rewriter skips the command.
- `--api-version`, `-f` and `--output-file` are unsupported on both commands, so
  the rewriter skips them. The table in [agent-hooks.md](agent-hooks.md) lists
  the rest.

## Limits

- No member caching, no `package.xml` generation, and no listing of all folders
  at once.
- Standard value sets and other special cases are not listed separately. The
  output covers what `listMetadata` returns.

## Keeping it in sync

- Changes to the cache, batching or folder rules belong in `src/handlers.mjs`.
  Update this file and the handler tests together.
- A new listing option needs a `bin/sfd.mjs` option, a usage check, a `COMMANDS`
  entry (see [agents-snippet.md](agents-snippet.md)), a README row, and a
  rewrite entry when `sf` has an equivalent.
