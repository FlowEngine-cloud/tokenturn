import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectOkta,
  disconnectOkta,
  getOktaConfig,
  hookAuthorized,
  OKTA_CONNECTOR,
  oktaStatus,
  oktaTick,
  parseLeaverEvents,
  parseOktaUsers,
  sweepLeaver,
  validateOktaInput,
} from "../ee/lib/okta";
import { GET as hookGet, POST as hookPost } from "../src/app/api/ee/okta/events/route";
import { GET as oktaGet } from "../src/app/api/ee/okta/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { closePool } from "../src/lib/db";
import { EE_LOCKED_COPY } from "../src/lib/license";
import { clearSecretKeyCache } from "../src/lib/secrets";
import { setSecretSetting } from "../src/lib/settings";
import { runMigrations } from "../scripts/migrate.mjs";
import { getJson } from "./helpers/http";
import { licenseInstance, unpinTestLicenseKey } from "./helpers/license";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const FIXTURES = path.resolve(__dirname, "fixtures", "ee");

const usersPage1 = readFileSync(path.join(FIXTURES, "okta-users-page1.json"), "utf8");
const usersPage2 = readFileSync(path.join(FIXTURES, "okta-users-page2.json"), "utf8");
const leaverLogs = readFileSync(path.join(FIXTURES, "okta-logs-leaver.json"), "utf8");

const DOMAIN = "https://acme.okta.com";

