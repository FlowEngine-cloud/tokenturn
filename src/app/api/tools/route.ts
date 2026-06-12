import { badRequest, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { DAY_RE, defaultRange } from "@/lib/range";
import { ResolveError } from "@/lib/resolve";
import { toolsData } from "@/lib/tools";

export const dynamic = "force-dynamic";

/**
 * Tools (spec 10 page 4): line survival and cost per 1,000 surviving lines
 * per tool per person, accept rates and revert rates over the range, side
 * by side - every number sourced from the rows its drill link returns.
 */
export async function GET(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const params = new URL(req.url).searchParams;
  const range = { ...defaultRange() };
  for (const key of ["from", "to"] as const) {
    const value = params.get(key);
    if (value === null) continue;
    if (!DAY_RE.test(value)) return badRequest(`${key} must be YYYY-MM-DD`);
    range[key] = value;
  }
  if (range.from > range.to) {
    return badRequest(`from ${range.from} is after to ${range.to}`);
  }

  try {
    return Response.json(await toolsData(range, db));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
