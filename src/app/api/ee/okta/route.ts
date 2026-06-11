import { connectOkta, disconnectOkta, oktaStatus, validateOktaInput } from "@ee/lib/okta";
import { readJson, requireAdmin } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getPool } from "@/lib/db";
import { requireEeFeature } from "@/lib/license";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * Okta sync (spec 11, enterprise). Admin-only and license-gated: without
 * the `okta_sync` feature every verb answers 403 with the locked-feature
 * line. GET = status (domain, hook secret, last run - never the token),
 * POST = connect { domain, token }, DELETE = disconnect.
 */

export async function GET(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;
  const locked = await requireEeFeature("okta_sync", db);
  if (locked) return locked;
  return Response.json(await oktaStatus({ db }));
}

export async function POST(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;
  const locked = await requireEeFeature("okta_sync", db);
  if (locked) return locked;

  try {
    const input = validateOktaInput(await readJson(req));
    await connectOkta(input, { db });
    await audit(admin, "okta.connect", { domain: input.domain }, db);
    return Response.json(await oktaStatus({ db }));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    // Okta's rejection verbatim (bad token, missing log access, ...).
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 422 },
    );
  }
}

export async function DELETE(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;
  const locked = await requireEeFeature("okta_sync", db);
  if (locked) return locked;

  if (!(await disconnectOkta({ db }))) {
    return Response.json({ error: "not connected" }, { status: 404 });
  }
  await audit(admin, "okta.disconnect", {}, db);
  return Response.json({ ok: true });
}
