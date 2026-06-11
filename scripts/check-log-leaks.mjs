#!/usr/bin/env node
import { readFileSync } from "node:fs";

/**
 * Spec 12: CI greps logs for leaked token patterns. Reads one or more log
 * files plus an optional JSON file of planted canary secrets (the smoke
 * scenario's last stdout line) and fails when any secret-shaped string -
 * or any literal canary - appears in the logs.
 *
 *   node scripts/check-log-leaks.mjs --canaries canaries.json server.log ...
 */

// Secret shapes for every credential the app handles (vendor tokens, Slack
// webhook paths, email keys, AWS keys, private keys, session cookies).
const PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{12,}/g, "anthropic admin key"],
  [/sk-[A-Za-z0-9_-]{20,}/g, "openai key"],
  [/ghp_[A-Za-z0-9]{20,}/g, "github classic PAT"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "github fine-grained PAT"],
  [/key_[A-Za-z0-9]{20,}/g, "cursor api key"],
  [/re_[A-Za-z0-9_]{20,}/g, "resend api key"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "slack token"],
  [/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g, "slack webhook path"],
  [/AKIA[0-9A-Z]{16}/g, "aws access key id"],
  [/-----BEGIN[A-Z ]*PRIVATE KEY-----/g, "private key material"],
  [/SSWS [A-Za-z0-9._-]{10,}/g, "okta token header"],
  [/"password"\s*:\s*"[^"]+"/g, "password field"],
  [/ai_pnl_session=[A-Za-z0-9_-]{16,}/g, "session token"],
];

const args = process.argv.slice(2);
let canaries = [];
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--canaries") {
    const raw = readFileSync(args[++i], "utf8").trim().split("\n").at(-1);
    canaries = JSON.parse(raw).canaries ?? [];
  } else {
    files.push(args[i]);
  }
}
if (files.length === 0) {
  console.error("usage: check-log-leaks.mjs [--canaries canaries.json] <logfile>...");
  process.exit(2);
}

const redact = (s) => (s.length <= 12 ? "***" : `${s.slice(0, 6)}…${s.slice(-3)} (${s.length} chars)`);

let leaks = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const canary of canaries) {
    let at = -1;
    while ((at = text.indexOf(canary, at + 1)) !== -1) {
      leaks += 1;
      const line = text.slice(text.lastIndexOf("\n", at) + 1, text.indexOf("\n", at));
      console.error(`LEAK ${file}: planted canary ${redact(canary)} in: ${line.slice(0, 160)}`);
    }
  }
  for (const [pattern, label] of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      leaks += 1;
      const at = match.index ?? 0;
      const line = text.slice(text.lastIndexOf("\n", at) + 1, text.indexOf("\n", at));
      console.error(`LEAK ${file}: ${label} ${redact(match[0])} in: ${line.slice(0, 160)}`);
    }
  }
}

if (leaks > 0) {
  console.error(`\n${leaks} leaked secret(s) found in logs`);
  process.exit(1);
}
console.error(`logs clean: ${files.join(", ")}`);
