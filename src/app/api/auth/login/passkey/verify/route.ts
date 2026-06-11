import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { badRequest, readJson, tooManyRequests, unauthorized } from "@/lib/api";
import { createSession, jsonWithSession } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { logger } from "@/lib/logger";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import {
  consumeChallenge,
  credentialById,
  rpFromRequest,
  updateCredentialCounter,
  verifyAuthentication,
} from "@/lib/webauthn";

export const dynamic = "force-dynamic";

/** Passkey sign-in, step 2: verify the assertion, open a session. */
export async function POST(req: Request) {
  if (!rateLimit(clientKey(req, "login"))) return tooManyRequests();
  const db = getPool();

  const body = await readJson(req);
  const challengeId = typeof body?.challengeId === "string" ? body.challengeId : null;
  const response = body?.response as AuthenticationResponseJSON | undefined;
  if (!challengeId || !response || typeof response.id !== "string") {
    return badRequest("challengeId and response required");
  }

  const stored = await consumeChallenge(challengeId, "authentication", db);
  if (!stored) return badRequest("challenge expired or already used");

  const found = await credentialById(response.id, db);
  if (!found) return unauthorized("unknown passkey");

  let result;
  try {
    result = await verifyAuthentication(
      rpFromRequest(req),
      stored.challenge,
      response,
      found.credential,
    );
  } catch (error) {
    logger.warn("passkey login verification failed", { error });
    return unauthorized("passkey verification failed");
  }
  if (!result.verified) return unauthorized("passkey verification failed");

  await updateCredentialCounter(found.credential.id, result.newCounter, db);
  const { rows } = await db.query(
    "SELECT id, name, role FROM users WHERE id = $1",
    [found.userId],
  );
  if (rows.length === 0) return unauthorized("unknown passkey");
  const user = rows[0];
  const session = await createSession(user.id, db);
  logger.info("login", { userId: user.id, method: "passkey" });
  return jsonWithSession(req, { user }, session);
}
