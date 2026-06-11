import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as importRoute } from "../src/app/api/people/import/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { closePool } from "../src/lib/db";
import { importPeople, parsePeopleCsv } from "../src/lib/people-import";
import { recomputeRollups } from "../src/lib/rollup";
import { runMigrations } from "../scripts/migrate.mjs";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

function csvRequest(text: string, opts: { cookie?: string; preview?: boolean } = {}): Request {
  return new Request(
    `http://localhost:3000/api/people/import${opts.preview ? "?preview=1" : ""}`,
    {
      method: "POST",
      headers: {
        "content-type": "text/csv",
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
      },
      body: text,
    },
  );
}

describe("parsePeopleCsv (spec 8: header auto-detect, per-row errors)", () => {
  it("auto-detects common header names, case- and punctuation-insensitive", () => {
    const parsed = parsePeopleCsv(
      'Email Address,Full Name\ndana@acme.dev,"Roth, Dana"\nomer@acme.dev,Omer Lev\n',
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.rows).toEqual([
      { line: 2, email: "dana@acme.dev", name: "Roth, Dana", error: null },
      { line: 3, email: "omer@acme.dev", name: "Omer Lev", error: null },
    ]);
  });

  it("joins first/last name columns and ignores extra columns", () => {
    const parsed = parsePeopleCsv(
      "given_name,Surname,Work Email,Department\nDana,Roth,dana@acme.dev,Eng\n",
    );
    expect(parsed.rows[0]).toEqual({
      line: 2,
      email: "dana@acme.dev",
      name: "Dana Roth",
      error: null,
    });
  });

  it("pins errors to rows: bad emails and in-file duplicates", () => {
    const parsed = parsePeopleCsv(
      "email\nnot-an-email\ndana@acme.dev\nDANA@acme.dev\n",
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.rows.map((r) => r.error)).toEqual([
      'bad email "not-an-email"',
      null,
      "duplicate of line 3",
    ]);
  });

  it("rejects structurally broken files outright", () => {
    expect(() => parsePeopleCsv("name\nDana\n")).toThrowError(/email column/);
    expect(() => parsePeopleCsv("   \n")).toThrowError(/empty/);
    expect(() => parsePeopleCsv("email,name\n")).toThrowError(/no rows/);
  });
});

describe.runIf(TEST_DATABASE_URL)("people CSV import (spec 8 In)", () => {
  let dbUrl: string;
  let pool: Pool;
  let adminCookie: string;
  let viewerCookie: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("people_import_test");
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

  it("imports, then re-imports as an upsert that never removes anyone", async () => {
    const first = await importPeople(
      parsePeopleCsv("email,name\ndana@acme.dev,Dana Roth\nomer@acme.dev,\n").rows,
      pool,
    );
    expect(first.created).toBe(2);
    expect(first.updated).toBe(0);

    // Re-import: case-insensitive email upsert; a missing name never
    // regresses an existing one; the absent person is NOT removed.
    const second = await importPeople(
      parsePeopleCsv("EMAIL,NAME\nDANA@ACME.DEV,\n").rows,
      pool,
    );
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);

    const { rows: people } = await pool.query(
      "SELECT email, name, source FROM people ORDER BY email",
    );
    expect(people).toEqual([
      { email: "dana@acme.dev", name: "Dana Roth", source: "csv" },
      { email: "omer@acme.dev", name: null, source: "csv" },
    ]);
  });

  it("auto-matches identities that synced before their person existed, history included", async () => {
    // A self-minted key synced a month of spend before anyone imported its
    // owner (spec 8: keys employees create on their own are auto-mapped).
    const { rows: identities } = await pool.query(
      `INSERT INTO identities (vendor, external_id, kind, email, display_name, tags)
       VALUES ('acme', 'key-maya', 'api_key', 'maya@acme.dev', 'maya-cli', '{maya-cli}')
       RETURNING id`,
    );
    await pool.query(
      `INSERT INTO spend_facts (day, identity_id, vendor, tokens, amount_cents, currency, cost_basis, source_ref)
       VALUES ('2026-06-01', $1, 'acme', 100, 700, 'USD', 'estimated', 'acme:1'),
              ('2026-06-02', $1, 'acme', 100, 300, 'USD', 'estimated', 'acme:2')`,
      [identities[0].id],
    );
    await recomputeRollups({ from: "2026-06-01", to: "2026-06-02" }, pool);

    const result = await importPeople(
      parsePeopleCsv("email,name\nmaya@acme.dev,Maya Peretz\n").rows,
      pool,
    );
    expect(result.matchedIdentities).toBe(1);
    expect(result.rollups).toEqual({ from: "2026-06-01", to: "2026-06-02" });

    // The identity's FULL history re-attributed (spec 4), rollups updated.
    const { rows: facts } = await pool.query(
      `SELECT count(*)::int AS n FROM spend_facts f
       JOIN people p ON p.id = f.person_id
       WHERE p.email = 'maya@acme.dev'`,
    );
    expect(facts[0].n).toBe(2);
    const { rows: rollup } = await pool.query(
      `SELECT sum(r.amount_usd_cents)::bigint AS total FROM rollup_daily r
       JOIN people p ON p.id = r.person_id
       WHERE p.email = 'maya@acme.dev'`,
    );
    expect(rollup[0].total).toBe("1000");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM rollup_daily WHERE person_id IS NULL",
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("identities marked not-a-person are never re-filled by an import", async () => {
    await pool.query(
      `INSERT INTO identities (vendor, external_id, kind, email, not_person)
       VALUES ('acme', 'svc-bot', 'api_key', 'omer@acme.dev', true)`,
    );
    const result = await importPeople(
      parsePeopleCsv("email,name\nomer@acme.dev,Omer Lev\n").rows,
      pool,
    );
    expect(result.matchedIdentities).toBe(0);
    const { rows } = await pool.query(
      "SELECT person_id FROM identities WHERE external_id = 'svc-bot'",
    );
    expect(rows[0].person_id).toBeNull();
  });

  it("route: admin-only, preview commits nothing, commit is all-or-nothing", async () => {
    const csv = "email,name\nrina@acme.dev,Rina\nbroken-email,Nobody\n";
    expect((await importRoute(csvRequest(csv))).status).toBe(401);
    expect((await importRoute(csvRequest(csv, { cookie: viewerCookie }))).status).toBe(403);

    // Preview: per-row verdicts, nothing written.
    const preview = await importRoute(csvRequest(csv, { cookie: adminCookie, preview: true }));
    expect(preview.status).toBe(200);
    const parsed = await preview.json();
    expect(parsed.ok).toBe(false);
    expect(parsed.rows[1].error).toBe('bad email "broken-email"');

    // Commit with a bad row: 400, the verdicts, and ZERO rows imported.
    const commit = await importRoute(csvRequest(csv, { cookie: adminCookie }));
    expect(commit.status).toBe(400);
    expect((await commit.json()).rows).toHaveLength(2);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM people WHERE email = 'rina@acme.dev'"))
        .rows[0].n,
    ).toBe(0);

    // The clean file imports.
    const ok = await importRoute(
      csvRequest("email,name\nrina@acme.dev,Rina Azulay\n", { cookie: adminCookie }),
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).created).toBe(1);

    expect((await importRoute(csvRequest("  ", { cookie: adminCookie }))).status).toBe(400);
  });
});
