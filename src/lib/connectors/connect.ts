import { Pool } from "pg";
import { getPool, type Db } from "../db";
import { wipeDemoData } from "../demo";
import { logger } from "../logger";
import {
  deleteSetting,
  getSecretSetting,
  setSecretSetting,
} from "../settings";
import { getConnector } from "./registry";
import type { Connector, ConnectorContext } from "./types";

/**
 * Connect / disconnect lifecycle. A connector is "connected" when its row
 * exists in the connectors table; its credentials live encrypted in
 * settings under connector:<vendor>:config and are decrypted only into a
 * sync's ConnectorContext - never logged, never stored plaintext.
 *
 * Connecting validates token scopes first (spec 5): a bad token never
 * creates a connectors row, and the vendor's error is surfaced verbatim.
 */

export interface ConnectorOpts {
  db?: Db;
  fetch?: typeof fetch;
  /** Secrets-key directory override (tests). */
  dataDir?: string;
}

export interface ConnectedRow {
  vendor: string;
  connected_at: Date;
  history_limit_days: number;
  scopes: string[];
}

function configKey(vendor: string): string {
  return `connector:${vendor}:config`;
}

export function buildContext(
  connector: Connector,
  config: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): ConnectorContext {
  return {
    config,
    fetch: fetchImpl,
    log: logger.child({ connector: connector.vendor }),
  };
}

export async function getConnectorConfig(
  vendor: string,
  opts: ConnectorOpts = {},
): Promise<Record<string, string> | null> {
  const db = opts.db ?? getPool();
  const raw = await getSecretSetting(configKey(vendor), db, opts.dataDir);
  return raw === null ? null : (JSON.parse(raw) as Record<string, string>);
}

/**
 * Validate scopes, store the encrypted config, mark the connector
 * connected. Reconnecting (new token) revalidates and replaces the config.
 * Throws the connector's scope/auth error verbatim on rejection.
 */
export async function connectConnector(
  vendor: string,
  config: Record<string, string>,
  opts: ConnectorOpts = {},
): Promise<ConnectedRow> {
  const connector = getConnector(vendor);
  if (!connector) throw new Error(`unknown connector: ${vendor}`);
  const db = opts.db ?? getPool();

  // Token scope validation on connect - before anything is stored.
  const check = await connector.validateScopes(
    buildContext(connector, config, opts.fetch),
  );

  // The first real connector wipes the demo dataset (spec 10, Onboarding).
  // It runs after the token validated and before anything is stored: a
  // failed wipe fails the connect cleanly, never mixes demo with real.
  await wipeDemoData(db instanceof Pool ? db : getPool());

  await setSecretSetting(configKey(vendor), JSON.stringify(config), db, opts.dataDir);
  const { rows } = await db.query(
    `INSERT INTO connectors (vendor, history_limit_days, scopes)
     VALUES ($1, $2, $3)
     ON CONFLICT (vendor) DO UPDATE SET
       history_limit_days = EXCLUDED.history_limit_days,
       scopes = EXCLUDED.scopes
     RETURNING vendor, connected_at, history_limit_days, scopes`,
    [vendor, connector.historyLimitDays, check.scopes],
  );
  logger.info("connector connected", { connector: vendor, scopes: check.scopes });
  return rows[0] as ConnectedRow;
}

/**
 * Disconnect: forget the credentials and stop syncing. Synced history
 * (facts, identities, rollups) stays - nothing hard-deletes (spec 4).
 */
export async function disconnectConnector(
  vendor: string,
  opts: ConnectorOpts = {},
): Promise<boolean> {
  const db = opts.db ?? getPool();
  const { rowCount } = await db.query(
    "DELETE FROM connectors WHERE vendor = $1",
    [vendor],
  );
  await deleteSetting(configKey(vendor), db);
  if ((rowCount ?? 0) > 0) {
    logger.info("connector disconnected", { connector: vendor });
    return true;
  }
  return false;
}

export async function connectedRow(
  vendor: string,
  db: Db = getPool(),
): Promise<ConnectedRow | null> {
  const { rows } = await db.query(
    `SELECT vendor, connected_at, history_limit_days, scopes
     FROM connectors WHERE vendor = $1`,
    [vendor],
  );
  return rows.length > 0 ? (rows[0] as ConnectedRow) : null;
}

export async function listConnectedRows(db: Db = getPool()): Promise<ConnectedRow[]> {
  const { rows } = await db.query(
    `SELECT vendor, connected_at, history_limit_days, scopes
     FROM connectors ORDER BY vendor`,
  );
  return rows as ConnectedRow[];
}
