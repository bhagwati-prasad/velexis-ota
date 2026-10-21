// checkout.create, checkout.get, checkout.setTravelers, checkout.setContacts and checkout.setRemarks (createCheckout,
// getCheckout, setCheckoutTravelers, setCheckoutContacts, setCheckoutRemarks; `x-scope: both`; OBE-036;
// ota/docs/flows/checkout-stripe.md §1 and §2 steps 1–2, ota/docs/data-model.md §4, SDK guide B3 §2.1–§2.5).
// No Amadeus call: everything comes from the stored priced offer (PricedOffersService.forCheckout), PostgreSQL only
// (OADR-0002: no offer data in Redis, whatever the document's "Redis `prc:{id}` first" says).
//
// create, in one transaction:
//   1. who: a signed-in customer (the customer guard verified the token; a customer that is gone, disabled or deleted
//      is `401 UNAUTHENTICATED`; `403 EMAIL_NOT_VERIFIED` when the storefront requires a verified address), else a
//      guest when `storefront_settings.guest_checkout_enabled` (`401 UNAUTHENTICATED` otherwise: sign in first). In
//      console scope (a `console:automation` key now, staff tokens with OBE-059) the checkout is `channel: console`,
//      for the priced offer's owner or as a guest checkout, whatever the guest setting;
//   2. the priced offer: of the request's environment, and when a customer priced it only that customer's (or console
//      scope), else `404`; `410 OFFER_EXPIRED` after its `expires_at`;
//   3. inserts `checkouts` (`open`, the priced offer's currency, `offer_amount = total_amount` = its selling total,
//      `expires_at = now + checkout_ttl_minutes`, the locale of the body, else of `Accept-Language`, else the
//      storefront's), one empty `checkout_travelers` row per traveller of the priced offer (type, held infant's adult)
//      and, for a customer with `prefillContactFromAccount` (default true), the primary contact from the profile;
//      the customer's other `open` checkouts of the same priced offer become `abandoned`.
//   The idempotency interceptor stores the `201` under the request's `Idempotency-Key`: a retry answers the same
//   checkout.
//
// Every later step reads the checkout in the request's environment (`404` otherwise, another tenant's id included,
// which its own schema does not have). A customer's checkout is readable by that customer, in console scope and with a
// secret key (the OTA's server); a guest checkout by anyone holding its unguessable `chk_` id with the OTA's
// credential (a capability URL: answers never carry a document number or a payment secret). The `set*` steps lock the
// row (`FOR UPDATE`), refuse a checkout that checkout.complete is completing (`409 CHECKOUT_BEING_COMPLETED`,
// `details.bookingId`: its booking is `pending`; `refuseWhileCompleting`, which checkout.setAncillaries,
// checkout.createPayment and checkout.updatePayment call too), a completed checkout (`409 CHECKOUT_ALREADY_COMPLETED`,
// `details.bookingId`) and an expired or abandoned one (`410 CHECKOUT_EXPIRED`), compare `If-Match` (`412
// PRECONDITION_FAILED`), check the data against the requirements (requirements.ts; all or nothing), replace their
// part, bump `checkouts.version` and answer the whole checkout from the same transaction.
import { Injectable } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import { PinoLogger } from "nestjs-pino";
import { CustomerContext } from "../common/auth/customer.guard";
import { Clock } from "../common/clock";
import { RequestContext } from "../common/http/request-context";
import { IdGenerator } from "../common/ids";
import { PricedOffersService, type CheckoutPricedOffer } from "../shopping/priced-offers.service";
import { CallerContext } from "../tenancy/caller-resolver";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import {
  effectiveStatus,
  ifMatchSatisfied,
  toCheckout,
  type Checkout,
  type CheckoutContactsRequest,
  type CheckoutCreateRequest,
  type CheckoutRemarksRequest,
  type CheckoutTravelersRequest,
  type TravelerView,
} from "./checkout.mapper";
import {
  CheckoutRepository,
  type CheckoutCustomerRow,
  type CheckoutRow,
  type CheckoutSettingsRow,
  type CheckoutTravelerRow,
} from "./checkout.repository";
import {
  contactErrors,
  MAX_FIELD_ERRORS,
  offerTravelersOf,
  primaryIndexOf,
  remarkErrors,
  requirementsForPricedOffer,
  travelerErrors,
  tripOf,
  utcDate,
  type CheckoutRequirements,
  type FieldError,
  type TravelerFacts,
} from "./requirements";
import { documentsToStore, TravelerDocuments, type StoredDocument } from "./traveler-documents";

