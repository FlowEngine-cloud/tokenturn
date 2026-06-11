import path from "node:path";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as createUser } from "../src/app/api/users/route";
import { POST as loginPassword } from "../src/app/api/auth/login/password/route";
import { POST as setupPassword } from "../src/app/api/auth/setup/password/route";
import { closePool } from "../src/lib/db";
import { resetRateLimits } from "../src/lib/rate-limit";
import { isPublicPath, proxy } from "../src/proxy";
import { runMigrations } from "../scripts/migrate.mjs";
import { BASE, postJson, sessionCookieOf } from "./helpers/http";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

function request(pathname: string, init: { method?: string; cookie?: string } = {}) {
  return new NextRequest(`${BASE}${pathname}`, {
    method: init.method ?? "GET",
    headers: init.cookie ? { cookie: init.cookie } : {},
  });
}

/** NextResponse.next() marks pass-through with this header. */
function passedThrough(res: Response): boolean {
  return res.headers.get("x-middleware-next") === "1";
}

describe("public paths", () => {
  it("only /healthz, ingest, and the auth surface are public", () => {
    expect(isPublicPath("/healthz")).toBe(true);
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/reset/some-token")).toBe(true);
    expect(isPublicPath("/api/ingest")).toBe(true);
    expect(isPublicPath("/api/ingest/events")).toBe(true);
    expect(isPublicPath("/api/auth/state")).toBe(true);
    expect(isPublicPath("/api/auth/setup/password")).toBe(true);
    expect(isPublicPath("/api/auth/login/passkey/options")).toBe(true);
    expect(isPublicPath("/api/auth/reset/consume")).toBe(true);

    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/people")).toBe(false);
    expect(isPublicPath("/api/users")).toBe(false);
    expect(isPublicPath("/api/auth/logout")).toBe(false);
    expect(isPublicPath("/api/auth/password")).toBe(false);
    expect(isPublicPath("/api/auth/passkey/options")).toBe(false);
  });
});

describe.runIf(TEST_DATABASE_URL)("auth gate", () => {
  let dbUrl: string;
  let pool: Pool;
  let adminCookie: string;
  let viewerCookie: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("proxy_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 3 });
    resetRateLimits();

    const claim = await setupPassword(
      postJson("/api/auth/setup/password", { name: "Amit", password: "first-boot-pass" }),
    );
    adminCookie = sessionCookieOf(claim);
    await createUser(
      postJson("/api/users", { name: "Dana", password: "viewer-pass-1" }, adminCookie),
    );
    const login = await loginPassword(
      postJson("/api/auth/login/password", { name: "Dana", password: "viewer-pass-1" }),
    );
    viewerCookie = sessionCookieOf(login);
  });

  afterAll(async () => {
    await closePool();
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  it("redirects anonymous page requests to /login", async () => {
    const res = await proxy(request("/"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it("rejects anonymous API requests with 401", async () => {
    const res = await proxy(request("/api/users"));
    expect(res.status).toBe(401);
  });

  it("a garbage session cookie does not pass", async () => {
    const res = await proxy(request("/", { cookie: "ai_pnl_session=forged-token" }));
    expect(res.status).toBe(307);
  });

  it("lets /healthz and ingest through without a session", async () => {
    expect(passedThrough(await proxy(request("/healthz")))).toBe(true);
    expect(
      passedThrough(await proxy(request("/api/ingest/events", { method: "POST" }))),
    ).toBe(true);
    expect(passedThrough(await proxy(request("/login")))).toBe(true);
  });

  it("lets a valid session through", async () => {
    expect(passedThrough(await proxy(request("/", { cookie: adminCookie })))).toBe(true);
    expect(
      passedThrough(
        await proxy(request("/api/users", { method: "POST", cookie: adminCookie })),
      ),
    ).toBe(true);
  });

  it("viewers read everything but write nothing", async () => {
    expect(passedThrough(await proxy(request("/", { cookie: viewerCookie })))).toBe(true);
    expect(
      passedThrough(await proxy(request("/api/users", { cookie: viewerCookie }))),
    ).toBe(true);

    const write = await proxy(
      request("/api/users", { method: "POST", cookie: viewerCookie }),
    );
    expect(write.status).toBe(403);

    // self-service stays available
    expect(
      passedThrough(
        await proxy(request("/api/auth/logout", { method: "POST", cookie: viewerCookie })),
      ),
    ).toBe(true);
    expect(
      passedThrough(
        await proxy(
          request("/api/auth/password", { method: "POST", cookie: viewerCookie }),
        ),
      ),
    ).toBe(true);
  });
});
