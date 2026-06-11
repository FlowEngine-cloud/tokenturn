import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as notPersonRoute } from "../src/app/api/resolve/[id]/not-person/route";
import { GET as resolveRoute } from "../src/app/api/resolve/route";
import { GET as tagRoute, PATCH as tagPatchRoute } from "../src/app/api/tags/[tag]/route";
import { GET as tagsRoute, POST as tagsPostRoute } from "../src/app/api/tags/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { connectConnector } from "../src/lib/connectors/connect";
import { clearConnectors, registerConnector } from "../src/lib/connectors/registry";
import { runSync } from "../src/lib/connectors/sync";
import { closePool } from "../src/lib/db";
import { recomputeRollups } from "../src/lib/rollup";
import { clearSecretKeyCache } from "../src/lib/secrets";
import { runMigrations } from "../scripts/migrate.mjs";
import { makeAcmeConnector } from "./helpers/fixture-connector";
import { getJson, patchJson, postJson } from "./helpers/http";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";
import { replayFile } from "./helpers/replay";

/**
 * Tags (spec 7b), driven through the real production path: recorded syncs
 * turn key names into tags, the tag API toggles counts-toward-personal-usage
 * and points tags at products, and the assertions read identities, the
 * ledger, and the rollups. Covers: filtering by tag across employees and
 * keys, the personal-usage toggle flowing into the rollup grain, tag ->
 * product routing with full-history re-attribution (the agent convention:
 * burn lands on the product, never a person), the two-product conflict in
 * the Resolve queue, and a key rename re-tagging history retroactively.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const FIXTURES = path.resolve(__dirname, "fixtures", "connectors", "tags");
const CONNECT_OK = path.resolve(
  __dirname, "fixtures", "connectors", "acme", "connect-ok.json",
);

/** Pinned clock: recordings are recorded against "today" = 2026-06-11. */
const NOW = new Date("2026-06-11T12:00:00Z");
const LATER_SAME_DAY = new Date("2026-06-11T18:00:00Z");
const NEXT_DAY = new Date("2026-06-12T09:00:00Z");

const VENDOR = "acme_t";

