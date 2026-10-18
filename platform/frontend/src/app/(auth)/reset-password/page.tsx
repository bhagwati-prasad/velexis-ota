import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";

import { ResetPasswordForm } from "@/app/(auth)/reset-password/reset-password-form";
import { PASSWORD_RESET_COOKIE } from "@/lib/session";
import { PASSWORD_RESET_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: "Choose a new password" };

/**
 * `/reset-password` (README §2 Auth and §6, PF-05 AC1). The link of the reset e-mail is `/reset-password?token=…`;
 * `middleware.ts` answers it before this page renders: the token goes into the httpOnly `__Host-vxp_reset` cookie
 * (`SameSite=Strict`, 15 minutes) and a refresh takes the browser to this page without the query, so the token does
 * not stay in the address bar or the history and never reaches a `Referer` or the rendered page. The page itself
 * never reads `?token=`.
 *
 * With the cookie it shows the new-password form; without it (never opened from the e-mail, or more than 15
 * minutes ago) it asks the person to open the link again or to request a new one.
 */
export default async function ResetPasswordPage() {
  const hasToken = Boolean((await cookies()).get(PASSWORD_RESET_COOKIE)?.value);
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-6 py-16 focus:outline-none"
    >
      {hasToken ? (
        <>
          <div className="grid gap-2">
            <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">Velexis</p>
            <h1 className="text-3xl font-semibold tracking-tight">{PASSWORD_RESET_STRINGS.resetTitle}</h1>
            <p className="text-muted-foreground">{PASSWORD_RESET_STRINGS.resetIntro}</p>
          </div>
          <ResetPasswordForm />
        </>
      ) : (
        <div className="grid gap-3">
          <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">Velexis</p>
          <h1 className="text-3xl font-semibold tracking-tight">{PASSWORD_RESET_STRINGS.linkMissingTitle}</h1>
          <p>{PASSWORD_RESET_STRINGS.linkMissing}</p>
          <p>
            <Link
              href="/forgot-password"
              prefetch={false}
              className="font-medium underline underline-offset-4"
            >
              {PASSWORD_RESET_STRINGS.requestNewLink}
            </Link>
          </p>
        </div>
      )}
      <p className="text-sm">
        <Link href="/sign-in" prefetch={false} className="font-medium underline underline-offset-4">
          {PASSWORD_RESET_STRINGS.backToSignIn}
        </Link>
      </p>
    </main>
  );
}
