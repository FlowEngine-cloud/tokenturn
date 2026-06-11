import { badRequest, cleanUuid, readJson, requireAdmin } from "@/lib/api";
import { getPool } from "@/lib/db";
import { mintOpenAiKeyForPerson, ProjectChoiceError } from "@/lib/provision";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * Mint a vendor API key for a person (admin, spec 8 In). OpenAI only -
 * Anthropic has no key-creation API (the person mints in their Console and
 * the next sync auto-detects it). Body: { vendor: "openai", projectId? }.
 *
 * The response carries the key's plaintext value exactly once; it is never
 * stored and never logged. When the org has several OpenAI projects and
 * none was picked, answers 409 with the list to choose from.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const id = cleanUuid((await params).id);
  if (!id) return badRequest("invalid person id");
  const body = await readJson(req);
  if (body?.vendor !== "openai") {
    return badRequest(
      'vendor must be "openai" - Anthropic keys are minted in the person\'s Console and auto-detected on the next sync',
    );
  }
  let projectId: string | null = null;
  if (body.projectId !== undefined && body.projectId !== null) {
    if (typeof body.projectId !== "string" || body.projectId.trim() === "") {
      return badRequest("projectId must be a non-empty string when set");
    }
    projectId = body.projectId.trim();
  }

  try {
    const minted = await mintOpenAiKeyForPerson(id, projectId, { db });
    return Response.json({ minted });
  } catch (error) {
    if (error instanceof ProjectChoiceError) {
      return Response.json(
        { error: error.message, projects: error.projects },
        { status: error.status },
      );
    }
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    // The vendor's error, verbatim (bad admin key, scope, quota, ...).
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
