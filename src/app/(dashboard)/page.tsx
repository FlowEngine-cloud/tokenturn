import { Suspense } from "react";
import { OnboardingGate } from "./onboarding-client";
import OverviewClient, { OverviewSkeleton } from "./overview-client";

export default function OverviewPage() {
  return (
    <Suspense fallback={<OverviewSkeleton />}>
      <OnboardingGate>
        <OverviewClient />
      </OnboardingGate>
    </Suspense>
  );
}
