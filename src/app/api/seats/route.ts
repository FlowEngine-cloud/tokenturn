import { badRequest, cleanUuid, readJson, requireAdmin, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { ResolveError } from "@/lib/resolve";
import { listSeatCandidates, listSeats, upsertSeat, type SeatInput } from "@/lib/seats";

export const dynamic = "force-dynamic";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Every subscription seat plus the auto-detected candidates (people a
 * connector reported on a subscription who have no seat yet).
 */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const [seats, candidates] = await Promise.all([listSeats(db), listSeatCandidates(db)]);
  return Response.json({ seats, candidates });
}

/**
 * Add or re-price a seat (one per vendor+person). A flat seat fee is reported
 * by no usage API, so it is recorded here and materializes into the ledger as
 * subscription spend - the only way a flat plan ($20/$100/$200 Claude Max, a
 * Cursor/Copilot seat) shows up as real money. Re-pricing re-values history.
 */
export async function POST(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const body = await readJson(req);
  if (!body) return badRequest("invalid JSON body");

  if (typeof body.vendor !== "string") return badRequest("vendor must be a string");
  const personId = cleanUuid(body.personId);
  if (personId === null) return badRequest("personId must be a uuid");
  if (typeof body.currency !== "string") return badRequest("currency must be a string");
  if (typeof body.amountCents !== "number" || !Number.isInteger(body.amountCents)) {
    return badRequest("amountCents must be an integer");
  }
  if (typeof body.startedMonth !== "string" || !MONTH_RE.test(body.startedMonth)) {
    return badRequest("startedMonth must be YYYY-MM");
  }
  if (body.endedMonth != null && (typeof body.endedMonth !== "string" || !MONTH_RE.test(body.endedMonth))) {
    return badRequest("endedMonth must be YYYY-MM");
  }

  const input: SeatInput = {
    vendor: body.vendor,
    personId,
    tier: typeof body.tier === "string" ? body.tier : null,
    amountCents: body.amountCents,
    currency: body.currency,
    startedMonth: body.startedMonth,
    endedMonth: typeof body.endedMonth === "string" ? body.endedMonth : null,
    note: typeof body.note === "string" ? body.note : null,
  };

  try {
    return Response.json(await upsertSeat(input, db));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
