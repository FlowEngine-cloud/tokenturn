/**
 * Fixed-window in-memory rate limiter for credential endpoints (login,
 * claim, reset). Single-container deployment (spec 10), so process-local
 * state is the whole picture. Zero dependencies.
 */

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;
const MAX_TRACKED_KEYS = 10_000;

const windows = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(
  key: string,
  max: number = MAX_ATTEMPTS,
  windowMs: number = WINDOW_MS,
): boolean {
  const now = Date.now();
  const entry = windows.get(key);
  if (!entry || entry.resetAt <= now) {
    if (windows.size >= MAX_TRACKED_KEYS) {
      for (const [k, v] of windows) {
        if (v.resetAt <= now) windows.delete(k);
      }
      if (windows.size >= MAX_TRACKED_KEYS) windows.clear();
    }
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}

/** Per-IP key for auth endpoints; first x-forwarded-for hop behind a proxy. */
export function clientKey(req: Request, scope: string): string {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
  return `${scope}:${ip}`;
}

/** Test-only. */
export function resetRateLimits(): void {
  windows.clear();
}
