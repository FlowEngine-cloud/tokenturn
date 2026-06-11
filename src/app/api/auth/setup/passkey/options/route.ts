import { badRequest, cleanName, conflict, readJson } from "@/lib/api";
import { isClaimed } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { registrationOptions, rpFromRequest } from "@/lib/webauthn";

export const dynamic = "force-dynamic";

/** First boot: passkey creation options for claiming the instance. */
export async function POST(req: Request) {
  const db = getPool();
  if (await isClaimed(db)) return conflict("instance already claimed");

  const body = await readJson(req);
  const name = cleanName(body?.name);
  if (!name) return badRequest("name required (1-80 characters)");

  const { challengeId, options } = await registrationOptions(
    rpFromRequest(req),
    name,
    null,
    db,
  );
  return Response.json({ challengeId, options });
}
