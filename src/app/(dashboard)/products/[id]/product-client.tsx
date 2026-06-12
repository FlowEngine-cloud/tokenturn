"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { DataTable, type Column } from "@/components/data-table";
import { ConfirmButton, ErrorLine, send, useLatest } from "@/components/form-utils";
import {
  ATTRIBUTION_LABELS,
  ManualEntryForm,
  OUTCOME_LABELS,
  ProductFields,
  productBody,
  type ProductFieldsValue,
} from "@/components/product-form";
import { RowLink, Tile } from "@/components/tile";
import { TrendBars } from "@/components/trend-bars";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { TrackedIssueRow } from "@/lib/connectors/issues";
import { formatCents, formatCount, shortDay } from "@/lib/format";
import type {
  ManualEntry,
  Product,
  ProductDailyRow,
  ProductDetail,
  ProductKeyRow,
} from "@/lib/products";
import { parseRange, withRange } from "@/lib/range";
import { useFetch } from "@/lib/use-fetch";

/**
 * One ROI (spec 10 page 3 click-through): spend, outcomes and unit cost
 * in its own unit, value and ROI where real, by vendor / person /
 * day, the keys routed to it (spec 7b) and its manual entries. Every number
 * links to the raw rows that sum to it. Admins manage the row here - rename,
 * change the slice or success, archive, record manual months.
 */

function ManagePanel({ product, onChanged }: { product: Product; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<ProductFieldsValue>({
    name: product.name,
    attribution: product.attribution,
    outcomeKind: product.outcomeKind,
    defaultValue:
      product.defaultValueCents === null ? "" : (product.defaultValueCents / 100).toFixed(2),
    defaultCurrency: product.defaultValueCurrency ?? "USD",
  });

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const { error: failure } = await send(`/api/products/${product.id}`, "PATCH", body);
    setBusy(false);
    if (failure) setError(failure);
    else onChanged();
  }

  const archived = product.archivedAt !== null;
  return (
    <section className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">Manage</h2>
        <span className="flex-1" />
        <ConfirmButton
          label={archived ? "Restore" : "Archive"}
          confirmLabel={archived ? "Confirm restore" : "Confirm archive"}
          disabled={busy}
          onConfirm={() => void patch({ archived: !archived })}
        />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <ProductFields value={fields} onChange={setFields} disabled={busy} idPrefix="manage" />
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            const body = productBody(fields);
            if (typeof body === "string") setError(body);
            else void patch(body);
          }}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
        </Button>
      </div>
      {!archived && <ManualEntryForm product={product} onChanged={onChanged} />}
      <ErrorLine message={error} />
    </section>
  );
}

export function ProductSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-64" />
      <div className="grid gap-4 md:grid-cols-4">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <Skeleton className="h-40" />
      <Skeleton className="h-64" />
    </div>
  );
}

