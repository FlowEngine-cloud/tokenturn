import type { Pool, PoolClient } from "pg";
import { getPool, type Db } from "./db";
import { cleanCurrency } from "./products";
import { ResolveError } from "./resolve";
import { recomputeRollups } from "./rollup";

/**
 * Subscription seats (the flat-fee side of the ledger, migration 019).
 *
 * A seat is a person's flat recurring plan with a vendor (Claude Max, a
 * Cursor/Copilot seat): a fixed monthly fee owed whether the seat ran one
 * token or a million. Metered usage already lands on the ledger from the
 * connectors; a flat seat fee is reported by no usage API, so it lives in
 * subscription_seats and materializes into spend_facts here - the same shape
 * the invoice true-up and manual entries use, so People/Overview keep summing
 * to one total and every number drills back to its source.
 *
 * Materialization: one spend_facts row per active month, on the month's first
 * UTC day, billing_mode 'subscription', cost_basis 'estimated' (the monthly
 * invoice trues it up like any other estimate), source_ref 'seat:<id>:<YYYY-MM>'.
 * A seat priced at 0 (a detected seat awaiting its price) materializes nothing
 * but still shows in the registry. Re-pricing or re-dating a seat deletes and
 * rebuilds its rows, then recomputes exactly the days that changed - so a
 * price edit re-values history, same rule as every other mapping (spec 4).
 *
 * Seats bill the CURRENT month too (a flat fee is owed for the month you are
 * in), unlike the invoice import which only trues up months that have closed.
 */

export interface SeatInput {
  vendor: string;
  personId: string;
  tier?: string | null;
  amountCents: number;
  currency: string;
  /** "YYYY-MM" - the first month billed. */
  startedMonth: string;
  /** "YYYY-MM" - the last month billed, or null for an ongoing seat. */
  endedMonth?: string | null;
  identityId?: string | null;
  source?: "manual" | "auto";
  note?: string | null;
}

