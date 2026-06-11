import { Suspense } from "react";
import ReportClient, { ReportSkeleton } from "./report-client";

/** Report (spec 10 page 6): one printable CFO page - spend by ROI and person,
 * unit costs, ROI where defined, month over month; CSV + FOCUS 1.4 export. */
export default function ReportPage() {
  return (
    <Suspense fallback={<ReportSkeleton />}>
      <ReportClient />
    </Suspense>
  );
}
