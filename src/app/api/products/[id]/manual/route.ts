import { badRequest, cleanUuid, readJson, requireAdmin } from "@/lib/api";
import { getPool } from "@/lib/db";
import {
  cleanCents,
  cleanCurrency,
  cleanMonth,
  upsertManualEntry,
  type ManualEntryInput,
} from "@/lib/products";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

const MAX_NOTE = 500;

/**
 * Record a manual monthly entry for a product with no API (admin, spec 7):
 *
 *   { "kind": "cost", "month": "2026-05", "amountCents": 20000,
 *     "currency": "USD", "note": "..." }
 *   { "kind": "outcomes", "month": "2026-05", "count": 42,
 *     "valueCents": 450, "valueCurrency": "USD" }
 *
 * One entry per product, kind and month - a PUT for the same month rewrites
 * it in place (corrections restate, nothing hard-deletes). valueCents is
 * per outcome and optional: absent, the product's default value applies at
 * read time. The entry lands in the ledger marked manual and every row it
 * produces drills back to it.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const id = cleanUuid((await params).id);
  if (!id) return badRequest("invalid product id");
  const body = await readJson(req);
  if (!body) return badRequest("invalid JSON body");

  const month = cleanMonth(body.month);
  if (!month) return badRequest("month must be YYYY-MM");
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== "string" || body.note.length > MAX_NOTE) {
      return badRequest(`note must be a string of at most ${MAX_NOTE} characters`);
    }
    note = body.note;
  }

  let input: ManualEntryInput;
  if (body.kind === "cost") {
    const amountCents = cleanCents(body.amountCents);
    if (amountCents === null) {
      return badRequest("amountCents must be a non-negative integer");
    }
    const currency = cleanCurrency(body.currency);
    if (!currency) return badRequest("currency must be a 3-letter code (e.g. USD)");
    input = { kind: "cost", month, amountCents, currency, note };
  } else if (body.kind === "outcomes") {
    const count = cleanCents(body.count);
    if (count === null) return badRequest("count must be a non-negative integer");
    let value: { cents: number; currency: string } | null = null;
    if (body.valueCents !== undefined && body.valueCents !== null) {
      const cents = cleanCents(body.valueCents);
      if (cents === null) {
        return badRequest("valueCents must be a non-negative integer");
      }
      const currency = cleanCurrency(body.valueCurrency);
      if (!currency) {
        return badRequest("valueCurrency must be a 3-letter code (e.g. USD)");
      }
      value = { cents, currency };
    } else if (body.valueCurrency !== undefined && body.valueCurrency !== null) {
      return badRequest("valueCurrency needs valueCents");
    }
    input = { kind: "outcomes", month, count, value, note };
  } else {
    return badRequest('kind must be "cost" or "outcomes"');
  }

  try {
    return Response.json(await upsertManualEntry(id, input, db));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
