import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as invoicesRoute } from "../src/app/api/invoices/route";
import { POST as importRoute } from "../src/app/api/invoices/import/route";
import { PATCH as settingsPatchRoute } from "../src/app/api/settings/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { connectConnector } from "../src/lib/connectors/connect";
import { clearConnectors, registerConnector } from "../src/lib/connectors/registry";
import { runSync } from "../src/lib/connectors/sync";
import { closePool } from "../src/lib/db";
import { recomputeRollups } from "../src/lib/rollup";
import { clearSecretKeyCache } from "../src/lib/secrets";
import { runMigrations } from "../scripts/migrate.mjs";
import { makeAcmeConnector } from "./helpers/fixture-connector";
import { getJson, patchJson } from "./helpers/http";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";
import { replayFile } from "./helpers/replay";

/**
 * Invoice true-up (spec section 4): "Monthly invoice import (CSV) trues
 * estimated up to invoiced; Overview shows drift when they diverge" - driven
 * through the real path. A recorded sync lands estimated facts, the CSV
 * import previews/commits with per-row errors, the true-up materializes one
 * drillable Unassigned adjustment per vendor-month (negative when the vendor
 * billed less), corrections rewrite the month in place, a restating sync
 * re-trues automatically, and the drift converts to the org's display
 * currency while the invoice keeps its original amount.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const FIXTURES = path.resolve(__dirname, "fixtures", "connectors", "invoices");
const CONNECT_OK = path.resolve(
  __dirname, "fixtures", "connectors", "acme", "connect-ok.json",
);

/** Pinned clock: recordings are recorded against "today" = 2026-06-11. */
const NOW = new Date("2026-06-11T12:00:00Z");
const VENDOR = "acme_v";

function postCsv(path: string, csv: string, cookie?: string): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "content-type": "text/csv", ...(cookie ? { cookie } : {}) },
    body: csv,
  });
}

