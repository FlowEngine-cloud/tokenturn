"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { DataTable, type Column } from "@/components/data-table";
import { Tile } from "@/components/tile";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents, formatCount, shortDay } from "@/lib/format";
import type { KeyDetail, KeyModelRow } from "@/lib/people";
import { parseRange, withRange } from "@/lib/range";
import { useFetch } from "@/lib/use-fetch";

/**
 * One vendor identity (spec 10 page 2): its tags say what it's for and
 * where it's plugged - by convention, the key's name (spec 7b) - plus
 * owner, product routing, models, last used. All-time numbers from the
 * key's own raw facts; the drill links carry the key's full span so the
 * rows shown sum to the numbers here.
 */

export function KeySkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-64" />
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

export default function KeyClient() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const range = parseRange(searchParams);
  const { data, error } = useFetch<KeyDetail>(`/api/keys/${id}`);

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 p-4 text-destructive">
        {error}
      </div>
    );
  }
  if (!data) return <KeySkeleton />;

  const ccy = data.displayCurrency;
  const money = (cents: number) => formatCents(cents, ccy);
  // The key's facts span this window - drills carry it so they sum to the
  // all-time numbers on this page.
  const span =
    data.firstUsedDay && data.lastUsedDay
      ? { from: data.firstUsedDay, to: data.lastUsedDay }
      : range;
  const drill = (query: string) => withRange(`/drill?key=${data.key.id}${query}`, span);

  const modelColumns: Column<KeyModelRow>[] = [
    {
      key: "model",
      header: "Model",
      render: (r) => r.model ?? <span className="text-muted-foreground">no model</span>,
      csv: (r) => r.model,
    },
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
      key: "lastDay",
      header: "Last used",
      render: (r) => shortDay(r.lastDay),
      csv: (r) => r.lastDay,
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
        <h1 className="font-mono text-lg font-semibold">
          {data.key.displayName ?? data.key.externalId}
        </h1>
        <span className="text-sm text-muted-foreground">
          {data.key.vendor} · {data.key.kind}
        </span>
        {data.key.notPerson && (
          <span className="rounded-full border px-2 py-0.5 text-sm text-muted-foreground">
            not a person
          </span>
        )}
      </div>

      {data.tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {data.tags.map((tag) => (
            <span
              key={tag.tag}
              className="flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm"
              title={tag.source === "manual" ? "added in Resolve" : "from the vendor-side key name"}
            >
              {tag.tag}
              {tag.productName && (
                <span className="text-muted-foreground">→ {tag.productName}</span>
              )}
              {!tag.countsPersonal && (
                <span className="text-amber-700">excluded from personal</span>
              )}
            </span>
          ))}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Tile title="Owner">
          {data.owner ? (
            <Link
              href={withRange(`/people/${data.owner.id}`, range)}
              className="text-lg font-medium hover:underline"
            >
              {data.owner.name ?? data.owner.email}
            </Link>
          ) : (
            <p className="text-lg text-muted-foreground">
              {data.key.notPerson ? "not a person" : "unresolved"}
            </p>
          )}
          {data.owner && (
            <p className="mt-1 text-sm text-muted-foreground">{data.owner.email}</p>
          )}
          {!data.owner && !data.key.notPerson && (
            <Link
              href="/resolve"
              className="mt-1 block text-sm text-muted-foreground hover:text-foreground"
            >
              Resolve →
            </Link>
          )}
        </Tile>
        <Tile title="Product">
          {data.product ? (
            <Link
              href={withRange(`/drill?product=${data.product.id}`, span)}
              className="text-lg font-medium hover:underline"
            >
              {data.product.name}
              {data.product.archived && (
                <span className="ml-2 text-sm text-muted-foreground">archived</span>
              )}
            </Link>
          ) : (
            <p className="text-lg text-muted-foreground">none</p>
          )}
        </Tile>
        <Tile title="Spend (all time)" href={drill("")}>
          <Link href={drill("")} className="text-3xl font-semibold tabular-nums">
            {money(data.totalCents)}
          </Link>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatCount(data.factCount)} facts
            {data.lastUsedDay
              ? ` · last used ${shortDay(data.lastUsedDay)}`
              : " · never used"}
          </p>
        </Tile>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Models</h2>
        <DataTable
          columns={modelColumns}
          rows={data.models}
          rowKey={(r) => r.model ?? "none"}
          csvName="ai-pnl-key-models.csv"
          rowHref={(r) => drill(`&model=${encodeURIComponent(r.model ?? "none")}`)}
          maxHeightClass="max-h-96"
        />
      </section>
    </div>
  );
}
