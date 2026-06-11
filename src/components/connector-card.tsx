"use client";

import Link from "next/link";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { statusOf } from "@/components/connector-health";
import { ConfirmButton, ErrorLine, send } from "@/components/form-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ConnectorHealth } from "@/lib/connectors/health";
import { formatCount, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * One vendor's connect screen (spec 5): the vendor's limits stated verbatim,
 * credential fields, connect/sync/disconnect, live backfill window and the
 * vendor's last error verbatim. Shared by Settings and Onboarding.
 */
export function ConnectorCard({
  c,
  isAdmin,
  onChanged,
}: {
  c: ConnectorHealth;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [config, setConfig] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const status = statusOf(c);

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
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", status.dot)} />
        <span className="font-medium">{c.displayName}</span>
        <span className="text-sm text-muted-foreground">{status.label}</span>
        <span className="flex-1" />
        {c.connected && (
          <span className="text-sm text-muted-foreground">
            {c.lastSuccessAt ? `synced ${timeAgo(c.lastSuccessAt)}` : "never synced"}
            {" · "}
            {formatCount(c.rowCounts.spendFacts)} facts ·{" "}
            {formatCount(c.rowCounts.identities)} identities ·{" "}
            {formatCount(c.rowCounts.metrics)} metrics
          </span>
        )}
        <Link
          href={`/drill?view=runs&vendor=${c.vendor}`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Runs →
        </Link>
      </div>

      {c.inProgress && (
        <p className="text-sm text-amber-700">
          backfilling {c.inProgress.since} → {c.inProgress.until}
        </p>
      )}
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
          {isAdmin ? (
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
          ) : (
            <p className="text-sm text-muted-foreground">Admin connects vendors.</p>
          )}
        </>
      )}

      {c.connected && isAdmin && (
        <div className="flex flex-wrap items-center gap-2">
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
          {notice && <span className="text-sm text-green-700">{notice}</span>}
        </div>
      )}
      <ErrorLine message={error} />
    </div>
  );
}
