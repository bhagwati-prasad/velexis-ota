import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { MfaSetup } from "@/app/(app)/account/security/mfa-setup";
import { PasswordForm, type PasswordRule } from "@/app/(app)/account/security/password-form";
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

/** The roles whose two-factor sign-in is mandatory in a live OTA (PADR-0008, revision of 2026-11-05; PBE-071). */
const MFA_MANDATORY_ROLES: ReadonlySet<components["schemas"]["TenantRole"]> = new Set(["owner", "admin"]);

/**
 * Whether the account must keep MFA on as an owner or admin of a live OTA, from `listTenants`, the dashboard's read:
 * it lists the OTAs of the account's active memberships in the statuses members see, with the role and the storefront
 * environment, the very rows the API's `mfa_mandatory` rule reads (FIX-W46-PLATFORM, lead decision (11c); no contract
 * change). `false` when the list could not be read: "Turn off" then stays, and the API's refusal has its own message.
 */
function mustKeepMfa(tenants: readonly components["schemas"]["TenantSummary"][] | undefined): boolean {
  return (tenants ?? []).some(
    (tenant) => MFA_MANDATORY_ROLES.has(tenant.role) && tenant.storefrontEnvironment === "live",
  );
}

/** The roles whose accounts have the privileged password rule, in any OTA (ADR-0008, revision of 2026-11-10). */
const PRIVILEGED_PASSWORD_ROLES: ReadonlySet<components["schemas"]["TenantRole"]> = new Set([
  "owner",
  "admin",
]);

/**
 * The password rule of the account, from `getMe`: `privileged` for a platform admin or an owner or admin of an OTA
 * (`memberships` holds the active memberships of OTAs that members may see, the rows the API's rule reads), else
 * `standard`; `undefined` when the account could not be read, so the form names both rules.
 */
function passwordRuleOf(account: components["schemas"]["Account"] | undefined): PasswordRule | undefined {
  if (account === undefined) {
    return undefined;
  }
  return account.isPlatformAdmin ||
    account.memberships.some((membership) => PRIVILEGED_PASSWORD_ROLES.has(membership.role))
    ? "privileged"
    : "standard";
}

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
 * the dates, and from its admin flag and memberships the password rule the new password's hint names), `listTenants`
 * (whether the account is an owner or admin of a live OTA, who must keep MFA on) and `listSessions` side by side. It
 * never holds a secret: the TOTP secret, its QR code and the recovery codes exist only in the answers of the actions,
 * rendered by the client components, so a reload shows none of them.
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
  const [me, tenants, sessions] = await Promise.all([
    api.GET("/v1/me"),
    api.GET("/v1/tenants"),
    api.GET("/v1/me/sessions"),
  ]);
  for (const answer of [me, tenants, sessions]) {
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
        <PasswordForm rule={passwordRuleOf(me.data)} />
      </Section>

      <Section id="security-mfa" title={SECURITY_STRINGS.mfaTitle}>
        {me.error !== undefined ? (
          <Unavailable title={SECURITY_STRINGS.mfaUnavailableTitle} error={me.error} />
        ) : (
          <MfaSetup
            mfaEnabled={me.data.mfaEnabled}
            mfaEnabledAt={me.data.mfaEnabledAt}
            isPlatformAdmin={me.data.isPlatformAdmin}
            mfaMandatory={mustKeepMfa(tenants.data?.data)}
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
