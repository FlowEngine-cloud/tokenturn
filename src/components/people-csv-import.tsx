"use client";

import { useRef, useState } from "react";
import { Check, Loader2, Upload } from "lucide-react";
import { ErrorLine } from "@/components/form-utils";
import { Button } from "@/components/ui/button";
import { formatCount } from "@/lib/format";
import type { ParsedPeopleCsv, PeopleImportResult } from "@/lib/people-import";
import { cn } from "@/lib/utils";

/**
 * People CSV roster import (spec 8 In): drag-drop, header auto-detect,
 * preview before commit, per-row errors. Commit is all-or-nothing - a file
 * with bad rows shows every verdict and imports nothing. Shared by
 * Onboarding and the People page.
 */

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

export function PeopleCsvImport({ onImported }: { onImported?: () => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<ParsedPeopleCsv | null>(null);
  const [result, setResult] = useState<PeopleImportResult | null>(null);

  async function loadFile(file: File) {
    setBusy(true);
    setError(null);
    setResult(null);
    const text = await file.text();
    const { error: failure, data } = await postCsv("/api/people/import?preview=1", text);
    setBusy(false);
    if (failure) {
      setError(failure);
      setCsv(null);
      setPreview(null);
    } else {
      setCsv(text);
      setPreview(data as ParsedPeopleCsv);
    }
  }

  function reset() {
    setCsv(null);
    setPreview(null);
    setError(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function commit() {
    if (csv === null) return;
    setBusy(true);
    setError(null);
    const { error: failure, data } = await postCsv("/api/people/import", csv);
    setBusy(false);
    if (failure) {
      setError(failure);
    } else {
      setResult(data as PeopleImportResult);
      reset();
      onImported?.();
    }
  }

  if (preview) {
    const importable = preview.rows.filter((row) => row.error === null).length;
    const broken = preview.rows.length - importable;
    return (
      <div className="space-y-3">
        <p className="text-sm">
          {formatCount(preview.rows.length)} rows · {formatCount(importable)} ready
          {broken > 0 && <span className="text-red-600"> · {formatCount(broken)} with errors</span>}
        </p>
        <div className="max-h-64 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-3 py-1.5 font-medium">Line</th>
                <th className="px-3 py-1.5 font-medium">Email</th>
                <th className="px-3 py-1.5 font-medium">Name</th>
                <th className="px-3 py-1.5 font-medium">Problem</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row) => (
                <tr key={row.line} className="border-b last:border-0">
                  <td className="px-3 py-1 tabular-nums text-muted-foreground">{row.line}</td>
                  <td className="px-3 py-1">{row.email ?? "—"}</td>
                  <td className="px-3 py-1">{row.name ?? "—"}</td>
                  <td className="px-3 py-1 text-red-600">{row.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {preview.ok ? (
            <Button size="sm" disabled={busy} onClick={commit}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                `Import ${formatCount(importable)} people`
              )}
            </Button>
          ) : (
            <p className="text-sm text-red-600">
              Nothing imports until every row is clean - fix the file and re-upload.
            </p>
          )}
          <Button variant="ghost" size="sm" disabled={busy} onClick={reset}>
            Pick another file
          </Button>
        </div>
        <ErrorLine message={error} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <input
        ref={fileInput}
        type="file"
        accept=".csv,text/csv,text/plain"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void loadFile(file);
        }}
      />
      <button
        type="button"
        disabled={busy}
        className={cn(
          "flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-8 text-sm transition-colors",
          dragOver ? "border-primary bg-primary/5" : "hover:border-primary/50",
        )}
        onClick={() => fileInput.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void loadFile(file);
        }}
      >
        {busy ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          <Upload className="h-5 w-5 text-muted-foreground" />
        )}
        <span className="font-medium">Drop a CSV here, or browse</span>
        <span className="text-muted-foreground">
          Needs an email column - name is optional, headers auto-detect.
        </span>
      </button>
      {result && (
        <p className="flex items-center gap-1.5 text-sm text-green-700">
          <Check className="h-4 w-4" />
          {formatCount(result.created)} created · {formatCount(result.updated)} updated
          {result.matchedIdentities > 0 &&
            ` · ${formatCount(result.matchedIdentities)} vendor identities auto-matched`}
        </p>
      )}
      <ErrorLine message={error} />
    </div>
  );
}
