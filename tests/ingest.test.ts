import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PATCH as keyRevokeRoute } from "../src/app/api/ingest-keys/[id]/route";
import { GET as keysGetRoute, POST as keysPostRoute } from "../src/app/api/ingest-keys/route";
import { POST as ingestRoute } from "../src/app/api/ingest/route";
import { POST as invoiceImportRoute } from "../src/app/api/invoices/import/route";
import { GET as productRoute, PATCH as productPatchRoute } from "../src/app/api/products/[id]/route";
import { POST as productsPostRoute } from "../src/app/api/products/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { closePool } from "../src/lib/db";
import { daySpans } from "../src/lib/ingest";
import { resetRateLimits } from "../src/lib/rate-limit";
import { runMigrations } from "../scripts/migrate.mjs";
import { getJson, patchJson, postJson } from "./helpers/http";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

/**
 * Ingest API (spec 6 + 12), driven through the real production path: keys
 * minted (shown once) and revoked via the routes, events POSTed with the
 * Bearer token, money landing as pinned-price estimated facts bucketed per
 * (key, day, vendor, model, identity), outcomes drilling to the caller's
 * ref, employee emails running the shared identity machinery, client-UUID
 * dedupe, per-event rejections with the reason verbatim, the invoice
 * true-up reacting to ingested spend, and the transport guards (auth,
 * rate limit, body cap).
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const BASE = "http://localhost:3000";

/** All test money is dated against this pinned "today". */
const TS_JUNE = "2026-06-10T08:00:00Z";

