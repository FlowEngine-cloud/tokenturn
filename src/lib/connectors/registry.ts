import type { Connector } from "./types";

/**
 * Connector registry. Vendor connectors register here at module load
 * (src/lib/connectors/index.ts is the one place that does it); the
 * scheduler, routes, and health surface only ever see the registry.
 */

const connectors = new Map<string, Connector>();

export function registerConnector(connector: Connector): void {
  // Last write wins: in dev, hot reload re-evaluates index.ts against the
  // surviving registry instance, so the same vendors register again.
  connectors.set(connector.vendor, connector);
}

export function getConnector(vendor: string): Connector | null {
  return connectors.get(vendor) ?? null;
}

export function listConnectors(): Connector[] {
  return [...connectors.values()];
}

/** Test-only: drop all registrations between test files. */
export function clearConnectors(): void {
  connectors.clear();
}
