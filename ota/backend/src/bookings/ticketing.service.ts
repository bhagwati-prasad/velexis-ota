// The issuance retries of the ticketing job (OBE-044; OADR-0008 points 3–5 and 8, OADR-0014 point 6,
// ota/docs/flows/ticketing-and-documents.md §2, §3 steps 1–4 and §4). It runs in the worker only, for one booking of
// the tenant of the current job context (ticketing.processor.ts opens it), and no database transaction is open while
// Amadeus is called (architecture §4).
//
//   1. Claim (T1). The booking is locked with `FOR NO KEY UPDATE SKIP LOCKED` (a booking another claim, worker or
//      request holds is skipped; lead decision of 2026-10-22, OADR-0014 point 6: a transaction that only holds the
//      booking's `FOR KEY SHARE`, the foreign-key lock of an insert of a booking event, an outbox row or a document
//      row, never makes the claim skip: such a transaction can only add rows that reference the booking, never change
//      the booking row the claim reads and writes, and the result step below waits for it) and checked again, whatever
//      the job said: `confirmed` with an Amadeus order, not paid by airline card (OBE-051 sends those to manual review;
//      they are never retried), paid when the tenant is suspended (OADR-0008 point 8), no cancellation holding it
//      (lead decision (1) of 2026-10-27, FIX-W31-OTA, cancellation-state.ts `cancellationHoldOf`: a cancellation's
//      claim committed less than 5 minutes ago whose outcome is not recorded, `bookings.cancellation_claimed_at`, or an
//      `undecided` DELETE without an answer; skip `cancellation_pending`, the booking stays due), and due:
//      `ticketing_status` `pending` or `failed` with `ticketing_next_attempt_at` reached, or an
//      `in_progress` claim older than TICKETING_CLAIM_TTL_MS (abandoned by a worker or request that stopped). The claim
//      writes `in_progress`, `ticketing_last_attempt_at = now` (the claim's fencing token), no next attempt and, for an
//      attempt that may issue, `ticketing_attempts + 1`; it commits before Amadeus is called. An attempt that may not
//      issue any more (ticketing-schedule.ts: the last failure was for payment reasons, eight attempts were made, or
//      the deadline is less than 2 hours away; a worker that was down can be late) only re-reads the order.
//   2. Resync. Flight Order Management GET, always first: tickets that an earlier, timed-out call issued are recorded
//      instead of issued twice (OADR-0008 point 4). Tickets for every traveller, or for some, are recorded (step 4).
//      A GET that fails is a failed attempt: the order is never issued without it.
//   3. Issue. Without tickets, and when the attempt may issue: Flight Order Issue with the OTA-merchant form of payment
//      for the order's offers (order-request.builder.ts). An answer with tickets is recorded; a refusal, an answer
//      without tickets or no answer at all (a timeout "may have issued": the next attempt starts with a resync, flow
//      §4) is a failed attempt.
//   4. Result (T2), fenced by the claim: the booking is locked again and must still be `confirmed` and `in_progress`
//      with the claim's `ticketing_last_attempt_at`; otherwise the claim was taken over (or the booking changed) and
//      nothing is written. Tickets: `booking_tickets` (a number the booking has already is kept), `ticketed` /
//      `issued` (or `partially_ticketed` / `partially_issued`), the redacted `order_snapshot`, `last_synced_at`, event
//      `booking.ticketed`. A failure: `failed` with the error code, and the next attempt of ticketing-schedule.ts with
//      event `booking.ticketing_failed`; or, when there is none, giving up (OADR-0008 point 5): no next attempt, events
//      `booking.ticketing_failed` (staff) and `booking.ticketing_delayed` (the traveller's timeline), outbox
//      `staff.ticketing_failed` and `booking.ticketing_delayed`, each once per booking (dedupe keys). The worker never
//      cancels: staff issue or cancel from the console.
//
// Staff alerts go to `storefront_settings.ops_alert_email`, else to the owners' e-mails read from the platform, else to
// OPS_ALERT_EMAIL (Velexis ops): notifications/staff-recipients.ts (OBE-055, OADR-0013 item 5). Log lines carry ids,
// attempt numbers and error codes, never an Amadeus body, a ticket or a person's data.
//
// console.bookings.issue (OBE-063, console/console-booking-actions.service.ts) takes the same claim in the API: the
// booking `FOR NO KEY UPDATE SKIP LOCKED` through TicketingRepository.lock, a fresh claim of this job or of another
// request refused (`ticketingClaimFresh`), then `in_progress` with `ticketing_last_attempt_at = now` as its fencing
// token, so the job skips the booking while staff issue it (claimSkip: `not_due`) and a staff issuance never runs
// next to the job's. Like each attempt of the job it reads the order first (step 2: tickets an earlier, timed-out call
// issued are recorded, not issued again), and its result step records the tickets with the job's own step
// (`recordIssuedTickets`). console.bookings.cancel refuses a booking while such a claim is fresh, and bookings.cancel
// too since FIX-W30-OTA; the other way round, since FIX-W31-OTA both ticketing claims leave a booking alone while a
// cancellation holds it (step 1: the job skips it, console.bookings.issue answers `409 BOOKING_NOT_MODIFIABLE` with
// `details.reason = cancellation_pending`), so neither calls Flight Order Issue on an order being deleted.
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppError } from "@velexis/errors";
import { sql } from "@velexis/db";
import { redactPayload } from "@velexis/logger";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AmadeusClient } from "../amadeus/amadeus.client";
import type { AmadeusCallContext } from "../amadeus/call-context";
import { Clock } from "../common/clock";
import type { WorkerConfig } from "../config";
import { InvalidNotificationError, OutboxService } from "../notifications/outbox.service";
import { storefrontUrl } from "../notifications/renderer";
import { StaffRecipients, type StaffAlertInput } from "../notifications/staff-recipients";
import type { TemplateKey } from "../notifications/templates/registry";
import { Money } from "../pricing/pricing.types";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { BookingsRepository, type BookingChildren } from "./bookings.repository";
import { cancellationHoldOf, cancellationUndecidedOf } from "./cancellation-state";
import {
  OrderRecorder,
  readCreatedOrder,
  ticketCoverage,
  ticketingStateOf,
  type CreatedOrder,
  type TicketCoverage,
} from "./order-recorder";
import { buildIssueRequest } from "./order-request.builder";
import {
  nextTicketingAttempt,
  ticketingAttemptRefusal,
  type TicketingNext,
  type TicketingStop,
} from "./ticketing-schedule";

