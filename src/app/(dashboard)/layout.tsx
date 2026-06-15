import { Suspense } from "react";
import { DemoBanner } from "@/components/shell/demo-banner";
import { DemoProvider } from "@/components/shell/demo-context";
import { Sidebar } from "@/components/shell/sidebar";
import { TopBar } from "@/components/shell/top-bar";
import { Tour } from "@/components/shell/tour";
import { VersionBanner } from "@/components/shell/version-banner";
import { isDemoMode } from "@/lib/demo";

// DEMO_MODE is a runtime env (docker-compose), so the shell must render per
// request - never prerendered with the flag baked in at build time.
export const dynamic = "force-dynamic";

/** The dashboard shell (spec 10): sidebar nav, global date-range picker,
 * cmd-K search. Auth is enforced by the proxy - unauthenticated visitors
 * never reach these pages. Demo mode (read once here, server-side) flows to
 * every client via DemoProvider so write controls render but stay disabled. */
export default function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <DemoProvider value={isDemoMode()}>
      <div className="min-h-screen">
        <Suspense>
          <Sidebar />
        </Suspense>
        <div className="flex min-h-screen flex-col md:pl-56 print:pl-0">
          <DemoBanner />
          <VersionBanner />
          <Suspense>
            <TopBar />
          </Suspense>
          <main className="flex-1 p-4 md:p-6">{children}</main>
        </div>
        <Suspense>
          <Tour />
        </Suspense>
      </div>
    </DemoProvider>
  );
}
