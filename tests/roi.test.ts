import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recomputeRollups } from "../src/lib/rollup";
import { roiView } from "../src/lib/roi";
import { runMigrations } from "../scripts/migrate.mjs";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

/**
 * The one ROI list (spec 7 + 10 page 3), driven through the real pipeline:
 * products/facts/metrics/outcomes -> recomputeRollups -> roiView. Built-in
 * coding-tool rows (success = lines surviving 30 days after the merge,
 * accept rates and tokens from the vendors' own counters) sit next to the
 * user-defined rows, all with the same columns: spend, tokens, successes,
 * $ and tokens per success, value, ROI multiple. No PR has been survival-
 * checked in this fixture, so every coding ROI stays a dash - merged PRs
 * are not a success and never stand in for one (survival.test.ts covers
 * the checked path). Every row carries tags and vendors for the filter bar.
 *
 * Fixture (USD display), June range 06-01..06-04:
 *   claude_code (built-in, metric-sourced): 1,500c vendor estimate,
 *     150k tokens from the vendor's counter, accepted 80 / rejected 20;
 *     PRs pr1+pr2 live, pr4 reverted - none survival-checked
 *   cursor (built-in, vendor-billed): dana 2,000c; PRs pr2+pr3
 *   devin (built-in, product-routed): key tagged devin spends 3,000c /
 *     10k tokens on the Devin row; pr5 live, pr6 reverted
 *   supportbot (sdk, sdk_event, default value 450c): 1,500c / 75k tokens,
 *     3 tickets (one valued 500c), 1 reverted -> value 1,400c, ROI 0.93
 *   Coding (connector, github_pr): owns the PR outcomes, no spend routed
 *   Company Brain (manual, none): 2,000c manual -> plain cost, no fake ROI
 */

const JUNE = { from: "2026-06-01", to: "2026-06-04" };

