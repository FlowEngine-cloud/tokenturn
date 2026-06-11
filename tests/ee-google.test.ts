import { generateKeyPairSync, verify as rsaVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildJwtAssertion,
  connectGoogle,
  disconnectGoogle,
  fetchAccessToken,
  getGoogleConfig,
  GOOGLE_CONNECTOR,
  googleStatus,
  googleTick,
  parseUsersPage,
  TOKEN_URL,
  USERS_URL,
  validateGoogleInput,
} from "../ee/lib/google";
import { GET as googleGet } from "../src/app/api/ee/google/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { closePool } from "../src/lib/db";
import { EE_LOCKED_COPY } from "../src/lib/license";
import { ResolveError } from "../src/lib/resolve";
import { clearSecretKeyCache } from "../src/lib/secrets";
import { runMigrations } from "../scripts/migrate.mjs";
import { getJson } from "./helpers/http";
import { licenseInstance, unpinTestLicenseKey } from "./helpers/license";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const FIXTURES = path.resolve(__dirname, "fixtures", "ee");

const page1 = readFileSync(path.join(FIXTURES, "google-users-page1.json"), "utf8");
const page2 = readFileSync(path.join(FIXTURES, "google-users-page2.json"), "utf8");

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const SA_JSON = JSON.stringify({
  type: "service_account",
  project_id: "acme-ai-pnl",
  private_key_id: "fixture",
  private_key: SA_KEY_PEM,
  client_email: "ai-pnl@acme-ai-pnl.iam.gserviceaccount.com",
  client_id: "1234567890",
  token_uri: "https://oauth2.googleapis.com/token",
});

const CONFIG = validateGoogleInput({ serviceAccountJson: SA_JSON, adminEmail: "admin@acme.com" });