/** The input of checkout.create. */
export interface CreateCheckoutInput {
  readonly body: CheckoutCreateRequest;
  /** `Accept-Language`: the names of the answer, and the checkout's locale when the body has none. */
  readonly acceptLanguage?: string | undefined;
}

/** The input of a step that changes a checkout. */
export interface CheckoutStepInput<B> {
  readonly checkoutId: string;
  readonly ifMatch?: string | undefined;
  readonly acceptLanguage?: string | undefined;
  readonly body: B;
}

/** What a step that changes a checkout works with. */
interface StepContext {
  readonly tenant: RequestTenant;
  readonly checkout: CheckoutRow;
  readonly priced: CheckoutPricedOffer;
  readonly requirements: CheckoutRequirements;
  readonly now: Date;
}

const LOCALE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;

/**
 * The checkout's locale: the body's, else the first language of `Accept-Language` in the document's form (`en-GB`),
 * else the storefront's default locale, else none.
 */
export function checkoutLocaleOf(
  locale: string | undefined,
  acceptLanguage: string | undefined,
  fallback: string,
): string | null {
  if (locale !== undefined) {
    return locale;
  }
  const first = acceptLanguage?.split(",")[0]?.split(";")[0]?.trim() ?? "";
  const match = /^([A-Za-z]{2,3})(?:[-_]([A-Za-z]{2}))?$/.exec(first);
  if (match?.[1] !== undefined) {
    return `${match[1].toLowerCase()}${match[2] === undefined ? "" : `-${match[2].toUpperCase()}`}`;
  }
  return LOCALE.test(fallback) ? fallback : null;
}

const notFound = (): AppError => new AppError("NOT_FOUND", { message: "No checkout with this id." });

/** `409 CHECKOUT_BEING_COMPLETED` with the pending booking (`CheckoutService.refuseWhileCompleting`). */
export function checkoutBeingCompleted(bookingId: string): AppError {
  return new AppError("CHECKOUT_BEING_COMPLETED", {
    message: "We are confirming your booking with the airline; the checkout cannot change meanwhile.",
    details: { bookingId },
  });
}

const travelerIndexOf = (error: FieldError): number =>
  Number(/^\/travelers\/(\d+)/.exec(error.path)?.[1] ?? 0);

/** A stored traveller as the cross-traveller checks compare it. */
const factsOfRow = (row: CheckoutTravelerRow): TravelerFacts => ({
  travelerId: row.amadeusTravelerId,
  firstName: row.firstName,
  lastName: row.lastName,
  dateOfBirth: row.dateOfBirth,
});

