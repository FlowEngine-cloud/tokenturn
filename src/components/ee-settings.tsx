"use client";

import { useState } from "react";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import {
  ConfirmButton,
  ErrorLine,
  Section,
  send,
  useLatest,
} from "@/components/form-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EE_FEATURE_LABELS, EE_LOCKED_COPY, type EeFeature, type LicenseStatus } from "@/lib/ee";
import { timeAgo } from "@/lib/format";
import { useFetch } from "@/lib/use-fetch";
import { cn } from "@/lib/utils";

/**
 * The enterprise surfaces on Settings (spec 11): the license box and one
 * section per ee/ feature. A feature the license does not grant shows
 * exactly one line (EE_LOCKED_COPY); expiry locks the features again while
 * everything recorded stays readable.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface DirectoryRun {
  status: "success" | "error";
  rowsSynced: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

function LockedLine() {
  return <p className="text-sm text-muted-foreground">{EE_LOCKED_COPY}</p>;
}

function StatusDot({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "h-2 w-2 shrink-0 rounded-full",
        on ? "bg-green-600" : "bg-muted-foreground/40",
      )}
    />
  );
}

function RunLine({ run }: { run: DirectoryRun | null }) {
  if (run === null) {
    return <span className="text-sm text-muted-foreground">never synced</span>;
  }
  return (
    <span className="text-sm text-muted-foreground">
      {run.status === "success"
        ? `synced ${timeAgo(run.finishedAt ?? run.startedAt)} · ${run.rowsSynced ?? 0} users`
        : `failed ${timeAgo(run.finishedAt ?? run.startedAt)}`}
    </span>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => setCopied(true));
      }}
    >
      {copied ? <Check className="h-4 w-4 text-green-700" /> : <Copy className="h-4 w-4" />}
    </Button>
  );
}

// ---- License (spec 11: issued per deal, verified offline) ------------------

export function LicenseSection({
  license,
  isAdmin,
  onChanged,
}: {
  license: LicenseStatus;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patch(value: string | null) {
    setBusy(true);
    setError(null);
    const { error: failure } = await send("/api/settings", "PATCH", {
      license_file: value,
    });
    setBusy(false);
    if (failure) {
      setError(failure);
    } else {
      setText("");
      onChanged();
    }
  }

  return (
    <Section title="License">
      <div className="flex flex-wrap items-center gap-2">
        <StatusDot on={license.state === "valid"} />
        {license.state === "none" ? (
          <span className="text-sm">
            Free · sustainable-use license - all connectors, the SDK, the full
            dashboard, limits and alerts. One admin plus view-only users.
          </span>
        ) : (
          <span className="text-sm">
            Enterprise · {license.org} ·{" "}
            {license.state === "expired" ? (
              <span className="text-red-600">expired {license.expiresAt}</span>
            ) : (
              `through ${license.expiresAt}`
            )}
          </span>
        )}
      </div>
      {license.state !== "none" && (
        <p className="text-sm text-muted-foreground">
          {license.features.map((f) => EE_FEATURE_LABELS[f]).join(" · ")}
          {license.state === "expired" &&
            " - locked until renewal; everything recorded stays readable"}
        </p>
      )}
      {isAdmin && (
        <div className="space-y-2">
          <textarea
            aria-label="License file"
            className="h-20 w-full max-w-2xl rounded-md border bg-transparent p-2 font-mono text-sm"
            placeholder='paste the license file - {"v":1,"payload":"...","signature":"..."}'
            disabled={busy}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy || text.trim() === ""}
              onClick={() => void patch(text.trim())}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Install license"}
            </Button>
            {license.state !== "none" && (
              <ConfirmButton
                label="Remove license"
                confirmLabel="Confirm remove"
                disabled={busy}
                onConfirm={() => void patch(null)}
              />
            )}
            <span className="text-sm text-muted-foreground">
              verified offline - nothing leaves this machine
            </span>
          </div>
        </div>
      )}
      <ErrorLine message={error} />
    </Section>
  );
}

// ---- Okta sync (spec 11: auto-invite on hire, auto-offboard on leave) ------

function OktaBody({ onChanged }: { onChanged: () => void }) {
  const [version, setVersion] = useState(0);
  const status = useLatest(
    useFetch<{
      connected: boolean;
      domain: string | null;
      hookSecret: string | null;
      lastRun: DirectoryRun | null;
    }>(`/api/ee/okta?v=${version}`).data,
  );
  const [domain, setDomain] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reload = () => {
    setVersion((v) => v + 1);
    onChanged();
  };

  if (!status) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const hookUrl =
    typeof window === "undefined" ? "" : `${window.location.origin}/api/ee/okta/events`;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <StatusDot on={status.connected} />
        <span className="text-sm">
          {status.connected ? status.domain : "not connected"}
        </span>
        {status.connected && <RunLine run={status.lastRun} />}
        {status.connected && (
          <>
            <span className="flex-1" />
            <Button
              variant="outline"
              size="sm"
              disabled={syncBusy}
              onClick={async () => {
                setSyncBusy(true);
                setError(null);
                setNotice(null);
                const { error: failure, data } = await send("/api/ee/okta/sync", "POST");
                setSyncBusy(false);
                if (failure) setError(failure);
                else if (data?.error) setError(String(data.error));
                else
                  setNotice(
                    `synced - ${String(data?.created)} new, ${String(data?.updated)} updated, ${
                      (data?.leavers as unknown[])?.length ?? 0
                    } leavers swept`,
                  );
                reload();
              }}
            >
              {syncBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sync now"}
            </Button>
            <ConfirmButton
              label="Disconnect"
              confirmLabel="Confirm disconnect"
              disabled={busy}
              onConfirm={() => {
                void send("/api/ee/okta", "DELETE").then(({ error: failure }) => {
                  if (failure) setError(failure);
                  else reload();
                });
              }}
            />
          </>
        )}
      </div>
      {status.connected && status.lastRun?.error && (
        <p className="text-sm text-destructive">{status.lastRun.error}</p>
      )}
      {status.connected && status.hookSecret && (
        <div className="space-y-1 text-sm">
          <p className="text-muted-foreground">
            Leaver events fire the sweep instantly via an Okta event hook
            (deactivate + suspend); the hourly System Log poll is the backstop.
            Register in Okta with:
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono">{hookUrl}</code>
            <CopyButton value={hookUrl} />
            <span className="text-muted-foreground">Authorization header:</span>
            <code className="font-mono">{status.hookSecret}</code>
            <CopyButton value={status.hookSecret} />
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="okta-domain">Org URL</Label>
          <Input
            id="okta-domain"
            className="h-8 w-64"
            placeholder="https://acme.okta.com"
            disabled={busy}
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="okta-token">API token (SSWS)</Label>
          <Input
            id="okta-token"
            type="password"
            autoComplete="off"
            className="h-8 w-64"
            disabled={busy}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>
        <Button
          size="sm"
          disabled={busy || domain.trim() === "" || token.trim() === ""}
          onClick={async () => {
            setBusy(true);
            setError(null);
            setNotice(null);
            const { error: failure } = await send("/api/ee/okta", "POST", {
              domain: domain.trim(),
              token: token.trim(),
            });
            setBusy(false);
            if (failure) {
              setError(failure);
            } else {
              setDomain("");
              setToken("");
              reload();
            }
          }}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : status.connected ? (
            "Replace"
          ) : (
            "Connect"
          )}
        </Button>
      </div>
      {notice && <p className="text-sm text-green-700">{notice}</p>}
      <ErrorLine message={error} />
    </>
  );
}

// ---- Google Workspace roster sync ------------------------------------------

function GoogleBody({ onChanged }: { onChanged: () => void }) {
  const [version, setVersion] = useState(0);
  const status = useLatest(
    useFetch<{
      connected: boolean;
      clientEmail: string | null;
      adminEmail: string | null;
      lastRun: DirectoryRun | null;
    }>(`/api/ee/google?v=${version}`).data,
  );
  const [json, setJson] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reload = () => {
    setVersion((v) => v + 1);
    onChanged();
  };

  if (!status) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <StatusDot on={status.connected} />
        <span className="text-sm">
          {status.connected
            ? `${status.clientEmail} as ${status.adminEmail}`
            : "not connected"}
        </span>
        {status.connected && <RunLine run={status.lastRun} />}
        {status.connected && (
          <>
            <span className="flex-1" />
            <Button
              variant="outline"
              size="sm"
              disabled={syncBusy}
              onClick={async () => {
                setSyncBusy(true);
                setError(null);
                setNotice(null);
                const { error: failure, data } = await send("/api/ee/google/sync", "POST");
                setSyncBusy(false);
                if (failure) setError(failure);
                else if (data?.error) setError(String(data.error));
                else
                  setNotice(
                    `synced - ${String(data?.created)} new, ${String(data?.updated)} updated`,
                  );
                reload();
              }}
            >
              {syncBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sync now"}
            </Button>
            <ConfirmButton
              label="Disconnect"
              confirmLabel="Confirm disconnect"
              disabled={busy}
              onConfirm={() => {
                void send("/api/ee/google", "DELETE").then(({ error: failure }) => {
                  if (failure) setError(failure);
                  else reload();
                });
              }}
            />
          </>
        )}
      </div>
      {status.connected && status.lastRun?.error && (
        <p className="text-sm text-destructive">{status.lastRun.error}</p>
      )}
      <div className="space-y-2">
        <textarea
          aria-label="Service account JSON"
          className="h-20 w-full max-w-2xl rounded-md border bg-transparent p-2 font-mono text-sm"
          placeholder="service-account key JSON (domain-wide delegation, directory read-only scope)"
          disabled={busy}
          value={json}
          onChange={(e) => setJson(e.target.value)}
        />
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="google-admin">Impersonated admin</Label>
            <Input
              id="google-admin"
              type="email"
              className="h-8 w-64"
              placeholder="admin@acme.com"
              disabled={busy}
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={busy || json.trim() === "" || adminEmail.trim() === ""}
            onClick={async () => {
              setBusy(true);
              setError(null);
              setNotice(null);
              const { error: failure } = await send("/api/ee/google", "POST", {
                serviceAccountJson: json,
                adminEmail: adminEmail.trim(),
              });
              setBusy(false);
              if (failure) {
                setError(failure);
              } else {
                setJson("");
                setAdminEmail("");
                reload();
              }
            }}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : status.connected ? (
              "Replace"
            ) : (
              "Connect"
            )}
          </Button>
        </div>
      </div>
      {notice && <p className="text-sm text-green-700">{notice}</p>}
      <ErrorLine message={error} />
    </>
  );
}

// ---- Scheduled reports (spec 11: monthly PDF email) ------------------------

export function ScheduledReportsSection({
  licensed,
  config,
  emailConfigured,
  isAdmin,
  onChanged,
}: {
  licensed: boolean;
  config: { enabled: boolean; recipients: string[] };
  emailConfigured: boolean;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [enabled, setEnabled] = useState(config.enabled);
  const [recipients, setRecipients] = useState(config.recipients.join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!licensed) {
    return (
      <Section title="Scheduled reports">
        <LockedLine />
      </Section>
    );
  }
  const list = recipients
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r !== "");

  return (
    <Section title="Scheduled reports">
      <div className="flex flex-wrap items-center gap-2">
        <StatusDot on={config.enabled} />
        <span className="text-sm">
          {config.enabled
            ? `monthly CFO report (PDF) to ${config.recipients.length} recipient${config.recipients.length > 1 ? "s" : ""}, first tick after each month closes`
            : "off"}
        </span>
        {!emailConfigured && (
          <span className="text-sm text-amber-700">
            needs the email provider above
          </span>
        )}
      </div>
      {isAdmin && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex h-8 items-center gap-2 text-sm">
            <input
              type="checkbox"
              disabled={busy}
              checked={enabled}
              onChange={(e) => {
                setSaved(false);
                setEnabled(e.target.checked);
              }}
            />
            Send monthly
          </label>
          <div className="space-y-1">
            <Label htmlFor="reports-recipients">Recipients</Label>
            <Input
              id="reports-recipients"
              className="h-8 w-96"
              placeholder="cfo@acme.com, finance@acme.com"
              disabled={busy}
              value={recipients}
              onChange={(e) => {
                setSaved(false);
                setRecipients(e.target.value);
              }}
            />
          </div>
          <Button
            size="sm"
            disabled={busy || (enabled && (list.length === 0 || list.some((r) => !EMAIL_RE.test(r))))}
            onClick={async () => {
              setBusy(true);
              setError(null);
              setSaved(false);
              const { error: failure } = await send("/api/settings", "PATCH", {
                scheduled_reports: { enabled, recipients: list },
              });
              setBusy(false);
              if (failure) setError(failure);
              else {
                setSaved(true);
                onChanged();
              }
            }}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </Button>
          {saved && <span className="text-sm text-green-700">saved</span>}
        </div>
      )}
      <ErrorLine message={error} />
    </Section>
  );
}

// ---- Audit log (spec 11: every sweep, every settings change, exportable) ---

interface AuditEntry {
  id: string;
  ts: string;
  actorName: string | null;
  action: string;
  detail: Record<string, unknown>;
}

function AuditBody() {
  const [older, setOlder] = useState<AuditEntry[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const latest = useLatest(
    useFetch<{ entries: AuditEntry[] }>("/api/audit?limit=50").data,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!latest) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const entries = [...latest.entries.filter((e) => !older.some((o) => o.id === e.id)), ...older];
  const last = entries[entries.length - 1];

  return (
    <>
      <div className="flex items-center gap-2">
        <a
          href="/api/audit?format=csv"
          download
          className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm font-medium hover:bg-accent"
        >
          <Download className="h-4 w-4" />
          Export CSV
        </a>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing yet. Sweeps, invites, connects, and settings changes land here.
        </p>
      ) : (
        <ul className="divide-y">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
              <span className="text-sm tabular-nums text-muted-foreground">
                {entry.ts.replace("T", " ").slice(0, 19)}
              </span>
              <span className="text-sm font-medium">{entry.action}</span>
              <span className="text-sm text-muted-foreground">
                {entry.actorName ?? "system"}
              </span>
              <code className="min-w-0 flex-1 truncate font-mono text-sm text-muted-foreground">
                {JSON.stringify(entry.detail)}
              </code>
            </li>
          ))}
        </ul>
      )}
      {last && !exhausted && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const res = await fetch(`/api/audit?limit=50&before=${last.id}`);
              const body = (await res.json()) as { entries?: AuditEntry[]; error?: string };
              if (!res.ok) setError(body.error ?? `request failed (${res.status})`);
              else if ((body.entries ?? []).length === 0) setExhausted(true);
              else setOlder((prev) => [...prev, ...(body.entries ?? [])]);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Load older"}
        </Button>
      )}
      <ErrorLine message={error} />
    </>
  );
}

// ---- The enterprise block ---------------------------------------------------

export function EnterpriseSections({
  features,
  isAdmin,
  scheduledReports,
  emailConfigured,
  onChanged,
}: {
  features: EeFeature[];
  isAdmin: boolean;
  scheduledReports: { enabled: boolean; recipients: string[] };
  emailConfigured: boolean;
  onChanged: () => void;
}) {
  // Directory + audit surfaces are admin API calls; viewers see the cards
  // only as locked/unlocked state, never the configs.
  return (
    <>
      <Section title="Okta sync">
        {!features.includes("okta_sync") ? (
          <LockedLine />
        ) : isAdmin ? (
          <OktaBody onChanged={onChanged} />
        ) : (
          <p className="text-sm text-muted-foreground">Licensed - admins configure it here.</p>
        )}
      </Section>
      <Section title="Google Workspace">
        {!features.includes("google_workspace") ? (
          <LockedLine />
        ) : isAdmin ? (
          <GoogleBody onChanged={onChanged} />
        ) : (
          <p className="text-sm text-muted-foreground">Licensed - admins configure it here.</p>
        )}
      </Section>
      <ScheduledReportsSection
        licensed={features.includes("scheduled_reports")}
        config={scheduledReports}
        emailConfigured={emailConfigured}
        isAdmin={isAdmin}
        onChanged={onChanged}
      />
      <Section title="Audit log">
        {!features.includes("audit_log") ? (
          <LockedLine />
        ) : isAdmin ? (
          <AuditBody />
        ) : (
          <p className="text-sm text-muted-foreground">Licensed - admins view and export it here.</p>
        )}
      </Section>
    </>
  );
}

export { LockedLine };
