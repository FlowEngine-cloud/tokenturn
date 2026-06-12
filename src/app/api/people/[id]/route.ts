import { badRequest, cleanUuid, requireAdmin, requireUser } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getPool } from "@/lib/db";
import { logger } from "@/lib/logger";
import { hardDeletePerson, personDetail } from "@/lib/people";
import { DAY_RE, defaultRange } from "@/lib/range";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * One person (spec 10 page 2 click-through): daily breakdown, keys and
 * seats, products, outcomes over the range. Follows merges to the survivor
 * (the response's person.id is authoritative) and still answers for
 * archived people - history stays intact, only current views hide them.
 * Admins also get `access` - the person's "Can sign in" state (spec 10.6),
 * written through PUT /api/people/{id}/access.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const id = cleanUuid((await params).id);
  if (!id) return badRequest("invalid person id");

  const search = new URL(req.url).searchParams;
  const range = { ...defaultRange() };
  for (const key of ["from", "to"] as const) {
    const value = search.get(key);
    if (value === null) continue;
    if (!DAY_RE.test(value)) return badRequest(`${key} must be YYYY-MM-DD`);
    range[key] = value;
  }
  if (range.from > range.to) {
    return badRequest(`from ${range.from} is after to ${range.to}`);
  }

  try {
    const detail = await personDetail(id, range, db);
    if (user.role !== "admin") return Response.json(detail);
    const { rows } = await db.query(
      "SELECT id, role FROM users WHERE person_id = $1",
      [detail.person.id],
    );
    const login = rows[0] as { id: string; role: "admin" | "viewer" } | undefined;
    return Response.json({
      ...detail,
      access: {
        role: login?.role ?? null,
        isSelf: login !== undefined && login.id.toLowerCase() === user.id.toLowerCase(),
      },
    });
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

/**
 * GDPR hard-delete (spec 4's one exception to "nothing hard-deletes"):
 * removes the person and scrubs their personal data; their spend stays on
 * the ledger as Unassigned and rollups keep the aggregate, so no total ever
 * changes. Admin-only, irreversible.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const id = cleanUuid((await params).id);
  if (!id) return badRequest("invalid person id");

  try {
    const removed = await hardDeletePerson(id, db);
    logger.info("person hard-deleted (gdpr)", { personId: id, by: admin.id });
    // The id, not the identity: the audit log must not re-hold the data
    // the delete just scrubbed.
    await audit(admin, "person.gdpr_delete", { personId: id, ...removed }, db);
    return Response.json({ ok: true, ...removed });
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
