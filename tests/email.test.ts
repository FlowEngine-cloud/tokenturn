import path from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as testSendRoute } from "../src/app/api/email/test/route";
import {
  GET as settingsGet,
  PATCH as settingsPatch,
} from "../src/app/api/settings/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { closePool } from "../src/lib/db";
import { signSesSendEmail } from "../src/lib/email";
import { runMigrations } from "../scripts/migrate.mjs";
import { getJson, patchJson, postJson } from "./helpers/http";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function stubFetch(response: Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string,
    });
    return response;
  });
  return calls;
}

describe.runIf(TEST_DATABASE_URL)("email provider (spec 12b)", () => {
  let dbUrl: string;
  let pool: Pool;
  let adminCookie: string;
  let viewerCookie: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("email_test");
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
  });

  afterAll(async () => {
    await closePool();
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("test-send without a provider says so; bad bodies rejected", async () => {
    expect((await testSendRoute(postJson("/api/email/test", { to: "x@y.io" }))).status).toBe(401);
    expect(
      (await testSendRoute(postJson("/api/email/test", { to: "x@y.io" }, viewerCookie))).status,
    ).toBe(403);
    expect(
      (await testSendRoute(postJson("/api/email/test", { to: "not-an-email" }, adminCookie)))
        .status,
    ).toBe(400);
    const res = await testSendRoute(postJson("/api/email/test", { to: "x@y.io" }, adminCookie));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(
      "no email provider configured - set one in Settings",
    );
  });

  it("rejects invalid configs with the problem named", async () => {
    const cases: [Record<string, unknown> | string, string][] = [
      ["smtp://nope", "email_provider_config must be an object, or null to clear it"],
      [{ provider: "smtp", from: "a@b.co", apiKey: "k" }, "provider must be resend, postmark, or ses"],
      [{ provider: "resend", from: "nope", apiKey: "k" }, "from must be an email address"],
      [{ provider: "resend", from: "a@b.co" }, "apiKey is required for resend"],
      [{ provider: "ses", from: "a@b.co", accessKeyId: "A", secretAccessKey: "S" }, "region is required for ses"],
      [
        { provider: "ses", from: "a@b.co", accessKeyId: "A", secretAccessKey: "S", region: "us-east" },
        "region must be an AWS region like us-east-1",
      ],
      [
        { provider: "resend", from: "a@b.co", apiKey: "k", region: "us-east-1" },
        "unknown email config field region",
      ],
    ];
    for (const [value, message] of cases) {
      const res = await settingsPatch(
        patchJson("/api/settings", { email_provider_config: value }, adminCookie),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(message);
    }
    expect(
      (
        await settingsPatch(
          patchJson(
            "/api/settings",
            { email_provider_config: { provider: "resend", from: "a@b.co", apiKey: "k" } },
            viewerCookie,
          ),
        )
      ).status,
    ).toBe(403);
  });

  it("stores the config encrypted; reads surface provider + from, never the key", async () => {
    const res = await settingsPatch(
      patchJson(
        "/api/settings",
        {
          email_provider_config: {
            provider: "resend",
            from: "reports@acme.com",
            apiKey: "re_SECRET_123",
          },
        },
        adminCookie,
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secrets.email_provider_config).toBe(true);
    expect(body.email).toEqual({ provider: "resend", from: "reports@acme.com" });
    expect(JSON.stringify(body)).not.toContain("re_SECRET_123");

    const { rows } = await pool.query(
      "SELECT value::text AS v, secret FROM settings WHERE key = 'email_provider_config'",
    );
    expect(rows[0].secret).toBe(true);
    expect(rows[0].v).not.toContain("re_SECRET_123");
    expect(rows[0].v).not.toContain("resend");

    const got = await settingsGet(getJson("/api/settings", viewerCookie));
    const gotBody = await got.json();
    expect(gotBody.email).toEqual({ provider: "resend", from: "reports@acme.com" });
    expect(JSON.stringify(gotBody)).not.toContain("re_SECRET_123");
  });

  it("test-sends through Resend with the documented request shape", async () => {
    const calls = stubFetch(new Response(JSON.stringify({ id: "email_1" }), { status: 200 }));
    const res = await testSendRoute(
      postJson("/api/email/test", { to: "cfo@acme.com" }, adminCookie),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, provider: "resend" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.authorization).toBe("Bearer re_SECRET_123");
    expect(JSON.parse(calls[0].body)).toEqual({
      from: "reports@acme.com",
      to: ["cfo@acme.com"],
      subject: "AI P&L test email",
      text: "Your AI P&L email provider works. This is a test send from Settings.",
    });
  });

  it("surfaces the provider's rejection verbatim", async () => {
    stubFetch(
      new Response(
        JSON.stringify({ statusCode: 401, message: "API key is invalid", name: "validation_error" }),
        { status: 401 },
      ),
    );
    const res = await testSendRoute(
      postJson("/api/email/test", { to: "cfo@acme.com" }, adminCookie),
    );
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("API key is invalid");
  });

  it("Postmark: server token header, Message error field", async () => {
    await settingsPatch(
      patchJson(
        "/api/settings",
        {
          email_provider_config: {
            provider: "postmark",
            from: "reports@acme.com",
            apiKey: "pm_SECRET_456",
          },
        },
        adminCookie,
      ),
    );
    const calls = stubFetch(new Response(JSON.stringify({ ErrorCode: 0 }), { status: 200 }));
    const ok = await testSendRoute(
      postJson("/api/email/test", { to: "cfo@acme.com" }, adminCookie),
    );
    expect(await ok.json()).toEqual({ ok: true, provider: "postmark" });
    expect(calls[0].url).toBe("https://api.postmarkapp.com/email");
    expect(calls[0].headers["x-postmark-server-token"]).toBe("pm_SECRET_456");
    expect(JSON.parse(calls[0].body)).toEqual({
      From: "reports@acme.com",
      To: "cfo@acme.com",
      Subject: "AI P&L test email",
      TextBody: "Your AI P&L email provider works. This is a test send from Settings.",
      MessageStream: "outbound",
    });

    stubFetch(
      new Response(JSON.stringify({ ErrorCode: 10, Message: "No Account found." }), {
        status: 401,
      }),
    );
    const bad = await testSendRoute(
      postJson("/api/email/test", { to: "cfo@acme.com" }, adminCookie),
    );
    expect(bad.status).toBe(502);
    expect((await bad.json()).error).toBe("No Account found.");
  });

  it("SES: SigV4-signed SendEmail against the region endpoint", async () => {
    await settingsPatch(
      patchJson(
        "/api/settings",
        {
          email_provider_config: {
            provider: "ses",
            from: "reports@acme.com",
            accessKeyId: "AKIATEST",
            secretAccessKey: "SES_SECRET_789",
            region: "eu-west-1",
          },
        },
        adminCookie,
      ),
    );
    const calls = stubFetch(new Response(JSON.stringify({ MessageId: "m-1" }), { status: 200 }));
    const res = await testSendRoute(
      postJson("/api/email/test", { to: "cfo@acme.com" }, adminCookie),
    );
    expect(await res.json()).toEqual({ ok: true, provider: "ses" });

    expect(calls[0].url).toBe("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
    expect(calls[0].headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(calls[0].headers.authorization).toMatch(
      new RegExp(
        "^AWS4-HMAC-SHA256 Credential=AKIATEST/\\d{8}/eu-west-1/ses/aws4_request, " +
          "SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$",
      ),
    );
    expect(JSON.parse(calls[0].body)).toEqual({
      FromEmailAddress: "reports@acme.com",
      Destination: { ToAddresses: ["cfo@acme.com"] },
      Content: {
        Simple: {
          Subject: { Data: "AI P&L test email" },
          Body: { Text: { Data: "Your AI P&L email provider works. This is a test send from Settings." } },
        },
      },
    });

    stubFetch(
      new Response(
        JSON.stringify({ message: "Email address is not verified.", __type: "MessageRejected" }),
        { status: 400 },
      ),
    );
    const bad = await testSendRoute(
      postJson("/api/email/test", { to: "cfo@acme.com" }, adminCookie),
    );
    expect(bad.status).toBe(502);
    expect((await bad.json()).error).toBe("Email address is not verified.");
  });

  it("SigV4 canonicalization is pinned (deterministic golden signature)", () => {
    const signed = signSesSendEmail(
      { accessKeyId: "AKIATEST", secretAccessKey: "SECRETTEST", region: "us-east-1" },
      JSON.stringify({
        FromEmailAddress: "reports@acme.com",
        Destination: { ToAddresses: ["cfo@acme.com"] },
        Content: {
          Simple: { Subject: { Data: "AI P&L test email" }, Body: { Text: { Data: "hello" } } },
        },
      }),
      new Date("2026-06-11T12:00:00Z"),
    );
    expect(signed.url).toBe("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
    expect(signed.headers["x-amz-date"]).toBe("20260611T120000Z");
    expect(signed.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIATEST/20260611/us-east-1/ses/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date, " +
        "Signature=34f1efefb87f854a46a77c2589abe7140746584ccbff5801c2aaade5cebd8dea",
    );
  });

  it("null clears the provider", async () => {
    const res = await settingsPatch(
      patchJson("/api/settings", { email_provider_config: null }, adminCookie),
    );
    const body = await res.json();
    expect(body.secrets.email_provider_config).toBe(false);
    expect(body.email).toBeNull();
    const after = await testSendRoute(
      postJson("/api/email/test", { to: "cfo@acme.com" }, adminCookie),
    );
    expect(after.status).toBe(409);
  });
});
