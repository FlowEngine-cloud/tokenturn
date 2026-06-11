import { badRequest, cleanUuid, requireAdmin, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { offboardOverview, runOffboard } from "@/lib/provision";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * Offboard (spec 8 Out).
 *
 * GET = the plan and history: every key and seat of this person across
 * every vendor, each with its sweep state (active / pending / failed with
 * the vendor's error verbatim / removed). POST (admin) = the sweep: mark
 * the person offboarded - excluded from current burn checks, history kept -
 * and remove every item at its vendor; failed items stay retryable one by
 * one via /offboard/retry.
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
  try {
    return Response.json(await offboardOverview(id, db));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const id = cleanUuid((await params).id);
  if (!id) return badRequest("invalid person id");
  try {
    return Response.json(await runOffboard(id, { db, actor: admin }));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
