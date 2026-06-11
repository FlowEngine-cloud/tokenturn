import type { Connector } from "./types";

/**
 * Connector registry. Vendor connectors register here at module load
 * (src/lib/connectors/index.ts is the one place that does it); the
 * scheduler, routes, and health surface only ever see the registry.
 */

const connectors = new Map<string, Connector>();

export function registerConnector(connector: Connector): void {
  if (connectors.has(connector.vendor)) {
    throw new Error(`connector ${connector.vendor} is already registered`);
  }
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