/** A claim older than this counts as abandoned (OADR-0014 point 6). */
export const TICKETING_CLAIM_TTL_MS = 5 * 60_000;

/** The Velexis operation of the ticketing job's Amadeus calls (`supplier_requests.operation`). */
export const TICKETING_OPERATION = "ticketing.issue";

/** The booking events the job writes, all as the system. */
const SYSTEM_ACTOR = Object.freeze({ type: "system", id: null });

/** A BCP 47 locale as the outbox accepts it. */
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

/** What the ticketing job reads of a booking. */
export interface TicketingBookingRow {
  readonly id: string;
  readonly environment: string;
  readonly reference: string;
  readonly status: string;
  readonly customerId: string | null;
  readonly amadeusOrderId: string | null;
  readonly recordLocator: string | null;
  readonly ownerOfficeId: string | null;
  readonly ticketingStatus: string;
  readonly ticketingAttempts: number;
  readonly ticketingLastAttemptAt: Date | null;
  readonly ticketingNextAttemptAt: Date | null;
  readonly ticketingDeadlineAt: Date | null;
  readonly ticketingErrorCode: string | null;
  readonly issuedAt: Date | null;
  readonly contactEmail: string;
  readonly currency: string;
  readonly totalAmount: string;
  readonly amountPaid: string;
  readonly version: number;
  /** A payment of the booking is an airline-card payment (`payments.method = airline_card`). */
  readonly paidByAirlineCard: boolean;
  /** `bookings.cancellation_claimed_at`: a cancellation's claim whose outcome is not recorded yet (FIX-W31-OTA). */
  readonly cancellationClaimedAt: Date | null;
  /** The booking's cancellation is `undecided` (a DELETE without an answer), read after the lock (FIX-W31-OTA). */
  readonly cancellationUndecided: boolean;
}

/** The query options of the scan. */
export interface DueBookingsQuery {
  readonly now: Date;
  /** Only bookings with a captured amount (a suspended tenant's, OADR-0008 point 8). */
  readonly paidOnly: boolean;
  readonly limit: number;
}

