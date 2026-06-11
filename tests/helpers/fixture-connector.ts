import type {
  Connector,
  ConnectorContext,
  ConnectorPage,
  FactInput,
  IdentityInput,
  OutcomeInput,
  ScopeCheck,
  SyncWindow,
} from "../../src/lib/connectors/types";

/**
 * "Acme AI" - the fake vendor that proves the connector contract. It does
 * everything a real vendor connector does: HTTP through ctx.fetch (so the
 * recorded-fixture replay drives it), Bearer auth from config, scope
 * validation on connect, paged usage reports, and a STRICT parser that
 * throws on any format drift - which is exactly how recorded fixtures turn
 * a vendor format change into a CI failure instead of silent bad numbers.
 *
 * Mapping rules (mirroring spec 5/7b/8):
 * - user_email rows -> a "user" identity (auto-matched to people by email).
 * - key rows -> an "api_key" identity; the key name becomes its tag.
 * - key rows with no name -> a bare fact reference; the framework
 *   auto-discovers a stub identity (keys people create on their own).
 * - an optional "outcomes" array -> sdk_event outcomes credited to the
 *   user's identity, so resolve tests can drive outcome re-attribution
 *   through the same recorded-sync path as facts.
 */

export const ACME_BASE = "https://api.acme.test";
export const ACME_HISTORY_LIMIT_DAYS = 31;
export const ACME_REQUIRED_SCOPE = "usage:read";

interface AcmeUsageRecord {
  id: string;
  day: string;
  user_email: string | null;
  key_id: string | null;
  key_name: string | null;
  model: string;
  tokens: number;
  amount_cents: number;
  currency: string;
}

const RECORD_FIELDS: Record<keyof AcmeUsageRecord, (v: unknown) => boolean> = {
  id: (v) => typeof v === "string" && v.length > 0,
  day: (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v),
  user_email: (v) => v === null || typeof v === "string",
  key_id: (v) => v === null || typeof v === "string",
  key_name: (v) => v === null || typeof v === "string",
  model: (v) => typeof v === "string",
  tokens: (v) => typeof v === "number" && Number.isInteger(v),
  amount_cents: (v) => typeof v === "number" && Number.isInteger(v),
  currency: (v) => typeof v === "string" && /^[A-Z]{3}$/.test(v),
};

/** Strict parse of one usage record. Any drift in the vendor format throws. */
function parseRecord(raw: unknown): AcmeUsageRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`acme usage record is not an object: ${JSON.stringify(raw)}`);
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "<no id>";
  for (const key of Object.keys(record)) {
    if (!(key in RECORD_FIELDS)) {
      throw new Error(`acme usage record ${id}: unexpected field "${key}"`);
    }
  }
  for (const [key, ok] of Object.entries(RECORD_FIELDS)) {
    if (!ok(record[key])) {
      throw new Error(`acme usage record ${id}: missing or invalid "${key}"`);
    }
  }
  return record as unknown as AcmeUsageRecord;
}

