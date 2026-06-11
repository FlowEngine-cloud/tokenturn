import path from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as inviteRoute } from "../src/app/api/people/invite/route";
import { POST as mintRoute } from "../src/app/api/people/[id]/keys/route";
import {
  GET as offboardGet,
  POST as offboardPost,
} from "../src/app/api/people/[id]/offboard/route";
import { POST as retryRoute } from "../src/app/api/people/[id]/offboard/retry/route";
import { createSession, SESSION_COOKIE } from "../src/lib/auth";
import { closePool } from "../src/lib/db";
import { checkLimitAlerts } from "../src/lib/limits";
import { personDetail } from "../src/lib/people";
import { recomputeRollups } from "../src/lib/rollup";
import { setSecretSetting } from "../src/lib/settings";
import { runMigrations } from "../scripts/migrate.mjs";
import { getJson, postJson } from "./helpers/http";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** Stub global fetch with a (method, url, body) router; returns the call log. */
function stubFetch(
  route: (method: string, url: string, body: unknown) => Response | null,
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({
      method,
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });
    const res = route(method, url, body);
    if (res === null) throw new Error(`unexpected vendor call: ${method} ${url}`);
    return res;
  });
  return calls;
}

// Vendor fixtures matching the connectors' strict parsers.
const PROJECT_LIST = (projects: { id: string; name: string; status: string }[]) =>
  json({
    object: "list",
    data: projects.map((p) => ({
      object: "organization.project",
      id: p.id,
      name: p.name,
      created_at: 1_700_000_000,
      archived_at: p.status === "archived" ? 1_710_000_000 : null,
      status: p.status,
    })),
    first_id: projects[0]?.id ?? null,
    has_more: false,
    last_id: projects[projects.length - 1]?.id ?? null,
  });

const API_KEY_LIST = json({
  object: "list",
  data: [
    {
      object: "organization.project.api_key",
      id: "key_1",
      name: "dana-laptop",
      redacted_value: "sk-...abc",
      created_at: 1_700_000_000,
      last_used_at: null,
      owner: {
        type: "user",
        user: {
          object: "organization.project.user",
          id: "u_1",
          name: "Dana",
          email: "dana@acme.com",
          role: "member",
          added_at: 1_700_000_000,
        },
      },
    },
  ],
  first_id: "key_1",
  has_more: false,
  last_id: "key_1",
});

