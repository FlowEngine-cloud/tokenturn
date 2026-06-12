"use client";

import { ChevronsUpDown, LogOut } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFetch } from "@/lib/use-fetch";

/**
 * Sidebar-bottom account menu (spec 10.6). One definition for the desktop
 * sidebar and the mobile drawer.
 */
export function SignedInRow() {
  const { data } = useFetch<{ user: { name: string } | null }>("/api/auth/state");
  if (!data?.user) return null;

  const initial = data.user.name.trim().charAt(0).toUpperCase() || "U";

  function signOut() {
    void fetch("/api/auth/logout", { method: "POST" })
      .catch(() => {})
      .then(() => {
        window.location.href = "/login";
      });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="mt-1 flex w-full items-center gap-2 rounded-md p-2 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring data-[state=open]:bg-sidebar-accent"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sm font-semibold text-sidebar-primary-foreground">
            {initial}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium" title={data.user.name}>
            {data.user.name}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[calc(var(--radix-dropdown-menu-trigger-width))] min-w-52"
      >
        <DropdownMenuLabel className="font-normal">
          <div className="flex items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
              {initial}
            </span>
            <span className="min-w-0 truncate font-medium">{data.user.name}</span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={signOut}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
