import { Suspense } from "react";
import { ConnectorHealthList } from "@/components/connector-health";
import { Skeleton } from "@/components/ui/skeleton";
import { allConnectorHealth } from "@/lib/connectors";
import { getPool } from "@/lib/db";
import { getAllSettings, secretSettingsPresence } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Settings shell (spec 10 page 7). Connector health + the current config,
 * read-only for now: editing (connect screens, thresholds, alert channels,
 * ingest keys) lands with the Settings build. Until then, values change via
 * PATCH /api/settings and connectors via POST /api/connectors/:vendor/connect.
 */
export default async function SettingsPage() {
  const db = getPool();
  const [connectors, settings, secrets] = await Promise.all([
    allConnectorHealth(db),
    getAllSettings(db),
    secretSettingsPresence(db),
  ]);

  const entries: { label: string; value: string }[] = [
    { label: "Display currency", value: settings.display_currency },
    {
      label: "Limit alert thresholds",
      value: settings.limit_alert_thresholds_pct.map((p) => `${p}%`).join(", "),
    },
    {
      label: "Anomaly trigger",
      value: `${settings.anomaly_burn_multiplier}x trailing avg, min $${(settings.anomaly_min_day_cents / 100).toFixed(2)}/day`,
    },
    { label: "Revert window", value: `${settings.revert_window_days} days` },
    {
      label: "Raw fact retention",
      value: `${settings.raw_facts_retention_months} months`,
    },
    {
      label: "Connector silent alert",
      value: `${settings.connector_silent_alert_hours}h`,
    },
    {
      label: "Slack webhook",
      value: secrets.slack_webhook_url ? "set" : "not set",
    },
    {
      label: "Update check",
      value: settings.update_check_enabled ? "on" : "off",
    },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Settings</h1>
      <section className="rounded-lg border bg-card p-4">
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Connectors</h2>
        <Suspense fallback={<Skeleton className="h-40" />}>
          <ConnectorHealthList connectors={connectors} />
        </Suspense>
      </section>
      <section className="rounded-lg border bg-card p-4">
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">Config</h2>
        <dl className="divide-y">
          {entries.map((entry) => (
            <div key={entry.label} className="flex items-center justify-between py-2.5">
              <dt className="text-sm text-muted-foreground">{entry.label}</dt>
              <dd className="text-sm">{entry.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-sm text-muted-foreground">
          Read-only for now - edit via PATCH /api/settings; connect vendors via
          POST /api/connectors/:vendor/connect.
        </p>
      </section>
    </div>
  );
}
