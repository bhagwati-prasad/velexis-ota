// The consumer of `ota-payments` (OBE-040; OADR-0010 points 3 and 6, OADR-0008 points 6 and 7, OADR-0014 points 4–6,
// ota/docs/architecture.md §6). It runs in the worker only. The API, the booking orchestration and the schedulers add
// three jobs, each `{tenantId, id}` with ids only (`paymentJob` builds them with their deterministic job ids):
//
//   payment.void            {pay_…}  job id payment-void-<pay_id>    checkout expiry, an Amadeus refusal after the
//                                                                     authorisation, reconciliation not found, suspension
//   payment.capture_retry   {pay_…}  job id capture-retry-<pay_id>   a capture that failed after the order (10 minutes
//                                                                     later, OADR-0008 point 7); capture-retry-
//                                                                     cancellation-<pay_id> for the amount a
//                                                                     cancellation keeps (FIX-W28-CANCEL)
//   refund.submit           {rfd_…}  job id refund-submit-<rfd_id>   a refund row (refunds.repository.ts) to send
//
// The safety net (lead decision (4) of 2026-10-24, FIX-W29-OTA; OADR-0010 point 6, OADR-0003 point 7). A capture or a
// void that runs after a commit (checkout.complete's and the reconciliation's capture after the record step, a
// cancellation's capture of the kept amount or its void) would be lost if the process stopped between the commit and
// the Stripe call: the authorisation would wait for the authorisation watch's alert after 5 days. So the record step
// queues, before its commit and on its own, the job that would retry that call, delayed CAPTURE_RETRY_DELAY_MS
// (`safetyNetJob`): `capture-retry-<pay_id>` for an order's capture, `capture-retry-cancellation-<pay_id>` for the
// kept amount, `payment-void-cancellation-<pay_id>` for a cancellation's void. A capture's safety net has the id of the
// retry its failure would queue, so it is that retry (BullMQ ignores the failure's add while it holds the job); it is
// removed once it completed (`removeOnComplete`), so a later producer of that id is never ignored for a day. On the
// normal path it finds the payment captured or voided and changes nothing; after a crash it captures with the request's
// own key (`pi:capture:<pay_id>:<amount>`, the booking's total; `pi:capture:<pay_id>:cancellation:<amount>`) or voids
// (`pi:cancel:<pay_id>`), once. An order's capture is followed by its issuance: when the net finds the payment
// captured (by itself or before a stop) and the booking still waiting for the issuance that checkout.complete's step 5
// or the reconciliation asks for after their capture (`confirmed`, `ticketing_status = pending`, never asked: the
// `issue_after_payment` policy), it makes the issuance due now, as the reconciliation's capture does, and the ticketing
// scan issues it (`requestIssuance`; PaymentsRepository.requestIssuanceAfterPayment). A record step that rolled back
// after the enqueue leaves a job that finds nothing to do: a cancellation's capture job captures only for a recorded
// cancellation (`isCancellationCaptureJob`), and the void never voids the payment of a booking that stands.
//
// Each job resolves its tenant through the platform cache (`active` or `suspended`: suspended tenants keep their
// obligations to paid travellers, OADR-0014 point 4; any other is skipped), then re-reads its row in a tenant
// transaction and does nothing when the state already moved (OADR-0010 point 6). The Stripe call goes through the
// PaymentGateway (StripeGateway, the payment's environment) outside any transaction, with the idempotency keys of
// OADR-0010 point 3, and its result is applied in a short transaction under the row's lock and with its `version`; a
// transaction that also changes the payment's booking, or writes a row that references it, locks the booking first,
// then the payment, and a refund's transaction locks the refund last (lead decision of 2026-10-21, OADR-0003 point 11:
// checkout, booking, payment, refund, a foreign-key lock counting as a lock of the parent):
//
//   payment.void            a payment that is not confirmed or `authorized`, with a PaymentIntent: `pi:cancel:<pay_id>`,
//                           then `canceled` (`payment.voided`). Captured, cancelled, failed or airline-card payments
//                           make no Stripe call, and neither does the payment of a booking whose order exists
//                           (`confirmed`, `ticketed`, `partially_ticketed`): it is captured, never voided.
//   payment.capture_retry   an `authorized` payment of a booking that still stands (`confirmed`, `ticketed`,
//                           `partially_ticketed`; never a payment without one): `pi:capture:<pay_id>:<amount>` with
//                           the amount of the orchestrator's `payment.capture_failed` event, or without one (a safety
//                           net, below) the booking's total, within the authorisation (so the key is the first
//                           capture's: a capture whose answer was lost is found again), then `captured`
//                           (`payment.captured`), the booking's `amount_paid` and its `payment.captured` event. It runs
//                           once: when it cannot capture, the staff are alerted (OADR-0008 point 7, "then staff"). The
//                           booking of a failed capture keeps `ticketing_status = manual_review` either way: staff
//                           issue it (a safety net's booking that waits for its issuance is made due, above).
//                           Of a `cancelled` booking whose `booking.cancelled` event names the payment
//                           (`capturePaymentId`; lead decision (1) of 2026-10-23, second batch, FIX-W28-CANCEL): the
//                           amount the cancellation keeps (`captureAmount`) with `pi:capture:<pay_id>:cancellation:
//                           <amount>`, the key of the request's capture, then besides the events above the release
//                           (RefundsRepository.recordRelease: the rest of the authorisation as the customer's refund,
//                           `succeeded`, requested by whoever cancelled, the customer, the staff or the system, as the
//                           event's `cancelledBy` and actor say: FIX-W30-OTA; and the booking's `refund.succeeded`),
//                           once. When it cannot capture, the
//                           alert asks the staff to capture the kept amount or release the authorisation, and a
//                           `payment.capture_failed` event with `final` makes the cancellation's `refundStatus`
//                           `manual_review`; the cancellation stands either way.
//   refund.submit           a refund row is claimed (`processing`, committed before the call; refunds.repository.ts) and
//                           sent as `refund:<rfd_id>` with its metadata; the Stripe refund's id is recorded and the row
//                           stays `processing`: its final state and the payment's refunded amount come from the webhook
//                           (OBE-039). A row already sent, or final, makes no call; a claim in flight is left to its job.
//
// Failures. A call that got no answer, a rate limit, a concurrent request with the same key or an account that cannot
// serve now (`424`) is tried again by BullMQ (ADR-0009 defaults) with the same key, which finds a result Stripe kept.
// After a refusal (a 4xx) or a 5xx (which Stripe keeps as the answer of the key for 24 hours, so the same key cannot
// succeed), and after the last attempt, the job reads the PaymentIntent again and applies what Stripe holds now (an
// authorisation that expired, a capture made elsewhere); when that is not what the job wanted, the staff are alerted
// (outbox `staff.manual_review` to `ops_alert_email`, else the owners, else OPS_ALERT_EMAIL, once per payment or refund
// and kind; notifications/staff-recipients.ts) and the job ends. A refund Stripe refused is `failed` (the cancellation
// stands, flows/change-and-cancel.md §4); one whose outcome is unknown is released (`pending`; the webhook still finds
// it by its `refund_id`) and alerted, once Stripe kept the answer or after the last attempt whatever its error (since
// FIX-W28-FOLLOWUPS, lead decision (7) of 2026-10-23, second batch, an error that is not a provider failure too). A
// refund whose job failed before its claim was never sent: the refunds sweep sends it again (refunds-sweep.processor.ts).
// A PaymentIntent whose metadata names another tenant or payment is a security event (logged by the gateway) and
// changes nothing.
//
// Log lines carry ids, job names, outcomes, statuses and Stripe's error codes, never a Stripe object, an e-mail address
// or a payload.
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { sql } from "@velexis/db";
import { AppError } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import { UnrecoverableError, type Job } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { OTA_QUEUE, otaWorkerOptions } from "../common/queues/queue-names";
import type { WorkerConfig } from "../config";
import { jobTenant } from "../jobs/fan-out";
import { InvalidNotificationError } from "../notifications/outbox.service";
import { StaffRecipients } from "../notifications/staff-recipients";
import { Money } from "../pricing/pricing.types";
import { PlatformCache } from "../tenancy/platform-cache";
import type { TenantStatus } from "../tenancy/platform-read.types";
import { TenantContext } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import {
  PAYMENT_GATEWAY,
  recordedPaymentAccount,
  type GatewayContext,
  type GatewayPayment,
  type GatewayRefundState,
  type GatewayState,
  type PaymentGateway,
} from "./payment-gateway";
import { providerStateUpdate } from "./payment-state";
import { PaymentsRepository, type LockedBookingRow, type PaymentRow } from "./payments.repository";
import {
  cancellationRequesterOf,
  REFUND_REASONS,
  RefundsRepository,
  refundSubmission,
  type RefundJobRow,
  type RefundReason,
  type RefundRequester,
} from "./refunds.repository";
import { StripeCallError, StripeMetadataMismatchError } from "./stripe/stripe.gateway";

