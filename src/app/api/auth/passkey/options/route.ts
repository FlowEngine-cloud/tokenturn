import { requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { registrationOptions, rpFromRequest } from "@/lib/webauthn";

export const dynamic = "force-dynamic";

/** Add a passkey to the signed-in user (used by the reset flow). */
export async function POST(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const { challengeId, options } = await registrationOptions(
    rpFromRequest(req),
    user.name,
    user.id,
    db,
  );
  return Response.json({ challengeId, options });
}
