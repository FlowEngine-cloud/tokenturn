"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Bot,
  ChevronDown,
  GitMerge,
  Loader2,
  MousePointer2,
  Plug,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { statusOf } from "@/components/connector-health";
import { ConfirmButton, ErrorLine, send } from "@/components/form-utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ConnectorHealth } from "@/lib/connectors/health";
import { formatCount, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * One vendor card (spec 10.6): icon, status dot, last sync, one connect/fix
 * action - nothing else at rest. The action (or the card) opens the full
 * panel: the vendor's limits stated verbatim (spec 5), credential fields,
 * connect/sync/disconnect, live backfill window and the vendor's last error
 * verbatim. Shared by Settings and Onboarding.
 */

const VENDOR_ICONS: Record<string, LucideIcon> = {
  anthropic: Sparkles,
  openai: Bot,
  cursor: MousePointer2,
  github: GitMerge,
};

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
  const Icon = VENDOR_ICONS[c.vendor] ?? Plug;
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
    <div className="rounded-lg border bg-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 p-4 text-left"
      >
        <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
        <span className="font-medium">{c.displayName}</span>
        <span className={cn("h-2 w-2 shrink-0 rounded-full", status.dot)} />
        <span className="flex-1" />
        {c.connected && (
          <span className="text-sm tabular-nums text-muted-foreground">
            {c.inProgress
              ? `backfilling ${c.inProgress.since} → ${c.inProgress.until}`
              : c.lastSuccessAt
                ? `synced ${timeAgo(c.lastSuccessAt)}`
                : "never synced"}
          </span>
        )}
        {!c.connected ? (
          <span className={buttonVariants({ size: "sm" })}>Connect</span>
        ) : broken ? (
          <span className={buttonVariants({ variant: "outline", size: "sm" })}>Fix</span>
        ) : (
          <ChevronDown
            className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")}
          />
        )}
      </button>

      {open && (
        <div className="space-y-3 border-t px-4 pb-4 pt-3">
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
                    disabled={busy || c.configFields.some((f) => !config[f.key]?.trim())}
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
                {formatCount(c.rowCounts.spendFacts)} facts ·{" "}
                {formatCount(c.rowCounts.identities)} identities ·{" "}
                {formatCount(c.rowCounts.metrics)} metrics
              </span>
              <Link
                href={`/drill?view=runs&vendor=${c.vendor}`}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Runs →
              </Link>
            </div>
          )}
          <ErrorLine message={error} />
        </div>
      )}
    </div>
  );
}
