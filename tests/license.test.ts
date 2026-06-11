import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  __setLicensePublicKeyForTests,
  EE_FEATURES,
  EE_LOCKED_COPY,
  eeFeatureEnabled,
  LicenseError,
  licenseExpired,
  licenseStatus,
  requireEeFeature,
  setLicenseFile,
  verifyLicenseFile,
  type LicensePayload,
} from "../src/lib/license";
import { runMigrations } from "../scripts/migrate.mjs";
import { TEST_DATABASE_URL, createScratchDb, dropScratchDb } from "./helpers/pg";

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");

/**
 * The wall (spec 11): licenses are signed files verified offline. These
 * tests issue real licenses with a test keypair (and once through the
 * actual ee/scripts/issue-license.mjs), pin the test public key, and prove
 * the wall opens for a valid grant, stays shut for tampered/expired/foreign
 * files, and always answers with the exact locked-feature line.
 */

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;

function issue(payload: Partial<LicensePayload> & Record<string, unknown>): string {
  const full = {
    org: "Acme Corp",
    issued_at: "2026-01-01",
    expires_at: "2027-01-01",
    features: ["*"],
    ...payload,
  };
  const b64 = Buffer.from(JSON.stringify(full), "utf8").toString("base64url");
  const signature = edSign(null, Buffer.from(b64, "utf8"), privateKey).toString("base64url");
  return JSON.stringify({ v: 1, payload: b64, signature });
}

