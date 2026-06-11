"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { ErrorLine, send, useLatest } from "@/components/form-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ConnectorHealth } from "@/lib/connectors/health";
import type { InviteResult } from "@/lib/provision";
import { useFetch } from "@/lib/use-fetch";

/**
 * Add one person (spec 8 In) - the CSV import is the bulk version of this.
 * Optional tool checkboxes grant vendor seats on the spot via the invite
 * fan-out; one result per tool - success or the vendor's error verbatim.
 */

function toggle(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function PeopleAdd({ onAdded }: { onAdded: () => void }) {
  const connectorData = useLatest(
    useFetch<{ connectors: ConnectorHealth[] }>("/api/connectors").data,
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [tools, setTools] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<InviteResult[] | null>(null);

  if (!connectorData) {
    return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  }
  const connectors = connectorData.connectors;
  const nameOf = (vendor: string) =>
    connectors.find((c) => c.vendor === vendor)?.displayName ?? vendor;

  async function add() {
    setBusy(true);
    setError(null);
    setResults(null);
    const created = await send("/api/people", "POST", { name, email });
    if (created.error) {
      setBusy(false);
      setError(created.error);
      return;
    }
    const personId = (created.data?.person as { id: string } | undefined)?.id;
    if (personId && tools.size > 0) {
      const { error: failure, data } = await send("/api/people/invite", "POST", {
        personIds: [personId],
        vendors: [...tools],
      });
      if (failure) {
        setBusy(false);
        setError(failure);
        return;
      }
      setResults((data?.results as InviteResult[]) ?? []);
    }
    setBusy(false);
    setName("");
    setEmail("");
    setTools(new Set());
    onAdded();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="add-name">Name</Label>
          <Input
            id="add-name"
            className="h-8 w-44"
            disabled={busy}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="add-email">Email</Label>
          <Input
            id="add-email"
            className="h-8 w-56"
            type="email"
            disabled={busy}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <Button size="sm" disabled={busy || email.trim() === ""} onClick={add}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        {connectors.map((c) => (
          <label
            key={c.vendor}
            className={
              c.connected
                ? "flex items-center gap-2 text-sm"
                : "flex items-center gap-2 text-sm text-muted-foreground"
            }
          >
            <input
              type="checkbox"
              disabled={!c.connected || busy}
              checked={tools.has(c.vendor)}
              onChange={() => setTools(toggle(tools, c.vendor))}
            />
            <span>{c.displayName}</span>
            {!c.connected && <span>not connected</span>}
          </label>
        ))}
      </div>
      <ErrorLine message={error} />
      {results && (
        <div className="max-h-72 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-3 py-1.5 font-medium">Tool</th>
                <th className="px-3 py-1.5 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={`${r.personId}:${r.vendor}`} className="border-b last:border-0">
                  <td className="px-3 py-1">{nameOf(r.vendor)}</td>
                  <td className="px-3 py-1">
                    {r.ok ? (
                      <span className="flex items-center gap-1.5 text-green-700">
                        <Check className="h-4 w-4 shrink-0" />
                        {r.detail}
                      </span>
                    ) : (
                      <span className="text-red-600">{r.error}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
