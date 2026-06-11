/**
 * Client-safe date-range helpers for the global picker (spec 10: one global
 * date-range picker). The active range lives in the URL (?from=&to=, UTC
 * days, inclusive), so navigation and every drill link inherit it and a
 * pasted URL reproduces exactly what was on screen. localStorage remembers
 * the last range as a fallback for entries whose URL carries none (a
 * bookmark, a fresh tab) - the picker re-injects it into the URL on landing.
 */

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DateRange {
  /** Inclusive UTC day, YYYY-MM-DD. */
  from: string;
  /** Inclusive UTC day, YYYY-MM-DD. */
  to: string;
}

export const DEFAULT_RANGE_DAYS = 30;

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return utcDay(date);
}

/** Every UTC day in [from, to], ascending - the trend axis. */
export function rangeDays(from: string, to: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    days.push(utcDay(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** Trailing N days ending today (UTC), inclusive. */
export function trailingRange(days: number, now: Date = new Date()): DateRange {
  const to = utcDay(now);
  return { from: addDays(to, -(days - 1)), to };
}

export function defaultRange(now: Date = new Date()): DateRange {
  return trailingRange(DEFAULT_RANGE_DAYS, now);
}

/** Calendar month to date (UTC). */
export function monthToDateRange(now: Date = new Date()): DateRange {
  const to = utcDay(now);
  return { from: `${to.slice(0, 7)}-01`, to };
}

/** The current UTC calendar month, YYYY-MM (the Report's default). */
export function currentMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
}

/** First and last UTC day of a YYYY-MM month, inclusive. */
export function monthBounds(month: string): DateRange {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

/** The range the URL actually carries: a valid ?from/?to pair or null -
 * anything missing or malformed is null, never a guess at partial input. */
export function rangeFromParams(params: {
  get(key: string): string | null;
}): DateRange | null {
  const from = params.get("from");
  const to = params.get("to");
  if (from && to && DAY_RE.test(from) && DAY_RE.test(to) && from <= to) {
    return { from, to };
  }
  return null;
}

/** Read ?from/?to; anything missing or malformed falls back to the default
 * trailing window. */
export function parseRange(
  params: { get(key: string): string | null },
  now: Date = new Date(),
): DateRange {
  return rangeFromParams(params) ?? defaultRange(now);
}

export const RANGE_STORAGE_KEY = "ai-pnl:range";

/** The last range the picker saw, or null - localStorage, validated like a
 * URL would be. Server-side it is always null. */
export function readStoredRange(): DateRange | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(RANGE_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      const { from, to } = parsed as { from?: unknown; to?: unknown };
      if (
        typeof from === "string" &&
        typeof to === "string" &&
        DAY_RE.test(from) &&
        DAY_RE.test(to) &&
        from <= to
      ) {
        return { from, to };
      }
    }
  } catch {
    // Unreadable storage or garbage content - behave as if nothing is stored.
  }
  return null;
}

/** Remember the active range so the next URL without one inherits it. */
export function storeRange(range: DateRange): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RANGE_STORAGE_KEY, JSON.stringify(range));
  } catch {
    // Storage may be full or blocked - the URL still carries the range.
  }
}

/** What the top bar shows on a route (spec 10). The global picker appears
 * exactly where the calendar drives the data:
 * - "hidden": dates mean nothing (Settings, Resolve, Help) - no bar at all.
 * - "search": the page has its own time axis (the Report is a month sheet,
 *   a key page is all-time, sync runs and invoices are vendor records) -
 *   cmd-K stays, the picker goes.
 * - "full": search + picker; the page's data follows the range. */
export function topBarMode(
  pathname: string,
  params: { get(key: string): string | null },
): "full" | "search" | "hidden" {
  const under = (route: string) =>
    pathname === route || pathname.startsWith(`${route}/`);
  if (under("/settings") || under("/resolve") || under("/help")) return "hidden";
  if (under("/report") || under("/keys")) return "search";
  const view = under("/drill") ? params.get("view") : null;
  if (view === "runs" || view === "invoices") return "search";
  return "full";
}

/** Append the active range to an app href, so drills keep the picker. */
export function withRange(href: string, range: DateRange): string {
  const sep = href.includes("?") ? "&" : "?";
  return `${href}${sep}from=${range.from}&to=${range.to}`;
}
