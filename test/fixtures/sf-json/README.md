# sf `--json` contract fixtures

Recorded from `@salesforce/cli/2.147.7` (node v24.14.0) on 2026-10-22 against a
Developer Edition scratch org and a Dev Hub, then anonymized: usernames, org and
record IDs, instance hosts and local paths are replaced with placeholders, and
`describe.json` is trimmed to 4 fields and 2 child relationships. Tokens were
never captured: sf 2.147 already prints the placeholder
`[REDACTED] Use 'sf org auth show-access-token' to view` for `accessToken` in
`org display` and `org list`, which is kept as recorded.

| File | Command |
| --- | --- |
| `query.json` | `sf data query -q "SELECT Id, Name FROM Account ORDER BY Name LIMIT 2" --json` |
| `query-relationship.json` | same with `Owner.Name` |
| `query-tooling.json` | `sf data query -q "SELECT Id, Name FROM ApexClass ..." --use-tooling-api --json` |
| `query-error.json` | `sf data query -q "SELECT Bogus__c FROM Account" --json` (exit 1) |
| `describe.json` | `sf sobject describe -s Account --json` (trimmed) |
| `apex-success.json` | `sf apex run -f ok.apex --json` with `System.debug(1);` |
| `apex-compile-error.json` | `Integer x = ;` (exit 1) |
| `apex-exception.json` | `Integer x = 1/0;` (exit 1) |
| `org-display-scratch.json` | `sf org display -o <scratch> --json` |
| `org-display-nonscratch.json` | `sf org display -o <devhub> --json` |
| `org-display-bad-alias.json` | `sf org display -o nope-not-an-org --json` (exit 2) |
| `org-list.json`, `org-list-all.json` | `sf org list [--all] --json` (identical here: no expired orgs) |

Error envelopes keep sf's `stack`, `cause` and `data` as recorded; sfd's
converters are not expected to reproduce `stack` or `cause`.

`org-list-regular.json` is a synthetic contract fixture derived from the
non-scratch entry in `org-list.json`, with `isDevHub` and default-hub fields
set to false. It covers an org that is neither scratch, sandbox nor Dev Hub,
which the captured environment did not contain. Its membership in both `other`
and `nonScratchOrgs` follows the installed sf 2.147.7
`@salesforce/plugin-org/lib/shared/orgListUtil.js` grouping filters. It is not
a new live-org capture.
