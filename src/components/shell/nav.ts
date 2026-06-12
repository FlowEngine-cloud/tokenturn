"use client";

import {
  CircleHelp,
  FileText,
  GitMerge,
  LayoutDashboard,
  Settings,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/** Fired by the Resolve page after a queue mutation so the nav badge
 * refetches without a navigation. */
export const RESOLVE_CHANGED_EVENT = "ai-pnl:resolve-changed";

/** The dashboard's pages (spec 10) - one definition for the sidebar, the
 * mobile drawer, and the cmd-K "Pages" group. */
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/people", label: "People", icon: Users },
  { href: "/roi", label: "ROI", icon: TrendingUp },
  { href: "/resolve", label: "Resolve", icon: GitMerge },
  { href: "/report", label: "Report", icon: FileText },
  { href: "/settings", label: "Settings", icon: Settings },
];

/** Pinned to the bottom of the sidebar, below the page list. */
export const HELP_ITEM: NavItem = { href: "/help", label: "Help", icon: CircleHelp };

/** The Resolve queue badge (queue + tag conflicts, spec 7b): refetches on
 * navigation and whenever the Resolve page announces a mutation. One
 * definition for the sidebar and the mobile drawer. */
export function useResolveBadge(): number {
  const pathname = usePathname();
  const [count, setCount] = useState(0);
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
          setCount(data.queue.length + conflicts);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pathname, version]);

  return count;
}

/** True when `href` is the page being shown - ROI detail routes kept their
 * original /products paths (spec 10.3). */
export function isNavActive(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return (
    pathname.startsWith(href) || (href === "/roi" && pathname.startsWith("/products"))
  );
}
