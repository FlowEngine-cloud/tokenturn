"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import {
  BadgeCheck,
  Bell,
  Cable,
  Check,
  Code2,
  Copy,
  Database,
  KeyRound,
  Loader2,
  Mail,
  Upload,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { ConnectorCard, PlugCard } from "@/components/connector-card";
import {
  AuditSection,
  GoogleConnectionCard,
  LicenseSection,
  OktaConnectionCard,
  ScheduledReportsSection,
} from "@/components/ee-settings";
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
import { type LicenseStatus } from "@/lib/ee";
import type { ApiKey } from "@/lib/auth";
import { formatCount, timeAgo } from "@/lib/format";
import type { IngestKey } from "@/lib/ingest";
import type { ImportResult, ParsedInvoiceCsv } from "@/lib/invoices";
import type { ProductListItem } from "@/lib/products";
import type { SettingValues } from "@/lib/settings";
import { useFetch } from "@/lib/use-fetch";
import { cn } from "@/lib/utils";

/**
 * Settings: personal access plus organization connections, alerts, data,
 * and licensing, with one section on screen at a time.
 * - Connections holds EVERYTHING that plugs in as one card grid on the one
 *   PlugCard shape: the vendors, Jira + Linear (success-only), the SDK's
 *   ingest keys, the email provider, the Slack webhook, and the Google
 *   Workspace + Okta ee cards - visible, locked without a license, never
 *   hidden.
 * - Alerts = where alerts go (Slack webhook, email recipients) and when
 *   (limit thresholds, the anomaly toggle + its two numbers), units in the
 *   labels.
 * - Data = display currency, invoice import, retention, revert window.
 * - License = one card.
 * There is no Users tab and no Defaults tab: login access and limits are
 * properties of the person (their page); offboard lives there too.
 * Everywhere: one label and one control per row, zero explanatory
 * sentences. Writes are admin-only; the server's word comes back verbatim.
 */

export function SettingsSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-9 w-full max-w-xl" />
      <Skeleton className="h-72 w-full" />
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

const OFF_DOT = "bg-muted-foreground/40";
const ON_DOT = "bg-green-600";

// ---- Slack webhook (spec 9: the default alert destination). The control is
// shared: the Connections card body and the Alerts tab "where" row ----------

function SlackWebhookControl({
  configured,
  isAdmin,
  onChanged,
}: {
  configured: boolean;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patch(value: string | null) {
    setBusy(true);
    setError(null);
    const { error: failure } = await send("/api/settings", "PATCH", {
      slack_webhook_url: value,
    });
    setBusy(false);
    if (failure) {
      setError(failure);
    } else {
      setUrl("");
      onChanged();
    }
  }

  if (!isAdmin) {
    return <span className="text-sm">{configured ? "configured" : "not set"}</span>;
  }
  return (
    <>
      <Input
        aria-label="Slack webhook URL"
        type="url"
        className="h-8 w-80 max-w-full"
        placeholder="https://hooks.slack.com/services/…"
        disabled={busy}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <Button
        size="sm"
        disabled={busy || url.trim() === ""}
        onClick={() => void patch(url.trim())}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : configured ? "Replace" : "Save"}
      </Button>
      {configured && (
        <ConfirmButton
          label="Clear"
          confirmLabel="Confirm clear"
          disabled={busy}
          onConfirm={() => void patch(null)}
        />
      )}
      <ErrorLine message={error} />
    </>
  );
}

function SlackCard({
  configured,
  isAdmin,
  onChanged,
}: {
  configured: boolean;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <PlugCard
      icon={Webhook}
      name="Slack"
      dot={configured ? ON_DOT : OFF_DOT}
      status={configured ? "connected" : null}
      action={configured ? null : "Connect"}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      <SettingsRow label="Webhook URL">
        <SlackWebhookControl configured={configured} isAdmin={isAdmin} onChanged={onChanged} />
      </SettingsRow>
    </PlugCard>
  );
}

// ---- Email provider card (spec 12b: pick a provider, get exactly its
// fields, test-send) ----------------------------------------------------------

interface EmailField {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  width?: string;
  /** Fixed choices render a select; the first one is the default. */
  options?: { value: string; label: string }[];
}

