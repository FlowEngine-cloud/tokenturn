import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * Secrets at rest (spec 12b): vendor tokens and other secrets are encrypted
 * with AES-256-GCM. The key is auto-generated on first boot and written to
 * the data volume - it never leaves the machine and is never an env var.
 *
 * Token format: "v1:<iv b64>:<auth tag b64>:<ciphertext b64>".
 */

const KEY_FILENAME = "secrets.key";

const keyCache = new Map<string, Buffer>();

/**
 * The data volume. /data inside the container (created by the Dockerfile,
 * mounted as a volume in compose); ./.data for bare-metal dev where /data
 * doesn't exist or isn't writable.
 */
export function defaultDataDir(): string {
  try {
    accessSync("/data", constants.W_OK);
    return "/data";
  } catch {
    return path.join(process.cwd(), ".data");
  }
}

export function secretKeyPath(dataDir: string = defaultDataDir()): string {
  return path.join(path.resolve(dataDir), KEY_FILENAME);
}

function parseKeyFile(contents: string, file: string): Buffer {
  const hex = contents.trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`invalid secrets key file at ${file}`);
  }
  return Buffer.from(hex, "hex");
}

/**
 * Read the 32-byte secrets key, generating it on first boot. Generation is
 * race-safe: the exclusive "wx" write means a concurrent boot that loses the
 * race re-reads the winner's key.
 */
export function loadOrCreateSecretKey(
  dataDir: string = defaultDataDir(),
): Buffer {
  const file = secretKeyPath(dataDir);
  const cached = keyCache.get(file);
  if (cached) return cached;

  let key: Buffer;
  try {
    key = parseKeyFile(readFileSync(file, "utf8"), file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fresh = randomBytes(32);
    try {
      writeFileSync(file, fresh.toString("hex") + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      key = fresh;
    } catch (writeErr) {
      if ((writeErr as NodeJS.ErrnoException).code !== "EEXIST") throw writeErr;
      key = parseKeyFile(readFileSync(file, "utf8"), file);
    }
  }
  keyCache.set(file, key);
  return key;
}

/** Test-only: forget cached keys so the next load re-reads the file. */
export function clearSecretKeyCache(): void {
  keyCache.clear();
}

export function encryptSecret(
  plaintext: string,
  key: Buffer = loadOrCreateSecretKey(),
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptSecret(
  token: string,
  key: Buffer = loadOrCreateSecretKey(),
): string {
  const parts = token.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("malformed secret token");
  }
  const [, ivB64, tagB64, ciphertextB64] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