/** The ticketing queries on `bookings` (tenant repository: the `tenantTx` transaction first, never a schema name). */
@Injectable()
export class TicketingRepository {
  /**
   * The ids of the bookings whose issuance is due at `now` (the claim's rule of the file header, in SQL), the longest
   * waiting first, at most `limit`. The partial index `bookings_ticketing_retry_idx` serves the first branch.
   */
  async dueBookingIds(trx: TenantTransaction, query: DueBookingsQuery): Promise<string[]> {
    const abandonedBefore = new Date(query.now.getTime() - TICKETING_CLAIM_TTL_MS);
    let select = trx
      .selectFrom("bookings")
      .select("bookings.id")
      .where("bookings.status", "=", "confirmed")
      .where("bookings.amadeus_order_id", "is not", null)
      .where((eb) =>
        eb.or([
          eb.and([
            eb("bookings.ticketing_status", "in", ["pending", "failed"]),
            eb("bookings.ticketing_next_attempt_at", "is not", null),
            eb("bookings.ticketing_next_attempt_at", "<=", query.now),
          ]),
          eb.and([
            eb("bookings.ticketing_status", "=", "in_progress"),
            eb("bookings.ticketing_last_attempt_at", "<", abandonedBefore),
          ]),
        ]),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("payments")
              .select(sql<number>`1`.as("one"))
              .whereRef("payments.booking_id", "=", "bookings.id")
              .where("payments.method", "=", "airline_card"),
          ),
        ),
      );
    if (query.paidOnly) {
      select = select.where("bookings.amount_paid", ">", "0");
    }
    const rows = await select
      .orderBy(sql`coalesce(bookings.ticketing_next_attempt_at, bookings.ticketing_last_attempt_at)`)
      .orderBy("bookings.id")
      .limit(query.limit)
      .execute();
    return rows.map((row) => row.id);
  }

  /**
   * The booking `id`, locked `FOR NO KEY UPDATE SKIP LOCKED` (the claim, see the file header) or `FOR UPDATE` (the
   * result, which waits); `undefined` when it does not exist or, with `skipLocked`, when another claim, worker or
   * request holds it (`FOR NO KEY UPDATE` or stronger; a `FOR KEY SHARE` holder never makes the claim skip). Its
   * cancellation state is read in a statement after the lock (`cancellationUndecided`), so it holds what a cancellation
   * that held the booking committed (the flag of a DELETE without an answer is a booking event, not a column of the
   * row); `cancellation_claimed_at` comes with the row, whose latest version the lock returns.
   */
  async lock(
    trx: TenantTransaction,
    id: string,
    options: { readonly skipLocked: boolean },
  ): Promise<TicketingBookingRow | undefined> {
    const query = trx
      .selectFrom("bookings")
      .select((eb) => [
        "bookings.id",
        "bookings.cancellation_claimed_at as cancellationClaimedAt",
        "bookings.environment",
        "bookings.reference",
        "bookings.status",
        "bookings.customer_id as customerId",
        "bookings.amadeus_order_id as amadeusOrderId",
        "bookings.record_locator as recordLocator",
        "bookings.owner_office_id as ownerOfficeId",
        "bookings.ticketing_status as ticketingStatus",
        "bookings.ticketing_attempts as ticketingAttempts",
        "bookings.ticketing_last_attempt_at as ticketingLastAttemptAt",
        "bookings.ticketing_next_attempt_at as ticketingNextAttemptAt",
        "bookings.ticketing_deadline_at as ticketingDeadlineAt",
        "bookings.ticketing_error_code as ticketingErrorCode",
        "bookings.issued_at as issuedAt",
        "bookings.contact_email as contactEmail",
        "bookings.version",
        sql<string>`bookings.currency::text`.as("currency"),
        sql<string>`bookings.total_amount::text`.as("totalAmount"),
        sql<string>`bookings.amount_paid::text`.as("amountPaid"),
        eb
          .exists(
            eb
              .selectFrom("payments")
              .select(sql<number>`1`.as("one"))
              .whereRef("payments.booking_id", "=", "bookings.id")
              .where("payments.method", "=", "airline_card"),
          )
          .as("paidByAirlineCard"),
      ])
      .where("bookings.id", "=", id);
    const row = await (
      options.skipLocked ? query.forNoKeyUpdate().skipLocked() : query.forUpdate()
    ).executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    return {
      ...row,
      paidByAirlineCard: Boolean(row.paidByAirlineCard),
      cancellationUndecided: await cancellationUndecidedOf(trx, row.id),
    };
  }
}

/** Why a ticketing job did nothing. */
export type TicketingSkip =
  /** No such booking in the tenant, or another transaction holds it. */
  | "not_claimable"
  | "not_confirmed"
  | "no_order"
  | "airline_card"
  /** A suspended tenant's booking without a captured amount. */
  | "unpaid"
  /**
   * A cancellation holds the booking (FIX-W31-OTA): its DELETE is in flight (a fresh `cancellation_claimed_at`) or
   * got no answer and is undecided; the booking stays due and a later scan tries again once the outcome is recorded.
   */
  | "cancellation_pending"
  /** Not due yet, already issued, given up, waiting for staff, or freshly claimed by someone else. */
  | "not_due";

/** What one ticketing job did (kept with the BullMQ job): ids, counts and codes, never more. */
export type TicketingOutcome =
  | { readonly outcome: "skipped"; readonly reason: TicketingSkip }
  | {
      readonly outcome: "ticketed";
      /** `resync`: the GET found tickets (no issue call); `issue`: Flight Order Issue answered with them. */
      readonly via: "resync" | "issue";
      readonly coverage: Exclude<TicketCoverage, "none">;
      readonly attempts: number;
    }
  | {
      readonly outcome: "retry_scheduled";
      readonly attempts: number;
      readonly code: string;
      /** ISO 8601. */
      readonly nextAttemptAt: string;
    }
  | {
      readonly outcome: "gave_up";
      readonly attempts: number;
      readonly code: string;
      readonly reason: TicketingStop;
    }
  /** The claim was taken over, or the booking changed meanwhile: nothing was written. */
  | { readonly outcome: "claim_lost" };

