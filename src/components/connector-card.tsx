"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Bot,
  ChevronDown,
  GitMerge,
  ListChecks,
  Loader2,
  Lock,
  MousePointer2,
  Plug,
  Sparkles,
  SquareKanban,
  type LucideIcon,
} from "lucide-react";
import { statusOf } from "@/components/connector-health";
import { ConfirmButton, ErrorLine, send } from "@/components/form-utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ConnectorHealth } from "@/lib/connectors/health";
import { formatCount, timeAgo } from "@/lib/format";
import { useFetch } from "@/lib/use-fetch";
import { cn } from "@/lib/utils";

/**
 * The one card shape for everything that plugs in (spec 10.6): icon, name,
 * status dot, last sync, one action - nothing else at rest. The header
 * toggles the card's panel; an open card spans the Connections grid.
 * PlugCard is the shell; ConnectorCard is the vendor/success connector on
 * top of it, with the full connect panel (the vendor's limits verbatim,
 * spec 5). Shared by Settings and Onboarding.
 */

const VENDOR_ICONS: Record<string, LucideIcon> = {
  anthropic: Sparkles,
  openai: Bot,
  cursor: MousePointer2,
  github: GitMerge,
  jira: SquareKanban,
  linear: ListChecks,
};

export function PlugCard({
  icon: Icon,
  name,
  marker,
  dot,
  status,
  locked,
  action,
  open,
  onToggle,
  children,
}: {
  icon: LucideIcon;
  name: string;
  /** Small truth next to the name ("success-only"). */
  marker?: string;
  /** Status dot class (bg-*). */
  dot: string;
  /** The card's one line of state (last sync / provider) - truthful or absent. */
  status?: string | null;
  /** Enterprise card without a license: the action slot shows the lock. */
  locked?: boolean;
  /** Action label at rest ("Connect", "Fix"); none = chevron. */
  action?: string | null;
  open: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-lg border bg-card", open && "sm:col-span-2")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-3 p-4 text-left"
      >
        <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{name}</span>
        {marker && <span className="text-sm text-muted-foreground">{marker}</span>}
        <span className={cn("h-2 w-2 shrink-0 rounded-full", dot)} />
        <span className="flex-1" />
        {status && (
          <span className="truncate text-sm tabular-nums text-muted-foreground">{status}</span>
        )}
        {locked ? (
          <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : action ? (
          <span className={buttonVariants({ size: "sm" })}>{action}</span>
        ) : (
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        )}
      </button>
      {open && <div className="space-y-3 border-t px-4 pb-4 pt-3">{children}</div>}
    </div>
  );
}

interface RoutedProject {
  key: string;
  name: string;
  productId: string | null;
}

/**
 * The project -> ROI mapping for a connected success integration (spec 7):
 * one row per Jira project / Linear team, each pointing at an ROI or the
 * default "Issues done" row. Changes apply retroactively - the project's
 * counted successes move with it.
 */
function ProjectRoutes({ vendor }: { vendor: string }) {
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const fetched = useFetch<{ projects: RoutedProject[] }>(
    `/api/connectors/${vendor}/projects?v=${version}`,
  );
  const { data: productsData } = useFetch<{ products: { id: string; name: string }[] }>(
    "/api/products",
  );
  if (fetched.error) return <ErrorLine message={fetched.error} />;
  if (!fetched.data || fetched.data.projects.length === 0) return null;

  async function route(project: string, productId: string | null) {
    setBusyKey(project);
    setError(null);
    const { error: failure } = await send(
      `/api/connectors/${vendor}/projects`,
      "PUT",
      { project, productId },
    );
    setBusyKey(null);
    if (failure) setError(failure);
    else setVersion((v) => v + 1);
  }

  return (
    <div className="space-y-2 border-t pt-3">
      <p className="text-sm font-medium text-muted-foreground">
        {vendor === "linear" ? "Teams → ROI" : "Projects → ROI"}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {fetched.data.projects.map((p) => (
          <div key={p.key} className="flex items-center gap-2">
            <Label htmlFor={`${vendor}-route-${p.key}`} className="w-40 truncate" title={p.name}>
              {p.key === p.name ? p.key : `${p.key} · ${p.name}`}
            </Label>
            <select
              id={`${vendor}-route-${p.key}`}
              className="h-8 flex-1 rounded-md border bg-transparent px-2 text-sm"
              disabled={busyKey === p.key}
              value={p.productId ?? ""}
              onChange={(e) => void route(p.key, e.target.value || null)}
            >
              <option value="">Default</option>
              {(productsData?.products ?? []).map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <ErrorLine message={error} />
    </div>
  );
}

export function ConnectorCard({
  c,
  isAdmin,
  onChanged,
}: {
  c: ConnectorHealth;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = statusOf(c);
  const broken = c.connected && (c.silent || c.lastRun?.status === "error");

  async function run(action: () => Promise<{ error: string | null; data: Record<string, unknown> | null }>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { error: failure, data } = await action();
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    const r = data?.run as { status?: string; rowsSynced?: number; error?: string | null } | undefined;
    if (r) {
      setNotice(r.status === "success" ? `synced ${formatCount(r.rowsSynced ?? 0)} rows` : null);
      setError(r.error ?? null);
    }
    onChanged();
  }

  return (
    <PlugCard
      icon={VENDOR_ICONS[c.vendor] ?? Plug}
      name={c.displayName}
      marker={c.successOnly ? "success-only" : undefined}
      dot={status.dot}
      status={
        c.connected
          ? c.inProgress
            ? `backfilling ${c.inProgress.since} → ${c.inProgress.until}`
            : c.lastSuccessAt
              ? `synced ${timeAgo(c.lastSuccessAt)}`
              : "never synced"
          : null
      }
      action={!c.connected ? "Connect" : broken ? "Fix" : null}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      {c.connected && c.lastRun?.error && (
        <p className="text-sm text-red-600" title={c.lastRun.error}>
          {c.lastRun.error}
        </p>
      )}

      {!c.connected && (
        <>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Backfills ~{c.historyLimitDays} days of history on connect.</li>
            {c.connectNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
          {isAdmin && (
            <div className="flex flex-wrap items-end gap-2">
              {c.configFields.map((field) => (
                <div key={field.key} className="space-y-1">
                  <Label htmlFor={`${c.vendor}-${field.key}`}>{field.label}</Label>
                  <Input
                    id={`${c.vendor}-${field.key}`}
                    type={field.secret ? "password" : "text"}
                    autoComplete="off"
                    placeholder={field.placeholder}
                    className="h-8 w-64"
                    disabled={busy}
                    value={config[field.key] ?? ""}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                  />
                </div>
              ))}
              <Button
                size="sm"
                disabled={
                  busy ||
                  c.configFields.some((f) => !f.optional && !config[f.key]?.trim())
                }
                onClick={() =>
                  run(() =>
                    send(`/api/connectors/${c.vendor}/connect`, "POST", { config }),
                  )
                }
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Connect"}
              </Button>
            </div>
          )}
        </>
      )}

      {c.connected && (
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => run(() => send(`/api/connectors/${c.vendor}/sync`, "POST"))}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sync now"}
              </Button>
              <ConfirmButton
                label="Disconnect"
                confirmLabel="Confirm disconnect"
                disabled={busy}
                onConfirm={() =>
                  run(() => send(`/api/connectors/${c.vendor}`, "DELETE"))
                }
              />
            </>
          )}
          {notice && <span className="text-sm text-green-700">{notice}</span>}
          <span className="flex-1" />
          <span className="text-sm tabular-nums text-muted-foreground">
            {c.successOnly
              ? `${formatCount(c.rowCounts.outcomes)} successes · ${formatCount(c.rowCounts.identities)} identities`
              : `${formatCount(c.rowCounts.spendFacts)} facts · ${formatCount(c.rowCounts.identities)} identities · ${formatCount(c.rowCounts.metrics)} metrics`}
          </span>
          <Link
            href={`/drill?view=runs&vendor=${c.vendor}`}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Runs →
          </Link>
        </div>
      )}
      {c.connected && c.successOnly && isAdmin && <ProjectRoutes vendor={c.vendor} />}
      <ErrorLine message={error} />
    </PlugCard>
  );
}
