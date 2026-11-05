// `customers.erase` against PostgreSQL 16 and Redis 7 (OBE-087; db README §7 "End-customer erasure inside a tenant",
// ota/docs/data-model.md §6, OADR-0014 points 2, 4 and 5). The worker's module graph runs in-process
// (WorkerModule.forRoot, as dist/worker.js builds it) on a clone of the @velexis/testing template (`tenant_alpha` and
// `tenant_beta` provisioned) and a Redis database of its own: the `ota-maintenance` consumer with the fan-out, the
// runner and the erasure's handler, which JobsModule provides.
//
// The file plays the platform (velexis_migrator: alpha `active`, beta `suspended`) and the API (`tenantTx` as
// velexis_ota_app: customers as sign-up and account.delete leave them, with their identities, sessions, reset
// tokens, consents, preferences and saved travellers, and the searches, checkouts, bookings, payments, refunds,
// events and e-mails of their trips). It removes the schedulers the worker registered at start-up and plays the
// scheduler instead: each run adds a `fan-out` job with the `prevMillis` of an iteration due at the FakeClock's minute,
// as BullMQ's scheduler adds them, and waits for the per-tenant jobs, whose ids it knows. The erasure reads the time
// from `Clock`, which the file points at its FakeClock; the clock only moves forward, a minute or more between runs, so
// every run has a bucket of its own. Each scenario does its work in its `beforeAll` hook, with a budget of its own; its
// tests read what it left. Names, addresses and numbers are made up per run; nothing is a real person's.
//
// FIX-W43-OTA (lead decisions (5f), (5g) and (5h) of 2026-11-05) adds to each seeded customer its account e-mails (one
// still pending, with a secret) and a checkout that never became a booking, with the customer as its traveller and
// contact, and gives its booked checkout a traveller and a contact; the scenarios prove the hourly cut-off of 30 days
// less one hour (29 days untouched, erased before its erasureDueBy, the boundary), that no name, address or document
// ciphertext of an erased customer is left in its account e-mails or in the travellers and contacts of its checkouts
// that never became bookings, and the `customer.erased` marker on each booking the erasure detached. That a new
// account verifying the address claims none of those bookings is proven through the API in account.int.test.ts.
import { randomBytes } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplicationContext } from "@nestjs/common";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type TenantDb,
} from "@velexis/db";
import { createTestDatabase, FakeClock, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import type { Job, Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ERASURE_DUE_AFTER_MS } from "../../../src/account/account.mapper";
import { CUSTOMERS_ERASE_JOB } from "../../../src/account/erasure.processor";
import {
  CUSTOMER_ERASED_SUMMARY,
  ERASED_RECIPIENT,
  ERASURE_BATCH,
  ERASURE_CUTOFF_AFTER_MS,
  ERASURE_RUN_INTERVAL_MS,
  type ErasureCounts,
} from "../../../src/account/erasure.service";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { CUSTOMER_ERASED_EVENT } from "../../../src/identity/customers.repository";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { loadWorkerConfig } from "../../../src/config";
import { minuteBucket, tenantJobId, type TenantJobResult } from "../../../src/jobs/fan-out";
import { FAN_OUT_JOB } from "../../../src/jobs/schedulers";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { testWorkerVariables } from "../../helpers/api-env";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";

/**
 * Cloning the template and starting the worker's graph (BullMQ connections, the scheduler registration): a few seconds
 * alone, more while every package's integration tests run on a 4-CPU CI runner. The bound only stops a hang.
 */
const SETUP_TIMEOUT_MS = 90_000;
/**
 * A scenario writes its rows, runs one or two iterations and waits for the worker each time; the bound only stops a
 * hang.
 */
const SCENARIO_TIMEOUT_MS = 60_000;
/**
 * How long a scenario waits at most for one job of the worker (an erasure takes milliseconds, a batch of 100 about a
 * second).
 */
const WAIT_MS = 30_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const quietPoolLogger = { error: (): void => undefined };

type TenantKey = "alpha" | "beta";

let db: TestDatabase;
let redis: TestRedis;
let worker: INestApplicationContext;
const sink = new MemorySink();
let migratorPool: ReturnType<typeof createPool>;
/** velexis_migrator, the owner of the platform tables: inserts the tenants as the platform does. */
let migrator: Kysely<PlatformDatabase>;
let otaPool: ReturnType<typeof createPool>;
/** `tenantTx` as velexis_ota_app: writes the tenant rows as the API does. */
let tenantDb: TenantDb;
let maintenance: Queue;
const tenantIds: Record<TenantKey, string> = { alpha: "", beta: "" };
/** The priced offer every checkout and booking of a tenant is opened with. */
const pricedOfferIds: Record<TenantKey, string> = { alpha: "", beta: "" };

/** Tomorrow at this minute: the file's first run; the clock only moves forward from here. */
const BASE = new Date(Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS + DAY_MS);
const clock = new FakeClock(BASE);

const txOf =
  (tenant: TenantKey) =>
  <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
    tenantTx(tenantDb, `tenant_${tenant}`, run);

/** The clock's instant moved by `ms` (negative: in the past). */
const fromNow = (ms: number): Date => new Date(clock.now().getTime() + ms);
/** A fresh SHA-256-shaped hex value, as the token tables store hashes. */
const hash = (): string => randomBytes(32).toString("hex");
/** A fresh Stripe-shaped id of this run. */
const stripeId = (prefix: string): string => `${prefix}_test_${randomBytes(10).toString("hex")}`;
/** A fresh booking reference (`bookings.reference`: 6 to 10 upper-case letters and digits). */
const bookingReference = (): string => `VX${randomBytes(3).toString("hex").toUpperCase()}`;
/** A made-up word of this run: names and addresses that no log line may ever show. */
const madeUp = (prefix: string): string => `${prefix}${randomBytes(4).toString("hex")}`;

async function insertTenant(key: TenantKey, status: "active" | "suspended"): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name: `${key} Travel`, status, plan_code: "early_access" })
    .execute();
  return id;
}

/** A search with one offer and its priced offer, valid for a year: what a checkout and a booking are opened with. */
async function insertPricedOffer(tenant: TenantKey): Promise<string> {
  const searchId = newId("srch");
  const offerId = newId("off");
  const pricedOfferId = newId("prc");
  const expires = fromNow(365 * DAY_MS);
  await txOf(tenant)(async (trx) => {
    await trx
      .insertInto("flight_searches")
      .values({
        id: searchId,
        environment: "test",
        criteria: JSON.stringify({
          mode: "simple",
          originLocationCode: "MAD",
          destinationLocationCode: "ORY",
        }),
        amadeus_request: JSON.stringify({ originLocationCode: "MAD", destinationLocationCode: "ORY" }),
        status: "completed",
        result_count: 1,
        expires_at: expires,
      })
      .execute();
    await trx
      .insertInto("flight_offers")
      .values({
        id: offerId,
        environment: "test",
        search_id: searchId,
        amadeus_offer_id: "1",
        payload: JSON.stringify({ type: "flight-offer", id: "1" }),
        currency: "EUR",
        net_total: "400.00",
        markup_amount: "40.00",
        selling_total: "440.00",
        first_departure_local: new Date(expires.getTime() - DAY_MS).toISOString().slice(0, 19),
        expires_at: expires,
      })
      .execute();
    await trx
      .insertInto("priced_offers")
      .values({
        id: pricedOfferId,
        environment: "test",
        offer_id: offerId,
        offer_ids: [offerId],
        amadeus_request: JSON.stringify({ data: { type: "flight-offers-pricing" } }),
        response: JSON.stringify({ data: { type: "flight-offers-pricing" } }),
        currency: "EUR",
        net_total: "400.00",
        markup_amount: "40.00",
        fee_amount: "0.00",
        selling_total: "440.00",
        expires_at: expires,
      })
      .execute();
  });
  return pricedOfferId;
}

