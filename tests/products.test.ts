import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as productRoute, PATCH as productPatchRoute } from "../src/app/api/products/[id]/route";
import { PUT as manualPutRoute } from "../src/app/api/products/[id]/manual/route";
import { GET as productsRoute, POST as productsPostRoute } from "../src/app/api/products/route";
import { GET as productsViewRoute } from "../src/app/api/products/view/route";
import { PATCH as tagPatchRoute } from "../src/app/api/tags/[tag]/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { connectConnector } from "../src/lib/connectors/connect";
import { clearConnectors, registerConnector } from "../src/lib/connectors/registry";
import { runSync } from "../src/lib/connectors/sync";
import { closePool } from "../src/lib/db";
import { listFacts, listOutcomes } from "../src/lib/overview";
import { recomputeRollups } from "../src/lib/rollup";
import { clearSecretKeyCache } from "../src/lib/secrets";
import { runMigrations } from "../scripts/migrate.mjs";
import { makeAcmeConnector } from "./helpers/fixture-connector";
import { getJson, patchJson, postJson, putJson } from "./helpers/http";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";
import { replayFile } from "./helpers/replay";

/**
 * Products = cost centers (spec section 7), driven through the real
 * production path: CRUD via the API, vendor spend reaching a product through
 * a recorded sync + tag routing, manual monthly entries for tools with no
 * API (materialized into the ledger, marked manual, drilling to the entry),
 * the default value per outcome applied at read time with per-entry
 * override, unit cost = spend / outcomes over the selected range, and
 * archive-not-delete semantics.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const FIXTURES = path.resolve(__dirname, "fixtures", "connectors", "products");
const CONNECT_OK = path.resolve(
  __dirname, "fixtures", "connectors", "acme", "connect-ok.json",
);

/** Pinned clock: recordings are recorded against "today" = 2026-06-11. */
const NOW = new Date("2026-06-11T12:00:00Z");

const VENDOR = "acme_p";
const GHOST = "00000000-0000-4000-8000-000000000000";

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function tagParams(tag: string) {
  return { params: Promise.resolve({ tag }) };
}

