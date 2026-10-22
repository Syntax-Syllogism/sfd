# Source tracking, retrieve and deploy

`sfd retrieve`, `sfd tracking`, and how `sfd deploy` keeps source tracking in
step. Source: `src/handlers.mjs` (`retrieve`, `tracking`, `deploy`, and the
project queue), `src/format.mjs` (`summarizeChanges`, `summarizeRetrieve`,
`formatRetrieve`, `formatTracking`), and `bin/sfd.mjs` (option checks).
Tests: `test/handlers.test.mjs`, `test/format.test.mjs`, `test/cli.test.mjs`.

The Salesforce work is done by `@salesforce/source-deploy-retrieve` and
`@salesforce/source-tracking`, loaded from the `sf` install (see the
[README](../README.md#daemon-lifecycle)). sfd only chooses the selectors, applies
the conflict rules below, and formats the result.

## Retrieve

```bash
sfd retrieve                       # tracked remote changes (changes-only)
sfd retrieve -d force-app/main     # path selector
sfd retrieve -m ApexClass:Foo      # metadata selector (repeatable)
sfd retrieve -x manifest/package.xml
```

`-d`, `-m` and `-x` are mutually exclusive; passing more than one is a usage
error (exit 2). With no selector, retrieve is "changes-only": it pulls the
remote changes that source tracking reports, including deletions.

Selector retrieves merge into the project. New components go to the project's
default package directory.

### Conflicts and tracked orgs

A conflict is a component that changed both locally and in the org since the
last sync.

| Org | Invocation | Result |
| --- | --- | --- |
| Tracks source | No selector, conflicts exist | Refused: nothing written, exit 1 |
| Tracks source | Selector, conflicts among the selected components | Refused: nothing written, exit 1. Conflicts outside the selection do not block it |
| Tracks source | Any form, `--ignore-conflicts` | Overwrites conflicting local files |
| Tracks source | No selector, no remote changes | Exit 0 with `No remote changes to retrieve.` |
| No source tracking | No selector | Usage error, exit 2 |
| No source tracking | Selector | Overwrites local files; no conflict check |

A refusal is a normal response with `success: false` and `status: "Conflicts"`.
The text output names the conflicting count and the `--ignore-conflicts` rerun.
The JSON output lists each conflict under `conflicts`.

Refusals are checked before any file is written, so a refused retrieve leaves
the project unchanged. After a successful retrieve on a tracked org, sfd calls
`updateTrackingFromRetrieve`, so the next changes-only run does not report the
same files again.

## Tracking

```bash
sfd tracking                # local, remote and conflicting changes
sfd tracking --local        # local changes and conflicts
sfd tracking --remote       # remote changes and conflicts
sfd tracking --conflicts    # conflicts only
```

- Requires an org with source tracking; otherwise usage error, exit 2.
- `--local` and `--remote` are mutually exclusive.
- Conflicts are always listed, except with `--conflicts`, which lists only
  conflicts.
- Paths are relative to the project directory.
- Text output groups the result under `local`, `remote` and `conflicts`, and
  collapses each source file with its companion `-meta.xml`. The JSON response
  keeps every file separately.
- Ignored entries are dropped.

## Deploy and tracking

After a successful deploy to an org that tracks source, sfd calls
`updateTrackingFromDeploy`, as `sf project deploy start` does. A check-only
deploy (`--check-only`) changes nothing and does not update tracking.

## Serialization

Deploy, retrieve and tracking share one queue inside the daemon (`serial()` in
`src/handlers.mjs`). Source Deploy Retrieve and source tracking keep
process-wide state, so these operations never run concurrently in one daemon.
Operations that do not touch the project (query, describe, REST, Apex, test)
are not queued.

A long deploy therefore delays a retrieve or `sfd tracking` issued
afterwards, until the deploy finishes or times out. A caller that needs the
result immediately should wait for the earlier command.

## Exit codes and timeouts

| Situation | Exit |
| --- | --- |
| Success, including a changes-only retrieve with nothing to do | 0 |
| Deploy or retrieve failed, or a conflict refusal | 1 |
| Usage error: bad selector combination, no tracking, missing project | 2 |
| Request timed out, or the daemon is unreachable | 3 |

Deploy and retrieve wait up to 33 minutes by default; `-w <minutes>` changes
the wait. The client deadline is extended to that wait plus 60 seconds, and
`SFD_TIMEOUT_SECONDS` overrides it (see the [README](../README.md#environment)).

## Changing this area

- Keep the conflict rules above in sync with `retrieve` in `src/handlers.mjs`.
  They are tested in `test/handlers.test.mjs` (refusal before writes, ignore
  conflicts, deletions, queue sharing).
- Output shape changes belong in `src/format.mjs`, with cases in
  `test/format.test.mjs`.
- The agent hook maps `project retrieve start` but not retrieve or deploy
  preview commands. See [agent-hooks.md](agent-hooks.md).
