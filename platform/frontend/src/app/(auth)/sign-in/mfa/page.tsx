import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { MfaForm } from "@/app/(auth)/sign-in/mfa/mfa-form";
import { MFA_CHALLENGE_COOKIE, NEXT_PATH_COOKIE, safeNextPath } from "@/lib/session";
import { MFA_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: "Two-factor authentication" };

/**
 * `/sign-in/mfa` (README §2 Auth, PF-04 AC2): the second step of a sign-in with MFA. Without a challenge in
 * `__Host-vxp_mfa` (never started, or its 5 minutes are over) there is nothing to complete, and the visitor goes back
 * to `/sign-in?mfa=expired`, with the return path the sign-in stored.
 */
export default async function MfaPage() {
  const cookieStore = await cookies();
  if (!cookieStore.get(MFA_CHALLENGE_COOKIE)?.value) {
    const query = new URLSearchParams({ mfa: "expired" });
    const next = safeNextPath(cookieStore.get(NEXT_PATH_COOKIE)?.value);
    if (next !== undefined) {
      query.set("next", next);
    }
    redirect(`/sign-in?${query.toString()}`);
  }
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-6 py-16 focus:outline-none"
    >
      <div className="grid gap-2">
        <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">Velexis</p>
        <h1 className="text-3xl font-semibold tracking-tight">{MFA_STRINGS.title}</h1>
      </div>
      <MfaForm />
      <div className="grid gap-2 text-sm text-muted-foreground">
        <p>{MFA_STRINGS.lostDevice}</p>
        <p>
          <Link
            href="/sign-in"
            prefetch={false}
            className="font-medium text-foreground underline underline-offset-4"
          >
            {MFA_STRINGS.backToSignIn}
          </Link>
        </p>
      </div>
    </main>
  );
}