@Injectable()
export class CheckoutService {
  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly callers: CallerContext,
    private readonly requestContext: RequestContext,
    private readonly customers: CustomerContext,
    private readonly repository: CheckoutRepository,
    private readonly pricedOffers: PricedOffersService,
    private readonly documents: TravelerDocuments,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(CheckoutService.name);
  }

  // ---- checkout.create ---------------------------------------------------------------------------------------------

  async create(input: CreateCheckoutInput): Promise<Checkout> {
    const tenant = this.tenants.require();
    const consoleScope = this.requestContext.isConsoleScope();
    const signedIn = consoleScope ? undefined : this.customers.get();
    const body = input.body;
    const created = await this.tx.run(async (trx) => {
      const now = this.clock.now();
      const settings = await this.settingsOf(trx, tenant);
      let customer: CheckoutCustomerRow | undefined;
      if (signedIn !== undefined) {
        customer = await this.repository.customer(trx, signedIn.customerId);
        if (customer === undefined || customer.status === "disabled" || customer.status === "deleted") {
          throw new AppError("UNAUTHENTICATED");
        }
        if (settings.requireEmailVerification && customer.emailVerifiedAt === null) {
          throw new AppError("EMAIL_NOT_VERIFIED");
        }
      } else if (!consoleScope && !settings.guestCheckoutEnabled) {
        throw new AppError("UNAUTHENTICATED", {
          message: "Sign in to book: this storefront has no guest checkout.",
        });
      }
      const priced = await this.pricedOffers.forCheckout(trx, body.pricedOfferId, input.acceptLanguage);
      if (
        priced === undefined ||
        priced.row.environment !== tenant.environment ||
        priced.row.searchEnvironment !== tenant.environment ||
        (priced.owner !== null && !consoleScope && priced.owner !== customer?.id)
      ) {
        throw new AppError("NOT_FOUND", { message: "No priced offer with this id." });
      }
      if (priced.row.expiresAt.getTime() <= now.getTime()) {
        throw new AppError("OFFER_EXPIRED");
      }
      const checkoutId = this.ids.newId("chk");
      const customerId = consoleScope ? priced.owner : (customer?.id ?? null);
      await this.repository.insertCheckout(trx, {
        id: checkoutId,
        environment: tenant.environment,
        channel: consoleScope ? "console" : "storefront",
        customer_id: customerId,
        is_guest: customerId === null,
        created_by_staff_id: tenant.actor.type === "staff" ? tenant.actor.id : null,
        base_priced_offer_id: priced.row.id,
        priced_offer_id: priced.row.id,
        status: "open",
        currency: priced.row.currency,
        offer_amount: priced.row.sellingTotal,
        ancillaries_amount: "0",
        fees_amount: "0",
        total_amount: priced.row.sellingTotal,
        locale: checkoutLocaleOf(body.locale, input.acceptLanguage, settings.defaultLocale),
        metadata: JSON.stringify(body.metadata ?? {}),
        expires_at: new Date(now.getTime() + settings.checkoutTtlMinutes * 60_000),
        version: 1,
        created_at: now,
        updated_at: now,
      });
      await this.repository.insertTravelers(
        trx,
        offerTravelersOf(priced.pricedOffer).map((traveler, position) => ({
          id: this.ids.newId("ctr"),
          checkout_id: checkoutId,
          amadeus_traveler_id: traveler.travelerId,
          traveler_type: traveler.travelerType,
          associated_adult_id: traveler.travelerType === "HELD_INFANT" ? traveler.associatedAdultId : null,
          position,
          created_at: now,
          updated_at: now,
        })),
      );
      if (customer !== undefined && body.prefillContactFromAccount !== false) {
        await this.repository.replaceContacts(trx, checkoutId, [
          {
            id: this.ids.newId("cco"),
            checkout_id: checkoutId,
            purpose: "STANDARD",
            is_primary: true,
            first_name: customer.firstName,
            last_name: customer.lastName,
            email: customer.email,
            phones: JSON.stringify(
              customer.phoneCountryCode !== null && customer.phoneNumber !== null
                ? [{ countryCallingCode: customer.phoneCountryCode, number: customer.phoneNumber }]
                : [],
            ),
            created_at: now,
            updated_at: now,
          },
        ]);
      }
      const abandoned =
        customerId === null
          ? 0
          : await this.repository.abandonOthers(trx, {
              customerId,
              basePricedOfferId: priced.row.id,
              keepId: checkoutId,
              now,
            });
      return {
        checkoutId,
        abandoned,
        checkout: await this.answer(trx, tenant, checkoutId, priced, settings, now),
      };
    });
    this.logger.info(
      {
        checkoutId: created.checkoutId,
        pricedOfferId: body.pricedOfferId,
        channel: created.checkout.channel,
        guest: created.checkout.isGuest,
        abandoned: created.abandoned,
      },
      "checkout.created",
    );
    return created.checkout;
  }

  // ---- checkout.get ------------------------------------------------------------------------------------------------

  /** The whole checkout; expired and completed checkouts are readable too. */
  async get(checkoutId: string, acceptLanguage?: string): Promise<Checkout> {
    const tenant = this.tenants.require();
    return await this.tx.run(async (trx) => {
      const now = this.clock.now();
      const checkout = await this.readable(trx, tenant, checkoutId, false);
      const priced = await this.pricedOfferOf(trx, checkout, acceptLanguage);
      const settings = await this.settingsOf(trx, tenant);
      return await this.answer(trx, tenant, checkout.id, priced, settings, now);
    });
  }

  // ---- checkout.setTravelers ---------------------------------------------------------------------------------------

  /** Replaces each listed traveller; the others keep their data. */
  async setTravelers(input: CheckoutStepInput<CheckoutTravelersRequest>): Promise<Checkout> {
    return await this.step(input, async (trx, context) => {
      const { checkout, tenant, requirements, now } = context;
      const rows = await this.repository.travelers(trx, checkout.id);
      const byTravelerId = new Map(rows.map((row) => [row.amadeusTravelerId, row]));
      const errors = travelerErrors(input.body.travelers, {
        requirements,
        trip: tripOf(context.priced.pricedOffer),
        today: utcDate(now),
        stored: rows.map(factsOfRow),
      });
      const plans: Array<{
        readonly row: CheckoutTravelerRow;
        readonly traveler: CheckoutTravelersRequest["travelers"][number];
        readonly documents: StoredDocument[];
      }> = [];
      for (const [index, traveler] of input.body.travelers.entries()) {
        const row = byTravelerId.get(traveler.travelerId);
        if (row === undefined) {
          continue;
        }
        const sent = traveler.documents ?? [];
        // A document without `number` keeps the stored one: only then are the stored documents decrypted.
        const stored = sent.some((document) => document.number === undefined)
          ? (await this.documents.open(tenant.schemaName, row.id, row)).documents
          : [];
        const merged = documentsToStore(sent, stored);
        for (const missing of merged.missing) {
          errors.push({
            path: `/travelers/${index}/documents/${missing}/number`,
            code: "REQUIRED",
            message: "Enter the document number: there is no stored document of this type and country.",
          });
        }
        plans.push({ row, traveler, documents: merged.documents });
      }
      if (errors.length > 0) {
        throw new AppError("TRAVELER_DATA_INVALID", {
          message: "Please check the traveller details.",
          fieldErrors: [...errors]
            .sort((a, b) => travelerIndexOf(a) - travelerIndexOf(b))
            .slice(0, MAX_FIELD_ERRORS),
        });
      }
      const customerCheckout = checkout.customerId !== null;
      for (const { row, traveler, documents } of plans) {
        const sealed = await this.documents.seal(
          tenant.schemaName,
          row.id,
          documents,
          traveler.discountEligibility ?? [],
        );
        await this.repository.updateTraveler(trx, checkout.id, row.id, {
          saved_traveler_id: null,
          first_name: traveler.name?.firstName ?? null,
          middle_name: traveler.name?.middleName ?? null,
          last_name: traveler.name?.lastName ?? null,
          second_last_name: traveler.name?.secondLastName ?? null,
          date_of_birth: traveler.dateOfBirth ?? null,
          gender: traveler.gender ?? null,
          contact: traveler.contact === undefined ? null : JSON.stringify(traveler.contact),
          documents_ciphertext: sealed.documentsCiphertext,
          discount_eligibility_ciphertext: sealed.discountEligibilityCiphertext,
          encryption_key_id: sealed.encryptionKeyId,
          loyalty_programs: JSON.stringify(traveler.loyaltyPrograms ?? []),
          emergency_contact:
            traveler.emergencyContact === undefined ? null : JSON.stringify(traveler.emergencyContact),
          // Customers only: a guest has no account to save a traveller to.
          save_to_profile: customerCheckout && traveler.saveToAccount === true,
          updated_at: now,
        });
      }
    });
  }

  // ---- checkout.setContacts ----------------------------------------------------------------------------------------

  /** Replaces the booking contacts. */
  async setContacts(input: CheckoutStepInput<CheckoutContactsRequest>): Promise<Checkout> {
    return await this.step(input, async (trx, { checkout, requirements, now }) => {
      const contacts = input.body.contacts;
      const errors = contactErrors(contacts, requirements.contact);
      if (errors.length > 0) {
        throw new AppError("CONTACT_DATA_INVALID", {
          message: "Please check the contact details.",
          fieldErrors: errors,
        });
      }
      const primary = primaryIndexOf(contacts);
      await this.repository.replaceContacts(
        trx,
        checkout.id,
        contacts.map((contact, index) => ({
          id: this.ids.newId("cco"),
          checkout_id: checkout.id,
          purpose: contact.purpose ?? "STANDARD",
          is_primary: index === primary,
          first_name: contact.addresseeName?.firstName ?? null,
          last_name: contact.addresseeName?.lastName ?? null,
          company_name: contact.companyName ?? null,
          email: contact.emailAddress ?? null,
          phones: JSON.stringify(contact.phones ?? []),
          address: contact.address === undefined ? null : JSON.stringify(contact.address),
          language: contact.language ?? null,
          // The list's order, one millisecond apart: the table has no position column.
          created_at: new Date(now.getTime() + index),
          updated_at: now,
        })),
      );
    });
  }

  // ---- checkout.setRemarks -----------------------------------------------------------------------------------------

  /** Replaces the special requests; an empty list removes them. */
  async setRemarks(input: CheckoutStepInput<CheckoutRemarksRequest>): Promise<Checkout> {
    return await this.step(input, async (trx, { checkout, tenant, requirements, now }) => {
      const remarks = input.body.remarks;
      const errors = remarkErrors(
        remarks,
        new Set(requirements.travelers.map((traveler) => traveler.travelerId)),
      );
      if (errors.length > 0) {
        throw new AppError("VALIDATION_FAILED", { fieldErrors: errors });
      }
      const staff = this.requestContext.isConsoleScope();
      await this.repository.replaceRemarks(
        trx,
        checkout.id,
        remarks.map((remark, position) => ({
          id: this.ids.newId("crm"),
          checkout_id: checkout.id,
          text: remark.text,
          traveler_ids: [...new Set(remark.travelerIds ?? [])],
          position,
          source: staff ? "staff" : "customer",
          created_by_staff_id: tenant.actor.type === "staff" ? tenant.actor.id : null,
          created_at: now,
          updated_at: now,
        })),
      );
    });
  }

  // ---- Shared ------------------------------------------------------------------------------------------------------

  /**
   * Refuses a change to a checkout that has a booking (OADR-0003 point 2): `409 CHECKOUT_BEING_COMPLETED` while
   * checkout.complete's claim is `pending` (its order is being created, or looked for after a `504`), `409
   * CHECKOUT_ALREADY_COMPLETED` once the booking is recorded. A failed booking clears its `checkout_id` and holds
   * nothing. A step calls it in the transaction that locked the checkout (`FOR UPDATE`): the claim locks the checkout
   * too, so a change and a claim never overlap; a step that calls Amadeus or Stripe first also calls it before them.
   */
  async refuseWhileCompleting(trx: TenantTransaction, checkoutId: string): Promise<void> {
    const booking = await this.repository.bookingOf(trx, checkoutId);
    if (booking === undefined) {
      return;
    }
    throw booking.status === "pending"
      ? checkoutBeingCompleted(booking.id)
      : new AppError("CHECKOUT_ALREADY_COMPLETED", { details: { bookingId: booking.id } });
  }

  /** One step that changes a checkout, in one transaction, answering the checkout after it. */
  private async step<B>(
    input: CheckoutStepInput<B>,
    change: (trx: TenantTransaction, context: StepContext) => Promise<void>,
  ): Promise<Checkout> {
    const tenant = this.tenants.require();
    return await this.tx.run(async (trx) => {
      const now = this.clock.now();
      const checkout = await this.readable(trx, tenant, input.checkoutId, true);
      await this.refuseWhileCompleting(trx, checkout.id);
      const status = effectiveStatus(checkout, now);
      if (status === "completed") {
        const bookingId = await this.repository.bookingIdOf(trx, checkout.id);
        throw new AppError(
          "CHECKOUT_ALREADY_COMPLETED",
          bookingId === null ? {} : { details: { bookingId } },
        );
      }
      if (status === "expired" || status === "abandoned") {
        throw new AppError("CHECKOUT_EXPIRED");
      }
      if (!ifMatchSatisfied(input.ifMatch, checkout.version)) {
        throw new AppError("PRECONDITION_FAILED");
      }
      const priced = await this.pricedOfferOf(trx, checkout, input.acceptLanguage);
      const settings = await this.settingsOf(trx, tenant);
      await change(trx, {
        tenant,
        checkout,
        priced,
        requirements: requirementsForPricedOffer(priced.pricedOffer),
        now,
      });
      await this.repository.touch(trx, checkout.id, now);
      return await this.answer(trx, tenant, checkout.id, priced, settings, now);
    });
  }

  /** The checkout if the request may read it (see the file header), locked when `lock`; `404` otherwise. */
  private async readable(
    trx: TenantTransaction,
    tenant: RequestTenant,
    checkoutId: string,
    lock: boolean,
  ): Promise<CheckoutRow> {
    const row = await this.repository.checkout(trx, checkoutId, lock);
    if (row === undefined || row.environment !== tenant.environment || !this.mayAccess(row)) {
      throw notFound();
    }
    return row;
  }

  private mayAccess(row: CheckoutRow): boolean {
    if (this.requestContext.isConsoleScope()) {
      return true;
    }
    if (row.customerId === null && row.isGuest) {
      return true;
    }
    const customer = this.customers.get();
    if (customer !== undefined) {
      return row.customerId !== null && row.customerId === customer.customerId;
    }
    const caller = this.callers.get();
    return caller?.type === "key" && caller.kind === "secret";
  }

  /** The priced offer a checkout buys; the foreign key keeps it while the checkout exists. */
  private async pricedOfferOf(
    trx: TenantTransaction,
    checkout: CheckoutRow,
    acceptLanguage: string | undefined,
  ): Promise<CheckoutPricedOffer> {
    const priced = await this.pricedOffers.forCheckout(trx, checkout.pricedOfferId, acceptLanguage);
    if (priced === undefined) {
      throw new Error("the priced offer of a checkout is missing");
    }
    return priced;
  }

  private async settingsOf(trx: TenantTransaction, tenant: RequestTenant): Promise<CheckoutSettingsRow> {
    const settings = await this.repository.settings(trx);
    if (settings === undefined) {
      this.logger.warn({ tenantId: tenant.tenantId }, "checkout.settings_missing");
      throw new AppError("TENANT_SUSPENDED", { message: "The storefront of this OTA is not ready yet." });
    }
    return settings;
  }

  /** The whole checkout as stored now, in the caller's transaction. */
  private async answer(
    trx: TenantTransaction,
    tenant: RequestTenant,
    checkoutId: string,
    priced: CheckoutPricedOffer,
    settings: CheckoutSettingsRow,
    now: Date,
  ): Promise<Checkout> {
    const checkout = await this.repository.checkout(trx, checkoutId);
    if (checkout === undefined) {
      throw new Error("a checkout of this transaction is not readable");
    }
    const children = await this.repository.children(trx, checkoutId);
    const travelers: TravelerView[] = [];
    for (const row of children.travelers) {
      const opened = await this.documents.open(tenant.schemaName, row.id, row);
      travelers.push({ row, documents: opened.documents, discounts: opened.discounts });
    }
    return toCheckout({
      checkout,
      travelers,
      contacts: children.contacts,
      ancillaries: children.ancillaries,
      remarks: children.remarks,
      pricedOffer: priced.pricedOffer,
      minorUnits: priced.minorUnits,
      requirements: requirementsForPricedOffer(priced.pricedOffer),
      settings,
      bookingId: checkout.status === "completed" ? await this.repository.bookingIdOf(trx, checkout.id) : null,
      now,
    });
  }
}
