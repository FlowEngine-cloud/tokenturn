import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { badRequest, readJson, requireUser } from "@/lib/api";
import { getPool } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  addCredential,
  consumeChallenge,
  rpFromRequest,
  verifyRegistration,
} from "@/lib/webauthn";

export const dynamic = "force-dynamic";

/** Add a passkey to the signed-in user, step 2: verify and store. */
export async function POST(req: Request) {
  const db = getPool();
  const user = await requireUser(req, db);
  if (user instanceof Response) return user;

  const body = await readJson(req);
  const challengeId = typeof body?.challengeId === "string" ? body.challengeId : null;
  const response = body?.response as RegistrationResponseJSON | undefined;
  if (!challengeId || !response) {
    return badRequest("challengeId and response required");
  }

  const stored = await consumeChallenge(challengeId, "registration", db);
  // The challenge must have been minted for this exact user.
  if (!stored || stored.userId !== user.id) {
    return badRequest("challenge expired or already used");
  }

  let credential;
  try {
    credential = await verifyRegistration(rpFromRequest(req), stored.challenge, response);
  } catch (error) {
    logger.warn("passkey add verification failed", { error, userId: user.id });
    return badRequest("passkey verification failed");
  }
  if (!credential) return badRequest("passkey verification failed");

  await addCredential(user.id, credential, db);
  logger.info("passkey added", { userId: user.id });
  return Response.json({ ok: true });
}
