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

## Connectors

Vendor connectors sync hourly with a stored cursor: full backfill to the vendor's history limit on first connect, resume at the exact failed page after an error, a trailing 7-day re-pull every sync (vendors restate data), and idempotent upserts - a vendor record is never duplicated. Token scopes are validated on connect; credentials are stored encrypted, never plaintext. `GET /api/connectors` is the health surface: last sync, row counts, and the vendor's error verbatim. A connector silent for 24 hours fires an alert event. Connectors are tested against recorded vendor responses (`tests/fixtures/connectors/`), so a vendor format change breaks CI instead of production.

**Anthropic** connects with an Admin API key (`sk-ant-admin...`) and pulls org users and API keys (keys auto-map to the person who created them - Anthropic has no key-creation API, so each person mints their own key and the next sync picks it up), per-key/workspace daily usage priced from a pinned model price table (marked `estimated` - Anthropic never reports raw API dollars per user), non-token charges from the cost report (web search, code execution, session usage; `invoiced`, unassigned), and per-user daily Claude Code analytics (sessions, commits, PRs, accept rates, tokens, cost) stored as metrics rather than spend so the ledger never double counts.

**GitHub** connects with a classic PAT (`read:org`, `manage_billing:copilot`, `repo`; enterprise-owned orgs need an enterprise owner's PAT with `admin:enterprise` - per-user Copilot dollars then come from the enterprise billing API) and pulls the Copilot seat roster, per-user AI-credit dollars (GitHub's finest per-user grain is the calendar month, so facts land on the month bucket, `invoiced`; spend the report can't attribute to a current seat holder stays visible as Unassigned), per-user daily Copilot usage counters (interactions, code generations/acceptances - the accept-rate inputs), and merged PRs as outcomes: a merged PR counts on merge, AI authorship is detected from bot authors and commit co-author trailers (Claude, Copilot, Cursor, Devin, Codex), and a revert referencing a PR within the revert window (Settings, default 30 days) flips it and recomputes - after the window it's final. Seat fees are never invented or amortized.

## Identity resolution

Identities auto-match to people by email, case-insensitively, across all vendors; keys map via their vendor-side owner fields. Whatever can't be matched sits in the Resolve queue (`GET /api/resolve`) with explainable suggestions - same email handle, same name, or the same email/name already confirmed on another identity - never guessed scores. One click confirms a match (`POST /api/resolve/{id}/confirm`), re-attributes that identity's **full history** (facts, metrics, outcomes, rollups), and is remembered forever: the email becomes an alias, so the same email on any vendor auto-maps from then on. A key that isn't a person - a service account - routes to a product and/or a tag instead (`POST /api/resolve/{id}/not-person`) and auto-match never re-fills it. Two emails belonging to one human merge (`POST /api/resolve/merge`); the merged person archives, and their identities, history, and email follow the survivor. Spend with no person and no product stays visible per vendor as Unassigned - never dropped, never hidden.

## Tags

Key names become tags on the next sync - the name says what a key is for and where it's plugged in, by convention; a key rename re-tags its full history retroactively (tags live on the identity, and every tag query joins facts to their identity). `GET /api/tags` lists every tag in use with the keys and spend behind it; `GET /api/tags/{tag}` filters the ledger by tag, across all employees and keys, down to the vendor rows. `PATCH /api/tags/{tag}` (admin) changes a tag's settings: `countsPersonal: false` keeps the spend attributed to its person but flags it out of personal usage (batch jobs, cron keys, experiments - the flag flows into the daily rollups), and `productId` points the tag at a product, routing every key carrying it - product set, person cleared, full history re-attributed, auto-match never re-fills it. That's the agent convention: a key tagged `devin` burns on the Devin product, never on whoever minted it, and new keys carrying a routed tag route at sync time with no clicks. A key routes to at most one product: a key whose tags point at two products is a conflict, surfaced in the Resolve queue (`conflicts` in `GET /api/resolve`) and left unrouted until a human un-points one of the tags or renames the key. Tags added in Resolve (`manual_tags`) survive syncs; vendor tags mirror the key name.

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
| `npm run lint` | ESLint |

```bash
TEST_DATABASE_URL=postgres://localhost:5432/postgres npm test
```

Migrations are plain SQL files in `migrations/`, named `NNN_description.sql`, applied in order by `scripts/migrate.mjs` on container boot.
