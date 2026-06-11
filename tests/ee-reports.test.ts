import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPdf } from "../ee/lib/pdf";
import {
  getScheduledReportsConfig,
  reportPdfLines,
  scheduledReportsTick,
  validateScheduledReportsConfig,
} from "../ee/lib/scheduled-reports";
import { PATCH as settingsPatch } from "../src/app/api/settings/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { APP_NAME } from "../src/lib/brand";
import { closePool } from "../src/lib/db";
import { buildMimeMessage, setEmailConfig } from "../src/lib/email";
import { EE_LOCKED_COPY } from "../src/lib/license";
import { ResolveError } from "../src/lib/resolve";
import { clearSecretKeyCache } from "../src/lib/secrets";
import type { ReportData } from "../src/lib/report";
import { runMigrations } from "../scripts/migrate.mjs";
import { patchJson } from "./helpers/http";
import { licenseInstance, unpinTestLicenseKey } from "./helpers/license";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

/** Spec 11: scheduled reports - monthly PDF email, enterprise. */

const SAMPLE: ReportData = {
  displayCurrency: "USD",
  month: "2026-05",
  prevMonth: "2026-04",
  from: "2026-05-01",
  to: "2026-05-31",
  people: [],
  rows: [
    {
      productId: "p1",
      name: "Support bot",
      archived: false,
      spendCents: 123_45,
      prevSpendCents: 100_00,
      momPct: 23.5,
      outcomeCount: 300,
      unit: "ticket_resolved",
      unitCostCents: 41,
      valueCents: 135_000,
      roi: 10.9,
      activeUsers: 4,
      costPerUserCents: null,
    },
    {
      productId: null,
      name: "No ROI",
      archived: false,
      spendCents: 50_00,
      prevSpendCents: 0,
      momPct: null,
      outcomeCount: 0,
      unit: null,
      unitCostCents: null,
      valueCents: null,
      roi: null,
      activeUsers: 2,
      costPerUserCents: 25_00,
    },
  ],
  totals: { spendCents: 173_45, prevSpendCents: 100_00, momPct: 73.5 },
  months: [
    { month: "2026-04", from: "2026-04-01", to: "2026-04-30", spendCents: 100_00 },
    { month: "2026-05", from: "2026-05-01", to: "2026-05-31", spendCents: 173_45 },
  ],
};

describe("the report PDF", () => {
  it("renders the CFO page deterministically as a real PDF", () => {
    const pdf = buildPdf(reportPdfLines(SAMPLE));
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.endsWith("%%EOF\n")).toBe(true);
    expect(text).toContain(`(${APP_NAME}) Tj`);
    expect(text).toContain("Monthly report - May 2026");
    expect(text).toContain("Support bot");
    expect(text).toContain("10.9x");
    // Deterministic: the same data yields byte-identical output.
    expect(buildPdf(reportPdfLines(SAMPLE)).equals(pdf)).toBe(true);
  });

  it("paginates instead of writing off the page", () => {
    // 45 size-10 lines fit a page (728 -> 56 at 15pt leading); 200 = 5 pages.
    const lines = Array.from({ length: 200 }, (_, i) => ({ text: `row ${i}` }));
    const text = buildPdf(lines).toString("latin1");
    expect(text).toContain("/Count 5");
    expect(text).toContain("(row 199) Tj");
  });

  it("escapes PDF-special characters and folds non-Latin-1 honestly", () => {
    const text = buildPdf([{ text: "a(b)c\\d ₪ש" }]).toString("latin1");
    expect(text).toContain("(a\\(b\\)c\\\\d ??) Tj");
  });
});

describe("config validation", () => {
  it("accepts only { enabled, recipients } with real addresses", () => {
    expect(validateScheduledReportsConfig({ enabled: true, recipients: ["cfo@acme.com"] })).toEqual({
      enabled: true,
      recipients: ["cfo@acme.com"],
    });
    expect(() => validateScheduledReportsConfig({ enabled: true, recipients: [] })).toThrow(
      ResolveError,
    );
    expect(() => validateScheduledReportsConfig({ enabled: true, recipients: ["nope"] })).toThrow(
      /email/,
    );
    expect(() =>
      validateScheduledReportsConfig({ enabled: false, recipients: [], extra: 1 }),
    ).toThrow(/unknown/);
  });
});