// ---- Customers and their trips ----------------------------------------------------------------------------------

interface CustomerSeed {
  /** The id to use (another tenant's customer id, for the isolation case); a fresh one otherwise. */
  readonly id?: string;
  /** When account.delete deleted it, relative to the clock; `null`: an active customer. */
  readonly deletedInMs: number | null;
}

/** A seeded customer: its id, the values no log line may show, and the ids of the rows of its trip. */
interface SeededCustomer {
  readonly id: string;
  /**
   * Names, the address it signed up with, the placeholder, the phone number, the new address it asked for (only its
   * verification e-mail holds it) and the street of its abandoned checkout's contact.
   */
  readonly personalData: readonly string[];
  readonly searchId: string;
  readonly checkoutId: string;
  readonly bookingId: string;
  readonly paymentId: string;
  readonly refundId: string;
  /** The booking's confirmation e-mail (a booking e-mail: it stays with the booking). */
  readonly notificationId: string;
  /** A checkout that never became a booking, with the customer as its traveller and contact. */
  readonly abandonedCheckoutId: string;
  /** The encrypted documents of the abandoned checkout's traveller (random bytes in place of a ciphertext). */
  readonly abandonedDocuments: Buffer;
  /** The customer's account e-mails, sorted: four sent and a password reset still pending with its secret. */
  readonly accountEmailIds: readonly string[];
}

/** The account e-mails each seeded customer has. */
const ACCOUNT_EMAILS_PER_CUSTOMER = 5;

/**
 * A customer as sign-up, its use of the storefront and (when `deletedInMs` is given) account.delete leave it, in one
 * transaction: the customer, a password identity, a session, a reset token, two consent events, preferences, a saved
 * traveller with a document; a search, a completed checkout with a traveller and a contact, a ticketed booking with a
 * traveller, a contact and an event, its captured and partly refunded Stripe payment, the refund, and the confirmation
 * e-mail; an abandoned checkout that never became a booking, with the customer as its traveller (encrypted documents)
 * and contact; and the account e-mails: the verification of a new address (to that address), a password reset, the
 * notice of the address change and the deletion's confirmation, sent, and a password reset still pending with its
 * secret (due in a year: no worker sends it).
 */
