# AI P&L

Self-hosted, per-employee AI spend and ROI ledger. Shows what every employee and every internal product spends on AI, and what the company got back - no proxy, no stored keys.

## Quickstart

```bash
docker compose up
```

Open [http://localhost:3000](http://localhost:3000).

That's it. `DATABASE_URL` is the only environment variable; everything else is configured in Settings and stored in the database. Migrations run automatically on boot. Backup = the Postgres volume.

## Login

The first visitor claims the instance as its one admin - with a passkey, or a password as fallback. No email needed. The admin can add view-only users (username + password). Lost passkey or password:

```bash
docker compose exec app reset-admin
```

prints a one-time reset link (valid 30 minutes, single use) to open on your instance's URL.

## Health

`GET /healthz` returns `200 {"status":"ok","db":"ok"}` when the app and database are up, `503` otherwise. The Docker image ships a matching `HEALTHCHECK`.

## Dashboard

Seven pages - Overview, People, Products, Tools, Resolve (with a live queue badge), Report, Settings - behind one global date-range picker (the range lives in the URL, so links reproduce what was on screen) and cmd-K search to any person, product, vendor, or page. The Overview (`GET /api/overview?from&to`) shows total spend with its estimated/invoiced split and the invoice-drift badge, attribution coverage with the visible Unassigned remainder, the daily trend, spend by vendor, top people, top products, and connector health. Every tile clicks through to the raw rows behind its number: spend facts (`GET /api/facts?from&to&day&vendor&person&product&key&model&basis` - totals cover the whole filter, so the drill provably sums to the tile, and every row carries the vendor `source_ref`), raw outcomes (`GET /api/outcomes?from&to&person&product&kind&tool` - count-aware, with the live/reverted split and each record's AI authorship tags), raw usage counters (`GET /api/metrics?from&to&vendor&metric&person&key` - `metric` takes a comma list, so an accept rate's two inputs land on one page), sync runs (`GET /api/runs?vendor`), or the invoice drift report (`GET /api/invoices`). Tables keep their headers while scrolling and export exactly the rows on screen as CSV. `GET /api/search?q=` powers cmd-K.

The People page (`GET /api/people?from&to`) lists everyone - plus the visible Unassigned bucket - with spend by vendor, live outcomes, $/outcome, and a daily trend; archived people leave this view while their history stays intact in every drill-down. Clicking a person (`GET /api/people/{id}?from&to` - follows merges to the surviving person) shows their daily breakdown per vendor, their keys and seats (with tags and all-time last use), the products their spend and outcomes touch, and outcomes by kind. Clicking a key (`GET /api/keys/{id}`) shows what it's for and where it's plugged - its tags (with product routing and the personal-usage flag), owner, product, per-model spend, and last used - all-time, from the key's own raw facts.

The Products page (`GET /api/products/view?from&to`) lists every cost center with spend, its own metric in its own unit - $/merge for `github_pr` products, $/`<kind>` when an event product's live outcomes are all one named kind, plain $/outcome when mixed, and cost per active user when the product has no outcome metric at all - plus ROI where real value exists, manual products included. Clicking a product (`GET /api/products/{id}?from&to`) shows its spend by basis, vendor, person, and day, its outcomes by kind (reverted ones flagged out), the keys routed to it, and its manual entries. The Tools page (`GET /api/tools?from&to`) puts the coding tools side by side - cost per merged PR per tool per person, accept rates, revert rates - with three honest cost sources, each labeled: vendor billing (Cursor, Copilot), the vendor's own per-user estimate (Claude Code's analytics cost counter, the only per-person Claude Code figure that exists), and the routed product's spend for agents (Devin - never split per person, because none exists). The Resolve page is the identity queue itself: one-click confirm on each suggestion (or search the roster), "not a person" routing to a product and/or tag, tag-conflict un-pointing, and the two-emails-one-human merge - the nav badge counts queue entries plus tag conflicts and drains live as they clear.

The Report page (`GET /api/report?month=YYYY-MM`) is one printable CFO page per calendar month: spend by cost center with last month and the month-over-month change beside each line, unit costs, ROI where defined, and a trailing six-month trend. It always sums to the whole ledger - archived cost centers stay on it (flagged), and spend routed to no product shows as its own "No cost center" line - and every number links to the raw rows behind it; printing hides the chrome and flips the page to ink on paper. Two exports: `GET /api/report/csv?month=` downloads the table as CSV, and `GET /api/report/focus?month=` streams a [FOCUS 1.4](https://focus.finops.org) file - one row per raw spend fact in the billed currency, the employee as the sub-account, ledger fields (`x_CostBasis`, `x_ProductName`, `x_SourceRef`, ...) as extension columns - so any FinOps tool can ingest the ledger wholesale.

The Settings page is where everything is configured (admin writes, viewers read): the four vendor connect screens with each vendor's limits stated verbatim plus sync-now/disconnect, products (create, edit, archive/restore, and manual monthly cost/outcome entries), ingest keys (minted per product, the token shown exactly once), the Slack alert webhook, and the display currency next to every numeric default in the plan - revert window, anomaly multiplier and floor, limit-alert thresholds, raw-fact retention, silent-connector hours, and the off-by-default GitHub release check. The license box states what free includes and that `ee/` features are licensed per deal.

## Connectors

Vendor connectors sync hourly with a stored cursor: full backfill to the vendor's history limit on first connect, resume at the exact failed page after an error, a trailing 7-day re-pull every sync (vendors restate data), and idempotent upserts - a vendor record is never duplicated. Token scopes are validated on connect; credentials are stored encrypted, never plaintext. `GET /api/connectors` is the health surface: last sync, row counts, and the vendor's error verbatim. A connector silent for 24 hours fires an alert event. Connectors are tested against recorded vendor responses (`tests/fixtures/connectors/`), so a vendor format change breaks CI instead of production.

**Anthropic** connects with an Admin API key (`sk-ant-admin...`) and pulls org users and API keys (keys auto-map to the person who created them - Anthropic has no key-creation API, so each person mints their own key and the next sync picks it up), per-key/workspace daily usage priced from a pinned model price table (marked `estimated` - Anthropic never reports raw API dollars per user), non-token charges from the cost report (web search, code execution, session usage; `invoiced`, unassigned), and per-user daily Claude Code analytics (sessions, commits, PRs, accept rates, tokens, cost) stored as metrics rather than spend so the ledger never double counts.

**GitHub** connects with a classic PAT (`read:org`, `manage_billing:copilot`, `repo`; enterprise-owned orgs need an enterprise owner's PAT with `admin:enterprise` - per-user Copilot dollars then come from the enterprise billing API) and pulls the Copilot seat roster, per-user AI-credit dollars (GitHub's finest per-user grain is the calendar month, so facts land on the month bucket, `invoiced`; spend the report can't attribute to a current seat holder stays visible as Unassigned), per-user daily Copilot usage counters (interactions, code generations/acceptances - the accept-rate inputs), and merged PRs as outcomes: a merged PR counts on merge, AI authorship is detected from bot authors and commit co-author trailers (Claude, Copilot, Cursor, Devin, Codex), and a revert referencing a PR within the revert window (Settings, default 30 days) flips it and recomputes - after the window it's final. Seat fees are never invented or amortized.

## Identity resolution

Identities auto-match to people by email, case-insensitively, across all vendors; keys map via their vendor-side owner fields. Whatever can't be matched sits in the Resolve queue (`GET /api/resolve`) with explainable suggestions - same email handle, same name, or the same email/name already confirmed on another identity - never guessed scores. One click confirms a match (`POST /api/resolve/{id}/confirm`), re-attributes that identity's **full history** (facts, metrics, outcomes, rollups), and is remembered forever: the email becomes an alias, so the same email on any vendor auto-maps from then on. A key that isn't a person - a service account - routes to a product and/or a tag instead (`POST /api/resolve/{id}/not-person`) and auto-match never re-fills it. Two emails belonging to one human merge (`POST /api/resolve/merge`); the merged person archives, and their identities, history, and email follow the survivor. Spend with no person and no product stays visible per vendor as Unassigned - never dropped, never hidden.

## Tags

Key names become tags on the next sync - the name says what a key is for and where it's plugged in, by convention; a key rename re-tags its full history retroactively (tags live on the identity, and every tag query joins facts to their identity). `GET /api/tags` lists every tag in use with the keys and spend behind it; `GET /api/tags/{tag}` filters the ledger by tag, across all employees and keys, down to the vendor rows. `PATCH /api/tags/{tag}` (admin) changes a tag's settings: `countsPersonal: false` keeps the spend attributed to its person but flags it out of personal usage (batch jobs, cron keys, experiments - the flag flows into the daily rollups), and `productId` points the tag at a product, routing every key carrying it - product set, person cleared, full history re-attributed, auto-match never re-fills it. That's the agent convention: a key tagged `devin` burns on the Devin product, never on whoever minted it, and new keys carrying a routed tag route at sync time with no clicks. A key routes to at most one product: a key whose tags point at two products is a conflict, surfaced in the Resolve queue (`conflicts` in `GET /api/resolve`) and left unrouted until a human un-points one of the tags or renames the key. Tags added in Resolve (`manual_tags`) survive syncs; vendor tags mirror the key name.

## Products

A product is a cost center - anything that spends AI money: a name, where its spend comes from (`connector`, `key`, `sdk`, or `manual`), and its success metric or none (`none`, `github_pr`, `sdk_event`, `manual`). `GET /api/products` lists them with rollup-backed totals; `POST /api/products` and `PATCH /api/products/{id}` (admin) create and change them - archive is the only exit (`archived: true`): archived products leave current views but their history and drill-downs stay fully readable, nothing hard-deletes. `GET /api/products/{id}?from&to` returns the product's metrics over the selected range in the org's display currency - spend (split by `estimated`/`invoiced`/`manual`, by vendor, by person, and by day), outcomes by kind (reverted ones excluded but visible), unit cost in the product's own unit, value, ROI = value / spend, active users and cost per active user - plus the keys routed to it and its manual entries; every number equals the facts/outcomes drill under the same filter. A product may set a default value per outcome, applied at read time to outcomes that carry no explicit value (so changing it re-values history retroactively); per-event values - from `track()` or a manual entry - override it, and a product with neither gets plain unit cost, never a fake ROI. Tools with no API take manual monthly entries (`PUT /api/products/{id}/manual`, admin): a `cost` entry materializes as one spend fact on the month's first day, vendor `manual`, cost basis `manual`; an `outcomes` entry as one count-carrying outcome row with an optional per-outcome value. One entry per product, kind, and month - a PUT for the same month rewrites it in place - and every manual row's `source_ref` is the entry's id, so manual numbers drill down to the entry, not vendor rows.

## SDK + ingest API

The TypeScript SDK ([sdk/](sdk/), `@ai-pnl/sdk`) and the Python SDK ([sdk-py/](sdk-py/), `ai-pnl`) - both zero runtime dependencies, fail-open always, full parity - are how internal products report what no vendor console can see: `pnl.wrap(client)` counts every OpenAI/Anthropic call from the response usage fields (streaming included; Python wraps sync and async clients alike), and `pnl.track(...)` records a success and its value, with the request context's tokens attached automatically. Quickstarts for Next.js, Express, and plain scripts live in [sdk/README.md](sdk/README.md); FastAPI and plain Python scripts in [sdk-py/README.md](sdk-py/README.md). Events carry client-side UUIDs, buffer locally (cap 10,000, oldest dropped), and flush every 5 seconds or 100 events; the server upserts on the UUID, so retries never double-count and SDK problems never break the host app.

The server side is `POST /api/ingest` - authenticated by an **ingest key** minted in Settings (`POST /api/ingest-keys`, admin: the token is in that response and nowhere else; `GET` lists prefixes only, `PATCH /api/ingest-keys/{id} {"revoked": true}` is the permanent kill switch), scoped to one product, rate-limited per key, body capped at 1 MB. Each event gets its own verdict (`accepted` / `duplicate` / `rejected` + the reason verbatim) so one bad event never sinks a batch. Call events become `estimated` facts priced from the same pinned LiteLLM table as the connectors - aggregated into one fact per key, day, vendor, model, and person, drilling down to the raw events - and they only count for products with attribution `sdk` (a key- or connector-attributed product already gets that spend from its vendor: one dollar, one source). Outcome events need outcome kind `sdk_event`; their `ref` becomes `source_ref` (the ticket id / coupon id the number drills to) and re-tracking the same ref restates the outcome in place. `employee` emails run the standard identity machinery: auto-match, Resolve queue when unknown, full-history re-attribution on a later match.

## Limits + burn alarms

A monthly spend limit per person (`PUT /api/people/{id}/limit {"limitUsdCents": 50000}`, admin; `null` clears) resets with the UTC calendar month and alerts to Slack at 80% and 100% of month-to-date spend - one alert per threshold per person per month, thresholds editable in Settings (`limit_alert_thresholds_pct`). Spend whose tag is toggled off personal usage never counts toward a limit. The limit is an alert, never a hard stop, and the vendor's own limit shows next to ours (`GET /api/limits`) with what each vendor can actually enforce stated verbatim: Cursor reports a per-user limit and accepts ours via `"pushToCursor": true` (Enterprise plan only - rejections come back verbatim, our limit stays saved); Anthropic workspace caps are real hard-stops but Console-set and not exposed by its Admin API; OpenAI has no budget API at all - alert only. Anomaly alarms fire when someone's daily burn reaches 3x their trailing 30-day average and at least $20 (both editable: `anomaly_burn_multiplier`, `anomaly_min_day_cents`), max one per person per day. The alert channel is a Slack incoming webhook, stored encrypted like every secret (`PATCH /api/settings {"slack_webhook_url": "https://hooks.slack.com/..."}`, `null` clears, never echoed back); silent-connector alerts ride the same channel.

## Money, FX, and invoices

Money is stored as billed - amount + currency - and normalized to USD cents in the daily rollups via daily ECB reference rates, fetched automatically (every 6 hours, recorded under `ecb_fx` in the sync history; `POST /api/fx/sync` fetches now, `GET /api/fx` shows coverage and the last run). Charts convert from USD to the org's **display currency** (Settings, `PATCH /api/settings {"display_currency": "EUR"}`) at read time - changing it never recomputes anything - and drill-downs always show the original amounts. A currency with no fetched rate is refused everywhere it could enter (manual entries, invoices, the display currency itself): no rate, no fake number.

Monthly invoices true the estimates up (`POST /api/invoices/import`, admin, CSV body with `vendor, month, amount, currency` + optional invoice ref and note; headers auto-detect, `?preview=1` validates with per-row errors without committing, and a commit is all-or-nothing). Each imported (vendor, month) - one row per month, re-import corrects it in place - materializes the difference between the invoice and that month's synced facts as **one adjustment fact** on the month's last day: cost basis `invoiced`, Unassigned (no known owner), negative when the vendor billed less than estimated, `source_ref = invoice:<id>` so it drills to the invoice, not vendor rows. Per-person and per-product numbers stay exactly what the vendor reported - the drift is never smeared over them - while totals sum to what was actually billed. Syncs that restate an invoiced month re-true it automatically. `GET /api/invoices` is the drift report behind the Overview tile: per vendor-month, estimated vs invoiced facts vs the invoice, with the drift in the invoice's currency, USD, and the display currency. Only completed months import - truing up a month still accruing would fabricate drift.

## Development

```bash
npm install
npm run dev          # http://localhost:3000
```

| Script | Does |
|---|---|
| `npm run build` | Production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest. Database tests need `TEST_DATABASE_URL` pointing at a Postgres server (they create and drop scratch databases); they skip when it's unset. CI always runs them. |
| `npm run test:py` | Python SDK tests (stdlib `unittest`, no installs). The end-to-end test boots the real app against a scratch database and needs `TEST_DATABASE_URL`; it skips when unset. |
| `npm run lint` | ESLint |

```bash
TEST_DATABASE_URL=postgres://localhost:5432/postgres npm test
```

Migrations are plain SQL files in `migrations/`, named `NNN_description.sql`, applied in order by `scripts/migrate.mjs` on container boot.
