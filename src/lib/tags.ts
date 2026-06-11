import type { Pool } from "pg";
import { getPool, type Db } from "./db";
import { logger } from "./logger";
import { reattribute, ResolveError, type Touched } from "./resolve";
import { fxExpr, recomputeRollups } from "./rollup";
import { effectiveTagsSql, factTagFilterSql } from "./tag-sql";

/**
 * Tags (spec 7b). Key names become tags on sync - the name says what the key
 * is for, by convention. Tags carry two pieces of configuration, both in
 * tag_settings (no row = defaults):
 *
 * - counts_personal: whether the tag's spend counts toward personal usage
 *   (off for batch jobs, cron keys, experiments). Attribution is untouched -
 *   the dollar stays the person's - the flag flows into rollup_daily so
 *   personal-usage views can exclude it.
 * - product_id: the tag points at a product. Every key carrying the tag is
 *   routed there (identities.product_id, the single product-routing point),
 *   marked not-a-person, and its FULL history follows - burn lands on the
 *   product, never a person (the agent convention: a key tagged "devin"
 *   burns on the Devin product, not on whoever minted it). A key routes to
 *   at most one product: a key whose tags point at two products is a
 *   conflict, surfaced in the Resolve queue and left unrouted - never
 *   guessed.
 *
 * A key rename re-tags its history retroactively for free: tags live on the
 * identity and every query here joins facts to their identity.
 */

export interface TagSummary {
  tag: string;
  countsPersonal: boolean;
  productId: string | null;
  productName: string | null;
  identityCount: number;
  vendors: string[];
  factCount: number;
  amountUsdCents: number;
}

/** Every tag in use, with its settings and the spend behind it. */
export async function listTags(db: Db = getPool()): Promise<TagSummary[]> {
  const { rows } = await db.query(
    `WITH tags AS (
       SELECT DISTINCT t.tag
       FROM identities i, LATERAL unnest(${effectiveTagsSql("i")}) AS t(tag)
     )
     SELECT tg.tag,
            COALESCE(ts.counts_personal, true) AS "countsPersonal",
            ts.product_id AS "productId",
            p.name AS "productName",
            ids.identity_count AS "identityCount",
            ids.vendors,
            spend.fact_count AS "factCount",
            spend.amount_usd_cents AS "amountUsdCents"
     FROM tags tg
     LEFT JOIN tag_settings ts ON ts.tag = tg.tag
     LEFT JOIN products p ON p.id = ts.product_id
     CROSS JOIN LATERAL (
       SELECT count(*)::int AS identity_count,
              array_agg(DISTINCT i.vendor) AS vendors
       FROM identities i WHERE tg.tag = ANY ${effectiveTagsSql("i")}
     ) ids
     CROSS JOIN LATERAL (
       SELECT count(*)::int AS fact_count,
              COALESCE(ROUND(SUM(
                f.amount_cents * ${fxExpr("f.currency", "f.day")}
              )), 0)::bigint AS amount_usd_cents
       FROM spend_facts f WHERE ${factTagFilterSql("f", "tg.tag")}
     ) spend
     ORDER BY tg.tag`,
  );
  return rows.map((row) => ({ ...row, amountUsdCents: Number(row.amountUsdCents) }));
}

export interface TagIdentity {
  id: string;
  vendor: string;
  externalId: string;
  kind: string;
  displayName: string | null;
  tags: string[];
  manualTags: string[];
  notPerson: boolean;
  personEmail: string | null;
  productName: string | null;
}

export interface TagFact {
  day: string;
  vendor: string;
  model: string | null;
  tokens: number;
  amountCents: number;
  currency: string;
  costBasis: string;
  sourceRef: string;
  identityExternalId: string;
  personEmail: string | null;
  productName: string | null;
}

export interface TagDetail {
  tag: string;
  countsPersonal: boolean;
  productId: string | null;
  productName: string | null;
  identities: TagIdentity[];
  /** The drill-down: the vendor rows behind every number shown for the tag. */
  facts: TagFact[];
}

export async function tagDetail(tag: string, db: Db = getPool()): Promise<TagDetail> {
  const { rows: identities } = await db.query(
    `SELECT i.id, i.vendor, i.external_id AS "externalId", i.kind,
            i.display_name AS "displayName", i.tags, i.manual_tags AS "manualTags",
            i.not_person AS "notPerson",
            pe.email AS "personEmail", pr.name AS "productName"
     FROM identities i
     LEFT JOIN people pe ON pe.id = i.person_id
     LEFT JOIN products pr ON pr.id = i.product_id
     WHERE $1 = ANY ${effectiveTagsSql("i")}
     ORDER BY i.vendor, i.kind, i.external_id`,
    [tag],
  );
  if (identities.length === 0) throw new ResolveError("no key carries that tag", 404);

  const { rows: settings } = await db.query(
    `SELECT ts.counts_personal AS "countsPersonal",
            ts.product_id AS "productId", p.name AS "productName"
     FROM tag_settings ts
     LEFT JOIN products p ON p.id = ts.product_id
     WHERE ts.tag = $1`,
    [tag],
  );

  const { rows: facts } = await db.query(
    `SELECT f.day::text AS day, f.vendor, f.model, f.tokens::int AS tokens,
            f.amount_cents::int AS "amountCents", f.currency,
            f.cost_basis AS "costBasis", f.source_ref AS "sourceRef",
            i.external_id AS "identityExternalId",
            pe.email AS "personEmail", pr.name AS "productName"
     FROM spend_facts f
     JOIN identities i ON i.id = f.identity_id
     LEFT JOIN people pe ON pe.id = f.person_id
     LEFT JOIN products pr ON pr.id = f.product_id
     WHERE ${factTagFilterSql("f", "$1")}
     ORDER BY f.day DESC, f.source_ref`,
    [tag],
  );

  return {
    tag,
    countsPersonal: settings.length > 0 ? settings[0].countsPersonal : true,
    productId: settings.length > 0 ? settings[0].productId : null,
    productName: settings.length > 0 ? settings[0].productName : null,
    identities: identities as TagIdentity[],
    facts: facts as TagFact[],
  };
}

