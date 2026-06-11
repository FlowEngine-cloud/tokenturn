"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { GitMerge, Loader2 } from "lucide-react";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { RESOLVE_CHANGED_EVENT } from "@/components/shell/nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents, formatCount } from "@/lib/format";
import { parseRange, withRange } from "@/lib/range";
import type { QueueEntry, UnassignedVendor } from "@/lib/resolve";
import type { TagConflict } from "@/lib/tags";
import { useFetch } from "@/lib/use-fetch";

/**
 * Resolve (spec 10 page 5): the identity queue. Suggested matches confirm in
 * one click and are remembered forever; a key can be marked "not a person"
 * and routed to a product or tag; two emails merge into one human, history
 * following the survivor. The nav badge drains as the queue does.
 */

interface ResolveData {
  queue: QueueEntry[];
  unassigned: UnassignedVendor[];
  conflicts: TagConflict[];
}

interface PersonHit {
  id: string;
  name: string | null;
  email: string;
  status: string;
}

export function ResolveSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-40" />
      <Skeleton className="h-40" />
    </div>
  );
}

async function postAction(
  url: string,
  body: Record<string, unknown>,
  method: "POST" | "PATCH" = "POST",
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.error ?? `request failed (${res.status})`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Debounced roster search - one picker for confirm and merge. */
function PersonSearch({
  placeholder,
  onPick,
  disabled,
}: {
  placeholder: string;
  onPick: (person: PersonHit) => void;
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PersonHit[]>([]);

  useEffect(() => {
    const query = q.trim();
    const timer = setTimeout(() => {
      if (query === "") {
        setHits([]);
        return;
      }
      fetch(`/api/search?q=${encodeURIComponent(query)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { people?: PersonHit[] } | null) => {
          if (data?.people) setHits(data.people);
        })
        .catch(() => {});
    }, 150);
    return () => clearTimeout(timer);
  }, [q]);

  return (
    <div className="relative w-full max-w-xs">
      <Input
        value={q}
        disabled={disabled}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        className="h-8"
      />
      {hits.length > 0 && q.trim() !== "" && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border bg-popover shadow-md">
          {hits.map((person) => (
            <button
              key={person.id}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => {
                setQ("");
                setHits([]);
                onPick(person);
              }}
            >
              <span className="truncate">{person.name ?? person.email}</span>
              {person.name && (
                <span className="truncate text-sm text-muted-foreground">
                  {person.email}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="text-sm text-destructive">{message}</p>;
}

function QueueCard({
  entry,
  products,
  keysHref,
  onDone,
}: {
  entry: QueueEntry;
  products: { id: string; name: string }[];
  keysHref: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routeOpen, setRouteOpen] = useState(false);
  const [productId, setProductId] = useState("");
  const [tag, setTag] = useState("");

  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    const failure = await action();
    if (failure) {
      setError(failure);
      setBusy(false);
    } else {
      onDone();
    }
  }

  const confirm = (personId: string) =>
    run(() => postAction(`/api/resolve/${entry.id}/confirm`, { personId }));

  const tags = [...new Set([...entry.tags, ...entry.manualTags])];
  const counts = [
    entry.factCount > 0 && `${formatCount(entry.factCount)} facts`,
    entry.metricCount > 0 && `${formatCount(entry.metricCount)} metrics`,
    entry.outcomeCount > 0 && `${formatCount(entry.outcomeCount)} outcomes`,
  ].filter(Boolean);

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="rounded-full border px-2.5 py-0.5 text-sm text-muted-foreground">
          {entry.vendor} · {entry.kind}
        </span>
        <Link href={keysHref} className="font-mono text-sm hover:underline">
          {entry.displayName ?? entry.externalId}
        </Link>
        {entry.email && (
          <span className="text-sm text-muted-foreground">{entry.email}</span>
        )}
        <span className="flex-1" />
        {counts.length > 0 && (
          <span className="text-sm text-muted-foreground">{counts.join(" · ")}</span>
        )}
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((t) => (
            <span key={t} className="rounded-full border px-2 py-0.5 text-sm">
              {t}
            </span>
          ))}
        </div>
      )}

      {entry.suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {entry.suggestions.map((s) => (
            <Button
              key={s.personId}
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => confirm(s.personId)}
            >
              {s.name ?? s.email}
              <span className="text-muted-foreground">· {s.reason} match</span>
            </Button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <PersonSearch
          placeholder="Confirm someone else…"
          disabled={busy}
          onPick={(person) => confirm(person.id)}
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => setRouteOpen((v) => !v)}
        >
          Not a person
        </Button>
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {routeOpen && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={productId}
            disabled={busy}
            onChange={(e) => setProductId(e.target.value)}
            className="h-8 rounded-md border bg-transparent px-2 text-sm"
          >
            <option value="">Route to ROI…</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Input
            value={tag}
            disabled={busy}
            onChange={(e) => setTag(e.target.value)}
            placeholder="…and/or tag it"
            className="h-8 w-40"
          />
          <Button
            size="sm"
            disabled={busy || (productId === "" && tag.trim() === "")}
            onClick={() =>
              run(() =>
                postAction(`/api/resolve/${entry.id}/not-person`, {
                  ...(productId !== "" ? { productId } : {}),
                  ...(tag.trim() !== "" ? { tag: tag.trim() } : {}),
                }),
              )
            }
          >
            Route
          </Button>
        </div>
      )}

      <ErrorLine message={error} />
    </div>
  );
}

function ConflictCard({
  conflict,
  keysHref,
  onDone,
}: {
  conflict: TagConflict;
  keysHref: string;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-2 rounded-lg border border-amber-500/40 bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="rounded-full border px-2.5 py-0.5 text-sm text-muted-foreground">
          {conflict.vendor} · {conflict.kind}
        </span>
        <Link href={keysHref} className="font-mono text-sm hover:underline">
          {conflict.externalId}
        </Link>
        <span className="text-sm text-amber-700">
          {formatCount(conflict.candidates.length)} tags claim this key - it stays
          unrouted until one lets go
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {conflict.candidates.map((candidate) => (
          <span key={candidate.tag} className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-sm">
            {candidate.tag} → {candidate.productName}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                const failure = await postAction(
                  `/api/tags/${encodeURIComponent(candidate.tag)}`,
                  { productId: null },
                  "PATCH",
                );
                if (failure) {
                  setError(failure);
                  setBusy(false);
                } else {
                  onDone();
                }
              }}
            >
              un-point
            </Button>
          </span>
        ))}
        {busy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>
      <ErrorLine message={error} />
    </div>
  );
}

function MergePanel({ onDone }: { onDone: () => void }) {
  const [from, setFrom] = useState<PersonHit | null>(null);
  const [into, setInto] = useState<PersonHit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function chip(person: PersonHit, clear: () => void) {
    return (
      <button
        className="rounded-full border px-2.5 py-0.5 text-sm hover:bg-accent"
        onClick={clear}
        title="click to clear"
      >
        {person.name ?? person.email}
      </button>
    );
  }

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4">
      <h2 className="text-sm font-medium text-muted-foreground">
        Merge two emails, one human
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        {from ? (
          chip(from, () => setFrom(null))
        ) : (
          <PersonSearch placeholder="Merge this person…" onPick={setFrom} disabled={busy} />
        )}
        <GitMerge className="h-4 w-4 text-muted-foreground" />
        {into ? (
          chip(into, () => setInto(null))
        ) : (
          <PersonSearch placeholder="…into this person" onPick={setInto} disabled={busy} />
        )}
        <Button
          size="sm"
          disabled={busy || !from || !into || from.id === into.id}
          onClick={async () => {
            if (!from || !into) return;
            setBusy(true);
            setError(null);
            const failure = await postAction("/api/resolve/merge", {
              fromPersonId: from.id,
              intoPersonId: into.id,
            });
            if (failure) {
              setError(failure);
            } else {
              setFrom(null);
              setInto(null);
              onDone();
            }
            setBusy(false);
          }}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Merge"}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        The first person archives; their identities, history and email follow the
        second forever.
      </p>
      <ErrorLine message={error} />
    </section>
  );
}

export default function ResolveClient() {
  const searchParams = useSearchParams();
  const range = parseRange(searchParams);
  const [version, setVersion] = useState(0);
  const { data, error } = useFetch<ResolveData>(`/api/resolve?v=${version}`);
  const { data: productData } = useFetch<{ products: { id: string; name: string }[] }>(
    "/api/products",
  );

  const reload = useCallback(() => {
    setVersion((v) => v + 1);
    window.dispatchEvent(new Event(RESOLVE_CHANGED_EVENT));
  }, []);

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 p-4 text-destructive">
        {error}
      </div>
    );
  }
  if (!data) return <ResolveSkeleton />;

  const products = productData?.products ?? [];
  const empty =
    data.queue.length === 0 && data.conflicts.length === 0 && data.unassigned.length === 0;

  const unassignedColumns: Column<UnassignedVendor>[] = [
    { key: "vendor", header: "Vendor", render: (r) => r.vendor, csv: (r) => r.vendor },
    {
      key: "amount",
      header: "Unassigned (USD)",
      align: "right",
      render: (r) => formatCents(r.amountUsdCents, "USD"),
      csv: (r) => (r.amountUsdCents / 100).toFixed(2),
    },
    {
      key: "facts",
      header: "Facts",
      align: "right",
      render: (r) => formatCount(r.factCount),
      csv: (r) => r.factCount,
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Resolve</h1>

      {empty && (
        <EmptyState
          icon={GitMerge}
          title="Nothing to resolve"
          body="Identities auto-map by email across vendors. Whatever can't be matched waits here with suggested matches."
        />
      )}

      {data.queue.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            Queue · {formatCount(data.queue.length)}
          </h2>
          {data.queue.map((entry) => (
            <QueueCard
              key={entry.id}
              entry={entry}
              products={products}
              keysHref={withRange(`/keys/${entry.id}`, range)}
              onDone={reload}
            />
          ))}
        </section>
      )}

      {data.conflicts.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            Tag conflicts · {formatCount(data.conflicts.length)}
          </h2>
          {data.conflicts.map((conflict) => (
            <ConflictCard
              key={conflict.identityId}
              conflict={conflict}
              keysHref={withRange(`/keys/${conflict.identityId}`, range)}
              onDone={reload}
            />
          ))}
        </section>
      )}

      {data.unassigned.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            Unassigned spend
          </h2>
          <DataTable
            columns={unassignedColumns}
            rows={data.unassigned}
            rowKey={(r) => r.vendor}
            csvName="ai-pnl-unassigned.csv"
            rowHref={(r) =>
              withRange(`/drill?vendor=${r.vendor}&person=unassigned&product=none`, range)
            }
          />
        </section>
      )}

      <MergePanel onDone={reload} />
    </div>
  );
}
