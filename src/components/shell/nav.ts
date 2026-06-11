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