/** A claimed booking. */
interface Claim {
  readonly booking: TicketingBookingRow;
  /** `ticketing_last_attempt_at` of the claim: its fencing token. */
  readonly claimedAt: Date;
  /** `ticketing_attempts` after the claim. */
  readonly attempts: number;
  /** Why this attempt may not issue (it only re-reads the order); `undefined` when it may. */
  readonly refusal: TicketingStop | undefined;
  readonly environment: "test" | "live";
}

/** A failed attempt, as the result step records it. */
interface Failure {
  readonly code: string;
  /** `ticketing_error` (console only): codes, never an Amadeus body. */
  readonly message: string;
  readonly supplierRequestId: string | null;
}

/** An Amadeus call's outcome: the order read from the answer, or the code of the failure. */
type OrderReply =
  | { readonly ok: true; readonly order: CreatedOrder; readonly supplierRequestId: string | null }
  | { readonly ok: false; readonly code: string; readonly supplierRequestId: string | null };

/** Why a booking may not be claimed at `now`, or `undefined` when it may. */
export function claimSkip(
  row: TicketingBookingRow,
  now: Date,
  tenantStatus: PlatformTenant["status"],
): TicketingSkip | undefined {
  if (row.status !== "confirmed") {
    return "not_confirmed";
  }
  if (row.amadeusOrderId === null) {
    return "no_order";
  }
  if (row.paidByAirlineCard) {
    return "airline_card";
  }
  if (tenantStatus === "suspended" && !new Money(row.amountPaid).greaterThan(0)) {
    return "unpaid";
  }
  if (cancellationHoldOf(row, now) !== undefined) {
    return "cancellation_pending";
  }
  const retryDue =
    (row.ticketingStatus === "pending" || row.ticketingStatus === "failed") &&
    row.ticketingNextAttemptAt !== null &&
    row.ticketingNextAttemptAt.getTime() <= now.getTime();
  const abandoned =
    row.ticketingStatus === "in_progress" &&
    row.ticketingLastAttemptAt !== null &&
    now.getTime() - row.ticketingLastAttemptAt.getTime() > TICKETING_CLAIM_TTL_MS;
  return retryDue || abandoned ? undefined : "not_due";
}

/**
 * Whether a booking's ticketing claim is fresh at `now`: `in_progress` and claimed less than TICKETING_CLAIM_TTL_MS ago,
 * by this job or by a staff issuance (console.bookings.issue refuses to claim such a booking; an older claim is
 * abandoned and may be taken over).
 */
export function ticketingClaimFresh(
  row: Pick<TicketingBookingRow, "ticketingStatus" | "ticketingLastAttemptAt">,
  now: Date,
): boolean {
  return (
    row.ticketingStatus === "in_progress" &&
    row.ticketingLastAttemptAt !== null &&
    now.getTime() - row.ticketingLastAttemptAt.getTime() <= TICKETING_CLAIM_TTL_MS
  );
}

/** What the result step writes with the tickets (the event's facts). */
export interface IssuedTicketsEvent {
  readonly actor: { readonly type: string; readonly id: string | null };
  readonly summary: string;
  readonly data: Record<string, unknown>;
  readonly supplierRequestId: string | null;
  readonly requestId: string;
  readonly now: Date;
  /** Queue the traveller's `booking.ticketed` e-mail (default); the e-ticket receipts are queued in every case. */
  readonly notifyCustomer?: boolean;
}

/**
 * The result step of an issuance with tickets, in the caller's transaction, whose caller locked the booking and
 * checked its claim (the ticketing job's `fenced`, console.bookings.issue's own fence): `booking_tickets` (a number the
 * booking has already is kept), `ticketed` / `issued` (or `partially_ticketed` / `partially_issued`), `issued_at`, no
 * next attempt or error, the redacted `order_snapshot`, `last_synced_at`, `version + 1`, and the event
 * `booking.ticketed` (OrderRecorder.event: the receipts and, unless `notifyCustomer` is false, the e-mail). Answers the
 * statuses written.
 */
