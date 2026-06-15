"use client";

import { Presentation } from "lucide-react";
import { useDemo } from "@/components/shell/demo-context";

/**
 * Shown on every dashboard page when the instance runs with DEMO_MODE=1
 * (see isDemoMode). The flag comes from DemoProvider - read server-side in
 * the layout, never baked in at build time. Everything is on screen and
 * fully browsable; the controls are visible but disabled.
 */
export function DemoBanner() {
  const demo = useDemo();
  if (!demo) return null;
  return (
    <div className="flex items-center gap-2 border-b bg-accent px-4 py-1.5 text-sm md:px-6 print:hidden">
      <Presentation className="h-4 w-4 shrink-0" />
      <span>
        <span className="font-medium">Demo mode</span> - read-only. Browse and drill into
        everything; the controls are shown but disabled.
      </span>
    </div>
  );
}
