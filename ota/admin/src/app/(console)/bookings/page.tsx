// `/bookings` (README §5, routes.md §3.1, OAD-006): every booking of the OTA in the environment of the switch, with
// the saved needs-attention views, the filters and cursor paging. The page reads only its URL: `listParams`
// (views.ts) turns the search parameters into the parameters of `console.bookings.list` (filters, sort, cursor, page
// size), so every view is a shareable link, and the client filter component writes those parameters and nothing else.
//
// Next.js hides a server component's error from `error.tsx` in production, so the codes the console can answer are
// handled here, on the server (routes.md §1, OAD-004): an expired access token goes to `/auth/refresh?next=` this
// page, an ended session to the portal (`redirectOnSessionError`), and every other API error renders the console's
// message for its code with the request id, under the filters, so staff can change them. A link whose parameters the
// API would refuse is never sent: the page names them instead of listing bookings under a filtered address with the
// filter left out.
import type { ConsoleBookingPage } from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { BookingsTable } from "@/app/(console)/bookings/bookings-table";
import { BookingFilters, BookingViews } from "@/app/(console)/bookings/filters";
import {
  activeView,
  bookingRow,
  clearedHref,
  currentHref,
  filterValuesOf,
  hasFilters,
  listParams,
  parameterLabel,
  queryOf,
  type ListQuery,
} from "@/app/(console)/bookings/views";
import { ErrorState } from "@/components/error-state";
import { errorMessage, isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { can } from "@/lib/permissions";
import { redirectOnSessionError } from "@/lib/session";
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

export const metadata: Metadata = { title: "Bookings" };

const PAGE_STRINGS = Object.freeze({
  title: "Bookings",
  intro: (environment: string) =>
    `Every booking of this OTA in the ${environment} environment: storefront, console and imported.`,
  invalidTitle: "This link has filters the list cannot use",
  invalid: (labels: string) => `Not valid: ${labels}. Change them above, or clear the filters.`,
  unavailableTitle: "The bookings could not be loaded",
  forbiddenTitle: "You cannot open the bookings",
  noMatch: "No booking matches these filters.",
  noBookings: "No bookings yet in this environment.",
  retry: "Try again",
  clear: "Clear filters",
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";

/** The permission of the list (scope §1.3: every role). */
const READ_PERMISSION = "bookings:read";

type SearchParams = Record<string, string | string[] | undefined>;

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

/** The heading, the saved views and the filters, above whatever the page shows. */
function ListShell({
  environment,
  children,
}: {
  readonly environment: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{PAGE_STRINGS.title}</h1>
        <p className="text-muted-foreground">{PAGE_STRINGS.intro(environment)}</p>
      </div>
      <BookingViews />
      <BookingFilters />
      {children}
    </div>
  );
}

export default async function BookingsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<SearchParams> }>) {
  const query = queryOf(await searchParams);
  const here = currentHref(query);

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

  const list: ListQuery = listParams(query, { now: Date.now(), timeZone: staff.tenant.timeZone });
  if (list.invalid.length > 0) {
    return (
      <ListShell environment={environment}>
        <section role="alert" className="grid max-w-xl gap-3">
          <h2 className="text-xl font-semibold">{PAGE_STRINGS.invalidTitle}</h2>
          <p>{PAGE_STRINGS.invalid(list.invalid.map(parameterLabel).join(", "))}</p>
          <Link href={clearedHref(query, list.invalid)} className={LINK_CLASS}>
            {PAGE_STRINGS.clear}
          </Link>
        </section>
      </ListShell>
    );
  }

  let result: ConsoleBookingPage;
  try {
    result = await request.console.bookings.list(list.params);
  } catch (error) {
    const failure = await apiFailure(error, here);
    return (
      <ListShell environment={environment}>
        <ErrorState title={PAGE_STRINGS.unavailableTitle} error={failure}>
          {/* The same URL again: the list is read anew. */}
          <a href={here} className={LINK_CLASS}>
            {PAGE_STRINGS.retry}
          </a>
          {failure.code === "VALIDATION_FAILED" ? (
            <Link href={clearedHref(query)} className={LINK_CLASS}>
              {PAGE_STRINGS.clear}
            </Link>
          ) : null}
        </ErrorState>
      </ListShell>
    );
  }

  const view = activeView(query);
  const emptyMessage =
    view?.emptyMessage ??
    (hasFilters(filterValuesOf(query)) ? PAGE_STRINGS.noMatch : PAGE_STRINGS.noBookings);
  return (
    <ListShell environment={environment}>
      <BookingsTable
        rows={result.data.map((summary) => bookingRow(summary, staff.tenant.timeZone))}
        page={{
          nextCursor: result.page.nextCursor,
          ...(list.pinned === undefined ? {} : { pinned: list.pinned }),
        }}
        emptyMessage={emptyMessage}
        {...(result.totalCount === undefined ? {} : { totalCount: result.totalCount })}
      />
    </ListShell>
  );
}
