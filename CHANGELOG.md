# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [Unreleased]

### Fixed

- Windows: `sfd start` and every other command failed with
  "process.getuid is not a function". The daemon now listens on a per-user
  named pipe, finds `sf` with `where` (including npm `sf.cmd` shims), and
  starts without a console window. CI runs on Windows as well as Linux.

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

