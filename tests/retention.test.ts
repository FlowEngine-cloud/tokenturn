import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DELETE as deletePerson } from "../src/app/api/people/[id]/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { closePool } from "../src/lib/db";
import { retentionCutoff, retentionTick } from "../src/lib/retention";
import { recomputeRollups } from "../src/lib/rollup";
import { setSetting } from "../src/lib/settings";
import { runMigrations } from "../scripts/migrate.mjs";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

/**
 * Spec 4: raw per-request facts keep 13 months (editable), daily rollups
 * forever - and the one exception to "nothing hard-deletes": GDPR person
 * delete, with rollups keeping the aggregate.
 */

function del(id: string, cookie?: string) {
  return deletePerson(
    new Request(`http://localhost:3000/api/people/${id}`, {
      method: "DELETE",
      headers: cookie ? { cookie } : {},
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("retention cutoff", () => {
  it("walks whole months back from the UTC day", () => {
    expect(retentionCutoff(new Date("2026-06-11T08:00:00Z"), 13)).toBe("2025-05-11");
    expect(retentionCutoff(new Date("2026-03-31T00:00:00Z"), 1)).toBe("2026-03-03"); // Feb 31 rolls
  });
});

describe.runIf(TEST_DATABASE_URL)("retention + GDPR delete (spec 4)", () => {
  let dbUrl: string;
  let pool: Pool;
  let adminCookie: string;
  let viewerCookie: string;
  const now = new Date("2026-06-11T08:00:00Z");

  beforeAll(async () => {
    dbUrl = await createScratchDb("retention_test");
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

  it("prunes raw facts past the horizon, keeps rollups, runs once per day", async () => {
    await pool.query(
      `INSERT INTO spend_facts (day, vendor, amount_cents, currency, cost_basis, source_ref) VALUES
       ('2024-01-15', 'openai', 1000, 'USD', 'estimated', 'old-1'),
       ('2025-05-10', 'openai', 2000, 'USD', 'estimated', 'old-2'),
       ('2025-05-11', 'openai', 3000, 'USD', 'estimated', 'kept-edge'),
       ('2026-06-01', 'openai', 4000, 'USD', 'estimated', 'kept-new')`,
    );
    await recomputeRollups({ from: "2024-01-15", to: "2024-01-15" }, pool);
    await recomputeRollups({ from: "2025-05-10", to: "2025-05-11" }, pool);

    const result = await retentionTick({ db: pool, now });
    expect(result).toEqual({
      ran: true,
      cutoffDay: "2025-05-11",
      factsDeleted: 2,
      ingestEventsDeleted: 0,
    });
    const { rows: left } = await pool.query("SELECT source_ref FROM spend_facts ORDER BY day");
    expect(left.map((r) => r.source_ref)).toEqual(["kept-edge", "kept-new"]);

    // Rollups keep the pruned days forever - the charts never lose history.
    const { rows: rolled } = await pool.query(
      "SELECT day::text, amount_usd_cents FROM rollup_daily WHERE day < '2025-05-11' ORDER BY day",
    );
    expect(rolled.length).toBe(2);
    expect(Number(rolled[0].amount_usd_cents)).toBe(1000);

    // Deduped: the same UTC day never prunes twice.
    expect((await retentionTick({ db: pool, now })).ran).toBe(false);
    // A new day prunes again, honoring the edited setting.
    await setSetting("raw_facts_retention_months", 1, pool);
    const tomorrow = new Date("2026-06-12T08:00:00Z");
    const second = await retentionTick({ db: pool, now: tomorrow });
    expect(second).toMatchObject({ ran: true, cutoffDay: "2026-05-12", factsDeleted: 1 });
  });

  it("GDPR delete: admin-only, scrubs the person, keeps the money as Unassigned", async () => {
    const { rows: people } = await pool.query(
      `INSERT INTO people (email, name) VALUES ('gone@acme.com', 'Gone Person') RETURNING id`,
    );
    const personId = people[0].id as string;
    const { rows: ids } = await pool.query(
      `INSERT INTO identities (person_id, vendor, external_id, kind, email, display_name) VALUES
        ($1, 'openai', 'user_g1', 'user', 'gone@acme.com', 'Gone Person'),
        ($1, 'openai', 'key_g1', 'api_key', 'gone@acme.com', 'batch-processing')
       RETURNING id`,
      [personId],
    );
    await pool.query(
      `INSERT INTO spend_facts (day, person_id, identity_id, vendor, amount_cents, currency, cost_basis, source_ref)
       VALUES ('2026-06-01', $1, $2, 'openai', 5000, 'USD', 'estimated', 'gdpr-fact')`,
      [personId, ids[0].id],
    );
    await recomputeRollups({ from: "2026-06-01", to: "2026-06-01" }, pool);
    const totalBefore = await pool.query(
      "SELECT sum(amount_usd_cents)::bigint AS total FROM rollup_daily WHERE day = '2026-06-01'",
    );

    expect((await del(personId)).status).toBe(401);
    expect((await del(personId, viewerCookie)).status).toBe(403);
    const res = await del(personId, adminCookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, identitiesScrubbed: 2 });
    expect((await del(personId, adminCookie)).status).toBe(404); // gone is gone

    // The person row is gone; identities survive scrubbed - vendor email
    // and user display name removed, key names (infrastructure tags) kept.
    expect(
      (await pool.query("SELECT 1 FROM people WHERE id = $1", [personId])).rows.length,
    ).toBe(0);
    const { rows: scrubbed } = await pool.query(
      `SELECT kind, person_id, email, display_name FROM identities
       WHERE external_id IN ('user_g1', 'key_g1') ORDER BY kind`,
    );
    expect(scrubbed).toEqual([
      { kind: "api_key", person_id: null, email: null, display_name: "batch-processing" },
      { kind: "user", person_id: null, email: null, display_name: null },
    ]);

    // The money stays - now Unassigned - and the rollup aggregate is intact.
    const { rows: fact } = await pool.query(
      "SELECT person_id, amount_cents FROM spend_facts WHERE source_ref = 'gdpr-fact'",
    );
    expect(fact[0].person_id).toBeNull();
    expect(Number(fact[0].amount_cents)).toBe(5000);
    const totalAfter = await pool.query(
      "SELECT sum(amount_usd_cents)::bigint AS total FROM rollup_daily WHERE day = '2026-06-01'",
    );
    expect(totalAfter.rows[0].total).toBe(totalBefore.rows[0].total);

    // Audited by id only - never the scrubbed identity.
    const { rows: auditRows } = await pool.query(
      "SELECT detail FROM audit_log WHERE action = 'person.gdpr_delete'",
    );
    expect(auditRows.length).toBe(1);
    expect(JSON.stringify(auditRows[0].detail)).not.toContain("gone@acme.com");
  });
});
