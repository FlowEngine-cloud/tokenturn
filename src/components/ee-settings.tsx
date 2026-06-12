"use client";

import { useRef, useState } from "react";
import {
  Building2,
  Check,
  Copy,
  Download,
  KeyRound,
  Loader2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { PlugCard } from "@/components/connector-card";
import {
  ConfirmButton,
  ErrorLine,
  Section,
  SettingsRow,
  send,
  useLatest,
} from "@/components/form-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EE_LOCKED_COPY, type LicenseStatus } from "@/lib/ee";
import { timeAgo } from "@/lib/format";
import { useFetch } from "@/lib/use-fetch";
import { cn } from "@/lib/utils";

/**
 * The enterprise surfaces (spec 11). Okta and Google Workspace plug in, so
 * they live as Connections cards - visible without a license, locked to
 * exactly one line (EE_LOCKED_COPY), never hidden. The License tab is one
 * card (spec 10.6): plan, expiry, file upload, the contact line. Scheduled
 * reports live on the Alerts tab, the audit log on Data; expiry locks the
 * features again while everything recorded stays readable.
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

export function StatusDot({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "h-2 w-2 shrink-0 rounded-full",
        on ? "bg-green-600" : "bg-muted-foreground/40",
      )}
    />
  );
}

function runText(run: DirectoryRun | null): string {
  if (run === null) return "never synced";
  const at = timeAgo(run.finishedAt ?? run.startedAt);
  return run.status === "success" ? `synced ${at}` : `failed ${at}`;
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

// ---- License (spec 10.6: one card - plan, expiry, file upload, contact) ----

export function LicenseSection({
  license,
  isAdmin,
  onChanged,
}: {
  license: LicenseStatus;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patch(value: string | null) {
    setBusy(true);
    setError(null);
    const { error: failure } = await send("/api/settings", "PATCH", {
      license_file: value,
    });
    setBusy(false);
    if (failure) setError(failure);
    else onChanged();
    if (fileInput.current) fileInput.current.value = "";
  }

  return (
    <Section title="License">
      <SettingsRow label="Plan">
        <StatusDot on={license.state === "valid"} />
        <span className="text-sm">
          {license.state === "none" ? "Free" : `Enterprise · ${license.org}`}
        </span>
        {isAdmin && license.state !== "none" && (
          <ConfirmButton
            label="Remove"
            confirmLabel="Confirm remove"
            disabled={busy}
            onConfirm={() => void patch(null)}
          />
        )}
      </SettingsRow>
      {license.state !== "none" && (
        <SettingsRow label="Expires">
          <span
            className={cn(
              "text-sm tabular-nums",
              license.state === "expired" && "text-red-600",
            )}
          >
            {license.expiresAt}
            {license.state === "expired" && " · expired"}
          </span>
        </SettingsRow>
      )}
      {isAdmin && (
        <SettingsRow label="License file">
          <input
            ref={fileInput}
            type="file"
            aria-label="License file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void file.text().then((text) => patch(text.trim()));
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Upload
          </Button>
        </SettingsRow>
      )}
      <SettingsRow label="Contact">
        <a
          href="mailto:hi@flowengine.cloud"
          className="text-sm underline underline-offset-2"
        >
          hi@flowengine.cloud
        </a>
      </SettingsRow>
      <ErrorLine message={error} />
    </Section>
  );
}

// ---- Directory cards (spec 11: Okta sync, Google Workspace roster) ---------
//
// Connections cards on the one PlugCard shape. Without the licensed feature
// the card is visible and locked to exactly the one line; with it, admins
// get the connect/sync/disconnect panel (the status APIs are admin-only, so
// viewers see the licensed state and nothing else).

function EeStaticCard({
  icon,
  name,
  locked,
  children,
}: {
  icon: LucideIcon;
  name: string;
  /** No license: the action slot shows the lock; the body is the one line. */
  locked?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <PlugCard
      icon={icon}
      name={name}
      dot="bg-muted-foreground/40"
      locked={locked}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      {children}
    </PlugCard>
  );
}

interface OktaStatus {
  connected: boolean;
  domain: string | null;
  hookSecret: string | null;
  lastRun: DirectoryRun | null;
}

