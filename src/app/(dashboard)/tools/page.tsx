import { Suspense } from "react";
import ToolsClient, { ToolsSkeleton } from "./tools-client";

/** Tools (spec 10 page 4): cost per merged PR per tool per person, accept
 * rates, revert rates - side by side. */
export default function ToolsPage() {
  return (
    <Suspense fallback={<ToolsSkeleton />}>
      <ToolsClient />
    </Suspense>
  );
}
