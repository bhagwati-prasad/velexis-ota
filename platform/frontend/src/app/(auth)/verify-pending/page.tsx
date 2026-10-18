import type { PlatformErrorCode } from "@velexis/errors";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ResendVerificationForm } from "@/app/(auth)/sign-up/sign-up-form";
import { continueAfterVerification } from "@/app/(auth)/verify-pending/actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { platformApi } from "@/lib/api";
import { ACCESS_TOKEN_COOKIE, accessTokenClaims } from "@/lib/session";
import { VERIFICATION_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: "Verify your e-mail" };

/** The problems `/verify-email` and `continueAfterVerification` report through `?error=`. */
const LINK_ERRORS = {
  token: VERIFICATION_STRINGS.tokenInvalid,
  unavailable: VERIFICATION_STRINGS.verifyUnavailable,
  session: VERIFICATION_STRINGS.continueUnavailable,
} as const;

type LinkError = keyof typeof LINK_ERRORS;

function linkError(value: string | string[] | undefined): LinkError | undefined {
  return typeof value === "string" && Object.hasOwn(LINK_ERRORS, value) ? (value as LinkError) : undefined;
}

/** Answers of `getMe` that mean there is no session (any more). */
const SESSION_ENDED: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "UNAUTHENTICATED",
  "TOKEN_EXPIRED",
]);

/** Who is looking at the page. */
type Viewer =
  /** No session: the visitor types the address to get a new link. */
  | { readonly kind: "anonymous"; readonly problem?: string }
  /** A signed-in account that has not verified its address yet. */
  | { readonly kind: "unverified"; readonly email: string }
  /** A signed-in account that has verified its address; `tokenCurrent` when its access token says so too. */
  | { readonly kind: "verified"; readonly tokenCurrent: boolean };

async function viewer(): Promise<Viewer> {
  const accessToken = (await cookies()).get(ACCESS_TOKEN_COOKIE)?.value;
  if (!accessToken) {
    return { kind: "anonymous" };
  }
  const me = await (await platformApi()).GET("/v1/me");
  if (me.error !== undefined) {
    return SESSION_ENDED.has(me.error.code)
      ? { kind: "anonymous" }
      : { kind: "anonymous", problem: VERIFICATION_STRINGS.sessionUnavailable };
  }
  if (me.data.emailVerified) {
    return { kind: "verified", tokenCurrent: accessTokenClaims(accessToken)?.emailVerified === true };
  }
  return { kind: "unverified", email: me.data.email };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * `/verify-pending` (README §2 Auth, PF-02 AC3): the only page of a signed-in account whose address is not
 * verified (`middleware.ts` and the `(app)` layout send it here), and where `/verify-email` sends an expired or used
 * link (`?error=token`). It explains the next step and offers "send a new link". An account that is verified by
 * now continues to the dashboard: at once when its access token says so, otherwise through
 * `continueAfterVerification`, which refreshes the session first.
 */
export default async function VerifyPendingPage({ searchParams }: { searchParams: SearchParams }) {
  const error = linkError((await searchParams).error);
  const who = await viewer();
  if (who.kind === "verified" && who.tokenCurrent) {
    redirect("/dashboard");
  }
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-6 py-16 focus:outline-none"
    >
      {who.kind === "verified" ? (
        <>
          <div className="grid gap-3">
            <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">Velexis</p>
            <h1 className="text-3xl font-semibold tracking-tight">{VERIFICATION_STRINGS.verifiedTitle}</h1>
            <p>{VERIFICATION_STRINGS.verifiedIntro}</p>
          </div>
          {error === "session" ? (
            <Alert variant="destructive">
              <AlertDescription>{LINK_ERRORS.session}</AlertDescription>
            </Alert>
          ) : null}
          <form action={continueAfterVerification}>
            <Button type="submit" size="lg">
              {VERIFICATION_STRINGS.continue}
            </Button>
          </form>
        </>
      ) : (
        <>
          <div className="grid gap-3">
            <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">Velexis</p>
            <h1 className="text-3xl font-semibold tracking-tight">{VERIFICATION_STRINGS.pendingTitle}</h1>
            {who.kind === "unverified" ? (
              <>
                <p>
                  {VERIFICATION_STRINGS.pendingSignedIn} <strong className="break-all">{who.email}</strong>.
                </p>
                <p className="text-muted-foreground">{VERIFICATION_STRINGS.pendingSignedInHint}</p>
              </>
            ) : (
              <p>{VERIFICATION_STRINGS.pendingAnonymous}</p>
            )}
          </div>
          {error === undefined || error === "session" ? null : (
            <Alert variant="destructive">
              <AlertDescription>{LINK_ERRORS[error]}</AlertDescription>
            </Alert>
          )}
          {who.kind === "anonymous" && who.problem !== undefined ? (
            <Alert>
              <AlertDescription>{who.problem}</AlertDescription>
            </Alert>
          ) : null}
          <section aria-labelledby="resend-title" className="grid gap-4 rounded-lg border p-5">
            <h2 id="resend-title" className="text-lg font-semibold">
              {VERIFICATION_STRINGS.resendTitle}
            </h2>
            <ResendVerificationForm askForEmail={who.kind === "anonymous"} />
          </section>
          {who.kind === "unverified" ? (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <span>{VERIFICATION_STRINGS.notYou}</span>
              {/* The same plain POST as the shell's "Sign out" (README §2, `/sign-out`). */}
              <form action="/sign-out" method="post">
                <Button type="submit" variant="link" size="sm" className="px-0">
                  {VERIFICATION_STRINGS.signOut}
                </Button>
              </form>
            </div>
          ) : (
            <p className="text-sm">
              <Link href="/sign-in" prefetch={false} className="font-medium underline underline-offset-4">
                {VERIFICATION_STRINGS.signIn}
              </Link>
            </p>
          )}
        </>
      )}
    </main>
  );
}
