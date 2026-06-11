import { Suspense } from "react";
import ResolveClient, { ResolveSkeleton } from "./resolve-client";

/** Resolve (spec 10 page 5): the identity queue - confirm a match in one
 * click, mark a key not-a-person, merge two emails into one human. */
export default function ResolvePage() {
  return (
    <Suspense fallback={<ResolveSkeleton />}>
      <ResolveClient />
    </Suspense>
  );
}
