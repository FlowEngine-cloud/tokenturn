"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { CornerDownLeft, Search } from "lucide-react";
import { HELP_ITEM, NAV_ITEMS } from "@/components/shell/nav";
import { rangeFromParams, withRange } from "@/lib/range";
import { cn } from "@/lib/utils";

/**
 * Cmd-K search to any person, ROI, or vendor (spec 10), plus the pages.
 * Entity hits land on the drill-down filtered to that entity over the
 * active date range: hrefs carry the URL's range when there is one;
 * otherwise they stay bare and the picker restores the remembered range
 * on landing. With `trigger={false}` only the ⌘K shortcut opens it - for
 * pages whose top bar is hidden.
 */

interface Item {
  key: string;
  group: "Pages" | "People" | "ROI" | "Vendors";
  label: string;
  sub?: string;
  href: string;
}

interface ApiResults {
  people: { id: string; name: string | null; email: string; status: string }[];
  products: { id: string; name: string; archived: boolean }[];
  vendors: { vendor: string; displayName: string; connected: boolean }[];
}

export function CommandMenu({ trigger = true }: { trigger?: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ApiResults | null>(null);
  const [active, setActive] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const range = rangeFromParams(searchParams);
  const carry = (href: string) => (range ? withRange(href, range) : href);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const q = query.trim();

  useEffect(() => {
    if (!open || q === "") return;
    const timer = setTimeout(() => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: ApiResults | null) => {
          if (data) setResults(data);
        })
        .catch(() => {});
    }, 150);
    return () => clearTimeout(timer);
  }, [q, open]);

  const items = useMemo<Item[]>(() => {
    const pages: Item[] = [...NAV_ITEMS, HELP_ITEM].filter((n) =>
      n.label.toLowerCase().includes(q.toLowerCase()),
    ).map((n) => ({
      key: `page:${n.href}`,
      group: "Pages",
      label: n.label,
      href: carry(n.href),
    }));
    if (q === "" || results === null) return pages;
    return [
      ...pages,
      ...results.people.map(
        (p): Item => ({
          key: `person:${p.id}`,
          group: "People",
          label: p.name ?? p.email,
          sub: p.name ? p.email : p.status !== "active" ? p.status : undefined,
          href: carry(`/people/${p.id}`),
        }),
      ),
      ...results.products.map(
        (p): Item => ({
          key: `product:${p.id}`,
          group: "ROI",
          label: p.name,
          sub: p.archived ? "archived" : undefined,
          href: carry(`/products/${p.id}`),
        }),
      ),
      ...results.vendors.map(
        (v): Item => ({
          key: `vendor:${v.vendor}`,
          group: "Vendors",
          label: v.displayName,
          sub: v.connected ? "connected" : undefined,
          href: carry(`/drill?vendor=${v.vendor}`),
        }),
      ),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, results, range?.from, range?.to]);

  const activeIndex = Math.min(active, Math.max(items.length - 1, 0));

  function select(item: Item) {
    setOpen(false);
    setQuery("");
    setResults(null);
    router.push(item.href);
  }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(activeIndex + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(activeIndex - 1, 0));
    } else if (e.key === "Enter" && items[activeIndex]) {
      e.preventDefault();
      select(items[activeIndex]);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      {trigger && (
        <Dialog.Trigger asChild>
          <button className="flex h-8 w-full max-w-xs items-center gap-2 rounded-md border px-3 text-sm text-muted-foreground hover:text-foreground">
            <Search className="h-4 w-4" />
            <span className="flex-1 text-left">Search</span>
            <kbd className="rounded border bg-muted px-1.5 font-mono text-xs">⌘K</kbd>
          </button>
        </Dialog.Trigger>
      )}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-[15%] z-[100] w-full max-w-lg -translate-x-1/2 overflow-hidden rounded-lg border bg-popover shadow-lg">
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onInputKey}
              placeholder="Person, ROI, vendor, page…"
              className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-80 overflow-y-auto p-1">
            {items.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No matches.
              </p>
            )}
            {items.map((item, index) => {
              const header =
                index === 0 || items[index - 1].group !== item.group
                  ? item.group
                  : null;
              return (
                <div key={item.key}>
                  {header && (
                    <p className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {header}
                    </p>
                  )}
                  <button
                    onClick={() => select(item)}
                    onMouseMove={() => setActive(index)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm",
                      index === activeIndex && "bg-accent text-accent-foreground",
                    )}
                  >
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.sub && (
                      <span className="truncate text-xs text-muted-foreground">
                        {item.sub}
                      </span>
                    )}
                    {index === activeIndex && (
                      <CornerDownLeft className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
