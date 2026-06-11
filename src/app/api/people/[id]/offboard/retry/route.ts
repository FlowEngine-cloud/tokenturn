import { badRequest, cleanUuid, readJson, requireAdmin } from "@/lib/api";
import { getPool } from "@/lib/db";
import { retryOffboardItem } from "@/lib/provision";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * Retry one failed offboard item (admin, spec 8 Out: "retryable one by
 * one"). Body: { itemId: uuid }. The item must belong to this person.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const personId = cleanUuid((await params).id);
  if (!personId) return badRequest("invalid person id");
  const body = await readJson(req);
  const itemId = cleanUuid(body?.itemId);
  if (!itemId) return badRequest("pass itemId (uuid)");

  const { rows } = await db.query(
    "SELECT person_id AS \"personId\" FROM offboard_items WHERE id = $1",
    [itemId],
  );
  if (rows.length === 0 || rows[0].personId !== personId) {
    return Response.json(
      { error: "no offboard item with that id for this person" },
      { status: 404 },
    );
  }

  try {
    return Response.json({ item: await retryOffboardItem(itemId, { db }) });
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
