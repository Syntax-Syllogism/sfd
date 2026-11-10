# Contributing to sfd

Thank you for your interest in contributing to sfd! This is a hobbyist project, and we welcome all kinds of contributions.

## How to Contribute

1. **Report Bugs:** If you find a bug, please open an issue with a clear description and steps to reproduce.
1. **Suggest Features:** Have an idea? Open an issue to discuss it.
1. **Submit Pull Requests:**
   - Fork the repository.
   - Create a new branch for your feature or fix.
   - Write clear, documented code. Read [AGENTS.md](AGENTS.md) for the repository conventions.
   - Make sure `npm run build`, `npm run typecheck` and `npm test` pass.
   - Open a Pull Request with a description of your changes.

## Development Setup

sfd is plain Node.js ESM and needs Node 22 or newer. Clone the repository and run
`npm test`. Most tests use stub or injected Salesforce modules and need no org or
Salesforce CLI login. The real-org check is opt-in: `SFD_TEST_ORG=<alias> npm test`.
The [README's Testing section](README.md#testing) lists what each part covers.

## Code of Conduct

Please note that this project is released with a [Contributor Code of Conduct](CODE_OF_CONDUCT.md). By participating in this project you agree to abide by its terms.
