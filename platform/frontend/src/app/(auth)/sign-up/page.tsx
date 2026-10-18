import type { Metadata } from "next";
import Link from "next/link";

import { SignUpForm } from "@/app/(auth)/sign-up/sign-up-form";
import { SIGN_UP_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: "Sign up" };

/**
 * `/sign-up` (README §2 Auth, PF-01): the sign-up form. The server action `signUp` sends the current terms
 * version (`lib/terms.ts`) and, on success, continues to `/sign-up/check-email`.
 */
export default function SignUpPage() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-6 py-16 focus:outline-none"
    >
      <div className="grid gap-2">
        <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">Velexis</p>
        <h1 className="text-3xl font-semibold tracking-tight">{SIGN_UP_STRINGS.title}</h1>
        <p className="text-muted-foreground">{SIGN_UP_STRINGS.intro}</p>
      </div>
      <SignUpForm />
      <p className="text-sm text-muted-foreground">
        {SIGN_UP_STRINGS.haveAccount}{" "}
        <Link
          href="/sign-in"
          prefetch={false}
          className="font-medium text-foreground underline underline-offset-4"
        >
          {SIGN_UP_STRINGS.signIn}
        </Link>
      </p>
    </main>
  );
}
