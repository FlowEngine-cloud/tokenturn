"use client";

import { useSearchParams } from "next/navigation";
import { DataTable, type Column } from "@/components/data-table";
import { formatCents } from "@/lib/format";
import { parseRange, withRange } from "@/lib/range";

export interface PersonRow {
  id: string;
  email: string;
  name: string | null;
  status: string;
  source: string;
  limitUsdCents: number | null;
}

/** Roster listing - each row drills to that person's spend facts over the
 * active range. The full per-person page is its own build (spec 10 page 2). */
export function PeopleTable({ people }: { people: PersonRow[] }) {
  const searchParams = useSearchParams();
  const range = parseRange(searchParams);

  const columns: Column<PersonRow>[] = [
    { key: "name", header: "Name", render: (r) => r.name ?? "–", csv: (r) => r.name },
    { key: "email", header: "Email", render: (r) => r.email, csv: (r) => r.email },
    { key: "status", header: "Status", render: (r) => r.status, csv: (r) => r.status },
    { key: "source", header: "Source", render: (r) => r.source, csv: (r) => r.source },
    {
      key: "limit",
      header: "Monthly limit",
      align: "right",
      render: (r) =>
        r.limitUsdCents === null ? "–" : formatCents(r.limitUsdCents, "USD"),
      csv: (r) => (r.limitUsdCents === null ? null : (r.limitUsdCents / 100).toFixed(2)),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={people}
      rowKey={(r) => r.id}
      csvName="ai-pnl-people.csv"
      rowHref={(r) => withRange(`/drill?person=${r.id}`, range)}
    />
  );
}