export async function recordIssuedTickets(
  trx: TenantTransaction,
  deps: { readonly bookings: BookingsRepository; readonly recorder: OrderRecorder },
  current: Pick<TicketingBookingRow, "id" | "status" | "issuedAt">,
  order: CreatedOrder,
  event: IssuedTicketsEvent,
): Promise<{ readonly status: string; readonly ticketingStatus: string }> {
  const coverage = ticketCoverage(order.travelerIds, order.tickets);
  if (coverage === "none") {
    throw new Error("recordIssuedTickets: an order without tickets");
  }
  const { now } = event;
  const travelerIds = await deps.bookings.travelerIds(trx, current.id);
  await deps.bookings.insertTickets(trx, deps.recorder.ticketRows(current.id, order, travelerIds, now));
  const state = ticketingStateOf(coverage, { issueRequested: true, policy: "issue_after_payment" });
  await deps.bookings.updateBooking(trx, current.id, {
    status: state.status,
    ticketing_status: state.ticketingStatus,
    issued_at: current.issuedAt ?? now,
    ticketing_next_attempt_at: null,
    ticketing_error_code: null,
    ticketing_error: null,
    order_snapshot: JSON.stringify(redactPayload(order.data)),
    last_synced_at: now,
    updated_at: now,
  });
  await deps.recorder.event(trx, current.id, {
    type: "booking.ticketed",
    actor: event.actor,
    statusFrom: current.status,
    statusTo: state.status,
    summary: event.summary,
    data: event.data,
    visibleToCustomer: true,
    supplierRequestId: event.supplierRequestId,
    requestId: event.requestId,
    now,
    ...(event.notifyCustomer === false ? { notifyCustomer: false } : {}),
  });
  return { status: state.status, ticketingStatus: state.ticketingStatus };
}

/** The API code of a failed call: an AppError's code, `INTERNAL_ERROR` for anything else (a bug). */
function codeOf(error: unknown): string {
  return error instanceof AppError ? error.code : "INTERNAL_ERROR";
}

/** Why the job stopped, for `ticketing_error` and the staff alert. */
const STOP_TEXT: Readonly<Record<TicketingStop, string>> = Object.freeze({
  attempts_exhausted: "every automatic attempt failed",
  deadline: "the ticketing deadline is less than 2 hours away",
  payment: "the airline refused the form of payment",
});

/** Runs one issuance attempt of a booking (see the file header). */
@Injectable()
export class TicketingService {
  private readonly baseDomain: string;
  private readonly adminUrl: string;

  constructor(
    private readonly tx: TenantTx,
    private readonly repository: TicketingRepository,
    private readonly bookings: BookingsRepository,
    private readonly recorder: OrderRecorder,
    private readonly amadeus: AmadeusClient,
    private readonly outbox: OutboxService,
    private readonly staffRecipients: StaffRecipients,
    private readonly clock: Clock,
    config: ConfigService<WorkerConfig, true>,
    @InjectPinoLogger(TicketingService.name) private readonly logger: PinoLogger,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
    this.adminUrl = config.get("PUBLIC_OTA_ADMIN_URL", { infer: true });
  }

  /**
   * One attempt for the booking `bookingId` of `tenant`, in the tenant's job context; `requestId` names the job in the
   * Amadeus calls and the events. Amadeus failures are recorded, never thrown; a database error is thrown (the job
   * fails and BullMQ retries it; a claim it left behind is abandoned after 5 minutes).
   */
  async attempt(tenant: PlatformTenant, bookingId: string, requestId: string): Promise<TicketingOutcome> {
    const claim = await this.claim(tenant, bookingId);
    if (typeof claim === "string") {
      this.logger.debug({ bookingId, reason: claim }, "bookings.ticketing_skipped");
      return { outcome: "skipped", reason: claim };
    }
    const context: AmadeusCallContext = {
      tenantId: tenant.id,
      environment: claim.environment,
      operation: TICKETING_OPERATION,
      requestId,
      bookingId,
      ...(claim.booking.ownerOfficeId === null ? {} : { orderOffice: claim.booking.ownerOfficeId }),
    };

    // Step 2: the resync, always first.
    const resynced = await this.getOrder(context, claim.booking);
    if (resynced.ok && ticketCoverage(resynced.order.travelerIds, resynced.order.tickets) !== "none") {
      return await this.recordTickets(
        tenant,
        claim,
        resynced.order,
        "resync",
        resynced.supplierRequestId,
        requestId,
      );
    }
    if (claim.refusal !== undefined) {
      // No issuance any more: the resync found nothing to record, so the job gives up.
      return await this.recordFailure(
        tenant,
        claim,
        {
          code: claim.booking.ticketingErrorCode ?? "TICKETING_FAILED",
          message: `No further automatic issuance: ${STOP_TEXT[claim.refusal]}`,
          supplierRequestId: resynced.supplierRequestId,
        },
        requestId,
      );
    }
    if (!resynced.ok) {
      return await this.recordFailure(
        tenant,
        claim,
        {
          code: resynced.code,
          message: `Flight Order Management GET failed: ${resynced.code}; the order is not issued without a resync`,
          supplierRequestId: resynced.supplierRequestId,
        },
        requestId,
      );
    }

    // Step 3: the issuance.
    const issued = await this.issueOrder(context, claim.booking, resynced.order);
    if (issued.ok && ticketCoverage(issued.order.travelerIds, issued.order.tickets) !== "none") {
      return await this.recordTickets(
        tenant,
        claim,
        issued.order,
        "issue",
        issued.supplierRequestId,
        requestId,
      );
    }
    return await this.recordFailure(
      tenant,
      claim,
      issued.ok
        ? {
            code: "TICKETING_FAILED",
            message: "Flight Order Issue answered without a ticket",
            supplierRequestId: issued.supplierRequestId,
          }
        : {
            code: issued.code,
            message: `Flight Order Issue failed: ${issued.code}`,
            supplierRequestId: issued.supplierRequestId,
          },
      requestId,
    );
  }

