# AI P&L

Self-hosted, per-employee AI spend and ROI ledger. Shows what every employee and every internal product spends on AI, and what the company got back - no proxy, no stored keys.

## Quickstart

```bash
docker compose up
```

Open [http://localhost:3000](http://localhost:3000).

That's it. `DATABASE_URL` is the only environment variable; everything else is configured in Settings and stored in the database. Migrations run automatically on boot. Backup = the Postgres volume.

## Health

`GET /healthz` returns `200 {"status":"ok","db":"ok"}` when the app and database are up, `503` otherwise. The Docker image ships a matching `HEALTHCHECK`.

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
