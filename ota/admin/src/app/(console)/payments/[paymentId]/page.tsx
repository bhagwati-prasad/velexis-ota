// `/payments/[paymentId]` (README §5, routes.md §7, OAD-011): one payment of the OTA in the environment of the switch,
// as staff see it, with what they may do with it now.
//
// - It reads `console.payments.get({ paymentId })` (`payments:read`, every role): the payment with its redacted events,
//   its refunds, its booking (`id`, `reference`, `status`, or none while the checkout has no booking) and the account
//   mode of its payment connection. "Refresh from Stripe" is a GET button to `?refresh=1`, which reads it with
//   `refresh: true` (the API reads the PaymentIntent again and applies its state, as a webhook would); when Stripe
//   fails (`502 PAYMENT_PROVIDER_ERROR`, nothing changed) the page reads the stored payment again and says so. It is
//   offered for a Stripe payment with a PaymentIntent only: the API answers any other as stored.
// - The payment is shown as the booking's Payments tab shows it (`PaymentCard` of the booking's sections: the
//   amounts, the card's brand and last 4 only, never its expiry or holder, 3-D Secure, the failure, the account, the
//   times, the version, the events and the refunds), under a header with the booking link, the checkout and what is
//   still refundable: the captured amount less the refunded amount less the refunds still on their way to Stripe
//   (`pending`, `processing`), as the API counts it (action-rules.ts `refundableOf`, the booking page's figure too).
// - Actions (routes.md §3.2 "Actions", OADR-0018 points 5 and 8): the booking page's Capture and Refund dialogs on
//   OAD-004's `ConfirmDialog` (reason, amount, the environment badge and the live warning, the idempotency key the
//   page renders here once per render, `ifMatch` = the payment's `version` for a capture) with this page's server
//   actions (`./actions.ts`). Capture only for an `authorized` Stripe payment and `payments:capture`; Refund only for a
//   Stripe payment with something left to refund and `payments:refund` (owner, admin, finance: an agent sees no refund
//   button). An airline-card payment shows "Refunded by the airline" instead (OADR-0004: the airline charged the card
//   and reverses its own charge; the console never refunds it).
//
// Next.js hides a server component's error from `error.tsx` in production, so the codes the console can answer are
// handled here, on the server (routes.md §1, OAD-004): an expired access token goes to `/auth/refresh?next=` this page
// (never with `refresh=1`), an ended session to the portal (`redirectOnSessionError`), a payment the environment does
// not have (`404 NOT_FOUND`, which the API answers for the other environment's payments too) and an id that is not a
// payment id (never sent) render the page's own "not found" state inside the shell, so the environment switch is at
// hand, and every other API error renders the console's message for its code with the request id and "Try again".
import type { ConsoleApi, ConsolePayment, ConsoleStaffProfile } from "@velexis/ota-sdk";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import {
  capturableOf,
  isAirlinePayment,
  refundableOf,
  refundsInFlightOf,
} from "@/app/(console)/bookings/[bookingId]/action-rules";
import { CaptureDialog, RefundDialog } from "@/app/(console)/bookings/[bookingId]/payment-dialogs";
import {
  METHOD_LABELS,
  PROVIDER_LABELS,
  PaymentCard,
  bookingHref,
  labelOf,
} from "@/app/(console)/bookings/[bookingId]/sections";
import { ErrorState } from "@/components/error-state";
import { Money } from "@/components/money";
import { StatusBadge, toneClasses, type StatusTone } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { errorMessage, isVelexisErrorLike, withRequestId, type VelexisErrorLike } from "@/lib/errors";
import { can, type StaffEnvironment } from "@/lib/permissions";
import { redirectOnSessionError } from "@/lib/session";
import { cn } from "@/lib/utils";
import { getConsoleRequest, type ConsoleRequest } from "@/lib/velexis";

import { capturePayment, refundPayment } from "./actions";

export const metadata: Metadata = { title: "Payment" };

