import { Client } from "pg";

/**
 * Scratch databases for tests. TEST_DATABASE_URL must point at a Postgres
 * server (any database); each test file creates a uniquely named database
 * and drops it afterwards.
 */

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function adminClient(): Client {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set");
  return new Client({ connectionString: TEST_DATABASE_URL });
}

export async function createScratchDb(prefix: string): Promise<string> {
  const name = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = adminClient();
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

export async function dropScratchDb(scratchUrl: string): Promise<void> {
  const name = new URL(scratchUrl).pathname.slice(1);
  const admin = adminClient();
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

export async function queryScratch<T extends Record<string, unknown>>(
  scratchUrl: string,
  sql: string,
): Promise<T[]> {
  const client = new Client({ connectionString: scratchUrl });
  await client.connect();
  try {
    const { rows } = await client.query(sql);
    return rows as T[];
  } finally {
    await client.end();
  }
}
