import { createPrivateKey, createSign } from "node:crypto";
import { isArr, isBool, isObj, nonEmptyStr, parsePicked, strOrNull } from "@/lib/connectors/strict";
import { getPool, type Db } from "@/lib/db";
import { eeFeatureEnabled } from "@/lib/license";
import { logger } from "@/lib/logger";
import { ResolveError } from "@/lib/resolve";
import { deleteSetting, getSecretSetting, setSecretSetting } from "@/lib/settings";
import {
  directorySyncDue,
  finishDirectoryRun,
  lastDirectoryRun,
  startDirectoryRun,
  upsertRoster,
  type DirectoryRunSummary,
} from "./directory";

/**
 * Google Workspace roster sync (spec 11, enterprise) - part of ee/,
 * commercial license (see ee/LICENSE).
 *
 * Auth is a Google Cloud service account with domain-wide delegation,
 * impersonating a Workspace admin (the only way Google exposes the
 * Directory API to server apps): we sign a JWT with the service account's
 * private key (RS256, zero dependencies), exchange it for an access token,
 * and page through admin.directory v1 users.list, read-only scope. The
 * service-account JSON is stored encrypted like every vendor token and is
 * never read back out through the API.
 *
 * Roster semantics are the CSV import's: upsert by email, names never
 * regress, nobody is ever removed - offboard is the only exit (and leavers
 * are Okta's job; Google Workspace is roster-only per spec 11).
 */

export const GOOGLE_CONFIG_SETTING = "directory:google:config";
export const GOOGLE_CONNECTOR = "google_directory";
export const DIRECTORY_SCOPE = "https://www.googleapis.com/auth/admin.directory.user.readonly";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const USERS_URL = "https://admin.googleapis.com/admin/directory/v1/users";
const PAGE_SIZE = 500; // Google's maximum for users.list

export interface GoogleConfig {
  /** From the service-account JSON. */
  clientEmail: string;
  privateKey: string;
  /** The Workspace admin the service account impersonates. */
  adminEmail: string;
}

export interface GoogleOpts {
  db?: Db;
  fetch?: typeof fetch;
  dataDir?: string;
  now?: Date;
  /** Sync-now: skip the hourly cadence check. */
  force?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Accepts the service-account JSON verbatim plus the admin to impersonate. */
export function validateGoogleInput(raw: unknown): GoogleConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ResolveError("body must be { serviceAccountJson, adminEmail }", 400);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.adminEmail !== "string" || !EMAIL_RE.test(r.adminEmail)) {
    throw new ResolveError("adminEmail must be the Workspace admin the service account impersonates", 400);
  }
  if (typeof r.serviceAccountJson !== "string" || r.serviceAccountJson.trim() === "") {
    throw new ResolveError("serviceAccountJson must be the downloaded service-account key file", 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.serviceAccountJson);
  } catch {
    throw new ResolveError("serviceAccountJson is not valid JSON", 400);
  }
  const sa = parsed as Record<string, unknown>;
  if (typeof sa.client_email !== "string" || typeof sa.private_key !== "string") {
    throw new ResolveError("serviceAccountJson is missing client_email or private_key", 400);
  }
  try {
    createPrivateKey(sa.private_key);
  } catch {
    throw new ResolveError("private_key in serviceAccountJson is not a valid key", 400);
  }
  return {
    clientEmail: sa.client_email,
    privateKey: sa.private_key,
    adminEmail: r.adminEmail,
  };
}

export async function getGoogleConfig(opts: GoogleOpts = {}): Promise<GoogleConfig | null> {
  const db = opts.db ?? getPool();
  const raw = await getSecretSetting(GOOGLE_CONFIG_SETTING, db, opts.dataDir);
  return raw === null ? null : (JSON.parse(raw) as GoogleConfig);
}

// ---------------------------------------------------------------------------
// Auth: service-account JWT -> access token

const b64url = (input: string | Buffer): string =>
  Buffer.from(input).toString("base64url");

/** The signed JWT grant (RFC 7523). Exported for the signature test. */
export function buildJwtAssertion(config: GoogleConfig, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: config.clientEmail,
      sub: config.adminEmail,
      scope: DIRECTORY_SCOPE,
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600,
    }),
  );
  const signature = createSign("RSA-SHA256")
    .update(`${head}.${claims}`)
    .sign(createPrivateKey(config.privateKey));
  return `${head}.${claims}.${b64url(signature)}`;
}

async function googleError(res: Response, label: string): Promise<Error> {
  const text = await res.text();
  let detail = text;
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string } | string;
      error_description?: string;
    };
    if (typeof parsed.error === "object" && typeof parsed.error?.message === "string") {
      detail = parsed.error.message;
    } else if (typeof parsed.error_description === "string") {
      detail = parsed.error_description;
    }
  } catch {
    // keep the raw body
  }
  return new Error(`google ${res.status} on ${label}: ${detail}`);
}