function OktaBody({ status, reload }: { status: OktaStatus; reload: () => void }) {
  const [domain, setDomain] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const hookUrl =
    typeof window === "undefined" ? "" : `${window.location.origin}/api/ee/okta/events`;

  return (
    <>
      {status.connected && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">{status.domain}</span>
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
        </div>
      )}
      {status.connected && status.lastRun?.error && (
        <p className="break-words text-sm text-destructive">{status.lastRun.error}</p>
      )}
      {status.connected && status.hookSecret && (
        <div className="space-y-1 text-sm">
          <p className="text-muted-foreground">
            Leaver events fire the sweep instantly via an Okta event hook
            (deactivate + suspend); the hourly System Log poll is the backstop.
            Register in Okta with:
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all font-mono">{hookUrl}</code>
            <CopyButton value={hookUrl} />
            <span className="text-muted-foreground">Authorization header:</span>
            <code className="break-all font-mono">{status.hookSecret}</code>
            <CopyButton value={status.hookSecret} />
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="okta-domain">Org URL</Label>
          <Input
            id="okta-domain"
            className="h-8 w-64 max-w-full"
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
            className="h-8 w-64 max-w-full"
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

interface GoogleStatus {
  connected: boolean;
  clientEmail: string | null;
  adminEmail: string | null;
  lastRun: DirectoryRun | null;
}

function GoogleBody({ status, reload }: { status: GoogleStatus; reload: () => void }) {
  const [json, setJson] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <>
      {status.connected && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">
            {status.clientEmail} as {status.adminEmail}
          </span>
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
        </div>
      )}
      {status.connected && status.lastRun?.error && (
        <p className="break-words text-sm text-destructive">{status.lastRun.error}</p>
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
              className="h-8 w-64 max-w-full"
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

function DirectoryAdminCard<T extends { connected: boolean; lastRun: DirectoryRun | null }>({
  icon,
  name,
  path,
  onChanged,
  body,
}: {
  icon: LucideIcon;
  name: string;
  path: string;
  onChanged: () => void;
  body: (status: T, reload: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const status = useLatest(useFetch<T>(`${path}?v=${version}`).data);
  const reload = () => {
    setVersion((v) => v + 1);
    onChanged();
  };

  return (
    <PlugCard
      icon={icon}
      name={name}
      dot={status?.connected ? "bg-green-600" : "bg-muted-foreground/40"}
      status={status?.connected ? runText(status.lastRun) : null}
      action={status !== null && !status.connected ? "Connect" : null}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      {status === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        body(status, reload)
      )}
    </PlugCard>
  );
}

export function OktaConnectionCard({
  licensed,
  isAdmin,
  onChanged,
}: {
  licensed: boolean;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  if (!licensed) {
    return (
      <EeStaticCard icon={KeyRound} name="Okta" locked>
        <LockedLine />
      </EeStaticCard>
    );
  }
  if (!isAdmin) {
    return (
      <EeStaticCard icon={KeyRound} name="Okta">
        <p className="text-sm text-muted-foreground">Licensed - admins configure it here.</p>
      </EeStaticCard>
    );
  }
  return (
    <DirectoryAdminCard<OktaStatus>
      icon={KeyRound}
      name="Okta"
      path="/api/ee/okta"
      onChanged={onChanged}
      body={(status, reload) => <OktaBody status={status} reload={reload} />}
    />
  );
}

export function GoogleConnectionCard({
  licensed,
  isAdmin,
  onChanged,
}: {
  licensed: boolean;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  if (!licensed) {
    return (
      <EeStaticCard icon={Building2} name="Google Workspace" locked>
        <LockedLine />
      </EeStaticCard>
    );
  }
  if (!isAdmin) {
    return (
      <EeStaticCard icon={Building2} name="Google Workspace">
        <p className="text-sm text-muted-foreground">Licensed - admins configure it here.</p>
      </EeStaticCard>
    );
  }
  return (
    <DirectoryAdminCard<GoogleStatus>
      icon={Building2}
      name="Google Workspace"
      path="/api/ee/google"
      onChanged={onChanged}
      body={(status, reload) => <GoogleBody status={status} reload={reload} />}
    />
  );
}

// ---- Monthly report (spec 11: scheduled monthly PDF email; lives on the
// Alerts tab - it is outbound email, like the alert recipients) --------------

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
      <Section title="Monthly report">
        <LockedLine />
      </Section>
    );
  }
  const list = recipients
    .split(",")
    .map((r) => r.trim())
    .filter((r) => r !== "");

  return (
    <Section title="Monthly report">
      <SettingsRow label="Send monthly" htmlFor="reports-enabled">
        <input
          id="reports-enabled"
          type="checkbox"
          disabled={busy || !isAdmin}
          checked={enabled}
          onChange={(e) => {
            setSaved(false);
            setEnabled(e.target.checked);
          }}
        />
        {enabled && !emailConfigured && (
          <span className="text-sm text-amber-700">needs the Email connection</span>
        )}
      </SettingsRow>
      <SettingsRow label="Recipients" htmlFor="reports-recipients">
        <Input
          id="reports-recipients"
          className="h-8 w-96 max-w-full"
          placeholder="cfo@acme.com, finance@acme.com"
          disabled={busy || !isAdmin}
          value={recipients}
          onChange={(e) => {
            setSaved(false);
            setRecipients(e.target.value);
          }}
        />
      </SettingsRow>
      {isAdmin && (
        <SettingsRow>
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
        </SettingsRow>
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
          Nothing yet. Sweeps, adds, connects, and settings changes land here.
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

// ---- The Data-tab audit block (spec 11: exportable) -------------------------

export function AuditSection({
  licensed,
  isAdmin,
}: {
  licensed: boolean;
  isAdmin: boolean;
}) {
  return (
    <Section title="Audit log">
      {!licensed ? (
        <LockedLine />
      ) : isAdmin ? (
        <AuditBody />
      ) : (
        <p className="text-sm text-muted-foreground">Licensed - admins view and export it here.</p>
      )}
    </Section>
  );
}

export { LockedLine };
