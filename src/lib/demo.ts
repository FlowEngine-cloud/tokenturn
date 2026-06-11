import type { Pool } from "pg";
import { getPool, type Db } from "./db";
import { logger } from "./logger";
import { ResolveError } from "./resolve";
import { recomputeRollups } from "./rollup";

/**
 * Demo dataset (spec 10, Onboarding): "start with demo data (wiped when the
 * first real connector connects)". The generator writes ~6 months of
 * realistic-looking people, keys, tags, products, daily spend, usage
 * counters and outcomes through the normal tables and the normal rollup
 * recompute, so every page renders exactly the way it will with real data -
 * and every demo number still drills down to its (demo) source rows.
 *
 * Demo rows are real ledger rows, marked two ways:
 * - every spend fact / outcome / usage metric carries a `demo:` source_ref
 *   prefix - the wipe selector that cannot get lost;
 * - the created people/products/identities/tag ids live in the
 *   `demo_dataset` settings row (the marker), written in the same
 *   transaction as the data.
 *
 * The wipe runs when the first real connector connects (see
 * connectConnector) and is conservative: a person or product that real data
 * has attached to in the meantime (a CSV re-import claimed the email, an
 * ingest key was minted for the product, a manual entry landed) is kept -
 * only its demo spend disappears. Rollups recompute over the demo span, so
 * the charts drop to exactly what the real rows say.
 */

export const DEMO_MARKER_KEY = "demo_dataset";
/** Every demo fact/outcome/metric source_ref starts with this. */
export const DEMO_REF_PREFIX = "demo:";
export const DEMO_DAYS = 180;

export interface DemoMarker {
  seededAt: string;
  from: string;
  to: string;
  peopleIds: string[];
  productIds: string[];
  identityIds: string[];
  tags: string[];
}

export interface DemoSummary {
  from: string;
  to: string;
  people: number;
  products: number;
  identities: number;
  facts: number;
  outcomes: number;
  metrics: number;
}

/** The marker, or null when no demo data is present. */
export async function demoMarker(db: Db = getPool()): Promise<DemoMarker | null> {
  const { rows } = await db.query(
    "SELECT value FROM settings WHERE key = $1 AND secret = false",
    [DEMO_MARKER_KEY],
  );
  return rows.length > 0 ? (rows[0].value as DemoMarker) : null;
}

// ---- deterministic generator ------------------------------------------------

/** mulberry32 - tiny seeded PRNG so the dataset is stable for tests. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return utcDay(d);
}

function isWeekend(day: string): boolean {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

type Role = "eng-claude" | "eng-cursor" | "eng-mixed" | "support" | "ops";

interface DemoPerson {
  handle: string;
  name: string;
  role: Role;
}

const DEMO_PEOPLE: DemoPerson[] = [
  { handle: "dana", name: "Dana Roth", role: "eng-claude" },
  { handle: "omer", name: "Omer Lev", role: "support" },
  { handle: "noa", name: "Noa Bar", role: "eng-cursor" },
  { handle: "adam", name: "Adam Klein", role: "eng-claude" },
  { handle: "maya", name: "Maya Peretz", role: "eng-mixed" },
  { handle: "eli", name: "Eli Cohen", role: "eng-cursor" },
  { handle: "tamar", name: "Tamar Levi", role: "support" },
  { handle: "yossi", name: "Yossi Mizrahi", role: "eng-claude" },
  { handle: "shira", name: "Shira Gold", role: "eng-mixed" },
  { handle: "david", name: "David Stern", role: "ops" },
  { handle: "rina", name: "Rina Azulay", role: "eng-cursor" },
  { handle: "jonah", name: "Jonah Fried", role: "ops" },
];

const DEMO_DOMAIN = "acme.dev";

interface FactRow {
  day: string;
  personId: string | null;
  productId: string | null;
  vendor: string;
  model: string | null;
  tokens: number;
  amountCents: number;
  costBasis: "estimated" | "invoiced";
  sourceRef: string;
  identityId: string | null;
}

interface OutcomeRow {
  ts: string;
  productId: string;
  personId: string | null;
  kind: string;
  count: number;
  valueCents: number | null;
  tools: string[];
  sourceRef: string;
  revertedAt: string | null;
  revertSourceRef: string | null;
}

interface MetricRow {
  day: string;
  vendor: string;
  metric: string;
  value: number;
  personId: string | null;
  sourceRef: string;
}

/** PR authorship mix per role - what makes the Tools page comparison real. */
const TOOL_MIX: Record<Role, [string, number][]> = {
  "eng-claude": [
    ["claude_code", 0.8],
    ["cursor", 0.1],
    ["copilot", 0.1],
  ],
  "eng-cursor": [
    ["cursor", 0.75],
    ["copilot", 0.15],
    ["claude_code", 0.1],
  ],
  "eng-mixed": [
    ["claude_code", 0.45],
    ["cursor", 0.45],
    ["copilot", 0.1],
  ],
  support: [],
  ops: [],
};

