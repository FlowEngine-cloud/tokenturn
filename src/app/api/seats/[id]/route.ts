import { badRequest, cleanUuid, requireAdmin } from "@/lib/api";
import { getPool } from "@/lib/db";
import { ResolveError } from "@/lib/resolve";
import { deleteSeat } from "@/lib/seats";

export const dynamic = "force-dynamic";

/** Remove a seat and the subscription spend it materialized. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const id = cleanUuid((await params).id);
  if (id === null) return badRequest("invalid seat id");

  try {
    await deleteSeat(id, db);
    return Response.json({ deleted: true });
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
