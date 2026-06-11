import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listFacts, listOutcomes } from "../src/lib/overview";
import { productDetail, productsView } from "../src/lib/products";
import { recomputeRollups } from "../src/lib/rollup";
import { setSetting } from "../src/lib/settings";
import { runMigrations } from "../scripts/migrate.mjs";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

/**
 * Products page readers (spec 10 page 3), driven through the real pipeline:
 * products/facts/outcomes -> recomputeRollups -> productsView/productDetail
 * - and the dashboard invariant: every displayed number equals the raw rows
 * its drill filter returns. Each product measures itself in its OWN unit:
 * $/merge (github_pr), $/ticket_resolved (one named sdk kind), $/outcome
 * (mixed kinds), $/active user (no outcome metric at all).
 *
 * Fixture (USD display, EUR rate 1.25 USD per EUR), June range 06-01..06-04:
 *   supportbot (sdk, sdk_event, default value 450c):
 *     dana 06-01 1,000 USD · omer 06-02 400 EUR (= 500 USD) · shared
 *     person-less 06-02 500 USD -> 2,000 total, 2 active users
 *     outcomes ticket_resolved: t1 dana valued 500 · t2 dana · t3 omer ·
 *     t4 dana REVERTED -> 3 live, value 500 + 2 x 450 = 1,400, ROI 0.7
 *   Coding (connector, github_pr): a routed shared key spends 600; 3 live
 *     merges + 1 reverted -> $2.00/merge
 *   Company Brain (manual, none): 2,000 manual + dana 300 + omer 100
 *     estimated -> $12.00/active user, no unit, no fake ROI
 *   mixed (sdk, sdk_event): two different kinds -> plain "outcome" unit
 *   empty (sdk, none): a roster row with zeros - listed, never invented
 *   oldtool (ARCHIVED): 9,999 spend - in no current view, history intact
 */

const JUNE = { from: "2026-06-01", to: "2026-06-04" };

