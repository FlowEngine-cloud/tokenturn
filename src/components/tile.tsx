"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

/** Dashboard tile - the header link goes to the rows behind the tile. */
export function Tile({
  title,
  href,
  children,
  className,
}: {
  title: string;
  href?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-lg border bg-card p-4", className)}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
        {href && (
          <Link href={href} className="text-sm text-muted-foreground hover:text-foreground">
            Rows →
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

/** One labeled number that links to its drill-down. */
export function RowLink({
  href,
  label,
  sub,
  value,
}: {
  href: string;
  label: string;
  sub?: string;
  value: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 rounded px-1 py-1.5 hover:bg-accent/50"
    >
      <span className="truncate">{label}</span>
      <span className="flex shrink-0 items-baseline gap-2">
        {sub && <span className="text-sm text-muted-foreground">{sub}</span>}
        <span className="tabular-nums">{value}</span>
      </span>
    </Link>
  );
}
