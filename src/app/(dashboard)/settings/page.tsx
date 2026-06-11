import { Suspense } from "react";
import SettingsClient, { SettingsSkeleton } from "./settings-client";

/** Settings (spec 10.6): controls grouped in cards - Connectors, Alerts,
 * Money, Email, Ingest keys, Users, Defaults, License - a label and a
 * control per row. */
export default function SettingsPage() {
  return (
    <Suspense fallback={<SettingsSkeleton />}>
      <SettingsClient />
    </Suspense>
  );
}
