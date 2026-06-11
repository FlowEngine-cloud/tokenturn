import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectConnector } from "../src/lib/connectors/connect";
import { clearConnectors, getConnector, registerConnector } from "../src/lib/connectors/registry";
import {
  checkSilentConnectors,
  schedulerTick,
} from "../src/lib/connectors/scheduler";
import { addDays, runSync, utcDay } from "../src/lib/connectors/sync";
import { clearEventListeners, emitEvent, onEvent, type AppEvents } from "../src/lib/events";
import { clearSecretKeyCache } from "../src/lib/secrets";
import { runMigrations } from "../scripts/migrate.mjs";
import { makeStubConnector } from "./helpers/fixture-connector";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

const HOUR = 3_600_000;

describe.runIf(TEST_DATABASE_URL)("hourly scheduler + silent alerts", () => {
  let dbUrl: string;
  let pool: Pool;
  let dataDir: string;
  // T0 tracks the real clock: sync_runs timestamps come from Postgres now(),
  // so test "nows" are offsets from real time, not a fully frozen calendar.
  const T0 = new Date();
  const stubA = makeStubConnector("stub_a");
  const stubB = makeStubConnector("stub_b");
  const stubC = makeStubConnector("stub_c");

  beforeAll(async () => {
    dbUrl = await createScratchDb("scheduler_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    pool = new Pool({ connectionString: dbUrl, max: 5 });
    dataDir = mkdtempSync(path.join(os.tmpdir(), "ai-pnl-scheduler-"));
    clearConnectors();
    registerConnector(stubA);
    registerConnector(stubB);
    registerConnector(stubC);
  });

  afterAll(async () => {
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
    clearConnectors();
    clearEventListeners();
    clearSecretKeyCache();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("re-registering a vendor replaces it (dev hot reload)", () => {
    const replacement = makeStubConnector("stub_a");
    registerConnector(replacement);
    expect(getConnector("stub_a")).toBe(replacement);
    registerConnector(stubA);
    expect(getConnector("stub_a")).toBe(stubA);
  });

  it("a tick syncs connected connectors only, starting with a full backfill", async () => {
    await connectConnector("stub_a", { apiKey: "k" }, { db: pool, dataDir });
    // stub_b stays unconnected, stub_c connected but never due for sync here

    const result = await schedulerTick({ pool, now: T0, dataDir });
    expect(result.synced.map((s) => `${s.vendor}:${s.status}`)).toEqual([
      "stub_a:success",
    ]);
    // First sync = backfill to the vendor's history limit (31 days).
    expect(stubA.windows).toEqual([
      { since: addDays(utcDay(T0), -31), until: utcDay(T0) },
    ]);
  });

  it("not due again within the hour", async () => {
    const result = await schedulerTick({
      pool,
      now: new Date(T0.getTime() + 10 * 60_000),
      dataDir,
    });
    expect(result.synced).toEqual([]);
    expect(stubA.windows).toHaveLength(1);
  });

  it("due again after an hour, now incremental with the 7-day re-pull", async () => {
    const now = new Date(T0.getTime() + 2 * HOUR);
    const result = await schedulerTick({ pool, now, dataDir });
    expect(result.synced.map((s) => s.vendor)).toEqual(["stub_a"]);
    expect(stubA.windows).toHaveLength(2);
    expect(stubA.windows[1]).toEqual({
      since: addDays(utcDay(now), -7),
      until: utcDay(now),
    });
  });

  it("a watermark older than 7 days catches up from where it left off", async () => {
    const now = new Date();
    const old = addDays(utcDay(now), -20);
    await pool.query(
      `UPDATE sync_runs SET cursor = $1 WHERE id = (
         SELECT id FROM sync_runs
         WHERE connector = 'stub_a' AND status = 'success'
         ORDER BY id DESC LIMIT 1)`,
      [JSON.stringify({ watermark: old })],
    );
    const result = await runSync("stub_a", { pool, now, dataDir });
    expect(result.status).toBe("success");
    expect(result.window).toEqual({ since: old, until: utcDay(now) });
  });

  it("emits connector.silent once per day when a connector goes quiet", async () => {
    const seen: AppEvents["connector.silent"][] = [];
    onEvent("connector.silent", (payload) => {
      seen.push(payload);
    });

    // Fresh success - not silent.
    expect(await checkSilentConnectors({ pool, now: new Date(), dataDir })).toEqual([]);
    expect(seen).toEqual([]);

    // 26h with no successful sync.
    const later = new Date(T0.getTime() + 26 * HOUR);
    expect(await checkSilentConnectors({ pool, now: later, dataDir })).toEqual(["stub_a"]);
    expect(seen).toHaveLength(1);
    expect(seen[0].vendor).toBe("stub_a");
    expect(seen[0].thresholdHours).toBe(24);
    expect(seen[0].lastSuccessAt).not.toBeNull();

    // Deduped: same day checks emit nothing more.
    expect(await checkSilentConnectors({ pool, now: later, dataDir })).toEqual([]);
    expect(seen).toHaveLength(1);
    const { rows } = await pool.query(
      "SELECT scope, period_key FROM alert_state WHERE kind = 'connector_silent'",
    );
    expect(rows).toEqual([{ scope: "stub_a", period_key: utcDay(later) }]);

    // Still silent the next day: a fresh alert.
    const nextDay = new Date(later.getTime() + 24 * HOUR);
    expect(await checkSilentConnectors({ pool, now: nextDay, dataDir })).toEqual(["stub_a"]);
    expect(seen).toHaveLength(2);
  });

  it("a connector that never synced counts silence from its connect time", async () => {
    await connectConnector("stub_c", { apiKey: "k" }, { db: pool, dataDir });
    await pool.query(
      "UPDATE connectors SET connected_at = now() - interval '25 hours' WHERE vendor = 'stub_c'",
    );

    const seen: AppEvents["connector.silent"][] = [];
    onEvent("connector.silent", (payload) => {
      seen.push(payload);
    });
    const emitted = await checkSilentConnectors({ pool, now: new Date(), dataDir });
    expect(emitted).toContain("stub_c");
    const event = seen.find((e) => e.vendor === "stub_c");
    expect(event).toMatchObject({ lastSuccessAt: null, thresholdHours: 24 });
  });

  it("the tick survives a connected vendor with no registered connector", async () => {
    await pool.query(
      "INSERT INTO connectors (vendor, history_limit_days) VALUES ('ghost_vendor', 31)",
    );
    const result = await schedulerTick({
      pool,
      now: new Date(T0.getTime() + 3 * HOUR),
      dataDir,
    });
    // ghost_vendor is skipped (warn), the registered ones still sync.
    expect(result.synced.map((s) => s.vendor)).not.toContain("ghost_vendor");
    expect(result.synced.map((s) => s.vendor)).toContain("stub_a");
  });

  it("event listeners can unsubscribe and never break the emitter", () => {
    let calls = 0;
    const off = onEvent("connector.silent", () => {
      calls += 1;
      throw new Error("listener exploded");
    });
    emitEvent("connector.silent", { vendor: "x", lastSuccessAt: null, thresholdHours: 24 });
    expect(calls).toBe(1);
    off();
    emitEvent("connector.silent", { vendor: "x", lastSuccessAt: null, thresholdHours: 24 });
    expect(calls).toBe(1);
  });
});
