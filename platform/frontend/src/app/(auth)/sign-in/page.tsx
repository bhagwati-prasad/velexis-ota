import type { Metadata } from "next";
import Link from "next/link";

import { SignInForm } from "@/app/(auth)/sign-in/sign-in-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { prefillEmail, safeNextPath } from "@/lib/session";
import { ERROR_MESSAGES, SIGN_IN_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: "Sign in" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** One value of a query parameter; a repeated parameter counts as absent. */
function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A notice at the top of the page, from where the visitor came. */
interface Notice {
  readonly text: string;
  /** A problem (an alert) rather than a status message. */
  readonly problem: boolean;
}

/**
 * The notice of the query: `mfa=expired` (the MFA step ended, `/sign-in/mfa`), `reset=1` (a new password,
 * `/reset-password`), `verified=1` (`/verify-email`) or `signedOut=1` (`/sign-out`). Other values show nothing.
 */
function noticeOf(params: Record<string, string | string[] | undefined>): Notice | undefined {
  if (single(params.mfa) === "expired") {
    return { text: ERROR_MESSAGES.MFA_CHALLENGE_INVALID, problem: true };
  }
  if (single(params.reset) === "1") {
    return { text: SIGN_IN_STRINGS.passwordChanged, problem: false };
  }
  if (single(params.verified) === "1") {
    return { text: SIGN_IN_STRINGS.verified, problem: false };
  }
  if (single(params.signedOut) === "1") {
    return { text: SIGN_IN_STRINGS.signedOut, problem: false };
  }
  return undefined;
}

/** `path` with the query parameters of `values` that have a value. */
function linkWith(path: string, values: Readonly<Record<string, string | undefined>>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) {
      query.set(name, value);
    }
  }
  const search = query.toString();
  return search === "" ? path : `${path}?${search}`;
}

/**
 * `/sign-in` (README §2 Auth and §6, PF-03): e-mail and password. `next` is the path to return to after sign-in;
 * only a relative path on the portal is kept (`safeNextPath`), so `next=https://evil.example/x` or
 * `next=//evil.example` lead to `/dashboard` like no `next` at all. The page always shows the form: whether a
 * session cookie still works is for the API to say, not for the page to guess. `email` prefills the address
 * (`prefillEmail`; the sign-in link of an invitation, PFE-012), and the sign-up link keeps it and `next`.
 */
export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const next = safeNextPath(single(params.next));
  const email = prefillEmail(single(params.email));
  const notice = noticeOf(params);
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-6 py-16 focus:outline-none"
    >
      <div className="grid gap-2">
        <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">Velexis</p>
        <h1 className="text-3xl font-semibold tracking-tight">{SIGN_IN_STRINGS.title}</h1>
        <p className="text-muted-foreground">{SIGN_IN_STRINGS.intro}</p>
      </div>
      {notice === undefined ? null : notice.problem ? (
        <Alert variant="destructive">
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      ) : (
        <Alert role="status">
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      )}
      <SignInForm next={next} email={email} />
      <p className="text-sm text-muted-foreground">
        {SIGN_IN_STRINGS.noAccount}{" "}
        <Link
          href={linkWith("/sign-up", { email, next })}
          prefetch={false}
          className="font-medium text-foreground underline underline-offset-4"
        >
          {SIGN_IN_STRINGS.signUp}
        </Link>
      </p>
    </main>
  );
}
