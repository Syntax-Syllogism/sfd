# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [Unreleased]

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

