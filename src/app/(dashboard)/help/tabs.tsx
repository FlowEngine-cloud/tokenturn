"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** The help area's two views (spec 10): the guide and the API reference. */
const TABS = [
  { href: "/help", label: "How it works" },
  { href: "/help/sdk", label: "SDK" },
  { href: "/help/api", label: "API reference" },
];

export function HelpTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex max-w-5xl gap-4 border-b text-sm">
      {TABS.map((tab) => {
        const active = tab.href === "/help" ? pathname === "/help" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "-mb-px border-b-2 pb-2",
              active
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
