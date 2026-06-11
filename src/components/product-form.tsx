"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { ErrorLine, send, toCents } from "@/components/form-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Product } from "@/lib/products";

/** The Add ROI form (spec 7): name + spend slice + success definition +
 * optional value per success. Shared by the ROI page, Settings and
 * Onboarding. (The DB keeps the products table name; only the language
 * changed.) */

export const ATTRIBUTION_OPTIONS = ["connector", "key", "sdk", "manual"] as const;
export const OUTCOME_OPTIONS = [
  "none",
  "github_pr",
  "issue_done",
  "sdk_event",
  "manual",
] as const;

/** Raw enums mean nothing to a CFO - label them, and say how the chosen
 * slice actually feeds the ROI (spec 7). */
export const ATTRIBUTION_LABELS: Record<string, string> = {
  connector: "Whole vendor",
  key: "Tagged keys",
  sdk: "SDK",
  manual: "Manual entry",
};
const ATTRIBUTION_HINTS: Record<string, string> = {
  connector: "Everything one vendor bills routes here.",
  key: "Keys named after it route here.",
  sdk: "wrap(client, { roi }) sends spend; track() sends successes.",
  manual: "You enter monthly cost - and successes - by hand.",
};
export const OUTCOME_LABELS: Record<string, string> = {
  none: "None - cost only",
  github_pr: "Merged PRs",
  issue_done: "Issues done (Jira/Linear)",
  sdk_event: "track() events",
  manual: "Manual",
};

export type ProductFieldsValue = {
  name: string;
  attribution: string;
  outcomeKind: string;
  defaultValue: string;
  defaultCurrency: string;
};

export function ProductFields({
  value,
  onChange,
  disabled,
  idPrefix,
}: {
  value: ProductFieldsValue;
  onChange: (next: ProductFieldsValue) => void;
  disabled: boolean;
  idPrefix: string;
}) {
  const set = (patch: Partial<ProductFieldsValue>) => onChange({ ...value, ...patch });
  const SELECT = "h-9 w-full rounded-md border bg-transparent px-2 text-sm";
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-name`}>Name</Label>
          <Input
            id={`${idPrefix}-name`}
            className="h-9 w-full"
            disabled={disabled}
            value={value.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-attribution`}>Spend slice</Label>
          <select
            id={`${idPrefix}-attribution`}
            className={SELECT}
            disabled={disabled}
            value={value.attribution}
            onChange={(e) => set({ attribution: e.target.value })}
          >
            {ATTRIBUTION_OPTIONS.map((a) => (
              <option key={a} value={a}>
                {ATTRIBUTION_LABELS[a]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-outcome`}>Success</Label>
          <select
            id={`${idPrefix}-outcome`}
            className={SELECT}
            disabled={disabled}
            value={value.outcomeKind}
            onChange={(e) => set({ outcomeKind: e.target.value })}
          >
            {OUTCOME_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {OUTCOME_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-value`}>Value per success</Label>
          <div className="flex gap-1.5">
            <Input
              id={`${idPrefix}-value`}
              className="h-9 w-full"
              inputMode="decimal"
              placeholder="4.50"
              disabled={disabled}
              value={value.defaultValue}
              onChange={(e) => set({ defaultValue: e.target.value })}
            />
            <Input
              aria-label="Value currency"
              className="h-9 w-20 uppercase"
              maxLength={3}
              disabled={disabled}
              value={value.defaultCurrency}
              onChange={(e) => set({ defaultCurrency: e.target.value.toUpperCase() })}
            />
          </div>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{ATTRIBUTION_HINTS[value.attribution]}</p>
    </div>
  );
}

/** name/attribution/outcomeKind/defaultValue form state -> API body. */
export function productBody(value: ProductFieldsValue): Record<string, unknown> | string {
  if (!value.name.trim()) return "name required";
  const body: Record<string, unknown> = {
    name: value.name.trim(),
    attribution: value.attribution,
    outcomeKind: value.outcomeKind,
  };
  if (value.defaultValue.trim() !== "") {
    const cents = toCents(value.defaultValue);
    if (cents === null) return "value per success must be a non-negative amount";
    body.defaultValueCents = cents;
    body.defaultValueCurrency = value.defaultCurrency || "USD";
  } else {
    body.defaultValueCents = null;
    body.defaultValueCurrency = null;
  }
  return body;
}

/** Record a month of manual cost / outcomes for a manual-slice ROI (spec 7).
 * Lives on the ROI's detail page; PUT upserts the month in place. */
export function ManualEntryForm({
  product,
  onChanged,
}: {
  product: Pick<Product, "id" | "attribution" | "outcomeKind">;
  onChanged: () => void;
}) {
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

export function NewProductForm({ onChanged }: { onChanged: () => void }) {
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
    <div className="space-y-3">
      <ProductFields value={fields} onChange={setFields} disabled={busy} idPrefix="new" />
      <div className="flex items-center justify-end gap-2">
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
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
        </Button>
      </div>
      <ErrorLine message={error} />
    </div>
  );
}