export async function fetchAccessToken(
  config: GoogleConfig,
  opts: GoogleOpts = {},
): Promise<string> {
  const fetchImpl = opts.fetch ?? fetch;
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: buildJwtAssertion(config, opts.now ?? new Date()),
    }).toString(),
  });
  if (!res.ok) throw await googleError(res, "token exchange");
  const body = parsePicked("google token response", await res.json(), {
    access_token: nonEmptyStr,
  });
  return body.access_token as string;
}

// ---------------------------------------------------------------------------
// users.list

interface GoogleUsersPage {
  users: { email: string; name: string | null }[];
  nextPageToken: string | null;
}

export function parseUsersPage(body: unknown): GoogleUsersPage {
  const page = parsePicked("google users response", body, {}, {
    users: isArr,
    nextPageToken: strOrNull,
  });
  const users = ((page.users as unknown[]) ?? []).flatMap((raw) => {
    const user = parsePicked("google user", raw, {
      primaryEmail: nonEmptyStr,
      suspended: isBool,
    }, { archived: isBool, name: isObj });
    if (user.suspended === true || user.archived === true) return [];
    let name: string | null = null;
    if (isObj(user.name)) {
      const n = parsePicked("google user name", user.name, {}, { fullName: strOrNull });
      if (typeof n.fullName === "string" && n.fullName.trim() !== "") name = n.fullName.trim();
    }
    return [{ email: user.primaryEmail as string, name }];
  });
  return {
    users,
    nextPageToken: typeof page.nextPageToken === "string" ? page.nextPageToken : null,
  };
}

async function listUsersPage(
  token: string,
  pageToken: string | null,
  opts: GoogleOpts,
): Promise<GoogleUsersPage> {
  const fetchImpl = opts.fetch ?? fetch;
  const url =
    `${USERS_URL}?customer=my_customer&maxResults=${PAGE_SIZE}&orderBy=email` +
    (pageToken !== null ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw await googleError(res, "users.list");
  return parseUsersPage(await res.json());
}

// ---------------------------------------------------------------------------
// Connect / disconnect / tick

/** Token exchange + a one-page probe, then store the config encrypted. */
export async function connectGoogle(
  config: GoogleConfig,
  opts: GoogleOpts = {},
): Promise<void> {
  const db = opts.db ?? getPool();
  const token = await fetchAccessToken(config, opts);
  parseUsersPage(
    await (async () => {
      const fetchImpl = opts.fetch ?? fetch;
      const res = await fetchImpl(`${USERS_URL}?customer=my_customer&maxResults=1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw await googleError(res, "users.list");
      return res.json();
    })(),
  );
  await setSecretSetting(GOOGLE_CONFIG_SETTING, JSON.stringify(config), db, opts.dataDir);
  logger.info("google workspace connected", { clientEmail: config.clientEmail });
}

export async function disconnectGoogle(opts: GoogleOpts = {}): Promise<boolean> {
  const db = opts.db ?? getPool();
  const had = (await getGoogleConfig(opts)) !== null;
  await deleteSetting(GOOGLE_CONFIG_SETTING, db);
  if (had) logger.info("google workspace disconnected", {});
  return had;
}

export interface GoogleTickResult {
  ran: boolean;
  created: number;
  updated: number;
  error: string | null;
}

export async function googleTick(opts: GoogleOpts = {}): Promise<GoogleTickResult> {
  const db = opts.db ?? getPool();
  const now = opts.now ?? new Date();
  if (!(await eeFeatureEnabled("google_workspace", db, now))) {
    return { ran: false, created: 0, updated: 0, error: null };
  }
  const config = await getGoogleConfig(opts);
  if (config === null) return { ran: false, created: 0, updated: 0, error: null };
  if (!opts.force && !(await directorySyncDue(GOOGLE_CONNECTOR, now, db))) {
    return { ran: false, created: 0, updated: 0, error: null };
  }

  const { runId } = await startDirectoryRun(GOOGLE_CONNECTOR, db);
  try {
    const token = await fetchAccessToken(config, opts);
    const users: { email: string; name: string | null }[] = [];
    let pageToken: string | null = null;
    do {
      const page: GoogleUsersPage = await listUsersPage(token, pageToken, opts);
      users.push(...page.users);
      pageToken = page.nextPageToken;
    } while (pageToken !== null);

    const roster = await upsertRoster(users, "google", db);
    await finishDirectoryRun(runId, { status: "success", cursor: {}, rowsSynced: users.length }, db);
    logger.info("google tick finished", { users: users.length, created: roster.created.length });
    return { ran: true, created: roster.created.length, updated: roster.updated, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishDirectoryRun(runId, { status: "error", error: message }, db);
    logger.error("google tick failed", { error: message });
    return { ran: true, created: 0, updated: 0, error: message };
  }
}

/** The Settings health line. */
export async function googleStatus(
  opts: GoogleOpts = {},
): Promise<{ connected: boolean; clientEmail: string | null; adminEmail: string | null; lastRun: DirectoryRunSummary | null }> {
  const db = opts.db ?? getPool();
  const config = await getGoogleConfig(opts);
  return {
    connected: config !== null,
    clientEmail: config?.clientEmail ?? null,
    adminEmail: config?.adminEmail ?? null,
    lastRun: await lastDirectoryRun(GOOGLE_CONNECTOR, db),
  };
}