describe.runIf(TEST_DATABASE_URL)("the one ROI list (spec 7)", () => {
  let dbUrl: string;
  let pool: Pool;
  let supportbot: string;
  let devinProduct: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("roi_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 3 });

    const { rows: people } = await pool.query(
      `INSERT INTO people (email, name) VALUES
         ('dana@acme.com', 'Dana Roth'), ('omer@acme.com', 'Omer Lev')
       RETURNING id`,
    );
    const [dana, omer] = people.map((p) => p.id as string);

    const { rows: products } = await pool.query(
      `INSERT INTO products
         (name, attribution, outcome_kind, default_value_cents, default_value_currency)
       VALUES
         ('supportbot', 'sdk', 'sdk_event', 450, 'USD'),
         ('Devin', 'key', 'none', NULL, NULL),
         ('Coding', 'connector', 'github_pr', NULL, NULL),
         ('Company Brain', 'manual', 'none', NULL, NULL)
       RETURNING id`,
    );
    const [bot, devin, coding, brain] = products.map((p) => p.id as string);
    supportbot = bot;
    devinProduct = devin;
    await pool.query(
      "INSERT INTO tag_settings (tag, product_id) VALUES ('devin', $1)",
      [devinProduct],
    );

    const { rows: ids } = await pool.query(
      `INSERT INTO identities (person_id, vendor, external_id, kind, tags, not_person, product_id)
       VALUES
         ($1, 'anthropic', 'u_dana', 'user', '{}', false, NULL),
         ($1, 'cursor', 'c_dana', 'user', '{}', false, NULL),
         (NULL, 'anthropic', 'key_devin', 'api_key', '{devin}', true, $2),
         (NULL, 'openai', 'key_bot', 'api_key', '{support-bot}', true, $3)
       RETURNING id`,
      [dana, devinProduct, supportbot],
    );
    const [aDana, cDana, kDevin, kBot] = ids.map((r) => r.id as string);

    // Claude Code's own counters: spend estimate, tokens, accept/reject.
    const metric = (day: string, name: string, value: number, ref: string) =>
      pool.query(
        `INSERT INTO usage_metrics (day, vendor, metric, value, person_id, identity_id, source_ref)
         VALUES ($1, 'anthropic', $2, $3, $4, $5, $6)`,
        [day, name, value, dana, aDana, ref],
      );
    await metric("2026-06-01", "estimated_cost_cents", 1_000, "cc:1");
    await metric("2026-06-01", "tokens", 120_000, "cc:1");
    await metric("2026-06-01", "tool_actions_accepted", 80, "cc:1");
    await metric("2026-06-01", "tool_actions_rejected", 20, "cc:1");
    await metric("2026-06-02", "estimated_cost_cents", 500, "cc:2");
    await metric("2026-06-02", "tokens", 30_000, "cc:2");
    // Outside the range - never counted.
    await metric("2026-05-20", "tokens", 9_999_999, "cc:may");

    const fact = (
      day: string,
      personId: string | null,
      productId: string | null,
      identityId: string | null,
      vendor: string,
      tokens: number,
      amountCents: number,
      basis: string,
      ref: string,
    ) =>
      pool.query(
        `INSERT INTO spend_facts (day, person_id, product_id, identity_id, vendor,
                                  tokens, amount_cents, currency, cost_basis, source_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'USD', $8, $9)`,
        [day, personId, productId, identityId, vendor, tokens, amountCents, basis, ref],
      );
    await fact("2026-06-01", dana, supportbot, kBot, "openai", 50_000, 1_000, "estimated", "s1");
    await fact("2026-06-02", omer, supportbot, kBot, "openai", 25_000, 500, "estimated", "s2");
    await fact("2026-06-02", null, devinProduct, kDevin, "anthropic", 10_000, 3_000, "estimated", "d1");
    await fact("2026-06-01", dana, null, cDana, "cursor", 0, 2_000, "estimated", "c1");
    await fact("2026-06-01", null, brain, null, "manual", 0, 2_000, "manual", "b1");

    const outcome = (
      ts: string,
      productId: string,
      personId: string | null,
      kind: string,
      tools: string[],
      valueCents: number | null,
      ref: string,
      reverted = false,
    ) =>
      pool.query(
        `INSERT INTO outcomes (ts, product_id, person_id, kind, count, value_cents,
                               currency, source_ref, tools, reverted_at, revert_source_ref)
         VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10)`,
        [
          ts,
          productId,
          personId,
          kind,
          valueCents,
          valueCents === null ? null : "USD",
          ref,
          tools,
          reverted ? "2026-06-04T00:00:00Z" : null,
          reverted ? `revert:${ref}` : null,
        ],
      );
    await outcome("2026-06-01T10:00:00Z", supportbot, dana, "ticket_resolved", [], 500, "t1");
    await outcome("2026-06-02T10:00:00Z", supportbot, dana, "ticket_resolved", [], null, "t2");
    await outcome("2026-06-02T11:00:00Z", supportbot, null, "ticket_resolved", [], null, "t3");
    await outcome("2026-06-03T10:00:00Z", supportbot, dana, "ticket_resolved", [], null, "t4", true);
    await outcome("2026-06-01T09:00:00Z", coding, dana, "github_pr", ["claude_code"], null, "pr1");
    await outcome("2026-06-02T09:00:00Z", coding, dana, "github_pr", ["claude_code", "cursor"], null, "pr2");
    await outcome("2026-06-02T09:30:00Z", coding, dana, "github_pr", ["cursor"], null, "pr3");
    await outcome("2026-06-03T09:00:00Z", coding, dana, "github_pr", ["claude_code"], null, "pr4", true);
    await outcome("2026-06-02T08:00:00Z", coding, null, "github_pr", ["devin"], null, "pr5");
    await outcome("2026-06-02T08:30:00Z", coding, null, "github_pr", ["devin"], null, "pr6", true);

    await recomputeRollups({}, pool);
  });

  afterAll(async () => {
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  it("one list: built-in coding rows next to the user-defined ones, spend-desc", async () => {
    const view = await roiView(JUNE, pool);
    expect(view.displayCurrency).toBe("USD");
    expect(view.rows.map((r) => [r.kind, r.name]).sort()).toEqual(
      [
        ["coding", "Claude Code"],
        ["coding", "Cursor"],
        ["coding", "Devin"],
        ["custom", "Coding"],
        ["custom", "Company Brain"],
        ["custom", "Devin"],
        ["custom", "supportbot"],
      ].sort(),
    );
    const spends = view.rows.map((r) => r.spendCents ?? -1);
    expect(spends).toEqual([...spends].sort((a, b) => b - a));
    // No survival checks recorded: a dash on every row, never a number
    // (the survival job's own coverage lives in survival.test.ts).
    expect(view.rows.every((r) => r.survivalPct === null)).toBe(true);
  });

  it("a metric-sourced coding row: vendor estimate, vendor tokens - no survival check, no ROI", async () => {
    const view = await roiView(JUNE, pool);
    const cc = view.rows.find((r) => r.key === "coding:claude_code")!;
    expect(cc).toMatchObject({
      kind: "coding",
      name: "Claude Code",
      unit: "1k lines",
      spendCents: 1_500,
      tokens: 150_000, // the May counter stays out
      // pr1 + pr2 merged, but a merge is not a success - until the survival
      // job has measured surviving lines, there is nothing to price.
      successes: 0,
      revertedCount: 1,
      costPerSuccessCents: null,
      tokensPerSuccess: null,
      valueCents: null, // no value recorded, none invented
      roi: null,
      acceptRatePct: 80,
      survivalPct: null,
      vendors: ["anthropic"],
    });
    expect(cc.tags).toContain("claude_code");
  });

  it("a vendor-billed coding row: spend and vendor facts, ROI dashes until lines are checked", async () => {
    const view = await roiView(JUNE, pool);
    const cursor = view.rows.find((r) => r.key === "coding:cursor")!;
    expect(cursor).toMatchObject({
      spendCents: 2_000,
      successes: 0, // pr2 + pr3 merged - merges are not successes
      costPerSuccessCents: null,
      tokensPerSuccess: null,
      vendors: ["cursor"],
    });
  });

  it("an agent's burn lands on its routed row (spec 7b) - and its coding row says so", async () => {
    const view = await roiView(JUNE, pool);
    const coding = view.rows.find((r) => r.key === "coding:devin")!;
    expect(coding).toMatchObject({
      spendCents: 3_000,
      tokens: 10_000,
      successes: 0, // pr5 merged, nothing survival-checked yet
      revertedCount: 1,
      vendors: ["anthropic"],
    });
    expect(coding.spendSource).toMatchObject({
      type: "product",
      productId: devinProduct,
    });
    expect(coding.tags).toContain("devin");

    const custom = view.rows.find((r) => r.key === `custom:${devinProduct}`)!;
    expect(custom).toMatchObject({
      spendCents: 3_000,
      tokens: 10_000,
      attribution: "key",
      tags: ["devin"],
      vendors: ["anthropic"],
    });
  });

  it("a user-defined row: $ and tokens per success, value, the ROI multiple", async () => {
    const view = await roiView(JUNE, pool);
    const bot = view.rows.find((r) => r.key === `custom:${supportbot}`)!;
    expect(bot).toMatchObject({
      kind: "custom",
      name: "supportbot",
      attribution: "sdk",
      unit: "ticket_resolved",
      spendCents: 1_500,
      tokens: 75_000,
      successes: 3,
      revertedCount: 1,
      costPerSuccessCents: 500,
      tokensPerSuccess: 25_000,
      valueCents: 1_400, // 500 explicit + 2 x 450 default
      roi: 0.93,
      acceptRatePct: null,
      tags: ["support-bot"],
      vendors: ["openai"],
    });
  });

  it("no success defined = plain cost - no fake ROI anywhere on the row", async () => {
    const view = await roiView(JUNE, pool);
    const brain = view.rows.find((r) => r.name === "Company Brain")!;
    expect(brain).toMatchObject({
      spendCents: 2_000,
      unit: null,
      successes: 0,
      costPerSuccessCents: null,
      tokensPerSuccess: null,
      valueCents: null,
      roi: null,
      vendors: ["manual"],
    });
  });
});
