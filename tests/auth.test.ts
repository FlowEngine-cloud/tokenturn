import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUT as putAccess } from "../src/app/api/people/[id]/access/route";
import { GET as personRoute } from "../src/app/api/people/[id]/route";
import { DELETE as deleteUser } from "../src/app/api/users/[id]/route";
import { GET as listUsers } from "../src/app/api/users/route";
import { POST as loginPassword } from "../src/app/api/auth/login/password/route";
import { POST as logout } from "../src/app/api/auth/logout/route";
import { POST as setOwnPassword } from "../src/app/api/auth/password/route";
import { POST as resetConsume } from "../src/app/api/auth/reset/consume/route";
import { POST as setupPassword } from "../src/app/api/auth/setup/password/route";
import { GET as authState } from "../src/app/api/auth/state/route";
import { createSession, getSessionUser, hashToken } from "../src/lib/auth";
import { closePool } from "../src/lib/db";
import { clearLicenseFile } from "../src/lib/license";
import { hashPassword, verifyPassword } from "../src/lib/password";
import { resetRateLimits } from "../src/lib/rate-limit";
import { runMigrations } from "../scripts/migrate.mjs";
import { mintResetToken } from "../scripts/reset-admin.mjs";
import { getJson, postJson, putJson, sessionCookieOf } from "./helpers/http";
import { licenseInstance, unpinTestLicenseKey } from "./helpers/license";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const execFileAsync = promisify(execFile);
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const RESET_ADMIN_CLI = path.resolve(__dirname, "..", "scripts", "reset-admin.mjs");

describe("password hashing", () => {
  it("round-trips and rejects wrong or malformed input", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash.startsWith("scrypt:")).toBe(true);
    expect(hash).not.toContain("correct horse battery");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
    expect(await verifyPassword("anything", "plaintext-not-a-hash")).toBe(false);
    expect(await verifyPassword("anything", null)).toBe(false);
    // same password, two hashes (random salt)
    expect(await hashPassword("correct horse battery")).not.toBe(hash);
  });
});

