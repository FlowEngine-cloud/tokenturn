"use client";

import { useSearchParams } from "next/navigation";
import { DataTable, type Column } from "@/components/data-table";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents, formatCentsSigned, formatCount } from "@/lib/format";
import type {
  FactPage,
  FactRow,
  MetricPage,
  MetricRow,
  OutcomePage,
  OutcomeRow,
  SyncRunRow,
} from "@/lib/overview";
import { parseRange } from "@/lib/range";
import { useFetch } from "@/lib/use-fetch";

/**
 * The drill-down page every tile clicks through to (spec 3: every number
 * drills to the vendor rows behind it). Views over raw rows: facts
 * (spend_facts), outcomes, metrics (vendor usage counters), runs
 * (sync_runs), invoices (imported invoices with their drift). Sticky
 * header, CSV export, totals across the whole filter so the page proves it
 * sums to the tile it came from.
 */

interface InvoiceRow {
  id: string;
  vendor: string;
  month: string;
  amountCents: number;
  currency: string;
  sourceRef: string | null;
  note: string | null;
  estimatedUsdCents: number;
  invoicedFactsUsdCents: number;
  driftDisplayCents: number;
}

function Chip({ label }: { label: string }) {
  return (
    <span className="rounded-full border px-2.5 py-0.5 text-sm text-muted-foreground">
      {label}
    </span>
  );
}

function DrillSkeletonBlock() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-96" />
    </div>
  );
}
export { DrillSkeletonBlock as DrillSkeleton };

function FactsView({ query, chips }: { query: string; chips: string[] }) {
  const { data, error } = useFetch<FactPage>(`/api/facts?${query}&limit=1000`);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <DrillSkeletonBlock />;

  const showDisplay = data.rows.some((r) => r.currency !== data.displayCurrency);
  const columns: Column<FactRow>[] = [
    { key: "day", header: "Day", render: (r) => r.day, csv: (r) => r.day },
    { key: "vendor", header: "Vendor", render: (r) => r.vendor, csv: (r) => r.vendor },
    {
      key: "model",
      header: "Model",
      render: (r) => r.model ?? "–",
      csv: (r) => r.model,
    },
    {
      key: "person",
      header: "Person",
      render: (r) =>
        r.personId ? (
          (r.personName ?? r.personEmail)
        ) : (
          <span className="text-muted-foreground">Unassigned</span>
        ),
      csv: (r) => r.personEmail ?? (r.personId ? r.personId : "unassigned"),
    },
    {
      key: "product",
      header: "ROI",
      render: (r) => r.productName ?? "–",
      csv: (r) => r.productName,
    },
    {
      key: "tokens",
      header: "Tokens",
      align: "right",
      render: (r) => (r.tokens > 0 ? formatCount(r.tokens) : "–"),
      csv: (r) => r.tokens,
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      render: (r) => formatCents(r.amountCents, r.currency),
      csv: (r) => (r.amountCents / 100).toFixed(2),
    },
    { key: "currency", header: "Ccy", render: (r) => r.currency, csv: (r) => r.currency },
    ...(showDisplay
      ? [
          {
            key: "display",
            header: `In ${data.displayCurrency}`,
            align: "right" as const,
            render: (r: FactRow) => formatCents(r.displayCents, data.displayCurrency),
            csv: (r: FactRow) => (r.displayCents / 100).toFixed(2),
          },
        ]
      : []),
    {
      key: "basis",
      header: "Basis",
      render: (r) => r.costBasis,
      csv: (r) => r.costBasis,
    },
    {
      key: "billing",
      header: "Billing",
      render: (r) => (r.billingMode === "subscription" ? "seat" : "metered"),
      csv: (r) => r.billingMode,
    },
    {
      key: "ref",
      header: "Source ref",
      render: (r) => (
        <span className="block max-w-56 truncate font-mono text-sm" title={r.sourceRef}>
          {r.sourceRef}
        </span>
      ),
      csv: (r) => r.sourceRef,
    },
  ];

  return (
    <div className="space-y-3">
      <Header
        chips={chips}
        summary={`${formatCents(data.totalDisplayCents, data.displayCurrency)} across ${formatCount(data.totalCount)} facts`}
      />
      <DataTable
        columns={columns}
        rows={data.rows}
        rowKey={(r) => r.id}
        csvName="tokenturn-facts.csv"
        note={
          data.rows.length < data.totalCount
            ? `first ${formatCount(data.rows.length)} of ${formatCount(data.totalCount)} - narrow the filter for the rest`
            : undefined
        }
      />
    </div>
  );
}

