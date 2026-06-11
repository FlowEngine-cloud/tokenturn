import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate.mjs";
import {
  TEST_DATABASE_URL,
  createScratchDb,
  dropScratchDb,
  queryScratch,
} from "./helpers/pg";

const FIXTURES = path.resolve(__dirname, "fixtures");

describe.runIf(TEST_DATABASE_URL)("runMigrations", () => {
  let dbUrl: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("migrate_test");
  });

  afterAll(async () => {
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  it("applies migrations in order and records them", async () => {
    const applied = await runMigrations({
      databaseUrl: dbUrl,
      dir: path.join(FIXTURES, "migrations-basic"),
    });
    expect(applied).toEqual([
      "001_create_widgets.sql",
      "002_seed_widgets.sql",
    ]);

    const widgets = await queryScratch(dbUrl, "SELECT name FROM widgets ORDER BY id");
    expect(widgets).toEqual([{ name: "alpha" }, { name: "beta" }]);

    const recorded = await queryScratch(
      dbUrl,
      "SELECT name FROM schema_migrations ORDER BY name",
    );
    expect(recorded.map((r) => r.name)).toEqual([
      "001_create_widgets.sql",
      "002_seed_widgets.sql",
    ]);
  });

  it("is idempotent: a second run applies nothing and duplicates nothing", async () => {
    const applied = await runMigrations({
      databaseUrl: dbUrl,
      dir: path.join(FIXTURES, "migrations-basic"),
    });
    expect(applied).toEqual([]);

    const widgets = await queryScratch(dbUrl, "SELECT count(*)::int AS n FROM widgets");
    expect(widgets[0].n).toBe(2);
  });

  it("rolls back a failed migration and keeps earlier ones", async () => {
    const failUrl = await createScratchDb("migrate_fail");
    try {
      await expect(
        runMigrations({
          databaseUrl: failUrl,
          dir: path.join(FIXTURES, "migrations-failing"),
        }),
      ).rejects.toThrow(/002_bad\.sql failed/);

      // 001 applied and recorded.
      const recorded = await queryScratch(
        failUrl,
        "SELECT name FROM schema_migrations",
      );
      expect(recorded.map((r) => r.name)).toEqual(["001_create_gadgets.sql"]);

      // 002's partial work rolled back: partial_table must not exist.
      const tables = await queryScratch(
        failUrl,
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
      );
      const names = tables.map((t) => t.tablename);
      expect(names).toContain("gadgets");
      expect(names).not.toContain("partial_table");
    } finally {
      await dropScratchDb(failUrl);
    }
  });

  it("handles a missing migrations dir as zero migrations", async () => {
    const applied = await runMigrations({
      databaseUrl: dbUrl,
      dir: path.join(FIXTURES, "does-not-exist"),
    });
    expect(applied).toEqual([]);
  });
});
