import {
  getScheduledReportsConfig,
  SCHEDULED_REPORTS_SETTING,
  setScheduledReportsConfig,
  validateScheduledReportsConfig,
} from "@ee/lib/scheduled-reports";
import { badRequest, conflict, readJson, requireAdmin, requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getPool } from "@/lib/db";
import {
  clearLicenseFile,
  LICENSE_SETTING,
  LicenseError,
  licenseStatus,
  requireEeFeature,
  setLicenseFile,
} from "@/lib/license";
import {
  EMAIL_CONFIG_SETTING,
  emailSummary,
  setEmailConfig,
  validateEmailConfig,
} from "@/lib/email";
import { unknownCurrencies } from "@/lib/fx";
import { logger } from "@/lib/logger";
import { ResolveError } from "@/lib/resolve";
import {
  deleteSetting,
  getAllSettings,
  SECRET_SETTING_KEYS,
  secretSettingsPresence,
  setSecretSetting,
  setSetting,
  SETTING_DEFAULTS,
  type SecretSettingKey,
  type SettingKey,
  type SettingValues,
} from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * All typed settings (DB values merged over the plan's defaults) plus, for
 * each secret setting (the Slack webhook, the email provider), whether one
 * is configured - never the value. The email provider additionally reports
 * its provider name and from address; credentials never leave the server.
 */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;
  return Response.json({
    settings: await getAllSettings(db),
    secrets: await secretSettingsPresence(db),
    email: await emailSummary({ db }),
    license: await licenseStatus(db),
    scheduledReports: await getScheduledReportsConfig(db),
  });
}

const posInt = (min: number) => (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) && v >= min;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Per-key validation; false = reject with the key's expectation. */
const VALIDATORS: { [K in SettingKey]: (v: unknown) => boolean } = {
  display_currency: (v) => typeof v === "string" && /^[A-Z]{3}$/.test(v),
  revert_window_days: posInt(1),
  anomaly_enabled: (v) => typeof v === "boolean",
  anomaly_burn_multiplier: (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
  anomaly_min_day_cents: posInt(0),
  alert_email_recipients: (v) =>
    Array.isArray(v) && v.every((r) => typeof r === "string" && EMAIL_RE.test(r)),
  limit_alert_thresholds_pct: (v) =>
    Array.isArray(v) && v.length > 0 && v.every((t) => posInt(1)(t) && t <= 100),
  raw_facts_retention_months: posInt(1),
  connector_silent_alert_hours: posInt(1),
  update_check_enabled: (v) => typeof v === "boolean",
};

const EXPECTATIONS: { [K in SettingKey]: string } = {
  display_currency: "a 3-letter currency code like USD",
  revert_window_days: "a whole number of days >= 1",
  anomaly_enabled: "true or false",
  anomaly_burn_multiplier: "a number > 0",
  anomaly_min_day_cents: "a whole number of cents >= 0",
  alert_email_recipients: "an array of email addresses",
  limit_alert_thresholds_pct: "a non-empty array of percentages (1-100)",
  raw_facts_retention_months: "a whole number of months >= 1",
  connector_silent_alert_hours: "a whole number of hours >= 1",
  update_check_enabled: "true or false",
};

function isSettingKey(key: string): key is SettingKey {
  return key in SETTING_DEFAULTS;
}

function isSecretSettingKey(key: string): key is SecretSettingKey {
  return (SECRET_SETTING_KEYS as readonly string[]).includes(key);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Update settings (admin). Body = a partial object of typed keys; every key
 * is validated, and the display currency must be one we can actually convert
 * to - no fake numbers from a currency with no FX rates. Secret keys take a
 * value to set (encrypted at rest, never echoed back) or null to clear: the
 * Slack webhook (spec 9) takes an https URL, the email provider config
 * (spec 12b) takes { provider, from, ...that provider's fields } - SMTP:
 * host+port+username+password; SES: accessKeyId+secretAccessKey+region;
 * Resend/Postmark/Mailgun: apiKey.
 */
export async function PATCH(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const body = await readJson(req);
  if (!body || Object.keys(body).length === 0) {
    return badRequest("pass at least one setting to change");
  }
  try {
    for (const [key, value] of Object.entries(body)) {
      if (key === LICENSE_SETTING) {
        // Verified offline against the pinned key (spec 11); a file that
        // does not verify is rejected before anything is stored.
        if (value !== null && typeof value !== "string") {
          return badRequest("license_file must be the license file text, or null to clear it");
        }
        continue;
      }
      if (key === SCHEDULED_REPORTS_SETTING) {
        // Enterprise (spec 11): writing the schedule needs the license.
        const locked = await requireEeFeature("scheduled_reports", db);
        if (locked) return locked;
        validateScheduledReportsConfig(value); // throws ResolveError
        continue;
      }
      if (key === EMAIL_CONFIG_SETTING) {
        if (value !== null) validateEmailConfig(value); // throws ResolveError
        continue;
      }
      if (isSecretSettingKey(key)) {
        if (value !== null && !(typeof value === "string" && isHttpsUrl(value))) {
          return badRequest(`${key} must be an https:// URL, or null to clear it`);
        }
        continue;
      }
      if (!isSettingKey(key)) return badRequest(`unknown setting ${key}`);
      if (!VALIDATORS[key](value)) {
        return badRequest(`${key} must be ${EXPECTATIONS[key]}`);
      }
    }
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
  if (typeof body.display_currency === "string") {
    const unknown = await unknownCurrencies([body.display_currency], db);
    if (unknown.length > 0) {
      return conflict(
        `no FX rate for ${body.display_currency} yet - sync FX rates first`,
      );
    }
  }

  const audited: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === LICENSE_SETTING) {
      try {
        if (value === null) {
          await clearLicenseFile(db);
          audited[key] = "cleared";
        } else {
          const payload = await setLicenseFile(value as string, db);
          audited[key] = { org: payload.org, expiresAt: payload.expires_at };
        }
      } catch (error) {
        if (error instanceof LicenseError) return badRequest(error.message);
        throw error;
      }
    } else if (key === SCHEDULED_REPORTS_SETTING) {
      await setScheduledReportsConfig(validateScheduledReportsConfig(value), db);
      audited[key] = value;
    } else if (key === EMAIL_CONFIG_SETTING) {
      await setEmailConfig(value === null ? null : validateEmailConfig(value), { db });
      audited[key] = value === null ? "cleared" : "replaced";
    } else if (isSecretSettingKey(key)) {
      if (value === null) await deleteSetting(key, db);
      else await setSecretSetting(key, value as string, db);
      // Secrets never reach the audit detail - presence only.
      audited[key] = value === null ? "cleared" : "replaced";
    } else {
      await setSetting(key as SettingKey, value as SettingValues[SettingKey], db);
      audited[key] = value;
    }
  }
  logger.info("settings updated", { keys: Object.keys(body) });
  await audit(admin, "settings.update", audited, db);
  return Response.json({
    settings: await getAllSettings(db),
    secrets: await secretSettingsPresence(db),
    email: await emailSummary({ db }),
    license: await licenseStatus(db),
    scheduledReports: await getScheduledReportsConfig(db),
  });
}
