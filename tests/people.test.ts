import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listFacts, listOutcomes } from "../src/lib/overview";
import { keyDetail, listPeople, personDetail } from "../src/lib/people";
import { recomputeRollups } from "../src/lib/rollup";
import { setSetting } from "../src/lib/settings";
import { runMigrations } from "../scripts/migrate.mjs";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

/**
 * People page readers (spec 10 page 2), driven through the real pipeline:
 * people/identities/products -> spend_facts/outcomes -> recomputeRollups ->
 * listPeople/personDetail/keyDetail - and the dashboard invariant: every
 * displayed number equals the raw rows its drill filter returns.
 *
 * Fixture (USD display, EUR rate 1.25 USD per EUR), June range 06-01..06-04:
 *   dana   key k1 (anthropic api_key "dana-coding" + manual tag)
 *          05-20  9,999 USD sonnet (outside range, all-time/key history)
 *          06-01 10,000 USD sonnet · 06-02 2,500 USD haiku
 *          seat k2 (cursor): 06-02 800 USD, no model
 *          06-02 1,200 USD openai carrying product supportbot (SDK-style)
 *          outcomes: 2 live ticket_resolved + 1 reverted (supportbot)
 *   omer   key k3 (openai): 06-01 5,000 USD gpt · 06-03 4,000 EUR acme
 *          1 live ticket_resolved
 *   noa    ARCHIVED: 06-02 7,777 USD anthropic - hidden from the list,
 *          intact in drills and personDetail
 *   lior   roster only, no spend
 *   devin  agent key k4 (not a person, routed to product devin via its tag):
 *          06-02 3,000 USD - product spend, belongs to no person view
 *   unassigned: 06-02 1,500 USD cursor (no person, no product)
 *   supportbot also has person-less spend (2,000 USD) and a count=5 manual
 *   outcome row - neither may leak into any person's numbers.
 */

const JUNE = { from: "2026-06-01", to: "2026-06-04" };

