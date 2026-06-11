import { readFileSync } from "node:fs";

/**
 * Recorded-fixture replay (spec 5: recorded-fixture tests so vendor format
 * changes break CI). A recording file is the vendor's real traffic, frozen:
 * an ordered list of request/response pairs. replayFetch() serves them to
 * the connector under test through the injected ConnectorContext.fetch.
 *
 * Matching is strict - method + full URL, plus the JSON request body when
 * the recording pins one (POST report APIs like Cursor's carry the window
 * and page in the body, not the URL). If the framework or connector asks
 * for anything not in the recording (a different backfill window, a
 * recomputed page, an extra call), the test fails loudly. That makes window
 * math and resume behavior structurally asserted by the fixtures
 * themselves: the only way through a recording is to request exactly what
 * was recorded.
 */

export interface Recording {
  request: { method: string; url: string; body?: unknown };
  /** JSON responses record `body`; raw text (NDJSON reports) records `text`. */
  response: { status: number; body?: unknown; text?: string };
}

/** Key-order-independent JSON for body comparison. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function bodyMatches(recorded: unknown, actual: string | undefined): boolean {
  if (recorded === undefined) return true; // recording does not pin a body
  if (actual === undefined) return false;
  try {
    return canonical(JSON.parse(actual)) === canonical(recorded);
  } catch {
    return false;
  }
}

export function loadRecordings(file: string): Recording[] {
  return JSON.parse(readFileSync(file, "utf8")) as Recording[];
}

export interface ReplaySession {
  fetch: typeof fetch;
  /** Recordings not yet served - assert .length === 0 for full coverage. */
  remaining(): Recording[];
}

export function replay(recordings: Recording[]): ReplaySession {
  const pending = [...recordings];
  const replayFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    const index = pending.findIndex(
      (r) =>
        r.request.method.toUpperCase() === method &&
        r.request.url === url &&
        bodyMatches(r.request.body, body),
    );
    if (index === -1) {
      throw new Error(
        `no recorded response for ${method} ${url}` +
          (body !== undefined ? ` body ${body}` : "") +
          (pending.length > 0
            ? ` (next recorded: ${pending[0].request.method} ${pending[0].request.url})`
            : " (recording exhausted)"),
      );
    }
    const [recording] = pending.splice(index, 1);
    if (recording.response.text !== undefined) {
      return new Response(recording.response.text, {
        status: recording.response.status,
        headers: { "content-type": "application/x-ndjson" },
      });
    }
    return new Response(JSON.stringify(recording.response.body), {
      status: recording.response.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: replayFetch, remaining: () => pending };
}

export function replayFile(file: string): ReplaySession {
  return replay(loadRecordings(file));
}
