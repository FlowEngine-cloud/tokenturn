import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PATCH as revokeApiKeyRoute,
} from "../src/app/api/api-keys/[id]/route";
import {
  GET as listApiKeysRoute,
  POST as mintApiKeyRoute,
} from "../src/app/api/api-keys/route";
import { GET as listUsers } from "../src/app/api/users/route";
import { createSession, SESSION_COOKIE, userFromRequest } from "../src/lib/auth";
import { closePool } from "../src/lib/db";
import { runMigrations } from "../scripts/migrate.mjs";
import { bearerJson, getJson, patchJson, postJson } from "./helpers/http";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

describe.runIf(TEST_DATABASE_URL)("personal API keys", () => {
  let dbUrl: string;
  let pool: Pool;
  let adminCookie: string;
  let viewerCookie: string;
  let viewerToken: string;
  let viewerKeyId: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("api_keys_test");
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

  it("mints a token once and lists only the caller's key metadata", async () => {
    const bad = await mintApiKeyRoute(
      postJson("/api/api-keys", { name: "" }, viewerCookie),
    );
    expect(bad.status).toBe(400);

    const minted = await mintApiKeyRoute(
      postJson("/api/api-keys", { name: "reporting" }, viewerCookie),
    );
    expect(minted.status).toBe(201);
    const body = await minted.json();
    expect(body.token).toMatch(/^pnl_api_[0-9a-f]{48}$/);
    expect(body.key).toMatchObject({
      name: "reporting",
      tokenPrefix: body.token.slice(0, 16),
      lastUsedAt: null,
      revokedAt: null,
    });
    viewerToken = body.token;
    viewerKeyId = body.key.id;

    const viewerList = await listApiKeysRoute(getJson("/api/api-keys", viewerCookie));
    expect(await viewerList.json()).toMatchObject({
      keys: [{ id: viewerKeyId, name: "reporting" }],
    });
    const adminList = await listApiKeysRoute(getJson("/api/api-keys", adminCookie));
    expect(await adminList.json()).toEqual({ keys: [] });
  });

  it("authenticates Bearer requests and inherits the owner's role", async () => {
    expect(await userFromRequest(bearerJson("/api/users", viewerToken), pool)).toMatchObject({
      name: "Viewer",
      role: "viewer",
    });
    expect((await listUsers(bearerJson("/api/users", viewerToken))).status).toBe(403);

    const { rows } = await pool.query(
      "SELECT last_used_at FROM api_keys WHERE id = $1",
      [viewerKeyId],
    );
    expect(rows[0].last_used_at).not.toBeNull();
  });

  it("prevents cross-user revocation and rejects revoked tokens", async () => {
    const hidden = await revokeApiKeyRoute(
      patchJson(`/api/api-keys/${viewerKeyId}`, { revoked: true }, adminCookie),
      { params: Promise.resolve({ id: viewerKeyId }) },
    );
    expect(hidden.status).toBe(404);

    const revoked = await revokeApiKeyRoute(
      patchJson(`/api/api-keys/${viewerKeyId}`, { revoked: true }, viewerCookie),
      { params: Promise.resolve({ id: viewerKeyId }) },
    );
    expect(revoked.status).toBe(200);
    expect((await revoked.json()).key.revokedAt).not.toBeNull();
    expect(await userFromRequest(bearerJson("/api/users", viewerToken), pool)).toBeNull();
  });
});
