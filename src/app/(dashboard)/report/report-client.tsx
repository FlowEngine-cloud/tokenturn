"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Download, FileText, Printer } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { APP_NAME } from "@/lib/brand";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents, formatCount, unitCostLabel } from "@/lib/format";
import { addMonths, currentMonth } from "@/lib/range";
import type { ReportData, ReportRow } from "@/lib/report";
import { useFetch } from "@/lib/use-fetch";
import { cn } from "@/lib/utils";

/**
 * Report (spec 10 page 6): one printable CFO page per month - spend by ROI
 * and by person, unit costs, ROI where defined, month over month - with CSV
 * and FOCUS 1.4 export. On screen every number drills to its raw rows; on
 * paper the chrome disappears (print:hidden) and the sheet stands alone.
 */

export function ReportSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-24" />
      <Skeleton className="h-96" />
    </div>
  );
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** "2026-06" -> "June 2026" (UTC). */
function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function momLabel(pct: number | null): React.ReactNode {
  if (pct === null) return <span className="text-muted-foreground">–</span>;
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

const CELL = "whitespace-nowrap border-b px-3 py-2";
const NUM = `${CELL} text-right tabular-nums`;

export default function ReportClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const raw = searchParams.get("month");
  const thisMonth = currentMonth();
  const month = raw && MONTH_RE.test(raw) && raw <= thisMonth ? raw : thisMonth;
  const { data, error } = useFetch<ReportData>(`/api/report?month=${month}`);

  const goTo = (m: string) => router.push(`${pathname}?month=${m}`);

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 p-4 text-destructive">
        {error}
      </div>
    );
  }
  if (!data) return <ReportSkeleton />;

  const ccy = data.displayCurrency;
  const money = (cents: number) => formatCents(cents, ccy);
  const drill = (row: ReportRow) =>
    `/drill?product=${row.productId ?? "none"}&from=${data.from}&to=${data.to}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <h1 data-tour="report-header" className="text-lg font-semibold">Report</h1>
        <span className="flex-1" />
        <div className="flex items-center rounded-md border">
          <Button variant="ghost" size="sm" onClick={() => goTo(addMonths(month, -1))}>
            <ChevronLeft />
          </Button>
          <span className="px-1 text-sm tabular-nums">{monthLabel(month)}</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={month >= thisMonth}
            onClick={() => goTo(addMonths(month, 1))}
          >
            <ChevronRight />
          </Button>
        </div>
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          <Printer />
          Print
        </Button>
        <a
          href={`/api/report/csv?month=${month}`}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          <Download />
          CSV
        </a>
        <a
          href={`/api/report/focus?month=${month}`}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          <Download />
          FOCUS 1.4
        </a>
      </div>

      {data.rows.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={`No spend in ${monthLabel(month)}`}
          body="Connect a vendor or record a manual cost - the report builds itself from the ledger."
          actionHref="/settings"
          actionLabel="Open Settings"
        />
      ) : (
        <div className="space-y-6 rounded-lg border bg-card p-6 print:border-0 print:p-0">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
            <div>
              <h2 className="text-xl font-semibold">AI spend · {monthLabel(month)}</h2>
              <p className="text-sm text-muted-foreground">
                {APP_NAME} · {data.from} → {data.to} · all amounts in {ccy}
              </p>
            </div>
            <div className="text-right">
              <Link
                href={`/drill?from=${data.from}&to=${data.to}`}
                className="block text-3xl font-semibold tabular-nums hover:underline"
              >
                {money(data.totals.spendCents)}
              </Link>
              <p className="text-sm text-muted-foreground">
                {monthLabel(data.prevMonth)} {money(data.totals.prevSpendCents)}
                {" · "}
                {momLabel(data.totals.momPct)}
              </p>
            </div>
          </div>

          {/* Phones scroll the sheet's tables in place; print keeps the flow. */}
          <div className="overflow-x-auto print:overflow-visible">
          <table className="w-full text-sm">
            <thead>
              <tr>
                {["ROI", "Spend", "Last month", "MoM", "Successes", "Unit cost", "ROI ×"].map(
                  (header, i) => (
                    <th
                      key={header}
                      className={cn(
                        "border-b-2 px-3 py-2 font-medium text-muted-foreground",
                        i === 0 ? "text-left" : "text-right",
                      )}
                    >
                      {header}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.productId ?? "none"}>
                  <td className={CELL}>
                    {row.productId === null ? (
                      <span className="text-muted-foreground">{row.name}</span>
                    ) : (
                      <Link
                        href={`/products/${row.productId}?from=${data.from}&to=${data.to}`}
                        className="hover:underline"
                      >
                        {row.name}
                      </Link>
                    )}
                    {row.archived && (
                      <span className="text-muted-foreground"> · archived</span>
                    )}
                  </td>
                  <td className={NUM}>
                    <Link href={drill(row)} className="hover:underline">
                      {money(row.spendCents)}
                    </Link>
                  </td>
                  <td className={NUM}>{money(row.prevSpendCents)}</td>
                  <td className={NUM}>{momLabel(row.momPct)}</td>
                  <td className={NUM}>
                    {row.unit === null ? (
                      row.activeUsers > 0 ? (
                        <span className="text-muted-foreground">
                          {formatCount(row.activeUsers)} users
                        </span>
                      ) : (
                        "–"
                      )
                    ) : row.productId === null ? (
                      formatCount(row.outcomeCount)
                    ) : (
                      <Link
                        href={`/drill?view=outcomes&product=${row.productId}&from=${data.from}&to=${data.to}`}
                        className="hover:underline"
                      >
                        {formatCount(row.outcomeCount)}
                      </Link>
                    )}
                  </td>
                  <td className={NUM}>{unitCostLabel(row, ccy)}</td>
                  <td className={NUM}>
                    {row.roi === null ? (
                      "–"
                    ) : (
                      <span className="text-green-700 print:text-foreground">{row.roi}x</span>
                    )}
                  </td>
                </tr>
              ))}
              <tr className="font-medium">
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {money(data.totals.spendCents)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {money(data.totals.prevSpendCents)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {momLabel(data.totals.momPct)}
                </td>
                <td colSpan={3} />
              </tr>
            </tbody>
          </table>
          </div>

          {data.people.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-medium text-muted-foreground">By person</h3>
              <div className="overflow-x-auto print:overflow-visible">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    {["Person", "Spend", "Last month", "MoM"].map((header, i) => (
                      <th
                        key={header}
                        className={cn(
                          "border-b-2 px-3 py-2 font-medium text-muted-foreground",
                          i === 0 ? "text-left" : "text-right",
                        )}
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.people.map((p) => (
                    <tr key={p.personId ?? "unassigned"}>
                      <td className={CELL}>
                        {p.personId === null ? (
                          <span className="text-muted-foreground">{p.name}</span>
                        ) : (
                          <Link
                            href={`/people/${p.personId}?from=${data.from}&to=${data.to}`}
                            className="hover:underline"
                          >
                            {p.name}
                          </Link>
                        )}
                      </td>
                      <td className={NUM}>{money(p.spendCents)}</td>
                      <td className={NUM}>{money(p.prevSpendCents)}</td>
                      <td className={NUM}>{momLabel(p.momPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-2 text-sm font-medium text-muted-foreground">
              Month over month
            </h3>
            <table className="w-full max-w-md text-sm">
              <tbody>
                {data.months.map((m) => {
                  const max = Math.max(...data.months.map((x) => x.spendCents), 1);
                  return (
                    <tr key={m.month}>
                      <td className="whitespace-nowrap py-1 pr-3 text-muted-foreground">
                        {monthLabel(m.month)}
                      </td>
                      <td className="w-full py-1">
                        <div
                          className="h-3 rounded-sm bg-foreground/70 print:bg-foreground"
                          style={{ width: `${Math.round((m.spendCents / max) * 100)}%` }}
                        />
                      </td>
                      <td className="whitespace-nowrap py-1 pl-3 text-right tabular-nums">
                        <Link
                          href={`/drill?from=${m.from}&to=${m.to}`}
                          className="hover:underline"
                        >
                          {money(m.spendCents)}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </div>
  );
}