function OutcomesView({ query, chips }: { query: string; chips: string[] }) {
  const { data, error } = useFetch<OutcomePage>(`/api/outcomes?${query}&limit=1000`);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <DrillSkeletonBlock />;

  const columns: Column<OutcomeRow>[] = [
    { key: "day", header: "Day", render: (r) => r.day, csv: (r) => r.day },
    { key: "kind", header: "Kind", render: (r) => r.kind, csv: (r) => r.kind },
    {
      key: "count",
      header: "Count",
      align: "right",
      render: (r) => formatCount(r.count),
      csv: (r) => r.count,
    },
    {
      key: "product",
      header: "ROI",
      render: (r) => r.productName,
      csv: (r) => r.productName,
    },
    {
      key: "person",
      header: "Person",
      render: (r) =>
        r.personId ? (
          (r.personName ?? r.personEmail)
        ) : (
          <span className="text-muted-foreground">–</span>
        ),
      csv: (r) => r.personEmail,
    },
    {
      key: "tools",
      header: "Tools",
      render: (r) => (r.tools.length > 0 ? r.tools.join(", ") : "–"),
      csv: (r) => r.tools.join(" "),
    },
    {
      key: "value",
      header: "Value",
      align: "right",
      render: (r) =>
        r.valueCents === null ? "–" : formatCents(r.valueCents, r.currency ?? "USD"),
      csv: (r) => (r.valueCents === null ? null : (r.valueCents / 100).toFixed(2)),
    },
    {
      key: "status",
      header: "Status",
      render: (r) =>
        r.revertedAt ? (
          <span className="text-amber-700" title={r.revertSourceRef ?? undefined}>
            reverted
          </span>
        ) : (
          "live"
        ),
      csv: (r) => (r.revertedAt ? `reverted: ${r.revertSourceRef ?? ""}` : "live"),
    },
    {
      key: "ref",
      header: "Source ref",
      render: (r) => (
        <span className="block max-w-56 truncate font-mono text-sm" title={r.sourceRef}>
          {r.sourceRef}
        </span>
      ),
      csv: (r) => r.sourceRef,
    },
  ];

  return (
    <div className="space-y-3">
      <Header
        chips={chips}
        summary={`${formatCount(data.liveCount)} live outcomes${
          data.revertedCount > 0 ? ` · ${formatCount(data.revertedCount)} reverted` : ""
        }`}
      />
      <DataTable
        columns={columns}
        rows={data.rows}
        rowKey={(r) => r.id}
        csvName="tokenturn-outcomes.csv"
        note={
          data.rows.length === data.limit
            ? `first ${formatCount(data.rows.length)} rows - narrow the filter for the rest`
            : undefined
        }
      />
    </div>
  );
}

