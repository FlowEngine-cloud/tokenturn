"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { HELP_ITEM, NAV_ITEMS, RESOLVE_CHANGED_EVENT } from "@/components/shell/nav";
import { DAY_RE } from "@/lib/range";
import { cn } from "@/lib/utils";

/**
 * Cross-page nav (spec 10). Links carry the active date range so the global
 * picker survives navigation. Resolve shows the live queue badge (queue +
 * tag conflicts, spec 7b) until both are empty; queue mutations announce
 * themselves so the badge drains without a navigation.
 */
export function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [resolveCount, setResolveCount] = useState<number>(0);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(RESOLVE_CHANGED_EVENT, bump);
    return () => window.removeEventListener(RESOLVE_CHANGED_EVENT, bump);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/resolve")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data && Array.isArray(data.queue)) {
          const conflicts = Array.isArray(data.conflicts) ? data.conflicts.length : 0;
          setResolveCount(data.queue.length + conflicts);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname, version]);

  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const rangeQuery =
    from && to && DAY_RE.test(from) && DAY_RE.test(to)
      ? `?from=${from}&to=${to}`
      : "";

  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-56 flex-col border-r bg-sidebar md:flex print:hidden">
      <div className="flex h-14 items-center border-b px-5">
        <Link href={`/${rangeQuery}`} className="font-semibold tracking-tight">
          {"AI P&L"}
        </Link>
      </div>
      <nav className="flex-1 space-y-1 p-3">
        {NAV_ITEMS.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href) ||
                // ROI detail routes kept their original paths (spec 10.3).
                (item.href === "/roi" && pathname.startsWith("/products"));
          return (
            <Link
              key={item.href}
              href={`${item.href}${rangeQuery}`}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm",
                active
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
            >
              <item.icon className="h-4 w-4" />
              <span className="flex-1">{item.label}</span>
              {item.href === "/resolve" && resolveCount > 0 && (
                <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
                  {resolveCount}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="border-t p-3">
        <Link
          href={`${HELP_ITEM.href}${rangeQuery}`}
          className={cn(
            "flex items-center gap-3 rounded-md px-3 py-2 text-sm",
            pathname.startsWith(HELP_ITEM.href)
              ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          )}
        >
          <HELP_ITEM.icon className="h-4 w-4" />
          {HELP_ITEM.label}
        </Link>
      </div>
    </aside>
  );
}
