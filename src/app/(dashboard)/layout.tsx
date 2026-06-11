import { Suspense } from "react";
import { Sidebar } from "@/components/shell/sidebar";
import { TopBar } from "@/components/shell/top-bar";
import { VersionBanner } from "@/components/shell/version-banner";

/** The dashboard shell (spec 10): sidebar nav, global date-range picker,
 * cmd-K search. Auth is enforced by the proxy - unauthenticated visitors
 * never reach these pages. */
export default function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="min-h-screen">
      <Suspense>
        <Sidebar />
      </Suspense>
      <div className="flex min-h-screen flex-col md:pl-56 print:pl-0">
        <VersionBanner />
        <Suspense>
          <TopBar />
        </Suspense>
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
