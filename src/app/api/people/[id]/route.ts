import { badRequest, cleanUuid, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { personDetail } from "@/lib/people";
import { DAY_RE, defaultRange } from "@/lib/range";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * One person (spec 10 page 2 click-through): daily breakdown, keys and
 * seats, products, outcomes over the range. Follows merges to the survivor
 * (the response's person.id is authoritative) and still answers for
 * archived people - history stays intact, only current views hide them.
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
    return Response.json(await personDetail(id, range, db));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
