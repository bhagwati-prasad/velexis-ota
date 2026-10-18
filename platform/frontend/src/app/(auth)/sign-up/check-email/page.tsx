import type { Metadata } from "next";
import Link from "next/link";

import { ResendVerificationForm } from "@/app/(auth)/sign-up/sign-up-form";
import { VERIFICATION_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: "Check your e-mail" };

/**
 * `/sign-up/check-email` (README §2 Auth, PF-02): where a sign-up continues. It reads the same for a new and an
 * already registered address (PADR-0008 item 1), and offers "send a new link" for the address the person types:
 * the portal keeps no copy of it between the two pages.
 */
export default function CheckEmailPage() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-6 py-16 focus:outline-none"
    >
      <div className="grid gap-3">
        <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">Velexis</p>
        <h1 className="text-3xl font-semibold tracking-tight">{VERIFICATION_STRINGS.checkEmailTitle}</h1>
        <p>{VERIFICATION_STRINGS.checkEmailIntro}</p>
        <p className="text-muted-foreground">{VERIFICATION_STRINGS.checkEmailExisting}</p>
      </div>
      <section aria-labelledby="resend-title" className="grid gap-4 rounded-lg border p-5">
        <div className="grid gap-1">
          <h2 id="resend-title" className="text-lg font-semibold">
            {VERIFICATION_STRINGS.resendTitle}
          </h2>
          <p className="text-sm text-muted-foreground">{VERIFICATION_STRINGS.checkEmailSpam}</p>
        </div>
        <ResendVerificationForm askForEmail />
      </section>
      <p className="text-sm">
        <Link href="/sign-in" prefetch={false} className="font-medium underline underline-offset-4">
          {VERIFICATION_STRINGS.backToSignIn}
        </Link>
      </p>
    </main>
  );
}
