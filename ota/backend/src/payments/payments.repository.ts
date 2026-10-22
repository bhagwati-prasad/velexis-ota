// The tenant repository of payments (OBE-038; db README §2.1, ota/docs/data-model.md): `payments` and their append-only
// `payment_events`, which the payments module owns, plus what the payment steps read or change of tables it does not
// own: the checkout a payment is for (locked while a payment step changes its totals, status and expiry), the
// storefront settings the payment follows (3-D Secure, accepted brands, the airline card of each environment), the
// prices of the checkout's extras (its totals in the pricing mode of the method, OBE-050), the minor units of a
// currency and the countries of airports (the card fee's rule facts). Like every tenant repository it takes the
// `tenantTx` transaction first, never opens one and never names a tenant schema. Amounts are read as text
// (`numeric::text`), never as JavaScript numbers; jsonb is written as JSON text.
//
// OBE-039 adds what the Stripe webhooks need (payments/webhooks/, stripe-events.processor.ts): the payment of a
// PaymentIntent, the webhook's `payment_events` row written once per provider event id (`payment_events_provider_uq`),
// the stored event read back by the processor, the payment's `refunds` rows (whose final state comes from the webhooks;
// OBE-040 creates them) with their `version` lock, and the staff alert's facts (`ops_alert_email`, the default locale and
// the booking's reference).
//
// The lock order (lead decision of 2026-10-21, OADR-0003 point 11): a transaction that locks a booking and its payment
// locks the booking first, then the payment. `lockBookings` takes the booking's lock for the payment jobs and alerts
// that change a booking, or write a row that references one, under a payment's lock.
//
// OBE-068 adds what console.payments needs (console/console-payments.service.ts): the page of the console's list
// (`consolePayments`, newest first with a keyset, in the request's environment), the events, refunds and booking
// summaries of a set of payments in one query each, and the booking writes of a staff capture (`setAmountPaid`) and of
// the refund events (`insertBookingEvent`, also the webhook's `refund.succeeded`; `refundBookingIds` names the bookings
// to lock before the payment).
import { Injectable } from "@nestjs/common";
import { sql, type Insertable, type TenantDatabase, type Updateable } from "@velexis/db";
import type { TenantTransaction } from "../tenancy/tenant-tx";

/** What a payment step reads of `storefront_settings`. */
export interface PaymentSettingsRow {
  readonly require3ds: boolean;
  readonly acceptedCardBrands: readonly string[];
  readonly paymentTiming: string;
  /** `airline_card_enabled_test` and `_live` (OBE-050). */
  readonly airlineCardEnabledTest: boolean;
  readonly airlineCardEnabledLive: boolean;
}

/** The checkout columns a payment step reads and changes. */
export interface PaymentCheckoutRow {
  readonly id: string;
  readonly environment: string;
  readonly status: string;
  readonly customerId: string | null;
  readonly isGuest: boolean;
  readonly pricedOfferId: string;
  readonly currency: string;
  readonly offerAmount: string;
  readonly ancillariesAmount: string;
  readonly feesAmount: string;
  readonly totalAmount: string;
  readonly paymentBrand: string | null;
  /** `markup_rules` or `net` (checkout/pricing-mode.ts). */
  readonly pricingMode: string;
  readonly expiresAt: Date;
  readonly version: number;
}

/** The two prices of one extra of a checkout (`checkout_ancillaries`). */
export interface CheckoutSelectionPricesRow {
  /** The selling price of the selection. */
  readonly priceAmount: string;
  /** The Amadeus price of the selection. */
  readonly netAmount: string;
}

/** A `payments` row, with the access columns of its checkout. */
export interface PaymentRow {
  readonly id: string;
  readonly environment: string;
  readonly checkoutId: string | null;
  readonly bookingId: string | null;
  readonly customerId: string | null;
  readonly provider: string;
  readonly providerConnectionId: string | null;
  readonly providerPaymentId: string | null;
  readonly method: string;
  readonly captureMethod: string;
  readonly currency: string;
  readonly amount: string;
  readonly cardFeeAmount: string;
  readonly amountAuthorized: string;
  readonly amountCaptured: string;
  readonly amountRefunded: string;
  readonly status: string;
  readonly cardBrand: string | null;
  readonly cardBin: string | null;
  readonly cardLast4: string | null;
  readonly cardExpMonth: number | null;
  readonly cardExpYear: number | null;
  readonly threeDs: unknown;
  readonly nextAction: unknown;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly authorizedAt: Date | null;
  readonly capturedAt: Date | null;
  readonly canceledAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** The checkout's customer (`null` for a guest checkout or no checkout). */
  readonly checkoutCustomerId: string | null;
  /** Whether the checkout is a guest checkout (`false` without a checkout). */
  readonly checkoutIsGuest: boolean;
}

