# Tokenturn

Self-hosted AI spend and ROI ledger. No proxy, no stored keys.

**[Live demo](https://tokenturn-demo.flowengine.cloud/)** - the whole product, read-only, on six months of seeded data. The login is pre-filled, so just click sign in.

Tokenturn has two main goals:

1. **Calculate the actual benefit you get for your AI spend.** What an agent that costs $200/month actually delivers, and whether it meets your success criteria. How much of the code written by AI survives production.
2. **Manage all AI spend across employees and tools.** Set per-person limits, catch burn spikes, invite and offboard people across vendors in one click, and true your estimates up against real invoices.

For ROI we calculate three different ways:

1. **Coding (built in).** Connect Cursor, Copilot, or Anthropic and you get accept rate, revert rate, and line survival (% of AI-written lines still alive after 30 and 90 days) with zero setup - coding ROI is survival, not merge count. Agents like Devin route their whole spend to one ROI row.
2. **SDK wrap.** Wrap your OpenAI/Anthropic client with the TypeScript or Python SDK. Every call is counted from the response usage, and `track()` records a success and its value when your tool delivers.
3. **API track.** Send events straight to `POST /api/ingest` from anything that can make an HTTP call. No SDK needed.

## Why Tokenturn

- **No proxy.** Proxying your LLM keys adds a bottleneck, latency, maintenance, a point of failure, and a real security risk. Tokenturn reads the vendors' admin APIs instead - nothing sits between your apps and the models.
- **No stored keys.** Your employees' API keys never pass through Tokenturn. Vendor admin tokens are stored encrypted; keys minted for people are shown exactly once and never saved or logged.
- **Flexible.** You define ROI your way: any spend slice (a tagged key, the SDK, a whole vendor, manual) against any success definition (`track()` events, issues done, manual), with your own value per outcome. The whole reports exports as [FOCUS] so any FinOps tool can ingest it.

## Integrations

OpenAI, Anthropic (including Claude Code analytics), Cursor, GitHub Copilot. Jira and Linear for success tracking (outcomes only, never spend). Slack and email for alerts. Okta and Google Workspace sync on the enterprise plan.

## Quick start

```bash
docker compose up
```

Open [http://localhost:3000](http://localhost:3000). The Compose setup creates PostgreSQL, waits for it, creates the application database, and applies all migrations automatically. Backup = the Postgres volume. `GET /healthz` reports app and database health.

### Coolify deployment

Use the repository's Coolify Compose file to provision the application and PostgreSQL together:

1. Create a new Coolify resource from this Git repository.
2. Select **Docker Compose** as the build pack.
3. Set the Compose file to `/docker-compose.coolify.yml`.
4. Deploy without exposing the public domain, or restrict it to your IP.
5. Open the instance and claim the first admin account.
6. Assign or expose the public domain only after the instance is claimed.

No database resource or `DATABASE_URL` needs to be created manually. Coolify generates `SERVICE_PASSWORD_POSTGRES`; the Compose file uses it for both PostgreSQL and the application's internal `db:5432` connection. Both the database and application secret key use persistent volumes.

For a Dockerfile-only deployment, provision PostgreSQL separately and set the runtime `DATABASE_URL` to a URL reachable from the application container. Do not use `localhost` or a public URL when an internal URL is available.

On every container start, Tokenturn waits up to 60 seconds for PostgreSQL, creates the database named in `DATABASE_URL` if it is missing and the configured role has `CREATEDB` permission, and applies pending migrations. `DATABASE_URL` is the only required application environment variable; everything else lives in Settings.

Set `DEMO_MODE=1` to run the instance read-only for live demos: everyone can sign in, browse, and drill into everything, but every change is rejected - including password changes, so a shared demo login stays safe. Claiming a fresh instance and seeding the demo data still work (each runs only once), so a demo box can bootstrap itself with the flag already on.

The first visitor claims the instance as its admin - with a passkey, or a password as fallback. Therefore, never expose a fresh unclaimed instance to the public internet. No email is needed. Sign-in access lives on each person's page ("Can sign in": none, viewer, or admin). Lost your login?

```bash
docker compose exec app reset-admin
```

prints a one-time reset link (valid 30 minutes, single use).

A fresh instance offers two starts: import your employees, or load demo data - six months of realistic spend and outcomes, wiped automatically when the first real vendor connects. Setup is three steps on one screen: connect a vendor, upload the people CSV, name your first ROI row. The CSV import auto-detects headers (email required, name optional), `?preview=1` shows per-row verdicts without committing, and re-import upserts by email - it never removes anyone.

## The dashboard

Seven pages behind one global date-range picker (the range lives in the URL, so links reproduce what was on screen) and cmd-K search to any person, ROI row, vendor, or page. Every number drills down to the raw rows behind it, and tables export what's on screen as CSV.

- **Overview** - total spend with its estimated/invoiced split, attribution coverage, daily trend, spend by vendor, top people, top ROI rows, connector health.
- **People** - everyone (plus the visible Unassigned bucket) with spend by vendor, outcomes, and $/outcome. A person's page shows their keys, seats, daily breakdown, and the ROI rows they touch.
- **ROI** - every ROI calculation in one list with the same columns: spend, tokens, successes, $ per success, value, ROI multiple. The built-in coding rows carry accept rate, revert rate, and line survival - success is surviving code, not merge count. A row with no success metric shows plain cost - never a fake ROI.
- **Resolve** - the identity queue: confirm matches, route service accounts, merge two emails into one human. The nav badge drains live.
- **Report** - one printable CFO page per month that always sums to the whole ledger. Exports as CSV or [FOCUS 1.4](https://focus.finops.org).
- **Settings** - five tabs: Personal API keys, Connections (vendors, Jira/Linear, SDK keys, email, Slack), Alerts, Data, License.

## Connectors

Connectors sync hourly with a stored cursor: full backfill on first connect, resume at the exact failed page after an error, a trailing 7-day re-pull (vendors restate data), idempotent upserts - a vendor record is never duplicated. Credentials are stored encrypted, never plaintext. A connector silent for 24 hours fires an alert. Every connector is tested against recorded vendor responses, so a vendor format change breaks CI instead of production.

- **OpenAI** - org users, projects, and keys; daily usage and costs; invites, key minting, and removals. Needs an `sk-admin-...` key.
- **Anthropic** - org users and keys (self-minted keys auto-map to their creator), per-key daily usage priced from a pinned price table (marked `estimated` - Anthropic never reports dollars per user), and per-user Claude Code analytics. Needs an `sk-ant-admin...` key.
- **Cursor** - team roster, per-user spend and usage via the team Admin API. Limit pushes and member removal need the Enterprise plan.
- **GitHub** - Copilot seats, per-user AI-credit dollars (monthly grain), usage counters, and line survival as the coding outcome: AI authorship detected from bot authors and co-author trailers (Claude, Copilot, Cursor, Devin, Codex), AI-added lines checked against the repo at the 30/90-day horizon, and a revert within the window (default 30 days) drops those lines. GitHub is a routing container here - the visible ROI is per-tool surviving code, not spend-per-merge. Survival comes from git - vendors report line counts, never which lines.
- **Jira / Linear** - success only, never spend. Each issue runs a state machine over its real status-transition history: hits the submitted status, goes pending; survives the window (default 30 days) or reaches Done, success; regresses inside the window, fail. Agent actors (app users) get the credit when they're the issue's delegate, assignee, or creator, and route to an ROI row by tag or by project mapping.

Every endpoint is verified against current vendor docs and covered by fixture tests, but most need real credentials to exercise live (admin keys for OpenAI/Anthropic/Cursor, an org PAT for GitHub, provider credentials for email). Everything publicly callable was called live.

## Identity resolution

Identities auto-match to people by email, case-insensitively, across all vendors. Whatever can't be matched sits in the Resolve queue with explainable suggestions (same handle, same name, same email confirmed elsewhere) - never guessed scores. One click confirms a match, re-attributes that identity's full history, and is remembered forever. A key that isn't a person routes to an ROI row and/or tag instead. Spend with no person and no ROI row stays visible as Unassigned - never dropped, never hidden.

## People in / out

**In.** CSV roster import (preview mode, upsert by email, never removes anyone). Invite fan-out: pick people and tools, and every (person, tool) pair gets its own verdict - OpenAI and Anthropic org invites, Copilot seats - one vendor failing never blocks the rest. `POST /api/people/{id}/keys` mints an OpenAI key and returns it exactly once - never stored, never logged. Anthropic keys are self-minted in the Console and auto-detected on the next sync.

**Out.** The Offboard button lists every key and seat the person holds across all vendors, then removes them all on confirm. Failed items keep the vendor's error verbatim and retry one by one. The person is excluded from limits, invites, and minting - while their history stays fully intact.

## Tags

Key names become tags on the next sync - the name says what a key is for, by convention, and a rename re-tags its full history. A tag can point at an ROI row, routing every key carrying it: a key tagged `devin` burns on the Devin row, never on whoever minted it. A tag can also be flagged out of personal usage (batch jobs, cron keys) so it never counts toward someone's limit. A key whose tags point at two ROI rows is a conflict, surfaced in Resolve until a human un-points one.

## ROI rows

An ROI row is anything that spends AI money: a name, a spend source (`connector`, `key`, `sdk`, or `manual`), and a success metric or none (`issue_done`, `sdk_event`, `manual`); coding survival is built in. The ROI page reads `GET /api/roi`; row CRUD keeps the old `products` path (`GET`/`POST /api/products`) - the table name stayed, only the language changed. A row can set a default value per outcome, applied at read time (changing it re-values history retroactively); per-event values override it. Tools with no API take manual monthly entries (`PUT /api/products/{id}/manual`) that drill down to the entry itself, not fake vendor rows. Archive is the only exit - history stays readable, nothing hard-deletes.

## SDKs + ingest API

The TypeScript SDK ([sdk/](sdk/), `@tokenturn/sdk`) and Python SDK ([sdk-py/](sdk-py/), `tokenturn`) - both zero dependencies, fail-open always, full parity:

```ts
import { pnl } from "@tokenturn/sdk";
import OpenAI from "openai";

const ai = pnl.wrap(new OpenAI(), { roi: "support-bot" }); // counts every call

pnl.track("ticket_resolved", { value: 4.5, ref: "ZD-3141", employee: "dana@acme.com" });
```

Events carry client-side UUIDs, buffer locally, and flush in batches; the server upserts on the UUID, so retries never double-count and SDK problems never break the host app. Quickstarts live in [sdk/README.md](sdk/README.md) and [sdk-py/README.md](sdk-py/README.md). (The `roi` option was previously named `product` - the old name still works everywhere.)

The server side is `POST /api/ingest`, authenticated by an ingest key minted in Settings - shown once, scoped to one ROI row, rate-limited, revocable. Each event gets its own verdict (`accepted` / `duplicate` / `rejected` + the reason) so one bad event never sinks a batch. The full API reference ships in-app at `/help/api`.

## Limits + burn alarms

A monthly spend limit per person alerts Slack at 80% and 100% of month-to-date spend (thresholds editable). It's an alert, never a hard stop - and the vendor's own limit shows next to ours with what each vendor can actually enforce: Cursor accepts pushed limits (Enterprise plan, whole dollars), Anthropic's hard caps are Console-only, OpenAI is alert-only. Anomaly alarms fire when someone's daily burn hits 3x their trailing 30-day average and at least $20 (both editable), max one per person per day.

## Money, FX, and invoices

Money is stored as billed (amount + currency) and normalized to USD via daily ECB rates, fetched automatically. Charts convert to your display currency at read time; drill-downs always show the original amounts. A currency with no fetched rate is refused everywhere - no rate, no fake number.

Monthly invoice CSVs true the estimates up: the difference between the invoice and that month's synced facts lands as one adjustment fact on the month's last day, so per-person numbers stay exactly what the vendor reported while totals sum to what was actually billed. `GET /api/invoices` is the drift report behind the Overview tile. Only completed months import.

## Free vs enterprise

Everything above is free and source-available (sustainable-use license): all connectors, the SDKs, the full dashboard, limits and alerts, invites and offboarding. Single org per vendor, one admin plus viewers. No pricing page, no telemetry without explicit opt-in.

[ee/](ee/) ships in this repo under a [commercial license](ee/LICENSE): Okta sync (auto-invite on hire, auto-offboard on leave), Google Workspace roster sync, additional admins, the exportable audit log, multi-org rollup, and scheduled monthly PDF reports. License files verify offline against a pinned public key - no license server, nothing phones home. When a license expires the features lock again and every byte of data stays readable. Sold direct: [hi@flowengine.cloud](mailto:hi@flowengine.cloud).

## Releases

Tagged images on GHCR, pinned by digest, each with a build-provenance attestation (`gh attestation verify`) and an SPDX SBOM on the GitHub release. CI greps every container log line for leaked token patterns - planted canary secrets included - before anything ships. The "new version" banner checks GitHub releases only when switched on; like all telemetry, off by default.

## Development

```bash
npm install
npm run dev          # http://localhost:3000
```

| Script | Does |
|---|---|
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest. Database tests need `TEST_DATABASE_URL` pointing at a Postgres server; they skip when it's unset. CI always runs them. |
| `npm run test:py` | Python SDK tests. The e2e test boots the production server against a scratch database; needs `TEST_DATABASE_URL`. |
| `npm run lint` | ESLint |

```bash
TEST_DATABASE_URL=postgres://localhost:5432/postgres npm test
```

Migrations are plain SQL files in `migrations/`, named `NNN_description.sql`, applied in order on container boot.
