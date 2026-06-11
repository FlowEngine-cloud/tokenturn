import { badRequest, cleanUuid, readJson, requireAdmin } from "@/lib/api";
import { getPool } from "@/lib/db";
import { pushLimitToCursor, type CursorPushResult } from "@/lib/limits";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Set or clear a person's monthly spend limit (spec 9, admin only).
 *
 * Body: { limitUsdCents: number | null, pushToCursor?: boolean }.
 * - The limit is OUR alert threshold (USD cents, calendar-month UTC reset).
 *   It never hard-stops anything by itself.
 * - pushToCursor additionally writes it as the person's Cursor per-user
 *   limit - the one vendor-side limit we can set, Enterprise only. A
 *   vendor rejection comes back verbatim in `cursor.error`; the local
 *   limit is saved either way, since it drives our alerts regardless.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const id = cleanUuid((await params).id);
  if (!id) return badRequest("invalid person id");
  const body = await readJson(req);
  if (!body || !("limitUsdCents" in body)) {
    return badRequest("pass limitUsdCents (USD cents), or null to clear it");
  }
  const limit = body.limitUsdCents;
  if (
    limit !== null &&
    !(typeof limit === "number" && Number.isInteger(limit) && limit > 0)
  ) {
    return badRequest(
      "limitUsdCents must be a positive whole number of USD cents, or null",
    );
  }
  const push = body.pushToCursor ?? false;
  if (typeof push !== "boolean") {
    return badRequest("pushToCursor must be true or false");
  }
  if (push && limit === null) {
    return badRequest(
      "pushToCursor needs a limit - clearing only clears the AI P&L limit",
    );
  }

  const { rows } = await db.query(
    `UPDATE people
     SET monthly_limit_usd_cents = $2, updated_at = now()
     WHERE id = $1 AND status = 'active' AND merged_into IS NULL
     RETURNING id, email, name, monthly_limit_usd_cents::bigint AS limit_cents`,
    [id, limit],
  );
  if (rows.length === 0) {
    return Response.json(
      { error: "no active person with that id" },
      { status: 404 },
    );
  }
  logger.info("person limit set", { personId: id, limitUsdCents: limit });

  let cursor:
    | ({ ok: true } & CursorPushResult)
    | { ok: false; error: string }
    | undefined;
  if (push) {
    try {
      cursor = { ok: true, ...(await pushLimitToCursor(id, limit as number, { db })) };
    } catch (err) {
      // The vendor's (or connect-state) error, verbatim - never pretend the
      // hard stop happened.
      cursor = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return Response.json({
    person: {
      id: rows[0].id,
      email: rows[0].email,
      name: rows[0].name,
      limitUsdCents: rows[0].limit_cents === null ? null : Number(rows[0].limit_cents),
    },
    ...(cursor !== undefined ? { cursor } : {}),
  });
}
