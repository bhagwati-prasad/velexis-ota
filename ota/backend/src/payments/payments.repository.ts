// The tenant repository of payments (OBE-038; db README §2.1, ota/docs/data-model.md): `payments` and their append-only
// `payment_events`, which the payments module owns, plus what the payment steps read or change of tables it does not
// own: the checkout a payment is for (locked while a payment step changes its totals, status and expiry), the
// storefront settings the payment follows (3-D Secure, accepted brands), the minor units of a currency and the
// countries of airports (the card fee's rule facts). Like every tenant repository it takes the `tenantTx` transaction
// first, never opens one and never names a tenant schema. Amounts are read as text (`numeric::text`), never as
// JavaScript numbers; jsonb is written as JSON text.
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
