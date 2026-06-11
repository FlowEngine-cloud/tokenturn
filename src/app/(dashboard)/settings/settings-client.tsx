"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { statusOf } from "@/components/connector-health";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import type { ConnectorHealth } from "@/lib/connectors/health";
import { formatCents, formatCount, timeAgo } from "@/lib/format";
import type { IngestKey } from "@/lib/ingest";
import type { ProductListItem } from "@/lib/products";
import type { SettingValues } from "@/lib/settings";
import { useFetch } from "@/lib/use-fetch";
import { cn } from "@/lib/utils";

/**
 * Settings (spec 10 page 7): connectors, products, alert channels, display
 * currency, license - and every numeric default in the plan (revert window,
 * anomaly thresholds, retention) editable. Plus the two key surfaces specs 6
 * and 11 put here: ingest keys (minted per product, shown once) and the
 * admin's view-only users. Writes are admin-only; the server's word comes
 * back verbatim.
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
  secrets: { slack_webhook_url: boolean };
}

interface UserRow {
  id: string;
  name: string;
  role: "admin" | "viewer";
  passkeys: number;
  has_password: boolean;
}

async function send(
  url: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body?: Record<string, unknown>,
): Promise<{ error: string | null; data: Record<string, unknown> | null }> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok) return { error: null, data };
    return {
      error: (data?.error as string) ?? `request failed (${res.status})`,
      data: null,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), data: null };
  }
}

function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="text-sm text-destructive">{message}</p>;
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg border bg-card p-4">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

/** Two-step destructive button: first click arms, second fires. */
function ConfirmButton({
  label,
  confirmLabel,
  disabled,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <Button
      variant={armed ? "destructive" : "ghost"}
      size="sm"
      disabled={disabled}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}

/** Dollars typed by a human -> integer cents, or null when not a number. */
function toCents(text: string): number | null {
  if (text.trim() === "") return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

// ---- Connectors (spec 5: connect screens state vendor limits verbatim) ----

function ConnectorCard({
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

// ---- Products = cost centers (spec 7) -------------------------------------

const ATTRIBUTION_OPTIONS = ["connector", "key", "sdk", "manual"] as const;
const OUTCOME_OPTIONS = ["none", "github_pr", "sdk_event", "manual"] as const;

function ProductFields({
  value,
  onChange,
  disabled,
  idPrefix,
}: {
  value: {
    name: string;
    attribution: string;
    outcomeKind: string;
    defaultValue: string;
    defaultCurrency: string;
  };
  onChange: (next: ProductFieldsValue) => void;
  disabled: boolean;
  idPrefix: string;
}) {
  const set = (patch: Partial<ProductFieldsValue>) => onChange({ ...value, ...patch });
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-name`}>Name</Label>
        <Input
          id={`${idPrefix}-name`}
          className="h-8 w-44"
          disabled={disabled}
          value={value.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-attribution`}>Spend from</Label>
        <select
          id={`${idPrefix}-attribution`}
          className="h-8 rounded-md border bg-transparent px-2 text-sm"
          disabled={disabled}
          value={value.attribution}
          onChange={(e) => set({ attribution: e.target.value })}
        >
          {ATTRIBUTION_OPTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-outcome`}>Outcomes</Label>
        <select
          id={`${idPrefix}-outcome`}
          className="h-8 rounded-md border bg-transparent px-2 text-sm"
          disabled={disabled}
          value={value.outcomeKind}
          onChange={(e) => set({ outcomeKind: e.target.value })}
        >
          {OUTCOME_OPTIONS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-value`}>Value per outcome</Label>
        <div className="flex gap-1">
          <Input
            id={`${idPrefix}-value`}
            className="h-8 w-24"
            inputMode="decimal"
            placeholder="4.50"
            disabled={disabled}
            value={value.defaultValue}
            onChange={(e) => set({ defaultValue: e.target.value })}
          />
          <Input
            aria-label="Value currency"
            className="h-8 w-16 uppercase"
            maxLength={3}
            disabled={disabled}
            value={value.defaultCurrency}
            onChange={(e) => set({ defaultCurrency: e.target.value.toUpperCase() })}
          />
        </div>
      </div>
    </div>
  );
}

type ProductFieldsValue = {
  name: string;
  attribution: string;
  outcomeKind: string;
  defaultValue: string;
  defaultCurrency: string;
};

/** name/attribution/outcomeKind/defaultValue form state -> API body. */
function productBody(value: ProductFieldsValue): Record<string, unknown> | string {
  if (!value.name.trim()) return "name required";
  const body: Record<string, unknown> = {
    name: value.name.trim(),
    attribution: value.attribution,
    outcomeKind: value.outcomeKind,
  };
  if (value.defaultValue.trim() !== "") {
    const cents = toCents(value.defaultValue);
    if (cents === null) return "value per outcome must be a non-negative amount";
    body.defaultValueCents = cents;
    body.defaultValueCurrency = value.defaultCurrency || "USD";
  } else {
    body.defaultValueCents = null;
    body.defaultValueCurrency = null;
  }
  return body;
}

function ManualEntryForm({ product, onChanged }: { product: ProductListItem; onChanged: () => void }) {
  const canCost = product.attribution === "manual";
  const canOutcomes = product.outcomeKind === "manual";
  const [kind, setKind] = useState<"cost" | "outcomes">(canCost ? "cost" : "outcomes");
  const [month, setMonth] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [count, setCount] = useState("");
  const [value, setValue] = useState("");
  const [valueCurrency, setValueCurrency] = useState("USD");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!canCost && !canOutcomes) return null;
  const activeKind = canCost && kind === "cost" ? "cost" : canOutcomes ? "outcomes" : "cost";

  async function save() {
    setError(null);
    setSaved(false);
    let body: Record<string, unknown>;
    if (activeKind === "cost") {
      const cents = toCents(amount);
      if (cents === null) {
        setError("amount must be a non-negative number");
        return;
      }
      body = { kind: "cost", month, amountCents: cents, currency: currency || "USD" };
    } else {
      const n = Number(count);
      if (!Number.isInteger(n) || n < 0) {
        setError("count must be a non-negative whole number");
        return;
      }
      body = { kind: "outcomes", month, count: n };
      if (value.trim() !== "") {
        const cents = toCents(value);
        if (cents === null) {
          setError("value must be a non-negative amount");
          return;
        }
        body.valueCents = cents;
        body.valueCurrency = valueCurrency || "USD";
      }
    }
    if (note.trim() !== "") body.note = note.trim();
    setBusy(true);
    const { error: failure } = await send(`/api/products/${product.id}/manual`, "PUT", body);
    setBusy(false);
    if (failure) {
      setError(failure);
    } else {
      setSaved(true);
      onChanged();
    }
  }

  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor={`manual-kind-${product.id}`}>Manual entry</Label>
          <select
            id={`manual-kind-${product.id}`}
            className="h-8 rounded-md border bg-transparent px-2 text-sm"
            disabled={busy || !(canCost && canOutcomes)}
            value={activeKind}
            onChange={(e) => setKind(e.target.value as "cost" | "outcomes")}
          >
            {canCost && <option value="cost">monthly cost</option>}
            {canOutcomes && <option value="outcomes">monthly outcomes</option>}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`manual-month-${product.id}`}>Month</Label>
          <Input
            id={`manual-month-${product.id}`}
            type="month"
            className="h-8 w-40"
            disabled={busy}
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </div>
        {activeKind === "cost" ? (
          <div className="space-y-1">
            <Label htmlFor={`manual-amount-${product.id}`}>Amount</Label>
            <div className="flex gap-1">
              <Input
                id={`manual-amount-${product.id}`}
                className="h-8 w-28"
                inputMode="decimal"
                placeholder="2000"
                disabled={busy}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <Input
                aria-label="Currency"
                className="h-8 w-16 uppercase"
                maxLength={3}
                disabled={busy}
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <Label htmlFor={`manual-count-${product.id}`}>Count</Label>
              <Input
                id={`manual-count-${product.id}`}
                className="h-8 w-20"
                inputMode="numeric"
                disabled={busy}
                value={count}
                onChange={(e) => setCount(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`manual-value-${product.id}`}>Value each</Label>
              <div className="flex gap-1">
                <Input
                  id={`manual-value-${product.id}`}
                  className="h-8 w-24"
                  inputMode="decimal"
                  placeholder="default"
                  disabled={busy}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
                <Input
                  aria-label="Value currency"
                  className="h-8 w-16 uppercase"
                  maxLength={3}
                  disabled={busy}
                  value={valueCurrency}
                  onChange={(e) => setValueCurrency(e.target.value.toUpperCase())}
                />
              </div>
            </div>
          </>
        )}
        <div className="space-y-1">
          <Label htmlFor={`manual-note-${product.id}`}>Note</Label>
          <Input
            id={`manual-note-${product.id}`}
            className="h-8 w-44"
            disabled={busy}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <Button size="sm" disabled={busy || !/^\d{4}-\d{2}$/.test(month)} onClick={save}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Record"}
        </Button>
        {saved && <span className="pb-1.5 text-sm text-green-700">recorded · rollups updated</span>}
      </div>
      <ErrorLine message={error} />
    </div>
  );
}

