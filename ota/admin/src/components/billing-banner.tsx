// The platform's billing notice in the console shell (README §4 and §9, OAD-018; ADR-0013 point 7, platform flow
// subscription-billing.md §E and §G, api-changes-console-and-internal.md §3.1): the platform's billing sync keeps
// `platform.tenants.billing_notice`, the OTA API hands it to the console in `tenant.billingNotice` of
// `console.auth.me`, and the shell shows it under its header on every page.
//
//   past_due      a subscription payment failed (or the subscription is paused): an alert, "Payment problem: update
//                 billing in the portal"
//   trial_ending  the trial ends soon: a status message asking for a plan
//   null, absent  nothing (an answer without the optional field means no banner)
//
// The notice never blocks the console: a subscription that ends suspends the OTA instead, and the shell then renders
// "This OTA is suspended" (403 TENANT_SUSPENDED). Billing belongs to the platform, so the banner only links to the
// portal's billing page of the OTA, built by lib/portal-links.ts from the configured portal URL and the session's
// tenant id and from nothing else.
//
// Who sees what (lead decision (2o) of 2026-11-02, FIX-W39-OTA): the notice shows for every role, so everyone knows
// why the console may stop; the link to the portal's billing page shows only to the roles the portal lets open it,
// owner and finance (the portal's `viewBilling` rule, platform/frontend/src/lib/roles.ts, and the platform API's
// getSubscription and listInvoices), read from the staff role the shell already has (`console.auth.me`). Every other
// role reads who can act instead of a link the portal would refuse. The portal still checks its own roles when the
// page opens. A server component: it renders on the server with the shell and sends no JavaScript.
import type { StaffRole } from "@velexis/ota-sdk";
import { CircleAlertIcon, TimerIcon, type LucideIcon } from "lucide-react";

import { PORTAL_AREAS, portalOtaUrl } from "@/lib/portal-links";
import { cn } from "@/lib/utils";

/** The values of `ConsoleTenant.billingNotice` that show a banner. */
export type BillingNotice = "past_due" | "trial_ending";

export const BILLING_STRINGS = Object.freeze({
  past_due: {
    title: "Payment problem: update billing in the portal",
    detail:
      "A Velexis subscription payment for this OTA failed. The console keeps working while the payment is retried; " +
      "the OTA is suspended if it is not made.",
  },
  trial_ending: {
    title: "Your trial ends soon: choose a plan in the portal",
    detail: "Choose a Velexis plan to keep this OTA running after the trial.",
  },
  link: "Go to billing in the portal",
  /** Instead of the link, for the roles the portal's billing page refuses. */
  billingRoles: "The OTA's owners and finance staff manage billing in the portal.",
});

/** The roles that open the portal's billing page: the portal's `viewBilling` rule (owner and finance). */
export const BILLING_ROLES: readonly StaffRole[] = Object.freeze(["owner", "finance"]);

/** `role` may open the portal's billing page (`BILLING_ROLES`); any other value may not. */
export function canViewBilling(role: string | null | undefined): boolean {
  return (BILLING_ROLES as readonly string[]).includes(role ?? "");
}

/** How each notice is shown: the alert of a failed payment, the status message of an ending trial. */
const NOTICE_STYLES: Readonly<
  Record<
    BillingNotice,
    { readonly role: "alert" | "status"; readonly icon: LucideIcon; readonly tone: string }
  >
> = Object.freeze({
  past_due: { role: "alert", icon: CircleAlertIcon, tone: "border-red-300 bg-red-50 text-red-950" },
  trial_ending: { role: "status", icon: TimerIcon, tone: "border-sky-200 bg-sky-50 text-sky-950" },
});

/** The portal's billing area (lib/portal-links.ts), the only page the banner links to. */
const BILLING_AREA_PATH = PORTAL_AREAS.find((area) => area.id === "billing")?.path ?? "billing";

/** `value` is a billing notice that shows a banner; `null`, a missing field and anything else are not. */
export function isBillingNotice(value: unknown): value is BillingNotice {
  return value === "past_due" || value === "trial_ending";
}

/** The portal's billing page of the OTA `tenantId` under `portalUrl`, or `undefined` for a value that is no tenant id. */
export function portalBillingUrl(portalUrl: string, tenantId: string): string | undefined {
  return portalOtaUrl(portalUrl, tenantId, BILLING_AREA_PATH);
}

export interface BillingBannerProps {
  /** `tenant.billingNotice` of `console.auth.me`: `past_due`, `trial_ending`, `null` or absent. */
  readonly notice: string | null | undefined;
  /** `PUBLIC_PORTAL_URL`. */
  readonly portalUrl: string;
  /** The session's OTA (`tenant.id` of `console.auth.me`). */
  readonly tenantId: string;
  /** The staff member's role (`staff.role` of `console.auth.me`): the link shows for owner and finance only. */
  readonly role: StaffRole;
  readonly className?: string;
}

/**
 * The strip of the platform's billing notice under the shell's header, for every role, with the link to the portal's
 * billing page for owner and finance (`canViewBilling`) and who manages billing for the others; nothing for `null`, a
 * missing notice or a value the console does not know.
 */
export function BillingBanner({ notice, portalUrl, tenantId, role, className }: BillingBannerProps) {
  if (!isBillingNotice(notice)) {
    return null;
  }
  const { role: ariaRole, icon: Icon, tone } = NOTICE_STYLES[notice];
  const strings = BILLING_STRINGS[notice];
  const billing = canViewBilling(role);
  const href = billing ? portalBillingUrl(portalUrl, tenantId) : undefined;
  return (
    <div
      role={ariaRole}
      data-notice={notice}
      className={cn("flex items-start gap-3 border-b px-6 py-3 text-sm", tone, className)}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="grid flex-1 gap-1">
        <p className="font-semibold">{strings.title}</p>
        <p>{strings.detail}</p>
        {href !== undefined ? (
          <p>
            <a href={href} className="font-medium underline underline-offset-4">
              {BILLING_STRINGS.link}
            </a>
          </p>
        ) : billing ? null : (
          <p>{BILLING_STRINGS.billingRoles}</p>
        )}
      </div>
    </div>
  );
}