export interface RoutedIdentity {
  id: string;
  productId: string;
}

/**
 * Apply tag->product routing to the scoped identities: when an identity's
 * effective tags point at exactly ONE product and the identity is not
 * already routed there, route it - product set, person cleared, marked
 * not-a-person (auto-match never re-fills an agent key). Identities whose
 * tags point at two products are left untouched - that is the Resolve-queue
 * conflict. Identities whose tags point at no product are also left
 * untouched: routing is sticky, exactly like a Resolve "not a person"
 * product route, so un-pointing a tag never silently un-routes history.
 *
 * A no-op for already-routed identities, which is what lets an explicit
 * human confirm (person + product, spec 7b) survive later syncs.
 */
export async function applyTagRouting(
  db: Db,
  scope: { identityIds?: string[]; tag?: string },
): Promise<RoutedIdentity[]> {
  if (scope.identityIds === undefined && scope.tag === undefined) {
    throw new Error("applyTagRouting needs a scope: identityIds or tag");
  }
  if (scope.identityIds !== undefined && scope.identityIds.length === 0) return [];
  const { rows } = await db.query(
    `WITH scoped AS (
       SELECT i.id,
              (SELECT array_agg(DISTINCT ts.product_id)
               FROM unnest(${effectiveTagsSql("i")}) AS t(tag)
               JOIN tag_settings ts
                 ON ts.tag = t.tag AND ts.product_id IS NOT NULL) AS candidates
       FROM identities i
       WHERE ($1::uuid[] IS NULL OR i.id = ANY ($1))
         AND ($2::text IS NULL OR $2 = ANY ${effectiveTagsSql("i")})
     )
     UPDATE identities i
     SET product_id = s.candidates[1], person_id = NULL, not_person = true,
         updated_at = now()
     FROM scoped s
     WHERE i.id = s.id
       AND cardinality(s.candidates) = 1
       AND i.product_id IS DISTINCT FROM s.candidates[1]
     RETURNING i.id, i.product_id AS "productId"`,
    [scope.identityIds ?? null, scope.tag ?? null],
  );
  return rows as RoutedIdentity[];
}

export interface TagConflict {
  identityId: string;
  vendor: string;
  externalId: string;
  kind: string;
  /** The product-pointing tags fighting over this key, ordered by tag. */
  candidates: { tag: string; productId: string; productName: string }[];
}

/**
 * Keys whose tags point at two (or more) products - a key routes to at most
 * one product (spec 7b), so these sit unrouted until a human un-points one
 * of the tags or renames the key.
 */
export async function tagConflicts(db: Db = getPool()): Promise<TagConflict[]> {
  const { rows } = await db.query(
    `WITH routed AS (
       SELECT i.id, ts.tag, ts.product_id, p.name AS product_name
       FROM identities i
       JOIN LATERAL unnest(${effectiveTagsSql("i")}) AS t(tag) ON true
       JOIN tag_settings ts ON ts.tag = t.tag AND ts.product_id IS NOT NULL
       JOIN products p ON p.id = ts.product_id
       GROUP BY i.id, ts.tag, ts.product_id, p.name
     )
     SELECT r.id AS "identityId", i.vendor, i.external_id AS "externalId",
            i.kind, r.tag, r.product_id AS "productId",
            r.product_name AS "productName"
     FROM routed r
     JOIN identities i ON i.id = r.id
     WHERE r.id IN (
       SELECT id FROM routed GROUP BY id HAVING count(DISTINCT product_id) > 1
     )
     ORDER BY i.vendor, i.kind, i.external_id, r.tag`,
  );
  const byIdentity = new Map<string, TagConflict>();
  for (const row of rows) {
    const entry: TagConflict = byIdentity.get(row.identityId) ?? {
      identityId: row.identityId,
      vendor: row.vendor,
      externalId: row.externalId,
      kind: row.kind,
      candidates: [],
    };
    entry.candidates.push({
      tag: row.tag,
      productId: row.productId,
      productName: row.productName,
    });
    byIdentity.set(row.identityId, entry);
  }
  return [...byIdentity.values()];
}

