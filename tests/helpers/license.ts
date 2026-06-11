import { generateKeyPairSync, sign as edSign } from "node:crypto";
import type { Db } from "../../src/lib/db";
import {
  __setLicensePublicKeyForTests,
  setLicenseFile,
  type LicensePayload,
} from "../../src/lib/license";

/**
 * Test license issuance: a per-process Ed25519 keypair whose public half
 * tests pin via __setLicensePublicKeyForTests. Mirrors exactly what
 * ee/scripts/issue-license.mjs produces.
 */

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
export const TEST_LICENSE_PUBLIC_PEM = publicKey.export({
  type: "spki",
  format: "pem",
}) as string;

export function issueTestLicense(
  payload: Partial<LicensePayload> & Record<string, unknown> = {},
): string {
  const full = {
    org: "Acme Corp",
    issued_at: "2026-01-01",
    expires_at: "2099-01-01",
    features: ["*"],
    ...payload,
  };
  const b64 = Buffer.from(JSON.stringify(full), "utf8").toString("base64url");
  const signature = edSign(null, Buffer.from(b64, "utf8"), privateKey).toString("base64url");
  return JSON.stringify({ v: 1, payload: b64, signature });
}

/** Pin the test key and install a license granting `features`. */
export async function licenseInstance(db: Db, features: string[] = ["*"]): Promise<void> {
  __setLicensePublicKeyForTests(TEST_LICENSE_PUBLIC_PEM);
  await setLicenseFile(issueTestLicense({ features }), db);
}

export function unpinTestLicenseKey(): void {
  __setLicensePublicKeyForTests(null);
}
