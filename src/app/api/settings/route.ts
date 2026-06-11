import { badRequest, conflict, readJson, requireAdmin, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { unknownCurrencies } from "@/lib/fx";
import { logger } from "@/lib/logger";
import {
  getAllSettings,
  setSetting,
  SETTING_DEFAULTS,
  type SettingKey,
  type SettingValues,
} from "@/lib/settings";

export const dynamic = "force-dynamic";

/** All typed settings, DB values merged over the plan's defaults. */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;
  return Response.json({ settings: await getAllSettings(db) });
}

const posInt = (min: number) => (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) && v >= min;

/** Per-key validation; false = reject with the key's expectation. */
const VALIDATORS: { [K in SettingKey]: (v: unknown) => boolean } = {
  display_currency: (v) => typeof v === "string" && /^[A-Z]{3}$/.test(v),
  revert_window_days: posInt(1),
  anomaly_burn_multiplier: (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
  anomaly_min_day_cents: posInt(0),
  limit_alert_thresholds_pct: (v) =>
    Array.isArray(v) && v.length > 0 && v.every((t) => posInt(1)(t) && t <= 100),
  raw_facts_retention_months: posInt(1),
  connector_silent_alert_hours: posInt(1),
  update_check_enabled: (v) => typeof v === "boolean",
};

const EXPECTATIONS: { [K in SettingKey]: string } = {
  display_currency: "a 3-letter currency code like USD",
  revert_window_days: "a whole number of days >= 1",
  anomaly_burn_multiplier: "a number > 0",
  anomaly_min_day_cents: "a whole number of cents >= 0",
  limit_alert_thresholds_pct: "a non-empty array of percentages (1-100)",
  raw_facts_retention_months: "a whole number of months >= 1",
  connector_silent_alert_hours: "a whole number of hours >= 1",
  update_check_enabled: "true or false",
};

function isSettingKey(key: string): key is SettingKey {
  return key in SETTING_DEFAULTS;
}

/**
 * Update settings (admin). Body = a partial object of typed keys; every key
 * is validated, and the display currency must be one we can actually convert
 * to - no fake numbers from a currency with no FX rates.
 */
export async function PATCH(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const body = await readJson(req);
  if (!body || Object.keys(body).length === 0) {
    return badRequest("pass at least one setting to change");
  }
  for (const [key, value] of Object.entries(body)) {
    if (!isSettingKey(key)) return badRequest(`unknown setting ${key}`);
    if (!VALIDATORS[key](value)) {
      return badRequest(`${key} must be ${EXPECTATIONS[key]}`);
    }
  }
  if (typeof body.display_currency === "string") {
    const unknown = await unknownCurrencies([body.display_currency], db);
    if (unknown.length > 0) {
      return conflict(
        `no FX rate for ${body.display_currency} yet - sync FX rates first`,
      );
    }
  }

  for (const [key, value] of Object.entries(body)) {
    await setSetting(key as SettingKey, value as SettingValues[SettingKey], db);
  }
  logger.info("settings updated", { keys: Object.keys(body) });
  return Response.json({ settings: await getAllSettings(db) });
}