function pick(rand: () => number, mix: [string, number][]): string {
  const r = rand();
  let acc = 0;
  for (const [tool, weight] of mix) {
    acc += weight;
    if (r < acc) return tool;
  }
  return mix[mix.length - 1][0];
}

function between(rand: () => number, lo: number, hi: number): number {
  return Math.round(lo + rand() * (hi - lo));
}

/**
 * Seed the demo dataset. Refuses when demo data is already present or a
 * real connector is connected (it would be wiped immediately). One
 * transaction: data + marker land together, then rollups recompute.
 */
export async function seedDemoData(
  pool: Pool = getPool(),
  now: Date = new Date(),
): Promise<DemoSummary> {
  if (await demoMarker(pool)) {
    throw new ResolveError("demo data is already present", 409);
  }
  const { rows: connected } = await pool.query("SELECT count(*)::int AS n FROM connectors");
  if (connected[0].n > 0) {
    throw new ResolveError(
      "a vendor is already connected - demo data would be wiped immediately",
      409,
    );
  }

  const to = utcDay(now);
  const from = addDays(to, -(DEMO_DAYS - 1));
  const rand = rng(0x20260610);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // People
    const peopleIds = new Map<string, string>();
    for (const person of DEMO_PEOPLE) {
      const { rows } = await client.query(
        `INSERT INTO people (email, name, source) VALUES ($1, $2, 'manual') RETURNING id`,
        [`${person.handle}@${DEMO_DOMAIN}`, person.name],
      );
      peopleIds.set(person.handle, rows[0].id as string);
    }

    // Products (spec 7's four archetypes)
    const productIds = new Map<string, string>();
    const productDefs = [
      { key: "coding", name: "Coding", attribution: "connector", outcome: "github_pr", value: null },
      { key: "support", name: "Support Bot", attribution: "sdk", outcome: "sdk_event", value: 450 },
      { key: "brain", name: "Company Brain", attribution: "sdk", outcome: "none", value: null },
      { key: "devin", name: "Devin", attribution: "key", outcome: "none", value: null },
    ] as const;
    for (const def of productDefs) {
      const { rows } = await client.query(
        `INSERT INTO products (name, attribution, outcome_kind, default_value_cents, default_value_currency)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [def.name, def.attribution, def.outcome, def.value, def.value === null ? null : "USD"],
      );
      productIds.set(def.key, rows[0].id as string);
    }

    // Identities: one Anthropic key per engineer (key name = tag, spec 7b),
    // Cursor + GitHub users for engineers, plus the convention keys - a
    // batch key toggled out of personal usage, the devin key routed to its
    // product, and two unresolved identities that keep the Resolve queue
    // honest from minute one.
    const identityIds: string[] = [];
    const identityIdByExternal = new Map<string, string>();
    async function insertIdentity(
      vendor: string,
      externalId: string,
      kind: string,
      opts: {
        email?: string | null;
        displayName?: string | null;
        tags?: string[];
        personId?: string | null;
        productId?: string | null;
        notPerson?: boolean;
      } = {},
    ): Promise<string> {
      const { rows } = await client.query(
        `INSERT INTO identities
           (vendor, external_id, kind, email, display_name, tags, person_id, product_id, not_person)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          vendor,
          externalId,
          kind,
          opts.email ?? null,
          opts.displayName ?? null,
          opts.tags ?? [],
          opts.personId ?? null,
          opts.productId ?? null,
          opts.notPerson ?? false,
        ],
      );
      const id = rows[0].id as string;
      identityIds.push(id);
      identityIdByExternal.set(externalId, id);
      return id;
    }

    for (const person of DEMO_PEOPLE) {
      const personId = peopleIds.get(person.handle)!;
      const email = `${person.handle}@${DEMO_DOMAIN}`;
      await insertIdentity("anthropic", `demo-key-${person.handle}`, "api_key", {
        email,
        displayName: `${person.handle}-cli`,
        tags: [`${person.handle}-cli`],
        personId,
      });
      if (person.role.startsWith("eng")) {
        await insertIdentity("cursor", `demo-cursor-${person.handle}`, "user", {
          email,
          displayName: person.name,
          personId,
        });
        await insertIdentity("github", `demo-gh-${person.handle}`, "user", {
          email,
          displayName: person.name,
          personId,
        });
      }
    }
    await insertIdentity("anthropic", "demo-key-batch", "api_key", {
      email: `dana@${DEMO_DOMAIN}`,
      displayName: "batch-processing",
      tags: ["batch-processing"],
      personId: peopleIds.get("dana"),
    });
    const devinIdentity = await insertIdentity("anthropic", "demo-key-devin", "api_key", {
      displayName: "devin",
      tags: ["devin"],
      productId: productIds.get("devin"),
      notPerson: true,
    });
    const legacyIdentity = await insertIdentity("anthropic", "demo-key-legacy", "api_key", {
      displayName: "legacy-batch",
      tags: ["legacy-batch"],
    });
    const guestIdentity = await insertIdentity("cursor", "demo-cursor-guest", "user", {
      email: "maya.peretz.dev@gmail.com",
      displayName: "Maya Peretz",
    });

    // Tag conventions (spec 7b): batch jobs don't count toward personal
    // usage; the devin tag routes to the Devin product.
    const tags = ["batch-processing", "devin"];
    await client.query(
      `INSERT INTO tag_settings (tag, counts_personal) VALUES ('batch-processing', false)`,
    );
    await client.query(
      `INSERT INTO tag_settings (tag, product_id) VALUES ('devin', $1)`,
      [productIds.get("devin")],
    );

    // ---- six months of daily activity ----
    const facts: FactRow[] = [];
    const outcomes: OutcomeRow[] = [];
    const metrics: MetricRow[] = [];
    let revertSeq = 0;

    const months = new Set<string>();
    for (let day = from; day <= to; day = addDays(day, 1)) {
      months.add(day.slice(0, 7));
      const workday = !isWeekend(day);

      for (const person of DEMO_PEOPLE) {
        const personId = peopleIds.get(person.handle)!;
        const eng = person.role.startsWith("eng");
        const claudeUser = person.role === "eng-claude" || person.role === "eng-mixed";
        const cursorUser = person.role === "eng-cursor" || person.role === "eng-mixed";

        if (eng && workday) {
          // Anthropic API spend through the personal key.
          const anthropicCents = claudeUser
            ? between(rand, 500, 1500)
            : between(rand, 100, 450);
          facts.push({
            day,
            personId,
            productId: productIds.get("coding")!,
            vendor: "anthropic",
            model: "claude-sonnet-4-5",
            tokens: anthropicCents * between(rand, 320, 420),
            amountCents: anthropicCents,
            costBasis: "estimated",
            sourceRef: `demo:anthropic:${person.handle}:${day}`,
            identityId: identityIdByExternal.get(`demo-key-${person.handle}`) ?? null,
          });
          if (claudeUser && rand() < 0.3) {
            const opusCents = between(rand, 200, 800);
            facts.push({
              day,
              personId,
              productId: productIds.get("coding")!,
              vendor: "anthropic",
              model: "claude-opus-4-6",
              tokens: opusCents * between(rand, 60, 90),
              amountCents: opusCents,
              costBasis: "estimated",
              sourceRef: `demo:anthropic-opus:${person.handle}:${day}`,
              identityId: identityIdByExternal.get(`demo-key-${person.handle}`) ?? null,
            });
          }
          // Cursor spend per member.
          const cursorCents = cursorUser ? between(rand, 250, 700) : between(rand, 50, 200);
          facts.push({
            day,
            personId,
            productId: productIds.get("coding")!,
            vendor: "cursor",
            model: null,
            tokens: 0,
            amountCents: cursorCents,
            costBasis: "estimated",
            sourceRef: `demo:cursor:${person.handle}:${day}`,
            identityId: identityIdByExternal.get(`demo-cursor-${person.handle}`) ?? null,
          });

          // Usage counters behind the Tools page accept rates.
          if (claudeUser) {
            metrics.push(
              { day, vendor: "anthropic", metric: "estimated_cost_cents", value: anthropicCents, personId, sourceRef: `demo:ccm:${person.handle}:${day}` },
              { day, vendor: "anthropic", metric: "tool_actions_accepted", value: between(rand, 40, 160), personId, sourceRef: `demo:ccm:${person.handle}:${day}` },
              { day, vendor: "anthropic", metric: "tool_actions_rejected", value: between(rand, 8, 40), personId, sourceRef: `demo:ccm:${person.handle}:${day}` },
            );
          }
          if (cursorUser) {
            metrics.push(
              { day, vendor: "cursor", metric: "accepts", value: between(rand, 50, 200), personId, sourceRef: `demo:cum:${person.handle}:${day}` },
              { day, vendor: "cursor", metric: "rejects", value: between(rand, 15, 60), personId, sourceRef: `demo:cum:${person.handle}:${day}` },
            );
          }
          const generations = between(rand, 80, 300);
          metrics.push(
            { day, vendor: "github", metric: "code_generations", value: generations, personId, sourceRef: `demo:ghm:${person.handle}:${day}` },
            { day, vendor: "github", metric: "code_acceptances", value: Math.round(generations * (0.25 + rand() * 0.2)), personId, sourceRef: `demo:ghm:${person.handle}:${day}` },
          );

          // Merged PRs - the coding outcome (spec 5), ~6% later reverted.
          const merges = Math.floor(rand() * 3.4);
          const mix = TOOL_MIX[person.role];
          for (let i = 0; i < merges; i++) {
            const reverted = rand() < 0.06;
            outcomes.push({
              ts: `${day}T${String(between(rand, 9, 17)).padStart(2, "0")}:00:00Z`,
              productId: productIds.get("coding")!,
              personId,
              kind: "github_pr",
              count: 1,
              valueCents: null,
              tools: [pick(rand, mix)],
              sourceRef: `demo:pr:${person.handle}:${day}:${i}`,
              revertedAt: reverted ? `${addDays(day, 2)}T09:00:00Z` : null,
              revertSourceRef: reverted ? `demo:revert:${++revertSeq}` : null,
            });
          }
        }

        // Company Brain: everyone queries it now and then.
        if (rand() < 0.45) {
          facts.push({
            day,
            personId,
            productId: productIds.get("brain")!,
            vendor: "openai",
            model: "gpt-5-mini",
            tokens: between(rand, 20_000, 120_000),
            amountCents: between(rand, 20, 90),
            costBasis: "estimated",
            sourceRef: `demo:brain:${person.handle}:${day}`,
            identityId: null,
          });
        }
      }

      // The support bot runs every day, people don't.
      facts.push({
        day,
        personId: null,
        productId: productIds.get("support")!,
        vendor: "openai",
        model: "gpt-5-mini",
        tokens: between(rand, 400_000, 900_000),
        amountCents: between(rand, 400, 900),
        costBasis: "estimated",
        sourceRef: `demo:support:${day}`,
        identityId: null,
      });
      outcomes.push({
        ts: `${day}T23:00:00Z`,
        productId: productIds.get("support")!,
        personId: null,
        kind: "ticket_resolved",
        count: between(rand, 8, 24),
        valueCents: null, // the product's default $4.50 applies at read time
        tools: [],
        sourceRef: `demo:tickets:${day}`,
        revertedAt: null,
        revertSourceRef: null,
      });

      if (workday) {
        // Devin burns on its product, never a person (spec 7b).
        facts.push({
          day,
          personId: null,
          productId: productIds.get("devin")!,
          vendor: "anthropic",
          model: "claude-sonnet-4-5",
          tokens: between(rand, 200_000, 700_000),
          amountCents: between(rand, 500, 1800),
          costBasis: "estimated",
          sourceRef: `demo:devin:${day}`,
          identityId: devinIdentity,
        });
        if (rand() < 0.4) {
          outcomes.push({
            ts: `${day}T15:00:00Z`,
            productId: productIds.get("coding")!,
            personId: null,
            kind: "github_pr",
            count: 1,
            valueCents: null,
            tools: ["devin"],
            sourceRef: `demo:pr:devin:${day}`,
            revertedAt: null,
            revertSourceRef: null,
          });
        }
        // Dana's batch key - attributed to her, toggled out of personal usage.
        facts.push({
          day,
          personId: peopleIds.get("dana")!,
          productId: null,
          vendor: "anthropic",
          model: "claude-haiku-4-5",
          tokens: between(rand, 500_000, 1_500_000),
          amountCents: between(rand, 400, 1200),
          costBasis: "estimated",
          sourceRef: `demo:batch:${day}`,
          identityId: identityIdByExternal.get("demo-key-batch") ?? null,
        });
      }

      // The unattributed remainder (spec 4: visible, never hidden).
      if (rand() < 0.3) {
        facts.push({
          day,
          personId: null,
          productId: null,
          vendor: "anthropic",
          model: "claude-haiku-4-5",
          tokens: between(rand, 50_000, 200_000),
          amountCents: between(rand, 50, 200),
          costBasis: "estimated",
          sourceRef: `demo:legacy:${day}`,
          identityId: legacyIdentity,
        });
      }
      if (rand() < 0.25) {
        facts.push({
          day,
          personId: null,
          productId: null,
          vendor: "cursor",
          model: null,
          tokens: 0,
          amountCents: between(rand, 100, 300),
          costBasis: "estimated",
          sourceRef: `demo:guest:${day}`,
          identityId: guestIdentity,
        });
      }
    }

    // Copilot seats bill monthly (spec 5: seat fees only as the vendor
    // reports them) - one invoiced fact per engineer per month.
    for (const month of months) {
      const monthStart = `${month}-01`;
      if (monthStart < from) continue;
      for (const person of DEMO_PEOPLE) {
        if (!person.role.startsWith("eng")) continue;
        facts.push({
          day: monthStart,
          personId: peopleIds.get(person.handle)!,
          productId: productIds.get("coding")!,
          vendor: "github",
          model: null,
          tokens: 0,
          amountCents: 1900,
          costBasis: "invoiced",
          sourceRef: `demo:copilot:${person.handle}:${month}`,
          identityId: identityIdByExternal.get(`demo-gh-${person.handle}`) ?? null,
        });
      }
    }

    // Bulk inserts via UNNEST - thousands of rows, three statements.
    await client.query(
      `INSERT INTO spend_facts
         (day, person_id, product_id, vendor, model, tokens, amount_cents,
          currency, cost_basis, source_ref, identity_id)
       SELECT day, person_id, product_id, vendor, model, tokens, amount_cents,
              'USD', cost_basis, source_ref, identity_id
       FROM UNNEST(
         $1::date[], $2::uuid[], $3::uuid[], $4::text[], $5::text[],
         $6::bigint[], $7::bigint[], $8::text[], $9::text[], $10::uuid[]
       ) AS t(day, person_id, product_id, vendor, model, tokens, amount_cents,
              cost_basis, source_ref, identity_id)`,
      [
        facts.map((f) => f.day),
        facts.map((f) => f.personId),
        facts.map((f) => f.productId),
        facts.map((f) => f.vendor),
        facts.map((f) => f.model),
        facts.map((f) => f.tokens),
        facts.map((f) => f.amountCents),
        facts.map((f) => f.costBasis),
        facts.map((f) => f.sourceRef),
        facts.map((f) => f.identityId),
      ],
    );
    await client.query(
      `INSERT INTO outcomes
         (ts, product_id, person_id, kind, count, value_cents, currency,
          tools, source_ref, reverted_at, revert_source_ref)
       SELECT ts, product_id, person_id, kind, count, value_cents,
              CASE WHEN value_cents IS NULL THEN NULL ELSE 'USD' END,
              string_to_array(tools, ','), source_ref, reverted_at, revert_source_ref
       FROM UNNEST(
         $1::timestamptz[], $2::uuid[], $3::uuid[], $4::text[], $5::int[],
         $6::bigint[], $7::text[], $8::text[], $9::timestamptz[], $10::text[]
       ) AS t(ts, product_id, person_id, kind, count, value_cents, tools,
              source_ref, reverted_at, revert_source_ref)`,
      [
        outcomes.map((o) => o.ts),
        outcomes.map((o) => o.productId),
        outcomes.map((o) => o.personId),
        outcomes.map((o) => o.kind),
        outcomes.map((o) => o.count),
        outcomes.map((o) => o.valueCents),
        outcomes.map((o) => o.tools.join(",")),
        outcomes.map((o) => o.sourceRef),
        outcomes.map((o) => o.revertedAt),
        outcomes.map((o) => o.revertSourceRef),
      ],
    );
    await client.query(
      `INSERT INTO usage_metrics (day, vendor, metric, value, person_id, source_ref)
       SELECT day, vendor, metric, value, person_id, source_ref
       FROM UNNEST(
         $1::date[], $2::text[], $3::text[], $4::bigint[], $5::uuid[], $6::text[]
       ) AS t(day, vendor, metric, value, person_id, source_ref)`,
      [
        metrics.map((m) => m.day),
        metrics.map((m) => m.vendor),
        metrics.map((m) => m.metric),
        metrics.map((m) => m.value),
        metrics.map((m) => m.personId),
        metrics.map((m) => m.sourceRef),
      ],
    );

    const marker: DemoMarker = {
      seededAt: now.toISOString(),
      from,
      to,
      peopleIds: [...peopleIds.values()],
      productIds: [...productIds.values()],
      identityIds,
      tags,
    };
    await client.query(
      `INSERT INTO settings (key, value, secret) VALUES ($1, $2::jsonb, false)`,
      [DEMO_MARKER_KEY, JSON.stringify(marker)],
    );

    await client.query("COMMIT");

    await recomputeRollups({ from, to }, pool);
    const summary: DemoSummary = {
      from,
      to,
      people: DEMO_PEOPLE.length,
      products: 4,
      identities: identityIds.length,
      facts: facts.length,
      outcomes: outcomes.length,
      metrics: metrics.length,
    };
    logger.info("demo data seeded", { ...summary });
    return summary;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if ((err as { code?: string }).code === "23505") {
      throw new ResolveError(
        "demo data collides with existing rows (a person or product already uses a demo name)",
        409,
      );
    }
    throw err;
  } finally {
    client.release();
  }
}

