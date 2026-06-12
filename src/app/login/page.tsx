import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser, isClaimed, SESSION_COOKIE } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { isDemoMode } from "@/lib/demo";
import { LoginClient } from "./login-client";

export const dynamic = "force-dynamic";

/**
 * First boot: the first visitor claims the instance as its one admin with a
 * passkey (password fallback). After that: sign in. No email either way.
 */
export default async function LoginPage() {
  const db = getPool();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token && (await getSessionUser(token, db))) redirect("/");
  return <LoginClient claimed={await isClaimed(db)} demo={isDemoMode()} />;
}