export default function ProductClient() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const range = parseRange(searchParams);
  // ?v= bump refetches after a manage write; useLatest keeps the page mounted
  // (a skeleton swap would eat the form's "saved" state mid-edit).
  const [version, setVersion] = useState(0);
  const { data: auth } = useFetch<{ user: { role: string } | null }>("/api/auth/state");
  const fetched = useFetch<ProductDetail & { issues: TrackedIssueRow[] }>(
    `/api/products/${id}?from=${range.from}&to=${range.to}&v=${version}`,
  );
  const data = useLatest(fetched.data);
  const { error } = fetched;

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 p-4 text-destructive">
        {error}
      </div>
    );
  }
  if (!data) return <ProductSkeleton />;

  const ccy = data.displayCurrency;
  const money = (cents: number) => formatCents(cents, ccy);
  const drill = (query = "") =>
    withRange(`/drill?product=${data.product.id}${query}`, range);
  const outcomesDrill = withRange(
    `/drill?view=outcomes&product=${data.product.id}`,
    range,
  );
  const m = data.metrics;
  const basisParts = (
    [
      ["estimated", m.spendByBasis.estimated],
      ["invoiced", m.spendByBasis.invoiced],
      ["manual", m.spendByBasis.manual],
    ] as const
  ).filter(([, cents]) => cents !== 0);

  const keyColumns: Column<ProductKeyRow>[] = [
    { key: "vendor", header: "Vendor", render: (r) => r.vendor, csv: (r) => r.vendor },
    {
      key: "key",
      header: "Key / seat",
      render: (r) => (
        <span className="font-mono text-sm">{r.displayName ?? r.externalId}</span>
      ),
      csv: (r) => r.displayName ?? r.externalId,
    },
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

  const entryColumns: Column<ManualEntry>[] = [
    { key: "month", header: "Month", render: (r) => r.month, csv: (r) => r.month },
    { key: "kind", header: "Kind", render: (r) => r.kind, csv: (r) => r.kind },
    {
      key: "amount",
      header: "Cost",
      align: "right",
      render: (r) =>
        r.amountCents === null ? "–" : formatCents(r.amountCents, r.currency ?? "USD"),
      csv: (r) => (r.amountCents === null ? null : (r.amountCents / 100).toFixed(2)),
    },
    {
      key: "outcomes",
      header: "Outcomes",
      align: "right",
      render: (r) => (r.outcomeCount === null ? "–" : formatCount(r.outcomeCount)),
      csv: (r) => r.outcomeCount,
    },
    {
      key: "value",
      header: "Value / success",
      align: "right",
      render: (r) =>
        r.valueCents === null ? "–" : formatCents(r.valueCents, r.valueCurrency ?? "USD"),
      csv: (r) => (r.valueCents === null ? null : (r.valueCents / 100).toFixed(2)),
    },
    { key: "note", header: "Note", render: (r) => r.note ?? "–", csv: (r) => r.note },
  ];

  // The ticket list behind the issue successes (spec 7): every tracked
  // Jira/Linear issue routed here, with the state the machine derived from
  // its status history. The key links to the real issue - the drill.
  const ISSUE_STATUS_CLASS: Record<TrackedIssueRow["status"], string> = {
    pending: "text-muted-foreground",
    success: "text-green-700",
    fail: "text-amber-700",
  };
  const issueColumns: Column<TrackedIssueRow>[] = [
    {
      key: "key",
      header: "Issue",
      render: (r) => (
        <a
          href={r.sourceRef}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-sm underline-offset-2 hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {r.key}
        </a>
      ),
      csv: (r) => r.key,
    },
    {
      key: "title",
      header: "Title",
      render: (r) => <span className="line-clamp-1">{r.title ?? "–"}</span>,
      csv: (r) => r.title,
    },
    { key: "project", header: "Project", render: (r) => r.project, csv: (r) => r.project },
    {
      key: "who",
      header: "Who",
      render: (r) => r.personName ?? r.personEmail ?? r.identityName ?? "–",
      csv: (r) => r.personName ?? r.personEmail ?? r.identityName,
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <span className={ISSUE_STATUS_CLASS[r.status]}>{r.status}</span>,
      csv: (r) => r.status,
    },
    {
      key: "day",
      header: "Day",
      align: "right",
      render: (r) =>
        r.decidedAt !== null
          ? shortDay(r.decidedAt.slice(0, 10))
          : `window ends ${shortDay(r.windowEnd.slice(0, 10))}`,
      csv: (r) => (r.decidedAt ?? r.windowEnd).slice(0, 10),
    },
  ];

  const dailyColumns: Column<ProductDailyRow>[] = [
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
        <h1 className="text-lg font-semibold">{data.product.name}</h1>
        <span className="text-sm text-muted-foreground">
          {ATTRIBUTION_LABELS[data.product.attribution]}
          {data.product.outcomeKind !== "none" &&
            ` · ${OUTCOME_LABELS[data.product.outcomeKind]}`}
        </span>
        {data.product.archivedAt !== null && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-sm font-medium text-amber-700">
            archived
          </span>
        )}
        <span className="flex-1" />
        {data.product.defaultValueCents !== null && (
          <span className="text-sm text-muted-foreground">
            default value{" "}
            {formatCents(
              data.product.defaultValueCents,
              data.product.defaultValueCurrency ?? "USD",
            )}
            /success
          </span>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Tile title="Spend" href={drill()}>
          <Link href={drill()} className="text-3xl font-semibold tabular-nums">
            {money(m.spendCents)}
          </Link>
          <p className="mt-1 text-sm text-muted-foreground">
            {basisParts.length > 1
              ? basisParts.map(([basis, cents]) => `${basis} ${money(cents)}`).join(" · ")
              : `${formatCount(m.factCount)} facts`}
          </p>
        </Tile>
        <Tile title="Outcomes" href={outcomesDrill}>
          <Link href={outcomesDrill} className="text-3xl font-semibold tabular-nums">
            {formatCount(m.outcomes)}
          </Link>
          <div className="mt-1 space-y-0.5 text-sm text-muted-foreground">
            {data.outcomesByKind.map((k) => (
              <RowLink
                key={k.kind}
                href={withRange(
                  `/drill?view=outcomes&product=${data.product.id}&kind=${encodeURIComponent(k.kind)}`,
                  range,
                )}
                label={k.kind}
                value={formatCount(k.count)}
              />
            ))}
            {m.revertedOutcomes > 0 && (
              <p className="px-1 text-amber-700">
                {formatCount(m.revertedOutcomes)} reverted
              </p>
            )}
          </div>
        </Tile>
        <Tile
          title={m.unit !== null ? `${ccy} / ${m.unit}` : `${ccy} / active user`}
          href={m.unit !== null ? outcomesDrill : drill()}
        >
          <p className="text-3xl font-semibold tabular-nums">
            {(() => {
              const cents = m.unit !== null ? m.unitCostCents : m.costPerUserCents;
              return cents === null ? "–" : money(cents);
            })()}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {m.unit !== null
              ? m.outcomes > 0
                ? `spend ÷ ${formatCount(m.outcomes)} live`
                : "no outcomes in range"
              : m.activeUsers > 0
                ? `spend ÷ ${formatCount(m.activeUsers)} active users`
                : "no attributed users in range"}
          </p>
        </Tile>
        <Tile title="ROI" href={outcomesDrill}>
          <p className="text-3xl font-semibold tabular-nums">
            {m.roi === null ? "–" : <span className="text-green-700">{m.roi}x</span>}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {m.valueCents === null
              ? "no recorded value"
              : `${money(m.valueCents)} value ÷ spend`}
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
        <Tile title="By vendor" href={drill()}>
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
        <Tile title="By person">
          <div className="space-y-1">
            {data.byPerson.length === 0 && (
              <p className="py-2 text-sm text-muted-foreground">
                No attributed spend or outcomes in this range.
              </p>
            )}
            {data.byPerson.map((p) => (
              <RowLink
                key={p.personId ?? "none"}
                href={drill(`&person=${p.personId ?? "unassigned"}`)}
                label={
                  p.personId === null ? "No person" : (p.name ?? p.email ?? p.personId)
                }
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

      {data.keys.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Keys routed here
          </h2>
          <DataTable
            columns={keyColumns}
            rows={data.keys}
            rowKey={(r) => r.id}
            csvName="tokenturn-roi-keys.csv"
            rowHref={(r) => withRange(`/keys/${r.id}`, range)}
            maxHeightClass="max-h-96"
          />
        </section>
      )}

      {data.issues.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Issues</h2>
          <DataTable
            columns={issueColumns}
            rows={data.issues}
            rowKey={(r) => `${r.vendor}:${r.sourceRef}`}
            csvName="tokenturn-roi-issues.csv"
            maxHeightClass="max-h-96"
          />
        </section>
      )}

      {data.manualEntries.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Manual entries
          </h2>
          <DataTable
            columns={entryColumns}
            rows={data.manualEntries}
            rowKey={(r) => r.id}
            csvName="tokenturn-roi-manual-entries.csv"
            rowHref={(r) =>
              r.kind === "cost"
                ? `/drill?product=${data.product.id}&vendor=manual&day=${r.month}-01&from=${r.month}-01&to=${r.month}-01`
                : `/drill?view=outcomes&product=${data.product.id}&kind=manual&from=${r.month}-01&to=${r.month}-01`
            }
            maxHeightClass="max-h-96"
          />
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Daily breakdown</h2>
        <DataTable
          columns={dailyColumns}
          rows={data.daily}
          rowKey={(r) => `${r.day}:${r.vendor}`}
          csvName="tokenturn-roi-daily.csv"
          rowHref={(r) => drill(`&day=${r.day}&vendor=${r.vendor}`)}
          maxHeightClass="max-h-96"
        />
      </section>

      {auth?.user?.role === "admin" && (
        <ManagePanel
          key={`${data.product.id}:${data.product.archivedAt ?? "live"}`}
          product={data.product}
          onChanged={() => setVersion((v) => v + 1)}
        />
      )}
    </div>
  );
}
