import { Suspense } from "react";
import { Users } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { getPool } from "@/lib/db";
import { PeopleTable, type PersonRow } from "./people-table";

export const dynamic = "force-dynamic";

/** Roster shell (spec 10 page 2 lands in its own build; this lists the
 * roster and drills each person's spend). */
export default async function PeoplePage() {
  const { rows } = await getPool().query(
    `SELECT id, email, name, status, source,
            monthly_limit_usd_cents::bigint AS "limitUsdCents"
     FROM people WHERE merged_into IS NULL
     ORDER BY lower(email)`,
  );
  const people: PersonRow[] = rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    source: row.source,
    limitUsdCents: row.limitUsdCents === null ? null : Number(row.limitUsdCents),
  }));

  if (people.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No people yet"
        body="Connect a vendor or import your roster - identities auto-map by email, and whatever can't be matched lands in Resolve."
        actionHref="/settings"
        actionLabel="Open Settings"
      />
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">People</h1>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <PeopleTable people={people} />
      </Suspense>
    </div>
  );
}
