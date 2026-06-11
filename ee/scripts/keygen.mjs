#!/usr/bin/env node
import { generateKeyPairSync } from "node:crypto";

/**
 * Generate an Ed25519 license-signing keypair. The private key (stdout) is
 * kept offline by FlowEngine and never ships; the public key (stderr) is
 * what src/lib/license.ts pins.
 *
 *   node ee/scripts/keygen.mjs > license-signing-key.pem
 */
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
process.stdout.write(privateKey.export({ type: "pkcs8", format: "pem" }));
process.stderr.write("Public key (pin in src/lib/license.ts):\n");
process.stderr.write(publicKey.export({ type: "spki", format: "pem" }));
