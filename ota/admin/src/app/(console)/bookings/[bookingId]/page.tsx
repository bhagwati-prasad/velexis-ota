// `/bookings/[bookingId]` (README §5, routes.md §3.2, OAD-007): one booking of the OTA in the environment of the
// switch, as staff see it. The page makes the SDK calls; sections.tsx renders them, tab by tab (`?tab=`):
//
// - every tab reads `console.bookings.get` (`bookings:read`); "Sync from Amadeus" (`?refresh=1`) reads it with
//   `refresh: true` (one Flight Order Management GET, throttled by the API to one per 10 s), and a supplier error of
//   that refresh reads the booking again without it and says so (the SDK's "retry without refresh");
// - the Payments tab adds `console.payments.get` for each payment of the booking (`payments:read`; without it the
//   tab shows the booking's own summary), each payment on its own, so one that fails does not hide the others;
// - the Amadeus order tab adds `console.bookings.retrieve`, and only that tab: it calls Amadeus and is audited
//   (`order.retrieve`), so the page never calls it for another tab, and not for a booking whose `consoleActions` say
//   it has no order to read (`canRetrieve`). The tab links never prefetch.
//
// Next.js hides a server component's error from `error.tsx` in production, so the codes the console can answer are
// handled here, on the server (routes.md §1, OAD-004): an expired access token goes to `/auth/refresh?next=` this
// page and tab, an ended session to the portal (`redirectOnSessionError`), a booking the environment does not have
// (`404 NOT_FOUND`, which the API answers for the other environment's bookings too) and an id that is not a booking
// id (never sent) render the page's own "not found" state inside the shell, so the environment switch is at hand, and
// every other API error renders the console's message for its code with the request id and "Try again". An error of
// the payments or of the Amadeus order is shown in its place, under the booking.
import type {
  ConsoleApi,
  ConsoleBooking,
  ConsoleFlightOrderRetrieval,
  ConsolePayment,
} from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";

import {
  BOOKING_ID_PATTERN,
  BookingDetail,
  bookingHref,
  REFRESH_PARAM,
  TAB_PARAM,
  tabOf,
  type BookingTab,
  type OrderView,
  type PaymentDetail,
  type PaymentsView,
  type RefreshOutcome,
  type SupplierIssueLike,
} from "@/app/(console)/bookings/[bookingId]/sections";
import { BOOKINGS_PATH } from "@/app/(console)/bookings/views";
import { ErrorState } from "@/components/error-state";
import { errorMessage, isVelexisErrorLike, type VelexisErrorLike } from "@/lib/errors";
import { can } from "@/lib/permissions";
import { redirectOnSessionError } from "@/lib/session";
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

export const metadata: Metadata = { title: "Booking" };

const PAGE_STRINGS = Object.freeze({
  unavailableTitle: "The booking could not be loaded",
  forbiddenTitle: "You cannot open bookings",
  notFoundTitle: "Booking not found",
  notFound: (environment: string) =>
    `No booking with this id in the ${environment.toUpperCase()} environment. It may belong to the other environment, or the link is wrong.`,
  back: "All bookings",
  retry: "Try again",
});

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";

/** The permission of the page (scope §1.3: every role). */
const READ_PERMISSION = "bookings:read";
/** The permission of the payments' events and refunds (scope §1.3: every role). */
const PAYMENTS_PERMISSION = "payments:read";

/**
 * The codes of a refresh that failed at Amadeus (`console.bookings.get` with `refresh`: "retry without `refresh`"):
 * the booking is read again from the OTA's tables.
 */
const REFRESH_SUPPLIER_CODES: ReadonlySet<string> = new Set([
  "SUPPLIER_NOT_CONFIGURED",
  "SUPPLIER_ERROR",
  "SUPPLIER_UNAVAILABLE",
  "SUPPLIER_TIMEOUT",
]);

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

/** The Amadeus issue of a supplier error (`error.supplier`: code and title), when it has one. */
function supplierIssueOf(error: unknown): SupplierIssueLike | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const { supplier } = error as { supplier?: unknown };
  if (typeof supplier !== "object" || supplier === null) {
    return undefined;
  }
  const { code, title } = supplier as { code?: unknown; title?: unknown };
  const issue = {
    ...(typeof code === "number" ? { code } : {}),
    ...(typeof title === "string" && title !== "" ? { title } : {}),
  };
  return Object.keys(issue).length === 0 ? undefined : issue;
}

/** The booking, or the API's refusal; with `refresh`, the outcome of the sync (see the file header). */
type BookingLoad =
  | { readonly ok: true; readonly booking: ConsoleBooking; readonly refresh?: RefreshOutcome }
  | { readonly ok: false; readonly error: VelexisErrorLike };

