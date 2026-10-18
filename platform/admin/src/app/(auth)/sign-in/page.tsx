import type { Metadata } from "next";

import { SignInForm } from "@/app/(auth)/sign-in/sign-in-form";
import { getConfig } from "@/lib/config";
import { safeNextPath } from "@/lib/session";
import { ERROR_MESSAGES, SIGN_IN_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: "Sign in" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** One value of a query parameter; a repeated parameter counts as absent. */
function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A notice at the top of the page, from where the admin came. */
interface Notice {
  readonly text: string;
  /** A problem (an alert) rather than a status message. */
  readonly problem: boolean;
}

/**
 * The notice of the query: `mfa=expired` (the MFA step ended, `/sign-in/mfa`) or `signedOut=1` (`/sign-out`). Other
 * values show nothing.
 */
function noticeOf(params: Record<string, string | string[] | undefined>): Notice | undefined {
  if (single(params.mfa) === "expired") {
    return { text: ERROR_MESSAGES.MFA_CHALLENGE_INVALID, problem: true };
  }
  if (single(params.signedOut) === "1") {
    return { text: SIGN_IN_STRINGS.signedOut, problem: false };
  }
  return undefined;
}

/**
 * `/sign-in` (README §2, PF-80): e-mail and password, the first of the two steps of every admin sign-in. `next` is
 * the path to return to after the second step; only a relative path on the admin is kept (`safeNextPath`), so
 * `next=https://evil.example/x` or `next=//evil.example` lead to the dashboard like no `next` at all. The page always
 * shows the form, also with a session: every sign-in asks for the TOTP or recovery code again.
 */
export default async function SignInPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const next = safeNextPath(single(params.next));
  const notice = noticeOf(params);
  const forgotPasswordUrl = new URL("/forgot-password", getConfig().PUBLIC_PORTAL_URL).toString();
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
        <h1 className="text-3xl font-semibold tracking-tight">{SIGN_IN_STRINGS.title}</h1>
        <p className="text-muted-foreground">{SIGN_IN_STRINGS.intro}</p>
      </div>
      {notice === undefined ? null : (
        <div
          role={notice.problem ? "alert" : "status"}
          className={
            notice.problem
              ? "rounded-lg border border-destructive/50 px-4 py-3 text-sm text-destructive"
              : "rounded-lg border px-4 py-3 text-sm"
          }
        >
          {notice.text}
        </div>
      )}
      <SignInForm next={next} />
      <p className="text-sm text-muted-foreground">
        <a
          href={forgotPasswordUrl}
          rel="noopener noreferrer"
          className="font-medium text-foreground underline underline-offset-4"
        >
          {SIGN_IN_STRINGS.forgotPassword}
        </a>
      </p>
    </main>
  );
}
