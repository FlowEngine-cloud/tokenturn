import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as auditRoute } from "../src/app/api/audit/route";
import { PUT as accessRoute } from "../src/app/api/people/[id]/access/route";
import { DELETE as deleteUserRoute } from "../src/app/api/users/[id]/route";
import { audit, auditLogCsv, listAuditLog } from "../src/lib/audit";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { closePool } from "../src/lib/db";
import { EE_LOCKED_COPY } from "../src/lib/license";
import { runMigrations } from "../scripts/migrate.mjs";
import { getJson, putJson } from "./helpers/http";
import { licenseInstance, unpinTestLicenseKey } from "./helpers/license";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

/**
 * Audit log (spec 11): recording is always on; viewing/exporting is the
 * licensed feature, and more admins is its own licensed feature - both
 * answer the exact locked line without a grant.
 */

describe.runIf(TEST_DATABASE_URL)("audit log + more admins (spec 11)", () => {
  let dbUrl: string;
  let pool: Pool;
  let adminId: string;
  let adminCookie: string;
  let viewerCookie: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("audit_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 3 });

    const { rows: admins } = await pool.query(
      "INSERT INTO users (name, role) VALUES ('Admin', 'admin') RETURNING id",
    );
    adminId = admins[0].id;
    adminCookie = `${SESSION_COOKIE}=${(await createSession(adminId, pool)).token}`;
    const { rows: viewers } = await pool.query(
      "INSERT INTO users (name, role) VALUES ('Viewer', 'viewer') RETURNING id",
    );
    viewerCookie = `${SESSION_COOKIE}=${(await createSession(viewers[0].id, pool)).token}`;
  });

  afterAll(async () => {
    unpinTestLicenseKey();
    await closePool();
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  it("records always - even on an unlicensed instance - and never throws", async () => {
    await audit("system", "test.system", { a: 1 }, pool);
    await audit(
      { id: adminId, name: "Admin", role: "admin" },
      "test.admin",
      { swept: ["k1"] },
      pool,
    );
    const rows = await listAuditLog({}, pool);
    expect(rows.length).toBe(2);
    expect(rows[0].action).toBe("test.admin"); // newest first
    expect(rows[0].actorName).toBe("Admin");
    expect(rows[1].actorName).toBe("system");
    expect(rows[1].detail).toEqual({ a: 1 });

    // A broken write can never break the audited action.
    await expect(audit("system", "x", {}, { query: () => Promise.reject(new Error("down")) } as never)).resolves.toBeUndefined();
  });

  it("viewing is admin-only and license-gated with the exact line", async () => {
    expect((await auditRoute(getJson("/api/audit"))).status).toBe(401);
    expect((await auditRoute(getJson("/api/audit", viewerCookie))).status).toBe(403);

    const locked = await auditRoute(getJson("/api/audit", adminCookie));
    expect(locked.status).toBe(403);
    expect((await locked.json()).error).toBe(EE_LOCKED_COPY);

    await licenseInstance(pool, ["audit_log"]);
    const res = await auditRoute(getJson("/api/audit", adminCookie));
    expect(res.status).toBe(200);
    const { entries } = await res.json();
    // The license install itself was audited.
    expect(entries[0].action).toBe("test.admin");
    expect(entries.map((e: { action: string }) => e.action)).toContain("test.system");
  });

  it("pages newest-first via before=, and exports the whole log as CSV", async () => {
    const page1 = await (
      await auditRoute(getJson("/api/audit?limit=1", adminCookie))
    ).json();
    expect(page1.entries.length).toBe(1);
    const page2 = await (
      await auditRoute(getJson(`/api/audit?limit=50&before=${page1.entries[0].id}`, adminCookie))
    ).json();
    expect(Number(page2.entries[0].id)).toBeLessThan(Number(page1.entries[0].id));

    const csvRes = await auditRoute(getJson("/api/audit?format=csv", adminCookie));
    expect(csvRes.headers.get("content-type")).toContain("text/csv");
    const csv = await csvRes.text();
    expect(csv.split("\n")[0]).toBe("id,ts,actor,action,detail");
    expect(csv).toContain("test.system");
    expect(csv).toContain('"{""swept"":[""k1""]}"'); // JSON detail CSV-escaped
    expect(csv).toBe(await auditLogCsv(pool));
  });

  it("more admins: locked without the feature (exact line), granted with it", async () => {
    await licenseInstance(pool, ["audit_log"]); // no more_admins
    const addPerson = async (email: string): Promise<string> => {
      const { rows } = await pool.query(
        "INSERT INTO people (email) VALUES ($1) RETURNING id",
        [email],
      );
      return rows[0].id as string;
    };
    const putRole = (personId: string, body: unknown) =>
      accessRoute(putJson(`/api/people/${personId}/access`, body, adminCookie), {
        params: Promise.resolve({ id: personId }),
      });

    const secondId = await addPerson("second@acme.com");
    const locked = await putRole(secondId, { role: "admin", password: "longpassword" });
    expect(locked.status).toBe(403);
    expect((await locked.json()).error).toBe(EE_LOCKED_COPY);

    // Viewers stay free.
    expect(
      (
        await putRole(await addPerson("free.viewer@acme.com"), {
          role: "viewer",
          password: "longpassword",
        })
      ).status,
    ).toBe(200);

    await licenseInstance(pool, ["more_admins"]);
    const res = await putRole(secondId, { role: "admin", password: "longpassword" });
    expect(res.status).toBe(200);
    expect((await res.json()).access.role).toBe("admin");
    const { rows: granted } = await pool.query(
      "SELECT id FROM users WHERE person_id = $1",
      [secondId],
    );

    // A second admin is removable; yourself never (so the last admin can
    // never disappear - lost-credential recovery is reset-admin, not delete).
    const del = (id: string) =>
      deleteUserRoute(getJsonDelete(`/api/users/${id}`, adminCookie), {
        params: Promise.resolve({ id }),
      });
    const self = await del(adminId);
    expect(self.status).toBe(403);
    expect((await self.json()).error).toContain("yourself");
    expect((await del(granted[0].id as string)).status).toBe(200);

    // Every grant landed in the log (spec 11: every settings change).
    const actions = (await listAuditLog({}, pool)).map((entry) => entry.action);
    expect(actions).toContain("person.access");
  });
});

function getJsonDelete(path: string, cookie?: string): Request {
  return new Request(`http://localhost:3000${path}`, {
    method: "DELETE",
    headers: cookie ? { cookie } : {},
  });
}
