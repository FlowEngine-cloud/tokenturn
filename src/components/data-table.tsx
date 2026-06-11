"use client";

import { useRouter } from "next/navigation";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Sticky-header table with CSV export (spec 10) - the one table every page
 * uses. The CSV is built from the same rows on screen: what you see is what
 * you export.
 */

export interface Column<T> {
  key: string;
  header: string;
  align?: "left" | "right";
  render: (row: T) => React.ReactNode;
  /** The raw value for the CSV cell. */
  csv: (row: T) => string | number | null;
}

function csvEscape(value: string | number | null): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv<T>(columns: Column<T>[], rows: T[]): string {
  const lines = [columns.map((c) => csvEscape(c.header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(c.csv(row))).join(","));
  }
  return lines.join("\n");
}

function downloadCsv<T>(name: string, columns: Column<T>[], rows: T[]): void {
  const blob = new Blob([toCsv(columns, rows)], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  csvName,
  rowHref,
  note,
  maxHeightClass = "max-h-[70vh]",
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  csvName: string;
  /** When set, clicking a row drills into it. */
  rowHref?: (row: T) => string | null;
  /** Small line under the header, e.g. "first 500 of 1,204 rows". */
  note?: string;
  maxHeightClass?: string;
}) {
  const router = useRouter();
  return (
    <div className="rounded-lg border">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm text-muted-foreground">
          {rows.length.toLocaleString("en-US")} rows
          {note ? ` · ${note}` : ""}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => downloadCsv(csvName, columns, rows)}
          disabled={rows.length === 0}
        >
          <Download />
          CSV
        </Button>
      </div>
      <div className={cn("overflow-auto", maxHeightClass)}>
        <table className="w-full text-sm">
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    "sticky top-0 z-10 whitespace-nowrap border-b bg-card px-3 py-2 text-left font-medium text-muted-foreground",
                    col.align === "right" && "text-right",
                  )}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const href = rowHref?.(row) ?? null;
              return (
                <tr
                  key={rowKey(row)}
                  className={cn(
                    "border-b last:border-b-0",
                    href && "cursor-pointer hover:bg-accent/50",
                  )}
                  onClick={href ? () => router.push(href) : undefined}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn(
                        "whitespace-nowrap px-3 py-2",
                        col.align === "right" && "text-right tabular-nums",
                      )}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-8 text-center text-muted-foreground"
                >
                  No rows.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
