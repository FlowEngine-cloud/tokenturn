"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Package, Users } from "lucide-react";
import { ConnectorCard } from "@/components/connector-card";
import { ErrorLine, send, useLatest } from "@/components/form-utils";
import { PeopleCsvImport } from "@/components/people-csv-import";
import { NewProductForm } from "@/components/product-form";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ConnectorHealth } from "@/lib/connectors/health";
import { formatCount } from "@/lib/format";
import type { OnboardingState } from "@/lib/onboarding";
import { useFetch } from "@/lib/use-fetch";
import { cn } from "@/lib/utils";
import { OverviewSkeleton } from "./overview-client";

/**
 * Onboarding (spec 10): first boot -> the admin claims the instance -> one
 * popup (import employees or start with demo data) -> one screen with the
 * three options (connect a vendor, upload the people CSV, name a product)
 * with live backfill progress - then it becomes the Overview. Existing
 * instances (no onboarding stage in settings) never see any of this.
 */

const POLL_MS = 4000;

function StartPopup({ onChanged }: { onChanged: () => void }) {
  const [busy, setBusy] = useState<"people" | "demo" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function choose(kind: "people" | "demo") {
    setBusy(kind);
    setError(null);
    const { error: failure } =
      kind === "demo"
        ? await send("/api/demo", "POST")
        : await send("/api/onboarding", "PATCH", { stage: "setup" });
    setBusy(null);
    if (failure) setError(failure);
    else onChanged();
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/25 p-4">
      <div className="w-full max-w-lg space-y-5 rounded-xl border bg-card p-8 shadow-xl">
        <h1 className="text-xl font-semibold">{"Welcome to AI P&L"}</h1>
        <div className="grid gap-3">
          <button
            type="button"
            disabled={busy !== null}
            className="rounded-lg border p-4 text-left transition-colors hover:border-primary/60 disabled:opacity-60"
            onClick={() => choose("people")}
          >
            <span className="flex items-center gap-2 font-medium">
              {busy === "people" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Users className="h-4 w-4" />
              )}
              Import employees
            </span>
          </button>
          <button
            type="button"
            disabled={busy !== null}
            className="rounded-lg border p-4 text-left transition-colors hover:border-primary/60 disabled:opacity-60"
            onClick={() => choose("demo")}
          >
            <span className="flex items-center gap-2 font-medium">
              {busy === "demo" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Package className="h-4 w-4" />
              )}
              Start with demo data
            </span>
            <span className="mt-1 block text-sm text-muted-foreground">
              Wiped when a real vendor connects.
            </span>
          </button>
        </div>
        <ErrorLine message={error} />
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  done,
  caption,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  caption: string | null;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-medium",
            done ? "bg-green-600/15 text-green-700" : "bg-muted text-muted-foreground",
          )}
        >
          {done ? <Check className="h-4 w-4" /> : n}
        </span>
        <h2 className="font-medium">{title}</h2>
        {caption && <span className="text-sm text-green-700">{caption}</span>}
      </div>
      {children}
    </section>
  );
}

function SetupScreen({
  state,
  version,
  onChanged,
  onDone,
}: {
  state: OnboardingState;
  version: number;
  onChanged: () => void;
  onDone: () => void;
}) {
  const connectorData = useLatest(
    useFetch<{ connectors: ConnectorHealth[] }>(`/api/connectors?v=${version}`).data,
  );
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finished = useRef(false);

  async function finish() {
    if (finished.current) return;
    finished.current = true;
    setFinishing(true);
    const { error: failure } = await send("/api/onboarding", "PATCH", { stage: "done" });
    setFinishing(false);
    if (failure) {
      finished.current = false;
      setError(failure);
    } else {
      onDone();
    }
  }

  // Live backfill progress, "then it becomes the Overview" (spec 10): the
  // moment the first real connector's backfill lands, this screen retires
  // itself. The demo wipe already ran on connect, so the Overview opening
  // here shows real rows only.
  const connectors = connectorData?.connectors ?? [];
  const backfillLanded = connectors.some(
    (c) => c.connected && c.lastRun?.status === "success" && !c.inProgress,
  );
  const backfilling = connectors.find((c) => c.connected && c.inProgress);
  useEffect(() => {
    if (!backfillLanded) return;
    const timer = setTimeout(() => void finish(), 0); // deferred: no setState mid-effect
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backfillLanded]);

  if (!connectorData) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-48" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    );
  }

  const { connectors: connected, people, products } = state.progress;
  const counted = (n: number, one: string, many: string) =>
    `${formatCount(n)} ${n === 1 ? one : many}`;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Three steps to a real dashboard</h1>
        <span className="flex-1" />
        <Button variant="outline" size="sm" disabled={finishing} onClick={finish}>
          {finishing ? <Loader2 className="h-4 w-4 animate-spin" /> : "Open dashboard →"}
        </Button>
      </div>

      {state.demo.present && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700">
          Demo data - wiped when a real vendor connects.
        </p>
      )}
      {backfilling?.inProgress && (
        <p className="rounded-md border border-green-700/30 bg-green-600/10 px-3 py-2 text-sm text-green-700">
          {backfilling.displayName} backfilling {backfilling.inProgress.since} →{" "}
          {backfilling.inProgress.until}
        </p>
      )}

      <Step
        n={1}
        title="Connect a vendor"
        done={connected > 0}
        caption={connected > 0 ? `${formatCount(connected)} connected` : null}
      >
        <div className="space-y-3">
          {connectors.map((c) => (
            <ConnectorCard key={c.vendor} c={c} isAdmin onChanged={onChanged} />
          ))}
        </div>
      </Step>

      <Step
        n={2}
        title="Upload your people CSV"
        done={people > 0}
        caption={people > 0 ? counted(people, "person", "people") : null}
      >
        <PeopleCsvImport onImported={onChanged} />
      </Step>

      <Step
        n={3}
        title="Add an ROI"
        done={products > 0}
        caption={products > 0 ? counted(products, "ROI", "ROIs") : null}
      >
        <NewProductForm onChanged={onChanged} />
      </Step>

      <ErrorLine message={error} />
    </div>
  );
}

export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);

  // Role is pinned to a constant URL so it never flickers mid-refetch.
  const { data: auth } = useFetch<{ user: { role: string } | null }>("/api/auth/state");
  const stateFetch = useFetch<OnboardingState>(`/api/onboarding?v=${version}`);
  const state = useLatest(stateFetch.data);
  const stage = state?.stage;
  const inSetup = stage === "setup" && auth?.user?.role === "admin";

  // Live progress: while the setup screen is up, poll - backfill windows,
  // CSV/product counts and the auto-finish all ride the same refetch.
  useEffect(() => {
    if (!inSetup) return;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [inSetup]);

  // A fetch error never blocks the dashboard itself.
  if (stateFetch.error) return <>{children}</>;
  if (!state || !auth) return <OverviewSkeleton />;

  if (inSetup) {
    return (
      <SetupScreen state={state} version={version} onChanged={reload} onDone={reload} />
    );
  }

  return (
    <>
      {state.demo.present && (
        <p className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700">
          These are demo numbers.{" "}
          <Link href="/settings" className="underline underline-offset-2">
            Connect a real vendor
          </Link>{" "}
          and they are wiped.
        </p>
      )}
      {children}
      {stage === "welcome" && auth.user?.role === "admin" && (
        <StartPopup onChanged={reload} />
      )}
    </>
  );
}