/** Route-matching fetch stub; records every request it serves. */
function oktaFetch(overrides: Record<string, () => Response> = {}) {
  const calls: { url: string; method: string; auth: string | null; body: string | null }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? "GET",
      auth: headers.authorization ?? null,
      body: (init?.body as string) ?? null,
    });
    for (const [prefix, respond] of Object.entries(overrides)) {
      if (url.startsWith(prefix)) return respond();
    }
    if (url.startsWith(`${DOMAIN}/api/v1/users`)) {
      const after = new URL(url).searchParams.get("after");
      if (after === null) {
        return new Response(usersPage1, {
          headers: {
            "content-type": "application/json",
            link: `<${DOMAIN}/api/v1/users?limit=200&after=cursor-page-2>; rel="next"`,
          },
        });
      }
      expect(after).toBe("cursor-page-2");
      return new Response(usersPage2, { headers: { "content-type": "application/json" } });
    }
    if (url.startsWith(`${DOMAIN}/api/v1/logs`)) {
      return new Response(leaverLogs, { headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("https://api.anthropic.com/v1/organizations/invites")) {
      return new Response(JSON.stringify({ type: "invite", id: "invite_1" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://api.cursor.com/teams/remove-member")) {
      return new Response(
        JSON.stringify({ success: true, userId: "user_abc", hasBillingCycleUsage: false }),
        { headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  return { impl, calls };
}

describe("okta parsing (recorded fixtures)", () => {
  it("parses the users pages - display name, first+last, empty -> null", () => {
    const users = parseOktaUsers(JSON.parse(usersPage1));
    expect(users).toEqual([
      { email: "dana@acme.com", name: "Dana Levi" },
      { email: "noa@acme.com", name: "Noa Stern" },
    ]);
    expect(parseOktaUsers(JSON.parse(usersPage2))).toEqual([
      { email: "svc-reports@acme.com", name: null },
    ]);
  });

  it("pulls only leaver events out of the log - deactivate and suspend", () => {
    const leavers = parseLeaverEvents(JSON.parse(leaverLogs));
    expect(leavers).toEqual([
      {
        email: "dana@acme.com",
        eventType: "user.lifecycle.deactivate",
        published: "2026-06-11T09:15:00.000Z",
      },
      {
        email: "ghost@acme.com",
        eventType: "user.lifecycle.suspend",
        published: "2026-06-11T09:25:00.000Z",
      },
    ]);
  });

  it("a format change throws with the field named", () => {
    expect(() => parseOktaUsers([{ id: "x", status: "ACTIVE", profile: {} }])).toThrow(
      /missing or invalid "email"/,
    );
    expect(() => parseLeaverEvents([{ eventType: "user.lifecycle.deactivate" }])).toThrow(
      /missing or invalid/,
    );
  });
});

describe.runIf(TEST_DATABASE_URL)("okta sync (spec 11)", () => {
  let dbUrl: string;
  let pool: Pool;
  let adminCookie: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("okta_test");
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

  it("everything is locked without the license - the exact line", async () => {
    const res = await oktaGet(getJson("/api/ee/okta", adminCookie));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(EE_LOCKED_COPY);

    const hook = await hookGet(getJson("/api/ee/okta/events"));
    expect(hook.status).toBe(403);
    expect((await hook.json()).error).toBe(EE_LOCKED_COPY);

    expect(await oktaTick({ db: pool })).toMatchObject({ ran: false });
  });

  it("connect validates the token against users AND the system log, then encrypts", async () => {
    await licenseInstance(pool, ["okta_sync"]);

    const denied = oktaFetch({
      [`${DOMAIN}/api/v1/users`]: () =>
        new Response(JSON.stringify({ errorCode: "E0000011", errorSummary: "Invalid token provided" }), {
          status: 401,
        }),
    });
    await expect(
      connectOkta({ domain: DOMAIN, token: "bad" }, { db: pool, fetch: denied.impl }),
    ).rejects.toThrow("okta 401 on /api/v1/users?limit=1: Invalid token provided");
    expect(await getOktaConfig({ db: pool })).toBeNull();

    const { impl, calls } = oktaFetch();
    // The route runs every connect through validateOktaInput first.
    const input = validateOktaInput({ domain: `${DOMAIN}/`, token: "ssws-token" });
    expect(input.domain).toBe(DOMAIN); // trailing slash trimmed
    const config = await connectOkta(input, { db: pool, fetch: impl });
    expect(config.hookSecret).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(calls.map((c) => c.auth)).toContain("SSWS ssws-token");
    // Stored encrypted - the settings row never carries the token plaintext.
    const { rows } = await pool.query(
      "SELECT value::text AS v, secret FROM settings WHERE key = 'directory:okta:config'",
    );
    expect(rows[0].secret).toBe(true);
    expect(rows[0].v).not.toContain("ssws-token");

    // Reconnect keeps the hook secret, so the hook registered in Okta survives.
    const again = await connectOkta(
      { domain: DOMAIN, token: "rotated" },
      { db: pool, fetch: oktaFetch().impl },
    );
    expect(again.hookSecret).toBe(config.hookSecret);
  });

  it("the tick pages the roster, creates people, auto-invites to connected vendors, sweeps leavers", async () => {
    // Anthropic is "connected": invite fan-out targets it (github never -
    // login-keyed; openai not connected here). Cursor is connected too but
    // is never an invite vendor (its Admin API has no invite endpoint) -
    // the leaver sweeps still remove its seats.
    await pool.query(
      `INSERT INTO connectors (vendor, history_limit_days, scopes) VALUES
         ('anthropic', 31, '{usage}'), ('cursor', 31, '{usage}')`,
    );
    await setSecretSetting("connector:anthropic:config", JSON.stringify({ adminKey: "ak" }), pool);
    await setSecretSetting("connector:cursor:config", JSON.stringify({ apiKey: "ck" }), pool);

    const { impl, calls } = oktaFetch();
    // First tick: the log poll starts at "now" (history before the connect
    // is not ours to replay) and the cursor advances to the newest event.
    const result = await oktaTick({
      db: pool,
      fetch: impl,
      force: true,
      now: new Date("2026-06-11T09:00:00.000Z"),
    });
    expect(result.error).toBeNull();
    expect(result.ran).toBe(true);
    expect(result.created).toBe(3); // both pages landed
    const { rows: people } = await pool.query(
      "SELECT email, name, source, status FROM people ORDER BY email",
    );
    expect(people).toEqual([
      // Deactivated by the leaver event in the same tick's log poll.
      { email: "dana@acme.com", name: "Dana Levi", source: "okta", status: "offboarded" },
      { email: "noa@acme.com", name: "Noa Stern", source: "okta", status: "active" },
      { email: "svc-reports@acme.com", name: null, source: "okta", status: "active" },
    ]);

    // Auto-invite on hire: one Anthropic invite per created person, by
    // email. Cursor gets none - there is no Cursor invite API.
    const invites = calls.filter(
      (c) =>
        c.url === "https://api.anthropic.com/v1/organizations/invites" && c.method === "POST",
    );
    expect(calls.some((c) => c.url.includes("api.cursor.com"))).toBe(false);
    expect(invites.map((c) => JSON.parse(c.body!).email).sort()).toEqual([
      "dana@acme.com",
      "noa@acme.com",
      "svc-reports@acme.com",
    ]);
    expect(result.autoInvited.every((r) => r.ok)).toBe(true);

    // Leavers: dana swept (no identities yet -> empty plan, status flips);
    // ghost@ is unknown and said so - never guessed.
    expect(result.leavers).toEqual([
      { email: "dana@acme.com", outcome: "offboarded", error: null },
      { email: "ghost@acme.com", outcome: "unknown_person", error: null },
    ]);

    // The run history carries the log cursor forward.
    const { rows: runs } = await pool.query(
      `SELECT status, cursor, rows_synced FROM sync_runs WHERE connector = $1
       ORDER BY id DESC LIMIT 1`,
      [OKTA_CONNECTOR],
    );
    expect(runs[0].status).toBe("success");
    expect(Number(runs[0].rows_synced)).toBe(3);
    expect(JSON.parse(runs[0].cursor).logsSince).toBe("2026-06-11T09:25:00.000Z");

    // Audited: the auto-invite and both leaver verdicts.
    const { rows: auditRows } = await pool.query(
      "SELECT action FROM audit_log ORDER BY id",
    );
    const actions = auditRows.map((r) => r.action as string);
    expect(actions).toContain("okta.auto_invite");
    expect(actions.filter((a) => a === "okta.leaver").length).toBe(2);
  });

  it("a leaver with real access gets the sweep, idempotently", async () => {
    const { rows } = await pool.query(
      `INSERT INTO people (email, name, source) VALUES ('bob@acme.com', 'Bob', 'okta') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO identities (person_id, vendor, external_id, kind, email)
       VALUES ($1, 'cursor', 'member-77', 'user', 'bob@acme.com')`,
      [rows[0].id],
    );
    const { impl, calls } = oktaFetch();
    const event = {
      email: "bob@acme.com",
      eventType: "user.lifecycle.deactivate",
      published: "2026-06-11T10:00:00.000Z",
    };
    const first = await sweepLeaver(event, { db: pool, fetch: impl });
    expect(first).toEqual({ email: "bob@acme.com", outcome: "offboarded", error: null });
    // Removal is email-keyed (POST /teams/remove-member), Enterprise only.
    const removal = calls.find(
      (c) => c.method === "POST" && c.url === "https://api.cursor.com/teams/remove-member",
    );
    expect(removal).toBeDefined();
    expect(JSON.parse(removal!.body!)).toEqual({ email: "bob@acme.com" });

    // The replayed event re-sweeps without duplicating items or calls.
    const second = await sweepLeaver(event, { db: pool, fetch: oktaFetch().impl });
    expect(second.outcome).toBe("already_offboarded");
    const { rows: items } = await pool.query(
      "SELECT oi.status FROM offboard_items oi JOIN people p ON p.id = oi.person_id WHERE p.email = 'bob@acme.com'",
    );
    expect(items).toEqual([{ status: "removed" }]);
  });

  it("the event hook: challenge echo, secret auth, events fire the sweep", async () => {
    const config = (await getOktaConfig({ db: pool }))!;
    expect(hookAuthorized(config, `Bearer ${config.hookSecret}`)).toBe(true);
    expect(hookAuthorized(config, config.hookSecret)).toBe(true);
    expect(hookAuthorized(config, "wrong")).toBe(false);
    expect(hookAuthorized(config, null)).toBe(false);

    const challenge = await hookGet(
      new Request("http://localhost:3000/api/ee/okta/events", {
        headers: {
          authorization: config.hookSecret,
          "x-okta-verification-challenge": "champ-123",
        },
      }),
    );
    expect(challenge.status).toBe(200);
    expect(await challenge.json()).toEqual({ verification: "champ-123" });

    expect(
      (
        await hookPost(
          new Request("http://localhost:3000/api/ee/okta/events", {
            method: "POST",
            headers: { authorization: "wrong" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(401);

    // A delivered leaver event sweeps; the global fetch is never reached
    // because noa has no removable identities.
    const res = await hookPost(
      new Request("http://localhost:3000/api/ee/okta/events", {
        method: "POST",
        headers: { authorization: config.hookSecret, "content-type": "application/json" },
        body: JSON.stringify({
          eventType: "com.okta.event_hook",
          data: {
            events: [
              {
                eventType: "user.lifecycle.deactivate",
                published: "2026-06-11T11:00:00.000Z",
                target: [{ type: "User", alternateId: "noa@acme.com", id: "x" }],
              },
            ],
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).swept).toEqual([
      { email: "noa@acme.com", outcome: "offboarded", error: null },
    ]);
    const { rows } = await pool.query("SELECT status FROM people WHERE email = 'noa@acme.com'");
    expect(rows[0].status).toBe("offboarded");
  });

  it("status reports the run surface; disconnect forgets the credentials", async () => {
    const status = await oktaStatus({ db: pool });
    expect(status.connected).toBe(true);
    expect(status.domain).toBe(DOMAIN);
    expect(status.lastRun?.status).toBe("success");

    expect(await disconnectOkta({ db: pool })).toBe(true);
    expect(await getOktaConfig({ db: pool })).toBeNull();
    expect(await oktaTick({ db: pool, force: true })).toMatchObject({ ran: false });
  });

  it("a vendor failure mid-tick lands in the run history verbatim", async () => {
    await connectOkta({ domain: DOMAIN, token: "t" }, { db: pool, fetch: oktaFetch().impl });
    const failing = oktaFetch({
      [`${DOMAIN}/api/v1/users`]: () =>
        new Response(JSON.stringify({ errorSummary: "rate limit exceeded" }), { status: 429 }),
    });
    const result = await oktaTick({ db: pool, fetch: failing.impl, force: true });
    expect(result.ran).toBe(true);
    expect(result.error).toContain("rate limit exceeded");
    const { rows } = await pool.query(
      `SELECT status, error FROM sync_runs WHERE connector = $1 ORDER BY id DESC LIMIT 1`,
      [OKTA_CONNECTOR],
    );
    expect(rows[0].status).toBe("error");
    expect(rows[0].error).toContain("rate limit exceeded");
  });
});
