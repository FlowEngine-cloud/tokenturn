import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as factsRoute } from "../src/app/api/facts/route";
import { GET as keyRoute } from "../src/app/api/keys/[id]/route";
import { GET as outcomesRoute } from "../src/app/api/outcomes/route";
import { GET as personRoute } from "../src/app/api/people/[id]/route";
import { GET as peopleRoute } from "../src/app/api/people/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { closePool } from "../src/lib/db";
import { recomputeRollups } from "../src/lib/rollup";
import { runMigrations } from "../scripts/migrate.mjs";
import { getJson } from "./helpers/http";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe.runIf(TEST_DATABASE_URL)("people/keys/outcomes routes", () => {
  let dbUrl: string;
  let pool: Pool;
  let viewerCookie: string;
  let dana: string;
  let merged: string;
  let keyId: string;
  let product: string;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    dbUrl = await createScratchDb("people_routes_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 3 });

    // Reads are for any session - a viewer proves it.
    const { rows: viewers } = await pool.query(
      "INSERT INTO users (name, role) VALUES ('Viewer', 'viewer') RETURNING id",
    );
    viewerCookie = `${SESSION_COOKIE}=${(await createSession(viewers[0].id, pool)).token}`;

    const { rows: people } = await pool.query(
      `INSERT INTO people (email, name) VALUES ('dana@acme.com', 'Dana') RETURNING id`,
    );
    dana = people[0].id;
    const { rows: mergedRows } = await pool.query(
      `INSERT INTO people (email, status, merged_into)
       VALUES ('dana.old@acme.com', 'archived', $1) RETURNING id`,
      [dana],
    );
    merged = mergedRows[0].id;
    const { rows: keys } = await pool.query(
      `INSERT INTO identities (person_id, vendor, external_id, kind, tags)
       VALUES ($1, 'anthropic', 'key_1', 'api_key', '{coding}') RETURNING id`,
      [dana],
    );
    keyId = keys[0].id;
    const { rows: products } = await pool.query(
      `INSERT INTO products (name, attribution, outcome_kind)
       VALUES ('supportbot', 'sdk', 'sdk_event') RETURNING id`,
    );
    product = products[0].id;

    await pool.query(
      `INSERT INTO spend_facts
         (day, person_id, identity_id, vendor, model, amount_cents, currency,
          cost_basis, source_ref)
       VALUES ($1, $2, $3, 'anthropic', 'claude-sonnet-4', 12345, 'USD', 'estimated', 'u1')`,
      [today, dana, keyId],
    );
    await pool.query(
      `INSERT INTO outcomes (ts, product_id, person_id, kind, source_ref)
       VALUES (now(), $1, $2, 'ticket_resolved', 't1')`,
      [product, dana],
    );
    await recomputeRollups({ from: today, to: today }, pool);
  });

  afterAll(async () => {
    await closePool();
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  it("every read needs a session", async () => {
    expect((await peopleRoute(getJson("/api/people"))).status).toBe(401);
    expect(
      (await personRoute(getJson(`/api/people/${dana}`), params(dana))).status,
    ).toBe(401);
    expect((await keyRoute(getJson(`/api/keys/${keyId}`), params(keyId))).status).toBe(401);
    expect((await outcomesRoute(getJson("/api/outcomes"))).status).toBe(401);
  });

  it("people list defaults to the trailing window and matches its drills", async () => {
    const res = await peopleRoute(getJson("/api/people", viewerCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.to).toBe(today);
    expect(body.people).toHaveLength(1);
    expect(body.people[0]).toMatchObject({
      personId: dana,
      email: "dana@acme.com",
      totalCents: 12_345,
      outcomeCount: 1,
      unitCostCents: 12_345,
    });

    // The row's number equals the facts drill through the route.
    const drill = await factsRoute(
      getJson(`/api/facts?from=${body.from}&to=${body.to}&person=${dana}`, viewerCookie),
    );
    const drillBody = await drill.json();
    expect(drillBody.totalDisplayCents).toBe(body.people[0].totalCents);

    // And the outcome count equals the outcomes drill.
    const outcomes = await outcomesRoute(
      getJson(`/api/outcomes?from=${body.from}&to=${body.to}&person=${dana}`, viewerCookie),
    );
    const outcomesBody = await outcomes.json();
    expect(outcomesBody.liveCount).toBe(body.people[0].outcomeCount);
    expect(outcomesBody.rows[0].sourceRef).toBe("t1");
  });

  it("person detail answers, follows merges, and 404s the unknown", async () => {
    const res = await personRoute(
      getJson(`/api/people/${dana}?from=${today}&to=${today}`, viewerCookie),
      params(dana),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totals.cents).toBe(12_345);
    expect(body.keys.map((k: { id: string }) => k.id)).toEqual([keyId]);

    const viaMerged = await personRoute(
      getJson(`/api/people/${merged}`, viewerCookie),
      params(merged),
    );
    expect((await viaMerged.json()).person.id).toBe(dana);

    const missing = await personRoute(
      getJson("/api/people/00000000-0000-4000-8000-000000000000", viewerCookie),
      params("00000000-0000-4000-8000-000000000000"),
    );
    expect(missing.status).toBe(404);
  });

  it("key detail answers with models and 404s the unknown", async () => {
    const res = await keyRoute(getJson(`/api/keys/${keyId}`, viewerCookie), params(keyId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.owner.id).toBe(dana);
    expect(body.totalCents).toBe(12_345);
    expect(body.models).toMatchObject([{ model: "claude-sonnet-4", cents: 12_345 }]);
    expect(body.tags).toMatchObject([{ tag: "coding", source: "vendor" }]);

    const missing = await keyRoute(
      getJson("/api/keys/00000000-0000-4000-8000-000000000000", viewerCookie),
      params("00000000-0000-4000-8000-000000000000"),
    );
    expect(missing.status).toBe(404);
  });

  it("validates every filter input loudly", async () => {
    const bad = [
      await peopleRoute(getJson("/api/people?from=junk", viewerCookie)),
      await peopleRoute(
        getJson("/api/people?from=2026-06-05&to=2026-06-01", viewerCookie),
      ),
      await personRoute(getJson("/api/people/nope", viewerCookie), params("nope")),
      await personRoute(
        getJson(`/api/people/${dana}?to=junk`, viewerCookie),
        params(dana),
      ),
      await keyRoute(getJson("/api/keys/nope", viewerCookie), params("nope")),
      await outcomesRoute(getJson("/api/outcomes?person=zzz", viewerCookie)),
      await outcomesRoute(getJson("/api/outcomes?product=zzz", viewerCookie)),
      await outcomesRoute(getJson(`/api/outcomes?kind=${"x".repeat(101)}`, viewerCookie)),
      await outcomesRoute(getJson("/api/outcomes?limit=0", viewerCookie)),
      await outcomesRoute(getJson("/api/outcomes?limit=1001", viewerCookie)),
      await factsRoute(getJson("/api/facts?key=zzz", viewerCookie)),
      await factsRoute(getJson(`/api/facts?model=${"x".repeat(201)}`, viewerCookie)),
    ];
    for (const res of bad) expect(res.status).toBe(400);
  });

  it("facts route filters by key and model", async () => {
    const res = await factsRoute(
      getJson(`/api/facts?key=${keyId}&model=claude-sonnet-4`, viewerCookie),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalDisplayCents).toBe(12_345);
    expect(body.rows).toHaveLength(1);

    const none = await factsRoute(
      getJson(`/api/facts?key=${keyId}&model=none`, viewerCookie),
    );
    expect((await none.json()).totalCount).toBe(0);
  });
});
