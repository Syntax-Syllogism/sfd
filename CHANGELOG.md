# Changelog

## Unreleased

- feat: expose plugin CLI tables through direct commands, help, agent snippets and rewrite hooks; add table validation, JSON Schema and `plugin init` generation (experimental v0).

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [Unreleased]

### Added

- Experimental plugin host: sf registry discovery, isolated warm workers, `op` and `plugin list`, plan/apply effects checks, progress, cancellation and auth invalidation.

- Experimental v0 plugin operation contract, runtime validators and test kit in `@syntax-syllogism/sfd-plugin`, with declaration checks in CI.

- `sfd test -y/--synchronous` runs tests from one Apex class without the async queue, with coverage and debug-log support

### Fixed

- Plugin `/validate` and `/testkit` TypeScript exports now match their runtime helpers.
- `sfd test --logs` no longer returns debug logs from earlier runs within the clock-skew window.
- Agent hooks preserve synchronous test execution and leave invalid synchronous selectors with `sf`
- Test summaries omit the run ID suffix when no run ID is available

## [0.5.4] - 2026-11-05

### Added

- `sfd test` accepts `-y`/`--synchronous` for single-class Apex test runs

### Fixed

- `sfd test --logs` excludes debug logs that existed before the test run

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

