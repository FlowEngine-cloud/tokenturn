/**
 * reset-admin (spec 12b): `docker exec <container> reset-admin` prints a
 * one-time reset link for the admin - the recovery path for a lost passkey.
 *
 * The link is valid 30 minutes and single use; minting a new one voids any
 * unused older link. Only the token's sha256 ever touches the database.
 */

import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";

const TOKEN_TTL_MINUTES = 30;

/** Mint a reset token for the one admin. Returns { token, admin }. */
export async function mintResetToken({ databaseUrl }) {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT id, name FROM users WHERE role = 'admin'",
    );
    if (rows.length === 0) {
      throw new Error(
        "no admin exists yet - open the app in a browser to claim it first",
      );
    }
    const admin = rows[0];
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await client.query(
      "DELETE FROM reset_tokens WHERE user_id = $1 AND used_at IS NULL",
      [admin.id],
    );
    await client.query(
      `INSERT INTO reset_tokens (token_hash, user_id, expires_at)
       VALUES ($1, $2, now() + interval '${TOKEN_TTL_MINUTES} minutes')`,
      [tokenHash, admin.id],
    );
    return { token, admin };
  } finally {
    await client.end();
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  mintResetToken({ databaseUrl: process.env.DATABASE_URL })
    .then(({ token, admin }) => {
      process.stdout.write(
        [
          "",
          `One-time reset link for admin "${admin.name}"`,
          `(valid ${TOKEN_TTL_MINUTES} minutes, single use):`,
          "",
          `  /reset/${token}`,
          "",
          "Open it on this instance's URL, e.g.:",
          "",
          `  http://localhost:3000/reset/${token}`,
          "",
        ].join("\n"),
      );
    })
    .catch((err) => {
      process.stderr.write(`reset-admin: ${err.message}\n`);
      process.exit(1);
    });
}
