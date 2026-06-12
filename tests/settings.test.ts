import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearSecretKeyCache } from "../src/lib/secrets";
import {
  SETTING_DEFAULTS,
  deleteSetting,
  getAllSettings,
  getSecretSetting,
  getSetting,
  setSecretSetting,
  setSetting,
} from "../src/lib/settings";
import { runMigrations } from "../scripts/migrate.mjs";
import {
  TEST_DATABASE_URL,
  createScratchDb,
  dropScratchDb,
} from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

describe.runIf(TEST_DATABASE_URL)("settings service", () => {
  let dbUrl: string;
  let pool: Pool;
  let dataDir: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("settings_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    pool = new Pool({ connectionString: dbUrl, max: 3 });
    dataDir = mkdtempSync(path.join(os.tmpdir(), "ai-pnl-settings-"));
  });

  afterAll(async () => {
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
    clearSecretKeyCache();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns the plan's defaults when nothing is set", async () => {
    expect(await getSetting("display_currency", pool)).toBe("USD");
    expect(await getSetting("revert_window_days", pool)).toBe(30);
    expect(await getSetting("anomaly_min_day_cents", pool)).toBe(2000);
    expect(await getSetting("limit_alert_thresholds_pct", pool)).toEqual([80, 100]);
    expect(await getSetting("raw_facts_retention_months", pool)).toBe(13);
    expect(await getSetting("update_check_enabled", pool)).toBe(false);
    expect(await getSetting("anomaly_enabled", pool)).toBe(true);
    expect(await getSetting("alert_email_recipients", pool)).toEqual([]);
  });

  it("set / get / delete round-trips through the DB", async () => {
    await setSetting("display_currency", "EUR", pool);
    expect(await getSetting("display_currency", pool)).toBe("EUR");

    await setSetting("limit_alert_thresholds_pct", [50, 80, 100], pool);
    expect(await getSetting("limit_alert_thresholds_pct", pool)).toEqual([50, 80, 100]);

    await setSetting("update_check_enabled", true, pool);
    expect(await getSetting("update_check_enabled", pool)).toBe(true);

    // overwrite, then delete falls back to the default
    await setSetting("display_currency", "GBP", pool);
    expect(await getSetting("display_currency", pool)).toBe("GBP");
    await deleteSetting("display_currency", pool);
    expect(await getSetting("display_currency", pool)).toBe("USD");
  });

  it("getAllSettings merges DB values over defaults", async () => {
    const all = await getAllSettings(pool);
    expect(all).toEqual({
      ...SETTING_DEFAULTS,
      limit_alert_thresholds_pct: [50, 80, 100],
      update_check_enabled: true,
    });
  });

  it("secrets are encrypted at rest and decrypt back", async () => {
    const webhook = "https://hooks.slack.com/services/T000/B000/supersecret";
    await setSecretSetting("slack_webhook_url", webhook, pool, dataDir);

    // raw row: flagged secret, ciphertext only - the plaintext is nowhere
    const { rows } = await pool.query(
      "SELECT value, secret FROM settings WHERE key = 'slack_webhook_url'",
    );
    expect(rows[0].secret).toBe(true);
    expect(typeof rows[0].value).toBe("string");
    expect(rows[0].value.startsWith("v1:")).toBe(true);
    expect(JSON.stringify(rows[0].value)).not.toContain("supersecret");

    expect(await getSecretSetting("slack_webhook_url", pool, dataDir)).toBe(webhook);

    // rotation: overwrite with a new value
    await setSecretSetting("slack_webhook_url", "https://example.com/new", pool, dataDir);
    expect(await getSecretSetting("slack_webhook_url", pool, dataDir)).toBe(
      "https://example.com/new",
    );
  });

  it("unset secrets are null and the secret flag is enforced both ways", async () => {
    expect(await getSecretSetting("never_set", pool, dataDir)).toBeNull();
    await expect(getSecretSetting("update_check_enabled", pool, dataDir)).rejects.toThrow(
      /not a secret/,
    );
    await expect(
      getSetting("slack_webhook_url" as never, pool),
    ).rejects.toThrow(/is a secret/);
  });
});
