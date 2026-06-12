"use client";

import { Presentation } from "lucide-react";
import { useFetch } from "@/lib/use-fetch";

/**
 * Shown on every dashboard page when the instance runs with DEMO_MODE=1
 * (see isDemoMode): browse everything, change nothing. The flag is read at
 * request time via /api/auth/state - never baked in at build time.
 */
export function DemoBanner() {
  const { data } = useFetch<{ demoMode: boolean }>("/api/auth/state");
  if (!data?.demoMode) return null;
  return (
    <div className="flex items-center gap-2 border-b bg-accent px-4 py-1.5 text-sm md:px-6 print:hidden">
      <Presentation className="h-4 w-4 shrink-0" />
      <span>
        <span className="font-medium">Demo mode</span> - read-only. Browse and drill into
        everything; saving is disabled.
      </span>
    </div>
  );
}
