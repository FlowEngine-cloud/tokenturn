import type { Pool } from "pg";
import { getPool } from "./db";
import { parseCsv } from "./invoices";
import { logger } from "./logger";
import { reattribute, ResolveError } from "./resolve";
import { recomputeRollups } from "./rollup";

/**
 * People CSV roster import (spec 8 In): header auto-detect, preview before
 * commit with per-row errors, re-import upserts by email (case-insensitive)
 * and never removes anyone - offboard is the only exit.
 *
 * Importing a person also runs the standard identity machinery the other
 * way around: identities that synced before their person existed
 * (self-minted keys are auto-discovered, spec 8) auto-match by email now,
 * and the match re-attributes their FULL history (spec 4), rollups included.
 */

export interface PersonCsvRow {
  /** 1-based line in the uploaded file. */
  line: number;
  email: string | null;
  name: string | null;
  /** Why the row cannot import; null = importable. */
  error: string | null;
}

type PersonColumn = "email" | "name" | "first_name" | "last_name";

/** Common HR/IdP export header names mapped onto our columns. */
const HEADER_ALIASES: Record<string, PersonColumn> = {
  email: "email",
  e_mail: "email",
  mail: "email",
  work_email: "email",
  email_address: "email",
  primary_email: "email",
  name: "name",
  full_name: "name",
  display_name: "name",
  employee: "name",
  employee_name: "name",
  first_name: "first_name",
  given_name: "first_name",
  last_name: "last_name",
  surname: "last_name",
  family_name: "last_name",
};

function normalizeHeader(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ParsedPeopleCsv {
  rows: PersonCsvRow[];
  /** True when every row can import. */
  ok: boolean;
}

/**
 * Parse + validate a people CSV. Structural problems (no email column)
 * throw ResolveError(400); row problems land on the row so the preview can
 * show them. Name comes from a name column, or first+last joined.
 */
export function parsePeopleCsv(text: string): ParsedPeopleCsv {
  const records = parseCsv(text);
  if (records.length === 0) throw new ResolveError("the CSV is empty", 400);

  const columns = new Map<PersonColumn, number>();
  for (const [index, cell] of records[0].cells.entries()) {
    const role = HEADER_ALIASES[normalizeHeader(cell)];
    if (role && !columns.has(role)) columns.set(role, index);
  }
  if (!columns.has("email")) {
    throw new ResolveError(
      "the CSV header needs an email column (name is optional; extras are ignored)",
      400,
    );
  }
  if (records.length === 1) {
    throw new ResolveError("the CSV has a header but no rows", 400);
  }

  const seen = new Map<string, number>();
  const rows: PersonCsvRow[] = [];
  for (const record of records.slice(1)) {
    const cell = (role: PersonColumn): string =>
      columns.has(role) ? (record.cells[columns.get(role)!] ?? "").trim() : "";
    const row: PersonCsvRow = { line: record.line, email: null, name: null, error: null };

    const email = cell("email");
    if (!EMAIL_RE.test(email) || email.length > 254) {
      row.error = `bad email ${JSON.stringify(email)}`;
    } else {
      const key = email.toLowerCase();
      const firstLine = seen.get(key);
      if (firstLine !== undefined) {
        row.error = `duplicate of line ${firstLine}`;
      } else {
        seen.set(key, record.line);
        row.email = email;
      }
    }

    const name = cell("name") || [cell("first_name"), cell("last_name")].filter(Boolean).join(" ");
    row.name = name.slice(0, 200) || null;
    rows.push(row);
  }
  return { rows, ok: rows.every((row) => row.error === null) };
}

export interface ImportedPersonRow {
  line: number;
  email: string;
  name: string | null;
  id: string;
  action: "created" | "updated";
}

export interface PeopleImportResult {
  rows: ImportedPersonRow[];
  created: number;
  updated: number;
  /** Previously unmatched identities that auto-matched to imported people. */
  matchedIdentities: number;
  /** Re-attributed history rolled back up; null = nothing needed it. */
  rollups: { from: string | null; to: string | null };
}

/**
 * Commit importable rows: upsert by lower(email) - names never regress to
 * null, nobody is ever removed - then sweep unmatched identities for new
 * email matches and re-attribute their full history. All-or-nothing.
 * The directory syncs (ee: Okta, Google Workspace) reuse this with their
 * own source label; the in-flow semantics are identical to the CSV's.
 */
export async function importPeople(
  rows: PersonCsvRow[],
  pool: Pool = getPool(),
  source: "csv" | "okta" | "google" | "manual" = "csv",
): Promise<PeopleImportResult> {
  const importable = rows.filter(
    (row): row is PersonCsvRow & { email: string } => row.error === null && row.email !== null,
  );
  if (importable.length === 0) {
    throw new ResolveError("no importable rows", 400);
  }

  const client = await pool.connect();
  let span: { from: string | null; to: string | null } = { from: null, to: null };
  let result: PeopleImportResult;
  try {
    await client.query("BEGIN");
    const imported: ImportedPersonRow[] = [];
    for (const row of importable) {
      const { rows: upserted } = await client.query(
        `INSERT INTO people (email, name, source) VALUES ($1, $2, $3)
         ON CONFLICT ((lower(email))) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, people.name),
           source = $3,
           updated_at = now()
         RETURNING id, name, (xmax = 0) AS created`,
        [row.email, row.name, source],
      );
      imported.push({
        line: row.line,
        email: row.email,
        name: upserted[0].name,
        id: upserted[0].id,
        action: upserted[0].created ? "created" : "updated",
      });
    }

    // Auto-match sweep (spec 5/8): identities that synced before their
    // person existed map now; "not a person" decisions are never re-filled.
    const { rows: matches } = await client.query(
      `SELECT i.id, p.id AS person_id
       FROM identities i
       JOIN people p ON p.merged_into IS NULL AND lower(p.email) = lower(i.email)
       WHERE i.person_id IS NULL AND NOT i.not_person AND i.email IS NOT NULL`,
    );
    for (const match of matches) {
      await client.query("UPDATE identities SET person_id = $2, updated_at = now() WHERE id = $1", [
        match.id,
        match.person_id,
      ]);
      const touched = await reattribute(client, match.id, match.person_id);
      if (touched.from !== null) {
        span = {
          from: span.from === null || touched.from < span.from ? touched.from : span.from,
          to: span.to === null || touched.to! > span.to ? touched.to : span.to,
        };
      }
    }
    await client.query("COMMIT");

    result = {
      rows: imported,
      created: imported.filter((row) => row.action === "created").length,
      updated: imported.filter((row) => row.action === "updated").length,
      matchedIdentities: matches.length,
      rollups: { from: null, to: null },
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (span.from !== null && span.to !== null) {
    const { from, to } = await recomputeRollups({ from: span.from, to: span.to }, pool);
    result.rollups = { from, to };
  }
  logger.info("people imported", {
    created: result.created,
    updated: result.updated,
    matchedIdentities: result.matchedIdentities,
  });
  return result;
}
