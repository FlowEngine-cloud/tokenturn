import { badRequest, readJson, requireAdmin, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { listPeople } from "@/lib/people";
import { importPeople } from "@/lib/people-import";
import { DAY_RE, defaultRange } from "@/lib/range";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * People (spec 10 page 2): the roster with per-person spend by vendor,
 * outcomes, $/outcome and trend over the range, plus the Unassigned bucket.
 * Archived people are hidden here; their history stays in the drills.
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
    return Response.json(await listPeople(range, db));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

/** Add one person (spec 8 In). Same upsert + auto-match sweep as the CSV -
 * the CSV is just this in bulk. */
export async function POST(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const body = await readJson(req);
  if (body instanceof Response) return body;
  if (body === null || typeof body !== "object") return badRequest("body required");
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const name = typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return badRequest("valid email required");

  try {
    const result = await importPeople([{ line: 1, email, name, error: null }], db, "manual");
    return Response.json({ person: result.rows[0] });
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
