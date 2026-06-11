import { badRequest, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { DAY_RE, defaultRange } from "@/lib/range";
import { ResolveError } from "@/lib/resolve";
import { roiView } from "@/lib/roi";

export const dynamic = "force-dynamic";

/**
 * ROI (spec 10 page 3): every ROI calculation over the range in one list -
 * the built-in coding-tool rows and the user-defined ones - each with spend,
 * tokens, successes, $ and tokens per success, value and the ROI multiple.
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
    return Response.json(await roiView(range, db));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
