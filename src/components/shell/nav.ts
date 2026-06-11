import {
  FileText,
  GitMerge,
  LayoutDashboard,
  Package,
  Settings,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/** Fired by the Resolve page after a queue mutation so the sidebar badge
 * refetches without a navigation. */
export const RESOLVE_CHANGED_EVENT = "ai-pnl:resolve-changed";

/** The dashboard's pages (spec 10) - one definition for the sidebar and the
 * cmd-K "Pages" group. */
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/people", label: "People", icon: Users },
  { href: "/products", label: "Products", icon: Package },
  { href: "/tools", label: "Tools", icon: Wrench },
  { href: "/resolve", label: "Resolve", icon: GitMerge },
  { href: "/report", label: "Report", icon: FileText },
  { href: "/settings", label: "Settings", icon: Settings },
];