describe.runIf(TEST_DATABASE_URL)("people in/out (spec 8)", () => {
  let dbUrl: string;
  let pool: Pool;
  let adminCookie: string;
  let viewerCookie: string;
  let dana: string;
  let omar: string;

  beforeAll(async () => {
    dbUrl = await createScratchDb("provision_test");
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

    const { rows: people } = await pool.query(
      `INSERT INTO people (email, name) VALUES
         ('dana@acme.com', 'Dana'), ('omar@acme.com', 'Omar')
       RETURNING id`,
    );
    dana = people[0].id;
    omar = people[1].id;

    // Dana's access across vendors - what offboarding must remove. The
    // github "user" identity is attribution only (the seat is the access).
    await pool.query(
      `INSERT INTO identities (person_id, vendor, external_id, kind, display_name, email) VALUES
         ($1, 'openai', 'u_1', 'user', 'Dana', 'dana@acme.com'),
         ($1, 'openai', 'key_1', 'api_key', 'dana-laptop', 'dana@acme.com'),
         ($1, 'anthropic', 'au_1', 'user', 'Dana', 'dana@acme.com'),
         ($1, 'anthropic', 'ak_1', 'api_key', 'dana-key', 'dana@acme.com'),
         ($1, 'cursor', '42', 'user', 'Dana', 'dana@acme.com'),
         ($1, 'github', '7', 'user', 'dana-gh', NULL),
         ($1, 'github', '7', 'seat', 'dana-gh', NULL)`,
      [dana],
    );

    // Connected state for openai/anthropic/github (cursor connects later -
    // the invite test wants its honest not-connected error first).
    for (const [vendor, config] of [
      ["openai", { adminKey: "sk-admin-test" }],
      ["anthropic", { adminKey: "sk-ant-admin-test" }],
      ["github", { org: "acme", token: "ghp_test" }],
    ] as const) {
      await pool.query(
        "INSERT INTO connectors (vendor, history_limit_days) VALUES ($1, 90)",
        [vendor],
      );
      await setSecretSetting(`connector:${vendor}:config`, JSON.stringify(config), pool);
    }
  });

  afterAll(async () => {
    await closePool();
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes need the admin; the offboard plan is readable by viewers", async () => {
    expect((await inviteRoute(postJson("/api/people/invite", {}))).status).toBe(401);
    expect(
      (await inviteRoute(postJson("/api/people/invite", {}, viewerCookie))).status,
    ).toBe(403);
    expect(
      (
        await mintRoute(
          postJson(`/api/people/${dana}/keys`, { vendor: "openai" }, viewerCookie),
          params(dana),
        )
      ).status,
    ).toBe(403);
    expect(
      (await offboardPost(postJson(`/api/people/${dana}/offboard`, {}, viewerCookie), params(dana)))
        .status,
    ).toBe(403);
    expect(
      (
        await retryRoute(
          postJson(`/api/people/${dana}/offboard/retry`, { itemId: dana }, viewerCookie),
          params(dana),
        )
      ).status,
    ).toBe(403);
    expect(
      (await offboardGet(getJson(`/api/people/${dana}/offboard`, viewerCookie), params(dana)))
        .status,
    ).toBe(200);
  });

  it("rejects bad invite bodies", async () => {
    for (const body of [
      {},
      { personIds: "x", vendors: [] },
      { personIds: [dana], vendors: ["slack"] },
      { personIds: ["not-a-uuid"], vendors: ["openai"] },
      { personIds: [], vendors: ["openai"] },
    ]) {
      const res = await inviteRoute(postJson("/api/people/invite", body, adminCookie));
      expect(res.status).toBe(400);
    }
    const ghost = "00000000-0000-4000-8000-00000000dead";
    expect(
      (
        await inviteRoute(
          postJson("/api/people/invite", { personIds: [ghost], vendors: ["openai"] }, adminCookie),
        )
      ).status,
    ).toBe(404);
  });

  it("fans invites out per person per tool with vendor errors verbatim", async () => {
    const calls = stubFetch((method, url, body) => {
      if (method === "POST" && url === "https://api.openai.com/v1/organization/invites") {
        const email = (body as { email: string }).email;
        if (email === "omar@acme.com") {
          // The vendor's rejection, verbatim through to the result.
          return json({ error: { message: "User omar@acme.com is already a member." } }, 409);
        }
        return json({ object: "organization.invite", id: "inv_1", email, role: "reader" });
      }
      if (method === "POST" && url === "https://api.anthropic.com/v1/organizations/invites") {
        return json({ type: "invite", id: "invite_1" });
      }
      if (
        method === "POST" &&
        url === "https://api.github.com/orgs/acme/copilot/billing/selected_users"
      ) {
        return json({ seats_created: 1 }, 201);
      }
      return null;
    });

    const res = await inviteRoute(
      postJson(
        "/api/people/invite",
        { personIds: [dana, omar], vendors: ["openai", "anthropic", "cursor", "github"] },
        adminCookie,
      ),
    );
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as {
      results: {
        personId: string;
        email: string;
        vendor: string;
        ok: boolean;
        detail: string | null;
        error: string | null;
      }[];
    };
    expect(results).toHaveLength(8);
    const result = (personId: string, vendor: string) =>
      results.find((r) => r.personId === personId && r.vendor === vendor)!;

    expect(result(dana, "openai")).toMatchObject({
      ok: true,
      detail: "org invite sent (reader role)",
    });
    expect(result(omar, "openai")).toMatchObject({
      ok: false,
      error: "User omar@acme.com is already a member.",
    });
    expect(result(dana, "anthropic").ok).toBe(true);
    // Cursor is not connected yet - honest connect-state error, not a fake.
    expect(result(dana, "cursor")).toMatchObject({
      ok: false,
      error: "Cursor is not connected - connect it in Settings first",
    });
    // GitHub seats are username-keyed: Dana has a mapped login, Omar none.
    expect(result(dana, "github")).toMatchObject({
      ok: true,
      detail: "Copilot seat assigned (@dana-gh)",
    });
    expect(result(omar, "github")).toMatchObject({
      ok: false,
      error: "no GitHub user is mapped to omar@acme.com - sync GitHub and match them in Resolve first",
    });

    // Request shapes: documented endpoints, auth headers, no email leak.
    const openaiInvite = calls.find(
      (c) => c.url.endsWith("/organization/invites") && (c.body as { email: string }).email === "dana@acme.com",
    )!;
    expect(openaiInvite.headers.authorization).toBe("Bearer sk-admin-test");
    expect(openaiInvite.body).toEqual({ email: "dana@acme.com", role: "reader" });
    const anthropicInvite = calls.find((c) => c.url.includes("anthropic"))!;
    expect(anthropicInvite.headers["x-api-key"]).toBe("sk-ant-admin-test");
    expect(anthropicInvite.body).toEqual({ email: "dana@acme.com", role: "user" });
    const seatAdd = calls.find((c) => c.url.includes("github"))!;
    expect(seatAdd.body).toEqual({ selected_usernames: ["dana-gh"] });
    // No cursor call ever went out - it is not connected.
    expect(calls.some((c) => c.url.includes("cursor"))).toBe(false);
  });

  it("minting asks which OpenAI project when there are several", async () => {
    stubFetch((method, url) =>
      method === "GET" && url.startsWith("https://api.openai.com/v1/organization/projects?")
        ? PROJECT_LIST([
            { id: "proj_1", name: "Default project", status: "active" },
            { id: "proj_2", name: "Skunkworks", status: "active" },
            { id: "proj_old", name: "Sunset", status: "archived" },
          ])
        : null,
    );
    const res = await mintRoute(
      postJson(`/api/people/${omar}/keys`, { vendor: "openai" }, adminCookie),
      params(omar),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    // Archived projects never offered.
    expect(body.projects).toEqual([
      { id: "proj_1", name: "Default project" },
      { id: "proj_2", name: "Skunkworks" },
    ]);
  });

  it("mints an OpenAI key, maps it to the person, and never stores the value", async () => {
    const calls = stubFetch((method, url) => {
      if (
        method === "POST" &&
        url === "https://api.openai.com/v1/organization/projects/proj_1/service_accounts"
      ) {
        return json({
          object: "organization.project.service_account",
          id: "sa_1",
          name: "omar@acme.com",
          role: "member",
          created_at: 1_750_000_000,
          api_key: {
            object: "organization.project.service_account.api_key",
            id: "key_mint_1",
            name: "Secret Key",
            value: "sk-svcacct-SHOWN-ONCE-NEVER-SAVED",
            created_at: 1_750_000_000,
          },
        });
      }
      return null;
    });

    const res = await mintRoute(
      postJson(`/api/people/${omar}/keys`, { vendor: "openai", projectId: "proj_1" }, adminCookie),
      params(omar),
    );
    expect(res.status).toBe(200);
    const { minted } = await res.json();
    expect(minted).toMatchObject({
      apiKey: "sk-svcacct-SHOWN-ONCE-NEVER-SAVED",
      keyId: "key_mint_1",
      projectId: "proj_1",
      name: "omar@acme.com",
    });
    expect(calls[0].body).toEqual({ name: "omar@acme.com" });

    // Mapped immediately: the key attributes to Omar from the first sync.
    const { rows } = await pool.query(
      `SELECT person_id, display_name, tags FROM identities
       WHERE vendor = 'openai' AND external_id = 'key_mint_1' AND kind = 'api_key'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].person_id).toBe(omar);
    expect(rows[0].tags).toEqual(["omar@acme.com"]);

    // Shown once, never saved: the plaintext exists nowhere in the database.
    for (const table of ["settings", "identities", "people", "offboard_items"]) {
      const { rows: leaks } = await pool.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${table}::text LIKE '%SHOWN-ONCE-NEVER-SAVED%'`,
      );
      expect(leaks[0].n).toBe(0);
    }
  });

  it("refuses to mint for unknown or non-active people and other vendors", async () => {
    const ghost = "00000000-0000-4000-8000-00000000dead";
    expect(
      (
        await mintRoute(
          postJson(`/api/people/${ghost}/keys`, { vendor: "openai" }, adminCookie),
          params(ghost),
        )
      ).status,
    ).toBe(404);
    // Anthropic has no key-creation API - the route says so.
    const anthropicRes = await mintRoute(
      postJson(`/api/people/${omar}/keys`, { vendor: "anthropic" }, adminCookie),
      params(omar),
    );
    expect(anthropicRes.status).toBe(400);
    expect((await anthropicRes.json()).error).toContain("Console");
  });

  describe("offboard sweep", () => {
    beforeAll(async () => {
      // Cursor joins the connected vendors for the sweep.
      await pool.query(
        "INSERT INTO connectors (vendor, history_limit_days) VALUES ('cursor', 90)",
      );
      await setSecretSetting(
        "connector:cursor:config",
        JSON.stringify({ apiKey: "cursor-admin-key" }),
        pool,
      );
      // History that must survive the sweep, and the burn-check seed.
      const today = new Date().toISOString().slice(0, 10);
      await pool.query(
        `INSERT INTO spend_facts
           (day, person_id, identity_id, vendor, amount_cents, currency, cost_basis, source_ref)
         SELECT $1, $2, i.id, 'openai', 50000, 'USD', 'estimated', 'prov:1'
         FROM identities i WHERE i.vendor = 'openai' AND i.external_id = 'key_1'`,
        [today, dana],
      );
      await recomputeRollups({ from: today, to: today }, pool);
    });

    it("lists every key and seat across vendors before confirming", async () => {
      const res = await offboardGet(
        getJson(`/api/people/${dana}/offboard`, viewerCookie),
        params(dana),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.person).toMatchObject({ id: dana, email: "dana@acme.com", status: "active" });
      // The github "user" identity is attribution, not access - not listed.
      expect(
        body.items.map((i: { vendor: string; kind: string; status: string }) => [
          i.vendor,
          i.kind,
          i.status,
        ]),
      ).toEqual([
        ["anthropic", "api_key", "active"],
        ["anthropic", "user", "active"],
        ["cursor", "user", "active"],
        ["github", "seat", "active"],
        ["openai", "api_key", "active"],
        ["openai", "user", "active"],
      ]);
    });

    it("removes everything on confirm; failures keep the vendor error and stay retryable", async () => {
      const calls = stubFetch((method, url, body) => {
        if (method === "DELETE" && url === "https://api.openai.com/v1/organization/users/u_1") {
          return json({ object: "organization.user.deleted", id: "u_1", deleted: true });
        }
        if (method === "GET" && url.startsWith("https://api.openai.com/v1/organization/projects?")) {
          return PROJECT_LIST([{ id: "proj_1", name: "Default project", status: "active" }]);
        }
        if (
          method === "GET" &&
          url.startsWith("https://api.openai.com/v1/organization/projects/proj_1/api_keys")
        ) {
          return API_KEY_LIST;
        }
        if (
          method === "DELETE" &&
          url === "https://api.openai.com/v1/organization/projects/proj_1/api_keys/key_1"
        ) {
          return json({ object: "organization.project.api_key.deleted", id: "key_1", deleted: true });
        }
        if (method === "DELETE" && url === "https://api.anthropic.com/v1/organizations/users/au_1") {
          return json({ type: "user_deleted", id: "au_1" });
        }
        if (method === "POST" && url === "https://api.anthropic.com/v1/organizations/api_keys/ak_1") {
          expect(body).toEqual({ status: "archived" });
          return json({ type: "api_key", id: "ak_1", status: "archived" });
        }
        if (method === "DELETE" && url === "https://api.cursor.com/teams/members/42") {
          return json({ error: "Only team admins can remove members." }, 403);
        }
        if (
          method === "DELETE" &&
          url === "https://api.github.com/orgs/acme/copilot/billing/selected_users"
        ) {
          expect(body).toEqual({ selected_usernames: ["dana-gh"] });
          return json({ seats_cancelled: 1 });
        }
        return null;
      });

      const res = await offboardPost(
        postJson(`/api/people/${dana}/offboard`, {}, adminCookie),
        params(dana),
      );
      expect(res.status).toBe(200);
      const result = await res.json();
      // History kept; person excluded from current burn (spec 8).
      expect(result.person.status).toBe("offboarded");
      const statuses = Object.fromEntries(
        result.items.map((i: { vendor: string; kind: string; status: string; error: string | null }) => [
          `${i.vendor}:${i.kind}`,
          [i.status, i.error],
        ]),
      );
      expect(statuses).toEqual({
        "anthropic:api_key": ["removed", null],
        "anthropic:user": ["removed", null],
        "cursor:user": ["failed", "Only team admins can remove members."],
        "github:seat": ["removed", null],
        "openai:api_key": ["removed", null],
        "openai:user": ["removed", null],
      });
      // The anthropic archive call really happened (no key-delete API).
      expect(calls.some((c) => c.url.endsWith("/api_keys/ak_1") && c.method === "POST")).toBe(true);

      // Removed identities are deprovisioned; the failed one is not.
      const { rows } = await pool.query(
        `SELECT external_id, kind, (deprovisioned_at IS NOT NULL) AS gone
         FROM identities WHERE person_id = $1 ORDER BY vendor, kind, external_id`,
        [dana],
      );
      const gone = Object.fromEntries(rows.map((r) => [`${r.external_id}:${r.kind}`, r.gone]));
      expect(gone).toEqual({
        "ak_1:api_key": true,
        "au_1:user": true,
        "42:user": false,
        "7:seat": true,
        "7:user": false, // attribution identity untouched
        "key_1:api_key": true,
        "u_1:user": true,
      });

      // History intact: the spend fact and its identity link survive.
      const { rows: facts } = await pool.query(
        "SELECT count(*)::int AS n FROM spend_facts WHERE person_id = $1 AND identity_id IS NOT NULL",
        [dana],
      );
      expect(facts[0].n).toBe(1);
      // The person page marks the removed key honestly.
      const today = new Date().toISOString().slice(0, 10);
      const detail = await personDetail(dana, { from: today, to: today }, pool);
      const key = detail.keys.find((k) => k.externalId === "key_1")!;
      expect(key.deprovisionedAt).not.toBeNull();
    });

    it("re-running the sweep retries only the failure - no duplicate items", async () => {
      const calls = stubFetch((method, url) =>
        method === "DELETE" && url === "https://api.cursor.com/teams/members/42"
          ? json({ error: "Only team admins can remove members." }, 403)
          : null,
      );
      const res = await offboardPost(
        postJson(`/api/people/${dana}/offboard`, {}, adminCookie),
        params(dana),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).items).toHaveLength(6);
      // Only the failed cursor item went back to its vendor.
      expect(calls).toHaveLength(1);
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM offboard_items WHERE person_id = $1",
        [dana],
      );
      expect(rows[0].n).toBe(6);
    });

    it("retries one item by id and finishes the sweep", async () => {
      const { rows } = await pool.query(
        "SELECT id FROM offboard_items WHERE person_id = $1 AND status = 'failed'",
        [dana],
      );
      expect(rows).toHaveLength(1);
      const itemId = rows[0].id;

      // Retry against a wrong person 404s.
      expect(
        (
          await retryRoute(
            postJson(`/api/people/${omar}/offboard/retry`, { itemId }, adminCookie),
            params(omar),
          )
        ).status,
      ).toBe(404);

      stubFetch((method, url) =>
        method === "DELETE" && url === "https://api.cursor.com/teams/members/42"
          ? json({})
          : null,
      );
      const res = await retryRoute(
        postJson(`/api/people/${dana}/offboard/retry`, { itemId }, adminCookie),
        params(dana),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).item).toMatchObject({ status: "removed", error: null });

      // A second retry on a removed item is refused.
      expect(
        (
          await retryRoute(
            postJson(`/api/people/${dana}/offboard/retry`, { itemId }, adminCookie),
            params(dana),
          )
        ).status,
      ).toBe(409);

      const overview = await offboardGet(
        getJson(`/api/people/${dana}/offboard`, viewerCookie),
        params(dana),
      );
      const items = (await overview.json()).items as { status: string }[];
      expect(items.every((i) => i.status === "removed")).toBe(true);
    });

    it("offboarded people are excluded from current burn checks", async () => {
      await pool.query(
        "UPDATE people SET monthly_limit_usd_cents = 10000 WHERE id = $1",
        [dana],
      );
      // Dana spent $500 against a $100 limit this month - but offboarded
      // people never alert.
      expect(await checkLimitAlerts({ pool })).toEqual([]);
      // Same data with the person active fires - the exclusion above is the
      // status, not missing data.
      await pool.query("UPDATE people SET status = 'active' WHERE id = $1", [dana]);
      const alerts = await checkLimitAlerts({ pool });
      expect(alerts.map((a) => a.thresholdPct)).toEqual([80, 100]);
      await pool.query("UPDATE people SET status = 'offboarded' WHERE id = $1", [dana]);
    });

    it("invites and minting refuse offboarded people", async () => {
      const inviteRes = await inviteRoute(
        postJson("/api/people/invite", { personIds: [dana], vendors: ["openai"] }, adminCookie),
      );
      const { results } = await inviteRes.json();
      expect(results[0]).toMatchObject({ ok: false, error: "person is offboarded" });
      const mintRes = await mintRoute(
        postJson(`/api/people/${dana}/keys`, { vendor: "openai" }, adminCookie),
        params(dana),
      );
      expect(mintRes.status).toBe(409);
      expect((await mintRes.json()).error).toBe("person is offboarded");
    });
  });
});