const PAGE_STRINGS = Object.freeze({
  title: "Payment",
  back: "All payments",
  retry: "Try again",
  unavailableTitle: "The payment could not be loaded",
  forbiddenTitle: "You cannot open payments",
  notFoundTitle: "Payment not found",
  notFound: (environment: string) =>
    `No payment with this id in the ${environment.toUpperCase()} environment. It may belong to the other environment, or the link is wrong.`,
  booking: "Booking",
  noBooking: "No booking yet: the checkout has not become a booking.",
  checkout: "Checkout",
  purpose: "For",
  environment: "Environment",
  stillRefundable: "Still refundable",
  refundsInFlight: "Refunds on their way to Stripe",
  actions: "Payment actions",
  refresh: "Refresh from Stripe",
  refreshed: "Read from Stripe just now: this is the payment as Stripe has it.",
  refreshFailed: "Stripe could not be read, so this is the stored payment.",
  refundedByAirline: "Refunded by the airline",
  details: "Details",
});

const PURPOSE_LABELS: Readonly<Record<string, string>> = {
  booking: "The booking",
  ancillaries: "Extras added to the booking",
};

const LINK_CLASS = "text-sm font-medium text-primary underline underline-offset-4";

/** The list of payments. */
const PAYMENTS_PATH = "/payments";
/** The permission of the page (scope §1.3: every role). */
const READ_PERMISSION = "payments:read";
/** A payment id as the API writes it (`ConsolePayment.id`). */
const PAYMENT_ID_PATTERN = /^pay_[0-9A-Za-z]{16,40}$/;
/** The search parameter of "Refresh from Stripe" (`refresh=1`). */
const REFRESH_PARAM = "refresh";
/** The code of a refresh that failed at Stripe: the payment is read again as it is stored. */
const REFRESH_PROVIDER_CODE = "PAYMENT_PROVIDER_ERROR";

type SearchParams = Record<string, string | string[] | undefined>;

/** The URL of a payment's page; with `refresh`, the one of "Refresh from Stripe". */
function paymentHref(paymentId: string, refresh = false): string {
  const path = `${PAYMENTS_PATH}/${encodeURIComponent(paymentId)}`;
  return refresh ? `${path}?${REFRESH_PARAM}=1` : path;
}

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

/** The outcome of "Refresh from Stripe". */
type RefreshOutcome = { readonly ok: true } | { readonly ok: false; readonly error: VelexisErrorLike };

/** The payment, or the API's refusal; with `refresh`, the outcome of the read at Stripe. */
type PaymentLoad =
  | { readonly ok: true; readonly payment: ConsolePayment; readonly refresh?: RefreshOutcome }
  | { readonly ok: false; readonly error: VelexisErrorLike };

async function loadPayment(
  con: ConsoleApi,
  paymentId: string,
  refresh: boolean,
  here: string,
): Promise<PaymentLoad> {
  try {
    const payment = await con.payments.get(refresh ? { paymentId, refresh: true } : { paymentId });
    return refresh ? { ok: true, payment, refresh: { ok: true } } : { ok: true, payment };
  } catch (error) {
    const failure = await apiFailure(error, here);
    if (!refresh || failure.code !== REFRESH_PROVIDER_CODE) {
      return { ok: false, error: failure };
    }
    try {
      const payment = await con.payments.get({ paymentId });
      return { ok: true, payment, refresh: { ok: false, error: failure } };
    } catch (second) {
      return { ok: false, error: await apiFailure(second, here) };
    }
  }
}

// ---- Actions --------------------------------------------------------------------------------------------------------

/** A new idempotency key for one dialog of this render. */
function newKey(): string {
  return crypto.randomUUID();
}

/** "Refresh from Stripe": a Stripe payment with a PaymentIntent (the API answers any other as stored). */
function refreshable(payment: ConsolePayment): boolean {
  return (
    payment.provider === "stripe" &&
    typeof payment.providerPaymentId === "string" &&
    payment.providerPaymentId !== ""
  );
}

