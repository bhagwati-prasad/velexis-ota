// The reconciliation of a booking whose Flight Create Orders outcome is unknown (OBE-043; OADR-0003 points 4–6,
// ota/docs/architecture-booking.md §4, ota/docs/data-model.md §3.3). It runs in the worker only, for one booking of the
// tenant of the current job context (reconcile.processor.ts opens it), and no database transaction is open while
// Amadeus or Stripe is called.
//
// checkout.complete (booking-orchestrator.service.ts) leaves such a booking `pending` with its claim, its checkout
// (locked: CHECKOUT_BEING_COMPLETED) and the authorisation, sets `reconcile_until = create_order_started_at + 15
// minutes` and queues the first `booking.reconcile` 30 seconds later; `bookings.reconcile_scan` (every minute) queues
// the others.
//
// A claim nobody decides (lead decision of 2026-10-21, OADR-0003 point 4): when the process died between the claim and
// Flight Create Orders, or the unknown-outcome write itself failed (`bookings.reconcile_not_scheduled`), the booking is
// `pending` without `reconcile_until`, its checkout locked and its authorisation held. The scan adopts such a booking
// once its create-order attempt (`create_order_started_at`, the claim) started more than RECONCILE_ADOPT_AFTER_MS ago
// (`adoptStaleClaims`: `reconcile_until = now + 15 minutes`, the event `booking.reconcile_adopted`), and it is then
// reconciled like any unknown outcome: the order may exist, so it is looked for first, and voided only once it is
// proven absent. A younger claim is left alone, as its request may still be in flight.
//
// A transaction here that locks the booking and its payment locks the booking first, then the payment (OADR-0003
// point 11). One attempt:
//
//   1. Claim (T1). The booking is locked `FOR UPDATE SKIP LOCKED` and checked again, whatever the job said: `pending`,
//      `reconcile_until` set, no `reconcile_outcome`, its order sent at least RECONCILE_FIRST_DELAY_MS ago, and no
//      other attempt within RECONCILE_CLAIM_GAP_MS (`updated_at` of the last claim), so two jobs of one minute make one
//      search. The claim writes `reconcile_attempts + 1` (the attempt's fencing token) and commits.
//   2. Search. Without a booking queue (`storefront_settings.booking_queue_number`) the order cannot be looked for.
//      Otherwise Queue List of the booking queue in the booking's queuing office, then the PNRs created between
//      `create_order_started_at − 1 min` and `+ 5 min` (Queue List gives the minute, read in UTC) whose travellers'
//      names include the lead traveller's last name, the closest in time first, at most RECONCILE_MAX_READS of them read
//      by record locator (Get Flight Order by Record Locator). An order is accepted only when it carries the general
//      remark `VELEXIS <reference>` with sub-type BACKOFFICE: a name alone never is. A read Amadeus answers `404`
//      (cancelled, purged) is a PNR that is not ours; any other failed read makes the search incomplete.
//   3. Decide (T2), with the booking locked again and still `pending` without an outcome:
//      - found: the order is recorded as checkout.complete records it (order-recorder.ts: `confirmed` or `ticketed`,
//        children, events, the `booking.confirmed` e-mail), `reconcile_outcome = found`, the checkout `completed`
//        (which releases its lock); then the money: the Stripe capture `pi:capture:<pay_id>:<amount>` (not for the
//        `manual_review` policy without tickets, whose staff are alerted), a failed capture handled as checkout.complete
//        handles it (`manual_review`, `payment.capture_retry` 10 minutes later, staff alert); then, for
//        `issue_after_payment`, the issuance through the ticketing job's own attempt (ticketing.service.ts: a resync
//        first, then Flight Order Issue), its next attempt set to now so the ticketing scan takes it over when needed;
//      - not found by `reconcile_until` (a complete search of an attempt claimed at or after it found nothing; or,
//        without a booking queue, simply once it passed), and only when the attempt still holds its claim: the booking
//        `failed` (`failure_code = SUPPLIER_TIMEOUT`, `reconcile_outcome = not_found`, `checkout_id` cleared), the
//        checkout reopened (`open`, or `expired` past its expiry), `payment.void` of its Stripe authorisation queued on
//        `ota-payments` after the commit (payments.processor.ts voids it, `pi:cancel:<pay_id>`), the e-mail
//        `booking.not_confirmed` to the traveller and a staff alert (`staff.manual_review`; "check the office by hand"
//        without a booking queue);
//      - anything else waits for the next attempt: a search that found nothing before `reconcile_until`, or one that
//        could not be completed (past `reconcile_until` the staff are alerted once, and nothing is voided while the
//        order may still be in what could not be read).
//    An airline-card booking is recorded when found but never failed automatically: OBE-051 adds its manual review.
//
// Log lines carry ids, attempt numbers, counts and codes, never a name, a record locator of another booking or a body.
import { Inject, Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { sql } from "@velexis/db";
import { AppError } from "@velexis/errors";
import type { Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AmadeusClient } from "../amadeus/amadeus.client";
import type { AmadeusCallContext } from "../amadeus/call-context";
import { AmadeusCallError } from "../amadeus/error-mapper";
import {
  CheckoutRepository,
  type CheckoutContactRow,
  type CheckoutTravelerRow,
} from "../checkout/checkout.repository";
import { TravelerDocuments } from "../checkout/traveler-documents";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { OTA_QUEUE } from "../common/queues/queue-names";
import { EMAIL_ADDRESS, type WorkerConfig } from "../config";
import { InvalidNotificationError, OutboxService } from "../notifications/outbox.service";
import { storefrontUrl } from "../notifications/renderer";
import type { TemplateKey } from "../notifications/templates/registry";
import {
  PAYMENT_GATEWAY,
  type GatewayContext,
  type GatewayState,
  type PaymentGateway,
} from "../payments/payment-gateway";
import { providerStateUpdate } from "../payments/payment-state";
import { PAYMENT_JOB, paymentJob } from "../payments/payments.processor";
import { PaymentsRepository, type PaymentRow } from "../payments/payments.repository";
import { Money } from "../pricing/pricing.types";
import { parseOffer, type ParsedOffer } from "../shopping/offers.mapper";
import { readPricingReply } from "../shopping/priced-offers.mapper";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import { afterCommit, TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { velexisRemarkText } from "./booking-reference";
import { BookingsRepository, type BookingSettingsRow } from "./bookings.repository";
import {
  OrderRecorder,
  readCreatedOrder,
  segmentPlansOf,
  type CheckoutTravelerView,
  type CreatedOrder,
  type RecordedOrder,
} from "./order-recorder";
import { VELEXIS_REMARK_SUBTYPE, type TicketingPolicy } from "./order-request.builder";
import { TicketingService } from "./ticketing.service";

// ---- Timing (OADR-0003 point 4) -------------------------------------------------------------------------------------

/** How long after `create_order_started_at` the reconciliation looks for an order: `reconcile_until`. */
export const RECONCILE_WINDOW_MS = 15 * 60_000;

/** The first attempt comes this long after the order was sent (the delay of the first `booking.reconcile`). */
export const RECONCILE_FIRST_DELAY_MS = 30_000;

/**
 * A `pending` booking without `reconcile_until` whose create-order attempt started more than this long ago is adopted
 * by the scan (lead decision of 2026-10-21): no request of checkout.complete is still in flight after it.
 */
export const RECONCILE_ADOPT_AFTER_MS = 2 * 60_000;

/** The event of an adopted claim (`booking_events.type`, staff only). */
export const RECONCILE_ADOPTED_EVENT = "booking.reconcile_adopted";

/**
 * The shortest time between two attempts of one booking: the first job and a scan job of the same minute, or two
 * scans, make one search. Shorter than the scan's minute, so the cadence stays one attempt per minute.
 */
export const RECONCILE_CLAIM_GAP_MS = 45_000;

/** A PNR is a candidate when Queue List says it was created from this long before the order was sent … */
export const RECONCILE_CREATED_BEFORE_MS = 60_000;
/** … to this long after. */
export const RECONCILE_CREATED_AFTER_MS = 5 * 60_000;

/** By-reference reads of one attempt, at most. */
export const RECONCILE_MAX_READS = 3;

/** When `payment.capture_retry` runs after a failed capture (OADR-0008 point 7). */
export const CAPTURE_RETRY_DELAY_MS = 10 * 60_000;

/** The Velexis operation of the reconciliation's Amadeus calls (`supplier_requests.operation`). */
export const RECONCILE_OPERATION = "booking.reconcile";

/** The originating system of every Velexis order (Get Flight Order by Record Locator supports only this one). */
const ORIGIN_SYSTEM_CODE = "GDS";

/** The booking events and payment events the reconciliation writes, all as the system. */
const SYSTEM_ACTOR = Object.freeze({ type: "system" as const, id: null });

/** A BCP 47 locale as the outbox accepts it. */
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

const POLICIES: readonly TicketingPolicy[] = ["issue_at_booking", "issue_after_payment", "manual_review"];

type JsonObject = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isRecord) : []);

