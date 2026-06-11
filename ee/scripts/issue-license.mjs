#!/usr/bin/env node
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Issue an AI P&L enterprise license file (FlowEngine-internal; licenses
 * are sold direct, spec 11/14). Prints the license JSON the customer
 * pastes into Settings -> License.
 *
 *   node ee/scripts/issue-license.mjs \
 *     --key license-signing-key.pem \
 *     --org "Acme Corp" \
 *     --expires 2027-06-30 \
 *     --features '*'
 */

const FEATURES = [
  "okta_sync",
  "google_workspace",
  "more_admins",
  "audit_log",
  "multi_org",
  "scheduled_reports",
];

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const keyPath = arg("key");
const org = arg("org");
const expires = arg("expires");
const featuresArg = arg("features") ?? "*";

if (!keyPath || !org || !expires || !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
  console.error(
    "usage: issue-license.mjs --key <pem> --org <name> --expires YYYY-MM-DD [--features '*'|a,b,c]",
  );
  process.exit(1);
}

const features =
  featuresArg === "*" ? ["*"] : featuresArg.split(",").map((f) => f.trim());
const unknown = features.find((f) => f !== "*" && !FEATURES.includes(f));
if (unknown) {
  console.error(`unknown feature: ${unknown}\nknown: ${FEATURES.join(", ")}`);
  process.exit(1);
}

const payload = Buffer.from(
  JSON.stringify({
    org,
    issued_at: new Date().toISOString().slice(0, 10),
    expires_at: expires,
    features,
  }),
  "utf8",
).toString("base64url");

const signature = sign(
  null,
  Buffer.from(payload, "utf8"),
  createPrivateKey(readFileSync(keyPath, "utf8")),
).toString("base64url");

process.stdout.write(JSON.stringify({ v: 1, payload, signature }) + "\n");
