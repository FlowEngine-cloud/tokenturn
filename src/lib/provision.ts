import {
  anthropicConnector,
  archiveAnthropicApiKey,
  deleteAnthropicUser,
  inviteAnthropicUser,
} from "./connectors/anthropic";
import {
  buildContext,
  getConnectorConfig,
  type ConnectorOpts,
} from "./connectors/connect";
import { cursorConnector, removeCursorMember } from "./connectors/cursor";
import {
  addCopilotSeat,
  githubConnector,
  removeCopilotSeat,
} from "./connectors/github";
import {
  deleteOpenAiApiKey,
  deleteOpenAiUser,
  inviteOpenAiUser,
  listOpenAiProjects,
  mintOpenAiKey,
  openaiConnector,
} from "./connectors/openai";
import type { Connector, ConnectorContext } from "./connectors/types";
import { audit, type AuditActor } from "./audit";
import { getPool, type Db } from "./db";
import { logger } from "./logger";
import { ResolveError } from "./resolve";

/**
 * People in / out (spec 8): invite fan-out, OpenAI key minting, and the
 * offboard sweep. Everything here calls vendor write APIs through the
 * connector modules (shared auth + verbatim-error convention) and never
 * pretends: a vendor rejection comes back word for word, per person per
 * tool, and a failed offboard item stays retryable one by one.
 */

const CONNECTORS: Record<string, Connector> = {
  anthropic: anthropicConnector,
  cursor: cursorConnector,
  github: githubConnector,
  openai: openaiConnector,
};

/**
 * Vendors whose APIs can actually grant a seat. Cursor is absent on
 * purpose: its Admin API has no invite endpoint (members are added from the
 * Cursor dashboard) - offering it would be a control that can never work.
 */
export const INVITE_VENDORS = ["anthropic", "github", "openai"] as const;
export type InviteVendor = (typeof INVITE_VENDORS)[number];

/** The vendor access an offboard sweep can actually remove, per vendor. */
const REMOVABLE_SQL = `(
       (i.vendor = 'openai' AND i.kind IN ('user', 'api_key'))
    OR (i.vendor = 'anthropic' AND i.kind IN ('user', 'api_key'))
    OR (i.vendor = 'cursor' AND i.kind = 'user')
    OR (i.vendor = 'github' AND i.kind = 'seat'))`;

async function vendorContext(
  vendor: string,
  opts: ConnectorOpts,
): Promise<ConnectorContext> {
  const connector = CONNECTORS[vendor];
  if (!connector) throw new ResolveError(`unknown vendor ${vendor}`, 400);
  const config = await getConnectorConfig(vendor, opts);
  if (config === null) {
    throw new Error(
      `${connector.displayName} is not connected - connect it in Settings first`,
    );
  }
  return buildContext(connector, config, opts.fetch);
}

// ---------------------------------------------------------------------------
// Invite fan-out (spec 8 In)

export interface InviteResult {
  personId: string;
  email: string;
  vendor: InviteVendor;
  ok: boolean;
  /** What happened, when it worked. */
  detail: string | null;
  /** The vendor's error verbatim (or our connect-state error), when it didn't. */
  error: string | null;
}

interface InvitePerson {
  id: string;
  email: string;
  githubLogin: string | null;
}

async function inviteOne(
  vendor: InviteVendor,
  ctx: ConnectorContext,
  person: InvitePerson,
): Promise<string> {
  switch (vendor) {
    case "openai":
      await inviteOpenAiUser(ctx, person.email);
      return "added to the org (reader role) - they confirm by email";
    case "anthropic":
      await inviteAnthropicUser(ctx, person.email);
      return "added to the org (user role) - they confirm by email";
    case "github": {
      // Copilot's seat API is username-keyed, never email-keyed.
      if (person.githubLogin === null) {
        throw new Error(
          `no GitHub user is mapped to ${person.email} - sync GitHub and match them in Resolve first`,
        );
      }
      await addCopilotSeat(ctx, ctx.config.org ?? "", person.githubLogin);
      return `Copilot seat assigned (@${person.githubLogin})`;
    }
  }
}

