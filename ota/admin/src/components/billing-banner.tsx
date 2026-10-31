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
// tenant id and from nothing else; the portal checks its own roles when the page opens, as it does for every link of
// `/portal`. A server component: it renders on the server with the shell and sends no JavaScript.
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
});

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
  readonly className?: string;
}

/**
 * The strip of the platform's billing notice under the shell's header, with the link to the portal's billing page;
 * nothing for `null`, a missing notice or a value the console does not know.
 */
export function BillingBanner({ notice, portalUrl, tenantId, className }: BillingBannerProps) {
  if (!isBillingNotice(notice)) {
    return null;
  }
  const { role, icon: Icon, tone } = NOTICE_STYLES[notice];
  const strings = BILLING_STRINGS[notice];
  const href = portalBillingUrl(portalUrl, tenantId);
  return (
    <div
      role={role}
      data-notice={notice}
      className={cn("flex items-start gap-3 border-b px-6 py-3 text-sm", tone, className)}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="grid flex-1 gap-1">
        <p className="font-semibold">{strings.title}</p>
        <p>{strings.detail}</p>
        {href === undefined ? null : (
          <p>
            <a href={href} className="font-medium underline underline-offset-4">
              {BILLING_STRINGS.link}
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
