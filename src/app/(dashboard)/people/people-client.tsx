"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { Upload, UserPlus, Users } from "lucide-react";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { useLatest } from "@/components/form-utils";
import { PeopleCsvImport } from "@/components/people-csv-import";
import { PeopleAdd } from "@/components/people-invite";
import { Sparkline } from "@/components/trend-bars";
import { Button } from "@/components/ui/button";
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
 *
 * Admins bring people in from here (spec 8): the CSV roster import
 * (re-import upserts by email, never removes) and the invite fan-out.
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
  // ?v= bump refetches after an import; useLatest keeps the loaded table -
  // and the import/invite panels' results - on screen through the refetch.
  // A RANGE change still shows the skeleton (kept data is only reused
  // while its window matches).
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);
  const fetched = useFetch<PeopleListData>(
    `/api/people?from=${range.from}&to=${range.to}&v=${version}`,
  );
  const last = useLatest(fetched.data);
  const data =
    last && last.from === range.from && last.to === range.to ? last : null;
  const { error } = fetched;
  const { data: auth } = useFetch<{ user: { role: string } | null }>(
    "/api/auth/state",
  );
  const isAdmin = auth?.user?.role === "admin";
  const [panel, setPanel] = useState<"import" | "add" | null>(null);

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 p-4 text-destructive">
        {error}
      </div>
    );
  }
  if (!data) return <PeopleSkeleton />;

  const adminBar = isAdmin && (
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex-1" />
      <Button
        variant={panel === "import" ? "secondary" : "outline"}
        size="sm"
        onClick={() => setPanel(panel === "import" ? null : "import")}
      >
        <Upload className="h-4 w-4" />
        Import CSV
      </Button>
      <Button
        variant={panel === "add" ? "secondary" : "outline"}
        size="sm"
        onClick={() => setPanel(panel === "add" ? null : "add")}
      >
        <UserPlus className="h-4 w-4" />
        Add
      </Button>
    </div>
  );
  const panels = isAdmin && panel !== null && (
    <div className="rounded-lg border bg-card p-4">
      {panel === "import" ? (
        <PeopleCsvImport onImported={reload} />
      ) : (
        <PeopleAdd onAdded={reload} />
      )}
    </div>
  );

  if (data.people.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold">People</h1>
          {adminBar}
        </div>
        {panels}
        {panel === null && (
          <EmptyState
            icon={Users}
            title="No people yet"
            body="Connect a vendor or import your roster - identities auto-map by email, and whatever can't be matched lands in Resolve."
            actionHref="/settings"
            actionLabel="Open Settings"
          />
        )}
      </div>
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
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">People</h1>
        {adminBar}
      </div>
      {panels}
      <DataTable
        columns={columns}
        rows={data.people}
        rowKey={(r) => r.personId ?? "unassigned"}
        csvName="tokenturn-people.csv"
        rowHref={(r) =>
          r.personId === null
            ? withRange("/drill?person=unassigned&product=none", range)
            : withRange(`/people/${r.personId}`, range)
        }
      />
    </div>
  );
}