/** Per-provider fields (spec 10.6): picking one shows exactly these. */
const EMAIL_PROVIDER_DEFS: { id: string; label: string; fields: EmailField[] }[] = [
  {
    id: "smtp",
    label: "SMTP",
    fields: [
      { key: "host", label: "Host", placeholder: "smtp.acme.com" },
      { key: "port", label: "Port", placeholder: "587", width: "w-24" },
      { key: "username", label: "Username" },
      { key: "password", label: "Password", secret: true },
    ],
  },
  { id: "resend", label: "Resend", fields: [{ key: "apiKey", label: "API key", secret: true }] },
  {
    id: "postmark",
    label: "Postmark",
    fields: [{ key: "apiKey", label: "Server token", secret: true }],
  },
  {
    id: "ses",
    label: "Amazon SES",
    fields: [
      { key: "accessKeyId", label: "Access key ID" },
      { key: "secretAccessKey", label: "Secret access key", secret: true },
      { key: "region", label: "Region", placeholder: "us-east-1", width: "w-32" },
    ],
  },
  {
    id: "mailgun",
    label: "Mailgun",
    fields: [
      { key: "apiKey", label: "API key", secret: true },
      {
        key: "region",
        label: "Region",
        options: [
          { value: "us", label: "US" },
          { value: "eu", label: "EU" },
        ],
      },
    ],
  },
];

function EmailCard({
  email,
  isAdmin,
  onChanged,
}: {
  email: { provider: string; from: string } | null;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState(email?.provider ?? "smtp");
  const [from, setFrom] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const def =
    EMAIL_PROVIDER_DEFS.find((p) => p.id === provider) ?? EMAIL_PROVIDER_DEFS[0];
  const ready =
    from.trim() !== "" &&
    def.fields.every((f) => f.options !== undefined || (values[f.key] ?? "").trim() !== "") &&
    (provider !== "smtp" || /^\d+$/.test((values.port ?? "").trim()));

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
      setValues({});
      setNotice(value === null ? "cleared" : "saved");
      onChanged();
    }
  }

  function save() {
    const payload: Record<string, unknown> = { provider, from: from.trim() };
    for (const f of def.fields) {
      const raw = (values[f.key] ?? "").trim();
      payload[f.key] = f.options
        ? raw || f.options[0].value
        : f.key === "port"
          ? Number(raw)
          : raw;
    }
    void patch(payload);
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
    <PlugCard
      icon={Mail}
      name="Email"
      dot={email !== null ? ON_DOT : OFF_DOT}
      status={email ? `${email.provider} · ${email.from}` : null}
      action={email !== null ? null : "Connect"}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      {!isAdmin && <span className="text-sm">{email ? "configured" : "not set"}</span>}
      {isAdmin && (
        <>
          <SettingsRow label="Provider" htmlFor="email-provider">
            <select
              id="email-provider"
              className="h-8 rounded-md border bg-transparent px-2 text-sm"
              disabled={busy}
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setValues({});
                setNotice(null);
              }}
            >
              {EMAIL_PROVIDER_DEFS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </SettingsRow>
          <SettingsRow label="From" htmlFor="email-from">
            <Input
              id="email-from"
              type="email"
              className="h-8 w-64 max-w-full"
              placeholder="reports@acme.com"
              disabled={busy}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </SettingsRow>
          {def.fields.map((f) => (
            <SettingsRow key={f.key} label={f.label} htmlFor={`email-${f.key}`}>
              {f.options ? (
                <select
                  id={`email-${f.key}`}
                  className="h-8 rounded-md border bg-transparent px-2 text-sm"
                  disabled={busy}
                  value={values[f.key] ?? f.options[0].value}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [f.key]: e.target.value }))
                  }
                >
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  id={`email-${f.key}`}
                  type={f.secret ? "password" : "text"}
                  autoComplete="off"
                  className={cn("h-8 max-w-full", f.width ?? "w-64")}
                  placeholder={f.placeholder}
                  disabled={busy}
                  value={values[f.key] ?? ""}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [f.key]: e.target.value }))
                  }
                />
              )}
            </SettingsRow>
          ))}
          <SettingsRow>
            <Button size="sm" disabled={busy || !ready} onClick={save}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : email ? "Replace" : "Save"}
            </Button>
            {email && (
              <ConfirmButton
                label="Clear"
                confirmLabel="Confirm clear"
                disabled={busy}
                onConfirm={() => void patch(null)}
              />
            )}
            {notice && <span className="text-sm text-green-700">{notice}</span>}
          </SettingsRow>
          {email && (
            <SettingsRow label="Test send" htmlFor="email-test-to">
              <Input
                id="email-test-to"
                type="email"
                className="h-8 w-64 max-w-full"
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
    </PlugCard>
  );
}

// ---- SDK card (spec 6: ingest keys minted in Settings, shown once, scoped
// per ROI - the SDK plugs in, so it lives in Connections) ---------------------

