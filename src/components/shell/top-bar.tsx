"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { CommandMenu } from "@/components/shell/command-menu";
import { DateRangePicker } from "@/components/shell/date-range-picker";
import { APP_NAME } from "@/lib/brand";
import { topBarMode } from "@/lib/range";

/** The top bar (spec 10): cmd-K search and the global date-range picker -
 * nothing else. The picker appears only where the calendar drives the data;
 * where dates mean nothing the whole bar disappears and cmd-K keeps working
 * through its keyboard shortcut. */
export function TopBar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const mode = topBarMode(pathname, searchParams);

  if (mode === "hidden") return <CommandMenu trigger={false} />;

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-4 border-b bg-background px-4 md:px-6 print:hidden">
      <div className="flex flex-1 items-center gap-3">
        <span className="font-semibold tracking-tight md:hidden">{APP_NAME}</span>
        <CommandMenu />
      </div>
      {mode === "full" && <DateRangePicker />}
    </header>
  );
}
