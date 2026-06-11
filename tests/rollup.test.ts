import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recomputeRollups } from "../src/lib/rollup";
import { runMigrations } from "../scripts/migrate.mjs";
import {
  TEST_DATABASE_URL,
  createScratchDb,
  dropScratchDb,
} from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const SEED = readFileSync(
  path.resolve(__dirname, "fixtures", "rollup_seed.sql"),
  "utf8",
);

const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";
const SUPPORT_BOT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

describe.runIf(TEST_DATABASE_URL)("recomputeRollups", () => {
  let dbUrl: string;
  let pool: Pool;

  beforeAll(async () => {
    dbUrl = await createScratchDb("rollup_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    pool = new Pool({ connectionString: dbUrl, max: 3 });
    await pool.query(SEED);
  });

  afterAll(async () => {
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  async function spendRollups() {
    const { rows } = await pool.query(
      `SELECT day::text, person_id, product_id, vendor, cost_basis,
              tokens::int, amount_usd_cents::int, fact_count
       FROM rollup_daily
       ORDER BY day, vendor, cost_basis, person_id NULLS LAST`,
    );
    return rows;
  }

  async function outcomeRollups() {
    const { rows } = await pool.query(
      `SELECT day::text, product_id, person_id, kind,
              outcome_count, value_usd_cents::int
       FROM rollup_outcomes_daily
       ORDER BY day, kind, person_id NULLS LAST`,
    );
    return rows;
  }

  it("rolls up spend with FX normalization, grouping, and the Unassigned bucket", async () => {
    const result = await recomputeRollups({}, pool);
    expect(result).toEqual({
      from: "2026-05-30",
      to: "2026-06-04",
      spendRows: 5,
      outcomeRows: 3,
    });

    expect(await spendRollups()).toEqual([
      // backfill before the first EUR rate falls forward to 06-01's 1.10
      { day: "2026-05-30", person_id: ALICE, product_id: null, vendor: "cursor", cost_basis: "invoiced", tokens: 0, amount_usd_cents: 110, fact_count: 1 },
      // two facts in one group summed
      { day: "2026-06-01", person_id: ALICE, product_id: null, vendor: "anthropic", cost_basis: "estimated", tokens: 3000, amount_usd_cents: 800, fact_count: 2 },
      // Unassigned: person_id NULL kept as its own visible bucket
      { day: "2026-06-01", person_id: null, product_id: null, vendor: "openai", cost_basis: "estimated", tokens: 500, amount_usd_cents: 250, fact_count: 1 },
      // EUR at 06-01 rate 1.10
      { day: "2026-06-01", person_id: BOB, product_id: null, vendor: "openai", cost_basis: "invoiced", tokens: 0, amount_usd_cents: 1100, fact_count: 1 },
      // rate gap: 06-04 uses the latest rate <= day (06-03, 1.20)
      { day: "2026-06-04", person_id: BOB, product_id: SUPPORT_BOT, vendor: "anthropic", cost_basis: "estimated", tokens: 4000, amount_usd_cents: 1200, fact_count: 1 },
    ]);
  });

  it("buckets outcomes by UTC day and keeps valueless outcomes countable", async () => {
    expect(await outcomeRollups()).toEqual([
      { day: "2026-06-01", product_id: SUPPORT_BOT, person_id: ALICE, kind: "ticket_resolved", outcome_count: 1, value_usd_cents: 450 },
      { day: "2026-06-01", product_id: SUPPORT_BOT, person_id: null, kind: "ticket_resolved", outcome_count: 1, value_usd_cents: 220 },
      // 2026-06-02T02:00Z is 06-01 in US timezones; UTC bucketing puts it on 06-02
      { day: "2026-06-02", product_id: SUPPORT_BOT, person_id: ALICE, kind: "ticket_resolved", outcome_count: 1, value_usd_cents: null },
    ]);
  });

  it("is idempotent: recomputing again yields identical rows, no duplicates", async () => {
    const before = await spendRollups();
    await recomputeRollups({}, pool);
    expect(await spendRollups()).toEqual(before);
    expect(await outcomeRollups()).toHaveLength(3);
  });

  it("re-attribution recompute moves history out of Unassigned and leaves other days alone", async () => {
    // Resolve matched the openai key to Bob: re-attribute the fact's history.
    await pool.query(
      "UPDATE spend_facts SET person_id = $1 WHERE source_ref = 'openai:usage:u1'",
      [BOB],
    );
    const result = await recomputeRollups(
      { from: "2026-06-01", to: "2026-06-01" },
      pool,
    );
    expect(result.spendRows).toBe(3);

    const rows = await spendRollups();
    // the Unassigned openai row is gone; the spend now sits on Bob
    expect(
      rows.filter((r) => r.person_id === null && r.vendor === "openai"),
    ).toEqual([]);
    expect(rows).toContainEqual({
      day: "2026-06-01", person_id: BOB, product_id: null, vendor: "openai", cost_basis: "estimated", tokens: 500, amount_usd_cents: 250, fact_count: 1,
    });
    // days outside the recompute range are untouched
    expect(rows.filter((r) => r.day === "2026-05-30")).toHaveLength(1);
    expect(rows.filter((r) => r.day === "2026-06-04")).toHaveLength(1);

    // total money is conserved: every dollar belongs to exactly one row
    const { rows: totals } = await pool.query(
      "SELECT SUM(amount_usd_cents)::int AS total FROM rollup_daily",
    );
    expect(totals[0].total).toBe(110 + 800 + 250 + 1100 + 1200);
  });

  it("aborts when a currency has no FX rate at all - no fake numbers", async () => {
    await pool.query(
      `INSERT INTO spend_facts
         (day, person_id, vendor, tokens, amount_cents, currency, cost_basis, source_ref)
       VALUES ('2026-06-05', $1, 'cursor', 0, 700, 'GBP', 'invoiced', 'cursor:invoice:gbp1')`,
      [ALICE],
    );
    await expect(recomputeRollups({}, pool)).rejects.toThrow(
      /no FX rate for currencies: GBP/,
    );
    // the failed run rolled back: previous rollups are intact
    expect(await spendRollups()).toHaveLength(5);
    await pool.query(
      "DELETE FROM spend_facts WHERE source_ref = 'cursor:invoice:gbp1'",
    );
  });

  it("rejects malformed and inverted ranges", async () => {
    await expect(
      recomputeRollups({ from: "06/01/2026", to: "2026-06-02" }, pool),
    ).rejects.toThrow(/must be YYYY-MM-DD/);
    await expect(
      recomputeRollups({ from: "2026-06-02", to: "2026-06-01" }, pool),
    ).rejects.toThrow(/is after/);
  });

  it("no facts and no range: a no-op that leaves retention-survivor rollups intact", async () => {
    // simulate a raw-fact retention purge: facts gone, rollups must survive
    await pool.query("DELETE FROM spend_facts");
    await pool.query("DELETE FROM outcomes");
    const result = await recomputeRollups({}, pool);
    expect(result).toEqual({ from: null, to: null, spendRows: 0, outcomeRows: 0 });
    expect(await spendRollups()).toHaveLength(5);
    expect(await outcomeRollups()).toHaveLength(3);
  });
});
