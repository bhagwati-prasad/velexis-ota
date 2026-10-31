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
// The lock order (lead decision of 2026-10-21, OADR-0003 point 11): a transaction here that locks several of a checkout,
// a booking, a payment and a refund locks them in that order, and a foreign-key lock (the FOR KEY SHARE an insert of a
// row that references a parent takes) counts as a lock of the parent. One attempt:
//
//   1. Claim (T1). The booking is locked `FOR NO KEY UPDATE SKIP LOCKED` (lead decision of 2026-10-22, OADR-0014 point
//      6: a transaction that only holds the booking's `FOR KEY SHARE`, an insert of a booking event, an outbox row or a
//      document row, never makes the claim skip; another attempt's claim or a decision does) and checked again,
//      whatever the job said: `pending`, `reconcile_until` set, no `reconcile_outcome`, its order sent at least
//      RECONCILE_FIRST_DELAY_MS ago, and no other attempt within RECONCILE_CLAIM_GAP_MS (`updated_at` of the last
//      claim), so two jobs of one minute make one search. The claim writes `reconcile_attempts + 1` (the attempt's fencing token) and commits.
//   2. Search. Without a booking queue (`storefront_settings.booking_queue_number`) the order cannot be looked for.
//      Otherwise Queue List of the booking queue in the booking's queuing office (at most RECONCILE_QUEUE_LIST_MAX
//      PNRs), then every PNR created between `create_order_started_at − 1 min` and `+ 5 min` (Queue List gives the
//      minute, read in UTC) whose travellers' names include the lead traveller's last name, the closest in time first,
//      read by record locator (Get Flight Order by Record Locator), at most RECONCILE_MAX_READS per attempt (`readSlice`:
//      the next attempt reads the next ones). An order is accepted only when it carries the general remark
//      `VELEXIS <reference>` with sub-type BACKOFFICE: a name alone never is. A read Amadeus answers `404` (cancelled,
//      purged) is a PNR that is not ours. A search that could not read every PNR that may be the order is incomplete
//      (SearchGap, lead decision of 2026-10-21, third batch): Queue List failed, answered something else than a list,
//      or may have left PNRs out (it holds RECONCILE_QUEUE_LIST_MAX of them, or its `meta.count` says more); an entry
//      that may be the order has no record locator or no readable names (it is not read: without the lead's name it
//      may be any other PNR of the queue); the cap was reached; a read failed or timed out; or the order with the
//      remark cannot be read. An incomplete search never proves the order absent.
//   3. Decide (T2), with the booking locked again and still `pending` without an outcome:
//      - found: the order is recorded as checkout.complete records it (order-recorder.ts: `confirmed` or `ticketed`,
//        children, events, the `booking.confirmed` e-mail), `reconcile_outcome = found`, the checkout `completed`
//        (which releases its lock), the checkout locked before the booking; then the money: the Stripe capture
//        `pi:capture:<pay_id>:<amount>` of the booking's total, which checkout.complete records before Flight Create
//        Orders (the priced offer the order was sent from, a re-price included) and never more than the authorisation
//        (not for the `manual_review` policy without tickets, whose staff are alerted), a failed capture handled as
//        checkout.complete handles it (`manual_review`, `payment.capture_retry` 10 minutes later, staff alert), and its
//        safety net added by T2 before its commit as checkout.complete's record step adds it (the same delayed
//        `capture-retry-<pay_id>`, lead decision (4) of 2026-10-24, FIX-W29-OTA: a worker that stopped between the
//        commit and the capture leaves no authorisation behind, as the decided booking is never claimed again); then,
//        for `issue_after_payment`, the issuance through the ticketing job's own attempt (ticketing.service.ts: a
//        resync first, then Flight Order Issue), its next attempt set to now so the ticketing scan takes it over when
//        needed;
//      - not found by `reconcile_until` (a complete search of an attempt claimed at or after it found nothing; or,
//        without a booking queue, simply once it passed), and only when the attempt still holds its claim: the checkout,
//        the booking and its payments locked in that order, the booking `failed` (`failure_code = SUPPLIER_TIMEOUT`,
//        `reconcile_outcome = not_found`, `checkout_id` cleared), the checkout reopened (`open`, or `expired` past its
//        expiry), `payment.void` of its Stripe authorisation queued on `ota-payments` after the commit
//        (payments.processor.ts voids it, `pi:cancel:<pay_id>`), the e-mail `booking.not_confirmed` to the traveller and
//        a staff alert (`staff.manual_review`; "check the office by hand" without a booking queue);
//      - undecided at `reconcile_until` (the search of an attempt claimed at or after it was incomplete), only while the
//        attempt still holds its claim: OADR-0003 point 5's manual review, nothing voided: the booking stays `pending`
//        with its checkout and authorisation, `reconcile_outcome = manual_review`, `ticketing_status = manual_review`,
//        the staff event `booking.reconcile_manual_review` and a staff alert; the scan stops, the staff decide. Unless
//        the search is incomplete only because of transient failures (lead decision (3) of 2026-10-22: a rate limit,
//        a timeout, a `5xx` or a network error of Queue List or of a by-reference read, `transientFailure`) and fewer
//        than RECONCILE_DEADLINE_RETRIES such attempts were tried again: then the staff event
//        `booking.reconcile_deadline_retry` (their number is the grace used) and the next scan's attempt searches
//        again; a search incomplete for any other reason (the read cap, a truncated or unreadable Queue List, entries
//        or an order that cannot be read) goes to the review at the deadline;
//      - anything else waits for the next attempt: a search before `reconcile_until` that found nothing, or that was
//        incomplete.
//    An airline-card booking (OBE-051, OADR-0004 point 7) is never failed automatically, as the airline may have charged
//    the card: found, its order is recorded and its payment settled as checkout.completeWithAirlineCard settles it
//    (`settleAirlineCardOrder`: `captured` with `airline.charged` when every ticket came back, else the booking's
//    ticketing in `manual_review` and a staff alert); not found by `reconcile_until` (or no booking queue), it goes to
//    the staff's review instead of the failure: the booking stays `pending` with its checkout and its `processing`
//    payment, `reconcile_outcome = manual_review`, `ticketing_status = manual_review`, the staff event
//    `booking.reconcile_manual_review` (`reason: airline_card_not_found`) and a staff alert; the scan stops. Before
//    OBE-051 such a booking stayed `pending` without an outcome and every attempt answered `pending` (`airline_card`).
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
import type { WorkerConfig } from "../config";
import { InvalidNotificationError, OutboxService } from "../notifications/outbox.service";
import { storefrontUrl } from "../notifications/renderer";
import type { TemplateKey } from "../notifications/templates/registry";
import {
  PAYMENT_GATEWAY,
  recordedPaymentAccount,
  type GatewayContext,
  type GatewayState,
  type PaymentGateway,
} from "../payments/payment-gateway";
import { providerStateUpdate } from "../payments/payment-state";
import {
  addSafetyNet,
  captureAmountOf,
  PAYMENT_JOB,
  paymentJob,
  safetyNetJob,
} from "../payments/payments.processor";
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
  type TicketCoverage,
} from "./order-recorder";
import { VELEXIS_REMARK_SUBTYPE, type TicketingPolicy } from "./order-request.builder";
import { StaffAlerts } from "./staff-alerts";
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
 * The event of a booking whose search was still incomplete at `reconcile_until` (`booking_events.type`, staff only):
 * `reconcile_outcome = manual_review`, the staff decide.
 */
