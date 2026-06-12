import {
  badRequest,
  cleanPassword,
  cleanUuid,
  conflict,
  forbidden,
  readJson,
  requireAdmin,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import { getPool } from "@/lib/db";
import { requireEeFeature } from "@/lib/license";
import { logger } from "@/lib/logger";
import { hashPassword } from "@/lib/password";

export const dynamic = "force-dynamic";

/**
 * "Can sign in" - login access as a property of the person (spec 10.6).
 * Body: { role: "none" | "viewer" | "admin", password?: string }.
 *
 * - none: removes the person's login; their sessions and passkeys go with
 *   it. Never your own, never the last admin.
 * - viewer/admin: creates the login (email as the username; password
 *   required, 8-200 chars) or changes the existing one's role. A passed
 *   password also resets the existing login's password. Granting admin is
 *   the `more_admins` enterprise feature - without a valid license it
 *   answers 403 with the locked-feature line (spec 11).
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
  const role = body?.role;
  if (role !== "none" && role !== "viewer" && role !== "admin") {
    return badRequest("role must be none, viewer or admin");
  }

  const { rows: people } = await db.query(
    "SELECT id, email FROM people WHERE id = $1 AND merged_into IS NULL",
    [id],
  );
  if (people.length === 0) {
    return Response.json({ error: "no such person" }, { status: 404 });
  }
  const email = people[0].email as string;
  const { rows: existing } = await db.query(
    "SELECT id, name, role FROM users WHERE person_id = $1",
    [id],
  );
  const current = existing[0] as { id: string; name: string; role: string } | undefined;
  if (current && current.id.toLowerCase() === admin.id.toLowerCase()) {
    return forbidden("you cannot change your own sign-in here");
  }

  if (role === "none") {
    if (!current) return Response.json({ access: { role: null } });
    if (current.role === "admin") {
      const { rows } = await db.query(
        "SELECT count(*)::int AS admins FROM users WHERE role = 'admin'",
      );
      if (rows[0].admins <= 1) {
        return forbidden("the last admin cannot lose sign-in");
      }
    }
    await db.query("DELETE FROM users WHERE id = $1", [current.id]);
    logger.info("person sign-in removed", { personId: id, by: admin.id });
    await audit(admin, "person.access", { personId: id, email, role: "none" }, db);
    return Response.json({ access: { role: null } });
  }

  if (role === "admin" && current?.role !== "admin") {
    const locked = await requireEeFeature("more_admins", db);
    if (locked) return locked;
  }

  const password = body && "password" in body ? cleanPassword(body.password) : undefined;
  if (password === null) return badRequest("password must be 8-200 characters");

  if (current) {
    await db.query(
      `UPDATE users SET role = $2,
              password_hash = COALESCE($3, password_hash)
       WHERE id = $1`,
      [current.id, role, password ? await hashPassword(password) : null],
    );
  } else {
    if (!password) return badRequest("password required (8-200 characters)");
    try {
      await db.query(
        `INSERT INTO users (name, email, role, password_hash, person_id)
         VALUES ($1, $1, $2, $3, $4)`,
        [email, role, await hashPassword(password), id],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        return conflict(`a sign-in named ${email} already exists`);
      }
      throw error;
    }
  }
  logger.info("person sign-in set", { personId: id, role, by: admin.id });
  await audit(admin, "person.access", { personId: id, email, role }, db);
  return Response.json({ access: { role } });
}
