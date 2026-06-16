import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser, isClaimed, SESSION_COOKIE } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { DEMO_LOGIN_NAME, DEMO_LOGIN_PASSWORD, isDemoMode } from "@/lib/demo";
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
  const demo = isDemoMode();
  return (
    <LoginClient
      claimed={await isClaimed(db)}
      demo={demo}
      demoCredentials={
        demo
          ? {
              name: DEMO_LOGIN_NAME,
              password: DEMO_LOGIN_PASSWORD,
            }
          : undefined
      }
    />
  );
}