function MetricsView({ query, chips }: { query: string; chips: string[] }) {
  const { data, error } = useFetch<MetricPage>(`/api/metrics?${query}&limit=1000`);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <DrillSkeletonBlock />;

  const columns: Column<MetricRow>[] = [
    { key: "day", header: "Day", render: (r) => r.day, csv: (r) => r.day },
    { key: "vendor", header: "Vendor", render: (r) => r.vendor, csv: (r) => r.vendor },
    { key: "metric", header: "Metric", render: (r) => r.metric, csv: (r) => r.metric },
    {
      key: "value",
      header: "Value",
      align: "right",
      render: (r) => formatCount(r.value),
      csv: (r) => r.value,
    },
    {
      key: "person",
      header: "Person",
      render: (r) =>
        r.personId ? (
          (r.personName ?? r.personEmail)
        ) : (
          <span className="text-muted-foreground">Unassigned</span>
        ),
      csv: (r) => r.personEmail ?? (r.personId ? r.personId : "unassigned"),
    },
    {
      key: "identity",
      header: "Key / user",
      render: (r) => (
        <span className="block max-w-48 truncate font-mono text-sm">
          {r.identityExternalId ?? "–"}
        </span>
      ),
      csv: (r) => r.identityExternalId,
    },
    {
      key: "ref",
      header: "Source ref",
      render: (r) => (
        <span className="block max-w-56 truncate font-mono text-sm" title={r.sourceRef}>
          {r.sourceRef}
        </span>
      ),
      csv: (r) => r.sourceRef,
    },
  ];

  return (
    <div className="space-y-3">
      <Header
        chips={chips}
        summary={
          data.byMetric.length === 0
            ? "No counters match"
            : `${data.byMetric
                .map((m) => `${m.metric} ${formatCount(m.value)}`)
                .join(" · ")} across ${formatCount(data.totalCount)} rows`
        }
      />
      <DataTable
        columns={columns}
        rows={data.rows}
        rowKey={(r) => r.id}
        csvName="tokenturn-metrics.csv"
        note={
          data.rows.length < data.totalCount
            ? `first ${formatCount(data.rows.length)} of ${formatCount(data.totalCount)} - narrow the filter for the rest`
            : undefined
        }
      />
    </div>
  );
}

function RunsView({ vendor, chips }: { vendor: string | null; chips: string[] }) {
  const { data, error } = useFetch<{ runs: SyncRunRow[] }>(
    `/api/runs${vendor ? `?vendor=${vendor}` : ""}`,
  );
  if (error) return <ErrorBox message={error} />;
  if (!data) return <DrillSkeletonBlock />;

  const columns: Column<SyncRunRow>[] = [
    { key: "id", header: "Run", render: (r) => `#${r.id}`, csv: (r) => r.id },
    {
      key: "connector",
      header: "Connector",
      render: (r) => r.connector,
      csv: (r) => r.connector,
    },
    { key: "status", header: "Status", render: (r) => r.status, csv: (r) => r.status },
    {
      key: "started",
      header: "Started",
      render: (r) => r.startedAt.replace("T", " ").slice(0, 19),
      csv: (r) => r.startedAt,
    },
    {
      key: "finished",
      header: "Finished",
      render: (r) => (r.finishedAt ? r.finishedAt.replace("T", " ").slice(0, 19) : "–"),
      csv: (r) => r.finishedAt,
    },
    {
      key: "rows",
      header: "Rows",
      align: "right",
      render: (r) => formatCount(r.rowsSynced),
      csv: (r) => r.rowsSynced,
    },
    {
      key: "error",
      header: "Error",
      render: (r) =>
        r.error ? (
          <span className="block max-w-md truncate text-red-600" title={r.error}>
            {r.error}
          </span>
        ) : (
          "–"
        ),
      csv: (r) => r.error,
    },
  ];

  return (
    <div className="space-y-3">
      <Header chips={chips} summary={`${formatCount(data.runs.length)} sync runs`} />
      <DataTable
        columns={columns}
        rows={data.runs}
        rowKey={(r) => String(r.id)}
        csvName="tokenturn-sync-runs.csv"
      />
    </div>
  );
}

