import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import {
  TEST_DATABASE_URL,
  createScratchDb,
  dropScratchDb,
} from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

describe.runIf(TEST_DATABASE_URL)("core schema", () => {
  let dbUrl: string;
  let pool: Pool;

  beforeAll(async () => {
    dbUrl = await createScratchDb("schema_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    pool = new Pool({ connectionString: dbUrl, max: 3 });
  });

  afterAll(async () => {
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  it("creates every table the spec and services depend on", async () => {
    const { rows } = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    expect(rows.map((r) => r.tablename)).toEqual([
      "alert_state",
      "auth_challenges",
      "connectors",
      "fx_rates",
      "identities",
      "ingest_keys",
      "outcomes",
      "people",
      "products",
      "reset_tokens",
      "rollup_daily",
      "rollup_outcomes_daily",
      "schema_migrations",
      "sessions",
      "settings",
      "spend_facts",
      "sync_runs",
      "users",
      "webauthn_credentials",
    ]);
  });

  it("accepts unassigned spend: person_id and product_id are nullable", async () => {
    const { rows } = await pool.query(
      `INSERT INTO spend_facts
         (day, person_id, product_id, vendor, tokens, amount_cents, currency, cost_basis, source_ref)
       VALUES ('2026-06-01', NULL, NULL, 'openai', 10, 42, 'USD', 'estimated', 'openai:usage:x1')
       RETURNING person_id, product_id`,
    );
    expect(rows[0]).toEqual({ person_id: null, product_id: null });
  });

  it("rejects spend facts outside the spec enums and currency format", async () => {
    await expect(
      pool.query(
        `INSERT INTO spend_facts (day, vendor, amount_cents, currency, cost_basis, source_ref)
         VALUES ('2026-06-01', 'openai', 1, 'USD', 'guessed', 'x')`,
      ),
    ).rejects.toThrow(/cost_basis/);
    await expect(
      pool.query(
        `INSERT INTO spend_facts (day, vendor, amount_cents, currency, cost_basis, source_ref)
         VALUES ('2026-06-01', 'openai', 1, 'usd', 'estimated', 'x')`,
      ),
    ).rejects.toThrow(/currency/);
  });

  it("enforces case-insensitive unique emails on people", async () => {
    await pool.query(
      "INSERT INTO people (email, name) VALUES ('Dana@acme.com', 'Dana')",
    );
    await expect(
      pool.query("INSERT INTO people (email) VALUES ('dana@ACME.com')"),
    ).rejects.toThrow(/people_email_lower_key/);
  });

  it("identities: one row per (vendor, external_id, kind), person optional until resolved", async () => {
    await pool.query(
      `INSERT INTO identities (person_id, vendor, external_id, kind, tags)
       VALUES (NULL, 'anthropic', 'key_abc', 'api_key', '{batch-processing}')`,
    );
    await expect(
      pool.query(
        `INSERT INTO identities (vendor, external_id, kind)
         VALUES ('anthropic', 'key_abc', 'api_key')`,
      ),
    ).rejects.toThrow(/identities_vendor_external_id_kind_key/);
  });

  it("outcomes: a value requires a currency and vice versa", async () => {
    const { rows } = await pool.query(
      `INSERT INTO products (name, attribution) VALUES ('coding', 'connector') RETURNING id`,
    );
    const productId = rows[0].id;
    await expect(
      pool.query(
        `INSERT INTO outcomes (ts, product_id, kind, value_cents, currency, source_ref)
         VALUES (now(), $1, 'merged_pr', 210, NULL, 'github:pr:1')`,
        [productId],
      ),
    ).rejects.toThrow(/check/i);
    // valueless outcomes are fine (cost-per-outcome products with no ROI)
    await pool.query(
      `INSERT INTO outcomes (ts, product_id, kind, source_ref)
       VALUES (now(), $1, 'merged_pr', 'github:pr:2')`,
      [productId],
    );
  });

  it("fx_rates: one rate per day and currency", async () => {
    await pool.query(
      "INSERT INTO fx_rates (day, currency, usd_rate) VALUES ('2026-06-01', 'EUR', 1.1)",
    );
    await expect(
      pool.query(
        "INSERT INTO fx_rates (day, currency, usd_rate) VALUES ('2026-06-01', 'EUR', 1.2)",
      ),
    ).rejects.toThrow(/fx_rates_pkey/);
  });

  it("rollup_daily: NULLS NOT DISTINCT unique key dedupes the Unassigned bucket", async () => {
    await pool.query(
      `INSERT INTO rollup_daily (day, person_id, product_id, vendor, cost_basis, tokens, amount_usd_cents, fact_count)
       VALUES ('2026-06-01', NULL, NULL, 'openai', 'estimated', 0, 100, 1)`,
    );
    await expect(
      pool.query(
        `INSERT INTO rollup_daily (day, person_id, product_id, vendor, cost_basis, tokens, amount_usd_cents, fact_count)
         VALUES ('2026-06-01', NULL, NULL, 'openai', 'estimated', 0, 200, 2)`,
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("ingest_keys store only a hash and alert_state dedupes per period", async () => {
    const { rows } = await pool.query(
      `INSERT INTO products (name, attribution) VALUES ('support-bot', 'sdk') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO ingest_keys (product_id, token_hash, token_prefix)
       VALUES ($1, 'deadbeef', 'pnl_dead')`,
      [rows[0].id],
    );
    await expect(
      pool.query(
        `INSERT INTO ingest_keys (product_id, token_hash, token_prefix)
         VALUES ($1, 'deadbeef', 'pnl_dead')`,
        [rows[0].id],
      ),
    ).rejects.toThrow(/ingest_keys_token_hash_key/);

    await pool.query(
      `INSERT INTO alert_state (kind, scope, period_key)
       VALUES ('limit_80', '11111111-1111-1111-1111-111111111111', '2026-06')`,
    );
    await expect(
      pool.query(
        `INSERT INTO alert_state (kind, scope, period_key)
         VALUES ('limit_80', '11111111-1111-1111-1111-111111111111', '2026-06')`,
      ),
    ).rejects.toThrow(/alert_state_kind_scope_period_key_key/);
    // a new month is a new alert
    await pool.query(
      `INSERT INTO alert_state (kind, scope, period_key)
       VALUES ('limit_80', '11111111-1111-1111-1111-111111111111', '2026-07')`,
    );
  });
});
