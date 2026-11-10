---
title: sfd documentation
description: Guides for sfd, which runs common Salesforce CLI operations through a warm local daemon.
---

`@syntax-syllogism/sfd` runs common Salesforce CLI operations through a long-lived local daemon, so each call skips the 5–20 seconds `sf` spends loading oclif and its plugins. A warm call answers in about 0.2 seconds. It is meant for agents and scripts that make many small org calls in a row.

```bash
npm install --global @syntax-syllogism/sfd
sfd query "SELECT Id, Name FROM Account LIMIT 5" -o my-org
```

Installed CLI users can browse these guides with `sfd help -a` or print one with `sfd help <guide>`. A guide whose name matches a command is listed with a `-guide` suffix (for example `discover-guide`), and the query guide is `query-output`, so neither shadows the command manual.

## Commands

- [Query output](query.md): the row limit, the CSV layout, the output mode for each flag combination, the sf-compatible `--sf-json` envelope, and the truncation trailer.
- [Source tracking, retrieve and deploy](source-tracking.md): `sfd retrieve`, `sfd tracking`, how `sfd deploy` keeps source tracking in step, the shared queue, and what a client disconnect stops.
- [Debug logs](debug-logs.md): `sfd logs`, `sfd logs get` and `sfd test --logs`, the TraceFlag setup they trigger, and the filtered output format.
- [Metadata listing](metadata-list.md): `sfd list-metadata-types` and `sfd list-metadata`, folder-based types, output formats and the `--json` shape.
- [Org list](org-list.md): which local orgs are listed, what `--status` checks, the `--json` allowlist and the no-token rule.
- [Safety policy](safety.md): how built-in commands and plugin operations are gated by declared effects and target org type.

## Daemon

- [Daemon](daemon.md): the local socket protocol, request limits and read deadline, signal shutdown, client-disconnect aborts, runtime directory checks, and how the daemon survives bad requests and unexpected errors.
- [Logging](logging.md): the daemon log's JSON-lines format, per-request access records, redaction, rotation, the flush before exit, plugin worker stderr, and the boot log.
- [Request limits](request-limits.md): the bounded fan-out in `org list --status` and `list-metadata`, backoff for reads that hit a Salesforce request limit, and the API usage shown by `sfd status`.

## Agents

- [Agent hooks](agent-hooks.md): `sfd hook` lets coding agents run `sf` commands through the warm daemon.
- [Agent snippet](agents-snippet.md): `sfd agents-snippet` prints a short Markdown block that tells coding agents to prefer `sfd` over `sf`.
- [Discover](discover.md): `sfd discover` reads local transcripts, classifies each shell call and estimates the savings.

## Help

- [Help topics](help-topics.md): `sfd help` shows command manuals and concept guides.
- [CLI help and version](cli-help.md): how `--help` and `--version` are generated from the command table.

## Plugins

- [Plugins](plugins.md): run experimental v0 plugin operations in isolated warm worker processes.
- [Plugin API v0](plugin-api.md): the manifest, operations and test helpers for plugin authors.