async function loadBooking(
  con: ConsoleApi,
  bookingId: string,
  refresh: boolean,
  here: string,
): Promise<BookingLoad> {
  try {
    const booking = await con.bookings.get(refresh ? { bookingId, refresh: true } : { bookingId });
    return refresh ? { ok: true, booking, refresh: { ok: true } } : { ok: true, booking };
  } catch (error) {
    const failure = await apiFailure(error, here);
    if (!refresh || !REFRESH_SUPPLIER_CODES.has(failure.code)) {
      return { ok: false, error: failure };
    }
    try {
      const booking = await con.bookings.get({ bookingId });
      return { ok: true, booking, refresh: { ok: false, error: failure } };
    } catch (second) {
      return { ok: false, error: await apiFailure(second, here) };
    }
  }
}

/** `console.bookings.retrieve` for the Amadeus order tab, when the booking has an order to read. */
async function loadOrder(con: ConsoleApi, booking: ConsoleBooking, here: string): Promise<OrderView> {
  if (!booking.consoleActions.canRetrieve) {
    return { state: "unavailable", reason: booking.consoleActions.reasons["canRetrieve"] };
  }
  let retrieval: ConsoleFlightOrderRetrieval;
  try {
    retrieval = await con.bookings.retrieve({ bookingId: booking.id });
  } catch (error) {
    const failure = await apiFailure(error, here);
    const supplier = supplierIssueOf(error);
    return supplier === undefined
      ? { state: "failed", error: failure }
      : { state: "failed", error: failure, supplier };
  }
  return { state: "loaded", retrieval };
}

/** `console.payments.get` for each payment of the booking, each on its own. */
async function loadPayments(
  con: ConsoleApi,
  booking: ConsoleBooking,
  permitted: boolean,
  here: string,
): Promise<PaymentsView> {
  if (!permitted) {
    return { permitted: false };
  }
  const details = await Promise.all(
    booking.payments.map(async ({ id }): Promise<PaymentDetail> => {
      let payment: ConsolePayment;
      try {
        payment = await con.payments.get({ paymentId: id });
      } catch (error) {
        return { id, error: await apiFailure(error, here) };
      }
      return { id, payment };
    }),
  );
  return { permitted: true, details };
}

/** The page's "not found" state, with the way back to the list. */
function NotFound({ environment }: { readonly environment: string }) {
  return (
    <ErrorState
      title={PAGE_STRINGS.notFoundTitle}
      description={{ message: PAGE_STRINGS.notFound(environment) }}
    >
      <Link href={BOOKINGS_PATH} className={LINK_CLASS}>
        {PAGE_STRINGS.back}
      </Link>
    </ErrorState>
  );
}

/** The one value of a search parameter (the first of a repeated one). */
function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function BookingPage({
  params,
  searchParams,
}: Readonly<{ params: Promise<{ bookingId: string }>; searchParams: Promise<SearchParams> }>) {
  const { bookingId } = await params;
  const query = await searchParams;
  const tab: BookingTab = tabOf(firstOf(query[TAB_PARAM]));
  const refresh = firstOf(query[REFRESH_PARAM]) === "1";
  // Where an expired session comes back to: this booking and tab, never a second sync.
  const here = bookingHref(bookingId, { tab });

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

  if (!BOOKING_ID_PATTERN.test(bookingId)) {
    // The API would refuse it (`400 VALIDATION_FAILED`): no request.
    return <NotFound environment={environment} />;
  }

  const loaded = await loadBooking(request.console, bookingId, refresh, here);
  if (!loaded.ok) {
    if (loaded.error.code === "NOT_FOUND") {
      return <NotFound environment={environment} />;
    }
    return (
      <ErrorState title={PAGE_STRINGS.unavailableTitle} error={loaded.error}>
        {/* The same tab again, without a second sync: the booking is read anew. */}
        <a href={here} className={LINK_CLASS}>
          {PAGE_STRINGS.retry}
        </a>
        <Link href={BOOKINGS_PATH} className={LINK_CLASS}>
          {PAGE_STRINGS.back}
        </Link>
      </ErrorState>
    );
  }

  const { booking } = loaded;
  const payments =
    tab === "payments"
      ? await loadPayments(request.console, booking, can(staff, PAYMENTS_PERMISSION), here)
      : undefined;
  const order = tab === "amadeus-order" ? await loadOrder(request.console, booking, here) : undefined;
  return (
    <BookingDetail
      booking={booking}
      tab={tab}
      timeZone={staff.tenant.timeZone}
      refresh={loaded.refresh}
      payments={payments}
      order={order}
    />
  );
}
