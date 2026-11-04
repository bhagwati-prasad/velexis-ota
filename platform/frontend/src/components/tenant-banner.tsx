import type { components } from "@velexis/api-types/platform";
import { CircleAlert, FlaskConical, CirclePause, Timer } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { can, otaPath, type TenantRole } from "@/lib/roles";
import { TENANT_BANNER_STRINGS } from "@/lib/strings";
import { cn } from "@/lib/utils";

type Tenant = components["schemas"]["Tenant"];

export interface TenantBannerProps {
  /** The OTA as `getTenant` answers it (`otas/[tenantId]/layout.tsx` loads it once). */
  readonly tenant: Pick<
    Tenant,
    "id" | "status" | "suspensionReason" | "billingNotice" | "storefrontEnvironment"
  >;
  /** The caller's role: the billing link shows only to roles that may see billing (scope §1.2). */
  readonly role: TenantRole;
  /**
   * The end of the trial (`trialEndsAt` of `getSubscription`), when it is known: only owners and finance members read
   * the subscription, and only while the OTA has the `trial_ending` notice (`otas/[tenantId]/layout.tsx`). The
   * `trial_ending` notice then says how many days are left, while the end is still ahead.
   */
  readonly trialEndsAt?: string | null | undefined;
  /** The current instant (milliseconds since the epoch), for the days left; the time of the render by default. */
  readonly now?: number | undefined;
  readonly className?: string;
}

const DAY_MS = 86_400_000;

/**
 * The whole days left until `trialEndsAt` (rounded up, so "within a day" covers the last hours), or `undefined` when
 * the end is unknown, not an instant, or already past: the notice then says no number at all (lead decision (2k) of
 * 2026-11-04: the words must be true before and after the trial's end).
 */
export function trialDaysLeft(trialEndsAt: string | null | undefined, now: number): number | undefined {
  if (typeof trialEndsAt !== "string") {
    return undefined;
  }
  const end = Date.parse(trialEndsAt);
  if (!Number.isFinite(end) || end <= now) {
    return undefined;
  }
  return Math.ceil((end - now) / DAY_MS);
}

function BillingLink({ tenantId }: { readonly tenantId: string }) {
  return (
    <Link
      href={otaPath(tenantId, "/billing")}
      className="font-medium text-foreground underline underline-offset-4"
    >
      {TENANT_BANNER_STRINGS.billingLink}
    </Link>
  );
}

/**
 * The notices of an OTA (README §4, PADR-0014, ADR-0013), shown above every page of the OTA by
 * `otas/[tenantId]/layout.tsx` (PFE-021, PF-74 AC1): suspended (with the reason and, for a billing suspension, the
 * billing link), a failed payment (`past_due`, "update your card" with the billing link), a trial that is ending
 * (`trial_ending`, with the days left while its end is known and ahead), and test mode. Urgent notices are alerts; the
 * others are status messages, so they are not announced on every page. A server component: the days left are counted
 * once, when the page renders.
 */
export function TenantBanner({ tenant, role, trialEndsAt, now, className }: TenantBannerProps) {
  const billingLink = can(role, "viewBilling") ? <BillingLink tenantId={tenant.id} /> : null;
  const notices: ReactNode[] = [];

  if (tenant.status === "suspended") {
    const reason = tenant.suspensionReason ?? "unknown";
    notices.push(
      <Alert key="suspended" variant="destructive" data-notice="suspended">
        <CirclePause aria-hidden="true" />
        <AlertTitle>{TENANT_BANNER_STRINGS.suspendedTitle}</AlertTitle>
        <AlertDescription>
          <p>{TENANT_BANNER_STRINGS.suspendedReasons[reason]}</p>
          <p>{TENANT_BANNER_STRINGS.suspendedReadOnly}</p>
          {reason === "billing" ? billingLink : null}
        </AlertDescription>
      </Alert>,
    );
  }
  if (tenant.billingNotice === "past_due") {
    notices.push(
      <Alert key="past-due" variant="destructive" data-notice="past_due">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>{TENANT_BANNER_STRINGS.pastDueTitle}</AlertTitle>
        <AlertDescription>
          <p>{TENANT_BANNER_STRINGS.pastDue}</p>
          {billingLink}
        </AlertDescription>
      </Alert>,
    );
  }
  if (tenant.billingNotice === "trial_ending") {
    const daysLeft = trialDaysLeft(trialEndsAt, now ?? Date.now());
    notices.push(
      <Alert key="trial-ending" role="status" data-notice="trial_ending">
        <Timer aria-hidden="true" />
        <AlertTitle>{TENANT_BANNER_STRINGS.trialEndingTitle}</AlertTitle>
        <AlertDescription>
          <p>{TENANT_BANNER_STRINGS.trialEnding}</p>
          {daysLeft === undefined ? null : (
            <p data-days-left={daysLeft}>{TENANT_BANNER_STRINGS.trialDaysLeft(daysLeft)}</p>
          )}
          {billingLink}
        </AlertDescription>
      </Alert>,
    );
  }
  if (tenant.storefrontEnvironment === "test") {
    notices.push(
      <Alert key="test-mode" role="status" data-notice="test_mode">
        <FlaskConical aria-hidden="true" />
        <AlertTitle>{TENANT_BANNER_STRINGS.testModeTitle}</AlertTitle>
        <AlertDescription>{TENANT_BANNER_STRINGS.testMode}</AlertDescription>
      </Alert>,
    );
  }

  if (notices.length === 0) {
    return null;
  }
  return (
    <section aria-label={TENANT_BANNER_STRINGS.label} className={cn("grid gap-3", className)}>
      {notices}
    </section>
  );
}