export const RECONCILE_MANUAL_REVIEW_EVENT = "booking.reconcile_manual_review";

/**
 * The shortest time between two attempts of one booking: the first job and a scan job of the same minute, or two
 * scans, make one search. Shorter than the scan's minute, so the cadence stays one attempt per minute.
 */
export const RECONCILE_CLAIM_GAP_MS = 45_000;

/**
 * The grace after `reconcile_until` (lead decision (3) of 2026-10-22, OADR-0003 point 5): a search at or after it that
 * is incomplete only because of transient failures (`transientFailure`: a rate limit, a timeout, a `5xx` or a network
 * error of Queue List or of a by-reference read) gets up to this many more attempts, one per reconcile run, before the
 * staff's review. A search incomplete for any other reason goes to the review at once.
 */
export const RECONCILE_DEADLINE_RETRIES = 3;

/**
 * The event of an attempt at or after `reconcile_until` whose search failed transiently and that is tried again
 * (`booking_events.type`, staff only): their number is the grace used (RECONCILE_DEADLINE_RETRIES).
 */
export const RECONCILE_DEADLINE_RETRY_EVENT = "booking.reconcile_deadline_retry";

/** A PNR is a candidate when Queue List says it was created from this long before the order was sent … */
export const RECONCILE_CREATED_BEFORE_MS = 60_000;
/** … to this long after. */
export const RECONCILE_CREATED_AFTER_MS = 5 * 60_000;

/**
 * By-reference reads of one attempt, at most: a safety cap far above the candidates of a booking queue (the PNRs of
 * one lead last name created within six minutes). An attempt that has more candidates reads this many and is
 * incomplete; the next attempt reads the next ones (`readSlice`). Before the lead decision of 2026-10-21 (third
 * batch) an attempt read three, so a fourth PNR of the same minute could stay unread and the order be voided.
 */
export const RECONCILE_MAX_READS = 50;

/**
 * The `max` of the reconciliation's Queue List: an answer that holds this many PNRs, or whose `meta.count` says the
 * queue holds more than it lists, may have left the order out, so its search is incomplete (an assumption to confirm
 * with Amadeus with the queue convention, OADR-0003 follow-ups).
 */
export const RECONCILE_QUEUE_LIST_MAX = 500;

/**
 * A Queue List answer of the booking queue that holds this many entries or more (or whose `meta.count` says the queue
 * does) raises the staff alert `booking_queue_nearly_full` (lead decision (5) of 2026-10-23: 80 % of the
 * RECONCILE_QUEUE_LIST_MAX one answer can carry; cleaning the queue stays manual in Amadeus: the runbook "Cleaning the
 * booking queue" of ota/backend/README.md §4), at most once a UTC day per OTA and environment (`bookingQueueAlertKey`;
 * test and live separately since FIX-W28-NOTIFY, lead decision (5) of 2026-10-23).
 */
export const BOOKING_QUEUE_ALERT_ENTRIES = 400;

/** The kind of the staff alert of a booking queue that is nearly full (its dedupe key's middle part). */
export const BOOKING_QUEUE_ALERT = "booking_queue_nearly_full";

/**
 * The dedupe key of the queue alert of `environment` (`test`, `live`) and the UTC day of `now`: one alert per OTA (tenant
 * schema), environment and day, so a test queue that fills never silences the live one's alert.
 */
export const bookingQueueAlertKey = (now: Date, environment: string): string =>
  `staff.manual_review:${BOOKING_QUEUE_ALERT}:${environment}:${now.toISOString().slice(0, 10)}`;

/** When `payment.capture_retry` runs after a failed capture (OADR-0008 point 7). */
export const CAPTURE_RETRY_DELAY_MS = 10 * 60_000;

/**
 * Whether the money step captures the payment of a recorded order (checkout.complete's step 4, the reconciliation's
 * found decision): unless the policy is `manual_review` and no ticket was issued (staff issue from the console, which
 * captures first).
 */
export function mustCaptureOrder(policy: string, recorded: Pick<RecordedOrder, "coverage">): boolean {
  return policy !== "manual_review" || recorded.coverage !== "none";
}

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
  /** Its creation, to the minute, as Queue List gives it; `null` when the entry's creation cannot be read. */
  readonly createdAt: Date | null;
}

/** What a Queue List answer says about the booking's order (`queueCandidates`). */
export interface QueueCandidates {
  /**
   * Every PNR that may be the order, each record locator once: created within the window, or at a time that cannot be
   * read, with a traveller of the lead's last name; the closest in time first, those of an unknown time last.
   */
  readonly candidates: readonly QueueCandidate[];
  /**
   * Entries that may be the order but are not read: within the window (or of an unknown time), with the lead's last
   * name but no record locator, or whose travellers' names cannot be read (without the lead's name, any other PNR).
   */
  readonly unreadable: number;
  /** The answer may list fewer PNRs than the queue holds (RECONCILE_QUEUE_LIST_MAX, `meta.count`). */
  readonly truncated: boolean;
  /**
   * How many entries the queue holds as far as the answer tells: its entries, or its `meta.count` when that says
   * more (BOOKING_QUEUE_ALERT_ENTRIES).
   */
  readonly entries: number;
}

/** Why a search could not read every PNR that may be the order: it never proves the order absent. */
export type SearchGap =
  /** Queue List failed (no answer, a refusal, a timeout). */
  | "queue_failed"
  /** Queue List answered something that is not a list of PNRs. */
  | "queue_unreadable"
  /** Queue List may have left PNRs out (RECONCILE_QUEUE_LIST_MAX, `meta.count`). */
  | "queue_truncated"
  /** The booking has no lead last name to match the PNRs with. */
  | "lead_unknown"
  /** A PNR that may be the order is not read: no record locator or no readable names (`QueueCandidates.unreadable`). */
  | "candidate_unreadable"
  /** More candidates than RECONCILE_MAX_READS: the next attempt reads the next ones. */
  | "read_cap"
  /** A by-reference read failed or timed out (other than a `404`). */
  | "read_failed"
  /** A PNR carries the booking's remark but its order cannot be read: it exists, so the booking is never failed. */
  | "order_unreadable";