  // ---- Step 1: the claim -------------------------------------------------------------------------------------------

  private async claim(tenant: PlatformTenant, bookingId: string): Promise<Claim | TicketingSkip> {
    return await this.tx.run(async (trx) => {
      const now = this.clock.now();
      const row = await this.repository.lock(trx, bookingId, { skipLocked: true });
      if (row === undefined) {
        return "not_claimable";
      }
      const skip = claimSkip(row, now, tenant.status);
      if (skip !== undefined) {
        return skip;
      }
      if (row.environment !== "test" && row.environment !== "live") {
        return "not_claimable";
      }
      const refusal = ticketingAttemptRefusal({
        attempts: row.ticketingAttempts,
        at: now,
        deadlineAt: row.ticketingDeadlineAt,
        lastErrorCode: row.ticketingErrorCode,
      });
      const attempts = refusal === undefined ? row.ticketingAttempts + 1 : row.ticketingAttempts;
      await this.bookings.updateBooking(trx, row.id, {
        ticketing_status: "in_progress",
        ticketing_attempts: attempts,
        ticketing_last_attempt_at: now,
        ticketing_next_attempt_at: null,
        updated_at: now,
      });
      this.logger.info(
        {
          bookingId: row.id,
          attempt: attempts,
          resyncOnly: refusal !== undefined,
          abandoned: row.ticketingStatus === "in_progress",
        },
        "bookings.ticketing_claimed",
      );
      return { booking: row, claimedAt: now, attempts, refusal, environment: row.environment };
    });
  }

  // ---- Steps 2 and 3: Amadeus --------------------------------------------------------------------------------------

  /** Flight Order Management GET of the booking's order. */
  private async getOrder(context: AmadeusCallContext, booking: TicketingBookingRow): Promise<OrderReply> {
    try {
      const reply = await this.amadeus.getFlightOrder(context, {
        flightOrderId: booking.amadeusOrderId ?? "",
      });
      const order = readCreatedOrder(reply.body);
      if (order === undefined) {
        this.logger.warn({ bookingId: booking.id }, "bookings.ticketing_order_unreadable");
        return { ok: false, code: "SUPPLIER_ERROR", supplierRequestId: reply.call.supplierRequestId };
      }
      return { ok: true, order, supplierRequestId: reply.call.supplierRequestId };
    } catch (error) {
      const code = codeOf(error);
      this.logger.warn({ bookingId: booking.id, code }, "bookings.ticketing_resync_failed");
      return { ok: false, code, supplierRequestId: null };
    }
  }

  /** Flight Order Issue of the booking's order, for the offers the resync read. */
  private async issueOrder(
    context: AmadeusCallContext,
    booking: TicketingBookingRow,
    order: CreatedOrder,
  ): Promise<OrderReply> {
    try {
      const reply = await this.amadeus.issueFlightOrder(context, {
        flightOrderId: booking.amadeusOrderId ?? order.id,
        body: buildIssueRequest(order.offers.map((offer) => offer.amadeusId)) as unknown as Parameters<
          AmadeusClient["issueFlightOrder"]
        >[1]["body"],
      });
      const issued = readCreatedOrder(reply.body);
      if (issued === undefined) {
        // Amadeus answered 2xx, so the tickets may exist: the next attempt's resync reads them.
        this.logger.warn({ bookingId: booking.id }, "bookings.ticketing_issue_unreadable");
        return { ok: false, code: "SUPPLIER_ERROR", supplierRequestId: reply.call.supplierRequestId };
      }
      return { ok: true, order: issued, supplierRequestId: reply.call.supplierRequestId };
    } catch (error) {
      const code = codeOf(error);
      this.logger.warn({ bookingId: booking.id, code }, "bookings.issue_failed");
      return { ok: false, code, supplierRequestId: null };
    }
  }

  // ---- Step 4: the result ------------------------------------------------------------------------------------------

