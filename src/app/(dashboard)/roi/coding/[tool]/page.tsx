import { Suspense } from "react";
import CodingToolClient, { CodingToolSkeleton } from "./coding-client";

/** One built-in coding-tool ROI row's detail (spec 10 page 3 click-through):
 * the per-person split with line survival and $ / 1k surviving lines, accept
 * and revert rates - every number linking to the raw rows behind it. */
export default function CodingToolPage() {
  return (
    <Suspense fallback={<CodingToolSkeleton />}>
      <CodingToolClient />
    </Suspense>
  );
}
