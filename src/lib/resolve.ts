import type { Pool, PoolClient } from "pg";
import { getPool, type Db } from "./db";
import { logger } from "./logger";
import { recomputeRollups } from "./rollup";

/**
 * Identity resolution (spec 5). Whatever auto-match by email could not place
 * sits in the Resolve queue: suggested matches, one click to confirm,
 * remembered forever.
 *
 * - confirmMatch: maps an identity to a person and re-attributes the
 *   identity's FULL history (facts, metrics, outcomes) - not just future
 *   spend (spec 4). When the identity carries an email the roster does not
 *   already own, the email is remembered in person_emails, so the same email
 *   on any vendor auto-maps from then on.
 * - markNotPerson: a key that is not a person (service account) routes to a
 *   product and/or a tag instead. Auto-match never re-fills it.
 * - mergePeople: two emails, one human. The merged person archives and
 *   points at the survivor; identities, history, and the merged email all
 *   follow the survivor.
 *
 * Every mutation recomputes the daily rollups for exactly the days whose
 * rows it re-attributed, so charts agree with the ledger immediately.
 */

export class ResolveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type SuggestionReason = "email" | "name" | "peer";

export interface Suggestion {
  personId: string;
  name: string | null;
  email: string;
  /**
   * Why this person is suggested:
   * - email: same email handle (local part) as a roster email
   * - name:  vendor display name equals a roster name
   * - peer:  the same email/display name is already confirmed on another identity
   */
  reason: SuggestionReason;
}

export interface QueueEntry {
  id: string;
  vendor: string;
  externalId: string;
  kind: string;
  email: string | null;
  displayName: string | null;
  tags: string[];
  manualTags: string[];
  lastSeenAt: string;
  factCount: number;
  metricCount: number;
  outcomeCount: number;
  suggestions: Suggestion[];
}

/** Spend with no person AND no product - visible per vendor, never hidden. */
export interface UnassignedVendor {
  vendor: string;
  amountUsdCents: number;
  factCount: number;
}

export interface ResolveQueue {
  queue: QueueEntry[];
  unassigned: UnassignedVendor[];
}

const SUGGESTION_RANK: Record<SuggestionReason, number> = { email: 1, name: 2, peer: 3 };
const MAX_SUGGESTIONS = 5;

/**
 * The Resolve queue: every identity with no person and not marked
 * "not a person", with deterministic, explainable match suggestions - no
 * scores, no guessing. Exact-equality signals only.
 */
