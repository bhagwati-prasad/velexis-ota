// The tenant repository of checkouts (OBE-036; ota/docs/data-model.md §2 and §4, db README §2.1): `checkouts` and
// their `checkout_travelers`, `checkout_contacts`, `checkout_ancillaries` and `checkout_remarks`, which the checkout
// module owns, plus the reads it needs of tables it does not own: the storefront settings a checkout follows, the
// signed-in customer (verification and the contact prefill), and the booking of a completed checkout. Like every
// tenant repository it takes the `tenantTx` transaction first, never opens one and never names a tenant schema.
// Amounts are read as text (`numeric::text`), dates through `to_char`, never as JavaScript numbers or local-time dates;
// jsonb is written as JSON text.
import { Injectable } from "@nestjs/common";
import { sql, type Insertable, type TenantDatabase, type Updateable } from "@velexis/db";
import type { TenantTransaction } from "../tenancy/tenant-tx";

/** What a checkout reads of `storefront_settings`. */
export interface CheckoutSettingsRow {
  readonly checkoutTtlMinutes: number;
  readonly guestCheckoutEnabled: boolean;
  readonly requireEmailVerification: boolean;
  readonly ticketingPolicy: string;
  readonly paymentTiming: string;
  readonly defaultLocale: string;
}

/** The customer columns checkout.create reads. */
export interface CheckoutCustomerRow {
  readonly id: string;
  readonly email: string;
  readonly emailVerifiedAt: Date | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly phoneCountryCode: string | null;
  readonly phoneNumber: string | null;
  readonly status: string;
}

/** A `checkouts` row. */
export interface CheckoutRow {
  readonly id: string;
  readonly environment: string;
  readonly channel: string;
  readonly customerId: string | null;
  readonly isGuest: boolean;
  readonly basePricedOfferId: string;
  readonly pricedOfferId: string;
  readonly status: string;
  readonly currency: string;
  readonly offerAmount: string;
  readonly ancillariesAmount: string;
  readonly feesAmount: string;
  readonly totalAmount: string;
  readonly paymentBrand: string | null;
  readonly locale: string | null;
  readonly termsAcceptedAt: Date | null;
  readonly metadata: unknown;
  readonly expiresAt: Date;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A `checkout_travelers` row. */
export interface CheckoutTravelerRow {
  readonly id: string;
  readonly amadeusTravelerId: string;
  readonly travelerType: string;
  readonly associatedAdultId: string | null;
  readonly savedTravelerId: string | null;
  readonly firstName: string | null;
  readonly middleName: string | null;
  readonly lastName: string | null;
  readonly secondLastName: string | null;
  /** `YYYY-MM-DD`. */
  readonly dateOfBirth: string | null;
  readonly gender: string | null;
  readonly contact: unknown;
  readonly documentsCiphertext: Buffer | null;
  readonly discountEligibilityCiphertext: Buffer | null;
  readonly encryptionKeyId: string | null;
  readonly loyaltyPrograms: unknown;
  readonly emergencyContact: unknown;
  readonly saveToProfile: boolean;
  readonly position: number;
}

/** A `checkout_contacts` row. */
export interface CheckoutContactRow {
  readonly id: string;
  readonly purpose: string;
  readonly isPrimary: boolean;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly companyName: string | null;
  readonly email: string | null;
  readonly phones: unknown;
  readonly address: unknown;
  readonly language: string | null;
}

/** A `checkout_ancillaries` row. */
export interface CheckoutAncillaryRow {
  readonly id: string;
  readonly checkoutTravelerId: string | null;
  readonly segmentId: string | null;
  readonly type: string;
  readonly serviceCode: string | null;
  readonly quantity: number;
  readonly weight: number | null;
  readonly weightUnit: string | null;
  readonly seatNumber: string | null;
  readonly currency: string;
  readonly priceAmount: string;
  readonly details: unknown;
}

/** A `checkout_remarks` row. */
export interface CheckoutRemarkRow {
  readonly id: string;
  readonly text: string;
  readonly travelerIds: readonly string[];
  readonly position: number;
  readonly source: string;
  readonly createdAt: Date;
}

/** Everything a checkout answer shows of the checkout's own tables. */
export interface CheckoutChildren {
  readonly travelers: readonly CheckoutTravelerRow[];
  readonly contacts: readonly CheckoutContactRow[];
  readonly ancillaries: readonly CheckoutAncillaryRow[];
  readonly remarks: readonly CheckoutRemarkRow[];
}

type CheckoutDb = TenantDatabase;

@Injectable()
export class CheckoutRepository {
  /** The settings a checkout follows; `undefined` without a settings row (provisioning never leaves one so). */
  async settings(trx: TenantTransaction): Promise<CheckoutSettingsRow | undefined> {
    return await trx
      .selectFrom("storefront_settings")
      .select([
        "checkout_ttl_minutes as checkoutTtlMinutes",
        "guest_checkout_enabled as guestCheckoutEnabled",
        "require_email_verification as requireEmailVerification",
        "ticketing_policy as ticketingPolicy",
        "payment_timing as paymentTiming",
        "default_locale as defaultLocale",
      ])
      .executeTakeFirst();
  }

