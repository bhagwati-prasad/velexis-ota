import type { Metadata } from "next";
import Link from "next/link";

import { ForgotPasswordForm } from "@/app/(auth)/forgot-password/forgot-password-form";
import { PASSWORD_RESET_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: "Reset your password" };

/**
 * `/forgot-password` (README §2 Auth, PF-05 AC1): asks for a reset link (`requestPasswordReset`). The link in the
 * e-mail opens `/reset-password?token=…`, which moves the token into a cookie before anything renders.
 */
export default function ForgotPasswordPage() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-6 py-16 focus:outline-none"
    >
      <div className="grid gap-2">
        <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">Velexis</p>
        <h1 className="text-3xl font-semibold tracking-tight">{PASSWORD_RESET_STRINGS.forgotTitle}</h1>
        <p className="text-muted-foreground">{PASSWORD_RESET_STRINGS.forgotIntro}</p>
      </div>
      <ForgotPasswordForm />
      <p className="text-sm">
        <Link href="/sign-in" prefetch={false} className="font-medium underline underline-offset-4">
          {PASSWORD_RESET_STRINGS.backToSignIn}
        </Link>
      </p>
    </main>
  );
}
