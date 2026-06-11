import path from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as limitsRoute } from "../src/app/api/limits/route";
import { PUT as personLimitRoute } from "../src/app/api/people/[id]/limit/route";
import {
  GET as settingsGet,
  PATCH as settingsPatch,
} from "../src/app/api/settings/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { closePool } from "../src/lib/db";
import { recomputeRollups } from "../src/lib/rollup";
import { getSecretSetting, setSecretSetting } from "../src/lib/settings";
import { runMigrations } from "../scripts/migrate.mjs";
import { getJson, patchJson, putJson } from "./helpers/http";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe.runIf(TEST_DATABASE_URL)("limits + alert-channel API routes", () => {
  let dbUrl: string;
  let pool: Pool;
  let adminCookie: string;
  let viewerCookie: string;
  let dana: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("limit_routes_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 3 });

    const { rows: admins } = await pool.query(
      "INSERT INTO users (name, role) VALUES ('Admin', 'admin') RETURNING id",
    );
    adminCookie = `${SESSION_COOKIE}=${(await createSession(admins[0].id, pool)).token}`;
    const { rows: viewers } = await pool.query(
      "INSERT INTO users (name, role) VALUES ('Viewer', 'viewer') RETURNING id",
    );
    viewerCookie = `${SESSION_COOKIE}=${(await createSession(viewers[0].id, pool)).token}`;

    const { rows } = await pool.query(
      `INSERT INTO people (email, name) VALUES ('dana@acme.com', 'Dana') RETURNING id`,
    );
    dana = rows[0].id;
  });

  afterAll(async () => {
    await closePool();
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads need a session; writes need the admin", async () => {
    expect((await limitsRoute(getJson("/api/limits"))).status).toBe(401);
    expect(
      (await personLimitRoute(putJson(`/api/people/${dana}/limit`, { limitUsdCents: 1 }), params(dana)))
        .status,
    ).toBe(401);
    expect(
      (
        await personLimitRoute(
          putJson(`/api/people/${dana}/limit`, { limitUsdCents: 1 }, viewerCookie),
          params(dana),
        )
      ).status,
    ).toBe(403);
    expect((await limitsRoute(getJson("/api/limits", viewerCookie))).status).toBe(200);
  });

  it("sets, reports, and clears a person's monthly limit", async () => {
    const res = await personLimitRoute(
      putJson(`/api/people/${dana}/limit`, { limitUsdCents: 50_000 }, adminCookie),
      params(dana),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      person: { id: dana, email: "dana@acme.com", name: "Dana", limitUsdCents: 50_000 },
    });

    // Month-to-date spend rides along, drillable via the returned window.
    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO spend_facts
         (day, person_id, vendor, amount_cents, currency, cost_basis, source_ref)
       VALUES ($1, $2, 'testvendor', 12345, 'USD', 'estimated', 'routes:1')`,
      [today, dana],
    );
    await recomputeRollups({ from: today, to: today }, pool);

    const list = await limitsRoute(getJson("/api/limits", viewerCookie));
    const page = await list.json();
    expect(page.month).toBe(today.slice(0, 7));
    expect(page.to).toBe(today);
    expect(page.vendorPolicies.openai.enforcement).toBe("alert-only");
    expect(page.people).toMatchObject([
      {
        personId: dana,
        email: "dana@acme.com",
        limitUsdCents: 50_000,
        monthSpendUsdCents: 12_345,
        thresholdsFired: [],
        vendorLimits: [],
      },
    ]);

    const cleared = await personLimitRoute(
      putJson(`/api/people/${dana}/limit`, { limitUsdCents: null }, adminCookie),
      params(dana),
    );
    expect((await cleared.json()).person.limitUsdCents).toBeNull();
  });

  it("rejects bad limits, unknown people, and push-without-limit", async () => {
    for (const limitUsdCents of [-5, 0, 1.5, "x"]) {
      const res = await personLimitRoute(
        putJson(`/api/people/${dana}/limit`, { limitUsdCents }, adminCookie),
        params(dana),
      );
      expect(res.status).toBe(400);
    }
    expect(
      (await personLimitRoute(putJson(`/api/people/${dana}/limit`, {}, adminCookie), params(dana)))
        .status,
    ).toBe(400);
    expect(
      (
        await personLimitRoute(
          putJson(`/api/people/${dana}/limit`, { limitUsdCents: null, pushToCursor: true }, adminCookie),
          params(dana),
        )
      ).status,
    ).toBe(400);
    const ghost = "00000000-0000-4000-8000-00000000dead";
    expect(
      (
        await personLimitRoute(
          putJson(`/api/people/${ghost}/limit`, { limitUsdCents: 100 }, adminCookie),
          params(ghost),
        )
      ).status,
    ).toBe(404);
  });

  it("pushToCursor without a connected Cursor fails honestly, limit still saved", async () => {
    const res = await personLimitRoute(
      putJson(`/api/people/${dana}/limit`, { limitUsdCents: 20_000, pushToCursor: true }, adminCookie),
      params(dana),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cursor).toEqual({
      ok: false,
      error: "Cursor is not connected - connect it in Settings first",
    });
    const { rows } = await pool.query(
      "SELECT monthly_limit_usd_cents::bigint AS l FROM people WHERE id = $1",
      [dana],
    );
    expect(Number(rows[0].l)).toBe(20_000);
  });

  describe("with Cursor connected", () => {
    beforeAll(async () => {
      // Connected state: a connectors row + the encrypted config (the same
      // shape connectConnector writes), using the default secrets dataDir
      // the routes read from.
      await pool.query(
        "INSERT INTO connectors (vendor, history_limit_days) VALUES ('cursor', 90)",
      );
      await setSecretSetting(
        "connector:cursor:config",
        JSON.stringify({ apiKey: "test-admin-key" }),
        pool,
      );
      // The person's Cursor roster email differs from people.email - the
      // push must use the vendor-side one.
      await pool.query(
        `INSERT INTO identities (person_id, vendor, external_id, kind, email)
         VALUES ($1, 'cursor', '42', 'user', 'dana.r@acme.com')`,
        [dana],
      );
    });

    it("pushes the limit to Cursor with the documented request shape", async () => {
      const calls: { url: string; init: RequestInit }[] = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response("{}", { status: 200 });
      });

      const res = await personLimitRoute(
        putJson(`/api/people/${dana}/limit`, { limitUsdCents: 25_050, pushToCursor: true }, adminCookie),
        params(dana),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).cursor).toEqual({
        ok: true,
        userEmail: "dana.r@acme.com",
        spendLimitDollars: 250.5,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://api.cursor.com/teams/user-spend-limit");
      expect(calls[0].init.method).toBe("POST");
      expect(JSON.parse(calls[0].init.body as string)).toEqual({
        userEmail: "dana.r@acme.com",
        spendLimitDollars: 250.5,
      });
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.authorization).toBe(
        `Basic ${Buffer.from("test-admin-key:").toString("base64")}`,
      );
    });

    it("surfaces Cursor's Enterprise-only rejection verbatim; our limit still saved", async () => {
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(
            JSON.stringify({ error: "Setting user spend limits requires an Enterprise plan." }),
            { status: 403 },
          ),
      );
      const res = await personLimitRoute(
        putJson(`/api/people/${dana}/limit`, { limitUsdCents: 30_000, pushToCursor: true }, adminCookie),
        params(dana),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).cursor).toEqual({
        ok: false,
        error: "Setting user spend limits requires an Enterprise plan.",
      });
      const { rows } = await pool.query(
        "SELECT monthly_limit_usd_cents::bigint AS l FROM people WHERE id = $1",
        [dana],
      );
      expect(Number(rows[0].l)).toBe(30_000);
    });

    it("the vendor limit Cursor reports shows up next to ours", async () => {
      await pool.query(
        `INSERT INTO usage_metrics (day, vendor, metric, value, person_id, source_ref)
         VALUES ('2026-06-01', 'cursor', 'spend_limit_dollars', 300, $1, 'spend:2026-06-01:42')`,
        [dana],
      );
      const page = await (await limitsRoute(getJson("/api/limits", adminCookie))).json();
      expect(page.people[0].vendorLimits).toEqual([
        {
          vendor: "cursor",
          limitUsdCents: 30_000,
          asOfDay: "2026-06-01",
          sourceRef: "spend:2026-06-01:42",
        },
      ]);
    });
  });

  describe("Slack webhook setting (spec 9 alert channel)", () => {
    it("admins set it, readers only ever see that it is set", async () => {
      const url = "https://hooks.slack.com/services/T000/B000/secret-hook";
      const res = await settingsPatch(
        patchJson("/api/settings", { slack_webhook_url: url }, adminCookie),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.secrets).toEqual({ slack_webhook_url: true, email_provider_config: false });
      // The value never leaves the server, and is encrypted at rest.
      expect(JSON.stringify(body)).not.toContain(url);
      const { rows } = await pool.query(
        "SELECT value::text AS v, secret FROM settings WHERE key = 'slack_webhook_url'",
      );
      expect(rows[0].secret).toBe(true);
      expect(rows[0].v).not.toContain("hooks.slack.com");
      expect(await getSecretSetting("slack_webhook_url", pool)).toBe(url);

      const got = await settingsGet(getJson("/api/settings", viewerCookie));
      const gotBody = await got.json();
      expect(gotBody.secrets).toEqual({ slack_webhook_url: true, email_provider_config: false });
      expect(JSON.stringify(gotBody)).not.toContain(url);
    });

    it("rejects non-https and non-string values; viewers cannot write", async () => {
      for (const bad of ["http://insecure.example.com/hook", "not a url", 5, true]) {
        const res = await settingsPatch(
          patchJson("/api/settings", { slack_webhook_url: bad }, adminCookie),
        );
        expect(res.status).toBe(400);
      }
      expect(
        (
          await settingsPatch(
            patchJson("/api/settings", { slack_webhook_url: "https://x.example/hook" }, viewerCookie),
          )
        ).status,
      ).toBe(403);
    });

    it("null clears it", async () => {
      const res = await settingsPatch(
        patchJson("/api/settings", { slack_webhook_url: null }, adminCookie),
      );
      expect((await res.json()).secrets).toEqual({ slack_webhook_url: false, email_provider_config: false });
      expect(await getSecretSetting("slack_webhook_url", pool)).toBeNull();
    });
  });
});
