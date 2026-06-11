import {
  badRequest,
  cleanName,
  cleanPassword,
  conflict,
  readJson,
  requireAdmin,
} from "@/lib/api";
import { audit } from "@/lib/audit";
import { getPool } from "@/lib/db";
import { requireEeFeature } from "@/lib/license";
import { logger } from "@/lib/logger";
import { hashPassword } from "@/lib/password";

export const dynamic = "force-dynamic";

/** List dashboard users (admin only). */
export async function GET(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const { rows } = await db.query(
    `SELECT u.id, u.name, u.role, u.created_at,
            count(c.id)::int AS passkeys,
            (u.password_hash IS NOT NULL) AS has_password
     FROM users u LEFT JOIN webauthn_credentials c ON c.user_id = u.id
     GROUP BY u.id ORDER BY u.role, lower(u.name)`,
  );
  return Response.json({ users: rows });
}

/**
 * Add a user. Free includes one admin plus view-only users (spec 11);
 * additional admins are the `more_admins` enterprise feature - without a
 * valid license, role "admin" answers 403 with the locked-feature line.
 */
export async function POST(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const body = await readJson(req);
  const name = cleanName(body?.name);
  const password = cleanPassword(body?.password);
  const role = body?.role ?? "viewer";
  if (!name) return badRequest("name required (1-80 characters)");
  if (!password) return badRequest("password required (8-200 characters)");
  if (role !== "viewer" && role !== "admin") {
    return badRequest("role must be viewer or admin");
  }
  if (role === "admin") {
    const locked = await requireEeFeature("more_admins", db);
    if (locked) return locked;
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO users (name, role, password_hash)
       VALUES ($1, $2, $3) RETURNING id, name, role`,
      [name, role, await hashPassword(password)],
    );
    logger.info("user added", { userId: rows[0].id, role, by: admin.id });
    await audit(admin, "user.add", { name, role, userId: rows[0].id }, db);
    return Response.json({ user: rows[0] }, { status: 201 });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      return conflict("a user with that name already exists");
    }
    throw error;
  }
}
