import { requireAdmin } from "@/lib/api";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * List sign-ins (admin only). Login access is a property of the person
 * (spec 10.6) - granting and changing it happens through
 * PUT /api/people/{id}/access. This list exists for the logins without a
 * person (the first-boot admin, legacy view-only users whose name matched
 * no roster email): they keep working and show on the People page, where
 * DELETE /api/users/{id} removes them.
 */
export async function GET(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const { rows } = await db.query(
    `SELECT u.id, u.name, u.role, u.person_id,
            count(c.id)::int AS passkeys,
            (u.password_hash IS NOT NULL) AS has_password
     FROM users u LEFT JOIN webauthn_credentials c ON c.user_id = u.id
     GROUP BY u.id ORDER BY u.role, lower(u.name)`,
  );
  return Response.json({ users: rows });
}