// ---- Jobs -----------------------------------------------------------------------------------------------------------

/** The job of `ota-bookings` (architecture §6). */
export const RECONCILE_JOB = "booking.reconcile";

/** The schedule of the scan (jobs/schedulers.ts) and the name of its per-tenant jobs. */
export const RECONCILE_SCAN_JOB = "bookings.reconcile_scan";

/** A tenant id as the platform writes it (`ten_` and a ULID). */
const TENANT_ID = /^ten_[0-9A-Za-z]{1,60}$/;

/** A booking id (`bkg_` and a ULID). */
const BOOKING_ID = /^bkg_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The payload of `booking.reconcile`: the tenant and the booking, nothing else (ADR-0009). */
export interface ReconcileJobData {
  readonly tenantId: string;
  readonly bookingId: string;
}

/** The payload of a `booking.reconcile` job, or `undefined` when it is not one (extra fields included). */
export function parseReconcileJobData(data: unknown): ReconcileJobData | undefined {
  if (!isRecord(data) || Object.keys(data).length !== 2) {
    return undefined;
  }
  const { tenantId, bookingId } = data;
  return typeof tenantId === "string" &&
    TENANT_ID.test(tenantId) &&
    typeof bookingId === "string" &&
    BOOKING_ID.test(bookingId)
    ? { tenantId, bookingId }
    : undefined;
}

/**
 * The id of a `booking.reconcile` job: `booking.reconcile:<bkg_…>:first` for the one checkout.complete queues, and
 * `booking.reconcile:<bkg_…>:<minute bucket>` for those of a scan (three parts, as BullMQ wants a custom id with `:`).
 */
export function reconcileJobId(bookingId: string, suffix: number | "first"): string {
  return `${RECONCILE_JOB}:${bookingId}:${suffix}`;
}

/** The `booking.reconcile` job of a booking, as `Queue.add`/`addBulk` take it; the first one comes 30 s later. */
export function reconcileJob(
  tenantId: string,
  bookingId: string,
  suffix: number | "first",
): {
  readonly name: string;
  readonly data: ReconcileJobData;
  readonly opts: { readonly jobId: string; readonly delay?: number };
} {
  return {
    name: RECONCILE_JOB,
    data: { tenantId, bookingId },
    opts: {
      jobId: reconcileJobId(bookingId, suffix),
      ...(suffix === "first" ? { delay: RECONCILE_FIRST_DELAY_MS } : {}),
    },
  };
}

// ---- The search, without I/O ----------------------------------------------------------------------------------------

/** A PNR of Queue List worth reading by record locator. */
export interface QueueCandidate {
  readonly recordLocator: string;
  /** Its creation, to the minute, as Queue List gives it. */
  readonly createdAt: Date;
}

/** A name as compared: no accents, upper case, letters only (`Müller-Lüdenscheidt` → `MULLERLUDENSCHEIDT`). */
export function comparableName(value: unknown): string {
  return typeof value === "string"
    ? value
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .toUpperCase()
        .replace(/[^A-Z]/g, "")
    : "";
}

/**
 * The creation instant of a Queue List entry: `creation.dateTime` to the minute (`2027-01-15T07:15`), read in UTC
 * unless it names its offset; `undefined` when it cannot be read.
 */