export interface WipeResult {
  wiped: boolean;
  facts: number;
  outcomes: number;
  metrics: number;
  /** People/products kept because real data attached to them since. */
  keptPeople: number;
  keptProducts: number;
}

/**
 * Wipe the demo dataset - called when the first real connector connects
 * (spec 10). Deletes the demo facts/outcomes/metrics by their `demo:`
 * source_ref prefix, then the demo identities, tag rows, people and
 * products - keeping any person or product that real rows reference by now
 * (a CSV import claimed the email, an ingest key or manual entry landed on
 * the product). Rollups recompute over the demo span afterwards.
 */
export async function wipeDemoData(pool: Pool = getPool()): Promise<WipeResult> {
  const none: WipeResult = {
    wiped: false,
    facts: 0,
    outcomes: 0,
    metrics: 0,
    keptPeople: 0,
    keptProducts: 0,
  };
  const client = await pool.connect();
  let marker: DemoMarker | null = null;
  let result = none;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT value FROM settings WHERE key = $1 FOR UPDATE",
      [DEMO_MARKER_KEY],
    );
    if (rows.length === 0) {
      await client.query("COMMIT");
      return none;
    }
    marker = rows[0].value as DemoMarker;
    const like = `${DEMO_REF_PREFIX}%`;

    const outcomes = await client.query(
      "DELETE FROM outcomes WHERE source_ref LIKE $1",
      [like],
    );
    const metrics = await client.query(
      "DELETE FROM usage_metrics WHERE source_ref LIKE $1",
      [like],
    );
    const facts = await client.query(
      "DELETE FROM spend_facts WHERE source_ref LIKE $1",
      [like],
    );
    await client.query("DELETE FROM identities WHERE id = ANY($1::uuid[])", [
      marker.identityIds,
    ]);
    await client.query("DELETE FROM tag_settings WHERE tag = ANY($1::text[])", [
      marker.tags,
    ]);

    // Conservative deletes: keep what real data now references. A demo
    // person re-imported via CSV flipped source to 'csv' and stays.
    const people = await client.query(
      `DELETE FROM people p
       WHERE p.id = ANY($1::uuid[]) AND p.source = 'manual'
         AND NOT EXISTS (SELECT 1 FROM spend_facts f WHERE f.person_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.person_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM usage_metrics m WHERE m.person_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM identities i WHERE i.person_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM people q WHERE q.merged_into = p.id)`,
      [marker.peopleIds],
    );
    const products = await client.query(
      `DELETE FROM products pr
       WHERE pr.id = ANY($1::uuid[])
         AND NOT EXISTS (SELECT 1 FROM spend_facts f WHERE f.product_id = pr.id)
         AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.product_id = pr.id)
         AND NOT EXISTS (SELECT 1 FROM identities i WHERE i.product_id = pr.id)
         AND NOT EXISTS (SELECT 1 FROM ingest_keys k WHERE k.product_id = pr.id)
         AND NOT EXISTS (SELECT 1 FROM manual_entries e WHERE e.product_id = pr.id)
         AND NOT EXISTS (SELECT 1 FROM tag_settings t WHERE t.product_id = pr.id)`,
      [marker.productIds],
    );

    await client.query("DELETE FROM settings WHERE key = $1", [DEMO_MARKER_KEY]);
    await client.query("COMMIT");

    result = {
      wiped: true,
      facts: facts.rowCount ?? 0,
      outcomes: outcomes.rowCount ?? 0,
      metrics: metrics.rowCount ?? 0,
      keptPeople: marker.peopleIds.length - (people.rowCount ?? 0),
      keptProducts: marker.productIds.length - (products.rowCount ?? 0),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Outside the transaction: rebuild the demo span so charts equal the
  // remaining (real) rows. An explicit range, so empty days truly empty.
  await recomputeRollups({ from: marker.from, to: marker.to }, pool);
  logger.info("demo data wiped", { ...result });
  return result;
}