function SdkCard({
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
  const [open, setOpen] = useState(false);
  const [productId, setProductId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const live = keys.filter((key) => !key.revokedAt);

  return (
    <PlugCard
      icon={Code2}
      name="SDK"
      dot={live.length > 0 ? ON_DOT : OFF_DOT}
      status={
        live.length > 0
          ? `${formatCount(live.length)} ingest ${live.length === 1 ? "key" : "keys"}`
          : "no ingest keys"
      }
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      {isAdmin && (
        <SettingsRow label="Mint" htmlFor="ingest-product">
          <select
            id="ingest-product"
            className="h-8 rounded-md border bg-transparent px-2 text-sm"
            disabled={busy}
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          >
            <option value="">Choose ROI…</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Input
            aria-label="Key name"
            className="h-8 w-40 max-w-full"
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
          <span className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-amber-500/40 p-2">
            <code className="break-all font-mono text-sm">{minted}</code>
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
    </PlugCard>
  );
}

// ---- Personal API keys -----------------------------------------------------

function PersonalApiKeysCard({
  keys,
  onChanged,
}: {
  keys: ApiKey[];
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  return (
    <Section title="Personal API keys">
      <SettingsRow label="New key" htmlFor="api-key-name">
        <Input
          id="api-key-name"
          className="h-8 w-64 max-w-full"
          placeholder="CI, local scripts, reporting"
          maxLength={80}
          disabled={busy}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          size="sm"
          disabled={busy || name.trim() === ""}
          onClick={async () => {
            setBusy(true);
            setError(null);
            setMinted(null);
            const { error: failure, data } = await send("/api/api-keys", "POST", {
              name: name.trim(),
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
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create key"}
        </Button>
      </SettingsRow>
      {minted && (
        <SettingsRow label="Token">
          <span className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-amber-500/40 p-2">
            <code className="break-all font-mono text-sm">{minted}</code>
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
      {keys.length === 0 ? (
        <SettingsRow label="Keys">
          <span className="text-sm text-muted-foreground">No personal API keys</span>
        </SettingsRow>
      ) : (
        <div className="divide-y">
          {keys.map((key) => (
            <div
              key={key.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0"
            >
              <span className="font-medium">{key.name}</span>
              <code className="font-mono text-sm text-muted-foreground">
                {key.tokenPrefix}…
              </code>
              <span className="flex-1" />
              <span className="text-sm text-muted-foreground">
                {key.lastUsedAt ? `used ${timeAgo(key.lastUsedAt)}` : "never used"}
              </span>
              {key.revokedAt ? (
                <span className="text-sm text-red-600">revoked</span>
              ) : (
                <ConfirmButton
                  label="Revoke"
                  confirmLabel="Confirm revoke"
                  onConfirm={() => {
                    void send(`/api/api-keys/${key.id}`, "PATCH", { revoked: true }).then(
                      ({ error: failure }) => {
                        if (failure) setError(failure);
                        else onChanged();
                      },
                    );
                  }}
                />
              )}
            </div>
          ))}
        </div>
      )}
      <ErrorLine message={error} />
    </Section>
  );
}

// ---- Connections (spec 10.6: one card grid for everything that plugs in) ---

function ConnectionsTab({
  connectors,
  payload,
  keys,
  products,
  isAdmin,
  onChanged,
}: {
  connectors: ConnectorHealth[];
  payload: SettingsPayload;
  keys: IngestKey[];
  products: ProductListItem[];
  isAdmin: boolean;
  onChanged: () => void;
}) {
  // Spend vendors first, success-only integrations after - one shape for all.
  const vendors = connectors.filter((c) => !c.successOnly);
  const successOnly = connectors.filter((c) => c.successOnly);
  const eeFeatures =
    payload.license.state === "valid" ? payload.license.features : [];

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {[...vendors, ...successOnly].map((c) => (
        <ConnectorCard key={c.vendor} c={c} isAdmin={isAdmin} onChanged={onChanged} />
      ))}
      <SdkCard keys={keys} products={products} isAdmin={isAdmin} onChanged={onChanged} />
      <EmailCard email={payload.email} isAdmin={isAdmin} onChanged={onChanged} />
      <SlackCard
        configured={payload.secrets.slack_webhook_url}
        isAdmin={isAdmin}
        onChanged={onChanged}
      />
      <GoogleConnectionCard
        licensed={eeFeatures.includes("google_workspace")}
        isAdmin={isAdmin}
        onChanged={onChanged}
      />
      <OktaConnectionCard
        licensed={eeFeatures.includes("okta_sync")}
        isAdmin={isAdmin}
        onChanged={onChanged}
      />
    </div>
  );
}

// ---- Alerts (spec 10.6: where they go - Slack webhook, email recipients -
// and when - thresholds, the anomaly toggle + its two numbers) ---------------

function AlertsCard({
  settings,
  slackConfigured,
  isAdmin,
  onChanged,
}: {
  settings: SettingValues;
  slackConfigured: boolean;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [form, setForm] = useState({
    alert_email_recipients: settings.alert_email_recipients.join(", "),
    limit_alert_thresholds_pct: settings.limit_alert_thresholds_pct.join(", "),
    anomaly_enabled: settings.anomaly_enabled,
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

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const list = (text: string) =>
      text
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== "");
    const { error: failure } = await send("/api/settings", "PATCH", {
      alert_email_recipients: list(form.alert_email_recipients),
      limit_alert_thresholds_pct: list(form.limit_alert_thresholds_pct)
        .map((t) => Number(t))
        .filter((t) => !Number.isNaN(t)),
      anomaly_enabled: form.anomaly_enabled,
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
    key: "limit_alert_thresholds_pct" | "anomaly_burn_multiplier" | "anomaly_min_day" | "connector_silent_alert_hours",
    suffix: string,
    width = "w-20",
    disabled = false,
  ) => (
    <SettingsRow label={label} htmlFor={`alerts-${key}`}>
      <Input
        id={`alerts-${key}`}
        className={`h-8 ${width}`}
        disabled={busy || !isAdmin || disabled}
        value={form[key]}
        onChange={(e) => set({ [key]: e.target.value } as Partial<typeof form>)}
      />
      <span className="text-sm text-muted-foreground">{suffix}</span>
    </SettingsRow>
  );

  return (
    <Section title="Alerts">
      <SettingsRow label="Slack webhook URL">
        <SlackWebhookControl
          configured={slackConfigured}
          isAdmin={isAdmin}
          onChanged={onChanged}
        />
      </SettingsRow>
      <SettingsRow label="Email alerts to" htmlFor="alerts-alert_email_recipients">
        <Input
          id="alerts-alert_email_recipients"
          className="h-8 w-96 max-w-full"
          placeholder="cfo@acme.com, finance@acme.com"
          disabled={busy || !isAdmin}
          value={form.alert_email_recipients}
          onChange={(e) => set({ alert_email_recipients: e.target.value })}
        />
      </SettingsRow>
      {numeric("Alert at", "limit_alert_thresholds_pct", "% of a person's monthly limit", "w-28")}
      <SettingsRow label="Anomaly alerts" htmlFor="alerts-anomaly_enabled">
        <input
          id="alerts-anomaly_enabled"
          type="checkbox"
          disabled={busy || !isAdmin}
          checked={form.anomaly_enabled}
          onChange={(e) => set({ anomaly_enabled: e.target.checked })}
        />
      </SettingsRow>
      {numeric(
        "Daily burn over",
        "anomaly_burn_multiplier",
        "× their 30-day average",
        "w-16",
        !form.anomaly_enabled,
      )}
      {numeric(
        "And at least",
        "anomaly_min_day",
        "USD that day",
        "w-20",
        !form.anomaly_enabled,
      )}
      {numeric(
        "Connector silent",
        "connector_silent_alert_hours",
        "hours before an alert",
        "w-16",
      )}
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

// ---- Data (spec 10.6: display currency, invoice import, retention, revert
// window; spec 4's monthly invoice CSV true-up) -------------------------------

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

function DataCard({
  settings,
  isAdmin,
  onChanged,
}: {
  settings: SettingValues;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [form, setForm] = useState({
    display_currency: settings.display_currency,
    raw_facts_retention_months: String(settings.raw_facts_retention_months),
    revert_window_days: String(settings.revert_window_days),
    update_check_enabled: settings.update_check_enabled,
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fxBusy, setFxBusy] = useState(false);
  const [fxNotice, setFxNotice] = useState<string | null>(null);

  const set = (patch: Partial<typeof form>) => {
    setSaved(false);
    setForm((prev) => ({ ...prev, ...patch }));
  };

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const { error: failure } = await send("/api/settings", "PATCH", {
      display_currency: form.display_currency.trim().toUpperCase(),
      raw_facts_retention_months: Number(form.raw_facts_retention_months),
      revert_window_days: Number(form.revert_window_days),
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
    <Section title="Data">
      <SettingsRow label="Display currency" htmlFor="data-currency">
        <Input
          id="data-currency"
          className="h-8 w-20 uppercase"
          maxLength={3}
          disabled={busy || !isAdmin}
          value={form.display_currency}
          onChange={(e) => set({ display_currency: e.target.value.toUpperCase() })}
        />
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
      <SettingsRow label="Retention" htmlFor="data-retention">
        <Input
          id="data-retention"
          className="h-8 w-16"
          disabled={busy || !isAdmin}
          value={form.raw_facts_retention_months}
          onChange={(e) => set({ raw_facts_retention_months: e.target.value })}
        />
        <span className="text-sm text-muted-foreground">months of raw facts</span>
      </SettingsRow>
      <SettingsRow label="Revert window" htmlFor="data-revert">
        <Input
          id="data-revert"
          className="h-8 w-16"
          disabled={busy || !isAdmin}
          value={form.revert_window_days}
          onChange={(e) => set({ revert_window_days: e.target.value })}
        />
        <span className="text-sm text-muted-foreground">
          days a revert can flip a merged PR
        </span>
      </SettingsRow>
      <SettingsRow label="Update check" htmlFor="data-update">
        <input
          id="data-update"
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

const TABS = [
  { id: "personal", label: "Personal", icon: KeyRound },
  { id: "connections", label: "Connections", icon: Cable },
  { id: "alerts", label: "Alerts", icon: Bell },
  { id: "data", label: "Data", icon: Database },
  { id: "license", label: "License", icon: BadgeCheck },
] as const satisfies readonly { id: string; label: string; icon: LucideIcon }[];

type TabId = (typeof TABS)[number]["id"];

export default function SettingsClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);

  const param = searchParams.get("tab");
  const tab: TabId = TABS.some((t) => t.id === param) ? (param as TabId) : "personal";

  function show(id: TabId) {
    const params = new URLSearchParams(searchParams);
    if (id === "personal") params.delete("tab");
    else params.set("tab", id);
    const qs = params.toString();
    router.replace(qs === "" ? pathname : `${pathname}?${qs}`, { scroll: false });
  }

  // Role never changes with settings writes - no ?v= bump, so isAdmin never
  // flickers false mid-refetch (which would unmount every admin-only block).
  const { data: auth } = useFetch<{ user: { id: string; role: string } | null }>(
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
  const apiKeyData = useLatest(
    useFetch<{ keys: ApiKey[] }>(`/api/api-keys?v=${version}`).data,
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
  if (!connectorData || !settingsData || !productData || !keyData || !apiKeyData) {
    return <SettingsSkeleton />;
  }
  const isAdmin = auth?.user?.role === "admin";
  // An expired license still reports its feature list (for the status line),
  // but unlocks nothing - expiry locks ee features, data stays readable.
  const eeFeatures =
    settingsData.license.state === "valid" ? settingsData.license.features : [];

  return (
    <div className="space-y-6">
      <header className="space-y-4 border-b pb-4">
        <div>
          <h1 className="text-xl font-semibold">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage your access and the organization&apos;s integrations.
          </p>
        </div>
        <nav className="flex flex-wrap gap-2" aria-label="Settings sections">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={id === tab ? "page" : undefined}
              onClick={() => show(id)}
              className={cn(
                "flex items-center gap-2 rounded-md border px-3 py-2 text-sm",
                id === tab
                  ? "border-foreground bg-foreground font-medium text-background"
                  : "bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </button>
          ))}
        </nav>
      </header>

      <div className="space-y-6">
        {tab === "personal" && (
          <PersonalApiKeysCard keys={apiKeyData.keys} onChanged={reload} />
        )}

        {tab === "connections" && (
          <ConnectionsTab
            connectors={connectorData.connectors}
            payload={settingsData}
            keys={keyData.keys}
            products={productData.products}
            isAdmin={isAdmin}
            onChanged={reload}
          />
        )}

        {tab === "alerts" && (
          <>
            <AlertsCard
              settings={settingsData.settings}
              slackConfigured={settingsData.secrets.slack_webhook_url}
              isAdmin={isAdmin}
              onChanged={reload}
            />
            <ScheduledReportsSection
              licensed={eeFeatures.includes("scheduled_reports")}
              config={settingsData.scheduledReports}
              emailConfigured={settingsData.email !== null}
              isAdmin={isAdmin}
              onChanged={reload}
            />
          </>
        )}

        {tab === "data" && (
          <>
            <DataCard
              settings={settingsData.settings}
              isAdmin={isAdmin}
              onChanged={reload}
            />
            <AuditSection licensed={eeFeatures.includes("audit_log")} isAdmin={isAdmin} />
          </>
        )}

        {tab === "license" && (
          <LicenseSection
            license={settingsData.license}
            isAdmin={isAdmin}
            onChanged={reload}
          />
        )}
      </div>
    </div>
  );
}
