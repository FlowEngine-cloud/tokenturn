/**
 * Client-safe date-range helpers for the global picker (spec 10: one global
 * date-range picker). The active range lives in the URL (?from=&to=, UTC
 * days, inclusive), so navigation and every drill link inherit it and a
 * pasted URL reproduces exactly what was on screen.
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

/** Read ?from/?to; anything missing or malformed falls back to the default
 * trailing window - never a guess at partial input. */
export function parseRange(
  params: { get(key: string): string | null },
  now: Date = new Date(),
): DateRange {
  const from = params.get("from");
  const to = params.get("to");
  if (from && to && DAY_RE.test(from) && DAY_RE.test(to) && from <= to) {
    return { from, to };
  }
  return defaultRange(now);
}

/** Append the active range to an app href, so drills keep the picker. */
export function withRange(href: string, range: DateRange): string {
  const sep = href.includes("?") ? "&" : "?";
  return `${href}${sep}from=${range.from}&to=${range.to}`;
}
