import { badRequest, readJson, requireAdmin } from "@/lib/api";
import { audit } from "@/lib/audit";
import {
  buildContext,
  getConnectorConfig,
} from "@/lib/connectors/connect";
import {
  listIssueProjectRoutes,
  setIssueProjectRoute,
} from "@/lib/connectors/issues";
import { getConnector } from "@/lib/connectors";
import { getPool } from "@/lib/db";
import { logger } from "@/lib/logger";
import { recomputeRollups } from "@/lib/rollup";

export const dynamic = "force-dynamic";

/**
 * Project -> ROI mapping for a success integration (spec 7 routing layer 2:
 * one shared app creates everything, so the project says which ROI an
 * issue's success belongs to). GET lists the vendor's projects (live, with
 * the vendor's error verbatim on failure) merged with the stored mapping;
 * PUT maps one project (productId null clears it) and re-routes the
 * project's history retroactively - the ledger's standard rule.
 */

export async function GET(
  req: Request,
  { params }: { params: Promise<{ vendor: string }> },
) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const { vendor } = await params;
  const connector = getConnector(vendor);
  if (!connector?.listProjects) {
    return Response.json({ error: "no such connector" }, { status: 404 });
  }
  const config = await getConnectorConfig(vendor, { db });
  if (config === null) {
    return Response.json({ error: "not connected" }, { status: 409 });
  }

  let vendorProjects: { key: string; name: string }[];
  try {
    vendorProjects = await connector.listProjects(buildContext(connector, config));
  } catch (error) {
    // The vendor's error, verbatim (spec 5).
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 422 });
  }
  const routes = new Map(
    (await listIssueProjectRoutes(vendor, db)).map((r) => [r.project, r]),
  );
  // Mapped projects the vendor no longer lists stay visible - the mapping
  // still routes their history.
  const known = new Set(vendorProjects.map((p) => p.key));
  const projects = [
    ...vendorProjects,
    ...[...routes.values()]
      .filter((r) => !known.has(r.project))
      .map((r) => ({ key: r.project, name: r.project })),
  ].map((p) => ({
    key: p.key,
    name: p.name,
    productId: routes.get(p.key)?.productId ?? null,
    productName: routes.get(p.key)?.productName ?? null,
  }));
  return Response.json({ projects });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ vendor: string }> },
) {
  const pool = getPool();
  const admin = await requireAdmin(req, pool);
  if (admin instanceof Response) return admin;

  const { vendor } = await params;
  const connector = getConnector(vendor);
  if (!connector?.listProjects) {
    return Response.json({ error: "no such connector" }, { status: 404 });
  }
  const body = await readJson(req);
  const project = body?.project;
  const productId = body?.productId ?? null;
  if (typeof project !== "string" || project.length === 0) {
    return badRequest("project required");
  }
  if (productId !== null && typeof productId !== "string") {
    return badRequest("productId must be a product id or null");
  }

  const client = await pool.connect();
  let moved: { outcomes: number; from: string | null; to: string | null };
  try {
    await client.query("BEGIN");
    moved = await setIssueProjectRoute(client, vendor, project, productId);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: message },
      { status: message === "product not found" ? 404 : 500 },
    );
  } finally {
    client.release();
  }
  if (moved.from !== null && moved.to !== null) {
    await recomputeRollups({ from: moved.from, to: moved.to }, pool);
  }
  logger.info("issue project route set", { vendor, project, productId, ...moved });
  await audit(admin, "connector.projects", { vendor, project, productId }, pool);
  return Response.json({ ok: true, movedOutcomes: moved.outcomes });
}
