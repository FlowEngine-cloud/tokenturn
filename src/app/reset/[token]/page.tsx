import { ResetClient } from "./reset-client";

export const dynamic = "force-dynamic";

/**
 * One-time admin reset link, minted by the reset-admin CLI (spec 12b).
 * Consuming the token revokes the admin's old sessions and signs this
 * browser in so new credentials can be set.
 */
export default async function ResetPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <ResetClient token={token} />;
}
