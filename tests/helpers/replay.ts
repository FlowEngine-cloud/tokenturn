import { readFileSync } from "node:fs";

/**
 * Recorded-fixture replay (spec 5: recorded-fixture tests so vendor format
 * changes break CI). A recording file is the vendor's real traffic, frozen:
 * an ordered list of request/response pairs. replayFetch() serves them to
 * the connector under test through the injected ConnectorContext.fetch.
 *
 * Matching is strict - method + full URL. If the framework or connector
 * asks for anything not in the recording (a different backfill window, a
 * recomputed page, an extra call), the test fails loudly. That makes window
 * math and resume behavior structurally asserted by the fixtures
 * themselves: the only way through a recording is to request exactly what
 * was recorded.
 */

export interface Recording {
  request: { method: string; url: string };
  response: { status: number; body: unknown };
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
    const index = pending.findIndex(
      (r) => r.request.method.toUpperCase() === method && r.request.url === url,
    );
    if (index === -1) {
      throw new Error(
        `no recorded response for ${method} ${url}` +
          (pending.length > 0
            ? ` (next recorded: ${pending[0].request.method} ${pending[0].request.url})`
            : " (recording exhausted)"),
      );
    }
    const [recording] = pending.splice(index, 1);
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