describe.runIf(TEST_DATABASE_URL)("products (spec 7)", () => {
  let dbUrl: string;
  let pool: Pool;
  let dataDir: string;
  let adminCookie: string;
  let viewerCookie: string;
  let supportBotId: string;
  let brainId: string;
  let mayEntryId: string;
  let brainEntryId: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("products_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 5 });
    dataDir = mkdtempSync(path.join(os.tmpdir(), "ai-pnl-products-"));
    clearConnectors();
    registerConnector(makeAcmeConnector(VENDOR));

    await pool.query(
      "INSERT INTO people (email, name, source) VALUES ('dana@acme.com', 'Dana', 'csv')",
    );

    const { rows: admins } = await pool.query(
      "INSERT INTO users (name, role) VALUES ('Admin', 'admin') RETURNING id",
    );
    adminCookie = `${SESSION_COOKIE}=${(await createSession(admins[0].id, pool)).token}`;
    const { rows: viewers } = await pool.query(
      "INSERT INTO users (name, role) VALUES ('Viewer', 'viewer') RETURNING id",
    );
    viewerCookie = `${SESSION_COOKIE}=${(await createSession(viewers[0].id, pool)).token}`;

    await connectConnector(VENDOR, { apiKey: "acme_sk_test_123" }, {
      db: pool,
      fetch: replayFile(CONNECT_OK).fetch,
      dataDir,
    });
  });

  afterAll(async () => {
    await closePool();
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
    clearConnectors();
    clearSecretKeyCache();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  async function detail(id: string, query = "", cookie = viewerCookie) {
    const res = await productRoute(
      getJson(`/api/products/${id}${query}`, cookie),
      idParams(id),
    );
    expect(res.status).toBe(200);
    return res.json();
  }

  it("an admin creates products; bad input is rejected with the precise reason", async () => {
    const created = await productsPostRoute(
      postJson(
        "/api/products",
        {
          name: "Support Bot",
          attribution: "key",
          outcomeKind: "manual",
          defaultValueCents: 450,
          defaultValueCurrency: "USD",
        },
        adminCookie,
      ),
    );
    expect(created.status).toBe(201);
    const { product: supportBot } = await created.json();
    expect(supportBot).toMatchObject({
      name: "Support Bot",
      attribution: "key",
      outcomeKind: "manual",
      defaultValueCents: 450,
      defaultValueCurrency: "USD",
      archivedAt: null,
    });
    supportBotId = supportBot.id;

    const brain = await productsPostRoute(
      postJson(
        "/api/products",
        { name: "Company Brain", attribution: "manual" },
        adminCookie,
      ),
    );
    expect(brain.status).toBe(201);
    const brainBody = await brain.json();
    expect(brainBody.product).toMatchObject({
      outcomeKind: "none",
      defaultValueCents: null,
      defaultValueCurrency: null,
    });
    brainId = brainBody.product.id;

    // Names are unique, case-insensitively.
    const dup = await productsPostRoute(
      postJson("/api/products", { name: "support bot", attribution: "sdk" }, adminCookie),
    );
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toBe("an ROI with that name already exists");

    for (const [body, error] of [
      [{ attribution: "key" }, "name required (1-80 characters)"],
      [{ name: "X", attribution: "proxy" }, "attribution must be one of connector, key, sdk, manual"],
      [{ name: "X", attribution: "key", outcomeKind: "vibes" }, "outcomeKind must be one of none, github_pr, issue_done, sdk_event, manual"],
      [{ name: "X", attribution: "key", defaultValueCents: 450 }, "defaultValueCurrency must be a 3-letter code (e.g. USD)"],
      [{ name: "X", attribution: "key", defaultValueCents: -1, defaultValueCurrency: "USD" }, "defaultValueCents must be a non-negative integer"],
      [{ name: "X", attribution: "key", defaultValueCents: 4.5, defaultValueCurrency: "USD" }, "defaultValueCents must be a non-negative integer"],
    ] as const) {
      const res = await productsPostRoute(postJson("/api/products", body, adminCookie));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(error);
    }
  });

  it("lists products for any session, alphabetically, with rollup-backed totals", async () => {
    const res = await productsRoute(getJson("/api/products", viewerCookie));
    expect(res.status).toBe(200);
    const { products } = await res.json();
    expect(products.map((p: { name: string }) => p.name)).toEqual([
      "Company Brain",
      "Support Bot",
    ]);
    expect(products[1]).toMatchObject({ spendUsdCents: 0, outcomeCount: 0 });
  });

  it("key spend reaches the product through its tag - and drills to the vendor rows", async () => {
    const session = replayFile(path.join(FIXTURES, "backfill.json"));
    const sync = await runSync(VENDOR, { pool, fetch: session.fetch, now: NOW, dataDir });
    expect(sync.status).toBe("success");
    expect(session.remaining()).toHaveLength(0);

    const routed = await tagPatchRoute(
      patchJson("/api/tags/support-bot", { productId: supportBotId }, adminCookie),
      tagParams("support-bot"),
    );
    expect(routed.status).toBe(200);
    expect(await routed.json()).toMatchObject({ routedIdentities: 1, facts: 2 });

    const body = await detail(supportBotId);
    expect(body.displayCurrency).toBe("USD");
    expect(body.metrics).toEqual({
      spendCents: 5000,
      spendByBasis: { estimated: 5000, invoiced: 0, manual: 0 },
      factCount: 2,
      outcomes: 0,
      valuedOutcomes: 0,
      revertedOutcomes: 0,
      unitCostCents: null,
      unit: "outcome",
      valueCents: null,
      roi: null,
      activeUsers: 0,
      costPerUserCents: null,
    });
    expect(body.byVendor).toEqual([{ vendor: VENDOR, cents: 5000, factCount: 2 }]);
    // Routed spend is person-less: the visible "No person" row, never hidden.
    expect(body.byPerson).toEqual([
      {
        personId: null,
        name: null,
        email: null,
        cents: 5000,
        factCount: 2,
        outcomeCount: 0,
      },
    ]);
    // The key that routes here, with its all-time last use.
    expect(body.keys).toEqual([
      expect.objectContaining({
        vendor: VENDOR,
        externalId: "key_sb",
        cents: 5000,
        factCount: 2,
        lastUsedDay: "2026-06-02",
      }),
    ]);
    // The drill-down behind the number (/drill?product=): exactly the
    // vendor rows, newest first - Dana's own (non-product) usage absent.
    const drill = await listFacts({ product: supportBotId }, pool);
    expect(drill.rows.map((f) => f.sourceRef)).toEqual(["p_sb_2", "p_sb_1"]);
    expect(drill.totalDisplayCents).toBe(body.metrics.spendCents);
    expect(drill.totalCount).toBe(body.metrics.factCount);
  });

  it("manual outcomes: the product's default value applies; an entry value overrides it", async () => {
    const may = await manualPutRoute(
      putJson(
        `/api/products/${supportBotId}/manual`,
        { kind: "outcomes", month: "2026-05", count: 40 },
        adminCookie,
      ),
      idParams(supportBotId),
    );
    expect(may.status).toBe(200);
    const mayBody = await may.json();
    expect(mayBody.entry).toMatchObject({
      kind: "outcomes",
      month: "2026-05",
      outcomeCount: 40,
      valueCents: null,
    });
    expect(mayBody.rollups).toEqual({ from: "2026-05-01", to: "2026-05-01" });
    mayEntryId = mayBody.entry.id;

    // 40 outcomes, none explicitly valued -> the 450c default covers them.
    let body = await detail(supportBotId);
    expect(body.metrics).toMatchObject({
      outcomes: 40,
      valuedOutcomes: 0,
      unitCostCents: 125, // 5000 / 40
      valueCents: 18000, // 40 x 450 default
      roi: 3.6,
    });

    const june = await manualPutRoute(
      putJson(
        `/api/products/${supportBotId}/manual`,
        { kind: "outcomes", month: "2026-06", count: 10, valueCents: 500, valueCurrency: "USD" },
        adminCookie,
      ),
      idParams(supportBotId),
    );
    expect(june.status).toBe(200);
    const juneEntryId = (await june.json()).entry.id;

    body = await detail(supportBotId);
    expect(body.metrics).toMatchObject({
      outcomes: 50,
      valuedOutcomes: 10,
      unitCostCents: 100, // 5000 / 50
      valueCents: 23000, // 40 x 450 default + 10 x 500 explicit
      roi: 4.6,
    });
    expect(body.outcomesByKind).toEqual([{ kind: "manual", count: 50 }]);
    // The drill-down (/drill?view=outcomes&product=): one row per entry,
    // count-carrying, pointing AT the entry (source_ref = the manual
    // entry's id), not at vendor rows.
    const drill = await listOutcomes({ product: supportBotId }, pool);
    expect(drill.liveCount).toBe(body.metrics.outcomes);
    expect(drill.rows).toEqual([
      expect.objectContaining({ ts: "2026-06-01T00:00:00.000Z", kind: "manual", count: 10, valueCents: 500, currency: "USD", sourceRef: juneEntryId, revertedAt: null }),
      expect.objectContaining({ ts: "2026-05-01T00:00:00.000Z", kind: "manual", count: 40, valueCents: null, currency: null, sourceRef: mayEntryId, revertedAt: null }),
    ]);
    expect(body.manualEntries.map((e: { id: string }) => e.id)).toEqual([
      juneEntryId,
      mayEntryId,
    ]);
  });

  it("changing the default value re-values history at read time; clearing it leaves explicit values only", async () => {
    const raise = await productPatchRoute(
      patchJson(`/api/products/${supportBotId}`, { defaultValueCents: 500, defaultValueCurrency: "USD" }, adminCookie),
      idParams(supportBotId),
    );
    expect(raise.status).toBe(200);
    expect((await detail(supportBotId)).metrics).toMatchObject({
      valueCents: 25000, // 40 x 500 + 10 x 500
      roi: 5,
    });

    const clear = await productPatchRoute(
      patchJson(`/api/products/${supportBotId}`, { defaultValueCents: null }, adminCookie),
      idParams(supportBotId),
    );
    expect(clear.status).toBe(200);
    expect((await clear.json()).product.defaultValueCents).toBeNull();
    // No default: only the 10 explicitly-valued outcomes carry value. The
    // 40 unvalued ones count toward unit cost but never invent value.
    expect((await detail(supportBotId)).metrics).toMatchObject({
      outcomes: 50,
      valuedOutcomes: 10,
      valueCents: 5000,
      roi: 1,
    });

    const restore = await productPatchRoute(
      patchJson(`/api/products/${supportBotId}`, { defaultValueCents: 450, defaultValueCurrency: "USD" }, adminCookie),
      idParams(supportBotId),
    );
    expect(restore.status).toBe(200);
  });

  it("unit cost = spend / outcomes over the SELECTED range", async () => {
    const range = { from: "2026-06-01", to: "2026-06-30" };
    const body = await detail(supportBotId, `?from=${range.from}&to=${range.to}`);
    expect(body.metrics).toMatchObject({
      spendCents: 2000,
      outcomes: 10,
      unitCostCents: 200, // 2000 / 10
      valueCents: 5000,
      roi: 2.5,
    });
    // The range-bounded drills agree exactly.
    const facts = await listFacts({ ...range, product: supportBotId }, pool);
    expect(facts.rows.map((f) => f.sourceRef)).toEqual(["p_sb_2"]);
    expect(facts.totalDisplayCents).toBe(body.metrics.spendCents);
    const outcomes = await listOutcomes({ ...range, product: supportBotId }, pool);
    expect(outcomes.rows).toHaveLength(1);
    expect(outcomes.liveCount).toBe(body.metrics.outcomes);
  });

  it("a correction rewrites the month in place - never a duplicate", async () => {
    const fixed = await manualPutRoute(
      putJson(
        `/api/products/${supportBotId}/manual`,
        { kind: "outcomes", month: "2026-05", count: 44 },
        adminCookie,
      ),
      idParams(supportBotId),
    );
    expect(fixed.status).toBe(200);
    // Same entry, restated - not a second one.
    expect((await fixed.json()).entry.id).toBe(mayEntryId);

    const body = await detail(supportBotId);
    expect(body.metrics).toMatchObject({
      outcomes: 54,
      unitCostCents: 93, // 5000 / 54
      valueCents: 24800, // 44 x 450 + 10 x 500
    });
    const drill = await listOutcomes({ product: supportBotId }, pool);
    const mayRows = drill.rows.filter((o) => o.sourceRef === mayEntryId);
    expect(mayRows).toEqual([expect.objectContaining({ count: 44 })]);
  });

  it("manual product: the monthly cost lands in the ledger marked manual and drills to the entry", async () => {
    const res = await manualPutRoute(
      putJson(
        `/api/products/${brainId}/manual`,
        { kind: "cost", month: "2026-05", amountCents: 20000, currency: "USD", note: "Company Brain subscription" },
        adminCookie,
      ),
      idParams(brainId),
    );
    expect(res.status).toBe(200);
    brainEntryId = (await res.json()).entry.id;

    let body = await detail(brainId);
    // Plain cost, no outcomes, no fake ROI (spec 7: the Company Brain
    // case) - and no outcome metric means no unit, never an invented one.
    expect(body.metrics).toEqual({
      spendCents: 20000,
      spendByBasis: { estimated: 0, invoiced: 0, manual: 20000 },
      factCount: 1,
      outcomes: 0,
      valuedOutcomes: 0,
      revertedOutcomes: 0,
      unitCostCents: null,
      unit: null,
      valueCents: null,
      roi: null,
      activeUsers: 0,
      costPerUserCents: null,
    });
    // Marked manual, drilling to the entry - not vendor rows.
    const drill = await listFacts({ product: brainId }, pool);
    expect(drill.rows).toEqual([
      expect.objectContaining({ day: "2026-05-01", vendor: "manual", model: null, tokens: 0, amountCents: 20000, currency: "USD", costBasis: "manual", sourceRef: brainEntryId, identityExternalId: null, personEmail: null }),
    ]);
    expect(body.manualEntries).toEqual([
      expect.objectContaining({
        id: brainEntryId,
        kind: "cost",
        month: "2026-05",
        amountCents: 20000,
        currency: "USD",
        note: "Company Brain subscription",
      }),
    ]);

    // The charts agree: the manual dollar is in the rollups, on the product.
    const { rows: rolled } = await pool.query(
      `SELECT vendor, cost_basis, person_id, amount_usd_cents::int AS cents
       FROM rollup_daily WHERE product_id = $1`,
      [brainId],
    );
    expect(rolled).toEqual([
      { vendor: "manual", cost_basis: "manual", person_id: null, cents: 20000 },
    ]);

    // A correction restates the same fact - one row, forever.
    const fixed = await manualPutRoute(
      putJson(
        `/api/products/${brainId}/manual`,
        { kind: "cost", month: "2026-05", amountCents: 25000, currency: "USD" },
        adminCookie,
      ),
      idParams(brainId),
    );
    expect(fixed.status).toBe(200);
    expect((await fixed.json()).entry.id).toBe(brainEntryId);
    body = await detail(brainId);
    expect(body.metrics.spendCents).toBe(25000);
    expect((await listFacts({ product: brainId }, pool)).totalCount).toBe(1);

    // And the list totals stay rollup-true.
    const list = await productsRoute(getJson("/api/products", viewerCookie));
    const { products } = await list.json();
    expect(products).toEqual([
      expect.objectContaining({ name: "Company Brain", spendUsdCents: 25000, outcomeCount: 0 }),
      expect.objectContaining({ name: "Support Bot", spendUsdCents: 5000, outcomeCount: 54 }),
    ]);
  });

  it("manual entries are refused where they don't belong", async () => {
    // Cost entries are for manual-attribution products only.
    const wrongCost = await manualPutRoute(
      putJson(
        `/api/products/${supportBotId}/manual`,
        { kind: "cost", month: "2026-05", amountCents: 100, currency: "USD" },
        adminCookie,
      ),
      idParams(supportBotId),
    );
    expect(wrongCost.status).toBe(409);
    expect((await wrongCost.json()).error).toBe(
      'manual cost entries need attribution "manual" (this product\'s spend comes from key)',
    );

    // Outcome entries are for outcome_kind = manual products only.
    const wrongOutcomes = await manualPutRoute(
      putJson(
        `/api/products/${brainId}/manual`,
        { kind: "outcomes", month: "2026-05", count: 5 },
        adminCookie,
      ),
      idParams(brainId),
    );
    expect(wrongOutcomes.status).toBe(409);
    expect((await wrongOutcomes.json()).error).toBe(
      'manual outcome entries need outcome_kind "manual" (this product\'s is none)',
    );

    // Money in a currency with no FX rate at all can never roll up:
    // rejected at the door, no fake numbers, no poisoned recomputes.
    const noRate = await manualPutRoute(
      putJson(
        `/api/products/${brainId}/manual`,
        { kind: "cost", month: "2026-05", amountCents: 100, currency: "EUR" },
        adminCookie,
      ),
      idParams(brainId),
    );
    expect(noRate.status).toBe(409);
    expect((await noRate.json()).error).toContain("no FX rate for EUR");
  });

  it("reverted outcomes never count toward unit cost or value", async () => {
    await pool.query(
      `INSERT INTO outcomes (ts, product_id, kind, count, source_ref, reverted_at, revert_source_ref)
       VALUES ('2026-06-03T00:00:00Z', $1, 'manual', 5, 'm_rev_1', '2026-06-04T00:00:00Z', 'rev_x')`,
      [supportBotId],
    );
    await recomputeRollups({ from: "2026-06-03", to: "2026-06-03" }, pool);

    const body = await detail(supportBotId);
    expect(body.metrics).toMatchObject({
      outcomes: 54,
      revertedOutcomes: 5,
      unitCostCents: 93,
      valueCents: 24800,
    });
    // Still visible in the drill-down, flagged.
    const drill = await listOutcomes({ product: supportBotId }, pool);
    const reverted = drill.rows.find((o) => o.sourceRef === "m_rev_1");
    expect(reverted).toMatchObject({ count: 5, revertedAt: "2026-06-04T00:00:00.000Z" });
    expect(drill.revertedCount).toBe(body.metrics.revertedOutcomes);
  });

  it("archive leaves current views; history and drill-downs stay intact", async () => {
    const archived = await productPatchRoute(
      patchJson(`/api/products/${brainId}`, { archived: true }, adminCookie),
      idParams(brainId),
    );
    expect(archived.status).toBe(200);
    expect((await archived.json()).product.archivedAt).not.toBeNull();

    // Gone from current views - the catalog AND the Products page...
    const list = await productsRoute(getJson("/api/products", viewerCookie));
    expect((await (await list).json()).products.map((p: { name: string }) => p.name)).toEqual([
      "Support Bot",
    ]);
    const view = await productsViewRoute(
      getJson("/api/products/view?from=2026-05-01&to=2026-06-30", viewerCookie),
    );
    expect(view.status).toBe(200);
    expect(
      (await view.json()).products.map((p: { name: string }) => p.name),
    ).toEqual(["Support Bot"]);
    // ...visible on request...
    const all = await productsRoute(getJson("/api/products?archived=1", viewerCookie));
    expect((await all.json()).products.map((p: { name: string }) => p.name)).toEqual([
      "Company Brain",
      "Support Bot",
    ]);
    // ...history fully readable...
    const body = await detail(brainId);
    expect(body.metrics.spendCents).toBe(25000);
    expect((await listFacts({ product: brainId }, pool)).totalCount).toBe(1);
    // ...but no new entries while archived.
    const entry = await manualPutRoute(
      putJson(
        `/api/products/${brainId}/manual`,
        { kind: "cost", month: "2026-06", amountCents: 100, currency: "USD" },
        adminCookie,
      ),
      idParams(brainId),
    );
    expect(entry.status).toBe(409);
    expect((await entry.json()).error).toBe("ROI is archived");

    // Restore brings it back.
    const restored = await productPatchRoute(
      patchJson(`/api/products/${brainId}`, { archived: false }, adminCookie),
      idParams(brainId),
    );
    expect((await restored.json()).product.archivedAt).toBeNull();
    const again = await productsRoute(getJson("/api/products", viewerCookie));
    expect((await again.json()).products).toHaveLength(2);
  });

  it("the Products page: spend, each product's own metric in its own unit", async () => {
    const res = await productsViewRoute(
      getJson("/api/products/view?from=2026-05-01&to=2026-06-30", viewerCookie),
    );
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view.displayCurrency).toBe("USD");
    expect(view.products).toEqual([
      // Company Brain: manual cost, no outcome metric - plain cost, no
      // fake unit, no fake ROI (spec 7).
      expect.objectContaining({
        name: "Company Brain",
        attribution: "manual",
        spendCents: 25000,
        outcomeCount: 0,
        unit: null,
        unitCostCents: null,
        valueCents: null,
        roi: null,
        activeUsers: 0,
        costPerUserCents: null,
      }),
      // Support Bot: $ per hand-counted outcome, reverted ones excluded.
      expect.objectContaining({
        name: "Support Bot",
        spendCents: 5000,
        outcomeCount: 54,
        revertedCount: 5,
        unitCostCents: 93,
        unit: "outcome",
        valueCents: 24800,
        roi: 4.96,
      }),
    ]);
    // Every row equals its drill (spec 3) - the page's numbers are proofs.
    for (const row of view.products) {
      const facts = await listFacts(
        { from: "2026-05-01", to: "2026-06-30", product: row.id },
        pool,
      );
      expect(facts.totalDisplayCents).toBe(row.spendCents);
      expect(facts.totalCount).toBe(row.factCount);
      const outcomes = await listOutcomes(
        { from: "2026-05-01", to: "2026-06-30", product: row.id },
        pool,
      );
      expect(outcomes.liveCount).toBe(row.outcomeCount);
      expect(outcomes.revertedCount).toBe(row.revertedCount);
    }

    for (const query of ["?from=junk", "?from=2026-06-10&to=2026-06-01"]) {
      const bad = await productsViewRoute(
        getJson(`/api/products/view${query}`, viewerCookie),
      );
      expect(bad.status).toBe(400);
    }
    expect((await productsViewRoute(getJson("/api/products/view"))).status).toBe(401);
  });

  it("rejects bad requests with the precise reason", async () => {
    const nothing = await productPatchRoute(
      patchJson(`/api/products/${supportBotId}`, {}, adminCookie),
      idParams(supportBotId),
    );
    expect(nothing.status).toBe(400);
    expect((await nothing.json()).error).toBe(
      "nothing to change: pass name, attribution, outcomeKind, defaultValue and/or archived",
    );

    expect(
      (await productRoute(getJson("/api/products/nope", viewerCookie), idParams("nope"))).status,
    ).toBe(400);
    expect(
      (await productRoute(getJson(`/api/products/${GHOST}`, viewerCookie), idParams(GHOST))).status,
    ).toBe(404);
    expect(
      (
        await productPatchRoute(
          patchJson(`/api/products/${GHOST}`, { name: "X" }, adminCookie),
          idParams(GHOST),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await manualPutRoute(
          putJson(`/api/products/${GHOST}/manual`, { kind: "cost", month: "2026-05", amountCents: 1, currency: "USD" }, adminCookie),
          idParams(GHOST),
        )
      ).status,
    ).toBe(404);

    for (const [body, error] of [
      [{ kind: "cost", month: "2026-13", amountCents: 1, currency: "USD" }, "month must be YYYY-MM"],
      [{ kind: "seat", month: "2026-05" }, 'kind must be "cost" or "outcomes"'],
      [{ kind: "cost", month: "2026-05", currency: "USD" }, "amountCents must be a non-negative integer"],
      [{ kind: "cost", month: "2026-05", amountCents: 1, currency: "usd" }, "currency must be a 3-letter code (e.g. USD)"],
      [{ kind: "outcomes", month: "2026-05", count: -1 }, "count must be a non-negative integer"],
      [{ kind: "outcomes", month: "2026-05", count: 1, valueCents: 100 }, "valueCurrency must be a 3-letter code (e.g. USD)"],
      [{ kind: "outcomes", month: "2026-05", count: 1, valueCurrency: "USD" }, "valueCurrency needs valueCents"],
    ] as const) {
      const res = await manualPutRoute(
        putJson(`/api/products/${supportBotId}/manual`, body, adminCookie),
        idParams(supportBotId),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(error);
    }

    for (const query of ["?from=2026-13-99", "?from=2026-06-10&to=2026-06-01"]) {
      const res = await productRoute(
        getJson(`/api/products/${supportBotId}${query}`, viewerCookie),
        idParams(supportBotId),
      );
      expect(res.status).toBe(400);
    }
  });

  it("reads need a session; changes need the admin", async () => {
    expect((await productsRoute(getJson("/api/products"))).status).toBe(401);
    expect(
      (await productRoute(getJson(`/api/products/${supportBotId}`), idParams(supportBotId))).status,
    ).toBe(401);
    expect(
      (
        await productsPostRoute(
          postJson("/api/products", { name: "X", attribution: "key" }, viewerCookie),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await productPatchRoute(
          patchJson(`/api/products/${supportBotId}`, { name: "X" }, viewerCookie),
          idParams(supportBotId),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await manualPutRoute(
          putJson(
            `/api/products/${supportBotId}/manual`,
            { kind: "outcomes", month: "2026-05", count: 1 },
            viewerCookie,
          ),
          idParams(supportBotId),
        )
      ).status,
    ).toBe(403);
  });
});
