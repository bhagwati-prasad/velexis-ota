import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { MfaForm } from "@/app/(auth)/sign-in/mfa/mfa-form";
import { MFA_CHALLENGE_COOKIE, safeNextPath } from "@/lib/session";
import { MFA_STRINGS, SIGN_IN_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: "Two-factor authentication" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * `/sign-in/mfa` (README §2, PF-80): the TOTP or recovery code step that every admin sign-in goes through. Without a
 * challenge in `__Host-vxa_mfa` (never started, or its 5 minutes are over) there is nothing to complete, and the
 * admin goes back to `/sign-in?mfa=expired`, with the return path of the query when it is a safe relative path.
 */
export default async function MfaPage({ searchParams }: { searchParams: SearchParams }) {
  const [cookieStore, params] = await Promise.all([cookies(), searchParams]);
  const next = safeNextPath(typeof params.next === "string" ? params.next : undefined);
  if (!cookieStore.get(MFA_CHALLENGE_COOKIE)?.value) {
    const query = new URLSearchParams({ mfa: "expired" });
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
        <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
          {SIGN_IN_STRINGS.eyebrow}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">{MFA_STRINGS.title}</h1>
      </div>
      <MfaForm next={next} />
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
