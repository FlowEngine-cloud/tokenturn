import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as claimRoute } from "../src/app/api/auth/setup/password/route";
import { POST as demoRoute } from "../src/app/api/demo/route";
import { GET as onboardingGet, PATCH as onboardingPatch } from "../src/app/api/onboarding/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { closePool } from "../src/lib/db";
import { getOnboardingStage, startOnboarding } from "../src/lib/onboarding";
import { runMigrations } from "../scripts/migrate.mjs";
import { getJson, patchJson, postJson } from "./helpers/http";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

describe.runIf(TEST_DATABASE_URL)("onboarding (spec 10)", () => {
  let dbUrl: string;
  let pool: Pool;
  let adminCookie: string;
  let viewerCookie: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("onboarding_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 3 });
  });

  afterAll(async () => {
    await closePool();
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  it("startOnboarding only fires on a completely empty ledger", async () => {
    // A pre-existing ledger (think: upgraded instance) never sees onboarding.
    await pool.query("INSERT INTO people (email, name) VALUES ('x@y.co', 'X')");
    await startOnboarding(pool);
    expect(await getOnboardingStage(pool)).toBe("done");
    await pool.query("DELETE FROM people");
  });

  it("claiming a fresh instance opens the welcome popup", async () => {
    const res = await claimRoute(
      postJson("/api/auth/setup/password", { name: "Admin", password: "hunter22pass" }),
    );
    expect(res.status).toBe(200);
    expect(await getOnboardingStage(pool)).toBe("welcome");

    const { rows: admins } = await pool.query("SELECT id FROM users WHERE role = 'admin'");
    adminCookie = `${SESSION_COOKIE}=${(await createSession(admins[0].id, pool)).token}`;
    const { rows: viewers } = await pool.query(
      "INSERT INTO users (name, role) VALUES ('Viewer', 'viewer') RETURNING id",
    );
    viewerCookie = `${SESSION_COOKIE}=${(await createSession(viewers[0].id, pool)).token}`;
  });

  it("state is session-gated; stage moves are admin-only", async () => {
    expect((await onboardingGet(getJson("/api/onboarding"))).status).toBe(401);
    expect(
      (await onboardingPatch(patchJson("/api/onboarding", { stage: "setup" }, viewerCookie)))
        .status,
    ).toBe(403);

    const res = await onboardingGet(getJson("/api/onboarding", viewerCookie));
    expect(res.status).toBe(200);
    const state = await res.json();
    expect(state.stage).toBe("welcome");
    expect(state.demo.present).toBe(false);
    expect(state.progress).toEqual({ connectors: 0, people: 0, products: 0 });
  });

  it("the demo choice seeds and advances the popup to the setup screen", async () => {
    expect((await demoRoute(postJson("/api/demo", {}, viewerCookie))).status).toBe(403);

    const res = await demoRoute(postJson("/api/demo", {}, adminCookie));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.demo.people).toBe(12);
    expect(body.onboarding.stage).toBe("setup");
    // The three setup steps track REAL progress - demo rows don't count.
    expect(body.onboarding.demo.present).toBe(true);
    expect(body.onboarding.progress).toEqual({ connectors: 0, people: 0, products: 0 });

    // Demo data twice = 409, stage stays put.
    expect((await demoRoute(postJson("/api/demo", {}, adminCookie))).status).toBe(409);
    expect(await getOnboardingStage(pool)).toBe("setup");
  });

  it("stages only move forward: setup -> done, never back", async () => {
    const back = await onboardingPatch(
      patchJson("/api/onboarding", { stage: "welcome" }, adminCookie),
    );
    expect(back.status).toBe(409);

    expect(
      (await onboardingPatch(patchJson("/api/onboarding", { stage: "nope" }, adminCookie)))
        .status,
    ).toBe(400);

    const done = await onboardingPatch(
      patchJson("/api/onboarding", { stage: "done" }, adminCookie),
    );
    expect(done.status).toBe(200);
    expect((await done.json()).stage).toBe("done");

    // Done is terminal; a same-stage PATCH is a harmless no-op.
    expect(
      (await onboardingPatch(patchJson("/api/onboarding", { stage: "setup" }, adminCookie)))
        .status,
    ).toBe(409);
    expect(
      (await onboardingPatch(patchJson("/api/onboarding", { stage: "done" }, adminCookie)))
        .status,
    ).toBe(200);
  });
});
