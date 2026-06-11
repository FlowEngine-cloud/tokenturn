import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DELETE as disconnectRoute,
  GET as connectorRoute,
} from "../src/app/api/connectors/[vendor]/route";
import { POST as connectRoute } from "../src/app/api/connectors/[vendor]/connect/route";
import { POST as syncRoute } from "../src/app/api/connectors/[vendor]/sync/route";
import { GET as listRoute } from "../src/app/api/connectors/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { clearConnectors, registerConnector } from "../src/lib/connectors/registry";
import { closePool } from "../src/lib/db";
import { runMigrations } from "../scripts/migrate.mjs";
import { makeStubConnector } from "./helpers/fixture-connector";
import { getJson, postJson } from "./helpers/http";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

function params(vendor: string) {
  return { params: Promise.resolve({ vendor }) };
}

function deleteReq(path_: string, cookie?: string): Request {
  return new Request(`http://localhost:3000${path_}`, {
    method: "DELETE",
    headers: cookie ? { cookie } : {},
  });
}

describe.runIf(TEST_DATABASE_URL)("connector API routes", () => {
  let dbUrl: string;
  let pool: Pool;
  let adminCookie: string;
  let viewerCookie: string;
  const stub = makeStubConnector("stub_api");

  beforeAll(async () => {
    dbUrl = await createScratchDb("connector_routes_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 3 });
    clearConnectors();
    registerConnector(stub);
    registerConnector(
      makeStubConnector("stub_reject", {
        rejectScopes: 'This token only has the "billing:read" scope.',
      }),
    );

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
    clearConnectors();
  });

  it("every route requires a session; mutations require the admin", async () => {
    expect((await listRoute(getJson("/api/connectors"))).status).toBe(401);
    expect(
      (await connectorRoute(getJson("/api/connectors/stub_api"), params("stub_api"))).status,
    ).toBe(401);
    expect(
      (
        await connectRoute(
          postJson("/api/connectors/stub_api/connect", { config: {} }, viewerCookie),
          params("stub_api"),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await syncRoute(
          postJson("/api/connectors/stub_api/sync", {}, viewerCookie),
          params("stub_api"),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await disconnectRoute(deleteReq("/api/connectors/stub_api", viewerCookie), params("stub_api"))
      ).status,
    ).toBe(403);
  });

  it("viewers can read the health surface", async () => {
    const res = await listRoute(getJson("/api/connectors", viewerCookie));
    expect(res.status).toBe(200);
    const { connectors } = await res.json();
    const vendors = connectors.map((c: { vendor: string }) => c.vendor);
    expect(vendors).toEqual(["stub_api", "stub_reject"]);
    expect(connectors[0]).toMatchObject({
      vendor: "stub_api",
      connected: false,
      lastRun: null,
      rowCounts: { spendFacts: 0, identities: 0 },
    });
  });

  it("connect validates the payload and the vendor", async () => {
    const unknown = await connectRoute(
      postJson("/api/connectors/nope/connect", { config: {} }, adminCookie),
      params("nope"),
    );
    expect(unknown.status).toBe(404);

    const badShape = await connectRoute(
      postJson("/api/connectors/stub_api/connect", { config: "token" }, adminCookie),
      params("stub_api"),
    );
    expect(badShape.status).toBe(400);
  });

  it("a token that fails scope validation comes back 422, verbatim, storing nothing", async () => {
    const res = await connectRoute(
      postJson("/api/connectors/stub_reject/connect", { config: { apiKey: "bad" } }, adminCookie),
      params("stub_reject"),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('This token only has the "billing:read" scope.');
    const { rows } = await pool.query(
      "SELECT 1 FROM connectors WHERE vendor = 'stub_reject'",
    );
    expect(rows).toHaveLength(0);
  });

  it("connect stores the config encrypted and kicks off the backfill", async () => {
    const res = await connectRoute(
      postJson(
        "/api/connectors/stub_api/connect",
        { config: { apiKey: "stub_secret_token_555" } },
        adminCookie,
      ),
      params("stub_api"),
    );
    expect(res.status).toBe(201);
    const { connector } = await res.json();
    expect(connector).toMatchObject({
      vendor: "stub_api",
      historyLimitDays: 31,
      scopes: ["usage:read"],
    });

    const { rows } = await pool.query(
      "SELECT value, secret FROM settings WHERE key = 'connector:stub_api:config'",
    );
    expect(rows[0].secret).toBe(true);
    expect(rows[0].value.startsWith("v1:")).toBe(true);
    expect(JSON.stringify(rows[0].value)).not.toContain("stub_secret_token_555");

    // The background backfill lands rows; poll health until it shows up.
    let health;
    for (let i = 0; i < 40; i++) {
      const healthRes = await connectorRoute(
        getJson("/api/connectors/stub_api", viewerCookie),
        params("stub_api"),
      );
      health = (await healthRes.json()).connector;
      if (health.lastRun?.status === "success") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(health.lastRun.status).toBe("success");
    expect(health.connected).toBe(true);
    expect(health.rowCounts.spendFacts).toBe(1);
  });

  it("sync-now runs inline and reports the run", async () => {
    const res = await syncRoute(
      postJson("/api/connectors/stub_api/sync", {}, adminCookie),
      params("stub_api"),
    );
    expect(res.status).toBe(200);
    const { run } = await res.json();
    expect(run.status).toBe("success");
    expect(run.window.until).toBe(new Date().toISOString().slice(0, 10));

    const notConnected = await syncRoute(
      postJson("/api/connectors/stub_reject/sync", {}, adminCookie),
      params("stub_reject"),
    );
    expect(notConnected.status).toBe(409);
    expect((await notConnected.json()).error).toMatch(/not connected/);
  });

  it("disconnect forgets credentials but keeps the synced history", async () => {
    const res = await disconnectRoute(
      deleteReq("/api/connectors/stub_api", adminCookie),
      params("stub_api"),
    );
    expect(res.status).toBe(200);

    const { rows: secrets } = await pool.query(
      "SELECT 1 FROM settings WHERE key = 'connector:stub_api:config'",
    );
    expect(secrets).toHaveLength(0);

    const healthRes = await connectorRoute(
      getJson("/api/connectors/stub_api", viewerCookie),
      params("stub_api"),
    );
    const { connector } = await healthRes.json();
    expect(connector.connected).toBe(false);
    expect(connector.rowCounts.spendFacts).toBeGreaterThan(0); // history stays

    const again = await disconnectRoute(
      deleteReq("/api/connectors/stub_api", adminCookie),
      params("stub_api"),
    );
    expect(again.status).toBe(404);
  });
});
