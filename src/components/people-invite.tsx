"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { ErrorLine, send, useLatest } from "@/components/form-utils";
import { Button } from "@/components/ui/button";
import type { ConnectorHealth } from "@/lib/connectors/health";
import type { InviteResult } from "@/lib/provision";
import { useFetch } from "@/lib/use-fetch";

/**
 * Invite fan-out (spec 8 In): pick people + tools, send, and read one
 * result per person per tool - success or the vendor's error verbatim.
 * Tools = the connected vendors; disconnected ones show but can't be
 * picked.
 */

export interface Invitee {
  personId: string;
  email: string;
  name: string | null;
}

function toggle(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function PeopleInvite({ people }: { people: Invitee[] }) {
  const connectorData = useLatest(
    useFetch<{ connectors: ConnectorHealth[] }>("/api/connectors").data,
  );
  const [picked, setPicked] = useState<Set<string>>(new Set());
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

  async function sendInvites() {
    setBusy(true);
    setError(null);
    setResults(null);
    const { error: failure, data } = await send("/api/people/invite", "POST", {
      personIds: [...picked],
      vendors: [...tools],
    });
    setBusy(false);
    if (failure) setError(failure);
    else setResults((data?.results as InviteResult[]) ?? []);
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium">People</span>
            <button
              type="button"
              className="text-sm text-muted-foreground underline-offset-2 hover:underline"
              onClick={() =>
                setPicked(
                  picked.size === people.length
                    ? new Set()
                    : new Set(people.map((p) => p.personId)),
                )
              }
            >
              {picked.size === people.length ? "none" : "all"}
            </button>
          </div>
          <div className="max-h-56 space-y-1 overflow-auto rounded-md border p-2">
            {people.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No active people yet - import the roster first.
              </p>
            )}
            {people.map((p) => (
              <label key={p.personId} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={picked.has(p.personId)}
                  onChange={() => setPicked(toggle(picked, p.personId))}
                />
                <span>{p.name ?? p.email}</span>
                {p.name && <span className="text-muted-foreground">{p.email}</span>}
              </label>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <span className="text-sm font-medium">Tools</span>
          <div className="space-y-1.5 rounded-md border p-2">
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
                  disabled={!c.connected}
                  checked={tools.has(c.vendor)}
                  onChange={() => setTools(toggle(tools, c.vendor))}
                />
                <span>{c.displayName}</span>
                {!c.connected && <span>not connected</span>}
              </label>
            ))}
          </div>
          <Button
            size="sm"
            disabled={busy || picked.size === 0 || tools.size === 0}
            onClick={sendInvites}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              `Invite ${picked.size || ""} ${picked.size === 1 ? "person" : "people"}`
            )}
          </Button>
        </div>
      </div>
      <ErrorLine message={error} />
      {results && (
        <div className="max-h-72 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-3 py-1.5 font-medium">Person</th>
                <th className="px-3 py-1.5 font-medium">Tool</th>
                <th className="px-3 py-1.5 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={`${r.personId}:${r.vendor}`} className="border-b last:border-0">
                  <td className="px-3 py-1">{r.email}</td>
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
