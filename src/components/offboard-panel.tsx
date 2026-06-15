"use client";

import { useState } from "react";
import { Dialog } from "radix-ui";
import { Check, Loader2, UserMinus, X } from "lucide-react";
import { useDemo } from "@/components/shell/demo-context";
import { ConfirmButton, ErrorLine } from "@/components/form-utils";
import { Button } from "@/components/ui/button";
import { shortDay } from "@/lib/format";
import type { OffboardOverview, OffboardRow } from "@/lib/provision";

/**
 * Offboard (spec 8 Out + 10.6): a small icon action in the person page
 * header - never a big primary button. It opens a confirm dialog listing
 * exactly what will be removed - every key and seat across every vendor -
 * Confirm removes them all, failed items show the vendor's error verbatim
 * and retry one by one. History kept: removed items stay listed. The GDPR
 * hard-delete (spec 4's one exception) lives at the bottom of the same
 * dialog.
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
      return <span className="min-w-0 break-words text-red-600">{item.error}</span>;
    case "removed":
      return (
        <span className="flex items-center gap-1.5 text-green-700">
          <Check className="h-4 w-4 shrink-0" />
          removed{item.removedAt && ` ${shortDay(item.removedAt.slice(0, 10))}`}
        </span>
      );
  }
}

export function OffboardDialog({
  personId,
  status,
  onChanged,
}: {
  personId: string;
  status: string;
  onChanged: () => void;
}) {
  const demo = useDemo();
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

  const items = overview?.items ?? [];
  const removable = items.filter((item) => item.status !== "removed");

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setOverview(null);
          void load();
        }
      }}
    >
      <Dialog.Trigger asChild>
        <Button variant="ghost" size="sm" aria-label="Offboard" title="Offboard">
          <UserMinus className="h-4 w-4" />
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/25" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border bg-card p-4 shadow-lg">
          <div className="flex items-center gap-2">
            <UserMinus className="h-4 w-4" />
            <Dialog.Title className="font-medium">
              {status === "offboarded" ? "Offboarded" : "Offboard"}
            </Dialog.Title>
            <span className="flex-1" />
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm" aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </Dialog.Close>
          </div>

          <div className="mt-3 space-y-3">
            {!overview ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <>
                {items.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No keys or seats on record across the connected vendors.
                    Confirming still marks the person offboarded and out of
                    current burn checks.
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
                        <span className="break-all font-mono">
                          {item.displayName ?? item.externalId}
                        </span>
                        <span className="flex-1" />
                        <ItemStatus item={item} />
                        {item.status === "failed" && item.itemId && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={retrying !== null || busy || demo}
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
                        disabled={busy || retrying !== null || demo}
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
                    disabled={busy || retrying !== null || demo}
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
                    Irreversible - scrubs their personal data; their spend stays
                    on the ledger as Unassigned and totals never change.
                  </span>
                </div>
              </>
            )}
            <ErrorLine message={error} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
