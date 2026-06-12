"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Brand } from "@/components/shell/brand";
import { CommandMenu } from "@/components/shell/command-menu";
import { DateRangePicker } from "@/components/shell/date-range-picker";
import { MobileNav } from "@/components/shell/mobile-nav";
import { topBarMode } from "@/lib/range";

/** The top bar (spec 10): cmd-K search and the global date-range picker -
 * nothing else. The picker appears only where the calendar drives the data.
 * Where dates mean nothing the bar disappears on desktop (cmd-K keeps
 * working through its keyboard shortcut) but stays on phones - below md it
 * is the only chrome, so it always carries the nav drawer. */
export function TopBar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const mode = topBarMode(pathname, searchParams);

  if (mode === "hidden") {
    return (
      <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b bg-background px-4 md:hidden print:hidden">
        <MobileNav />
        <span className="flex-1">
          <Brand />
        </span>
        {/* Mounted (CSS-hidden at md+), so ⌘K works on desktop too. */}
        <CommandMenu />
      </header>
    );
  }

  return (
    <header className="sticky top-0 z-40 flex h-14 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b bg-background px-4 max-[420px]:h-auto max-[420px]:py-2 md:px-6 print:hidden">
      <div className="flex flex-1 items-center gap-3">
        <MobileNav />
        <span className="md:hidden">
          <Brand />
        </span>
        <CommandMenu />
      </div>
      {mode === "full" && <DateRangePicker />}
    </header>
  );
}
