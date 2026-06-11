import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as factsRoute } from "../src/app/api/facts/route";
import { GET as overviewRoute } from "../src/app/api/overview/route";
import { GET as runsRoute } from "../src/app/api/runs/route";
import { GET as searchRoute } from "../src/app/api/search/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { closePool } from "../src/lib/db";
import { recomputeRollups } from "../src/lib/rollup";
import { runMigrations } from "../scripts/migrate.mjs";
import { getJson } from "./helpers/http";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

describe.runIf(TEST_DATABASE_URL)("overview/facts/runs/search routes", () => {
  let dbUrl: string;
  let pool: Pool;
  let viewerCookie: string;
  let dana: string;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    dbUrl = await createScratchDb("overview_routes_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 3 });

    // Reads are for any session - a viewer proves it.
    const { rows: viewers } = await pool.query(
      "INSERT INTO users (name, role) VALUES ('Viewer', 'viewer') RETURNING id",
    );
    viewerCookie = `${SESSION_COOKIE}=${(await createSession(viewers[0].id, pool)).token}`;

    const { rows } = await pool.query(
      "INSERT INTO people (email, name) VALUES ('dana@acme.com', 'Dana') RETURNING id",
    );
    dana = rows[0].id;
    await pool.query(
      `INSERT INTO spend_facts
         (day, person_id, vendor, amount_cents, currency, cost_basis, source_ref)
       VALUES ($1, $2, 'anthropic', 12345, 'USD', 'estimated', 'usage:1'),
              ($1, NULL, 'anthropic', 555, 'USD', 'estimated', 'usage:2')`,
      [today, dana],
    );
    await recomputeRollups({ from: today, to: today }, pool);
    await pool.query(
      `INSERT INTO sync_runs (connector, status, rows_synced, error)
       VALUES ('anthropic', 'error', 0, 'permission_error: missing scope')`,
    );
  });

  afterAll(async () => {
    await closePool();
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  it("every read needs a session", async () => {
    expect((await overviewRoute(getJson("/api/overview"))).status).toBe(401);
    expect((await factsRoute(getJson("/api/facts"))).status).toBe(401);
    expect((await runsRoute(getJson("/api/runs"))).status).toBe(401);
    expect((await searchRoute(getJson("/api/search?q=x"))).status).toBe(401);
  });

  it("overview defaults to the trailing window and carries connector health", async () => {
    const res = await overviewRoute(getJson("/api/overview", viewerCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.to).toBe(today);
    expect(body.from < body.to).toBe(true);
    expect(body.totals.totalCents).toBe(12_900);
    expect(body.totals.assignedCents).toBe(12_345);
    expect(body.totals.unassignedCents).toBe(555);
    expect(body.byVendor).toMatchObject([
      { vendor: "anthropic", totalCents: 12_900, unassignedCents: 555 },
    ]);
    // All registered connectors report health, connected or not, with the
    // last error verbatim.
    const vendors = body.connectors.map((c: { vendor: string }) => c.vendor).sort();
    expect(vendors).toEqual(["anthropic", "cursor", "github", "openai"]);
    const anthropic = body.connectors.find(
      (c: { vendor: string }) => c.vendor === "anthropic",
    );
    expect(anthropic.connected).toBe(false);
    expect(anthropic.lastRun.error).toBe("permission_error: missing scope");
  });

  it("overview validates the range", async () => {
    expect(
      (await overviewRoute(getJson("/api/overview?from=junk", viewerCookie))).status,
    ).toBe(400);
    expect(
      (
        await overviewRoute(
          getJson("/api/overview?from=2026-06-05&to=2026-06-01", viewerCookie),
        )
      ).status,
    ).toBe(400);
  });

  it("facts drill matches the tile and exposes source refs", async () => {
    const res = await factsRoute(getJson(`/api/facts?person=${dana}`, viewerCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalCount).toBe(1);
    expect(body.totalDisplayCents).toBe(12_345);
    expect(body.rows[0]).toMatchObject({
      vendor: "anthropic",
      amountCents: 12_345,
      currency: "USD",
      sourceRef: "usage:1",
      personEmail: "dana@acme.com",
    });

    const unassigned = await factsRoute(
      getJson("/api/facts?person=unassigned&product=none", viewerCookie),
    );
    expect((await unassigned.json()).totalDisplayCents).toBe(555);
  });

  it("facts rejects bad filters", async () => {
    for (const query of [
      "person=not-a-uuid",
      "product=nope",
      "basis=guessed",
      "vendor=Not%20A%20Vendor",
      "day=junk",
      "from=junk",
      "limit=0",
      "limit=5000",
      "offset=-1",
    ]) {
      const res = await factsRoute(getJson(`/api/facts?${query}`, viewerCookie));
      expect(res.status, query).toBe(400);
    }
  });

  it("runs lists sync history with the vendor's error verbatim", async () => {
    const res = await runsRoute(getJson("/api/runs?vendor=anthropic", viewerCookie));
    expect(res.status).toBe(200);
    const { runs } = await res.json();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      connector: "anthropic",
      status: "error",
      error: "permission_error: missing scope",
    });
    expect(
      (await runsRoute(getJson("/api/runs?vendor=Bad%20Vendor", viewerCookie))).status,
    ).toBe(400);
    expect(
      (await runsRoute(getJson("/api/runs?limit=0", viewerCookie))).status,
    ).toBe(400);
  });

  it("search requires q and finds entities", async () => {
    expect((await searchRoute(getJson("/api/search", viewerCookie))).status).toBe(400);
    expect(
      (await searchRoute(getJson(`/api/search?q=${"x".repeat(81)}`, viewerCookie)))
        .status,
    ).toBe(400);

    const res = await searchRoute(getJson("/api/search?q=dana", viewerCookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.people.map((p: { email: string }) => p.email)).toEqual([
      "dana@acme.com",
    ]);
  });
});
