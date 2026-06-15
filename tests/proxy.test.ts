import path from "node:path";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as loginPassword } from "../src/app/api/auth/login/password/route";
import { POST as setupPassword } from "../src/app/api/auth/setup/password/route";
import { GET as authState } from "../src/app/api/auth/state/route";
import { mintApiKey } from "../src/lib/auth";
import { closePool } from "../src/lib/db";
import { hashPassword } from "../src/lib/password";
import { resetRateLimits } from "../src/lib/rate-limit";
import { isPublicPath, proxy } from "../src/proxy";
import { runMigrations } from "../scripts/migrate.mjs";
import { BASE, postJson, sessionCookieOf } from "./helpers/http";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

function request(
  pathname: string,
  init: { method?: string; cookie?: string; bearer?: string } = {},
) {
  return new NextRequest(`${BASE}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
    },
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
  let viewerApiKey: string;

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
    await pool.query(
      "INSERT INTO users (name, role, password_hash) VALUES ('Dana', 'viewer', $1)",
      [await hashPassword("viewer-pass-1")],
    );
    const login = await loginPassword(
      postJson("/api/auth/login/password", { name: "Dana", password: "viewer-pass-1" }),
    );
    viewerCookie = sessionCookieOf(login);
    const { rows } = await pool.query("SELECT id FROM users WHERE name = 'Dana'");
    viewerApiKey = (await mintApiKey(rows[0].id, "proxy test", pool)).token;
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

  it("accepts Bearer API keys and applies the owner's role", async () => {
    expect(
      passedThrough(await proxy(request("/api/overview", { bearer: viewerApiKey }))),
    ).toBe(true);
    expect(
      (
        await proxy(
          request("/api/users", { method: "POST", bearer: viewerApiKey }),
        )
      ).status,
    ).toBe(403);
    expect(
      passedThrough(
        await proxy(
          request("/api/api-keys", { method: "POST", bearer: viewerApiKey }),
        ),
      ),
    ).toBe(true);
    expect(
      (
        await proxy(
          request("/api/ingest-keys", { method: "POST", bearer: viewerApiKey }),
        )
      ).status,
    ).toBe(403);
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
    expect(
      (
        await proxy(
          request("/api/ingest-keys", { method: "POST", cookie: viewerCookie }),
        )
      ).status,
    ).toBe(403);
  });

  describe("demo mode (DEMO_MODE=1)", () => {
    beforeAll(() => {
      process.env.DEMO_MODE = "1";
    });
    afterAll(() => {
      delete process.env.DEMO_MODE;
    });

    it("does not duplicate demo state in /api/auth/state - the server flag is the one source", async () => {
      // Demo mode has a single source of truth (isDemoMode()): the dashboard
      // layout feeds it to the UI via DemoProvider and the proxy enforces it.
      // The auth-state API must not re-expose it as a second, drifting source.
      const body = await (await authState(request("/api/auth/state"))).json();
      expect(body).not.toHaveProperty("demoMode");
    });

    it("everyone reads, nobody writes - even the admin", async () => {
      expect(passedThrough(await proxy(request("/", { cookie: adminCookie })))).toBe(true);
      expect(
        passedThrough(await proxy(request("/api/users", { cookie: adminCookie }))),
      ).toBe(true);

      const write = await proxy(
        request("/api/users", { method: "POST", cookie: adminCookie }),
      );
      expect(write.status).toBe(403);
      expect((await write.json()).error).toMatch(/demo mode/);
    });

    it("blocks public-path writes too (ingest, reset consume)", async () => {
      expect(
        (await proxy(request("/api/ingest/events", { method: "POST" }))).status,
      ).toBe(403);
      expect(
        (await proxy(request("/api/auth/reset/consume", { method: "POST" }))).status,
      ).toBe(403);
    });

    it("blocks credential changes - the demo account is shared", async () => {
      expect(
        (
          await proxy(
            request("/api/auth/password", { method: "POST", cookie: adminCookie }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await proxy(
            request("/api/api-keys", { method: "POST", cookie: adminCookie }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await proxy(
            request("/api/auth/passkey/options", { method: "POST", cookie: adminCookie }),
          )
        ).status,
      ).toBe(403);
    });

    it("sign-in/out and the one-shot bootstrap writes stay open", async () => {
      expect(
        passedThrough(
          await proxy(request("/api/auth/login/password", { method: "POST" })),
        ),
      ).toBe(true);
      expect(
        passedThrough(
          await proxy(request("/api/auth/setup/password", { method: "POST" })),
        ),
      ).toBe(true);
      expect(
        passedThrough(
          await proxy(request("/api/auth/logout", { method: "POST", cookie: adminCookie })),
        ),
      ).toBe(true);
      expect(
        passedThrough(
          await proxy(request("/api/demo", { method: "POST", cookie: adminCookie })),
        ),
      ).toBe(true);
      expect(
        passedThrough(
          await proxy(request("/api/onboarding", { method: "PATCH", cookie: adminCookie })),
        ),
      ).toBe(true);
    });
  });
});
