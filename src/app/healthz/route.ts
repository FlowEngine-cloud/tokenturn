import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Liveness + readiness probe. Docker HEALTHCHECK hits this.
 * 200 when the app is up and the database answers; 503 otherwise.
 */
export async function GET() {
  try {
    await getPool().query("SELECT 1");
    return NextResponse.json({ status: "ok", db: "ok" });
  } catch (error) {
    logger.error("healthz db check failed", { error });
    return NextResponse.json(
      { status: "degraded", db: "unreachable" },
      { status: 503 },
    );
  }
}
