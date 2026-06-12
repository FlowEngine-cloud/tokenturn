"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Dialog } from "radix-ui";
import { Menu, X } from "lucide-react";
import {
  HELP_ITEM,
  isNavActive,
  NAV_ITEMS,
  useResolveBadge,
} from "@/components/shell/nav";
import { APP_NAME } from "@/lib/brand";
import { rangeFromParams } from "@/lib/range";
import { cn } from "@/lib/utils";

/**
 * Cross-page nav (spec 10), phones: the sidebar is hidden below md, so the
 * top bar shows this hamburger instead - a left drawer with the same page
 * list and the same Resolve badge. Z ladder: sidebar 30, top bar 40, this
 * drawer 50, onboarding popup 60, cmd-K 90/100.
 */
export function MobileNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const resolveCount = useResolveBadge();
  const [open, setOpen] = useState(false);

  const range = rangeFromParams(searchParams);
  const rangeQuery = range ? `?from=${range.from}&to=${range.to}` : "";

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          aria-label="Menu"
          className="flex h-8 w-8 items-center justify-center rounded-md border text-muted-foreground hover:text-foreground md:hidden"
        >
          <Menu className="h-4 w-4" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/25 md:hidden" />
        <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r bg-sidebar md:hidden">
          <Dialog.Title className="sr-only">Navigation</Dialog.Title>
          <div className="flex h-14 items-center justify-between border-b px-5">
            <Link
              href={`/${rangeQuery}`}
              onClick={() => setOpen(false)}
              className="font-semibold tracking-tight"
            >
              {APP_NAME}
            </Link>
            <Dialog.Close asChild>
              <button
                aria-label="Close menu"
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>
          <nav className="flex-1 space-y-1 p-3">
            {NAV_ITEMS.map((item) => {
              const active = isNavActive(item.href, pathname);
              return (
                <Link
                  key={item.href}
                  href={`${item.href}${rangeQuery}`}
                  onClick={() => setOpen(false)}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm",
                    active
                      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                      : "text-muted-foreground",
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
              onClick={() => setOpen(false)}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm",
                pathname.startsWith(HELP_ITEM.href)
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-muted-foreground",
              )}
            >
              <HELP_ITEM.icon className="h-4 w-4" />
              {HELP_ITEM.label}
            </Link>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
