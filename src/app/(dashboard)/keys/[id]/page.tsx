import { Suspense } from "react";
import KeyClient, { KeySkeleton } from "./key-client";

/** One key/seat (spec 10 page 2): tags, owner, product, models, last used. */
export default function KeyPage() {
  return (
    <Suspense fallback={<KeySkeleton />}>
      <KeyClient />
    </Suspense>
  );
}
