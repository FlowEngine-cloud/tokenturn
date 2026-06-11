"use client";

import { useState } from "react";
import { Check, Copy, KeyRound, Loader2 } from "lucide-react";
import { ErrorLine, useLatest } from "@/components/form-utils";
import { Button } from "@/components/ui/button";
import type { ConnectorHealth } from "@/lib/connectors/health";
import type { MintedKeyForPerson } from "@/lib/provision";
import { useFetch } from "@/lib/use-fetch";

/**
 * Per-person key minting (spec 8 In). OpenAI: minted via the Admin API,
 * the key value shown once and never saved. Anthropic has no key-creation
 * API - the person mints in their Console and the next sync auto-detects
 * and maps it - so that path is a note, not a button.
 */

export function MintOpenAiKey({
  personId,
  personEmail,
  onMinted,
}: {
  personId: string;
  personEmail: string;
  onMinted: () => void;
}) {
  const connectorData = useLatest(
    useFetch<{ connectors: ConnectorHealth[] }>("/api/connectors").data,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [projectId, setProjectId] = useState("");
  const [minted, setMinted] = useState<MintedKeyForPerson | null>(null);
  const [copied, setCopied] = useState(false);

  const openai = connectorData?.connectors.find((c) => c.vendor === "openai");
  const anthropic = connectorData?.connectors.find((c) => c.vendor === "anthropic");
  if (!openai?.connected && !anthropic?.connected) return null;

  async function mint(pickedProject: string | null) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/people/${personId}/keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          vendor: "openai",
          ...(pickedProject ? { projectId: pickedProject } : {}),
        }),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.ok) {
        setMinted(data?.minted as MintedKeyForPerson);
        setCopied(false);
        setProjects(null);
        onMinted();
      } else if (res.status === 409 && Array.isArray(data?.projects)) {
        // Several projects - the admin picks where the key lives.
        const list = data.projects as { id: string; name: string }[];
        setProjects(list);
        setProjectId(list[0]?.id ?? "");
      } else {
        setError((data?.error as string) ?? `request failed (${res.status})`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        {openai?.connected && !minted && (
          <>
            <Button size="sm" disabled={busy} onClick={() => void mint(projectId || null)}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Mint OpenAI key"}
            </Button>
            {projects && (
              <select
                aria-label="OpenAI project"
                className="h-8 rounded-md border bg-transparent px-2 text-sm"
                disabled={busy}
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
        {minted && (
          <span className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 p-2">
            <code className="font-mono text-sm">{minted.apiKey}</code>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(minted.apiKey).then(() => setCopied(true));
              }}
            >
              {copied ? <Check className="h-4 w-4 text-green-700" /> : <Copy className="h-4 w-4" />}
            </Button>
            <span className="text-sm text-amber-700">
              shown once - hand it to {personEmail} now
            </span>
          </span>
        )}
      </div>
      {anthropic?.connected && (
        <p className="text-sm text-muted-foreground">
          Anthropic has no key-creation API - {personEmail} mints a key in
          their Console; the next sync auto-detects it and maps it here.
        </p>
      )}
      <ErrorLine message={error} />
    </div>
  );
}
