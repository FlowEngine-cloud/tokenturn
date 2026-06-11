import { Suspense } from "react";
import SettingsClient, { SettingsSkeleton } from "./settings-client";

/** Settings (spec 10 page 7): connectors, products, alert channels, display
 * currency, license - every numeric default in the plan editable here. */
export default function SettingsPage() {
  return (
    <Suspense fallback={<SettingsSkeleton />}>
      <SettingsClient />
    </Suspense>
  );
}
