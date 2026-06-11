import { Suspense } from "react";
import RoiClient, { RoiSkeleton } from "./roi-client";

/** ROI (spec 10 page 3): every ROI calculation in one list - the built-in
 * coding-tool rows and the ones you add - each row a slice of spend ÷ a
 * definition of success. */
export default function RoiPage() {
  return (
    <Suspense fallback={<RoiSkeleton />}>
      <RoiClient />
    </Suspense>
  );
}
