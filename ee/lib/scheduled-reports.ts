import { audit } from "@/lib/audit";
import { APP_NAME } from "@/lib/brand";
import { getPool, type Db } from "@/lib/db";
import { emailSummary, isEmailAddress, sendEmail, type EmailOpts } from "@/lib/email";
import { formatCents, formatPct } from "@/lib/format";
import { eeFeatureEnabled } from "@/lib/license";
import { logger } from "@/lib/logger";
import { addMonths, currentMonth, reportData, type ReportData } from "@/lib/report";
import { ResolveError } from "@/lib/resolve";
import { buildPdf, type PdfLine } from "./pdf";

/**
 * Scheduled reports (spec 11, enterprise): once a month, the CFO report for
 * the month that just closed goes out as a PDF email to the configured
 * recipients. Part of ee/ - commercial license (see ee/LICENSE).
 *
 * The check rides the scheduler tick; alert_state dedupes to exactly one
 * send per month (marked only after at least one recipient got it, so a
 * down provider retries next tick). Requires the outbound email provider
 * from Settings - nothing here stores credentials.
 */

export const SCHEDULED_REPORTS_SETTING = "scheduled_reports";

export interface ScheduledReportsConfig {
  enabled: boolean;
  recipients: string[];
}

const DEFAULT_CONFIG: ScheduledReportsConfig = { enabled: false, recipients: [] };

export function validateScheduledReportsConfig(raw: unknown): ScheduledReportsConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ResolveError("scheduled_reports must be { enabled, recipients }", 400);
  }
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).find((k) => k !== "enabled" && k !== "recipients");
  if (extra !== undefined) {
    throw new ResolveError(`unknown scheduled_reports field ${extra}`, 400);
  }
  if (typeof r.enabled !== "boolean") {
    throw new ResolveError("enabled must be true or false", 400);
  }
  if (!Array.isArray(r.recipients) || r.recipients.some((e) => !isEmailAddress(e))) {
    throw new ResolveError("recipients must be an array of email addresses", 400);
  }
  if (r.enabled && r.recipients.length === 0) {
    throw new ResolveError("add at least one recipient to enable scheduled reports", 400);
  }
  return { enabled: r.enabled, recipients: r.recipients as string[] };
}

export async function getScheduledReportsConfig(
  db: Db = getPool(),
): Promise<ScheduledReportsConfig> {
  const { rows } = await db.query(
    "SELECT value FROM settings WHERE key = $1 AND secret = false",
    [SCHEDULED_REPORTS_SETTING],
  );
  if (rows.length === 0) return DEFAULT_CONFIG;
  try {
    return validateScheduledReportsConfig(rows[0].value);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function setScheduledReportsConfig(
  config: ScheduledReportsConfig,
  db: Db = getPool(),
): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value, secret) VALUES ($1, $2::jsonb, false)
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, secret = false, updated_at = now()`,
    [SCHEDULED_REPORTS_SETTING, JSON.stringify(config)],
  );
}

// ---------------------------------------------------------------------------
// PDF rendering

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  })} ${y}`;
}

const col = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + "…" : s).padEnd(w);
const num = (s: string, w: number) => (s.length > w ? s.slice(0, w) : s).padStart(w);