/**
 * The controls of the payment for this staff member, now: "Refresh from Stripe", Capture and Refund each when the
 * payment and the permission allow it; "Refunded by the airline" for an airline-card payment, for every role.
 */
function paymentActions(
  payment: ConsolePayment,
  staff: ConsoleStaffProfile,
  environment: StaffEnvironment,
): ReactNode[] {
  const controls: ReactNode[] = [];
  if (refreshable(payment)) {
    controls.push(
      <form key="refresh" method="get" action={paymentHref(payment.id)}>
        <input type="hidden" name={REFRESH_PARAM} value="1" />
        <Button type="submit" variant="outline" size="sm">
          {PAGE_STRINGS.refresh}
        </Button>
      </form>,
    );
  }
  const bookingId = payment.booking?.id;
  const authorized = can(staff, "payments:capture") ? capturableOf(payment) : undefined;
  if (authorized !== undefined) {
    controls.push(
      <CaptureDialog
        key="capture"
        paymentId={payment.id}
        bookingId={bookingId}
        environment={environment}
        idempotencyKey={newKey()}
        action={capturePayment}
        version={payment.version}
        authorized={authorized}
      />,
    );
  }
  if (isAirlinePayment(payment)) {
    controls.push(
      <p
        key="airline"
        data-airline-refund="true"
        className={cn(
          "inline-flex h-8 items-center rounded-md px-3 text-sm font-medium",
          toneClasses("warning"),
        )}
      >
        {PAGE_STRINGS.refundedByAirline}
      </p>,
    );
  } else {
    const refundable = can(staff, "payments:refund") ? refundableOf(payment) : undefined;
    if (refundable !== undefined) {
      controls.push(
        <RefundDialog
          key="refund"
          paymentId={payment.id}
          bookingId={bookingId}
          environment={environment}
          idempotencyKey={newKey()}
          action={refundPayment}
          refundable={refundable}
        />,
      );
    }
  }
  return controls;
}

// ---- Pieces ---------------------------------------------------------------------------------------------------------

/** One fact: a label and its value. */
type Fact = readonly [label: string, value: ReactNode];

