import { createPublicKey, verify as edVerify, type KeyObject } from "node:crypto";
import { getPool, type Db } from "./db";
import { logger } from "./logger";

/**
 * The enterprise wall (spec 11). `ee/` features unlock with a license file
 * issued per deal and verified OFFLINE: the file is a signed grant (org,
 * expiry, feature list) checked against the Ed25519 public key pinned
 * below - no license server, no phone-home, nothing leaves the machine.
 *
 * Locked features show exactly one line (EE_LOCKED_COPY). License expiry
 * locks the features again; nothing that was synced or recorded ever
 * becomes unreadable.
 */

export {
  EE_LOCKED_COPY,
  EE_FEATURES,
  EE_FEATURE_LABELS,
  type EeFeature,
  type LicenseState,
  type LicenseStatus,
} from "./ee";
import { EE_FEATURES, EE_LOCKED_COPY, type EeFeature, type LicenseStatus } from "./ee";

/** FlowEngine's license-signing public key (Ed25519, SPKI). The private
 * counterpart never ships; licenses are issued per deal with
 * ee/scripts/issue-license.mjs. */
export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAnoy9eWeRJKWhZoi8jZif2E7xt5jGKY8hHWkgcqSsRpQ=
-----END PUBLIC KEY-----`;

/** Settings row holding the raw license file text. */
export const LICENSE_SETTING = "license_file";

export class LicenseError extends Error {}

export interface LicensePayload {
  /** Who the license was issued to. */
  org: string;
  /** ISO dates (UTC). The license is valid through the end of expires_at. */
  issued_at: string;
  expires_at: string;
  /** Feature keys granted; ["*"] grants everything. */
  features: string[];
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Tests may pin their own trust anchor; the guard keeps the override dead
// code outside vitest, so a production build always verifies against the
// pinned FlowEngine key.
let publicKeyOverride: string | null = null;
export function __setLicensePublicKeyForTests(pem: string | null): void {
  if (!process.env.VITEST) {
    throw new Error("license key override is test-only");
  }
  publicKeyOverride = pem;
}

function trustAnchor(): KeyObject {
  return createPublicKey(publicKeyOverride ?? LICENSE_PUBLIC_KEY_PEM);
}

function decodePayload(payloadB64: string): LicensePayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    throw new LicenseError("license payload is not valid JSON");
  }
  const p = parsed as Record<string, unknown>;
  if (
    !p ||
    typeof p !== "object" ||
    typeof p.org !== "string" ||
    p.org.trim() === "" ||
    typeof p.issued_at !== "string" ||
    !DAY_RE.test(p.issued_at) ||
    typeof p.expires_at !== "string" ||
    !DAY_RE.test(p.expires_at) ||
    !Array.isArray(p.features) ||
    p.features.some((f) => typeof f !== "string")
  ) {
    throw new LicenseError("license payload is malformed");
  }
  const unknown = (p.features as string[]).find(
    (f) => f !== "*" && !(EE_FEATURES as readonly string[]).includes(f),
  );
  if (unknown !== undefined) {
    throw new LicenseError(`license names an unknown feature: ${unknown}`);
  }
  return p as unknown as LicensePayload;
}

/**
 * Verify a license file and return its payload. The signature covers the
 * exact base64url payload bytes - no canonicalization to get wrong. Throws
 * LicenseError naming the problem; expiry is NOT checked here (an expired
 * license is still a real license - status reports it as expired).
 */
export function verifyLicenseFile(text: string): LicensePayload {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text.trim());
  } catch {
    throw new LicenseError("license file is not valid JSON");
  }
  const e = envelope as Record<string, unknown>;
  if (!e || typeof e !== "object" || e.v !== 1) {
    throw new LicenseError("license file format not recognized (expected v=1)");
  }
  if (typeof e.payload !== "string" || typeof e.signature !== "string") {
    throw new LicenseError("license file is missing payload or signature");
  }
  let ok = false;
  try {
    ok = edVerify(
      null,
      Buffer.from(e.payload, "utf8"),
      trustAnchor(),
      Buffer.from(e.signature, "base64url"),
    );
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new LicenseError(
      "license signature is invalid - the file was altered or not issued by FlowEngine",
    );
  }
  return decodePayload(e.payload);
}

function expandFeatures(features: string[]): EeFeature[] {
  if (features.includes("*")) return [...EE_FEATURES];
  return EE_FEATURES.filter((f) => features.includes(f));
}

/** True through the whole expires_at day (UTC). */
export function licenseExpired(payload: LicensePayload, now: Date): boolean {
  return now.toISOString().slice(0, 10) > payload.expires_at;
}

export async function getLicenseFileText(db: Db = getPool()): Promise<string | null> {
  const { rows } = await db.query(
    "SELECT value FROM settings WHERE key = $1 AND secret = false",
    [LICENSE_SETTING],
  );
  return rows.length > 0 ? (rows[0].value as string) : null;
}

/** Verify and store a license file; throws LicenseError on a bad file. */
export async function setLicenseFile(
  text: string,
  db: Db = getPool(),
): Promise<LicensePayload> {
  const payload = verifyLicenseFile(text);
  await db.query(
    `INSERT INTO settings (key, value, secret) VALUES ($1, $2::jsonb, false)
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, secret = false, updated_at = now()`,
    [LICENSE_SETTING, JSON.stringify(text.trim())],
  );
  logger.info("license installed", {
    org: payload.org,
    expiresAt: payload.expires_at,
    features: payload.features,
  });
  return payload;
}

export async function clearLicenseFile(db: Db = getPool()): Promise<void> {
  await db.query("DELETE FROM settings WHERE key = $1", [LICENSE_SETTING]);
  logger.info("license removed", {});
}

/**
 * The instance's license status. A stored file that no longer verifies
 * (key rotation, manual DB edits) reports as "none" with the features
 * locked - it can never unlock anything.
 */
export async function licenseStatus(
  db: Db = getPool(),
  now: Date = new Date(),
): Promise<LicenseStatus> {
  const text = await getLicenseFileText(db);
  if (text === null) {
    return { state: "none", org: null, issuedAt: null, expiresAt: null, features: [] };
  }
  let payload: LicensePayload;
  try {
    payload = verifyLicenseFile(text);
  } catch {
    return { state: "none", org: null, issuedAt: null, expiresAt: null, features: [] };
  }
  return {
    state: licenseExpired(payload, now) ? "expired" : "valid",
    org: payload.org,
    issuedAt: payload.issued_at,
    expiresAt: payload.expires_at,
    features: expandFeatures(payload.features),
  };
}

/** True when a valid (unexpired) license grants the feature. */
export async function eeFeatureEnabled(
  feature: EeFeature,
  db: Db = getPool(),
  now: Date = new Date(),
): Promise<boolean> {
  const status = await licenseStatus(db, now);
  return status.state === "valid" && status.features.includes(feature);
}

/**
 * Route guard: null when the feature is licensed, otherwise the 403 with
 * the exact locked-feature line (spec 11).
 */
export async function requireEeFeature(
  feature: EeFeature,
  db: Db = getPool(),
): Promise<Response | null> {
  if (await eeFeatureEnabled(feature, db)) return null;
  return Response.json({ error: EE_LOCKED_COPY }, { status: 403 });
}