/** A stored `payment_events` row, as the Stripe event processor reads it back (OBE-039). */
export interface PaymentEventRow {
  readonly id: string;
  readonly paymentId: string;
  readonly type: string;
  readonly source: string;
  readonly providerEventId: string | null;
  readonly payload: unknown;
  readonly createdAt: Date;
}

/** A `refunds` row, as the Stripe event processor applies a refund's state to it (OBE-039). */
export interface RefundRow {
  readonly id: string;
  readonly paymentId: string;
  readonly currency: string;
  readonly amount: string;
  readonly status: string;
  readonly providerRefundId: string | null;
  readonly failureReason: string | null;
  readonly processedAt: Date | null;
  readonly version: number;
}

/** What a staff alert about a payment needs (OBE-039): where it goes, in which locale, and the booking it names. */
export interface PaymentAlertFacts {
  /** `storefront_settings.ops_alert_email`, or `null` when the OTA set none. */
  readonly opsAlertEmail: string | null;
  /** `storefront_settings.default_locale`, or `null` without a settings row. */
  readonly defaultLocale: string | null;
  /** The booking's reference and record locator, when the payment has a booking. */
  readonly bookingReference: string | null;
  readonly recordLocator: string | null;
}

/** A booking a payment transaction locked before the payment (`lockBookings`). */
export interface LockedBookingRow {
  readonly id: string;
  /** `bookings.amount_paid`, as text. */
  readonly amountPaid: string;
}

/**
 * How `lockBookings` locks: `update` (`FOR UPDATE`) when the transaction changes the booking; `key share` (`FOR KEY
 * SHARE`) when it only writes a row that references it (an outbox row, a booking event), whose foreign key takes that
 * lock at the end of the insert anyway.
 */
export type BookingLockMode = "update" | "key share";

/** What console.payments.list reads (`consolePayments`, OBE-068). */
export interface ConsolePaymentQuery {
  readonly environment: string;
  /** `payments.status` values, in the stored spelling (`canceled`). */
  readonly statuses?: readonly string[] | undefined;
  readonly providers?: readonly string[] | undefined;
  readonly methods?: readonly string[] | undefined;
  readonly bookingId?: string | undefined;
  /** At or after. */
  readonly createdFrom?: Date | undefined;
  /** Before. */
  readonly createdTo?: Date | undefined;
  /** The keyset position of the page's start: after the row with this `sortKey` and id. */
  readonly after?: { readonly key: string; readonly id: string } | undefined;
  readonly limit: number;
}

/** A `payment_events` row as the console shows it (OBE-068). */
export interface ConsolePaymentEventRow {
  readonly id: string;
  readonly paymentId: string;
  readonly type: string;
  readonly source: string;
  readonly statusFrom: string | null;
  readonly statusTo: string | null;
  /** As text, or `null`. */
  readonly amount: string | null;
  readonly currency: string | null;
  readonly providerEventId: string | null;
  /** The redacted payload stored with the event. */
  readonly payload: unknown;
  readonly createdAt: Date;
}

