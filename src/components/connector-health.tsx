"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { ConnectorHealth } from "@/lib/connectors/health";
import { formatCount, timeAgo } from "@/lib/format";
import { parseRange, withRange } from "@/lib/range";
import { cn } from "@/lib/utils";

/**
 * Connector health (spec 5): connection state, last sync, row counts, the
 * vendor's error verbatim. Shared by Overview and Settings; each row drills
 * to its sync runs.
 */

function statusOf(c: ConnectorHealth): { label: string; dot: string } {
  if (!c.connected) return { label: "not connected", dot: "bg-muted-foreground/40" };
  if (c.lastRun?.status === "running") {
    return { label: "syncing", dot: "bg-yellow-500 animate-pulse" };
  }
  if (c.silent) return { label: "silent", dot: "bg-yellow-500" };
  if (c.lastRun?.status === "error") return { label: "error", dot: "bg-red-500" };
  if (c.lastRun?.status === "success") return { label: "ok", dot: "bg-green-500" };
  return { label: "connected", dot: "bg-green-500/60" };
}

export function ConnectorHealthList({ connectors }: { connectors: ConnectorHealth[] }) {
  const searchParams = useSearchParams();
  const range = parseRange(searchParams);

  return (
    <ul className="divide-y">
      {connectors.map((c) => {
        const status = statusOf(c);
        return (
          <li key={c.vendor}>
            <Link
              href={withRange(`/drill?view=runs&vendor=${c.vendor}`, range)}
              className="flex flex-col gap-1 px-1 py-3 hover:bg-accent/50"
            >
              <span className="flex items-center gap-3">
                <span className={cn("h-2 w-2 shrink-0 rounded-full", status.dot)} />
                <span className="font-medium">{c.displayName}</span>
                <span className="text-sm text-muted-foreground">{status.label}</span>
                <span className="flex-1" />
                {c.connected && (
                  <span className="text-sm text-muted-foreground">
                    {c.lastSuccessAt
                      ? `synced ${timeAgo(c.lastSuccessAt)}`
                      : "never synced"}
                    {" · "}
                    {formatCount(c.rowCounts.spendFacts)} facts
                  </span>
                )}
              </span>
              {c.connected && c.lastRun?.error && (
                <span
                  className="truncate pl-5 text-sm text-red-400"
                  title={c.lastRun.error}
                >
                  {c.lastRun.error}
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
