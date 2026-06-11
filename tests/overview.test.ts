import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importInvoices } from "../src/lib/invoices";
import {
  listFacts,
  listSyncRuns,
  overviewData,
  searchEverything,
} from "../src/lib/overview";
import { recomputeRollups } from "../src/lib/rollup";
import { setSetting } from "../src/lib/settings";
import { runMigrations } from "../scripts/migrate.mjs";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

/**
 * Overview + drill-down readers, driven through the real pipeline:
 * people/products -> spend_facts -> recomputeRollups -> overviewData, and
 * the one invariant the whole dashboard hangs on - every tile number equals
 * the sum of the raw facts its drill-down returns (spec 3).
 *
 * Fixture (USD display, EUR rate 1.25 USD per EUR):
 *   2026-05-20  dana   anthropic   9,999 USD  (outside the June range)
 *   2026-06-01  dana   anthropic  10,000 USD
 *   2026-06-01  omer   openai      5,000 USD
 *   2026-06-02  dana   anthropic   2,500 USD
 *   2026-06-02  -      cursor      1,500 USD  (no person, no product)
 *   2026-06-02  -      openai      2,000 USD  (supportbot product)
 *   2026-06-02  omer   acme        4,000 EUR  (= 5,000 USD)
 * plus a May anthropic invoice of 120.00 USD -> +2,001 drift adjustment.
 */

const JUNE = { from: "2026-06-01", to: "2026-06-04" };
const MAY_JUNE = { from: "2026-05-01", to: "2026-06-04" };