export async function resolveQueue(db: Db = getPool()): Promise<ResolveQueue> {
  const { rows: queueRows } = await db.query(
    `SELECT i.id, i.vendor, i.external_id AS "externalId", i.kind, i.email,
            i.display_name AS "displayName", i.tags, i.manual_tags AS "manualTags",
            i.updated_at AS "lastSeenAt",
            (SELECT count(*) FROM spend_facts f WHERE f.identity_id = i.id)::int AS "factCount",
            (SELECT count(*) FROM usage_metrics m WHERE m.identity_id = i.id)::int AS "metricCount",
            (SELECT count(*) FROM outcomes o WHERE o.identity_id = i.id)::int AS "outcomeCount"
     FROM identities i
     WHERE i.person_id IS NULL AND NOT i.not_person
     ORDER BY i.vendor, i.kind, i.external_id`,
  );

  const { rows: suggestionRows } = await db.query(
    `WITH queue AS (
       SELECT id, email, display_name FROM identities
       WHERE person_id IS NULL AND NOT not_person
     ), live AS (
       SELECT id, email, name FROM people WHERE merged_into IS NULL
     )
     SELECT DISTINCT ON (identity_id, person_id)
            identity_id AS "identityId", person_id AS "personId",
            name, email, reason, rank
     FROM (
       -- same email handle (local part) as a roster email
       SELECT q.id AS identity_id, p.id AS person_id, p.name, p.email,
              'email' AS reason, 1 AS rank
       FROM queue q JOIN live p
         ON q.email IS NOT NULL
        AND split_part(lower(q.email), '@', 1) <> ''
        AND split_part(lower(q.email), '@', 1) = split_part(lower(p.email), '@', 1)
       UNION ALL
       -- vendor display name equals a roster name
       SELECT q.id, p.id, p.name, p.email, 'name', 2
       FROM queue q JOIN live p
         ON q.display_name IS NOT NULL AND p.name IS NOT NULL
        AND lower(p.name) = lower(q.display_name)
       UNION ALL
       -- the same email/display name is already confirmed on another identity
       SELECT DISTINCT q.id, p.id, p.name, p.email, 'peer', 3
       FROM queue q
       JOIN identities j
         ON j.person_id IS NOT NULL AND j.id <> q.id
        AND ((q.email IS NOT NULL AND j.email IS NOT NULL
              AND lower(j.email) = lower(q.email))
          OR (q.display_name IS NOT NULL AND j.display_name IS NOT NULL
              AND lower(j.display_name) = lower(q.display_name)))
       JOIN live p ON p.id = j.person_id
     ) s
     ORDER BY identity_id, person_id, rank`,
  );

  const byIdentity = new Map<string, Suggestion[]>();
  for (const row of suggestionRows) {
    const list = byIdentity.get(row.identityId) ?? [];
    list.push({
      personId: row.personId,
      name: row.name,
      email: row.email,
      reason: row.reason as SuggestionReason,
    });
    byIdentity.set(row.identityId, list);
  }

  const queue: QueueEntry[] = queueRows.map((row) => ({
    ...(row as Omit<QueueEntry, "suggestions" | "lastSeenAt">),
    lastSeenAt: new Date(row.lastSeenAt).toISOString(),
    suggestions: (byIdentity.get(row.id) ?? [])
      .sort(
        (a, b) =>
          SUGGESTION_RANK[a.reason] - SUGGESTION_RANK[b.reason] ||
          (a.email < b.email ? -1 : 1),
      )
      .slice(0, MAX_SUGGESTIONS),
  }));

  // Unassigned, visible per vendor (spec 4): no person and no product. From
  // the rollups - the same numbers every chart shows.
  const { rows: unassignedRows } = await db.query(
    `SELECT vendor, SUM(amount_usd_cents)::bigint AS amount, SUM(fact_count)::int AS facts
     FROM rollup_daily
     WHERE person_id IS NULL AND product_id IS NULL
     GROUP BY vendor ORDER BY vendor`,
  );
  const unassigned: UnassignedVendor[] = unassignedRows.map((row) => ({
    vendor: row.vendor,
    amountUsdCents: Number(row.amount),
    factCount: Number(row.facts),
  }));

  return { queue, unassigned };
}

export interface Reattributed {
  facts: number;
  metrics: number;
  outcomes: number;
  /** Day range the rollups were recomputed for; null = nothing changed. */
  rollups: { from: string | null; to: string | null };
}

interface Touched extends Omit<Reattributed, "rollups"> {
  from: string | null;
  to: string | null;
}

/**
 * Point an identity's FULL history (facts, metrics, outcomes) at a person -
 * or at Unassigned (personId null) - and, when a product is given, route its
 * facts there. Only rows that disagree are touched, so re-runs are no-ops.
 * Returns the changed row counts and the UTC day span they cover.
 */
async function reattribute(
  db: PoolClient,
  identityId: string,
  personId: string | null,
  productId: string | null = null,
): Promise<Touched> {
  const factWhere = `identity_id = $1
     AND (person_id IS DISTINCT FROM $2
       OR ($3::uuid IS NOT NULL AND product_id IS DISTINCT FROM $3))`;
  const { rows: span } = await db.query(
    `SELECT min(d)::text AS from, max(d)::text AS to FROM (
       SELECT day AS d FROM spend_facts WHERE ${factWhere}
       UNION ALL
       SELECT (ts AT TIME ZONE 'UTC')::date FROM outcomes
       WHERE identity_id = $1 AND person_id IS DISTINCT FROM $2
     ) days`,
    [identityId, personId, productId],
  );
  const facts = await db.query(
    `UPDATE spend_facts
     SET person_id = $2, product_id = COALESCE($3, product_id)
     WHERE ${factWhere}`,
    [identityId, personId, productId],
  );
  const metrics = await db.query(
    `UPDATE usage_metrics SET person_id = $2
     WHERE identity_id = $1 AND person_id IS DISTINCT FROM $2`,
    [identityId, personId],
  );
  const outcomes = await db.query(
    `UPDATE outcomes SET person_id = $2
     WHERE identity_id = $1 AND person_id IS DISTINCT FROM $2`,
    [identityId, personId],
  );
  return {
    facts: facts.rowCount ?? 0,
    metrics: metrics.rowCount ?? 0,
    outcomes: outcomes.rowCount ?? 0,
    from: span[0].from,
    to: span[0].to,
  };
}

