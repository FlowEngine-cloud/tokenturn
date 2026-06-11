import { Suspense } from "react";
import { GitMerge } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { getPool } from "@/lib/db";
import { resolveQueue } from "@/lib/resolve";
import { ResolveTables, type QueueRow, type UnassignedRow } from "./resolve-tables";

export const dynamic = "force-dynamic";

/** The identity queue (spec 10 page 5). Listing + drill here; the
 * confirm / not-a-person / merge actions land with the Resolve UI build. */
export default async function ResolvePage() {
  const { queue, unassigned } = await resolveQueue(getPool());

  if (queue.length === 0 && unassigned.length === 0) {
    return (
      <EmptyState
        icon={GitMerge}
        title="Nothing to resolve"
        body="Identities auto-map by email across vendors. Whatever can't be matched waits here with suggested matches."
      />
    );
  }

  const queueRows: QueueRow[] = queue.map((entry) => ({
    id: entry.id,
    vendor: entry.vendor,
    externalId: entry.externalId,
    kind: entry.kind,
    email: entry.email,
    displayName: entry.displayName,
    tags: [...entry.tags, ...entry.manualTags],
    factCount: entry.factCount,
    suggestionCount: entry.suggestions.length,
  }));
  const unassignedRows: UnassignedRow[] = unassigned.map((u) => ({
    vendor: u.vendor,
    amountUsdCents: u.amountUsdCents,
    factCount: u.factCount,
  }));

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Resolve</h1>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <ResolveTables queue={queueRows} unassigned={unassignedRows} />
      </Suspense>
    </div>
  );
}
