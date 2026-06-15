# Contributing to Tokenturn

Thanks for helping improve Tokenturn. This guide covers the setup, the checks
your change has to pass, and how the licensing splits across the repo.

## Setup

```bash
npm install
npm run dev          # http://localhost:3000
```

Database-backed tests need a Postgres server:

```bash
TEST_DATABASE_URL=postgres://localhost:5432/postgres npm test
```

## Before you open a PR

Run the same gates CI runs - a PR that fails any of these won't merge:

```bash
npm run lint
npm run typecheck
npm run build
npm test             # set TEST_DATABASE_URL so the DB suite runs
npm run test:py      # Python SDK tests
```

Keep changes focused, add a test that fails without your fix, and don't commit
secrets, `.env*`, or anything under `.data/`.

## Licensing of your contribution

This repo is split:

- Everything outside `ee/` is under the **Sustainable Use License** (see
  [LICENSE](LICENSE)). By opening a PR you agree your contribution ships under
  that license.
- The `ee/` directory is **commercial and source-available** (see
  [ee/LICENSE](ee/LICENSE)). Contributions there are accepted at FlowEngine's
  discretion under those terms.

## Reporting security issues

Don't open a public issue for a vulnerability - follow [SECURITY.md](SECURITY.md).