  /**
   * The booking locked again, or `undefined` when the claim is no longer this job's: the booking is not `confirmed`
   * and `in_progress` with the claim's `ticketing_last_attempt_at` any more.
   */
  private async fenced(trx: TenantTransaction, claim: Claim): Promise<TicketingBookingRow | undefined> {
    const current = await this.repository.lock(trx, claim.booking.id, { skipLocked: false });
    if (
      current?.status !== "confirmed" ||
      current.ticketingStatus !== "in_progress" ||
      current.ticketingLastAttemptAt?.getTime() !== claim.claimedAt.getTime()
    ) {
      this.logger.warn(
        { bookingId: claim.booking.id, attempt: claim.attempts, version: current?.version },
        "bookings.ticketing_claim_lost",
      );
      return undefined;
    }
    if (current.version !== claim.booking.version + 1) {
      // Changed meanwhile by something that keeps out of ticketing (contacts, tags): the claim still holds.
      this.logger.debug(
        { bookingId: current.id, claimedVersion: claim.booking.version + 1, version: current.version },
        "bookings.ticketing_concurrent_change",
      );
    }
    return current;
  }

  private async recordTickets(
    tenant: PlatformTenant,
    claim: Claim,
    order: CreatedOrder,
    via: "resync" | "issue",
    supplierRequestId: string | null,
    requestId: string,
  ): Promise<TicketingOutcome> {
    const coverage = ticketCoverage(order.travelerIds, order.tickets);
    if (coverage === "none") {
      throw new Error("recordTickets: an order without tickets");
    }
    const written = await this.tx.run(async (trx) => {
      const now = this.clock.now();
      const current = await this.fenced(trx, claim);
      if (current === undefined) {
        return false;
      }
      await recordIssuedTickets(trx, { bookings: this.bookings, recorder: this.recorder }, current, order, {
        actor: SYSTEM_ACTOR,
        summary:
          via === "resync" ? "E-tickets issued (found at the airline and recorded)." : "E-tickets issued.",
        data: { tickets: order.tickets.map((ticket) => ticket.documentNumber), attempt: claim.attempts, via },
        supplierRequestId,
        requestId,
        now,
      });
      return true;
    });
    if (!written) {
      return { outcome: "claim_lost" };
    }
    this.logger.info(
      { tenantId: tenant.id, bookingId: claim.booking.id, attempt: claim.attempts, via, coverage },
      "bookings.ticketed",
    );
    return { outcome: "ticketed", via, coverage, attempts: claim.attempts };
  }

  private async recordFailure(
    tenant: PlatformTenant,
    claim: Claim,
    failure: Failure,
    requestId: string,
  ): Promise<TicketingOutcome> {
    const result = await this.tx.run(async (trx) => {
      const now = this.clock.now();
      const current = await this.fenced(trx, claim);
      if (current === undefined) {
        return undefined;
      }
      const next: TicketingNext =
        claim.refusal === undefined
          ? nextTicketingAttempt({
              attempts: claim.attempts,
              failedAt: now,
              deadlineAt: current.ticketingDeadlineAt,
              errorCode: failure.code,
            })
          : { kind: "stop", reason: claim.refusal };
      const message =
        next.kind === "retry" ? failure.message : `${failure.message}; gave up: ${STOP_TEXT[next.reason]}`;
      await this.bookings.updateBooking(trx, current.id, {
        ticketing_status: "failed",
        ticketing_next_attempt_at: next.kind === "retry" ? next.at : null,
        ticketing_error_code: failure.code,
        ticketing_error: message,
        updated_at: now,
      });
      await this.recorder.event(trx, current.id, {
        type: "booking.ticketing_failed",
        actor: SYSTEM_ACTOR,
        statusFrom: current.status,
        statusTo: current.status,
        summary:
          next.kind === "retry"
            ? "The airline did not issue the tickets yet; the issuance is retried."
            : "The airline did not issue the tickets; staff must issue them from the console.",
        data: {
          attempt: claim.attempts,
          code: failure.code,
          nextAttemptAt: next.kind === "retry" ? next.at.toISOString() : null,
          ...(next.kind === "stop" ? { stop: next.reason } : {}),
        },
        visibleToCustomer: false,
        supplierRequestId: failure.supplierRequestId,
        requestId,
        now,
      });
      if (next.kind === "stop") {
        await this.recorder.event(trx, current.id, {
          type: "booking.ticketing_delayed",
          actor: SYSTEM_ACTOR,
          statusFrom: current.status,
          statusTo: current.status,
          summary: "Your e-tickets are delayed; our team will issue them as soon as possible.",
          visibleToCustomer: true,
          requestId,
          // One millisecond after the failure it follows: the timeline orders by time, then by the random id.
          now: new Date(now.getTime() + 1),
        });
        await this.giveUpAlerts(trx, tenant, current, {
          code: failure.code,
          message: `The automatic issuance stopped: ${STOP_TEXT[next.reason]}. Issue the tickets or cancel the booking from the console.`,
          attempts: claim.attempts,
        });
      }
      return next;
    });
    if (result === undefined) {
      return { outcome: "claim_lost" };
    }
    if (result.kind === "retry") {
      this.logger.warn(
        {
          tenantId: tenant.id,
          bookingId: claim.booking.id,
          attempt: claim.attempts,
          code: failure.code,
          nextAttemptAt: result.at.toISOString(),
        },
        "bookings.ticketing_retry_scheduled",
      );
      return {
        outcome: "retry_scheduled",
        attempts: claim.attempts,
        code: failure.code,
        nextAttemptAt: result.at.toISOString(),
      };
    }
    this.logger.error(
      {
        tenantId: tenant.id,
        bookingId: claim.booking.id,
        attempt: claim.attempts,
        code: failure.code,
        reason: result.reason,
      },
      "bookings.ticketing_given_up",
    );
    return { outcome: "gave_up", attempts: claim.attempts, code: failure.code, reason: result.reason };
  }

