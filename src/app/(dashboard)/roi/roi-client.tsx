"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Popover } from "radix-ui";
import { Check, ChevronDown, Loader2, Plus, Tag, TrendingUp, X } from "lucide-react";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { send } from "@/components/form-utils";
import { ATTRIBUTION_LABELS, NewProductForm } from "@/components/product-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents, formatCount, formatPct, unitCostLabel } from "@/lib/format";
import { parseRange, withRange } from "@/lib/range";
import type { RoiRow, RoiViewData } from "@/lib/roi";
import type { TagSummary } from "@/lib/tags";
import { useFetch } from "@/lib/use-fetch";

/**
 * ROI (spec 7 + 10 page 3): one list of ROI calculations - the built-in
 * coding-tool rows (success = lines still alive 30 days after the merge,
 * $ and tokens per 1k surviving lines, accept rates) and the user-defined
 * ones. The filter bar slices by tag and vendor; "Add ROI" opens the form;
 * a row click goes to its detail (per-person split, daily breakdown,
 * drills).
 */

export function RoiSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-96" />
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  vendor: "vendor billing",
  metric: "vendor estimate",
  product: "tagged keys",
};

function sourceLabel(row: RoiRow): string {
  if (row.kind === "coding") {
    return `built-in${row.spendSource ? ` · ${SOURCE_LABEL[row.spendSource.type]}` : ""}`;
  }
  return ATTRIBUTION_LABELS[row.attribution ?? ""] ?? "";
}

