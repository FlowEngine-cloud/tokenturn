import { Suspense } from "react";
import { CommandMenu } from "@/components/shell/command-menu";
import { DateRangePicker } from "@/components/shell/date-range-picker";
import { Sidebar } from "@/components/shell/sidebar";
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
        <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-4 border-b bg-background px-4 md:px-6 print:hidden">
          <div className="flex flex-1 items-center gap-3">
            <span className="font-semibold tracking-tight md:hidden">{"AI P&L"}</span>
            <Suspense>
              <CommandMenu />
            </Suspense>
          </div>
          <Suspense>
            <DateRangePicker />
          </Suspense>
        </header>
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
