"use client";

import { useSearchParams } from "next/navigation";
import { DataTable, type Column } from "@/components/data-table";
import { formatCents, formatCount } from "@/lib/format";
import { parseRange, withRange } from "@/lib/range";

export interface QueueRow {
  id: string;
  vendor: string;
  externalId: string;
  kind: string;
  email: string | null;
  displayName: string | null;
  tags: string[];
  factCount: number;
  suggestionCount: number;
}

export interface UnassignedRow {
  vendor: string;
  amountUsdCents: number;
  factCount: number;
}

/** Queue listing; confirm/merge actions are the Resolve build's own loop. */
export function ResolveTables({
  queue,
  unassigned,
}: {
  queue: QueueRow[];
  unassigned: UnassignedRow[];
}) {
  const searchParams = useSearchParams();
  const range = parseRange(searchParams);

  const queueColumns: Column<QueueRow>[] = [
    { key: "vendor", header: "Vendor", render: (r) => r.vendor, csv: (r) => r.vendor },
    { key: "kind", header: "Kind", render: (r) => r.kind, csv: (r) => r.kind },
    {
      key: "who",
      header: "Identity",
      render: (r) => r.email ?? r.displayName ?? r.externalId,
      csv: (r) => r.email ?? r.displayName ?? r.externalId,
    },
    {
      key: "tags",
      header: "Tags",
      render: (r) => (r.tags.length > 0 ? r.tags.join(", ") : "–"),
      csv: (r) => r.tags.join(" "),
    },
    {
      key: "facts",
      header: "Facts",
      align: "right",
      render: (r) => formatCount(r.factCount),
      csv: (r) => r.factCount,
    },
    {
      key: "suggestions",
      header: "Suggestions",
      align: "right",
      render: (r) => (r.suggestionCount > 0 ? formatCount(r.suggestionCount) : "–"),
      csv: (r) => r.suggestionCount,
    },
  ];

  const unassignedColumns: Column<UnassignedRow>[] = [
    { key: "vendor", header: "Vendor", render: (r) => r.vendor, csv: (r) => r.vendor },
    {
      key: "amount",
      header: "Unassigned (USD)",
      align: "right",
      render: (r) => formatCents(r.amountUsdCents, "USD"),
      csv: (r) => (r.amountUsdCents / 100).toFixed(2),
    },
    {
      key: "facts",
      header: "Facts",
      align: "right",
      render: (r) => formatCount(r.factCount),
      csv: (r) => r.factCount,
    },
  ];

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-base font-medium">Queue</h2>
        <DataTable
          columns={queueColumns}
          rows={queue}
          rowKey={(r) => r.id}
          csvName="ai-pnl-resolve-queue.csv"
        />
      </section>
      <section className="space-y-3">
        <h2 className="text-base font-medium">Unassigned spend</h2>
        <DataTable
          columns={unassignedColumns}
          rows={unassigned}
          rowKey={(r) => r.vendor}
          csvName="ai-pnl-unassigned.csv"
          rowHref={(r) =>
            withRange(`/drill?vendor=${r.vendor}&person=unassigned&product=none`, range)
          }
        />
      </section>
    </div>
  );
}