/** The CFO page (spec 10 page 6) as PDF lines - same numbers as /report. */
export function reportPdfLines(data: ReportData): PdfLine[] {
  const cur = data.displayCurrency;
  const money = (cents: number) => formatCents(cents, cur);
  const lines: PdfLine[] = [
    { text: APP_NAME, font: "B", size: 18 },
    { text: `Monthly report - ${monthLabel(data.month)}`, font: "H", size: 12, gapBefore: 4 },
    {
      text: `Total spend ${money(data.totals.spendCents)}   last month ${money(
        data.totals.prevSpendCents,
      )}   MoM ${formatPct(data.totals.momPct)}`,
      font: "H",
      size: 11,
      gapBefore: 10,
    },
    {
      text:
        col("ROI", 26) +
        num("Spend", 12) +
        num("Last mo", 12) +
        num("MoM", 8) +
        num("Successes", 9) +
        num("Unit cost", 12) +
        num("ROI x", 7),
      font: "C",
      size: 9,
      gapBefore: 14,
    },
  ];
  for (const row of data.rows) {
    lines.push({
      text:
        col(row.name + (row.archived ? " (archived)" : ""), 26) +
        num(money(row.spendCents), 12) +
        num(money(row.prevSpendCents), 12) +
        num(formatPct(row.momPct), 8) +
        num(String(row.outcomeCount), 9) +
        num(
          row.unitCostCents === null
            ? row.costPerUserCents === null
              ? "-"
              : `${money(row.costPerUserCents)}/user`
            : `${money(row.unitCostCents)}/${row.unit ?? "outcome"}`,
          12,
        ) +
        num(row.roi === null ? "-" : `${row.roi.toFixed(1)}x`, 7),
      font: "C",
      size: 9,
    });
  }
  lines.push({ text: "Trend", font: "B", size: 11, gapBefore: 16 });
  for (const m of data.months) {
    lines.push({
      text: col(monthLabel(m.month), 26) + num(money(m.spendCents), 12),
      font: "C",
      size: 9,
    });
  }
  lines.push({
    text: `Generated by ${APP_NAME} - every number drills to its source rows in the dashboard.`,
    font: "H",
    size: 8,
    gapBefore: 16,
  });
  return lines;
}

// ---------------------------------------------------------------------------
// The monthly tick

export interface ScheduledReportTickResult {
  /** The month that was (or would be) reported, YYYY-MM. */
  month: string;
  sent: string[];
  failed: { to: string; error: string }[];
  skipped: string | null;
}

export async function scheduledReportsTick(
  opts: EmailOpts & { now?: Date } = {},
): Promise<ScheduledReportTickResult> {
  const db = opts.db ?? getPool();
  const now = opts.now ?? new Date();
  const month = addMonths(currentMonth(now), -1); // the month that just closed
  const skip = (reason: string): ScheduledReportTickResult => ({
    month,
    sent: [],
    failed: [],
    skipped: reason,
  });

  if (!(await eeFeatureEnabled("scheduled_reports", db, now))) {
    return skip("unlicensed");
  }
  const config = await getScheduledReportsConfig(db);
  if (!config.enabled || config.recipients.length === 0) return skip("disabled");
  if ((await emailSummary({ ...opts, db })) === null) {
    return skip("no email provider configured");
  }
  const { rows: already } = await db.query(
    "SELECT 1 FROM alert_state WHERE kind = 'scheduled_report' AND scope = 'org' AND period_key = $1",
    [month],
  );
  if (already.length > 0) return skip("already sent");

  const data = await reportData(month, db);
  const pdf = buildPdf(reportPdfLines(data));
  const attachment = {
    filename: `tokenturn-report-${month}.pdf`,
    contentType: "application/pdf",
    content: pdf.toString("base64"),
  };

  const sent: string[] = [];
  const failed: { to: string; error: string }[] = [];
  for (const to of config.recipients) {
    try {
      await sendEmail(
        {
          to,
          subject: `${APP_NAME} monthly report - ${monthLabel(month)}`,
          text:
            `The ${APP_NAME} report for ${monthLabel(month)} is attached.\n\n` +
            `Total spend: ${formatCents(data.totals.spendCents, data.displayCurrency)} ` +
            `(MoM ${formatPct(data.totals.momPct)}).`,
          attachments: [attachment],
        },
        { ...opts, db },
      );
      sent.push(to);
    } catch (error) {
      // The provider's error verbatim, per recipient.
      failed.push({ to, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (sent.length > 0) {
    // Mark sent only on success: a fully failed month retries next tick.
    await db.query(
      `INSERT INTO alert_state (kind, scope, period_key)
       VALUES ('scheduled_report', 'org', $1) ON CONFLICT DO NOTHING`,
      [month],
    );
  }
  await audit("system", "report.scheduled", { month, sent, failed }, db);
  logger.info("scheduled report tick", { month, sent: sent.length, failed: failed.length });
  return { month, sent, failed, skipped: null };
}
