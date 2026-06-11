import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { badRequest, cleanName, conflict, readJson, tooManyRequests } from "@/lib/api";
import { createSession, isClaimed, jsonWithSession } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { logger } from "@/lib/logger";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import {
  addCredential,
  consumeChallenge,
  rpFromRequest,
  verifyRegistration,
} from "@/lib/webauthn";

export const dynamic = "force-dynamic";

/**
 * First boot: verify the passkey attestation and claim the instance as the
 * one admin. The single-admin unique index makes a concurrent double-claim
 * impossible - the loser gets a 409.
 */
export async function POST(req: Request) {
  if (!rateLimit(clientKey(req, "claim"))) return tooManyRequests();
  const pool = getPool();
  if (await isClaimed(pool)) return conflict("instance already claimed");

  const body = await readJson(req);
  const name = cleanName(body?.name);
  const challengeId = typeof body?.challengeId === "string" ? body.challengeId : null;
  const response = body?.response as RegistrationResponseJSON | undefined;
  if (!name || !challengeId || !response) {
    return badRequest("name, challengeId and response required");
  }

  const stored = await consumeChallenge(challengeId, "registration", pool);
  if (!stored) return badRequest("challenge expired or already used");

  let credential;
  try {
    credential = await verifyRegistration(rpFromRequest(req), stored.challenge, response);
  } catch (error) {
    logger.warn("passkey claim verification failed", { error });
    return badRequest("passkey verification failed");
  }
  if (!credential) return badRequest("passkey verification failed");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "INSERT INTO users (name, role) VALUES ($1, 'admin') RETURNING id, name, role",
      [name],
    );
    const user = rows[0];
    await addCredential(user.id, credential, client);
    const session = await createSession(user.id, client);
    await client.query("COMMIT");
    logger.info("instance claimed", { userId: user.id, method: "passkey" });
    return jsonWithSession(req, { user }, session);
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as { code?: string }).code === "23505") {
      return conflict("instance already claimed");
    }
    throw error;
  } finally {
    client.release();
  }
}
