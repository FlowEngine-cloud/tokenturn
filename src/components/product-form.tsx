"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { ErrorLine, send, toCents } from "@/components/form-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** The Add ROI form (spec 7): name + spend slice + success definition +
 * optional value per success. Shared by the ROI page, Settings and
 * Onboarding. (The DB keeps the products table name; only the language
 * changed.) */

export const ATTRIBUTION_OPTIONS = ["connector", "key", "sdk", "manual"] as const;
export const OUTCOME_OPTIONS = ["none", "github_pr", "sdk_event", "manual"] as const;

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
  sdk: "wrap(client, { product }) sends spend; track() sends successes.",
  manual: "You enter monthly cost - and successes - by hand.",
};
export const OUTCOME_LABELS: Record<string, string> = {
  none: "None - cost only",
  github_pr: "Merged PRs",
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
  return (
    <div className="space-y-2">
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
        <Label htmlFor={`${idPrefix}-attribution`}>Spend slice</Label>
        <select
          id={`${idPrefix}-attribution`}
          className="h-8 rounded-md border bg-transparent px-2 text-sm"
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
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-outcome`}>Success</Label>
        <select
          id={`${idPrefix}-outcome`}
          className="h-8 rounded-md border bg-transparent px-2 text-sm"
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
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-value`}>Value per success</Label>
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
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
        </Button>
      </div>
      <ErrorLine message={error} />
    </div>
  );
}
