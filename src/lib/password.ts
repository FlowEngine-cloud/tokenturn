import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

/**
 * Password hashing for the WebAuthn fallback (spec 12b). scrypt from
 * node:crypto - zero dependencies. Parameters are encoded into each hash so
 * they can be raised later without invalidating existing hashes.
 *
 * Format: "scrypt:<N>:<r>:<p>:<salt b64>:<hash b64>".
 */

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

function maxmem(n: number, r: number): number {
  // node throws unless maxmem > 128 * N * r; double it for headroom.
  return 256 * n * r;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: maxmem(N, R),
  });
  return `scrypt:${N}:${R}:${P}:${salt.toString("base64")}:${key.toString("base64")}`;
}

export async function verifyPassword(
  password: string,
  stored: string | null,
): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await scrypt(password, salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: maxmem(n, r),
  });
  return timingSafeEqual(expected, actual);
}
