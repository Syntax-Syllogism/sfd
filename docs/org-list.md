# Org list

`sfd org list`: which local orgs are listed, how defaults, types and expiry are
derived, what `--status` checks and how it is bounded, the `--json` allowlist,
the sf-compatible `--sf-json` envelope, and the no-token rule. Source:
`src/handlers.mjs` (`orgList`, `refreshIfAuthChanged`, `withDeadline`),
`src/format.mjs` (`formatOrgList`), `src/sf-json.mjs` (`orgEntry`,
`sfJson.orgList`), `bin/sfd.mjs` (the `org` case), and `src/rewrite.mjs` (the
`org list` mapping). Tests: `test/handlers.test.mjs` (the `org list` cases),
`test/format.test.mjs`, `test/cli.test.mjs`, `test/rewrite.test.mjs` and
`test/sf-json.test.mjs`.

```bash
sfd org list
sfd org list --all --status
sfd org list --json
```

## Which orgs are listed

- Usernames come from `AuthInfo.listAllAuthorizations()`. A `NoAuthInfoFound`
  error means there are no orgs.
- Only primary users are listed. When `~/.sfdx/<orgId>.json` exists and its
  first username is not this user, the user is skipped. The exception is a user
  that is the target-org, which is resolved against all aliases of that user.
- An auth file that cannot be read is skipped. The daemon logs a fixed warning
  that names no auth field and no vendor error text, because those can contain
  secrets.
- Each line's alias is the first alias that `StateAggregator` maps to the
  username, or `-` when there is none.
- `*` marks the target-org and `H` marks the target-dev-hub. Each config value
  can be an alias or a username.
- Type: an org with `expirationDate` or `devHubUsername` is `Scratch`. Otherwise
  it is `DevHub` (`isDevHub`), `Sandbox` (`isSandbox`) or `Org`.
- Orgs are sorted by alias, then username. Orgs without an alias sort first.

## Expiry and hidden orgs

- Without `--status`, a scratch org is expired when the date part of its local
  `expirationDate` is before today (UTC date).
- With `--status`, the Dev Hub's `ScratchOrgInfo.Status` decides. `Expired` and
  `Deleted` both mean expired. The Dev Hub's `ExpirationDate` replaces the local
  one when it is returned.
- Expired orgs are hidden unless `--all` is given. The text output then ends
  with `(<n> expired scratch org(s) hidden; use --all)`. The JSON output has no
  hint.

## `--status`

- Non-scratch orgs are checked in parallel. Each check calls `refreshAuth()` on
  the cached org, under a 10 s deadline (`withDeadline`). A success is
  `Connected`. A failure is the error's `name`, such as `RefreshTokenAuthError`,
  or `Timeout`.
- A failed or timed-out check removes the cached org, so the next call tries
  again. Results are not cached.
- Scratch orgs are grouped by `devHubUsername`. Each Dev Hub is queried once,
  under the same 10 s deadline:
  `SELECT ScratchOrg, Status, ExpirationDate FROM ScratchOrgInfo WHERE ScratchOrg IN (...)`.
  Ids are 15-character prefixes, and rows are matched on that prefix.
- Scratch orgs without a `devHubUsername` or `orgId` get no status. If the Dev
  Hub query fails, or the org is missing from its result, the status is blank
  and the local expiry is kept.

## Output

Text output has one line per org: the marker (`*` and `H`, or spaces), the
alias, the username, the type, then for scratch orgs `expires YYYY-MM-DD` or
`EXPIRED`. Columns are padded to the longest alias and username. The status
column appears only with `--status`. With no orgs the output is
`No authenticated orgs. Run: sf org login web -a <alias>`.

`--json` prints `{ "orgs": [...] }`. The handler returns `{ orgs, hiddenExpired }`,
and the CLI drops `hiddenExpired` from the JSON. Each entry has `alias`,
`username`, `orgId`, `instanceUrl`, `type`, `isDefault`, `isDefaultDevHub`, and
optionally `expirationDate`, `expired` and `status`.

## No tokens in output

`orgList` builds each entry field by field from an allowlist. It never spreads
the auth fields. No access token, refresh token or client secret appears in any
output mode, `--json` included. `test/handlers.test.mjs` checks this with a
fake that carries those values.

## Freshness

`orgList` calls `refreshIfAuthChanged()`, the same check `getOrg` uses. It
compares the modification times of `~/.sfdx` and `~/.sfdx/alias.json`. When
either changes, the handler clears its cached orgs and traces and the
`StateAggregator` instance. Logins and logouts show up on the next call, without
`sfd reload`. Concurrent refreshes share one promise.

## Rewrite hook

| `sf` | `sfd` |
| --- | --- |
| `sf org list` | `sfd org list --status` |
| `sf org list --skip-connection-status` | `sfd org list` |
| `--all`, `--json` | carried through |
| `--clean`, `--verbose`, `-p`, `--no-prompt`, `-o` | left on `sf` |

`mapArgs` in `src/rewrite.mjs` adds `--status` unless `skip-connection-status`
was given. The general rules are in [agent-hooks.md](agent-hooks.md).

## Changing this area

- New JSON fields go in the allowlist in `orgList`, and in the field list above.
  Never spread `auth.getFields()` into the result.
- Text layout changes belong in `formatOrgList`. Add a case to
  `test/format.test.mjs`.
- Keep both deadlines at 10 s. The Dev Hub query uses the same deadline as the
  org checks.
- The `-o` rejection and the `org list` argument check are in the `org` case of
  `run` in `bin/sfd.mjs`. The command does not resolve a target org.
- Out of scope: `--clean`, verbose columns (instance, API version, last used,
  namespace, created by), login, logout, setting defaults, and caching
  `--status`. Use `sf` for those.

## sf-compatible JSON

`--sf-json` prints sf's `other`, `sandboxes`, `nonScratchOrgs`, `devHubs` and
`scratchOrgs` groups with allowlisted auth fields and live scratch metadata.
Regular orgs appear in `other`; all non-scratch orgs, including dev hubs and
sandboxes, also appear in `nonScratchOrgs`. The access token is
always sf's redaction placeholder and the envelope includes sf's secrets
warning. Other auth secrets are excluded. Connection checks are enabled unless
`--skip-connection-status` is passed; scratch metadata is enriched in either
case. Existing primary-user filtering, alias ordering and expiry rules apply.
