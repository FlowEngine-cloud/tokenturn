"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { ErrorLine, send, toCents } from "@/components/form-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Product (= cost center, spec 7) form fields + create form. Shared by
 * Settings and Onboarding. */

export const ATTRIBUTION_OPTIONS = ["connector", "key", "sdk", "manual"] as const;
export const OUTCOME_OPTIONS = ["none", "github_pr", "sdk_event", "manual"] as const;

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
    if (cents === null) return "value per outcome must be a non-negative amount";
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
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create"}
        </Button>
      </div>
      <ErrorLine message={error} />
    </div>
  );
}