describe("license file verification (offline)", () => {
  beforeAll(() => __setLicensePublicKeyForTests(publicPem));
  afterAll(() => __setLicensePublicKeyForTests(null));

  it("accepts a properly signed license and returns its payload", () => {
    const payload = verifyLicenseFile(issue({ features: ["okta_sync", "audit_log"] }));
    expect(payload.org).toBe("Acme Corp");
    expect(payload.expires_at).toBe("2027-01-01");
    expect(payload.features).toEqual(["okta_sync", "audit_log"]);
  });

  it("verifies a license issued by the real ee/scripts/issue-license.mjs", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ai-pnl-license-"));
    try {
      const keyPath = path.join(dir, "key.pem");
      writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
      const out = execFileSync("node", [
        path.resolve(__dirname, "..", "ee", "scripts", "issue-license.mjs"),
        "--key", keyPath,
        "--org", "Script Org",
        "--expires", "2030-12-31",
        "--features", "okta_sync,scheduled_reports",
      ]).toString();
      const payload = verifyLicenseFile(out);
      expect(payload.org).toBe("Script Org");
      expect(payload.features).toEqual(["okta_sync", "scheduled_reports"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a tampered payload - the signature no longer matches", () => {
    const file = JSON.parse(issue({}));
    const payload = JSON.parse(Buffer.from(file.payload, "base64url").toString());
    payload.expires_at = "2099-01-01"; // the customer edit
    file.payload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    expect(() => verifyLicenseFile(JSON.stringify(file))).toThrow(
      /signature is invalid/,
    );
  });

  it("rejects a license signed by a different key", () => {
    const { privateKey: foreign } = generateKeyPairSync("ed25519");
    const b64 = Buffer.from(
      JSON.stringify({ org: "X", issued_at: "2026-01-01", expires_at: "2027-01-01", features: ["*"] }),
    ).toString("base64url");
    const signature = edSign(null, Buffer.from(b64, "utf8"), foreign).toString("base64url");
    expect(() =>
      verifyLicenseFile(JSON.stringify({ v: 1, payload: b64, signature })),
    ).toThrow(LicenseError);
  });

  it("rejects garbage, wrong versions, and unknown features by name", () => {
    expect(() => verifyLicenseFile("not json")).toThrow(/not valid JSON/);
    expect(() => verifyLicenseFile(JSON.stringify({ v: 2, payload: "x", signature: "y" }))).toThrow(
      /expected v=1/,
    );
    expect(() => verifyLicenseFile(issue({ features: ["sso_magic"] }))).toThrow(
      /unknown feature: sso_magic/,
    );
    expect(() => verifyLicenseFile(issue({ org: "" }))).toThrow(/malformed/);
    expect(() => verifyLicenseFile(issue({ expires_at: "soon" }))).toThrow(/malformed/);
  });

  it("expiry is checked at use time, valid through the whole expiry day UTC", () => {
    const payload = verifyLicenseFile(issue({ expires_at: "2026-06-30" }));
    expect(licenseExpired(payload, new Date("2026-06-30T23:59:59Z"))).toBe(false);
    expect(licenseExpired(payload, new Date("2026-07-01T00:00:00Z"))).toBe(true);
  });
});

describe.runIf(TEST_DATABASE_URL)("the wall (spec 11)", () => {
  let dbUrl: string;
  let pool: Pool;

  beforeAll(async () => {
    __setLicensePublicKeyForTests(publicPem);
    dbUrl = await createScratchDb("license_test");
    await runMigrations({ databaseUrl: dbUrl, dir: MIGRATIONS_DIR });
    pool = new Pool({ connectionString: dbUrl, max: 3 });
  });

  afterAll(async () => {
    __setLicensePublicKeyForTests(null);
    await pool?.end();
    if (dbUrl) await dropScratchDb(dbUrl);
  });

  it("no license: every feature locked with the exact line", async () => {
    expect(await licenseStatus(pool)).toEqual({
      state: "none",
      org: null,
      issuedAt: null,
      expiresAt: null,
      features: [],
    });
    for (const feature of EE_FEATURES) {
      expect(await eeFeatureEnabled(feature, pool)).toBe(false);
    }
    const res = await requireEeFeature("audit_log", pool);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    expect(await res!.json()).toEqual({
      error: "Enterprise feature - contact hi@flowengine.cloud",
    });
    expect(EE_LOCKED_COPY).toBe("Enterprise feature - contact hi@flowengine.cloud");
  });

  it("a bad file is rejected before storage; a valid one unlocks its features", async () => {
    await expect(setLicenseFile("garbage", pool)).rejects.toThrow(LicenseError);
    expect((await licenseStatus(pool)).state).toBe("none");

    await setLicenseFile(issue({ features: ["okta_sync"] }), pool);
    const status = await licenseStatus(pool, new Date("2026-06-11T00:00:00Z"));
    expect(status.state).toBe("valid");
    expect(status.org).toBe("Acme Corp");
    expect(status.features).toEqual(["okta_sync"]);
    expect(await eeFeatureEnabled("okta_sync", pool, new Date("2026-06-11T00:00:00Z"))).toBe(true);
    expect(await eeFeatureEnabled("audit_log", pool, new Date("2026-06-11T00:00:00Z"))).toBe(false);
    expect(await requireEeFeature("okta_sync", pool)).toBeNull();
  });

  it("the wildcard grants everything; expiry locks it all again", async () => {
    await setLicenseFile(issue({ features: ["*"], expires_at: "2026-06-30" }), pool);
    const before = new Date("2026-06-15T12:00:00Z");
    const after = new Date("2026-07-02T12:00:00Z");
    for (const feature of EE_FEATURES) {
      expect(await eeFeatureEnabled(feature, pool, before)).toBe(true);
      expect(await eeFeatureEnabled(feature, pool, after)).toBe(false);
    }
    const expired = await licenseStatus(pool, after);
    expect(expired.state).toBe("expired");
    // The status still names the grant - the UI shows what expired - but
    // nothing unlocks.
    expect(expired.features).toEqual([...EE_FEATURES]);
  });

  it("a stored file that stops verifying (key rotation, DB edits) reads as none", async () => {
    await setLicenseFile(issue({}), pool);
    await pool.query(
      `UPDATE settings SET value = to_jsonb('{"v":1,"payload":"eyJvcmciOiJYIn0","signature":"AAAA"}'::text)
       WHERE key = 'license_file'`,
    );
    expect((await licenseStatus(pool)).state).toBe("none");
    expect(await eeFeatureEnabled("okta_sync", pool)).toBe(false);
  });
});
