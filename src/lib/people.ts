import { getPool, type Db } from "./db";
import {
  assertDay,
  displayLateral,
  type TrendPoint,
} from "./overview";
import { ResolveError } from "./resolve";
import { fxExpr } from "./rollup";
import { getSetting } from "./settings";
import { effectiveTagsSql } from "./tag-sql";

/**
 * People readers (spec 10 page 2): per person spend by vendor, outcomes,
 * $/outcome and trend; one person's daily breakdown, keys/seats and
 * products; one key's tags, owner, product, models and last-used.
 *
 * Same contract as the Overview readers: chart numbers come from the daily
 * rollups converted to the display currency per day at read time, and every
 * one of them equals listFacts/listOutcomes under the same filter - the
 * drill the UI links it to. Per-key numbers are the one exception that
 * reads spend_facts directly: rollups carry no identity grain, and a key's
 * number IS its drill (both read the same raw rows).
 *
 * Archived people leave current views - the roster below skips them - but
 * history stays intact (spec 4): their facts keep their name in every
 * drill-down and personDetail still renders for a direct link.
 */

/** Facts a person view counts: a person's rows plus the Unassigned bucket
 * (person NULL, product NULL). Person-less product spend belongs to the
 * Products view - agents are products, not people (spec 7b). */
const PEOPLE_VIEW_SQL = "(r.person_id IS NOT NULL OR r.product_id IS NULL)";

/** Live outcomes only - reverted ones roll up under "<kind>:reverted" and
 * never count toward $/outcome (spec 5). */
const LIVE_KIND_SQL = "kind NOT LIKE '%:reverted'";

export interface PersonVendorSpend {
  vendor: string;
  cents: number;
  factCount: number;
}

export interface PersonListRow {
  /** null = the Unassigned bucket. */
  personId: string | null;
  name: string | null;
  email: string | null;
  status: string | null;
  totalCents: number;
  factCount: number;
  byVendor: PersonVendorSpend[];
  /** Live outcomes attributed to the person in range. */
  outcomeCount: number;
  /** totalCents / outcomeCount; null when there are no outcomes. */
  unitCostCents: number | null;
  /** Per-day cents over the range's days, zero-filled (sparkline). */
  trend: number[];
}

export interface PeopleListData {
  displayCurrency: string;
  from: string;
  to: string;
  /** The trend axis - every UTC day in range, ascending. */
  days: string[];
  people: PersonListRow[];
}

