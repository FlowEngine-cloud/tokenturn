"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  HELP_ITEM,
  isNavActive,
  NAV_ITEMS,
  SETTINGS_ITEM,
  useResolveBadge,
} from "@/components/shell/nav";
import { Brand } from "@/components/shell/brand";
import { SignedInRow } from "@/components/shell/signed-in";
import { rangeFromParams } from "@/lib/range";
import { cn } from "@/lib/utils";

/**
 * Cross-page nav (spec 10), desktop: fixed sidebar at md+. Below md the
 * drawer in mobile-nav.tsx takes over. Links carry the active date range so
 * the global picker survives navigation. Resolve shows the live queue badge
 * (queue + tag conflicts, spec 7b) until both are empty.
 */
export function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const resolveCount = useResolveBadge();

  const range = rangeFromParams(searchParams);
  const rangeQuery = range ? `?from=${range.from}&to=${range.to}` : "";

  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-56 flex-col border-r bg-sidebar md:flex print:hidden">
      <div className="flex h-14 items-center border-b px-5">
        <Link href={`/${rangeQuery}`}>
          <Brand />
        </Link>
      </div>
      <nav className="flex-1 space-y-1 p-3">
        {NAV_ITEMS.map((item) => {
          const active = isNavActive(item.href, pathname);
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
        {[SETTINGS_ITEM, HELP_ITEM].map((item) => (
          <Link
            key={item.href}
            href={`${item.href}${rangeQuery}`}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm",
              pathname.startsWith(item.href)
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            )}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </Link>
        ))}
        <SignedInRow />
      </div>
    </aside>
  );
}