async function recomputeTouched(
  touched: Touched,
  pool: Pool,
): Promise<Reattributed["rollups"]> {
  if (touched.from === null || touched.to === null) {
    return { from: null, to: null };
  }
  const { from, to } = await recomputeRollups(
    { from: touched.from, to: touched.to },
    pool,
  );
  return { from, to };
}

interface IdentityRow {
  id: string;
  vendor: string;
  external_id: string;
  email: string | null;
  person_id: string | null;
  product_id: string | null;
}

async function lockIdentity(db: PoolClient, identityId: string): Promise<IdentityRow> {
  const { rows } = await db.query(
    `SELECT id, vendor, external_id, email, person_id, product_id
     FROM identities WHERE id = $1 FOR UPDATE`,
    [identityId],
  );
  if (rows.length === 0) throw new ResolveError("identity not found", 404);
  return rows[0] as IdentityRow;
}

export interface ConfirmResult extends Reattributed {
  identityId: string;
  personId: string;
  /** The email now remembered forever in person_emails, when one was. */
  rememberedEmail: string | null;
}

/**
 * Confirm a match: this identity is this person. Re-attributes the
 * identity's full history and remembers the identity's email (when the
 * roster does not already own it) so every future identity with that email
 * auto-maps - on any vendor, forever. Also un-marks "not a person" - a
 * confirm is the stronger, newer decision. Product routing is untouched: a
 * key can belong to a person and still route to a product (spec 7b).
 */
