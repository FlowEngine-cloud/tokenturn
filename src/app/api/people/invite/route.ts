import { badRequest, cleanUuid, readJson, requireAdmin } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getPool } from "@/lib/db";
import { inviteFanout, INVITE_VENDORS } from "@/lib/provision";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * Invite fan-out (admin, spec 8 In): pick people + tools, every (person,
 * tool) pair gets its own result - success detail or the vendor's error
 * verbatim. Body: { personIds: uuid[], vendors: string[] }.
 */
export async function POST(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const body = await readJson(req);
  const rawIds = body?.personIds;
  const vendors = body?.vendors;
  if (!Array.isArray(rawIds) || !Array.isArray(vendors)) {
    return badRequest("pass personIds (uuid[]) and vendors (string[])");
  }
  const personIds: string[] = [];
  for (const raw of rawIds) {
    const id = cleanUuid(raw);
    if (!id) return badRequest(`invalid person id ${JSON.stringify(raw)}`);
    if (!personIds.includes(id)) personIds.push(id);
  }
  const tools = [...new Set(vendors.map(String))];

  try {
    const results = await inviteFanout(personIds, tools, { db });
    await audit(
      admin,
      "people.invite",
      {
        people: personIds.length,
        vendors: tools,
        ok: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
      },
      db,
    );
    return Response.json({ vendors: INVITE_VENDORS, results });
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
