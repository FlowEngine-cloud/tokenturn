"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  DAY_RE,
  monthToDateRange,
  parseRange,
  trailingRange,
  type DateRange,
} from "@/lib/range";
import { cn } from "@/lib/utils";

/** One global date-range picker (spec 10). The range lives in the URL, so
 * every page and every drill link inherits it. */

const PRESETS: { label: string; range: () => DateRange }[] = [
  { label: "7D", range: () => trailingRange(7) },
  { label: "30D", range: () => trailingRange(30) },
  { label: "90D", range: () => trailingRange(90) },
  { label: "MTD", range: () => monthToDateRange() },
];

export function DateRangePicker() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = parseRange(searchParams);

  function apply(range: DateRange) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("from", range.from);
    params.set("to", range.to);
    router.replace(`${pathname}?${params.toString()}`);
  }

  function applyEdge(key: "from" | "to", value: string) {
    if (!DAY_RE.test(value)) return;
    const next = { ...active, [key]: value };
    if (next.from > next.to) return;
    apply(next);
  }

  return (
    <div className="flex items-center gap-2">
      <div className="hidden items-center rounded-md border p-0.5 sm:flex">
        {PRESETS.map((preset) => {
          const range = preset.range();
          const isActive = range.from === active.from && range.to === active.to;
          return (
            <button
              key={preset.label}
              onClick={() => apply(range)}
              className={cn(
                "rounded px-2.5 py-1 text-sm",
                isActive
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      <input
        type="date"
        aria-label="From"
        value={active.from}
        max={active.to}
        onChange={(e) => applyEdge("from", e.target.value)}
        className="h-8 rounded-md border bg-transparent px-2 text-sm [color-scheme:light]"
      />
      <span className="text-muted-foreground">–</span>
      <input
        type="date"
        aria-label="To"
        value={active.to}
        min={active.from}
        onChange={(e) => applyEdge("to", e.target.value)}
        className="h-8 rounded-md border bg-transparent px-2 text-sm [color-scheme:light]"
      />
    </div>
  );
}
