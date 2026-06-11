import { connectGoogle, disconnectGoogle, googleStatus, validateGoogleInput } from "@ee/lib/google";
import { readJson, requireAdmin } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getPool } from "@/lib/db";
import { requireEeFeature } from "@/lib/license";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * Google Workspace roster sync (spec 11, enterprise). Admin-only and
 * license-gated behind `google_workspace`. GET = status (client email,
 * impersonated admin, last run - never the key), POST = connect
 * { serviceAccountJson, adminEmail }, DELETE = disconnect.
 */

export async function GET(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;
  const locked = await requireEeFeature("google_workspace", db);
  if (locked) return locked;
  return Response.json(await googleStatus({ db }));
}

export async function POST(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;
  const locked = await requireEeFeature("google_workspace", db);
  if (locked) return locked;

  try {
    const config = validateGoogleInput(await readJson(req));
    await connectGoogle(config, { db });
    await audit(admin, "google.connect", { clientEmail: config.clientEmail }, db);
    return Response.json(await googleStatus({ db }));
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    // Google's rejection verbatim (delegation not granted, bad key, ...).
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
  const locked = await requireEeFeature("google_workspace", db);
  if (locked) return locked;

  if (!(await disconnectGoogle({ db }))) {
    return Response.json({ error: "not connected" }, { status: 404 });
  }
  await audit(admin, "google.disconnect", {}, db);
  return Response.json({ ok: true });
}