async function seedCustomer(tenant: TenantKey, seed: CustomerSeed): Promise<SeededCustomer> {
  const id = seed.id ?? newId("cus");
  const firstName = madeUp("Ingrid");
  const lastName = madeUp("Halvorsen");
  const address = `${madeUp("traveller.")}@example.com`;
  const placeholder = `${hash()}@deleted.invalid`;
  const phone = `7700${String(randomBytes(3).readUIntBE(0, 3)).padStart(6, "0")}`;
  const newAddress = `${madeUp("renamed.")}@example.com`;
  const street = `${madeUp("Fjordgata ")} 12`;
  const abandonedDocuments = randomBytes(64);
  const deletedAt = seed.deletedInMs === null ? null : fromNow(seed.deletedInMs);
  const signedUpAt = fromNow(-400 * DAY_MS);
  const ids = {
    searchId: newId("srch"),
    checkoutId: newId("chk"),
    bookingId: newId("bkg"),
    paymentId: newId("pay"),
    refundId: newId("rfd"),
    notificationId: newId("ntf"),
    abandonedCheckoutId: newId("chk"),
  };
  const accountEmailIds = Array.from({ length: ACCOUNT_EMAILS_PER_CUSTOMER }, () => newId("ntf")).sort();
  const phones = JSON.stringify([{ deviceType: "MOBILE", countryCallingCode: "44", number: phone }]);
  await txOf(tenant)(async (trx) => {
    await trx
      .insertInto("customers")
      .values({
        id,
        email: deletedAt === null ? address : placeholder,
        email_verified_at: signedUpAt,
        first_name: firstName,
        last_name: lastName,
        date_of_birth: "1988-04-17",
        phone_country_code: "44",
        phone_number: phone,
        status: deletedAt === null ? "active" : "deleted",
        marketing_consent: false,
        deleted_at: deletedAt,
        created_at: signedUpAt,
        updated_at: deletedAt ?? signedUpAt,
      })
      .execute();
    const identityId = newId("cid");
    await trx
      .insertInto("customer_identities")
      .values({
        id: identityId,
        customer_id: id,
        provider: "password",
        provider_subject: deletedAt === null ? address : placeholder,
        password_hash: "argon2id-hash-of-a-made-up-password",
        email: deletedAt === null ? address : placeholder,
        email_verified_at: signedUpAt,
        disabled_at: deletedAt,
      })
      .execute();
    const sessionStart = fromNow(-(seed.deletedInMs === null ? 1 : 40) * DAY_MS);
    await trx
      .insertInto("customer_sessions")
      .values({
        id: newId("ses"),
        customer_id: id,
        identity_id: identityId,
        refresh_token_hash: hash(),
        family_id: newId("ses"),
        remember_me: true,
        family_expires_at: new Date(sessionStart.getTime() + 30 * DAY_MS),
        expires_at: new Date(sessionStart.getTime() + 30 * DAY_MS),
        user_agent: "Mozilla/5.0 (made up)",
        ip_address: "192.0.2.10",
        revoked_at: deletedAt,
        revoke_reason: deletedAt === null ? null : "account_deleted",
      })
      .execute();
    await trx
      .insertInto("customer_password_resets")
      .values({
        id: newId("pwr"),
        customer_id: id,
        token_hash: hash(),
        requested_ip: "192.0.2.10",
        expires_at: new Date(sessionStart.getTime() + HOUR_MS),
      })
      .execute();
    await trx
      .insertInto("customer_consents")
      .values([
        {
          id: newId("ccn"),
          customer_id: id,
          kind: "terms",
          policy_version: "2026-01",
          granted: true,
          source: "sign_up",
          created_at: signedUpAt,
          updated_at: signedUpAt,
        },
        {
          id: newId("ccn"),
          customer_id: id,
          kind: "marketing",
          policy_version: null,
          granted: false,
          source: "account",
        },
      ])
      .execute();
    await trx
      .insertInto("customer_preferences")
      .values({ id: newId("cpf"), customer_id: id, locale: "en", currency: "EUR", home_airport: "MAD" })
      .execute();
    const travelerId = newId("trv");
    await trx
      .insertInto("saved_travelers")
      .values({
        id: travelerId,
        customer_id: id,
        is_self: true,
        first_name: firstName,
        last_name: lastName,
        date_of_birth: "1988-04-17",
        email: address,
      })
      .execute();
    await trx
      .insertInto("saved_traveler_documents")
      .values({
        id: newId("tdc"),
        saved_traveler_id: travelerId,
        document_type: "PASSPORT",
        // Random bytes in place of a ciphertext: no document number exists anywhere in this file.
        number_ciphertext: randomBytes(48),
        encryption_key_id: "local:v1",
        number_last4: "0042",
        expiry_date: "2031-01-31",
        issuance_country: "NO",
      })
      .execute();
    await trx
      .insertInto("flight_searches")
      .values({
        id: ids.searchId,
        environment: "test",
        customer_id: id,
        criteria: JSON.stringify({
          mode: "simple",
          originLocationCode: "OSL",
          destinationLocationCode: "MAD",
        }),
        amadeus_request: JSON.stringify({ originLocationCode: "OSL", destinationLocationCode: "MAD" }),
        status: "completed",
        result_count: 1,
        expires_at: fromNow(365 * DAY_MS),
      })
      .execute();
    await trx
      .insertInto("checkouts")
      .values({
        id: ids.checkoutId,
        environment: "test",
        customer_id: id,
        is_guest: false,
        base_priced_offer_id: pricedOfferIds[tenant],
        priced_offer_id: pricedOfferIds[tenant],
        status: "completed",
        currency: "EUR",
        offer_amount: "440.00",
        total_amount: "440.00",
        expires_at: fromNow(-60 * DAY_MS),
        version: 4,
      })
      .execute();
    const departure = fromNow(-50 * DAY_MS);
    await trx
      .insertInto("bookings")
      .values({
        id: ids.bookingId,
        environment: "test",
        reference: bookingReference(),
        customer_id: id,
        checkout_id: ids.checkoutId,
        priced_offer_id: pricedOfferIds[tenant],
        status: "ticketed",
        ticketing_status: "issued",
        first_departure_at: departure,
        last_arrival_at: new Date(departure.getTime() + 3 * HOUR_MS),
        currency: "EUR",
        net_amount: "400.00",
        markup_amount: "40.00",
        total_amount: "440.00",
        amount_paid: "440.00",
        amount_refunded: "40.00",
        contact_email: address,
        lead_last_name: lastName.toUpperCase(),
        version: 7,
        created_at: fromNow(-60 * DAY_MS),
        updated_at: fromNow(-55 * DAY_MS),
      })
      .execute();
    await trx
      .insertInto("booking_travelers")
      .values({
        id: newId("btr"),
        booking_id: ids.bookingId,
        amadeus_traveler_id: "1",
        traveler_type: "ADULT",
        first_name: firstName,
        last_name: lastName,
      })
      .execute();
    await trx
      .insertInto("booking_contacts")
      .values({ id: newId("bco"), booking_id: ids.bookingId, is_primary: true, email: address })
      .execute();
    await trx
      .insertInto("booking_events")
      .values({
        id: newId("evt"),
        booking_id: ids.bookingId,
        type: "booking.created",
        actor_type: "customer",
        actor_id: id,
        status_to: "confirmed",
      })
      .execute();
    await trx
      .insertInto("payments")
      .values({
        id: ids.paymentId,
        environment: "test",
        checkout_id: ids.checkoutId,
        booking_id: ids.bookingId,
        customer_id: id,
        provider: "stripe",
        provider_connection_id: newId("ppc"),
        provider_payment_id: stripeId("pi"),
        method: "card",
        capture_method: "manual",
        currency: "EUR",
        amount: "440.00",
        amount_authorized: "440.00",
        amount_captured: "440.00",
        amount_refunded: "40.00",
        status: "partially_refunded",
        card_brand: "VISA",
        card_last4: "4242",
        authorized_at: fromNow(-60 * DAY_MS),
        captured_at: fromNow(-60 * DAY_MS),
        metadata: JSON.stringify({ connection: { accountMode: "velexis", accountReference: null } }),
        version: 5,
      })
      .execute();
    await trx
      .insertInto("refunds")
      .values({
        id: ids.refundId,
        payment_id: ids.paymentId,
        booking_id: ids.bookingId,
        currency: "EUR",
        amount: "40.00",
        reason: "customer_request",
        status: "succeeded",
        provider_refund_id: stripeId("re"),
        requested_by_type: "customer",
        requested_by_id: id,
        processed_at: fromNow(-55 * DAY_MS),
      })
      .execute();
    await trx
      .insertInto("notifications")
      .values({
        id: ids.notificationId,
        template_key: "booking.confirmed",
        channel: "email",
        recipient: address,
        recipient_type: "customer",
        customer_id: id,
        booking_id: ids.bookingId,
        payload: JSON.stringify({ booking: { reference: "VXSAMPLE" } }),
        status: "sent",
        sent_at: fromNow(-60 * DAY_MS),
      })
      .execute();
    // The booked checkout's traveller and contact: they became the booking's, and stay.
    await trx
      .insertInto("checkout_travelers")
      .values({
        id: newId("ctr"),
        checkout_id: ids.checkoutId,
        amadeus_traveler_id: "1",
        traveler_type: "ADULT",
        first_name: firstName,
        last_name: lastName,
        date_of_birth: "1988-04-17",
        documents_ciphertext: randomBytes(64),
        encryption_key_id: "local:v1",
      })
      .execute();
    await trx
      .insertInto("checkout_contacts")
      .values({ id: newId("cco"), checkout_id: ids.checkoutId, is_primary: true, email: address })
      .execute();
    // A checkout that never became a booking: abandoned (account.delete abandons the open ones), the customer its
    // traveller (contact details, encrypted documents) and its contact (name, address, phone, street).
    await trx
      .insertInto("checkouts")
      .values({
        id: ids.abandonedCheckoutId,
        environment: "test",
        customer_id: id,
        is_guest: false,
        base_priced_offer_id: pricedOfferIds[tenant],
        priced_offer_id: pricedOfferIds[tenant],
        status: "abandoned",
        currency: "EUR",
        offer_amount: "440.00",
        total_amount: "440.00",
        expires_at: fromNow(-41 * DAY_MS),
        version: 3,
      })
      .execute();
    await trx
      .insertInto("checkout_travelers")
      .values({
        id: newId("ctr"),
        checkout_id: ids.abandonedCheckoutId,
        amadeus_traveler_id: "1",
        traveler_type: "ADULT",
        first_name: firstName,
        last_name: lastName,
        date_of_birth: "1988-04-17",
        gender: "FEMALE",
        contact: JSON.stringify({ emailAddress: address, phones: JSON.parse(phones) as unknown }),
        // Random bytes in place of a ciphertext: no document number exists anywhere in this file.
        documents_ciphertext: abandonedDocuments,
        encryption_key_id: "local:v1",
      })
      .execute();
    await trx
      .insertInto("checkout_contacts")
      .values({
        id: newId("cco"),
        checkout_id: ids.abandonedCheckoutId,
        purpose: "STANDARD",
        is_primary: true,
        first_name: firstName,
        last_name: lastName,
        email: address,
        phones,
        address: JSON.stringify({ lines: [street], postalCode: "0150", countryCode: "NO", cityName: "Oslo" }),
        language: "en",
      })
      .execute();
    // The account e-mails, as the outbox leaves them: sent, with the rendered subject (a tenant's template may name
    // the customer), the variables and the provider's id; the pending one holds its secret until it is sent.
    const accountEmails = [
      { template: "auth.verify_email", to: newAddress, pending: false },
      { template: "auth.password_reset", to: address, pending: false },
      { template: "account.email_changed", to: address, pending: false },
      { template: "account.deleted", to: address, pending: false },
      { template: "auth.password_reset", to: address, pending: true },
    ] as const;
    await trx
      .insertInto("notifications")
      .values(
        accountEmails.map((email, index) => ({
          id: accountEmailIds[index] ?? newId("ntf"),
          template_key: email.template,
          channel: "email",
          recipient: email.to,
          recipient_type: "customer",
          customer_id: id,
          locale: "en",
          subject: email.pending ? null : `${firstName}, about your Alpha Travel account`,
          payload: JSON.stringify({
            customer: { firstName },
            change: { requestedAt: signedUpAt.toISOString() },
          }),
          secret_payload_ciphertext: email.pending ? randomBytes(48) : null,
          encryption_key_id: email.pending ? "local:v1" : null,
          dedupe_key: `${email.template}:${newId("pwr")}`,
          status: email.pending ? "pending" : "sent",
          attempts: email.pending ? 0 : 1,
          next_attempt_at: email.pending ? fromNow(400 * DAY_MS) : fromNow(-45 * DAY_MS),
          provider: email.pending ? null : "smtp",
          provider_message_id: email.pending ? null : `<${hash()}@mail.example.com>`,
          sent_at: email.pending ? null : fromNow(-45 * DAY_MS),
          created_at: fromNow(-45 * DAY_MS),
          updated_at: fromNow(-45 * DAY_MS),
        })),
      )
      .execute();
  });
  return {
    id,
    personalData: [firstName, lastName, address, placeholder, phone, newAddress, street],
    ...ids,
    abandonedDocuments,
    accountEmailIds,
  };
}

