import type { PlatformErrorCode } from "@velexis/errors";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { beginEnrolment, confirmEnrolment } from "@/app/(auth)/mfa-enrolment/actions";
import { MfaEnrolment } from "@/app/(app)/account/security/mfa-setup";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { platformApi } from "@/lib/api";
import { MFA_ENROLMENT_PATH, errorMessage, mfaEnrolmentPath } from "@/lib/errors";
import { safeNextPath } from "@/lib/session";
import { MFA_ENROLMENT_STRINGS } from "@/lib/strings";

export const metadata: Metadata = { title: MFA_ENROLMENT_STRINGS.title };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Answers of `getMe` that mean there is no session (any more). */
const SESSION_ENDED: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "UNAUTHENTICATED",
  "TOKEN_EXPIRED",
]);

/** Where the account continues when no `next` is usable. */
const DEFAULT_CONTINUATION = "/dashboard";

/**
 * Where the account continues after the enrolment: `next` of the query when `safeNextPath()` accepts it, as the
 * sign-in keeps its own (`https://evil.example/x` and `//evil.example` are dropped), and never this page itself;
 * otherwise `/dashboard`. A repeated `next` counts as absent.
 */
async function continuationOf(searchParams: SearchParams | undefined): Promise<string> {
  const value = ((await searchParams) ?? {})["next"];
  const next = safeNextPath(typeof value === "string" ? value : undefined);
  if (next === undefined) {
    return DEFAULT_CONTINUATION;
  }
  const { pathname } = new URL(next, "https://portal.invalid");
  return pathname === MFA_ENROLMENT_PATH || pathname.startsWith(`${MFA_ENROLMENT_PATH}/`)
    ? DEFAULT_CONTINUATION
    : next;
}

/**
 * `/mfa-enrolment` (README §2 Auth; PFE-030; PF-04 AC4; PADR-0008, revision of 2026-11-05): the only page of an active
 * owner or admin of a live OTA without MFA, outside the signed-in shell. The `(app)` layout sends such an account here
 * (`getMe` says `mfaEnrolmentRequired`, PBE-071's rule), and so does every page, server action and route handler whose
 * API call meets the API's enrolment gate (`lib/errors.ts` `leaveForMfaEnrolment`), with the page it asked for as
 * `next`. The page says why, runs the set-up of the security page (`MfaEnrolment` of `mfa-setup.tsx`: QR code and
 * base32 secret, the confirming code, the ten recovery codes shown once; nothing more reaches the browser, and this
 * page's own markup holds none of it) and then continues to `next` (`continuationOf`). "Sign out" stays offered.
 *
 * An account that does not (or no longer) need the enrolment goes to `next` at once; one without a session to
 * `/sign-in`, which comes back here with the same `next`; an unverified one to `/verify-pending`.
 */
export default async function MfaEnrolmentPage({ searchParams }: { searchParams?: SearchParams }) {
  const continueTo = await continuationOf(searchParams);
  const me = await (await platformApi()).GET("/v1/me");
  if (me.error !== undefined && SESSION_ENDED.has(me.error.code)) {
    redirect(
      `/sign-in?${new URLSearchParams({
        next: continueTo === DEFAULT_CONTINUATION ? MFA_ENROLMENT_PATH : mfaEnrolmentPath(continueTo),
      }).toString()}`,
    );
  }
  if (me.data !== undefined) {
    if (!me.data.emailVerified) {
      redirect("/verify-pending");
    }
    if (!me.data.mfaEnrolmentRequired) {
      redirect(continueTo);
    }
  }
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-dvh w-full max-w-xl flex-col justify-center gap-8 px-6 py-16 focus:outline-none"
    >
      <div className="grid gap-3">
        <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">Velexis</p>
        <h1 className="text-3xl font-semibold tracking-tight">{MFA_ENROLMENT_STRINGS.title}</h1>
        <p>{MFA_ENROLMENT_STRINGS.intro}</p>
        <p className="text-muted-foreground">{MFA_ENROLMENT_STRINGS.why}</p>
      </div>
      {me.error !== undefined ? (
        <Alert variant="destructive">
          <AlertTitle>{MFA_ENROLMENT_STRINGS.unavailableTitle}</AlertTitle>
          <AlertDescription>{errorMessage(me.error)}</AlertDescription>
        </Alert>
      ) : (
        <section aria-labelledby="mfa-enrolment-setup" className="grid gap-4 rounded-lg border p-5">
          <div className="grid gap-1">
            <h2 id="mfa-enrolment-setup" className="text-lg font-semibold">
              {MFA_ENROLMENT_STRINGS.setupTitle}
            </h2>
            <p className="text-sm text-muted-foreground">{MFA_ENROLMENT_STRINGS.steps}</p>
          </div>
          <MfaEnrolment begin={beginEnrolment} confirm={confirmEnrolment} continueTo={continueTo} />
        </section>
      )}
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span>{MFA_ENROLMENT_STRINGS.notYou}</span>
        {/* The same plain POST as the shell's "Sign out" (README §2, `/sign-out`). */}
        <form action="/sign-out" method="post">
          <Button type="submit" variant="link" size="sm" className="px-0">
            {MFA_ENROLMENT_STRINGS.signOut}
          </Button>
        </form>
      </div>
    </main>
  );
}
