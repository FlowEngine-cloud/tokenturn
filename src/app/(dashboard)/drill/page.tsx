import { Suspense } from "react";
import DrillClient, { DrillSkeleton } from "./drill-client";

export default function DrillPage() {
  return (
    <Suspense fallback={<DrillSkeleton />}>
      <DrillClient />
    </Suspense>
  );
}