/** A `refunds` row as the console shows it (OBE-068). */
export interface ConsoleRefundRow {
  readonly id: string;
  readonly paymentId: string;
  readonly bookingId: string | null;
  readonly currency: string;
  readonly amount: string;
  readonly penaltyAmount: string | null;
  readonly reason: string;
  readonly reasonNote: string | null;
  readonly status: string;
  readonly providerRefundId: string | null;
  readonly requestedByType: string;
  readonly requestedById: string | null;
  readonly failureReason: string | null;
  readonly processedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The short reference of a payment's booking (`ConsolePaymentBooking`). */
export interface PaymentBookingSummaryRow {
  readonly id: string;
  readonly reference: string;
  readonly status: string;
}

/** The booking events of a refund (`insertRefundBookingEvent`): asked for, and refunded on Stripe's word. */
export const REFUND_BOOKING_EVENT = Object.freeze({
  requested: "refund.requested",
  succeeded: "refund.succeeded",
} as const);

/** One booking event of a refund (`insertRefundBookingEvent`). */
export interface RefundBookingEvent {
  /** `evt_…` */
  readonly id: string;
  readonly kind: keyof typeof REFUND_BOOKING_EVENT;
  readonly bookingId: string;
  readonly refundId: string;
  readonly paymentId: string;
  /** The refund's amount as stored (a decimal string) and its currency. */
  readonly amount: string;
  readonly currency: string;
  /** Who caused it (`booking_events.actor_type`, `actor_id`). */
  readonly actor: { readonly type: string; readonly id: string | null };
  readonly requestId: string | null;
  readonly now: Date;
}

/** The payment states of a checkout that a new payment replaces (cancelled before they are confirmed). */
export const REPLACEABLE_STATUSES = ["requires_payment_method", "requires_action"] as const;

type Db = TenantDatabase;

/**
 * The `payments` rows with their checkout's access columns, as `PaymentRow` (amounts as text): the query `payment` and
 * `consolePayments` narrow.
 */
function paymentRows(trx: TenantTransaction) {
  return trx
    .selectFrom("payments as p")
    .leftJoin("checkouts as c", "c.id", "p.checkout_id")
    .select([
      "p.id as id",
      "p.environment as environment",
      "p.checkout_id as checkoutId",
      "p.booking_id as bookingId",
      "p.customer_id as customerId",
      "p.provider as provider",
      "p.provider_connection_id as providerConnectionId",
      "p.provider_payment_id as providerPaymentId",
      "p.method as method",
      "p.capture_method as captureMethod",
      "p.status as status",
      "p.card_brand as cardBrand",
      "p.card_exp_month as cardExpMonth",
      "p.card_exp_year as cardExpYear",
      "p.three_ds as threeDs",
      "p.next_action as nextAction",
      "p.failure_code as failureCode",
      "p.failure_message as failureMessage",
      "p.authorized_at as authorizedAt",
      "p.captured_at as capturedAt",
      "p.canceled_at as canceledAt",
      "p.version as version",
      "p.created_at as createdAt",
      "p.updated_at as updatedAt",
      "c.customer_id as checkoutCustomerId",
      sql<boolean>`coalesce(c.is_guest, false)`.as("checkoutIsGuest"),
      sql<string>`p.currency::text`.as("currency"),
      sql<string | null>`p.card_bin::text`.as("cardBin"),
      sql<string | null>`p.card_last4::text`.as("cardLast4"),
      sql<string>`p.amount::text`.as("amount"),
      sql<string>`p.card_fee_amount::text`.as("cardFeeAmount"),
      sql<string>`p.amount_authorized::text`.as("amountAuthorized"),
      sql<string>`p.amount_captured::text`.as("amountCaptured"),
      sql<string>`p.amount_refunded::text`.as("amountRefunded"),
    ]);
}

@Injectable()
export class PaymentsRepository {
  /** The settings a payment follows; `undefined` without a settings row (provisioning never leaves one so). */
  async settings(trx: TenantTransaction): Promise<PaymentSettingsRow | undefined> {
    return await trx
      .selectFrom("storefront_settings")
      .select([
        "require_3ds as require3ds",
        "accepted_card_brands as acceptedCardBrands",
        "payment_timing as paymentTiming",
        "airline_card_enabled_test as airlineCardEnabledTest",
        "airline_card_enabled_live as airlineCardEnabledLive",
      ])
      .executeTakeFirst();
  }

