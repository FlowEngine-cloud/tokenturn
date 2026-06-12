import { Suspense } from "react";
import SettingsClient, { SettingsSkeleton } from "./settings-client";

/** Settings (spec 10.6): exactly four icon tabs, one on screen at a time -
 * Connections, Alerts, Data, License. Connections lands first and holds
 * everything that plugs in as one card grid. A label and a control per
 * row. */
export default function SettingsPage() {
  return (
    <Suspense fallback={<SettingsSkeleton />}>
      <SettingsClient />
    </Suspense>
  );
}
