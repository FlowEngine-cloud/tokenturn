import { Suspense } from "react";
import PersonClient, { PersonSkeleton } from "./person-client";

/** One person (spec 10 page 2): daily breakdown, keys and seats, products. */
export default function PersonPage() {
  return (
    <Suspense fallback={<PersonSkeleton />}>
      <PersonClient />
    </Suspense>
  );
}
