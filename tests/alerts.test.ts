import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  emailAlert,
  formatAnomalyAlert,
  formatConnectorSilentAlert,
  formatLimitAlert,
  postSlack,
  registerAlertSink,
  SLACK_WEBHOOK_SETTING,
} from "../src/lib/alerts";
import { APP_NAME } from "../src/lib/brand";
import { setEmailConfig } from "../src/lib/email";
import { clearEventListeners, emitEvent, type AppEvents } from "../src/lib/events";
import { checkBurnAlerts } from "../src/lib/limits";
import { recomputeRollups } from "../src/lib/rollup";
import { clearSecretKeyCache } from "../src/lib/secrets";
import { setSecretSetting, setSetting } from "../src/lib/settings";
import { runMigrations } from "../scripts/migrate.mjs";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

const LIMIT_EVENT: AppEvents["limit.threshold"] = {
  personId: "00000000-0000-4000-8000-000000000001",
  email: "dana@acme.com",
  name: "Dana",
  month: "2026-03",
  thresholdPct: 80,
  limitUsdCents: 50_000,
  monthSpendUsdCents: 41_210,
};

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.runIf(TEST_DATABASE_URL)("Slack alert channel", () => {
  let dbUrl: string;
  let pool: Pool;
  let dataDir: string;
  let server: Server;
  let webhookUrl: string;
  let failNext = false;
  const received: { contentType: string | null; body: string }[] = [];

  beforeAll(async () => {
    dbUrl = await createScratchDb("alerts_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    pool = new Pool({ connectionString: dbUrl, max: 5 });
    dataDir = mkdtempSync(path.join(os.tmpdir(), "ai-pnl-alerts-"));

    // A real webhook receiver: the sink's fetch goes over actual HTTP.
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (failNext) {
          failNext = false;
          res.writeHead(500).end("kaboom");
          return;
        }
        received.push({ contentType: req.headers["content-type"] ?? null, body });
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    webhookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });

  afterAll(async () => {
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
    await new Promise((resolve) => server?.close(resolve));
    clearEventListeners();
    clearSecretKeyCache();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("formats messages with real numbers and honest enforcement language", () => {
    expect(formatLimitAlert(LIMIT_EVENT)).toBe(
      "Dana (dana@acme.com) hit 80% of their $500.00 monthly AI limit: " +
        "$412.10 spent in 2026-03.",
    );
    expect(formatLimitAlert({ ...LIMIT_EVENT, name: null, thresholdPct: 100 })).toBe(
      "dana@acme.com hit 100% of their $500.00 monthly AI limit: " +
        "$412.10 spent in 2026-03. " +
        `${APP_NAME} does not hard-stop spend - check vendor-side limits.`,
    );
    expect(
      formatAnomalyAlert({
        personId: "x",
        email: "gil@acme.com",
        name: null,
        day: "2026-03-20",
        dayUsdCents: 6_140,
        trailingAvgUsdCents: 1_180,
        multiplier: 3,
        minDayUsdCents: 2_000,
      }),
    ).toBe(
      "Burn anomaly: gil@acme.com spent $61.40 on 2026-03-20 - " +
        "5.2x their 30-day average of $11.80/day.",
    );
    expect(
      formatAnomalyAlert({
        personId: "x",
        email: "jon@acme.com",
        name: "Jon",
        day: "2026-03-20",
        dayUsdCents: 2_500,
        trailingAvgUsdCents: 0,
        multiplier: 3,
        minDayUsdCents: 2_000,
      }),
    ).toBe(
      "Burn anomaly: Jon (jon@acme.com) spent $25.00 on 2026-03-20 - " +
        "with no spend in the past 30 days.",
    );
    expect(
      formatConnectorSilentAlert({
        vendor: "cursor",
        lastSuccessAt: "2026-03-19T07:00:00.000Z",
        thresholdHours: 24,
      }),
    ).toBe(
      "Connector cursor has been silent for over 24h " +
        "(last successful sync 2026-03-19T07:00:00.000Z).",
    );
    expect(
      formatConnectorSilentAlert({ vendor: "github", lastSuccessAt: null, thresholdHours: 24 }),
    ).toBe("Connector github has been silent for over 24h (never synced since connect).");
  });

  it("no webhook configured: alerts are skipped, never thrown", async () => {
    expect(await postSlack("hello", { db: pool, dataDir })).toBe("skipped");
  });

  it("delivers each alert event as one webhook POST", async () => {
    await setSecretSetting(SLACK_WEBHOOK_SETTING, webhookUrl, pool, dataDir);
    const off = registerAlertSink({ db: pool, dataDir });
    try {
      emitEvent("limit.threshold", LIMIT_EVENT);
      await until(() => received.length === 1, "limit alert delivery");
      expect(received[0].contentType).toBe("application/json");
      expect(JSON.parse(received[0].body)).toEqual({
        text: formatLimitAlert(LIMIT_EVENT),
      });

      emitEvent("burn.anomaly", {
        personId: "x",
        email: "gil@acme.com",
        name: null,
        day: "2026-03-20",
        dayUsdCents: 6_140,
        trailingAvgUsdCents: 1_180,
        multiplier: 3,
        minDayUsdCents: 2_000,
      });
      emitEvent("connector.silent", {
        vendor: "cursor",
        lastSuccessAt: null,
        thresholdHours: 24,
      });
      await until(() => received.length === 3, "anomaly + silent delivery");
      const texts = received.slice(1, 3).map((item) => JSON.parse(item.body).text);
      expect(texts.some((text) => text.includes("Burn anomaly"))).toBe(true);
      expect(texts.some((text) => text.includes("Connector cursor"))).toBe(true);

      // Idempotent: a second registration adds no duplicate listeners.
      const second = registerAlertSink({ db: pool, dataDir });
      expect(second).toBe(off);
      emitEvent("limit.threshold", LIMIT_EVENT);
      await until(() => received.length === 4, "single delivery after re-register");
      await new Promise((r) => setTimeout(r, 150));
      expect(received.length).toBe(4);
    } finally {
      off();
    }
    // Unsubscribed: nothing more is delivered.
    emitEvent("limit.threshold", LIMIT_EVENT);
    await new Promise((r) => setTimeout(r, 150));
    expect(received.length).toBe(4);
  });

  it("a webhook failure is swallowed and later alerts still deliver", async () => {
    failNext = true;
    expect(await postSlack("will fail", { db: pool, dataDir })).toBe("failed");
    expect(await postSlack("recovers", { db: pool, dataDir })).toBe("sent");
    expect(JSON.parse(received[received.length - 1].body)).toEqual({ text: "recovers" });
  });

  it("end to end: seeded spend -> burn check -> Slack message over real HTTP", async () => {
    const { rows } = await pool.query(
      `INSERT INTO people (email, name, status, monthly_limit_usd_cents)
       VALUES ('omer@acme.com', 'Omer', 'active', 10000) RETURNING id`,
    );
    await pool.query(
      `INSERT INTO spend_facts
         (day, person_id, vendor, amount_cents, currency, cost_basis, source_ref)
       VALUES ('2026-03-18', $1, 'testvendor', 9000, 'USD', 'estimated', 'e2e:1')`,
      [rows[0].id],
    );
    await recomputeRollups({ from: "2026-03-18", to: "2026-03-18" }, pool);

    const off = registerAlertSink({ db: pool, dataDir });
    const before = received.length;
    try {
      const result = await checkBurnAlerts({
        pool,
        now: new Date("2026-03-18T20:00:00Z"),
      });
      expect(result.limitAlerts).toMatchObject([{ thresholdPct: 80 }]);
      expect(result.anomalies).toMatchObject([{ dayUsdCents: 9000 }]);
      await until(() => received.length === before + 2, "end-to-end delivery");
      const texts = received.slice(before).map((r) => JSON.parse(r.body).text);
      expect(texts).toContain(
        "Omer (omer@acme.com) hit 80% of their $100.00 monthly AI limit: " +
          "$90.00 spent in 2026-03.",
      );
      expect(texts).toContain(
        "Burn anomaly: Omer (omer@acme.com) spent $90.00 on 2026-03-18 - " +
          "with no spend in the past 30 days.",
      );
    } finally {
      off();
    }
  });

  it("email recipients get the alert too; unset = skipped, never thrown", async () => {
    // No recipients configured.
    expect(await emailAlert("hello", { db: pool, dataDir })).toBe("skipped");

    // Recipients but no provider: still skipped, never thrown.
    await setSetting("alert_email_recipients", ["cfo@acme.com", "fin@acme.com"], pool);
    expect(await emailAlert("hello", { db: pool, dataDir })).toBe("skipped");

    // Provider configured: one email per recipient through it.
    await setEmailConfig(
      { provider: "resend", from: "alerts@acme.com", apiKey: "re_test" },
      { db: pool, dataDir },
    );
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ id: "ok" }), { status: 200 });
    }) as typeof fetch;
    expect(
      await emailAlert("limit hit", { db: pool, dataDir, fetch: fakeFetch }),
    ).toBe("sent");
    expect(sent.map((s) => s.body.to)).toEqual([["cfo@acme.com"], ["fin@acme.com"]]);
    expect(sent[0].url).toBe("https://api.resend.com/emails");
    expect(sent[0].body.subject).toBe(`${APP_NAME} alert`);
    expect(sent[0].body.text).toBe("limit hit");

    // A provider failure is swallowed (best-effort, like Slack).
    const failFetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    expect(
      await emailAlert("will fail", { db: pool, dataDir, fetch: failFetch }),
    ).toBe("failed");
  });
});
