"use client";

import { useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { Check, Fingerprint, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function errorOf(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data?.error === "string") return data.error;
  } catch {
    // fall through
  }
  return `request failed (${res.status})`;
}

export function ResetClient({ token }: { token: string }) {
  const [stage, setStage] = useState<"confirm" | "credentials">("confirm");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [passkeyAdded, setPasskeyAdded] = useState(false);
  const [passwordSet, setPasswordSet] = useState(false);

  function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    action()
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setBusy(false));
  }

  async function consume() {
    const res = await postJson("/api/auth/reset/consume", { token });
    if (!res.ok) throw new Error(await errorOf(res));
    setStage("credentials");
  }

  async function addPasskey() {
    const optRes = await postJson("/api/auth/passkey/options", {});
    if (!optRes.ok) throw new Error(await errorOf(optRes));
    const { challengeId, options } = await optRes.json();
    const response = await startRegistration({ optionsJSON: options });
    const verifyRes = await postJson("/api/auth/passkey/verify", {
      challengeId,
      response,
    });
    if (!verifyRes.ok) throw new Error(await errorOf(verifyRes));
    setPasskeyAdded(true);
  }

  async function setNewPassword() {
    const res = await postJson("/api/auth/password", { password });
    if (!res.ok) throw new Error(await errorOf(res));
    setPasswordSet(true);
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">AI P&amp;L</h1>
          <p className="mt-1 text-base text-muted-foreground">Admin reset</p>
        </div>

        {stage === "confirm" && (
          <div className="space-y-4">
            <p className="text-base">
              This one-time link signs you in as the admin and signs out every
              other session.
            </p>
            <Button className="w-full" disabled={busy} onClick={() => run(consume)}>
              {busy && <Loader2 className="animate-spin" />}
              Continue
            </Button>
          </div>
        )}

        {stage === "credentials" && (
          <div className="space-y-8">
            <div className="space-y-3">
              <Button
                className="w-full"
                disabled={busy}
                onClick={() => run(addPasskey)}
              >
                {passkeyAdded ? <Check /> : <Fingerprint />}
                {passkeyAdded ? "Passkey added" : "Create new passkey"}
              </Button>
            </div>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                run(setNewPassword);
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="password">New password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <Button
                type="submit"
                variant="secondary"
                className="w-full"
                disabled={busy}
              >
                {passwordSet ? <Check /> : null}
                {passwordSet ? "Password set" : "Set password"}
              </Button>
            </form>
            {(passkeyAdded || passwordSet) && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => window.location.assign("/")}
              >
                Go to dashboard
              </Button>
            )}
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </main>
  );
}
