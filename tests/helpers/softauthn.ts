import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";

/**
 * A software WebAuthn authenticator for tests: real P-256 keys, real CBOR,
 * real signatures - it drives the production verification path end-to-end.
 * Nothing under test is mocked; a broken verifier fails these responses.
 */

// ---- minimal CBOR encoder (definite lengths only) ----

function head(major: number, len: number): Buffer {
  if (len < 24) return Buffer.from([(major << 5) | len]);
  if (len < 0x100) return Buffer.from([(major << 5) | 24, len]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(len, 1);
  return b;
}

export function cbor(value: unknown): Buffer {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const buf = Buffer.from(value);
    return Buffer.concat([head(2, buf.length), buf]);
  }
  if (typeof value === "string") {
    const buf = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, buf.length), buf]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  }
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const parts = [head(5, entries.length)];
    for (const [k, v] of entries) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  throw new Error(`cbor: unsupported value ${String(value)}`);
}

// ---- the authenticator ----

interface Overrides {
  /** Lie about the challenge in clientDataJSON. */
  challenge?: string;
  /** Lie about the origin in clientDataJSON. */
  origin?: string;
  /** Corrupt the assertion signature. */
  corruptSignature?: boolean;
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export class SoftAuthenticator {
  private readonly credentialId = randomBytes(16);
  private readonly keys = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  private counter = 0;

  get credentialIdB64(): string {
    return this.credentialId.toString("base64url");
  }

  private cosePublicKey(): Buffer {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    return cbor(
      new Map<number, unknown>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x as string, "base64url")],
        [-3, Buffer.from(jwk.y as string, "base64url")],
      ]),
    );
  }

  /** navigator.credentials.create() for the given registration options. */
  register(
    options: { challenge: string; rp: { id?: string } },
    origin: string,
    overrides: Overrides = {},
  ) {
    const rpId = options.rp.id ?? new URL(origin).hostname;
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: "webauthn.create",
        challenge: overrides.challenge ?? options.challenge,
        origin: overrides.origin ?? origin,
        crossOrigin: false,
      }),
    );
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      createHash("sha256").update(rpId).digest(),
      Buffer.from([FLAG_UP | FLAG_UV | FLAG_AT]),
      Buffer.alloc(4), // counter 0 at registration
      Buffer.alloc(16), // aaguid
      credIdLen,
      this.credentialId,
      this.cosePublicKey(),
    ]);
    return {
      id: this.credentialIdB64,
      rawId: this.credentialIdB64,
      type: "public-key" as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        attestationObject: cbor({
          fmt: "none",
          attStmt: {},
          authData,
        }).toString("base64url"),
        transports: ["internal" as const],
      },
    };
  }

  /** navigator.credentials.get() for the given authentication options. */
  authenticate(
    options: { challenge: string; rpId?: string },
    origin: string,
    overrides: Overrides = {},
  ) {
    this.counter += 1;
    const rpId = options.rpId ?? new URL(origin).hostname;
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: overrides.challenge ?? options.challenge,
        origin: overrides.origin ?? origin,
        crossOrigin: false,
      }),
    );
    const counterBuf = Buffer.alloc(4);
    counterBuf.writeUInt32BE(this.counter);
    const authData = Buffer.concat([
      createHash("sha256").update(rpId).digest(),
      Buffer.from([FLAG_UP | FLAG_UV]),
      counterBuf,
    ]);
    const signature = createSign("SHA256")
      .update(
        Buffer.concat([
          authData,
          createHash("sha256").update(clientDataJSON).digest(),
        ]),
      )
      .sign(this.keys.privateKey);
    if (overrides.corruptSignature) signature[signature.length - 1] ^= 0xff;
    return {
      id: this.credentialIdB64,
      rawId: this.credentialIdB64,
      type: "public-key" as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: signature.toString("base64url"),
      },
    };
  }
}
