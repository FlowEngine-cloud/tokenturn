"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Wrench } from "lucide-react";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { RowLink, Tile } from "@/components/tile";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents, formatCount, formatPct } from "@/lib/format";
import { parseRange, withRange, type DateRange } from "@/lib/range";
import type { ToolPersonRow, ToolsData, ToolSummary } from "@/lib/tools";
import { useFetch } from "@/lib/use-fetch";

/**
 * Tools (spec 10 page 4): cost per merged PR per tool per person, accept
 * rates, revert rates - side by side. Every cell links to the raw rows
 * behind it: vendor facts, the vendor's own usage counters, or the routed
 * product's spend - each labeled for what it is.
 */

export function ToolsSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-40" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Skeleton className="h-44" />
        <Skeleton className="h-44" />
        <Skeleton className="h-44" />
      </div>
      <Skeleton className="h-96" />
    </div>
  );
}

const TOOL_LABELS: Record<string, string> = {
  claude_code: "Claude Code",
  cursor: "Cursor",
  copilot: "Copilot",
  devin: "Devin",
  codex: "Codex",
};

export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool;
}

const SPEND_BASIS: Record<string, string> = {
  vendor: "vendor billing",
  metric: "vendor estimate",
  product: "product spend",
};

/** The drill link for a (tool, person) spend cell - or for the tool total
 * when person is undefined. */
function spendHref(
  summary: ToolSummary,
  range: DateRange,
  personId?: string | null,
): string | null {
  const source = summary.spendSource;
  if (source === null) return null;
  const person =
    personId === undefined
      ? ""
      : personId === null
        ? `&person=unassigned${source.type === "vendor" ? "&product=none" : ""}`
        : `&person=${personId}`;
  if (source.type === "vendor") {
    return withRange(`/drill?vendor=${source.vendor}${person}`, range);
  }
  if (source.type === "metric") {
    return withRange(
      `/drill?view=metrics&vendor=${source.vendor}&metric=${source.metric}${person}`,
      range,
    );
  }
  return withRange(`/drill?product=${source.productId}`, range);
}

function mergesHref(
  tool: string,
  range: DateRange,
  personId?: string | null,
): string {
  const person =
    personId === undefined
      ? ""
      : `&person=${personId === null ? "unassigned" : personId}`;
  return withRange(`/drill?view=outcomes&kind=github_pr&tool=${tool}${person}`, range);
}

function acceptHref(
  summary: ToolSummary,
  range: DateRange,
  personId?: string | null,
): string | null {
  const accept = summary.acceptSource;
  if (accept === null) return null;
  const person =
    personId === undefined
      ? ""
      : `&person=${personId === null ? "unassigned" : personId}`;
  return withRange(
    `/drill?view=metrics&vendor=${accept.vendor}&metric=${accept.accepted},${accept.against}${person}`,
    range,
  );
}

function ToolCard({
  summary,
  range,
  currency,
}: {
  summary: ToolSummary;
  range: DateRange;
  currency: string;
}) {
  const money = (cents: number) => formatCents(cents, currency);
  const headline =
    summary.costPerMergeCents !== null
      ? `${money(summary.costPerMergeCents)} / merge`
      : summary.spendCents !== null
        ? money(summary.spendCents)
        : `${formatCount(summary.merges)} merges`;
  const headlineHref =
    summary.costPerMergeCents !== null
      ? mergesHref(summary.tool, range)
      : (spendHref(summary, range) ?? mergesHref(summary.tool, range));

  return (
    <Tile title={toolLabel(summary.tool)}>
      <Link href={headlineHref} className="text-3xl font-semibold tabular-nums">
        {headline}
      </Link>
      <div className="mt-2 space-y-0.5 text-sm">
        {summary.spendCents !== null && summary.spendSource !== null && (
          <RowLink
            href={spendHref(summary, range)!}
            label="Spend"
            sub={
              summary.spendSource.type === "product"
                ? `product: ${summary.spendSource.productName}`
                : SPEND_BASIS[summary.spendSource.type]
            }
            value={money(summary.spendCents)}
          />
        )}
        <RowLink
          href={mergesHref(summary.tool, range)}
          label="Merged PRs"
          sub={
            summary.peopleCount > 0
              ? `${formatCount(summary.peopleCount)} people`
              : undefined
          }
          value={formatCount(summary.merges)}
        />
        {summary.acceptRatePct !== null && (
          <RowLink
            href={acceptHref(summary, range)!}
            label="Accept rate"
            value={formatPct(summary.acceptRatePct)}
          />
        )}
        {summary.revertRatePct !== null && (
          <RowLink
            href={mergesHref(summary.tool, range)}
            label="Revert rate"
            sub={
              summary.reverted > 0
                ? `${formatCount(summary.reverted)} reverted`
                : undefined
            }
            value={formatPct(summary.revertRatePct)}
          />
        )}
      </div>
    </Tile>
  );
}