export async function confirmMatch(
  identityId: string,
  personId: string,
  pool: Pool = getPool(),
): Promise<ConfirmResult> {
  const client = await pool.connect();
  let touched: Touched;
  let rememberedEmail: string | null = null;
  try {
    await client.query("BEGIN");
    const identity = await lockIdentity(client, identityId);
    const { rows: people } = await client.query(
      "SELECT id, merged_into FROM people WHERE id = $1",
      [personId],
    );
    if (people.length === 0) throw new ResolveError("person not found", 404);
    if (people[0].merged_into !== null) {
      throw new ResolveError(
        "that person was merged into another; confirm against the surviving person",
        409,
      );
    }

    await client.query(
      `UPDATE identities
       SET person_id = $2, not_person = false, updated_at = now()
       WHERE id = $1`,
      [identityId, personId],
    );

    // Remember the email forever - unless the roster already owns it as a
    // live person's primary email (then people.email is the memory).
    if (identity.email) {
      const { rowCount } = await client.query(
        `INSERT INTO person_emails (email, person_id)
         SELECT lower($1), $2
         WHERE NOT EXISTS (
           SELECT 1 FROM people
           WHERE lower(email) = lower($1) AND merged_into IS NULL
         )
         ON CONFLICT (email) DO UPDATE SET person_id = EXCLUDED.person_id`,
        [identity.email, personId],
      );
      if ((rowCount ?? 0) > 0) rememberedEmail = identity.email.toLowerCase();
    }

    touched = await reattribute(client, identityId, personId);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const rollups = await recomputeTouched(touched, pool);
  const result: ConfirmResult = {
    identityId,
    personId,
    rememberedEmail,
    facts: touched.facts,
    metrics: touched.metrics,
    outcomes: touched.outcomes,
    rollups,
  };
  logger.info("resolve: match confirmed", { ...result });
  return result;
}

export interface NotPersonResult extends Reattributed {
  identityId: string;
  productId: string | null;
  manualTags: string[];
}

/**
 * Mark an identity "not a person" (service account) and route it to a
 * product and/or a tag (spec 5). Its full history moves to Unassigned -
 * person-wise - and onto the product when one is given; auto-match will
 * never re-fill its person.
 */
export async function markNotPerson(
  identityId: string,
  route: { productId?: string | null; tag?: string | null },
  pool: Pool = getPool(),
): Promise<NotPersonResult> {
  const productId = route.productId ?? null;
  const tag = route.tag?.trim() || null;
  if (productId === null && tag === null) {
    throw new ResolveError("route the key to a product or a tag", 400);
  }

  const client = await pool.connect();
  let touched: Touched;
  let manualTags: string[];
  try {
    await client.query("BEGIN");
    await lockIdentity(client, identityId);
    if (productId !== null) {
      const { rows } = await client.query(
        "SELECT 1 FROM products WHERE id = $1 AND archived_at IS NULL",
        [productId],
      );
      if (rows.length === 0) throw new ResolveError("product not found", 404);
    }

    const { rows: updated } = await client.query(
      `UPDATE identities
       SET not_person = true, person_id = NULL,
           product_id = COALESCE($2, product_id),
           manual_tags = CASE
             WHEN $3::text IS NULL OR $3 = ANY(manual_tags) THEN manual_tags
             ELSE manual_tags || $3
           END,
           updated_at = now()
       WHERE id = $1
       RETURNING manual_tags`,
      [identityId, productId, tag],
    );
    manualTags = updated[0].manual_tags as string[];

    touched = await reattribute(client, identityId, null, productId);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const rollups = await recomputeTouched(touched, pool);
  const result: NotPersonResult = {
    identityId,
    productId,
    manualTags,
    facts: touched.facts,
    metrics: touched.metrics,
    outcomes: touched.outcomes,
    rollups,
  };
  logger.info("resolve: marked not a person", { ...result });
  return result;
}

export interface MergeResult extends Reattributed {
  fromPersonId: string;
  intoPersonId: string;
  identities: number;
  /** The merged person's email, now an alias of the survivor. */
  rememberedEmail: string;
}

/**
 * Two emails, one human (spec 5): merge `fromPersonId` into `intoPersonId`.
 * The merged person archives and points at the survivor; their identities
 * and full history (facts, metrics, outcomes) follow, and their email
 * becomes a remembered alias so future spend lands on the survivor too.
 */
export async function mergePeople(
  fromPersonId: string,
  intoPersonId: string,
  pool: Pool = getPool(),
): Promise<MergeResult> {
  if (fromPersonId === intoPersonId) {
    throw new ResolveError("cannot merge a person into themselves", 400);
  }

  const client = await pool.connect();
  let counts: { identities: number; facts: number; metrics: number; outcomes: number };
  let touched: Touched;
  let rememberedEmail: string;
  try {
    await client.query("BEGIN");
    const { rows: people } = await client.query(
      `SELECT id, email, merged_into FROM people
       WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [[fromPersonId, intoPersonId]],
    );
    const from = people.find((p) => p.id === fromPersonId);
    const into = people.find((p) => p.id === intoPersonId);
    if (!from || !into) throw new ResolveError("person not found", 404);
    if (from.merged_into !== null || into.merged_into !== null) {
      throw new ResolveError("that person was already merged", 409);
    }

    const { rows: span } = await client.query(
      `SELECT min(d)::text AS from, max(d)::text AS to FROM (
         SELECT day AS d FROM spend_facts WHERE person_id = $1
         UNION ALL
         SELECT (ts AT TIME ZONE 'UTC')::date FROM outcomes WHERE person_id = $1
       ) days`,
      [fromPersonId],
    );

    await client.query(
      `UPDATE people
       SET merged_into = $2, status = 'archived', updated_at = now()
       WHERE id = $1`,
      [fromPersonId, intoPersonId],
    );
    // The merged email is remembered forever, and any aliases the merged
    // person had collected follow the survivor too.
    rememberedEmail = (from.email as string).toLowerCase();
    await client.query(
      `INSERT INTO person_emails (email, person_id) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET person_id = EXCLUDED.person_id`,
      [rememberedEmail, intoPersonId],
    );
    await client.query(
      "UPDATE person_emails SET person_id = $2 WHERE person_id = $1",
      [fromPersonId, intoPersonId],
    );

    const identities = await client.query(
      `UPDATE identities SET person_id = $2, updated_at = now()
       WHERE person_id = $1`,
      [fromPersonId, intoPersonId],
    );
    const facts = await client.query(
      "UPDATE spend_facts SET person_id = $2 WHERE person_id = $1",
      [fromPersonId, intoPersonId],
    );
    const metrics = await client.query(
      "UPDATE usage_metrics SET person_id = $2 WHERE person_id = $1",
      [fromPersonId, intoPersonId],
    );
    const outcomes = await client.query(
      "UPDATE outcomes SET person_id = $2 WHERE person_id = $1",
      [fromPersonId, intoPersonId],
    );
    counts = {
      identities: identities.rowCount ?? 0,
      facts: facts.rowCount ?? 0,
      metrics: metrics.rowCount ?? 0,
      outcomes: outcomes.rowCount ?? 0,
    };
    touched = { ...counts, from: span[0].from, to: span[0].to };
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const rollups = await recomputeTouched(touched, pool);
  const result: MergeResult = {
    fromPersonId,
    intoPersonId,
    rememberedEmail,
    identities: counts.identities,
    facts: counts.facts,
    metrics: counts.metrics,
    outcomes: counts.outcomes,
    rollups,
  };
  logger.info("resolve: people merged", { ...result });
  return result;
}
