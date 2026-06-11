"use client";

import { useSearchParams } from "next/navigation";
import { Users } from "lucide-react";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Sparkline } from "@/components/trend-bars";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents, formatCount } from "@/lib/format";
import type { PeopleListData, PersonListRow } from "@/lib/people";
import { parseRange, withRange } from "@/lib/range";
import { useFetch } from "@/lib/use-fetch";

/**
 * People (spec 10 page 2): per person spend by vendor, outcomes, $/outcome
 * and trend over the active range, plus the visible Unassigned bucket.
 * Click a person for their daily breakdown, keys and products; the
 * Unassigned row drills straight to its facts. Archived people are hidden
 * here - their history stays intact in every drill-down.
 */

export function PeopleSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-96" />
    </div>
  );
}

function vendorSummary(row: PersonListRow, currency: string): string {
  return row.byVendor
    .map((v) => `${v.vendor} ${formatCents(v.cents, currency)}`)
    .join(" · ");
}

export default function PeopleClient() {
  const searchParams = useSearchParams();
  const range = parseRange(searchParams);
  const { data, error } = useFetch<PeopleListData>(
    `/api/people?from=${range.from}&to=${range.to}`,
  );

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 p-4 text-destructive">
        {error}
      </div>
    );
  }
  if (!data) return <PeopleSkeleton />;

  if (data.people.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No people yet"
        body="Connect a vendor or import your roster - identities auto-map by email, and whatever can't be matched lands in Resolve."
        actionHref="/settings"
        actionLabel="Open Settings"
      />
    );
  }

  const ccy = data.displayCurrency;
  const columns: Column<PersonListRow>[] = [
    {
      key: "person",
      header: "Person",
      render: (r) =>
        r.personId === null ? (
          <span className="text-muted-foreground">Unassigned</span>
        ) : (
          <span className="flex flex-col">
            <span>{r.name ?? r.email}</span>
            {r.name && (
              <span className="text-sm text-muted-foreground">{r.email}</span>
            )}
          </span>
        ),
      csv: (r) => r.email ?? "unassigned",
    },
    {
      key: "status",
      header: "Status",
      render: (r) =>
        r.status === null ? (
          "–"
        ) : r.status === "active" ? (
          "active"
        ) : (
          <span className="text-amber-700">{r.status}</span>
        ),
      csv: (r) => r.status,
    },
    {
      key: "spend",
      header: "Spend",
      align: "right",
      render: (r) => formatCents(r.totalCents, ccy),
      csv: (r) => (r.totalCents / 100).toFixed(2),
    },
    {
      key: "vendors",
      header: "By vendor",
      render: (r) => {
        if (r.byVendor.length === 0) return "–";
        const top = r.byVendor.slice(0, 3);
        return (
          <span className="text-sm text-muted-foreground">
            {vendorSummary({ ...r, byVendor: top }, ccy)}
            {r.byVendor.length > 3 && ` +${r.byVendor.length - 3}`}
          </span>
        );
      },
      csv: (r) => vendorSummary(r, ccy),
    },
    {
      key: "outcomes",
      header: "Outcomes",
      align: "right",
      render: (r) =>
        r.personId === null ? "–" : r.outcomeCount > 0 ? formatCount(r.outcomeCount) : "0",
      csv: (r) => (r.personId === null ? null : r.outcomeCount),
    },
    {
      key: "unit",
      header: "$ / outcome",
      align: "right",
      render: (r) =>
        r.unitCostCents === null ? "–" : formatCents(r.unitCostCents, ccy),
      csv: (r) => (r.unitCostCents === null ? null : (r.unitCostCents / 100).toFixed(2)),
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
      <h1 className="text-lg font-semibold">People</h1>
      <DataTable
        columns={columns}
        rows={data.people}
        rowKey={(r) => r.personId ?? "unassigned"}
        csvName="ai-pnl-people.csv"
        rowHref={(r) =>
          r.personId === null
            ? withRange("/drill?person=unassigned&product=none", range)
            : withRange(`/people/${r.personId}`, range)
        }
      />
    </div>
  );
}