  /** The checkout `id`, locked `FOR UPDATE` when `lock`; `undefined` for an unknown id. */
  async checkout(trx: TenantTransaction, id: string, lock = false): Promise<PaymentCheckoutRow | undefined> {
    let query = trx
      .selectFrom("checkouts")
      .select([
        "id",
        "environment",
        "status",
        "customer_id as customerId",
        "is_guest as isGuest",
        "priced_offer_id as pricedOfferId",
        "payment_brand as paymentBrand",
        "pricing_mode as pricingMode",
        "expires_at as expiresAt",
        "version",
        sql<string>`currency::text`.as("currency"),
        sql<string>`offer_amount::text`.as("offerAmount"),
        sql<string>`ancillaries_amount::text`.as("ancillariesAmount"),
        sql<string>`fees_amount::text`.as("feesAmount"),
        sql<string>`total_amount::text`.as("totalAmount"),
      ])
      .where("id", "=", id);
    if (lock) {
      query = query.forUpdate();
    }
    return await query.executeTakeFirst();
  }

  /** The selling and Amadeus prices of the checkout's extras, in their order. */
  async selectionPrices(trx: TenantTransaction, checkoutId: string): Promise<CheckoutSelectionPricesRow[]> {
    return await trx
      .selectFrom("checkout_ancillaries")
      .select([
        sql<string>`price_amount::text`.as("priceAmount"),
        sql<string>`net_amount::text`.as("netAmount"),
      ])
      .where("checkout_id", "=", checkoutId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
  }

  /** Changes the checkout after a payment step and bumps its `version`. */
  async updateCheckout(
    trx: TenantTransaction,
    id: string,
    values: Omit<Updateable<Db["checkouts"]>, "version" | "id">,
  ): Promise<void> {
    await trx
      .updateTable("checkouts")
      .set({ ...values, version: sql`version + 1` })
      .where("id", "=", id)
      .execute();
  }

  /** The payment `id` with its checkout's access columns, locked `FOR UPDATE` when `lock`; `undefined` if unknown. */
  async payment(trx: TenantTransaction, id: string, lock = false): Promise<PaymentRow | undefined> {
    let query = paymentRows(trx).where("p.id", "=", id);
    if (lock) {
      query = query.forUpdate(["p"]);
    }
    return await query.executeTakeFirst();
  }

  // ---- Console reads (OBE-068) ------------------------------------------------------------------------------------

  /**
   * One page of the payments of `query.environment` for console.payments.list, newest first (`created_at`, then `id`,
   * both descending), after the keyset position `query.after` when given, at most `query.limit` rows. The filters are
   * AND-ed, the values of a list OR-ed; statuses in the stored spelling (`canceled`). `sortKey` is the row's
   * `created_at` in UTC with microseconds, the key of the next page's cursor.
   */
  async consolePayments(
    trx: TenantTransaction,
    query: ConsolePaymentQuery,
  ): Promise<(PaymentRow & { readonly sortKey: string })[]> {
    let select = paymentRows(trx)
      .select(
        sql<string>`to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`.as("sortKey"),
      )
      .where("p.environment", "=", query.environment);
    if (query.statuses !== undefined && query.statuses.length > 0) {
      select = select.where("p.status", "in", [...query.statuses]);
    }
    if (query.providers !== undefined && query.providers.length > 0) {
      select = select.where("p.provider", "in", [...query.providers]);
    }
    if (query.methods !== undefined && query.methods.length > 0) {
      select = select.where("p.method", "in", [...query.methods]);
    }
    if (query.bookingId !== undefined) {
      select = select.where("p.booking_id", "=", query.bookingId);
    }
    if (query.createdFrom !== undefined) {
      select = select.where("p.created_at", ">=", query.createdFrom);
    }
    if (query.createdTo !== undefined) {
      select = select.where("p.created_at", "<", query.createdTo);
    }
    if (query.after !== undefined) {
      const { key, id } = query.after;
      select = select.where(
        sql<boolean>`(p.created_at, p.id) < ((${key}::timestamp AT TIME ZONE 'UTC'), ${id})`,
      );
    }
    return await select.orderBy("p.created_at", "desc").orderBy("p.id", "desc").limit(query.limit).execute();
  }

  /** The events of the payments `paymentIds` (`payment_events`), oldest first. */
  async consoleEvents(
    trx: TenantTransaction,
    paymentIds: readonly string[],
  ): Promise<ConsolePaymentEventRow[]> {
    if (paymentIds.length === 0) {
      return [];
    }
    return await trx
      .selectFrom("payment_events")
      .select([
        "id",
        "payment_id as paymentId",
        "type",
        "source",
        "status_from as statusFrom",
        "status_to as statusTo",
        "provider_event_id as providerEventId",
        "payload",
        "created_at as createdAt",
        sql<string | null>`amount::text`.as("amount"),
        sql<string | null>`currency::text`.as("currency"),
      ])
      .where("payment_id", "in", [...new Set(paymentIds)])
      .orderBy("created_at")
      .orderBy("id")
      .execute();
  }

  /** The refunds of the payments `paymentIds` (`refunds`), oldest first, with who asked for them. */
  async consoleRefunds(trx: TenantTransaction, paymentIds: readonly string[]): Promise<ConsoleRefundRow[]> {
    if (paymentIds.length === 0) {
      return [];
    }
    return await trx
      .selectFrom("refunds")
      .select([
        "id",
        "payment_id as paymentId",
        "booking_id as bookingId",
        "reason",
        "reason_note as reasonNote",
        "status",
        "provider_refund_id as providerRefundId",
        "requested_by_type as requestedByType",
        "requested_by_id as requestedById",
        "failure_reason as failureReason",
        "processed_at as processedAt",
        "created_at as createdAt",
        "updated_at as updatedAt",
        sql<string>`currency::text`.as("currency"),
        sql<string>`amount::text`.as("amount"),
        sql<string | null>`penalty_amount::text`.as("penaltyAmount"),
      ])
      .where("payment_id", "in", [...new Set(paymentIds)])
      .orderBy("created_at")
      .orderBy("id")
      .execute();
  }

  /** The reference and status of each booking of `ids` that exists, by id. */
  async bookingSummaries(
    trx: TenantTransaction,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, PaymentBookingSummaryRow>> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) {
      return new Map();
    }
    const rows = await trx
      .selectFrom("bookings")
      .select(["id", "reference", "status"])
      .where("id", "in", wanted)
      .execute();
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** The bookings the refunds of payment `paymentId` reference, read without a lock (`booking_id` never changes). */
  async refundBookingIds(trx: TenantTransaction, paymentId: string): Promise<ReadonlyMap<string, string>> {
    const rows = await trx
      .selectFrom("refunds")
      .select(["id", "booking_id as bookingId"])
      .where("payment_id", "=", paymentId)
      .where("booking_id", "is not", null)
      .execute();
    return new Map(rows.flatMap((row) => (row.bookingId === null ? [] : [[row.id, row.bookingId] as const])));
  }

  /**
   * Shows a capture on a booking that the caller's transaction locked `FOR UPDATE` before the payment
   * (`lockBookings`): `amount_paid` and `version + 1`.
   */
  async setAmountPaid(trx: TenantTransaction, bookingId: string, amount: string, now: Date): Promise<void> {
    await trx
      .updateTable("bookings")
      .set({ amount_paid: amount, updated_at: now, version: sql`version + 1` })
      .where("id", "=", bookingId)
      .execute();
  }

  /**
   * Appends a booking event (`booking_events`, append-only) for a payment step. Its foreign key takes `FOR KEY SHARE` on
   * the booking: the caller locked the booking before the payment (`lockBookings`, OADR-0003 point 11).
   */
  async insertBookingEvent(trx: TenantTransaction, row: Insertable<Db["booking_events"]>): Promise<void> {
    await trx.insertInto("booking_events").values(row).execute();
  }

  /**
   * Appends the customer-visible booking event of a refund (lead decision 6 of 2026-10-22): `refund.requested` when it
   * is asked for, worded as a request, and `refund.succeeded` only when Stripe reports it succeeded (the webhook). No
   * other step says that a refund was made. The caller holds the booking's lock (`insertBookingEvent`).
   */
  async insertRefundBookingEvent(trx: TenantTransaction, event: RefundBookingEvent): Promise<void> {
    const what = `Refund of ${event.amount} ${event.currency}`;
    await this.insertBookingEvent(trx, {
      id: event.id,
      booking_id: event.bookingId,
      type: REFUND_BOOKING_EVENT[event.kind],
      actor_type: event.actor.type,
      actor_id: event.actor.id,
      summary: event.kind === "requested" ? `${what} requested.` : `${what} completed.`,
      data: JSON.stringify({
        refundId: event.refundId,
        paymentId: event.paymentId,
        amount: event.amount,
        currency: event.currency,
      }),
      visible_to_customer: true,
      request_id: event.requestId,
      created_at: event.now,
      updated_at: event.now,
    });
  }

  /**
   * Locks the bookings `ids` (in id order) before the transaction locks their payments: every transaction that locks a
   * booking and its payment takes the booking first, then the payment (OADR-0003 point 11), so two of them never wait
   * for each other in a circle. `mode` says how (BookingLockMode). Answers the bookings found, in id order.
   */
  async lockBookings(
    trx: TenantTransaction,
    ids: readonly string[],
    mode: BookingLockMode,
  ): Promise<LockedBookingRow[]> {
    const wanted = [...new Set(ids)].sort();
    if (wanted.length === 0) {
      return [];
    }
    const query = trx
      .selectFrom("bookings")
      .select(["id", sql<string>`amount_paid::text`.as("amountPaid")])
      .where("id", "in", wanted)
      .orderBy("id");
    return await (mode === "update" ? query.forUpdate() : query.forKeyShare()).execute();
  }

  /** The checkout's payments in one of `statuses`, oldest first, locked `FOR UPDATE`. */
  async paymentsOfCheckout(
    trx: TenantTransaction,
    checkoutId: string,
    statuses: readonly string[],
  ): Promise<PaymentRow[]> {
    const ids = await trx
      .selectFrom("payments")
      .select("id")
      .where("checkout_id", "=", checkoutId)
      .where("status", "in", [...statuses])
      .orderBy("created_at")
      .orderBy("id")
      .forUpdate()
      .execute();
    const rows: PaymentRow[] = [];
    for (const { id } of ids) {
      const row = await this.payment(trx, id);
      if (row !== undefined) {
        rows.push(row);
      }
    }
    return rows;
  }

  async insertPayment(trx: TenantTransaction, row: Insertable<Db["payments"]>): Promise<void> {
    await trx.insertInto("payments").values(row).execute();
  }

  /**
   * Changes the payment `id` if its `version` is still `expectedVersion`, and bumps it; answers whether it did (a
   * concurrent change answers `false` and changes nothing).
   */
  async updatePayment(
    trx: TenantTransaction,
    id: string,
    expectedVersion: number,
    values: Omit<Updateable<Db["payments"]>, "version" | "id">,
  ): Promise<boolean> {
    const result = await trx
      .updateTable("payments")
      .set({ ...values, version: sql`version + 1` })
      .where("id", "=", id)
      .where("version", "=", expectedVersion)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** Appends a payment event (`payment_events` is append-only: `updated_at` equals `created_at`). */
  async insertEvent(trx: TenantTransaction, row: Insertable<Db["payment_events"]>): Promise<void> {
    await trx.insertInto("payment_events").values(row).execute();
  }

  /** The id of the payment of `provider` whose provider payment id (PaymentIntent) is `providerPaymentId`. */
  async paymentIdByProviderId(
    trx: TenantTransaction,
    provider: string,
    providerPaymentId: string,
  ): Promise<string | undefined> {
    const row = await trx
      .selectFrom("payments")
      .select("id")
      .where("provider", "=", provider)
      .where("provider_payment_id", "=", providerPaymentId)
      .executeTakeFirst();
    return row?.id;
  }

  /**
   * Appends a payment event that carries a provider event id, once: a second row with the same `provider_event_id`
   * inserts nothing (`payment_events_provider_uq`, also against a concurrent insert, which this one waits for).
   * Answers whether this call inserted it.
   */
  async insertProviderEvent(trx: TenantTransaction, row: Insertable<Db["payment_events"]>): Promise<boolean> {
    if (row.provider_event_id === null || row.provider_event_id === undefined) {
      throw new Error("insertProviderEvent: a provider event needs its provider_event_id");
    }
    const inserted = await trx
      .insertInto("payment_events")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("provider_event_id").where("provider_event_id", "is not", null).doNothing(),
      )
      .returning("id")
      .executeTakeFirst();
    return inserted !== undefined;
  }

  /** The id of the payment event stored for the provider event `providerEventId`, if any. */
  async eventIdByProviderEventId(
    trx: TenantTransaction,
    providerEventId: string,
  ): Promise<string | undefined> {
    const row = await trx
      .selectFrom("payment_events")
      .select("id")
      .where("provider_event_id", "=", providerEventId)
      .executeTakeFirst();
    return row?.id;
  }

  /** The payment event `id`, or `undefined`. */
  async event(trx: TenantTransaction, id: string): Promise<PaymentEventRow | undefined> {
    return await trx
      .selectFrom("payment_events")
      .select([
        "id",
        "payment_id as paymentId",
        "type",
        "source",
        "provider_event_id as providerEventId",
        "payload",
        "created_at as createdAt",
      ])
      .where("id", "=", id)
      .executeTakeFirst();
  }

  /** Whether the payment has an event of `type` whose payload's `key` is `value` (a step already recorded). */
  async hasEvent(
    trx: TenantTransaction,
    paymentId: string,
    type: string,
    key: string,
    value: string,
  ): Promise<boolean> {
    const row = await trx
      .selectFrom("payment_events")
      .select("id")
      .where("payment_id", "=", paymentId)
      .where("type", "=", type)
      .where(sql<string>`payload ->> ${key}`, "=", value)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The refunds of a payment, oldest first, locked `FOR UPDATE`. */
  async refundsOfPayment(trx: TenantTransaction, paymentId: string): Promise<RefundRow[]> {
    return await trx
      .selectFrom("refunds")
      .select([
        "id",
        "payment_id as paymentId",
        "status",
        "provider_refund_id as providerRefundId",
        "failure_reason as failureReason",
        "processed_at as processedAt",
        "version",
        sql<string>`currency::text`.as("currency"),
        sql<string>`amount::text`.as("amount"),
      ])
      .where("payment_id", "=", paymentId)
      .orderBy("created_at")
      .orderBy("id")
      .forUpdate()
      .execute();
  }

  /**
   * Changes the refund `id` if its `version` is still `expectedVersion`, and bumps it; answers whether it did (a
   * concurrent change answers `false` and changes nothing).
   */
  async updateRefund(
    trx: TenantTransaction,
    id: string,
    expectedVersion: number,
    values: Omit<Updateable<Db["refunds"]>, "version" | "id">,
  ): Promise<boolean> {
    const result = await trx
      .updateTable("refunds")
      .set({ ...values, version: sql`version + 1` })
      .where("id", "=", id)
      .where("version", "=", expectedVersion)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** The facts of a staff alert about a payment: the alert address, the locale and the booking `bookingId`. */
  async alertFacts(trx: TenantTransaction, bookingId: string | null): Promise<PaymentAlertFacts> {
    const settings = await trx
      .selectFrom("storefront_settings")
      .select(["ops_alert_email as opsAlertEmail", "default_locale as defaultLocale"])
      .executeTakeFirst();
    const booking =
      bookingId === null
        ? undefined
        : await trx
            .selectFrom("bookings")
            .select(["reference", "record_locator as recordLocator"])
            .where("id", "=", bookingId)
            .executeTakeFirst();
    return {
      opsAlertEmail: settings?.opsAlertEmail ?? null,
      defaultLocale: settings?.defaultLocale ?? null,
      bookingReference: booking?.reference ?? null,
      recordLocator: booking?.recordLocator ?? null,
    };
  }

  /** `reference.currencies.minor_units` of `code`, or `null` for an unknown currency. */
  async currencyMinorUnits(trx: TenantTransaction, code: string): Promise<number | null> {
    const row = await trx
      .selectFrom("reference.currencies")
      .select("minor_units")
      .where("code", "=", code)
      .executeTakeFirst();
    return row?.minor_units ?? null;
  }

  /** The ISO country of each known airport of `codes` (`reference.airports`). */
  async airportCountries(trx: TenantTransaction, codes: readonly string[]): Promise<Map<string, string>> {
    const wanted = codes.filter((code) => /^[A-Z]{3}$/.test(code));
    if (wanted.length === 0) {
      return new Map();
    }
    const rows = await trx
      .selectFrom("reference.airports")
      .select(["iata_code", "country_code"])
      .where("iata_code", "in", wanted)
      .execute();
    return new Map(rows.map((row) => [row.iata_code, row.country_code]));
  }
}
