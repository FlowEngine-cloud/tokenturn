"use client";

import { useSearchParams } from "next/navigation";
import { DataTable, type Column } from "@/components/data-table";
import { parseRange, withRange } from "@/lib/range";

export interface ProductRow {
  id: string;
  name: string;
  attribution: string;
  outcomeKind: string;
  archived: boolean;
}

/** Cost-center listing - each row drills to its spend facts over the active
 * range. Per-product metrics ($/merge, ROI) are spec 10 page 3's build. */
export function ProductsTable({ products }: { products: ProductRow[] }) {
  const searchParams = useSearchParams();
  const range = parseRange(searchParams);

  const columns: Column<ProductRow>[] = [
    { key: "name", header: "Name", render: (r) => r.name, csv: (r) => r.name },
    {
      key: "attribution",
      header: "Spend source",
      render: (r) => r.attribution,
      csv: (r) => r.attribution,
    },
    {
      key: "outcomeKind",
      header: "Outcome",
      render: (r) => (r.outcomeKind === "none" ? "–" : r.outcomeKind),
      csv: (r) => r.outcomeKind,
    },
    {
      key: "archived",
      header: "Status",
      render: (r) =>
        r.archived ? <span className="text-muted-foreground">archived</span> : "active",
      csv: (r) => (r.archived ? "archived" : "active"),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={products}
      rowKey={(r) => r.id}
      csvName="ai-pnl-products.csv"
      rowHref={(r) => withRange(`/drill?product=${r.id}`, range)}
    />
  );
}