function ProductRow({
  product,
  isAdmin,
  onChanged,
}: {
  product: ProductListItem;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<ProductFieldsValue>({
    name: product.name,
    attribution: product.attribution,
    outcomeKind: product.outcomeKind,
    defaultValue:
      product.defaultValueCents === null ? "" : (product.defaultValueCents / 100).toFixed(2),
    defaultCurrency: product.defaultValueCurrency ?? "USD",
  });

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const { error: failure } = await send(`/api/products/${product.id}`, "PATCH", body);
    setBusy(false);
    if (failure) setError(failure);
    else onChanged();
  }

  const archived = product.archivedAt !== null;
  return (
    <div className={cn("space-y-3 rounded-lg border p-3", archived && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/products/${product.id}`} className="font-medium hover:underline">
          {product.name}
        </Link>
        <span className="text-sm text-muted-foreground">
          {product.attribution} · {product.outcomeKind}
          {product.defaultValueCents !== null &&
            ` · ${formatCents(product.defaultValueCents, product.defaultValueCurrency ?? "USD")}/outcome`}
          {archived && " · archived"}
        </span>
        <span className="flex-1" />
        <span className="text-sm tabular-nums text-muted-foreground">
          {formatCents(product.spendUsdCents, "USD")} all-time
          {product.outcomeCount > 0 && ` · ${formatCount(product.outcomeCount)} outcomes`}
        </span>
        {isAdmin && (
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setOpen((v) => !v)}>
              {open ? "Close" : "Edit"}
            </Button>
            <ConfirmButton
              label={archived ? "Restore" : "Archive"}
              confirmLabel={archived ? "Confirm restore" : "Confirm archive"}
              disabled={busy}
              onConfirm={() => patch({ archived: !archived })}
            />
          </>
        )}
      </div>

      {open && isAdmin && (
        <div className="space-y-3 border-t pt-3">
          <div className="flex flex-wrap items-end gap-2">
            <ProductFields
              value={fields}
              onChange={setFields}
              disabled={busy}
              idPrefix={`edit-${product.id}`}
            />
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                const body = productBody(fields);
                if (typeof body === "string") setError(body);
                else void patch(body);
              }}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </Button>
          </div>
          {!archived && <ManualEntryForm product={product} onChanged={onChanged} />}
        </div>
      )}
      <ErrorLine message={error} />
    </div>
  );
}

function NewProductForm({ onChanged }: { onChanged: () => void }) {
  const [fields, setFields] = useState<ProductFieldsValue>({
    name: "",
    attribution: "sdk",
    outcomeKind: "none",
    defaultValue: "",
    defaultCurrency: "USD",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <ProductFields value={fields} onChange={setFields} disabled={busy} idPrefix="new" />
        <Button
          size="sm"
          disabled={busy || fields.name.trim() === ""}
          onClick={async () => {
            const body = productBody(fields);
            if (typeof body === "string") {
              setError(body);
              return;
            }
            setBusy(true);
            setError(null);
            const { error: failure } = await send("/api/products", "POST", body);
            setBusy(false);
            if (failure) {
              setError(failure);
            } else {
              setFields({
                name: "",
                attribution: "sdk",
                outcomeKind: "none",
                defaultValue: "",
                defaultCurrency: "USD",
              });
              onChanged();
            }
          }}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create"}
        </Button>
      </div>
      <ErrorLine message={error} />
    </div>
  );
}

// ---- Ingest keys (spec 6: minted in Settings, shown once, per product) ----

function IngestKeysSection({
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
  const live = products.filter((p) => p.archivedAt === null);
  const [productId, setProductId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  return (
    <Section title="Ingest keys">
      {isAdmin && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Product"
            className="h-8 rounded-md border bg-transparent px-2 text-sm"
            disabled={busy}
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          >
            <option value="">Mint for product…</option>
            {live.map((p) => (
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
        </div>
      )}
      {minted && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 p-2">
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
        </div>
      )}
      <ErrorLine message={error} />
      {keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No keys yet. The SDK authenticates with an ingest key scoped to one product.
        </p>
      ) : (
        <ul className="divide-y">
          {keys.map((key) => (
            <li key={key.id} className="flex flex-wrap items-center gap-3 py-2">
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
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---- Alert channel (spec 9: alerts default to the Slack webhook) ----------

function AlertsSection({
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

  return (
    <Section title="Alert channel">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            configured ? "bg-green-600" : "bg-muted-foreground/40",
          )}
        />
        <span className="text-sm">
          Slack webhook {configured ? "configured" : "not set"}
        </span>
        <span className="text-sm text-muted-foreground">
          · limit, anomaly and silent-connector alerts post here
        </span>
      </div>
      {isAdmin && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Slack webhook URL"
            type="url"
            className="h-8 w-96"
            placeholder="https://hooks.slack.com/services/…"
            disabled={busy}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button
            size="sm"
            disabled={busy || url.trim() === ""}
            onClick={() => patch(url.trim())}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : configured ? "Replace" : "Save"}
          </Button>
          {configured && (
            <ConfirmButton
              label="Clear"
              confirmLabel="Confirm clear"
              disabled={busy}
              onConfirm={() => patch(null)}
            />
          )}
        </div>
      )}
      <ErrorLine message={error} />
    </Section>
  );
}

// ---- Display currency + every numeric default in the plan -----------------

function ConfigSection({
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
    revert_window_days: String(settings.revert_window_days),
    anomaly_burn_multiplier: String(settings.anomaly_burn_multiplier),
    anomaly_min_day: (settings.anomaly_min_day_cents / 100).toFixed(2),
    limit_alert_thresholds_pct: settings.limit_alert_thresholds_pct.join(", "),
    raw_facts_retention_months: String(settings.raw_facts_retention_months),
    connector_silent_alert_hours: String(settings.connector_silent_alert_hours),
    update_check_enabled: settings.update_check_enabled,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
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
    const thresholds = form.limit_alert_thresholds_pct
      .split(",")
      .map((t) => Number(t.trim()))
      .filter((t) => !Number.isNaN(t));
    const body = {
      display_currency: form.display_currency.trim().toUpperCase(),
      revert_window_days: Number(form.revert_window_days),
      anomaly_burn_multiplier: Number(form.anomaly_burn_multiplier),
      anomaly_min_day_cents: toCents(form.anomaly_min_day) ?? -1,
      limit_alert_thresholds_pct: thresholds,
      raw_facts_retention_months: Number(form.raw_facts_retention_months),
      connector_silent_alert_hours: Number(form.connector_silent_alert_hours),
      update_check_enabled: form.update_check_enabled,
    };
    const { error: failure } = await send("/api/settings", "PATCH", body);
    setBusy(false);
    if (failure) {
      setError(failure);
    } else {
      setSaved(true);
      onChanged();
    }
  }

  const field = (
    label: string,
    key: keyof typeof form,
    opts: { width?: string; suffix?: string } = {},
  ) => (
    <div className="space-y-1">
      <Label htmlFor={`cfg-${key}`}>{label}</Label>
      <div className="flex items-center gap-1.5">
        <Input
          id={`cfg-${key}`}
          className={cn("h-8", opts.width ?? "w-24")}
          disabled={busy || !isAdmin}
          value={String(form[key])}
          onChange={(e) => set({ [key]: e.target.value } as Partial<typeof form>)}
        />
        {opts.suffix && (
          <span className="text-sm text-muted-foreground">{opts.suffix}</span>
        )}
      </div>
    </div>
  );

  return (
    <Section title="Display currency & defaults">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        {field("Display currency", "display_currency", { width: "w-20 uppercase" })}
        {field("Revert window", "revert_window_days", { suffix: "days" })}
        {field("Anomaly trigger", "anomaly_burn_multiplier", {
          width: "w-16",
          suffix: "x trailing 30-day avg",
        })}
        {field("Anomaly minimum", "anomaly_min_day", { suffix: "$/day" })}
        {field("Limit alerts at", "limit_alert_thresholds_pct", {
          width: "w-28",
          suffix: "% of monthly limit",
        })}
        {field("Raw fact retention", "raw_facts_retention_months", { suffix: "months" })}
        {field("Connector silent alert", "connector_silent_alert_hours", { suffix: "hours" })}
        <label className="flex h-8 items-center gap-2 text-sm">
          <input
            type="checkbox"
            disabled={busy || !isAdmin}
            checked={form.update_check_enabled}
            onChange={(e) => set({ update_check_enabled: e.target.checked })}
          />
          Check GitHub for new releases
        </label>
      </div>
      {isAdmin && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={save}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
          </Button>
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
        </div>
      )}
      <ErrorLine message={error} />
    </Section>
  );
}

// ---- View-only users (spec 11: one admin, who can add view-only users) ----

function UsersSection({
  users,
  onChanged,
}: {
  users: UserRow[];
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Section title="Users">
      <ul className="divide-y">
        {users.map((user) => (
          <li key={user.id} className="flex items-center gap-3 py-2">
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
            {user.role === "viewer" && (
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
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Viewer name"
          className="h-8 w-40"
          placeholder="viewer name"
          disabled={busy}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          aria-label="Viewer password"
          type="password"
          autoComplete="new-password"
          className="h-8 w-40"
          placeholder="password (8+)"
          disabled={busy}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button
          size="sm"
          disabled={busy || name.trim() === "" || password.length < 8}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const { error: failure } = await send("/api/users", "POST", {
              name: name.trim(),
              password,
            });
            setBusy(false);
            if (failure) {
              setError(failure);
            } else {
              setName("");
              setPassword("");
              onChanged();
            }
          }}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add viewer"}
        </Button>
      </div>
      <ErrorLine message={error} />
    </Section>
  );
}

// ---- Page ------------------------------------------------------------------

/**
 * Keep the last loaded value while a refetch is in flight. Settings refetches
 * after every write (the ?v= bump); without this the page would fall back to
 * the skeleton, unmounting every section - and with them the one-time minted
 * ingest token, "saved" notices and open edit forms.
 */
function useLatest<T>(value: T | null): T | null {
  const [last, setLast] = useState<T | null>(null);
  if (value !== null && value !== last) setLast(value); // derived state, re-renders pre-commit
  return value ?? last;
}

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
    useFetch<{ products: ProductListItem[] }>(
      `/api/products?archived=1&v=${version}`,
    ).data,
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

      <Section title="Products">
        {isAdmin && <NewProductForm onChanged={reload} />}
        <div className="space-y-2">
          {productData.products.map((product) => (
            <ProductRow
              key={product.id}
              product={product}
              isAdmin={isAdmin}
              onChanged={reload}
            />
          ))}
          {productData.products.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No products yet. A product is a cost center - anything that spends AI money.
            </p>
          )}
        </div>
      </Section>

      <IngestKeysSection
        keys={keyData.keys}
        products={productData.products}
        isAdmin={isAdmin}
        onChanged={reload}
      />

      <AlertsSection
        configured={settingsData.secrets.slack_webhook_url}
        isAdmin={isAdmin}
        onChanged={reload}
      />

      {/* No version key: the form itself is the live copy of these values
        * (nothing else edits them), and a remount would eat the saved notice. */}
      <ConfigSection settings={settingsData.settings} isAdmin={isAdmin} onChanged={reload} />

      {userData && <UsersSection users={userData.users} onChanged={reload} />}

      <Section title="License">
        <p className="text-sm">
          Free · sustainable-use license - all v1 connectors, the SDK, the full
          dashboard, limits and alerts. One admin plus view-only users, single org
          per vendor.
        </p>
        <p className="text-sm text-muted-foreground">
          Enterprise (Okta sync, Google Workspace roster, more admins, audit log,
          multi-org rollup, scheduled reports) is licensed per deal and verified
          offline - contact hi@flowengine.cloud.
        </p>
      </Section>
    </div>
  );
}
