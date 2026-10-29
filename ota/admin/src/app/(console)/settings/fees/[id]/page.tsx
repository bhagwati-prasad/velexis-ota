// `/settings/fees/[id]` (README §5, routes.md §9, OAD-013): one fee rule, through `console.settings.feeRules.get`
// (`settings:read`, every role).
//
// - Owners and admins (`settings:write`) get the rule in the shared form (pricing-rule-form.tsx), which saves the
//   fields they changed with `console.settings.feeRules.update` and `ifMatch` = the version shown here, and shows the
//   API's warnings; and "Delete rule" (`console.settings.feeRules.delete`, the same `ifMatch`).
// - Every other role (agent, finance, viewer) sees the rule read only, with the permission that changing it needs.
//
// Next.js hides a server component's error from `error.tsx` in production, so the codes the console can answer are
// handled here, on the server (routes.md §1, OAD-004): an expired access token goes to `/auth/refresh?next=` this
// page, an ended session to the portal (`redirectOnSessionError`), an id that is not a fee rule id (never sent) and
// `404 NOT_FOUND` render the page's own "not found" state inside the shell, and every other API error renders the
// console's message for its code with the request id and "Try again".
import type { FeeRule, StaffPermission } from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";

import { formatInstant } from "@/app/(console)/bookings/views";
import { ErrorState } from "@/components/error-state";
import { errorMessage, isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { can } from "@/lib/permissions";
import { redirectOnSessionError } from "@/lib/session";
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

import {
  DeleteRuleDialog,
  PricingExplainer,
  PricingRuleForm,
  RuleBadges,
  RuleDetails,
} from "../../pricing-rule-form";
import { RULE_ID_PATTERN, RULE_PATHS, rulePath } from "../../pricing-rules";

export const metadata: Metadata = { title: "Fee rule" };

const PAGE_STRINGS = Object.freeze({
  back: "All fee rules",
  retry: "Try again",
  unavailableTitle: "The fee rule could not be loaded",
  forbiddenTitle: "You cannot open the fee rules",
  notFoundTitle: "Fee rule not found",
  notFound: "This OTA has no fee rule with this id. It may have been deleted, or the link is wrong.",
  version: (version: number, updated: string) => `Version ${version}, last changed ${updated}.`,
  effect:
    "Changes apply from the next pricing; priced offers, checkouts and bookings keep their fee lines. The rule is shared by the test and live environments.",
  readOnly: "Read only: changing fee rules needs the permission settings:write.",
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";
const READ_PERMISSION: StaffPermission = "settings:read";
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

/** "Fee rule not found", inside the shell. */
function NotFound() {
  return (
    <ErrorState title={PAGE_STRINGS.notFoundTitle} description={{ message: PAGE_STRINGS.notFound }}>
      <Link href={RULE_PATHS.fee} className={LINK_CLASS}>
        {PAGE_STRINGS.back}
      </Link>
    </ErrorState>
  );
}

export default async function FeeRulePage({ params }: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  const valid = RULE_ID_PATTERN.fee.test(id);
  // Where an expired session comes back to: this rule (an id that is not one is never put into the URL).
  const here = valid ? rulePath("fee", id) : RULE_PATHS.fee;

  let request: ConsoleRequest;
  try {
    request = await getConsoleRequest();
  } catch (error) {
    // The shell renders the same failure of `console.auth.me` in its own words; the page never throws it.
    const failure = await apiFailure(error, here);
    return <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure} />;
  }
  const { staff, environment } = request;

  if (!can(staff, READ_PERMISSION)) {
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
            details: { requiredPermission: READ_PERMISSION },
          }),
        }}
      />
    );
  }
  if (!valid) {
    // The API would refuse it (`400 VALIDATION_FAILED`): no request.
    return <NotFound />;
  }

  let rule: FeeRule;
  try {
    rule = await request.console.settings.feeRules.get({ feeRuleId: id });
  } catch (error) {
    const failure = await apiFailure(error, here);
    if (failure.code === "NOT_FOUND") {
      return <NotFound />;
    }
    return (
      <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure}>
        <a href={here} className={LINK_CLASS}>
          {PAGE_STRINGS.retry}
        </a>
        <Link href={RULE_PATHS.fee} className={LINK_CLASS}>
          {PAGE_STRINGS.back}
        </Link>
      </ErrorState>
    );
  }

  const timeZone = staff.tenant.timeZone;
  const canWrite = can(staff, WRITE_PERMISSION);
  return (
    <div className="grid gap-6">
      <div className="grid gap-2">
        <Link href={RULE_PATHS.fee} className={LINK_CLASS}>
          {PAGE_STRINGS.back}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{rule.name}</h1>
          <RuleBadges kind="fee" rule={rule} />
        </div>
        <p className="text-sm text-muted-foreground">
          {PAGE_STRINGS.version(rule.version, formatInstant(rule.updatedAt, timeZone))}
        </p>
        <p className="max-w-3xl text-muted-foreground">{PAGE_STRINGS.effect}</p>
      </div>
      <PricingExplainer kind="fee" />
      {canWrite ? (
        <>
          <PricingRuleForm
            kind="fee"
            mode="edit"
            rule={rule}
            timeZone={timeZone}
            defaultCurrency={staff.tenant.defaultCurrency}
          />
          <DeleteRuleDialog
            kind="fee"
            ruleId={rule.id}
            ruleName={rule.name}
            version={rule.version}
            environment={environment}
            idempotencyKey={crypto.randomUUID()}
          />
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{PAGE_STRINGS.readOnly}</p>
          <RuleDetails kind="fee" rule={rule} timeZone={timeZone} />
        </>
      )}
    </div>
  );
}