/**
 * A minimal deleted customer (the batch scenario): the row and its disabled identity, deleted `deletedInMs` from the
 * clock.
 */
async function insertDeletedCustomer(trx: TenantTransaction, deletedInMs: number): Promise<string> {
  const id = newId("cus");
  const placeholder = `${hash()}@deleted.invalid`;
  const deletedAt = fromNow(deletedInMs);
  await trx
    .insertInto("customers")
    .values({ id, email: placeholder, first_name: madeUp("Batch"), status: "deleted", deleted_at: deletedAt })
    .execute();
  await trx
    .insertInto("customer_identities")
    .values({
      id: newId("cid"),
      customer_id: id,
      provider: "password",
      provider_subject: placeholder,
      password_hash: "argon2id-hash-of-a-made-up-password",
      email: placeholder,
      disabled_at: deletedAt,
    })
    .execute();
  return id;
}

/** The customer's own rows, per table: what an erasure deletes. */
async function ownRowsOf(tenant: TenantKey, customerId: string): Promise<Record<string, number>> {
  return await txOf(tenant)(async (trx) => {
    const count = async (
      table:
        | "customer_identities"
        | "customer_sessions"
        | "customer_password_resets"
        | "customer_consents"
        | "customer_preferences"
        | "customer_data_exports"
        | "saved_travelers",
    ): Promise<number> => {
      const rows = await trx.selectFrom(table).select("id").where("customer_id", "=", customerId).execute();
      return rows.length;
    };
    const customers = await trx.selectFrom("customers").select("id").where("id", "=", customerId).execute();
    const documents = await trx
      .selectFrom("saved_traveler_documents as d")
      .innerJoin("saved_travelers as t", "t.id", "d.saved_traveler_id")
      .select("d.id")
      .where("t.customer_id", "=", customerId)
      .execute();
    return {
      customers: customers.length,
      identities: await count("customer_identities"),
      sessions: await count("customer_sessions"),
      passwordResets: await count("customer_password_resets"),
      consents: await count("customer_consents"),
      preferences: await count("customer_preferences"),
      dataExports: await count("customer_data_exports"),
      savedTravelers: await count("saved_travelers"),
      savedTravelerDocuments: documents.length,
    };
  });
}

/**
 * Every column of the rows of a seeded customer's trips, of its account e-mails and of the customer itself, as the
 * database holds them.
 */
async function recordsOf(tenant: TenantKey, seeded: SeededCustomer): Promise<Record<string, unknown>> {
  return await txOf(tenant)(async (trx) => ({
    customer: await trx.selectFrom("customers").selectAll().where("id", "=", seeded.id).executeTakeFirst(),
    search: await trx
      .selectFrom("flight_searches")
      .selectAll()
      .where("id", "=", seeded.searchId)
      .executeTakeFirstOrThrow(),
    checkout: await trx
      .selectFrom("checkouts")
      .selectAll()
      .where("id", "=", seeded.checkoutId)
      .executeTakeFirstOrThrow(),
    booking: await trx
      .selectFrom("bookings")
      .selectAll()
      .where("id", "=", seeded.bookingId)
      .executeTakeFirstOrThrow(),
    travelers: await trx
      .selectFrom("booking_travelers")
      .selectAll()
      .where("booking_id", "=", seeded.bookingId)
      .execute(),
    contacts: await trx
      .selectFrom("booking_contacts")
      .selectAll()
      .where("booking_id", "=", seeded.bookingId)
      .execute(),
    events: await trx
      .selectFrom("booking_events")
      .selectAll()
      .where("booking_id", "=", seeded.bookingId)
      .execute(),
    payment: await trx
      .selectFrom("payments")
      .selectAll()
      .where("id", "=", seeded.paymentId)
      .executeTakeFirstOrThrow(),
    refund: await trx
      .selectFrom("refunds")
      .selectAll()
      .where("id", "=", seeded.refundId)
      .executeTakeFirstOrThrow(),
    notification: await trx
      .selectFrom("notifications")
      .selectAll()
      .where("id", "=", seeded.notificationId)
      .executeTakeFirstOrThrow(),
    bookedTravelers: await trx
      .selectFrom("checkout_travelers")
      .selectAll()
      .where("checkout_id", "=", seeded.checkoutId)
      .execute(),
    bookedContacts: await trx
      .selectFrom("checkout_contacts")
      .selectAll()
      .where("checkout_id", "=", seeded.checkoutId)
      .execute(),
    abandonedCheckout: await trx
      .selectFrom("checkouts")
      .selectAll()
      .where("id", "=", seeded.abandonedCheckoutId)
      .executeTakeFirstOrThrow(),
    abandonedTravelers: await trx
      .selectFrom("checkout_travelers")
      .selectAll()
      .where("checkout_id", "=", seeded.abandonedCheckoutId)
      .execute(),
    abandonedContacts: await trx
      .selectFrom("checkout_contacts")
      .selectAll()
      .where("checkout_id", "=", seeded.abandonedCheckoutId)
      .execute(),
    accountEmails: await trx
      .selectFrom("notifications")
      .selectAll()
      .where("id", "in", [...seeded.accountEmailIds])
      .orderBy("id")
      .execute(),
  }));
}

