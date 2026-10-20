// The tenant repository of payments (OBE-038; db README §2.1, ota/docs/data-model.md): `payments` and their append-only
// `payment_events`, which the payments module owns, plus what the payment steps read or change of tables it does not
// own: the checkout a payment is for (locked while a payment step changes its totals, status and expiry), the
// storefront settings the payment follows (3-D Secure, accepted brands), the minor units of a currency and the
// countries of airports (the card fee's rule facts). Like every tenant repository it takes the `tenantTx` transaction
// first, never opens one and never names a tenant schema. Amounts are read as text (`numeric::text`), never as
// JavaScript numbers; jsonb is written as JSON text.
//
// OBE-039 adds what the Stripe webhooks need (payments/webhooks/, stripe-events.processor.ts): the payment of a
// PaymentIntent, the webhook's `payment_events` row written once per provider event id (`payment_events_provider_uq`),
// the stored event read back by the processor, the payment's `refunds` rows (whose final state comes from the webhooks;
// OBE-040 creates them) with their `version` lock, and the staff alert's facts (`ops_alert_email`, the default locale and
// the booking's reference).
import { Injectable } from "@nestjs/common";
import { sql, type Insertable, type TenantDatabase, type Updateable } from "@velexis/db";
import type { TenantTransaction } from "../tenancy/tenant-tx";

/** What a payment step reads of `storefront_settings`. */
export interface PaymentSettingsRow {
  readonly require3ds: boolean;
  readonly acceptedCardBrands: readonly string[];
  readonly paymentTiming: string;
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
  readonly expiresAt: Date;
  readonly version: number;
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

/** The payment states of a checkout that a new payment replaces (cancelled before they are confirmed). */
export const REPLACEABLE_STATUSES = ["requires_payment_method", "requires_action"] as const;

type Db = TenantDatabase;

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
    let query = trx
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
      ])
      .where("p.id", "=", id);
    if (lock) {
      query = query.forUpdate(["p"]);
    }
    return await query.executeTakeFirst();
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
