import { Suspense } from "react";
import SettingsClient, { SettingsSkeleton } from "./settings-client";

/** Settings (spec 10.6): a left section nav with icons, one section on
 * screen at a time - Connections, Alerts, Money, Email, Users, Defaults,
 * License. Connections lands first. A label and a control per row. */
export default function SettingsPage() {
  return (
    <Suspense fallback={<SettingsSkeleton />}>
      <SettingsClient />
    </Suspense>
  );
}
