import { getOktaConfig, hookAuthorized, parseLeaverEvents, sweepLeaver } from "@ee/lib/okta";
import { isArr } from "@/lib/connectors/strict";
import { getPool } from "@/lib/db";
import { requireEeFeature } from "@/lib/license";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * The Okta event hook endpoint (spec 11: the leaver event fires the sweep).
 * Authenticated by the hook secret minted at connect time, which the admin
 * pastes into Okta's Authorization-header field when registering the hook -
 * never by session. License-gated like every `okta_sync` surface.
 *
 * GET is Okta's one-time verification handshake; POST carries lifecycle
 * events. Only deactivate/suspend targets are acted on; everything else is
 * acknowledged and ignored. Always 200 on authorized delivery - per-user
 * results land in the audit log, and the hourly System Log poll is the
 * backstop for anything that fails here.
 */

async function authorize(req: Request): Promise<Response | null> {
  const db = getPool();
  const locked = await requireEeFeature("okta_sync", db);
  if (locked) return locked;
  const config = await getOktaConfig({ db });
  if (config === null) {
    return Response.json({ error: "Okta is not connected" }, { status: 404 });
  }
  if (!hookAuthorized(config, req.headers.get("authorization"))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

/** Okta's endpoint verification: echo the challenge header back. */
export async function GET(req: Request) {
  const denied = await authorize(req);
  if (denied) return denied;
  const challenge = req.headers.get("x-okta-verification-challenge");
  if (!challenge) {
    return Response.json({ error: "missing x-okta-verification-challenge header" }, { status: 400 });
  }
  return Response.json({ verification: challenge });
}

export async function POST(req: Request) {
  const denied = await authorize(req);
  if (denied) return denied;

  let events: unknown = null;
  try {
    const body = (await req.json()) as { data?: { events?: unknown } };
    events = body?.data?.events ?? null;
  } catch {
    return Response.json({ error: "body is not valid JSON" }, { status: 400 });
  }
  if (!isArr(events)) {
    return Response.json({ error: "body has no data.events array" }, { status: 400 });
  }

  const db = getPool();
  const leavers = parseLeaverEvents(events as unknown[]);
  const results = [];
  for (const event of leavers) {
    results.push(await sweepLeaver(event, { db }));
  }
  logger.info("okta event hook processed", {
    events: (events as unknown[]).length,
    leavers: leavers.length,
  });
  return Response.json({ ok: true, swept: results });
}