/**
 * Invite people to tools: every (person, vendor) pair gets its own result,
 * success or the error verbatim - one vendor failing never blocks the rest.
 */
export async function inviteFanout(
  personIds: string[],
  vendors: string[],
  opts: ConnectorOpts = {},
): Promise<InviteResult[]> {
  const db = opts.db ?? getPool();
  const badVendor = vendors.find(
    (v) => !(INVITE_VENDORS as readonly string[]).includes(v),
  );
  if (badVendor !== undefined) {
    throw new ResolveError(`unknown vendor ${badVendor}`, 400);
  }
  if (personIds.length === 0 || vendors.length === 0) {
    throw new ResolveError("pick at least one person and one tool", 400);
  }

  const { rows: peopleRows } = await db.query(
    `SELECT p.id, p.email, p.status, p.merged_into AS "mergedInto", gh.login
     FROM people p
     LEFT JOIN LATERAL (
       SELECT i.display_name AS login FROM identities i
       WHERE i.person_id = p.id AND i.vendor = 'github' AND i.kind = 'user'
         AND i.display_name IS NOT NULL
       ORDER BY i.updated_at DESC LIMIT 1
     ) gh ON true
     WHERE p.id = ANY ($1)`,
    [personIds],
  );
  const byId = new Map(peopleRows.map((row) => [row.id as string, row]));
  const missing = personIds.find((id) => !byId.has(id));
  if (missing !== undefined) {
    throw new ResolveError(`no person with id ${missing}`, 404);
  }

  const results: InviteResult[] = [];
  for (const vendor of vendors as InviteVendor[]) {
    // One connect-state check per vendor; not-connected fails every pair
    // for that vendor with the same honest message.
    let ctx: ConnectorContext | null = null;
    let ctxError: string | null = null;
    try {
      ctx = await vendorContext(vendor, opts);
    } catch (err) {
      ctxError = err instanceof Error ? err.message : String(err);
    }
    for (const personId of personIds) {
      const row = byId.get(personId)!;
      const base = { personId, email: row.email as string, vendor };
      if (row.mergedInto !== null) {
        results.push({ ...base, ok: false, detail: null, error: "person was merged - add the surviving person instead" });
        continue;
      }
      if (row.status !== "active") {
        results.push({ ...base, ok: false, detail: null, error: `person is ${row.status}` });
        continue;
      }
      if (ctx === null) {
        results.push({ ...base, ok: false, detail: null, error: ctxError });
        continue;
      }
      try {
        const detail = await inviteOne(vendor, ctx, {
          id: personId,
          email: row.email,
          githubLogin: row.login ?? null,
        });
        results.push({ ...base, ok: true, detail, error: null });
      } catch (err) {
        results.push({
          ...base,
          ok: false,
          detail: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  logger.info("invite fan-out finished", {
    people: personIds.length,
    vendors,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  });
  return results;
}

// ---------------------------------------------------------------------------
// OpenAI key minting (spec 8 In: minted via API, shown once, never saved)

/** Minting needs a project and the org has several - the caller must pick. */
export class ProjectChoiceError extends ResolveError {
  constructor(readonly projects: { id: string; name: string }[]) {
    super("pick the OpenAI project to mint the key in", 409);
  }
}

export interface MintedKeyForPerson {
  /** The plaintext key - returned exactly once, never stored, never logged. */
  apiKey: string;
  keyId: string;
  identityId: string;
  projectId: string;
  name: string;
}

/**
 * Mint an OpenAI key for a person and map it to them immediately, so its
 * spend attributes from the first sync. The key value goes back to the
 * caller once; only the vendor's key id is stored (as the identity).
 */
export async function mintOpenAiKeyForPerson(
  personId: string,
  projectId: string | null,
  opts: ConnectorOpts = {},
): Promise<MintedKeyForPerson> {
  const db = opts.db ?? getPool();
  const { rows } = await db.query(
    `SELECT id, email, status, merged_into AS "mergedInto"
     FROM people WHERE id = $1`,
    [personId],
  );
  if (rows.length === 0) throw new ResolveError("person not found", 404);
  if (rows[0].mergedInto !== null) {
    throw new ResolveError("person was merged - mint for the surviving person", 409);
  }
  if (rows[0].status !== "active") {
    throw new ResolveError(`person is ${rows[0].status}`, 409);
  }

  const ctx = await vendorContext("openai", opts);
  let target = projectId;
  if (target === null) {
    const projects = await listOpenAiProjects(ctx);
    if (projects.length === 0) {
      throw new ResolveError("the OpenAI organization has no active project", 409);
    }
    if (projects.length > 1) throw new ProjectChoiceError(projects);
    target = projects[0].id;
  }

  // The key is named after its person - the name becomes the key's tag
  // (spec 7b) and says what it's for on every page.
  const minted = await mintOpenAiKey(ctx, target, rows[0].email);
  const { rows: identityRows } = await db.query(
    `INSERT INTO identities (vendor, external_id, kind, display_name, tags, person_id)
     VALUES ('openai', $1, 'api_key', $2, ARRAY[$2], $3)
     ON CONFLICT (vendor, external_id, kind) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       tags = EXCLUDED.tags,
       person_id = COALESCE(identities.person_id, EXCLUDED.person_id),
       updated_at = now()
     RETURNING id`,
    [minted.keyId, minted.name, personId],
  );
  // Never log the key value (spec 12: CI greps logs for token patterns).
  logger.info("openai key minted", {
    personId,
    keyId: minted.keyId,
    projectId: target,
  });
  return {
    apiKey: minted.apiKey,
    keyId: minted.keyId,
    identityId: identityRows[0].id,
    projectId: target,
    name: minted.name,
  };
}

// ---------------------------------------------------------------------------
// Offboard (spec 8 Out)

export interface OffboardRow {
  /** offboard_items id once the sweep planned it; null = not swept yet. */
  itemId: string | null;
  identityId: string | null;
  vendor: string;
  externalId: string;
  kind: string;
  displayName: string | null;
  /** active = current access, untouched. The rest mirror offboard_items. */
  status: "active" | "pending" | "failed" | "removed";
  error: string | null;
  removedAt: string | null;
}

export interface OffboardOverview {
  person: { id: string; email: string; name: string | null; status: string };
  items: OffboardRow[];
}

async function loadPerson(
  personId: string,
  db: Db,
): Promise<{ id: string; email: string; name: string | null; status: string }> {
  const { rows } = await db.query(
    `SELECT id, email, name, status, merged_into AS "mergedInto"
     FROM people WHERE id = $1`,
    [personId],
  );
  if (rows.length === 0) throw new ResolveError("person not found", 404);
  if (rows[0].mergedInto !== null) {
    throw new ResolveError("person was merged - offboard the surviving person", 409);
  }
  return { id: rows[0].id, email: rows[0].email, name: rows[0].name, status: rows[0].status };
}

/**
 * Everything offboarding touches for one person: their removable keys and
 * seats across every vendor, with the sweep state of each (active /
 * pending / failed with the vendor's error / removed). History kept -
 * removed items stay listed forever.
 */
export async function offboardOverview(
  personId: string,
  db: Db = getPool(),
): Promise<OffboardOverview> {
  const person = await loadPerson(personId, db);
  const { rows } = await db.query(
    `SELECT i.id AS "identityId", oi.id AS "itemId",
            i.vendor, i.external_id AS "externalId", i.kind,
            i.display_name AS "displayName",
            oi.status, oi.error, oi.removed_at AS "removedAt"
     FROM identities i
     LEFT JOIN offboard_items oi ON oi.identity_id = i.id
     WHERE i.person_id = $1 AND ${REMOVABLE_SQL}
     ORDER BY i.vendor, i.kind, i.external_id`,
    [personId],
  );
  return {
    person,
    items: rows.map((row) => ({
      itemId: row.itemId,
      identityId: row.identityId,
      vendor: row.vendor,
      externalId: row.externalId,
      kind: row.kind,
      displayName: row.displayName,
      status: (row.status as OffboardRow["status"] | null) ?? "active",
      error: row.error,
      removedAt: row.removedAt === null ? null : new Date(row.removedAt).toISOString(),
    })),
  };
}

async function removeOne(item: ItemRow, opts: ConnectorOpts): Promise<void> {
  const { vendor, kind, externalId, displayName } = item;
  const ctx = await vendorContext(vendor, opts);
  if (vendor === "openai" && kind === "user") return deleteOpenAiUser(ctx, externalId);
  if (vendor === "openai" && kind === "api_key") return deleteOpenAiApiKey(ctx, externalId);
  if (vendor === "anthropic" && kind === "user") return deleteAnthropicUser(ctx, externalId);
  if (vendor === "anthropic" && kind === "api_key") {
    return archiveAnthropicApiKey(ctx, externalId);
  }
  if (vendor === "cursor" && kind === "user") {
    // /teams/remove-member is email-keyed for us: its userId variant wants
    // the encoded user_... id, which is not the numeric roster id we hold.
    if (item.email === null) {
      throw new Error("the member has no email on record - sync Cursor first");
    }
    return removeCursorMember(ctx, item.email);
  }
  if (vendor === "github" && kind === "seat") {
    if (displayName === null) {
      throw new Error("the seat has no GitHub login on record - sync GitHub first");
    }
    return removeCopilotSeat(ctx, ctx.config.org ?? "", displayName);
  }
  throw new Error(`nothing to remove for ${vendor} ${kind}`);
}

interface ItemRow {
  id: string;
  personId: string;
  identityId: string | null;
  vendor: string;
  externalId: string;
  kind: string;
  displayName: string | null;
  /** The identity's vendor-side email (cursor removal is email-keyed). */
  email: string | null;
}

/** Run one item against the vendor and persist the outcome. */
async function executeItem(item: ItemRow, opts: ConnectorOpts): Promise<OffboardRow> {
  const db = opts.db ?? getPool();
  try {
    await removeOne(item, opts);
    const { rows } = await db.query(
      `UPDATE offboard_items
       SET status = 'removed', error = NULL, removed_at = now(), updated_at = now()
       WHERE id = $1 RETURNING removed_at AS "removedAt"`,
      [item.id],
    );
    if (item.identityId !== null) {
      // The identity row stays - history kept - it just stops being
      // current access (and never re-plans into another sweep).
      await db.query(
        `UPDATE identities SET deprovisioned_at = now(), updated_at = now()
         WHERE id = $1 AND deprovisioned_at IS NULL`,
        [item.identityId],
      );
    }
    logger.info("offboard item removed", {
      itemId: item.id,
      personId: item.personId,
      vendor: item.vendor,
      kind: item.kind,
    });
    return {
      itemId: item.id,
      identityId: item.identityId,
      vendor: item.vendor,
      externalId: item.externalId,
      kind: item.kind,
      displayName: item.displayName,
      status: "removed",
      error: null,
      removedAt: new Date(rows[0].removedAt).toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.query(
      `UPDATE offboard_items
       SET status = 'failed', error = $2, updated_at = now()
       WHERE id = $1`,
      [item.id, message],
    );
    logger.error("offboard item failed", {
      itemId: item.id,
      personId: item.personId,
      vendor: item.vendor,
      kind: item.kind,
      error: message,
    });
    return {
      itemId: item.id,
      identityId: item.identityId,
      vendor: item.vendor,
      externalId: item.externalId,
      kind: item.kind,
      displayName: item.displayName,
      status: "failed",
      error: message,
      removedAt: null,
    };
  }
}

const ITEM_COLUMNS = `oi.id, oi.person_id AS "personId", oi.identity_id AS "identityId",
       oi.vendor, oi.external_id AS "externalId", oi.kind,
       oi.display_name AS "displayName", i.email`;

/**
 * The offboard sweep: plan an item for every piece of current access (the
 * partial unique index makes re-runs retry existing failures instead of
 * stacking duplicates), mark the person offboarded - excluded from current
 * burn checks, history intact - then remove every item at its vendor,
 * recording each outcome. Failed items keep the vendor's error verbatim
 * and stay retryable one by one.
 */
export async function runOffboard(
  personId: string,
  opts: ConnectorOpts & { actor?: AuditActor } = {},
): Promise<OffboardOverview> {
  const db = opts.db ?? getPool();
  await loadPerson(personId, db); // 404 unknown / 409 merged-away

  const { rows: logins } = await db.query(
    "SELECT id, role FROM users WHERE person_id = $1",
    [personId],
  );
  const login = logins[0] as { id: string; role: string } | undefined;
  if (login && opts.actor !== "system" && opts.actor?.id === login.id) {
    throw new ResolveError("you cannot offboard yourself", 403);
  }
  if (login?.role === "admin") {
    const { rows } = await db.query(
      "SELECT count(*)::int AS admins FROM users WHERE role = 'admin'",
    );
    if (rows[0].admins <= 1) {
      throw new ResolveError("the last admin cannot be offboarded", 403);
    }
  }

  await db.query(
    `INSERT INTO offboard_items
       (person_id, identity_id, vendor, external_id, kind, display_name)
     SELECT i.person_id, i.id, i.vendor, i.external_id, i.kind, i.display_name
     FROM identities i
     WHERE i.person_id = $1 AND i.deprovisioned_at IS NULL AND ${REMOVABLE_SQL}
     ON CONFLICT (identity_id) WHERE status <> 'removed' DO NOTHING`,
    [personId],
  );
  await db.query(
    `UPDATE people SET status = 'offboarded', updated_at = now()
     WHERE id = $1 AND status <> 'offboarded'`,
    [personId],
  );
  if (login) {
    // Sessions, passkeys and personal API keys cascade with the login.
    await db.query("DELETE FROM users WHERE id = $1", [login.id]);
  }

  const { rows: pending } = await db.query(
    `SELECT ${ITEM_COLUMNS} FROM offboard_items oi
     LEFT JOIN identities i ON i.id = oi.identity_id
     WHERE oi.person_id = $1 AND oi.status <> 'removed'
     ORDER BY oi.vendor, oi.kind, oi.external_id`,
    [personId],
  );
  for (const item of pending as ItemRow[]) {
    await executeItem(item, opts);
  }
  logger.info("offboard sweep finished", { personId, items: pending.length });
  const overview = await offboardOverview(personId, db);
  // Every sweep lands in the audit log (spec 11), whoever fired it - the
  // offboard button or an Okta leaver event.
  await audit(
    opts.actor ?? "system",
    "offboard.sweep",
    {
      personId,
      email: overview.person.email,
      removed: overview.items.filter((i) => i.status === "removed").length,
      failed: overview.items.filter((i) => i.status === "failed").length,
    },
    db,
  );
  return overview;
}

/** Retry one failed (or stuck-pending) item - spec 8: one by one. */
export async function retryOffboardItem(
  itemId: string,
  opts: ConnectorOpts & { actor?: AuditActor } = {},
): Promise<OffboardRow> {
  const db = opts.db ?? getPool();
  const { rows } = await db.query(
    `SELECT ${ITEM_COLUMNS}, oi.status FROM offboard_items oi
     LEFT JOIN identities i ON i.id = oi.identity_id
     WHERE oi.id = $1`,
    [itemId],
  );
  if (rows.length === 0) throw new ResolveError("offboard item not found", 404);
  if (rows[0].status === "removed") {
    throw new ResolveError("already removed - nothing to retry", 409);
  }
  const result = await executeItem(rows[0] as ItemRow, opts);
  await audit(
    opts.actor ?? "system",
    "offboard.retry",
    {
      personId: (rows[0] as ItemRow).personId,
      vendor: result.vendor,
      externalId: result.externalId,
      status: result.status,
    },
    db,
  );
  return result;
}