function Facts({ items }: { readonly items: readonly Fact[] }) {
  return (
    <dl className="grid grid-cols-[minmax(9rem,max-content)_1fr] gap-x-4 gap-y-1 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The booking the payment pays, with its status; or why there is none yet. */
function bookingFact(payment: ConsolePayment): ReactNode {
  const { booking } = payment;
  if (booking === null) {
    return <span className="text-muted-foreground">{PAGE_STRINGS.noBooking}</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Link
        href={bookingHref(booking.id, { tab: "payments" })}
        prefetch={false}
        className="font-mono font-medium underline-offset-4 hover:underline focus-visible:underline"
      >
        {booking.reference}
      </Link>
      <StatusBadge kind="booking" status={booking.status} />
    </span>
  );
}

/** The payment's header: its id and status, provider and method, and the facts the card below does not show. */
function Header({ payment }: { readonly payment: ConsolePayment }) {
  const refundable = refundableOf(payment);
  const inFlight = refundsInFlightOf(payment);
  const facts: Fact[] = [
    [PAGE_STRINGS.booking, bookingFact(payment)],
    [
      PAGE_STRINGS.checkout,
      payment.checkoutId === null ? "None" : <code className="text-xs">{payment.checkoutId}</code>,
    ],
    ...(payment.purpose === undefined
      ? []
      : [[PAGE_STRINGS.purpose, labelOf(PURPOSE_LABELS, payment.purpose)] as const]),
    [PAGE_STRINGS.environment, payment.environment.toUpperCase()],
    ...(refundable === undefined
      ? []
      : [[PAGE_STRINGS.stillRefundable, <Money value={refundable} />] as const]),
    ...(inFlight === undefined ? [] : [[PAGE_STRINGS.refundsInFlight, <Money value={inFlight} />] as const]),
  ];
  return (
    <header className="grid gap-3">
      <Link href={PAYMENTS_PATH} className={LINK_CLASS}>
        {PAGE_STRINGS.back}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          {PAGE_STRINGS.title} <code className="font-mono text-xl">{payment.id}</code>
        </h1>
        <StatusBadge kind="paymentRecord" status={payment.status} />
      </div>
      <p className="text-muted-foreground">
        {labelOf(PROVIDER_LABELS, payment.provider)} · {labelOf(METHOD_LABELS, payment.method)} ·{" "}
        <Money value={payment.amount} />
      </p>
      <Facts items={facts} />
    </header>
  );
}

/** What "Refresh from Stripe" did (a failure leaves the stored payment on the page, as the booking page's sync does). */
function RefreshNotice({ refresh }: { readonly refresh: RefreshOutcome }) {
  const tone: StatusTone = refresh.ok ? "success" : "warning";
  const text = refresh.ok
    ? PAGE_STRINGS.refreshed
    : `${PAGE_STRINGS.refreshFailed} ${withRequestId(errorMessage(refresh.error), refresh.error.requestId)}`;
  return (
    <p role="status" data-tone={tone} className={cn("rounded-md px-3 py-2 text-sm", toneClasses(tone))}>
      {text}
    </p>
  );
}

/** The page's "not found" state, with the way back to the list. */
function NotFound({ environment }: { readonly environment: string }) {
  return (
    <ErrorState
      title={PAGE_STRINGS.notFoundTitle}
      description={{ message: PAGE_STRINGS.notFound(environment) }}
    >
      <Link href={PAYMENTS_PATH} className={LINK_CLASS}>
        {PAGE_STRINGS.back}
      </Link>
    </ErrorState>
  );
}

/** The one value of a search parameter (the first of a repeated one). */
function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function PaymentPage({
  params,
  searchParams,
}: Readonly<{ params: Promise<{ paymentId: string }>; searchParams: Promise<SearchParams> }>) {
  const { paymentId } = await params;
  const query = await searchParams;
  const refresh = firstOf(query[REFRESH_PARAM]) === "1";
  // Where an expired session comes back to: this payment, never a second read at Stripe.
  const here = paymentHref(paymentId);

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

  if (!PAYMENT_ID_PATTERN.test(paymentId)) {
    // The API would refuse it (`400 VALIDATION_FAILED`): no request.
    return <NotFound environment={environment} />;
  }

  const loaded = await loadPayment(request.console, paymentId, refresh, here);
  if (!loaded.ok) {
    if (loaded.error.code === "NOT_FOUND") {
      return <NotFound environment={environment} />;
    }
    return (
      <ErrorState title={PAGE_STRINGS.unavailableTitle} error={loaded.error}>
        {/* The payment again, without a second read at Stripe. */}
        <a href={here} className={LINK_CLASS}>
          {PAGE_STRINGS.retry}
        </a>
        <Link href={PAYMENTS_PATH} className={LINK_CLASS}>
          {PAGE_STRINGS.back}
        </Link>
      </ErrorState>
    );
  }

  const { payment } = loaded;
  const controls = paymentActions(payment, staff, environment);
  // A payment without a PaymentIntent (a link with `refresh=1` to an airline-card payment, say) was answered as stored:
  // nothing was read at Stripe, so nothing is said about it.
  const refreshed = refreshable(payment) ? loaded.refresh : undefined;
  return (
    <div className="grid gap-6">
      <Header payment={payment} />
      {controls.length === 0 ? null : (
        <section aria-label={PAGE_STRINGS.actions} className="flex flex-wrap items-start gap-3">
          {controls}
        </section>
      )}
      {refreshed === undefined ? null : <RefreshNotice refresh={refreshed} />}
      <section aria-labelledby="payment-details-heading" className="grid gap-3">
        <h2 id="payment-details-heading" className="text-lg font-semibold">
          {PAGE_STRINGS.details}
        </h2>
        <PaymentCard
          summary={payment}
          detail={{ id: payment.id, payment }}
          timeZone={staff.tenant.timeZone}
        />
      </section>
    </div>
  );
}