export interface Seat {
  id: string;
  vendor: string;
  personId: string;
  personName: string | null;
  personEmail: string;
  tier: string | null;
  amountCents: number;
  currency: string;
  startedMonth: string;
  endedMonth: string | null;
  source: "manual" | "auto";
  note: string | null;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const VENDOR_RE = /^[a-z0-9][a-z0-9_.-]*$/;

/** First UTC day of `date`'s month, "YYYY-MM". */
function currentMonth(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** Inclusive list of "YYYY-MM" months from `start` to `end`. */
function monthsBetween(start: string, end: string): string[] {
  const months: string[] = [];
  let [y, m] = start.split("-").map(Number);
  const [ey, em] = end.split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

function assertMonth(name: string, value: string): void {
  if (!MONTH_RE.test(value)) {
    throw new ResolveError(`${name} must be YYYY-MM, got ${JSON.stringify(value)}`, 400);
  }
}

/**
 * Rebuild one seat's materialized facts. Deletes whatever it produced before,
 * inserts one fact per active month (only when priced), and returns every UTC
 * day whose facts changed - the days the caller must recompute.
 */
async function materializeSeat(
  client: PoolClient,
  seat: {
    id: string;
    vendor: string;
    personId: string;
    amountCents: number;
    currency: string;
    startedMonth: string;
    endedMonth: string | null;
  },
  now: Date,
): Promise<string[]> {
  const days = new Set<string>();

  const removed = await client.query(
    "DELETE FROM spend_facts WHERE vendor = $1 AND source_ref LIKE $2 RETURNING day::text AS day",
    [seat.vendor, `seat:${seat.id}:%`],
  );
  for (const row of removed.rows) days.add(row.day as string);

  if (seat.amountCents > 0) {
    const last = seat.endedMonth
      ? seat.endedMonth < currentMonth(now)
        ? seat.endedMonth
        : currentMonth(now)
      : currentMonth(now);
    // A seat whose start is still in the future bills nothing yet.
    if (seat.startedMonth <= last) {
      for (const month of monthsBetween(seat.startedMonth, last)) {
        const day = `${month}-01`;
        await client.query(
          `INSERT INTO spend_facts
             (day, person_id, product_id, vendor, model, tokens, amount_cents,
              currency, cost_basis, billing_mode, source_ref)
           VALUES ($1::date, $2, NULL, $3, NULL, 0, $4, $5, 'estimated', 'subscription', $6)`,
          [day, seat.personId, seat.vendor, seat.amountCents, seat.currency, `seat:${seat.id}:${month}`],
        );
        days.add(day);
      }
    }
  }
  return [...days];
}

/** Recompute each touched day's rollups (one tight range per contiguous day). */
async function recomputeDays(days: string[], pool: Pool): Promise<void> {
  for (const day of [...new Set(days)].sort()) {
    await recomputeRollups({ from: day, to: day }, pool);
  }
}

/**
 * Add or update a seat (one per vendor+person) and rebuild its ledger rows.
 * Validates the same way the invoice/manual paths do: a real currency with an
 * FX rate, a sane month range. Returns the stored seat.
 */
export async function upsertSeat(
  input: SeatInput,
  pool: Pool = getPool(),
  now: Date = new Date(),
): Promise<Seat> {
  const vendor = input.vendor.trim().toLowerCase();
  if (!VENDOR_RE.test(vendor)) throw new ResolveError(`bad vendor ${JSON.stringify(input.vendor)}`, 400);
  if (vendor === "manual") throw new ResolveError('vendor "manual" is reserved', 400);
  const currency = cleanCurrency(input.currency.trim().toUpperCase());
  if (currency === null) throw new ResolveError(`bad currency ${JSON.stringify(input.currency)}`, 400);
  if (!Number.isInteger(input.amountCents) || input.amountCents < 0) {
    throw new ResolveError("amountCents must be a non-negative integer", 400);
  }
  assertMonth("startedMonth", input.startedMonth);
  if (input.endedMonth != null) {
    assertMonth("endedMonth", input.endedMonth);
    if (input.endedMonth < input.startedMonth) {
      throw new ResolveError("endedMonth is before startedMonth", 400);
    }
  }

  const client = await pool.connect();
  const days = new Set<string>();
  let seatId: string;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO subscription_seats
         (vendor, person_id, identity_id, tier, amount_cents, currency,
          started_month, ended_month, source, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10)
       ON CONFLICT (vendor, person_id) DO UPDATE SET
         identity_id = COALESCE(EXCLUDED.identity_id, subscription_seats.identity_id),
         tier = EXCLUDED.tier,
         amount_cents = EXCLUDED.amount_cents,
         currency = EXCLUDED.currency,
         started_month = EXCLUDED.started_month,
         ended_month = EXCLUDED.ended_month,
         note = EXCLUDED.note,
         updated_at = now()
       RETURNING id`,
      [
        vendor,
        input.personId,
        input.identityId ?? null,
        input.tier ?? null,
        input.amountCents,
        currency,
        `${input.startedMonth}-01`,
        input.endedMonth ? `${input.endedMonth}-01` : null,
        input.source ?? "manual",
        input.note ?? null,
      ],
    );
    seatId = rows[0].id as string;
    const touched = await materializeSeat(
      client,
      {
        id: seatId,
        vendor,
        personId: input.personId,
        amountCents: input.amountCents,
        currency,
        startedMonth: input.startedMonth,
        endedMonth: input.endedMonth ?? null,
      },
      now,
    );
    for (const day of touched) days.add(day);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await recomputeDays([...days], pool);
  const seats = await listSeats(pool, { id: seatId });
  return seats[0];
}

/** Remove a seat and the ledger rows it produced. */
export async function deleteSeat(id: string, pool: Pool = getPool()): Promise<void> {
  const client = await pool.connect();
  const days = new Set<string>();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT vendor FROM subscription_seats WHERE id = $1",
      [id],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      throw new ResolveError("seat not found", 404);
    }
    const removed = await client.query(
      "DELETE FROM spend_facts WHERE vendor = $1 AND source_ref LIKE $2 RETURNING day::text AS day",
      [rows[0].vendor, `seat:${id}:%`],
    );
    for (const row of removed.rows) days.add(row.day as string);
    await client.query("DELETE FROM subscription_seats WHERE id = $1", [id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await recomputeDays([...days], pool);
}

/**
 * Re-materialize every seat. Run on a schedule (and after a backfill) so an
 * ongoing seat grows its current-month fee as the calendar advances - the
 * only seat fact that does not exist until the month it bills arrives.
 */
export async function materializeAllSeats(
  pool: Pool = getPool(),
  now: Date = new Date(),
): Promise<{ days: string[] }> {
  const { rows } = await pool.query(
    `SELECT id, vendor, person_id AS "personId", amount_cents AS "amountCents",
            currency, to_char(started_month, 'YYYY-MM') AS "startedMonth",
            to_char(ended_month, 'YYYY-MM') AS "endedMonth"
     FROM subscription_seats`,
  );
  const client = await pool.connect();
  const days = new Set<string>();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      const touched = await materializeSeat(
        client,
        {
          id: row.id,
          vendor: row.vendor,
          personId: row.personId,
          amountCents: Number(row.amountCents),
          currency: row.currency,
          startedMonth: row.startedMonth,
          endedMonth: row.endedMonth,
        },
        now,
      );
      for (const day of touched) days.add(day);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const sorted = [...days].sort();
  await recomputeDays(sorted, pool);
  return { days: sorted };
}

export interface SeatCandidate {
  personId: string;
  personName: string | null;
  personEmail: string;
  vendor: string;
  tier: string | null;
}

/**
 * People a connector reported on a subscription (identities.subscription_type
 * is set) who have no seat yet - the auto-detected candidates the Settings
 * card offers to price. The vendor knows WHO is on a flat plan; only the fee
 * has to be entered, so detection does the finding and the admin sets the price.
 */
export async function listSeatCandidates(db: Db = getPool()): Promise<SeatCandidate[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (i.vendor, p.id)
            p.id AS "personId", p.name AS "personName", p.email AS "personEmail",
            i.vendor, i.subscription_type AS tier
     FROM identities i
     JOIN people p ON p.id = i.person_id
     WHERE i.subscription_type IS NOT NULL
       AND p.merged_into IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM subscription_seats s
         WHERE s.vendor = i.vendor AND s.person_id = i.person_id
       )
     ORDER BY i.vendor, p.id, p.email`,
  );
  return rows.map((row) => ({
    personId: row.personId,
    personName: row.personName,
    personEmail: row.personEmail,
    vendor: row.vendor,
    tier: row.tier,
  }));
}

export async function listSeats(
  db: Db = getPool(),
  filter: { id?: string; vendor?: string } = {},
): Promise<Seat[]> {
  const { rows } = await db.query(
    `SELECT s.id, s.vendor, s.person_id AS "personId", p.name AS "personName",
            p.email AS "personEmail", s.tier,
            s.amount_cents::bigint AS "amountCents", s.currency,
            to_char(s.started_month, 'YYYY-MM') AS "startedMonth",
            to_char(s.ended_month, 'YYYY-MM') AS "endedMonth",
            s.source, s.note
     FROM subscription_seats s
     JOIN people p ON p.id = s.person_id
     WHERE ($1::uuid IS NULL OR s.id = $1)
       AND ($2::text IS NULL OR s.vendor = $2)
     ORDER BY s.vendor, p.email`,
    [filter.id ?? null, filter.vendor ?? null],
  );
  return rows.map((row) => ({
    id: row.id,
    vendor: row.vendor,
    personId: row.personId,
    personName: row.personName,
    personEmail: row.personEmail,
    tier: row.tier,
    amountCents: Number(row.amountCents),
    currency: row.currency,
    startedMonth: row.startedMonth,
    endedMonth: row.endedMonth,
    source: row.source,
    note: row.note,
  }));
}