function ingestPost(token: string | null, body: unknown, headers: Record<string, string> = {}) {
  return ingestRoute(
    new Request(`${BASE}/api/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function call(over: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    kind: "call",
    ts: TS_JUNE,
    vendor: "openai",
    model: "gpt-4o-mini",
    inputTokens: 0,
    outputTokens: 0,
    ...over,
  };
}

describe.runIf(TEST_DATABASE_URL)("ingest API (spec 6)", () => {
  let dbUrl: string;
  let pool: Pool;
  let adminCookie: string;
  let viewerCookie: string;
  let supportBotId: string;
  let keyProductId: string;
  let supportToken: string;
  let supportKeyId: string;
  let keyProductToken: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("ingest_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 5 });
    resetRateLimits();

    await pool.query(
      "INSERT INTO people (email, name, source) VALUES ('dana@acme.com', 'Dana', 'csv')",
    );

    const { rows: admins } = await pool.query(
      "INSERT INTO users (name, role) VALUES ('Admin', 'admin') RETURNING id",
    );
    adminCookie = `${SESSION_COOKIE}=${(await createSession(admins[0].id, pool)).token}`;
    const { rows: viewers } = await pool.query(
      "INSERT INTO users (name, role) VALUES ('Viewer', 'viewer') RETURNING id",
    );
    viewerCookie = `${SESSION_COOKIE}=${(await createSession(viewers[0].id, pool)).token}`;

    const bot = await productsPostRoute(
      postJson(
        "/api/products",
        { name: "Support Bot", attribution: "sdk", outcomeKind: "sdk_event" },
        adminCookie,
      ),
    );
    supportBotId = (await bot.json()).product.id;
    const keyed = await productsPostRoute(
      postJson("/api/products", { name: "Shared Key Tool", attribution: "key" }, adminCookie),
    );
    keyProductId = (await keyed.json()).product.id;
  });

  afterAll(async () => {
    resetRateLimits();
    await closePool();
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  it("mints keys (admin, token shown once) and lists them without tokens", async () => {
    const minted = await keysPostRoute(
      postJson("/api/ingest-keys", { productId: supportBotId, name: "prod-api" }, adminCookie),
    );
    expect(minted.status).toBe(201);
    const body = await minted.json();
    expect(body.token).toMatch(/^pnl_[0-9a-f]{48}$/);
    expect(body.key).toMatchObject({
      productId: supportBotId,
      productName: "Support Bot",
      name: "prod-api",
      tokenPrefix: body.token.slice(0, 12),
      lastUsedAt: null,
      revokedAt: null,
    });
    supportToken = body.token;
    supportKeyId = body.key.id;

    const minted2 = await keysPostRoute(
      postJson("/api/ingest-keys", { productId: keyProductId }, adminCookie),
    );
    expect(minted2.status).toBe(201);
    keyProductToken = (await minted2.json()).token;

    // The list never carries a token - only the prefix shown at mint.
    const list = await keysGetRoute(getJson("/api/ingest-keys", viewerCookie));
    expect(list.status).toBe(200);
    const { keys } = await list.json();
    expect(keys).toHaveLength(2);
    expect(JSON.stringify(keys)).not.toContain(supportToken);
    expect(keys.map((k: { productName: string }) => k.productName).sort()).toEqual([
      "Shared Key Tool",
      "Support Bot",
    ]);

    // Regular signed-in users can mint; ghost and archived products are refused.
    expect(
      (await keysPostRoute(postJson("/api/ingest-keys", { productId: supportBotId, name: "viewer" }, viewerCookie))).status,
    ).toBe(201);
    expect(
      (
        await keysPostRoute(
          postJson("/api/ingest-keys", { productId: "00000000-0000-4000-8000-000000000000" }, adminCookie),
        )
      ).status,
    ).toBe(404);
    const archived = await productsPostRoute(
      postJson("/api/products", { name: "Old Tool", attribution: "sdk" }, adminCookie),
    );
    const archivedId = (await archived.json()).product.id;
    await productPatchRoute(
      patchJson(`/api/products/${archivedId}`, { archived: true }, adminCookie),
      { params: Promise.resolve({ id: archivedId }) },
    );
    expect(
      (await keysPostRoute(postJson("/api/ingest-keys", { productId: archivedId }, adminCookie))).status,
    ).toBe(409);
  });

  it("call events land as pinned-price estimated facts, bucketed per day/model/person", async () => {
    const events = [
      // Dana, gpt-4o-mini, two calls -> ONE bucket fact, cents rounded once:
      // (1.2M + 0.8M) x $0.15/MTok + (100k + 150k) x $0.60/MTok = $0.45.
      call({ inputTokens: 1_200_000, outputTokens: 100_000, employee: "dana@acme.com" }),
      call({ inputTokens: 800_000, outputTokens: 150_000, employee: "Dana@Acme.com" }),
      // Bob is on no roster -> identity lands unresolved, money in his bucket
      // stays visible (1M x $3 + 200k x $15 per MTok = $6.00).
      call({
        vendor: "anthropic",
        model: "claude-sonnet-4-5",
        inputTokens: 1_000_000,
        outputTokens: 200_000,
        employee: "bob@acme.com",
      }),
      // No employee -> the Unassigned bucket (400k x $2.50 + 60k x $10 = $1.60).
      call({ model: "gpt-4o", inputTokens: 400_000, outputTokens: 60_000 }),
    ];
    const res = await ingestPost(supportToken, { events });
    expect(res.status).toBe(200);
    const { results } = await res.json();
    expect(results).toEqual(events.map((e) => ({ id: e.id, status: "accepted" })));

    const { rows: facts } = await pool.query(
      `SELECT f.day::text AS day, f.vendor, f.model, f.tokens::int AS tokens,
              f.amount_cents::int AS cents, f.currency, f.cost_basis AS basis,
              f.source_ref AS ref, p.email AS person, i.external_id AS identity
       FROM spend_facts f
       LEFT JOIN people p ON p.id = f.person_id
       LEFT JOIN identities i ON i.id = f.identity_id
       ORDER BY f.amount_cents`,
    );
    expect(facts).toEqual([
      expect.objectContaining({
        day: "2026-06-10", vendor: "openai", model: "gpt-4o-mini", tokens: 2_250_000,
        cents: 45, currency: "USD", basis: "estimated", person: "dana@acme.com",
        identity: "dana@acme.com",
      }),
      expect.objectContaining({
        day: "2026-06-10", vendor: "openai", model: "gpt-4o", tokens: 460_000,
        cents: 160, person: null, identity: null,
      }),
      expect.objectContaining({
        day: "2026-06-10", vendor: "anthropic", model: "claude-sonnet-4-5",
        tokens: 1_200_000, cents: 600, person: null, identity: "bob@acme.com",
      }),
    ]);
    for (const fact of facts) {
      expect(fact.ref).toMatch(new RegExp(`^sdk:${supportKeyId}:2026-06-10:`));
    }

    // Each bucket drills to the raw events behind it.
    const { rows: drill } = await pool.query(
      `SELECT SUM(input_tokens)::int AS input, SUM(output_tokens)::int AS output
       FROM ingest_events
       WHERE kind = 'call' AND model = 'gpt-4o-mini'`,
    );
    expect(drill[0]).toEqual({ input: 2_000_000, output: 250_000 });

    // The charts agree: rollups carry the same money, on the product.
    const { rows: rolled } = await pool.query(
      `SELECT SUM(amount_usd_cents)::int AS cents FROM rollup_daily WHERE product_id = $1`,
      [supportBotId],
    );
    expect(rolled[0].cents).toBe(805);

    // bob@acme.com waits in the shared identity machinery, never dropped.
    const { rows: bob } = await pool.query(
      `SELECT vendor, kind, person_id FROM identities WHERE external_id = 'bob@acme.com'`,
    );
    expect(bob).toEqual([{ vendor: "sdk", kind: "user", person_id: null }]);

    // lastUsedAt now set.
    const list = await keysGetRoute(getJson("/api/ingest-keys", viewerCookie));
    const key = (await list.json()).keys.find((k: { id: string }) => k.id === supportKeyId);
    expect(key.lastUsedAt).not.toBeNull();
  });

  it("retries are safe: the same client UUIDs upsert, never double-count", async () => {
    const events = [
      call({ inputTokens: 1_000_000, outputTokens: 0, employee: "dana@acme.com" }),
    ];
    const first = await ingestPost(supportToken, { events });
    expect((await first.json()).results).toEqual([{ id: events[0].id, status: "accepted" }]);
    const { rows: before } = await pool.query(
      "SELECT amount_cents::int AS cents, tokens::int AS tokens FROM spend_facts WHERE model = 'gpt-4o-mini'",
    );

    const retry = await ingestPost(supportToken, { events });
    expect((await retry.json()).results).toEqual([{ id: events[0].id, status: "duplicate" }]);
    const { rows: after } = await pool.query(
      "SELECT amount_cents::int AS cents, tokens::int AS tokens FROM spend_facts WHERE model = 'gpt-4o-mini'",
    );
    expect(after).toEqual(before);
    expect(after[0]).toEqual({ cents: 60, tokens: 3_250_000 }); // 45c + $0.15
  });

  it("outcomes drill to the caller's ref and restate in place when re-tracked", async () => {
    const first = {
      id: randomUUID(),
      kind: "outcome",
      ts: TS_JUNE,
      outcome: "ticket_resolved",
      valueCents: 450,
      currency: "USD",
      ref: "ZD-3141",
      employee: "dana@acme.com",
      tokens: { inputTokens: 1200, outputTokens: 300, calls: [randomUUID()] },
    };
    const anonymous = {
      id: randomUUID(),
      kind: "outcome",
      ts: TS_JUNE,
      outcome: "ticket_resolved",
    };
    const res = await ingestPost(supportToken, { events: [first, anonymous] });
    expect((await res.json()).results).toEqual([
      { id: first.id, status: "accepted" },
      { id: anonymous.id, status: "accepted" },
    ]);

    const { rows } = await pool.query(
      `SELECT o.kind, o.count::int AS count, o.value_cents::int AS value, o.currency,
              o.source_ref AS ref, p.email AS person, o.meta
       FROM outcomes o LEFT JOIN people p ON p.id = o.person_id
       ORDER BY o.value_cents DESC NULLS LAST`,
    );
    expect(rows).toEqual([
      {
        kind: "ticket_resolved", count: 1, value: 450, currency: "USD", ref: "ZD-3141",
        person: "dana@acme.com",
        meta: { sdkEventId: first.id, tokens: first.tokens },
      },
      expect.objectContaining({
        kind: "ticket_resolved", value: null, ref: `sdk:${anonymous.id}`, person: null,
      }),
    ]);

    // Re-tracking the same record corrects it in place - one outcome forever.
    const correction = { ...first, id: randomUUID(), valueCents: 500 };
    await ingestPost(supportToken, { events: [correction] });
    const { rows: corrected } = await pool.query(
      "SELECT count(*)::int AS n, max(value_cents)::int AS value FROM outcomes WHERE source_ref = 'ZD-3141'",
    );
    expect(corrected[0]).toEqual({ n: 1, value: 500 });

    // The product's numbers see the outcomes (ROI machinery, spec 7).
    const detail = await productRoute(
      getJson(`/api/products/${supportBotId}`, viewerCookie),
      { params: Promise.resolve({ id: supportBotId }) },
    );
    const { metrics } = await detail.json();
    expect(metrics.outcomes).toBe(2);
    expect(metrics.valuedOutcomes).toBe(1);
    expect(metrics.valueCents).toBe(500);
  });

  it("a late roster import re-attributes the identity's full history", async () => {
    const before = call({
      ts: "2026-06-08T10:00:00Z",
      inputTokens: 1_000_000,
      outputTokens: 0,
      employee: "carol@acme.com",
    });
    await ingestPost(supportToken, { events: [before] });
    const { rows: unmatched } = await pool.query(
      "SELECT person_id FROM spend_facts WHERE day = '2026-06-08'",
    );
    expect(unmatched).toEqual([{ person_id: null }]);

    await pool.query(
      "INSERT INTO people (email, name, source) VALUES ('carol@acme.com', 'Carol', 'csv')",
    );
    const after = call({
      ts: "2026-06-09T10:00:00Z",
      inputTokens: 1_000_000,
      outputTokens: 0,
      employee: "carol@acme.com",
    });
    await ingestPost(supportToken, { events: [after] });

    // Both days now belong to Carol - facts AND rollups.
    const { rows: facts } = await pool.query(
      `SELECT f.day::text AS day, p.email FROM spend_facts f
       JOIN people p ON p.id = f.person_id
       WHERE f.day IN ('2026-06-08', '2026-06-09') ORDER BY f.day`,
    );
    expect(facts).toEqual([
      { day: "2026-06-08", email: "carol@acme.com" },
      { day: "2026-06-09", email: "carol@acme.com" },
    ]);
    const { rows: rolled } = await pool.query(
      `SELECT r.day::text AS day FROM rollup_daily r
       JOIN people p ON p.id = r.person_id
       WHERE p.email = 'carol@acme.com' ORDER BY r.day`,
    );
    expect(rolled.map((r) => r.day)).toEqual(["2026-06-08", "2026-06-09"]);
  });

  it("rejects bad events one by one, with the reason verbatim - the rest land", async () => {
    const good = call({ inputTokens: 1000, outputTokens: 100 });
    const cases: Array<[Record<string, unknown>, string]> = [
      [call({ model: "gpt-99-turbo" }), 'no pinned price for openai model "gpt-99-turbo"'],
      [call({ vendor: "mistral" }), 'vendor must be "openai" or "anthropic"'],
      [call({ inputTokens: -1 }), "inputTokens and outputTokens must be non-negative integers"],
      [
        call({ ts: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() }),
        "is in the future",
      ],
      [call({ ts: "2020-01-01T00:00:00Z" }), "raw-fact retention"],
      [call({ employee: "not-an-email" }), "employee must be an email address"],
      [call({ roi: "Some Other ROI" }), 'this key is scoped to ROI "Support Bot"'],
      // The pre-rename wire key is still checked, silently, as an alias.
      [call({ product: "Some Other ROI" }), 'this key is scoped to ROI "Support Bot"'],
      [{ id: "nope", kind: "call", ts: TS_JUNE }, "id must be a UUID"],
      [{ id: randomUUID(), kind: "metric", ts: TS_JUNE }, 'kind must be "call" or "outcome"'],
      [
        { id: randomUUID(), kind: "outcome", ts: TS_JUNE, outcome: "x:reverted" },
        'must not contain ":"',
      ],
      [
        { id: randomUUID(), kind: "outcome", ts: TS_JUNE, outcome: "manual" },
        'outcome kind "manual" is reserved',
      ],
      [
        { id: randomUUID(), kind: "outcome", ts: TS_JUNE, outcome: "sale", valueCents: 100 },
        "currency must be a 3-letter code",
      ],
      [
        { id: randomUUID(), kind: "outcome", ts: TS_JUNE, outcome: "sale", valueCents: 100, currency: "GBP" },
        "no FX rate for GBP yet",
      ],
      [
        { id: randomUUID(), kind: "outcome", ts: TS_JUNE, outcome: "sale", ref: "sdk:abc" },
        "reserved",
      ],
    ];
    const res = await ingestPost(supportToken, { events: [good, ...cases.map(([e]) => e)] });
    expect(res.status).toBe(200);
    const { results } = await res.json();
    expect(results[0]).toEqual({ id: good.id, status: "accepted" });
    for (let i = 0; i < cases.length; i++) {
      expect(results[i + 1].status).toBe("rejected");
      expect(results[i + 1].error).toContain(cases[i][1]);
    }
  });

  it("keys are scoped: spend needs an sdk ROI, track() an sdk_event ROI", async () => {
    const res = await ingestPost(keyProductToken, {
      events: [
        call(),
        { id: randomUUID(), kind: "outcome", ts: TS_JUNE, outcome: "ticket_resolved" },
      ],
    });
    const { results } = await res.json();
    expect(results[0].status).toBe("rejected");
    expect(results[0].error).toContain('gets its spend from key');
    expect(results[1].status).toBe("rejected");
    expect(results[1].error).toContain('success kind "sdk_event"');
  });

  it("a matching roi (or the old product alias) passes the scope check", async () => {
    const events = [
      call({ roi: "Support Bot" }),
      call({ product: "Support Bot" }), // pre-rename SDKs
    ];
    const { results } = await (await ingestPost(supportToken, { events })).json();
    expect(results.map((r: { status: string }) => r.status)).toEqual([
      "accepted",
      "accepted",
    ]);
  });

  it("new estimated spend re-trues an invoiced month's drift", async () => {
    // Invoice May for $10.00 - with no May facts the whole amount is drift.
    const imported = await invoiceImportRoute(
      new Request(`${BASE}/api/invoices/import`, {
        method: "POST",
        headers: { "content-type": "text/csv", cookie: adminCookie },
        body: "vendor,month,amount,currency\nopenai,2026-05,10.00,USD\n",
      }),
    );
    expect(imported.status).toBe(200);
    const adjustment = async () =>
      (
        await pool.query(
          `SELECT amount_cents::int AS cents FROM spend_facts
           WHERE vendor = 'openai' AND source_ref LIKE 'invoice:%'`,
        )
      ).rows[0].cents;
    expect(await adjustment()).toBe(1000);

    // 2M x $2.50 + 350k x $10 per MTok = $8.50 estimated -> drift $1.50.
    const may = call({
      ts: "2026-05-20T09:00:00Z",
      model: "gpt-4o",
      inputTokens: 2_000_000,
      outputTokens: 350_000,
    });
    const res = await ingestPost(supportToken, { events: [may] });
    expect((await res.json()).results).toEqual([{ id: may.id, status: "accepted" }]);
    expect(await adjustment()).toBe(150);
  });

  it("revocation is permanent and takes effect on the next request", async () => {
    const params = { params: Promise.resolve({ id: supportKeyId }) };
    expect(
      (await keyRevokeRoute(patchJson(`/api/ingest-keys/${supportKeyId}`, { revoked: true }, viewerCookie), params)).status,
    ).toBe(403);
    expect(
      (
        await keyRevokeRoute(
          patchJson(`/api/ingest-keys/${supportKeyId}`, { revoked: false }, adminCookie),
          params,
        )
      ).status,
    ).toBe(400);

    const revoked = await keyRevokeRoute(
      patchJson(`/api/ingest-keys/${supportKeyId}`, { revoked: true }, adminCookie),
      params,
    );
    expect(revoked.status).toBe(200);
    const at = (await revoked.json()).key.revokedAt;
    expect(at).not.toBeNull();

    expect((await ingestPost(supportToken, { events: [] })).status).toBe(401);

    // Idempotent - and the original revocation time stands.
    const again = await keyRevokeRoute(
      patchJson(`/api/ingest-keys/${supportKeyId}`, { revoked: true }, adminCookie),
      params,
    );
    expect((await again.json()).key.revokedAt).toBe(at);

    // History keeps pointing at the revoked key: nothing hard-deletes.
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM ingest_events WHERE key_id = $1",
      [supportKeyId],
    );
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it("guards the transport: auth, body cap, batch cap, rate limit", async () => {
    expect((await ingestPost(null, { events: [] })).status).toBe(401);
    expect((await ingestPost("pnl_wrong", { events: [] })).status).toBe(401);

    const big = await ingestPost(keyProductToken, { events: [] }, { "content-length": "2000000" });
    expect(big.status).toBe(413);
    const reallyBig = await ingestPost(keyProductToken, `{"events": ["${"x".repeat(1_000_001)}"]}`);
    expect(reallyBig.status).toBe(413);

    expect((await ingestPost(keyProductToken, { events: "nope" })).status).toBe(400);
    expect((await ingestPost(keyProductToken, "{not json")).status).toBe(400);
    const tooMany = await ingestPost(keyProductToken, {
      events: Array.from({ length: 501 }, () => ({})),
    });
    expect(tooMany.status).toBe(400);
    expect((await tooMany.json()).error).toContain("max 500");

    // 600 requests/minute per key, then 429 (spec 12: rate-limited).
    resetRateLimits();
    for (let i = 0; i < 600; i++) {
      expect((await ingestPost(keyProductToken, { events: [] })).status).toBe(200);
    }
    expect((await ingestPost(keyProductToken, { events: [] })).status).toBe(429);
    resetRateLimits();
  });

  it("daySpans groups scattered days into contiguous recompute runs", () => {
    expect(daySpans(["2026-06-10", "2026-06-08", "2026-06-09", "2026-05-20", "2026-06-10"])).toEqual([
      { from: "2026-05-20", to: "2026-05-20" },
      { from: "2026-06-08", to: "2026-06-10" },
    ]);
    expect(daySpans([])).toEqual([]);
  });
});