/**
 * The rows of tenant `tenant` that could hold an erased customer's personal data after the erasure (lead decision (5g)
 * of 2026-11-05): every `notifications` row, every traveller and contact of a checkout that no booking names, and the
 * document ciphertexts of every checkout traveller.
 */
async function personalTables(tenant: TenantKey) {
  return await txOf(tenant)(async (trx) => ({
    notifications: await trx.selectFrom("notifications").selectAll().execute(),
    unbookedTravelers: await trx
      .selectFrom("checkout_travelers")
      .selectAll()
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("bookings")
              .select("bookings.id")
              .whereRef("bookings.checkout_id", "=", "checkout_travelers.checkout_id"),
          ),
        ),
      )
      .execute(),
    unbookedContacts: await trx
      .selectFrom("checkout_contacts")
      .selectAll()
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("bookings")
              .select("bookings.id")
              .whereRef("bookings.checkout_id", "=", "checkout_contacts.checkout_id"),
          ),
        ),
      )
      .execute(),
    documents: (await trx.selectFrom("checkout_travelers").select("documents_ciphertext").execute()).map(
      (row) => row.documents_ciphertext,
    ),
  }));
}

/** A row as text, its bytea columns as hex, for a search of personal values. */
const rowText = (row: unknown): string =>
  JSON.stringify(row, (_key, value: unknown) =>
    value !== null && typeof value === "object" && (value as { type?: unknown }).type === "Buffer"
      ? Buffer.from((value as { data: number[] }).data).toString("hex")
      : value,
  );

/** What a seeded customer has before any erasure: one of each, two consent events, no data export. */
const SEEDED_OWN_ROWS = {
  customers: 1,
  identities: 1,
  sessions: 1,
  passwordResets: 1,
  consents: 2,
  preferences: 1,
  dataExports: 0,
  savedTravelers: 1,
  savedTravelerDocuments: 1,
};

/** What is left of an erased customer's own rows: nothing. */
const NO_OWN_ROWS = Object.fromEntries(Object.keys(SEEDED_OWN_ROWS).map((table) => [table, 0]));

// ---- The scheduler's side ---------------------------------------------------------------------------------------

