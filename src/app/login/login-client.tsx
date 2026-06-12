"use client";

import { useState } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Fingerprint, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { APP_NAME } from "@/lib/brand";

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

export function LoginClient({ claimed }: { claimed: boolean }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [usePassword, setUsePassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    action()
      .then(() => window.location.assign("/"))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      });
  }

  async function claimWithPasskey() {
    if (!name.trim()) throw new Error("enter your name first");
    const optRes = await postJson("/api/auth/setup/passkey/options", { name });
    if (!optRes.ok) throw new Error(await errorOf(optRes));
    const { challengeId, options } = await optRes.json();
    const response = await startRegistration({ optionsJSON: options });
    const verifyRes = await postJson("/api/auth/setup/passkey/verify", {
      challengeId,
      name,
      response,
    });
    if (!verifyRes.ok) throw new Error(await errorOf(verifyRes));
  }

  async function claimWithPassword() {
    const res = await postJson("/api/auth/setup/password", { name, password });
    if (!res.ok) throw new Error(await errorOf(res));
  }

  async function loginWithPasskey() {
    const optRes = await postJson("/api/auth/login/passkey/options", {});
    if (!optRes.ok) throw new Error(await errorOf(optRes));
    const { challengeId, options } = await optRes.json();
    const response = await startAuthentication({ optionsJSON: options });
    const verifyRes = await postJson("/api/auth/login/passkey/verify", {
      challengeId,
      response,
    });
    if (!verifyRes.ok) throw new Error(await errorOf(verifyRes));
  }

  async function loginWithPassword() {
    const res = await postJson("/api/auth/login/password", { name, password });
    if (!res.ok) throw new Error(await errorOf(res));
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{APP_NAME}</h1>
          <p className="mt-1 text-base text-muted-foreground">
            {claimed ? "Sign in" : "Claim this instance as its admin"}
          </p>
        </div>

        {!claimed && (
          <form
            className="space-y-6"
            onSubmit={(e) => {
              e.preventDefault();
              run(usePassword ? claimWithPassword : claimWithPasskey);
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                autoComplete="username"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            {usePassword && (
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
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
            )}
            <div className="space-y-3">
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <Fingerprint />}
                {usePassword ? "Claim with password" : "Create passkey"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                disabled={busy}
                onClick={() => setUsePassword((v) => !v)}
              >
                {usePassword ? "Use a passkey instead" : "Use a password instead"}
              </Button>
            </div>
          </form>
        )}

        {claimed && (
          <div className="space-y-6">
            <Button
              className="w-full"
              disabled={busy}
              onClick={() => run(loginWithPasskey)}
            >
              {busy ? <Loader2 className="animate-spin" /> : <Fingerprint />}
              Sign in with passkey
            </Button>
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <div className="h-px flex-1 bg-border" />
              or
              <div className="h-px flex-1 bg-border" />
            </div>
            <form
              className="space-y-6"
              onSubmit={(e) => {
                e.preventDefault();
                run(loginWithPassword);
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  autoComplete="username"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
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
                Sign in
              </Button>
            </form>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </main>
  );
}
