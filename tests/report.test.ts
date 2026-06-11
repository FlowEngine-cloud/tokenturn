import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as reportRoute } from "../src/app/api/report/route";
import { GET as reportCsvRoute } from "../src/app/api/report/csv/route";
import { GET as reportFocusRoute } from "../src/app/api/report/focus/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { closePool } from "../src/lib/db";
import { listFacts, listOutcomes } from "../src/lib/overview";
import { productsView } from "../src/lib/products";
import {
  FOCUS_COLUMNS,
  focusCsv,
  NO_COST_CENTER,
  reportCsv,
  reportData,
} from "../src/lib/report";
import { ResolveError } from "../src/lib/resolve";
import { recomputeRollups } from "../src/lib/rollup";
import { runMigrations } from "../scripts/migrate.mjs";
import { getJson } from "./helpers/http";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

/**
 * The CFO report (spec 10 page 6), driven through the real pipeline:
 * facts/outcomes -> recomputeRollups -> reportData / CSV / FOCUS 1.4 - and
 * the ledger invariant: every report number equals the raw rows its drill
 * filter returns, archived products and the no-cost-center bucket included,
 * so the month always sums to the whole ledger.
 *
 * Fixture (USD display, EUR rate 1.25 USD per EUR), report month 2026-06:
 *   support (sdk, sdk_event, default 450c): June dana 1,000 USD + omer
 *     400 EUR (= 500); May 800. June outcomes: t1 dana valued 500 ·
 *     t2 omer · t3 REVERTED -> 2 live, value 500+450=950, ROI 0.63,
 *     $7.50/ticket_resolved, 2 active users.
 *   coding (connector, github_pr): June 600 via routed key; 2 live merges
 *     + 1 reverted -> $3.00/merge. May 400, 1 merge.
 *   brain (manual, none): June 2,000 manual + dana 300 -> $23.00/active
 *     user, May zero -> MoM null. Manual fact feeds FOCUS "Purchase".
 *   Old, "Tool" (ARCHIVED): June 999 - on the report (flagged archived,
 *     money never leaves a total), absent from the Products page.
 *   idle (sdk, none): all-zero roster row - dropped from the report.
 *   No cost center: June 700 unassigned, May 250 -> MoM +180%.
 */

const JUNE = "2026-06";
const JUNE_RANGE = { from: "2026-06-01", to: "2026-06-30" };
const MAY_RANGE = { from: "2026-05-01", to: "2026-05-31" };