/** Calls `check` every 25 ms until it returns a value other than `undefined`, at most WAIT_MS. */
async function waitFor<T>(what: string, check: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor: ${what} did not happen within ${WAIT_MS} ms`);
    }
    await new Promise((done) => setTimeout(done, 25));
  }
}

/**
 * The job `id` of `ota-maintenance` once it has finished (completed or failed). The state is read first and the job
 * after it: BullMQ writes a job's result and moves it to its final set in one step.
 */
async function finished(id: string): Promise<Job> {
  return await waitFor(`the job ${id}`, async () => {
    const state = await maintenance.getJobState(id);
    return state === "completed" || state === "failed" ? await maintenance.getJob(id) : undefined;
  });
}

/** The per-tenant jobs of one run, by tenant. */
type RunJobs = Record<TenantKey, Job>;

/**
 * One `customers.erase` iteration due at the clock's minute: its `fan-out` job, then the per-tenant jobs of both
 * tenants (alpha `active`, beta `suspended`), whose ids the fan-out builds.
 */
async function iteration(): Promise<RunJobs> {
  const due = clock.now();
  const fanOut = await maintenance.add(
    FAN_OUT_JOB,
    { task: CUSTOMERS_ERASE_JOB },
    { prevMillis: due.getTime() },
  );
  await finished(fanOut.id ?? "");
  return {
    alpha: await finished(tenantJobId(CUSTOMERS_ERASE_JOB, tenantIds.alpha, minuteBucket(due))),
    beta: await finished(tenantJobId(CUSTOMERS_ERASE_JOB, tenantIds.beta, minuteBucket(due))),
  };
}

/** The result a per-tenant job completed with. */
function resultOf(job: Job): TenantJobResult {
  return job.returnvalue as TenantJobResult;
}

/** The counts of a job that erased `customers` seeded customers (each with one of each row) and nothing else. */
function seededCounts(customers: number): ErasureCounts {
  return {
    customers,
    failed: 0,
    // The booked checkout and the abandoned one; the abandoned one's traveller and contact.
    checkoutsDetached: 2 * customers,
    checkoutTravelers: customers,
    checkoutContacts: customers,
    bookingsDetached: customers,
    paymentsDetached: customers,
    accountEmails: ACCOUNT_EMAILS_PER_CUSTOMER * customers,
    savedTravelerDocuments: customers,
    savedTravelers: customers,
    preferences: customers,
    dataExports: 0,
    sessions: customers,
    passwordResets: customers,
    consents: 2 * customers,
    identities: customers,
  };
}

/** A completed per-tenant job's result with these counts. */
function done(tenant: TenantKey, counts: ErasureCounts, continued = false): TenantJobResult {
  return { task: CUSTOMERS_ERASE_JOB, tenantId: tenantIds[tenant], outcome: "done", counts, continued };
}

/** The `customer.erased` lines logged so far. */
const erasedLines = (): Record<string, unknown>[] =>
  sink.records().filter((record) => record["msg"] === "customer.erased");

beforeAll(async () => {
  db = await createTestDatabase();
  redis = await useRedis();
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: quietPoolLogger,
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-app",
    logger: quietPoolLogger,
    max: 3,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  tenantIds.alpha = await insertTenant("alpha", "active");
  tenantIds.beta = await insertTenant("beta", "suspended");
  for (const tenant of ["alpha", "beta"] as const) {
    pricedOfferIds[tenant] = await insertPricedOffer(tenant);
  }

  const config = loadWorkerConfig({
    ...testWorkerVariables(),
    APP_ENV: "test",
    DATABASE_URL: db.urlFor("ota"),
    DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
    REDIS_URL: redis.url,
  });
  useNextApplicationLoggerOutsideRequests();
  worker = await createWorkerApp(WorkerModule.forRoot(config, { logger: createWorkerLogger(config, sink) }));
  await worker.init();
  maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
  // From here on the file plays the scheduler: no iteration of the real ones may fire while it runs.
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
}, SETUP_TIMEOUT_MS);

describe("customers.erase: who is erased, what goes and what stays", () => {
  /** Alpha: deleted 31 days ago, due. */
  let due: SeededCustomer;
  /** Alpha: deleted 29 days ago, not due yet. */
  let recent: SeededCustomer;
  /** Alpha: an active customer. */
  let active: SeededCustomer;
  /** Beta (suspended): deleted 31 days ago, due. */
  let suspendedDue: SeededCustomer;
  /** Beta: a customer with the id of alpha's due one, deleted 29 days ago: another tenant's row. */
  let twin: SeededCustomer;
  const before: Record<string, Record<string, unknown>> = {};
  const after: Record<string, Record<string, unknown>> = {};
  const ownBefore: Record<string, Record<string, number>> = {};
  const ownAfter: Record<string, Record<string, number>> = {};
  let run: RunJobs;
  /** The run's instant: the time of its booking events and of its changes to the account e-mails. */
  let runAt: Date;
  const tablesAfter: Partial<Record<TenantKey, Awaited<ReturnType<typeof personalTables>>>> = {};

  beforeAll(async () => {
    vi.spyOn(worker.get(Clock, { strict: false }), "now").mockImplementation(() => clock.now());
    due = await seedCustomer("alpha", { deletedInMs: -31 * DAY_MS });
    recent = await seedCustomer("alpha", { deletedInMs: -29 * DAY_MS });
    active = await seedCustomer("alpha", { deletedInMs: null });
    suspendedDue = await seedCustomer("beta", { deletedInMs: -31 * DAY_MS });
    twin = await seedCustomer("beta", { id: due.id, deletedInMs: -29 * DAY_MS });
    const seeded = { due, recent, active, suspendedDue, twin };
    const tenantOf = (name: string): TenantKey =>
      name === "suspendedDue" || name === "twin" ? "beta" : "alpha";
    for (const [name, customer] of Object.entries(seeded)) {
      before[name] = await recordsOf(tenantOf(name), customer);
      ownBefore[name] = await ownRowsOf(tenantOf(name), customer.id);
    }

    runAt = clock.now();
    run = await iteration();

    for (const [name, customer] of Object.entries(seeded)) {
      after[name] = await recordsOf(tenantOf(name), customer);
      ownAfter[name] = await ownRowsOf(tenantOf(name), customer.id);
    }
    tablesAfter.alpha = await personalTables("alpha");
    tablesAfter.beta = await personalTables("beta");
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-087 AC1] erases a customer deleted 31 days ago: the row, its identities, consents, sessions and saved data are gone", () => {
    expect(ownBefore["due"]).toEqual(SEEDED_OWN_ROWS);
    expect(ownAfter["due"]).toEqual(NO_OWN_ROWS);
    expect(after["due"]?.["customer"]).toBeUndefined();
    expect(resultOf(run.alpha)).toEqual(done("alpha", seededCounts(1)));
  });

  it("[OBE-087 AC1] leaves a customer deleted 29 days ago untouched, and an active one too", () => {
    expect(ownAfter["recent"]).toEqual(SEEDED_OWN_ROWS);
    expect(after["recent"]).toEqual(before["recent"]);
    expect((after["recent"]?.["booking"] as { customer_id: string | null }).customer_id).toBe(recent.id);
    expect(ownAfter["active"]).toEqual(SEEDED_OWN_ROWS);
    expect(after["active"]).toEqual(before["active"]);
  });

  it("[OBE-087 AC2] keeps the booking, payment and refund with their amounts and references; only customer_id is detached", () => {
    const was = before["due"] ?? {};
    const is = after["due"] ?? {};
    // Every column as it was (amounts, references, statuses, version, updated_at), customer_id now NULL.
    expect(is["booking"]).toEqual({ ...(was["booking"] as object), customer_id: null });
    expect(is["payment"]).toEqual({ ...(was["payment"] as object), customer_id: null });
    expect(is["refund"]).toEqual(was["refund"]);
    expect(is["booking"]).toMatchObject({
      reference: (was["booking"] as { reference: string }).reference,
      total_amount: "440.00",
      amount_paid: "440.00",
      amount_refunded: "40.00",
      status: "ticketed",
      version: 7,
    });
    expect(is["payment"]).toMatchObject({
      provider_payment_id: (was["payment"] as { provider_payment_id: string }).provider_payment_id,
      amount: "440.00",
      amount_captured: "440.00",
      amount_refunded: "40.00",
      card_last4: "4242",
    });
    expect(is["refund"]).toMatchObject({
      amount: "40.00",
      payment_id: due.paymentId,
      booking_id: due.bookingId,
      status: "succeeded",
    });
    // The booking's travellers, contact and timeline are its financial and audit record (db README §7); the erasure
    // only adds its marker to the timeline (lead decision (5h) of 2026-11-05).
    expect(is["travelers"]).toEqual(was["travelers"]);
    expect(is["contacts"]).toEqual(was["contacts"]);
    expect(
      (is["events"] as { type: string }[]).filter((event) => event.type !== CUSTOMER_ERASED_EVENT),
    ).toEqual(was["events"]);
  });

  it("detaches the checkout, the search and the e-mail record too, and keeps the checkout's guest flag and status", () => {
    const was = before["due"] ?? {};
    const is = after["due"] ?? {};
    expect(is["checkout"]).toEqual({ ...(was["checkout"] as object), customer_id: null });
    expect(is["checkout"]).toMatchObject({ is_guest: false, status: "completed", version: 4 });
    expect(is["abandonedCheckout"]).toEqual({ ...(was["abandonedCheckout"] as object), customer_id: null });
    expect(is["abandonedCheckout"]).toMatchObject({ is_guest: false, status: "abandoned", version: 3 });
    expect(is["search"]).toEqual({ ...(was["search"] as object), customer_id: null });
    // A booking e-mail stays with its booking: only detached from the customer.
    expect(is["notification"]).toEqual({ ...(was["notification"] as object), customer_id: null });
  });

  it("[FIX-W43-OTA AC2] leaves the customer's account e-mails without an address, variables or subject, and cancels the one still pending", () => {
    const was = before["due"]?.["accountEmails"] as Record<string, unknown>[];
    const is = after["due"]?.["accountEmails"] as Record<string, unknown>[];
    expect(was).toHaveLength(ACCOUNT_EMAILS_PER_CUSTOMER);
    expect(is.map((row) => row["id"])).toEqual(was.map((row) => row["id"]));
    for (const [index, row] of is.entries()) {
      const prior = was[index] ?? {};
      const pending = prior["status"] === "pending";
      // The template, the time it was sent, the provider's id and the ids in its dedupe key stay: the record that an
      // e-mail was sent, and nothing of the person it went to.
      expect(row).toEqual({
        ...prior,
        recipient: ERASED_RECIPIENT,
        payload: {},
        subject: null,
        customer_id: null,
        status: pending ? "cancelled" : "sent",
        secret_payload_ciphertext: null,
        secrets_purged_at: pending ? runAt : prior["secrets_purged_at"],
        updated_at: runAt,
      });
      for (const value of due.personalData) {
        expect(rowText(row)).not.toContain(value);
      }
    }
    expect(is.filter((row) => row["status"] === "cancelled")).toHaveLength(1);
  });

  it("[FIX-W43-OTA AC2] leaves no name, address or phone number of the customer in the outbox but the booking e-mail's recipient", () => {
    const [firstName, lastName, address, placeholder, phone, newAddress, street] = due.personalData;
    const rows = tablesAfter.alpha?.notifications ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const value of [firstName, lastName, placeholder, phone, newAddress, street]) {
      expect(rows.filter((row) => rowText(row).includes(value ?? "-"))).toEqual([]);
    }
    // The booking's confirmation still goes to the booking's contact address: the booking's record (db README §7).
    expect(rows.filter((row) => rowText(row).includes(address ?? "-")).map((row) => row.id)).toEqual([
      due.notificationId,
    ]);
  });

  it("[FIX-W43-OTA AC2] deletes the travellers and contacts of the customer's checkouts that never became bookings, document ciphertexts included", () => {
    const was = before["due"] ?? {};
    const is = after["due"] ?? {};
    expect(was["abandonedTravelers"]).toHaveLength(1);
    expect(was["abandonedContacts"]).toHaveLength(1);
    expect(is["abandonedTravelers"]).toEqual([]);
    expect(is["abandonedContacts"]).toEqual([]);
    // Nowhere in the tenant's checkouts that no booking names is anything of the customer left, nor its documents
    // in any checkout traveller.
    const tables = tablesAfter.alpha;
    for (const row of [...(tables?.unbookedTravelers ?? []), ...(tables?.unbookedContacts ?? [])]) {
      for (const value of due.personalData) {
        expect(rowText(row)).not.toContain(value);
      }
    }
    expect(tables?.documents.some((document) => document?.equals(due.abandonedDocuments) === true)).toBe(
      false,
    );
    // The suspended tenant's erased customer too.
    expect(after["suspendedDue"]?.["abandonedTravelers"]).toEqual([]);
    expect(after["suspendedDue"]?.["abandonedContacts"]).toEqual([]);
    expect(
      tablesAfter.beta?.documents.some(
        (document) => document?.equals(suspendedDue.abandonedDocuments) === true,
      ),
    ).toBe(false);
  });

  it("[FIX-W43-OTA AC2] keeps the traveller and contact of the checkout that became the booking, as the booking keeps its own", () => {
    const was = before["due"] ?? {};
    const is = after["due"] ?? {};
    expect(was["bookedTravelers"]).toHaveLength(1);
    expect(is["bookedTravelers"]).toEqual(was["bookedTravelers"]);
    expect(is["bookedContacts"]).toEqual(was["bookedContacts"]);
  });

  it("[FIX-W43-OTA AC3] marks the detached booking with a customer.erased event without personal data, staff only", () => {
    const events = after["due"]?.["events"] as Record<string, unknown>[];
    const markers = events.filter((event) => event["type"] === CUSTOMER_ERASED_EVENT);
    expect(markers).toEqual([
      {
        id: expect.stringMatching(/^evt_/) as unknown,
        booking_id: due.bookingId,
        type: CUSTOMER_ERASED_EVENT,
        actor_type: "system",
        actor_id: null,
        status_from: null,
        status_to: null,
        summary: CUSTOMER_ERASED_SUMMARY,
        data: {},
        visible_to_customer: false,
        supplier_request_id: null,
        request_id: null,
        created_at: runAt,
        updated_at: runAt,
      },
    ]);
    for (const value of [...due.personalData, due.id]) {
      expect(rowText(markers)).not.toContain(value);
    }
    expect(
      (after["suspendedDue"]?.["events"] as { type: string }[]).filter(
        (event) => event.type === CUSTOMER_ERASED_EVENT,
      ),
    ).toHaveLength(1);
  });

  it("[FIX-W43-OTA AC1] the hourly cut-off leaves the customer deleted 29 days ago untouched: account e-mails, checkouts and bookings", () => {
    // 29 days is more than a day short of the cut-off of 30 days less one hour.
    expect(29 * DAY_MS).toBeLessThan(ERASURE_CUTOFF_AFTER_MS);
    expect(after["recent"]?.["accountEmails"]).toEqual(before["recent"]?.["accountEmails"]);
    expect(after["recent"]?.["abandonedTravelers"]).toEqual(before["recent"]?.["abandonedTravelers"]);
    expect(after["recent"]?.["abandonedContacts"]).toEqual(before["recent"]?.["abandonedContacts"]);
    expect(after["recent"]?.["events"]).toEqual(before["recent"]?.["events"]);
    expect(after["twin"]).toEqual(before["twin"]);
  });

  it("erases a suspended tenant's due customers (OADR-0014 point 4) in that tenant's schema only", () => {
    expect(ownAfter["suspendedDue"]).toEqual(NO_OWN_ROWS);
    expect(after["suspendedDue"]?.["booking"]).toMatchObject({ customer_id: null, total_amount: "440.00" });
    expect(resultOf(run.beta)).toEqual(done("beta", seededCounts(1)));
    // Beta's customer with the id alpha's erasure deleted is another row, in another schema, and not due yet.
    expect(twin.id).toBe(due.id);
    expect(ownAfter["twin"]).toEqual(SEEDED_OWN_ROWS);
    expect(after["twin"]).toEqual(before["twin"]);
  });

  it("logs one customer.erased line per erasure with the tenant, the id and counts, never a name, an address or a phone number", () => {
    // The two tenants' jobs may run side by side (the queue's concurrency is 2): their lines are read per tenant.
    const lines = erasedLines();
    expect(lines).toHaveLength(2);
    const ofTenant = (tenant: TenantKey) => lines.filter((line) => line["tenantId"] === tenantIds[tenant]);
    for (const [tenant, customer] of [
      ["alpha", due],
      ["beta", suspendedDue],
    ] as const) {
      expect(ofTenant(tenant)).toEqual([
        expect.objectContaining({
          customerId: customer.id,
          checkoutsDetached: 2,
          checkoutTravelers: 1,
          checkoutContacts: 1,
          bookingsDetached: 1,
          paymentsDetached: 1,
          accountEmails: ACCOUNT_EMAILS_PER_CUSTOMER,
          sessions: 1,
          consents: 2,
          identities: 1,
        }),
      ]);
    }
    const text = sink.text();
    for (const customer of [due, recent, active, suspendedDue, twin]) {
      for (const value of customer.personalData) {
        expect(text).not.toContain(value);
      }
    }
    expect(text).not.toContain("1988-04-17");
  });
});

describe("customers.erase: idempotent", () => {
  let again: RunJobs;
  let unchanged: { before: Record<string, number>; after: Record<string, number> };
  let later: RunJobs;
  let recentAfter: Record<string, number>;

  /** How many rows each table holds in alpha: what a run that erases nothing must leave as it is. */
  async function tableSizes(): Promise<Record<string, number>> {
    return await txOf("alpha")(async (trx) => {
      const sizes: Record<string, number> = {};
      for (const table of [
        "customers",
        "customer_identities",
        "customer_sessions",
        "customer_password_resets",
        "customer_consents",
        "customer_preferences",
        "saved_travelers",
        "saved_traveler_documents",
        "checkouts",
        "checkout_travelers",
        "checkout_contacts",
        "bookings",
        "booking_events",
        "payments",
        "refunds",
        "notifications",
      ] as const) {
        const rows = await trx.selectFrom(table).select("id").execute();
        sizes[table] = rows.length;
      }
      const attached = await trx
        .selectFrom("bookings")
        .select("id")
        .where("customer_id", "is not", null)
        .execute();
      sizes["bookingsWithCustomer"] = attached.length;
      return sizes;
    });
  }

  beforeAll(async () => {
    vi.spyOn(worker.get(Clock, { strict: false }), "now").mockImplementation(() => clock.now());
    const sizesBefore = await tableSizes();
    clock.advance(MINUTE_MS);
    again = await iteration();
    unchanged = { before: sizesBefore, after: await tableSizes() };

    // Two days on, the customer deleted 29 days ago is 31 days past its deletion.
    clock.advance(2 * DAY_MS);
    later = await iteration();
    recentAfter = await txOf("alpha")(async (trx) => {
      const rows = await trx.selectFrom("customers").select("id").where("status", "=", "deleted").execute();
      return { deletedCustomers: rows.length };
    });
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-087 AC1] [FIX-W43-OTA AC2] [FIX-W43-OTA AC3] a second run erases nothing and changes nothing: no second marker, nothing more cleared", () => {
    expect(resultOf(again.alpha)).toEqual(done("alpha", seededCounts(0)));
    expect(resultOf(again.beta)).toEqual(done("beta", seededCounts(0)));
    expect(unchanged.after).toEqual(unchanged.before);
  });

  it("[OBE-087 AC1] erases the customer deleted 29 days ago once 30 days have passed", () => {
    // Alpha's customer deleted 29 days ago and beta's twin, both 31 days past their deletion now.
    expect(resultOf(later.alpha)).toEqual(done("alpha", seededCounts(1)));
    expect(resultOf(later.beta)).toEqual(done("beta", seededCounts(1)));
    expect(recentAfter).toEqual({ deletedCustomers: 0 });
  });
});

describe("customers.erase: batches", () => {
  /** The deleted customers of the scenario, oldest deletion first. */
  let deleted: string[];
  let first: Job;
  let continuation: Job;
  let left: number;

  beforeAll(async () => {
    vi.spyOn(worker.get(Clock, { strict: false }), "now").mockImplementation(() => clock.now());
    clock.advance(MINUTE_MS);
    // One more than a batch, deleted a second apart between 40 and 39 days ago, inserted newest first.
    deleted = await txOf("alpha")(async (trx) => {
      const ids: string[] = [];
      for (let index = ERASURE_BATCH; index >= 0; index -= 1) {
        ids.unshift(await insertDeletedCustomer(trx, -40 * DAY_MS + index * 1000));
      }
      return ids;
    });
    const dueAt = clock.now();
    await maintenance.add(FAN_OUT_JOB, { task: CUSTOMERS_ERASE_JOB }, { prevMillis: dueAt.getTime() });
    const bucket = minuteBucket(dueAt);
    first = await finished(tenantJobId(CUSTOMERS_ERASE_JOB, tenantIds.alpha, bucket));
    continuation = await finished(tenantJobId(CUSTOMERS_ERASE_JOB, tenantIds.alpha, bucket, 1));
    await finished(tenantJobId(CUSTOMERS_ERASE_JOB, tenantIds.beta, bucket));
    left = await txOf("alpha")(async (trx) => {
      const rows = await trx.selectFrom("customers").select("id").where("id", "in", deleted).execute();
      return rows.length;
    });
  }, SCENARIO_TIMEOUT_MS);

  it("erases 100 customers per job, oldest deletion first, and continues with the rest (OADR-0014 point 2)", () => {
    const minimal = (customers: number): ErasureCounts => ({
      ...seededCounts(0),
      customers,
      identities: customers,
    });
    expect(resultOf(first)).toEqual(done("alpha", minimal(ERASURE_BATCH), true));
    expect(resultOf(continuation)).toEqual(done("alpha", minimal(1)));
    expect(left).toBe(0);
    const order = erasedLines()
      .map((line) => line["customerId"])
      .filter((id): id is string => typeof id === "string" && deleted.includes(id));
    expect(order).toEqual(deleted);
  });
});

describe("customers.erase: the cut-off of 30 days less one hour, and the next hourly run", () => {
  /** Alpha: deleted exactly 30 days before the first run, so its erasureDueBy is that run's instant. */
  let onTheDay: SeededCustomer;
  /** Alpha: deleted 30 days less one hour before the first run: at the cut-off, an hour before its erasureDueBy. */
  let atTheCutoff: SeededCustomer;
  /** Alpha: deleted one second after that: a second short of the first run's cut-off. */
  let aSecondShort: SeededCustomer;
  /** The erasureDueBy account.delete answered each of them: its deletion + 30 days. */
  const dueBy: Record<string, Date> = {};
  let first: RunJobs;
  let firstAt: Date;
  let next: RunJobs;
  let nextAt: Date;
  const ownAfterFirst: Record<string, Record<string, number>> = {};
  const ownAfterNext: Record<string, Record<string, number>> = {};

  beforeAll(async () => {
    vi.spyOn(worker.get(Clock, { strict: false }), "now").mockImplementation(() => clock.now());
    clock.advance(MINUTE_MS);
    const deletions = {
      onTheDay: -ERASURE_DUE_AFTER_MS,
      atTheCutoff: -ERASURE_CUTOFF_AFTER_MS,
      aSecondShort: -ERASURE_CUTOFF_AFTER_MS + 1000,
    };
    onTheDay = await seedCustomer("alpha", { deletedInMs: deletions.onTheDay });
    atTheCutoff = await seedCustomer("alpha", { deletedInMs: deletions.atTheCutoff });
    aSecondShort = await seedCustomer("alpha", { deletedInMs: deletions.aSecondShort });
    for (const [name, deletedInMs] of Object.entries(deletions)) {
      dueBy[name] = fromNow(deletedInMs + ERASURE_DUE_AFTER_MS);
    }
    const seeded = { onTheDay, atTheCutoff, aSecondShort };

    firstAt = clock.now();
    first = await iteration();
    for (const [name, customer] of Object.entries(seeded)) {
      ownAfterFirst[name] = await ownRowsOf("alpha", customer.id);
    }

    // The schedule's next run, an hour later (minute 50 of the next hour).
    clock.advance(ERASURE_RUN_INTERVAL_MS);
    nextAt = clock.now();
    next = await iteration();
    for (const [name, customer] of Object.entries(seeded)) {
      ownAfterNext[name] = await ownRowsOf("alpha", customer.id);
    }
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W43-OTA AC1] erases a customer at the cut-off, an hour before its erasureDueBy, and leaves one a second short of the cut-off", () => {
    expect(ownAfterFirst["atTheCutoff"]).toEqual(NO_OWN_ROWS);
    expect(firstAt.getTime()).toBe((dueBy["atTheCutoff"]?.getTime() ?? 0) - ERASURE_RUN_INTERVAL_MS);
    // One deleted exactly 30 days ago is due too: its erasureDueBy is this run's instant.
    expect(ownAfterFirst["onTheDay"]).toEqual(NO_OWN_ROWS);
    expect(ownAfterFirst["aSecondShort"]).toEqual(SEEDED_OWN_ROWS);
    expect(resultOf(first.alpha)).toEqual(done("alpha", seededCounts(2)));
    expect(resultOf(first.beta)).toEqual(done("beta", seededCounts(0)));
  });

  it("[FIX-W43-OTA AC1] the next hourly run erases the customer a second short of the cut-off before its erasureDueBy", () => {
    expect(nextAt.getTime() - firstAt.getTime()).toBe(ERASURE_RUN_INTERVAL_MS);
    expect(ownAfterNext["aSecondShort"]).toEqual(NO_OWN_ROWS);
    expect(nextAt.getTime()).toBeLessThan(dueBy["aSecondShort"]?.getTime() ?? 0);
    expect(resultOf(next.alpha)).toEqual(done("alpha", seededCounts(1)));
    expect(resultOf(next.beta)).toEqual(done("beta", seededCounts(0)));
  });
});