describe.runIf(TEST_DATABASE_URL)("overview + drill-down", () => {
  let dbUrl: string;
  let pool: Pool;
  let dana: string;
  let omer: string;
  let supportbot: string;

  async function fact(
    day: string,
    personId: string | null,
    productId: string | null,
    vendor: string,
    amountCents: number,
    currency: string,
    sourceRef: string,
    basis = "estimated",
    tokens = 0,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO spend_facts
         (day, person_id, product_id, vendor, model, tokens, amount_cents,
          currency, cost_basis, source_ref)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9)`,
      [day, personId, productId, vendor, tokens, amountCents, currency, basis, sourceRef],
    );
  }

  beforeAll(async () => {
    dbUrl = await createScratchDb("overview_test");
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
    dana = people[0].id;
    omer = people[1].id;
    const { rows: products } = await pool.query(
      `INSERT INTO products (name, attribution, outcome_kind)
       VALUES ('supportbot', 'sdk', 'sdk_event') RETURNING id`,
    );
    supportbot = products[0].id;

    await fact("2026-05-20", dana, null, "anthropic", 9_999, "USD", "a0");
    await fact("2026-06-01", dana, null, "anthropic", 10_000, "USD", "a1", "estimated", 1234);
    await fact("2026-06-01", omer, null, "openai", 5_000, "USD", "o1");
    await fact("2026-06-02", dana, null, "anthropic", 2_500, "USD", "a2");
    await fact("2026-06-02", null, null, "cursor", 1_500, "USD", "c1");
    await fact("2026-06-02", null, supportbot, "openai", 2_000, "USD", "s1");
    await fact("2026-06-02", omer, null, "acme", 4_000, "EUR", "x1");

    await pool.query(
      `INSERT INTO outcomes (ts, product_id, kind, source_ref)
       VALUES ('2026-06-02T10:00:00Z', $1, 'ticket_resolved', 't1'),
              ('2026-06-02T11:00:00Z', $1, 'ticket_resolved', 't2')`,
      [supportbot],
    );

    await recomputeRollups({}, pool);

    // May invoice: 120.00 vs 99.99 synced -> +20.01 adjustment (invoiced,
    // Unassigned, day 2026-05-31). importInvoices recomputes that day.
    await importInvoices(
      [
        {
          line: 2,
          vendor: "anthropic",
          month: "2026-05",
          amountCents: 12_000,
          currency: "USD",
          ref: "INV-1",
          note: null,
          error: null,
        },
      ],
      pool,
    );
  });

  afterAll(async () => {
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  it("totals: estimated/invoiced split, coverage, fact count", async () => {
    const data = await overviewData(JUNE, pool);
    expect(data.displayCurrency).toBe("USD");
    expect(data.totals).toEqual({
      totalCents: 26_000,
      estimatedCents: 26_000,
      invoicedCents: 0,
      assignedCents: 24_500,
      unassignedCents: 1_500,
      coveragePct: 94.2,
      factCount: 6,
    });
  });

  it("trend zero-fills every day in range", async () => {
    const { trend } = await overviewData(JUNE, pool);
    expect(trend).toEqual([
      { day: "2026-06-01", cents: 15_000 },
      { day: "2026-06-02", cents: 11_000 },
      { day: "2026-06-03", cents: 0 },
      { day: "2026-06-04", cents: 0 },
    ]);
  });

  it("by vendor, ordered by spend, with the visible unassigned bucket", async () => {
    const { byVendor } = await overviewData(JUNE, pool);
    expect(byVendor).toEqual([
      {
        vendor: "anthropic",
        totalCents: 12_500,
        estimatedCents: 12_500,
        invoicedCents: 0,
        unassignedCents: 0,
        factCount: 2,
      },
      {
        vendor: "openai",
        totalCents: 7_000,
        estimatedCents: 7_000,
        invoicedCents: 0,
        unassignedCents: 0,
        factCount: 2,
      },
      {
        vendor: "acme",
        totalCents: 5_000,
        estimatedCents: 5_000,
        invoicedCents: 0,
        unassignedCents: 0,
        factCount: 1,
      },
      {
        vendor: "cursor",
        totalCents: 1_500,
        estimatedCents: 1_500,
        invoicedCents: 0,
        unassignedCents: 1_500,
        factCount: 1,
      },
    ]);
  });

  it("top people includes Unassigned but never product-routed spend", async () => {
    const { topPeople } = await overviewData(JUNE, pool);
    expect(topPeople).toEqual([
      { personId: dana, name: "Dana Roth", email: "dana@acme.com", cents: 12_500, factCount: 2 },
      { personId: omer, name: "Omer Lev", email: "omer@acme.com", cents: 10_000, factCount: 2 },
      { personId: null, name: null, email: null, cents: 1_500, factCount: 1 },
    ]);
  });

  it("top products carry spend and live outcomes in range", async () => {
    const { topProducts } = await overviewData(JUNE, pool);
    expect(topProducts).toEqual([
      {
        productId: supportbot,
        name: "supportbot",
        archived: false,
        cents: 2_000,
        factCount: 1,
        outcomeCount: 2,
      },
    ]);
  });

  it("drift badge sums the invoice adjustments for the range's months", async () => {
    const june = await overviewData(JUNE, pool);
    expect(june.drift).toEqual({ cents: 0, invoiceCount: 0 });

    const mayJune = await overviewData(MAY_JUNE, pool);
    expect(mayJune.drift).toEqual({ cents: 2_001, invoiceCount: 1 });
    // The adjustment shows up as invoiced spend and drills to the invoice.
    expect(mayJune.totals.estimatedCents).toBe(35_999);
    expect(mayJune.totals.invoicedCents).toBe(2_001);
    const drill = await listFacts({ ...MAY_JUNE, basis: "invoiced" }, pool);
    expect(drill.totalDisplayCents).toBe(2_001);
    expect(drill.rows).toHaveLength(1);
    expect(drill.rows[0].sourceRef).toMatch(/^invoice:/);
    expect(drill.rows[0].day).toBe("2026-05-31");
  });

  it("every tile number equals the sum of its drill-down rows", async () => {
    const data = await overviewData(JUNE, pool);

    const all = await listFacts(JUNE, pool);
    expect(all.totalDisplayCents).toBe(data.totals.totalCents);
    expect(all.totalCount).toBe(data.totals.factCount);

    for (const vendor of data.byVendor) {
      const drill = await listFacts({ ...JUNE, vendor: vendor.vendor }, pool);
      expect(drill.totalDisplayCents).toBe(vendor.totalCents);
      expect(drill.totalCount).toBe(vendor.factCount);
    }
    for (const person of data.topPeople) {
      const drill = await listFacts(
        person.personId
          ? { ...JUNE, person: person.personId }
          : { ...JUNE, person: "unassigned", product: "none" },
        pool,
      );
      expect(drill.totalDisplayCents).toBe(person.cents);
    }
    for (const product of data.topProducts) {
      const drill = await listFacts({ ...JUNE, product: product.productId }, pool);
      expect(drill.totalDisplayCents).toBe(product.cents);
    }
    for (const point of data.trend) {
      const drill = await listFacts({ day: point.day }, pool);
      expect(drill.totalDisplayCents).toBe(point.cents);
    }
    // Coverage remainder = the unassigned drill.
    const unassigned = await listFacts(
      { ...JUNE, person: "unassigned", product: "none" },
      pool,
    );
    expect(unassigned.totalDisplayCents).toBe(data.totals.unassignedCents);
  });

  it("drill rows show the original billed amount and the vendor source_ref", async () => {
    const { rows } = await listFacts({ ...JUNE, vendor: "acme" }, pool);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      day: "2026-06-02",
      vendor: "acme",
      amountCents: 4_000,
      currency: "EUR",
      displayCents: 5_000,
      costBasis: "estimated",
      sourceRef: "x1",
      personEmail: "omer@acme.com",
      productId: null,
    });
    const tokens = await listFacts({ day: "2026-06-01", vendor: "anthropic" }, pool);
    expect(tokens.rows[0].tokens).toBe(1234);
    expect(tokens.totalTokens).toBe(1234);
  });

  it("paging caps rows but totals always cover the whole filter", async () => {
    const page = await listFacts({ ...JUNE, limit: 2 }, pool);
    expect(page.rows).toHaveLength(2);
    expect(page.totalCount).toBe(6);
    expect(page.totalDisplayCents).toBe(26_000);
    // Newest first.
    expect(page.rows[0].day).toBe("2026-06-02");
    const rest = await listFacts({ ...JUNE, limit: 2, offset: 4 }, pool);
    expect(rest.rows).toHaveLength(2);
    expect(rest.rows[1].day).toBe("2026-06-01");
  });

  it("display currency converts tiles and drills identically (read-time)", async () => {
    await setSetting("display_currency", "EUR", pool);
    try {
      const data = await overviewData(JUNE, pool);
      expect(data.displayCurrency).toBe("EUR");
      expect(data.totals.totalCents).toBe(20_800); // 26,000 USD / 1.25
      const drill = await listFacts(JUNE, pool);
      expect(drill.totalDisplayCents).toBe(20_800);
      // The EUR fact converts back to exactly what was billed.
      const acme = await listFacts({ ...JUNE, vendor: "acme" }, pool);
      expect(acme.rows[0].displayCents).toBe(4_000);
      expect(acme.rows[0].amountCents).toBe(4_000);
    } finally {
      await setSetting("display_currency", "USD", pool);
    }
  });

  it("rejects bad ranges and bad filters loudly", async () => {
    await expect(overviewData({ from: "junk", to: "2026-06-02" }, pool)).rejects.toThrow(
      /from must be/,
    );
    await expect(
      overviewData({ from: "2026-06-05", to: "2026-06-01" }, pool),
    ).rejects.toThrow(/after/);
    await expect(listFacts({ day: "06-01-2026" }, pool)).rejects.toThrow(/day must be/);
  });

  it("lists sync runs newest-first with the vendor's error verbatim", async () => {
    await pool.query(
      `INSERT INTO sync_runs (connector, status, rows_synced, started_at, finished_at) VALUES
         ('anthropic', 'success', 12, '2026-06-01T01:00:00Z', '2026-06-01T01:01:00Z'),
         ('openai', 'success', 7, '2026-06-01T02:00:00Z', '2026-06-01T02:01:00Z')`,
    );
    await pool.query(
      `INSERT INTO sync_runs (connector, status, rows_synced, error, started_at)
       VALUES ('anthropic', 'error', 0,
               'invalid x-api-key: This key has been disabled', '2026-06-02T01:00:00Z')`,
    );

    const all = await listSyncRuns({}, pool);
    expect(all.map((r) => [r.connector, r.status])).toEqual([
      ["anthropic", "error"],
      ["openai", "success"],
      ["anthropic", "success"],
    ]);
    expect(all[0].error).toBe("invalid x-api-key: This key has been disabled");

    const anthropic = await listSyncRuns({ vendor: "anthropic" }, pool);
    expect(anthropic).toHaveLength(2);
    expect(anthropic.every((r) => r.connector === "anthropic")).toBe(true);
  });

  it("search finds people, products, and vendors - registry and data alike", async () => {
    const byName = await searchEverything("dan", pool);
    expect(byName.people.map((p) => p.email)).toEqual(["dana@acme.com"]);

    const byEmail = await searchEverything("OMER@", pool);
    expect(byEmail.people.map((p) => p.email)).toEqual(["omer@acme.com"]);

    const product = await searchEverything("support", pool);
    expect(product.products.map((p) => p.name)).toEqual(["supportbot"]);

    const registryVendor = await searchEverything("anthro", pool);
    expect(registryVendor.vendors.map((v) => v.vendor)).toEqual(["anthropic"]);
    expect(registryVendor.vendors[0].connected).toBe(false);

    // "acme" only exists as spend data - found via the rollups.
    const dataVendor = await searchEverything("acme", pool);
    expect(dataVendor.vendors.map((v) => v.vendor)).toContain("acme");
    expect(dataVendor.people).toHaveLength(2); // matched by email domain
  });

  it("search escapes LIKE wildcards instead of matching everything", async () => {
    const percent = await searchEverything("100%", pool);
    expect(percent.people).toEqual([]);
    expect(percent.products).toEqual([]);
    const underscore = await searchEverything("_", pool);
    expect(underscore.people).toEqual([]);
  });

  it("search skips merged people - history lives on the survivor", async () => {
    await pool.query("UPDATE people SET merged_into = $1 WHERE id = $2", [dana, omer]);
    const result = await searchEverything("omer", pool);
    expect(result.people).toEqual([]);
  });
});
