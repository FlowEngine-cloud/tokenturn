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
import { buildMailgunBody, signSesSendEmail } from "../src/lib/email";
import { runMigrations } from "../scripts/migrate.mjs";

const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn(async () => ({ messageId: "m-1" }));
  const createTransport = vi.fn(() => ({ sendMail }));
  return { sendMail, createTransport };
});
vi.mock("nodemailer", () => ({ default: { createTransport } }));
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
    const smtp = {
      provider: "smtp",
      from: "a@b.co",
      host: "smtp.b.co",
      port: 587,
      username: "u",
      password: "p",
    };
    const cases: [Record<string, unknown> | string, string][] = [
      ["smtp://nope", "email_provider_config must be an object, or null to clear it"],
      [
        { provider: "sendgrid", from: "a@b.co", apiKey: "k" },
        "provider must be smtp, resend, postmark, ses, or mailgun",
      ],
      [{ provider: "resend", from: "nope", apiKey: "k" }, "from must be an email address"],
      [{ provider: "resend", from: "a@b.co" }, "apiKey is required for resend"],
      [{ provider: "mailgun", from: "a@b.co" }, "apiKey is required for mailgun"],
      [{ provider: "ses", from: "a@b.co", accessKeyId: "A", secretAccessKey: "S" }, "region is required for ses"],
      [
        { provider: "ses", from: "a@b.co", accessKeyId: "A", secretAccessKey: "S", region: "us-east" },
        "region must be an AWS region like us-east-1",
      ],
      [
        { provider: "resend", from: "a@b.co", apiKey: "k", region: "us-east-1" },
        "unknown email config field region",
      ],
      [{ ...smtp, port: undefined }, "port must be a whole number between 1 and 65535"],
      [{ ...smtp, port: 0 }, "port must be a whole number between 1 and 65535"],
      [{ ...smtp, host: "  " }, "host is required for smtp"],
      [{ ...smtp, apiKey: "k" }, "unknown email config field apiKey"],
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

  it("SMTP: nodemailer transport with the configured host/port/auth", async () => {
    await settingsPatch(
      patchJson(
        "/api/settings",
        {
          email_provider_config: {
            provider: "smtp",
            from: "reports@acme.com",
            host: "smtp.acme.com",
            port: 587,
            username: "mailer",
            password: "SMTP_SECRET",
          },
        },
        adminCookie,
      ),
    );
    createTransport.mockClear();
    sendMail.mockClear();
    const res = await testSendRoute(
      postJson("/api/email/test", { to: "cfo@acme.com" }, adminCookie),
    );
    expect(await res.json()).toEqual({ ok: true, provider: "smtp" });
    expect(createTransport).toHaveBeenCalledWith({
      host: "smtp.acme.com",
      port: 587,
      secure: false,
      auth: { user: "mailer", pass: "SMTP_SECRET" },
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: "reports@acme.com",
      to: "cfo@acme.com",
      subject: "AI P&L test email",
      text: "Your AI P&L email provider works. This is a test send from Settings.",
      attachments: [],
    });

    // The SMTP server's rejection, verbatim.
    sendMail.mockRejectedValueOnce(new Error("Invalid login: 535 Authentication failed"));
    const bad = await testSendRoute(
      postJson("/api/email/test", { to: "cfo@acme.com" }, adminCookie),
    );
    expect(bad.status).toBe(502);
    expect((await bad.json()).error).toBe("Invalid login: 535 Authentication failed");
  });

  it("Mailgun: basic auth against the from-domain, multipart fields", async () => {
    await settingsPatch(
      patchJson(
        "/api/settings",
        {
          email_provider_config: {
            provider: "mailgun",
            from: "reports@mg.acme.com",
            apiKey: "mg_SECRET_321",
          },
        },
        adminCookie,
      ),
    );
    const calls = stubFetch(
      new Response(JSON.stringify({ id: "<x>", message: "Queued." }), { status: 200 }),
    );
    const res = await testSendRoute(
      postJson("/api/email/test", { to: "cfo@acme.com" }, adminCookie),
    );
    expect(await res.json()).toEqual({ ok: true, provider: "mailgun" });
    expect(calls[0].url).toBe("https://api.mailgun.net/v3/mg.acme.com/messages");
    expect(calls[0].headers.authorization).toBe(
      `Basic ${Buffer.from("api:mg_SECRET_321").toString("base64")}`,
    );
    expect(calls[0].headers["content-type"]).toContain("multipart/form-data");
    const body = Buffer.from(calls[0].body as unknown as Uint8Array).toString("utf8");
    expect(body).toContain('name="from"\r\n\r\nreports@mg.acme.com');
    expect(body).toContain('name="to"\r\n\r\ncfo@acme.com');
    expect(body).toContain('name="subject"\r\n\r\nAI P&L test email');

    stubFetch(new Response(JSON.stringify({ message: "Forbidden" }), { status: 401 }));
    const bad = await testSendRoute(
      postJson("/api/email/test", { to: "cfo@acme.com" }, adminCookie),
    );
    expect(bad.status).toBe(502);
    expect((await bad.json()).error).toBe("Forbidden");
  });

  it("Mailgun multipart bytes are pinned (attachment as a file part)", () => {
    const { contentType, body } = buildMailgunBody({
      from: "a@mg.b.co",
      to: "c@d.co",
      subject: "s",
      text: "t",
      attachments: [
        {
          filename: "r.pdf",
          contentType: "application/pdf",
          content: Buffer.from("PDF").toString("base64"),
        },
      ],
    });
    expect(contentType).toBe('multipart/form-data; boundary="=_ai-pnl-form-boundary"');
    expect(body.toString("utf8")).toBe(
      '--=_ai-pnl-form-boundary\r\nContent-Disposition: form-data; name="from"\r\n\r\na@mg.b.co\r\n' +
        '--=_ai-pnl-form-boundary\r\nContent-Disposition: form-data; name="to"\r\n\r\nc@d.co\r\n' +
        '--=_ai-pnl-form-boundary\r\nContent-Disposition: form-data; name="subject"\r\n\r\ns\r\n' +
        '--=_ai-pnl-form-boundary\r\nContent-Disposition: form-data; name="text"\r\n\r\nt\r\n' +
        '--=_ai-pnl-form-boundary\r\nContent-Disposition: form-data; name="attachment"; filename="r.pdf"\r\n' +
        "Content-Type: application/pdf\r\n\r\nPDF\r\n" +
        "--=_ai-pnl-form-boundary--\r\n",
    );
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
