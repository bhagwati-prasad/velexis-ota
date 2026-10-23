// Status badges of the OTA admin (README §9): booking, ticketing, payment and sync states, always in words with a
// matching colour, so colour is never the only signal (conventions §3). The statuses are the OTA document's enums
// as the SDK types them; a status the admin does not know yet (a newer API) still renders, neutral and in its raw
// form. Server or client; no state. The SDK import is types only, which the compiler erases (OADR-0018 point 1).
import type {
  ConsoleBookingStatus,
  ConsoleBookingSyncStatus,
  ConsolePaymentStatus,
  ConsoleTicketingStatus,
  PaymentStatus,
} from "@velexis/ota-sdk";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** The statuses each kind of badge shows. */
interface StatusesByKind {
  /** `ConsoleBooking.status`: the booking's own state. */
  booking: ConsoleBookingStatus;
  /** The ticketing (issuance) state of a booking. */
  ticketing: ConsoleTicketingStatus;
  /** The payment state derived for a booking (`ConsoleBookingSummary.paymentStatus`). */
  payment: ConsolePaymentStatus;
  /** One payment's state at the provider (`ConsolePayment.status`). */
  paymentRecord: PaymentStatus;
  /** The synchronisation with Amadeus (`ConsoleSupplierSync.status`, `ConsoleBookingSummary.syncStatus`). */
  sync: ConsoleBookingSyncStatus;
}

/** What a badge is about. */
export type StatusKind = keyof StatusesByKind;
/** The statuses of one kind. */
export type StatusOf<Kind extends StatusKind> = StatusesByKind[Kind];

/** How a status reads at a glance; the label always says it in words. */
export type StatusTone = "success" | "info" | "warning" | "danger" | "neutral";

type Table<Value> = { readonly [Kind in StatusKind]: Readonly<Record<StatusOf<Kind>, Value>> };

/** Every status of every kind has a label: a status the document adds fails the type check until it has one. */
export const STATUS_LABELS: Table<string> = {
  booking: {
    pending: "Pending",
    confirmed: "Confirmed",
    ticketed: "Ticketed",
    partially_ticketed: "Partially ticketed",
    cancelled: "Cancelled",
    failed: "Failed",
  },
  ticketing: {
    pending: "Not issued",
    in_progress: "Issuing",
    issued: "Issued",
    partially_issued: "Partially issued",
    failed: "Issuing failed",
    manual_review: "Manual review",
    not_applicable: "Not applicable",
  },
  payment: {
    unpaid: "Unpaid",
    authorized: "Authorised",
    paid: "Paid",
    partially_refunded: "Partially refunded",
    refunded: "Refunded",
    failed: "Payment failed",
    not_applicable: "Not applicable",
  },
  paymentRecord: {
    requires_payment_method: "Awaiting payment",
    requires_action: "Awaiting 3-D Secure",
    processing: "Processing",
    authorized: "Authorised",
    captured: "Captured",
    partially_refunded: "Partially refunded",
    refunded: "Refunded",
    cancelled: "Cancelled",
    failed: "Failed",
  },
  sync: {
    refreshed: "Refreshed",
    fresh: "Up to date",
    stale: "Stale",
    throttled: "Throttled",
    failed: "Sync failed",
    order_not_found: "Order not found",
    not_applicable: "Not synchronised",
  },
};

/** The tone of every status: what needs attention is a warning, what went wrong is a danger. */
export const STATUS_TONES: Table<StatusTone> = {
  booking: {
    pending: "warning",
    confirmed: "info",
    ticketed: "success",
    partially_ticketed: "warning",
    cancelled: "neutral",
    failed: "danger",
  },
  ticketing: {
    pending: "neutral",
    in_progress: "info",
    issued: "success",
    partially_issued: "warning",
    failed: "danger",
    manual_review: "warning",
    not_applicable: "neutral",
  },
  payment: {
    unpaid: "warning",
    authorized: "info",
    paid: "success",
    partially_refunded: "neutral",
    refunded: "neutral",
    failed: "danger",
    not_applicable: "neutral",
  },
  paymentRecord: {
    requires_payment_method: "neutral",
    requires_action: "warning",
    processing: "info",
    authorized: "info",
    captured: "success",
    partially_refunded: "neutral",
    refunded: "neutral",
    cancelled: "neutral",
    failed: "danger",
  },
  sync: {
    refreshed: "success",
    fresh: "success",
    stale: "warning",
    throttled: "info",
    failed: "danger",
    order_not_found: "danger",
    not_applicable: "neutral",
  },
};

const TONE_CLASSES: Readonly<Record<StatusTone, string>> = {
  success: "border-transparent bg-emerald-100 text-emerald-900",
  info: "border-transparent bg-sky-100 text-sky-900",
  warning: "border-transparent bg-amber-100 text-amber-900",
  danger: "border-transparent bg-red-100 text-red-900",
  neutral: "border-transparent bg-secondary text-secondary-foreground",
};

/** The classes of a badge of `tone`, for badges that are not about a status (the environment badge). */
export function toneClasses(tone: StatusTone): string {
  return TONE_CLASSES[tone];
}

/** The label and the tone of `status`; an unknown status reads as its raw value, neutral. */
export function describeStatus(kind: StatusKind, status: string): { label: string; tone: StatusTone } {
  const labels: Readonly<Record<string, string>> = STATUS_LABELS[kind];
  const tones: Readonly<Record<string, StatusTone>> = STATUS_TONES[kind];
  if (Object.hasOwn(labels, status)) {
    return { label: labels[status] ?? status, tone: tones[status] ?? "neutral" };
  }
  return { label: status.replaceAll(/[_-]/g, " "), tone: "neutral" };
}

export interface StatusBadgeProps<Kind extends StatusKind> {
  readonly kind: Kind;
  readonly status: StatusOf<Kind>;
  readonly className?: string;
}

/** A status in words with a matching colour. */
export function StatusBadge<Kind extends StatusKind>({ kind, status, className }: StatusBadgeProps<Kind>) {
  const { label, tone } = describeStatus(kind, status);
  return (
    <Badge
      variant="outline"
      data-kind={kind}
      data-status={status}
      data-tone={tone}
      className={cn(TONE_CLASSES[tone], className)}
    >
      {label}
    </Badge>
  );
}