/** `meta.count` of a Queue List answer, a number or a decimal string (the specification's example); else `undefined`. */
function queueCountOf(meta: unknown): number | undefined {
  const count = isRecord(meta) ? meta["count"] : undefined;
  if (typeof count === "number" && Number.isInteger(count) && count >= 0) {
    return count;
  }
  return typeof count === "string" && /^\d{1,9}$/.test(count) ? Number(count) : undefined;
}

/** The last names of a Queue List entry's travellers, or `undefined` when it names none that can be read. */
function queueLastNamesOf(entry: JsonObject): string[] | undefined {
  const names = records(entry["travelers"])
    .flatMap((traveler) => records(traveler["names"]))
    .map((name) => comparableName(name["lastName"]))
    .filter((name) => name !== "");
  return names.length > 0 ? names : undefined;
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
 * around `startedAt` (the entry's minute counts from its start), or at a time that cannot be read, with a traveller of
 * the lead's last name; every one of them, the closest in time first, each record locator once (lead decision of
 * 2026-10-21, third batch: an order is never left unread because others of its minute came first). The entries that
 * may be the order but cannot be read, and whether the answer may be truncated (it holds `max` PNRs, or its
 * `meta.count` says more), are counted, so the search can tell that it is incomplete. `undefined` when the answer is
 * not a list of PNRs, or the booking has no lead last name to match.
 */
export function queueCandidates(
  reply: unknown,
  booking: { readonly startedAt: Date; readonly leadLastName: string },
  max: number = RECONCILE_QUEUE_LIST_MAX,
): QueueCandidates | undefined {
  const lead = comparableName(booking.leadLastName);
  if (lead === "" || !isRecord(reply) || !Array.isArray(reply["data"])) {
    return undefined;
  }
  const data: readonly unknown[] = reply["data"];
  const count = queueCountOf(reply["meta"]);
  const truncated = data.length >= max || (count !== undefined && count > data.length);
  const started = booking.startedAt.getTime();
  // The minute Queue List gives starts up to 59 s before the PNR was created.
  const earliest = Math.floor((started - RECONCILE_CREATED_BEFORE_MS) / 60_000) * 60_000;
  const latest = started + RECONCILE_CREATED_AFTER_MS;
  const found = new Map<string, QueueCandidate>();
  let unreadable = 0;
  for (const item of data) {
    if (!isRecord(item)) {
      // Nothing of it can be read, its time and names included: it may be the order.
      unreadable += 1;
      continue;
    }
    const createdAt = queueCreationOf(item) ?? null;
    if (createdAt !== null && (createdAt.getTime() < earliest || createdAt.getTime() > latest)) {
      continue;
    }
    const names = queueLastNamesOf(item);
    if (names !== undefined && !names.includes(lead)) {
      continue;
    }
    const recordLocator = queueRecordLocatorOf(item);
    if (names === undefined || recordLocator === undefined) {
      unreadable += 1;
      continue;
    }
    const known = found.get(recordLocator);
    if (known === undefined || (known.createdAt === null && createdAt !== null)) {
      found.set(recordLocator, { recordLocator, createdAt });
    }
  }
  const distance = (candidate: QueueCandidate): number =>
    candidate.createdAt === null
      ? Number.POSITIVE_INFINITY
      : Math.abs(candidate.createdAt.getTime() - started);
  const candidates = [...found.values()].sort((a, b) => {
    const da = distance(a);
    const db = distance(b);
    return da === db ? a.recordLocator.localeCompare(b.recordLocator) : da < db ? -1 : 1;
  });
  return { candidates, unreadable, truncated, entries: Math.max(data.length, count ?? 0) };
}

/**
 * The candidates an attempt reads (lead decision of 2026-10-21, third batch): all of them when they are at most
 * `cap`; otherwise `cap` of them, the reads of attempt `n` starting where attempt `n − 1` stopped in the ordered list
 * (from `(n − 1) × cap`, wrapping round), so that the attempts read the candidates in turns. Such an attempt has not
 * read every candidate: it is incomplete and never proves the order absent.
 */
export function readSlice<T>(
  candidates: readonly T[],
  attempt: number,
  cap: number = RECONCILE_MAX_READS,
): readonly T[] {
  if (candidates.length <= cap) {
    return candidates;
  }
  const start = (Math.max(0, attempt - 1) * cap) % candidates.length;
  return [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, cap);
}

/**
 * Why a Queue List answer leaves an attempt's search incomplete whatever its reads find (lead decision of 2026-10-21,
 * third batch): the answer may have left PNRs out, an entry that may be the order is not read (no record locator or
 * no readable names), or the attempt reads (`reads`, its `readSlice`) fewer candidates than there are; `undefined`
 * when every PNR that may be the order is among the reads.
 */
export function listedGap(listed: QueueCandidates, reads: number): SearchGap | undefined {
  if (listed.truncated) {
    return "queue_truncated";
  }
  if (listed.unreadable > 0) {
    return "candidate_unreadable";
  }
  return reads < listed.candidates.length ? "read_cap" : undefined;
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
   * `FOR NO KEY UPDATE SKIP LOCKED` (a booking another transaction holds, such as its own request's or another scan's,
   * is left to a later scan; one whose `FOR KEY SHARE` alone is held, by the insert of a row that references it, is
   * adopted: lead decision of 2026-10-22, OADR-0014 point 6), get `reconcile_until = now + RECONCILE_WINDOW_MS`. A
   * claim is adopted once: an adopted booking has its `reconcile_until`, and a concurrent scan skips the rows this one
   * holds. Answers what it adopted; the caller writes their events in the same transaction. `bookings_status_idx`
   * (environment, status) serves it.
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
      .forNoKeyUpdate()
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
   * The booking `id`, locked `FOR NO KEY UPDATE SKIP LOCKED` (the claim, see the file header) or `FOR UPDATE` (the
   * decision, which waits); `undefined` when it does not exist or, with `skipLocked`, when another claim or a decision
   * holds it (`FOR NO KEY UPDATE` or stronger; a `FOR KEY SHARE` holder never makes the claim skip).
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
      .where("id", "=", id);
    return await (
      options.skipLocked ? query.forNoKeyUpdate().skipLocked() : query.forUpdate()
    ).executeTakeFirst();
  }

  /**
   * How many attempts after `reconcile_until` failed transiently and were tried again (RECONCILE_DEADLINE_RETRY_EVENT,
   * lead decision (3) of 2026-10-22): the grace used. The booking's own events count it, so no column is needed;
   * `booking_events_booking_idx` serves it.
   */
  async deadlineRetries(trx: TenantTransaction, bookingId: string): Promise<number> {
    const row = await trx
      .selectFrom("booking_events")
      .select(sql<number>`count(*)::int`.as("retries"))
      .where("booking_id", "=", bookingId)
      .where("type", "=", RECONCILE_DEADLINE_RETRY_EVENT)
      .executeTakeFirst();
    return row?.retries ?? 0;
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

// ---- The airline card's settlement (OBE-051) ------------------------------------------------------------------------

/** The kind (dedupe key's last part) of the staff alert of an airline-card order without every ticket. */
export const AIRLINE_CARD_NOT_TICKETED = "airline_card_not_ticketed";

/** The reason and alert kind of an airline-card booking whose order was not found by `reconcile_until`. */
export const AIRLINE_CARD_NOT_FOUND = "airline_card_not_found";

/** The booking event of an airline-card order without every ticket (staff only): the staff decide. */
export const AIRLINE_CARD_TICKETING_REVIEW_EVENT = "booking.ticketing_manual_review";

/** What `settleAirlineCardOrder` writes with: the orchestration's or the reconciliation's own repositories. */
export interface AirlineCardSettlementDeps {
  readonly bookings: BookingsRepository;
  readonly payments: PaymentsRepository;
  readonly recorder: OrderRecorder;
  readonly ids: IdGenerator;
}

/** What `settleAirlineCardOrder` did. */
export interface AirlineCardSettlement {
  readonly paymentId: string;
  /** True when the airline charged the card (every ticket came back): the payment is `captured`. */
  readonly captured: boolean;
}

/**
 * The payment of an airline-card booking whose order was just recorded (OADR-0004 point 5; OBE-051), in the record
 * step's transaction, which locked the checkout and the booking: the booking's airline-card payment is locked next
 * (OADR-0003 point 11). An order with every ticket: the airline charged the card, so the payment is `captured` for its
 * amount (`amount_authorized = amount_captured = amount`, `payment_events` `airline.charged` with the amount only),
 * the booking's `amount_paid` is that amount and the customer's timeline says so (`payment.captured`). Otherwise the
 * payment stays `processing` (the staff check what the airline charged) and the booking's ticketing goes to
 * `manual_review` without a next attempt: Flight Order Issue never carries the card, which is gone (api-changes.md
 * §3.2), so the ticketing job never takes it (it skips airline-card bookings anyway); the caller alerts the staff
 * (AIRLINE_CARD_NOT_TICKETED). `undefined` for a booking without an airline-card payment.
 */
export async function settleAirlineCardOrder(
  trx: TenantTransaction,
  deps: AirlineCardSettlementDeps,
  input: {
    readonly bookingId: string;
    readonly coverage: TicketCoverage;
    readonly actor: { readonly type: string; readonly id: string | null };
    /** `payment_events.source`: the API's request or the worker's job. */
    readonly source: "api" | "system";
    readonly requestId: string;
    readonly now: Date;
  },
): Promise<AirlineCardSettlement | undefined> {
  const { bookingId, now } = input;
  let paymentId: string | undefined;
  for (const id of await deps.bookings.paymentIdsOf(trx, bookingId)) {
    const row = await deps.payments.payment(trx, id);
    if (row?.method === "airline_card") {
      paymentId = row.id;
    }
  }
  const payment = paymentId === undefined ? undefined : await deps.payments.payment(trx, paymentId, true);
  if (payment === undefined) {
    return undefined;
  }
  if (input.coverage !== "full") {
    await deps.bookings.updateBooking(trx, bookingId, {
      ticketing_status: "manual_review",
      ticketing_next_attempt_at: null,
      ticketing_error_code: "TICKETING_FAILED",
      ticketing_error:
        "Flight Create Orders with issue=true and the airline card returned no ticket for every traveller; the card " +
        "cannot be used again",
      updated_at: now,
    });
    await deps.recorder.event(trx, bookingId, {
      type: AIRLINE_CARD_TICKETING_REVIEW_EVENT,
      actor: input.actor,
      summary:
        "The airline did not issue every ticket of the order paid by airline card; staff check the order and decide.",
      data: { paymentId: payment.id, coverage: input.coverage },
      visibleToCustomer: false,
      requestId: input.requestId,
      now,
    });
    return { paymentId: payment.id, captured: false };
  }
  if (payment.status !== "captured") {
    await deps.payments.updatePayment(trx, payment.id, payment.version, {
      status: "captured",
      amount_authorized: payment.amount,
      amount_captured: payment.amount,
      authorized_at: payment.authorizedAt ?? now,
      captured_at: payment.capturedAt ?? now,
      failure_code: null,
      failure_message: null,
      updated_at: now,
    });
    await deps.payments.insertEvent(trx, {
      id: deps.ids.newId("pev"),
      payment_id: payment.id,
      type: "airline.charged",
      source: input.source,
      status_from: payment.status,
      status_to: "captured",
      amount: payment.amount,
      currency: payment.currency,
      payload: JSON.stringify({ bookingId }),
      created_at: now,
      updated_at: now,
    });
    await deps.bookings.updateBooking(trx, bookingId, { amount_paid: payment.amount, updated_at: now });
    await deps.recorder.event(trx, bookingId, {
      type: "payment.captured",
      actor: input.actor,
      summary: "The airline charged your card.",
      data: { paymentId: payment.id, amount: payment.amount },
      visibleToCustomer: true,
      requestId: input.requestId,
      now,
    });
  }
  return { paymentId: payment.id, captured: true };
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
  /**
   * Before `reconcile_until`, a search that could not read every PNR that may be the order (SearchGap): the next
   * attempt looks again.
   */
  | "search_incomplete"
  /**
   * At or after `reconcile_until`, a search incomplete only because of transient failures, within the grace of
   * RECONCILE_DEADLINE_RETRIES more attempts (lead decision (3) of 2026-10-22): the next attempt searches again.
   */
  | "deadline_retry"
  /** The order was found but could not be recorded: the next attempt tries again, staff were alerted. */
  | "record_failed";

/** What one attempt did (kept with the BullMQ job): ids, counts and codes, never more. */
export type ReconcileOutcome =
  | { readonly outcome: "skipped"; readonly reason: ReconcileSkip }
  | {
      readonly outcome: "pending";
      readonly attempts: number;
      readonly reason: ReconcileWait;
      /** `deadline_retry`: which of the RECONCILE_DEADLINE_RETRIES more attempts comes next (1 to 3). */
      readonly retry?: number;
    }
  | {
      readonly outcome: "found";
      readonly attempts: number;
      readonly status: string;
      readonly captured: boolean;
      readonly ticketing: string | null;
    }
  | { readonly outcome: "not_found"; readonly attempts: number; readonly voids: number }
  /**
   * The search at `reconcile_until` was still incomplete: the booking stays `pending` with its authorisation and
   * `reconcile_outcome = manual_review`, and the staff decide (OADR-0003 point 5).
   */
  | { readonly outcome: "manual_review"; readonly attempts: number; readonly gap: SearchGap }
  /**
   * An airline-card booking whose order was not found by `reconcile_until` (or without a booking queue): the staff's
   * review instead of the failure, as the airline may have charged the card (OBE-051, OADR-0004 point 7).
   */
  | {
      readonly outcome: "manual_review";
      readonly attempts: number;
      readonly reason: typeof AIRLINE_CARD_NOT_FOUND;
    }
  /** Decided meanwhile by another attempt or by staff, or another attempt claimed it since: nothing written. */
  | { readonly outcome: "decided_elsewhere" | "claim_lost"; readonly attempts: number };

/** A claimed booking. */
interface Claim {
  readonly booking: ReconcileBookingRow;
  /** `reconcile_attempts` after the claim: its fencing token. */
  readonly attempts: number;
  /** The more attempts after `reconcile_until` already given (RECONCILE_DEADLINE_RETRY_EVENT), at the claim. */
  readonly deadlineRetries: number;
  /** When the attempt claimed the booking, before its search. */
  readonly claimedAt: Date;
  readonly startedAt: Date;
  readonly until: Date;
  readonly environment: "test" | "live";
}

/** What a search found. */
type SearchResult =
  | { readonly kind: "found"; readonly order: CreatedOrder; readonly supplierRequestId: string | null }
  /** Every PNR that may be the order was read, and none carries the booking's remark: the order is absent. */
  | { readonly kind: "absent"; readonly candidates: number }
  /**
   * Not every PNR that may be the order could be read (`gap`, with the API code of a failed call): proves nothing.
   * `candidates` and `read` count the PNRs worth reading and those read. `transient`: only calls that failed
   * transiently (`transientFailure`) left it incomplete, so the grace after `reconcile_until` applies.
   */
  | {
      readonly kind: "incomplete";
      readonly gap: SearchGap;
      readonly code: string;
      readonly candidates: number;
      readonly read: number;
      readonly transient: boolean;
    }
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

/** The API codes of a call that failed transiently (error-mapper.ts, rate-limiter.ts): worth another attempt. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  // The buckets of the credential set or of the tenant were empty (rate-limiter.ts): no request was sent.
  "RATE_LIMITED",
  // No answer in time, a cut connection, or Amadeus's gateway gave up (504).
  "SUPPLIER_TIMEOUT",
  // A connection that could not be made, Amadeus's 502 and 503, and Amadeus's 429 (the shared quota).
  "SUPPLIER_UNAVAILABLE",
  // Redis or the platform data did not answer: the call was not made.
  "SERVICE_UNAVAILABLE",
]);

/**
 * Whether a failed Queue List or by-reference read failed transiently (lead decision (3) of 2026-10-22): a rate limit
 * (ours or Amadeus's `429`), a timeout, a `5xx` (`500` with 141 SYSTEM ERROR and any other one included, which the
 * mapper answers `502 SUPPLIER_ERROR`) or a network error. Anything else (a refusal, a `401`, an answer that cannot be
 * read, a bug) is not: trying again a minute later would meet it again.
 */
export function transientFailure(error: unknown): boolean {
  if (!(error instanceof AppError)) {
    return false;
  }
  if (TRANSIENT_CODES.has(error.code)) {
    return true;
  }
  const cause = error.cause;
  return (
    cause instanceof AmadeusCallError &&
    (cause.outcome === "timeout" ||
      cause.outcome === "network_error" ||
      cause.httpStatus === 429 ||
      (cause.httpStatus !== undefined && cause.httpStatus >= 500))
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

/**
 * The decision an attempt takes after its search (see the file header): a found order is recorded; before
 * `reconcile_until` anything else waits for the next attempt; at or after it, a complete search that found nothing
 * (or the lack of a booking queue, OADR-0003 point 5) fails the booking and voids, and an incomplete one goes to the
 * staff's review (lead decision of 2026-10-21, third batch: an incomplete search never proves the order absent),
 * unless only transient failures left it incomplete (`grace.transient`) and fewer than RECONCILE_DEADLINE_RETRIES
 * more attempts were given (`grace.used`): then it is tried again (lead decision (3) of 2026-10-22).
 */
export function reconcileDecision(
  search: SearchResult["kind"],
  pastDeadline: boolean,
  grace: { readonly transient: boolean; readonly used: number } = { transient: false, used: 0 },
): "record" | "fail" | "review" | "retry" | "wait" {
  if (search === "found") {
    return "record";
  }
  if (!pastDeadline) {
    return "wait";
  }
  if (search !== "incomplete") {
    return "fail";
  }
  return grace.transient && grace.used < RECONCILE_DEADLINE_RETRIES ? "retry" : "review";
}

/** Runs one reconciliation attempt of a booking (see the file header). */
@Injectable()
export class ReconcileService {
  private readonly baseDomain: string;

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
    private readonly alerts: StaffAlerts,
    @InjectQueue(OTA_QUEUE.payments) private readonly paymentsQueue: Queue,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    config: ConfigService<WorkerConfig, true>,
    @InjectPinoLogger(ReconcileService.name) private readonly logger: PinoLogger,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
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
        ...(search.kind === "incomplete"
          ? {
              gap: search.gap,
              code: search.code,
              candidates: search.candidates,
              read: search.read,
              transient: search.transient,
            }
          : {}),
        pastDeadline,
      },
      "bookings.reconcile_searched",
    );
    const grace = {
      transient: search.kind === "incomplete" && search.transient,
      used: claim.deadlineRetries,
    };
    switch (reconcileDecision(search.kind, pastDeadline, grace)) {
      case "record":
        return search.kind === "found"
          ? await this.recordFound(tenant, claim, search.order, search.supplierRequestId, requestId)
          : { outcome: "pending", attempts: claim.attempts, reason: "search_incomplete" };
      case "fail":
        return await this.failNotFound(tenant, claim, settings, search.kind === "no_queue", requestId);
      case "review":
        return search.kind === "incomplete"
          ? await this.manualReview(tenant, claim, settings, search, requestId)
          : { outcome: "pending", attempts: claim.attempts, reason: "search_incomplete" };
      case "retry":
        return search.kind === "incomplete"
          ? await this.deadlineRetry(claim, search, requestId)
          : { outcome: "pending", attempts: claim.attempts, reason: "search_incomplete" };
      case "wait":
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
      // The grace used so far (lead decision (3) of 2026-10-22); only an attempt past the deadline asks.
      const deadlineRetries =
        now.getTime() >= row.reconcileUntil.getTime()
          ? await this.repository.deadlineRetries(trx, row.id)
          : 0;
      this.logger.info({ bookingId: row.id, attempt: attempts }, "bookings.reconcile_claimed");
      return {
        booking: row,
        attempts,
        deadlineRetries,
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
    const incomplete = (
      gap: SearchGap,
      code: string,
      transient: boolean,
      candidates = 0,
      read = 0,
    ): SearchResult => ({
      kind: "incomplete",
      gap,
      code,
      candidates,
      read,
      transient,
    });
    if (comparableName(claim.booking.leadLastName) === "") {
      // No name to match a PNR with: nothing can be proven absent.
      this.logger.error({ bookingId: claim.booking.id }, "bookings.reconcile_lead_unknown");
      return incomplete("lead_unknown", "INTERNAL_ERROR", false);
    }
    const context: AmadeusCallContext = {
      tenantId: tenant.id,
      environment: claim.environment,
      operation: RECONCILE_OPERATION,
      requestId,
      bookingId: claim.booking.id,
    };
    let listed: QueueCandidates | undefined;
    try {
      const reply = await this.amadeus.listQueue(context, {
        queueId: queue,
        query: {
          category: settings?.bookingQueueCategory ?? 0,
          max: RECONCILE_QUEUE_LIST_MAX,
          ...(claim.booking.queuingOfficeId === null ? {} : { officeId: claim.booking.queuingOfficeId }),
        },
      });
      listed = queueCandidates(reply.body, {
        startedAt: claim.startedAt,
        leadLastName: claim.booking.leadLastName,
      });
    } catch (error) {
      const code = codeOf(error);
      this.logger.warn({ bookingId: claim.booking.id, code }, "bookings.reconcile_queue_failed");
      return incomplete("queue_failed", code, transientFailure(error));
    }
    if (listed === undefined) {
      this.logger.warn({ bookingId: claim.booking.id }, "bookings.reconcile_queue_unreadable");
      return incomplete("queue_unreadable", "SUPPLIER_ERROR", false);
    }
    if (listed.entries >= BOOKING_QUEUE_ALERT_ENTRIES) {
      // Staff clean the queue by hand before it outgrows one answer; the search goes on as it would without it.
      await this.queueNearlyFull(tenant, claim, settings, queue, listed.entries);
    }
    const { candidates } = listed;
    const reads = readSlice(candidates, claim.attempts);
    // What makes the search incomplete, the first gap seen; every PNR read is still read (it may be the order).
    const listGap = listedGap(listed, reads.length);
    let gap: { readonly gap: SearchGap; readonly code: string } | undefined =
      listGap === undefined ? undefined : { gap: listGap, code: "SUPPLIER_ERROR" };
    // Whether only transient failures leave it incomplete: what Queue List and the cap leave out never is.
    let transient = listGap === undefined;
    let read = 0;
    for (const candidate of reads) {
      read += 1;
      try {
        const reply = await this.amadeus.getFlightOrderByReference(context, {
          query: { reference: candidate.recordLocator, originSystemCode: ORIGIN_SYSTEM_CODE },
        });
        const order = orderOfBooking(reply.body, claim.booking.reference);
        if (order === null) {
          // The order exists but cannot be recorded: never failed for it.
          this.logger.error({ bookingId: claim.booking.id }, "bookings.reconcile_order_unreadable");
          gap ??= { gap: "order_unreadable", code: "SUPPLIER_ERROR" };
          transient = false;
        } else if (order !== undefined) {
          return { kind: "found", order, supplierRequestId: reply.call.supplierRequestId };
        }
      } catch (error) {
        if (!isNotFound(error)) {
          // A refusal, a timeout or no answer: what was not read may be the order.
          const code = codeOf(error);
          this.logger.warn({ bookingId: claim.booking.id, code }, "bookings.reconcile_read_failed");
          gap ??= { gap: "read_failed", code };
          transient &&= transientFailure(error);
        }
      }
    }
    if (gap !== undefined) {
      if (listGap !== undefined) {
        this.logger.warn(
          {
            bookingId: claim.booking.id,
            gap: gap.gap,
            candidates: candidates.length,
            unreadable: listed.unreadable,
            read,
          },
          "bookings.reconcile_search_partial",
        );
      }
      return incomplete(gap.gap, gap.code, transient, candidates.length, read);
    }
    return { kind: "absent", candidates: candidates.length };
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
    let recorded:
      | {
          readonly result: RecordedOrder;
          readonly issueRequested: boolean;
          /** The airline-card payment's settlement (OBE-051); `undefined` for a booking paid otherwise. */
          readonly airline: AirlineCardSettlement | undefined;
        }
      | undefined;
    try {
      recorded = await this.tx.run(async (trx) => {
        const now = this.clock.now();
        // The lock order: the checkout, then the booking (lead decision of 2026-10-21, OADR-0003 point 11).
        await this.checkouts.checkout(trx, checkoutId, true);
        const current = await this.repository.lock(trx, id, { skipLocked: false });
        if (
          current?.status !== "pending" ||
          current.reconcileOutcome !== null ||
          current.checkoutId !== checkoutId
        ) {
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
        // An airline-card booking: the airline charged the card with the order (OBE-051), nothing to capture.
        const airline = await settleAirlineCardOrder(
          trx,
          { bookings: this.bookings, payments: this.payments, recorder: this.recorder, ids: this.ids },
          {
            bookingId: id,
            coverage: result.coverage,
            actor: SYSTEM_ACTOR,
            source: "system",
            requestId,
            now: new Date(now.getTime() + 2),
          },
        );
        if (airline?.captured === false) {
          await this.staffAlert(trx, tenant, booking, settings, AIRLINE_CARD_NOT_TICKETED, {
            reason:
              `The order of booking ${booking.reference}, paid by airline card, was found after a timeout without ` +
              "every ticket. The card cannot be used again: check the order in the office, then issue the tickets " +
              "with another form of payment or cancel the booking from the console.",
          });
        }
        if (airline === undefined && mustCaptureOrder(policy, result)) {
          // The capture below runs after this commit: its safety net is added before it (FIX-W29-OTA).
          const payment = await this.capturablePayment(trx, id);
          if (payment !== undefined && payment.status !== "captured") {
            await this.queueCaptureSafetyNet(tenant, id, payment.id);
          }
        }
        return { result, issueRequested: booking.issueRequested, airline };
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

    if (recorded.airline !== undefined) {
      // The airline card: charged by the airline with the order, which was issued at its creation (OBE-051).
      const final = await this.tx.run((trx) => this.bookings.booking(trx, id));
      return {
        outcome: "found",
        attempts: claim.attempts,
        status: final?.status ?? result.status,
        captured: recorded.airline.captured,
        ticketing: null,
      };
    }

    // The money, as checkout.complete's step 4.
    const mustCapture = mustCaptureOrder(policy, result);
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
      const payment = await this.capturablePayment(trx, id);
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
    // The total of the priced offer the order was sent from, which checkout.complete records on the booking before it
    // sends Flight Create Orders (a re-price included, lead decision of 2026-10-21, third batch), and never more than
    // the authorisation (`captureAmountOf`: a total above it captures the amount authorised).
    const amount = captureAmountOf(booking.totalAmount, payment, minorUnits);
    if (!new Money(amount).equals(booking.totalAmount)) {
      this.logger.error(
        { bookingId: id, paymentId: payment.id, total: booking.totalAmount, captured: amount },
        "bookings.reconcile_total_above_authorisation",
      );
    }
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
            account: recordedPaymentAccount(payment.metadata),
            connectionId: payment.providerConnectionId,
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

  /** The booking's Stripe payment with a PaymentIntent (the last one), or `undefined` (an airline-card booking). */
  private async capturablePayment(
    trx: TenantTransaction,
    bookingId: string,
  ): Promise<PaymentRow | undefined> {
    let payment: PaymentRow | undefined;
    for (const paymentId of await this.bookings.paymentIdsOf(trx, bookingId)) {
      const row = await this.payments.payment(trx, paymentId);
      if (row?.provider === "stripe" && row.providerPaymentId !== null) {
        payment = row;
      }
    }
    return payment;
  }

  /**
   * The safety net of the capture after the record step (lead decision (4) of 2026-10-24, FIX-W29-OTA; see the file
   * header): the delayed `payment.capture_retry` of the payment (`capture-retry-<pay_id>`), added in the record step's
   * transaction before its commit. Never throws: a net Redis does not take is logged.
   */
  private async queueCaptureSafetyNet(
    tenant: PlatformTenant,
    bookingId: string,
    paymentId: string,
  ): Promise<void> {
    const net = safetyNetJob("capture", tenant.id, paymentId, CAPTURE_RETRY_DELAY_MS);
    const outcome = await addSafetyNet(this.paymentsQueue, net);
    if (outcome !== "added") {
      this.logger.warn(
        { bookingId, jobId: net.opts.jobId, outcome },
        "bookings.capture_safety_net_not_queued",
      );
    }
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
    const checkoutId = claim.booking.checkoutId;
    const decided = await this.tx.run(async (trx): Promise<ReconcileOutcome> => {
      const now = this.clock.now();
      // The lock order of the claim: the checkout, then the booking, then its payments (lead decision of 2026-10-21,
      // OADR-0003 point 11). Before FIX-W25-BOOKINGS the checkout came last, after the booking and the payments.
      const checkout = checkoutId === null ? undefined : await this.checkouts.checkout(trx, checkoutId, true);
      const current = await this.repository.lock(trx, id, { skipLocked: false });
      if (
        current?.status !== "pending" ||
        current.reconcileOutcome !== null ||
        current.checkoutId !== checkoutId
      ) {
        return { outcome: "decided_elsewhere", attempts: claim.attempts };
      }
      if (current.reconcileAttempts !== claim.attempts) {
        // Another attempt claimed the booking since: it decides with its own, newer search.
        return { outcome: "claim_lost", attempts: claim.attempts };
      }
      const payments = await this.repository.lockPayments(trx, id);
      if (payments.some((payment) => payment.method === "airline_card")) {
        // The airline may have charged the card: never an automatic failure, the staff decide (OADR-0004 point 7).
        return await this.airlineCardReview(trx, tenant, claim, current, settings, noQueue, requestId, now);
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
    } else if (decided.outcome === "manual_review") {
      this.logger.warn(
        { tenantId: tenant.id, bookingId: id, attempt: claim.attempts, noQueue },
        "bookings.reconcile_airline_card_review",
      );
    } else {
      this.logger.warn(
        { bookingId: id, attempt: claim.attempts, outcome: decided.outcome },
        "bookings.reconcile_not_decided",
      );
    }
    return decided;
  }

  /**
   * An airline-card booking whose order was not found by `reconcile_until` (or without a booking queue; see the file
   * header), in the not-found decision's transaction, which locked the checkout, the booking and its payments: the
   * staff's review, nothing else changes (the checkout stays locked by the pending booking, the payment `processing`).
   */
  private async airlineCardReview(
    trx: TenantTransaction,
    tenant: PlatformTenant,
    claim: Claim,
    booking: ReconcileBookingRow,
    settings: BookingSettingsRow | undefined,
    noQueue: boolean,
    requestId: string,
    now: Date,
  ): Promise<ReconcileOutcome> {
    await this.bookings.updateBooking(trx, booking.id, {
      reconcile_outcome: "manual_review",
      ticketing_status: "manual_review",
      ticketing_next_attempt_at: null,
      updated_at: now,
    });
    await this.recorder.event(trx, booking.id, {
      type: RECONCILE_MANUAL_REVIEW_EVENT,
      actor: SYSTEM_ACTOR,
      statusFrom: "pending",
      statusTo: "pending",
      summary:
        `The order of booking ${booking.reference}, paid by airline card, was not found by ` +
        `${claim.until.toISOString()}; the airline may have charged the card, so the staff decide.`,
      data: {
        reconcileOutcome: "manual_review",
        reason: AIRLINE_CARD_NOT_FOUND,
        attempt: claim.attempts,
        bookingQueue: !noQueue,
      },
      visibleToCustomer: false,
      requestId,
      now,
    });
    await this.staffAlert(trx, tenant, booking, settings, `reconcile_${AIRLINE_CARD_NOT_FOUND}`, {
      reason: noQueue
        ? `Amadeus did not confirm booking ${booking.reference}, paid by airline card, and the OTA has no booking ` +
          "queue, so the order could not be looked for. The airline may have charged the card: look for the order " +
          `with the remark VELEXIS ${booking.reference} in the office, then settle the booking from the console.`
        : `Amadeus did not confirm booking ${booking.reference}, paid by airline card, and its order was not found ` +
          "in the booking queue within 15 minutes. The airline may have charged the card: look for the order with " +
          `the remark VELEXIS ${booking.reference} in the office, then settle the booking from the console (a ` +
          "charge without an order is reversed by the airline).",
    });
    return { outcome: "manual_review", attempts: claim.attempts, reason: AIRLINE_CARD_NOT_FOUND };
  }

  // ---- Step 3: undecided ---------------------------------------------------------------------------------------

  /**
   * The search of an attempt claimed at or after `reconcile_until` could not read every PNR that may be the order
   * (lead decision of 2026-10-21, third batch): the order may exist, so nothing is voided. As OADR-0003 point 5 settles
   * an order the reconciliation cannot decide, the booking stays `pending` with its checkout (still locked) and its
   * authorisation, gets `reconcile_outcome = manual_review` and `ticketing_status = manual_review` (the console's
   * "needs attention" list; the scan stops), the staff event `booking.reconcile_manual_review` and a staff alert; only
   * while the attempt still holds its claim. The staff look for the order in the office and decide.
   */
  private async manualReview(
    tenant: PlatformTenant,
    claim: Claim,
    settings: BookingSettingsRow | undefined,
    search: Extract<SearchResult, { kind: "incomplete" }>,
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
        return { outcome: "claim_lost", attempts: claim.attempts };
      }
      await this.bookings.updateBooking(trx, id, {
        reconcile_outcome: "manual_review",
        ticketing_status: "manual_review",
        ticketing_next_attempt_at: null,
        updated_at: now,
      });
      await this.recorder.event(trx, id, {
        type: RECONCILE_MANUAL_REVIEW_EVENT,
        actor: SYSTEM_ACTOR,
        statusFrom: "pending",
        statusTo: "pending",
        summary:
          `The order of booking ${current.reference} could be neither found nor proven absent by ` +
          `${claim.until.toISOString()}; the payment authorisation is kept for the staff to decide.`,
        data: {
          reconcileOutcome: "manual_review",
          attempt: claim.attempts,
          gap: search.gap,
          code: search.code,
          candidates: search.candidates,
          read: search.read,
          deadlineRetries: claim.deadlineRetries,
        },
        visibleToCustomer: false,
        requestId,
        now,
      });
      await this.staffAlert(trx, tenant, current, settings, "reconcile_manual_review", {
        reason:
          `Amadeus did not confirm booking ${current.reference}, and by its deadline the reconciliation could not ` +
          `read every order of the booking queue that may be it (${search.gap}, ${search.code}). The booking stays ` +
          "pending and its payment is neither captured nor voided: look for the order with the remark " +
          `VELEXIS ${current.reference} in the office and settle the booking and its payment from the console.`,
      });
      return { outcome: "manual_review", attempts: claim.attempts, gap: search.gap };
    });
    this.logger.warn(
      {
        tenantId: tenant.id,
        bookingId: id,
        attempt: claim.attempts,
        outcome: decided.outcome,
        gap: search.gap,
      },
      "bookings.reconcile_manual_review",
    );
    return decided;
  }

  /**
   * The search of an attempt claimed at or after `reconcile_until` is incomplete only because of transient failures,
   * and fewer than RECONCILE_DEADLINE_RETRIES more attempts were given (lead decision (3) of 2026-10-22, OADR-0003
   * point 5): only while the attempt still holds its claim, the staff event RECONCILE_DEADLINE_RETRY_EVENT (the grace
   * used is their number) and nothing else; the booking stays `pending` without an outcome, so the next scan's attempt
   * searches again, and decides like any attempt past the deadline (found, absent, or, failing again, another retry or
   * the review).
   */
  private async deadlineRetry(
    claim: Claim,
    search: Extract<SearchResult, { kind: "incomplete" }>,
    requestId: string,
  ): Promise<ReconcileOutcome> {
    const id = claim.booking.id;
    const retry = claim.deadlineRetries + 1;
    const decided = await this.tx.run(async (trx): Promise<ReconcileOutcome> => {
      const now = this.clock.now();
      const current = await this.repository.lock(trx, id, { skipLocked: false });
      if (current?.status !== "pending" || current.reconcileOutcome !== null) {
        return { outcome: "decided_elsewhere", attempts: claim.attempts };
      }
      if (current.reconcileAttempts !== claim.attempts) {
        return { outcome: "claim_lost", attempts: claim.attempts };
      }
      await this.recorder.event(trx, id, {
        type: RECONCILE_DEADLINE_RETRY_EVENT,
        actor: SYSTEM_ACTOR,
        statusFrom: "pending",
        statusTo: "pending",
        summary:
          `The search for the order of booking ${current.reference} at its deadline failed for a moment ` +
          `(${search.code}); it is tried again (${retry} of ${RECONCILE_DEADLINE_RETRIES}).`,
        data: {
          attempt: claim.attempts,
          retry,
          retries: RECONCILE_DEADLINE_RETRIES,
          gap: search.gap,
          code: search.code,
          candidates: search.candidates,
          read: search.read,
        },
        visibleToCustomer: false,
        requestId,
        now,
      });
      return { outcome: "pending", attempts: claim.attempts, reason: "deadline_retry", retry };
    });
    this.logger.warn(
      {
        bookingId: id,
        attempt: claim.attempts,
        outcome: decided.outcome,
        retry,
        gap: search.gap,
        code: search.code,
      },
      "bookings.reconcile_deadline_retry",
    );
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
   * A staff alert (`staff.manual_review`) to `ops_alert_email`, else the owners, else OPS_ALERT_EMAIL
   * (notifications/staff-recipients.ts), once per booking and kind (dedupe key `staff.manual_review:<bkg_…>:<kind>`),
   * written by StaffAlerts (staff-alerts.ts). A call the outbox refuses is logged and skipped, as the e-mails of
   * `enqueue` are.
   */
  private async staffAlert(
    trx: TenantTransaction,
    tenant: PlatformTenant,
    booking: Pick<ReconcileBookingRow, "id" | "reference">,
    settings: BookingSettingsRow | undefined,
    kind: string,
    alert: { readonly reason: string },
  ): Promise<void> {
    await this.alerts.send(trx, {
      settings,
      fallbackLocale: tenant.defaultLocale,
      booking: { id: booking.id, reference: booking.reference },
      dedupeKey: `staff.manual_review:${booking.id}:${kind}`,
      reason: alert.reason,
    });
  }

  /**
   * The staff alert of a booking queue that is nearly full (lead decision (5) of 2026-10-23): `staff.manual_review`
   * about the OTA, not a booking, at most once a UTC day per OTA and environment (`bookingQueueAlertKey`, the
   * environment of the booking whose search read the queue), in a short transaction of its own between two Amadeus
   * calls. Its failure is logged and never changes the search.
   */
  private async queueNearlyFull(
    tenant: PlatformTenant,
    claim: Claim,
    settings: BookingSettingsRow | undefined,
    queue: number,
    entries: number,
  ): Promise<void> {
    const now = this.clock.now();
    const category = settings?.bookingQueueCategory ?? 0;
    const office = claim.booking.queuingOfficeId ?? "the queuing office";
    try {
      const queued = await this.tx.run((trx) =>
        this.alerts.send(trx, {
          settings,
          fallbackLocale: tenant.defaultLocale,
          booking: null,
          path: "bookings",
          dedupeKey: bookingQueueAlertKey(now, claim.environment),
          reason:
            `The booking queue ${queue} (category ${category}) of ${office} (${claim.environment}) holds ${entries} ` +
            `PNRs; one Queue List answer carries at most ${RECONCILE_QUEUE_LIST_MAX}, and a fuller queue leaves the ` +
            "search for bookings whose answer was lost incomplete (they go to the staff's review instead of being " +
            "decided). Remove the PNRs of finished bookings from the queue by hand in Amadeus (runbook: Cleaning " +
            "the booking queue, ota/backend/README.md).",
        }),
      );
      this.logger.warn(
        {
          tenantId: tenant.id,
          bookingId: claim.booking.id,
          entries,
          limit: RECONCILE_QUEUE_LIST_MAX,
          queued,
        },
        "bookings.booking_queue_nearly_full",
      );
    } catch (error) {
      this.logger.error(
        { tenantId: tenant.id, bookingId: claim.booking.id, err: error },
        "bookings.booking_queue_alert_failed",
      );
    }
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