describe.runIf(TEST_DATABASE_URL)("people page readers", () => {
  let dbUrl: string;
  let pool: Pool;
  let dana: string;
  let omer: string;
  let noa: string;
  let supportbot: string;
  let devinProduct: string;
  let k1: string;
  let k2: string;
  let k3: string;
  let k4: string;

  async function fact(
    day: string,
    personId: string | null,
    productId: string | null,
    identityId: string | null,
    vendor: string,
    model: string | null,
    amountCents: number,
    currency: string,
    sourceRef: string,
    tokens = 0,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO spend_facts
         (day, person_id, product_id, identity_id, vendor, model, tokens,
          amount_cents, currency, cost_basis, source_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'estimated', $10)`,
      [day, personId, productId, identityId, vendor, model, tokens, amountCents, currency, sourceRef],
    );
  }

  async function identity(
    personId: string | null,
    vendor: string,
    externalId: string,
    kind: string,
    opts: {
      tags?: string[];
      manualTags?: string[];
      displayName?: string;
      notPerson?: boolean;
      productId?: string;
    } = {},
  ): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO identities
         (person_id, vendor, external_id, kind, tags, manual_tags,
          display_name, not_person, product_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        personId,
        vendor,
        externalId,
        kind,
        opts.tags ?? [],
        opts.manualTags ?? [],
        opts.displayName ?? null,
        opts.notPerson ?? false,
        opts.productId ?? null,
      ],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    dbUrl = await createScratchDb("people_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 3 });

    await pool.query(
      "INSERT INTO fx_rates (day, currency, usd_rate) VALUES ('2026-05-01', 'EUR', 1.25)",
    );
    const { rows: people } = await pool.query(
      `INSERT INTO people (email, name, status) VALUES
         ('dana@acme.com', 'Dana Roth', 'active'),
         ('omer@acme.com', 'Omer Lev', 'active'),
         ('noa@acme.com', 'Noa Bar', 'archived'),
         ('lior@acme.com', 'Lior Gal', 'active')
       RETURNING id`,
    );
    [dana, omer, noa] = people.map((p) => p.id);
    const { rows: products } = await pool.query(
      `INSERT INTO products (name, attribution, outcome_kind) VALUES
         ('supportbot', 'sdk', 'sdk_event'), ('devin', 'key', 'none')
       RETURNING id`,
    );
    supportbot = products[0].id;
    devinProduct = products[1].id;

    k1 = await identity(dana, "anthropic", "key_dana", "api_key", {
      tags: ["dana-coding"],
      manualTags: ["experiments", "dana-coding"],
      displayName: "dana-coding",
    });
    k2 = await identity(dana, "cursor", "seat_dana", "seat");
    k3 = await identity(omer, "openai", "key_omer", "api_key", {
      tags: ["batch-processing"],
    });
    k4 = await identity(null, "anthropic", "key_devin", "api_key", {
      tags: ["devin"],
      notPerson: true,
      productId: devinProduct,
    });
    // Tag config (spec 7b): batch jobs excluded from personal usage, the
    // devin tag points at the devin product.
    await pool.query(
      `INSERT INTO tag_settings (tag, counts_personal, product_id) VALUES
         ('batch-processing', false, NULL), ('devin', true, $1)`,
      [devinProduct],
    );

    await fact("2026-05-20", dana, null, k1, "anthropic", "claude-sonnet-4", 9_999, "USD", "a0");
    await fact("2026-06-01", dana, null, k1, "anthropic", "claude-sonnet-4", 10_000, "USD", "a1", 1_000);
    await fact("2026-06-02", dana, null, k1, "anthropic", "claude-haiku-4", 2_500, "USD", "a2", 200);
    await fact("2026-06-02", dana, null, k2, "cursor", null, 800, "USD", "c-seat");
    await fact("2026-06-02", dana, supportbot, null, "openai", "gpt-5", 1_200, "USD", "s-dana");
    await fact("2026-06-01", omer, null, k3, "openai", "gpt-5", 5_000, "USD", "o1");
    await fact("2026-06-03", omer, null, null, "acme", null, 4_000, "EUR", "x1");
    await fact("2026-06-02", noa, null, null, "anthropic", null, 7_777, "USD", "n1");
    await fact("2026-06-02", null, devinProduct, k4, "anthropic", "claude-sonnet-4", 3_000, "USD", "d1");
    await fact("2026-06-02", null, supportbot, null, "openai", null, 2_000, "USD", "s-shared");
    await fact("2026-06-02", null, null, null, "cursor", null, 1_500, "USD", "u1");

    await pool.query(
      `INSERT INTO outcomes
         (ts, product_id, person_id, kind, count, value_cents, currency,
          source_ref, reverted_at, revert_source_ref)
       VALUES
         ('2026-06-02T10:00:00Z', $1, $2, 'ticket_resolved', 1, 450, 'USD', 't1', NULL, NULL),
         ('2026-06-02T11:00:00Z', $1, $2, 'ticket_resolved', 1, NULL, NULL, 't2', NULL, NULL),
         ('2026-06-03T09:00:00Z', $1, $2, 'ticket_resolved', 1, NULL, NULL, 't3',
          '2026-06-04T00:00:00Z', 'revert:t3'),
         ('2026-06-02T12:00:00Z', $1, $3, 'ticket_resolved', 1, NULL, NULL, 't4', NULL, NULL),
         ('2026-06-01T00:00:00Z', $1, NULL, 'manual', 5, NULL, NULL, 't5', NULL, NULL)`,
      [supportbot, dana, omer],
    );

    await recomputeRollups({}, pool);
  });

  afterAll(async () => {
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  it("lists people by spend with vendor split, outcomes, $/outcome, trend", async () => {
    const data = await listPeople(JUNE, pool);
    expect(data.displayCurrency).toBe("USD");
    expect(data.days).toEqual(["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"]);

    expect(data.people.map((p) => [p.email, p.totalCents])).toEqual([
      ["dana@acme.com", 14_500],
      ["omer@acme.com", 10_000],
      [null, 1_500], // the visible Unassigned bucket
      ["lior@acme.com", 0],
    ]);

    const [danaRow, omerRow, unassigned, liorRow] = data.people;
    expect(danaRow.byVendor).toEqual([
      { vendor: "anthropic", cents: 12_500, factCount: 2 },
      { vendor: "openai", cents: 1_200, factCount: 1 },
      { vendor: "cursor", cents: 800, factCount: 1 },
    ]);
    expect(danaRow.outcomeCount).toBe(2); // reverted t3 never counts
    expect(danaRow.unitCostCents).toBe(7_250);
    expect(danaRow.trend).toEqual([10_000, 4_500, 0, 0]);

    expect(omerRow.byVendor.map((v) => v.vendor)).toEqual(["acme", "openai"]);
    expect(omerRow.outcomeCount).toBe(1);
    expect(omerRow.unitCostCents).toBe(10_000);

    expect(unassigned.personId).toBeNull();
    expect(unassigned.byVendor).toEqual([
      { vendor: "cursor", cents: 1_500, factCount: 1 },
    ]);
    expect(unassigned.outcomeCount).toBe(0);
    expect(unassigned.unitCostCents).toBeNull();

    expect(liorRow.byVendor).toEqual([]);
    expect(liorRow.trend).toEqual([0, 0, 0, 0]);
  });

  it("hides archived people from the list but keeps their history intact", async () => {
    const data = await listPeople(JUNE, pool);
    expect(data.people.some((p) => p.email === "noa@acme.com")).toBe(false);
    // Her spend is in no list row...
    const listed = data.people.reduce((sum, p) => sum + p.totalCents, 0);
    expect(listed).toBe(26_000); // 14,500 + 10,000 + 1,500 + 0 - no 7,777
    // ...but the raw facts still exist, attributed and drillable.
    const drill = await listFacts({ ...JUNE, person: noa }, pool);
    expect(drill.totalDisplayCents).toBe(7_777);
    expect(drill.rows[0].personEmail).toBe("noa@acme.com");
    // And the person page still answers - history, not a current view.
    const detail = await personDetail(noa, JUNE, pool);
    expect(detail.person.status).toBe("archived");
    expect(detail.totals.cents).toBe(7_777);
  });

  it("keeps product-routed agent spend out of every person row", async () => {
    const data = await listPeople(JUNE, pool);
    for (const row of data.people) {
      for (const v of row.byVendor) {
        // devin's 3,000 anthropic spend appears under no person and not in
        // the Unassigned bucket (it has a product - spec 7b).
        if (row.personId === null) expect(v.vendor).not.toBe("anthropic");
      }
    }
    const unassigned = data.people.find((p) => p.personId === null)!;
    expect(unassigned.totalCents).toBe(1_500);
  });

  it("every list number equals the sum of its drill-down rows", async () => {
    const data = await listPeople(JUNE, pool);
    for (const row of data.people) {
      const filter =
        row.personId === null
          ? { ...JUNE, person: "unassigned", product: "none" }
          : { ...JUNE, person: row.personId };
      const drill = await listFacts(filter, pool);
      expect(drill.totalDisplayCents).toBe(row.totalCents);
      expect(drill.totalCount).toBe(row.factCount);

      for (const v of row.byVendor) {
        const vendorDrill = await listFacts({ ...filter, vendor: v.vendor }, pool);
        expect(vendorDrill.totalDisplayCents).toBe(v.cents);
        expect(vendorDrill.totalCount).toBe(v.factCount);
      }
      for (const [i, cents] of row.trend.entries()) {
        const dayDrill = await listFacts({ ...filter, day: data.days[i] }, pool);
        expect(dayDrill.totalDisplayCents).toBe(cents);
      }
      if (row.personId !== null) {
        const outcomes = await listOutcomes({ ...JUNE, person: row.personId }, pool);
        expect(outcomes.liveCount).toBe(row.outcomeCount);
      }
    }
  });

  it("person detail: totals, vendor split, trend, daily breakdown - all drillable", async () => {
    const detail = await personDetail(dana, JUNE, pool);
    expect(detail.person).toMatchObject({
      id: dana,
      email: "dana@acme.com",
      name: "Dana Roth",
      status: "active",
    });
    expect(detail.totals).toEqual({
      cents: 14_500,
      factCount: 4,
      outcomeCount: 2,
      revertedCount: 1,
      unitCostCents: 7_250,
    });
    expect(detail.byVendor).toEqual([
      { vendor: "anthropic", cents: 12_500, factCount: 2 },
      { vendor: "openai", cents: 1_200, factCount: 1 },
      { vendor: "cursor", cents: 800, factCount: 1 },
    ]);
    expect(detail.trend).toEqual([
      { day: "2026-06-01", cents: 10_000 },
      { day: "2026-06-02", cents: 4_500 },
      { day: "2026-06-03", cents: 0 },
      { day: "2026-06-04", cents: 0 },
    ]);
    // Daily breakdown: newest day first, per vendor, summing to the total.
    expect(detail.daily).toEqual([
      { day: "2026-06-02", vendor: "anthropic", cents: 2_500, factCount: 1, tokens: 200 },
      { day: "2026-06-02", vendor: "cursor", cents: 800, factCount: 1, tokens: 0 },
      { day: "2026-06-02", vendor: "openai", cents: 1_200, factCount: 1, tokens: 0 },
      { day: "2026-06-01", vendor: "anthropic", cents: 10_000, factCount: 1, tokens: 1_000 },
    ]);
    for (const row of detail.daily) {
      const drill = await listFacts(
        { person: dana, day: row.day, vendor: row.vendor },
        pool,
      );
      expect(drill.totalDisplayCents).toBe(row.cents);
      expect(drill.totalCount).toBe(row.factCount);
    }
    expect(detail.outcomesByKind).toEqual([{ kind: "ticket_resolved", count: 2 }]);
  });

  it("person detail: keys and seats with tags, range spend, all-time last use", async () => {
    const detail = await personDetail(dana, JUNE, pool);
    expect(detail.keys.map((k) => k.id)).toEqual([k1, k2]); // vendor order
    const [key1, key2] = detail.keys;
    expect(key1).toMatchObject({
      vendor: "anthropic",
      externalId: "key_dana",
      kind: "api_key",
      displayName: "dana-coding",
      cents: 12_500, // range-bounded: the May fact stays out
      factCount: 2,
      lastUsedDay: "2026-06-02",
    });
    expect(key1.tags).toEqual(["dana-coding", "experiments"]); // deduped
    expect(key2).toMatchObject({
      vendor: "cursor",
      kind: "seat",
      cents: 800,
      lastUsedDay: "2026-06-02",
    });
    // The key number IS its drill: /drill?key= over the same range.
    for (const key of detail.keys) {
      const drill = await listFacts({ ...JUNE, key: key.id }, pool);
      expect(drill.totalDisplayCents).toBe(key.cents);
      expect(drill.totalCount).toBe(key.factCount);
    }
  });

  it("person detail: products this person's spend and outcomes touch", async () => {
    const detail = await personDetail(dana, JUNE, pool);
    expect(detail.products).toEqual([
      {
        productId: supportbot,
        name: "supportbot",
        archived: false,
        cents: 1_200,
        factCount: 1,
        outcomeCount: 2, // dana's live outcomes only - not omer's, not t5
      },
    ]);
    const drill = await listFacts({ ...JUNE, person: dana, product: supportbot }, pool);
    expect(drill.totalDisplayCents).toBe(1_200);
    const outcomes = await listOutcomes(
      { ...JUNE, person: dana, product: supportbot },
      pool,
    );
    expect(outcomes.liveCount).toBe(2);
  });

  it("follows a merge to the surviving person", async () => {
    const { rows } = await pool.query(
      `INSERT INTO people (email, name, status, merged_into)
       VALUES ('dana.old@acme.com', 'Dana (old)', 'archived', $1) RETURNING id`,
      [dana],
    );
    const detail = await personDetail(rows[0].id, JUNE, pool);
    expect(detail.person.id).toBe(dana);
    expect(detail.person.email).toBe("dana@acme.com");
  });

  it("rejects unknown people and bad ranges loudly", async () => {
    await expect(
      personDetail("00000000-0000-4000-8000-000000000000", JUNE, pool),
    ).rejects.toThrow(/person not found/);
    await expect(
      listPeople({ from: "junk", to: "2026-06-02" }, pool),
    ).rejects.toThrow(/from must be/);
    await expect(
      personDetail(dana, { from: "2026-06-05", to: "2026-06-01" }, pool),
    ).rejects.toThrow(/after/);
  });

  it("key detail: tags say what it's for, owner, models, last used - drillable", async () => {
    const detail = await keyDetail(k1, pool);
    expect(detail.key).toMatchObject({
      vendor: "anthropic",
      externalId: "key_dana",
      kind: "api_key",
      displayName: "dana-coding",
      notPerson: false,
    });
    expect(detail.owner).toMatchObject({ id: dana, email: "dana@acme.com" });
    expect(detail.product).toBeNull();
    expect(detail.tags).toEqual([
      {
        tag: "dana-coding",
        source: "vendor",
        productId: null,
        productName: null,
        countsPersonal: true,
      },
      {
        tag: "experiments",
        source: "manual",
        productId: null,
        productName: null,
        countsPersonal: true,
      },
    ]);
    // All-time: May + June facts, grouped by model, spend-descending.
    expect(detail.totalCents).toBe(22_499);
    expect(detail.factCount).toBe(3);
    expect(detail.firstUsedDay).toBe("2026-05-20");
    expect(detail.lastUsedDay).toBe("2026-06-02");
    expect(detail.models).toEqual([
      {
        model: "claude-sonnet-4",
        cents: 19_999,
        factCount: 2,
        tokens: 1_000,
        lastDay: "2026-06-01",
      },
      {
        model: "claude-haiku-4",
        cents: 2_500,
        factCount: 1,
        tokens: 200,
        lastDay: "2026-06-02",
      },
    ]);
    // Every model row sums to its drill (/drill?key=&model=), and the key
    // total to the unfiltered key drill - over the key's full span.
    const all = await listFacts({ key: k1 }, pool);
    expect(all.totalDisplayCents).toBe(detail.totalCents);
    expect(all.totalCount).toBe(detail.factCount);
    for (const model of detail.models) {
      const drill = await listFacts({ key: k1, model: model.model ?? "none" }, pool);
      expect(drill.totalDisplayCents).toBe(model.cents);
      expect(drill.totalCount).toBe(model.factCount);
    }
  });

  it("key detail: seat with no model, agent key routed to its product", async () => {
    const seat = await keyDetail(k2, pool);
    expect(seat.models).toEqual([
      { model: null, cents: 800, factCount: 1, tokens: 0, lastDay: "2026-06-02" },
    ]);
    const noModel = await listFacts({ key: k2, model: "none" }, pool);
    expect(noModel.totalDisplayCents).toBe(800);

    const agent = await keyDetail(k4, pool);
    expect(agent.key.notPerson).toBe(true);
    expect(agent.owner).toBeNull();
    expect(agent.product).toMatchObject({ id: devinProduct, name: "devin" });
    expect(agent.tags).toEqual([
      {
        tag: "devin",
        source: "vendor",
        productId: devinProduct,
        productName: "devin",
        countsPersonal: true,
      },
    ]);

    const batch = await keyDetail(k3, pool);
    expect(batch.tags[0]).toMatchObject({
      tag: "batch-processing",
      countsPersonal: false,
    });

    await expect(
      keyDetail("00000000-0000-4000-8000-000000000000", pool),
    ).rejects.toThrow(/key not found/);
  });

  it("outcome drill: count-aware totals, live/reverted split, filters", async () => {
    const danaOutcomes = await listOutcomes({ ...JUNE, person: dana }, pool);
    expect(danaOutcomes.totalCount).toBe(3);
    expect(danaOutcomes.liveCount).toBe(2);
    expect(danaOutcomes.revertedCount).toBe(1);
    // Newest first; the reverted row points at the reverting record.
    expect(danaOutcomes.rows[0]).toMatchObject({
      sourceRef: "t3",
      revertSourceRef: "revert:t3",
    });
    expect(danaOutcomes.rows[0].revertedAt).not.toBeNull();
    expect(danaOutcomes.rows[2]).toMatchObject({
      sourceRef: "t1",
      valueCents: 450,
      currency: "USD",
      personEmail: "dana@acme.com",
      productName: "supportbot",
    });

    // Count-aware: the manual row counts 5 outcomes as one drillable row.
    const product = await listOutcomes({ ...JUNE, product: supportbot }, pool);
    expect(product.totalCount).toBe(9); // 4 single + 1 row counting 5
    expect(product.liveCount).toBe(8);

    const unassigned = await listOutcomes({ ...JUNE, person: "unassigned" }, pool);
    expect(unassigned.rows.map((r) => r.sourceRef)).toEqual(["t5"]);
    expect(unassigned.liveCount).toBe(5);

    const byKind = await listOutcomes({ ...JUNE, kind: "manual" }, pool);
    expect(byKind.rows).toHaveLength(1);

    const paged = await listOutcomes({ ...JUNE, limit: 2, offset: 0 }, pool);
    expect(paged.rows).toHaveLength(2);
    expect(paged.totalCount).toBe(9); // totals always cover the whole filter

    await expect(listOutcomes({ from: "junk" }, pool)).rejects.toThrow(/from must be/);
  });

  it("display currency converts list and drills identically", async () => {
    await setSetting("display_currency", "EUR", pool);
    try {
      const data = await listPeople(JUNE, pool);
      expect(data.displayCurrency).toBe("EUR");
      const danaRow = data.people[0];
      expect(danaRow.totalCents).toBe(11_600); // 14,500 USD / 1.25
      const drill = await listFacts({ ...JUNE, person: dana }, pool);
      expect(drill.totalDisplayCents).toBe(11_600);

      const detail = await personDetail(omer, JUNE, pool);
      // The EUR fact converts back to exactly what was billed.
      expect(detail.byVendor.find((v) => v.vendor === "acme")!.cents).toBe(4_000);
    } finally {
      await setSetting("display_currency", "USD", pool);
    }
  });

  it("a display currency with no FX rate aborts - no fake numbers", async () => {
    await setSetting("display_currency", "GBP", pool);
    try {
      await expect(listPeople(JUNE, pool)).rejects.toThrow(/no FX rate/);
      await expect(personDetail(dana, JUNE, pool)).rejects.toThrow(/no FX rate/);
      await expect(keyDetail(k1, pool)).rejects.toThrow(/no FX rate/);
    } finally {
      await setSetting("display_currency", "USD", pool);
    }
  });
});
