import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { hashToken } from "./auth";
import { tryLookupPinnedPrice, PRICE_PIN_FILE, type PinnedProvider } from "./connectors/prices";
import { upsertIdentity, type ResolvedIdentity } from "./connectors/sync";
import { getPool, type Db } from "./db";
import { unknownCurrencies } from "./fx";
import { trueUpAfterSync } from "./invoices";
import { logger } from "./logger";
import { ResolveError } from "./resolve";
import { recomputeRollups } from "./rollup";

/**
 * Ingest API (spec section 6): the server side of the SDK.
 *
 * - Auth: ingest keys minted in Settings, shown once, scoped per product.
 *   Only the sha256 of the token is stored; revoke is the only exit
 *   (nothing hard-deletes - history keeps pointing at the key).
 * - Events carry client-side UUIDs; the server upserts on the UUID, so SDK
 *   retries are safe (spec 6 "fail-open always").
 * - 'call' events (wrap()) become ESTIMATED spend: tokens x the pinned
 *   LiteLLM price table (spec 4), aggregated into one spend fact per
 *   (key, day, vendor, model, identity) bucket so cents round once per
 *   bucket, not once per call. The bucket fact drills to the raw events.
 * - 'outcome' events (track()) become outcomes rows: kind = the tracked
 *   kind, source_ref = the caller's ref (ticket id, coupon id - the real
 *   record every outcome drills to) or 'sdk:<uuid>' when none was given.
 * - employee emails become identities (vendor 'sdk'): auto-matched by
 *   email, queued in Resolve when unmatched, full history re-attributed
 *   on a later match - the same rules as every vendor identity.
 * - No fake numbers: an unpriced model, an unknown currency, a mismatched
 *   product all REJECT that event with the reason verbatim; the rest of
 *   the batch still lands. The SDK logs rejections and drops them.
 */

export const MAX_INGEST_EVENTS = 500;
export const MAX_INGEST_BODY_BYTES = 1_000_000;
/** Requests per key per minute (spec 12: the ingest API is rate-limited). */
export const INGEST_RATE_LIMIT_PER_MIN = 600;

/** Reserved source_ref namespace for SDK-derived rows (like 'invoice:'). */
export const SDK_REF_PREFIX = "sdk:";

const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_DAYS = 400; // past the 13-month raw-fact retention (spec 4)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

// ---------------------------------------------------------------------------
// Ingest keys (spec 6: minted in Settings, shown once, scoped per product)
// ---------------------------------------------------------------------------