export interface TagUpdate {
  /** Count the tag's spend toward personal usage, or not. */
  countsPersonal?: boolean;
  /** Point the tag at a product (uuid) or un-point it (null). */
  productId?: string | null;
}

export interface TagUpdateResult {
  tag: string;
  countsPersonal: boolean;
  productId: string | null;
  /** Identities routed (or re-routed) to a product by this change. */
  routedIdentities: number;
  /** Keys carrying this tag left unrouted because two products claim them. */
  conflictIdentities: number;
  facts: number;
  metrics: number;
  outcomes: number;
  rollups: { from: string | null; to: string | null };
}

/**
 * Change a tag's settings. Pointing the tag at a product routes every key
 * carrying it and re-attributes their FULL history (retroactive, like every
 * mapping change, spec 4); the counts-personal toggle re-flags history just
 * as retroactively. Either way the daily rollups are recomputed for exactly
 * the day span the tag's spend covers, so charts agree immediately.
 */
export async function updateTag(
  tag: string,
  update: TagUpdate,
  pool: Pool = getPool(),
): Promise<TagUpdateResult> {
  if (update.countsPersonal === undefined && update.productId === undefined) {
    throw new ResolveError("nothing to change: pass countsPersonal and/or productId", 400);
  }

  const client = await pool.connect();
  let countsPersonal: boolean;
  let productId: string | null;
  let routed: RoutedIdentity[] = [];
  let conflictIdentities: number;
  let span: { from: string | null; to: string | null };
  const touched = { facts: 0, metrics: 0, outcomes: 0 };
  try {
    await client.query("BEGIN");
    const { rows: carried } = await client.query(
      `SELECT 1 FROM identities i WHERE $1 = ANY ${effectiveTagsSql("i")} LIMIT 1`,
      [tag],
    );
    if (carried.length === 0) throw new ResolveError("no key carries that tag", 404);
    if (typeof update.productId === "string") {
      const { rows } = await client.query(
        "SELECT 1 FROM products WHERE id = $1 AND archived_at IS NULL",
        [update.productId],
      );
      if (rows.length === 0) throw new ResolveError("product not found", 404);
    }

    const { rows: setting } = await client.query(
      `INSERT INTO tag_settings (tag, counts_personal, product_id)
       VALUES ($1, COALESCE($2, true), $3)
       ON CONFLICT (tag) DO UPDATE SET
         counts_personal = COALESCE($2, tag_settings.counts_personal),
         product_id = CASE WHEN $4 THEN $3::uuid ELSE tag_settings.product_id END,
         updated_at = now()
       RETURNING counts_personal AS "countsPersonal", product_id AS "productId"`,
      [
        tag,
        update.countsPersonal ?? null,
        update.productId ?? null,
        update.productId !== undefined,
      ],
    );
    countsPersonal = setting[0].countsPersonal as boolean;
    productId = setting[0].productId as string | null;

    // The day span the tag's spend and outcomes cover - the rollup
    // recompute range. Routing only ever touches identities carrying the
    // tag, so their history is inside this span by construction.
    const { rows: spanRows } = await client.query(
      `SELECT min(d)::text AS from, max(d)::text AS to FROM (
         SELECT f.day AS d FROM spend_facts f WHERE ${factTagFilterSql("f", "$1")}
         UNION ALL
         SELECT (o.ts AT TIME ZONE 'UTC')::date FROM outcomes o
         JOIN identities oi ON oi.id = o.identity_id
         WHERE $1 = ANY ${effectiveTagsSql("oi")}
       ) days`,
      [tag],
    );
    span = spanRows[0];

    if (update.productId !== undefined) {
      routed = await applyTagRouting(client, { tag });
      for (const r of routed) {
        const t: Touched = await reattribute(client, r.id, null, r.productId);
        touched.facts += t.facts;
        touched.metrics += t.metrics;
        touched.outcomes += t.outcomes;
      }
    }

    const { rows: conflicts } = await client.query(
      `SELECT count(*)::int AS n FROM (
         SELECT i.id
         FROM identities i
         JOIN LATERAL unnest(${effectiveTagsSql("i")}) AS t(tag) ON true
         JOIN tag_settings ts ON ts.tag = t.tag AND ts.product_id IS NOT NULL
         WHERE $1 = ANY ${effectiveTagsSql("i")}
         GROUP BY i.id
         HAVING count(DISTINCT ts.product_id) > 1
       ) c`,
      [tag],
    );
    conflictIdentities = conflicts[0].n as number;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  let rollups: TagUpdateResult["rollups"] = { from: null, to: null };
  if (span.from !== null && span.to !== null) {
    const { from, to } = await recomputeRollups({ from: span.from, to: span.to }, pool);
    rollups = { from, to };
  }

  const result: TagUpdateResult = {
    tag,
    countsPersonal,
    productId,
    routedIdentities: routed.length,
    conflictIdentities,
    facts: touched.facts,
    metrics: touched.metrics,
    outcomes: touched.outcomes,
    rollups,
  };
  logger.info("tag updated", { ...result });
  return result;
}