describe.runIf(TEST_DATABASE_URL)("CFO report (spec 10.6)", () => {
  let dbUrl: string;
  let pool: Pool;
  let viewerCookie: string;
  let dana: string;
  let omer: string;
  let support: string;
  let coding: string;
  let brain: string;
  let oldtool: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("report_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 3 });

    const { rows: viewers } = await pool.query(
      "INSERT INTO users (name, role) VALUES ('Viewer', 'viewer') RETURNING id",
    );
    viewerCookie = `${SESSION_COOKIE}=${(await createSession(viewers[0].id, pool)).token}`;

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
         ('support', 'sdk', 'sdk_event', 450, 'USD', NULL),
         ('coding', 'connector', 'github_pr', NULL, NULL, NULL),
         ('brain', 'manual', 'none', NULL, NULL, NULL),
         ('Old, "Tool"', 'key', 'none', NULL, NULL, now()),
         ('idle', 'sdk', 'none', NULL, NULL, NULL)
       RETURNING id`,
    );
    [support, coding, brain, oldtool] = products.map((p) => p.id);

    const { rows: keys } = await pool.query(
      `INSERT INTO identities
         (person_id, vendor, external_id, kind, display_name, tags, not_person, product_id)
       VALUES (NULL, 'anthropic', 'key_coding', 'api_key', 'Coding Key', '{coding}', true, $1)
       RETURNING id`,
      [coding],
    );
    const codingKey = keys[0].id;

    const fact = (
      day: string,
      personId: string | null,
      productId: string | null,
      identityId: string | null,
      vendor: string,
      model: string | null,
      tokens: number,
      amountCents: number,
      currency: string,
      basis: string,
      sourceRef: string,
    ) =>
      pool.query(
        `INSERT INTO spend_facts (day, person_id, product_id, identity_id, vendor,
                                  model, tokens, amount_cents, currency, cost_basis, source_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [day, personId, productId, identityId, vendor, model, tokens,
         amountCents, currency, basis, sourceRef],
      );
    // June - the report month.
    await fact("2026-06-01", dana, support, null, "openai", "gpt-5", 12_000, 1_000, "USD", "estimated", "s1");
    await fact("2026-06-05", omer, support, null, "openai", null, 0, 400, "EUR", "invoiced", "s2");
    await fact("2026-06-02", null, coding, codingKey, "anthropic", null, 0, 600, "USD", "estimated", "k1");
    await fact("2026-06-01", null, brain, null, "manual", null, 0, 2_000, "USD", "manual", "b1");
    await fact("2026-06-03", dana, brain, null, "openai", null, 0, 300, "USD", "estimated", "b2");
    await fact("2026-06-03", null, oldtool, null, "acme", null, 0, 999, "USD", "estimated", "old1");
    await fact("2026-06-04", null, null, null, "anthropic", null, 0, 700, "USD", "estimated", "u1");
    // May - last month.
    await fact("2026-05-10", dana, support, null, "openai", null, 0, 800, "USD", "estimated", "s0");
    await fact("2026-05-15", null, coding, codingKey, "anthropic", null, 0, 400, "USD", "estimated", "k0");
    await fact("2026-05-05", null, null, null, "anthropic", null, 0, 250, "USD", "estimated", "u0");

    const outcome = (
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
        [ts, productId, personId, kind, valueCents,
         valueCents === null ? null : "USD", sourceRef,
         reverted ? "2026-06-20T00:00:00Z" : null,
         reverted ? `revert:${sourceRef}` : null],
      );
    await outcome("2026-06-01T10:00:00Z", support, dana, "ticket_resolved", 500, "t1");
    await outcome("2026-06-05T10:00:00Z", support, omer, "ticket_resolved", null, "t2");
    await outcome("2026-06-06T10:00:00Z", support, dana, "ticket_resolved", null, "t3", true);
    await outcome("2026-06-02T09:00:00Z", coding, dana, "github_pr", null, "pr1");
    await outcome("2026-06-02T09:30:00Z", coding, null, "github_pr", null, "pr2");
    await outcome("2026-06-03T09:00:00Z", coding, dana, "github_pr", null, "pr3", true);
    await outcome("2026-05-12T10:00:00Z", support, dana, "ticket_resolved", null, "t0");

    await recomputeRollups({}, pool);
  });

  afterAll(async () => {
    await closePool();
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  it("reports spend by cost center - archived and no-cost-center money included", async () => {
    const data = await reportData(JUNE, pool);
    expect(data.displayCurrency).toBe("USD");
    expect(data.from).toBe(JUNE_RANGE.from);
    expect(data.to).toBe(JUNE_RANGE.to);
    expect(data.prevMonth).toBe("2026-05");

    expect(data.rows.map((r) => r.name)).toEqual([
      "brain", // 2,300
      "support", // 1,500
      'Old, "Tool"', // 999
      NO_COST_CENTER, // 700
      "coding", // 600
    ]);
    const byName = new Map(data.rows.map((r) => [r.name, r]));
    expect(byName.get('Old, "Tool"')!.archived).toBe(true);
    expect(byName.get(NO_COST_CENTER)!.productId).toBeNull();
    // The all-zero roster row says nothing - dropped.
    expect(byName.has("idle")).toBe(false);

    // Every spend number equals the raw rows its drill filter returns.
    for (const row of data.rows) {
      const drill = await listFacts(
        { ...JUNE_RANGE, product: row.productId ?? "none" },
        pool,
      );
      expect(row.spendCents).toBe(drill.totalDisplayCents);
      const prevDrill = await listFacts(
        { ...MAY_RANGE, product: row.productId ?? "none" },
        pool,
      );
      expect(row.prevSpendCents).toBe(prevDrill.totalDisplayCents);
    }
    // ...and the total is the whole ledger for the month.
    const monthDrill = await listFacts(JUNE_RANGE, pool);
    expect(data.totals.spendCents).toBe(monthDrill.totalDisplayCents);
    expect(data.totals.spendCents).toBe(6_099);
    expect(data.totals.prevSpendCents).toBe(1_450);
    expect(data.totals.momPct).toBe(320.6);
  });

  it("computes unit costs and ROI where defined - never invented", async () => {
    const data = await reportData(JUNE, pool);
    const byName = new Map(data.rows.map((r) => [r.name, r]));

    const supportRow = byName.get("support")!;
    expect(supportRow.spendCents).toBe(1_500); // 1,000 USD + 400 EUR @ 1.25
    expect(supportRow.outcomeCount).toBe(2); // t3 reverted, never counted
    expect(supportRow.unit).toBe("ticket_resolved");
    expect(supportRow.unitCostCents).toBe(750);
    expect(supportRow.valueCents).toBe(950); // 500 explicit + 450 default
    expect(supportRow.roi).toBe(0.63);
    expect(supportRow.activeUsers).toBe(2);
    // The outcome count drills to the same live rows.
    const outcomes = await listOutcomes({ ...JUNE_RANGE, product: support }, pool);
    expect(supportRow.outcomeCount).toBe(outcomes.liveCount);

    const codingRow = byName.get("coding")!;
    expect(codingRow.unit).toBe("merge");
    expect(codingRow.unitCostCents).toBe(300); // $3.00/merge
    expect(codingRow.roi).toBeNull(); // no value anywhere - no fake ROI
    expect(codingRow.momPct).toBe(50); // 400 -> 600

    const brainRow = byName.get("brain")!;
    expect(brainRow.unit).toBeNull();
    expect(brainRow.unitCostCents).toBeNull();
    expect(brainRow.costPerUserCents).toBe(2_300); // dana is the only user
    expect(brainRow.momPct).toBeNull(); // May zero - no fake percent

    expect(byName.get(NO_COST_CENTER)!.momPct).toBe(180); // 250 -> 700

    // The report's per-product math is the Products page's math, verbatim.
    const view = await productsView(JUNE_RANGE, pool, { includeArchived: true });
    for (const row of data.rows) {
      if (row.productId === null) continue;
      const p = view.products.find((v) => v.id === row.productId)!;
      expect({ spend: row.spendCents, unitCost: row.unitCostCents, roi: row.roi }).toEqual({
        spend: p.spendCents,
        unitCost: p.unitCostCents,
        roi: p.roi,
      });
    }
  });

  it("builds the month-over-month trend from the same rollups", async () => {
    const data = await reportData(JUNE, pool);
    expect(data.months.map((m) => m.month)).toEqual([
      "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
    ]);
    for (const m of data.months) {
      const drill = await listFacts({ from: m.from, to: m.to }, pool);
      expect(m.spendCents).toBe(drill.totalDisplayCents);
    }
    expect(data.months.at(-1)!.spendCents).toBe(6_099);
    expect(data.months.at(-2)!.spendCents).toBe(1_450);
    expect(data.months[0].spendCents).toBe(0);
  });

  it("rejects a malformed month", async () => {
    await expect(reportData("2026-13", pool)).rejects.toThrow(ResolveError);
    await expect(reportData("june", pool)).rejects.toThrow("month must be YYYY-MM");
  });

  it("exports the report table as CSV - the same numbers, escaped", async () => {
    const data = await reportData(JUNE, pool);
    const csv = reportCsv(data);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "Month,Cost center,Status,Spend (USD),Last month (USD),MoM %,Outcomes,Unit," +
        "Unit cost (USD),Value (USD),ROI,Active users,Cost per active user (USD)",
    );
    expect(lines).toHaveLength(1 + data.rows.length + 1); // header + rows + total
    expect(lines).toContain(
      "2026-06,support,active,15.00,8.00,87.5,2,ticket_resolved,7.50,9.50,0.63,2,7.50",
    );
    // Comma + quote in a product name stays one CSV cell.
    expect(csv).toContain('"Old, ""Tool""",archived,9.99');
    expect(lines.at(-1)).toBe("2026-06,Total,,60.99,14.50,320.6,,,,,,,");
  });

  it("exports FOCUS 1.4 - one row per raw fact, sums equal to the drill", async () => {
    const csv = await focusCsv(JUNE, pool);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(FOCUS_COLUMNS.join(","));
    const monthDrill = await listFacts(JUNE_RANGE, pool);
    expect(lines).toHaveLength(1 + monthDrill.totalCount);

    // Keyset paging never duplicates or drops a row.
    expect(await focusCsv(JUNE, pool, 2)).toBe(csv);

    // BilledCost sums per currency equal the raw facts behind them.
    const col = (name: string) => FOCUS_COLUMNS.indexOf(name as (typeof FOCUS_COLUMNS)[number]);
    const rows = lines.slice(1).map((line) => line.split(",")); // no commas in fixture cells
    const sums = new Map<string, number>();
    for (const cells of rows) {
      const ccy = cells[col("BillingCurrency")];
      sums.set(ccy, (sums.get(ccy) ?? 0) + Math.round(Number(cells[col("BilledCost")]) * 100));
    }
    expect(sums.get("USD")).toBe(5_599);
    expect(sums.get("EUR")).toBe(400);

    const byRef = new Map(rows.map((cells) => [cells[col("x_SourceRef")], cells]));
    const s1 = byRef.get("s1")!;
    expect(s1).toHaveLength(FOCUS_COLUMNS.length); // cells stay aligned to the header
    expect(s1[col("ChargeCategory")]).toBe("Usage");
    expect(s1[col("ChargeDescription")]).toBe("openai gpt-5 usage");
    expect(s1[col("ChargePeriodStart")]).toBe("2026-06-01T00:00:00Z");
    expect(s1[col("ChargePeriodEnd")]).toBe("2026-06-02T00:00:00Z");
    expect(s1[col("BillingPeriodStart")]).toBe("2026-06-01T00:00:00Z");
    expect(s1[col("BillingPeriodEnd")]).toBe("2026-07-01T00:00:00Z");
    expect(s1[col("ConsumedQuantity")]).toBe("12000");
    expect(s1[col("ConsumedUnit")]).toBe("tokens");
    expect(s1[col("SubAccountId")]).toBe(dana);
    expect(s1[col("SubAccountName")]).toBe("dana@acme.com");
    expect(s1[col("x_CostBasis")]).toBe("estimated");
    expect(s1[col("x_ProductId")]).toBe(support);

    // Manual money is a Purchase, never disguised as vendor usage.
    const b1 = byRef.get("b1")!;
    expect(b1[col("ChargeCategory")]).toBe("Purchase");
    expect(b1[col("ChargeDescription")]).toBe("manual monthly cost entry");
    expect(b1[col("x_CostBasis")]).toBe("manual");

    // The routed key is the resource.
    const k1 = byRef.get("k1")!;
    expect(k1[col("ResourceId")]).toBe("key_coding");
    expect(k1[col("ResourceName")]).toBe("Coding Key");
    expect(k1[col("SubAccountId")]).toBe("");

    // EUR money exports as billed - original currency, no conversion.
    const s2 = byRef.get("s2")!;
    expect(s2[col("BilledCost")]).toBe("4.00");
    expect(s2[col("BillingCurrency")]).toBe("EUR");
  });

  it("serves the report and both exports over authenticated routes", async () => {
    expect((await reportRoute(getJson(`/api/report?month=${JUNE}`))).status).toBe(401);
    expect((await reportCsvRoute(getJson(`/api/report/csv?month=${JUNE}`))).status).toBe(401);
    expect(
      (await reportFocusRoute(getJson(`/api/report/focus?month=${JUNE}`))).status,
    ).toBe(401);
    expect(
      (await reportRoute(getJson("/api/report?month=2026-6", viewerCookie))).status,
    ).toBe(400);
    expect(
      (await reportCsvRoute(getJson("/api/report/csv?month=nope", viewerCookie))).status,
    ).toBe(400);

    const res = await reportRoute(getJson(`/api/report?month=${JUNE}`, viewerCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.month).toBe(JUNE);
    expect(body.totals.spendCents).toBe(6_099);

    const csvRes = await reportCsvRoute(
      getJson(`/api/report/csv?month=${JUNE}`, viewerCookie),
    );
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get("content-type")).toContain("text/csv");
    expect(csvRes.headers.get("content-disposition")).toContain(
      `ai-pnl-report-${JUNE}.csv`,
    );
    expect(await csvRes.text()).toBe(reportCsv(await reportData(JUNE, pool)));

    const focusRes = await reportFocusRoute(
      getJson(`/api/report/focus?month=${JUNE}`, viewerCookie),
    );
    expect(focusRes.status).toBe(200);
    expect(focusRes.headers.get("content-type")).toContain("text/csv");
    expect(focusRes.headers.get("content-disposition")).toContain(
      `ai-pnl-focus-1.4-${JUNE}.csv`,
    );
    // The stream emits the same file, one line at a time.
    expect(await focusRes.text()).toBe(`${await focusCsv(JUNE, pool)}\n`);
  });
});
