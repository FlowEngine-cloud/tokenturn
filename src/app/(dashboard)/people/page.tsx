import { Suspense } from "react";
import PeopleClient, { PeopleSkeleton } from "./people-client";

/** People (spec 10 page 2): per person spend by vendor, outcomes,
 * $/outcome, trend - every row drills into the person. */
export default function PeoplePage() {
  return (
    <Suspense fallback={<PeopleSkeleton />}>
      <PeopleClient />
    </Suspense>
  );
}
