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
  readonly className?: string;
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
 * The notices of an OTA (README §4, PADR-0014, ADR-0013): suspended (with the reason and, for a billing
 * suspension, the billing link), a failed payment (`past_due`), a trial that ends soon (`trial_ending`), and test
 * mode. Urgent notices are alerts; the others are status messages, so they are not announced on every page.
 */
export function TenantBanner({ tenant, role, className }: TenantBannerProps) {
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
    notices.push(
      <Alert key="trial-ending" role="status" data-notice="trial_ending">
        <Timer aria-hidden="true" />
        <AlertTitle>{TENANT_BANNER_STRINGS.trialEndingTitle}</AlertTitle>
        <AlertDescription>
          <p>{TENANT_BANNER_STRINGS.trialEnding}</p>
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