function rangeDays(from: string, to: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export async function listPeople(
  range: { from: string; to: string },
  db: Db = getPool(),
): Promise<PeopleListData> {
  assertDay("from", range.from);
  assertDay("to", range.to);
  if (range.from > range.to) {
    throw new ResolveError(`from ${range.from} is after to ${range.to}`, 400);
  }
  const displayCurrency = await getSetting("display_currency", db);
  const params = [displayCurrency, range.from, range.to];

  // The roster: archived people leave current views (spec 4); merged-away
  // rows live on through their survivor.
  const { rows: roster } = await db.query(
    `SELECT id, email, name, status FROM people
     WHERE merged_into IS NULL AND status <> 'archived'
     ORDER BY lower(email)`,
  );

  // Spend per (person, vendor) from the rollups - including the Unassigned
  // bucket (person NULL, product NULL) and excluding spend of people hidden
  // from this view (archived/merged), whose history stays in the drills.
  const visibleSql = `${PEOPLE_VIEW_SQL}
       AND (p.id IS NULL OR (p.status <> 'archived' AND p.merged_into IS NULL))`;
  const { rows: vendorRows } = await db.query(
    `SELECT r.person_id AS "personId", r.vendor,
            ROUND(SUM(d.cents))::bigint AS cents,
            SUM(r.fact_count)::int AS facts,
            COALESCE(BOOL_OR(d.cents IS NULL), false) AS fx_missing
     FROM rollup_daily r
     LEFT JOIN people p ON p.id = r.person_id
     ${displayLateral("r")}
     WHERE r.day BETWEEN $2::date AND $3::date AND ${visibleSql}
     GROUP BY r.person_id, r.vendor
     ORDER BY 3 DESC, r.vendor`,
    params,
  );
  if (vendorRows.some((row) => row.fx_missing)) {
    throw new ResolveError(
      `no FX rate for the display currency ${displayCurrency} - sync FX rates first`,
      409,
    );
  }

  const { rows: trendRows } = await db.query(
    `SELECT r.person_id AS "personId", r.day::text AS day,
            ROUND(SUM(d.cents))::bigint AS cents
     FROM rollup_daily r
     LEFT JOIN people p ON p.id = r.person_id
     ${displayLateral("r")}
     WHERE r.day BETWEEN $2::date AND $3::date AND ${visibleSql}
     GROUP BY r.person_id, r.day`,
    params,
  );

  const { rows: outcomeRows } = await db.query(
    `SELECT person_id AS "personId", SUM(outcome_count)::int AS outcomes
     FROM rollup_outcomes_daily
     WHERE day BETWEEN $1::date AND $2::date
       AND person_id IS NOT NULL AND ${LIVE_KIND_SQL}
     GROUP BY person_id`,
    [range.from, range.to],
  );

  const days = rangeDays(range.from, range.to);
  const dayIndex = new Map(days.map((day, i) => [day, i]));
  const byPerson = new Map<string | null, PersonListRow>();
  const rowFor = (
    personId: string | null,
    seed: { name: string | null; email: string | null; status: string | null },
  ): PersonListRow => {
    let row = byPerson.get(personId);
    if (!row) {
      row = {
        personId,
        ...seed,
        totalCents: 0,
        factCount: 0,
        byVendor: [],
        outcomeCount: 0,
        unitCostCents: null,
        trend: days.map(() => 0),
      };
      byPerson.set(personId, row);
    }
    return row;
  };

  for (const p of roster) {
    rowFor(p.id, { name: p.name, email: p.email, status: p.status });
  }
  const unassignedSeed = { name: null, email: null, status: null };
  for (const v of vendorRows) {
    const row = rowFor(v.personId, unassignedSeed);
    const cents = Number(v.cents);
    row.byVendor.push({ vendor: v.vendor, cents, factCount: Number(v.facts) });
    row.totalCents += cents;
    row.factCount += Number(v.facts);
  }
  for (const t of trendRows) {
    const index = dayIndex.get(t.day);
    if (index !== undefined) {
      rowFor(t.personId, unassignedSeed).trend[index] += Number(t.cents);
    }
  }
  for (const o of outcomeRows) {
    const row = byPerson.get(o.personId);
    if (!row) continue; // outcomes of archived people stay out of this view
    row.outcomeCount = Number(o.outcomes);
    row.unitCostCents =
      row.outcomeCount > 0 ? Math.round(row.totalCents / row.outcomeCount) : null;
  }

  const people = [...byPerson.values()].sort(
    (a, b) =>
      b.totalCents - a.totalCents ||
      (a.email ?? "￿").localeCompare(b.email ?? "￿"),
  );
  return { displayCurrency, from: range.from, to: range.to, days, people };
}

// ---- one person: daily breakdown, keys and seats, products ----

export interface PersonDailyRow {
  day: string;
  vendor: string;
  cents: number;
  factCount: number;
  tokens: number;
}

export interface PersonKeyRow {
  id: string;
  vendor: string;
  externalId: string;
  kind: string;
  displayName: string | null;
  tags: string[];
  /** Spend this key produced in range (from its raw facts - rollups carry
   * no key grain; equals the /drill?key= total by construction). */
  cents: number;
  factCount: number;
  /** All-time last fact day - null = never used. */
  lastUsedDay: string | null;
}

export interface PersonProductRow {
  productId: string;
  name: string;
  archived: boolean;
  cents: number;
  factCount: number;
  /** Live outcomes this person earned for the product in range. */
  outcomeCount: number;
}

export interface PersonOutcomeKind {
  kind: string;
  count: number;
}

export interface PersonDetail {
  displayCurrency: string;
  from: string;
  to: string;
  person: {
    id: string;
    email: string;
    name: string | null;
    status: string;
    source: string;
    monthlyLimitUsdCents: number | null;
  };
  totals: {
    cents: number;
    factCount: number;
    outcomeCount: number;
    revertedCount: number;
    /** cents / outcomeCount; null when there are no outcomes. */
    unitCostCents: number | null;
  };
  byVendor: PersonVendorSpend[];
  trend: TrendPoint[];
  daily: PersonDailyRow[];
  keys: PersonKeyRow[];
  products: PersonProductRow[];
  outcomesByKind: PersonOutcomeKind[];
}

export async function personDetail(
  id: string,
  range: { from: string; to: string },
  db: Db = getPool(),
): Promise<PersonDetail> {
  assertDay("from", range.from);
  assertDay("to", range.to);
  if (range.from > range.to) {
    throw new ResolveError(`from ${range.from} is after to ${range.to}`, 400);
  }

  // Follow merges to the survivor - history follows the merged person
  // (spec 5), so a stale link to the merged-away row lands on the human.
  let personId = id;
  let person: PersonDetail["person"] | null = null;
  for (let hop = 0; hop < 10 && person === null; hop += 1) {
    const { rows } = await db.query(
      `SELECT id, email, name, status, source, merged_into AS "mergedInto",
              monthly_limit_usd_cents::bigint AS "limitCents"
       FROM people WHERE id = $1`,
      [personId],
    );
    if (rows.length === 0) throw new ResolveError("person not found", 404);
    if (rows[0].mergedInto !== null) {
      personId = rows[0].mergedInto;
      continue;
    }
    person = {
      id: rows[0].id,
      email: rows[0].email,
      name: rows[0].name,
      status: rows[0].status,
      source: rows[0].source,
      monthlyLimitUsdCents:
        rows[0].limitCents === null ? null : Number(rows[0].limitCents),
    };
  }
  if (person === null) throw new ResolveError("person not found", 404);

  const displayCurrency = await getSetting("display_currency", db);
  const params = [displayCurrency, range.from, range.to, person.id];

  // Daily breakdown per vendor - the rollups at full grain for this person.
  const { rows: dailyRows } = await db.query(
    `SELECT r.day::text AS day, r.vendor,
            ROUND(SUM(d.cents))::bigint AS cents,
            SUM(r.fact_count)::int AS facts,
            SUM(r.tokens)::bigint AS tokens,
            COALESCE(BOOL_OR(d.cents IS NULL), false) AS fx_missing
     FROM rollup_daily r
     ${displayLateral("r")}
     WHERE r.day BETWEEN $2::date AND $3::date AND r.person_id = $4
     GROUP BY r.day, r.vendor
     ORDER BY r.day DESC, r.vendor`,
    params,
  );
  if (dailyRows.some((row) => row.fx_missing)) {
    throw new ResolveError(
      `no FX rate for the display currency ${displayCurrency} - sync FX rates first`,
      409,
    );
  }
  const daily: PersonDailyRow[] = dailyRows.map((row) => ({
    day: row.day,
    vendor: row.vendor,
    cents: Number(row.cents),
    factCount: Number(row.facts),
    tokens: Number(row.tokens),
  }));

  // By-vendor and the zero-filled trend, derived from the same daily rows
  // so the three views can never disagree.
  const byVendorMap = new Map<string, PersonVendorSpend>();
  const trendMap = new Map<string, number>();
  let cents = 0;
  let factCount = 0;
  for (const row of daily) {
    cents += row.cents;
    factCount += row.factCount;
    const vendor = byVendorMap.get(row.vendor) ?? {
      vendor: row.vendor,
      cents: 0,
      factCount: 0,
    };
    vendor.cents += row.cents;
    vendor.factCount += row.factCount;
    byVendorMap.set(row.vendor, vendor);
    trendMap.set(row.day, (trendMap.get(row.day) ?? 0) + row.cents);
  }
  const byVendor = [...byVendorMap.values()].sort(
    (a, b) => b.cents - a.cents || a.vendor.localeCompare(b.vendor),
  );
  const trend: TrendPoint[] = rangeDays(range.from, range.to).map((day) => ({
    day,
    cents: trendMap.get(day) ?? 0,
  }));

  const { rows: outcomeRows } = await db.query(
    `SELECT CASE WHEN ${LIVE_KIND_SQL} THEN kind
            ELSE left(kind, -length(':reverted')) END AS kind,
            (${LIVE_KIND_SQL}) AS live,
            SUM(outcome_count)::int AS outcomes
     FROM rollup_outcomes_daily
     WHERE day BETWEEN $1::date AND $2::date AND person_id = $3
     GROUP BY 1, 2 ORDER BY 3 DESC, 1`,
    [range.from, range.to, person.id],
  );
  const outcomesByKind: PersonOutcomeKind[] = outcomeRows
    .filter((row) => row.live)
    .map((row) => ({ kind: row.kind, count: Number(row.outcomes) }));
  const outcomeCount = outcomesByKind.reduce((sum, k) => sum + k.count, 0);
  const revertedCount = outcomeRows
    .filter((row) => !row.live)
    .reduce((sum, row) => sum + Number(row.outcomes), 0);

  // Keys and seats: every vendor identity mapped to this person, with the
  // spend it produced in range and its all-time last use. Raw facts - the
  // rollups carry no key grain, so the number IS its own drill.
  const factDisplaySql = `f.amount_cents::numeric * ${fxExpr("f.currency", "f.day")}
    / ${fxExpr("$1::text", "f.day")}`;
  const { rows: keyRows } = await db.query(
    `SELECT i.id, i.vendor, i.external_id AS "externalId", i.kind,
            i.display_name AS "displayName",
            ${effectiveTagsSql("i")} AS tags,
            COALESCE(ROUND(s.cents), 0)::bigint AS cents,
            COALESCE(s.facts, 0)::int AS facts,
            u.last_day::text AS "lastUsedDay",
            COALESCE(s.fx_missing, false) AS fx_missing
     FROM identities i
     LEFT JOIN LATERAL (
       SELECT SUM(${factDisplaySql}) AS cents, COUNT(*)::int AS facts,
              BOOL_OR((${factDisplaySql}) IS NULL) AS fx_missing
       FROM spend_facts f
       WHERE f.identity_id = i.id AND f.day BETWEEN $2::date AND $3::date
     ) s ON true
     LEFT JOIN LATERAL (
       SELECT MAX(f.day) AS last_day FROM spend_facts f WHERE f.identity_id = i.id
     ) u ON true
     WHERE i.person_id = $4
     ORDER BY i.vendor, i.kind, i.external_id`,
    params,
  );
  if (keyRows.some((row) => row.fx_missing)) {
    throw new ResolveError(
      `no FX rate for the display currency ${displayCurrency} - sync FX rates first`,
      409,
    );
  }

  // Products this person's attributed spend or outcomes touch (a fact can
  // carry a person AND a product, spec 4 - the SDK's employee tag).
  const { rows: productRows } = await db.query(
    `SELECT pr.id AS "productId", pr.name,
            (pr.archived_at IS NOT NULL) AS archived,
            COALESCE(ROUND(SUM(d.cents)), 0)::bigint AS cents,
            COALESCE(SUM(r.fact_count), 0)::int AS facts,
            COALESCE(o.live, 0)::int AS outcomes
     FROM products pr
     LEFT JOIN rollup_daily r
       ON r.product_id = pr.id AND r.person_id = $4
      AND r.day BETWEEN $2::date AND $3::date
     LEFT JOIN LATERAL (
       SELECT r.amount_usd_cents::numeric / ${fxExpr("$1::text", "r.day")} AS cents
     ) d ON true
     LEFT JOIN LATERAL (
       SELECT SUM(ro.outcome_count)::int AS live
       FROM rollup_outcomes_daily ro
       WHERE ro.product_id = pr.id AND ro.person_id = $4
         AND ro.day BETWEEN $2::date AND $3::date AND ro.${LIVE_KIND_SQL}
     ) o ON true
     GROUP BY pr.id, pr.name, pr.archived_at, o.live
     HAVING COUNT(r.day) > 0 OR COALESCE(o.live, 0) > 0
     ORDER BY 4 DESC, pr.name`,
    params,
  );

  return {
    displayCurrency,
    from: range.from,
    to: range.to,
    person,
    totals: {
      cents,
      factCount,
      outcomeCount,
      revertedCount,
      unitCostCents: outcomeCount > 0 ? Math.round(cents / outcomeCount) : null,
    },
    byVendor,
    trend,
    daily,
    keys: keyRows.map((row) => ({
      id: row.id,
      vendor: row.vendor,
      externalId: row.externalId,
      kind: row.kind,
      displayName: row.displayName,
      tags: [...new Set(row.tags as string[])],
      cents: Number(row.cents),
      factCount: Number(row.facts),
      lastUsedDay: row.lastUsedDay,
    })),
    products: productRows.map((row) => ({
      productId: row.productId,
      name: row.name,
      archived: row.archived,
      cents: Number(row.cents),
      factCount: Number(row.facts),
      outcomeCount: Number(row.outcomes),
    })),
    outcomesByKind,
  };
}

// ---- one key: tags, owner, product, models, last used ----

export interface KeyTag {
  tag: string;
  /** vendor = mirrors the key's name (re-tags on rename); manual = Resolve. */
  source: "vendor" | "manual";
  /** Where the tag routes spend, when it points at a product (spec 7b). */
  productId: string | null;
  productName: string | null;
  /** false = the tag's spend is excluded from personal usage. */
  countsPersonal: boolean;
}

export interface KeyModelRow {
  /** null = the vendor reported no model (seat fees, flat charges). */
  model: string | null;
  cents: number;
  factCount: number;
  tokens: number;
  lastDay: string;
}

export interface KeyDetail {
  displayCurrency: string;
  key: {
    id: string;
    vendor: string;
    externalId: string;
    kind: string;
    displayName: string | null;
    vendorEmail: string | null;
    notPerson: boolean;
    createdAt: string;
  };
  owner: { id: string; name: string | null; email: string; status: string } | null;
  /** The key's product routing (identities.product_id, spec 7b). */
  product: { id: string; name: string; archived: boolean } | null;
  tags: KeyTag[];
  /** All-time, from the key's raw facts - the same rows /drill?key= shows. */
  totalCents: number;
  factCount: number;
  totalTokens: number;
  firstUsedDay: string | null;
  lastUsedDay: string | null;
  models: KeyModelRow[];
}

export async function keyDetail(id: string, db: Db = getPool()): Promise<KeyDetail> {
  const { rows: keys } = await db.query(
    `SELECT i.id, i.vendor, i.external_id AS "externalId", i.kind,
            i.display_name AS "displayName", i.email AS "vendorEmail",
            i.not_person AS "notPerson", i.created_at AS "createdAt",
            i.tags, i.manual_tags AS "manualTags",
            pe.id AS "ownerId", pe.name AS "ownerName",
            pe.email AS "ownerEmail", pe.status AS "ownerStatus",
            pr.id AS "productId", pr.name AS "productName",
            (pr.archived_at IS NOT NULL) AS "productArchived"
     FROM identities i
     LEFT JOIN people pe ON pe.id = i.person_id
     LEFT JOIN products pr ON pr.id = i.product_id
     WHERE i.id = $1`,
    [id],
  );
  if (keys.length === 0) throw new ResolveError("key not found", 404);
  const k = keys[0];

  // Tag settings answer "where is it plugged": product routing and the
  // counts-personal toggle (spec 7b). No row = the defaults.
  const vendorTags = k.tags as string[];
  const manualTags = k.manualTags as string[];
  const allTags = [...new Set([...vendorTags, ...manualTags])];
  const { rows: tagRows } = allTags.length
    ? await db.query(
        `SELECT ts.tag, ts.counts_personal AS "countsPersonal",
                ts.product_id AS "productId", p.name AS "productName"
         FROM tag_settings ts
         LEFT JOIN products p ON p.id = ts.product_id
         WHERE ts.tag = ANY ($1)`,
        [allTags],
      )
    : { rows: [] };
  const settings = new Map(tagRows.map((row) => [row.tag, row]));
  const tags: KeyTag[] = allTags.map((tag) => {
    const s = settings.get(tag);
    return {
      tag,
      source: vendorTags.includes(tag) ? "vendor" : "manual",
      productId: s?.productId ?? null,
      productName: s?.productName ?? null,
      countsPersonal: s?.countsPersonal ?? true,
    };
  });

  const displayCurrency = await getSetting("display_currency", db);
  const displaySql = `f.amount_cents::numeric * ${fxExpr("f.currency", "f.day")}
    / ${fxExpr("$2::text", "f.day")}`;
  const { rows: modelRows } = await db.query(
    `SELECT f.model, ROUND(SUM(${displaySql}))::bigint AS cents,
            COUNT(*)::int AS facts, SUM(f.tokens)::bigint AS tokens,
            MAX(f.day)::text AS "lastDay", MIN(f.day)::text AS "firstDay",
            COALESCE(BOOL_OR((${displaySql}) IS NULL), false) AS fx_missing
     FROM spend_facts f
     WHERE f.identity_id = $1
     GROUP BY f.model
     ORDER BY 2 DESC, f.model NULLS LAST`,
    [id, displayCurrency],
  );
  if (modelRows.some((row) => row.fx_missing)) {
    throw new ResolveError(
      "a fact's currency has no FX rate - sync FX rates first",
      409,
    );
  }

  let totalCents = 0;
  let factCount = 0;
  let totalTokens = 0;
  let firstUsedDay: string | null = null;
  let lastUsedDay: string | null = null;
  const models: KeyModelRow[] = modelRows.map((row) => {
    totalCents += Number(row.cents);
    factCount += Number(row.facts);
    totalTokens += Number(row.tokens);
    if (firstUsedDay === null || row.firstDay < firstUsedDay) firstUsedDay = row.firstDay;
    if (lastUsedDay === null || row.lastDay > lastUsedDay) lastUsedDay = row.lastDay;
    return {
      model: row.model,
      cents: Number(row.cents),
      factCount: Number(row.facts),
      tokens: Number(row.tokens),
      lastDay: row.lastDay,
    };
  });

  return {
    displayCurrency,
    key: {
      id: k.id,
      vendor: k.vendor,
      externalId: k.externalId,
      kind: k.kind,
      displayName: k.displayName,
      vendorEmail: k.vendorEmail,
      notPerson: k.notPerson,
      createdAt: new Date(k.createdAt).toISOString(),
    },
    owner: k.ownerId
      ? { id: k.ownerId, name: k.ownerName, email: k.ownerEmail, status: k.ownerStatus }
      : null,
    product: k.productId
      ? { id: k.productId, name: k.productName, archived: k.productArchived }
      : null,
    tags,
    totalCents,
    factCount,
    totalTokens,
    firstUsedDay,
    lastUsedDay,
    models,
  };
}
