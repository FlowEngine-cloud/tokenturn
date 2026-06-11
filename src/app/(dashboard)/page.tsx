import { Suspense } from "react";
import OverviewClient, { OverviewSkeleton } from "./overview-client";

export default function OverviewPage() {
  return (
    <Suspense fallback={<OverviewSkeleton />}>
      <OverviewClient />
    </Suspense>
  );
}
