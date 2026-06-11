import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as metricsRoute } from "../src/app/api/metrics/route";
import { GET as outcomesRoute } from "../src/app/api/outcomes/route";
import { GET as toolsRoute } from "../src/app/api/tools/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { closePool } from "../src/lib/db";
import { listFacts, listMetrics, listOutcomes } from "../src/lib/overview";
import { recomputeRollups } from "../src/lib/rollup";
import { setSetting } from "../src/lib/settings";
import { toolsData } from "../src/lib/tools";
import { runMigrations } from "../scripts/migrate.mjs";
import { getJson } from "./helpers/http";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

/**
 * Tools page readers (spec 10 page 4), driven through the real pipeline:
 * outcomes carrying AI authorship tags, the vendors' usage counters, vendor
 * spend rollups and tag-routed product spend -> toolsData - and the
 * dashboard invariant: every displayed number equals the raw rows its drill
 * filter returns (listOutcomes ?tool=, listMetrics, listFacts).
 *
 * Fixture (USD display, EUR rate 1.25 USD per EUR), June range 06-01..06-04:
 *   merged PRs (kind github_pr, Coding product):
 *     pr1 dana [claude_code] · pr2 dana [claude_code, cursor] - one PR, two
 *     tools, counted by each · pr3 dana [cursor] · pr4 dana [claude_code]
 *     REVERTED · pr5 omer [copilot] · pr6 nobody [devin] · pr7 nobody
 *     [devin] REVERTED · pr8 human-only (tools []) - belongs to no tool
 *   counters: dana CC 80/20 accepted/rejected + 1,500c estimated cost;
 *     an unmapped CC actor 5/5 + 300c; dana cursor 30/10; omer cursor 0/0
 *     (no rate, never invented); dana copilot 40 acceptances / 100
 *     generations
 *   spend: dana cursor 2,000 USD + 400 EUR (-> 2,500 USD); omer cursor
 *     1,000; unassigned cursor 500; a product-routed cursor fact 400 (no
 *     person) that must NOT appear in any person row; dana github seat 800;
 *     devin product 3,000 anthropic via its tagged key
 */

const JUNE = { from: "2026-06-01", to: "2026-06-04" };