  // ---- Giving up: the e-mails --------------------------------------------------------------------------------------

  /** `staff.ticketing_failed` and `booking.ticketing_delayed`, once per booking each (their dedupe keys). */
  private async giveUpAlerts(
    trx: TenantTransaction,
    tenant: PlatformTenant,
    booking: TicketingBookingRow,
    failure: { readonly code: string; readonly message: string; readonly attempts: number },
  ): Promise<void> {
    const settings = await this.bookings.settings(trx);
    const children = await this.bookings.children(trx, booking.id);
    const consoleUrl = new URL(
      `bookings/${booking.id}`,
      this.adminUrl.endsWith("/") ? this.adminUrl : `${this.adminUrl}/`,
    ).toString();
    await this.alert(trx, booking.id, {
      templateKey: "staff.ticketing_failed",
      locale: settings?.defaultLocale ?? tenant.defaultLocale,
      bookingId: booking.id,
      dedupeKey: `staff.ticketing_failed:${booking.id}`,
      data: {
        booking: { reference: booking.reference, recordLocator: booking.recordLocator ?? "", consoleUrl },
        failure: { code: failure.code, message: failure.message, attempts: failure.attempts },
      },
    });
    const primary = children.contacts.find((contact) => contact.isPrimary) ?? children.contacts[0];
    const language = primary?.language ?? null;
    await this.enqueue(trx, booking.id, "booking.ticketing_delayed", {
      templateKey: "booking.ticketing_delayed",
      to: primary?.email ?? booking.contactEmail,
      locale:
        language !== null && LOCALE.test(language)
          ? language
          : (settings?.defaultLocale ?? tenant.defaultLocale),
      customerId: booking.customerId,
      bookingId: booking.id,
      dedupeKey: `booking.ticketing_delayed:${booking.id}`,
      data: { booking: this.travellerBooking(tenant, booking, children, primary) },
    });
  }

  /** The `booking.*` variables of a traveller e-mail, from the stored booking. */
  private travellerBooking(
    tenant: PlatformTenant,
    booking: TicketingBookingRow,
    children: BookingChildren,
    primary: BookingChildren["contacts"][number] | undefined,
  ): Record<string, unknown> {
    return {
      reference: booking.reference,
      recordLocator: booking.recordLocator ?? "",
      url: `${storefrontUrl(tenant.key, this.baseDomain)}/booking.html?id=${booking.id}`,
      total: { amount: booking.totalAmount, currency: booking.currency },
      contact: { firstName: primary?.firstName ?? "", lastName: primary?.lastName ?? "" },
      travellers: children.travelers.map((traveler) => ({
        firstName: traveler.firstName,
        lastName: traveler.lastName,
      })),
      segments: children.segments.map((segment) => ({
        origin: segment.departureIata,
        destination: segment.arrivalIata,
        departureAt: segment.departureLocal,
        arrivalAt: segment.arrivalLocal,
        carrierCode: segment.carrierCode,
        flightNumber: segment.flightNumber,
      })),
    };
  }

  /** Queues a staff alert to the OTA's staff (see the file header); a refused call is logged and skipped, as below. */
  private async alert(trx: TenantTransaction, bookingId: string, input: StaffAlertInput): Promise<void> {
    try {
      await this.staffRecipients.enqueue(trx, input);
    } catch (error) {
      if (!(error instanceof InvalidNotificationError)) {
        throw error;
      }
      this.logger.error({ bookingId, template: input.templateKey }, "bookings.ticketing_alert_invalid");
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
      this.logger.error({ bookingId, template: key }, "bookings.ticketing_alert_invalid");
    }
  }
}
