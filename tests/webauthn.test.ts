import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as loginOptions } from "../src/app/api/auth/login/passkey/options/route";
import { POST as loginVerify } from "../src/app/api/auth/login/passkey/verify/route";
import { POST as addOptions } from "../src/app/api/auth/passkey/options/route";
import { POST as addVerify } from "../src/app/api/auth/passkey/verify/route";
import { POST as setupOptions } from "../src/app/api/auth/setup/passkey/options/route";
import { POST as setupVerify } from "../src/app/api/auth/setup/passkey/verify/route";
import { GET as authState } from "../src/app/api/auth/state/route";
import { closePool } from "../src/lib/db";
import { resetRateLimits } from "../src/lib/rate-limit";
import { rpFromRequest } from "../src/lib/webauthn";
import { runMigrations } from "../scripts/migrate.mjs";
import { BASE, getJson, postJson, sessionCookieOf } from "./helpers/http";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";
import { SoftAuthenticator } from "./helpers/softauthn";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

describe("rpFromRequest", () => {
  it("derives RP id and origin from the request host", () => {
    const plain = rpFromRequest(new Request("http://localhost:3000/api/x"));
    expect(plain).toEqual({ rpID: "localhost", origin: "http://localhost:3000" });

    const proxied = rpFromRequest(
      new Request("http://127.0.0.1:3000/api/x", {
        headers: {
          "x-forwarded-host": "pnl.acme.com",
          "x-forwarded-proto": "https",
        },
      }),
    );
    expect(proxied).toEqual({ rpID: "pnl.acme.com", origin: "https://pnl.acme.com" });
  });
});

describe.runIf(TEST_DATABASE_URL)("passkeys end-to-end", () => {
  let dbUrl: string;
  let pool: Pool;
  let adminCookie: string;
  const authenticator = new SoftAuthenticator();
  const secondAuthenticator = new SoftAuthenticator();

  beforeAll(async () => {
    dbUrl = await createScratchDb("webauthn_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 3 });
    resetRateLimits();
  });

  afterAll(async () => {
    await closePool();
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  it("first boot: a passkey claims the instance and signs in", async () => {
    const optRes = await setupOptions(
      postJson("/api/auth/setup/passkey/options", { name: "Amit" }),
    );
    expect(optRes.status).toBe(200);
    const { challengeId, options } = await optRes.json();
    expect(options.rp.id).toBe("localhost");
    expect(options.user.name).toBe("Amit");

    const response = authenticator.register(options, BASE);
    const verifyRes = await setupVerify(
      postJson("/api/auth/setup/passkey/verify", { challengeId, name: "Amit", response }),
    );
    expect(verifyRes.status).toBe(200);
    expect((await verifyRes.json()).user.role).toBe("admin");
    adminCookie = sessionCookieOf(verifyRes);

    const creds = await pool.query("SELECT credential_id, counter FROM webauthn_credentials");
    expect(creds.rows).toEqual([
      { credential_id: authenticator.credentialIdB64, counter: "0" },
    ]);
  });

  it("claim endpoints refuse once claimed", async () => {
    const res = await setupOptions(
      postJson("/api/auth/setup/passkey/options", { name: "Mallory" }),
    );
    expect(res.status).toBe(409);
  });

  it("passkey login verifies the assertion and bumps the counter", async () => {
    const optRes = await loginOptions(postJson("/api/auth/login/passkey/options", {}));
    const { challengeId, options } = await optRes.json();
    expect(
      options.allowCredentials.map((c: { id: string }) => c.id),
    ).toContain(authenticator.credentialIdB64);

    const response = authenticator.authenticate(options, BASE);
    const verifyRes = await loginVerify(
      postJson("/api/auth/login/passkey/verify", { challengeId, response }),
    );
    expect(verifyRes.status).toBe(200);

    const state = await authState(getJson("/api/auth/state", sessionCookieOf(verifyRes)));
    expect((await state.json()).user).toMatchObject({ name: "Amit", role: "admin" });

    const { rows } = await pool.query(
      "SELECT counter, last_used_at FROM webauthn_credentials WHERE credential_id = $1",
      [authenticator.credentialIdB64],
    );
    expect(rows[0].counter).toBe("1");
    expect(rows[0].last_used_at).not.toBeNull();
  });

  it("challenges are single use", async () => {
    const optRes = await loginOptions(postJson("/api/auth/login/passkey/options", {}));
    const { challengeId, options } = await optRes.json();

    const first = await loginVerify(
      postJson("/api/auth/login/passkey/verify", {
        challengeId,
        response: authenticator.authenticate(options, BASE),
      }),
    );
    expect(first.status).toBe(200);

    const replay = await loginVerify(
      postJson("/api/auth/login/passkey/verify", {
        challengeId,
        response: authenticator.authenticate(options, BASE),
      }),
    );
    expect(replay.status).toBe(400);
  });

  it("an assertion for another origin is rejected", async () => {
    const { challengeId, options } = await (
      await loginOptions(postJson("/api/auth/login/passkey/options", {}))
    ).json();
    const res = await loginVerify(
      postJson("/api/auth/login/passkey/verify", {
        challengeId,
        response: authenticator.authenticate(options, BASE, {
          origin: "https://evil.example",
        }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("a tampered signature is rejected", async () => {
    const { challengeId, options } = await (
      await loginOptions(postJson("/api/auth/login/passkey/options", {}))
    ).json();
    const res = await loginVerify(
      postJson("/api/auth/login/passkey/verify", {
        challengeId,
        response: authenticator.authenticate(options, BASE, { corruptSignature: true }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("an unknown credential is rejected", async () => {
    const { challengeId, options } = await (
      await loginOptions(postJson("/api/auth/login/passkey/options", {}))
    ).json();
    const res = await loginVerify(
      postJson("/api/auth/login/passkey/verify", {
        challengeId,
        response: secondAuthenticator.authenticate(options, BASE),
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unknown passkey");
  });

  it("a signed-in user can add a passkey; the challenge is bound to them", async () => {
    const anon = await addOptions(postJson("/api/auth/passkey/options", {}));
    expect(anon.status).toBe(401);

    const optRes = await addOptions(postJson("/api/auth/passkey/options", {}, adminCookie));
    expect(optRes.status).toBe(200);
    const { challengeId, options } = await optRes.json();
    // existing passkey is excluded from re-registration
    expect(
      options.excludeCredentials.map((c: { id: string }) => c.id),
    ).toContain(authenticator.credentialIdB64);

    const verifyRes = await addVerify(
      postJson(
        "/api/auth/passkey/verify",
        { challengeId, response: secondAuthenticator.register(options, BASE) },
        adminCookie,
      ),
    );
    expect(verifyRes.status).toBe(200);

    const { rows } = await pool.query("SELECT count(*)::int AS n FROM webauthn_credentials");
    expect(rows[0].n).toBe(2);

    // the new passkey signs in
    const { challengeId: loginChallenge, options: loginOpts } = await (
      await loginOptions(postJson("/api/auth/login/passkey/options", {}))
    ).json();
    const login = await loginVerify(
      postJson("/api/auth/login/passkey/verify", {
        challengeId: loginChallenge,
        response: secondAuthenticator.authenticate(loginOpts, BASE),
      }),
    );
    expect(login.status).toBe(200);
  });

  it("a bogus or expired challengeId is rejected", async () => {
    const res = await loginVerify(
      postJson("/api/auth/login/passkey/verify", {
        challengeId: "00000000-0000-4000-8000-000000000000",
        response: authenticator.authenticate({ challenge: "xyz" }, BASE),
      }),
    );
    expect(res.status).toBe(400);
  });
});
