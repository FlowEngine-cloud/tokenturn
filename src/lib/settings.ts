import { getPool, type Db } from "./db";
import { decryptSecret, encryptSecret, loadOrCreateSecretKey } from "./secrets";

/**
 * Settings service. All config lives in the settings table (DATABASE_URL is
 * the only env var, spec 12b). Typed keys below carry every numeric default
 * in the plan; secret values (vendor tokens, webhooks, email provider keys)
 * go through the *SecretSetting functions and are encrypted at rest.
 */

export type { Db };

export interface SettingValues {
  /** Org display currency for charts; drill-downs show the original. */
  display_currency: string;
  /** Days a revert can flip a merged PR before it's final (spec 5). */
  revert_window_days: number;
  /** Anomaly alerts on/off (spec 10.6 Alerts); the two numbers below. */
  anomaly_enabled: boolean;
  /** Anomaly: daily burn >= multiplier x trailing 30-day average (spec 9). */
  anomaly_burn_multiplier: number;
  /** Anomaly: and daily burn >= this many USD cents (spec 9: $20). */
  anomaly_min_day_cents: number;
  /** Where alerts go besides Slack: email recipients (spec 10.6 Alerts). */
  alert_email_recipients: string[];
  /** Spend-limit alert thresholds, % of the monthly limit (spec 9). */
  limit_alert_thresholds_pct: number[];
  /** Raw per-request facts retention; rollups keep forever (spec 4). */
  raw_facts_retention_months: number;
  /** A connector silent this long fires a Slack alert (spec 5). */
  connector_silent_alert_hours: number;
  /** "New version available" check against GitHub releases - opt-in. */
  update_check_enabled: boolean;
}

export type SettingKey = keyof SettingValues;

export const SETTING_DEFAULTS: SettingValues = {
  display_currency: "USD",
  revert_window_days: 30,
  anomaly_enabled: true,
  anomaly_burn_multiplier: 3,
  anomaly_min_day_cents: 2000,
  alert_email_recipients: [],
  limit_alert_thresholds_pct: [80, 100],
  raw_facts_retention_months: 13,
  connector_silent_alert_hours: 24,
  update_check_enabled: false,
};

export async function getSetting<K extends SettingKey>(
  key: K,
  db: Db = getPool(),
): Promise<SettingValues[K]> {
  const { rows } = await db.query(
    "SELECT value, secret FROM settings WHERE key = $1",
    [key],
  );
  if (rows.length === 0) return SETTING_DEFAULTS[key];
  if (rows[0].secret) {
    throw new Error(`setting ${key} is a secret; use getSecretSetting`);
  }
  return rows[0].value as SettingValues[K];
}

export async function setSetting<K extends SettingKey>(
  key: K,
  value: SettingValues[K],
  db: Db = getPool(),
): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value, secret)
     VALUES ($1, $2::jsonb, false)
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, secret = false, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

/** Remove a setting row; typed keys fall back to their default. */
export async function deleteSetting(
  key: string,
  db: Db = getPool(),
): Promise<void> {
  await db.query("DELETE FROM settings WHERE key = $1", [key]);
}

/** All typed settings, DB values merged over defaults (for the Settings page). */
export async function getAllSettings(db: Db = getPool()): Promise<SettingValues> {
  const keys = Object.keys(SETTING_DEFAULTS);
  const { rows } = await db.query(
    "SELECT key, value FROM settings WHERE key = ANY($1) AND secret = false",
    [keys],
  );
  const merged = { ...SETTING_DEFAULTS };
  for (const row of rows) {
    (merged as Record<string, unknown>)[row.key as string] = row.value;
  }
  return merged;
}

/**
 * Secret settings the Settings API can set or clear by key (vendor
 * connector configs go through the connect flow instead). Write-only:
 * the API only ever reports whether one is configured, never the value.
 */
export const SECRET_SETTING_KEYS = [
  "slack_webhook_url",
  "email_provider_config",
] as const;
export type SecretSettingKey = (typeof SECRET_SETTING_KEYS)[number];

export async function secretSettingsPresence(
  db: Db = getPool(),
): Promise<Record<SecretSettingKey, boolean>> {
  const { rows } = await db.query(
    "SELECT key FROM settings WHERE key = ANY($1) AND secret = true",
    [[...SECRET_SETTING_KEYS]],
  );
  const present = new Set(rows.map((r) => r.key as string));
  return Object.fromEntries(
    SECRET_SETTING_KEYS.map((key) => [key, present.has(key)]),
  ) as Record<SecretSettingKey, boolean>;
}

/**
 * Store a secret (vendor token, Slack webhook, email provider key).
 * Encrypted with the data-volume key before it touches the DB - the
 * plaintext is never stored anywhere.
 */
export async function setSecretSetting(
  key: string,
  plaintext: string,
  db: Db = getPool(),
  dataDir?: string,
): Promise<void> {
  const token = encryptSecret(plaintext, loadOrCreateSecretKey(dataDir));
  await db.query(
    `INSERT INTO settings (key, value, secret)
     VALUES ($1, $2::jsonb, true)
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, secret = true, updated_at = now()`,
    [key, JSON.stringify(token)],
  );
}

/** Decrypt and return a secret setting, or null when unset. */
export async function getSecretSetting(
  key: string,
  db: Db = getPool(),
  dataDir?: string,
): Promise<string | null> {
  const { rows } = await db.query(
    "SELECT value, secret FROM settings WHERE key = $1",
    [key],
  );
  if (rows.length === 0) return null;
  if (!rows[0].secret) {
    throw new Error(`setting ${key} is not a secret; use getSetting`);
  }
  return decryptSecret(rows[0].value as string, loadOrCreateSecretKey(dataDir));
}
