import { APP_NAME } from "./brand";
import { getPool, type Db } from "./db";
import { onEvent, type AppEvents } from "./events";
import { logger } from "./logger";
import { getSecretSetting } from "./settings";

/**
 * Slack alert channel (spec 9 / 12b: alerts default to the Slack webhook).
 * The webhook URL is a secret setting (slack_webhook_url), encrypted at
 * rest like vendor tokens and edited in Settings.
 *
 * registerAlertSink subscribes to the alert events (limit thresholds, burn
 * anomalies, silent connectors) and posts one plain-text message per event.
 * Delivery is best-effort and never throws: dedupe already happened in
 * alert_state before the event fired, and a sink failure must never break
 * a sync. No webhook configured = the alert is logged and skipped.
 */

export const SLACK_WEBHOOK_SETTING = "slack_webhook_url";

export interface AlertSinkOpts {
  db?: Db;
  /** Secrets-key directory override (tests). */
  dataDir?: string;
  fetch?: typeof fetch;
}

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

export function formatLimitAlert(p: AppEvents["limit.threshold"]): string {
  const who = p.name ? `${p.name} (${p.email})` : p.email;
  const base =
    `${who} hit ${p.thresholdPct}% of their ${usd(p.limitUsdCents)} ` +
    `monthly AI limit: ${usd(p.monthSpendUsdCents)} spent in ${p.month}.`;
  // Never pretend to hard-stop what we can't (spec 9).
  return p.thresholdPct >= 100
    ? `${base} ${APP_NAME} does not hard-stop spend - check vendor-side limits.`
    : base;
}

export function formatAnomalyAlert(p: AppEvents["burn.anomaly"]): string {
  const who = p.name ? `${p.name} (${p.email})` : p.email;
  const avg =
    p.trailingAvgUsdCents > 0
      ? `${(p.dayUsdCents / p.trailingAvgUsdCents).toFixed(1)}x their 30-day average of ${usd(p.trailingAvgUsdCents)}/day`
      : "with no spend in the past 30 days";
  return `Burn anomaly: ${who} spent ${usd(p.dayUsdCents)} on ${p.day} - ${avg}.`;
}

export function formatConnectorSilentAlert(
  p: AppEvents["connector.silent"],
): string {
  const since = p.lastSuccessAt
    ? `last successful sync ${p.lastSuccessAt}`
    : "never synced since connect";
  return `Connector ${p.vendor} has been silent for over ${p.thresholdHours}h (${since}).`;
}

export type SlackDelivery = "sent" | "skipped" | "failed";

/**
 * Post one message to the configured webhook. Returns the outcome instead
 * of throwing - callers (event listeners) must be unbreakable.
 */
export async function postSlack(
  text: string,
  opts: AlertSinkOpts = {},
): Promise<SlackDelivery> {
  const db = opts.db ?? getPool();
  const fetchImpl = opts.fetch ?? fetch;
  try {
    const webhook = await getSecretSetting(SLACK_WEBHOOK_SETTING, db, opts.dataDir);
    if (webhook === null) {
      logger.info("no slack webhook configured, alert not delivered", { text });
      return "skipped";
    }
    const res = await fetchImpl(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      logger.error("slack webhook rejected alert", {
        status: res.status,
        body: (await res.text()).slice(0, 500),
        text,
      });
      return "failed";
    }
    logger.info("slack alert sent", { text });
    return "sent";
  } catch (err) {
    logger.error("slack alert delivery failed", { error: err, text });
    return "failed";
  }
}

let active: (() => void) | null = null;

/**
 * Subscribe the Slack sink to every alert event (idempotent - a second
 * registration is a no-op until the first is unsubscribed). Returns an
 * unsubscribe function; the boot path registers once and never does.
 */
export function registerAlertSink(opts: AlertSinkOpts = {}): () => void {
  if (active) return active;
  const offs = [
    onEvent("limit.threshold", async (p) => {
      await postSlack(formatLimitAlert(p), opts);
    }),
    onEvent("burn.anomaly", async (p) => {
      await postSlack(formatAnomalyAlert(p), opts);
    }),
    onEvent("connector.silent", async (p) => {
      await postSlack(formatConnectorSilentAlert(p), opts);
    }),
  ];
  const off = () => {
    for (const unsubscribe of offs) unsubscribe();
    if (active === off) active = null;
  };
  active = off;
  return off;
}
