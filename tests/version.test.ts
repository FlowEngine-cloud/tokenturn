import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as versionRoute } from "../src/app/api/version/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { closePool } from "../src/lib/db";
import { setSetting } from "../src/lib/settings";
import {
  __clearVersionCacheForTests,
  APP_VERSION,
  isNewerVersion,
  versionInfo,
} from "../src/lib/version";
import { runMigrations } from "../scripts/migrate.mjs";
import { getJson } from "./helpers/http";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

describe("version comparison", () => {
  it("compares semver tags, v-prefixed or not", () => {
    expect(isNewerVersion("v0.2.0", "0.1.0")).toBe(true);
    expect(isNewerVersion("0.1.1", "0.1.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isNewerVersion("v0.0.9", "0.1.0")).toBe(false);
    expect(isNewerVersion("nightly", "0.1.0")).toBe(false);
  });
});

describe.runIf(TEST_DATABASE_URL)("update check (spec 12b: opt-in, off by default)", () => {
  let dbUrl: string;
  let pool: Pool;
  let cookie: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("version_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 3 });
    const { rows } = await pool.query(
      "INSERT INTO users (name, role) VALUES ('Viewer', 'viewer') RETURNING id",
    );
    cookie = `${SESSION_COOKIE}=${(await createSession(rows[0].id, pool)).token}`;
  });

  afterAll(async () => {
    await closePool();
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  beforeEach(() => __clearVersionCacheForTests());

  it("off by default: no request leaves the machine, ever", async () => {
    let reached = 0;
    const info = await versionInfo({
      db: pool,
      fetch: (async () => {
        reached += 1;
        return new Response("{}");
      }) as typeof fetch,
    });
    expect(reached).toBe(0);
    expect(info).toEqual({
      current: APP_VERSION,
      enabled: false,
      latest: null,
      updateAvailable: false,
      releasesUrl: "https://github.com/flowengine/ai-pnl/releases",
    });
  });

  it("opted in: reads GitHub releases, flags newer tags, caches the answer", async () => {
    await setSetting("update_check_enabled", true, pool);
    let calls = 0;
    const stub = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ tag_name: "v9.9.9", name: "v9.9.9" }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const info = await versionInfo({ db: pool, fetch: stub });
    expect(info.updateAvailable).toBe(true);
    expect(info.latest).toBe("v9.9.9");

    await versionInfo({ db: pool, fetch: stub });
    expect(calls).toBe(1); // cached - GitHub is asked at most every 6h

    // A same-or-older tag shows no banner.
    __clearVersionCacheForTests();
    const same = await versionInfo({
      db: pool,
      fetch: (async () =>
        new Response(JSON.stringify({ tag_name: `v${APP_VERSION}` }))) as typeof fetch,
    });
    expect(same.updateAvailable).toBe(false);
  });

  it("a GitHub failure never breaks anything - the banner just stays away", async () => {
    const info = await versionInfo({
      db: pool,
      fetch: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    expect(info.updateAvailable).toBe(false);
    expect(info.latest).toBeNull();
  });

  it("the route needs a session and reports the same shape", async () => {
    expect((await versionRoute(getJson("/api/version"))).status).toBe(401);
    await setSetting("update_check_enabled", false, pool);
    const res = await versionRoute(getJson("/api/version", cookie));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ current: APP_VERSION, enabled: false });
  });
});
