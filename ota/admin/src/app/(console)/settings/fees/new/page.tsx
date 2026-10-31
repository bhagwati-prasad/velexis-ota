// `/settings/fees/new` (README §5, routes.md §9, OAD-013): a new fee rule, for owners and admins (`settings:write`):
// the shared form (pricing-rule-form.tsx) with `FeeRuleInput`'s defaults (per booking, priority 100, not refundable,
// active, no window, the OTA's default currency; the fee type is chosen), posted to `createFeeRule` under the
// idempotency key rendered here once per render (a double submit creates one rule). A success opens the new rule, or
// stays to show the API's warnings. Every other role gets a state naming the permission, without a form.
//
// Next.js hides a server component's error from `error.tsx` in production, so the shell's `console.auth.me` failure
// is handled here, on the server (routes.md §1): an expired access token goes to `/auth/refresh?next=` this page, an
// ended session to the portal (`redirectOnSessionError`), any other error renders the console's message with the
// request id.
import type { StaffPermission } from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";

import { ErrorState } from "@/components/error-state";
import { errorMessage, isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { can } from "@/lib/permissions";
import { redirectOnSessionError } from "@/lib/session";
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

import { PricingExplainer, PricingRuleForm } from "../../pricing-rule-form";
import { RULE_PATHS, newRulePath } from "../../pricing-rules";

export const metadata: Metadata = { title: "New fee rule" };

const PAGE_STRINGS = Object.freeze({
  title: "New fee rule",
  intro:
    "The rule applies from the next pricing; offers already priced keep their fees. Rules are shared by the test and live environments.",
  back: "All fee rules",
  unavailableTitle: "The form could not be opened",
  forbiddenTitle: "You cannot create fee rules",
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";
const WRITE_PERMISSION: StaffPermission = "settings:write";

/**
 * An error of the OTA API as the page's state: `TOKEN_EXPIRED` and an ended session redirect (Next.js's redirect is
 * thrown on), anything that is not an API error is thrown for the error boundary, and an API error is returned.
 */
async function apiFailure(error: unknown, here: string): Promise<VelexisErrorLike> {
  if (!isVelexisErrorLike(error)) {
    throw error;
  }
  try {
    await redirectOnSessionError(error, here);
  } catch (thrown) {
    // `redirectOnSessionError` throws the same error back when it is not about the session.
    if (thrown !== error) {
      throw thrown;
    }
  }
  return error;
}

export default async function NewFeeRulePage() {
  let request: ConsoleRequest;
  try {
    request = await getConsoleRequest();
  } catch (error) {
    const failure = await apiFailure(error, newRulePath("fee"));
    return <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure} />;
  }
  const { staff } = request;

  if (!can(staff, WRITE_PERMISSION)) {
    return (
      <ErrorState
        title={PAGE_STRINGS.forbiddenTitle}
        description={{
          message: errorMessage({
            code: "FORBIDDEN",
            status: 403,
            requestId: null,
            fieldErrors: [],
            retryable: false,
            details: { requiredPermission: WRITE_PERMISSION },
          }),
        }}
      >
        <Link href={RULE_PATHS.fee} className={LINK_CLASS}>
          {PAGE_STRINGS.back}
        </Link>
      </ErrorState>
    );
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <Link href={RULE_PATHS.fee} className={LINK_CLASS}>
          {PAGE_STRINGS.back}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{PAGE_STRINGS.title}</h1>
        <p className="max-w-3xl text-muted-foreground">{PAGE_STRINGS.intro}</p>
      </div>
      <PricingExplainer kind="fee" />
      <PricingRuleForm
        kind="fee"
        mode="create"
        idempotencyKey={crypto.randomUUID()}
        timeZone={staff.tenant.timeZone}
        defaultCurrency={staff.tenant.defaultCurrency}
      />
    </div>
  );
}
