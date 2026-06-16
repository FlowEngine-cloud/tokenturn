import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listFacts, overviewData } from "../src/lib/overview";
import { recomputeRollups } from "../src/lib/rollup";
import { deleteSeat, listSeats, upsertSeat } from "../src/lib/seats";
import { runMigrations } from "../scripts/migrate.mjs";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const JUNE = { from: "2026-06-01", to: "2026-06-30" };
// Fixed "now" so an ongoing seat materializes through June, deterministically.
const NOW = new Date("2026-06-16T00:00:00Z");

/**
 * Subscription seats: a flat seat fee is real spend (it lands on the ledger as
 * billing_mode 'subscription'), while the seat holder's usage stays usage
 * value (from usage_metrics, never double counted as spend). The two Overview
 * numbers - real spend vs usage value - and the billing_mode drill filter all
 * hang on this, so the test drives the real pipeline and proves them.
 *
 * Fixture (USD display):
 *   2026-06-02  dana  anthropic  $50   metered estimated (an API key's tokens)
 *   2026-06-05  dana  anthropic  $3000 usage_metrics estimated_cost_cents
 *   seat: dana on Anthropic, $200/mo flat, started 2026-06 -> $200 June fee
 */
describe.runIf(TEST_DATABASE_URL)("subscription seats", () => {
  let dbUrl: string;
  let pool: Pool;
  let dana: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("seats_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 3 });

    const { rows } = await pool.query(
      `INSERT INTO people (email, name) VALUES ('dana@acme.com', 'Dana') RETURNING id`,
    );
    dana = rows[0].id;

    // Metered API usage (billing_mode defaults to 'metered').
    await pool.query(
      `INSERT INTO spend_facts (day, person_id, vendor, tokens, amount_cents, currency, cost_basis, source_ref)
       VALUES ('2026-06-02', $1, 'anthropic', 1000, 5000, 'USD', 'estimated', 'usage:a1')`,
      [dana],
    );
    // Claude Code subscription usage value, kept out of spend_facts.
    await pool.query(
      `INSERT INTO usage_metrics (day, vendor, metric, value, person_id, source_ref)
       VALUES ('2026-06-05', 'anthropic', 'estimated_cost_cents', 300000, $1, 'cc:1')`,
      [dana],
    );
    await recomputeRollups(JUNE, pool);
  });

  afterAll(async () => {
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  it("a flat seat lands on the ledger as subscription spend, not as usage", async () => {
    const seat = await upsertSeat(
      {
        vendor: "anthropic",
        personId: dana,
        tier: "Max 20x",
        amountCents: 20000,
        currency: "USD",
        startedMonth: "2026-06",
      },
      pool,
      NOW,
    );
    expect(seat.amountCents).toBe(20000);
    expect((await listSeats(pool)).length).toBe(1);

    const o = await overviewData(JUNE, pool);
    // Real spend = metered $50 + flat seat $200.
    expect(o.totals.totalCents).toBe(25000);
    expect(o.totals.subscriptionCents).toBe(20000);
    expect(o.totals.meteredCents).toBe(5000);
    // Usage value = metered token estimate $50 + seat holder's $3000 of usage.
    expect(o.totals.usageValueCents).toBe(305000);
  });

  it("the billing_mode drill filter splits seats from metered, and sums to its tile", async () => {
    const subs = await listFacts({ ...JUNE, billingMode: "subscription" }, pool);
    expect(subs.totalCount).toBe(1);
    expect(subs.totalDisplayCents).toBe(20000);
    expect(subs.rows[0].billingMode).toBe("subscription");

    const metered = await listFacts({ ...JUNE, billingMode: "metered" }, pool);
    expect(metered.totalDisplayCents).toBe(5000);
  });

  it("re-pricing a seat re-values its materialized months", async () => {
    await upsertSeat(
      { vendor: "anthropic", personId: dana, amountCents: 10000, currency: "USD", startedMonth: "2026-06" },
      pool,
      NOW,
    );
    const o = await overviewData(JUNE, pool);
    expect(o.totals.subscriptionCents).toBe(10000);
    expect(o.totals.totalCents).toBe(15000);
  });

  it("deleting a seat removes its subscription spend", async () => {
    const [seat] = await listSeats(pool);
    await deleteSeat(seat.id, pool);
    expect((await listSeats(pool)).length).toBe(0);

    const o = await overviewData(JUNE, pool);
    expect(o.totals.subscriptionCents).toBe(0);
    expect(o.totals.totalCents).toBe(5000);
    // Usage value keeps the seat holder's metered estimate only (seat usage
    // no longer scoped to a seat); the $3000 metric drops out.
    expect(o.totals.usageValueCents).toBe(5000);
  });
});