function tagParams(tag: string) {
  return { params: Promise.resolve({ tag }) };
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe.runIf(TEST_DATABASE_URL)("tags (spec 7b)", () => {
  let dbUrl: string;
  let pool: Pool;
  let dataDir: string;
  let adminCookie: string;
  let viewerCookie: string;
  const person: Record<string, string> = {};
  let devinProductId: string;
  let batchEtlProductId: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("tags_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 5 });
    dataDir = mkdtempSync(path.join(os.tmpdir(), "ai-pnl-tags-"));
    clearConnectors();
    registerConnector(makeAcmeConnector(VENDOR));

    for (const [name, email] of [
      ["Dana", "dana@acme.com"],
      ["Rob", "rob@acme.com"],
    ]) {
      const { rows } = await pool.query(
        "INSERT INTO people (email, name, source) VALUES ($1, $2, 'csv') RETURNING id",
        [email, name],
      );
      person[email] = rows[0].id;
    }

    const { rows: products } = await pool.query(
      `INSERT INTO products (name, attribution, outcome_kind)
       VALUES ('Devin', 'key', 'none'), ('Batch ETL', 'key', 'none')
       RETURNING id, name`,
    );
    devinProductId = products.find((p) => p.name === "Devin")!.id;
    batchEtlProductId = products.find((p) => p.name === "Batch ETL")!.id;

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

  async function sync(recording: string, now: Date) {
    const session = replayFile(path.join(FIXTURES, recording));
    const result = await runSync(VENDOR, { pool, fetch: session.fetch, now, dataDir });
    expect(result.status).toBe("success");
    expect(session.remaining()).toHaveLength(0);
    return result;
  }

  /** spend_facts keyed by source_ref with the person/product they landed on. */
  async function facts() {
    const { rows } = await pool.query(
      `SELECT f.source_ref AS ref, p.email AS person, pr.name AS product
       FROM spend_facts f
       LEFT JOIN people p ON p.id = f.person_id
       LEFT JOIN products pr ON pr.id = f.product_id
       WHERE f.vendor = $1`,
      [VENDOR],
    );
    return Object.fromEntries(rows.map((r) => [r.ref, r]));
  }

  async function identityRow(externalId: string) {
    const { rows } = await pool.query(
      `SELECT i.id, i.not_person AS "notPerson", i.tags,
              i.manual_tags AS "manualTags",
              p.email AS person, pr.name AS product
       FROM identities i
       LEFT JOIN people p ON p.id = i.person_id
       LEFT JOIN products pr ON pr.id = i.product_id
       WHERE i.vendor = $1 AND i.external_id = $2`,
      [VENDOR, externalId],
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function listTags(cookie = viewerCookie) {
    const res = await tagsRoute(getJson("/api/tags", cookie));
    expect(res.status).toBe(200);
    return (await res.json()).tags;
  }

  it("key names become tags on sync; keys auto-map to their minters", async () => {
    await sync("backfill.json", NOW);

    const byRef = await facts();
    expect(byRef.t_dana_u1).toMatchObject({ person: "dana@acme.com", product: null });
    expect(byRef.t_exp_1).toMatchObject({ person: "dana@acme.com", product: null });
    expect(byRef.t_batch_d1).toMatchObject({ person: "dana@acme.com", product: null });
    expect(byRef.t_batch_r1).toMatchObject({ person: "rob@acme.com", product: null });
    expect(byRef.t_devin_1).toMatchObject({ person: "dana@acme.com", product: null });

    expect(await listTags()).toEqual([
      { tag: "batch-processing", countsPersonal: true, productId: null, productName: null, identityCount: 2, vendors: [VENDOR], factCount: 2, amountUsdCents: 750 },
      { tag: "cli-experiments", countsPersonal: true, productId: null, productName: null, identityCount: 1, vendors: [VENDOR], factCount: 2, amountUsdCents: 500 },
      { tag: "devin", countsPersonal: true, productId: null, productName: null, identityCount: 1, vendors: [VENDOR], factCount: 2, amountUsdCents: 1500 },
    ]);
  });

  it("a tag filters the ledger across all employees and keys, down to the vendor rows", async () => {
    const res = await tagRoute(getJson("/api/tags/batch-processing", viewerCookie), tagParams("batch-processing"));
    expect(res.status).toBe(200);
    const detail = await res.json();

    expect(detail).toMatchObject({
      tag: "batch-processing",
      countsPersonal: true,
      productId: null,
      productName: null,
    });
    // Two keys, two different employees - one tag.
    expect(
      detail.identities.map((i: { externalId: string; personEmail: string | null }) => [i.externalId, i.personEmail]),
    ).toEqual([
      ["key_batch_d", "dana@acme.com"],
      ["key_batch_r", "rob@acme.com"],
    ]);
    // Drill-down: the exact vendor rows behind the tag's number, newest first.
    expect(detail.facts).toEqual([
      { day: "2026-05-22", vendor: VENDOR, model: "claude-haiku-4", tokens: 5000, amountCents: 250, currency: "USD", costBasis: "estimated", sourceRef: "t_batch_r1", identityExternalId: "key_batch_r", personEmail: "rob@acme.com", productName: null },
      { day: "2026-05-21", vendor: VENDOR, model: "claude-haiku-4", tokens: 9000, amountCents: 500, currency: "USD", costBasis: "estimated", sourceRef: "t_batch_d1", identityExternalId: "key_batch_d", personEmail: "dana@acme.com", productName: null },
    ]);
  });

  it("the counts-toward-personal-usage toggle re-flags history in the rollups; attribution is untouched", async () => {
    await recomputeRollups({}, pool);

    const res = await tagPatchRoute(
      patchJson("/api/tags/batch-processing", { countsPersonal: false }, adminCookie),
      tagParams("batch-processing"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tag: "batch-processing",
      countsPersonal: false,
      productId: null,
      routedIdentities: 0,
      conflictIdentities: 0,
      facts: 0,
      metrics: 0,
      outcomes: 0,
      rollups: { from: "2026-05-21", to: "2026-05-22" },
    });

    // The flagged rollup rows are exactly the tag's spend, still per person.
    const { rows: flagged } = await pool.query(
      `SELECT day::text AS day, person_id, amount_usd_cents::int AS cents
       FROM rollup_daily WHERE NOT counts_personal ORDER BY day`,
    );
    expect(flagged).toEqual([
      { day: "2026-05-21", person_id: person["dana@acme.com"], cents: 500 },
      { day: "2026-05-22", person_id: person["rob@acme.com"], cents: 250 },
    ]);

    // Dana's dollar is still Dana's (spec 4) - it just stops counting as
    // personal usage.
    const { rows: dana } = await pool.query(
      `SELECT SUM(amount_usd_cents) FILTER (WHERE counts_personal)::int AS personal,
              SUM(amount_usd_cents)::int AS total
       FROM rollup_daily WHERE person_id = $1`,
      [person["dana@acme.com"]],
    );
    expect(dana).toEqual([{ personal: 2100, total: 2600 }]);
  });

  it("pointing a tag at a product routes the key and its FULL history - burn lands on the product, never a person", async () => {
    const res = await tagPatchRoute(
      patchJson("/api/tags/devin", { productId: devinProductId }, adminCookie),
      tagParams("devin"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tag: "devin",
      countsPersonal: true,
      productId: devinProductId,
      routedIdentities: 1,
      conflictIdentities: 0,
      facts: 2,
      metrics: 0,
      outcomes: 0,
      rollups: { from: "2026-05-15", to: "2026-06-05" },
    });

    // The key is an agent now: product set, person cleared, never re-filled.
    expect(await identityRow("key_devin")).toMatchObject({
      notPerson: true,
      person: null,
      product: "Devin",
    });
    // Full history followed - t_devin_1 is far outside any re-pull window.
    const byRef = await facts();
    expect(byRef.t_devin_1).toMatchObject({ person: null, product: "Devin" });
    expect(byRef.t_devin_2).toMatchObject({ person: null, product: "Devin" });

    // Charts agree: Devin spend left Dana's personal burn for the product.
    const { rows: devin } = await pool.query(
      `SELECT SUM(amount_usd_cents)::int AS cents FROM rollup_daily
       WHERE product_id = $1 AND person_id IS NULL`,
      [devinProductId],
    );
    expect(devin).toEqual([{ cents: 1500 }]);
    const { rows: dana } = await pool.query(
      `SELECT SUM(amount_usd_cents)::int AS total FROM rollup_daily WHERE person_id = $1`,
      [person["dana@acme.com"]],
    );
    expect(dana).toEqual([{ total: 1100 }]);

    // Routed keys are resolved - not Resolve-queue material.
    const queueRes = await resolveRoute(getJson("/api/resolve", viewerCookie));
    const { queue, conflicts } = await queueRes.json();
    expect(queue).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("a new key carrying a routed tag is routed at sync time - the agent convention needs no clicks", async () => {
    await sync("incremental.json", LATER_SAME_DAY);

    // key_agent2 is owned by Rob vendor-side, but its tag says agent: the
    // fact lands on the Devin product with no person, in the same sync.
    expect(await identityRow("key_agent2")).toMatchObject({
      notPerson: true,
      person: null,
      product: "Devin",
    });
    expect((await facts()).t_agent2_1).toMatchObject({ person: null, product: "Devin" });
    // The re-pull did not re-fill the routed key's person either.
    expect(await identityRow("key_devin")).toMatchObject({ person: null, product: "Devin" });

    const devin = (await listTags()).find((t: { tag: string }) => t.tag === "devin");
    expect(devin).toMatchObject({ identityCount: 2, factCount: 3, amountUsdCents: 2400 });
  });

  it("two product-tags on one key = a conflict in the Resolve queue; the key is never guess-routed", async () => {
    // A Resolve decision hands key_batch_r a second tag: devin (-> Devin).
    const batchR = await identityRow("key_batch_r");
    const notPersonRes = await notPersonRoute(
      postJson(`/api/resolve/${batchR.id}/not-person`, { tag: "devin" }, adminCookie),
      idParams(batchR.id),
    );
    expect(notPersonRes.status).toBe(200);

    // Now point batch-processing at Batch ETL: key_batch_d routes, but
    // key_batch_r carries tags pointing at two products - a conflict.
    const res = await tagPatchRoute(
      patchJson("/api/tags/batch-processing", { productId: batchEtlProductId }, adminCookie),
      tagParams("batch-processing"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tag: "batch-processing",
      countsPersonal: false, // the earlier toggle survives
      productId: batchEtlProductId,
      routedIdentities: 1,
      conflictIdentities: 1,
      facts: 1,
      metrics: 0,
      outcomes: 0,
      rollups: { from: "2026-05-21", to: "2026-05-22" },
    });

    expect(await identityRow("key_batch_d")).toMatchObject({
      notPerson: true,
      person: null,
      product: "Batch ETL",
    });
    // The conflicted key stays unrouted - no fake attribution.
    expect(await identityRow("key_batch_r")).toMatchObject({
      manualTags: ["devin"],
      person: null,
      product: null,
    });
    expect((await facts()).t_batch_r1).toMatchObject({ person: null, product: null });

    const queueRes = await resolveRoute(getJson("/api/resolve", viewerCookie));
    expect((await queueRes.json()).conflicts).toEqual([
      {
        identityId: batchR.id,
        vendor: VENDOR,
        externalId: "key_batch_r",
        kind: "api_key",
        candidates: [
          { tag: "batch-processing", productId: batchEtlProductId, productName: "Batch ETL" },
          { tag: "devin", productId: devinProductId, productName: "Devin" },
        ],
      },
    ]);

    // The manual tag counts: devin now spans three keys.
    const devin = (await listTags()).find((t: { tag: string }) => t.tag === "devin");
    expect(devin).toMatchObject({ identityCount: 3, factCount: 4 });
  });

  it("un-pointing one tag resolves the conflict; already-routed keys keep their product", async () => {
    const res = await tagPatchRoute(
      patchJson("/api/tags/devin", { productId: null }, adminCookie),
      tagParams("devin"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tag: "devin",
      countsPersonal: true,
      productId: null,
      routedIdentities: 1, // key_batch_r - one candidate left
      conflictIdentities: 0,
      facts: 1,
      metrics: 0,
      outcomes: 0,
      rollups: { from: "2026-05-15", to: "2026-06-10" },
    });

    expect(await identityRow("key_batch_r")).toMatchObject({
      notPerson: true,
      person: null,
      product: "Batch ETL",
    });
    expect((await facts()).t_batch_r1).toMatchObject({ person: null, product: "Batch ETL" });
    // Routing is sticky: un-pointing the tag never un-routes history.
    expect(await identityRow("key_devin")).toMatchObject({ person: null, product: "Devin" });
    expect(await identityRow("key_agent2")).toMatchObject({ person: null, product: "Devin" });

    const queueRes = await resolveRoute(getJson("/api/resolve", viewerCookie));
    const { unassigned, conflicts } = await queueRes.json();
    expect(conflicts).toEqual([]);
    // Everything is attributed: a person or a product owns every dollar.
    expect(unassigned).toEqual([]);

    const { rows: rolled } = await pool.query(
      `SELECT pr.name, SUM(r.amount_usd_cents)::int AS cents
       FROM rollup_daily r JOIN products pr ON pr.id = r.product_id
       GROUP BY pr.name ORDER BY pr.name`,
    );
    expect(rolled).toEqual([
      { name: "Batch ETL", cents: 750 },
      { name: "Devin", cents: 2400 },
    ]);
  });

  it("a key rename re-tags its history retroactively", async () => {
    await sync("rename.json", NEXT_DAY);

    expect((await identityRow("key_exp")).tags).toEqual(["research"]);
    const tags = await listTags();
    expect(tags.map((t: { tag: string }) => t.tag)).toEqual([
      "batch-processing", "devin", "research",
    ]);
    // The renamed key's FULL history sits under the new tag - including
    // t_exp_1 from 2026-05-18, synced weeks before the rename.
    expect(tags.find((t: { tag: string }) => t.tag === "research")).toMatchObject({
      identityCount: 1,
      factCount: 3,
      amountUsdCents: 650,
    });
    const res = await tagRoute(getJson("/api/tags/research", viewerCookie), tagParams("research"));
    expect(
      (await res.json()).facts.map((f: { sourceRef: string }) => f.sourceRef),
    ).toEqual(["t_exp_3", "t_exp_2", "t_exp_1"]);

    // The person-owned key stayed person-owned: rename is not routing.
    expect(await identityRow("key_exp")).toMatchObject({
      notPerson: false,
      person: "dana@acme.com",
      product: null,
    });
  });

  it("rejects bad input with the precise reason", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";

    const unknownTag = await tagPatchRoute(
      patchJson("/api/tags/ghost-tag", { countsPersonal: false }, adminCookie),
      tagParams("ghost-tag"),
    );
    expect(unknownTag.status).toBe(404);
    expect((await unknownTag.json()).error).toBe("no such tag");

    const unknownDetail = await tagRoute(
      getJson("/api/tags/ghost-tag", viewerCookie),
      tagParams("ghost-tag"),
    );
    expect(unknownDetail.status).toBe(404);

    const nothing = await tagPatchRoute(
      patchJson("/api/tags/research", {}, adminCookie),
      tagParams("research"),
    );
    expect(nothing.status).toBe(400);
    expect((await nothing.json()).error).toBe(
      "nothing to change: pass countsPersonal and/or productId",
    );

    const badToggle = await tagPatchRoute(
      patchJson("/api/tags/research", { countsPersonal: "yes" }, adminCookie),
      tagParams("research"),
    );
    expect(badToggle.status).toBe(400);

    const badProduct = await tagPatchRoute(
      patchJson("/api/tags/research", { productId: "nope" }, adminCookie),
      tagParams("research"),
    );
    expect(badProduct.status).toBe(400);

    const ghostProduct = await tagPatchRoute(
      patchJson("/api/tags/research", { productId: ghost }, adminCookie),
      tagParams("research"),
    );
    expect(ghostProduct.status).toBe(404);
    expect((await ghostProduct.json()).error).toBe("ROI not found");

    const blankTag = await tagPatchRoute(
      patchJson("/api/tags/%20", { countsPersonal: false }, adminCookie),
      tagParams(" "),
    );
    expect(blankTag.status).toBe(400);
  });

  it("reads need a session; changes need the admin", async () => {
    expect((await tagsRoute(getJson("/api/tags"))).status).toBe(401);
    expect(
      (await tagRoute(getJson("/api/tags/research"), tagParams("research"))).status,
    ).toBe(401);
    expect(
      (
        await tagPatchRoute(
          patchJson("/api/tags/research", { countsPersonal: false }, viewerCookie),
          tagParams("research"),
        )
      ).status,
    ).toBe(403);
    expect(
      (await tagsPostRoute(postJson("/api/tags", { tag: "x" }, viewerCookie))).status,
    ).toBe(403);
  });

  it("a tag added ahead of its keys is listed with zero keys, idempotently", async () => {
    // The ROI filter bar's "Add a tag" (spec 7b): the tag exists before any
    // key carries it - naming a key after it puts spend under it on sync.
    const created = await tagsPostRoute(
      postJson("/api/tags", { tag: "future-agent" }, adminCookie),
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ tag: "future-agent", created: true });

    const again = await tagsPostRoute(
      postJson("/api/tags", { tag: "future-agent" }, adminCookie),
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ tag: "future-agent", created: false });

    const tags = await listTags();
    const future = tags.find((t: { tag: string }) => t.tag === "future-agent");
    expect(future).toMatchObject({
      countsPersonal: true,
      productId: null,
      identityCount: 0,
      vendors: [],
      factCount: 0,
      amountUsdCents: 0,
    });
    // An existing carried tag stays untouched by a duplicate add.
    const carried = tags.find((t: { tag: string }) => t.tag === "devin");
    expect(carried.identityCount).toBeGreaterThan(0);

    // The detail page answers for it too - zero keys, zero facts, not a 404.
    const detail = await tagRoute(
      getJson("/api/tags/future-agent", viewerCookie),
      tagParams("future-agent"),
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      tag: "future-agent",
      countsPersonal: true,
      productId: null,
      identities: [],
      facts: [],
    });

    // And its settings can be staged before any key carries it: the first
    // key named after it routes on sync.
    const staged = await tagPatchRoute(
      patchJson("/api/tags/future-agent", { countsPersonal: false }, adminCookie),
      tagParams("future-agent"),
    );
    expect(staged.status).toBe(200);
    expect(await staged.json()).toMatchObject({
      tag: "future-agent",
      countsPersonal: false,
      routedIdentities: 0,
    });

    const blank = await tagsPostRoute(postJson("/api/tags", { tag: "  " }, adminCookie));
    expect(blank.status).toBe(400);
    const notString = await tagsPostRoute(postJson("/api/tags", { tag: 7 }, adminCookie));
    expect(notString.status).toBe(400);
  });
});