export function queueCreationOf(entry: JsonObject): Date | undefined {
  const creation = isRecord(entry["creation"]) ? entry["creation"]["dateTime"] : undefined;
  if (typeof creation !== "string") {
    return undefined;
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/.exec(
    creation,
  );
  if (match === null) {
    return undefined;
  }
  const instant = new Date(`${match[1]}T${match[2]}:${match[3] ?? "00"}${match[4] ?? "Z"}`);
  return Number.isNaN(instant.getTime()) ? undefined : instant;
}

/** The record locator of a Queue List entry: the part of its `id` before the creation day (`ABC123-2027-01-15`). */
export function queueRecordLocatorOf(entry: JsonObject): string | undefined {
  const id = entry["id"];
  const match = typeof id === "string" ? /^([A-Za-z0-9]{5,8})(?:-|$)/.exec(id) : null;
  return match?.[1]?.toUpperCase();
}

/**
 * The PNRs of a Queue List answer that may be the booking's order (see the file header): created within the window
 * around `startedAt` (the entry's minute counts from its start), with a traveller of the lead's last name, the closest
 * in time first, each record locator once, at most RECONCILE_MAX_READS.
 */
export function queueCandidates(
  reply: unknown,
  booking: { readonly startedAt: Date; readonly leadLastName: string },
): QueueCandidate[] {
  const lead = comparableName(booking.leadLastName);
  if (lead === "") {
    return [];
  }
  const started = booking.startedAt.getTime();
  // The minute Queue List gives starts up to 59 s before the PNR was created.
  const earliest = Math.floor((started - RECONCILE_CREATED_BEFORE_MS) / 60_000) * 60_000;
  const latest = started + RECONCILE_CREATED_AFTER_MS;
  const found = new Map<string, QueueCandidate>();
  for (const entry of records(isRecord(reply) ? reply["data"] : undefined)) {
    const recordLocator = queueRecordLocatorOf(entry);
    const createdAt = queueCreationOf(entry);
    if (recordLocator === undefined || createdAt === undefined || found.has(recordLocator)) {
      continue;
    }
    if (createdAt.getTime() < earliest || createdAt.getTime() > latest) {
      continue;
    }
    const named = records(entry["travelers"]).some((traveler) =>
      records(traveler["names"]).some((name) => comparableName(name["lastName"]) === lead),
    );
    if (named) {
      found.set(recordLocator, { recordLocator, createdAt });
    }
  }
  return [...found.values()]
    .sort(
      (a, b) =>
        Math.abs(a.createdAt.getTime() - started) - Math.abs(b.createdAt.getTime() - started) ||
        a.recordLocator.localeCompare(b.recordLocator),
    )
    .slice(0, RECONCILE_MAX_READS);
}

/** A remark text as compared: upper case, single spaces, trimmed. */
const comparableText = (value: unknown): string =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ").toUpperCase() : "";

/**
 * Whether an Amadeus flight order carries the booking's general remark `VELEXIS <reference>` with sub-type BACKOFFICE
 * (order-request.builder.ts writes it into every order): the only proof that a PNR is the booking's order.
 */
export function carriesVelexisRemark(order: unknown, reference: string): boolean {
  const expected = velexisRemarkText(reference);
  const remarks = isRecord(order) && isRecord(order["remarks"]) ? order["remarks"]["general"] : undefined;
  return records(remarks).some(
    (remark) =>
      comparableText(remark["subType"]) === VELEXIS_REMARK_SUBTYPE &&
      comparableText(remark["text"]) === expected,
  );
}

/**
 * The booking's order in a Get Flight Order by Record Locator answer (`data`, a list): the first order that carries
 * its remark, as a Flight Create Orders answer reads (`readCreatedOrder`); `null` when one carries the remark but cannot
 * be read (it exists, so the booking is not failed for it), `undefined` when none carries it.
 */
export function orderOfBooking(reply: unknown, reference: string): CreatedOrder | null | undefined {
  const body = isRecord(reply) ? reply : {};
  const data = Array.isArray(body["data"]) ? body["data"] : isRecord(body["data"]) ? [body["data"]] : [];
  const order = data.find((candidate) => carriesVelexisRemark(candidate, reference));
  if (order === undefined) {
    return undefined;
  }
  return readCreatedOrder({ data: order, dictionaries: body["dictionaries"] }) ?? null;
}

// ---- The repository -------------------------------------------------------------------------------------------------

/** What the reconciliation reads of a booking. */
export interface ReconcileBookingRow {
  readonly id: string;
  readonly environment: string;
  readonly reference: string;
  readonly status: string;
  readonly customerId: string | null;
  readonly checkoutId: string | null;
  readonly pricedOfferId: string | null;
  readonly queuingOfficeId: string | null;
  readonly issueRequested: boolean;
  readonly contactEmail: string;
  readonly leadLastName: string;
  readonly currency: string;
  readonly totalAmount: string;
  readonly createOrderStartedAt: Date | null;
  readonly reconcileUntil: Date | null;
  readonly reconcileAttempts: number;
  readonly reconcileOutcome: string | null;
  readonly updatedAt: Date;
}

/** A payment of a booking, as the decisions read it. */
export interface ReconcilePaymentRow {
  readonly id: string;
  readonly provider: string;
  readonly method: string;
  readonly status: string;
  readonly providerPaymentId: string | null;
}

/** A claim the scan adopted (`adoptStaleClaims`). */
export interface AdoptedClaim {
  readonly id: string;
  readonly reference: string;
  readonly createOrderStartedAt: Date;
  /** `now + RECONCILE_WINDOW_MS`: the adoption's deadline. */
  readonly reconcileUntil: Date;
}

/** Before this instant a claim without `reconcile_until` is stale at `now` (RECONCILE_ADOPT_AFTER_MS). */
export function staleClaimBefore(now: Date): Date {
  return new Date(now.getTime() - RECONCILE_ADOPT_AFTER_MS);
}

/** The `reconcile_until` of a claim adopted at `now`: the normal window, from the adoption. */
export function adoptedReconcileUntil(now: Date): Date {
  return new Date(now.getTime() + RECONCILE_WINDOW_MS);
}

/** The reconciliation's queries (tenant repository: the `tenantTx` transaction first, never a schema name). */
@Injectable()
export class ReconcileRepository {
  /**
   * Adopts the stale claims of `now` (see the file header): the `pending` bookings without `reconcile_until` or an
   * outcome whose create-order attempt started before `staleClaimBefore(now)`, at most `limit`, the oldest first, locked
   * `FOR UPDATE SKIP LOCKED` (a booking another transaction holds, such as its own request's, is left to a later scan),
   * get `reconcile_until = now + RECONCILE_WINDOW_MS`. A claim is adopted once: an adopted booking has its
   * `reconcile_until`, and a concurrent scan skips the rows this one holds. Answers what it adopted; the caller writes
   * their events in the same transaction. `bookings_status_idx` (environment, status) serves it.
   */
  async adoptStaleClaims(
    trx: TenantTransaction,
    query: { readonly now: Date; readonly limit: number },
  ): Promise<AdoptedClaim[]> {
    const rows = await trx
      .selectFrom("bookings")
      .select(["id", "reference", "create_order_started_at as createOrderStartedAt"])
      .where("environment", "in", ["test", "live"])
      .where("status", "=", "pending")
      .where("reconcile_until", "is", null)
      .where("reconcile_outcome", "is", null)
      .where("create_order_started_at", "<", staleClaimBefore(query.now))
      .orderBy("create_order_started_at")
      .orderBy("id")
      .limit(query.limit)
      .forUpdate()
      .skipLocked()
      .execute();
    const reconcileUntil = adoptedReconcileUntil(query.now);
    const adopted = rows.flatMap((row): AdoptedClaim[] =>
      row.createOrderStartedAt === null
        ? []
        : [
            {
              id: row.id,
              reference: row.reference,
              createOrderStartedAt: row.createOrderStartedAt,
              reconcileUntil,
            },
          ],
    );
    if (adopted.length > 0) {
      // As checkout.complete's unknown outcome writes it (a new ETag: the booking's state changed).
      await trx
        .updateTable("bookings")
        .set({ reconcile_until: reconcileUntil, updated_at: query.now, version: sql`version + 1` })
        .where(
          "id",
          "in",
          adopted.map((claim) => claim.id),
        )
        .execute();
    }
    return adopted;
  }

  /**
   * The ids of the bookings the reconciliation still has to decide at `now` (`pending`, `reconcile_until` set, no
   * outcome, the order sent at least RECONCILE_FIRST_DELAY_MS ago), the earliest deadline first, at most `limit`. The
   * partial index `bookings_reconcile_idx` serves it.
   */
  async dueBookingIds(
    trx: TenantTransaction,
    query: { readonly now: Date; readonly limit: number },
  ): Promise<string[]> {
    const sentBefore = new Date(query.now.getTime() - RECONCILE_FIRST_DELAY_MS);
    const rows = await trx
      .selectFrom("bookings")
      .select("id")
      .where("status", "=", "pending")
      .where("reconcile_until", "is not", null)
      .where("reconcile_outcome", "is", null)
      .where("create_order_started_at", "<=", sentBefore)
      .orderBy("reconcile_until")
      .orderBy("id")
      .limit(query.limit)
      .execute();
    return rows.map((row) => row.id);
  }

  /**
   * The booking `id`, locked `FOR UPDATE SKIP LOCKED` (the claim) or `FOR UPDATE` (the decision, which waits);
   * `undefined` when it does not exist or, with `skipLocked`, when another transaction holds it.
   */
  async lock(
    trx: TenantTransaction,
    id: string,
    options: { readonly skipLocked: boolean },
  ): Promise<ReconcileBookingRow | undefined> {
    const query = trx
      .selectFrom("bookings")
      .select([
        "id",
        "environment",
        "reference",
        "status",
        "customer_id as customerId",
        "checkout_id as checkoutId",
        "priced_offer_id as pricedOfferId",
        "queuing_office_id as queuingOfficeId",
        "issue_requested as issueRequested",
        "contact_email as contactEmail",
        "lead_last_name as leadLastName",
        "create_order_started_at as createOrderStartedAt",
        "reconcile_until as reconcileUntil",
        "reconcile_attempts as reconcileAttempts",
        "reconcile_outcome as reconcileOutcome",
        "updated_at as updatedAt",
        sql<string>`currency::text`.as("currency"),
        sql<string>`total_amount::text`.as("totalAmount"),
      ])
      .where("id", "=", id)
      .forUpdate();
    return await (options.skipLocked ? query.skipLocked() : query).executeTakeFirst();
  }

  /** Records a claimed attempt: `reconcile_attempts` (the fencing token) and `updated_at`; the ETag stays as it is. */
  async markAttempt(trx: TenantTransaction, id: string, attempts: number, now: Date): Promise<void> {
    await trx
      .updateTable("bookings")
      .set({ reconcile_attempts: attempts, updated_at: now })
      .where("id", "=", id)
      .execute();
  }

  /** The payments of a booking, oldest first, locked `FOR UPDATE` (after the booking: the lock order of payments). */
  async lockPayments(trx: TenantTransaction, bookingId: string): Promise<ReconcilePaymentRow[]> {
    return await trx
      .selectFrom("payments")
      .select(["id", "provider", "method", "status", "provider_payment_id as providerPaymentId"])
      .where("booking_id", "=", bookingId)
      .orderBy("created_at")
      .orderBy("id")
      .forUpdate()
      .execute();
  }

  /**
   * Whether the booking `bookingId` failed because its order was not found (`reconcile_outcome = not_found`): the
   * authorisation of its payment is being voided, so checkout.complete does not complete with that payment again.
   */
  async notFound(trx: TenantTransaction, bookingId: string): Promise<boolean> {
    const row = await trx
      .selectFrom("bookings")
      .select("id")
      .where("id", "=", bookingId)
      .where("status", "=", "failed")
      .where("reconcile_outcome", "=", "not_found")
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The Amadeus answer stored with a priced offer (`priced_offers.response`), or `undefined`. */
  async pricedOfferResponse(trx: TenantTransaction, pricedOfferId: string): Promise<unknown> {
    const row = await trx
      .selectFrom("priced_offers")
      .select("response")
      .where("id", "=", pricedOfferId)
      .executeTakeFirst();
    return row?.response;
  }
}

// ---- The service ----------------------------------------------------------------------------------------------------

/** Why an attempt did nothing. */
export type ReconcileSkip =
  /** No such booking in the tenant, or another transaction holds it. */
  | "not_claimable"
  | "not_pending"
  /**
   * Pending without `reconcile_until`: its checkout.complete is still under way, or the scan has not adopted its stale
   * claim yet (RECONCILE_ADOPT_AFTER_MS).
   */
  | "not_reconciling"
  | "decided"
  /** Sent less than RECONCILE_FIRST_DELAY_MS ago, or attempted less than RECONCILE_CLAIM_GAP_MS ago. */
  | "not_due";

/** Why an attempt left the booking `pending`. */
export type ReconcileWait =
  /** A complete search before `reconcile_until` found nothing. */
  | "not_found_yet"
  /** No booking queue, before `reconcile_until`: nothing to search. */
  | "no_queue"
  /** Queue List or a read failed, or an order with the remark could not be read: the next attempt looks again. */
  | "search_incomplete"
  /** Not found, but the booking is paid by airline card: no automatic failure (OBE-051 adds the manual review). */
  | "airline_card"
  /** The order was found but could not be recorded: the next attempt tries again, staff were alerted. */
  | "record_failed";

/** What one attempt did (kept with the BullMQ job): ids, counts and codes, never more. */
export type ReconcileOutcome =
  | { readonly outcome: "skipped"; readonly reason: ReconcileSkip }
  | { readonly outcome: "pending"; readonly attempts: number; readonly reason: ReconcileWait }
  | {
      readonly outcome: "found";
      readonly attempts: number;
      readonly status: string;
      readonly captured: boolean;
      readonly ticketing: string | null;
    }
  | { readonly outcome: "not_found"; readonly attempts: number; readonly voids: number }
  /** Decided meanwhile by another attempt or by staff, or another attempt claimed it since: nothing written. */
  | { readonly outcome: "decided_elsewhere" | "claim_lost"; readonly attempts: number };

/** A claimed booking. */
interface Claim {
  readonly booking: ReconcileBookingRow;
  /** `reconcile_attempts` after the claim: its fencing token. */
  readonly attempts: number;
  /** When the attempt claimed the booking, before its search. */
  readonly claimedAt: Date;
  readonly startedAt: Date;
  readonly until: Date;
  readonly environment: "test" | "live";
}

/** What a search found. */
type SearchResult =
  | { readonly kind: "found"; readonly order: CreatedOrder; readonly supplierRequestId: string | null }
  | { readonly kind: "absent"; readonly candidates: number }
  | { readonly kind: "incomplete"; readonly code: string }
  | { readonly kind: "no_queue" };

/** The API code of a failed call: an AppError's code, `INTERNAL_ERROR` for anything else (a bug). */
function codeOf(error: unknown): string {
  return error instanceof AppError ? error.code : "INTERNAL_ERROR";
}

/** An Amadeus `404`: the record locator names no order (any more). */
function isNotFound(error: unknown): boolean {
  return (
    error instanceof AppError && error.cause instanceof AmadeusCallError && error.cause.httpStatus === 404
  );
}

/** Why the claim of `row` is refused at `now`, or `undefined` when it may be claimed. */
export function reconcileClaimSkip(row: ReconcileBookingRow, now: Date): ReconcileSkip | undefined {
  if (row.status !== "pending") {
    return "not_pending";
  }
  if (row.reconcileUntil === null || row.createOrderStartedAt === null) {
    return "not_reconciling";
  }
  if (row.reconcileOutcome !== null) {
    return "decided";
  }
  if (now.getTime() < row.createOrderStartedAt.getTime() + RECONCILE_FIRST_DELAY_MS) {
    return "not_due";
  }
  if (row.reconcileAttempts > 0 && now.getTime() - row.updatedAt.getTime() < RECONCILE_CLAIM_GAP_MS) {
    return "not_due";
  }
  return undefined;
}

/** The decision an attempt takes after its search (see the file header). */
export function reconcileDecision(
  search: SearchResult["kind"],
  pastDeadline: boolean,
): "record" | "fail" | "wait" {
  if (search === "found") {
    return "record";
  }
  if (search === "incomplete" || !pastDeadline) {
    return "wait";
  }
  return "fail";
}

/** Runs one reconciliation attempt of a booking (see the file header). */
@Injectable()
export class ReconcileService {
  private readonly baseDomain: string;
  private readonly adminUrl: string;
  private readonly opsAlertEmail: string;

  constructor(
    private readonly tx: TenantTx,
    private readonly repository: ReconcileRepository,
    private readonly bookings: BookingsRepository,
    private readonly checkouts: CheckoutRepository,
    private readonly documents: TravelerDocuments,
    private readonly payments: PaymentsRepository,
    private readonly recorder: OrderRecorder,
    private readonly ticketing: TicketingService,
    private readonly amadeus: AmadeusClient,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly outbox: OutboxService,
    @InjectQueue(OTA_QUEUE.payments) private readonly paymentsQueue: Queue,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    config: ConfigService<WorkerConfig, true>,
    @InjectPinoLogger(ReconcileService.name) private readonly logger: PinoLogger,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
    this.adminUrl = config.get("PUBLIC_OTA_ADMIN_URL", { infer: true });
    this.opsAlertEmail = config.get("OPS_ALERT_EMAIL", { infer: true });
  }

  /**
   * One attempt for the booking `bookingId` of `tenant`, in the tenant's job context; `requestId` names the job in the
   * Amadeus and Stripe calls and the events. Amadeus and Stripe failures are recorded or waited out, never thrown; a
   * database error is thrown (the job fails, and BullMQ or the next scan tries again).
   */
  async attempt(tenant: PlatformTenant, bookingId: string, requestId: string): Promise<ReconcileOutcome> {
    const claim = await this.claim(bookingId);
    if (typeof claim === "string") {
      this.logger.debug({ bookingId, reason: claim }, "bookings.reconcile_skipped");
      return { outcome: "skipped", reason: claim };
    }
    const settings = await this.tx.run((trx) => this.bookings.settings(trx));
    const search = await this.search(tenant, claim, settings, requestId);
    // Only a search that started at or after `reconcile_until` may prove the order absent.
    const pastDeadline = claim.claimedAt.getTime() >= claim.until.getTime();
    this.logger.info(
      {
        bookingId,
        attempt: claim.attempts,
        search: search.kind,
        ...(search.kind === "absent" ? { candidates: search.candidates } : {}),
        ...(search.kind === "incomplete" ? { code: search.code } : {}),
        pastDeadline,
      },
      "bookings.reconcile_searched",
    );
    switch (reconcileDecision(search.kind, pastDeadline)) {
      case "record":
        return search.kind === "found"
          ? await this.recordFound(tenant, claim, search.order, search.supplierRequestId, requestId)
          : { outcome: "pending", attempts: claim.attempts, reason: "search_incomplete" };
      case "fail":
        return await this.failNotFound(tenant, claim, settings, search.kind === "no_queue", requestId);
      case "wait":
        if (search.kind === "incomplete" && pastDeadline) {
          await this.tx.run((trx) =>
            this.staffAlert(trx, tenant, claim.booking, settings, "reconcile_search_failed", {
              reason:
                `Amadeus did not confirm booking ${claim.booking.reference} and the reconciliation cannot read the ` +
                `booking queue or its orders (${search.code}); it keeps trying. Look for the order in the office: ` +
                "the payment is neither captured nor voided until the order is found or proven absent.",
            }),
          );
        }
        return {
          outcome: "pending",
          attempts: claim.attempts,
          reason:
            search.kind === "incomplete"
              ? "search_incomplete"
              : search.kind === "no_queue"
                ? "no_queue"
                : "not_found_yet",
        };
    }
  }

  // ---- Step 1: the claim -------------------------------------------------------------------------------------------

  private async claim(bookingId: string): Promise<Claim | ReconcileSkip> {
    return await this.tx.run(async (trx) => {
      const now = this.clock.now();
      const row = await this.repository.lock(trx, bookingId, { skipLocked: true });
      if (row === undefined) {
        return "not_claimable";
      }
      const skip = reconcileClaimSkip(row, now);
      if (skip !== undefined) {
        return skip;
      }
      if (
        (row.environment !== "test" && row.environment !== "live") ||
        row.createOrderStartedAt === null ||
        row.reconcileUntil === null
      ) {
        return "not_claimable";
      }
      const attempts = row.reconcileAttempts + 1;
      await this.repository.markAttempt(trx, row.id, attempts, now);
      this.logger.info({ bookingId: row.id, attempt: attempts }, "bookings.reconcile_claimed");
      return {
        booking: row,
        attempts,
        claimedAt: now,
        startedAt: row.createOrderStartedAt,
        until: row.reconcileUntil,
        environment: row.environment,
      };
    });
  }

  // ---- Step 2: the search ------------------------------------------------------------------------------------------

  private async search(
    tenant: PlatformTenant,
    claim: Claim,
    settings: BookingSettingsRow | undefined,
    requestId: string,
  ): Promise<SearchResult> {
    const queue = settings?.bookingQueueNumber ?? null;
    if (queue === null) {
      return { kind: "no_queue" };
    }
    const context: AmadeusCallContext = {
      tenantId: tenant.id,
      environment: claim.environment,
      operation: RECONCILE_OPERATION,
      requestId,
      bookingId: claim.booking.id,
    };
    let candidates: QueueCandidate[];
    try {
      const listed = await this.amadeus.listQueue(context, {
        queueId: queue,
        query: {
          category: settings?.bookingQueueCategory ?? 0,
          ...(claim.booking.queuingOfficeId === null ? {} : { officeId: claim.booking.queuingOfficeId }),
        },
      });
      candidates = queueCandidates(listed.body, {
        startedAt: claim.startedAt,
        leadLastName: claim.booking.leadLastName,
      });
    } catch (error) {
      const code = codeOf(error);
      this.logger.warn({ bookingId: claim.booking.id, code }, "bookings.reconcile_queue_failed");
      return { kind: "incomplete", code };
    }
    let incomplete: string | undefined;
    for (const candidate of candidates) {
      try {
        const reply = await this.amadeus.getFlightOrderByReference(context, {
          query: { reference: candidate.recordLocator, originSystemCode: ORIGIN_SYSTEM_CODE },
        });
        const order = orderOfBooking(reply.body, claim.booking.reference);
        if (order === null) {
          // The order exists but cannot be recorded: never failed for it.
          this.logger.error({ bookingId: claim.booking.id }, "bookings.reconcile_order_unreadable");
          incomplete ??= "SUPPLIER_ERROR";
        } else if (order !== undefined) {
          return { kind: "found", order, supplierRequestId: reply.call.supplierRequestId };
        }
      } catch (error) {
        if (!isNotFound(error)) {
          const code = codeOf(error);
          this.logger.warn({ bookingId: claim.booking.id, code }, "bookings.reconcile_read_failed");
          incomplete ??= code;
        }
      }
    }
    return incomplete === undefined
      ? { kind: "absent", candidates: candidates.length }
      : { kind: "incomplete", code: incomplete };
  }

  // ---- Step 3: found -----------------------------------------------------------------------------------------------

  private async recordFound(
    tenant: PlatformTenant,
    claim: Claim,
    order: CreatedOrder,
    supplierRequestId: string | null,
    requestId: string,
  ): Promise<ReconcileOutcome> {
    const id = claim.booking.id;
    const checkoutId = claim.booking.checkoutId;
    if (checkoutId === null) {
      throw new Error("a pending booking without its checkout");
    }
    // What the record step needs, read (and decrypted) before the decision's transaction.
    const read = await this.tx.run(async (trx) => {
      const settings = await this.bookings.settings(trx);
      const checkout = await this.checkouts.checkout(trx, checkoutId);
      const children = await this.checkouts.children(trx, checkoutId);
      return { settings, checkout, children };
    });
    if (read.settings === undefined || read.checkout === undefined) {
      throw new Error("the settings or the checkout of a pending booking are missing");
    }
    const { settings, checkout, children } = read;
    const travelers: CheckoutTravelerView[] = [];
    for (const row of children.travelers) {
      const opened = await this.documents.open(tenant.schemaName, row.id, row);
      travelers.push({ row, documents: opened.documents, discounts: opened.discounts });
    }
    const policy = POLICIES.find((entry) => entry === settings.ticketingPolicy) ?? "issue_after_payment";
    let recorded: { readonly result: RecordedOrder; readonly issueRequested: boolean } | undefined;
    try {
      recorded = await this.tx.run(async (trx) => {
        const now = this.clock.now();
        const current = await this.repository.lock(trx, id, { skipLocked: false });
        if (current?.status !== "pending" || current.reconcileOutcome !== null) {
          return undefined;
        }
        const booking = await this.bookings.booking(trx, id);
        if (booking === undefined) {
          return undefined;
        }
        const result = await this.recorder.record(trx, {
          schema: tenant.schemaName,
          tenantKey: tenant.key,
          booking,
          order,
          travelers,
          contacts: children.contacts,
          remarks: children.remarks,
          settings,
          policy,
          issueRequested: booking.issueRequested,
          locale: checkout.locale ?? settings.defaultLocale,
          actor: SYSTEM_ACTOR,
          requestId,
          supplierRequestId,
          now,
        });
        await this.bookings.updateBooking(trx, id, { reconcile_outcome: "found", updated_at: now });
        await this.bookings.updateCheckout(trx, checkoutId, {
          status: "completed",
          completed_at: now,
          updated_at: now,
        });
        await this.recorder.event(trx, id, {
          type: "booking.reconciled",
          actor: SYSTEM_ACTOR,
          statusFrom: "pending",
          statusTo: result.status,
          summary: `The order of booking ${booking.reference} was found at the airline after a timeout and recorded.`,
          data: {
            outcome: "found",
            attempt: claim.attempts,
            recordLocator: order.records[0]?.reference ?? null,
          },
          visibleToCustomer: false,
          supplierRequestId,
          requestId,
          // One millisecond after the record step's events: the timeline orders by time, then by the random id.
          now: new Date(now.getTime() + 1),
        });
        return { result, issueRequested: booking.issueRequested };
      });
    } catch (error) {
      // The order exists at Amadeus but T2 rolled back: the booking stays pending, and the next attempt finds it again.
      this.logger.error({ bookingId: id, err: error }, "bookings.reconcile_record_failed");
      await this.tx.run((trx) =>
        this.staffAlert(trx, tenant, claim.booking, settings, "reconcile_record_failed", {
          reason:
            `The order of booking ${claim.booking.reference} was found at the airline after a timeout, but it could ` +
            "not be recorded; the reconciliation tries again every minute. Check the booking.",
        }),
      );
      return { outcome: "pending", attempts: claim.attempts, reason: "record_failed" };
    }
    if (recorded === undefined) {
      this.logger.warn({ bookingId: id, attempt: claim.attempts }, "bookings.reconcile_decided_elsewhere");
      return { outcome: "decided_elsewhere", attempts: claim.attempts };
    }
    const { result } = recorded;
    this.logger.info(
      { tenantId: tenant.id, bookingId: id, attempt: claim.attempts, status: result.status },
      "bookings.reconcile_found",
    );

    // The money, as checkout.complete's step 4.
    const mustCapture = policy !== "manual_review" || result.coverage !== "none";
    const issueDue =
      policy === "issue_after_payment" && result.coverage === "none" && !recorded.issueRequested;
    let captured = false;
    if (mustCapture) {
      captured = await this.capture(tenant, claim, result.status, issueDue, settings, requestId);
    } else {
      await this.tx.run((trx) =>
        this.staffAlert(trx, tenant, claim.booking, settings, "manual_review_policy", {
          reason:
            "The ticketing policy of the OTA is manual review: issue the tickets from the console, which captures the payment first.",
        }),
      );
    }

    // The issuance, as checkout.complete's step 5: through the ticketing job's attempt (a resync, then the issue).
    let ticketing: string | null = null;
    if (captured && issueDue) {
      const issued = await this.ticketing.attempt(tenant, id, requestId);
      ticketing = issued.outcome;
    }
    const final = await this.tx.run((trx) => this.bookings.booking(trx, id));
    return {
      outcome: "found",
      attempts: claim.attempts,
      status: final?.status ?? result.status,
      captured,
      ticketing,
    };
  }

  /**
   * The capture of the booking's Stripe payment (`pi:capture:<pay_id>:<amount>`); answers whether the payment is
   * captured. A booking without one (an airline-card booking) has nothing to capture. A failure is handled as
   * checkout.complete handles it (see the file header). A capture that worked makes the issuance due at once when
   * `issueDue` (`issue_after_payment` and no ticket yet).
   */
  private async capture(
    tenant: PlatformTenant,
    claim: Claim,
    bookingStatus: string,
    issueDue: boolean,
    settings: BookingSettingsRow,
    requestId: string,
  ): Promise<boolean> {
    const id = claim.booking.id;
    const read = await this.tx.run(async (trx) => {
      const booking = await this.bookings.booking(trx, id);
      const paymentIds = await this.bookings.paymentIdsOf(trx, id);
      let payment: PaymentRow | undefined;
      for (const paymentId of paymentIds) {
        const row = await this.payments.payment(trx, paymentId);
        if (row?.provider === "stripe" && row.providerPaymentId !== null) {
          payment = row;
        }
      }
      const minorUnits =
        booking === undefined ? 2 : ((await this.payments.currencyMinorUnits(trx, booking.currency)) ?? 2);
      return { booking, payment, minorUnits };
    });
    if (read.booking === undefined || read.payment === undefined) {
      this.logger.info({ bookingId: id }, "bookings.reconcile_nothing_to_capture");
      return false;
    }
    const { booking, payment, minorUnits } = read;
    const ctx: GatewayContext = { tenantId: tenant.id, environment: claim.environment, requestId };
    const amount = new Money(booking.totalAmount).toFixed(minorUnits);
    let state: GatewayState | undefined;
    if (payment.status !== "captured") {
      try {
        state = await this.gateway.capture(
          ctx,
          {
            id: payment.id,
            checkoutId: payment.checkoutId,
            providerPaymentId: payment.providerPaymentId,
            currency: payment.currency,
            amount: new Money(payment.amount).toFixed(minorUnits),
            minorUnits,
            version: payment.version,
          },
          amount,
        );
      } catch (error) {
        this.logger.warn(
          { bookingId: id, paymentId: payment.id, code: codeOf(error) },
          "bookings.reconcile_capture_failed",
        );
        await this.captureFailed(tenant, claim, payment, bookingStatus, amount, settings, requestId);
        return false;
      }
    }
    await this.tx.run(async (trx) => {
      const now = this.clock.now();
      // The lock order of a transaction that changes a booking and its payment: the booking first, then the payment.
      await this.bookings.booking(trx, id, true);
      const current = await this.payments.payment(trx, payment.id, true);
      if (current !== undefined && state !== undefined) {
        const update = providerStateUpdate(current, state, now);
        if (update.kind === "apply") {
          await this.payments.updatePayment(trx, current.id, current.version, update.values);
          await this.paymentEvent(trx, current, {
            type: "payment.captured",
            statusFrom: current.status,
            statusTo: update.status,
            amount,
            payload: { bookingId: id, source: RECONCILE_OPERATION },
            now,
          });
        }
      }
      const received = state === undefined ? payment.amountCaptured : state.amountReceived;
      await this.bookings.updateBooking(trx, id, {
        amount_paid: new Money(received).toFixed(minorUnits),
        // Step 5 of checkout.complete: the issuance is requested by the capture and due now (the ticketing scan takes it
        // when this job does not); `ticketing_requested_at` is when issuance was first requested (tenant.sql).
        ...(issueDue ? { ticketing_requested_at: now, ticketing_next_attempt_at: now } : {}),
        updated_at: now,
      });
      await this.recorder.event(trx, id, {
        type: "payment.captured",
        actor: SYSTEM_ACTOR,
        summary: "Payment received.",
        data: { paymentId: payment.id, amount },
        visibleToCustomer: true,
        requestId,
        now,
      });
    });
    return true;
  }

  /** A failed capture after the order was recorded: as checkout.complete's (see the file header). */
  private async captureFailed(
    tenant: PlatformTenant,
    claim: Claim,
    payment: PaymentRow,
    bookingStatus: string,
    amount: string,
    settings: BookingSettingsRow,
    requestId: string,
  ): Promise<void> {
    const id = claim.booking.id;
    await this.tx.run(async (trx) => {
      const now = this.clock.now();
      await this.bookings.updateBooking(trx, id, {
        // A ticketed booking keeps `issued` (bookings_ticketing_ck); the others wait for staff.
        ...(bookingStatus === "ticketed"
          ? {}
          : { ticketing_status: "manual_review", ticketing_next_attempt_at: null }),
        ticketing_error_code: "PAYMENT_CAPTURE_FAILED",
        ticketing_error: "The Stripe capture failed after the order was found and recorded",
        updated_at: now,
      });
      const current = await this.payments.payment(trx, payment.id, true);
      if (current !== undefined) {
        await this.paymentEvent(trx, current, {
          type: "payment.capture_failed",
          payload: { bookingId: id, amount },
          now,
        });
      }
      await this.recorder.event(trx, id, {
        type: "payment.capture_failed",
        actor: SYSTEM_ACTOR,
        summary: "The payment could not be captured; staff will review the booking.",
        data: { paymentId: payment.id },
        visibleToCustomer: false,
        requestId,
        now,
      });
      await this.staffAlert(trx, tenant, claim.booking, settings, "capture_failed", {
        reason:
          "The payment could not be captured after the order was found and recorded. The capture is retried once in 10 minutes; check the payment before issuing.",
      });
      const job = paymentJob(PAYMENT_JOB.captureRetry, tenant.id, payment.id);
      afterCommit(trx, () =>
        this.paymentsQueue.add(job.name, job.data, { ...job.opts, delay: CAPTURE_RETRY_DELAY_MS }).then(
          () => undefined,
          (error: unknown) => {
            this.logger.warn({ paymentId: payment.id, err: error }, "bookings.enqueue_failed");
          },
        ),
      );
    });
  }

  // ---- Step 3: not found -------------------------------------------------------------------------------------------

  private async failNotFound(
    tenant: PlatformTenant,
    claim: Claim,
    settings: BookingSettingsRow | undefined,
    noQueue: boolean,
    requestId: string,
  ): Promise<ReconcileOutcome> {
    const id = claim.booking.id;
    const decided = await this.tx.run(async (trx): Promise<ReconcileOutcome> => {
      const now = this.clock.now();
      const current = await this.repository.lock(trx, id, { skipLocked: false });
      if (current?.status !== "pending" || current.reconcileOutcome !== null) {
        return { outcome: "decided_elsewhere", attempts: claim.attempts };
      }
      if (current.reconcileAttempts !== claim.attempts) {
        // Another attempt claimed the booking since: it decides with its own, newer search.
        return { outcome: "claim_lost", attempts: claim.attempts };
      }
      const payments = await this.repository.lockPayments(trx, id);
      if (payments.some((payment) => payment.method === "airline_card")) {
        // The airline may have charged the card: never an automatic failure (OADR-0003 point 5; OBE-051).
        return { outcome: "pending", attempts: claim.attempts, reason: "airline_card" };
      }
      await this.bookings.updateBooking(trx, id, {
        status: "failed",
        ticketing_status: "not_applicable",
        checkout_id: null,
        failure_code: "SUPPLIER_TIMEOUT",
        failure_message: noQueue
          ? "booking.reconcile: no booking queue to look for the order in; not confirmed after 15 minutes"
          : "booking.reconcile: the order was not found in the booking queue within 15 minutes",
        reconcile_outcome: "not_found",
        updated_at: now,
      });
      const voidable = payments.filter(
        (payment) =>
          payment.provider === "stripe" &&
          payment.providerPaymentId !== null &&
          ["requires_payment_method", "requires_action", "processing", "authorized"].includes(payment.status),
      );
      await this.recorder.event(trx, id, {
        type: "booking.failed",
        actor: SYSTEM_ACTOR,
        statusFrom: "pending",
        statusTo: "failed",
        summary: `Booking ${current.reference} not confirmed: the order was not found after the timeout.`,
        data: {
          code: "SUPPLIER_TIMEOUT",
          reconcileOutcome: "not_found",
          attempt: claim.attempts,
          bookingQueue: !noQueue,
          paymentVoidQueued: voidable.length > 0,
        },
        visibleToCustomer: false,
        requestId,
        now,
      });
      await this.recorder.event(trx, id, {
        type: "booking.not_confirmed",
        actor: SYSTEM_ACTOR,
        statusFrom: "pending",
        statusTo: "failed",
        summary: "The airline did not confirm your booking. You have not been charged.",
        visibleToCustomer: true,
        requestId,
        now: new Date(now.getTime() + 1),
      });
      const checkout =
        current.checkoutId === null
          ? undefined
          : await this.checkouts.checkout(trx, current.checkoutId, true);
      if (checkout !== undefined && (checkout.status === "open" || checkout.status === "payment_pending")) {
        // The checkout can be completed again (with a new payment) while it has not expired.
        await this.bookings.updateCheckout(trx, checkout.id, {
          status: checkout.expiresAt.getTime() > now.getTime() ? "open" : "expired",
          updated_at: now,
        });
      }
      const children = checkout === undefined ? undefined : await this.checkouts.children(trx, checkout.id);
      await this.notConfirmedEmail(trx, tenant, current, {
        locale: checkout?.locale ?? null,
        contacts: children?.contacts ?? [],
        travelers: children?.travelers ?? [],
        settings,
      });
      await this.staffAlert(trx, tenant, current, settings, "reconcile_not_found", {
        reason: noQueue
          ? `Amadeus did not confirm booking ${current.reference} and the OTA has no booking queue, so the order could ` +
            "not be looked for: check the office by hand. The booking is marked failed and the payment authorisation " +
            "is released; if the order exists, import it from the console and settle the payment with the traveller."
          : `Amadeus did not confirm booking ${current.reference} and its order was not found in the booking queue ` +
            "within 15 minutes. The booking is marked failed and the payment authorisation is released; if the order " +
            "turns up, import it from the console and settle the payment with the traveller.",
      });
      for (const payment of voidable) {
        const job = paymentJob(PAYMENT_JOB.void, tenant.id, payment.id);
        afterCommit(trx, () =>
          this.paymentsQueue.add(job.name, job.data, job.opts).then(
            () => undefined,
            (error: unknown) => {
              this.logger.warn({ paymentId: payment.id, err: error }, "bookings.enqueue_failed");
            },
          ),
        );
      }
      return { outcome: "not_found", attempts: claim.attempts, voids: voidable.length };
    });
    if (decided.outcome === "not_found") {
      this.logger.warn(
        { tenantId: tenant.id, bookingId: id, attempt: claim.attempts, noQueue, voids: decided.voids },
        "bookings.reconcile_not_found",
      );
    } else if (decided.outcome === "pending") {
      this.logger.warn(
        { bookingId: id, attempt: claim.attempts },
        "bookings.reconcile_airline_card_undecided",
      );
    } else {
      this.logger.warn(
        { bookingId: id, attempt: claim.attempts, outcome: decided.outcome },
        "bookings.reconcile_not_decided",
      );
    }
    return decided;
  }

  /** The e-mail `booking.not_confirmed` to the traveller (the checkout's primary contact, else the booking's e-mail). */
  private async notConfirmedEmail(
    trx: TenantTransaction,
    tenant: PlatformTenant,
    booking: ReconcileBookingRow,
    checkout: {
      readonly locale: string | null;
      readonly contacts: readonly CheckoutContactRow[];
      readonly travelers: readonly CheckoutTravelerRow[];
      readonly settings: BookingSettingsRow | undefined;
    },
  ): Promise<void> {
    const { contacts, travelers, settings } = checkout;
    const primary = contacts.find((contact) => contact.isPrimary) ?? contacts[0];
    const offers = await this.offersOf(trx, booking.pricedOfferId);
    const language = primary?.language ?? null;
    const locale = [language, checkout.locale, settings?.defaultLocale ?? null].find(
      (value): value is string => value !== null && LOCALE.test(value),
    );
    await this.enqueue(trx, booking.id, "booking.not_confirmed", {
      templateKey: "booking.not_confirmed",
      to: primary?.email ?? booking.contactEmail,
      locale: locale ?? tenant.defaultLocale,
      customerId: booking.customerId,
      bookingId: booking.id,
      dedupeKey: `booking.not_confirmed:${booking.id}`,
      data: {
        booking: {
          reference: booking.reference,
          recordLocator: "",
          url: `${storefrontUrl(tenant.key, this.baseDomain)}/booking.html?id=${booking.id}`,
          total: { amount: booking.totalAmount, currency: booking.currency },
          contact: { firstName: primary?.firstName ?? "", lastName: primary?.lastName ?? "" },
          travellers: travelers.map((traveler) => ({
            firstName: traveler.firstName ?? "",
            lastName: traveler.lastName ?? "",
          })),
          segments: segmentPlansOf(offers).map((segment) => ({
            origin: segment.departureIata,
            destination: segment.arrivalIata,
            departureAt: segment.departureLocal,
            arrivalAt: segment.arrivalLocal,
            carrierCode: segment.carrierCode,
            flightNumber: segment.flightNumber,
          })),
        },
      },
    });
  }

  /** The Amadeus offers of the booking's priced offer, for the e-mail's flights; none when they cannot be read. */
  private async offersOf(trx: TenantTransaction, pricedOfferId: string | null): Promise<ParsedOffer[]> {
    if (pricedOfferId === null) {
      return [];
    }
    const response = await this.repository.pricedOfferResponse(trx, pricedOfferId);
    return readPricingReply(response).flightOffers.flatMap((offer) => parseOffer(offer) ?? []);
  }

  // ---- Shared ------------------------------------------------------------------------------------------------------

  /**
   * A staff alert (`staff.manual_review`) to `ops_alert_email`, else the OTA's support e-mail, else OPS_ALERT_EMAIL, once
   * per booking and kind (dedupe key `staff.manual_review:<bkg_…>:<kind>`).
   */
  private async staffAlert(
    trx: TenantTransaction,
    tenant: PlatformTenant,
    booking: Pick<ReconcileBookingRow, "id" | "reference">,
    settings: BookingSettingsRow | undefined,
    kind: string,
    alert: { readonly reason: string },
  ): Promise<void> {
    const to =
      [settings?.opsAlertEmail, settings?.supportEmail].find(
        (address): address is string =>
          address !== null && address !== undefined && EMAIL_ADDRESS.test(address),
      ) ?? this.opsAlertEmail;
    const consoleUrl = new URL(
      `bookings/${booking.id}`,
      this.adminUrl.endsWith("/") ? this.adminUrl : `${this.adminUrl}/`,
    ).toString();
    await this.enqueue(trx, booking.id, "staff.manual_review", {
      templateKey: "staff.manual_review",
      to,
      locale: settings?.defaultLocale ?? tenant.defaultLocale,
      recipientType: "staff",
      bookingId: booking.id,
      dedupeKey: `staff.manual_review:${booking.id}:${kind}`,
      data: {
        booking: { reference: booking.reference, recordLocator: "", consoleUrl },
        review: { reason: alert.reason },
      },
    });
  }

  /**
   * Queues one e-mail; a call the outbox refuses (InvalidNotificationError, raised before any SQL: a recipient that is
   * not one address, say) is logged and skipped, so the booking's state is recorded all the same.
   */
  private async enqueue(
    trx: TenantTransaction,
    bookingId: string,
    key: TemplateKey,
    input: Parameters<OutboxService["enqueue"]>[1],
  ): Promise<void> {
    try {
      await this.outbox.enqueue(trx, input);
    } catch (error) {
      if (!(error instanceof InvalidNotificationError)) {
        throw error;
      }
      this.logger.error({ bookingId, template: key }, "bookings.reconcile_email_invalid");
    }
  }

  private async paymentEvent(
    trx: TenantTransaction,
    row: PaymentRow,
    event: {
      readonly type: string;
      readonly statusFrom?: string | undefined;
      readonly statusTo?: string | undefined;
      readonly amount?: string | undefined;
      readonly payload: Record<string, unknown>;
      readonly now: Date;
    },
  ): Promise<void> {
    await this.payments.insertEvent(trx, {
      id: this.ids.newId("pev"),
      payment_id: row.id,
      type: event.type,
      source: "system",
      status_from: event.statusFrom ?? null,
      status_to: event.statusTo ?? null,
      amount: event.amount ?? null,
      currency: event.amount === undefined ? null : row.currency,
      payload: JSON.stringify(event.payload),
      created_at: event.now,
      updated_at: event.now,
    });
  }
}