describe.runIf(TEST_DATABASE_URL)("tools page readers", () => {
  let dbUrl: string;
  let pool: Pool;
  let dana: string;
  let omer: string;
  let coding: string;
  let devinProduct: string;
  let viewerCookie: string;

  async function metric(
    day: string,
    personId: string | null,
    identityId: string | null,
    vendor: string,
    name: string,
    value: number,
    sourceRef: string,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO usage_metrics (day, vendor, metric, value, person_id, identity_id, source_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [day, vendor, name, value, personId, identityId, sourceRef],
    );
  }

  async function pr(
    ts: string,
    personId: string | null,
    tools: string[],
    sourceRef: string,
    reverted = false,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO outcomes (ts, product_id, person_id, kind, count, source_ref, tools,
                             reverted_at, revert_source_ref)
       VALUES ($1, $2, $3, 'github_pr', 1, $4, $5, $6, $7)`,
      [
        ts,
        coding,
        personId,
        sourceRef,
        tools,
        reverted ? "2026-06-04T00:00:00Z" : null,
        reverted ? `revert:${sourceRef}` : null,
      ],
    );
  }

  beforeAll(async () => {
    dbUrl = await createScratchDb("tools_test");
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
      `INSERT INTO products (name, attribution, outcome_kind) VALUES
         ('Coding', 'connector', 'github_pr'), ('devin', 'key', 'none')
       RETURNING id`,
    );
    coding = products[0].id;
    devinProduct = products[1].id;
    await pool.query(
      "INSERT INTO tag_settings (tag, product_id) VALUES ('devin', $1)",
      [devinProduct],
    );

    const { rows: ids } = await pool.query(
      `INSERT INTO identities (person_id, vendor, external_id, kind, tags, not_person, product_id)
       VALUES
         ($1, 'anthropic', 'u_dana', 'user', '{}', false, NULL),
         ($1, 'cursor', 'c_dana', 'user', '{}', false, NULL),
         ($2, 'cursor', 'c_omer', 'user', '{}', false, NULL),
         (NULL, 'anthropic', 'u_ghost', 'user', '{}', false, NULL),
         (NULL, 'anthropic', 'key_devin', 'api_key', '{devin}', true, $3)
       RETURNING id`,
      [dana, omer, devinProduct],
    );
    const [aDana, cDana, , uGhost, kDevin] = ids.map((r) => r.id);

    // Claude Code counters (vendor estimate is USD cents, spec 5).
    await metric("2026-06-01", dana, aDana, "anthropic", "tool_actions_accepted", 80, "cc:1:dana");
    await metric("2026-06-01", dana, aDana, "anthropic", "tool_actions_rejected", 20, "cc:1:dana");
    await metric("2026-06-01", dana, aDana, "anthropic", "estimated_cost_cents", 1_000, "cc:1:dana");
    await metric("2026-06-02", dana, aDana, "anthropic", "estimated_cost_cents", 500, "cc:2:dana");
    await metric("2026-05-20", dana, aDana, "anthropic", "estimated_cost_cents", 9_999, "cc:may:dana");
    await metric("2026-06-02", null, uGhost, "anthropic", "tool_actions_accepted", 5, "cc:2:ghost");
    await metric("2026-06-02", null, uGhost, "anthropic", "tool_actions_rejected", 5, "cc:2:ghost");
    await metric("2026-06-02", null, uGhost, "anthropic", "estimated_cost_cents", 300, "cc:2:ghost");
    // Cursor + Copilot counters.
    await metric("2026-06-01", dana, cDana, "cursor", "accepts", 30, "cu:1:dana");
    await metric("2026-06-01", dana, cDana, "cursor", "rejects", 10, "cu:1:dana");
    await metric("2026-06-02", omer, null, "cursor", "accepts", 0, "cu:2:omer");
    await metric("2026-06-02", omer, null, "cursor", "rejects", 0, "cu:2:omer");
    await metric("2026-06-01", dana, null, "github", "code_acceptances", 40, "cp:1:dana");
    await metric("2026-06-01", dana, null, "github", "code_generations", 100, "cp:1:dana");

    const fact = async (
      day: string,
      personId: string | null,
      productId: string | null,
      identityId: string | null,
      vendor: string,
      amountCents: number,
      currency: string,
      sourceRef: string,
    ) =>
      pool.query(
        `INSERT INTO spend_facts (day, person_id, product_id, identity_id, vendor,
                                  tokens, amount_cents, currency, cost_basis, source_ref)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7, 'estimated', $8)`,
        [day, personId, productId, identityId, vendor, amountCents, currency, sourceRef],
      );
    await fact("2026-06-01", dana, null, cDana, "cursor", 2_000, "USD", "c1");
    await fact("2026-06-03", dana, null, cDana, "cursor", 400, "EUR", "c2");
    await fact("2026-06-02", omer, null, null, "cursor", 1_000, "USD", "c3");
    await fact("2026-06-02", null, null, null, "cursor", 500, "USD", "c4");
    await fact("2026-06-02", null, devinProduct, null, "cursor", 400, "USD", "c5");
    await fact("2026-06-02", dana, null, null, "github", 800, "USD", "g1");
    await fact("2026-06-02", null, devinProduct, kDevin, "anthropic", 3_000, "USD", "d1");

    await pr("2026-06-01T10:00:00Z", dana, ["claude_code"], "pr:acme/app#1");
    await pr("2026-06-02T10:00:00Z", dana, ["claude_code", "cursor"], "pr:acme/app#2");
    await pr("2026-06-02T11:00:00Z", dana, ["cursor"], "pr:acme/app#3");
    await pr("2026-06-03T10:00:00Z", dana, ["claude_code"], "pr:acme/app#4", true);
    await pr("2026-06-02T12:00:00Z", omer, ["copilot"], "pr:acme/app#5");
    await pr("2026-06-01T09:00:00Z", null, ["devin"], "pr:acme/app#6");
    await pr("2026-06-02T09:00:00Z", null, ["devin"], "pr:acme/app#7", true);
    await pr("2026-06-02T08:00:00Z", dana, [], "pr:acme/app#8");
    // Outside the range - never counted.
    await pr("2026-05-20T08:00:00Z", dana, ["claude_code"], "pr:acme/app#9");

    await recomputeRollups({}, pool);

    const { rows: viewers } = await pool.query(
      "INSERT INTO users (name, role) VALUES ('Viewer', 'viewer') RETURNING id",
    );
    viewerCookie = `${SESSION_COOKIE}=${(await createSession(viewers[0].id, pool)).token}`;
  });

  afterAll(async () => {
    await closePool();
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  it("puts the tools side by side: $/merge, accept rate, revert rate", async () => {
    const data = await toolsData(JUNE, pool);
    expect(data.displayCurrency).toBe("USD");
    expect(data.tools.map((t) => t.tool)).toEqual([
      "cursor", // 4,000 spend
      "devin", // 3,400
      "claude_code", // 1,800
      "copilot", // 800
    ]);

    const byTool = new Map(data.tools.map((t) => [t.tool, t]));
    expect(byTool.get("claude_code")).toMatchObject({
      spendSource: { type: "metric", vendor: "anthropic", metric: "estimated_cost_cents" },
      spendCents: 1_800, // dana 1,500 + unmapped 300; May stays out
      merges: 2,
      reverted: 1,
      costPerMergeCents: 900,
      acceptRatePct: 77.3, // (80+5) / (80+5+20+5)
      revertRatePct: 33.3,
      peopleCount: 1,
    });
    expect(byTool.get("cursor")).toMatchObject({
      spendSource: { type: "vendor", vendor: "cursor" },
      spendCents: 4_000, // dana 2,500 (EUR converted) + omer 1,000 + unassigned 500
      merges: 2,
      reverted: 0,
      costPerMergeCents: 2_000,
      acceptRatePct: 75, // omer's 0/0 adds nothing and invents nothing
      revertRatePct: 0,
      peopleCount: 2,
    });
    expect(byTool.get("copilot")).toMatchObject({
      spendSource: { type: "vendor", vendor: "github" },
      spendCents: 800,
      merges: 1,
      costPerMergeCents: 800,
      acceptRatePct: 40, // of-total: 40 acceptances / 100 generations
      revertRatePct: 0,
    });
    // Agents are products, not people (spec 7b): devin's cost is its
    // product's spend - including the routed cursor fact - never split
    // per person.
    expect(byTool.get("devin")).toMatchObject({
      spendSource: { type: "product", productId: devinProduct, productName: "devin" },
      spendCents: 3_400,
      merges: 1,
      reverted: 1,
      costPerMergeCents: 3_400,
      acceptRatePct: null,
      revertRatePct: 50,
      peopleCount: 0,
    });
    expect(byTool.has("codex")).toBe(false); // no signal, no row
  });

  it("splits every tool per person - the human-only PR belongs to no tool", async () => {
    const data = await toolsData(JUNE, pool);
    const cell = (tool: string, personId: string | null) =>
      data.rows.find((r) => r.tool === tool && r.personId === personId);

    expect(cell("claude_code", dana)).toMatchObject({
      email: "dana@acme.com",
      spendCents: 1_500,
      merges: 2,
      reverted: 1,
      costPerMergeCents: 750,
      accepted: 80,
      against: 20,
      acceptRatePct: 80,
    });
    expect(cell("claude_code", null)).toMatchObject({
      spendCents: 300,
      merges: 0,
      acceptRatePct: 50,
    });
    expect(cell("cursor", dana)).toMatchObject({
      spendCents: 2_500,
      merges: 2, // pr2 counts for cursor AND claude_code
      costPerMergeCents: 1_250,
      acceptRatePct: 75,
    });
    expect(cell("cursor", omer)).toMatchObject({
      spendCents: 1_000,
      merges: 0,
      accepted: 0,
      against: 0,
      acceptRatePct: null, // 0/0 is no rate, not 0%
    });
    // The unassigned cursor row holds only ownerless, product-less spend -
    // the product-routed fact (c5) is the devin product's money.
    expect(cell("cursor", null)).toMatchObject({ spendCents: 500 });
    expect(cell("copilot", dana)).toMatchObject({
      spendCents: 800,
      merges: 0,
      acceptRatePct: 40,
    });
    expect(cell("copilot", omer)).toMatchObject({ spendCents: null, merges: 1 });
    expect(cell("devin", null)).toMatchObject({
      spendCents: null, // no per-person devin cost exists, none is invented
      merges: 1,
      reverted: 1,
    });
    expect(data.rows.some((r) => r.tool === "")).toBe(false);
  });

  it("every cell equals the sum of its drill-down rows", async () => {
    const data = await toolsData(JUNE, pool);

    for (const row of data.rows) {
      // Merges -> /drill?view=outcomes&kind=github_pr&tool=&person=
      const outcomes = await listOutcomes(
        {
          ...JUNE,
          kind: "github_pr",
          tool: row.tool,
          person: row.personId ?? "unassigned",
        },
        pool,
      );
      expect(outcomes.liveCount).toBe(row.merges);
      expect(outcomes.revertedCount).toBe(row.reverted);
      for (const outcome of outcomes.rows) {
        expect(outcome.tools).toContain(row.tool);
      }
    }

    // claude_code spend -> /drill?view=metrics (the vendor's own counters).
    const danaCost = await listMetrics(
      {
        ...JUNE,
        vendor: "anthropic",
        metric: ["estimated_cost_cents"],
        person: dana,
      },
      pool,
    );
    expect(danaCost.totalValue).toBe(1_500);
    const danaAccept = await listMetrics(
      {
        ...JUNE,
        vendor: "anthropic",
        metric: ["tool_actions_accepted", "tool_actions_rejected"],
        person: dana,
      },
      pool,
    );
    expect(danaAccept.byMetric).toEqual([
      { metric: "tool_actions_accepted", value: 80, rowCount: 1 },
      { metric: "tool_actions_rejected", value: 20, rowCount: 1 },
    ]);

    // cursor spend -> /drill?vendor=cursor&person= (facts, FX-converted).
    const danaCursor = await listFacts({ ...JUNE, vendor: "cursor", person: dana }, pool);
    expect(danaCursor.totalDisplayCents).toBe(2_500);
    const unassignedCursor = await listFacts(
      { ...JUNE, vendor: "cursor", person: "unassigned", product: "none" },
      pool,
    );
    expect(unassignedCursor.totalDisplayCents).toBe(500);

    // devin spend -> /drill?product= (the routed product's rows).
    const devinFacts = await listFacts({ ...JUNE, product: devinProduct }, pool);
    expect(devinFacts.totalDisplayCents).toBe(3_400);
  });

  it("converts to the display currency identically everywhere; no rate = 409", async () => {
    await setSetting("display_currency", "EUR", pool);
    try {
      const data = await toolsData(JUNE, pool);
      const byTool = new Map(data.tools.map((t) => [t.tool, t]));
      expect(byTool.get("claude_code")!.spendCents).toBe(1_440); // 1,800 / 1.25
      expect(byTool.get("cursor")!.spendCents).toBe(3_200); // 4,000 / 1.25
      const danaCursor = data.rows.find(
        (r) => r.tool === "cursor" && r.personId === dana,
      )!;
      expect(danaCursor.spendCents).toBe(2_000); // 1,600 + the 400 EUR as billed
      const drill = await listFacts({ ...JUNE, vendor: "cursor", person: dana }, pool);
      expect(drill.totalDisplayCents).toBe(danaCursor.spendCents);
    } finally {
      await setSetting("display_currency", "USD", pool);
    }

    await setSetting("display_currency", "GBP", pool);
    try {
      await expect(toolsData(JUNE, pool)).rejects.toThrow(/no FX rate/);
    } finally {
      await setSetting("display_currency", "USD", pool);
    }
  });

  it("rejects bad ranges loudly", async () => {
    await expect(toolsData({ from: "junk", to: "2026-06-02" }, pool)).rejects.toThrow(
      /from must be/,
    );
    await expect(
      toolsData({ from: "2026-06-05", to: "2026-06-01" }, pool),
    ).rejects.toThrow(/after/);
  });

  it("serves the page and its drills through the routes, auth enforced", async () => {
    expect((await toolsRoute(getJson("/api/tools"))).status).toBe(401);
    expect((await metricsRoute(getJson("/api/metrics"))).status).toBe(401);

    const res = await toolsRoute(
      getJson(`/api/tools?from=${JUNE.from}&to=${JUNE.to}`, viewerCookie),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tools.map((t: { tool: string }) => t.tool)).toEqual([
      "cursor",
      "devin",
      "claude_code",
      "copilot",
    ]);

    const metrics = await metricsRoute(
      getJson(
        `/api/metrics?from=${JUNE.from}&to=${JUNE.to}&vendor=anthropic&metric=tool_actions_accepted,tool_actions_rejected&person=${dana}`,
        viewerCookie,
      ),
    );
    expect(metrics.status).toBe(200);
    const page = await metrics.json();
    expect(page.byMetric).toHaveLength(2);
    expect(page.totalCount).toBe(2);
    expect(page.rows.every((r: { sourceRef: string }) => r.sourceRef.length > 0)).toBe(true);

    const outcomes = await outcomesRoute(
      getJson(
        `/api/outcomes?from=${JUNE.from}&to=${JUNE.to}&kind=github_pr&tool=claude_code`,
        viewerCookie,
      ),
    );
    expect(outcomes.status).toBe(200);
    const outcomePage = await outcomes.json();
    expect(outcomePage.liveCount).toBe(2);
    expect(outcomePage.revertedCount).toBe(1);

    for (const [path, message] of [
      ["/api/tools?from=junk", "from must be YYYY-MM-DD"],
      ["/api/tools?from=2026-06-05&to=2026-06-01", "from 2026-06-05 is after to 2026-06-01"],
      ["/api/metrics?from=junk", "from must be YYYY-MM-DD"],
      ["/api/metrics?vendor=Not%20A%20Vendor", "bad vendor"],
      ["/api/metrics?metric=Bad%20Metric", "metric must be a comma-separated list of counter names"],
      ["/api/metrics?person=nope", 'person must be a uuid or "unassigned"'],
      ["/api/metrics?key=nope", "key must be a uuid"],
      ["/api/metrics?limit=0", "bad limit"],
      ["/api/metrics?limit=2000", "limit is capped at 1000"],
      ["/api/metrics?offset=-1", "bad offset"],
      [`/api/outcomes?tool=${"x".repeat(101)}`, "bad tool"],
    ] as const) {
      const bad = await (path.startsWith("/api/tools")
        ? toolsRoute(getJson(path, viewerCookie))
        : path.startsWith("/api/metrics")
          ? metricsRoute(getJson(path, viewerCookie))
          : outcomesRoute(getJson(path, viewerCookie)));
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toBe(message);
    }
  });
});
