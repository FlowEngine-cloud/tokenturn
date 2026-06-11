import pkg from "../../package.json";
import { getPool, type Db } from "./db";
import { logger } from "./logger";
import { getSetting } from "./settings";

/**
 * The "new version available" check (spec 12b): opt-in, off by default like
 * all telemetry. When `update_check_enabled` is on, the server asks the
 * GitHub releases API for the latest tag - nothing about the instance is
 * sent (a plain unauthenticated GET), and the result is cached in memory so
 * the dashboard never makes GitHub wait on a page load.
 */

export const APP_VERSION: string = pkg.version;
/** Where releases live; the check and the banner link both point here. */
export const RELEASES_REPO = "flowengine/ai-pnl";
const RELEASES_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
export const RELEASES_URL = `https://github.com/${RELEASES_REPO}/releases`;
const CACHE_MS = 6 * 60 * 60 * 1000;

export interface VersionInfo {
  current: string;
  /** Off = the opt-in is off; nothing was checked. */
  enabled: boolean;
  latest: string | null;
  updateAvailable: boolean;
  releasesUrl: string;
}

/** "v0.2.1" > "0.1.9" etc.; non-numeric tags never beat the current version. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] | null => {
    const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

let cache: { at: number; latest: string | null } | null = null;

/** Test hook: drop the in-memory cache. */
export function __clearVersionCacheForTests(): void {
  cache = null;
}

async function latestRelease(fetchImpl: typeof fetch, now: Date): Promise<string | null> {
  if (cache && now.getTime() - cache.at < CACHE_MS) return cache.latest;
  let latest: string | null = null;
  try {
    const res = await fetchImpl(RELEASES_API, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (res.ok) {
      const body = (await res.json()) as { tag_name?: unknown };
      if (typeof body.tag_name === "string") latest = body.tag_name;
    } else {
      logger.warn("release check failed", { status: res.status });
    }
  } catch (error) {
    // The check must never break a page; the banner just stays away.
    logger.warn("release check failed", { error });
  }
  cache = { at: now.getTime(), latest };
  return latest;
}

export async function versionInfo(
  opts: { db?: Db; fetch?: typeof fetch; now?: Date } = {},
): Promise<VersionInfo> {
  const db = opts.db ?? getPool();
  const enabled = await getSetting("update_check_enabled", db);
  if (!enabled) {
    return {
      current: APP_VERSION,
      enabled: false,
      latest: null,
      updateAvailable: false,
      releasesUrl: RELEASES_URL,
    };
  }
  const latest = await latestRelease(opts.fetch ?? fetch, opts.now ?? new Date());
  return {
    current: APP_VERSION,
    enabled: true,
    latest,
    updateAvailable: latest !== null && isNewerVersion(latest, APP_VERSION),
    releasesUrl: RELEASES_URL,
  };
}
