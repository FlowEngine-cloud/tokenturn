import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as ingestRoute } from "../src/app/api/ingest/route";
import { closePool } from "../src/lib/db";
import { mintIngestKey } from "../src/lib/ingest";
import { Pnl } from "../sdk/src/client";
import { runMigrations } from "../scripts/migrate.mjs";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

/**
 * The whole spec-6 offer, end to end: the SDK's own fetch is pointed at the
 * REAL ingest route handler, so wrap() + track() drive the production path
 * into a real database - estimated facts priced from the pinned table,
 * outcomes drilling to the ref, rollups recomputed - and a full re-send of
 * an already-delivered batch (the retry after a lost response) changes
 * nothing.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

describe.runIf(TEST_DATABASE_URL)("SDK -> ingest route -> ledger (spec 6)", () => {
  let dbUrl: string;
  let pool: Pool;
  let token: string;
  let productId: string;

  const sentBodies: string[] = [];
  const routeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sentBodies.push(String(init?.body));
    return ingestRoute(new Request(String(input), init));
  }) as typeof fetch;

  beforeAll(async () => {
    dbUrl = await createScratchDb("sdk_ingest_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 5 });

    await pool.query(
      "INSERT INTO people (email, name, source) VALUES ('dana@acme.com', 'Dana', 'csv')",
    );
    const { rows } = await pool.query(
      `INSERT INTO products (name, attribution, outcome_kind)
       VALUES ('Support Bot', 'sdk', 'sdk_event') RETURNING id`,
    );
    productId = rows[0].id;
    ({ token } = await mintIngestKey(productId, "e2e", pool));
  });

  afterAll(async () => {
    await closePool();
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  it("two minutes to data: wrap + track, flush, and the ledger has it all", async () => {
    const pnl = new Pnl({
      url: "http://pnl.test",
      key: token,
      roi: "Support Bot",
      fetch: routeFetch,
    });
    const openai = {
      chat: {
        completions: {
          async create(params: { model: string }) {
            return {
              model: params.model,
              choices: [{ message: { content: "done" } }],
              // x2 calls: 2.4M in x $0.15/MTok + 600k out x $0.60/MTok = $0.72
              usage: { prompt_tokens: 1_200_000, completion_tokens: 300_000 },
            };
          },
        },
      },
    };
    const ai = pnl.wrap(openai);

    await pnl.context({ employee: "dana@acme.com" }, async () => {
      await ai.chat.completions.create({ model: "gpt-4o-mini" });
      await ai.chat.completions.create({ model: "gpt-4o-mini" });
      pnl.track("ticket_resolved", { value: 4.5, ref: "ZD-1" });
    });
    await pnl.flush();
    expect(pnl.pending()).toHaveLength(0);

    // One estimated fact bucket, priced from the pinned table, on Dana.
    const { rows: facts } = await pool.query(
      `SELECT f.vendor, f.model, f.tokens::int AS tokens,
              f.amount_cents::int AS cents, f.cost_basis AS basis,
              f.product_id AS product, p.email
       FROM spend_facts f JOIN people p ON p.id = f.person_id`,
    );
    expect(facts).toEqual([
      {
        vendor: "openai",
        model: "gpt-4o-mini",
        tokens: 3_000_000,
        cents: 72,
        basis: "estimated",
        product: productId,
        email: "dana@acme.com",
      },
    ]);

    // The outcome drills to the ticket, carries the context's tokens.
    const { rows: outcomes } = await pool.query(
      `SELECT o.kind, o.value_cents::int AS value, o.currency,
              o.source_ref AS ref, p.email, o.meta
       FROM outcomes o JOIN people p ON p.id = o.person_id`,
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      kind: "ticket_resolved",
      value: 450,
      currency: "USD",
      ref: "ZD-1",
      email: "dana@acme.com",
    });
    expect(outcomes[0].meta.tokens).toMatchObject({
      inputTokens: 2_400_000,
      outputTokens: 600_000,
    });
    expect(outcomes[0].meta.tokens.calls).toHaveLength(2);

    // The charts agree without any extra step: rollups already carry it.
    const { rows: spendRolled } = await pool.query(
      "SELECT SUM(amount_usd_cents)::int AS cents FROM rollup_daily WHERE product_id = $1",
      [productId],
    );
    expect(spendRolled[0].cents).toBe(72);
    const { rows: outcomeRolled } = await pool.query(
      "SELECT SUM(outcome_count)::int AS outcomes FROM rollup_outcomes_daily WHERE product_id = $1",
      [productId],
    );
    expect(outcomeRolled[0].outcomes).toBe(1);
  });

  it("a retried delivery (lost response) is a pure no-op", async () => {
    const before = await pool.query(
      "SELECT (SELECT count(*) FROM ingest_events)::int AS events, (SELECT sum(amount_cents) FROM spend_facts)::int AS cents",
    );
    // Re-send the exact bytes the SDK already delivered.
    for (const body of [...sentBodies]) {
      const res = await ingestRoute(
        new Request("http://pnl.test/api/ingest", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body,
        }),
      );
      expect(res.status).toBe(200);
      const { results } = await res.json();
      for (const r of results) expect(r.status).toBe("duplicate");
    }
    const after = await pool.query(
      "SELECT (SELECT count(*) FROM ingest_events)::int AS events, (SELECT sum(amount_cents) FROM spend_facts)::int AS cents",
    );
    expect(after.rows).toEqual(before.rows);
  });
});
