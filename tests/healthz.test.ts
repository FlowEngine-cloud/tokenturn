import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/healthz/route";
import { closePool } from "@/lib/db";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

afterEach(async () => {
  await closePool();
  vi.unstubAllEnvs();
});

describe("GET /healthz", () => {
  it.runIf(TEST_DATABASE_URL)(
    "returns 200 with db ok when the database answers",
    async () => {
      const dbUrl = await createScratchDb("healthz_test");
      try {
        vi.stubEnv("DATABASE_URL", dbUrl);
        const res = await GET();
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: "ok", db: "ok" });
      } finally {
        await closePool();
        await dropScratchDb(dbUrl);
      }
    },
  );

  it("returns 503 when the database is unreachable", async () => {
    // Port 1 refuses connections immediately.
    vi.stubEnv("DATABASE_URL", "postgres://nobody@127.0.0.1:1/nothing");
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "degraded", db: "unreachable" });
  });

  it("returns 503 when DATABASE_URL is missing", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const res = await GET();
    expect(res.status).toBe(503);
  });
});