describe.runIf(TEST_DATABASE_URL)("invoice import + true-up (spec 4)", () => {
  let dbUrl: string;
  let pool: Pool;
  let dataDir: string;
  let adminCookie: string;
  let viewerCookie: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("invoices_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 5 });
    dataDir = mkdtempSync(path.join(os.tmpdir(), "ai-pnl-invoices-"));
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

    // Daily FX (tested in fx.test.ts); here May EUR is a hand-pinned 1.25.
    await pool.query(
      "INSERT INTO fx_rates (day, currency, usd_rate) VALUES ('2026-05-01', 'EUR', 1.25)",
    );
    // A second vendor with no connector: synced-elsewhere facts, seeded raw.
    await pool.query(
      `INSERT INTO spend_facts (day, vendor, tokens, amount_cents, currency, cost_basis, source_ref)
       VALUES ('2026-05-15', 'beta', 0, 1000, 'USD', 'estimated', 'beta:usage:1')`,
    );

    await connectConnector(VENDOR, { apiKey: "acme_sk_test_123" }, {
      db: pool,
      fetch: replayFile(CONNECT_OK).fetch,
      dataDir,
    });
    const synced = await runSync(VENDOR, {
      pool,
      fetch: replayFile(path.join(FIXTURES, "backfill.json")).fetch,
      now: NOW,
      dataDir,
    });
    expect(synced.status).toBe("success");
    await recomputeRollups({}, pool);
  });

  afterAll(async () => {
    await closePool();
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
    clearConnectors();
    clearSecretKeyCache();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  async function adjustmentRows(vendor: string) {
    const { rows } = await pool.query(
      `SELECT day::text AS day, amount_cents::int AS cents, currency,
              cost_basis AS basis, person_id, product_id, source_ref AS ref
       FROM spend_facts WHERE vendor = $1 AND source_ref LIKE 'invoice:%'
       ORDER BY day`,
      [vendor],
    );
    return rows;
  }

  async function mayRollup(vendor: string) {
    const { rows } = await pool.query(
      `SELECT cost_basis AS basis, SUM(amount_usd_cents)::int AS usd
       FROM rollup_daily
       WHERE vendor = $1 AND day BETWEEN '2026-05-01' AND '2026-05-31'
       GROUP BY cost_basis ORDER BY cost_basis`,
      [vendor],
    );
    return rows;
  }

  async function drift(cookie = viewerCookie) {
    const res = await invoicesRoute(getJson("/api/invoices", cookie));
    expect(res.status).toBe(200);
    return res.json();
  }

  it("preview validates every row - aliased headers, quoted notes - and commits nothing", async () => {
    const csv = [
      "Provider,Billing Period,Total,CCY,Invoice Number,Memo",
      `${VENDOR},2026-05,50.00,USD,INV-1001,"May true-up, reconciled"`,
      `${VENDOR},2026-13,1.00,USD,,`,
      `${VENDOR},2026-04,12x.00,USD,,`,
      "beta,2026-04,5.00,XXX,,",
      `${VENDOR},2026-06,1.00,USD,,`,
      `${VENDOR},2026-05,2.00,USD,,`,
      "manual,2026-04,1.00,USD,,",
    ].join("\n");
    const res = await importRoute(postCsv("/api/invoices/import?preview=1", csv, adminCookie));
    expect(res.status).toBe(200);
    const { rows, ok } = await res.json();
    expect(ok).toBe(false);
    expect(rows.map((r: { line: number; error: string | null }) => [r.line, r.error])).toEqual([
      [2, null],
      [3, 'bad month "2026-13" - want YYYY-MM'],
      [4, 'bad amount "12x.00" - want a plain decimal like 1234.56'],
      [5, "no FX rate for XXX yet - sync FX rates first"],
      [6, "2026-06 is not over yet - import after the month closes"],
      [7, `duplicate row for ${VENDOR} 2026-05`],
      [8, 'vendor "manual" is reserved for manual product entries'],
    ]);
    expect(rows[0]).toMatchObject({
      vendor: VENDOR,
      month: "2026-05",
      amountCents: 5000,
      currency: "USD",
      ref: "INV-1001",
      note: "May true-up, reconciled",
    });

    // Preview is read-only; and a commit with any bad row imports NOTHING.
    const commit = await importRoute(postCsv("/api/invoices/import", csv, adminCookie));
    expect(commit.status).toBe(400);
    expect((await commit.json()).error).toBe("no rows imported - fix the rows below and retry");
    const { rows: count } = await pool.query("SELECT count(*)::int AS n FROM invoices");
    expect(count[0].n).toBe(0);
    expect(await adjustmentRows(VENDOR)).toHaveLength(0);
  });

  it("import trues estimated up to invoiced via one Unassigned adjustment per vendor-month", async () => {
    // Synced facts: acme_v May estimated = 2000 + 1500 + 820 = 4320.
    // Invoices: acme_v $50.00; beta EUR 10.00 over $10.00 of facts.
    const csv = [
      "vendor,month,amount,currency,ref",
      `${VENDOR},2026-05,50.00,USD,INV-1001`,
      "beta,2026-05,10.00,EUR,INV-2002",
    ].join("\n");
    const res = await importRoute(postCsv("/api/invoices/import", csv, adminCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toBe(2);
    expect(body.rollupDays).toEqual(["2026-05-31"]);
    expect(body.invoices).toMatchObject([
      { vendor: VENDOR, month: "2026-05", amountCents: 5000, currency: "USD", driftCents: 680 },
      // 1000 USD cents of facts = 800 EUR cents at 1.25; invoice 1000 -> +200.
      { vendor: "beta", month: "2026-05", amountCents: 1000, currency: "EUR", driftCents: 200 },
    ]);

    // The adjustment: month's last day, invoiced, Unassigned, drills to the invoice.
    expect(await adjustmentRows(VENDOR)).toMatchObject([
      { day: "2026-05-31", cents: 680, currency: "USD", basis: "invoiced",
        person_id: null, product_id: null },
    ]);
    expect(await adjustmentRows("beta")).toMatchObject([
      { day: "2026-05-31", cents: 200, currency: "EUR", basis: "invoiced" },
    ]);

    // Rollups now sum to the invoice: estimates untouched, drift on top.
    expect(await mayRollup(VENDOR)).toEqual([
      { basis: "estimated", usd: 4320 },
      { basis: "invoiced", usd: 680 },
    ]);
    expect(await mayRollup("beta")).toEqual([
      { basis: "estimated", usd: 1000 },
      { basis: "invoiced", usd: 250 },
    ]);

    // The drift report: same numbers, original invoice amounts preserved.
    const report = await drift();
    expect(report.displayCurrency).toBe("USD");
    expect(report.invoices).toMatchObject([
      {
        vendor: VENDOR, month: "2026-05", amountCents: 5000, currency: "USD",
        sourceRef: "INV-1001", estimatedUsdCents: 4320, invoicedFactsUsdCents: 0,
        invoiceUsdCents: 5000, driftCents: 680, driftUsdCents: 680, driftDisplayCents: 680,
      },
      {
        vendor: "beta", month: "2026-05", amountCents: 1000, currency: "EUR",
        sourceRef: "INV-2002", estimatedUsdCents: 1000, invoicedFactsUsdCents: 0,
        invoiceUsdCents: 1250, driftCents: 200, driftUsdCents: 250, driftDisplayCents: 250,
      },
    ]);
  });

  it("drift converts to the org display currency; the invoice keeps its original", async () => {
    const set = await settingsPatchRoute(
      patchJson("/api/settings", { display_currency: "EUR" }, adminCookie),
    );
    expect(set.status).toBe(200);

    const report = await drift();
    expect(report.displayCurrency).toBe("EUR");
    const [acme, beta] = report.invoices;
    expect(acme.driftDisplayCents).toBe(544); // 680 USD / 1.25
    expect(beta.driftDisplayCents).toBe(200); // back to its own currency
    // Originals stay as billed (drill-downs show the original, spec 4).
    expect(acme).toMatchObject({ amountCents: 5000, currency: "USD", driftUsdCents: 680 });
    expect(beta).toMatchObject({ amountCents: 1000, currency: "EUR", driftUsdCents: 250 });

    await settingsPatchRoute(patchJson("/api/settings", { display_currency: "USD" }, adminCookie));
  });

  it("re-import corrects the month in place; zero drift removes the adjustment", async () => {
    const csv = `vendor,month,amount,currency,ref\n${VENDOR},2026-05,43.20,USD,INV-1001-FIX`;
    const res = await importRoute(postCsv("/api/invoices/import", csv, adminCookie));
    expect(res.status).toBe(200);
    expect((await res.json()).invoices[0]).toMatchObject({ driftCents: 0 });

    // Still one invoice row (vendor+month upserts), no adjustment fact left.
    const { rows } = await pool.query(
      "SELECT amount_cents::int AS cents, source_ref AS ref FROM invoices WHERE vendor = $1",
      [VENDOR],
    );
    expect(rows).toEqual([{ cents: 4320, ref: "INV-1001-FIX" }]);
    expect(await adjustmentRows(VENDOR)).toHaveLength(0);
    expect(await mayRollup(VENDOR)).toEqual([{ basis: "estimated", usd: 4320 }]);
    const report = await drift();
    expect(report.invoices.find((i: { vendor: string }) => i.vendor === VENDOR))
      .toMatchObject({ driftCents: 0, driftUsdCents: 0 });
  });

  it("a vendor billing less than estimated trues DOWN with a negative adjustment", async () => {
    const csv = `vendor,month,amount,currency\n${VENDOR},2026-05,40.00,USD`;
    const res = await importRoute(postCsv("/api/invoices/import", csv, adminCookie));
    expect(res.status).toBe(200);
    expect((await res.json()).invoices[0]).toMatchObject({ driftCents: -320 });
    expect(await adjustmentRows(VENDOR)).toMatchObject([
      { day: "2026-05-31", cents: -320, currency: "USD", basis: "invoiced" },
    ]);
    expect(await mayRollup(VENDOR)).toEqual([
      { basis: "estimated", usd: 4320 },
      { basis: "invoiced", usd: -320 },
    ]);
  });

  it("a sync that restates an invoiced month re-trues it automatically", async () => {
    // The vendor restates may_3 from $8.20 to $13.20 (spec 4: every sync
    // re-pulls the trailing days; vendors restate data).
    const synced = await runSync(VENDOR, {
      pool,
      fetch: replayFile(path.join(FIXTURES, "restate.json")).fetch,
      now: NOW,
      dataDir,
    });
    expect(synced.status).toBe("success");

    // May estimated is now 4820 against a $40.00 invoice: drift -820,
    // recomputed by the sync itself - no import call.
    expect(await adjustmentRows(VENDOR)).toMatchObject([
      { day: "2026-05-31", cents: -820, currency: "USD", basis: "invoiced" },
    ]);
    const { rows } = await pool.query(
      `SELECT amount_usd_cents::int AS usd FROM rollup_daily
       WHERE vendor = $1 AND day = '2026-05-31' AND cost_basis = 'invoiced'`,
      [VENDOR],
    );
    expect(rows).toEqual([{ usd: -820 }]);
    const report = await drift();
    expect(report.invoices.find((i: { vendor: string }) => i.vendor === VENDOR))
      .toMatchObject({ estimatedUsdCents: 4820, driftCents: -820, driftUsdCents: -820 });
  });

  it("refuses to true up over facts whose currency has no FX rate at all", async () => {
    await pool.query(
      `INSERT INTO spend_facts (day, vendor, tokens, amount_cents, currency, cost_basis, source_ref)
       VALUES ('2026-05-20', 'beta', 0, 500, 'SEK', 'estimated', 'beta:usage:2')`,
    );
    const csv = "vendor,month,amount,currency\nbeta,2026-05,11.00,EUR";
    const res = await importRoute(postCsv("/api/invoices/import", csv, adminCookie));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "cannot true up beta 2026-05: no FX rate for SEK - sync FX rates first",
    );
    // Atomic: the rejected import left the previous invoice untouched.
    const { rows } = await pool.query(
      "SELECT amount_cents::int AS cents FROM invoices WHERE vendor = 'beta'",
    );
    expect(rows).toEqual([{ cents: 1000 }]);

    // The drift report refuses too - no silently-skipped money.
    const broken = await invoicesRoute(getJson("/api/invoices", viewerCookie));
    expect(broken.status).toBe(409);

    await pool.query("DELETE FROM spend_facts WHERE source_ref = 'beta:usage:2'");
    expect((await invoicesRoute(getJson("/api/invoices", viewerCookie))).status).toBe(200);
  });

  it("import is admin-only; the report needs a session; ranges are validated", async () => {
    const csv = "vendor,month,amount,currency\nbeta,2026-05,10.00,EUR";
    expect((await importRoute(postCsv("/api/invoices/import", csv, viewerCookie))).status).toBe(403);
    expect((await importRoute(postCsv("/api/invoices/import", csv))).status).toBe(401);
    expect((await invoicesRoute(getJson("/api/invoices"))).status).toBe(401);
    expect((await invoicesRoute(getJson("/api/invoices?from=05-2026", viewerCookie))).status).toBe(400);

    // Month range bounds the report.
    const ranged = await invoicesRoute(getJson("/api/invoices?from=2026-05&to=2026-05", viewerCookie));
    expect((await ranged.json()).invoices).toHaveLength(2);
    const empty = await invoicesRoute(getJson("/api/invoices?to=2026-04", viewerCookie));
    expect((await empty.json()).invoices).toHaveLength(0);
  });
});