describe.runIf(TEST_DATABASE_URL)("scheduled reports tick (spec 11)", () => {
  let dbUrl: string;
  let pool: Pool;
  let adminCookie: string;
  const now = new Date("2026-06-11T08:00:00Z"); // reports 2026-05

  function emailFetch(respond?: (url: string, body: string) => Response) {
    const calls: { url: string; body: string }[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = (init?.body as string) ?? "";
      calls.push({ url, body });
      return respond
        ? respond(url, body)
        : new Response(JSON.stringify({ id: "msg_1" }), {
            headers: { "content-type": "application/json" },
          });
    }) as typeof fetch;
    return { impl, calls };
  }

  beforeAll(async () => {
    dbUrl = await createScratchDb("reports_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 3 });
    const { rows } = await pool.query(
      "INSERT INTO users (name, role) VALUES ('Admin', 'admin') RETURNING id",
    );
    adminCookie = `${SESSION_COOKIE}=${(await createSession(rows[0].id, pool)).token}`;
  });

  afterAll(async () => {
    unpinTestLicenseKey();
    clearSecretKeyCache();
    await closePool();
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  it("writing the schedule is license-gated with the exact line", async () => {
    const locked = await settingsPatch(
      patchJson(
        "/api/settings",
        { scheduled_reports: { enabled: true, recipients: ["cfo@acme.com"] } },
        adminCookie,
      ),
    );
    expect(locked.status).toBe(403);
    expect((await locked.json()).error).toBe(EE_LOCKED_COPY);

    await licenseInstance(pool, ["scheduled_reports"]);
    const bad = await settingsPatch(
      patchJson("/api/settings", { scheduled_reports: { enabled: true, recipients: [] } }, adminCookie),
    );
    expect(bad.status).toBe(400);

    const ok = await settingsPatch(
      patchJson(
        "/api/settings",
        { scheduled_reports: { enabled: true, recipients: ["cfo@acme.com", "fin@acme.com"] } },
        adminCookie,
      ),
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).scheduledReports).toEqual({
      enabled: true,
      recipients: ["cfo@acme.com", "fin@acme.com"],
    });
  });

  it("skips honestly: unlicensed, disabled, or no email provider", async () => {
    await licenseInstance(pool, ["audit_log"]); // license without the feature
    expect((await scheduledReportsTick({ db: pool, now })).skipped).toBe("unlicensed");

    await licenseInstance(pool, ["scheduled_reports"]);
    expect((await scheduledReportsTick({ db: pool, now })).skipped).toBe(
      "no email provider configured",
    );
    expect(await getScheduledReportsConfig(pool)).toEqual({
      enabled: true,
      recipients: ["cfo@acme.com", "fin@acme.com"],
    });
  });

  it("sends the closed month's PDF to every recipient, exactly once per month", async () => {
    await setEmailConfig(
      { provider: "resend", from: "reports@acme.com", apiKey: "re_key" },
      { db: pool },
    );
    const { impl, calls } = emailFetch();
    const result = await scheduledReportsTick({ db: pool, now, fetch: impl });
    expect(result).toMatchObject({
      month: "2026-05",
      sent: ["cfo@acme.com", "fin@acme.com"],
      failed: [],
      skipped: null,
    });
    expect(calls.length).toBe(2);
    const sent = JSON.parse(calls[0].body);
    expect(sent.subject).toBe(`${APP_NAME} monthly report - May 2026`);
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments[0].filename).toBe("ai-pnl-report-2026-05.pdf");
    expect(
      Buffer.from(sent.attachments[0].content, "base64").toString("latin1").startsWith("%PDF-1.4"),
    ).toBe(true);

    // Deduped through alert_state: the month never sends twice.
    expect((await scheduledReportsTick({ db: pool, now, fetch: impl })).skipped).toBe(
      "already sent",
    );
    expect(calls.length).toBe(2);

    // The send is audited.
    const { rows } = await pool.query(
      "SELECT action, detail FROM audit_log WHERE action = 'report.scheduled' ORDER BY id DESC LIMIT 1",
    );
    expect(rows[0].detail.month).toBe("2026-05");

    // Next month is its own dedupe key.
    const july = new Date("2026-07-02T08:00:00Z");
    const second = await scheduledReportsTick({ db: pool, now: july, fetch: impl });
    expect(second.month).toBe("2026-06");
    expect(second.sent.length).toBe(2);
  });

  it("a fully failed month retries next tick; partial failure reports verbatim", async () => {
    const aug = new Date("2026-08-01T08:00:00Z");
    const down = emailFetch(
      () => new Response(JSON.stringify({ message: "API key is invalid" }), { status: 401 }),
    );
    const failed = await scheduledReportsTick({ db: pool, now: aug, fetch: down.impl });
    expect(failed.sent).toEqual([]);
    expect(failed.failed.map((f) => f.to)).toEqual(["cfo@acme.com", "fin@acme.com"]);
    expect(failed.failed[0].error).toContain("API key is invalid");

    // Nothing was marked sent - the next tick retries, and a half-up
    // provider yields one sent (marks the month) + one verbatim failure.
    let first = true;
    const flaky = emailFetch(() => {
      if (first) {
        first = false;
        return new Response(JSON.stringify({ id: "msg_2" }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ message: "rate limited" }), { status: 429 });
    });
    const retried = await scheduledReportsTick({ db: pool, now: aug, fetch: flaky.impl });
    expect(retried.sent).toEqual(["cfo@acme.com"]);
    expect(retried.failed[0].error).toContain("rate limited");
    expect((await scheduledReportsTick({ db: pool, now: aug, fetch: flaky.impl })).skipped).toBe(
      "already sent",
    );
  });

  it("builds a deterministic multipart MIME message for SES attachments", () => {
    const mime = buildMimeMessage("reports@acme.com", {
      to: "cfo@acme.com",
      subject: `${APP_NAME} monthly report - May 2026`,
      text: "attached",
      attachments: [
        { filename: "r.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.4").toString("base64") },
      ],
    });
    expect(mime).toContain('Content-Type: multipart/mixed; boundary="=_ai-pnl-mime-boundary"');
    expect(mime).toContain('Content-Disposition: attachment; filename="r.pdf"');
    expect(mime).toContain(Buffer.from("attached", "utf8").toString("base64"));
    expect(mime.endsWith("--=_ai-pnl-mime-boundary--\r\n")).toBe(true);
  });
});
