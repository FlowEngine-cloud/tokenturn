"use client";

import { useSearchParams } from "next/navigation";
import { Package } from "lucide-react";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Sparkline } from "@/components/trend-bars";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents, formatCount } from "@/lib/format";
import type { ProductsViewData, ProductViewRow } from "@/lib/products";
import { parseRange, withRange } from "@/lib/range";
import { useFetch } from "@/lib/use-fetch";

/**
 * Products (spec 10 page 3): per cost center - spend over the range and its
 * own metric in its own unit ($/merge, $/ticket_resolved, $/active user),
 * manual products included, ROI only where real value exists. Rows drill
 * into the product; archived products leave this view, history intact.
 */

export function ProductsSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-96" />
    </div>
  );
}

/** "$2.10 / merge", "$9.00 / active user" - or an honest dash. */
export function unitCostLabel(
  row: Pick<ProductViewRow, "unit" | "unitCostCents" | "costPerUserCents">,
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

export default function ProductsClient() {
  const searchParams = useSearchParams();
  const range = parseRange(searchParams);
  const { data, error } = useFetch<ProductsViewData>(
    `/api/products/view?from=${range.from}&to=${range.to}`,
  );

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 p-4 text-destructive">
        {error}
      </div>
    );
  }
  if (!data) return <ProductsSkeleton />;

  if (data.products.length === 0) {
    return (
      <EmptyState
        icon={Package}
        title="No products yet"
        body="Products are cost centers - anything that spends AI money. A key tag, the SDK, or a manual entry routes spend into one."
        actionHref="/settings"
        actionLabel="Open Settings"
      />
    );
  }

  const ccy = data.displayCurrency;
  const columns: Column<ProductViewRow>[] = [
    { key: "name", header: "Product", render: (r) => r.name, csv: (r) => r.name },
    {
      key: "source",
      header: "Source",
      render: (r) => (
        <span className="text-muted-foreground">{r.attribution}</span>
      ),
      csv: (r) => r.attribution,
    },
    {
      key: "spend",
      header: "Spend",
      align: "right",
      render: (r) => formatCents(r.spendCents, ccy),
      csv: (r) => (r.spendCents / 100).toFixed(2),
    },
    {
      key: "outcomes",
      header: "Outcomes",
      align: "right",
      render: (r) =>
        r.unit === null ? (
          r.activeUsers > 0 ? (
            <span className="text-muted-foreground">
              {formatCount(r.activeUsers)} users
            </span>
          ) : (
            "–"
          )
        ) : (
          <span>
            {formatCount(r.outcomeCount)}
            {r.revertedCount > 0 && (
              <span className="text-yellow-500"> · {formatCount(r.revertedCount)} rev</span>
            )}
          </span>
        ),
      csv: (r) => (r.unit === null ? r.activeUsers : r.outcomeCount),
    },
    {
      key: "unit",
      header: "Unit cost",
      align: "right",
      render: (r) => unitCostLabel(r, ccy),
      csv: (r) => unitCostLabel(r, ccy),
    },
    {
      key: "roi",
      header: "ROI",
      align: "right",
      render: (r) =>
        r.roi === null ? "–" : <span className="text-green-500">{r.roi}x</span>,
      csv: (r) => r.roi,
    },
    {
      key: "trend",
      header: "Trend",
      render: (r) => <Sparkline values={r.trend} />,
      csv: (r) => r.trend.join(" "),
    },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Products</h1>
      <DataTable
        columns={columns}
        rows={data.products}
        rowKey={(r) => r.id}
        csvName="ai-pnl-products.csv"
        rowHref={(r) => withRange(`/products/${r.id}`, range)}
      />
    </div>
  );
}
