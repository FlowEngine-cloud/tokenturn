import { badRequest, forbidden, readJson, requireAdmin } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getPool } from "@/lib/db";
import { requireEeFeature } from "@/lib/license";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Change a user's role (spec 11). Promoting anyone to admin is the
 * `more_admins` enterprise feature: without a valid license it answers 403
 * with the locked-feature line - the dropdown always shows Admin, picking it
 * is what hits the wall. Your own role never changes here, so the last
 * admin can never demote themselves out of Settings.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return badRequest("invalid user id");
  if (id.toLowerCase() === admin.id.toLowerCase()) {
    return forbidden("you cannot change your own role");
  }

  const body = await readJson(req);
  const role = body?.role;
  if (role !== "viewer" && role !== "admin") {
    return badRequest("role must be viewer or admin");
  }
  if (role === "admin") {
    const locked = await requireEeFeature("more_admins", db);
    if (locked) return locked;
  }

  const { rows } = await db.query(
    "UPDATE users SET role = $2 WHERE id = $1 RETURNING id, name, role",
    [id, role],
  );
  if (rows.length === 0) {
    return Response.json({ error: "no such user" }, { status: 404 });
  }
  logger.info("user role changed", { userId: id, role, by: admin.id });
  await audit(admin, "user.role", { userId: id, name: rows[0].name, role }, db);
  return Response.json({ user: rows[0] });
}

/**
 * Remove a user. Admins added under a `more_admins` license are removable
 * like anyone else, but never the last admin (lost-credential recovery is
 * the reset-admin CLI, not deletion) and never yourself. Sessions and
 * passkeys cascade with the row.
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
  if (id.toLowerCase() === admin.id.toLowerCase()) {
    return forbidden("you cannot delete yourself");
  }

  const { rows } = await db.query(
    "SELECT name, role FROM users WHERE id = $1",
    [id],
  );
  if (rows.length === 0) {
    return Response.json({ error: "no such user" }, { status: 404 });
  }
  if (rows[0].role === "admin") {
    const { rows: count } = await db.query(
      "SELECT count(*)::int AS admins FROM users WHERE role = 'admin'",
    );
    if (count[0].admins <= 1) {
      return forbidden("the last admin cannot be deleted");
    }
  }

  await db.query("DELETE FROM users WHERE id = $1", [id]);
  logger.info("user removed", { userId: id, by: admin.id });
  await audit(
    admin,
    "user.remove",
    { userId: id, name: rows[0].name, role: rows[0].role },
    db,
  );
  return Response.json({ ok: true });
}
