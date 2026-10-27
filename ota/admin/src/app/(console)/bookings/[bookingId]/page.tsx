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
//
// The actions (OAD-008, routes.md §3.2 "Actions"): the page renders the dialogs and forms of what the staff member may do
// now, by permission (`can()`) and by the booking's `consoleActions` (Issue and Cancel never while the outcome is
// unknown, `pending`), each with an idempotency key rendered here once per render (`crypto.randomUUID()`), so a double
// submit replays the same action and a success, which revalidates the page, brings new keys. Issue, Cancel and Resync
// sit under the header on every tab; the order's edits on the Travellers and contacts tab; the note form on the Timeline
// and notes tab; Capture and Refund on the payments of the Payments tab, which know their `version` from
// `console.payments.get`. The client components get plain values only (ids, versions, amounts, the names and contacts
// they prefill), never the booking.
import type {
  ConsoleApi,
  ConsoleBooking,
  ConsoleFlightOrderRetrieval,
  ConsolePayment,
  ConsoleStaffProfile,
} from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import {
  CONTACT_PURPOSES,
  canAllowUnpaid,
  cancelPlanOf,
  capturableOf,
  issuePlanOf,
  keptContactOf,
  keptFieldOf,
  refundableOf,
} from "@/app/(console)/bookings/[bookingId]/action-rules";
import { CancelDialog } from "@/app/(console)/bookings/[bookingId]/cancel-dialog";
import { IssueDialog } from "@/app/(console)/bookings/[bookingId]/issue-dialog";
import { NoteForm } from "@/app/(console)/bookings/[bookingId]/note-form";
import {
  BookingEditPanel,
  ResyncForm,
  type ContactEditValues,
  type TravelerEditValues,
} from "@/app/(console)/bookings/[bookingId]/patch-form";
import { CaptureDialog, RefundDialog } from "@/app/(console)/bookings/[bookingId]/payment-dialogs";
import {
  BOOKING_ID_PATTERN,
  BookingDetail,
  bookingHref,
  REFRESH_PARAM,
  TAB_PARAM,
  tabOf,
  type BookingActionSlots,
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
import { can, type StaffEnvironment } from "@/lib/permissions";
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

// ---- Actions (OAD-008) ------------------------------------------------------------------------------------------------

/** A new idempotency key for one dialog of this render. */
function newKey(): string {
  return crypto.randomUUID();
}

/** What a dialog prefills of a traveller. */
function travelerValues(traveler: ConsoleBooking["travelers"][number]): TravelerEditValues {
  const name = traveler.name ?? null;
  const phone = traveler.contact?.phones?.[0];
  const label = [name?.firstName, name?.lastName]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return {
    travelerId: traveler.travelerId,
    label: label === "" ? `traveller ${traveler.travelerId}` : label,
    firstName: name?.firstName ?? "",
    lastName: name?.lastName ?? "",
    dateOfBirth: traveler.dateOfBirth ?? undefined,
    gender: traveler.gender ?? undefined,
    email: traveler.contact?.emailAddress ?? undefined,
    phoneCountryCode: phone?.countryCallingCode ?? undefined,
    phoneNumber: phone?.number ?? undefined,
    // The API replaces the traveller's contact whole: what the dialog does not show goes back with the edit.
    kept: keptFieldOf(keptContactOf(traveler.contact)),
  };
}

/** What a dialog prefills of a contact of the order; one per purpose the API takes. */
function contactValues(contacts: ConsoleBooking["contacts"]): ContactEditValues[] {
  const seen = new Set<string>();
  const values: ContactEditValues[] = [];
  for (const contact of contacts) {
    if (seen.has(contact.purpose) || !CONTACT_PURPOSES.some((choice) => choice.value === contact.purpose)) {
      continue;
    }
    seen.add(contact.purpose);
    const phone = contact.phones?.[0];
    const address = contact.address ?? null;
    values.push({
      purpose: contact.purpose,
      firstName: contact.addresseeName?.firstName ?? undefined,
      lastName: contact.addresseeName?.lastName ?? undefined,
      companyName: contact.companyName ?? undefined,
      email: contact.emailAddress ?? undefined,
      phoneCountryCode: phone?.countryCallingCode ?? undefined,
      phoneNumber: phone?.number ?? undefined,
      addressLine1: address?.lines?.[0] ?? undefined,
      addressLine2: address?.lines?.[1] ?? undefined,
      postalCode: address?.postalCode ?? undefined,
      cityName: address?.cityName ?? undefined,
      countryCode: address?.countryCode ?? undefined,
      language: contact.language ?? undefined,
      // The API replaces the order's contact of this purpose whole: what the dialog does not show goes back with it.
      kept: keptFieldOf(keptContactOf(contact)),
    });
  }
  return values;
}

/** Capture and Refund of each payment of the Payments tab, by payment id. */
function paymentActions(
  bookingId: string,
  payments: PaymentsView | undefined,
  staff: ConsoleStaffProfile,
  environment: StaffEnvironment,
): Record<string, ReactNode> | undefined {
  if (payments === undefined || !payments.permitted) {
    return undefined;
  }
  const slots: Record<string, ReactNode> = {};
  for (const { id, payment } of payments.details) {
    if (payment === undefined) {
      continue;
    }
    const authorized = can(staff, "payments:capture") ? capturableOf(payment) : undefined;
    const refundable = can(staff, "payments:refund") ? refundableOf(payment) : undefined;
    if (authorized === undefined && refundable === undefined) {
      continue;
    }
    slots[id] = (
      <>
        {authorized === undefined ? null : (
          <CaptureDialog
            paymentId={id}
            bookingId={bookingId}
            environment={environment}
            idempotencyKey={newKey()}
            version={payment.version}
            authorized={authorized}
          />
        )}
        {refundable === undefined ? null : (
          <RefundDialog
            paymentId={id}
            bookingId={bookingId}
            environment={environment}
            idempotencyKey={newKey()}
            refundable={refundable}
          />
        )}
      </>
    );
  }
  return slots;
}

/**
 * The action controls of the booking for this staff member, now: each one only with its permission and when the
 * booking's `consoleActions` allow it; Issue and Cancel never while the outcome is unknown (`pending`). Tab-specific
 * controls are built for their tab only.
 */
function bookingActions(
  booking: ConsoleBooking,
  tab: BookingTab,
  staff: ConsoleStaffProfile,
  environment: StaffEnvironment,
  timeZone: string,
  payments: PaymentsView | undefined,
): BookingActionSlots {
  const actions = booking.consoleActions;
  const decided = booking.status !== "pending";
  const common = {
    bookingId: booking.id,
    reference: booking.reference,
    version: booking.version,
    environment,
  };
  const bar: ReactNode[] = [];
  if (decided && actions.canIssue && can(staff, "bookings:issue")) {
    const ticketing = booking.ticketing.status;
    bar.push(
      <IssueDialog
        key="issue"
        {...common}
        idempotencyKey={newKey()}
        plan={issuePlanOf(booking)}
        canAllowUnpaid={canAllowUnpaid(staff.staff.role)}
        urgent={ticketing === "failed" || ticketing === "manual_review"}
      />,
    );
  }
  if (decided && actions.canCancel && can(staff, "bookings:cancel")) {
    bar.push(
      <CancelDialog
        key="cancel"
        {...common}
        idempotencyKey={newKey()}
        plan={cancelPlanOf(booking, timeZone, Date.now())}
      />,
    );
  }
  if (actions.canResync && can(staff, "bookings:write")) {
    bar.push(<ResyncForm key="resync" bookingId={booking.id} />);
  }
  const editable = actions.canPatch && can(staff, "bookings:write");
  const agreement = booking.ticketingAgreement;
  const payment = tab === "payments" ? paymentActions(booking.id, payments, staff, environment) : undefined;
  return {
    ...(bar.length === 0 ? {} : { bar }),
    ...(tab === "travellers" && editable
      ? {
          travellers: (
            <BookingEditPanel
              bookingId={booking.id}
              version={booking.version}
              environment={environment}
              idempotencyKeys={Object.fromEntries(
                [
                  ...booking.travelers.map((traveler) => `traveler:${traveler.travelerId}`),
                  ...booking.contacts.map((contact) => `contact:${contact.purpose}`),
                  "remark",
                  "agreement",
                ].map((name) => [name, newKey()]),
              )}
              travelers={booking.travelers.map(travelerValues)}
              contacts={contactValues(booking.contacts)}
              agreement={{ option: agreement?.option ?? undefined, delay: agreement?.delay ?? undefined }}
            />
          ),
        }
      : {}),
    ...(tab === "timeline" && actions.canAddNote && can(staff, "bookings:write")
      ? { timeline: <NoteForm bookingId={booking.id} idempotencyKey={newKey()} /> }
      : {}),
    ...(payment === undefined ? {} : { payments: payment }),
  };
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
  const timeZone = staff.tenant.timeZone;
  return (
    <BookingDetail
      booking={booking}
      tab={tab}
      timeZone={timeZone}
      refresh={loaded.refresh}
      payments={payments}
      order={order}
      actions={bookingActions(booking, tab, staff, environment, timeZone, payments)}
    />
  );
}