describe.runIf(TEST_DATABASE_URL)("products page readers", () => {
  let dbUrl: string;
  let pool: Pool;
  let dana: string;
  let omer: string;
  let supportbot: string;
  let coding: string;
  let brain: string;
  let mixed: string;
  let oldtool: string;
  let codingKey: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("products_page_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 3 });

    await pool.query(
      "INSERT INTO fx_rates (day, currency, usd_rate) VALUES ('2026-05-01', 'EUR', 1.25)",
    );
    const { rows: people } = await pool.query(
      `INSERT INTO people (email, name) VALUES
         ('dana@acme.com', 'Dana Roth'), ('omer@acme.com', 'Omer Lev')
       RETURNING id`,
    );
    [dana, omer] = people.map((p) => p.id);

    const { rows: products } = await pool.query(
      `INSERT INTO products
         (name, attribution, outcome_kind, default_value_cents, default_value_currency, archived_at)
       VALUES
         ('supportbot', 'sdk', 'sdk_event', 450, 'USD', NULL),
         ('Coding', 'connector', 'github_pr', NULL, NULL, NULL),
         ('Company Brain', 'manual', 'none', NULL, NULL, NULL),
         ('mixed', 'sdk', 'sdk_event', NULL, NULL, NULL),
         ('empty', 'sdk', 'none', NULL, NULL, NULL),
         ('oldtool', 'key', 'none', NULL, NULL, now())
       RETURNING id`,
    );
    [supportbot, coding, brain, mixed, , oldtool] = products.map((p) => p.id);

    const { rows: keys } = await pool.query(
      `INSERT INTO identities (person_id, vendor, external_id, kind, tags, not_person, product_id)
       VALUES (NULL, 'anthropic', 'key_coding', 'api_key', '{coding}', true, $1)
       RETURNING id`,
      [coding],
    );
    codingKey = keys[0].id;

    const fact = async (
      day: string,
      personId: string | null,
      productId: string | null,
      identityId: string | null,
      vendor: string,
      amountCents: number,
      currency: string,
      basis: string,
      sourceRef: string,
    ) =>
      pool.query(
        `INSERT INTO spend_facts (day, person_id, product_id, identity_id, vendor,
                                  tokens, amount_cents, currency, cost_basis, source_ref)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9)`,
        [day, personId, productId, identityId, vendor, amountCents, currency, basis, sourceRef],
      );
    await fact("2026-06-01", dana, supportbot, null, "openai", 1_000, "USD", "estimated", "s1");
    await fact("2026-06-02", omer, supportbot, null, "openai", 400, "EUR", "estimated", "s2");
    await fact("2026-06-02", null, supportbot, null, "anthropic", 500, "USD", "estimated", "s3");
    await fact("2026-06-02", null, coding, codingKey, "anthropic", 600, "USD", "estimated", "k1");
    await fact("2026-06-01", null, brain, null, "manual", 2_000, "USD", "manual", "b1");
    await fact("2026-06-01", dana, brain, null, "openai", 300, "USD", "estimated", "b2");
    await fact("2026-06-03", omer, brain, null, "openai", 100, "USD", "estimated", "b3");
    await fact("2026-06-02", null, oldtool, null, "acme", 9_999, "USD", "estimated", "old1");
    // Outside the range - key history, never range numbers.
    await fact("2026-05-20", null, coding, codingKey, "anthropic", 7_000, "USD", "estimated", "k0");

    const outcome = async (
      ts: string,
      productId: string,
      personId: string | null,
      kind: string,
      valueCents: number | null,
      sourceRef: string,
      reverted = false,
    ) =>
      pool.query(
        `INSERT INTO outcomes (ts, product_id, person_id, kind, count, value_cents,
                               currency, source_ref, reverted_at, revert_source_ref)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9)`,
        [
          ts,
          productId,
          personId,
          kind,
          valueCents,
          valueCents === null ? null : "USD",
          sourceRef,
          reverted ? "2026-06-04T00:00:00Z" : null,
          reverted ? `revert:${sourceRef}` : null,
        ],
      );
    await outcome("2026-06-01T10:00:00Z", supportbot, dana, "ticket_resolved", 500, "t1");
    await outcome("2026-06-02T10:00:00Z", supportbot, dana, "ticket_resolved", null, "t2");
    await outcome("2026-06-02T11:00:00Z", supportbot, omer, "ticket_resolved", null, "t3");
    await outcome("2026-06-03T10:00:00Z", supportbot, dana, "ticket_resolved", null, "t4", true);
    await outcome("2026-06-01T09:00:00Z", coding, dana, "github_pr", null, "pr1");
    await outcome("2026-06-02T09:00:00Z", coding, dana, "github_pr", null, "pr2");
    await outcome("2026-06-02T09:30:00Z", coding, null, "github_pr", null, "pr3");
    await outcome("2026-06-03T09:00:00Z", coding, dana, "github_pr", null, "pr4", true);
    await outcome("2026-06-02T12:00:00Z", mixed, null, "ticket_resolved", null, "m1");
    await outcome("2026-06-02T13:00:00Z", mixed, null, "coupon_used", null, "m2");

    await recomputeRollups({}, pool);
  });

  afterAll(async () => {
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  it("lists every cost center with spend and its own metric in its own unit", async () => {
    const view = await productsView(JUNE, pool);
    expect(view.displayCurrency).toBe("USD");
    expect(view.days).toEqual(["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"]);

    expect(view.products.map((p) => [p.name, p.spendCents])).toEqual([
      ["Company Brain", 2_400],
      ["supportbot", 2_000],
      ["Coding", 600],
      ["mixed", 0],
      ["empty", 0],
    ]);

    const byName = new Map(view.products.map((p) => [p.name, p]));
    expect(byName.get("supportbot")).toMatchObject({
      outcomeCount: 3,
      revertedCount: 1,
      unit: "ticket_resolved", // one named kind = the product's own unit
      unitCostCents: 667, // 2,000 / 3
      valueCents: 1_400, // 500 explicit + 2 x 450 default
      roi: 0.7,
      activeUsers: 2,
      costPerUserCents: 1_000,
      trend: [1_000, 1_000, 0, 0],
    });
    expect(byName.get("Coding")).toMatchObject({
      unit: "merge",
      outcomeCount: 3,
      revertedCount: 1,
      unitCostCents: 200, // 600 / 3 merges
      valueCents: null, // no value recorded, none invented
      roi: null,
    });
    expect(byName.get("Company Brain")).toMatchObject({
      unit: null, // no outcome metric: plain cost per active user
      unitCostCents: null,
      outcomeCount: 0,
      activeUsers: 2,
      costPerUserCents: 1_200, // 2,400 / 2
      valueCents: null,
      roi: null,
    });
    expect(byName.get("mixed")).toMatchObject({
      unit: "outcome", // two different kinds: no single unit is claimed
      outcomeCount: 2,
      unitCostCents: 0,
    });
    expect(byName.get("empty")).toMatchObject({
      spendCents: 0,
      outcomeCount: 0,
      unitCostCents: null,
      costPerUserCents: null,
      trend: [0, 0, 0, 0],
    });
  });

  it("hides archived products from the view; their history stays drillable", async () => {
    const view = await productsView(JUNE, pool);
    expect(view.products.some((p) => p.name === "oldtool")).toBe(false);

    const drill = await listFacts({ ...JUNE, product: oldtool }, pool);
    expect(drill.totalDisplayCents).toBe(9_999);
    const detail = await productDetail(oldtool, JUNE, pool);
    expect(detail.product.archivedAt).not.toBeNull();
    expect(detail.metrics.spendCents).toBe(9_999);
  });

  it("every view number equals the sum of its drill-down rows", async () => {
    const view = await productsView(JUNE, pool);
    for (const row of view.products) {
      const facts = await listFacts({ ...JUNE, product: row.id }, pool);
      expect(facts.totalDisplayCents).toBe(row.spendCents);
      expect(facts.totalCount).toBe(row.factCount);
      const outcomes = await listOutcomes({ ...JUNE, product: row.id }, pool);
      expect(outcomes.liveCount).toBe(row.outcomeCount);
      expect(outcomes.revertedCount).toBe(row.revertedCount);
      for (const [i, cents] of row.trend.entries()) {
        const dayDrill = await listFacts(
          { product: row.id, day: view.days[i] },
          pool,
        );
        expect(dayDrill.totalDisplayCents).toBe(cents);
      }
    }
  });

  it("product detail: totals, vendor/person/day splits - all drillable", async () => {
    const detail = await productDetail(supportbot, JUNE, pool);
    expect(detail.displayCurrency).toBe("USD");
    expect(detail.metrics).toEqual({
      spendCents: 2_000,
      spendByBasis: { estimated: 2_000, invoiced: 0, manual: 0 },
      factCount: 3,
      outcomes: 3,
      valuedOutcomes: 1,
      revertedOutcomes: 1,
      unitCostCents: 667,
      unit: "ticket_resolved",
      valueCents: 1_400,
      roi: 0.7,
      activeUsers: 2,
      costPerUserCents: 1_000,
    });
    expect(detail.outcomesByKind).toEqual([{ kind: "ticket_resolved", count: 3 }]);
    expect(detail.byVendor).toEqual([
      { vendor: "openai", cents: 1_500, factCount: 2 },
      { vendor: "anthropic", cents: 500, factCount: 1 },
    ]);
    // The person-less share is its own visible row, never dropped.
    expect(detail.byPerson).toEqual([
      { personId: dana, name: "Dana Roth", email: "dana@acme.com", cents: 1_000, factCount: 1, outcomeCount: 2 },
      { personId: omer, name: "Omer Lev", email: "omer@acme.com", cents: 500, factCount: 1, outcomeCount: 1 },
      { personId: null, name: null, email: null, cents: 500, factCount: 1, outcomeCount: 0 },
    ]);
    expect(detail.trend).toEqual([
      { day: "2026-06-01", cents: 1_000 },
      { day: "2026-06-02", cents: 1_000 },
      { day: "2026-06-03", cents: 0 },
      { day: "2026-06-04", cents: 0 },
    ]);
    expect(detail.daily).toEqual([
      { day: "2026-06-02", vendor: "anthropic", cents: 500, factCount: 1, tokens: 0 },
      { day: "2026-06-02", vendor: "openai", cents: 500, factCount: 1, tokens: 0 },
      { day: "2026-06-01", vendor: "openai", cents: 1_000, factCount: 1, tokens: 0 },
    ]);
    // Every split equals its drill filter (spec 3).
    for (const v of detail.byVendor) {
      const drill = await listFacts({ ...JUNE, product: supportbot, vendor: v.vendor }, pool);
      expect(drill.totalDisplayCents).toBe(v.cents);
    }
    for (const p of detail.byPerson) {
      const drill = await listFacts(
        { ...JUNE, product: supportbot, person: p.personId ?? "unassigned" },
        pool,
      );
      expect(drill.totalDisplayCents).toBe(p.cents);
      const outcomes = await listOutcomes(
        { ...JUNE, product: supportbot, person: p.personId ?? "unassigned" },
        pool,
      );
      expect(outcomes.liveCount).toBe(p.outcomeCount);
    }
    for (const d of detail.daily) {
      const drill = await listFacts(
        { product: supportbot, day: d.day, vendor: d.vendor },
        pool,
      );
      expect(drill.totalDisplayCents).toBe(d.cents);
    }
  });

  it("product detail: the keys routed to it, range spend, all-time last use", async () => {
    const detail = await productDetail(coding, JUNE, pool);
    expect(detail.keys).toEqual([
      expect.objectContaining({
        id: codingKey,
        vendor: "anthropic",
        externalId: "key_coding",
        tags: ["coding"],
        cents: 600, // range-bounded: the May fact stays out
        factCount: 1,
        lastUsedDay: "2026-06-02",
      }),
    ]);
    // The key number IS its drill (/drill?key=) over the same range.
    const drill = await listFacts({ ...JUNE, key: codingKey }, pool);
    expect(drill.totalDisplayCents).toBe(600);
  });

  it("display currency converts view, detail and drills identically", async () => {
    await setSetting("display_currency", "EUR", pool);
    try {
      const view = await productsView(JUNE, pool);
      const bot = view.products.find((p) => p.name === "supportbot")!;
      expect(bot.spendCents).toBe(1_600); // 2,000 USD / 1.25
      expect(bot.valueCents).toBe(1_120); // 400 explicit + 720 default
      expect(bot.roi).toBe(0.7); // a ratio survives any currency
      const drill = await listFacts({ ...JUNE, product: supportbot }, pool);
      expect(drill.totalDisplayCents).toBe(bot.spendCents);

      const detail = await productDetail(supportbot, JUNE, pool);
      expect(detail.metrics.spendCents).toBe(1_600);
      expect(detail.metrics.valueCents).toBe(1_120);
      // The EUR fact converts back to exactly what was billed.
      expect(detail.byPerson.find((p) => p.personId === omer)!.cents).toBe(400);
    } finally {
      await setSetting("display_currency", "USD", pool);
    }
  });

  it("a display currency with no FX rate aborts - no fake numbers", async () => {
    await setSetting("display_currency", "GBP", pool);
    try {
      await expect(productsView(JUNE, pool)).rejects.toThrow(/no FX rate/);
      await expect(productDetail(supportbot, JUNE, pool)).rejects.toThrow(/no FX rate/);
    } finally {
      await setSetting("display_currency", "USD", pool);
    }
  });

  it("rejects unknown products and bad ranges loudly", async () => {
    await expect(
      productDetail("00000000-0000-4000-8000-000000000000", JUNE, pool),
    ).rejects.toThrow(/ROI not found/);
    await expect(
      productsView({ from: "junk", to: "2026-06-02" }, pool),
    ).rejects.toThrow(/from must be/);
    await expect(
      productDetail(supportbot, { from: "2026-06-05", to: "2026-06-01" }, pool),
    ).rejects.toThrow(/after/);
  });
});
