/** Client-safe display formatting. Amounts arrive as integer cents in a
 * known currency - formatting never changes a number, only renders it. */

export function formatCents(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    // Unknown ISO code: show the raw value with its code, never nothing.
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** Signed variant for drift ("+$12.34" / "-$0.50"). */
export function formatCentsSigned(cents: number, currency: string): string {
  const abs = formatCents(Math.abs(cents), currency);
  return cents < 0 ? `-${abs}` : `+${abs}`;
}

export function formatPct(pct: number | null): string {
  return pct === null ? "–" : `${pct}%`;
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/** UI names for the AI authorship tags - shared by every page showing
 * coding tools (client-safe: the server readers import from here too). */
export const TOOL_LABELS: Record<string, string> = {
  claude_code: "Claude Code",
  cursor: "Cursor",
  copilot: "Copilot",
  devin: "Devin",
  codex: "Codex",
};

export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

/** "$2.10 / merge", "$9.00 / active user" - or an honest dash. Shared by the
 * ROI table and the Report (spec 7: unit cost in the row's own unit; no
 * success defined = cost per active user, never a fake ROI). */
export function unitCostLabel(
  row: {
    unit: string | null;
    unitCostCents: number | null;
    costPerUserCents: number | null;
  },
  currency: string,
): string {
  if (row.unit !== null) {
    return row.unitCostCents === null
      ? "–"
      : `${formatCents(row.unitCostCents, currency)} / ${row.unit}`;
  }
  return row.costPerUserCents === null
    ? "–"
    : `${formatCents(row.costPerUserCents, currency)} / active user`;
}

/** "2026-06-05" -> "Jun 5" (UTC; day buckets are UTC everywhere). */
export function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function timeAgo(iso: string | null, nowMs: number = Date.now()): string {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
