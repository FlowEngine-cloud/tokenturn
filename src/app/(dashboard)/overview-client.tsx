"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Plug } from "lucide-react";
import { ConnectorHealthList } from "@/components/connector-health";
import { EmptyState } from "@/components/empty-state";
import { RowLink, Tile } from "@/components/tile";
import { TrendBars } from "@/components/trend-bars";
import { Skeleton } from "@/components/ui/skeleton";
import type { ConnectorHealth } from "@/lib/connectors/health";
import {
  formatCents,
  formatCentsSigned,
  formatCount,
  formatPct,
  shortDay,
} from "@/lib/format";
import type { OverviewData } from "@/lib/overview";
import { parseRange, withRange } from "@/lib/range";

/**
 * Overview (spec 10 page 1). Every tile clicks through to the drill-down
 * rows behind its number - tiles read rollups, drills read raw facts, and
 * the two sum to the same money.
 */

type Payload = OverviewData & { connectors: ConnectorHealth[] };

export function OverviewSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
      </div>
      <Skeleton className="h-40" />
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
      </div>
      <Skeleton className="h-40" />
    </div>
  );
}

export default function OverviewClient() {
  const searchParams = useSearchParams();
  const range = parseRange(searchParams);
  const url = `/api/overview?from=${range.from}&to=${range.to}`;
  // Keyed by URL so a range change shows the skeleton, never stale numbers.
  const [state, setState] = useState<{
    url: string;
    data: Payload | null;
    error: string | null;
  }>({ url: "", data: null, error: null });

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || body === null) {
          setState({ url, data: null, error: body?.error ?? `request failed (${res.status})` });
        } else {
          setState({ url, data: body, error: null });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ url, data: null, error: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const { data, error } = state.url === url ? state : { data: null, error: null };

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 p-4 text-destructive">
        {error}
      </div>
    );
  }
  if (!data) return <OverviewSkeleton />;

  const drill = (query: string) => withRange(`/drill${query}`, range);
  const ccy = data.displayCurrency;
  const money = (cents: number) => formatCents(cents, ccy);

  if (data.totals.factCount === 0) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon={Plug}
          title="No spend in this range"
          body="Connect a vendor and the first sync backfills as far as its history allows - or widen the date range."
          actionHref="/settings"
          actionLabel="Open Settings"
        />
        <Tile title="Connectors">
          <ConnectorHealthList connectors={data.connectors} />
        </Tile>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Tile title="Total spend" href={drill("")}>
          <div className="flex items-baseline gap-3">
            <Link
              href={drill("")}
              data-tour="overview-total"
              className="text-3xl font-semibold tabular-nums"
              title="What you actually pay - metered usage plus flat subscription seats"
            >
              {money(data.totals.totalCents)}
            </Link>
            <span className="text-xs text-muted-foreground">real spend</span>
            {data.drift.invoiceCount > 0 && data.drift.cents !== 0 && (
              <Link
                href={drill("?view=invoices")}
                className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700"
                title="Invoice totals diverge from synced facts - click for the invoices behind it"
              >
                {formatCentsSigned(data.drift.cents, ccy)} drift
              </Link>
            )}
            {data.drift.invoiceCount > 0 && data.drift.cents === 0 && (
              <Link
                href={drill("?view=invoices")}
                className="rounded-full bg-green-600/15 px-2 py-0.5 text-xs font-medium text-green-700"
              >
                invoices reconciled
              </Link>
            )}
          </div>
          <div className="mt-3 space-y-1 text-sm">
            {data.totals.subscriptionCents > 0 && (
              <RowLink
                href={drill("?billingMode=subscription")}
                label="Subscriptions"
                sub="flat seats"
                value={money(data.totals.subscriptionCents)}
              />
            )}
            <RowLink
              href={drill("?billingMode=metered")}
              label="Metered"
              sub="pay-as-you-go"
              value={money(data.totals.meteredCents)}
            />
          </div>
          <div className="mt-3 border-t pt-3">
            <div className="flex items-baseline justify-between">
              <span
                className="text-sm text-muted-foreground"
                title="What all this usage would cost at API rates - on a flat seat it runs well above the fee"
              >
                Usage value
              </span>
              <span className="text-lg font-semibold tabular-nums">
                {money(data.totals.usageValueCents)}
              </span>
            </div>
            {data.totals.subscriptionCents > 0 &&
              data.totals.usageValueCents > data.totals.subscriptionCents && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {money(data.totals.usageValueCents - data.totals.subscriptionCents)} more
                  than the seat fees - the leverage your flat plans buy.
                </p>
              )}
          </div>
        </Tile>

        <Tile
          title="Attribution coverage"
          href={drill("?person=unassigned&product=none")}
        >
          <p className="text-3xl font-semibold tabular-nums">
            {formatPct(data.totals.coveragePct)}
          </p>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${data.totals.coveragePct ?? 0}%` }}
            />
          </div>
          <div className="mt-3 text-sm">
            <RowLink
              href={drill("?person=unassigned&product=none")}
              label="Unassigned"
              value={money(data.totals.unassignedCents)}
            />
          </div>
        </Tile>
      </div>

      <Tile title="Trend">
        <TrendBars
          points={data.trend}
          hrefFor={(day) => drill(`?day=${day}`)}
          titleFor={(point) => `${shortDay(point.day)} · ${money(point.cents)}`}
        />
        <div className="mt-2 flex justify-between text-sm text-muted-foreground">
          <span>{shortDay(range.from)}</span>
          <span>{shortDay(range.to)}</span>
        </div>
      </Tile>

      <div className="grid gap-4 lg:grid-cols-3">
        <Tile title="By vendor">
          <div className="space-y-1">
            {data.byVendor.map((v) => (
              <RowLink
                key={v.vendor}
                href={drill(`?vendor=${v.vendor}`)}
                label={v.vendor}
                sub={
                  v.unassignedCents > 0
                    ? `${money(v.unassignedCents)} unassigned`
                    : undefined
                }
                value={money(v.totalCents)}
              />
            ))}
          </div>
        </Tile>

        <Tile title="Top people">
          <div className="space-y-1">
            {data.topPeople.map((p) => (
              <RowLink
                key={p.personId ?? "unassigned"}
                href={
                  p.personId
                    ? drill(`?person=${p.personId}`)
                    : drill("?person=unassigned&product=none")
                }
                label={p.personId ? (p.name ?? p.email ?? p.personId) : "Unassigned"}
                value={money(p.cents)}
              />
            ))}
          </div>
        </Tile>

        <Tile title="Top ROI">
          <div className="space-y-1">
            {data.topProducts.length === 0 && (
              <p className="py-2 text-sm text-muted-foreground">
                No ROI spend in this range.
              </p>
            )}
            {data.topProducts.map((p) => (
              <RowLink
                key={p.productId}
                href={drill(`?product=${p.productId}`)}
                label={p.name}
                sub={
                  p.outcomeCount > 0
                    ? `${formatCount(p.outcomeCount)} outcomes`
                    : undefined
                }
                value={money(p.cents)}
              />
            ))}
          </div>
        </Tile>
      </div>

      <Tile title="Connectors">
        <ConnectorHealthList connectors={data.connectors} />
      </Tile>
    </div>
  );
}
