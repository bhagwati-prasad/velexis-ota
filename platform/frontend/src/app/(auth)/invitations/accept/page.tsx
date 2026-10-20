import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";

import { acceptInvitation, signOutForInvitation } from "@/app/(auth)/invitations/accept/actions";
import { DateTime } from "@/components/date-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { createPlatformApi, platformApi, type ApiError, type ApiResult } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { errorMessage, isPlatformErrorCode } from "@/lib/errors";
import { ACCESS_TOKEN_COOKIE, INVITATION_COOKIE } from "@/lib/session";
import { INVITATION_STRINGS, ROLE_LABELS } from "@/lib/strings";

export const metadata: Metadata = { title: INVITATION_STRINGS.pageTitle };

type InvitationPreview = components["schemas"]["InvitationPreview"];
type Account = components["schemas"]["Account"];
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** This page, without its token: where sign-in and sign-up come back to. */
const ACCEPT_PATH = "/invitations/accept";

/** One value of a query parameter; a repeated parameter counts as absent. */
function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The refusal of `acceptInvitation` the action sent back in `?error=`; anything else is ignored. */
function refusalOf(value: string | undefined): PlatformErrorCode | undefined {
  return isPlatformErrorCode(value) ? value : undefined;
}

/** `lookupInvitation` is public: no bearer token, only the end-user headers (its limit counts the visitor's IP). */
async function lookup(token: string): Promise<ApiResult<InvitationPreview>> {
  const settings = getConfig();
  const api = createPlatformApi({
    baseUrl: settings.PLATFORM_API_URL,
    bffKey: settings.PLATFORM_BFF_KEY,
    requestHeaders: await headers(),
  });
  return api.POST("/v1/invitations/lookup", { body: { token } });
}

/** Whether a visitor is signed in, and as whom when `getMe` could say. */
type Visitor = { readonly signedIn: false } | { readonly signedIn: true; readonly account?: Account };

/**
 * The visitor of the page. Without an access token cookie (the middleware has renewed an expired one when it could)
 * nobody is signed in; with one, `getMe` names the account, and an answer that the session ended means the same as no
 * cookie. Another failure (API unavailable) leaves a signed-in visitor whose address is unknown: "Accept" then lets
 * the API decide.
 */
async function loadVisitor(hasSession: boolean): Promise<Visitor> {
  if (!hasSession) {
    return { signedIn: false };
  }
  const api = await platformApi();
  const me = await api.GET("/v1/me");
  if (me.error === undefined) {
    return { signedIn: true, account: me.data };
  }
  return me.error.code === "UNAUTHENTICATED" || me.error.code === "TOKEN_EXPIRED"
    ? { signedIn: false }
    : { signedIn: true };
}

/** The token is no good: the API refused it, or refused its shape. */
function tokenRefused(error: ApiError): boolean {
  return (
    error.code === "INVITATION_INVALID" ||
    (error.code === "VALIDATION_FAILED" &&
      error.fieldErrors.some((fieldError) => fieldError.path === "/token"))
  );
}

