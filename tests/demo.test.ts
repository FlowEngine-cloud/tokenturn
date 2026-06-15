import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectConnector } from "../src/lib/connectors/connect";
import { clearConnectors, registerConnector } from "../src/lib/connectors/registry";
import { closePool } from "../src/lib/db";
import { DEMO_MARKER_KEY, demoMarker, seedDemoData, wipeDemoData } from "../src/lib/demo";
import { trailingRange } from "../src/lib/range";
import { ResolveError } from "../src/lib/resolve";
import { roiView } from "../src/lib/roi";
import { runMigrations } from "../scripts/migrate.mjs";
import { makeStubConnector } from "./helpers/fixture-connector";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const NOW = new Date("2026-06-10T12:00:00Z");

async function count(pool: Pool, sql: string): Promise<number> {
  const { rows } = await pool.query(sql);
  return Number(rows[0].n);
}

describe.runIf(TEST_DATABASE_URL)("demo dataset (spec 10 onboarding)", () => {
  let dbUrl: string;
  let pool: Pool;
  let dataDir: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("demo_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 3 });
    dataDir = mkdtempSync(path.join(os.tmpdir(), "ai-pnl-demo-"));
    clearConnectors();
    registerConnector(makeStubConnector("stub_demo"));
  });

  afterAll(async () => {
    await closePool();
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    clearConnectors();
  });

  it("seeds ~6 months of people, keys, tags, products, spend and outcomes", async () => {
    const summary = await seedDemoData(pool, NOW);

    expect(summary.from).toBe("2025-12-13"); // 180 days incl. the seed day
    expect(summary.to).toBe("2026-06-10");
    expect(summary.people).toBe(12);
    expect(summary.products).toBe(5);

    // The summary is the database, not a brochure.
    expect(await count(pool, "SELECT count(*) AS n FROM people")).toBe(summary.people);
    expect(await count(pool, "SELECT count(*) AS n FROM products")).toBe(summary.products);
    expect(await count(pool, "SELECT count(*) AS n FROM identities")).toBe(summary.identities);
    expect(await count(pool, "SELECT count(*) AS n FROM spend_facts")).toBe(summary.facts);
    expect(await count(pool, "SELECT count(*) AS n FROM outcomes")).toBe(summary.outcomes);
    expect(await count(pool, "SELECT count(*) AS n FROM usage_metrics")).toBe(summary.metrics);
    expect(await count(pool, "SELECT count(*) AS n FROM issue_tracking")).toBe(summary.issues);
    expect(await count(pool, "SELECT count(*) AS n FROM survival_checks")).toBe(
      summary.survivalChecks,
    );

    // Every demo row is wipe-selectable by its source_ref prefix.
    expect(
      await count(pool, "SELECT count(*) AS n FROM spend_facts WHERE source_ref NOT LIKE 'demo:%'"),
    ).toBe(0);
    expect(
      await count(pool, "SELECT count(*) AS n FROM outcomes WHERE source_ref NOT LIKE 'demo:%'"),
    ).toBe(0);

    // The marker landed with the data.
    const marker = await demoMarker(pool);
    expect(marker?.peopleIds).toHaveLength(12);
    expect(marker?.from).toBe(summary.from);

    // Rollups were recomputed through the normal pipeline: chart money ==
    // fact money, to the cent (every demo number drills to demo rows).
    const { rows: ledger } = await pool.query(
      `SELECT (SELECT sum(amount_cents)::bigint FROM spend_facts) AS facts,
              (SELECT sum(amount_usd_cents)::bigint FROM rollup_daily) AS rollup`,
    );
    expect(ledger[0].rollup).not.toBeNull();
    expect(ledger[0].rollup).toBe(ledger[0].facts);

    // The pages this feeds: invoiced Copilot seats exist (est/inv split),
    // unassigned spend exists (coverage tile), the Resolve queue is alive,
    // a batch tag is toggled out of personal usage and the devin tag routes
    // to its product (spec 7b conventions shown working).
    expect(
      await count(
        pool,
        "SELECT count(*) AS n FROM spend_facts WHERE cost_basis = 'invoiced'",
      ),
    ).toBeGreaterThan(0);
    expect(
      await count(
        pool,
        "SELECT count(*) AS n FROM spend_facts WHERE person_id IS NULL AND product_id IS NULL",
      ),
    ).toBeGreaterThan(0);
    expect(
      await count(
        pool,
        "SELECT count(*) AS n FROM identities WHERE person_id IS NULL AND NOT not_person",
      ),
    ).toBe(2);
    const { rows: tags } = await pool.query(
      "SELECT tag, counts_personal, product_id FROM tag_settings ORDER BY tag",
    );
    expect(tags.map((t) => t.tag)).toEqual(["batch-processing", "devin", "triage-agent"]);
    expect(tags[0].counts_personal).toBe(false);
    expect(tags[1].product_id).not.toBeNull();
    expect(tags[2].product_id).not.toBeNull();

    // Reverted PRs remain available as a coding diagnostic.
    expect(
      await count(pool, "SELECT count(*) AS n FROM outcomes WHERE reverted_at IS NOT NULL"),
    ).toBeGreaterThan(0);

    // The Jira-fed ROI shows the whole ticket lifecycle from minute one:
    // pending, success AND fail tracking rows, and exactly one issue_done
    // outcome per success - never one for pending or fail.
    const { rows: lifecycle } = await pool.query(
      "SELECT status, count(*)::int AS n FROM issue_tracking GROUP BY status",
    );
    const byStatus = Object.fromEntries(lifecycle.map((r) => [r.status, Number(r.n)]));
    expect(byStatus.pending).toBeGreaterThan(0);
    expect(byStatus.success).toBeGreaterThan(0);
    expect(byStatus.fail).toBeGreaterThan(0);
    expect(
      await count(pool, "SELECT count(*) AS n FROM outcomes WHERE kind = 'issue_done'"),
    ).toBe(byStatus.success);
    // Pending rows are honest: undecided, window still open at seed time.
    expect(
      await count(
        pool,
        `SELECT count(*) AS n FROM issue_tracking
         WHERE status = 'pending' AND (decided_at IS NOT NULL OR window_end <= '2026-06-10T12:00:00Z')`,
      ),
    ).toBe(0);

    // Survival columns have real rows behind them: both horizons, never
    // more lines alive than written, and only for PRs whose horizon passed.
    expect(
      await count(pool, "SELECT count(*) AS n FROM survival_checks WHERE horizon_days = 30"),
    ).toBeGreaterThan(0);
    expect(
      await count(pool, "SELECT count(*) AS n FROM survival_checks WHERE horizon_days = 90"),
    ).toBeGreaterThan(0);
    expect(
      await count(
        pool,
        `SELECT count(*) AS n FROM survival_checks sc JOIN outcomes o ON o.source_ref = sc.source_ref
         WHERE o.ts + make_interval(days => sc.horizon_days) > '2026-06-10T12:00:00Z'`,
      ),
    ).toBe(0);

    // Seeded demos open on this 90-day cohort: coding ROI is surviving
    // lines at 30 days, and the internal GitHub outcome product never
    // leaks back into the list as a spend-per-merge row.
    const roi = await roiView(trailingRange(90, NOW), pool);
    const codingRows = roi.rows.filter((row) => row.kind === "coding");
    expect(codingRows.some((row) => row.survivalPct !== null)).toBe(true);
    expect(codingRows.some((row) => row.successes > 0)).toBe(true);
    expect(roi.rows.some((row) => row.kind === "custom" && row.name === "Coding")).toBe(false);
  });

  it("refuses to seed twice", async () => {
    await expect(seedDemoData(pool, NOW)).rejects.toThrowError(ResolveError);
  });

  it("is wiped when the first real connector connects, rollups included", async () => {
    // Real data attaches to one demo person and one demo product before the
    // wipe: a real fact on Dana, an ingest key on Support Bot.
    const { rows: dana } = await pool.query(
      "SELECT id FROM people WHERE email = 'dana@acme.dev'",
    );
    const { rows: support } = await pool.query(
      "SELECT id FROM products WHERE name = 'Support Bot'",
    );
    await pool.query(
      `INSERT INTO spend_facts (day, person_id, vendor, tokens, amount_cents, currency, cost_basis, source_ref)
       VALUES ('2026-06-01', $1, 'openai', 10, 1234, 'USD', 'estimated', 'real:1')`,
      [dana[0].id],
    );
    await pool.query(
      `INSERT INTO ingest_keys (product_id, token_prefix, token_hash)
       VALUES ($1, 'pnl_test', 'hash')`,
      [support[0].id],
    );

    await connectConnector("stub_demo", { apiKey: "k" }, { db: pool, dataDir });

    // Demo rows gone, marker gone; the real fact survives.
    expect(await demoMarker(pool)).toBeNull();
    expect(
      await count(pool, "SELECT count(*) AS n FROM spend_facts WHERE source_ref LIKE 'demo:%'"),
    ).toBe(0);
    expect(await count(pool, "SELECT count(*) AS n FROM outcomes")).toBe(0);
    expect(await count(pool, "SELECT count(*) AS n FROM usage_metrics")).toBe(0);
    expect(await count(pool, "SELECT count(*) AS n FROM spend_facts")).toBe(1);
    expect(await count(pool, "SELECT count(*) AS n FROM identities")).toBe(0);
    expect(await count(pool, "SELECT count(*) AS n FROM tag_settings")).toBe(0);
    expect(await count(pool, "SELECT count(*) AS n FROM issue_tracking")).toBe(0);
    expect(await count(pool, "SELECT count(*) AS n FROM survival_checks")).toBe(0);

    // Conservative deletes: the person and product real data touched stay.
    const { rows: people } = await pool.query("SELECT email FROM people");
    expect(people.map((p) => p.email)).toEqual(["dana@acme.dev"]);
    const { rows: products } = await pool.query("SELECT name FROM products");
    expect(products.map((p) => p.name)).toEqual(["Support Bot"]);

    // Rollups over the demo span now say exactly what the real rows say.
    const { rows: rollup } = await pool.query(
      "SELECT sum(amount_usd_cents)::bigint AS total FROM rollup_daily",
    );
    expect(rollup[0].total).toBe("1234");
  });

  it("wiping again is a no-op, and seeding after a connector exists is refused", async () => {
    expect((await wipeDemoData(pool)).wiped).toBe(false);
    await expect(seedDemoData(pool, NOW)).rejects.toThrowError(
      /already connected/,
    );
    // Nothing snuck back in.
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM settings WHERE key = $1", [
      DEMO_MARKER_KEY,
    ]);
    expect(rows[0].n).toBe(0);
  });
});