describe.runIf(TEST_DATABASE_URL)("auth flows", () => {
  let dbUrl: string;
  let pool: Pool;
  let adminCookie: string;
  let viewerCookie: string;
  let viewerId: string;
  let danaPersonId: string;

  const addPerson = async (email: string, name?: string): Promise<string> => {
    const { rows } = await pool.query(
      "INSERT INTO people (email, name, source) VALUES ($1, $2, 'manual') RETURNING id",
      [email, name ?? null],
    );
    return rows[0].id as string;
  };
  const putRole = (personId: string, body: unknown, cookie?: string) =>
    putAccess(putJson(`/api/people/${personId}/access`, body, cookie), {
      params: Promise.resolve({ id: personId }),
    });

  beforeAll(async () => {
    dbUrl = await createScratchDb("auth_test");
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

  it("reset-admin refuses while the instance is unclaimed", async () => {
    await expect(mintResetToken({ databaseUrl: dbUrl })).rejects.toThrow(
      /no admin/,
    );
  });

  it("the first visitor claims the instance as admin (password fallback)", async () => {
    const short = await setupPassword(
      postJson("/api/auth/setup/password", { name: "Amit", password: "short" }),
    );
    expect(short.status).toBe(400);

    const res = await setupPassword(
      postJson("/api/auth/setup/password", { name: "Amit", password: "first-boot-pass" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.role).toBe("admin");
    adminCookie = sessionCookieOf(res);

    // the session cookie is real: state shows the signed-in admin
    const state = await authState(getJson("/api/auth/state", adminCookie));
    expect(await state.json()).toMatchObject({
      claimed: true,
      user: { name: "Amit", role: "admin" },
    });
  });

  it("the instance can only be claimed once", async () => {
    const res = await setupPassword(
      postJson("/api/auth/setup/password", { name: "Mallory", password: "second-claim!" }),
    );
    expect(res.status).toBe(409);
  });

  it("a second admin is an enterprise feature - the API refuses unlicensed", async () => {
    // The DB-level one-admin index is gone (more admins is licensed, spec
    // 11); the enforcing layer is the license wall on the access API.
    const personId = await addPerson("other@acme.com", "Other");
    const res = await putRole(
      personId,
      { role: "admin", password: "longpassword" },
      adminCookie,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "Enterprise feature - contact hi@flowengine.cloud",
    );
  });

  it("password login: wrong creds 401, right creds open a session", async () => {
    resetRateLimits();
    const wrong = await loginPassword(
      postJson("/api/auth/login/password", { name: "Amit", password: "not-it-at-all" }),
    );
    expect(wrong.status).toBe(401);

    const unknown = await loginPassword(
      postJson("/api/auth/login/password", { name: "Nobody", password: "whatever123" }),
    );
    expect(unknown.status).toBe(401);

    const right = await loginPassword(
      postJson("/api/auth/login/password", { name: "amit", password: "first-boot-pass" }),
    );
    expect(right.status).toBe(200); // name match is case-insensitive
    expect(sessionCookieOf(right)).toContain("ai_pnl_session=");
  });

  it("rate-limits brute-force login attempts", async () => {
    resetRateLimits();
    for (let i = 0; i < 10; i++) {
      const res = await loginPassword(
        postJson("/api/auth/login/password", { name: "Amit", password: `guess-${i}-xx` }),
      );
      expect(res.status).toBe(401);
    }
    const eleventh = await loginPassword(
      postJson("/api/auth/login/password", { name: "Amit", password: "guess-11-xx" }),
    );
    expect(eleventh.status).toBe(429);
    resetRateLimits();
  });

  it("granting a person view-only sign-in: the viewer logs in but cannot write", async () => {
    danaPersonId = await addPerson("dana@acme.com", "Dana");
    const created = await putRole(
      danaPersonId,
      { role: "viewer", password: "viewer-pass-1" },
      adminCookie,
    );
    expect(created.status).toBe(200);
    expect((await created.json()).access.role).toBe("viewer");
    const { rows } = await pool.query("SELECT id FROM users WHERE person_id = $1", [
      danaPersonId,
    ]);
    viewerId = rows[0].id as string;

    // The email is the username.
    const login = await loginPassword(
      postJson("/api/auth/login/password", { name: "dana@acme.com", password: "viewer-pass-1" }),
    );
    expect(login.status).toBe(200);
    expect((await login.json()).user.role).toBe("viewer");
    viewerCookie = sessionCookieOf(login);

    // route-level role check: a viewer cannot grant sign-in or list logins
    const denied = await putRole(
      danaPersonId,
      { role: "admin", password: "evil-pass-99" },
      viewerCookie,
    );
    expect(denied.status).toBe(403);
    const deniedList = await listUsers(getJson("/api/users", viewerCookie));
    expect(deniedList.status).toBe(403);

    const list = await listUsers(getJson("/api/users", adminCookie));
    const { users } = await list.json();
    expect(users.map((u: { name: string }) => u.name).sort()).toEqual([
      "Amit",
      "dana@acme.com",
    ]);
    // The first-boot admin stays person-less (listed on People); the
    // granted login links to its person.
    type Row = { name: string; person_id: string | null };
    expect(users.find((u: Row) => u.name === "Amit").person_id).toBeNull();
    expect(users.find((u: Row) => u.name === "dana@acme.com").person_id).toBe(danaPersonId);

    // The person API reports the access state to admins only (spec 10.6).
    const adminView = await personRoute(
      getJson(`/api/people/${danaPersonId}`, adminCookie),
      { params: Promise.resolve({ id: danaPersonId }) },
    );
    expect((await adminView.json()).access).toEqual({ role: "viewer", isSelf: false });
    const viewerView = await personRoute(
      getJson(`/api/people/${danaPersonId}`, viewerCookie),
      { params: Promise.resolve({ id: danaPersonId }) },
    );
    expect((await viewerView.json()).access).toBeUndefined();
  });

  it("sign-in names stay unique, case-insensitively", async () => {
    // A person whose email collides with the existing "Amit" username.
    const personId = await addPerson("AMIT");
    const res = await putRole(
      personId,
      { role: "viewer", password: "another-pass-1" },
      adminCookie,
    );
    expect(res.status).toBe(409);
  });

  it("unauthenticated access management is rejected", async () => {
    expect((await listUsers(getJson("/api/users"))).status).toBe(401);
    expect((await putRole(danaPersonId, { role: "viewer" })).status).toBe(401);
  });

  it("Can sign in: admin is always offered, picking it is licensed (spec 10.6)", async () => {
    // Your own sign-in never changes here (the last admin can't demote out).
    const amitPersonId = await addPerson("amit@acme.com", "Amit");
    await pool.query("UPDATE users SET person_id = $1 WHERE role = 'admin'", [
      amitPersonId,
    ]);
    expect((await putRole(amitPersonId, { role: "viewer" }, adminCookie)).status).toBe(403);
    expect((await putRole(amitPersonId, { role: "none" }, adminCookie)).status).toBe(403);

    // Unlicensed promote: the locked-feature line, verbatim - the wall the
    // always-visible Admin option hits.
    const locked = await putRole(danaPersonId, { role: "admin" }, adminCookie);
    expect(locked.status).toBe(403);
    expect((await locked.json()).error).toBe(
      "Enterprise feature - contact hi@flowengine.cloud",
    );

    // Licensed: it works, both directions.
    await licenseInstance(pool, ["more_admins"]);
    try {
      const promoted = await putRole(danaPersonId, { role: "admin" }, adminCookie);
      expect(promoted.status).toBe(200);
      expect((await promoted.json()).access.role).toBe("admin");
      const demoted = await putRole(danaPersonId, { role: "viewer" }, adminCookie);
      expect(demoted.status).toBe(200);
      expect((await demoted.json()).access.role).toBe("viewer");
    } finally {
      await clearLicenseFile(pool);
      unpinTestLicenseKey();
    }
  });

  it("Can sign in: none removes the login and its sessions", async () => {
    const personId = await addPerson("nia@acme.com", "Nia");
    expect(
      (await putRole(personId, { role: "viewer", password: "nia-pass-123" }, adminCookie))
        .status,
    ).toBe(200);
    const login = await loginPassword(
      postJson("/api/auth/login/password", { name: "nia@acme.com", password: "nia-pass-123" }),
    );
    expect(login.status).toBe(200);
    const cookie = sessionCookieOf(login);

    const removed = await putRole(personId, { role: "none" }, adminCookie);
    expect(removed.status).toBe(200);
    expect((await removed.json()).access.role).toBeNull();

    const state = await authState(getJson("/api/auth/state", cookie));
    expect((await state.json()).user).toBeNull();
    resetRateLimits();
    const relogin = await loginPassword(
      postJson("/api/auth/login/password", { name: "nia@acme.com", password: "nia-pass-123" }),
    );
    expect(relogin.status).toBe(401);
  });

  it("the admin cannot be deleted", async () => {
    const { rows } = await pool.query("SELECT id FROM users WHERE role = 'admin'");
    const res = await deleteUser(getDelete(`/api/users/${rows[0].id}`, adminCookie), {
      params: Promise.resolve({ id: rows[0].id as string }),
    });
    expect(res.status).toBe(403);
  });

  it("deleting a viewer revokes their sessions", async () => {
    const res = await deleteUser(getDelete(`/api/users/${viewerId}`, adminCookie), {
      params: Promise.resolve({ id: viewerId }),
    });
    expect(res.status).toBe(200);

    const state = await authState(getJson("/api/auth/state", viewerCookie));
    expect((await state.json()).user).toBeNull();

    const login = await loginPassword(
      postJson("/api/auth/login/password", { name: "Dana", password: "viewer-pass-1" }),
    );
    expect(login.status).toBe(401);
  });

  it("logout destroys the session", async () => {
    const login = await loginPassword(
      postJson("/api/auth/login/password", { name: "Amit", password: "first-boot-pass" }),
    );
    const cookie = sessionCookieOf(login);
    const out = await logout(postJson("/api/auth/logout", {}, cookie));
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("01 Jan 1970");

    const state = await authState(getJson("/api/auth/state", cookie));
    expect((await state.json()).user).toBeNull();
  });

  it("expired sessions do not authenticate", async () => {
    const { rows } = await pool.query("SELECT id FROM users WHERE role = 'admin'");
    const { token } = await createSession(rows[0].id, pool);
    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE token_hash = $1", [
      hashToken(token),
    ]);
    expect(await getSessionUser(token, pool)).toBeNull();
  });

  it("reset-admin CLI prints a one-time link that recovers the admin", async () => {
    // the real CLI, as docker exec runs it
    const first = await execFileAsync(process.execPath, [RESET_ADMIN_CLI], {
      env: { ...process.env, DATABASE_URL: dbUrl },
    });
    const firstToken = first.stdout.match(/\/reset\/([A-Za-z0-9_-]+)/)?.[1];
    expect(firstToken).toBeTruthy();
    // only the hash is stored
    expect(
      (await pool.query("SELECT 1 FROM reset_tokens WHERE token_hash = $1", [firstToken]))
        .rows.length,
    ).toBe(0);

    // minting again voids the first link
    const second = await execFileAsync(process.execPath, [RESET_ADMIN_CLI], {
      env: { ...process.env, DATABASE_URL: dbUrl },
    });
    const secondToken = second.stdout.match(/\/reset\/([A-Za-z0-9_-]+)/)?.[1];
    expect(secondToken).toBeTruthy();
    expect(secondToken).not.toBe(firstToken);

    const voided = await resetConsume(
      postJson("/api/auth/reset/consume", { token: firstToken }),
    );
    expect(voided.status).toBe(400);

    // consuming the live link revokes old sessions and signs this browser in
    const consumed = await resetConsume(
      postJson("/api/auth/reset/consume", { token: secondToken }),
    );
    expect(consumed.status).toBe(200);
    const resetCookie = sessionCookieOf(consumed);
    const oldState = await authState(getJson("/api/auth/state", adminCookie));
    expect((await oldState.json()).user).toBeNull();

    // single use
    const replay = await resetConsume(
      postJson("/api/auth/reset/consume", { token: secondToken }),
    );
    expect(replay.status).toBe(400);

    // the fresh session can set a new password, which then logs in
    const set = await setOwnPassword(
      postJson("/api/auth/password", { password: "recovered-pass-9" }, resetCookie),
    );
    expect(set.status).toBe(200);
    const login = await loginPassword(
      postJson("/api/auth/login/password", { name: "Amit", password: "recovered-pass-9" }),
    );
    expect(login.status).toBe(200);
  });
});

describe.runIf(TEST_DATABASE_URL)("login-access migration backfill (017)", () => {
  it("email-matches existing logins to people; the unmatched keep working", async () => {
    const dbUrl = await createScratchDb("auth_backfill_test");
    const migPool = () => new Pool({ connectionString: dbUrl, max: 2 });
    try {
      // Apply everything before 017, then seed a pre-migration state.
      const all = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
      const cut = all.indexOf("017_login_access.sql");
      expect(cut).toBeGreaterThan(0);
      const tmp = await mkdtemp(path.join(os.tmpdir(), "ai-pnl-mig-"));
      for (const file of all.slice(0, cut)) {
        await copyFile(path.join(MIGRATIONS_DIR, file), path.join(tmp, file));
      }
      await runMigrations({ databaseUrl: dbUrl, dir: tmp });

      const pool = migPool();
      try {
        await pool.query(
          `INSERT INTO people (email, name) VALUES
             ('dana@acme.com', 'Dana'), ('lee@acme.com', 'Lee')`,
        );
        const { rows: sessions } = await pool.query(
          `INSERT INTO users (name, role) VALUES
             ('Amit', 'admin'), ('DANA@ACME.COM', 'viewer')
           RETURNING id`,
        );
        const danaToken = (await createSession(sessions[1].id, pool)).token;

        await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });

        const { rows } = await pool.query(
          `SELECT u.name, p.email
           FROM users u LEFT JOIN people p ON p.id = u.person_id
           ORDER BY u.name`,
        );
        expect(rows).toEqual([
          { name: "Amit", email: null }, // no email match - person-less, untouched
          { name: "DANA@ACME.COM", email: "dana@acme.com" }, // case-insensitive
        ]);
        // Existing sessions survive the migration.
        expect(await getSessionUser(danaToken, pool)).toMatchObject({
          role: "viewer",
        });
      } finally {
        await pool.end();
      }
    } finally {
      await dropScratchDb(dbUrl);
    }
  });
});

function getDelete(pathname: string, cookie?: string): Request {
  return new Request(`http://localhost:3000${pathname}`, {
    method: "DELETE",
    headers: cookie ? { cookie } : {},
  });
}