  /** The customer `customerId`, or `undefined`. */
  async customer(trx: TenantTransaction, customerId: string): Promise<CheckoutCustomerRow | undefined> {
    return await trx
      .selectFrom("customers")
      .select([
        "id",
        "email",
        "email_verified_at as emailVerifiedAt",
        "first_name as firstName",
        "last_name as lastName",
        "phone_country_code as phoneCountryCode",
        "phone_number as phoneNumber",
        "status",
      ])
      .where("id", "=", customerId)
      .executeTakeFirst();
  }

  async insertCheckout(trx: TenantTransaction, row: Insertable<CheckoutDb["checkouts"]>): Promise<void> {
    await trx.insertInto("checkouts").values(row).execute();
  }

  async insertTravelers(
    trx: TenantTransaction,
    rows: readonly Insertable<CheckoutDb["checkout_travelers"]>[],
  ): Promise<void> {
    if (rows.length > 0) {
      await trx
        .insertInto("checkout_travelers")
        .values([...rows])
        .execute();
    }
  }

  /**
   * Marks the other `open` checkouts of `customerId` for the same base priced offer `abandoned` (checkout.create);
   * answers how many.
   */
  async abandonOthers(
    trx: TenantTransaction,
    input: { customerId: string; basePricedOfferId: string; keepId: string; now: Date },
  ): Promise<number> {
    const result = await trx
      .updateTable("checkouts")
      .set({ status: "abandoned", version: sql`version + 1`, updated_at: input.now })
      .where("customer_id", "=", input.customerId)
      .where("base_priced_offer_id", "=", input.basePricedOfferId)
      .where("id", "<>", input.keepId)
      .where("status", "=", "open")
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /** The checkout `id`, locked `FOR UPDATE` when `lock` (the steps that change it); `undefined` for an unknown id. */
  async checkout(trx: TenantTransaction, id: string, lock = false): Promise<CheckoutRow | undefined> {
    let query = trx
      .selectFrom("checkouts")
      .select([
        "id",
        "environment",
        "channel",
        "customer_id as customerId",
        "is_guest as isGuest",
        "base_priced_offer_id as basePricedOfferId",
        "priced_offer_id as pricedOfferId",
        "status",
        "payment_brand as paymentBrand",
        "locale",
        "terms_accepted_at as termsAcceptedAt",
        "metadata",
        "expires_at as expiresAt",
        "version",
        "created_at as createdAt",
        "updated_at as updatedAt",
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

  /** The travellers of a checkout, in their order. */
  async travelers(trx: TenantTransaction, checkoutId: string): Promise<CheckoutTravelerRow[]> {
    return await trx
      .selectFrom("checkout_travelers")
      .select([
        "id",
        "amadeus_traveler_id as amadeusTravelerId",
        "traveler_type as travelerType",
        "associated_adult_id as associatedAdultId",
        "saved_traveler_id as savedTravelerId",
        "first_name as firstName",
        "middle_name as middleName",
        "last_name as lastName",
        "second_last_name as secondLastName",
        "gender",
        "contact",
        "documents_ciphertext as documentsCiphertext",
        "discount_eligibility_ciphertext as discountEligibilityCiphertext",
        "encryption_key_id as encryptionKeyId",
        "loyalty_programs as loyaltyPrograms",
        "emergency_contact as emergencyContact",
        "save_to_profile as saveToProfile",
        "position",
        sql<string | null>`to_char(date_of_birth, 'YYYY-MM-DD')`.as("dateOfBirth"),
      ])
      .where("checkout_id", "=", checkoutId)
      .orderBy("position")
      .orderBy("amadeus_traveler_id")
      .execute();
  }

  /** Everything an answer shows of the checkout's own tables. */
  async children(trx: TenantTransaction, checkoutId: string): Promise<CheckoutChildren> {
    const travelers = await this.travelers(trx, checkoutId);
    const contacts = await trx
      .selectFrom("checkout_contacts")
      .select([
        "id",
        "purpose",
        "is_primary as isPrimary",
        "first_name as firstName",
        "last_name as lastName",
        "company_name as companyName",
        "email",
        "phones",
        "address",
        "language",
      ])
      .where("checkout_id", "=", checkoutId)
      // setContacts writes the list in its order, one millisecond apart (`replaceContacts`).
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const ancillaries = await trx
      .selectFrom("checkout_ancillaries")
      .select([
        "id",
        "checkout_traveler_id as checkoutTravelerId",
        "segment_id as segmentId",
        "type",
        "service_code as serviceCode",
        "quantity",
        "weight",
        "weight_unit as weightUnit",
        "seat_number as seatNumber",
        "details",
        sql<string>`currency::text`.as("currency"),
        sql<string>`price_amount::text`.as("priceAmount"),
      ])
      .where("checkout_id", "=", checkoutId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const remarks = await trx
      .selectFrom("checkout_remarks")
      .select(["id", "text", "traveler_ids as travelerIds", "position", "source", "created_at as createdAt"])
      .where("checkout_id", "=", checkoutId)
      .orderBy("position")
      .execute();
    return { travelers, contacts, ancillaries, remarks };
  }

  /** Replaces the data of one traveller row of the checkout. */
  async updateTraveler(
    trx: TenantTransaction,
    checkoutId: string,
    travelerRowId: string,
    values: Updateable<CheckoutDb["checkout_travelers"]>,
  ): Promise<void> {
    await trx
      .updateTable("checkout_travelers")
      .set(values)
      .where("id", "=", travelerRowId)
      .where("checkout_id", "=", checkoutId)
      .execute();
  }

  /** Replaces the contacts of a checkout with `rows` (inserted in their order). */
  async replaceContacts(
    trx: TenantTransaction,
    checkoutId: string,
    rows: readonly Insertable<CheckoutDb["checkout_contacts"]>[],
  ): Promise<void> {
    await trx.deleteFrom("checkout_contacts").where("checkout_id", "=", checkoutId).execute();
    if (rows.length > 0) {
      await trx
        .insertInto("checkout_contacts")
        .values([...rows])
        .execute();
    }
  }

  /** Replaces the remarks of a checkout with `rows`. */
  async replaceRemarks(
    trx: TenantTransaction,
    checkoutId: string,
    rows: readonly Insertable<CheckoutDb["checkout_remarks"]>[],
  ): Promise<void> {
    await trx.deleteFrom("checkout_remarks").where("checkout_id", "=", checkoutId).execute();
    if (rows.length > 0) {
      await trx
        .insertInto("checkout_remarks")
        .values([...rows])
        .execute();
    }
  }

  /** Bumps the checkout's `version` after a step changed it (`checkouts.version` counts child changes too). */
  async touch(trx: TenantTransaction, checkoutId: string, now: Date): Promise<void> {
    await trx
      .updateTable("checkouts")
      .set({ version: sql`version + 1`, updated_at: now })
      .where("id", "=", checkoutId)
      .execute();
  }

  /** The booking checkout.complete created from the checkout, or `null`. */
  async bookingIdOf(trx: TenantTransaction, checkoutId: string): Promise<string | null> {
    const row = await trx
      .selectFrom("bookings")
      .select("id")
      .where("checkout_id", "=", checkoutId)
      .executeTakeFirst();
    return row?.id ?? null;
  }
}
