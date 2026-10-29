// `/settings/fees` (README §5, routes.md §9, OAD-013): the OTA's fee rules, the fees charged on top of the selling price
// at the step of their type (OADR-0005 point 7), through `console.settings.feeRules.list` (`settings:read`, every
// role), in the order the pricing engine evaluates them (priority, then id), with the API's `active` filter and cursor
// paging.
//
// The URL is the state: `active=true|false` (none: every rule) and `cursor` (the `page.nextCursor` of the previous page,
// which "Next page" sets and "First page" drops; the API binds a cursor to the filter that wrote it). A link with a
// value the API would refuse is never sent: the page says so, with a link to every rule. Each row links to the rule's
// page; owners and admins (`settings:write`) get "New fee rule", the other roles see the list read only (the button
// disabled, naming the permission). The explanation of the steps and of the first match per fee type is above the list.
//
// Next.js hides a server component's error from `error.tsx` in production, so the codes the console can answer are
// handled here, on the server (routes.md §1, OAD-004): an expired access token goes to `/auth/refresh?next=` this
// list, an ended session to the portal (`redirectOnSessionError`), and every other API error renders the console's
// message for its code with the request id, with "Try again" (and "First page" for `400 VALIDATION_FAILED`, a cursor
// the API refused).
import type { FeeRule, StaffPermission } from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { queryOf } from "@/app/(console)/bookings/views";
import { ErrorState } from "@/components/error-state";
import { PermissionGate } from "@/components/permission-gate";
import { errorMessage, isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { can } from "@/lib/permissions";
import { redirectOnSessionError } from "@/lib/session";
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

import {
  NewRuleLink,
  PricingExplainer,
  RuleListFilter,
  RuleListPaging,
  RulesTable,
} from "../pricing-rule-form";
import { RULES_PAGE_SIZE, RULE_PATHS, ruleListHref, ruleListQueryOf } from "../pricing-rules";

export const metadata: Metadata = { title: "Fee rules" };

const PAGE_STRINGS = Object.freeze({
  title: "Fee rules",
  intro:
    "Fees charged on top of the selling price: service, ticketing, card, extras and cancellation fees. The rules are shared by the test and live environments, and a change applies from the next pricing.",
  newRule: "New fee rule",
  readOnly: "Read only: changing fee rules needs the permission settings:write.",
  unavailableTitle: "The fee rules could not be loaded",
  forbiddenTitle: "You cannot open the fee rules",
  invalidTitle: "This link has a filter the list cannot use",
  invalid: "Its active filter or its page is not valid.",
  allRules: "All fee rules",
  retry: "Try again",
  firstPage: "First page",
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

/** The heading, the explanation and the filter, above whatever the page shows. */
function ListShell({
  request,
  active,
  children,
}: {
  readonly request: ConsoleRequest;
  readonly active: boolean | undefined;
  readonly children: ReactNode;
}) {
  const canWrite = can(request.staff, WRITE_PERMISSION);
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{PAGE_STRINGS.title}</h1>
          <p className="max-w-3xl text-muted-foreground">{PAGE_STRINGS.intro}</p>
          {canWrite ? null : <p className="text-sm text-muted-foreground">{PAGE_STRINGS.readOnly}</p>}
        </div>
        <PermissionGate profile={request.staff} permission={WRITE_PERMISSION} label={PAGE_STRINGS.newRule}>
          <NewRuleLink kind="fee" />
        </PermissionGate>
      </div>
      <PricingExplainer kind="fee" />
      <RuleListFilter kind="fee" active={active} />
      {children}
    </div>
  );
}

export default async function FeeRulesPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const list = ruleListQueryOf(queryOf(await searchParams));
  const here = ruleListHref("fee", list.active, list.cursor);

  let request: ConsoleRequest;
  try {
    request = await getConsoleRequest();
  } catch (error) {
    // The shell renders the same failure of `console.auth.me` in its own words; the page never throws it.
    const failure = await apiFailure(error, here);
    return <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure} />;
  }

  if (!can(request.staff, READ_PERMISSION)) {
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

  if (list.invalid.length > 0) {
    return (
      <ListShell request={request} active={undefined}>
        <section role="alert" className="grid max-w-xl gap-3">
          <h2 className="text-xl font-semibold">{PAGE_STRINGS.invalidTitle}</h2>
          <p>{PAGE_STRINGS.invalid}</p>
          <Link href={RULE_PATHS.fee} className={LINK_CLASS}>
            {PAGE_STRINGS.allRules}
          </Link>
        </section>
      </ListShell>
    );
  }

  let rules: FeeRule[];
  let nextCursor: string | null;
  try {
    const page = await request.console.settings.feeRules.list({
      limit: RULES_PAGE_SIZE,
      ...(list.active === undefined ? {} : { active: list.active }),
      ...(list.cursor === undefined ? {} : { cursor: list.cursor }),
    });
    rules = page.data;
    nextCursor = page.page.nextCursor;
  } catch (error) {
    const failure = await apiFailure(error, here);
    return (
      <ListShell request={request} active={list.active}>
        <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure}>
          {/* The same URL again: the list is read anew. */}
          <a href={here} className={LINK_CLASS}>
            {PAGE_STRINGS.retry}
          </a>
          {failure.code === "VALIDATION_FAILED" ? (
            <Link href={ruleListHref("fee", list.active)} className={LINK_CLASS}>
              {PAGE_STRINGS.firstPage}
            </Link>
          ) : null}
        </ErrorState>
      </ListShell>
    );
  }

  return (
    <ListShell request={request} active={list.active}>
      <RulesTable kind="fee" rules={rules} timeZone={request.staff.tenant.timeZone} />
      <RuleListPaging
        kind="fee"
        active={list.active}
        onLaterPage={list.cursor !== undefined}
        nextCursor={nextCursor}
      />
    </ListShell>
  );
}
