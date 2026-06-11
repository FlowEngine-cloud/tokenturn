import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as fxRoute } from "../src/app/api/fx/route";
import { POST as fxSyncRoute } from "../src/app/api/fx/sync/route";
import { GET as settingsGetRoute, PATCH as settingsPatchRoute } from "../src/app/api/settings/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { closePool } from "../src/lib/db";
import {
  FX_RETRY_MS,
  FX_SYNC_INTERVAL_MS,
  fxDue,
  fxTick,
  syncFxRates,
} from "../src/lib/fx";
import { recomputeRollups } from "../src/lib/rollup";
import { runMigrations } from "../scripts/migrate.mjs";
import { getJson, patchJson } from "./helpers/http";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";
import { replayFile } from "./helpers/replay";

/**
 * Money correctness (spec section 4): daily ECB FX rates land in fx_rates as
 * USD-per-unit rates, restated/new days upsert in place, format drift fails
 * the run loudly instead of writing bad rates, the fetched rates drive the
 * rollup's USD normalization end to end, and the org display currency is a
 * validated setting - never a currency we cannot actually convert to.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const FIXTURES = path.resolve(__dirname, "fixtures", "fx");

const fixture = (name: string) => path.join(FIXTURES, `${name}.json`);

describe.runIf(TEST_DATABASE_URL)("ECB FX rates (spec 4)", () => {
  let dbUrl: string;
  let pool: Pool;
  let adminCookie: string;
  let viewerCookie: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("fx_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 5 });

    const { rows: admins } = await pool.query(
      "INSERT INTO users (name, role) VALUES ('Admin', 'admin') RETURNING id",
    );
    adminCookie = `${SESSION_COOKIE}=${(await createSession(admins[0].id, pool)).token}`;
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

  async function rateRows() {
    const { rows } = await pool.query(
      `SELECT day::text AS day, currency, usd_rate::float8 AS rate
       FROM fx_rates ORDER BY day, currency`,
    );
    return rows as { day: string; currency: string; rate: number }[];
  }

  it("fetches the ECB feed and stores USD-per-unit rates for every day and currency", async () => {
    const session = replayFile(fixture("ecb-ok"));
    const result = await syncFxRates({ pool, fetch: session.fetch });
    expect(result).toMatchObject({
      skipped: false,
      status: "success",
      rowsSynced: 6,
      latestDay: "2026-06-10",
    });
    expect(session.remaining()).toHaveLength(0);

    // EUR-based input becomes USD-per-unit: rate(C) = rate(USD) / rate(C),
    // EUR itself = rate(USD). USD never needs a row.
    expect(await rateRows()).toEqual([
      { day: "2026-06-09", currency: "EUR", rate: 1.25 },
      { day: "2026-06-09", currency: "GBP", rate: 1.5625 },
      { day: "2026-06-09", currency: "JPY", rate: 0.008 },
      { day: "2026-06-10", currency: "EUR", rate: 1.1 },
      { day: "2026-06-10", currency: "GBP", rate: 1.25 },
      { day: "2026-06-10", currency: "JPY", rate: 0.008 },
    ]);

    const { rows: runs } = await pool.query(
      "SELECT connector, status, rows_synced::int AS rows, cursor FROM sync_runs ORDER BY id DESC LIMIT 1",
    );
    expect(runs[0]).toMatchObject({ connector: "ecb_fx", status: "success", rows: 6 });
    expect(JSON.parse(runs[0].cursor)).toEqual({ latestDay: "2026-06-10" });
  });

  it("re-fetching upserts in place: restated days correct, new days append", async () => {
    const result = await syncFxRates({ pool, fetch: replayFile(fixture("ecb-restated")).fetch });
    expect(result).toMatchObject({ status: "success", rowsSynced: 6, latestDay: "2026-06-11" });

    const rows = await rateRows();
    expect(rows).toHaveLength(9);
    // 2026-06-10 restated in place...
    expect(rows.filter((r) => r.day === "2026-06-10")).toEqual([
      { day: "2026-06-10", currency: "EUR", rate: 1.2 },
      { day: "2026-06-10", currency: "GBP", rate: 1.25 },
      { day: "2026-06-10", currency: "JPY", rate: 0.008 },
    ]);
    // ...2026-06-09 untouched, 2026-06-11 appended.
    expect(rows.filter((r) => r.day === "2026-06-09").map((r) => r.rate)).toEqual([
      1.25, 1.5625, 0.008,
    ]);
    expect(rows.filter((r) => r.day === "2026-06-11")).toEqual([
      { day: "2026-06-11", currency: "EUR", rate: 1.25 },
      { day: "2026-06-11", currency: "GBP", rate: 1.25 },
      { day: "2026-06-11", currency: "JPY", rate: 0.01 },
    ]);
  });

  it("format drift fails the run verbatim and writes nothing", async () => {
    for (const [name, message] of [
      ["ecb-drift", 'ECB feed: bad rate "N/A" for GBP on 2026-06-10'],
      ["ecb-no-usd", "ECB feed: no USD rate on 2026-06-10"],
      ["ecb-down", "ECB feed: no rate days found - format drift?"],
    ] as const) {
      const result = await syncFxRates({ pool, fetch: replayFile(fixture(name)).fetch });
      expect(result.status).toBe("error");
      expect(result.error).toBe(message);
      const { rows } = await pool.query(
        "SELECT error FROM sync_runs WHERE connector = 'ecb_fx' ORDER BY id DESC LIMIT 1",
      );
      expect(rows[0].error).toBe(message);
    }
    // The good rates from the earlier fetches are untouched.
    expect(await rateRows()).toHaveLength(9);
  });

  it("fxTick fetches on the daily cadence: fresh = skip, stale or failed = due", async () => {
    // Last run above is an error. Within the retry window: not due.
    const { rows } = await pool.query(
      "SELECT started_at FROM sync_runs WHERE connector = 'ecb_fx' ORDER BY id DESC LIMIT 1",
    );
    const lastStart = new Date(rows[0].started_at).getTime();
    expect(await fxDue(pool, new Date(lastStart + FX_RETRY_MS / 2))).toBe(false);
    expect(await fxTick({ pool, now: new Date(lastStart + FX_RETRY_MS / 2) })).toBeNull();
    // An hour after a failure: due again.
    expect(await fxDue(pool, new Date(lastStart + FX_RETRY_MS + 1000))).toBe(true);

    const ticked = await fxTick({
      pool,
      fetch: replayFile(fixture("ecb-ok")).fetch,
      now: new Date(lastStart + FX_RETRY_MS + 1000),
    });
    expect(ticked).toMatchObject({ status: "success" });

    // After a success: quiet until the interval passes.
    const { rows: latest } = await pool.query(
      "SELECT started_at FROM sync_runs WHERE connector = 'ecb_fx' ORDER BY id DESC LIMIT 1",
    );
    const successStart = new Date(latest[0].started_at).getTime();
    expect(await fxDue(pool, new Date(successStart + FX_SYNC_INTERVAL_MS / 2))).toBe(false);
    expect(await fxDue(pool, new Date(successStart + FX_SYNC_INTERVAL_MS + 1000))).toBe(true);
  });

  it("fetched rates drive the rollup's USD normalization", async () => {
    // ecb-ok re-fetched last, so GBP on 2026-06-10 is back to 1.25 USD.
    await pool.query(
      `INSERT INTO spend_facts (day, vendor, tokens, amount_cents, currency, cost_basis, source_ref)
       VALUES ('2026-06-10', 'fxdemo', 0, 800, 'GBP', 'estimated', 'fxdemo:1')`,
    );
    await recomputeRollups({ from: "2026-06-10", to: "2026-06-10" }, pool);
    const { rows } = await pool.query(
      `SELECT amount_usd_cents::int AS usd FROM rollup_daily
       WHERE vendor = 'fxdemo' AND day = '2026-06-10'`,
    );
    expect(rows[0].usd).toBe(1000);
  });

  it("GET /api/fx reports coverage and the last run; POST /api/fx/sync is admin-only", async () => {
    const status = await fxRoute(getJson("/api/fx", viewerCookie));
    expect(status.status).toBe(200);
    const { fx } = await status.json();
    expect(fx.latestDay).toBe("2026-06-11");
    expect(fx.currencies).toBe(3);
    expect(fx.lastRun).toMatchObject({ status: "success", rowsSynced: 6, error: null });

    expect((await fxRoute(getJson("/api/fx"))).status).toBe(401);
    const forbidden = await fxSyncRoute(
      new Request("http://localhost:3000/api/fx/sync", {
        method: "POST",
        headers: { cookie: viewerCookie },
      }),
    );
    expect(forbidden.status).toBe(403);

    // The route uses the real global fetch; serve it the recording.
    vi.stubGlobal("fetch", replayFile(fixture("ecb-ok")).fetch);
    try {
      const synced = await fxSyncRoute(
        new Request("http://localhost:3000/api/fx/sync", {
          method: "POST",
          headers: { cookie: adminCookie },
        }),
      );
      expect(synced.status).toBe(200);
      expect((await synced.json()).run).toMatchObject({
        status: "success",
        rowsSynced: 6,
        latestDay: "2026-06-10",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("display currency: viewer-readable, admin-set, and only convertible currencies", async () => {
    expect((await settingsGetRoute(getJson("/api/settings"))).status).toBe(401);

    const initial = await settingsGetRoute(getJson("/api/settings", viewerCookie));
    expect(initial.status).toBe(200);
    expect((await initial.json()).settings.display_currency).toBe("USD");

    expect(
      (await settingsPatchRoute(patchJson("/api/settings", { display_currency: "EUR" }, viewerCookie)))
        .status,
    ).toBe(403);

    for (const [body, status, error] of [
      [{ display_currency: "eur" }, 400, "display_currency must be a 3-letter currency code like USD"],
      [{ bogus: 1 }, 400, "unknown setting bogus"],
      [{ limit_alert_thresholds_pct: [0] }, 400, "limit_alert_thresholds_pct must be a non-empty array of percentages (1-100)"],
      [{}, 400, "pass at least one setting to change"],
      // No CHF rate ever fetched: refusing beats charts full of unconvertible numbers.
      [{ display_currency: "CHF" }, 409, "no FX rate for CHF yet - sync FX rates first"],
    ] as const) {
      const res = await settingsPatchRoute(patchJson("/api/settings", body, adminCookie));
      expect(res.status).toBe(status);
      expect((await res.json()).error).toBe(error);
    }

    const updated = await settingsPatchRoute(
      patchJson("/api/settings", { display_currency: "EUR", revert_window_days: 14 }, adminCookie),
    );
    expect(updated.status).toBe(200);
    expect((await updated.json()).settings).toMatchObject({
      display_currency: "EUR",
      revert_window_days: 14,
    });
    const after = await settingsGetRoute(getJson("/api/settings", viewerCookie));
    expect((await after.json()).settings.display_currency).toBe("EUR");
  });
});
