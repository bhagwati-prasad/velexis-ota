import type { components } from "@velexis/api-types/platform";
import Link from "next/link";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { can, otaPath, type TenantRole } from "@/lib/roles";
import { CONSOLE_STRINGS, TENANT_BANNER_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

/**
 * "Open console" (README §2 and §4, platform/docs/flows/team-and-ota-admin-sso.md §C, PADR-0007 point 4): the button
 * that starts the single sign-on into the OTA admin, the paths of the hand-off, and the notice that says why a launch
 * was refused. Plain markup without state or secrets: the button is a `<form method="post">`, so it works before the
 * page hydrates and without JavaScript, and a link prefetch or a crawler can never mint a token (a `GET` of the
 * launch URL only leads to the console picker).
 */

type SuspensionReason = NonNullable<components["schemas"]["SuspensionReason"]>;

/** The launch route handler of an OTA: `POST` checks `Origin`, mints the token and answers the hand-off page. */
export function consoleLaunchPath(tenantId: string): string {
  return otaPath(tenantId, "/console/launch");
}

/** The query parameters of the console picker and of a refused launch. */
export const CONSOLE_QUERY = Object.freeze({
  /** `/console?tenant=<id>`: the OTA the picker pre-selects; on the security page, the OTA to open again. */
  tenant: "tenant",
  /** Why the console could not be opened (`ConsoleProblem`). */
  problem: "console",
  /** The suspension reason of a `suspended` OTA. */
  reason: "reason",
});

/** `/console`, pre-selecting `tenantId` when given (PADR-0007 point 5: the OTA admin's way back). */
export function consolePickerPath(tenantId?: string): string {
  return tenantId === undefined
    ? "/console"
    : `/console?${new URLSearchParams({ [CONSOLE_QUERY.tenant]: tenantId }).toString()}`;
}

/**
 * Why a launch was refused, as the launch route handler tells the page it sends the browser back to:
 * `TENANT_NOT_ACTIVE` with its `details.status` (`provisioning`, `suspended` with a reason, `failed`, or
 * `not_active` without a known status), `RATE_LIMITED`, `MFA_REQUIRED`, and `unavailable` for anything else.
 */
export const CONSOLE_PROBLEMS = [
  "provisioning",
  "suspended",
  "failed",
  "not_active",
  "rate_limited",
  "unavailable",
  "mfa_required",
] as const;

export type ConsoleProblem = (typeof CONSOLE_PROBLEMS)[number];

/** The suspension reasons of the platform document (PADR-0014). */
const SUSPENSION_REASONS = [
  "billing",
  "abuse",
  "request",
  "admin",
] as const satisfies readonly SuspensionReason[];

/** A refused launch: the problem and, for a suspended OTA, the reason when the API gave one. */
export interface ConsoleLaunchFailure {
  readonly problem: ConsoleProblem;
  readonly reason?: SuspensionReason;
}

function isConsoleProblem(value: unknown): value is ConsoleProblem {
  return typeof value === "string" && (CONSOLE_PROBLEMS as readonly string[]).includes(value);
}

function isSuspensionReason(value: unknown): value is SuspensionReason {
  return typeof value === "string" && (SUSPENSION_REASONS as readonly string[]).includes(value);
}

/** One value of a page's search parameter (the first of repeated ones). */
export function searchParam(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

/**
 * Where the launch sends the browser after a refusal: the security page for `MFA_REQUIRED` (with the OTA, so it can
 * offer to open the console again), the OTA dashboard for everything else. Only the problem's name travels in the
 * URL, never a token or the API's text.
 */
export function consoleProblemPath(tenantId: string, failure: ConsoleLaunchFailure): string {
  if (failure.problem === "mfa_required") {
    const query = new URLSearchParams({
      [CONSOLE_QUERY.problem]: failure.problem,
      [CONSOLE_QUERY.tenant]: tenantId,
    });
    return `/account/security?${query.toString()}`;
  }
  const query = new URLSearchParams({ [CONSOLE_QUERY.problem]: failure.problem });
  if (failure.problem === "suspended" && failure.reason !== undefined) {
    query.set(CONSOLE_QUERY.reason, failure.reason);
  }
  return `${otaPath(tenantId)}?${query.toString()}`;
}

/**
 * The refused launch a page's search parameters describe, or `undefined`. Unknown values are ignored, so a crafted
 * link can only show one of the portal's own messages.
 */
export function consoleProblemOf(
  searchParams: Readonly<Record<string, string | readonly string[] | undefined>>,
): ConsoleLaunchFailure | undefined {
  const problem = searchParam(searchParams[CONSOLE_QUERY.problem]);
  if (!isConsoleProblem(problem)) {
    return undefined;
  }
  const reason = searchParam(searchParams[CONSOLE_QUERY.reason]);
  return problem === "suspended" && isSuspensionReason(reason) ? { problem, reason } : { problem };
}

export interface OpenConsoleButtonProps {
  readonly tenantId: string;
  /** The OTA's name, read after "Open console" by screen readers when a page lists several buttons. */
  readonly tenantName?: string;
  readonly variant?: "default" | "outline";
  readonly className?: string;
}

/**
 * "Open console": a small form that posts to `/otas/{tenantId}/console/launch` (README §2 route handlers). The post
 * carries no field: the route handler checks `Origin` and mints the token with the session's cookie.
 */
export function OpenConsoleButton({
  tenantId,
  tenantName,
  variant = "default",
  className,
}: OpenConsoleButtonProps) {
  return (
    <form method="post" action={consoleLaunchPath(tenantId)} className={cn("contents", className)}>
      <Button type="submit" variant={variant}>
        {CONSOLE_STRINGS.openConsole}
        {tenantName === undefined ? null : (
          <span className="sr-only">{CONSOLE_STRINGS.openConsoleFor(tenantName)}</span>
        )}
      </Button>
    </form>
  );
}

export interface ConsoleLaunchNoticeProps {
  readonly failure: ConsoleLaunchFailure;
  /** The OTA the launch was for: the billing link and "Open the console again" need it. */
  readonly tenantId?: string;
  /** The caller's role in that OTA: the billing link shows only to roles that may see billing (scope §1.2). */
  readonly role?: TenantRole;
}

/**
 * Why the console could not be opened (flow §C step 2, PADR-0007 point 2): a suspended OTA with its reason and, for a
 * billing suspension, the billing link (or whom to ask, for roles without billing); an OTA in set-up or whose set-up
 * failed; the rate limit; the MFA policy of live OTAs, with the way to open the console again once MFA is on.
 */
export function ConsoleLaunchNotice({ failure, tenantId, role }: ConsoleLaunchNoticeProps) {
  const { problem } = failure;
  const billing = problem === "suspended" && failure.reason === "billing";
  return (
    <Alert variant="destructive" data-notice="console">
      <AlertTitle>{CONSOLE_STRINGS.problemTitle}</AlertTitle>
      <AlertDescription>
        <p>{CONSOLE_STRINGS.problems[problem]}</p>
        {problem === "suspended" ? (
          <p>{TENANT_BANNER_STRINGS.suspendedReasons[failure.reason ?? "unknown"]}</p>
        ) : null}
        {billing && tenantId !== undefined && role !== undefined && can(role, "viewBilling") ? (
          <Link
            href={otaPath(tenantId, "/billing")}
            className="font-medium text-foreground underline underline-offset-4"
          >
            {TENANT_BANNER_STRINGS.billingLink}
          </Link>
        ) : billing ? (
          <p>{CONSOLE_STRINGS.billingAskOwner}</p>
        ) : null}
        {problem === "mfa_required" && tenantId !== undefined ? (
          <Link
            href={consolePickerPath(tenantId)}
            className="font-medium text-foreground underline underline-offset-4"
          >
            {CONSOLE_STRINGS.openAgain}
          </Link>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
