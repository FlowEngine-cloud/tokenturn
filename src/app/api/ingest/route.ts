import { badRequest, conflict, tooManyRequests, unauthorized } from "@/lib/api";
import { getPool } from "@/lib/db";
import {
  ingestEvents,
  ingestKeyByToken,
  INGEST_RATE_LIMIT_PER_MIN,
  MAX_INGEST_BODY_BYTES,
  MAX_INGEST_EVENTS,
} from "@/lib/ingest";
import { clientKey, rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * The SDK's ingest endpoint (spec 6 + 12): Bearer ingest key (minted in
 * Settings, scoped per product), rate-limited per key, body size capped.
 * Body: { events: [...] } - up to 500 events carrying client UUIDs; the
 * server upserts on the UUID so retries are safe. Responds 200 with a
 * per-event verdict (accepted / duplicate / rejected + the reason); only
 * transport-level problems get an error status.
 */
export async function POST(req: Request) {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_INGEST_BODY_BYTES) {
    return Response.json(
      { error: `body too large (max ${MAX_INGEST_BODY_BYTES} bytes)` },
      { status: 413 },
    );
  }

  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    if (!rateLimit(clientKey(req, "ingest_miss"), 60)) return tooManyRequests();
    return unauthorized("missing Bearer ingest key");
  }
  const db = getPool();
  const key = await ingestKeyByToken(token, db);
  if (!key) {
    if (!rateLimit(clientKey(req, "ingest_miss"), 60)) return tooManyRequests();
    return unauthorized("unknown or revoked ingest key");
  }
  if (!rateLimit(`ingest:${key.keyId}`, INGEST_RATE_LIMIT_PER_MIN)) {
    return tooManyRequests();
  }
  if (key.productArchived) {
    return conflict(`product "${key.productName}" is archived`);
  }

  const text = await req.text();
  if (text.length > MAX_INGEST_BODY_BYTES) {
    return Response.json(
      { error: `body too large (max ${MAX_INGEST_BODY_BYTES} bytes)` },
      { status: 413 },
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return badRequest("invalid JSON body");
  }
  const events =
    body && typeof body === "object" && Array.isArray((body as { events?: unknown }).events)
      ? ((body as { events: unknown[] }).events)
      : null;
  if (!events) return badRequest("body must be { events: [...] }");
  if (events.length > MAX_INGEST_EVENTS) {
    return badRequest(`too many events in one batch (max ${MAX_INGEST_EVENTS})`);
  }

  const { results } = await ingestEvents(key, events, { pool: db });
  return Response.json({ results });
}