export default function ToolsClient() {
  const searchParams = useSearchParams();
  const range = parseRange(searchParams);
  const { data, error } = useFetch<ToolsData>(
    `/api/tools?from=${range.from}&to=${range.to}`,
  );

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 p-4 text-destructive">
        {error}
      </div>
    );
  }
  if (!data) return <ToolsSkeleton />;

  if (data.tools.length === 0) {
    return (
      <EmptyState
        icon={Wrench}
        title="No tool activity in range"
        body="Connect GitHub for merged PRs and revert rates, Anthropic for Claude Code analytics, Cursor or Copilot for per-user usage - the comparison builds itself."
        actionHref="/settings"
        actionLabel="Open Settings"
      />
    );
  }

  const ccy = data.displayCurrency;
  const money = (cents: number) => formatCents(cents, ccy);
  const summaries = new Map(data.tools.map((t) => [t.tool, t]));

  const columns: Column<ToolPersonRow>[] = [
    {
      key: "tool",
      header: "Tool",
      render: (r) => toolLabel(r.tool),
      csv: (r) => r.tool,
    },
    {
      key: "person",
      header: "Person",
      render: (r) =>
        r.personId === null ? (
          <span className="text-muted-foreground">Unassigned</span>
        ) : (
          <Link href={withRange(`/people/${r.personId}`, range)} className="hover:underline">
            {r.name ?? r.email}
          </Link>
        ),
      csv: (r) => r.email ?? "unassigned",
    },
    {
      key: "spend",
      header: "Spend",
      align: "right",
      render: (r) => {
        if (r.spendCents === null) return "–";
        const href = spendHref(summaries.get(r.tool)!, range, r.personId);
        return href ? (
          <Link href={href} className="tabular-nums hover:underline">
            {money(r.spendCents)}
          </Link>
        ) : (
          money(r.spendCents)
        );
      },
      csv: (r) => (r.spendCents === null ? null : (r.spendCents / 100).toFixed(2)),
    },
    {
      key: "merges",
      header: "Merged PRs",
      align: "right",
      render: (r) =>
        r.merges > 0 || r.reverted > 0 ? (
          <Link
            href={mergesHref(r.tool, range, r.personId)}
            className="tabular-nums hover:underline"
          >
            {formatCount(r.merges)}
          </Link>
        ) : (
          "–"
        ),
      csv: (r) => r.merges,
    },
    {
      key: "unit",
      header: "$ / merge",
      align: "right",
      render: (r) => (r.costPerMergeCents === null ? "–" : money(r.costPerMergeCents)),
      csv: (r) =>
        r.costPerMergeCents === null ? null : (r.costPerMergeCents / 100).toFixed(2),
    },
    {
      key: "accept",
      header: "Accept rate",
      align: "right",
      render: (r) => {
        if (r.acceptRatePct === null) return "–";
        const href = acceptHref(summaries.get(r.tool)!, range, r.personId);
        return href ? (
          <Link href={href} className="tabular-nums hover:underline">
            {formatPct(r.acceptRatePct)}
          </Link>
        ) : (
          formatPct(r.acceptRatePct)
        );
      },
      csv: (r) => r.acceptRatePct,
    },
    {
      key: "revert",
      header: "Reverted",
      align: "right",
      render: (r) =>
        r.reverted > 0 ? (
          <Link
            href={mergesHref(r.tool, range, r.personId)}
            className="tabular-nums text-yellow-500 hover:underline"
          >
            {formatCount(r.reverted)}
          </Link>
        ) : (
          "–"
        ),
      csv: (r) => r.reverted,
    },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Tools</h1>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data.tools.map((summary) => (
          <ToolCard key={summary.tool} summary={summary} range={range} currency={ccy} />
        ))}
      </div>
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Per person</h2>
        <DataTable
          columns={columns}
          rows={data.rows}
          rowKey={(r) => `${r.tool}:${r.personId ?? "unassigned"}`}
          csvName="ai-pnl-tools.csv"
        />
      </section>
    </div>
  );
}