function TagFilter({
  tags,
  active,
  isAdmin,
  onPick,
  onAdded,
}: {
  tags: TagSummary[];
  active: string | null;
  isAdmin: boolean;
  onPick: (tag: string | null) => void;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = (tag: string | null) => {
    onPick(tag);
    setOpen(false);
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setAdding(false);
          setName("");
          setError(null);
        }
      }}
    >
      <Popover.Trigger asChild>
        <Button variant="outline" size="sm">
          <Tag />
          {active ?? "All tags"}
          <ChevronDown />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-72 rounded-md border bg-popover p-1 shadow-md"
        >
          <div className="max-h-64 overflow-y-auto">
            <button
              onClick={() => pick(null)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            >
              <span className="w-4">{active === null && <Check className="h-4 w-4" />}</span>
              All tags
            </button>
            {tags.map((t) => (
              <button
                key={t.tag}
                onClick={() => pick(t.tag)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span className="w-4">
                  {active === t.tag && <Check className="h-4 w-4" />}
                </span>
                <span className="flex-1 truncate">{t.tag}</span>
                <span className="text-sm text-muted-foreground">
                  {t.identityCount > 0
                    ? `${formatCount(t.identityCount)} ${t.identityCount === 1 ? "key" : "keys"}`
                    : "no keys yet"}
                </span>
              </button>
            ))}
            {tags.length === 0 && (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">No tags yet.</p>
            )}
          </div>
          {isAdmin && (
            <div className="border-t pt-1">
              {!adding ? (
                <button
                  onClick={() => setAdding(true)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <Plus className="h-4 w-4" />
                  Add a tag
                </button>
              ) : (
                <div className="space-y-2 p-2">
                  <div className="flex gap-2">
                    <Input
                      autoFocus
                      className="h-8"
                      placeholder="tag"
                      disabled={busy}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                    />
                    <Button
                      size="sm"
                      disabled={busy || name.trim() === ""}
                      onClick={async () => {
                        setBusy(true);
                        setError(null);
                        const { error: failure } = await send("/api/tags", "POST", {
                          tag: name.trim(),
                        });
                        setBusy(false);
                        if (failure) {
                          setError(failure);
                        } else {
                          setAdding(false);
                          setName("");
                          onAdded();
                        }
                      }}
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Name a key with this tag in the vendor console - its spend shows
                    up under it on next sync.
                  </p>
                  {error && <p className="text-sm text-destructive">{error}</p>}
                </div>
              )}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export default function RoiClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const range = parseRange(searchParams);
  const tagFilter = searchParams.get("tag");
  const vendorFilter = searchParams.get("vendor");
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);

  const { data, error } = useFetch<RoiViewData>(
    `/api/roi?from=${range.from}&to=${range.to}&v=${version}`,
  );
  const { data: tagData } = useFetch<{ tags: TagSummary[] }>(`/api/tags?v=${version}`);
  const { data: auth } = useFetch<{ user: { role: string } | null }>("/api/auth/state");
  const isAdmin = auth?.user?.role === "admin";

  const setParam = (key: string, value: string | null) => {
    const params = new URLSearchParams(searchParams);
    if (value === null) params.delete(key);
    else params.set(key, value);
    const qs = params.toString();
    router.replace(qs === "" ? pathname : `${pathname}?${qs}`);
  };

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 p-4 text-destructive">
        {error}
      </div>
    );
  }
  if (!data) return <RoiSkeleton />;

  const ccy = data.displayCurrency;
  const money = (cents: number) => formatCents(cents, ccy);
  const rows = data.rows.filter(
    (r) =>
      (tagFilter === null || r.tags.includes(tagFilter)) &&
      (vendorFilter === null || r.vendors.includes(vendorFilter)),
  );
  const vendors = [...new Set(data.rows.flatMap((r) => r.vendors))].sort();

  const columns: Column<RoiRow>[] = [
    {
      key: "name",
      header: "ROI",
      render: (r) => (
        <span>
          {r.name}
          <span className="ml-2 text-sm text-muted-foreground">{sourceLabel(r)}</span>
        </span>
      ),
      csv: (r) => r.name,
    },
    {
      key: "spend",
      header: "Spend",
      align: "right",
      render: (r) => (r.spendCents === null ? "–" : money(r.spendCents)),
      csv: (r) => (r.spendCents === null ? null : (r.spendCents / 100).toFixed(2)),
    },
    {
      key: "tokens",
      header: "Tokens",
      align: "right",
      render: (r) => (r.tokens > 0 ? formatCount(r.tokens) : "–"),
      csv: (r) => r.tokens,
    },
    {
      key: "successes",
      header: "Successes",
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
        ) : r.kind === "coding" ? (
          // Lines alive at 30 days; a dash until the survival job has
          // measured a PR in range.
          r.survivalPct === null ? (
            "–"
          ) : (
            <span>{formatCount(r.successes)} lines</span>
          )
        ) : (
          <span>
            {formatCount(r.successes)}
            {r.revertedCount > 0 && (
              <span className="text-amber-700"> · {formatCount(r.revertedCount)} rev</span>
            )}
          </span>
        ),
      csv: (r) => (r.unit === null ? r.activeUsers : r.successes),
    },
    {
      key: "costPerSuccess",
      header: "$ / success",
      align: "right",
      render: (r) =>
        unitCostLabel(
          { unit: r.unit, unitCostCents: r.costPerSuccessCents, costPerUserCents: r.costPerUserCents },
          ccy,
        ),
      csv: (r) =>
        r.costPerSuccessCents === null ? null : (r.costPerSuccessCents / 100).toFixed(2),
    },
    {
      key: "tokensPerSuccess",
      header: "Tokens / success",
      align: "right",
      render: (r) =>
        r.tokensPerSuccess === null ? "–" : formatCount(r.tokensPerSuccess),
      csv: (r) => r.tokensPerSuccess,
    },
    {
      key: "value",
      header: "Value",
      align: "right",
      render: (r) => (r.valueCents === null ? "–" : money(r.valueCents)),
      csv: (r) => (r.valueCents === null ? null : (r.valueCents / 100).toFixed(2)),
    },
    {
      key: "roi",
      header: "ROI ×",
      align: "right",
      render: (r) =>
        r.roi === null ? "–" : <span className="text-green-700">{r.roi}x</span>,
      csv: (r) => r.roi,
    },
    {
      key: "accept",
      header: "Accept",
      align: "right",
      render: (r) => formatPct(r.acceptRatePct),
      csv: (r) => r.acceptRatePct,
    },
    {
      key: "survival",
      header: "Survival",
      align: "right",
      render: (r) => formatPct(r.survivalPct),
      csv: (r) => r.survivalPct,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">ROI</h1>
        <span className="flex-1" />
        <TagFilter
          tags={tagData?.tags ?? []}
          active={tagFilter}
          isAdmin={isAdmin}
          onPick={(tag) => setParam("tag", tag)}
          onAdded={() => setVersion((v) => v + 1)}
        />
        <select
          aria-label="Vendor"
          className="h-8 rounded-md border bg-transparent px-2 text-sm"
          value={vendorFilter ?? ""}
          onChange={(e) => setParam("vendor", e.target.value === "" ? null : e.target.value)}
        >
          <option value="">All vendors</option>
          {vendors.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        {isAdmin && (
          <Button size="sm" onClick={() => setAdding((v) => !v)}>
            {adding ? <X /> : <Plus />}
            Add ROI
          </Button>
        )}
      </div>

      <details className="group rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground">
        <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
          <span>Each row pairs a slice of spend with a success you define - $ and tokens per result.</span>
          <span className="flex-1" />
          <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
        </summary>
        <ul className="mt-3 space-y-1.5">
          <li>Coding tools are built in: their spend against the code still alive in prod 30 days after it lands.</li>
          <li>Add your own: pick where spend comes from (a tagged key, the SDK, a whole vendor) and what counts as success.</li>
          <li>Tags: name a key in the vendor console (stripe-agent-…) and filter by it here.</li>
          <li>
            Full story in{" "}
            <Link href="/help" className="underline underline-offset-2">
              Help
            </Link>
            .
          </li>
        </ul>
      </details>

      {adding && (
        <div className="rounded-lg border bg-card p-4">
          <NewProductForm
            onChanged={() => {
              setAdding(false);
              setVersion((v) => v + 1);
            }}
          />
        </div>
      )}

      {data.rows.length === 0 ? (
        <EmptyState
          icon={TrendingUp}
          title="No ROI yet"
          body='An ROI is a slice of spend and a definition of success. Connect a vendor, add one above, or pick "Add a tag" in the tag filter to route a key&apos;s spend.'
          actionHref="/settings"
          actionLabel="Open Settings"
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.key}
          csvName="tokenturn-roi.csv"
          rowHref={(r) =>
            r.kind === "custom"
              ? withRange(`/products/${r.productId}`, range)
              : withRange(`/roi/coding/${r.tool}`, range)
          }
        />
      )}
    </div>
  );
}
