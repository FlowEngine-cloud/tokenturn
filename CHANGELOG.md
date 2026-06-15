# Changelog

All notable changes to Tokenturn are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [semantic versioning](https://semver.org).

## [0.1.0] - 2026-06-15

First public release.

### Added

- Self-hosted AI spend and ROI ledger - no proxy, no stored employee keys.
- Connectors: OpenAI, Anthropic (incl. Claude Code analytics), Cursor, GitHub Copilot.
- Success tracking via Jira and Linear (outcomes only, never spend).
- TypeScript and Python SDKs plus the `POST /api/ingest` event API.
- Identity resolution, people in/out, tags, and ROI rows.
- Per-person limits, burn alarms, and Slack/email alerts.
- FX, invoice truing, and FOCUS 1.4 report export.
- Docker Compose and Coolify deployment, automatic migrations on boot.
- Enterprise (`ee/`) features behind an offline license check: Okta sync,
  Google Workspace roster sync, audit log, scheduled PDF reports.