// ---- Jobs ----------------------------------------------------------------------------------------------------------

/** The jobs of `ota-payments` (architecture §6). */
export const PAYMENT_JOB = Object.freeze({
  void: "payment.void",
  captureRetry: "payment.capture_retry",
  refundSubmit: "refund.submit",
} as const);
export type PaymentJobName = (typeof PAYMENT_JOB)[keyof typeof PAYMENT_JOB];

const PAYMENT_JOB_NAMES: readonly string[] = Object.freeze(Object.values(PAYMENT_JOB));

/** Whether `name` is a job of `ota-payments`. */
export function isPaymentJobName(name: unknown): name is PaymentJobName {
  return typeof name === "string" && PAYMENT_JOB_NAMES.includes(name);
}

/** The payload of every job of `ota-payments`: the tenant and the payment (`pay_…`) or, for refund.submit, the refund. */
export interface PaymentJobData {
  readonly tenantId: string;
  readonly id: string;
}

const TENANT_ID = /^ten_[0-9A-Za-z_]{1,60}$/;
const PAYMENT_ID = /^pay_[0-9A-Za-z_]{1,60}$/;
const REFUND_ID = /^rfd_[0-9A-Za-z_]{1,60}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The payload of a job `name`, or `undefined` when it is not one (an id of another kind, extra fields included). */
export function parsePaymentJobData(name: PaymentJobName, data: unknown): PaymentJobData | undefined {
  if (!isRecord(data) || Object.keys(data).length !== 2) {
    return undefined;
  }
  const { tenantId, id } = data;
  const idPattern = name === PAYMENT_JOB.refundSubmit ? REFUND_ID : PAYMENT_ID;
  return typeof tenantId === "string" &&
    TENANT_ID.test(tenantId) &&
    typeof id === "string" &&
    idPattern.test(id)
    ? { tenantId, id }
    : undefined;
}

/** The first part of each job's deterministic BullMQ id (`<prefix>-<id>`). */
const JOB_ID_PREFIX: Readonly<Record<PaymentJobName, string>> = Object.freeze({
  "payment.void": "payment-void",
  "payment.capture_retry": "capture-retry",
  "refund.submit": "refund-submit",
});

/**
 * A job of `ota-payments` as `Queue.add` takes it: its name, `{tenantId, id}` and the job id `<prefix>-<id>`, so BullMQ
 * holds one job per payment and job (completed ones for a day, failed ones for 30, ADR-0009) however often it is added.
 * A producer adds its own options (the 10-minute `delay` of a capture retry).
 */
export function paymentJob(
  name: PaymentJobName,
  tenantId: string,
  id: string,
): {
  readonly name: PaymentJobName;
  readonly data: PaymentJobData;
  readonly opts: { readonly jobId: string };
} {
  return { name, data: { tenantId, id }, opts: { jobId: `${JOB_ID_PREFIX[name]}-${id}` } };
}

/**
 * The `payment.capture_retry` of the amount a cancellation keeps (FIX-W28-CANCEL): the job of `paymentJob` under the
 * id `capture-retry-cancellation-<pay_id>`, so it never meets the job of a capture of the order that failed earlier
 * (BullMQ keeps a finished job for a day, and would ignore a second one with its id). The producer adds the delay.
 */
export function cancellationCaptureRetryJob(
  tenantId: string,
  paymentId: string,
): {
  readonly name: PaymentJobName;
  readonly data: PaymentJobData;
  readonly opts: { readonly jobId: string };
} {
  const job = paymentJob(PAYMENT_JOB.captureRetry, tenantId, paymentId);
  return { ...job, opts: { jobId: `${CANCELLATION_CAPTURE_JOB_PREFIX}${paymentId}` } };
}

/** The first part of the job id of a cancellation's capture retry (`cancellationCaptureRetryJob`). */
export const CANCELLATION_CAPTURE_JOB_PREFIX = "capture-retry-cancellation-";

/** True for the job id of a cancellation's capture retry or safety net: it captures only for a recorded cancellation. */
export function isCancellationCaptureJob(jobId: string): boolean {
  return jobId.startsWith(CANCELLATION_CAPTURE_JOB_PREFIX);
}

/** What a safety net covers (see the file header). */
export type SafetyNetKind = "capture" | "cancellation_capture" | "cancellation_void";

/** How long the add of a safety net may wait for Redis inside its record step's transaction. */
export const SAFETY_NET_ENQUEUE_TIMEOUT_MS = 2000;

/**
 * The safety net of a capture or a void that runs after a commit (see the file header): the job, delayed `delayMs`,
 * removed once it completed.
 */
export function safetyNetJob(
  kind: SafetyNetKind,
  tenantId: string,
  paymentId: string,
  delayMs: number,
): {
  readonly name: PaymentJobName;
  readonly data: PaymentJobData;
  readonly opts: { readonly jobId: string; readonly delay: number; readonly removeOnComplete: true };
} {
  const job =
    kind === "capture"
      ? paymentJob(PAYMENT_JOB.captureRetry, tenantId, paymentId)
      : kind === "cancellation_capture"
        ? cancellationCaptureRetryJob(tenantId, paymentId)
        : {
            ...paymentJob(PAYMENT_JOB.void, tenantId, paymentId),
            opts: { jobId: `payment-void-cancellation-${paymentId}` },
          };
  return { ...job, opts: { jobId: job.opts.jobId, delay: delayMs, removeOnComplete: true } };
}

/**
 * Adds a safety net (`safetyNetJob`) from inside its record step's transaction, before the commit: waits at most
 * SAFETY_NET_ENQUEUE_TIMEOUT_MS for Redis and never throws. Answers `added`, or why not (the caller logs it: without
 * the net, the call after the commit still runs, and its failure path still queues its retry).
 */