function InvoicesView({ months, chips }: { months: { from: string; to: string }; chips: string[] }) {
  const { data, error } = useFetch<{ displayCurrency: string; invoices: InvoiceRow[] }>(
    `/api/invoices?from=${months.from}&to=${months.to}`,
  );
  if (error) return <ErrorBox message={error} />;
  if (!data) return <DrillSkeletonBlock />;

  const columns: Column<InvoiceRow>[] = [
    { key: "vendor", header: "Vendor", render: (r) => r.vendor, csv: (r) => r.vendor },
    { key: "month", header: "Month", render: (r) => r.month, csv: (r) => r.month },
    {
      key: "invoice",
      header: "Invoice",
      align: "right",
      render: (r) => formatCents(r.amountCents, r.currency),
      csv: (r) => (r.amountCents / 100).toFixed(2),
    },
    { key: "ccy", header: "Ccy", render: (r) => r.currency, csv: (r) => r.currency },
    {
      key: "estimated",
      header: "Est. facts (USD)",
      align: "right",
      render: (r) => formatCents(r.estimatedUsdCents, "USD"),
      csv: (r) => (r.estimatedUsdCents / 100).toFixed(2),
    },
    {
      key: "invoiced",
      header: "Inv. facts (USD)",
      align: "right",
      render: (r) => formatCents(r.invoicedFactsUsdCents, "USD"),
      csv: (r) => (r.invoicedFactsUsdCents / 100).toFixed(2),
    },
    {
      key: "drift",
      header: `Drift (${data.displayCurrency})`,
      align: "right",
      render: (r) =>
        r.driftDisplayCents === 0 ? (
          <span className="text-muted-foreground">0</span>
        ) : (
          <span className="text-amber-700">
            {formatCentsSigned(r.driftDisplayCents, data.displayCurrency)}
          </span>
        ),
      csv: (r) => (r.driftDisplayCents / 100).toFixed(2),
    },
    {
      key: "ref",
      header: "Invoice ref",
      render: (r) => r.sourceRef ?? "–",
      csv: (r) => r.sourceRef,
    },
    { key: "note", header: "Note", render: (r) => r.note ?? "–", csv: (r) => r.note },
  ];

  const drift = data.invoices.reduce((sum, i) => sum + i.driftDisplayCents, 0);
  return (
    <div className="space-y-3">
      <Header
        chips={chips}
        summary={`${formatCount(data.invoices.length)} invoices · ${formatCentsSigned(drift, data.displayCurrency)} drift`}
      />
      <DataTable
        columns={columns}
        rows={data.invoices}
        rowKey={(r) => r.id}
        csvName="tokenturn-invoices.csv"
      />
    </div>
  );
}

function Header({ chips, summary }: { chips: string[]; summary: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <h1 className="text-lg font-semibold">{summary}</h1>
      <span className="flex-1" />
      {chips.map((chip) => (
        <Chip key={chip} label={chip} />
      ))}
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-destructive/50 p-4 text-destructive">
      {message}
    </div>
  );
}

export default function DrillClient() {
  const searchParams = useSearchParams();
  const range = parseRange(searchParams);
  const view = searchParams.get("view") ?? "facts";

  const chips = [`${range.from} → ${range.to}`];
  const query = new URLSearchParams({ from: range.from, to: range.to });
  const keys =
    view === "outcomes"
      ? (["person", "product", "kind", "tool"] as const)
      : view === "metrics"
        ? (["vendor", "metric", "person", "key"] as const)
        : (["day", "vendor", "person", "product", "key", "model", "basis", "billingMode"] as const);
  for (const key of keys) {
    const value = searchParams.get(key);
    if (!value) continue;
    query.set(key, value);
    if (key === "person" && value === "unassigned") chips.push("Unassigned");
    else if (key === "product" && value === "none") chips.push("No ROI");
    else if (key === "model" && value === "none") chips.push("No model");
    else if (key === "metric") chips.push(value);
    else if (key === "billingMode")
      chips.push(value === "subscription" ? "Subscriptions" : "Metered");
    else {
      // The query param keeps its API name; the chip speaks ROI.
      const label = key === "product" ? "ROI" : key;
      chips.push(`${label}: ${value.length > 12 ? `${value.slice(0, 8)}…` : value}`);
    }
  }

  if (view === "runs") {
    const vendor = searchParams.get("vendor");
    return <RunsView vendor={vendor} chips={vendor ? [`vendor: ${vendor}`] : []} />;
  }
  if (view === "invoices") {
    return (
      <InvoicesView
        months={{ from: range.from.slice(0, 7), to: range.to.slice(0, 7) }}
        chips={[`${range.from.slice(0, 7)} → ${range.to.slice(0, 7)}`]}
      />
    );
  }
  if (view === "outcomes") {
    return <OutcomesView query={query.toString()} chips={chips} />;
  }
  if (view === "metrics") {
    return <MetricsView query={query.toString()} chips={chips} />;
  }
  return <FactsView query={query.toString()} chips={chips} />;
}
