import type { PlatformErrorCode } from "@velexis/errors";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { MfaSetup } from "@/app/(app)/account/security/mfa-setup";
import { PasswordForm } from "@/app/(app)/account/security/password-form";
import { SessionsTable, SignOutEverywhere } from "@/app/(app)/account/security/sessions-table";
import {
  CONSOLE_QUERY,
  ConsoleLaunchNotice,
  consoleProblemOf,
  searchParam,
} from "@/components/open-console-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { SECURITY_STRINGS } from "@/lib/strings";
import { isTenantId } from "@/lib/tenant";

export const metadata: Metadata = { title: SECURITY_STRINGS.title };

/** Answers that mean the session is over: sign in again and come back. */
const SESSION_ENDED: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  "UNAUTHENTICATED",
  "TOKEN_EXPIRED",
]);

/** A section of the page with its heading and intro. */
function Section({
  id,
  title,
  intro,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly intro?: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="grid gap-4">
      <div className="grid gap-1">
        <h2 id={id} className="text-xl font-semibold tracking-tight">
          {title}
        </h2>
        {intro === undefined ? null : <p className="text-sm text-muted-foreground">{intro}</p>}
      </div>
      {children}
    </section>
  );
}

/** The portal's message for a list or account that could not be loaded, in place of its section's content. */
function Unavailable({ title, error }: { readonly title: string; readonly error: ApiError }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{errorMessage(error)}</AlertDescription>
    </Alert>
  );
}

/**
 * `/account/security` (README §2 Signed in; PF-04, PF-06): the password, two-factor authentication and the sessions
 * of the signed-in account. The page reads `getMe` (whether MFA is on, since when, a platform admin, the time zone of
 * the dates) and `listSessions` side by side. It never holds a secret: the TOTP secret, its QR code and the recovery
 * codes exist only in the answers of the actions, rendered by the client components, so a reload shows none of them.
 * An ended session goes to sign-in and back here; a call that fails otherwise shows the portal's message in place of
 * its section, and the rest of the page stays. "Open console" of a live OTA refused for an account without MFA
 * (`MFA_REQUIRED`, PFE-017) comes here with `?console=mfa_required&tenant=<id>`: the page says why and links back to
 * the console picker for that OTA.
 */
export default async function SecurityPage({
  searchParams,
}: Readonly<{ searchParams?: Promise<Record<string, string | string[] | undefined>> }>) {
  const query = (await searchParams) ?? {};
  const consoleFailure = consoleProblemOf(query);
  const consoleTenant = searchParam(query[CONSOLE_QUERY.tenant]);
  const api = await platformApi();
  const [me, sessions] = await Promise.all([api.GET("/v1/me"), api.GET("/v1/me/sessions")]);
  for (const answer of [me, sessions]) {
    if (answer.error !== undefined && SESSION_ENDED.has(answer.error.code)) {
      redirect(`/sign-in?${new URLSearchParams({ next: "/account/security" }).toString()}`);
    }
  }
  const timeZone = me.data?.timeZone ?? "UTC";

  return (
    <div className="mx-auto grid max-w-3xl gap-10">
      <div className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{SECURITY_STRINGS.title}</h1>
        <p className="text-muted-foreground">{SECURITY_STRINGS.intro}</p>
      </div>
      {consoleFailure?.problem === "mfa_required" ? (
        <ConsoleLaunchNotice
          failure={consoleFailure}
          {...(isTenantId(consoleTenant) ? { tenantId: consoleTenant } : {})}
        />
      ) : null}

      <Section
        id="security-password"
        title={SECURITY_STRINGS.passwordTitle}
        intro={SECURITY_STRINGS.passwordIntro}
      >
        <PasswordForm />
      </Section>

      <Section id="security-mfa" title={SECURITY_STRINGS.mfaTitle}>
        {me.error !== undefined ? (
          <Unavailable title={SECURITY_STRINGS.mfaUnavailableTitle} error={me.error} />
        ) : (
          <MfaSetup
            mfaEnabled={me.data.mfaEnabled}
            mfaEnabledAt={me.data.mfaEnabledAt}
            isPlatformAdmin={me.data.isPlatformAdmin}
            timeZone={timeZone}
          />
        )}
      </Section>

      <Section
        id="security-sessions"
        title={SECURITY_STRINGS.sessionsTitle}
        intro={SECURITY_STRINGS.sessionsIntro}
      >
        {sessions.error !== undefined ? (
          <Unavailable title={SECURITY_STRINGS.sessionsUnavailableTitle} error={sessions.error} />
        ) : (
          <SessionsTable sessions={sessions.data.data} timeZone={timeZone} />
        )}
        <SignOutEverywhere />
      </Section>
    </div>
  );
}
