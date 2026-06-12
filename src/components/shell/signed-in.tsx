"use client";

import { LogOut } from "lucide-react";
import { useFetch } from "@/lib/use-fetch";

/**
 * Sidebar-bottom account row (spec 10.6): the signed-in name and the sign
 * out action. One definition for the desktop sidebar and the mobile drawer.
 */
export function SignedInRow() {
  const { data } = useFetch<{ user: { name: string } | null }>("/api/auth/state");
  if (!data?.user) return null;

  return (
    <div className="flex items-center gap-3 px-3 py-2 text-sm text-muted-foreground">
      <span className="min-w-0 flex-1 truncate" title={data.user.name}>
        {data.user.name}
      </span>
      <button
        type="button"
        aria-label="Sign out"
        title="Sign out"
        className="rounded-md p-1 hover:text-foreground"
        onClick={() => {
          void fetch("/api/auth/logout", { method: "POST" })
            .catch(() => {})
            .then(() => {
              window.location.href = "/login";
            });
        }}
      >
        <LogOut className="h-4 w-4" />
      </button>
    </div>
  );
}
