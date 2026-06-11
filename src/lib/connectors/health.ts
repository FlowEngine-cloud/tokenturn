import { getPool, type Db } from "../db";
import { getSetting } from "../settings";
import { listConnectedRows, type ConnectedRow } from "./connect";
import { listConnectors } from "./registry";
import type { ConfigField, Connector, SyncCursor } from "./types";

/**
 * Health surface (spec 5): last sync, row counts, the vendor's error
 * verbatim, and whether the connector has gone silent. Everything here is
 * read straight from sync_runs and the fact tables - no cached status that
 * can drift from the data.
 */

export interface SyncRunSummary {
  id: number;
  status: "running" | "success" | "error";
  startedAt: string;
  finishedAt: string | null;
  rowsSynced: number;
  /** The vendor's error, verbatim. */
  error: string | null;
}

export interface ConnectorHealth {
  vendor: string;
  displayName: string;
  connected: boolean;
  connectedAt: string | null;
  /** How far back history goes - the connect screen shows this (spec 5). */
  historyLimitDays: number;
  /** Vendor limits the connect screen states verbatim (spec 5). */
  connectNotes: string[];
  /** Credential fields the connect screen collects. */
  configFields: ConfigField[];
  scopes: string[];
  lastRun: SyncRunSummary | null;
  lastSuccessAt: string | null;
  /** Backfill/resume window currently in flight, when a run is mid-window. */
  inProgress: { since: string; until: string } | null;
  rowCounts: { spendFacts: number; identities: number; metrics: number };
  /** No successful sync for connector_silent_alert_hours (default 24). */
  silent: boolean;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function healthFor(
  connector: Connector,
  connectedRowOrNull: ConnectedRow | null,
  silentAfterMs: number,
  now: Date,
  db: Db,
): Promise<ConnectorHealth> {
  const vendor = connector.vendor;
  const { rows: runs } = await db.query(
    `SELECT id, status, started_at, finished_at, rows_synced, error, cursor
     FROM sync_runs WHERE connector = $1
     ORDER BY started_at DESC, id DESC LIMIT 1`,
    [vendor],
  );
  const { rows: success } = await db.query(
    `SELECT finished_at FROM sync_runs
     WHERE connector = $1 AND status = 'success'
     ORDER BY finished_at DESC LIMIT 1`,
    [vendor],
  );
  const { rows: counts } = await db.query(
    `SELECT
       (SELECT count(*) FROM spend_facts WHERE vendor = $1) AS facts,
       (SELECT count(*) FROM identities WHERE vendor = $1) AS identities,
       (SELECT count(*) FROM usage_metrics WHERE vendor = $1) AS metrics`,
    [vendor],
  );

  const lastRun = runs[0] ?? null;
  let inProgress: ConnectorHealth["inProgress"] = null;
  if (lastRun && lastRun.status !== "success" && lastRun.cursor) {
    try {
      const cursor = JSON.parse(lastRun.cursor) as SyncCursor;
      if (cursor.inProgress) {
        inProgress = { since: cursor.inProgress.since, until: cursor.inProgress.until };
      }
    } catch {
      // Unreadable cursor: health still renders, just without the window.
    }
  }

  const lastSuccessAt = iso(success[0]?.finished_at ?? null);
  // Silent = connected but no successful sync inside the threshold; a
  // connector that never synced counts from when it was connected.
  const sinceMs = lastSuccessAt
    ? Date.parse(lastSuccessAt)
    : connectedRowOrNull
      ? new Date(connectedRowOrNull.connected_at).getTime()
      : null;
  const silent =
    connectedRowOrNull !== null && sinceMs !== null && now.getTime() - sinceMs >= silentAfterMs;

  return {
    vendor,
    displayName: connector.displayName,
    connected: connectedRowOrNull !== null,
    connectedAt: connectedRowOrNull ? iso(connectedRowOrNull.connected_at) : null,
    historyLimitDays:
      connectedRowOrNull?.history_limit_days ?? connector.historyLimitDays,
    connectNotes: connector.connectNotes ?? [],
    configFields: connector.configFields ?? [],
    scopes: connectedRowOrNull?.scopes ?? [],
    lastRun: lastRun
      ? {
          id: Number(lastRun.id),
          status: lastRun.status,
          startedAt: iso(lastRun.started_at)!,
          finishedAt: iso(lastRun.finished_at),
          rowsSynced: Number(lastRun.rows_synced ?? 0),
          error: lastRun.error,
        }
      : null,
    lastSuccessAt,
    inProgress,
    rowCounts: {
      spendFacts: Number(counts[0].facts),
      identities: Number(counts[0].identities),
      metrics: Number(counts[0].metrics),
    },
    silent,
  };
}

/** Health for every registered connector (connected or not). */
export async function allConnectorHealth(
  db: Db = getPool(),
  now: Date = new Date(),
): Promise<ConnectorHealth[]> {
  const silentHours = await getSetting("connector_silent_alert_hours", db);
  const silentAfterMs = silentHours * 3_600_000;
  const connected = new Map(
    (await listConnectedRows(db)).map((row) => [row.vendor, row]),
  );
  const out: ConnectorHealth[] = [];
  for (const connector of listConnectors()) {
    out.push(
      await healthFor(
        connector,
        connected.get(connector.vendor) ?? null,
        silentAfterMs,
        now,
        db,
      ),
    );
  }
  return out;
}

export async function connectorHealth(
  vendor: string,
  db: Db = getPool(),
  now: Date = new Date(),
): Promise<ConnectorHealth | null> {
  const all = await allConnectorHealth(db, now);
  return all.find((h) => h.vendor === vendor) ?? null;
}