export interface IngestKey {
  id: string;
  productId: string;
  productName: string;
  name: string | null;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const KEY_COLUMNS = `
  k.id, k.product_id AS "productId", p.name AS "productName", k.name,
  k.token_prefix AS "tokenPrefix", k.created_at AS "createdAt",
  k.last_used_at AS "lastUsedAt", k.revoked_at AS "revokedAt"
`;

function toKey(row: Record<string, unknown>): IngestKey {
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return {
    ...(row as unknown as IngestKey),
    createdAt: new Date(row.createdAt as string).toISOString(),
    lastUsedAt: iso(row.lastUsedAt),
    revokedAt: iso(row.revokedAt),
  };
}

/**
 * Mint a key for a product. The plaintext token is returned ONCE and never
 * stored - only its sha256 (spec 12: no stored secrets in plaintext).
 */
export async function mintIngestKey(
  productId: string,
  name: string | null,
  db: Db = getPool(),
): Promise<{ key: IngestKey; token: string }> {
  const { rows: products } = await db.query(
    "SELECT name, archived_at FROM products WHERE id = $1",
    [productId],
  );
  if (products.length === 0) throw new ResolveError("product not found", 404);
  if (products[0].archived_at !== null) {
    throw new ResolveError("product is archived", 409);
  }

  const token = `pnl_${randomBytes(24).toString("hex")}`;
  const { rows } = await db.query(
    `INSERT INTO ingest_keys AS k (product_id, name, token_hash, token_prefix)
     VALUES ($1, $2, $3, $4)
     RETURNING k.id, k.product_id AS "productId", $5::text AS "productName",
       k.name, k.token_prefix AS "tokenPrefix", k.created_at AS "createdAt",
       k.last_used_at AS "lastUsedAt", k.revoked_at AS "revokedAt"`,
    [productId, name, hashToken(token), token.slice(0, 12), products[0].name],
  );
  const key = toKey(rows[0]);
  logger.info("ingest key minted", { keyId: key.id, productId });
  return { key, token };
}

export async function listIngestKeys(db: Db = getPool()): Promise<IngestKey[]> {
  const { rows } = await db.query(
    `SELECT ${KEY_COLUMNS}
     FROM ingest_keys k JOIN products p ON p.id = k.product_id
     ORDER BY k.created_at DESC, k.id`,
  );
  return rows.map(toKey);
}

/** Revocation is permanent - a leaked key must die; mint a new one. */
export async function revokeIngestKey(
  id: string,
  db: Db = getPool(),
): Promise<IngestKey> {
  const { rows } = await db.query(
    `UPDATE ingest_keys k SET revoked_at = COALESCE(k.revoked_at, now())
     FROM products p WHERE p.id = k.product_id AND k.id = $1
     RETURNING ${KEY_COLUMNS}`,
    [id],
  );
  if (rows.length === 0) throw new ResolveError("ingest key not found", 404);
  logger.info("ingest key revoked", { keyId: id });
  return toKey(rows[0]);
}

/** The key a Bearer token authenticates, with its product scope. Null =
 * unknown or revoked - the caller answers 401 either way. */
export interface KeyContext {
  keyId: string;
  productId: string;
  productName: string;
  attribution: string;
  outcomeKind: string;
  productArchived: boolean;
}

export async function ingestKeyByToken(
  token: string,
  db: Db = getPool(),
): Promise<KeyContext | null> {
  const { rows } = await db.query(
    `SELECT k.id AS "keyId", k.product_id AS "productId",
            p.name AS "productName", p.attribution,
            p.outcome_kind AS "outcomeKind",
            (p.archived_at IS NOT NULL) AS "productArchived"
     FROM ingest_keys k JOIN products p ON p.id = k.product_id
     WHERE k.token_hash = $1 AND k.revoked_at IS NULL`,
    [hashToken(token)],
  );
  return rows.length > 0 ? (rows[0] as KeyContext) : null;
}

// ---------------------------------------------------------------------------
// Event validation
// ---------------------------------------------------------------------------

export type EventStatus = "accepted" | "duplicate" | "rejected";

export interface EventResult {
  /** Echo of the client UUID; null when the event had no usable id. */
  id: string | null;
  status: EventStatus;
  error?: string;
}

interface NormalizedCall {
  id: string;
  kind: "call";
  ts: string;
  day: string;
  vendor: PinnedProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  employee: string | null;
}

interface NormalizedOutcome {
  id: string;
  kind: "outcome";
  ts: string;
  day: string;
  outcome: string;
  valueCents: number | null;
  currency: string | null;
  ref: string | null;
  employee: string | null;
  tokens: { inputTokens: number; outputTokens: number; calls: string[] } | null;
}

type Normalized = NormalizedCall | NormalizedOutcome;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function tokenCount(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e12
    ? v
    : null;
}

function reject(id: string | null, error: string): { ok: false; result: EventResult } {
  return { ok: false, result: { id, status: "rejected", error } };
}

/** Validate one wire event. Every rejection carries the precise reason -
 * the SDK surfaces it verbatim in the host app's logs. */
function parseEvent(
  raw: unknown,
  key: KeyContext,
  now: Date,
): { ok: true; ev: Normalized } | { ok: false; result: EventResult } {
  if (!isObj(raw)) return reject(null, "event must be an object");
  const id =
    typeof raw.id === "string" && UUID_RE.test(raw.id) ? raw.id.toLowerCase() : null;
  if (!id) return reject(null, "id must be a UUID");

  if (typeof raw.ts !== "string" || !Number.isFinite(Date.parse(raw.ts))) {
    return reject(id, "ts must be an ISO timestamp");
  }
  const ts = new Date(raw.ts);
  if (ts.getTime() > now.getTime() + MAX_FUTURE_MS) {
    return reject(id, `ts ${raw.ts} is in the future`);
  }
  if (ts.getTime() < now.getTime() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000) {
    return reject(id, `ts ${raw.ts} is older than the ${MAX_AGE_DAYS}-day raw-fact retention`);
  }
  const day = ts.toISOString().slice(0, 10);

  let employee: string | null = null;
  if (raw.employee !== undefined && raw.employee !== null) {
    if (
      typeof raw.employee !== "string" ||
      raw.employee.trim().length === 0 ||
      raw.employee.length > 200 ||
      !EMAIL_RE.test(raw.employee.trim())
    ) {
      return reject(id, "employee must be an email address");
    }
    employee = raw.employee.trim().toLowerCase();
  }

  if (raw.product !== undefined && raw.product !== null) {
    const p = typeof raw.product === "string" ? raw.product.trim() : "";
    if (p.toLowerCase() !== key.productName.toLowerCase() && p !== key.productId) {
      return reject(id, `this key is scoped to product "${key.productName}"`);
    }
  }

  if (raw.kind === "call") {
    if (key.attribution !== "sdk") {
      return reject(
        id,
        `product "${key.productName}" gets its spend from ${key.attribution} - ` +
          `wrap() calls only count for attribution "sdk" products (one dollar, one source)`,
      );
    }
    if (raw.vendor !== "openai" && raw.vendor !== "anthropic") {
      return reject(id, 'vendor must be "openai" or "anthropic"');
    }
    const model =
      typeof raw.model === "string" && raw.model.trim().length > 0 && raw.model.length <= 200
        ? raw.model.trim()
        : null;
    if (!model) return reject(id, "model required (1-200 characters)");
    const inputTokens = tokenCount(raw.inputTokens);
    const outputTokens = tokenCount(raw.outputTokens);
    if (inputTokens === null || outputTokens === null) {
      return reject(id, "inputTokens and outputTokens must be non-negative integers");
    }
    if (!tryLookupPinnedPrice(raw.vendor, model)) {
      return reject(
        id,
        `no pinned price for ${raw.vendor} model "${model}" - add it to ${PRICE_PIN_FILE}`,
      );
    }
    return {
      ok: true,
      ev: { id, kind: "call", ts: raw.ts, day, vendor: raw.vendor, model, inputTokens, outputTokens, employee },
    };
  }

  if (raw.kind === "outcome") {
    if (key.outcomeKind !== "sdk_event") {
      return reject(
        id,
        `product "${key.productName}" has outcome kind ${key.outcomeKind} - ` +
          'track() needs a product with outcome kind "sdk_event"',
      );
    }
    const outcome =
      typeof raw.outcome === "string" && raw.outcome.trim().length > 0 && raw.outcome.trim().length <= 80
        ? raw.outcome.trim()
        : null;
    if (!outcome) return reject(id, "outcome kind required (1-80 characters)");
    if (outcome.includes(":")) {
      return reject(id, 'outcome kind must not contain ":" (reserved for revert buckets)');
    }
    if (outcome === "manual") {
      return reject(id, 'outcome kind "manual" is reserved for manual entries');
    }

    let valueCents: number | null = null;
    let currency: string | null = null;
    if (raw.valueCents !== undefined && raw.valueCents !== null) {
      if (
        typeof raw.valueCents !== "number" ||
        !Number.isInteger(raw.valueCents) ||
        raw.valueCents < 0
      ) {
        return reject(id, "valueCents must be a non-negative integer");
      }
      valueCents = raw.valueCents;
      if (typeof raw.currency !== "string" || !CURRENCY_RE.test(raw.currency)) {
        return reject(id, "currency must be a 3-letter code (e.g. USD) when valueCents is set");
      }
      currency = raw.currency;
    } else if (raw.currency !== undefined && raw.currency !== null) {
      return reject(id, "currency needs valueCents");
    }

    let ref: string | null = null;
    if (raw.ref !== undefined && raw.ref !== null) {
      const r = typeof raw.ref === "string" ? raw.ref.trim() : "";
      if (r.length === 0 || r.length > 200) {
        return reject(id, "ref must be 1-200 characters");
      }
      if (r.startsWith(SDK_REF_PREFIX) || r.startsWith("invoice:")) {
        return reject(id, `ref must not start with the reserved "${SDK_REF_PREFIX}" or "invoice:" prefixes`);
      }
      ref = r;
    }

    let tokens: NormalizedOutcome["tokens"] = null;
    if (raw.tokens !== undefined && raw.tokens !== null) {
      const t = raw.tokens;
      const input = isObj(t) ? tokenCount(t.inputTokens) : null;
      const output = isObj(t) ? tokenCount(t.outputTokens) : null;
      const calls =
        isObj(t) && Array.isArray(t.calls) && t.calls.every((c) => typeof c === "string" && UUID_RE.test(c))
          ? (t.calls as string[]).map((c) => c.toLowerCase())
          : null;
      if (input === null || output === null || calls === null || calls.length > 1000) {
        return reject(id, "tokens must carry inputTokens, outputTokens and call UUIDs");
      }
      tokens = { inputTokens: input, outputTokens: output, calls };
    }

    return {
      ok: true,
      ev: { id, kind: "outcome", ts: raw.ts, day, outcome, valueCents, currency, ref, employee, tokens },
    };
  }

  return reject(id, 'kind must be "call" or "outcome"');
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/** USD cents for a call bucket - same math as the connector estimators:
 * exact-decimal USD/MTok from the pinned table, rounded once at the end. */
function bucketCents(vendor: PinnedProvider, model: string, input: number, output: number): number {
  const price = tryLookupPinnedPrice(vendor, model);
  if (!price) {
    // Validated at the door; only reachable if the pin file shrinks mid-flight.
    throw new Error(`no pinned price for ${vendor} model "${model}"`);
  }
  return Math.round(((input * price.inputPerMTok + output * price.outputPerMTok) / 1e6) * 100);
}

/** Sweep facts/outcomes to mirror their identity's current person (a match
 * re-attributes full history, spec 4). Returns the UTC days touched. */
async function sweepIdentityHistory(
  client: PoolClient,
  resolved: ResolvedIdentity,
): Promise<string[]> {
  const facts = await client.query(
    `UPDATE spend_facts SET person_id = $2
     WHERE identity_id = $1 AND person_id IS DISTINCT FROM $2
     RETURNING day::text AS day`,
    [resolved.id, resolved.personId],
  );
  const outcomes = await client.query(
    `UPDATE outcomes SET person_id = $2
     WHERE identity_id = $1 AND person_id IS DISTINCT FROM $2
     RETURNING (ts AT TIME ZONE 'UTC')::date::text AS day`,
    [resolved.id, resolved.personId],
  );
  return [...facts.rows, ...outcomes.rows].map((r) => r.day as string);
}

/** Group UTC days into contiguous spans so rollups recompute in runs, not
 * once per scattered day. */
export function daySpans(days: Iterable<string>): Array<{ from: string; to: string }> {
  const sorted = [...new Set(days)].sort();
  const spans: Array<{ from: string; to: string }> = [];
  for (const day of sorted) {
    const last = spans[spans.length - 1];
    const next = last
      ? new Date(Date.parse(`${last.to}T00:00:00Z`) + 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10)
      : null;
    if (last && day === next) last.to = day;
    else spans.push({ from: day, to: day });
  }
  return spans;
}

export interface IngestOutcome {
  results: EventResult[];
  accepted: number;
  duplicates: number;
  rejected: number;
}

interface IngestOpts {
  pool?: Pool;
  /** Pinned clock for tests. */
  now?: Date;
}

interface CallBucket {
  day: string;
  vendor: PinnedProvider;
  model: string;
  identityId: string | null;
  personId: string | null;
}

export async function ingestEvents(
  key: KeyContext,
  rawEvents: unknown[],
  opts: IngestOpts = {},
): Promise<IngestOutcome> {
  const pool = opts.pool ?? getPool();
  const now = opts.now ?? new Date();
  if (rawEvents.length === 0) {
    return { results: [], accepted: 0, duplicates: 0, rejected: 0 };
  }

  // Validate everything up front; the batch's verdicts come back in order.
  const results: EventResult[] = new Array(rawEvents.length);
  const parsed: Array<{ index: number; ev: Normalized }> = [];
  for (let i = 0; i < rawEvents.length; i++) {
    const v = parseEvent(rawEvents[i], key, now);
    if (v.ok) parsed.push({ index: i, ev: v.ev });
    else results[i] = v.result;
  }

  // No fake numbers: outcome money in a currency with no FX rates can never
  // roll up - reject those events, keep the rest of the batch.
  const currencies = parsed
    .map((p) => (p.ev.kind === "outcome" ? p.ev.currency : null))
    .filter((c): c is string => c !== null);
  const unknown = new Set(await unknownCurrencies(currencies, pool));
  const events: Array<{ index: number; ev: Normalized }> = [];
  for (const p of parsed) {
    if (p.ev.kind === "outcome" && p.ev.currency && unknown.has(p.ev.currency)) {
      results[p.index] = {
        id: p.ev.id,
        status: "rejected",
        error: `no FX rate for ${p.ev.currency} yet - send USD or a currency with known rates`,
      };
    } else {
      events.push(p);
    }
  }

  const rollupDays = new Set<string>();
  const factDays: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Employee emails -> 'sdk' identities, on the shared auto-match +
    // Resolve + full-history machinery. The sweep keeps older SDK rows
    // mirroring the identity's current person (late roster imports).
    const identities = new Map<string, ResolvedIdentity>();
    for (const email of new Set(
      events.map((p) => p.ev.employee).filter((e): e is string => e !== null),
    )) {
      const resolved = await upsertIdentity(client, "sdk", {
        externalId: email,
        kind: "user",
        email,
      });
      identities.set(email, resolved);
      for (const day of await sweepIdentityHistory(client, resolved)) {
        rollupDays.add(day);
      }
    }

    // Upsert on the client UUID: a retry of a lost response is a no-op.
    const buckets = new Map<string, CallBucket>();
    for (const { index, ev } of events) {
      const identity = ev.employee ? (identities.get(ev.employee) ?? null) : null;
      const inserted = await client.query(
        `INSERT INTO ingest_events
           (id, key_id, product_id, kind, ts, day, vendor, model,
            input_tokens, output_tokens, outcome, value_cents, currency,
            ref, employee_email, identity_id, meta)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6::date, $7, $8, $9, $10,
                 $11, $12, $13, $14, $15, $16, $17::jsonb)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
          ev.id,
          key.keyId,
          key.productId,
          ev.kind,
          ev.ts,
          ev.day,
          ev.kind === "call" ? ev.vendor : null,
          ev.kind === "call" ? ev.model : null,
          ev.kind === "call" ? ev.inputTokens : null,
          ev.kind === "call" ? ev.outputTokens : null,
          ev.kind === "outcome" ? ev.outcome : null,
          ev.kind === "outcome" ? ev.valueCents : null,
          ev.kind === "outcome" ? ev.currency : null,
          ev.kind === "outcome" ? ev.ref : null,
          ev.employee,
          identity?.id ?? null,
          JSON.stringify(ev.kind === "outcome" && ev.tokens ? { tokens: ev.tokens } : {}),
        ],
      );
      if (inserted.rows.length === 0) {
        results[index] = { id: ev.id, status: "duplicate" };
        continue;
      }
      results[index] = { id: ev.id, status: "accepted" };
      rollupDays.add(ev.day);

      if (ev.kind === "call") {
        factDays.push(ev.day);
        const bucketKey = `${ev.day}|${ev.vendor}|${ev.model}|${identity?.id ?? ""}`;
        buckets.set(bucketKey, {
          day: ev.day,
          vendor: ev.vendor,
          model: ev.model,
          identityId: identity?.id ?? null,
          personId: identity?.personId ?? null,
        });
      } else {
        // Re-tracking the same (kind, ref) restates the outcome in place -
        // and may move it across days; recompute the old day too.
        const sourceRef = ev.ref ?? `${SDK_REF_PREFIX}${ev.id}`;
        const { rows: old } = await client.query(
          `SELECT (ts AT TIME ZONE 'UTC')::date::text AS day FROM outcomes
           WHERE kind = $1 AND source_ref = $2`,
          [ev.outcome, sourceRef],
        );
        if (old.length > 0) rollupDays.add(old[0].day as string);
        await client.query(
          `INSERT INTO outcomes
             (ts, product_id, person_id, identity_id, kind, count,
              value_cents, currency, source_ref, meta)
           VALUES ($1::timestamptz, $2, $3, $4, $5, 1, $6, $7, $8, $9::jsonb)
           ON CONFLICT (kind, source_ref) DO UPDATE SET
             ts = EXCLUDED.ts,
             product_id = EXCLUDED.product_id,
             person_id = EXCLUDED.person_id,
             identity_id = EXCLUDED.identity_id,
             count = EXCLUDED.count,
             value_cents = EXCLUDED.value_cents,
             currency = EXCLUDED.currency,
             meta = EXCLUDED.meta`,
          [
            ev.ts,
            key.productId,
            identity?.personId ?? null,
            identity?.id ?? null,
            ev.outcome,
            ev.valueCents,
            ev.currency,
            sourceRef,
            JSON.stringify({ sdkEventId: ev.id, ...(ev.tokens ? { tokens: ev.tokens } : {}) }),
          ],
        );
      }
    }

    // Re-derive every touched call bucket from ALL its events: idempotent,
    // and cents round once per bucket, never per call.
    for (const bucket of buckets.values()) {
      const { rows } = await client.query(
        `SELECT SUM(input_tokens)::bigint AS input, SUM(output_tokens)::bigint AS output
         FROM ingest_events
         WHERE key_id = $1 AND kind = 'call' AND day = $2::date
           AND vendor = $3 AND model = $4 AND identity_id IS NOT DISTINCT FROM $5`,
        [key.keyId, bucket.day, bucket.vendor, bucket.model, bucket.identityId],
      );
      const input = Number(rows[0].input);
      const output = Number(rows[0].output);
      const sourceRef =
        `${SDK_REF_PREFIX}${key.keyId}:${bucket.day}:${bucket.identityId ?? "unassigned"}:${bucket.model}`;
      await client.query(
        `INSERT INTO spend_facts
           (day, person_id, product_id, identity_id, vendor, model, tokens,
            amount_cents, currency, cost_basis, source_ref)
         VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, 'USD', 'estimated', $9)
         ON CONFLICT (vendor, source_ref) DO UPDATE SET
           person_id = EXCLUDED.person_id,
           product_id = EXCLUDED.product_id,
           identity_id = EXCLUDED.identity_id,
           tokens = EXCLUDED.tokens,
           amount_cents = EXCLUDED.amount_cents`,
        [
          bucket.day,
          bucket.personId,
          key.productId,
          bucket.identityId,
          bucket.vendor,
          bucket.model,
          input + output,
          bucketCents(bucket.vendor, bucket.model, input, output),
          sourceRef,
        ],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  for (const span of daySpans(rollupDays)) {
    await recomputeRollups(span, pool);
  }

  // New estimated facts change an invoiced month's drift - re-true it, and
  // never let a true-up failure fail the ingest (mirrors the sync engine).
  if (factDays.length > 0) {
    const span = { min: factDays.reduce((a, b) => (a < b ? a : b)),
                   max: factDays.reduce((a, b) => (a > b ? a : b)) };
    for (const vendor of new Set(
      events.flatMap((p) => (p.ev.kind === "call" ? [p.ev.vendor] : [])),
    )) {
      try {
        await trueUpAfterSync(vendor, span, pool);
      } catch (err) {
        logger.error("ingest true-up failed", { vendor, error: err });
      }
    }
  }

  await pool.query("UPDATE ingest_keys SET last_used_at = now() WHERE id = $1", [
    key.keyId,
  ]);

  const outcome: IngestOutcome = {
    results,
    accepted: results.filter((r) => r.status === "accepted").length,
    duplicates: results.filter((r) => r.status === "duplicate").length,
    rejected: results.filter((r) => r.status === "rejected").length,
  };
  logger.info("ingest batch processed", {
    keyId: key.keyId,
    productId: key.productId,
    accepted: outcome.accepted,
    duplicates: outcome.duplicates,
    rejected: outcome.rejected,
  });
  return outcome;
}
