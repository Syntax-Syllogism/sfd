# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [Unreleased]

## [0.7.1] - 2026-11-09

### Fixed

- `sfd retrieve` no longer prints a contradictory `FAILED (Succeeded)` header when the server succeeds but some components fail; it prints `PARTIAL: retrieved N files from <org> (<id>); M failed` and still exits 1

## [0.7.0] - 2026-11-09

### Added

- Plugin operations can report partial failures with `ctx.reportFailures?.(count)`; successful envelopes carry positive counts and the CLI exits 1
- Documentation site for sfd, built with Starlight

### Changed

- Installing the Claude hook now confirms deny rules before making changes

### Fixed

- Plain plugin plans print warnings before the policy decision

## [0.6.1] - 2026-11-06

### Added

- Experimental plugin support (v0). sfd finds plugins in the `sf` plugin
  registry and runs their operations in isolated warm worker processes. Workers
  support plan/apply, progress reporting and cancellation, and they are
  restarted when org auth changes. New commands: `sfd op <id>` and
  `sfd plugin list [--json]`.
- Plugins can declare CLI tables, which make their operations available as
  direct `sfd` commands. These commands appear in `sfd help`, in
  `sfd agents-snippet` output and in agent rewrite hooks. Tables are validated
  against a published JSON Schema and cached when `sfd plugin list` runs.
- `sfd plugin init [<plugin-root>] [--ops <id,…>] [--write]` generates a
  plugin's CLI table.
- New `@syntax-syllogism/sfd-plugin` package containing the v0 operation
  contract types, runtime validators (`/validate`) and a test kit (`/testkit`)
  for plugin authors.
- Safety policy based on effects. Built-in commands and plugin operations are
  classified as `read`, `local-write`, `org-write` or `destructive`, and the
  policy decides whether to allow, ask or deny based on the target org type
  (scratch, sandbox, production or unknown). The policy can be customized with
  a file at `SFD_POLICY` (default `~/.config/sfd/policy.json`). See
  `docs/safety.md`.
- Org write confirmations. When the policy decision is "ask", the command
  stops with exit code 4 and prints a confirmation hash. Re-run the command
  with `--confirm <hash>` to proceed. The hash can be used once and expires
  after 10 minutes. With `--json`, the response includes an
  `approvalRequired` object.
- `sfd org --json` now includes a top-level `type`, and `sfd org list --json`
  adds `safetyType`.

### Changed

- **Org writes to production and unknown orgs now need confirmation by
  default.** This covers `deploy` (including `--check-only`), anonymous `apex`,
  and REST `POST`/`PATCH`/`PUT`. REST `DELETE` needs confirmation on sandbox,
  production and unknown orgs. Scripts that make these calls must add
  `--confirm <hash>` or relax the policy.
- The Claude and Codex rewrite hooks ask the harness for permission when a
  rewritten command's policy decision is ask or deny. This includes plugin
  commands, which are checked against the effects they declare.
- npm releases are published with npm trusted publishing (OIDC), so no
  `NPM_TOKEN` is needed.

### Fixed

- The TypeScript declarations for the plugin `/validate` and `/testkit`
  subpaths now match their runtime exports.
- Hook and runtime code paths now guard `process.getuid` on Windows.

## [0.5.4] - 2026-11-05

### Added

- `sfd test` accepts `-y`/`--synchronous` for single-class Apex test runs

### Fixed

- `sfd test --logs` excludes debug logs that existed before the test run
- Agent hooks preserve synchronous test execution and leave invalid synchronous selectors with `sf`
- Test summaries omit the run ID suffix when no run ID is available

## [0.5.3] - 2026-10-29

### Added

- Git-style help manuals and guides for `sfd`
- `--version` flag and per-command `--help` output for `sfd`

### Changed

- Timestamp difference handling is shared across `sfd discover` transcript readers

### Fixed

- Gemini CLI call durations are now measured in `sfd discover`

## [0.5.2] - 2026-10-26

### Fixed

- `sfd discover` now reads Gemini CLI sessions stored as JSONL, so Gemini CLI usage appears in adoption reports

## [0.5.1] - 2026-10-23

### Added

- Windows PowerShell support for rewriting `sf` commands in agent hooks, so hooks running under PowerShell get the same compact JSON output as other shells

## [0.5.0] - 2026-10-23

### Added

- List commands that shell out to `sf` now return JSON output compatible with `sf`'s `--json` format

## [0.4.0] - 2026-10-22

### Added

- `--limit` and `--csv` options for `sfd query`, with CSV output
- `sfd agents-snippet` command that generates a snippet for AGENTS.md and CLAUDE.md
- `sfd org list` command that lists locally authenticated orgs, with optional status checks
- `sfd list-metadata-types` and `sfd list-metadata` commands for browsing org metadata
- `sfd discover` command that reports missed opportunities to use `sfd` in place of `sf`

## [0.3.1] - 2026-10-22

### Changed

- Internal maintenance and tooling updates

## [0.3.0] - 2026-10-22

### Added

- Added `sfd retrieve` for pulling metadata from an org into the local project
- Added tracking commands for inspecting changes between local source and the org
- Added filtered debug log output
- Added automatic TraceFlag creation when debug logs are requested

### Fixed

- Fixed a startup failure on Windows (`process.getuid is not a function`)

## [0.2.0] - 2026-10-22

### Added

- Agent hook that rewrites supported `sf` commands to their faster `sfd` equivalents

## [0.1.0] - 2026-10-22

### Added

- Warm local daemon for fast Salesforce CLI operations, covering queries, anonymous Apex, REST calls, describes, source deploys, and Apex test runs

### Fixed

- Correct UTF-8 handling of Salesforce output
- Fix paging of large result sets
- Fix daemon startup and shutdown lifecycle
- Enforce timeouts on Salesforce operations
- Fix command-line interface behavior

