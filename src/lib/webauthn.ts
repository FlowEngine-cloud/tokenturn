import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import { APP_NAME } from "./brand";
import { getPool, type Db } from "./db";

/**
 * Passkeys (spec 11 + 12b). Thin wrapper over @simplewebauthn/server plus
 * the DB plumbing: one-time challenges (deleted on use, so assertions can't
 * be replayed) and credential storage.
 *
 * The RP is derived from the request's Host header - self-hosted instances
 * live on whatever domain the user picked, and DATABASE_URL is the only env
 * var, so there is nothing to configure.
 */

export const RP_NAME = APP_NAME;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface RelyingParty {
  rpID: string;
  origin: string;
}

export function rpFromRequest(req: Request): RelyingParty {
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ??
    url.protocol.replace(":", "");
  // rpID is the effective domain: hostname without the port.
  const rpID = host.replace(/:\d+$/, "");
  return { rpID, origin: `${proto}://${host}` };
}

// ---- one-time challenges ----

export type ChallengeKind = "registration" | "authentication";

export async function storeChallenge(
  kind: ChallengeKind,
  challenge: string,
  userId: string | null,
  db: Db = getPool(),
): Promise<string> {
  await db.query("DELETE FROM auth_challenges WHERE expires_at < now()");
  const { rows } = await db.query(
    `INSERT INTO auth_challenges (kind, challenge, user_id, expires_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [kind, challenge, userId, new Date(Date.now() + CHALLENGE_TTL_MS)],
  );
  return rows[0].id as string;
}

/** Single use: the row is deleted as it is read. */
export async function consumeChallenge(
  id: string,
  kind: ChallengeKind,
  db: Db = getPool(),
): Promise<{ challenge: string; userId: string | null } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await db.query(
    `DELETE FROM auth_challenges
     WHERE id = $1 AND kind = $2 AND expires_at > now()
     RETURNING challenge, user_id`,
    [id, kind],
  );
  if (rows.length === 0) return null;
  return { challenge: rows[0].challenge as string, userId: rows[0].user_id as string | null };
}

// ---- credentials ----

export interface StoredCredential {
  userId: string;
  credential: WebAuthnCredential;
}

export async function addCredential(
  userId: string,
  credential: WebAuthnCredential,
  db: Db = getPool(),
): Promise<void> {
  await db.query(
    `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId,
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      credential.transports ?? [],
    ],
  );
}

export async function credentialById(
  credentialId: string,
  db: Db = getPool(),
): Promise<StoredCredential | null> {
  const { rows } = await db.query(
    `SELECT user_id, credential_id, public_key, counter, transports
     FROM webauthn_credentials WHERE credential_id = $1`,
    [credentialId],
  );
  if (rows.length === 0) return null;
  return {
    userId: rows[0].user_id as string,
    credential: {
      id: rows[0].credential_id as string,
      publicKey: new Uint8Array(rows[0].public_key as Buffer),
      counter: Number(rows[0].counter),
      transports: rows[0].transports ?? [],
    },
  };
}

export async function credentialDescriptorsForUser(
  userId: string,
  db: Db = getPool(),
): Promise<{ id: string; transports?: WebAuthnCredential["transports"] }[]> {
  const { rows } = await db.query(
    "SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1",
    [userId],
  );
  return rows.map((r) => ({ id: r.credential_id as string, transports: r.transports ?? [] }));
}

/** All credentials - login is usernameless, the assertion picks the user. */
export async function allCredentialDescriptors(
  db: Db = getPool(),
): Promise<{ id: string; transports?: WebAuthnCredential["transports"] }[]> {
  const { rows } = await db.query(
    "SELECT credential_id, transports FROM webauthn_credentials",
  );
  return rows.map((r) => ({ id: r.credential_id as string, transports: r.transports ?? [] }));
}

export async function updateCredentialCounter(
  credentialId: string,
  newCounter: number,
  db: Db = getPool(),
): Promise<void> {
  await db.query(
    `UPDATE webauthn_credentials
     SET counter = $2, last_used_at = now() WHERE credential_id = $1`,
    [credentialId, newCounter],
  );
}

// ---- ceremonies ----

export async function registrationOptions(
  rp: RelyingParty,
  userName: string,
  excludeUserId: string | null,
  db: Db = getPool(),
): Promise<{
  challengeId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
}> {
  const excludeCredentials = excludeUserId
    ? await credentialDescriptorsForUser(excludeUserId, db)
    : [];
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rp.rpID,
    userName,
    attestationType: "none",
    excludeCredentials,
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
  const challengeId = await storeChallenge(
    "registration",
    options.challenge,
    excludeUserId,
    db,
  );
  return { challengeId, options };
}

export async function verifyRegistration(
  rp: RelyingParty,
  expectedChallenge: string,
  response: RegistrationResponseJSON,
): Promise<WebAuthnCredential | null> {
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    // userVerification is "preferred": require presence, not verification.
    requireUserVerification: false,
  });
  if (!result.verified || !result.registrationInfo) return null;
  return result.registrationInfo.credential;
}

export async function authenticationOptions(
  rp: RelyingParty,
  db: Db = getPool(),
): Promise<{
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}> {
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    allowCredentials: await allCredentialDescriptors(db),
    userVerification: "preferred",
  });
  const challengeId = await storeChallenge(
    "authentication",
    options.challenge,
    null,
    db,
  );
  return { challengeId, options };
}

export async function verifyAuthentication(
  rp: RelyingParty,
  expectedChallenge: string,
  response: AuthenticationResponseJSON,
  credential: WebAuthnCredential,
): Promise<{ verified: boolean; newCounter: number }> {
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    credential,
    requireUserVerification: false,
  });
  return {
    verified: result.verified,
    newCounter: result.authenticationInfo?.newCounter ?? credential.counter,
  };
}
