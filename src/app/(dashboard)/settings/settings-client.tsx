"use client";

import { useRef, useState } from "react";
import { Check, Copy, Loader2, Upload } from "lucide-react";
import { ConnectorCard } from "@/components/connector-card";
import { EnterpriseSections, LicenseSection, StatusDot } from "@/components/ee-settings";
import {
  ConfirmButton,
  ErrorLine,
  Section,
  SettingsRow,
  send,
  toCents,
  useLatest,
} from "@/components/form-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { ConnectorHealth } from "@/lib/connectors/health";
import { EE_LOCKED_COPY, type LicenseStatus } from "@/lib/ee";
import { formatCount, timeAgo } from "@/lib/format";
import type { IngestKey } from "@/lib/ingest";
import type { ImportResult, ParsedInvoiceCsv } from "@/lib/invoices";
import type { ProductListItem } from "@/lib/products";
import type { SettingValues } from "@/lib/settings";
import { useFetch } from "@/lib/use-fetch";

/**
 * Settings (spec 10.6): real controls grouped in cards, a label and a
 * control per row - Connectors, Alerts, Money, Email, Ingest keys (spec 6:
 * minted here, shown once), Users, Defaults, License, then the ee/ cards.
 * Writes are admin-only; the server's word comes back verbatim.
 */

export function SettingsSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-48" />
      <Skeleton className="h-48" />
      <Skeleton className="h-48" />
    </div>
  );
}

interface SettingsPayload {
  settings: SettingValues;
  secrets: { slack_webhook_url: boolean; email_provider_config: boolean };
  /** Provider + from of the configured email provider - never the key. */
  email: { provider: string; from: string } | null;
  license: LicenseStatus;
  scheduledReports: { enabled: boolean; recipients: string[] };
}

interface UserRow {
  id: string;
  name: string;
  role: "admin" | "viewer";
  passkeys: number;
  has_password: boolean;
}

// ---- Alerts (spec 9: Slack webhook + every alert threshold) ----------------

function AlertsCard({
  settings,
  configured,
  isAdmin,
  onChanged,
}: {
  settings: SettingValues;
  configured: boolean;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [url, setUrl] = useState("");
  const [webhookBusy, setWebhookBusy] = useState(false);
  const [form, setForm] = useState({
    limit_alert_thresholds_pct: settings.limit_alert_thresholds_pct.join(", "),
    anomaly_burn_multiplier: String(settings.anomaly_burn_multiplier),
    anomaly_min_day: (settings.anomaly_min_day_cents / 100).toFixed(2),
    connector_silent_alert_hours: String(settings.connector_silent_alert_hours),
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<typeof form>) => {
    setSaved(false);
    setForm((prev) => ({ ...prev, ...patch }));
  };

  async function patchWebhook(value: string | null) {
    setWebhookBusy(true);
    setError(null);
    const { error: failure } = await send("/api/settings", "PATCH", {
      slack_webhook_url: value,
    });
    setWebhookBusy(false);
    if (failure) {
      setError(failure);
    } else {
      setUrl("");
      onChanged();
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const thresholds = form.limit_alert_thresholds_pct
      .split(",")
      .map((t) => Number(t.trim()))
      .filter((t) => !Number.isNaN(t));
    const { error: failure } = await send("/api/settings", "PATCH", {
      limit_alert_thresholds_pct: thresholds,
      anomaly_burn_multiplier: Number(form.anomaly_burn_multiplier),
      anomaly_min_day_cents: toCents(form.anomaly_min_day) ?? -1,
      connector_silent_alert_hours: Number(form.connector_silent_alert_hours),
    });
    setBusy(false);
    if (failure) {
      setError(failure);
    } else {
      setSaved(true);
      onChanged();
    }
  }

  const numeric = (
    label: string,
    key: keyof typeof form,
    suffix: string,
    width = "w-20",
  ) => (
    <SettingsRow label={label} htmlFor={`alerts-${key}`}>
      <Input
        id={`alerts-${key}`}
        className={`h-8 ${width}`}
        disabled={busy || !isAdmin}
        value={form[key]}
        onChange={(e) => set({ [key]: e.target.value } as Partial<typeof form>)}
      />
      <span className="text-sm text-muted-foreground">{suffix}</span>
    </SettingsRow>
  );

  return (
    <Section title="Alerts">
      <SettingsRow label="Slack webhook" htmlFor="alerts-webhook">
        <StatusDot on={configured} />
        {isAdmin ? (
          <>
            <Input
              id="alerts-webhook"
              type="url"
              className="h-8 w-80"
              placeholder="https://hooks.slack.com/services/…"
              disabled={webhookBusy}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Button
              size="sm"
              disabled={webhookBusy || url.trim() === ""}
              onClick={() => void patchWebhook(url.trim())}
            >
              {webhookBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : configured ? (
                "Replace"
              ) : (
                "Save"
              )}
            </Button>
            {configured && (
              <ConfirmButton
                label="Clear"
                confirmLabel="Confirm clear"
                disabled={webhookBusy}
                onConfirm={() => void patchWebhook(null)}
              />
            )}
          </>
        ) : (
          <span className="text-sm">{configured ? "configured" : "not set"}</span>
        )}
      </SettingsRow>
      {numeric("Limit alerts", "limit_alert_thresholds_pct", "% of monthly limit", "w-28")}
      {numeric("Anomaly trigger", "anomaly_burn_multiplier", "× 30-day average", "w-16")}
      {numeric("Anomaly floor", "anomaly_min_day", "$ / day")}
      {numeric("Silent connector", "connector_silent_alert_hours", "hours", "w-16")}
      {isAdmin && (
        <SettingsRow>
          <Button size="sm" disabled={busy} onClick={save}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </Button>
          {saved && <span className="text-sm text-green-700">saved</span>}
        </SettingsRow>
      )}
      <ErrorLine message={error} />
    </Section>
  );
}

// ---- Money (spec 4: display currency + monthly invoice CSV true-up) -------

async function postCsv(
  url: string,
  text: string,
): Promise<{ error: string | null; data: unknown }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: text,
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok) return { error: null, data };
    return { error: (data?.error as string) ?? `request failed (${res.status})`, data };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), data: null };
  }
}