async function acmeJson(
  ctx: ConnectorContext,
  url: string,
): Promise<Record<string, unknown>> {
  const res = await ctx.fetch(url, {
    headers: { authorization: `Bearer ${ctx.config.apiKey ?? ""}` },
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    // The vendor's error, verbatim (spec 5).
    throw new Error(
      typeof body.error === "string" ? body.error : `acme returned HTTP ${res.status}`,
    );
  }
  return body;
}

function toPage(body: Record<string, unknown>): ConnectorPage {
  if (!Array.isArray(body.records)) {
    throw new Error('acme usage response: missing or invalid "records"');
  }
  if (body.next_page !== null && typeof body.next_page !== "string") {
    throw new Error('acme usage response: missing or invalid "next_page"');
  }

  const identities = new Map<string, IdentityInput>();
  const facts: FactInput[] = [];
  for (const raw of body.records) {
    const record = parseRecord(raw);
    let identity: FactInput["identity"];
    if (record.user_email !== null) {
      identity = { externalId: record.user_email, kind: "user" };
      identities.set(`user:${record.user_email}`, {
        externalId: record.user_email,
        kind: "user",
        email: record.user_email,
      });
    } else if (record.key_id !== null) {
      identity = { externalId: record.key_id, kind: "api_key" };
      if (record.key_name !== null) {
        // Key names become tags (spec 7b). Nameless keys are left for the
        // framework to auto-discover as stubs.
        identities.set(`api_key:${record.key_id}`, {
          externalId: record.key_id,
          kind: "api_key",
          displayName: record.key_name,
          tags: [record.key_name],
        });
      }
    }
    facts.push({
      day: record.day,
      identity,
      model: record.model,
      tokens: record.tokens,
      amountCents: record.amount_cents,
      currency: record.currency,
      costBasis: "estimated",
      sourceRef: record.id,
    });
  }

  const outcomes: OutcomeInput[] = [];
  if (body.outcomes !== undefined) {
    if (!Array.isArray(body.outcomes)) {
      throw new Error('acme usage response: invalid "outcomes"');
    }
    for (const raw of body.outcomes) {
      const event = raw as Record<string, unknown>;
      if (
        !event ||
        typeof event.id !== "string" ||
        typeof event.ts !== "string" ||
        typeof event.user_email !== "string"
      ) {
        throw new Error(`acme outcome is malformed: ${JSON.stringify(raw)}`);
      }
      identities.set(`user:${event.user_email}`, {
        externalId: event.user_email,
        kind: "user",
        email: event.user_email,
      });
      outcomes.push({
        ts: event.ts,
        kind: "sdk_event",
        identity: { externalId: event.user_email, kind: "user" },
        sourceRef: event.id,
      });
    }
  }

  return {
    identities: [...identities.values()],
    facts,
    outcomes,
    nextPageToken: body.next_page as string | null,
  };
}

export function usageUrl(window: SyncWindow, pageToken: string | null): string {
  return (
    `${ACME_BASE}/v1/usage?since=${window.since}&until=${window.until}` +
    (pageToken ? `&page=${pageToken}` : "")
  );
}

/** Build the fake connector; vendor id is parameterized so each test scenario gets its own cursor history. */
export function makeAcmeConnector(vendor = "acme"): Connector {
  return {
    vendor,
    displayName: "Acme AI",
    historyLimitDays: ACME_HISTORY_LIMIT_DAYS,

    async validateScopes(ctx: ConnectorContext): Promise<ScopeCheck> {
      const body = await acmeJson(ctx, `${ACME_BASE}/v1/me`);
      if (!Array.isArray(body.scopes) || body.scopes.some((s) => typeof s !== "string")) {
        throw new Error('acme /v1/me response: missing or invalid "scopes"');
      }
      const scopes = body.scopes as string[];
      if (!scopes.includes(ACME_REQUIRED_SCOPE)) {
        throw new Error(
          `token is missing the ${ACME_REQUIRED_SCOPE} scope (has: ${scopes.join(", ") || "none"})`,
        );
      }
      return { scopes };
    },

    async fetchPage(
      ctx: ConnectorContext,
      window: SyncWindow,
      pageToken: string | null,
    ): Promise<ConnectorPage> {
      return toPage(await acmeJson(ctx, usageUrl(window, pageToken)));
    },
  };
}

/**
 * A no-HTTP contract-conforming connector for scheduler/route tests: serves
 * one programmatic page per sync and records every window it was asked for.
 */
export function makeStubConnector(
  vendor: string,
  options: { rejectScopes?: string } = {},
): Connector & { windows: SyncWindow[] } {
  const windows: SyncWindow[] = [];
  return {
    vendor,
    displayName: `Stub ${vendor}`,
    historyLimitDays: 31,
    windows,
    async validateScopes() {
      if (options.rejectScopes) throw new Error(options.rejectScopes);
      return { scopes: ["usage:read"] };
    },
    async fetchPage(_ctx, window) {
      windows.push(window);
      return {
        identities: [],
        facts: [
          {
            day: window.until,
            amountCents: 100,
            currency: "USD",
            costBasis: "estimated",
            sourceRef: `${vendor}:${window.since}:${window.until}:${windows.length}`,
          },
        ],
        nextPageToken: null,
      };
    },
  };
}
