import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as confirmRoute } from "../src/app/api/resolve/[id]/confirm/route";
import { POST as notPersonRoute } from "../src/app/api/resolve/[id]/not-person/route";
import { POST as mergeRoute } from "../src/app/api/resolve/merge/route";
import { GET as queueRoute } from "../src/app/api/resolve/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { connectConnector } from "../src/lib/connectors/connect";
import { clearConnectors, registerConnector } from "../src/lib/connectors/registry";
import { runSync } from "../src/lib/connectors/sync";
import { closePool } from "../src/lib/db";
import { recomputeRollups } from "../src/lib/rollup";
import { clearSecretKeyCache } from "../src/lib/secrets";
import { runMigrations } from "../scripts/migrate.mjs";
import { makeAcmeConnector } from "./helpers/fixture-connector";
import { getJson, postJson } from "./helpers/http";
import { factRows, outcomeRows } from "./helpers/ledger";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";
import { replayFile } from "./helpers/replay";

/**
 * Identity resolution (spec 5), driven through the real production path:
 * recorded vendor syncs land the identities and history, the Resolve API
 * routes confirm / mark-not-a-person / merge, and the assertions read the
 * ledger and the rollups - so any break in auto-match, the queue,
 * full-history re-attribution, or the match memory fails here.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const FIXTURES = path.resolve(__dirname, "fixtures", "connectors", "resolve");
const CONNECT_OK = path.resolve(
  __dirname, "fixtures", "connectors", "acme", "connect-ok.json",
);

/** Pinned clock: recordings are recorded against "today" = 2026-06-10. */
const NOW = new Date("2026-06-10T12:00:00Z");
const LATER_SAME_DAY = new Date("2026-06-10T13:00:00Z");
const NEXT_DAY = new Date("2026-06-11T09:00:00Z");

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe.runIf(TEST_DATABASE_URL)("identity resolution (Resolve)", () => {
  let dbUrl: string;
  let pool: Pool;
  let dataDir: string;
  let adminCookie: string;
  let viewerCookie: string;
  const person: Record<string, string> = {};
  let ciBotProductId: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("resolve_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    process.env.DATABASE_URL = dbUrl;
    pool = new Pool({ connectionString: dbUrl, max: 5 });
    dataDir = mkdtempSync(path.join(os.tmpdir(), "ai-pnl-resolve-"));
    clearConnectors();
    registerConnector(makeAcmeConnector("acme_r"));
    registerConnector(makeAcmeConnector("acme_r2"));

    // The roster - everyone except Newman, who is imported mid-story.
    for (const [name, email] of [
      ["Dana", "dana@acme.com"],
      ["Bob Smith", "bob@initech.com"],
      ["Rob Lee", "rob@acme.com"],
      ["Build Svc", "svc@acme.com"],
      ["D. Cohen", "dana@gmail.com"],
    ]) {
      const { rows } = await pool.query(
        "INSERT INTO people (email, name, source) VALUES ($1, $2, 'csv') RETURNING id",
        [email, name],
      );
      person[email] = rows[0].id;
    }

    const { rows: products } = await pool.query(
      `INSERT INTO products (name, attribution, outcome_kind)
       VALUES ('CI Bot', 'key', 'none'), ('Support Bot', 'sdk', 'sdk_event')
       RETURNING id, name`,
    );
    ciBotProductId = products.find((p) => p.name === "CI Bot")!.id;

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
    clearSecretKeyCache();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  async function connect(vendor: string) {
    return connectConnector(vendor, { apiKey: "acme_sk_test_123" }, {
      db: pool,
      fetch: replayFile(CONNECT_OK).fetch,
      dataDir,
    });
  }

  async function sync(vendor: string, recording: string, now: Date) {
    const session = replayFile(path.join(FIXTURES, recording));
    const result = await runSync(vendor, { pool, fetch: session.fetch, now, dataDir });
    expect(result.status).toBe("success");
    expect(session.remaining()).toHaveLength(0);
    return result;
  }

  async function identityId(vendor: string, externalId: string, kind = "user") {
    const { rows } = await pool.query(
      "SELECT id FROM identities WHERE vendor = $1 AND external_id = $2 AND kind = $3",
      [vendor, externalId, kind],
    );
    expect(rows).toHaveLength(1);
    return rows[0].id as string;
  }

  async function getQueue(cookie = viewerCookie) {
    const res = await queueRoute(getJson("/api/resolve", cookie));
    expect(res.status).toBe(200);
    return res.json();
  }

  it("backfill auto-matches by email, case-insensitive; the rest is unresolved", async () => {
    await connect("acme_r");
    await sync("acme_r", "backfill.json", NOW);

    const facts = await factRows(pool, "acme_r");
    const byRef = Object.fromEntries(facts.map((f) => [f.sourceRef, f]));
    expect(byRef.r_dana_1.personEmail).toBe("dana@acme.com");
    expect(byRef.r_svc_1.personEmail).toBe("svc@acme.com");
    for (const unresolved of ["r_bob_1", "r_bob_2", "r_ci_1", "r_rob_1", "r_robA_1", "r_anon_1", "r_newman_1"]) {
      expect(byRef[unresolved].personEmail).toBeNull();
    }

    // The outcome landed on its product, credited to no one yet.
    const outcomes = await outcomeRows(pool);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      sourceRef: "evt_bob_1",
      kind: "sdk_event",
      product: "Support Bot",
      personEmail: null,
    });
  });

  it("the queue lists every unresolved identity with explainable suggestions, and unassigned spend per vendor", async () => {
    await recomputeRollups({}, pool);
    const { queue, unassigned } = await getQueue();

    expect(queue.map((q: { externalId: string; kind: string }) => `${q.kind}:${q.externalId}`)).toEqual([
      "api_key:key_anon",
      "api_key:key_ci",
      "api_key:key_rob",
      "api_key:key_robA",
      "user:bob@gmail.com",
      "user:newman@acme.com",
    ]);

    const byExt = Object.fromEntries(queue.map((q: { externalId: string }) => [q.externalId, q]));
    // Same email handle on the roster.
    expect(byExt["bob@gmail.com"].suggestions).toEqual([
      { personId: person["bob@initech.com"], name: "Bob Smith", email: "bob@initech.com", reason: "email" },
    ]);
    expect(byExt["bob@gmail.com"]).toMatchObject({ factCount: 2, outcomeCount: 1 });
    // Vendor display name equals a roster name.
    expect(byExt.key_rob.suggestions).toEqual([
      { personId: person["rob@acme.com"], name: "Rob Lee", email: "rob@acme.com", reason: "name" },
    ]);
    // Nothing to go on - no guessed matches, ever.
    expect(byExt.key_anon.suggestions).toEqual([]);
    expect(byExt.key_ci.suggestions).toEqual([]);
    expect(byExt.key_robA.suggestions).toEqual([]);
    expect(byExt["newman@acme.com"].suggestions).toEqual([]);

    // Unassigned = no person and no product, visible per vendor (spec 4).
    expect(unassigned).toEqual([
      { vendor: "acme_r", amountUsdCents: 250 + 80 + 400 + 150 + 65 + 90 + 40, factCount: 7 },
    ]);
  });

  it("confirming a match re-attributes the identity's FULL history - facts, outcomes, rollups - and remembers the email", async () => {
    const bobIdentity = await identityId("acme_r", "bob@gmail.com");
    const res = await confirmRoute(
      postJson(`/api/resolve/${bobIdentity}/confirm`, { personId: person["bob@initech.com"] }, adminCookie),
      idParams(bobIdentity),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      identityId: bobIdentity,
      personId: person["bob@initech.com"],
      rememberedEmail: "bob@gmail.com",
      facts: 2,
      metrics: 0,
      outcomes: 1,
      rollups: { from: "2026-05-21", to: "2026-05-28" },
    });

    // Both facts - including the one outside any re-pull window - moved.
    const facts = await factRows(pool, "acme_r");
    for (const ref of ["r_bob_1", "r_bob_2"]) {
      expect(facts.find((f) => f.sourceRef === ref)!.personEmail).toBe("bob@initech.com");
    }
    expect((await outcomeRows(pool))[0].personEmail).toBe("bob@initech.com");

    // Remembered forever.
    const { rows: aliases } = await pool.query("SELECT email, person_id FROM person_emails");
    expect(aliases).toEqual([{ email: "bob@gmail.com", person_id: person["bob@initech.com"] }]);

    // Rollups were recomputed for exactly the touched days.
    const { rows: rollup } = await pool.query(
      `SELECT day::text AS day, amount_usd_cents::int AS cents FROM rollup_daily
       WHERE person_id = $1 ORDER BY day`,
      [person["bob@initech.com"]],
    );
    expect(rollup).toEqual([
      { day: "2026-05-21", cents: 250 },
      { day: "2026-05-28", cents: 80 },
    ]);
    const { rows: outcomeRollup } = await pool.query(
      `SELECT day::text AS day, kind, outcome_count FROM rollup_outcomes_daily
       WHERE person_id = $1`,
      [person["bob@initech.com"]],
    );
    expect(outcomeRollup).toEqual([{ day: "2026-05-28", kind: "sdk_event", outcome_count: 1 }]);

    // Off the queue.
    const { queue } = await getQueue();
    expect(queue.map((q: { externalId: string }) => q.externalId)).not.toContain("bob@gmail.com");
  });

  it("a confirmed email is remembered across vendors: the next vendor auto-maps it with no human action", async () => {
    await connect("acme_r2");
    await sync("acme_r2", "vendor2-backfill.json", LATER_SAME_DAY);

    const facts = await factRows(pool, "acme_r2");
    expect(facts.find((f) => f.sourceRef === "v2_bob_1")!.personEmail).toBe("bob@initech.com");
    // dana@gmail.com is (so far) its own roster person - matched directly.
    expect(facts.find((f) => f.sourceRef === "v2_dana_g1")!.personEmail).toBe("dana@gmail.com");
  });

  it("keys confirm too; identities without an email leave no alias behind", async () => {
    for (const key of ["key_rob", "key_robA"]) {
      const id = await identityId("acme_r", key, "api_key");
      const res = await confirmRoute(
        postJson(`/api/resolve/${id}/confirm`, { personId: person["rob@acme.com"] }, adminCookie),
        idParams(id),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ facts: 1, rememberedEmail: null });
    }
    const facts = await factRows(pool, "acme_r");
    expect(facts.find((f) => f.sourceRef === "r_rob_1")!.personEmail).toBe("rob@acme.com");
    expect(facts.find((f) => f.sourceRef === "r_robA_1")!.personEmail).toBe("rob@acme.com");
    const { rows: aliases } = await pool.query("SELECT count(*)::int AS n FROM person_emails");
    expect(aliases[0].n).toBe(1); // still just bob@gmail.com
  });

  it("not a person: a service key routes to a product, full history included", async () => {
    const ciIdentity = await identityId("acme_r", "key_ci", "api_key");
    const res = await notPersonRoute(
      postJson(`/api/resolve/${ciIdentity}/not-person`, { productId: ciBotProductId, tag: "ci" }, adminCookie),
      idParams(ciIdentity),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      identityId: ciIdentity,
      productId: ciBotProductId,
      manualTags: ["ci"],
      facts: 1,
      metrics: 0,
      outcomes: 0,
      rollups: { from: "2026-05-22", to: "2026-05-22" },
    });

    const { rows } = await pool.query(
      `SELECT f.person_id, p.name AS product FROM spend_facts f
       JOIN products p ON p.id = f.product_id WHERE f.source_ref = 'r_ci_1'`,
    );
    expect(rows).toEqual([{ person_id: null, product: "CI Bot" }]);
    // Routed spend is attributed - it leaves the Unassigned bucket.
    const { rows: rolled } = await pool.query(
      `SELECT amount_usd_cents::int AS cents FROM rollup_daily
       WHERE product_id = $1`,
      [ciBotProductId],
    );
    expect(rolled).toEqual([{ cents: 400 }]);
    const { queue } = await getQueue();
    expect(queue.map((q: { externalId: string }) => q.externalId)).not.toContain("key_ci");
  });

  it("not a person with a tag only - and auto-match never re-fills it, even when the email is on the roster", async () => {
    const svcIdentity = await identityId("acme_r", "svc@acme.com");
    const res = await notPersonRoute(
      postJson(`/api/resolve/${svcIdentity}/not-person`, { tag: "service" }, adminCookie),
      idParams(svcIdentity),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ productId: null, manualTags: ["service"], facts: 1 });

    // Newman joins the roster only now - after his history already synced.
    const { rows } = await pool.query(
      "INSERT INTO people (email, name, source) VALUES ('newman@acme.com', 'Newman', 'csv') RETURNING id",
    );
    person["newman@acme.com"] = rows[0].id;

    await sync("acme_r", "repull.json", LATER_SAME_DAY);

    const facts = await factRows(pool, "acme_r");
    const byRef = Object.fromEntries(facts.map((f) => [f.sourceRef, f]));
    // svc@acme.com is on the roster, but the identity is not a person:
    // the re-pulled identity and its new fact stay unmapped.
    expect(byRef.r_svc_1.personEmail).toBeNull();
    expect(byRef.r_svc_2.personEmail).toBeNull();
    const { rows: svc } = await pool.query(
      "SELECT person_id, not_person, manual_tags FROM identities WHERE id = $1",
      [svcIdentity],
    );
    expect(svc).toEqual([{ person_id: null, not_person: true, manual_tags: ["service"] }]);

    // The late auto-match re-attributes Newman's FULL history at sync time:
    // r_newman_1 is from 2026-05-29, far outside this sync's window.
    expect(byRef.r_newman_1.personEmail).toBe("newman@acme.com");
    expect(byRef.r_newman_2.personEmail).toBe("newman@acme.com");
  });

  it("a display name confirmed elsewhere becomes a peer suggestion", async () => {
    await recomputeRollups({}, pool);
    const { queue, unassigned } = await getQueue();
    expect(queue.map((q: { externalId: string }) => q.externalId)).toEqual(["key_anon", "key_robB"]);
    expect(queue[1].suggestions).toEqual([
      { personId: person["rob@acme.com"], name: "Rob Lee", email: "rob@acme.com", reason: "peer" },
    ]);
    // anon 90 + robB 25 + svc (tag-routed, no product) 55+75.
    expect(unassigned).toEqual([
      { vendor: "acme_r", amountUsdCents: 90 + 25 + 55 + 75, factCount: 4 },
    ]);
  });

  it("confirming a not-a-person identity reverses it; a live primary email never becomes an alias", async () => {
    const svcIdentity = await identityId("acme_r", "svc@acme.com");
    const res = await confirmRoute(
      postJson(`/api/resolve/${svcIdentity}/confirm`, { personId: person["svc@acme.com"] }, adminCookie),
      idParams(svcIdentity),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      facts: 2,
      rememberedEmail: null, // people.email is already the memory
      rollups: { from: "2026-05-23", to: "2026-06-09" },
    });
    const { rows: svc } = await pool.query(
      "SELECT not_person FROM identities WHERE id = $1",
      [svcIdentity],
    );
    expect(svc[0].not_person).toBe(false);
    const facts = await factRows(pool, "acme_r");
    expect(facts.find((f) => f.sourceRef === "r_svc_2")!.personEmail).toBe("svc@acme.com");
  });

  it("merge: two emails, one human - identities, history, and the email follow the survivor", async () => {
    const res = await mergeRoute(
      postJson(
        "/api/resolve/merge",
        { fromPersonId: person["dana@gmail.com"], intoPersonId: person["dana@acme.com"] },
        adminCookie,
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      fromPersonId: person["dana@gmail.com"],
      intoPersonId: person["dana@acme.com"],
      rememberedEmail: "dana@gmail.com",
      identities: 1,
      facts: 1,
      metrics: 0,
      outcomes: 0,
      rollups: { from: "2026-05-25", to: "2026-05-25" },
    });

    const { rows: merged } = await pool.query(
      "SELECT status, merged_into FROM people WHERE id = $1",
      [person["dana@gmail.com"]],
    );
    expect(merged).toEqual([
      { status: "archived", merged_into: person["dana@acme.com"] },
    ]);
    const facts = await factRows(pool, "acme_r2");
    expect(facts.find((f) => f.sourceRef === "v2_dana_g1")!.personEmail).toBe("dana@acme.com");
    const { rows: alias } = await pool.query(
      "SELECT person_id FROM person_emails WHERE email = 'dana@gmail.com'",
    );
    expect(alias).toEqual([{ person_id: person["dana@acme.com"] }]);
    const { rows: rolled } = await pool.query(
      `SELECT amount_usd_cents::int AS cents FROM rollup_daily
       WHERE person_id = $1 AND day = '2026-05-25'`,
      [person["dana@acme.com"]],
    );
    expect(rolled).toEqual([{ cents: 75 }]);
  });

  it("after the merge, the merged email auto-maps to the survivor on any vendor", async () => {
    await sync("acme_r", "after-merge.json", NEXT_DAY);
    const facts = await factRows(pool, "acme_r");
    expect(facts.find((f) => f.sourceRef === "r_dana_g2")!.personEmail).toBe("dana@acme.com");
  });

  it("rejects bad input with the precise reason", async () => {
    const anonIdentity = await identityId("acme_r", "key_anon", "api_key");

    const badId = await confirmRoute(
      postJson("/api/resolve/nope/confirm", { personId: person["dana@acme.com"] }, adminCookie),
      idParams("nope"),
    );
    expect(badId.status).toBe(400);

    const ghost = "00000000-0000-4000-8000-000000000000";
    const missingIdentity = await confirmRoute(
      postJson(`/api/resolve/${ghost}/confirm`, { personId: person["dana@acme.com"] }, adminCookie),
      idParams(ghost),
    );
    expect(missingIdentity.status).toBe(404);

    const missingPerson = await confirmRoute(
      postJson(`/api/resolve/${anonIdentity}/confirm`, { personId: ghost }, adminCookie),
      idParams(anonIdentity),
    );
    expect(missingPerson.status).toBe(404);

    // Confirming against a merged person points at the survivor instead.
    const mergedPerson = await confirmRoute(
      postJson(`/api/resolve/${anonIdentity}/confirm`, { personId: person["dana@gmail.com"] }, adminCookie),
      idParams(anonIdentity),
    );
    expect(mergedPerson.status).toBe(409);

    const noRoute = await notPersonRoute(
      postJson(`/api/resolve/${anonIdentity}/not-person`, {}, adminCookie),
      idParams(anonIdentity),
    );
    expect(noRoute.status).toBe(400);
    expect((await noRoute.json()).error).toBe("route the key to a product or a tag");

    const ghostProduct = await notPersonRoute(
      postJson(`/api/resolve/${anonIdentity}/not-person`, { productId: ghost }, adminCookie),
      idParams(anonIdentity),
    );
    expect(ghostProduct.status).toBe(404);

    const selfMerge = await mergeRoute(
      postJson(
        "/api/resolve/merge",
        { fromPersonId: person["dana@acme.com"], intoPersonId: person["dana@acme.com"] },
        adminCookie,
      ),
    );
    expect(selfMerge.status).toBe(400);

    const alreadyMerged = await mergeRoute(
      postJson(
        "/api/resolve/merge",
        { fromPersonId: person["dana@gmail.com"], intoPersonId: person["bob@initech.com"] },
        adminCookie,
      ),
    );
    expect(alreadyMerged.status).toBe(409);
  });

  it("the queue needs a session; every mutation needs the admin", async () => {
    expect((await queueRoute(getJson("/api/resolve"))).status).toBe(401);

    const anonIdentity = await identityId("acme_r", "key_anon", "api_key");
    expect(
      (
        await confirmRoute(
          postJson(`/api/resolve/${anonIdentity}/confirm`, { personId: person["dana@acme.com"] }, viewerCookie),
          idParams(anonIdentity),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await notPersonRoute(
          postJson(`/api/resolve/${anonIdentity}/not-person`, { tag: "x" }, viewerCookie),
          idParams(anonIdentity),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await mergeRoute(
          postJson(
            "/api/resolve/merge",
            { fromPersonId: person["dana@acme.com"], intoPersonId: person["bob@initech.com"] },
            viewerCookie,
          ),
        )
      ).status,
    ).toBe(403);
  });
});