function InvoiceImportControl({ onChanged }: { onChanged: () => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<ParsedInvoiceCsv | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setCsv(null);
    setPreview(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function load(file: File) {
    setBusy(true);
    setError(null);
    setResult(null);
    const text = await file.text();
    const { error: failure, data } = await postCsv("/api/invoices/import?preview=1", text);
    setBusy(false);
    if (failure) {
      setError(failure);
      reset();
    } else {
      setCsv(text);
      setPreview(data as ParsedInvoiceCsv);
    }
  }

  async function commit() {
    if (csv === null) return;
    setBusy(true);
    setError(null);
    const { error: failure, data } = await postCsv("/api/invoices/import", csv);
    setBusy(false);
    if (failure) {
      setError(failure);
    } else {
      setResult(data as ImportResult);
      reset();
    }
    onChanged();
  }

  if (preview) {
    const bad = preview.rows.filter((row) => row.error !== null);
    return (
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm tabular-nums">
            {formatCount(preview.rows.length)} rows ·{" "}
            {formatCount(preview.rows.length - bad.length)} ready
            {bad.length > 0 && (
              <span className="text-red-600"> · {formatCount(bad.length)} with errors</span>
            )}
          </span>
          {preview.ok && (
            <Button size="sm" disabled={busy} onClick={() => void commit()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Import"}
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={busy} onClick={reset}>
            Cancel
          </Button>
        </div>
        {bad.slice(0, 8).map((row) => (
          <p key={row.line} className="text-sm text-red-600">
            line {row.line}: {row.error}
          </p>
        ))}
        {bad.length > 8 && (
          <p className="text-sm text-red-600">+ {formatCount(bad.length - 8)} more</p>
        )}
        <ErrorLine message={error} />
      </div>
    );
  }

  return (
    <>
      <input
        ref={fileInput}
        type="file"
        accept=".csv,text/csv,text/plain"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void load(file);
        }}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => fileInput.current?.click()}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        Import CSV
      </Button>
      <span className="text-sm text-muted-foreground">vendor, month, amount, currency</span>
      {result && (
        <span className="flex items-center gap-1.5 text-sm text-green-700">
          <Check className="h-4 w-4" />
          {formatCount(result.imported)} imported
        </span>
      )}
      <ErrorLine message={error} />
    </>
  );
}

function MoneyCard({
  settings,
  isAdmin,
  onChanged,
}: {
  settings: SettingValues;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [currency, setCurrency] = useState(settings.display_currency);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fxBusy, setFxBusy] = useState(false);
  const [fxNotice, setFxNotice] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const { error: failure } = await send("/api/settings", "PATCH", {
      display_currency: currency.trim().toUpperCase(),
    });
    setBusy(false);
    if (failure) {
      setError(failure);
    } else {
      setSaved(true);
      onChanged();
    }
  }

  return (
    <Section title="Money">
      <SettingsRow label="Display currency" htmlFor="money-currency">
        <Input
          id="money-currency"
          className="h-8 w-20 uppercase"
          maxLength={3}
          disabled={busy || !isAdmin}
          value={currency}
          onChange={(e) => {
            setSaved(false);
            setCurrency(e.target.value.toUpperCase());
          }}
        />
        {isAdmin && (
          <Button size="sm" disabled={busy} onClick={save}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </Button>
        )}
        {saved && <span className="text-sm text-green-700">saved</span>}
        {error?.includes("FX") && (
          <Button
            variant="outline"
            size="sm"
            disabled={fxBusy}
            onClick={async () => {
              setFxBusy(true);
              setFxNotice(null);
              const { error: failure, data } = await send("/api/fx/sync", "POST");
              setFxBusy(false);
              if (failure) {
                setFxNotice(failure);
              } else {
                const run = data?.run as { status?: string; error?: string | null };
                setFxNotice(
                  run?.status === "success"
                    ? "rates synced - save again"
                    : (run?.error ?? "sync failed"),
                );
              }
            }}
          >
            {fxBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sync FX rates"}
          </Button>
        )}
        {fxNotice && <span className="text-sm text-muted-foreground">{fxNotice}</span>}
      </SettingsRow>
      {isAdmin && (
        <SettingsRow label="Invoice import">
          <InvoiceImportControl onChanged={onChanged} />
        </SettingsRow>
      )}
      <ErrorLine message={error} />
    </Section>
  );
}

// ---- Email provider (spec 12b: API key in Settings, encrypted, test-send) -

function EmailCard({
  email,
  isAdmin,
  onChanged,
}: {
  email: { provider: string; from: string } | null;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [provider, setProvider] = useState("resend");
  const [from, setFrom] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [region, setRegion] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function patch(value: Record<string, unknown> | null) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { error: failure } = await send("/api/settings", "PATCH", {
      email_provider_config: value,
    });
    setBusy(false);
    if (failure) {
      setError(failure);
    } else {
      setApiKey("");
      setAccessKeyId("");
      setSecretAccessKey("");
      setNotice(value === null ? "cleared" : "saved - key encrypted at rest");
      onChanged();
    }
  }

  function save() {
    const base = { provider, from: from.trim() };
    void patch(
      provider === "ses"
        ? {
            ...base,
            accessKeyId: accessKeyId.trim(),
            secretAccessKey: secretAccessKey.trim(),
            region: region.trim(),
          }
        : { ...base, apiKey: apiKey.trim() },
    );
  }

  async function testSend() {
    setTestBusy(true);
    setError(null);
    setNotice(null);
    const { error: failure, data } = await send("/api/email/test", "POST", {
      to: to.trim(),
    });
    setTestBusy(false);
    if (failure) setError(failure);
    else setNotice(`test email sent via ${String(data?.provider)}`);
  }

  return (
    <Section title="Email">
      <SettingsRow label="Status">
        <StatusDot on={email !== null} />
        <span className="text-sm">
          {email ? `${email.provider} · from ${email.from}` : "not set"}
        </span>
        {email && isAdmin && (
          <ConfirmButton
            label="Clear"
            confirmLabel="Confirm clear"
            disabled={busy}
            onConfirm={() => void patch(null)}
          />
        )}
      </SettingsRow>
      {isAdmin && (
        <>
          <SettingsRow label="Provider" htmlFor="email-provider">
            <select
              id="email-provider"
              className="h-8 rounded-md border bg-transparent px-2 text-sm"
              disabled={busy}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="resend">Resend</option>
              <option value="postmark">Postmark</option>
              <option value="ses">Amazon SES</option>
            </select>
          </SettingsRow>
          <SettingsRow label="From" htmlFor="email-from">
            <Input
              id="email-from"
              type="email"
              className="h-8 w-64"
              placeholder="reports@acme.com"
              disabled={busy}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </SettingsRow>
          {provider === "ses" ? (
            <>
              <SettingsRow label="Access key ID" htmlFor="email-access-key">
                <Input
                  id="email-access-key"
                  className="h-8 w-64"
                  disabled={busy}
                  value={accessKeyId}
                  onChange={(e) => setAccessKeyId(e.target.value)}
                />
              </SettingsRow>
              <SettingsRow label="Secret access key" htmlFor="email-secret-key">
                <Input
                  id="email-secret-key"
                  type="password"
                  autoComplete="off"
                  className="h-8 w-64"
                  disabled={busy}
                  value={secretAccessKey}
                  onChange={(e) => setSecretAccessKey(e.target.value)}
                />
              </SettingsRow>
              <SettingsRow label="Region" htmlFor="email-region">
                <Input
                  id="email-region"
                  className="h-8 w-32"
                  placeholder="us-east-1"
                  disabled={busy}
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                />
              </SettingsRow>
            </>
          ) : (
            <SettingsRow
              label={provider === "postmark" ? "Server token" : "API key"}
              htmlFor="email-api-key"
            >
              <Input
                id="email-api-key"
                type="password"
                autoComplete="off"
                className="h-8 w-64"
                disabled={busy}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </SettingsRow>
          )}
          <SettingsRow>
            <Button
              size="sm"
              disabled={
                busy ||
                from.trim() === "" ||
                (provider === "ses"
                  ? accessKeyId.trim() === "" ||
                    secretAccessKey.trim() === "" ||
                    region.trim() === ""
                  : apiKey.trim() === "")
              }
              onClick={save}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : email ? "Replace" : "Save"}
            </Button>
            {notice && <span className="text-sm text-green-700">{notice}</span>}
          </SettingsRow>
          {email && (
            <SettingsRow label="Test send" htmlFor="email-test-to">
              <Input
                id="email-test-to"
                type="email"
                className="h-8 w-64"
                placeholder="you@acme.com"
                disabled={testBusy}
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={testBusy || to.trim() === ""}
                onClick={() => void testSend()}
              >
                {testBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Send"}
              </Button>
            </SettingsRow>
          )}
        </>
      )}
      <ErrorLine message={error} />
    </Section>
  );
}

// ---- Ingest keys (spec 6: minted in Settings, shown once, per ROI) --------

function IngestKeysCard({
  keys,
  products,
  isAdmin,
  onChanged,
}: {
  keys: IngestKey[];
  products: ProductListItem[];
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [productId, setProductId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  return (
    <Section title="Ingest keys">
      {isAdmin && (
        <SettingsRow label="Mint" htmlFor="ingest-product">
          <select
            id="ingest-product"
            className="h-8 rounded-md border bg-transparent px-2 text-sm"
            disabled={busy}
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          >
            <option value="">Mint for ROI…</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Input
            aria-label="Key name"
            className="h-8 w-40"
            placeholder="name (optional)"
            disabled={busy}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            size="sm"
            disabled={busy || productId === ""}
            onClick={async () => {
              setBusy(true);
              setError(null);
              setMinted(null);
              const { error: failure, data } = await send("/api/ingest-keys", "POST", {
                productId,
                ...(name.trim() !== "" ? { name: name.trim() } : {}),
              });
              setBusy(false);
              if (failure) {
                setError(failure);
              } else {
                setMinted((data?.token as string) ?? null);
                setCopied(false);
                setName("");
                onChanged();
              }
            }}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Mint key"}
          </Button>
        </SettingsRow>
      )}
      {minted && (
        <SettingsRow>
          <span className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 p-2">
            <code className="font-mono text-sm">{minted}</code>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(minted).then(() => setCopied(true));
              }}
            >
              {copied ? <Check className="h-4 w-4 text-green-700" /> : <Copy className="h-4 w-4" />}
            </Button>
            <span className="text-sm text-amber-700">shown once - store it now</span>
          </span>
        </SettingsRow>
      )}
      {keys.length > 0 && (
        <div className="space-y-2">
          {keys.map((key) => (
            <div key={key.id} className="flex flex-wrap items-center gap-3">
              <code className="font-mono text-sm">{key.tokenPrefix}…</code>
              {key.name && <span className="text-sm">{key.name}</span>}
              <span className="text-sm text-muted-foreground">→ {key.productName}</span>
              <span className="flex-1" />
              <span className="text-sm text-muted-foreground">
                {key.lastUsedAt ? `used ${timeAgo(key.lastUsedAt)}` : "never used"}
              </span>
              {key.revokedAt ? (
                <span className="text-sm text-red-600">revoked</span>
              ) : (
                isAdmin && (
                  <ConfirmButton
                    label="Revoke"
                    confirmLabel="Confirm revoke"
                    onConfirm={() => {
                      void send(`/api/ingest-keys/${key.id}`, "PATCH", { revoked: true }).then(
                        ({ error: failure }) => {
                          if (failure) setError(failure);
                          else onChanged();
                        },
                      );
                    }}
                  />
                )
              )}
            </div>
          ))}
        </div>
      )}
      <ErrorLine message={error} />
    </Section>
  );
}

// ---- Users (spec 11: one admin + view-only users; more admins = ee) -------

function UsersCard({
  users,
  moreAdminsLicensed,
  onChanged,
}: {
  users: UserRow[];
  moreAdminsLicensed: boolean;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"viewer" | "admin">("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adminLocked = role === "admin" && !moreAdminsLicensed;
  const admins = users.filter((u) => u.role === "admin").length;

  return (
    <Section title="Users">
      <div className="space-y-2">
        {users.map((user) => (
          <div key={user.id} className="flex flex-wrap items-center gap-3">
            <span className="font-medium">{user.name}</span>
            <span className="text-sm text-muted-foreground">
              {user.role}
              {" · "}
              {[
                user.passkeys > 0 && `${user.passkeys} passkey${user.passkeys > 1 ? "s" : ""}`,
                user.has_password && "password",
              ]
                .filter(Boolean)
                .join(" + ") || "no credentials"}
            </span>
            <span className="flex-1" />
            {(user.role === "viewer" || admins > 1) && (
              <ConfirmButton
                label="Remove"
                confirmLabel="Confirm remove"
                disabled={busy}
                onConfirm={() => {
                  void send(`/api/users/${user.id}`, "DELETE").then(({ error: failure }) => {
                    if (failure) setError(failure);
                    else onChanged();
                  });
                }}
              />
            )}
          </div>
        ))}
      </div>
      <SettingsRow label="Add" htmlFor="user-name">
        <Input
          id="user-name"
          className="h-8 w-40"
          placeholder="name"
          disabled={busy}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          aria-label="User password"
          type="password"
          autoComplete="new-password"
          className="h-8 w-40"
          placeholder="password (8+)"
          disabled={busy}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <select
          aria-label="Role"
          className="h-8 rounded-md border bg-transparent px-2 text-sm"
          disabled={busy}
          value={role}
          onChange={(e) => setRole(e.target.value as "viewer" | "admin")}
        >
          <option value="viewer">viewer</option>
          <option value="admin">admin</option>
        </select>
        <Button
          size="sm"
          disabled={busy || adminLocked || name.trim() === "" || password.length < 8}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const { error: failure } = await send("/api/users", "POST", {
              name: name.trim(),
              password,
              role,
            });
            setBusy(false);
            if (failure) {
              setError(failure);
            } else {
              setName("");
              setPassword("");
              setRole("viewer");
              onChanged();
            }
          }}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
        </Button>
        {adminLocked && <span className="text-sm text-muted-foreground">{EE_LOCKED_COPY}</span>}
      </SettingsRow>
      <ErrorLine message={error} />
    </Section>
  );
}

// ---- Defaults (spec 10.6: revert window, retention) ------------------------

function DefaultsCard({
  settings,
  isAdmin,
  onChanged,
}: {
  settings: SettingValues;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [form, setForm] = useState({
    revert_window_days: String(settings.revert_window_days),
    raw_facts_retention_months: String(settings.raw_facts_retention_months),
    update_check_enabled: settings.update_check_enabled,
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<typeof form>) => {
    setSaved(false);
    setForm((prev) => ({ ...prev, ...patch }));
  };

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const { error: failure } = await send("/api/settings", "PATCH", {
      revert_window_days: Number(form.revert_window_days),
      raw_facts_retention_months: Number(form.raw_facts_retention_months),
      update_check_enabled: form.update_check_enabled,
    });
    setBusy(false);
    if (failure) {
      setError(failure);
    } else {
      setSaved(true);
      onChanged();
    }
  }

  return (
    <Section title="Defaults">
      <SettingsRow label="Revert window" htmlFor="defaults-revert">
        <Input
          id="defaults-revert"
          className="h-8 w-16"
          disabled={busy || !isAdmin}
          value={form.revert_window_days}
          onChange={(e) => set({ revert_window_days: e.target.value })}
        />
        <span className="text-sm text-muted-foreground">days</span>
      </SettingsRow>
      <SettingsRow label="Retention" htmlFor="defaults-retention">
        <Input
          id="defaults-retention"
          className="h-8 w-16"
          disabled={busy || !isAdmin}
          value={form.raw_facts_retention_months}
          onChange={(e) => set({ raw_facts_retention_months: e.target.value })}
        />
        <span className="text-sm text-muted-foreground">months of raw facts</span>
      </SettingsRow>
      <SettingsRow label="Update check" htmlFor="defaults-update">
        <input
          id="defaults-update"
          type="checkbox"
          disabled={busy || !isAdmin}
          checked={form.update_check_enabled}
          onChange={(e) => set({ update_check_enabled: e.target.checked })}
        />
        <span className="text-sm text-muted-foreground">GitHub releases</span>
      </SettingsRow>
      {isAdmin && (
        <SettingsRow>
          <Button size="sm" disabled={busy} onClick={save}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </Button>
          {saved && <span className="text-sm text-green-700">saved</span>}
        </SettingsRow>
      )}
      <ErrorLine message={error} />
    </Section>
  );
}

// ---- Page ------------------------------------------------------------------

export default function SettingsClient() {
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);

  // Role never changes with settings writes - no ?v= bump, so isAdmin never
  // flickers false mid-refetch (which would unmount every admin-only block).
  const { data: auth } = useFetch<{ user: { role: string } | null }>(
    "/api/auth/state",
  );
  const connectorFetch = useFetch<{ connectors: ConnectorHealth[] }>(
    `/api/connectors?v=${version}`,
  );
  const settingsFetch = useFetch<SettingsPayload>(`/api/settings?v=${version}`);
  const connectorData = useLatest(connectorFetch.data);
  const settingsData = useLatest(settingsFetch.data);
  const productData = useLatest(
    useFetch<{ products: ProductListItem[] }>(`/api/products?v=${version}`).data,
  );
  const keyData = useLatest(
    useFetch<{ keys: IngestKey[] }>(`/api/ingest-keys?v=${version}`).data,
  );
  const userData = useLatest(
    useFetch<{ users: UserRow[] }>(`/api/users?v=${version}`).data,
  );
  const { error: connectorError } = connectorFetch;
  const { error: settingsError } = settingsFetch;

  const error = connectorError ?? settingsError;
  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 p-4 text-destructive">
        {error}
      </div>
    );
  }
  if (!connectorData || !settingsData || !productData || !keyData) {
    return <SettingsSkeleton />;
  }
  const isAdmin = auth?.user?.role === "admin";
  // An expired license still reports its feature list (for the status line),
  // but unlocks nothing - expiry locks ee features, data stays readable.
  const eeFeatures =
    settingsData.license.state === "valid" ? settingsData.license.features : [];

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Settings</h1>

      <Section title="Connectors">
        <div className="space-y-3">
          {connectorData.connectors.map((c) => (
            <ConnectorCard key={c.vendor} c={c} isAdmin={isAdmin} onChanged={reload} />
          ))}
        </div>
      </Section>

      <AlertsCard
        settings={settingsData.settings}
        configured={settingsData.secrets.slack_webhook_url}
        isAdmin={isAdmin}
        onChanged={reload}
      />

      <MoneyCard settings={settingsData.settings} isAdmin={isAdmin} onChanged={reload} />

      <EmailCard email={settingsData.email} isAdmin={isAdmin} onChanged={reload} />

      <IngestKeysCard
        keys={keyData.keys}
        products={productData.products}
        isAdmin={isAdmin}
        onChanged={reload}
      />

      {userData && (
        <UsersCard
          users={userData.users}
          moreAdminsLicensed={eeFeatures.includes("more_admins")}
          onChanged={reload}
        />
      )}

      <DefaultsCard settings={settingsData.settings} isAdmin={isAdmin} onChanged={reload} />

      <LicenseSection
        license={settingsData.license}
        isAdmin={isAdmin}
        onChanged={reload}
      />

      <EnterpriseSections
        features={eeFeatures}
        isAdmin={isAdmin}
        scheduledReports={settingsData.scheduledReports}
        emailConfigured={settingsData.email !== null}
        onChanged={reload}
      />
    </div>
  );
}
