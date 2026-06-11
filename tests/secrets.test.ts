import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSecretKeyCache,
  decryptSecret,
  encryptSecret,
  loadOrCreateSecretKey,
  secretKeyPath,
} from "../src/lib/secrets";

function tmpDataDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "ai-pnl-secrets-"));
}

describe("secrets", () => {
  const dirs: string[] = [];

  afterEach(() => {
    clearSecretKeyCache();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("generates a 32-byte key on first boot, owner-only, and reuses it after", () => {
    const dir = tmpDataDir();
    dirs.push(dir);

    const key = loadOrCreateSecretKey(dir);
    expect(key).toHaveLength(32);

    const file = secretKeyPath(dir);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").trim()).toBe(key.toString("hex"));

    // a later boot reads the same key back (cache cleared = fresh process)
    clearSecretKeyCache();
    expect(loadOrCreateSecretKey(dir).equals(key)).toBe(true);
  });

  it("round-trips secrets, including unicode", () => {
    const dir = tmpDataDir();
    dirs.push(dir);
    const key = loadOrCreateSecretKey(dir);

    for (const secret of ["sk-ant-api03-abc123", "hé🔐 token\nwith newline", ""]) {
      const token = encryptSecret(secret, key);
      expect(token.startsWith("v1:")).toBe(true);
      expect(token).not.toContain(secret || "::never::");
      expect(decryptSecret(token, key)).toBe(secret);
    }
  });

  it("never produces the same ciphertext twice (fresh IV per call)", () => {
    const dir = tmpDataDir();
    dirs.push(dir);
    const key = loadOrCreateSecretKey(dir);
    expect(encryptSecret("same", key)).not.toBe(encryptSecret("same", key));
  });

  it("rejects tampered ciphertext, the wrong key, and malformed tokens", () => {
    const dir = tmpDataDir();
    dirs.push(dir);
    const key = loadOrCreateSecretKey(dir);
    const token = encryptSecret("payload", key);

    const parts = token.split(":");
    const flipped = Buffer.from(parts[3], "base64");
    flipped[0] ^= 0xff;
    const tampered = [parts[0], parts[1], parts[2], flipped.toString("base64")].join(":");
    expect(() => decryptSecret(tampered, key)).toThrow();

    const otherDir = tmpDataDir();
    dirs.push(otherDir);
    const otherKey = loadOrCreateSecretKey(otherDir);
    expect(() => decryptSecret(token, otherKey)).toThrow();

    expect(() => decryptSecret("not-a-token", key)).toThrow(/malformed/);
    expect(() => decryptSecret("v2:a:b:c", key)).toThrow(/malformed/);
  });

  it("refuses a corrupted key file instead of silently regenerating", () => {
    const dir = tmpDataDir();
    dirs.push(dir);
    loadOrCreateSecretKey(dir);
    clearSecretKeyCache();
    writeFileSync(secretKeyPath(dir), "garbage\n");
    expect(() => loadOrCreateSecretKey(dir)).toThrow(/invalid secrets key file/);
  });
});
