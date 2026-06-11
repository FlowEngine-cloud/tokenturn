import { badRequest, forbidden, requireAdmin } from "@/lib/api";
import { getPool } from "@/lib/db";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Remove a view-only user. The admin can't be deleted - lost-credential
 * recovery is the reset-admin CLI, never deletion (exactly one admin).
 * Sessions and passkeys cascade with the row.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return badRequest("invalid user id");

  const { rows } = await db.query("SELECT role FROM users WHERE id = $1", [id]);
  if (rows.length === 0) {
    return Response.json({ error: "no such user" }, { status: 404 });
  }
  if (rows[0].role === "admin") return forbidden("the admin cannot be deleted");

  await db.query("DELETE FROM users WHERE id = $1", [id]);
  logger.info("viewer removed", { userId: id, by: admin.id });
  return Response.json({ ok: true });
}