export async function addSafetyNet(
  queue: { add(name: string, data: unknown, opts: Record<string, unknown>): Promise<unknown> },
  job: ReturnType<typeof safetyNetJob>,
  timeoutMs: number = SAFETY_NET_ENQUEUE_TIMEOUT_MS,
): Promise<"added" | "failed" | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const added = queue.add(job.name, job.data, { ...job.opts }).then(
    () => "added" as const,
    () => "failed" as const,
  );
  const timedOut = new Promise<"timeout">((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout("timeout"), timeoutMs);
  });
  try {
    return await Promise.race([added, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** The tenant statuses whose payment jobs run (OADR-0014 point 4); the others are skipped. */
export const PAYMENT_JOB_TENANT_STATUSES: readonly TenantStatus[] = Object.freeze(["active", "suspended"]);

/** The attempt of a job the handler runs. */
export interface PaymentJobAttempt {
  /** The BullMQ job id: the request id of the job's provider calls and events. */
  readonly jobId: string;
  /** True when BullMQ will not try the job again if this attempt fails. */
  readonly last: boolean;
}

/** The attempt of `job`: its id and whether it is the last one its options allow. */
export function attemptOf(job: Pick<Job, "id" | "name" | "attemptsMade" | "opts">): PaymentJobAttempt {
  const attempts =
    typeof job.opts.attempts === "number" && Number.isInteger(job.opts.attempts) && job.opts.attempts > 0
      ? job.opts.attempts
      : 1;
  return { jobId: job.id ?? job.name, last: job.attemptsMade + 1 >= attempts };
}

/** What one job did. */
export type PaymentJobOutcome = "applied" | "unchanged" | "missing" | "ignored" | "failed";

/** What a finished job returns (BullMQ keeps it with the job): ids and the outcome, never more. */
export type PaymentJobResult =
  | {
      readonly tenantId: string;
      readonly job: PaymentJobName;
      readonly id: string;
      readonly outcome: PaymentJobOutcome;
    }
  | {
      readonly tenantId: string;
      readonly job: PaymentJobName;
      readonly id: string;
      readonly outcome: "skipped";
      readonly reason: string;
    };

// ---- Rules -----------------------------------------------------------------------------------------------------------

/** The payment statuses a void cancels: not confirmed yet, or authorised. */
export const VOIDABLE_STATUSES: readonly string[] = Object.freeze([
  "requires_payment_method",
  "requires_action",
  "processing",
  "authorized",
]);

/** The payment statuses of a captured payment. */
export const CAPTURED_STATUSES: readonly string[] = Object.freeze([
  "captured",
  "partially_refunded",
  "refunded",
]);

/** The booking statuses of an order that exists: its payment is captured. */
const BOOKED_STATUSES: readonly string[] = Object.freeze(["confirmed", "ticketed", "partially_ticketed"]);

/** How a failed provider call ends (see the file header). */
export type ProviderFailure =
  /** No answer, a rate limit, a concurrent request with the key, or an account that cannot serve now: try again. */
  | "retry"
  /** Stripe answered a 5xx, which it keeps as the answer of the key: the outcome is unknown and the key cannot tell. */
  | "kept"
  /** Stripe refused the request (a 4xx): nothing happened. */
  | "refused"
  /** The PaymentIntent read back names another tenant or payment. */
  | "mismatch";

/** How a provider failure ends, or `undefined` when `error` is not one (a database error: BullMQ retries the job). */
export function providerFailureOf(error: unknown): ProviderFailure | undefined {
  if (!(error instanceof AppError)) {
    return undefined;
  }
  if (error.code === "PAYMENT_PROVIDER_NOT_CONFIGURED") {
    return "retry";
  }
  if (error.code !== "PAYMENT_PROVIDER_ERROR") {
    return undefined;
  }
  const cause = error.cause;
  if (cause instanceof StripeMetadataMismatchError) {
    return "mismatch";
  }
  if (!(cause instanceof StripeCallError)) {
    return "retry";
  }
  const status = cause.statusCode;
  if (status === null || status === 409 || status === 429) {
    return "retry";
  }
  return status >= 500 ? "kept" : "refused";
}

/** A code for logs and `refunds.failure_reason`: Stripe's error code, else the error's code; never a message. */
export function failureCodeOf(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (
    cause instanceof StripeCallError &&
    cause.stripeCode !== null &&
    /^[a-z0-9_]{1,64}$/.test(cause.stripeCode)
  ) {
    return cause.stripeCode;
  }
  if (cause instanceof StripeCallError) {
    return cause.statusCode === null ? "provider_unreachable" : `provider_http_${cause.statusCode}`;
  }
  if (error instanceof AppError) {
    return error.code;
  }
  return error instanceof Error ? error.name : "unknown_error";
}

/** A decimal amount as `payment_events.payload.amount` holds it. */
const DECIMAL = /^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,6})?$/;

/**
 * The amount a capture retry captures, with `minorUnits` decimals: the amount of the failed capture (so the
 * idempotency key `pi:capture:<pay_id>:<amount>` is the first attempt's), when it is a positive amount within the
 * authorisation; else the amount authorised, else the payment's amount.
 */
export function captureAmountOf(
  recorded: string | null,
  payment: Pick<PaymentRow, "amount" | "amountAuthorized">,
  minorUnits: number,
): string {
  const authorized = new Money(payment.amountAuthorized);
  const ceiling = authorized.greaterThan(0) ? authorized : new Money(payment.amount);
  if (recorded !== null && DECIMAL.test(recorded)) {
    const value = new Money(recorded);
    if (value.greaterThan(0) && value.lessThanOrEqualTo(ceiling)) {
      return value.toFixed(minorUnits);
    }
  }
  return ceiling.toFixed(minorUnits);
}

/** A provider call failed in a way that may pass: BullMQ tries the job again, with the same idempotency key. */
export class PaymentProviderUnavailableError extends Error {
  override readonly name = "PaymentProviderUnavailableError";
}

/** Another job's submission of the refund is in flight: this one waits for BullMQ's next attempt. */
export class RefundSubmissionInFlightError extends Error {
  override readonly name = "RefundSubmissionInFlightError";
}

// ---- Queries of the jobs ---------------------------------------------------------------------------------------------

/** The amount of the payment's last `payment.capture_failed` event (booking-orchestrator.service.ts), if any. */
export async function recordedCaptureAmount(
  trx: TenantTransaction,
  paymentId: string,
): Promise<string | null> {
  const row = await trx
    .selectFrom("payment_events")
    .select(sql<string | null>`payload ->> 'amount'`.as("amount"))
    .where("payment_id", "=", paymentId)
    .where("type", "=", "payment.capture_failed")
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  return typeof row?.amount === "string" ? row.amount : null;
}

/** The capture a cancellation asked for of a payment (FIX-W28-CANCEL, see the file header). */
export interface CancellationCapture {
  /** The amount the cancellation keeps, as its `booking.cancelled` event recorded it (`captureAmount`). */
  readonly amount: string;
  /** The reason of the release's refund row (`refundReason`, refunds.reason). */
  readonly reason: RefundReason;
  /**
   * Who cancelled (`refunds.requested_by` of the release; `cancellationRequesterOf` of the event's `cancelledBy` and
   * actor, FIX-W30-OTA): the customer (`cus_…`, `null` for a guest), the staff (`stf_…`, `null` for a console key) or the
   * system.
   */
  readonly requestedBy: { readonly type: RefundRequester; readonly id: string | null };
}

/**
 * The capture the newest `booking.cancelled` event of the payment's booking asks for of this payment
 * (`capturePaymentId`, cancellation.service.ts: lead decision (1) of 2026-10-23, second batch), or `undefined`.
 */
export async function cancellationCaptureOf(
  trx: TenantTransaction,
  payment: Pick<PaymentRow, "id" | "bookingId">,
): Promise<CancellationCapture | undefined> {
  if (payment.bookingId === null) {
    return undefined;
  }
  const row = await trx
    .selectFrom("booking_events")
    .select(["actor_type as actorType", "actor_id as actorId", "data"])
    .where("booking_id", "=", payment.bookingId)
    .where("type", "=", "booking.cancelled")
    .where(sql<string>`data ->> 'capturePaymentId'`, "=", payment.id)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  const data = isRecord(row?.data) ? row.data : {};
  const amount = data["captureAmount"];
  if (row === undefined || typeof amount !== "string" || !DECIMAL.test(amount)) {
    return undefined;
  }
  const reason = data["refundReason"];
  return {
    amount,
    reason: (REFUND_REASONS as readonly unknown[]).includes(reason)
      ? (reason as RefundReason)
      : "customer_request",
    requestedBy: cancellationRequesterOf(data["cancelledBy"], { type: row.actorType, id: row.actorId }),
  };
}

/**
 * The total of the booking `bookingId`, or `null` without one: what checkout.complete and the reconciliation capture
 * (the priced offer the order was sent from), the amount of a capture retry without a failed capture's event (the
 * safety net after a crash between the record step and the capture, FIX-W29-OTA).
 */
async function bookingTotal(trx: TenantTransaction, bookingId: string | null): Promise<string | null> {
  if (bookingId === null) {
    return null;
  }
  const row = await trx
    .selectFrom("bookings")
    .select(sql<string>`total_amount::text`.as("total"))
    .where("id", "=", bookingId)
    .executeTakeFirst();
  return row?.total ?? null;
}

/** The status of the booking `bookingId`, or `null` without one. */
async function bookingStatus(trx: TenantTransaction, bookingId: string | null): Promise<string | null> {
  if (bookingId === null) {
    return null;
  }
  const row = await trx
    .selectFrom("bookings")
    .select("status")
    .where("id", "=", bookingId)
    .executeTakeFirst();
  return row?.status ?? null;
}

// ---- Staff alerts ----------------------------------------------------------------------------------------------------

/** The template of every alert of the payments queue and the authorisation watch. */
const ALERT_TEMPLATE = "staff.manual_review";

/** One staff alert about a payment. */
export interface PaymentAlert {
  /** Makes the alert once only (`notifications_dedupe_uq`), such as `staff.payment:<pay_id>:void_failed`. */
  readonly dedupeKey: string;
  /** What happened and what staff should do: ids, amounts and codes, never card data or a Stripe message. */
  readonly reason: string;
}

/**
 * The staff alerts about payments (outbox `staff.manual_review`): to the OTA's `ops_alert_email`, else its owners, else
 * OPS_ALERT_EMAIL (notifications/staff-recipients.ts, OBE-055), in the storefront's default locale, with the booking's
 * reference and a console link to the booking (or the payment).
 */
@Injectable()
export class PaymentAlerts {
  constructor(
    private readonly payments: PaymentsRepository,
    private readonly staffRecipients: StaffRecipients,
    private readonly config: ConfigService<WorkerConfig, true>,
    @InjectPinoLogger(PaymentAlerts.name) private readonly logger: PinoLogger,
  ) {}

  /** Queues the alert in `trx`; answers whether a new e-mail was queued (`false` for a repeated dedupe key). */
  async send(
    trx: TenantTransaction,
    payment: Pick<PaymentRow, "id" | "bookingId">,
    alert: PaymentAlert,
  ): Promise<boolean> {
    const facts = await this.payments.alertFacts(trx, payment.bookingId);
    const adminUrl = this.config.get("PUBLIC_OTA_ADMIN_URL");
    const consolePath =
      payment.bookingId === null ? `payments/${payment.id}` : `bookings/${payment.bookingId}`;
    try {
      const queued = await this.staffRecipients.enqueue(trx, {
        templateKey: ALERT_TEMPLATE,
        locale: facts.defaultLocale ?? "en",
        data: {
          booking: {
            reference: facts.bookingReference ?? "",
            recordLocator: facts.recordLocator ?? "",
            consoleUrl: new URL(consolePath, adminUrl.endsWith("/") ? adminUrl : `${adminUrl}/`).toString(),
          },
          review: { reason: alert.reason },
        },
        dedupeKey: alert.dedupeKey,
        bookingId: payment.bookingId,
      });
      return queued.queued;
    } catch (error) {
      if (!(error instanceof InvalidNotificationError)) {
        throw error;
      }
      this.logger.warn({ paymentId: payment.id }, "payments.staff_alert_invalid");
      return false;
    }
  }
}

// ---- The handler -----------------------------------------------------------------------------------------------------

/** A payment and what its job needs, as read at the start of the job. */
interface ReadPayment {
  readonly payment: PaymentRow;
  readonly minorUnits: number;
  /** The status of the payment's booking, `null` without one. */
  readonly bookingStatus: string | null;
}

/** What the claim of a refund found. */
type RefundClaim =
  | { readonly kind: "missing" | "done" | "in_flight" | "failed" }
  | {
      readonly kind: "claimed";
      readonly row: RefundJobRow;
      readonly payment: PaymentRow;
      readonly providerPaymentId: string;
      readonly version: number;
      readonly minorUnits: number;
    };

/** The provider call of a void or a capture retry. */
type PaymentCall = "void" | "capture";

/** The status each call wants. */
const GOAL: Readonly<Record<PaymentCall, string>> = Object.freeze({ void: "canceled", capture: "captured" });

/** The payment event of the status each call wants. */
const GOAL_EVENT: Readonly<Record<PaymentCall, string>> = Object.freeze({
  void: "payment.voided",
  capture: "payment.captured",
});

/** Runs the jobs of `ota-payments` inside the job's tenant context (see the file header). */
@Injectable()
export class PaymentJobsHandler {
  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly payments: PaymentsRepository,
    private readonly refunds: RefundsRepository,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly alerts: PaymentAlerts,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    @InjectPinoLogger(PaymentJobsHandler.name) private readonly logger: PinoLogger,
  ) {}

  async run(name: PaymentJobName, id: string, attempt: PaymentJobAttempt): Promise<PaymentJobOutcome> {
    switch (name) {
      case PAYMENT_JOB.void:
        return await this.voidPayment(id, attempt);
      case PAYMENT_JOB.captureRetry:
        return await this.retryCapture(id, attempt);
      case PAYMENT_JOB.refundSubmit:
        return await this.submitRefund(id, attempt);
    }
  }

  // ---- payment.void --------------------------------------------------------------------------------------------------

  private async voidPayment(paymentId: string, attempt: PaymentJobAttempt): Promise<PaymentJobOutcome> {
    const read = await this.tx.run((trx) => this.read(trx, paymentId));
    if (read === undefined) {
      return this.missing(PAYMENT_JOB.void, paymentId);
    }
    const { payment } = read;
    if (payment.provider !== "stripe" || payment.providerPaymentId === null) {
      // An airline-card payment (the airline charged the card) or one that never reached Stripe: nothing to void.
      this.logger.info({ paymentId, provider: payment.provider }, "payments.void_not_applicable");
      return "ignored";
    }
    if (!VOIDABLE_STATUSES.includes(payment.status)) {
      this.logger.info({ paymentId, status: payment.status }, "payments.void_not_needed");
      return "unchanged";
    }
    if (read.bookingStatus !== null && BOOKED_STATUSES.includes(read.bookingStatus)) {
      // The payment now pays for an order that exists (a checkout that expired while it was completed, say): it is
      // captured, never voided; a cancellation cancels the booking before it voids.
      this.logger.warn({ paymentId, bookingStatus: read.bookingStatus }, "payments.void_refused_booked");
      return "unchanged";
    }
    const ctx = this.context(payment, attempt);
    let state: GatewayState;
    try {
      state = await this.gateway.void(ctx, this.gatewayPayment(read));
    } catch (error) {
      return await this.afterCallFailure("void", read, ctx, attempt, error);
    }
    return await this.applyState(read, state, "void", attempt);
  }

  // ---- payment.capture_retry -----------------------------------------------------------------------------------------

  private async retryCapture(paymentId: string, attempt: PaymentJobAttempt): Promise<PaymentJobOutcome> {
    const read = await this.tx.run(async (trx) => {
      const found = await this.read(trx, paymentId);
      if (found === undefined) {
        return undefined;
      }
      const capturable =
        found.payment.provider === "stripe" &&
        found.payment.providerPaymentId !== null &&
        found.payment.status === "authorized";
      // The kept amount of a cancelled booking (FIX-W28-CANCEL): its `booking.cancelled` event names the payment.
      const cancellation =
        found.bookingStatus === "cancelled" ? await cancellationCaptureOf(trx, found.payment) : undefined;
      // The amount of the failed capture, else (the safety net after a crash, FIX-W29-OTA) the booking's total.
      return {
        ...found,
        cancellation,
        recorded:
          cancellation?.amount ??
          (capturable
            ? ((await recordedCaptureAmount(trx, paymentId)) ??
              (await bookingTotal(trx, found.payment.bookingId)))
            : null),
      };
    });
    if (read === undefined) {
      return this.missing(PAYMENT_JOB.captureRetry, paymentId);
    }
    const { payment, cancellation } = read;
    if (payment.provider !== "stripe" || payment.providerPaymentId === null) {
      this.logger.info({ paymentId, provider: payment.provider }, "payments.capture_not_applicable");
      return "ignored";
    }
    if (cancellation === undefined && isCancellationCaptureJob(attempt.jobId)) {
      // The safety net of a cancellation whose record step rolled back (FIX-W29-OTA): nothing was cancelled, so the
      // order's money is not this job's to capture.
      this.logger.info({ paymentId, bookingStatus: read.bookingStatus }, "payments.capture_not_needed");
      return "unchanged";
    }
    if (
      cancellation === undefined &&
      (read.bookingStatus === null || !BOOKED_STATUSES.includes(read.bookingStatus))
    ) {
      // No order stands behind the payment (none was made, or the booking failed or was cancelled without keeping
      // anything): money is never captured without an order (OADR-0008), but for what a cancellation keeps.
      this.logger.info({ paymentId, bookingStatus: read.bookingStatus }, "payments.capture_not_needed");
      return "unchanged";
    }
    if (CAPTURED_STATUSES.includes(payment.status)) {
      // Captured meanwhile (a capture whose answer was lost, seen by the webhook; staff): the booking shows it, and a
      // cancellation's release is recorded.
      await this.tx.run(async (trx) => {
        const booking = await this.lockBookingOf(trx, payment);
        await this.recordBookingPayment(trx, booking, payment, payment.amountCaptured, attempt, cancellation);
        if (cancellation !== undefined) {
          await this.recordRelease(trx, payment, payment.amountCaptured, cancellation, attempt);
        } else {
          await this.requestIssuance(trx, booking, payment, attempt);
        }
      });
      return "unchanged";
    }
    if (payment.status !== "authorized") {
      // The authorisation is gone (cancelled, expired): nothing can be captured any more.
      await this.tx.run((trx) =>
        this.alerts.send(trx, payment, {
          dedupeKey: `staff.payment:${payment.id}:capture_retry_failed`,
          reason:
            cancellation === undefined
              ? `The card payment ${payment.id} (${payment.amount} ${payment.currency}) could not be captured: its ` +
                `authorisation is ${payment.status} at Stripe, so the booking is not paid. Contact the customer or ` +
                "cancel the booking."
              : `The amount the cancellation of this booking keeps (${cancellation.amount} ${payment.currency}) ` +
                `could not be captured from the card payment ${payment.id}: its authorisation is ${payment.status} at ` +
                "Stripe, so nothing was charged. Ask the customer for the cancellation fee, or waive it.",
        }),
      );
      this.logger.warn({ paymentId, status: payment.status }, "payments.capture_retry_impossible");
      return "failed";
    }
    const amount = captureAmountOf(read.recorded, payment, read.minorUnits);
    const ctx = this.context(payment, attempt);
    let state: GatewayState;
    try {
      state = await this.gateway.capture(
        ctx,
        this.gatewayPayment(read),
        amount,
        cancellation === undefined ? "booking" : "cancellation",
      );
    } catch (error) {
      return await this.afterCallFailure("capture", read, ctx, attempt, error, amount, cancellation);
    }
    return await this.applyState(read, state, "capture", attempt, cancellation);
  }

  /**
   * Records the release of a cancellation's capture (RefundsRepository.recordRelease: the authorisation less what was
   * captured, as the customer's refund, `succeeded`) with the customer-visible `refund.succeeded`, once, in `trx`,
   * which locked the payment's booking and the payment first (OADR-0003 point 11: the refund comes last).
   */
  private async recordRelease(
    trx: TenantTransaction,
    payment: PaymentRow,
    captured: string,
    cancellation: CancellationCapture,
    attempt: PaymentJobAttempt,
  ): Promise<void> {
    if (payment.bookingId === null) {
      return;
    }
    const now = this.clock.now();
    const kept = new Money(captured);
    const authorised = Money.max(new Money(payment.amountAuthorized), kept);
    const released = await this.refunds.recordRelease(trx, {
      id: this.ids.newId("rfd"),
      paymentId: payment.id,
      bookingId: payment.bookingId,
      amount: authorised.minus(kept).toFixed(2),
      kept: kept.toFixed(2),
      reason: cancellation.reason,
      requestedBy: cancellation.requestedBy,
      source: "system",
      now,
    });
    if (released !== undefined) {
      await this.payments.insertRefundBookingEvent(trx, {
        id: this.ids.newId("evt"),
        kind: "succeeded",
        bookingId: payment.bookingId,
        refundId: released.id,
        paymentId: payment.id,
        amount: released.amount,
        currency: released.currency,
        actor: { type: "system", id: null },
        requestId: attempt.jobId,
        now: new Date(now.getTime() + 1),
      });
    }
  }

  // ---- Shared by void and capture ------------------------------------------------------------------------------------

  /**
   * After a failed void or capture: a failure that may pass is tried again by BullMQ (until the last attempt); otherwise
   * the PaymentIntent is read again and what Stripe holds is applied, and when that is not what the job wanted the
   * staff are alerted and the job ends `failed`.
   */
  private async afterCallFailure(
    call: PaymentCall,
    read: ReadPayment,
    ctx: GatewayContext,
    attempt: PaymentJobAttempt,
    error: unknown,
    amount?: string,
    cancellation?: CancellationCapture,
  ): Promise<PaymentJobOutcome> {
    const failure = providerFailureOf(error);
    if (failure === undefined) {
      throw error;
    }
    const { payment } = read;
    const code = failureCodeOf(error);
    this.logger.warn(
      { paymentId: payment.id, jobId: attempt.jobId, failure, code, last: attempt.last },
      call === "void" ? "payments.void_failed" : "payments.capture_retry_failed",
    );
    if (failure === "mismatch") {
      // The gateway logged the security event. The PaymentIntent is not this payment's: nothing changes, no retry.
      throw new UnrecoverableError(`the PaymentIntent of ${payment.id} names another tenant or payment`);
    }
    if (failure === "retry" && !attempt.last) {
      throw new PaymentProviderUnavailableError(`Stripe could not ${call} ${payment.id} now (${code})`);
    }
    // What Stripe holds now: a lost answer may have done it, or the PaymentIntent moved (expired, captured elsewhere).
    const state = await this.refreshed(ctx, read);
    if (state !== undefined) {
      const outcome = await this.applyState(read, state, call, attempt, cancellation);
      if (state.status === GOAL[call]) {
        return outcome;
      }
    }
    const status = state?.status ?? payment.status;
    await this.tx.run(async (trx) => {
      if (cancellation !== undefined) {
        // The staff decide now (`refundStatus: manual_review`, bookings.mapper.ts): the payment's booking before the
        // payment, as the event and the alert's outbox row reference them (OADR-0003 point 11).
        await this.lockBookingOf(trx, payment, "key share");
        await this.paymentEvent(trx, payment, attempt, this.clock.now(), {
          type: "payment.capture_failed",
          payload: {
            bookingId: payment.bookingId,
            amount: amount ?? cancellation.amount,
            purpose: "cancellation",
            code,
            final: true,
          },
        });
      }
      await this.alerts.send(trx, payment, {
        dedupeKey: `staff.payment:${payment.id}:${call === "void" ? "void_failed" : "capture_retry_failed"}`,
        reason:
          call === "void"
            ? voidFailedReason(payment, status, code)
            : cancellation === undefined
              ? captureFailedReason(payment, amount, code)
              : keptCaptureFailedReason(payment, amount ?? cancellation.amount, code),
      });
    });
    return "failed";
  }

  /** The PaymentIntent read again, or `undefined` when it cannot be read now. */
  private async refreshed(ctx: GatewayContext, read: ReadPayment): Promise<GatewayState | undefined> {
    try {
      return await this.gateway.refresh(ctx, this.gatewayPayment(read));
    } catch (error) {
      if (providerFailureOf(error) === undefined) {
        throw error;
      }
      return undefined;
    }
  }

  /**
   * Applies a PaymentIntent state under the row's lock and with its `version` (payment-state.ts says what it may
   * change), with a payment event; a capture also shows on the booking, whose lock is taken first (the lock order of a
   * transaction that locks a booking and its payment: the booking, then the payment; OADR-0003 point 11).
   */
  private async applyState(
    read: ReadPayment,
    state: GatewayState,
    call: PaymentCall,
    attempt: PaymentJobAttempt,
    cancellation?: CancellationCapture,
  ): Promise<PaymentJobOutcome> {
    return await this.tx.run(async (trx) => {
      const now = this.clock.now();
      const booking = call === "capture" ? await this.lockBookingOf(trx, read.payment) : undefined;
      const current = await this.payments.payment(trx, read.payment.id, true);
      if (current === undefined) {
        return "missing";
      }
      const update = providerStateUpdate(current, state, now);
      let outcome: PaymentJobOutcome = "unchanged";
      if (update.kind === "refused") {
        this.logger.info(
          { paymentId: current.id, from: update.from, to: update.to, jobId: attempt.jobId },
          "payments.provider_state_not_applied",
        );
      } else if (update.kind === "apply") {
        if (!(await this.payments.updatePayment(trx, current.id, current.version, update.values))) {
          throw new Error("the payment changed while its locked row was updated");
        }
        const amount =
          update.status === "captured"
            ? update.values["amount_captured"]
            : update.status === "authorized"
              ? update.values["amount_authorized"]
              : undefined;
        await this.paymentEvent(trx, current, attempt, now, {
          type: update.status === GOAL[call] ? GOAL_EVENT[call] : `payment.${update.status}`,
          statusFrom: current.status,
          statusTo: update.status,
          amount: typeof amount === "string" ? amount : undefined,
          payload: { job: call === "void" ? PAYMENT_JOB.void : PAYMENT_JOB.captureRetry },
        });
        outcome = "applied";
      }
      if (call === "capture" && state.status === "captured") {
        const captured = Money.min(new Money(state.amountReceived), new Money(current.amount)).toFixed(2);
        if (await this.recordBookingPayment(trx, booking, current, captured, attempt, cancellation)) {
          outcome = "applied";
        }
        if (cancellation !== undefined) {
          await this.recordRelease(trx, current, captured, cancellation, attempt);
        } else {
          await this.requestIssuance(trx, booking, current, attempt);
        }
      }
      return outcome;
    });
  }

  /**
   * After an order's payment is captured by this job (not a cancellation's): the issuance that checkout.complete's
   * step 5 or the reconciliation would have asked for right after their capture, when the booking still waits for it
   * (`PaymentsRepository.requestIssuanceAfterPayment`: `issue_after_payment`, never asked). Only a safety net after a
   * process that stopped between a record step and its capture, or between the capture and the issuance, finds such a
   * booking (FIX-W29-OTA): the ticketing scan then issues it, as it would issue a failed attempt's retry. A failed
   * capture's retry finds the booking in `manual_review` (staff issue it), and the normal path finds it asked for.
   */
  private async requestIssuance(
    trx: TenantTransaction,
    booking: LockedBookingRow | undefined,
    payment: Pick<PaymentRow, "id" | "bookingId">,
    attempt: PaymentJobAttempt,
  ): Promise<void> {
    if (booking === undefined || booking.id !== payment.bookingId) {
      return;
    }
    if (await this.payments.requestIssuanceAfterPayment(trx, booking.id, this.clock.now())) {
      this.logger.info(
        { paymentId: payment.id, bookingId: booking.id, jobId: attempt.jobId },
        "payments.issuance_requested",
      );
    }
  }

  /**
   * The payment's booking, locked `FOR UPDATE` before the payment is (`PaymentsRepository.lockBookings`); `undefined`
   * without one.
   */
  private async lockBookingOf(
    trx: TenantTransaction,
    payment: Pick<PaymentRow, "bookingId">,
    mode: "update" | "key share" = "update",
  ): Promise<LockedBookingRow | undefined> {
    if (payment.bookingId === null) {
      return undefined;
    }
    const [booking] = await this.payments.lockBookings(trx, [payment.bookingId], mode);
    return booking;
  }

  /**
   * Shows a capture on the payment's booking, which the transaction locked before the payment (`lockBookingOf`):
   * `amount_paid` (captured payments) and a `payment.captured` booking event the customer sees, once (nothing when the
   * booking shows the amount already). Answers whether it changed the booking.
   */
  private async recordBookingPayment(
    trx: TenantTransaction,
    booking: LockedBookingRow | undefined,
    payment: Pick<PaymentRow, "id" | "bookingId">,
    captured: string,
    attempt: PaymentJobAttempt,
    cancellation?: CancellationCapture,
  ): Promise<boolean> {
    if (payment.bookingId === null || !new Money(captured).greaterThan(0)) {
      return false;
    }
    if (booking?.id !== payment.bookingId) {
      // Not the booking this transaction locked first: it is never locked after the payment.
      this.logger.warn({ paymentId: payment.id }, "payments.booking_not_locked");
      return false;
    }
    if (new Money(booking.amountPaid).greaterThanOrEqualTo(captured)) {
      return false;
    }
    const now = this.clock.now();
    const amount = new Money(captured).toFixed(2);
    await trx
      .updateTable("bookings")
      .set({ amount_paid: amount, updated_at: now, version: sql`version + 1` })
      .where("id", "=", booking.id)
      .execute();
    await trx
      .insertInto("booking_events")
      .values({
        id: this.ids.newId("evt"),
        booking_id: booking.id,
        type: "payment.captured",
        actor_type: "system",
        actor_id: null,
        summary:
          cancellation === undefined
            ? "Payment received."
            : "The amount kept for the cancellation was charged; the rest of the payment was released.",
        data: JSON.stringify(
          cancellation === undefined
            ? { paymentId: payment.id, amount }
            : { paymentId: payment.id, amount, purpose: "cancellation" },
        ),
        visible_to_customer: true,
        request_id: attempt.jobId,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return true;
  }

  // ---- refund.submit -------------------------------------------------------------------------------------------------

  private async submitRefund(refundId: string, attempt: PaymentJobAttempt): Promise<PaymentJobOutcome> {
    const claim = await this.tx.run((trx) => this.claimRefund(trx, refundId, attempt));
    switch (claim.kind) {
      case "missing":
        return this.missing(PAYMENT_JOB.refundSubmit, refundId);
      case "done":
        this.logger.info({ refundId }, "payments.refund_already_submitted");
        return "unchanged";
      case "failed":
        return "failed";
      case "in_flight":
        if (attempt.last) {
          await this.alertRefund(refundId, "not_submitted", "provider_unconfirmed");
        }
        throw new RefundSubmissionInFlightError(`the refund ${refundId} is being submitted by another job`);
      case "claimed":
        break;
    }
    const { row, payment, providerPaymentId, minorUnits } = claim;
    const ctx = this.context(payment, attempt);
    let state: GatewayRefundState;
    try {
      state = await this.gateway.refund(ctx, {
        id: row.id,
        paymentId: payment.id,
        providerPaymentId,
        currency: row.currency,
        amount: new Money(row.amount).toFixed(minorUnits),
        minorUnits,
        // Where the payment lives (OBE-077): the refund is made on that account.
        account: recordedPaymentAccount(payment.metadata),
        connectionId: payment.providerConnectionId,
      });
    } catch (error) {
      return await this.afterRefundFailure(claim, attempt, error);
    }
    return await this.tx.run(async (trx) => {
      const now = this.clock.now();
      // The payment before the refund (its event below references the payment): `lockParents`.
      await this.refunds.lockParents(trx, row.id);
      const current = await this.refunds.refund(trx, row.id, true);
      if (current === undefined || current.providerRefundId !== null) {
        // The webhook recorded the refund first.
        return "unchanged";
      }
      await this.refunds.recordSubmission(trx, row.id, state.providerRefundId, now);
      await this.paymentEvent(trx, payment, attempt, now, {
        type: "refund.submitted",
        statusFrom: current.status,
        statusTo: current.status === "pending" ? "processing" : current.status,
        amount: row.amount,
        currency: row.currency,
        payload: { refundId: row.id, providerRefundId: state.providerRefundId, providerStatus: state.status },
      });
      this.logger.info({ refundId: row.id, providerStatus: state.status }, "payments.refund_submitted");
      return "applied";
    });
  }

  /** Claims the refund for this job's submission (refunds.repository.ts), in one short transaction. */
  private async claimRefund(
    trx: TenantTransaction,
    refundId: string,
    attempt: PaymentJobAttempt,
  ): Promise<RefundClaim> {
    const now = this.clock.now();
    // The payment's booking and the payment before the refund: a refused row's event and alert reference them.
    await this.refunds.lockParents(trx, refundId);
    const row = await this.refunds.refund(trx, refundId, true);
    if (row === undefined) {
      return { kind: "missing" };
    }
    const submission = refundSubmission(row, now);
    if (submission !== "submit") {
      return { kind: submission };
    }
    const payment = await this.payments.payment(trx, row.paymentId);
    if (payment === undefined || payment.provider !== "stripe" || payment.providerPaymentId === null) {
      // A row create() would have refused: never sent, failed for staff.
      if (await this.refunds.markFailed(trx, row.id, row.version, "payment_not_refundable", now)) {
        await this.refundFailed(trx, row, payment, attempt, now, {
          code: "payment_not_refundable",
          from: row.status,
        });
      }
      return { kind: "failed" };
    }
    if (row.status === "processing") {
      this.logger.warn(
        { refundId, claimedAt: row.updatedAt.toISOString() },
        "payments.refund_claim_abandoned",
      );
    }
    const version = await this.refunds.claim(trx, row.id, row.version, now);
    if (version === undefined) {
      throw new Error("the refund changed while its locked row was claimed");
    }
    const minorUnits = (await this.payments.currencyMinorUnits(trx, row.currency)) ?? 2;
    return {
      kind: "claimed",
      row,
      payment,
      providerPaymentId: payment.providerPaymentId,
      version,
      minorUnits,
    };
  }

  /**
   * After a failed submission: a refusal fails the refund (and alerts the staff); an unknown outcome releases the
   * claim, and is tried again by BullMQ when it may pass, else alerted; the last attempt alerts whatever the error.
   */
  private async afterRefundFailure(
    claim: Extract<RefundClaim, { kind: "claimed" }>,
    attempt: PaymentJobAttempt,
    error: unknown,
  ): Promise<PaymentJobOutcome> {
    const { row, payment, version } = claim;
    const failure = providerFailureOf(error);
    const code = failureCodeOf(error);
    this.logger.warn(
      { refundId: row.id, paymentId: payment.id, jobId: attempt.jobId, failure: failure ?? "error", code },
      "payments.refund_submit_failed",
    );
    if (failure === "refused" || failure === "mismatch") {
      await this.tx.run(async (trx) => {
        const now = this.clock.now();
        // The payment's booking and the payment before the refund (`lockParents`): the failure's event and alert
        // reference them. Before FIX-W25-BOOKINGS the refund was locked first, the reverse of the webhook's order.
        await this.refunds.lockParents(trx, row.id);
        if (await this.refunds.markFailed(trx, row.id, version, code, now)) {
          await this.refundFailed(trx, row, payment, attempt, now, { code, from: "processing" });
        }
      });
      return "failed";
    }
    // No answer, or one that cannot tell: the refund may exist at Stripe (the webhook finds it by its refund_id).
    let releaseFailure: { readonly error: unknown } | undefined;
    try {
      await this.tx.run((trx) => this.refunds.release(trx, row.id, version, this.clock.now()));
    } catch (releaseError) {
      if (!attempt.last) {
        // The claim stays until its lease ends; BullMQ's next attempt waits for it, then sends with the same key.
        throw releaseError;
      }
      releaseFailure = { error: releaseError };
    }
    if (failure === undefined && !attempt.last) {
      // Not a provider failure (a database error, say): BullMQ tries again, with the same key.
      throw error;
    }
    if (failure === "retry" && !attempt.last) {
      throw new PaymentProviderUnavailableError(`Stripe could not take the refund ${row.id} now (${code})`);
    }
    // An answer Stripe keeps for the key, or the last attempt whatever its error (since FIX-W28-FOLLOWUPS, lead decision
    // (7) of 2026-10-23, second batch, also an error that is not a provider failure, and a release that failed): the
    // refunds sweep never sends a claimed row again, so the staff check the payment before refunding again.
    await this.alertRefund(row.id, "not_submitted", code);
    if (releaseFailure !== undefined) {
      throw releaseFailure.error;
    }
    if (failure === undefined) {
      throw error;
    }
    if (failure === "retry") {
      throw new PaymentProviderUnavailableError(`Stripe could not take the refund ${row.id} (${code})`);
    }
    return "failed";
  }

  /** The event and the staff alert of a refund that failed before Stripe took it. */
  private async refundFailed(
    trx: TenantTransaction,
    row: RefundJobRow,
    payment: PaymentRow | undefined,
    attempt: PaymentJobAttempt,
    now: Date,
    failure: { readonly code: string; readonly from: string },
  ): Promise<void> {
    if (payment === undefined) {
      return;
    }
    // The alert's outbox row references the payment's booking, and the payment event the payment (their foreign keys
    // take FOR KEY SHARE on both): the caller took both locks before the refund's (`RefundsRepository.lockParents`,
    // OADR-0003 point 11).
    const { code } = failure;
    await this.paymentEvent(trx, payment, attempt, now, {
      type: "refund.failed",
      statusFrom: failure.from,
      statusTo: "failed",
      amount: row.amount,
      currency: row.currency,
      payload: { refundId: row.id, failureReason: code },
    });
    await this.alerts.send(trx, payment, {
      dedupeKey: `staff.refund:${row.id}:failed`,
      reason:
        `The refund ${row.id} of ${row.amount} ${row.currency} for the card payment ${payment.id} failed at Stripe ` +
        `(${code}). The cancellation stands: refund the customer another way or from the console.`,
    });
  }

  /** The staff alert of a refund whose submission could not be confirmed. */
  private async alertRefund(refundId: string, kind: "not_submitted", code: string): Promise<void> {
    await this.tx.run(async (trx) => {
      const row = await this.refunds.refund(trx, refundId);
      const payment = row === undefined ? undefined : await this.payments.payment(trx, row.paymentId);
      if (row === undefined || payment === undefined) {
        return;
      }
      await this.alerts.send(trx, payment, {
        dedupeKey: `staff.refund:${row.id}:${kind}`,
        reason:
          `The refund ${row.id} of ${row.amount} ${row.currency} for the card payment ${payment.id} could not be ` +
          `confirmed at Stripe (${code}). Check the payment in the console before refunding again.`,
      });
    });
  }

  // ---- Shared --------------------------------------------------------------------------------------------------------

  private async read(trx: TenantTransaction, paymentId: string): Promise<ReadPayment | undefined> {
    const payment = await this.payments.payment(trx, paymentId);
    if (payment === undefined) {
      return undefined;
    }
    return {
      payment,
      minorUnits: (await this.payments.currencyMinorUnits(trx, payment.currency)) ?? 2,
      bookingStatus: await bookingStatus(trx, payment.bookingId),
    };
  }

  private missing(job: PaymentJobName, id: string): PaymentJobOutcome {
    this.logger.warn({ job, id }, "payments.job_row_missing");
    return "missing";
  }

  /** The gateway context of a payment's job: the tenant, the payment's environment and the job id as request id. */
  private context(payment: Pick<PaymentRow, "environment">, attempt: PaymentJobAttempt): GatewayContext {
    return {
      tenantId: this.tenants.require().tenantId,
      environment: payment.environment === "live" ? "live" : "test",
      requestId: attempt.jobId,
    };
  }

  private gatewayPayment({ payment, minorUnits }: ReadPayment): GatewayPayment {
    return {
      id: payment.id,
      checkoutId: payment.checkoutId,
      providerPaymentId: payment.providerPaymentId,
      currency: payment.currency,
      amount: new Money(payment.amount).toFixed(minorUnits),
      minorUnits,
      version: payment.version,
      account: recordedPaymentAccount(payment.metadata),
      connectionId: payment.providerConnectionId,
    };
  }

  /** Appends a `payment_events` row (`source = system`) for what a job did. */
  private async paymentEvent(
    trx: TenantTransaction,
    payment: Pick<PaymentRow, "id" | "currency">,
    attempt: PaymentJobAttempt,
    now: Date,
    event: {
      readonly type: string;
      readonly statusFrom?: string | undefined;
      readonly statusTo?: string | undefined;
      readonly amount?: string | undefined;
      readonly currency?: string | undefined;
      readonly payload?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.payments.insertEvent(trx, {
      id: this.ids.newId("pev"),
      payment_id: payment.id,
      type: event.type,
      source: "system",
      status_from: event.statusFrom ?? null,
      status_to: event.statusTo ?? null,
      amount: event.amount ?? null,
      currency: event.amount === undefined ? null : (event.currency ?? payment.currency),
      payload: JSON.stringify(redactPayload({ ...event.payload, jobId: attempt.jobId })),
      created_at: now,
      updated_at: now,
    });
  }
}

/** The reason of the alert of a void that did not happen. */
function voidFailedReason(payment: PaymentRow, status: string, code: string): string {
  const what = `The authorisation of the card payment ${payment.id} (${payment.amount} ${payment.currency})`;
  return CAPTURED_STATUSES.includes(status)
    ? `${what} could not be voided: Stripe reports the payment captured. Refund it from the console if the booking ` +
        "did not go ahead."
    : `${what} could not be voided at Stripe (${code}): the customer's funds stay held until Stripe releases them, ` +
        "about 7 days after the authorisation. Check the payment in the console.";
}

/** The reason of the alert of a capture retry that did not capture. */
function captureFailedReason(payment: PaymentRow, amount: string | undefined, code: string): string {
  return (
    `The card payment ${payment.id} (${amount ?? payment.amount} ${payment.currency}) could not be captured again ` +
    `after the order was created (${code}), so the booking is not paid. Capture it from the console or contact the ` +
    "customer before issuing."
  );
}

/** The reason of the alert of a capture retry that did not capture what a cancellation keeps (FIX-W28-CANCEL). */
function keptCaptureFailedReason(payment: PaymentRow, amount: string, code: string): string {
  return (
    `The amount the cancellation of this booking keeps (${amount} ${payment.currency}: the cancellation fee and the ` +
    `fees that are not refunded) could not be captured from the card payment ${payment.id} after a second try ` +
    `(${code}). The cancellation stands, and the authorisation holds the customer's funds until Stripe releases ` +
    "them, about 7 days after the authorisation: capture the kept amount from the console, or release the " +
    "authorisation."
  );
}

// ---- The processor ---------------------------------------------------------------------------------------------------

/**
 * The consumer of `ota-payments` (architecture §6, concurrency 4): `payment.void`, `payment.capture_retry` and
 * `refund.submit` (see the file header); any other job fails at once.
 */
@Processor(OTA_QUEUE.payments, otaWorkerOptions(OTA_QUEUE.payments))
export class PaymentsProcessor extends WorkerHost {
  /** The message of the last worker error logged, so a Redis outage is logged once, not on every reconnection. */
  private lastWorkerError: string | undefined;

  constructor(
    private readonly handler: PaymentJobsHandler,
    private readonly cache: PlatformCache,
    private readonly tenants: TenantContext,
    @InjectPinoLogger(PaymentsProcessor.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job): Promise<PaymentJobResult> {
    const name = isPaymentJobName(job.name) ? job.name : undefined;
    const data = name === undefined ? undefined : parsePaymentJobData(name, job.data);
    if (name === undefined || data === undefined) {
      this.logger.error(
        { queue: job.queueName, jobId: job.id, jobName: String(job.name).slice(0, 64) },
        "payments.job_invalid",
      );
      throw new UnrecoverableError("the job is not a payment job {tenantId, id} of ota-payments");
    }
    const tenant = await this.cache.tenantById(data.tenantId);
    if (tenant === null || !PAYMENT_JOB_TENANT_STATUSES.includes(tenant.status)) {
      const reason = tenant === null ? "tenant_not_found" : `tenant_${tenant.status}`;
      this.logger.warn({ tenantId: data.tenantId, job: name, reason }, "payments.job_tenant_skipped");
      return { tenantId: data.tenantId, job: name, id: data.id, outcome: "skipped", reason };
    }
    const outcome = await this.tenants.run(jobTenant(tenant, job), () =>
      this.handler.run(name, data.id, attemptOf(job)),
    );
    this.logger.info({ tenantId: tenant.id, job: name, id: data.id, outcome }, "payments.job_processed");
    return { tenantId: tenant.id, job: name, id: data.id, outcome };
  }

  /** A job failed: logged with its id, attempt and the error's name, never the error (it may quote SQL). */
  @OnWorkerEvent("failed")
  onFailed(job: Job | undefined, error: Error): void {
    this.logger.error(
      {
        queue: OTA_QUEUE.payments,
        jobName: job === undefined ? undefined : String(job.name).slice(0, 64),
        jobId: job?.id,
        attempt: job?.attemptsMade,
        code: error.name,
      },
      "payments.job_failed",
    );
  }

  /** Errors of the worker itself (its Redis connections); job failures are the `failed` events above. */
  @OnWorkerEvent("error")
  onWorkerError(error: Error): void {
    if (error.message !== this.lastWorkerError) {
      this.lastWorkerError = error.message;
      this.logger.error({ queue: OTA_QUEUE.payments, err: error }, "queue.worker_error");
    }
  }

  /** A job became active: the worker's connection works again, so the next error is logged. */
  @OnWorkerEvent("active")
  onActive(): void {
    this.lastWorkerError = undefined;
  }
}
