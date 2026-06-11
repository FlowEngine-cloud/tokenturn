"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Wrench } from "lucide-react";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { RowLink, Tile } from "@/components/tile";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents, formatCount, formatPct, toolLabel } from "@/lib/format";
import { parseRange, withRange, type DateRange } from "@/lib/range";
import type { ToolPersonRow, ToolsData, ToolSummary } from "@/lib/tools";
import { useFetch } from "@/lib/use-fetch";

/**
 * One built-in coding-tool ROI (spec 10 page 3 click-through): cost per
 * merged PR per person, accept and revert rates, and line survival (lines
 * written, % alive at 30/90 days, cost per 1,000 surviving lines - the
 * background git checks, spec 5). Every cell links to the raw rows behind
 * it: vendor facts, the vendor's own usage counters, or the routed spend -
 * each labeled for what it is.
 */

export function CodingToolSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-40" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
      <Skeleton className="h-96" />
    </div>
  );
}

const SPEND_BASIS: Record<string, string> = {
  vendor: "vendor billing",
  metric: "vendor estimate",
  product: "routed spend",
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

export default function CodingToolClient() {
  const params = useParams<{ tool: string }>();
  const tool = params.tool;
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
  if (!data) return <CodingToolSkeleton />;

  const summary = data.tools.find((t) => t.tool === tool);
  if (!summary) {
    return (
      <EmptyState
        icon={Wrench}
        title={`No ${toolLabel(tool)} activity in range`}
        body="Connect GitHub for merged PRs and revert rates, Anthropic for Claude Code analytics, Cursor or Copilot for per-user usage."
        actionHref="/settings"
        actionLabel="Open Settings"
      />
    );
  }

  const ccy = data.displayCurrency;
  const money = (cents: number) => formatCents(cents, ccy);
  const rows = data.rows.filter((r) => r.tool === tool);

  const columns: Column<ToolPersonRow>[] = [
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
        const href = spendHref(summary, range, r.personId);
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
            href={mergesHref(tool, range, r.personId)}
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
        const href = acceptHref(summary, range, r.personId);
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
            href={mergesHref(tool, range, r.personId)}
            className="tabular-nums text-amber-700 hover:underline"
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
      <h1 className="text-lg font-semibold">{toolLabel(tool)}</h1>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <Tile title="Spend" href={spendHref(summary, range) ?? undefined}>
          {summary.spendCents !== null && summary.spendSource !== null ? (
            <>
              <Link
                href={spendHref(summary, range)!}
                className="text-3xl font-semibold tabular-nums"
              >
                {money(summary.spendCents)}
              </Link>
              <p className="mt-1 text-sm text-muted-foreground">
                {summary.spendSource.type === "product"
                  ? `via ${summary.spendSource.productName}`
                  : SPEND_BASIS[summary.spendSource.type]}
                {summary.tokens > 0 && ` · ${formatCount(summary.tokens)} tokens`}
              </p>
            </>
          ) : (
            <p className="text-3xl font-semibold text-muted-foreground">–</p>
          )}
        </Tile>
        <Tile title="Merged PRs" href={mergesHref(tool, range)}>
          <Link
            href={mergesHref(tool, range)}
            className="text-3xl font-semibold tabular-nums"
          >
            {formatCount(summary.merges)}
          </Link>
          <p className="mt-1 text-sm text-muted-foreground">
            {summary.costPerMergeCents !== null &&
              `${money(summary.costPerMergeCents)} / merge`}
            {summary.peopleCount > 0 &&
              `${summary.costPerMergeCents !== null ? " · " : ""}${formatCount(summary.peopleCount)} people`}
          </p>
        </Tile>
        <Tile title="Accept rate" href={acceptHref(summary, range) ?? undefined}>
          {summary.acceptRatePct !== null ? (
            <Link
              href={acceptHref(summary, range)!}
              className="text-3xl font-semibold tabular-nums"
            >
              {formatPct(summary.acceptRatePct)}
            </Link>
          ) : (
            <p className="text-3xl font-semibold text-muted-foreground">–</p>
          )}
        </Tile>
        <Tile title="Revert rate">
          {summary.revertRatePct !== null ? (
            <>
              <RowLink
                href={mergesHref(tool, range)}
                label="Reverted"
                value={formatPct(summary.revertRatePct)}
              />
              {summary.reverted > 0 && (
                <p className="mt-1 px-1 text-sm text-amber-700">
                  {formatCount(summary.reverted)} reverted
                </p>
              )}
            </>
          ) : (
            <p className="text-3xl font-semibold text-muted-foreground">–</p>
          )}
        </Tile>
        <Tile title="Survival 30d" href={mergesHref(tool, range)}>
          {summary.survivalPct !== null ? (
            <>
              <Link
                href={mergesHref(tool, range)}
                className="text-3xl font-semibold tabular-nums"
              >
                {formatPct(summary.survivalPct)}
              </Link>
              <p className="mt-1 text-sm text-muted-foreground">
                {formatCount(summary.linesAlive)} of {formatCount(summary.linesWritten)} lines
                {summary.survival90Pct !== null &&
                  ` · 90d ${formatPct(summary.survival90Pct)}`}
                {summary.costPer1kSurvivingCents !== null &&
                  ` · ${money(summary.costPer1kSurvivingCents)} / 1k lines`}
              </p>
            </>
          ) : (
            <p className="text-3xl font-semibold text-muted-foreground">–</p>
          )}
        </Tile>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Per person</h2>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.personId ?? "unassigned"}
          csvName={`ai-pnl-roi-${tool}.csv`}
        />
      </section>
    </div>
  );
}