function googleFetch(overrides: Record<string, () => Response> = {}) {
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
    if (url === TOKEN_URL) {
      return new Response(
        JSON.stringify({ access_token: "ya29.fixture-token", expires_in: 3599, token_type: "Bearer" }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith(USERS_URL)) {
      const pageToken = new URL(url).searchParams.get("pageToken");
      return new Response(pageToken === "fixture-page-2" ? page2 : page1, {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  return { impl, calls };
}

describe("google workspace plumbing", () => {
  it("validates the connect input with the problem named", () => {
    expect(() => validateGoogleInput(null)).toThrow(ResolveError);
    expect(() => validateGoogleInput({ serviceAccountJson: SA_JSON, adminEmail: "nope" })).toThrow(
      /adminEmail/,
    );
    expect(() => validateGoogleInput({ serviceAccountJson: "{]", adminEmail: "a@b.co" })).toThrow(
      /not valid JSON/,
    );
    expect(() =>
      validateGoogleInput({ serviceAccountJson: "{}", adminEmail: "a@b.co" }),
    ).toThrow(/client_email or private_key/);
    expect(() =>
      validateGoogleInput({
        serviceAccountJson: JSON.stringify({ client_email: "x@y.iam", private_key: "garbage" }),
        adminEmail: "a@b.co",
      }),
    ).toThrow(/not a valid key/);
    expect(CONFIG.clientEmail).toBe("ai-pnl@acme-ai-pnl.iam.gserviceaccount.com");
  });

  it("signs a real RS256 JWT grant: impersonation subject, read-only scope", () => {
    const now = new Date("2026-06-11T12:00:00Z");
    const jwt = buildJwtAssertion(CONFIG, now);
    const [head, claims, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const payload = JSON.parse(Buffer.from(claims, "base64url").toString());
    expect(payload).toEqual({
      iss: "ai-pnl@acme-ai-pnl.iam.gserviceaccount.com",
      sub: "admin@acme.com",
      scope: "https://www.googleapis.com/auth/admin.directory.user.readonly",
      aud: TOKEN_URL,
      iat: 1781179200,
      exp: 1781182800,
    });
    expect(
      rsaVerify(
        "RSA-SHA256",
        Buffer.from(`${head}.${claims}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("exchanges the JWT for a token; Google's rejection comes back verbatim", async () => {
    const { impl, calls } = googleFetch();
    expect(await fetchAccessToken(CONFIG, { fetch: impl })).toBe("ya29.fixture-token");
    const body = new URLSearchParams(calls[0].body!);
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(body.get("assertion")).toMatch(/^eyJ/);

    const denied = googleFetch({
      [TOKEN_URL]: () =>
        new Response(
          JSON.stringify({ error: "unauthorized_client", error_description: "Client is unauthorized to retrieve access tokens using this method" }),
          { status: 401 },
        ),
    });
    await expect(fetchAccessToken(CONFIG, { fetch: denied.impl })).rejects.toThrow(
      "google 401 on token exchange: Client is unauthorized to retrieve access tokens using this method",
    );
  });

  it("parses users pages - suspended/archived skipped, names kept", () => {
    const parsed = parseUsersPage(JSON.parse(page1));
    expect(parsed.users).toEqual([{ email: "dana@acme.com", name: "Dana Levi" }]);
    expect(parsed.nextPageToken).toBe("fixture-page-2");
    expect(parseUsersPage(JSON.parse(page2))).toEqual({
      users: [{ email: "noa@acme.com", name: "Noa Stern" }],
      nextPageToken: null,
    });
    expect(() => parseUsersPage({ users: [{ primaryEmail: "x@y.co" }] })).toThrow(
      /missing or invalid "suspended"/,
    );
  });
});

describe.runIf(TEST_DATABASE_URL)("google workspace roster sync (spec 11)", () => {
  let dbUrl: string;
  let pool: Pool;
  let adminCookie: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("google_test");
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

  it("locked without the license - the exact line - and the tick is a no-op", async () => {
    const res = await googleGet(getJson("/api/ee/google", adminCookie));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(EE_LOCKED_COPY);
    expect(await googleTick({ db: pool })).toEqual({
      ran: false,
      created: 0,
      updated: 0,
      error: null,
    });
  });

  it("connect probes the token + one page, stores the key encrypted", async () => {
    await licenseInstance(pool, ["google_workspace"]);

    const denied = googleFetch({
      [USERS_URL]: () =>
        new Response(JSON.stringify({ error: { code: 403, message: "Not Authorized to access this resource/api" } }), {
          status: 403,
        }),
    });
    await expect(connectGoogle(CONFIG, { db: pool, fetch: denied.impl })).rejects.toThrow(
      "google 403 on users.list: Not Authorized to access this resource/api",
    );
    expect(await getGoogleConfig({ db: pool })).toBeNull();

    await connectGoogle(CONFIG, { db: pool, fetch: googleFetch().impl });
    const { rows } = await pool.query(
      "SELECT value::text AS v, secret FROM settings WHERE key = 'directory:google:config'",
    );
    expect(rows[0].secret).toBe(true);
    expect(rows[0].v).not.toContain("PRIVATE KEY");
  });

  it("the tick pages the whole directory and upserts through the import path", async () => {
    // dana exists from a CSV with a name typo; the sync may fix the name but
    // never duplicates or removes.
    await pool.query("INSERT INTO people (email, name, source) VALUES ('dana@acme.com', NULL, 'csv')");

    const result = await googleTick({ db: pool, fetch: googleFetch().impl, force: true });
    expect(result).toEqual({ ran: true, created: 1, updated: 1, error: null });
    const { rows: people } = await pool.query(
      "SELECT email, name, source FROM people ORDER BY email",
    );
    expect(people).toEqual([
      { email: "dana@acme.com", name: "Dana Levi", source: "google" },
      { email: "noa@acme.com", name: "Noa Stern", source: "google" },
    ]);
    const { rows: runs } = await pool.query(
      "SELECT status, rows_synced FROM sync_runs WHERE connector = $1 ORDER BY id DESC LIMIT 1",
      [GOOGLE_CONNECTOR],
    );
    expect(runs[0].status).toBe("success");
    expect(Number(runs[0].rows_synced)).toBe(2);

    // Within the hour the tick is not due; force runs anyway.
    expect((await googleTick({ db: pool, fetch: googleFetch().impl })).ran).toBe(false);
  });

  it("a provider failure lands in the run history verbatim; disconnect forgets", async () => {
    const failing = googleFetch({
      [TOKEN_URL]: () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: "Invalid JWT Signature." }), {
          status: 400,
        }),
    });
    const result = await googleTick({ db: pool, fetch: failing.impl, force: true });
    expect(result.ran).toBe(true);
    expect(result.error).toBe("google 400 on token exchange: Invalid JWT Signature.");
    const { rows } = await pool.query(
      "SELECT status, error FROM sync_runs WHERE connector = $1 ORDER BY id DESC LIMIT 1",
      [GOOGLE_CONNECTOR],
    );
    expect(rows[0].error).toContain("Invalid JWT Signature.");

    const status = await googleStatus({ db: pool });
    expect(status.connected).toBe(true);
    expect(status.lastRun?.status).toBe("error");

    expect(await disconnectGoogle({ db: pool })).toBe(true);
    expect(await getGoogleConfig({ db: pool })).toBeNull();
  });
});
