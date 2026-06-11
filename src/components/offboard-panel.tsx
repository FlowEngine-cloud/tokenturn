"use client";

import { useState } from "react";
import { Check, Loader2, UserMinus } from "lucide-react";
import { ConfirmButton, ErrorLine } from "@/components/form-utils";
import { Button } from "@/components/ui/button";
import { shortDay } from "@/lib/format";
import type { OffboardOverview, OffboardRow } from "@/lib/provision";

/**
 * Offboard (spec 8 Out): the button opens the plan - every key and seat
 * across every vendor - Confirm removes them all, failed items show the
 * vendor's error verbatim and retry one by one. History kept: removed
 * items stay listed.
 */

async function fetchJson(url: string, init?: RequestInit) {
  try {
    const res = await fetch(url, init);
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok) return { error: null as string | null, data };
    return { error: (data?.error as string) ?? `request failed (${res.status})`, data: null };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), data: null };
  }
}

function ItemStatus({ item }: { item: OffboardRow }) {
  switch (item.status) {
    case "active":
      return <span className="text-muted-foreground">will be removed</span>;
    case "pending":
      return <span className="text-amber-700">pending</span>;
    case "failed":
      return <span className="text-red-600">{item.error}</span>;
    case "removed":
      return (
        <span className="flex items-center gap-1.5 text-green-700">
          <Check className="h-4 w-4 shrink-0" />
          removed{item.removedAt && ` ${shortDay(item.removedAt.slice(0, 10))}`}
        </span>
      );
  }
}

export function OffboardPanel({
  personId,
  status,
  onChanged,
}: {
  personId: string;
  status: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<OffboardOverview | null>(null);

  async function load() {
    setError(null);
    const { error: failure, data } = await fetchJson(`/api/people/${personId}/offboard`);
    if (failure) setError(failure);
    else setOverview(data as unknown as OffboardOverview);
  }

  async function run() {
    setBusy(true);
    setError(null);
    const { error: failure, data } = await fetchJson(`/api/people/${personId}/offboard`, {
      method: "POST",
    });
    setBusy(false);
    if (failure) {
      setError(failure);
    } else {
      setOverview(data as unknown as OffboardOverview);
      onChanged();
    }
  }

  async function retry(itemId: string) {
    setRetrying(itemId);
    setError(null);
    const { error: failure } = await fetchJson(`/api/people/${personId}/offboard/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId }),
    });
    setRetrying(null);
    if (failure) setError(failure);
    await load();
    onChanged();
  }

  if (!open) {
    return (
      <Button
        variant={status === "offboarded" ? "outline" : "destructive"}
        size="sm"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        <UserMinus className="h-4 w-4" />
        {status === "offboarded" ? "Offboard status" : "Offboard"}
      </Button>
    );
  }

  const items = overview?.items ?? [];
  const removable = items.filter((item) => item.status !== "removed");
  return (
    <div className="w-full space-y-3 rounded-lg border border-destructive/40 p-4">
      <div className="flex items-center gap-2">
        <UserMinus className="h-4 w-4" />
        <span className="font-medium">
          {status === "offboarded" ? "Offboarded" : "Offboard"}
        </span>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>

      {!overview ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No keys or seats on record across the connected vendors.
              Confirming still marks the person offboarded and out of current
              burn checks.
            </p>
          ) : (
            <ul className="divide-y rounded-md border">
              {items.map((item) => (
                <li
                  key={item.itemId ?? item.identityId ?? item.externalId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
                >
                  <span className="w-20 font-medium">{item.vendor}</span>
                  <span className="w-16 text-muted-foreground">{item.kind}</span>
                  <span className="font-mono">{item.displayName ?? item.externalId}</span>
                  <span className="flex-1" />
                  <ItemStatus item={item} />
                  {item.status === "failed" && item.itemId && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={retrying !== null || busy}
                      onClick={() => void retry(item.itemId!)}
                    >
                      {retrying === item.itemId ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Retry"
                      )}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {(removable.length > 0 || status !== "offboarded") &&
              (busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ConfirmButton
                  label={
                    removable.length > 0
                      ? `Remove ${removable.length} ${removable.length === 1 ? "item" : "items"}`
                      : "Mark offboarded"
                  }
                  confirmLabel="Confirm - remove access"
                  disabled={busy || retrying !== null}
                  onConfirm={() => void run()}
                />
              ))}
            <span className="text-sm text-muted-foreground">
              History stays intact - spend and outcomes keep their drill-downs.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <ConfirmButton
              label="Delete person (GDPR)"
              confirmLabel="Confirm - delete forever"
              disabled={busy || retrying !== null}
              onConfirm={() => {
                void fetchJson(`/api/people/${personId}`, { method: "DELETE" }).then(
                  ({ error: failure }) => {
                    if (failure) setError(failure);
                    else window.location.href = "/people";
                  },
                );
              }}
            />
            <span className="text-sm text-muted-foreground">
              Irreversible - scrubs their personal data; their spend stays on
              the ledger as Unassigned and totals never change.
            </span>
          </div>
        </>
      )}
      <ErrorLine message={error} />
    </div>
  );
}
