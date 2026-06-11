import { badRequest, readJson, requireAdmin } from "@/lib/api";
import { APP_NAME } from "@/lib/brand";
import { getPool } from "@/lib/db";
import { isEmailAddress, sendEmail } from "@/lib/email";
import { ResolveError } from "@/lib/resolve";

export const dynamic = "force-dynamic";

/**
 * Test-send (admin, spec 12b): one plain-text email through the configured
 * provider to prove the key and from-address work. Body: { to: email }.
 * A provider rejection comes back verbatim.
 */
export async function POST(req: Request) {
  const db = getPool();
  const admin = await requireAdmin(req, db);
  if (admin instanceof Response) return admin;

  const body = await readJson(req);
  if (!isEmailAddress(body?.to)) return badRequest("pass to (an email address)");

  try {
    const { provider } = await sendEmail(
      {
        to: body!.to as string,
        subject: `${APP_NAME} test email`,
        text: `Your ${APP_NAME} email provider works. This is a test send from Settings.`,
      },
      { db },
    );
    return Response.json({ ok: true, provider });
  } catch (error) {
    if (error instanceof ResolveError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    // The provider's error, verbatim.
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
