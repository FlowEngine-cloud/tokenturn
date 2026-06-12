"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/** Shared write-form plumbing for dashboard clients (Settings, Onboarding). */

export async function send(
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

export function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  // min-w-0 + break-words: vendor errors come back verbatim and can be one
  // long token (a URL, a JSON blob) - they must wrap, never blow out a card.
  return <p className="min-w-0 break-words text-sm text-destructive">{message}</p>;
}

/** One titled settings card. */
export function Section({
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

/** One settings line (spec 10.6): a label and a control, nothing else. No
 * label = a control-only row (save buttons) aligned to the control column. */
export function SettingsRow({
  label,
  htmlFor,
  children,
}: {
  label?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 items-center gap-x-4 gap-y-1 sm:grid-cols-[11rem_minmax(0,1fr)]">
      {label ? (
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </label>
      ) : (
        <span aria-hidden className="max-sm:hidden" />
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/** Two-step destructive button: first click arms, second fires. */
export function ConfirmButton({
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
export function toCents(text: string): number | null {
  if (text.trim() === "") return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/**
 * Keep the last loaded value while a refetch is in flight. Pages that
 * refetch after every write (the ?v= bump) would otherwise fall back to the
 * skeleton, unmounting every section - and with them one-time minted
 * tokens, "saved" notices and open edit forms.
 */
export function useLatest<T>(value: T | null): T | null {
  const [last, setLast] = useState<T | null>(null);
  if (value !== null && value !== last) setLast(value); // derived state, re-renders pre-commit
  return value ?? last;
}
