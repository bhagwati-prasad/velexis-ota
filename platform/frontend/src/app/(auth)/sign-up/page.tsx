import type { Metadata } from "next";
import Link from "next/link";
import { use } from "react";

import { SignUpForm } from "@/app/(auth)/sign-up/sign-up-form";
import { newOtaPath, planCodeOf } from "@/lib/plan-code";
import { prefillEmail, safeNextPath } from "@/lib/session";
import { SIGN_UP_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: "Sign up" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** One value of a query parameter; a repeated parameter counts as absent. */
function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** `/sign-in`, with the path to return to and the address to prefill when there are any. */
function signInLink(email: string | undefined, next: string | undefined): string {
  const query = new URLSearchParams();
  if (next !== undefined) {
    query.set("next", next);
  }
  if (email !== undefined) {
    query.set("email", email);
  }
  const search = query.toString();
  return search === "" ? "/sign-in" : `/sign-in?${search}`;
}

/**
 * The path to return to after the sign-up: a safe `next` (the invitation's `/invitations/accept`), otherwise the
 * wizard with the plan chosen on `/pricing` (`?plan=<code>`, a well-formed code only; KI-009), otherwise none.
 */
function returnPath(params: Record<string, string | string[] | undefined>): string | undefined {
  const next = safeNextPath(single(params.next));
  if (next !== undefined) {
    return next;
  }
  const plan = planCodeOf(params.plan);
  return plan === undefined ? undefined : newOtaPath(plan);
}

/**
 * `/sign-up` (README §2 Auth, PF-01): the sign-up form. The server action `signUp` sends the current terms
 * version (`lib/terms.ts`) and, on success, continues to `/sign-up/check-email`. `email` prefills the address
 * (`prefillEmail`; the sign-up link of an invitation, PFE-012); the "Sign in" link keeps it and the return path, so a
 * person who already has an account signs in and comes back to the invitation. The return path (`returnPath`: a safe
 * `next`, or `/otas/new?plan=<code>` for the plan chosen on `/pricing`) also travels in the form's hidden `next`, and
 * the action keeps it for the e-mail verification in this browser (FIX-W69-SIGNUP, KI-008, KI-009). Next.js always
 * passes the query; `use()` reads it, so the page renders the same without one.
 */
export default function SignUpPage({ searchParams }: { readonly searchParams?: SearchParams }) {
  const params = searchParams === undefined ? {} : use(searchParams);
  const email = prefillEmail(single(params.email));
  const next = returnPath(params);
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
      <SignUpForm email={email} next={next} />
      <p className="text-sm text-muted-foreground">
        {SIGN_UP_STRINGS.haveAccount}{" "}
        <Link
          href={signInLink(email, next)}
          prefetch={false}
          className="font-medium text-foreground underline underline-offset-4"
        >
          {SIGN_UP_STRINGS.signIn}
        </Link>
      </p>
    </main>
  );
}
