import type { Pool } from "pg";

/**
 * Ledger readers shared by connector tests: pull what a sync wrote, joined
 * to the identities/people it attributed, in a stable order so whole-ledger
 * snapshots can be compared against the recorded fixtures' expected files.
 */

export async function factRows(pool: Pool, vendor: string) {
  const { rows } = await pool.query(
    `SELECT f.source_ref AS "sourceRef", f.day::text AS day, f.model,
            f.tokens::int AS tokens, f.amount_cents::int AS "amountCents",
            f.currency, f.cost_basis AS "costBasis",
            i.external_id AS "identityExternalId", p.email AS "personEmail"
     FROM spend_facts f
     LEFT JOIN identities i ON i.id = f.identity_id
     LEFT JOIN people p ON p.id = f.person_id
     WHERE f.vendor = $1 ORDER BY f.source_ref`,
    [vendor],
  );
  return rows;
}

export async function identityRows(pool: Pool, vendor: string) {
  const { rows } = await pool.query(
    `SELECT i.external_id AS "externalId", i.kind, i.email,
            i.display_name AS "displayName", i.tags, p.email AS "personEmail"
     FROM identities i LEFT JOIN people p ON p.id = i.person_id
     WHERE i.vendor = $1 ORDER BY i.external_id`,
    [vendor],
  );
  return rows;
}

export async function metricRows(pool: Pool, vendor: string) {
  const { rows } = await pool.query(
    `SELECT m.source_ref AS "sourceRef", m.day::text AS day, m.metric,
            m.value::int AS value,
            i.external_id AS "identityExternalId", p.email AS "personEmail"
     FROM usage_metrics m
     LEFT JOIN identities i ON i.id = m.identity_id
     LEFT JOIN people p ON p.id = m.person_id
     WHERE m.vendor = $1 ORDER BY m.source_ref, m.metric`,
    [vendor],
  );
  return rows;
}

export async function lastRunRow(pool: Pool, vendor: string) {
  const { rows } = await pool.query(
    `SELECT id, status, cursor, error, rows_synced FROM sync_runs
     WHERE connector = $1 ORDER BY started_at DESC, id DESC LIMIT 1`,
    [vendor],
  );
  return rows[0];
}