/** The two addresses are the same, letter case ignored, as the API compares them. */
function sameAddress(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** What keeps a signed-in visitor from accepting, or what an earlier attempt was refused for. */
type Problem =
  | { readonly kind: "mismatch" }
  | { readonly kind: "unverified" }
  | { readonly kind: "member" }
  | { readonly kind: "failed"; readonly message: string };

/** The refusals of `acceptInvitation` that the page explains on their own. */
const REFUSAL_PROBLEMS: Readonly<Partial<Record<PlatformErrorCode, Problem>>> = {
  INVITATION_EMAIL_MISMATCH: { kind: "mismatch" },
  EMAIL_NOT_VERIFIED: { kind: "unverified" },
  ALREADY_MEMBER: { kind: "member" },
};

/**
 * The problem of a signed-in visitor: the account's own state comes first (another address than the invited one, an
 * unverified address: the API would refuse the acceptance), then the refusal of the last attempt. Another address
 * wins over an unverified one: verifying an address that was not invited would never let this account accept.
 */
function problemOf(
  account: Account | undefined,
  preview: InvitationPreview,
  refusal: PlatformErrorCode | undefined,
): Problem | undefined {
  if (account !== undefined && !sameAddress(account.email, preview.email)) {
    return { kind: "mismatch" };
  }
  if (account !== undefined && !account.emailVerified) {
    return { kind: "unverified" };
  }
  if (refusal === undefined) {
    return undefined;
  }
  return (
    REFUSAL_PROBLEMS[refusal] ?? {
      kind: "failed",
      message: refusal === "RATE_LIMITED" ? INVITATION_STRINGS.rateLimited : errorMessage(refusal),
    }
  );
}

/** The page frame of every state: one `main` and one `h1`. */
function Page({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center gap-8 px-6 py-16 focus:outline-none"
    >
      <div className="grid gap-2">
        <p className="text-sm font-medium tracking-wide text-muted-foreground uppercase">Velexis</p>
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      </div>
      {children}
    </main>
  );
}

const LINK_CLASSES = "font-medium underline underline-offset-4";

/** A query string of `values`. */
function query(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

/** The invitation's details from `lookupInvitation`. */
function Details({ preview }: { readonly preview: InvitationPreview }) {
  return (
    <section aria-labelledby="invitation-details" className="grid gap-3">
      <h2 id="invitation-details" className="sr-only">
        {INVITATION_STRINGS.detailsLabel}
      </h2>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{INVITATION_STRINGS.ota}</dt>
        <dd data-field="tenantName">{preview.tenantName}</dd>
        <dt className="text-muted-foreground">{INVITATION_STRINGS.role}</dt>
        <dd data-field="role">{ROLE_LABELS[preview.role]}</dd>
        <dt className="text-muted-foreground">{INVITATION_STRINGS.invitedAddress}</dt>
        <dd data-field="email">{preview.email}</dd>
        <dt className="text-muted-foreground">{INVITATION_STRINGS.expires}</dt>
        <dd data-field="expiresAt">
          <DateTime value={preview.expiresAt} />
        </dd>
      </dl>
    </section>
  );
}

/** Sign in or sign up with the invited address prefilled, and come back here (`next`). */
function SignedOut({ preview }: { readonly preview: InvitationPreview }) {
  return (
    <div className="grid gap-4" data-state="signed-out">
      <p>{INVITATION_STRINGS.signedOut}</p>
      <div className="flex flex-wrap gap-3">
        <Button asChild>
          <Link href={`/sign-in?${query({ next: ACCEPT_PATH, email: preview.email })}`} prefetch={false}>
            {INVITATION_STRINGS.signIn}
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={`/sign-up?${query({ email: preview.email, next: ACCEPT_PATH })}`} prefetch={false}>
            {INVITATION_STRINGS.signUp}
          </Link>
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">{INVITATION_STRINGS.signUpHint}</p>
    </div>
  );
}

/** Another address than the invited one (PF-20 AC3): the message names the invited address. */
function Mismatch({ preview, account }: { readonly preview: InvitationPreview; readonly account?: Account }) {
  return (
    <div className="grid gap-4" data-state="mismatch">
      <Alert variant="destructive">
        <AlertTitle>{INVITATION_STRINGS.mismatchTitle}</AlertTitle>
        <AlertDescription>
          <p>{INVITATION_STRINGS.mismatch(preview.email)}</p>
          {account === undefined ? null : <p>{INVITATION_STRINGS.signedInAs(account.email)}</p>}
        </AlertDescription>
      </Alert>
      <form action={signOutForInvitation}>
        <input type="hidden" name="email" value={preview.email} />
        <Button type="submit" variant="outline">
          {INVITATION_STRINGS.switchAccount}
        </Button>
      </form>
    </div>
  );
}

/** "Accept the invitation": a plain form post to the `acceptInvitation` action, which reads the token's cookie. */
function AcceptForm() {
  return (
    <form action={acceptInvitation}>
      <Button type="submit" size="lg">
        {INVITATION_STRINGS.accept}
      </Button>
    </form>
  );
}

/** A signed-in visitor: accept, or what keeps them from it. */
function SignedIn({
  preview,
  account,
  problem,
}: {
  readonly preview: InvitationPreview;
  readonly account: Account | undefined;
  readonly problem: Problem | undefined;
}) {
  if (problem?.kind === "mismatch") {
    return <Mismatch preview={preview} {...(account === undefined ? {} : { account })} />;
  }
  if (problem?.kind === "unverified") {
    return (
      <Alert variant="destructive" data-state="unverified">
        <AlertTitle>{INVITATION_STRINGS.unverifiedTitle}</AlertTitle>
        <AlertDescription>
          <p>{INVITATION_STRINGS.unverified}</p>
          <p>
            <Link href="/verify-pending" prefetch={false} className={LINK_CLASSES}>
              {INVITATION_STRINGS.verifyLink}
            </Link>
          </p>
        </AlertDescription>
      </Alert>
    );
  }
  if (problem?.kind === "member") {
    return (
      <div className="grid gap-3" data-state="member">
        <p role="status">{INVITATION_STRINGS.alreadyMember}</p>
        <p>
          <Link href="/dashboard" prefetch={false} className={LINK_CLASSES}>
            {INVITATION_STRINGS.dashboardLink}
          </Link>
        </p>
      </div>
    );
  }
  return (
    <div className="grid gap-4" data-state="signed-in">
      {problem?.kind === "failed" ? (
        <Alert variant="destructive">
          <AlertTitle>{INVITATION_STRINGS.failedTitle}</AlertTitle>
          <AlertDescription>{problem.message}</AlertDescription>
        </Alert>
      ) : null}
      {account === undefined ? null : <p>{INVITATION_STRINGS.signedInAs(account.email)}</p>}
      <AcceptForm />
    </div>
  );
}

/**
 * `/invitations/accept` (README §2 Auth and §6; flows/team-and-ota-admin-sso.md §A steps 2–3; PF-20 AC3). The link of
 * the invitation e-mail is `/invitations/accept?token=…`; `middleware.ts` answers it before this page renders: the
 * token goes into the httpOnly `__Host-vxp_invite` cookie (`SameSite=Strict`, 15 minutes) and a refresh takes the
 * browser to this page without the query, so the token never stays in the address bar or the history and never
 * reaches a `Referer` or the rendered page. The page itself never reads `?token=`.
 *
 * With the cookie it shows the invitation (`lookupInvitation`: OTA, role, inviter, invited address, expiry). A visitor
 * who is not signed in gets sign-in and sign-up links with the invited address prefilled and `next` back here; a
 * signed-in visitor gets "Accept" (`acceptInvitation`, then the OTA's dashboard), unless their account has another
 * address than the invited one (the message names the invited address and offers to sign out and sign in with it) or
 * an unverified one. Without the cookie, or with a token the API refuses, the page explains what to do.
 */
export default async function AcceptInvitationPage({ searchParams }: { searchParams: SearchParams }) {
  const refusal = refusalOf(single((await searchParams).error));
  const cookieStore = await cookies();
  const token = cookieStore.get(INVITATION_COOKIE)?.value;
  if (!token) {
    return refusal === "INVITATION_INVALID" ? (
      <Page title={INVITATION_STRINGS.invalidTitle}>
        <p data-state="invalid">{INVITATION_STRINGS.invalid}</p>
      </Page>
    ) : (
      <Page title={INVITATION_STRINGS.linkMissingTitle}>
        <p data-state="link-missing">{INVITATION_STRINGS.linkMissing}</p>
      </Page>
    );
  }

  const [preview, visitor] = await Promise.all([
    lookup(token),
    loadVisitor(Boolean(cookieStore.get(ACCESS_TOKEN_COOKIE)?.value)),
  ]);
  if (preview.error !== undefined) {
    if (tokenRefused(preview.error)) {
      return (
        <Page title={INVITATION_STRINGS.invalidTitle}>
          <p data-state="invalid">{INVITATION_STRINGS.invalid}</p>
        </Page>
      );
    }
    return (
      <Page title={INVITATION_STRINGS.unavailableTitle}>
        <Alert variant="destructive" data-state="unavailable">
          <AlertDescription>
            {preview.error.code === "RATE_LIMITED"
              ? INVITATION_STRINGS.rateLimited
              : errorMessage(preview.error)}
          </AlertDescription>
        </Alert>
      </Page>
    );
  }

  const invitation = preview.data;
  return (
    <Page title={INVITATION_STRINGS.title(invitation.tenantName)}>
      <p className="text-muted-foreground">
        {INVITATION_STRINGS.intro(invitation.inviterName, invitation.tenantName)}
      </p>
      <Details preview={invitation} />
      {visitor.signedIn ? (
        <SignedIn
          preview={invitation}
          account={visitor.account}
          problem={problemOf(visitor.account, invitation, refusal)}
        />
      ) : (
        <SignedOut preview={invitation} />
      )}
    </Page>
  );
}
