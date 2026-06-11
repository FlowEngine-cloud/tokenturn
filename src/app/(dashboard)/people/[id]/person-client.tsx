"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { DataTable, type Column } from "@/components/data-table";
import { useLatest } from "@/components/form-utils";
import { MintOpenAiKey } from "@/components/mint-openai-key";
import { OffboardPanel } from "@/components/offboard-panel";
import { RowLink, Tile } from "@/components/tile";
import { TrendBars } from "@/components/trend-bars";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents, formatCount, shortDay } from "@/lib/format";
import type { PersonDailyRow, PersonDetail, PersonKeyRow } from "@/lib/people";
import { parseRange, withRange } from "@/lib/range";
import { useFetch } from "@/lib/use-fetch";

/**
 * One person (spec 10 page 2 click-through): spend by vendor, outcomes,
 * $/outcome, trend, daily breakdown, keys and seats, products. Every number
 * links to the raw rows that sum to it; keys click through to /keys/[id].
 * Admins also act from here (spec 8): mint an OpenAI key (shown once) and
 * offboard - every key and seat removed, history kept.
 */

export function PersonSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-64" />
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <Skeleton className="h-40" />
      <Skeleton className="h-64" />
    </div>
  );
}

export default function PersonClient() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const range = parseRange(searchParams);
  // ?v= bump refetches after a write (mint, offboard). useLatest keeps the
  // loaded page - and the shown-once minted key - on screen through the
  // refetch; a RANGE change still shows the skeleton (the kept data is
  // only reused while its window matches).
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);
  const fetched = useFetch<PersonDetail>(
    `/api/people/${id}?from=${range.from}&to=${range.to}&v=${version}`,
  );
  const last = useLatest(fetched.data);
  const data =
    last && last.from === range.from && last.to === range.to ? last : null;
  const { error } = fetched;
  const { data: auth } = useFetch<{ user: { role: string } | null }>(
    "/api/auth/state",
  );
  const isAdmin = auth?.user?.role === "admin";

  // A merged-away id answers with its survivor - move the URL onto them.
  useEffect(() => {
    if (data && data.person.id !== id) {
      router.replace(withRange(`/people/${data.person.id}`, range));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, id, range.from, range.to]);

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 p-4 text-destructive">
        {error}
      </div>
    );
  }
  if (!data) return <PersonSkeleton />;

  const ccy = data.displayCurrency;
  const money = (cents: number) => formatCents(cents, ccy);
  const drill = (query: string) =>
    withRange(`/drill?person=${data.person.id}${query}`, range);
  const outcomesDrill = withRange(
    `/drill?view=outcomes&person=${data.person.id}`,
    range,
  );

  const keyColumns: Column<PersonKeyRow>[] = [
    { key: "vendor", header: "Vendor", render: (r) => r.vendor, csv: (r) => r.vendor },
    {
      key: "key",
      header: "Key / seat",
      render: (r) => (
        <span className="flex items-center gap-2">
          <span className="font-mono text-sm">{r.displayName ?? r.externalId}</span>
          {r.deprovisionedAt && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-sm text-amber-700">
              removed
            </span>
          )}
        </span>
      ),
      csv: (r) => r.displayName ?? r.externalId,
    },
    { key: "kind", header: "Kind", render: (r) => r.kind, csv: (r) => r.kind },
    {
      key: "tags",
      header: "Tags",
      render: (r) =>
        r.tags.length === 0 ? (
          "–"
        ) : (
          <span className="flex flex-wrap gap-1">
            {r.tags.map((tag) => (
              <span key={tag} className="rounded-full border px-2 py-0.5 text-sm">
                {tag}
              </span>
            ))}
          </span>
        ),
      csv: (r) => r.tags.join(" "),
    },
    {
      key: "lastUsed",
      header: "Last used",
      render: (r) => (r.lastUsedDay ? shortDay(r.lastUsedDay) : "never"),
      csv: (r) => r.lastUsedDay,
    },
    {
      key: "spend",
      header: "Spend",
      align: "right",
      render: (r) => money(r.cents),
      csv: (r) => (r.cents / 100).toFixed(2),
    },
  ];

  const dailyColumns: Column<PersonDailyRow>[] = [
    { key: "day", header: "Day", render: (r) => r.day, csv: (r) => r.day },
    { key: "vendor", header: "Vendor", render: (r) => r.vendor, csv: (r) => r.vendor },
    {
      key: "facts",
      header: "Facts",
      align: "right",
      render: (r) => formatCount(r.factCount),
      csv: (r) => r.factCount,
    },
    {
      key: "tokens",
      header: "Tokens",
      align: "right",
      render: (r) => (r.tokens > 0 ? formatCount(r.tokens) : "–"),
      csv: (r) => r.tokens,
    },
    {
      key: "spend",
      header: "Spend",
      align: "right",
      render: (r) => money(r.cents),
      csv: (r) => (r.cents / 100).toFixed(2),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-lg font-semibold">
          {data.person.name ?? data.person.email}
        </h1>
        <span className="text-sm text-muted-foreground">{data.person.email}</span>
        {data.person.status !== "active" && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-sm font-medium text-amber-700">
            {data.person.status}
          </span>
        )}
        <span className="flex-1" />
        {data.person.monthlyLimitUsdCents !== null && (
          <span className="text-sm text-muted-foreground">
            limit {formatCents(data.person.monthlyLimitUsdCents, "USD")}/mo
          </span>
        )}
        {isAdmin && (
          <OffboardPanel
            personId={data.person.id}
            status={data.person.status}
            onChanged={reload}
          />
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Tile title="Spend" href={drill("")}>
          <Link href={drill("")} className="text-3xl font-semibold tabular-nums">
            {money(data.totals.cents)}
          </Link>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatCount(data.totals.factCount)} facts
          </p>
        </Tile>
        <Tile title="Outcomes" href={outcomesDrill}>
          <Link href={outcomesDrill} className="text-3xl font-semibold tabular-nums">
            {formatCount(data.totals.outcomeCount)}
          </Link>
          <div className="mt-1 space-y-0.5 text-sm text-muted-foreground">
            {data.outcomesByKind.map((k) => (
              <RowLink
                key={k.kind}
                href={withRange(
                  `/drill?view=outcomes&person=${data.person.id}&kind=${encodeURIComponent(k.kind)}`,
                  range,
                )}
                label={k.kind}
                value={formatCount(k.count)}
              />
            ))}
            {data.totals.revertedCount > 0 && (
              <p className="px-1 text-amber-700">
                {formatCount(data.totals.revertedCount)} reverted
              </p>
            )}
          </div>
        </Tile>
        <Tile title="$ / outcome" href={outcomesDrill}>
          <p className="text-3xl font-semibold tabular-nums">
            {data.totals.unitCostCents === null
              ? "–"
              : money(data.totals.unitCostCents)}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.totals.outcomeCount > 0
              ? "spend ÷ live outcomes"
              : "no outcomes in range"}
          </p>
        </Tile>
      </div>

      <Tile title="Trend">
        <TrendBars
          points={data.trend}
          hrefFor={(day) => drill(`&day=${day}`)}
          titleFor={(point) => `${shortDay(point.day)} · ${money(point.cents)}`}
        />
        <div className="mt-2 flex justify-between text-sm text-muted-foreground">
          <span>{shortDay(range.from)}</span>
          <span>{shortDay(range.to)}</span>
        </div>
      </Tile>

      <div className="grid gap-4 lg:grid-cols-2">
        <Tile title="By vendor" href={drill("")}>
          <div className="space-y-1">
            {data.byVendor.length === 0 && (
              <p className="py-2 text-sm text-muted-foreground">
                No spend in this range.
              </p>
            )}
            {data.byVendor.map((v) => (
              <RowLink
                key={v.vendor}
                href={drill(`&vendor=${v.vendor}`)}
                label={v.vendor}
                sub={`${formatCount(v.factCount)} facts`}
                value={money(v.cents)}
              />
            ))}
          </div>
        </Tile>
        <Tile title="Products">
          <div className="space-y-1">
            {data.products.length === 0 && (
              <p className="py-2 text-sm text-muted-foreground">
                No product-attributed spend or outcomes in this range.
              </p>
            )}
            {data.products.map((p) => (
              <RowLink
                key={p.productId}
                href={drill(`&product=${p.productId}`)}
                label={p.archived ? `${p.name} (archived)` : p.name}
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

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Keys and seats</h2>
        {isAdmin && data.person.status === "active" && (
          <MintOpenAiKey
            personId={data.person.id}
            personEmail={data.person.email}
            onMinted={reload}
          />
        )}
        {data.keys.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
            No vendor identities map to this person yet - syncs auto-map by
            email, the rest lands in Resolve.
          </p>
        ) : (
          <DataTable
            columns={keyColumns}
            rows={data.keys}
            rowKey={(r) => r.id}
            csvName="ai-pnl-person-keys.csv"
            rowHref={(r) => withRange(`/keys/${r.id}`, range)}
            maxHeightClass="max-h-96"
          />
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Daily breakdown</h2>
        <DataTable
          columns={dailyColumns}
          rows={data.daily}
          rowKey={(r) => `${r.day}:${r.vendor}`}
          csvName="ai-pnl-person-daily.csv"
          rowHref={(r) => drill(`&day=${r.day}&vendor=${r.vendor}`)}
          maxHeightClass="max-h-96"
        />
      </section>
    </div>
  );
}
