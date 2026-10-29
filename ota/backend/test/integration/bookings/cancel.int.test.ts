// bookings.quoteCancellation and bookings.cancel (OBE-049, OF-08 AC2; ota/docs/flows/change-and-cancel.md §2, §3 steps
// 3–7, §4, §7): the quote, the cancellation at Amadeus and in the booking, and its money step exactly once, against
// PostgreSQL 16, Redis 7, the Amadeus stub and a fake of the Stripe API, through the API's whole pipeline (key and edge
// callers, CSRF, the booking access guard, validation, idempotency) and the worker's queues (`refund.submit` and
// `payment.void` on `ota-payments`, `booking.cancellation_check` on `ota-bookings`).
//
// The file clones the @velexis/testing template (tenant_alpha provisioned) and writes the platform rows as the platform
// does: alpha in test on the Velexis test Amadeus account, whose base URL is the stub's (the worker has no override),
// with a Velexis-mode Stripe connection and a secret test key. Customers are inserted with access tokens signed by the
// API's own key; guests hold a booking token row. Every booking points at an order created in the stub through its own
// HTTP API and is written the way the record step writes it (the redacted snapshot, the order's contact and remarks),
// with synthetic travellers and flights relative to now, a total of 125.47 EUR of which 15.00 are the booking's OTA fees
// (no priced offer: every fee is kept) and a cancellation fee rule of 10.00 EUR (economy): a Stripe payment captured in
// full is estimated at 125.47 − 15.00 − 10.00 = 100.47. Since FIX-W28-CANCEL (lead decisions (1) and (2) of 2026-10-23,
// second batch) an authorisation is split the same way, its kept 25.00 captured with
// `pi:capture:<pay_id>:cancellation:25.00` and the rest released (only a booking that keeps nothing voids it), and a
// card fee is kept unless its stored line is refundable. Payments are written as checkout.createPayment and the webhooks leave
// them, with their PaymentIntents in the fake. Both processes run in-process: the API (createTestApp) and the worker
// (WorkerModule.forRoot), whose schedulers are removed and whose e-mail and document consumers are paused (the outbox
// rows and the queued documents are what this file checks). The worker's check of a DELETE without an answer is queued
// 30 s later; the file promotes the delayed job instead of waiting. Amadeus answers are chosen per call by giving the
// client a stub scenario for the DELETE (a spy, as update.int.test.ts does); the stub's `timeout` holds an answer for
// 100 ms instead of 30 s. Both processes' Amadeus buckets hold enough calls for the whole file (LIMITS). Every answer
// is checked against the OTA document.
import { randomBytes } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Global, Module, type DynamicModule, type INestApplicationContext } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { encryptValue, hashApiKey, type KeyProvider } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  sql,
  tenantTx,
  type Kysely,
  type PlatformDatabase,
  type TenantDb,
  type TenantSchema,
} from "@velexis/db";
import { AppError } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import {
  createTestDatabase,
  expectResponseToMatch,
  responseChecker,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import { startAmadeusStub, type AmadeusStub } from "@velexis/testing/amadeus";
import { uniqueEmail } from "@velexis/testing/mailpit";
import type { Job, Queue } from "bullmq";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AmadeusClient } from "../../../src/amadeus/amadeus.client";
import { AMADEUS_LIMITS, DEFAULT_AMADEUS_LIMITS, type AmadeusLimits } from "../../../src/amadeus/limits";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { localDayOf } from "../../../src/bookings/cancellation-mode";
import {
  CANCELLATION_CHECK_JOB,
  CANCELLATION_CHECK_MAX_RUNS,
  CancellationRecorder,
  REQUEST_ONLY_WARNING,
} from "../../../src/bookings/cancellation.service";
import { CustomerBookingsService } from "../../../src/bookings/customer-bookings.service";
import { newBookingToken } from "../../../src/bookings/guest-access.service";
import { buildCreateOrderRequest } from "../../../src/bookings/order-request.builder";
import { bookingTokenHash } from "../../../src/common/auth/booking-access.guard";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { loadWorkerConfig, type ApiConfig } from "../../../src/config";
import { DocumentsProcessor } from "../../../src/documents/documents.processor";
import { TokenService } from "../../../src/identity/token.service";
import { NotificationsProcessor } from "../../../src/notifications/notifications.processor";
import {
  cancellationCaptureRetryJob,
  PAYMENT_JOB,
  paymentJob,
  PaymentsProcessor,
} from "../../../src/payments/payments.processor";
import { Money } from "../../../src/pricing/pricing.types";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import { ReconcileProcessor, RECONCILE_SCAN_JOB } from "../../../src/bookings/reconcile.processor";
import { ticketingJob } from "../../../src/bookings/ticketing.processor";
import { minuteBucket, tenantJob } from "../../../src/jobs/fan-out";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { buildOrderContact, buildOrderRequestInput } from "../../builders/bookings";
import {
  edgeWriteHeaders,
  newApiKey,
  testApiCredentials,
  testKeyProvider,
  testWorkerVariables,
} from "../../helpers/api-env";
import { startFakeStripe, stripeEndpointModule, type FakeStripe } from "../../helpers/fake-stripe";
import { holdKeyShare, probeLockOrder } from "../../helpers/lock-order";
import {
  runDelayedPaymentJob as runPaymentJobNow,
  type FinishedPaymentJob,
} from "../../helpers/payment-jobs";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type JsonObject = Record<string, unknown>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ALPHA: TenantSchema = "tenant_alpha" as TenantSchema;
const ALPHA_HOST = "alpha.ota.example.com";
const TIME_ZONE = "Europe/Paris";

/**
 * A scenario quotes and cancels a booking (a few API calls, one or two stub calls) and waits for the worker's jobs:
 * well under a second each locally; the bound allows for CI load and only stops a scenario that hangs.
 */
const SCENARIO_TIMEOUT_MS = 60_000;
/** How long a scenario waits at most for the worker. */
const WAIT_MS = 20_000;

/**
 * The Amadeus client's buckets of this file: the scenarios make their quotes, DELETEs and the worker's reads one after
 * the other for one tenant, faster than the tenant bucket's 10-call burst refills, so the buckets hold enough for the
 * whole file and no call meets the client's `429` (limits.ts: tests pass their own; sync.int.test.ts does the same).
 */
const LIMITS: AmadeusLimits = Object.freeze({
  ...DEFAULT_AMADEUS_LIMITS,
  credentialBucket: Object.freeze({ ratePerSecond: 20, burst: 500 }),
  tenantBucket: Object.freeze({ ratePerSecond: 5, burst: 500 }),
});

/** A global module that provides LIMITS to the Amadeus client and rate limiter of the API and of the worker. */
function amadeusLimitsModule(): DynamicModule {
  @Global()
  @Module({})
  class TestAmadeusLimitsModule {}
  return {
    module: TestAmadeusLimitsModule,
    providers: [{ provide: AMADEUS_LIMITS, useValue: LIMITS }],
    exports: [AMADEUS_LIMITS],
    global: true,
  };
}

/** This run's Velexis test keys: Stripe's shapes, random, never a committed value. */
const SECRET_KEY = `sk_test_${randomBytes(20).toString("hex")}`;
const PUBLISHABLE_KEY = `pk_test_${randomBytes(20).toString("hex")}`;
const OPS_EMAIL = `ops-alerts-${randomBytes(4).toString("hex")}@alpha-travel.example`;

/** The booking's total, its OTA fees (all kept: no priced offer) and the cancellation fee rule. */
const TOTAL = "125.47";
const FEES = "15.00";
const CANCELLATION_FEE = "10.00";
/** What a Stripe payment of TOTAL captured in full gets back: TOTAL − FEES − CANCELLATION_FEE. */
const REFUND = "100.47";

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let worker: INestApplicationContext;
const workerSink = new MemorySink();
let stub: AmadeusStub;
let stripe: FakeStripe;
let keys: KeyProvider;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let tokens: TokenService;
let alphaId: string;
let alphaSk: string;
let office: string;
let stubCredentials: { readonly clientId: string; readonly clientSecret: string };
let paymentsQueue: Queue;
let bookingsQueue: Queue;

// ---- Platform rows -------------------------------------------------------------------------------------------------

async function insertAmadeusAccount(): Promise<string> {
  const id = newId("ama");
  const { ciphertext, kekId } = await encryptValue(stubCredentials.clientSecret, {
    aad: `platform.amadeus_accounts.client_secret_ciphertext:${id}`,
    keys,
  });
  await migrator
    .insertInto("platform.amadeus_accounts")
    .values({
      id,
      name: "Velexis test",
      environment: "test",
      // The worker has no AMADEUS_BASE_URL_* override: its calls go to the account's base URL, the stub's.
      base_url: stub.url,
      client_id: stubCredentials.clientId,
      client_secret_ciphertext: ciphertext,
      encryption_key_id: kekId,
      status: "active",
    })
    .execute();
  return id;
}

/** The active tenant alpha with its test Amadeus connection (the stub) and its Velexis-mode Stripe connection. */
async function insertTenant(accountId: string): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key: "alpha", name: "alpha Travel", status: "active", plan_code: "early_access" })
    .execute();
  await migrator
    .insertInto("platform.supplier_connections")
    .values({
      id: newId("sc"),
      tenant_id: id,
      environment: "test",
      credential_source: "velexis",
      amadeus_account_id: accountId,
      office_ids: [office],
      default_office_id: office,
      queuing_office_id: office,
      owner_office_id: office,
      status: "active",
    })
    .execute();
  await migrator
    .insertInto("platform.payment_provider_connections")
    .values({
      id: newId("ppc"),
      tenant_id: id,
      provider: "stripe",
      environment: "test",
      account_mode: "velexis",
      capture_mode: "manual",
      is_default: true,
      status: "active",
    })
    .execute();
  return id;
}

/** A secret test key of alpha (a storefront server key), as the platform issues it. */
async function issueKey(tenantId: string): Promise<string> {
  const key = newApiKey("sk", "test");
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
      name: "Server (storefront)",
      kind: "secret",
      environment: "test",
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
    })
    .execute();
  return key;
}

// ---- Tenant rows ---------------------------------------------------------------------------------------------------

const inTenant = <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, ALPHA, run);

/** Turns the OTA's self-service cancellation on or off (`storefront_settings.features`). */
async function setSelfService(on: boolean): Promise<void> {
  await inTenant((trx) =>
    trx
      .updateTable("storefront_settings")
      .set({
        features: sql`jsonb_set(features, '{selfServiceCancellation}', ${JSON.stringify(on)}::jsonb)`,
      })
      .execute(),
  );
}

/** A customer of alpha and an access token for it. */
async function newCustomer(): Promise<{ readonly id: string; readonly token: string }> {
  const id = newId("cus");
  await inTenant((trx) =>
    trx
      .insertInto("customers")
      .values({
        id,
        email: `${id.toLowerCase()}@example.com`,
        email_verified_at: new Date(),
        first_name: "Testa",
        last_name: "Customer",
      })
      .execute(),
  );
  const signed = await tokens.signCustomerToken({ sub: id, tid: alphaId, sid: newId("ses") });
  return { id, token: signed.token };
}

const local = (date: Date): string => date.toISOString().slice(0, 19);

async function stubToken(): Promise<string> {
  const tokenRes = await fetch(`${stub.url}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: stubCredentials.clientId,
      client_secret: stubCredentials.clientSecret,
    }).toString(),
  });
  return ((await tokenRes.json()) as { access_token: string }).access_token;
}

const orderPath = (orderId: string): string => `/v1/booking/flight-orders/${encodeURIComponent(orderId)}`;

/** The status of the order at the stub, as another Amadeus client reads it (404 once it is cancelled). */
async function stubOrderStatus(orderId: string): Promise<number> {
  const res = await fetch(`${stub.url}${orderPath(orderId)}`, {
    headers: { Authorization: `Bearer ${await stubToken()}` },
  });
  await res.body?.cancel();
  return res.status;
}

/**
 * An order of the stub (Flight Create Orders, not issued) of one adult, for `email`, its flight leaving at `outbound`
 * and landing 2 hours later (local times read as UTC, as the record step stores them for the template's airports): the
 * seeded booking holds the same flight, so a refresh, which records the order through the sync's diff since
 * FIX-W27-SYNC, finds no schedule change.
 */
async function newStubOrder(email: string, outbound: Date): Promise<JsonObject> {
  const input = buildOrderRequestInput();
  const flightOffers = records(input.flightOffers).map((offer) => ({
    ...offer,
    itineraries: records(offer["itineraries"]).map((itinerary) => ({
      ...itinerary,
      segments: records(itinerary["segments"]).map((segment) => ({
        ...segment,
        departure: { ...(segment["departure"] as JsonObject), at: local(outbound) },
        arrival: {
          ...(segment["arrival"] as JsonObject),
          at: local(new Date(outbound.getTime() + 2 * HOUR)),
        },
      })),
    })),
  }));
  const built = buildCreateOrderRequest({
    ...input,
    flightOffers,
    contacts: [buildOrderContact({ email })],
    remarks: [],
    offices: { queuing: office, owner: office },
  });
  const res = await fetch(`${stub.url}/v1/booking/flight-orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await stubToken()}`, "Content-Type": "application/vnd.amadeus+json" },
    body: JSON.stringify(built.body),
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { data: JsonObject }).data;
}

const records = (value: unknown): JsonObject[] =>
  Array.isArray(value)
    ? value.filter((item): item is JsonObject => typeof item === "object" && item !== null)
    : [];

/** What a seeded booking looks like. */
interface BookingSeed {
  readonly customerId?: string | null;
  readonly status?: string;
  /** When each traveller's e-ticket was issued; none: not ticketed. */
  readonly ticketsIssuedAt?: readonly Date[];
  /** The departure, relative to now (10 days by default); the flight lasts 2 hours. */
  readonly departInMs?: number;
  /** An airline-card booking: net pricing, no OTA fee or markup, the net total. */
  readonly net?: boolean;
  /**
   * The cabin of its flight (ECONOMY by default, which the cancellation fee rule is scoped to) and its OTA fees (FEES
   * by default; the markup takes the rest of TOTAL): a BUSINESS booking without fees keeps nothing on cancellation.
   */
  readonly cabin?: string;
  readonly fees?: string;
}

/** A seeded booking: its id, its order at the stub and the order's contact address. */
interface SeededBooking {
  readonly id: string;
  readonly orderId: string;
  readonly email: string;
}

/**
 * A booking of a new stub order as the record step writes it: the bookings row (TOTAL, or the net 98.47 for an
 * airline-card booking), its MAD–ORY flight (segment "3" of offer "2", the stub's offer), the adult, the order's
 * contact (primary) and its record, and the tickets of `seed`.
 */
async function seedBooking(prefix: string, seed: BookingSeed = {}): Promise<SeededBooking> {
  const email = uniqueEmail(prefix);
  const id = newId("bkg");
  const now = Date.now();
  const outbound = new Date(now + (seed.departInMs ?? 10 * DAY));
  const order = await newStubOrder(email, outbound);
  // The order's segment, whose terminals the booking keeps as the record step does.
  const flight =
    records(records(records(order["flightOffers"])[0]?.["itineraries"])[0]?.["segments"])[0] ?? {};
  const recordLocator = (records(order["associatedRecords"])[0]?.["reference"] as string | undefined) ?? "";
  const contact = records(order["contacts"])[0] ?? {};
  const contactName = (contact["addresseeName"] ?? {}) as JsonObject;
  const status = seed.status ?? (seed.ticketsIssuedAt === undefined ? "confirmed" : "ticketed");
  const ticketed = seed.ticketsIssuedAt !== undefined && seed.ticketsIssuedAt.length > 0;
  const net = seed.net === true;
  const fees = net ? "0.00" : (seed.fees ?? FEES);
  // The markup takes what the fees do not of TOTAL (98.47 net + 12.00 + 15.00 by default).
  const markup = net ? "0.00" : new Money(TOTAL).minus("98.47").minus(fees).toFixed(2);
  await inTenant(async (trx) => {
    await trx
      .insertInto("bookings")
      .values({
        id,
        environment: "test",
        reference: newBookingReference(),
        channel: "storefront",
        customer_id: seed.customerId ?? null,
        status,
        ticketing_status: status === "cancelled" ? "not_applicable" : ticketed ? "issued" : "pending",
        issued_at: ticketed ? (seed.ticketsIssuedAt?.[0] ?? null) : null,
        amadeus_order_id: order["id"] as string,
        record_locator: recordLocator,
        origin_system_code: "GDS",
        owner_office_id: office,
        queuing_office_id: office,
        trip_type: "one_way",
        origin_iata: "MAD",
        destination_iata: "ORY",
        first_departure_at: outbound,
        last_arrival_at: new Date(outbound.getTime() + 2 * HOUR),
        validating_carrier: "IB",
        travelers_count: 1,
        currency: "EUR",
        pricing_mode: net ? "net" : "markup_rules",
        net_amount: "98.47",
        net_base_amount: "56.00",
        net_fees_amount: "0.00",
        net_services_amount: "0.00",
        markup_amount: markup,
        fees_amount: fees,
        taxes_amount: "42.47",
        total_amount: net ? "98.47" : TOTAL,
        contact_email: contact["emailAddress"] as string,
        lead_last_name: "SAMPLE",
        order_snapshot: JSON.stringify(redactPayload(order)),
        last_synced_at: new Date(now - HOUR),
        cancelled_at: status === "cancelled" ? new Date(now - HOUR) : null,
        cancelled_by: status === "cancelled" ? "airline" : null,
        created_at: new Date(now - 2 * DAY),
      })
      .execute();
    await trx
      .insertInto("booking_segments")
      .values({
        id: newId("seg"),
        booking_id: id,
        amadeus_flight_offer_id: "2",
        amadeus_segment_id: "3",
        itinerary_index: 0,
        segment_index: 0,
        carrier_code: "IB",
        flight_number: "3436",
        departure_iata: "MAD",
        departure_terminal: ((flight["departure"] ?? {}) as JsonObject)["terminal"] as string | undefined,
        departure_local: local(outbound),
        departure_at: outbound,
        arrival_iata: "ORY",
        arrival_terminal: ((flight["arrival"] ?? {}) as JsonObject)["terminal"] as string | undefined,
        arrival_local: local(new Date(outbound.getTime() + 2 * HOUR)),
        arrival_at: new Date(outbound.getTime() + 2 * HOUR),
        duration_minutes: 120,
        cabin: seed.cabin ?? "ECONOMY",
        booking_class: "Q",
        status: status === "cancelled" ? "CANCELLED" : "CONFIRMED",
      })
      .execute();
    const travelerId = newId("btr");
    await trx
      .insertInto("booking_travelers")
      .values({
        id: travelerId,
        booking_id: id,
        amadeus_traveler_id: "1",
        traveler_type: "ADULT",
        first_name: "TESTAA",
        last_name: "SAMPLE",
        date_of_birth: "1988-04-12",
        gender: "FEMALE",
      })
      .execute();
    await trx
      .insertInto("booking_contacts")
      .values({
        id: newId("bco"),
        booking_id: id,
        purpose: "STANDARD",
        is_primary: true,
        first_name: (contactName["firstName"] as string | undefined) ?? null,
        last_name: (contactName["lastName"] as string | undefined) ?? null,
        email: contact["emailAddress"] as string,
        phones: JSON.stringify(contact["phones"] ?? []),
        language: "en",
      })
      .execute();
    await trx
      .insertInto("booking_associated_records")
      .values({
        id: newId("bar"),
        booking_id: id,
        reference: recordLocator,
        origin_system_code: "GDS",
        flight_offer_id: "2",
        is_primary: true,
      })
      .execute();
    for (const issuedAt of seed.ticketsIssuedAt ?? []) {
      await trx
        .insertInto("booking_tickets")
        .values({
          id: newId("tkt"),
          booking_id: id,
          booking_traveler_id: travelerId,
          amadeus_traveler_id: "1",
          document_type: "ETICKET",
          document_number: `075-${String(randomBytes(5).readUIntBE(0, 5)).padStart(10, "0").slice(0, 10)}`,
          status: "ISSUED",
          segment_ids: ["3"],
          validating_carrier: "IB",
          issued_at: issuedAt,
        })
        .execute();
    }
  });
  return { id, orderId: order["id"] as string, email };
}

/** A fresh Stripe-shaped id of this run (`pi_test_…`). */
const stripeId = (prefix: string): string => `${prefix}_test_${randomBytes(10).toString("hex")}`;

/**
 * The payment of a booking, as checkout.createPayment, the capture and the webhooks leave it, and its PaymentIntent in
 * the fake: Stripe `captured` (TOTAL), Stripe `authorized` (TOTAL, not captured), or an airline card the airline
 * charged (the net 98.47). The booking's `amount_paid` follows.
 */
async function seedPayment(
  bookingId: string,
  kind: "captured" | "authorized" | "airline",
  card: { readonly fee: string; readonly lines?: readonly JsonObject[] } = { fee: "0.00" },
): Promise<{ readonly id: string; readonly intentId: string | null }> {
  const id = newId("pay");
  const airline = kind === "airline";
  const amount = airline ? "98.47" : TOTAL;
  const intentId = airline ? null : stripeId("pi");
  await inTenant(async (trx) => {
    await trx
      .insertInto("payments")
      .values({
        id,
        environment: "test",
        booking_id: bookingId,
        provider: airline ? "airline" : "stripe",
        provider_connection_id: airline ? null : newId("ppc"),
        provider_payment_id: intentId,
        method: airline ? "airline_card" : "card",
        capture_method: airline ? "automatic" : "manual",
        currency: "EUR",
        amount,
        // The card fee and, since tenant migration 0004, its lines (none: a payment of before it).
        card_fee_amount: card.fee,
        ...(card.lines === undefined ? {} : { card_fee_lines: JSON.stringify(card.lines) }),
        amount_authorized: amount,
        amount_captured: kind === "authorized" ? "0" : amount,
        status: kind === "authorized" ? "authorized" : "captured",
        card_brand: "VISA",
        card_last4: "4242",
        authorized_at: new Date(Date.now() - DAY),
        captured_at: kind === "authorized" ? null : new Date(Date.now() - DAY),
        three_ds: airline ? null : JSON.stringify({ required: false, status: "not_required", version: null }),
        metadata: JSON.stringify({}),
        version: 2,
      })
      .execute();
    await trx
      .updateTable("bookings")
      .set({ amount_paid: kind === "authorized" ? "0" : amount })
      .where("id", "=", bookingId)
      .execute();
  });
  if (intentId !== null) {
    stripe.intents.set(intentId, {
      id: intentId,
      object: "payment_intent",
      status: kind === "authorized" ? "requires_capture" : "succeeded",
      amount: 12547,
      amount_capturable: kind === "authorized" ? 12547 : 0,
      amount_received: kind === "authorized" ? 0 : 12547,
      currency: "eur",
      capture_method: "manual",
      client_secret: `${intentId}_secret_${randomBytes(8).toString("hex")}`,
      metadata: {
        velexis_tenant_id: alphaId,
        velexis_environment: "test",
        checkout_id: newId("chk"),
        payment_id: id,
      },
      payment_method: {
        id: stripeId("pm"),
        object: "payment_method",
        card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
      },
      latest_charge: kind === "authorized" ? null : stripeId("ch"),
      last_payment_error: null,
      livemode: false,
    });
  }
  return { id, intentId };
}

/** A live guest token of the booking (`booking_access_tokens`, as checkout.complete issues it). */
async function guestToken(bookingId: string): Promise<string> {
  const token = newBookingToken("test");
  await inTenant((trx) =>
    trx
      .insertInto("booking_access_tokens")
      .values({
        id: newId("bat"),
        booking_id: bookingId,
        token_hash: bookingTokenHash(token),
        issued_via: "booking_created",
        expires_at: new Date(Date.now() + 30 * DAY),
      })
      .execute(),
  );
  return token;
}

// ---- The API calls ---------------------------------------------------------------------------------------------------

/** Who calls: a storefront server with its secret key, for a customer or a guest, or the storefront edge. */
type Credential =
  | { readonly kind: "key"; readonly customerToken?: string; readonly bookingToken?: string }
  | { readonly kind: "edge"; readonly customerToken: string };

function credentialHeaders(credential: Credential): Record<string, string> {
  if (credential.kind === "edge") {
    const headers = edgeWriteHeaders(ALPHA_HOST);
    return { ...headers, Cookie: `${headers["Cookie"] ?? ""}; __Host-vx_at=${credential.customerToken}` };
  }
  return {
    "X-Api-Key": alphaSk,
    ...(credential.customerToken === undefined
      ? {}
      : { Authorization: `Bearer ${credential.customerToken}` }),
    ...(credential.bookingToken === undefined ? {} : { "X-Booking-Token": credential.bookingToken }),
  };
}

const quote = (bookingId: string, credential: Credential) =>
  request(api.server).get(`/v1/bookings/${bookingId}/cancellation-quote`).set(credentialHeaders(credential));

const idempotencyKey = (): string => randomBytes(16).toString("hex");

function cancel(
  bookingId: string,
  credential: Credential,
  ifMatch: string,
  body: JsonObject,
  key: string = idempotencyKey(),
) {
  return request(api.server)
    .post(`/v1/bookings/${bookingId}/cancellation`)
    .set({ ...credentialHeaders(credential), "If-Match": ifMatch, "Idempotency-Key": key })
    .send(body);
}

/** The body of a cancellation for the quoted refund. */
const cancellation = (expectedRefund: unknown, extra: JsonObject = {}): JsonObject => ({
  reasonCode: "change_of_plans",
  comment: "Trip postponed",
  expectedRefund,
  ...extra,
});

/** The `[status, error code]` of an answer. */
const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

/**
 * The client's next Flight Order Management DELETE with a stub scenario (only that call: the quote's read and the
 * worker's read answer as usual). Restore the spy after the call.
 */
function nextDeleteWith(scenario: string) {
  const client = api.app.get(AmadeusClient, { strict: false });
  const cancelOrder = client.cancelFlightOrder.bind(client);
  return vi
    .spyOn(client, "cancelFlightOrder")
    .mockImplementationOnce((context, req, options) =>
      cancelOrder({ ...context, stubScenario: scenario }, req, options),
    );
}

const amadeusCalls = (operation: string) => stub.requests().filter((entry) => entry.operation === operation);

const claimedAtOf = async (bookingId: string): Promise<Date | null> =>
  (
    await inTenant((trx) =>
      trx
        .selectFrom("bookings")
        .select("cancellation_claimed_at")
        .where("id", "=", bookingId)
        .executeTakeFirstOrThrow(),
    )
  ).cancellation_claimed_at;

/**
 * The API's next Flight Order Management DELETE held by a barrier: `reached` resolves once the claim (T1) committed
 * and the DELETE is about to leave; `pass()` lets it go to the stub with `scenario` (none: the stub's own answer).
 */
function holdNextDelete(scenario?: string) {
  const client = api.app.get(AmadeusClient, { strict: false });
  const cancelOrder = client.cancelFlightOrder.bind(client);
  let reach = (): void => undefined;
  const reached = new Promise<void>((resolveReach) => {
    reach = resolveReach;
  });
  let pass = (): void => undefined;
  const passed = new Promise<void>((resolvePass) => {
    pass = resolvePass;
  });
  const spy = vi.spyOn(client, "cancelFlightOrder").mockImplementationOnce(async (context, req, options) => {
    reach();
    await passed;
    return await cancelOrder(
      scenario === undefined ? context : { ...context, stubScenario: scenario },
      req,
      options,
    );
  });
  return { reached, pass, spy };
}

// ---- What a scenario reads -----------------------------------------------------------------------------------------

const bookingRow = (bookingId: string) =>
  inTenant((trx) =>
    trx
      .selectFrom("bookings")
      .select([
        "version",
        "status",
        "ticketing_status",
        "cancelled_by",
        "cancel_reason",
        "cancelled_at",
        sql<string>`amount_paid::text`.as("amount_paid"),
      ])
      .where("id", "=", bookingId)
      .executeTakeFirstOrThrow(),
  );

const segmentStatuses = (bookingId: string) =>
  inTenant(async (trx) =>
    (
      await trx.selectFrom("booking_segments").select("status").where("booking_id", "=", bookingId).execute()
    ).map((row) => row.status),
  );

const ticketStatuses = (bookingId: string) =>
  inTenant(async (trx) =>
    (
      await trx.selectFrom("booking_tickets").select("status").where("booking_id", "=", bookingId).execute()
    ).map((row) => row.status),
  );

const eventsOf = (bookingId: string) =>
  inTenant((trx) =>
    trx
      .selectFrom("booking_events")
      .select(["type", "actor_type", "visible_to_customer", "data"])
      .where("booking_id", "=", bookingId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );

const refundsOf = (bookingId: string) =>
  inTenant((trx) =>
    trx
      .selectFrom("refunds")
      .select([
        "id",
        "payment_id",
        "status",
        "reason",
        "requested_by_type",
        "requested_by_id",
        "provider_refund_id",
        sql<string>`amount::text`.as("amount"),
        sql<string | null>`penalty_amount::text`.as("penalty_amount"),
      ])
      .where("booking_id", "=", bookingId)
      .execute(),
  );

const paymentRow = (paymentId: string) =>
  inTenant((trx) =>
    trx
      .selectFrom("payments")
      .select(["status", "canceled_at", sql<string>`amount_captured::text`.as("amount_captured")])
      .where("id", "=", paymentId)
      .executeTakeFirstOrThrow(),
  );

const paymentEventTypes = (paymentId: string) =>
  inTenant(async (trx) =>
    (
      await trx
        .selectFrom("payment_events")
        .select("type")
        .where("payment_id", "=", paymentId)
        .orderBy("created_at")
        .execute()
    ).map((row) => row.type),
  );

const notificationsOf = (bookingId: string) =>
  inTenant((trx) =>
    trx
      .selectFrom("notifications")
      .select(["template_key", "recipient", "recipient_type", "dedupe_key", "payload"])
      .where("booking_id", "=", bookingId)
      .orderBy("template_key")
      .execute(),
  );

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

/** Runs the delayed job `id` of `ota-payments` now and answers how the worker finished it (test/helpers). */
const runDelayedPaymentJob = (id: string): Promise<FinishedPaymentJob> =>
  runPaymentJobNow(worker, paymentsQueue, id);

/** Waits until the job `id` of `queue` has finished (completed or failed) and answers it. */
async function finished(queue: Queue, id: string): Promise<Job> {
  return await waitFor(`the job ${id}`, async () => {
    const state = await queue.getJobState(id);
    return state === "completed" || state === "failed" ? await queue.getJob(id) : undefined;
  });
}

/**
 * The delayed first check of a booking's DELETE without an answer, run now (the API queued it 30 s later; its id ends
 * with the flag's deadline and the run, `…:<bkg_…>:<deadline>-1`).
 */
async function runCheck(bookingId: string, done: ReadonlySet<string> = new Set()): Promise<Job> {
  const prefix = `${CANCELLATION_CHECK_JOB}:${bookingId}:`;
  const job = await waitFor(`the first check of ${bookingId}`, async () =>
    (await bookingsQueue.getJobs(["delayed", "waiting", "active", "completed", "failed"])).find(
      (candidate) =>
        candidate.id?.startsWith(prefix) === true && candidate.id.endsWith("-1") && !done.has(candidate.id),
    ),
  );
  if ((await job.getState()) === "delayed") {
    await job.promote();
  }
  return await finished(bookingsQueue, job.id ?? "");
}

/** The Stripe requests about a PaymentIntent, its cancel and refunds included. */
const stripeRequestsAbout = (intentId: string) =>
  stripe.requests.filter(
    (entry) =>
      entry.path.includes(intentId) ||
      (entry.path === "/v1/refunds" && entry.form["payment_intent"] === intentId),
  );

// Cloning the template, starting the stub and the fake Stripe API, building the API's and the worker's module graphs
// and compiling the response validators take several seconds alone and much longer on a busy 4-CPU runner: all of it
// happens once here, with its own budget, and the scenarios only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["quoteBookingCancellation", [200]],
    ["cancelBooking", [200, 202, 403, 409, 412, 502, 504]],
    ["listBookingEvents", [200]],
    ["getBooking", [200]],
  ] as const) {
    for (const status of statuses) {
      checker.check(operationId, { status, body: {} });
    }
  }
  [db, redis, keys, stripe] = await Promise.all([
    createTestDatabase(),
    useRedis(),
    testKeyProvider(),
    startFakeStripe(),
  ]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-writer",
    logger: { error: () => undefined },
    max: 3,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  stubCredentials = {
    clientId: `velexis-test-${randomBytes(4).toString("hex")}`,
    clientSecret: randomBytes(24).toString("base64url"),
  };
  office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
  stub = await startAmadeusStub({
    credentials: stubCredentials,
    // The `timeout` scenario holds an answer for 100 ms, then gives up with its 504, as after 30 s.
    timers: {
      setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 100)),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
  });
  alphaId = await insertTenant(await insertAmadeusAccount());
  alphaSk = await issueKey(alphaId);
  await inTenant(async (trx) => {
    await seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" });
    await trx
      .updateTable("storefront_settings")
      .set({ ops_alert_email: OPS_EMAIL, time_zone: TIME_ZONE })
      .execute();
    // The OTA's cancellation fee (OADR-0005 point 7): 10.00 EUR per booking in economy, kept (a booking in another
    // cabin without fees keeps nothing: FIX-W28-CANCEL's void of an authorisation).
    await trx
      .insertInto("fee_rules")
      .values({
        id: newId("fee"),
        name: "Cancellation fee",
        label: "Cancellation fee",
        fee_type: "cancellation",
        calculation: "fixed",
        fixed_amount: CANCELLATION_FEE,
        currency: "EUR",
        applies_per: "booking",
        scope: JSON.stringify({ cabins: ["ECONOMY"] }),
        priority: 10,
        is_active: true,
        refundable: false,
      })
      .execute();
  });
  await setSelfService(true);
  tokens = new TokenService(
    { get: () => testApiCredentials().jwtKeyFile } as unknown as ConfigService<ApiConfig, true>,
    new Clock(),
  );
  api = await createTestApp({
    database: db,
    redis,
    imports: [stripeEndpointModule(stripe.endpoint), amadeusLimitsModule()],
    env: {
      AMADEUS_BASE_URL_TEST: stub.url,
      STRIPE_SECRET_KEY_TEST: SECRET_KEY,
      STRIPE_PUBLISHABLE_KEY_TEST: PUBLISHABLE_KEY,
    },
  });
  const config = loadWorkerConfig({
    ...testWorkerVariables(),
    STRIPE_SECRET_KEY_TEST: SECRET_KEY,
    STRIPE_PUBLISHABLE_KEY_TEST: PUBLISHABLE_KEY,
    APP_ENV: "test",
    DATABASE_URL: db.urlFor("ota"),
    DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
    REDIS_URL: redis.url,
  });
  @Module({
    imports: [
      stripeEndpointModule(stripe.endpoint),
      amadeusLimitsModule(),
      WorkerModule.forRoot(config, { logger: createWorkerLogger(config, workerSink) }),
    ],
  })
  class WorkerRootModule {}
  useNextApplicationLoggerOutsideRequests();
  worker = await createWorkerApp(WorkerRootModule);
  await worker.init();
  paymentsQueue = worker.get<Queue>(getQueueToken(OTA_QUEUE.payments), { strict: false });
  bookingsQueue = worker.get<Queue>(getQueueToken(OTA_QUEUE.bookings), { strict: false });
  const maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
  // No scheduler iteration may fire while the file runs, and no e-mail or document is rendered: the file reads the
  // outbox rows and the queues.
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
  await worker.get(NotificationsProcessor, { strict: false }).worker.pause();
  await worker.get(DocumentsProcessor, { strict: false }).worker.pause();
  // The first calls of a process open the pools' connections and warm the token, validation, Amadeus and Stripe code;
  // done once here, so that no test pays for it.
  const warmCustomer = await newCustomer();
  const warm = await seedBooking("cancel.warm", { customerId: warmCustomer.id });
  await seedPayment(warm.id, "captured");
  const credential: Credential = { kind: "key", customerToken: warmCustomer.token };
  const warmQuote = await quote(warm.id, credential);
  expect(answer(warmQuote)).toEqual([200, undefined]);
  const warmCancel = await cancel(warm.id, credential, '"1"', cancellation(warmQuote.body.estimatedRefund));
  expect(answer(warmCancel)).toEqual([200, undefined]);
  // Its refund job reaches the fake Stripe API: done before any scenario counts Stripe requests.
  await finished(paymentsQueue, `refund-submit-${(await refundsOf(warm.id))[0]?.id ?? ""}`);
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  vi.restoreAllMocks();
  await worker?.close();
  await api?.close();
  await stub?.stop();
  await stripe?.close();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

describe("release: a customer cancels an unticketed booking paid by Stripe, twice with one key", () => {
  let booking: SeededBooking;
  let customerId: string;
  let payment: { readonly id: string; readonly intentId: string | null };
  let quoted: Response;
  let first: Response;
  let second: Response;
  let replayed: Response;
  let deletes: ReturnType<typeof amadeusCalls>;
  let refunds: Awaited<ReturnType<typeof refundsOf>>;
  let submitted: Job;
  let retried: Job;
  let events: Response;
  let credential: Credential;

  beforeAll(async () => {
    const customer = await newCustomer();
    customerId = customer.id;
    credential = { kind: "key", customerToken: customer.token };
    booking = await seedBooking("cancel.release", { customerId: customer.id });
    payment = await seedPayment(booking.id, "captured");
    quoted = await quote(booking.id, credential);
    stub.clearRequests();
    stripe.reset();

    // The same request twice at once with one key (a double click, the SDK's retry), then once more later. The payments
    // consumer waits meanwhile, so the answers show the refund as the cancellation asked for it (`pending`), never as
    // its job may already have moved it (`processing`): no reliance on the timing between the request and the job.
    const paymentsWorker = worker.get(PaymentsProcessor, { strict: false }).worker;
    await paymentsWorker.pause();
    const key = idempotencyKey();
    const body = cancellation(quoted.body.estimatedRefund);
    try {
      [first, second] = await Promise.all([
        cancel(booking.id, credential, '"1"', body, key),
        cancel(booking.id, credential, '"1"', body, key),
      ]);
      replayed = await cancel(booking.id, credential, '"1"', body, key);
    } finally {
      paymentsWorker.resume();
    }
    deletes = amadeusCalls("cancelFlightOrder");

    refunds = await refundsOf(booking.id);
    const refundId = refunds[0]?.id ?? "";
    // The refund job the cancellation queued, then the same job again under another id (a retried job).
    submitted = await finished(paymentsQueue, `refund-submit-${refundId}`);
    const again = paymentJob(PAYMENT_JOB.refundSubmit, alphaId, refundId);
    await paymentsQueue.add(again.name, again.data, { jobId: `retried-refund-submit-${refundId}` });
    retried = await finished(paymentsQueue, `retried-refund-submit-${refundId}`);
    events = await request(api.server)
      .get(`/v1/bookings/${booking.id}/events`)
      .set(credentialHeaders(credential));
  }, SCENARIO_TIMEOUT_MS);

  it("quotes a release with the refund less the kept fees and the cancellation fee", () => {
    expect(answer(quoted)).toEqual([200, undefined]);
    expectResponseToMatch("quoteBookingCancellation", quoted);
    expect(quoted.headers["cache-control"]).toBe("no-store");
    expect(quoted.body).toMatchObject({
      bookingId: booking.id,
      cancellable: true,
      mode: "release",
      notAllowedReason: null,
      currency: "EUR",
      amountPaid: { amount: TOTAL, currency: "EUR" },
      estimatedRefund: { amount: REFUND, currency: "EUR" },
      penalty: { amount: "0.00", currency: "EUR" },
      otaFee: { amount: "25.00", currency: "EUR" },
      voidDeadlineAt: null,
      source: "policy",
      lines: [
        {
          travelerId: "1",
          travelerName: "TESTAA SAMPLE",
          ticketNumber: null,
          paid: { amount: TOTAL, currency: "EUR" },
          refund: { amount: REFUND, currency: "EUR" },
        },
      ],
    });
    const expiresIn = Date.parse(quoted.body.expiresAt as string) - Date.now();
    expect(expiresIn).toBeGreaterThan(0);
    expect(expiresIn).toBeLessThanOrEqual(10 * MINUTE);
  });

  it("[OBE-049 AC1] answers 200 with the cancelled booking to every call of the key", () => {
    for (const res of [first, second, replayed]) {
      expect(answer(res)).toEqual([200, undefined]);
      expectResponseToMatch("cancelBooking", res);
      expect(res.headers["etag"]).toBe('"3"');
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    expect(second.body).toEqual(first.body);
    expect(replayed.body).toEqual(first.body);
    expect(first.body.cancellation).toMatchObject({
      bookingId: booking.id,
      status: "cancelled",
      cancelledBy: "customer",
      reasonCode: "change_of_plans",
      comment: "Trip postponed",
      ticketsVoided: false,
      estimatedRefund: { amount: REFUND, currency: "EUR" },
      refund: { amount: { amount: REFUND, currency: "EUR" }, status: "pending", reason: "customer_request" },
      refundStatus: "pending",
    });
    expect(first.body.booking).toMatchObject({ id: booking.id, status: "cancelled", version: 3 });
    expect(first.body.booking.cancellation).toEqual(first.body.cancellation);
  });

  it("[OBE-049 AC1] cancels the order at Amadeus with one DELETE and records the cancellation", async () => {
    expect(deletes.map((call) => call.status)).toEqual([204]);
    expect(await stubOrderStatus(booking.orderId)).toBe(404);
    expect(await bookingRow(booking.id)).toMatchObject({
      status: "cancelled",
      cancelled_by: "customer",
      cancel_reason: "change_of_plans",
      ticketing_status: "not_applicable",
      version: 3,
    });
    expect(await segmentStatuses(booking.id)).toEqual(["CANCELLED"]);
    expect(await ticketStatuses(booking.id)).toEqual([]);
  });

  it("[OBE-049 AC1] asks for one refund and sends it to Stripe once, whatever the jobs", async () => {
    expect(refunds).toEqual([
      expect.objectContaining({
        payment_id: payment.id,
        amount: REFUND,
        reason: "customer_request",
        requested_by_type: "customer",
        requested_by_id: customerId,
      }),
    ]);
    const refundId = refunds[0]?.id;
    const calls = stripe.requests.filter((entry) => entry.method === "POST" && entry.path === "/v1/refunds");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers["idempotency-key"]).toBe(`refund:${refundId}`);
    expect(calls[0]?.form).toMatchObject({ payment_intent: payment.intentId, amount: "10047" });
    expect(submitted.returnvalue).toMatchObject({ outcome: "applied" });
    expect(retried.returnvalue).toMatchObject({ outcome: "unchanged" });
    expect((await refundsOf(booking.id)).map((row) => row.status)).toEqual(["processing"]);
  });

  it("[OBE-049 AC1] writes booking.cancelled and refund.requested, which bookings.listEvents shows", async () => {
    const added = (await eventsOf(booking.id)).filter((event) => event.visible_to_customer);
    expect(added.map((event) => [event.type, event.actor_type])).toEqual([
      ["booking.cancelled", "customer"],
      ["refund.requested", "customer"],
    ]);
    expect(added[0]?.data).toMatchObject({
      cancelledBy: "customer",
      mode: "release",
      refundStatus: "pending",
    });
    expect(answer(events)).toEqual([200, undefined]);
    expectResponseToMatch("listBookingEvents", events);
    expect((events.body as { data: Array<{ type: string }> }).data.map((event) => event.type)).toEqual([
      "refund.requested",
      "booking.cancelled",
    ]);
  });

  it("queues the traveller's booking.cancelled e-mail with the refund, once", async () => {
    const rows = await notificationsOf(booking.id);
    expect(rows.map((row) => [row.template_key, row.recipient, row.dedupe_key])).toEqual([
      ["booking.cancelled", booking.email, `booking.cancelled:${booking.id}`],
    ]);
    expect(rows[0]?.payload).toMatchObject({ refund: { amount: REFUND, currency: "EUR" } });
  });

  it("never writes the traveller's address into a log line", () => {
    expect(api.sink.text()).not.toContain(booking.email);
    expect(workerSink.text()).not.toContain(booking.email);
  });
});

describe("void: a customer on the storefront cancels a booking ticketed today, paid by an authorisation", () => {
  let booking: SeededBooking;
  let payment: { readonly id: string; readonly intentId: string | null };
  let credential: Credential;
  let quoted: Response;
  let first: Response;
  let again: Response;
  let got: Response;
  let deletes: ReturnType<typeof amadeusCalls>;
  let calls: typeof stripe.requests;

  beforeAll(async () => {
    const customer = await newCustomer();
    credential = { kind: "edge", customerToken: customer.token };
    booking = await seedBooking("cancel.void", { customerId: customer.id, ticketsIssuedAt: [new Date()] });
    payment = await seedPayment(booking.id, "authorized");
    quoted = await quote(booking.id, credential);
    stub.clearRequests();
    stripe.reset();

    const key = idempotencyKey();
    first = await cancel(booking.id, credential, '"1"', cancellation(quoted.body.estimatedRefund), key);
    again = await cancel(booking.id, credential, '"1"', cancellation(quoted.body.estimatedRefund), key);
    deletes = amadeusCalls("cancelFlightOrder");
    calls = [...stripe.requests];
    got = await request(api.server).get(`/v1/bookings/${booking.id}`).set(credentialHeaders(credential));
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W28-CANCEL AC1] quotes a void that keeps the fees and gives the rest of the authorisation back", () => {
    expect(answer(quoted)).toEqual([200, undefined]);
    expectResponseToMatch("quoteBookingCancellation", quoted);
    expect(quoted.body).toMatchObject({
      mode: "void",
      cancellable: true,
      amountPaid: { amount: TOTAL, currency: "EUR" },
      estimatedRefund: { amount: REFUND, currency: "EUR" },
      otaFee: { amount: "25.00", currency: "EUR" },
      voidDeadlineAt: localDayOf(new Date(), TIME_ZONE).endsAt.toISOString(),
    });
    expect((quoted.body.lines as JsonObject[])[0]?.["ticketNumber"]).toMatch(/^075-\d{10}$/);
  });

  it("[FIX-W28-CANCEL AC1] cancels the order once, voids its tickets, captures the kept amount once and releases the rest", async () => {
    expect(answer(first)).toEqual([200, undefined]);
    expectResponseToMatch("cancelBooking", first);
    expect(first.body.cancellation).toMatchObject({
      status: "cancelled",
      ticketsVoided: true,
      estimatedRefund: { amount: REFUND, currency: "EUR" },
      // The release is the refund, done once Stripe captured the kept amount.
      refund: {
        paymentId: payment.id,
        amount: { amount: REFUND, currency: "EUR" },
        penalty: { amount: "25.00", currency: "EUR" },
        status: "succeeded",
      },
      refundStatus: "succeeded",
    });
    expect(answer(again)).toEqual([200, undefined]);
    expect(again.body).toEqual(first.body);
    expect(deletes.map((call) => call.status)).toEqual([204]);
    expect(await ticketStatuses(booking.id)).toEqual(["VOID"]);
    // One capture of the 25.00 kept, with the cancellation's key; no void, no refund at Stripe.
    expect(calls.map((entry) => [entry.method, entry.path, entry.headers["idempotency-key"]])).toEqual([
      [
        "POST",
        `/v1/payment_intents/${payment.intentId}/capture`,
        `pi:capture:${payment.id}:cancellation:25.00`,
      ],
    ]);
    expect(calls[0]?.form).toEqual({ amount_to_capture: "2500" });
    expect(stripe.intents.get(payment.intentId ?? "")).toMatchObject({
      status: "succeeded",
      amount_received: 2500,
    });
    expect(await paymentRow(payment.id)).toMatchObject({ status: "captured", amount_captured: "25.00" });
    expect(await paymentEventTypes(payment.id)).toEqual(["payment.captured", "payment.released"]);
    expect(await refundsOf(booking.id)).toEqual([
      expect.objectContaining({
        payment_id: payment.id,
        status: "succeeded",
        amount: REFUND,
        penalty_amount: "25.00",
        provider_refund_id: null,
        requested_by_type: "customer",
      }),
    ]);
    expect(await bookingRow(booking.id)).toMatchObject({ status: "cancelled", amount_paid: "25.00" });
    const visible = (await eventsOf(booking.id)).filter((event) => event.visible_to_customer);
    expect(visible.map((event) => event.type)).toEqual([
      "booking.cancelled",
      "payment.captured",
      "refund.succeeded",
    ]);
    expect(visible[0]?.data).toMatchObject({
      capturePaymentId: payment.id,
      captureAmount: "25.00",
      releaseAmount: REFUND,
    });
  });

  it("[FIX-W28-CANCEL AC3] shows the same cancellation in bookings.get, with the customer's reason and comment", () => {
    expect(answer(got)).toEqual([200, undefined]);
    expect(got.body.cancellation).toEqual(first.body.cancellation);
    expect(got.body.cancellation).toMatchObject({ reasonCode: "change_of_plans", comment: "Trip postponed" });
    expect(got.body.allowedActions).toMatchObject({ canCancel: false, reasons: { canCancel: "cancelled" } });
  });
});

describe("an authorisation of which the cancellation keeps nothing", () => {
  let booking: SeededBooking;
  let payment: { readonly id: string; readonly intentId: string | null };
  let quoted: Response;
  let res: Response;
  let calls: typeof stripe.requests;

  beforeAll(async () => {
    const customer = await newCustomer();
    const credential: Credential = { kind: "key", customerToken: customer.token };
    // Business class (no cancellation fee rule) and no OTA fee: nothing is kept.
    booking = await seedBooking("cancel.void_all", {
      customerId: customer.id,
      cabin: "BUSINESS",
      fees: "0.00",
    });
    payment = await seedPayment(booking.id, "authorized");
    quoted = await quote(booking.id, credential);
    stripe.reset();
    res = await cancel(booking.id, credential, '"1"', cancellation(quoted.body.estimatedRefund));
    calls = [...stripe.requests];
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W28-CANCEL AC1] quotes the whole authorisation back and voids it once, nothing captured", async () => {
    expect(quoted.body).toMatchObject({
      mode: "release",
      estimatedRefund: { amount: TOTAL, currency: "EUR" },
      otaFee: { amount: "0.00", currency: "EUR" },
    });
    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("cancelBooking", res);
    expect(res.body.cancellation).toMatchObject({
      status: "cancelled",
      refund: null,
      refundStatus: "authorization_voided",
    });
    expect(calls.map((entry) => [entry.method, entry.path, entry.headers["idempotency-key"]])).toEqual([
      ["POST", `/v1/payment_intents/${payment.intentId}/cancel`, `pi:cancel:${payment.id}`],
    ]);
    expect(await paymentRow(payment.id)).toMatchObject({ status: "canceled", amount_captured: "0.00" });
    expect(await paymentEventTypes(payment.id)).toEqual(["payment.voided"]);
    expect(await refundsOf(booking.id)).toEqual([]);
  });
});

describe("a capture of the kept amount that fails", () => {
  let dropped: { booking: SeededBooking; payment: { id: string; intentId: string | null }; res: Response };
  let refused: { booking: SeededBooking; payment: { id: string; intentId: string | null }; res: Response };
  let droppedRetry: FinishedPaymentJob;
  let refusedRetry: FinishedPaymentJob;
  let droppedAfter: Response;
  let refusedAfter: Response;
  let credentials: Credential[];

  /** A customer's cancellation of a booking paid by an authorisation, whose capture meets `failure`. */
  async function cancelWith(prefix: string, failure: () => void) {
    const customer = await newCustomer();
    const credential: Credential = { kind: "key", customerToken: customer.token };
    credentials.push(credential);
    const booking = await seedBooking(prefix, { customerId: customer.id });
    const payment = await seedPayment(booking.id, "authorized");
    const quoted = await quote(booking.id, credential);
    stripe.reset();
    failure();
    // No reset after it: the 500 kept for the capture's key must stay for the queue's retry.
    const res = await cancel(booking.id, credential, '"1"', cancellation(quoted.body.estimatedRefund));
    return { booking, payment, res };
  }

  /**
   * The delayed `payment.capture_retry` of a cancellation's kept amount, run now (it is queued 10 minutes later): since
   * FIX-W29-OTA the record step's safety net, whose id the failure's retry shares.
   */
  async function runRetry(paymentId: string): Promise<FinishedPaymentJob> {
    return await runDelayedPaymentJob(`capture-retry-cancellation-${paymentId}`);
  }

  beforeAll(async () => {
    credentials = [];
    // Stripe unreachable for the capture and the SDK's one retry: nothing is kept for the key.
    dropped = await cancelWith("cancel.capture_dropped", () => stripe.fail(2, "drop"));
    // A 500 Stripe keeps for the key (the SDK's retry replays it): the queue's retry can only replay it too.
    refused = await cancelWith("cancel.capture_500", () => stripe.fail(1, "server_error"));
    droppedRetry = await runRetry(dropped.payment.id);
    refusedRetry = await runRetry(refused.payment.id);
    const read = (bookingId: string, credential: Credential) =>
      request(api.server).get(`/v1/bookings/${bookingId}`).set(credentialHeaders(credential));
    droppedAfter = await read(dropped.booking.id, credentials[0] as Credential);
    refusedAfter = await read(refused.booking.id, credentials[1] as Credential);
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W28-CANCEL AC1] never undoes the cancellation: 200 pending, the failure recorded and the staff alerted", async () => {
    for (const { booking, payment, res } of [dropped, refused]) {
      expect(answer(res)).toEqual([200, undefined]);
      expectResponseToMatch("cancelBooking", res);
      expect(res.body.cancellation).toMatchObject({
        status: "cancelled",
        refund: null,
        refundStatus: "pending",
      });
      expect(await bookingRow(booking.id)).toMatchObject({ status: "cancelled" });
      const failedEvent = (await eventsOf(booking.id)).find(
        (event) => event.type === "payment.capture_failed",
      );
      expect(failedEvent).toMatchObject({ visible_to_customer: false });
      expect(failedEvent?.data).toMatchObject({
        paymentId: payment.id,
        amount: "25.00",
        purpose: "cancellation",
      });
      expect(
        (await notificationsOf(booking.id))
          .filter((row) => row.template_key === "staff.manual_review")
          .map((row) => row.dedupe_key),
      ).toContain(`staff.manual_review:${booking.id}:cancellation_capture_failed`);
    }
  });

  it("[FIX-W28-CANCEL AC1] lets the payments queue capture it with the same key, then shows the release", async () => {
    expect(droppedRetry.returnvalue).toMatchObject({ outcome: "applied" });
    expect(await paymentRow(dropped.payment.id)).toMatchObject({
      status: "captured",
      amount_captured: "25.00",
    });
    expect(await refundsOf(dropped.booking.id)).toEqual([
      expect.objectContaining({ status: "succeeded", amount: REFUND, provider_refund_id: null }),
    ]);
    expect(answer(droppedAfter)).toEqual([200, undefined]);
    expect(droppedAfter.body.cancellation).toMatchObject({
      refund: { amount: { amount: REFUND, currency: "EUR" }, status: "succeeded" },
      refundStatus: "succeeded",
    });
  });

  it("[FIX-W28-CANCEL AC1] hands a capture the retry cannot make to the staff: manual_review, the cancellation stands", async () => {
    expect(refusedRetry.returnvalue).toMatchObject({ outcome: "failed" });
    expect(await paymentRow(refused.payment.id)).toMatchObject({ status: "authorized" });
    expect(await refundsOf(refused.booking.id)).toEqual([]);
    expect(
      (await notificationsOf(refused.booking.id))
        .filter((row) => row.template_key === "staff.manual_review")
        .map((row) => row.dedupe_key),
    ).toContain(`staff.payment:${refused.payment.id}:capture_retry_failed`);
    expect(refusedAfter.body.cancellation).toMatchObject({
      status: "cancelled",
      refund: null,
      refundStatus: "manual_review",
    });
    expect(await bookingRow(refused.booking.id)).toMatchObject({ status: "cancelled" });
  });
});

describe("the safety net of a cancellation's capture or void after the commit (FIX-W29-OTA)", () => {
  /** What one cancellation of a booking paid by an authorisation left, and its safety net's run. */
  interface Netted {
    readonly booking: SeededBooking;
    /** The customer who cancelled (`cus_…`). */
    readonly customerId: string;
    readonly payment: { readonly id: string; readonly intentId: string | null };
    readonly res: Response;
    /** The Stripe calls of the request (none after a crash before the call). */
    readonly requestCalls: number;
    readonly paymentBefore: Awaited<ReturnType<typeof paymentRow>>;
    readonly net: FinishedPaymentJob;
    /** True when no finished job holds the net's id once it completed (`removeOnComplete`). */
    readonly netRemoved: boolean;
    /** A second run of the same retry after the net (as a capture failure would queue it): changes nothing. */
    readonly again: FinishedPaymentJob | undefined;
    /** Every Stripe call about the PaymentIntent, the request's and the jobs'. */
    readonly calls: Array<readonly [string, string, string | undefined]>;
    readonly after: Response;
  }

  /**
   * A customer's cancellation of a booking paid by an authorisation, the API stopping between the record step's commit
   * and the Stripe call when `crash` (simulated: the money step's part after the commit never runs), then the record
   * step's safety net run by the worker (`net`, its job id).
   */
  async function cancelAndNet(
    prefix: string,
    options: {
      readonly crash: boolean;
      readonly keepNothing?: boolean;
      readonly net: (paymentId: string) => string;
    },
  ): Promise<Netted> {
    const customer = await newCustomer();
    const credential: Credential = { kind: "key", customerToken: customer.token };
    const booking = await seedBooking(
      prefix,
      options.keepNothing === true
        ? { customerId: customer.id, cabin: "BUSINESS", fees: "0.00" }
        : { customerId: customer.id },
    );
    const payment = await seedPayment(booking.id, "authorized");
    const quoted = await quote(booking.id, credential);
    stripe.reset();
    const recorder = api.app.get(CancellationRecorder, { strict: false });
    const crash = options.crash
      ? vi
          .spyOn(recorder, "settleAuthorisation")
          .mockRejectedValue(new Error("the process stopped before the Stripe call (simulated)"))
      : undefined;
    let res: Response;
    try {
      res = await cancel(booking.id, credential, '"1"', cancellation(quoted.body.estimatedRefund));
    } finally {
      crash?.mockRestore();
    }
    const requestCalls = stripe.requests.length;
    const paymentBefore = await paymentRow(payment.id);
    const net = await runDelayedPaymentJob(options.net(payment.id));
    const netRemoved = (await paymentsQueue.getJob(options.net(payment.id))) === undefined;
    let again: FinishedPaymentJob | undefined;
    if (options.keepNothing !== true) {
      // The retry a capture failure queues, under the net's id: accepted again now that the net completed.
      const retry = cancellationCaptureRetryJob(alphaId, payment.id);
      await paymentsQueue.add(retry.name, retry.data, { ...retry.opts, delay: 10 * MINUTE });
      again = await runDelayedPaymentJob(retry.opts.jobId);
    }
    const calls = stripe.requests.map(
      (entry) => [entry.method, entry.path, entry.headers["idempotency-key"]] as const,
    );
    const after = await request(api.server)
      .get(`/v1/bookings/${booking.id}`)
      .set(credentialHeaders(credential));
    return {
      booking,
      customerId: customer.id,
      payment,
      res,
      requestCalls,
      paymentBefore,
      net,
      netRemoved,
      again,
      calls,
      after,
    };
  }

  const keptNet = (paymentId: string): string => `capture-retry-cancellation-${paymentId}`;
  const voidNet = (paymentId: string): string => `payment-void-cancellation-${paymentId}`;
  let normal: Netted;
  let crashed: Netted;
  let normalVoid: Netted;
  let crashedVoid: Netted;

  beforeAll(async () => {
    normal = await cancelAndNet("cancel.net_normal", { crash: false, net: keptNet });
    crashed = await cancelAndNet("cancel.net_crash", { crash: true, net: keptNet });
    normalVoid = await cancelAndNet("cancel.net_void", { crash: false, keepNothing: true, net: voidNet });
    crashedVoid = await cancelAndNet("cancel.net_void_crash", {
      crash: true,
      keepNothing: true,
      net: voidNet,
    });
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W29-OTA AC3] the normal path captures the kept amount once: its safety net finds it captured and changes nothing", async () => {
    expect(answer(normal.res)).toEqual([200, undefined]);
    expect(normal.paymentBefore).toMatchObject({ status: "captured", amount_captured: "25.00" });
    expect(normal.net).toEqual({
      state: "completed",
      returnvalue: expect.objectContaining({ outcome: "unchanged" }),
    });
    expect(normal.again?.returnvalue).toMatchObject({ outcome: "unchanged" });
    expect(normal.calls).toEqual([
      [
        "POST",
        `/v1/payment_intents/${normal.payment.intentId}/capture`,
        `pi:capture:${normal.payment.id}:cancellation:25.00`,
      ],
    ]);
    expect(await paymentEventTypes(normal.payment.id)).toEqual(["payment.captured", "payment.released"]);
    expect(await refundsOf(normal.booking.id)).toHaveLength(1);
    // The net is removed once it completed: no finished job holds its id, so a later retry of it is never ignored.
    expect(normal.netRemoved).toBe(true);
  });

  it("[FIX-W29-OTA AC3] a crash between the commit and the Stripe call is captured by the safety net exactly once", async () => {
    // The request recorded the cancellation and stopped before Stripe: nothing captured, the authorisation held.
    expect(crashed.res.status).toBe(500);
    expect(crashed.requestCalls).toBe(0);
    expect(crashed.paymentBefore).toMatchObject({ status: "authorized", amount_captured: "0.00" });
    expect(await bookingRow(crashed.booking.id)).toMatchObject({ status: "cancelled", amount_paid: "25.00" });
    expect(crashed.net).toEqual({
      state: "completed",
      returnvalue: expect.objectContaining({ outcome: "applied" }),
    });
    expect(crashed.again?.returnvalue).toMatchObject({ outcome: "unchanged" });
    // One capture, with the request's own key, by the net; the second run finds it captured.
    expect(crashed.calls).toEqual([
      [
        "POST",
        `/v1/payment_intents/${crashed.payment.intentId}/capture`,
        `pi:capture:${crashed.payment.id}:cancellation:25.00`,
      ],
    ]);
    expect(await paymentRow(crashed.payment.id)).toMatchObject({
      status: "captured",
      amount_captured: "25.00",
    });
    expect(await refundsOf(crashed.booking.id)).toEqual([
      expect.objectContaining({ status: "succeeded", amount: REFUND, penalty_amount: "25.00" }),
    ]);
    expect(crashed.after.body.cancellation).toMatchObject({
      status: "cancelled",
      refund: { amount: { amount: REFUND, currency: "EUR" }, status: "succeeded" },
      refundStatus: "succeeded",
    });
  });

  it("[FIX-W30-OTA AC7] records the release of the safety net's capture as asked for by the customer who cancelled", async () => {
    // The capture retry recorded the release (not the request, which stopped before Stripe): it names the requester
    // the cancellation's own record names, as the request's release does on the normal path.
    for (const netted of [crashed, normal]) {
      expect(await refundsOf(netted.booking.id)).toEqual([
        expect.objectContaining({
          status: "succeeded",
          requested_by_type: "customer",
          requested_by_id: netted.customerId,
        }),
      ]);
    }
  });

  it("[FIX-W29-OTA AC3] voids once on the normal path and after a crash, through the void's own safety net", async () => {
    expect(answer(normalVoid.res)).toEqual([200, undefined]);
    expect(normalVoid.net.returnvalue).toMatchObject({ outcome: "unchanged" });
    expect(normalVoid.calls).toEqual([
      [
        "POST",
        `/v1/payment_intents/${normalVoid.payment.intentId}/cancel`,
        `pi:cancel:${normalVoid.payment.id}`,
      ],
    ]);
    expect(crashedVoid.res.status).toBe(500);
    expect(crashedVoid.requestCalls).toBe(0);
    expect(crashedVoid.paymentBefore).toMatchObject({ status: "authorized" });
    expect(crashedVoid.net.returnvalue).toMatchObject({ outcome: "applied" });
    expect(crashedVoid.calls).toEqual([
      [
        "POST",
        `/v1/payment_intents/${crashedVoid.payment.intentId}/cancel`,
        `pi:cancel:${crashedVoid.payment.id}`,
      ],
    ]);
    for (const { payment } of [normalVoid, crashedVoid]) {
      expect(await paymentRow(payment.id)).toMatchObject({ status: "canceled", amount_captured: "0.00" });
      expect(await paymentEventTypes(payment.id)).toEqual(["payment.voided"]);
    }
    expect(crashedVoid.after.body.cancellation).toMatchObject({ refundStatus: "authorization_voided" });
  });
});

describe("the card fee of a cancelled booking's payment", () => {
  /** A card fee of 3.00: the Amadeus fee 1.00 and an OTA fee rule's 2.00, refundable or not. */
  const lines = (refundable: boolean): JsonObject[] => [
    { source: "amadeus", ruleId: null, amount: "1.00", refundable: false },
    { source: "fee_rule", ruleId: "fee_01JA0000000000000000000001", amount: "2.00", refundable },
  ];
  let refundable: { booking: SeededBooking; quoted: Response; res: Response };
  let kept: { booking: SeededBooking; payment: { id: string; intentId: string | null }; quoted: Response };
  let legacy: Response;
  let keptCalls: typeof stripe.requests;

  beforeAll(async () => {
    const customer = await newCustomer();
    const credential: Credential = { kind: "key", customerToken: customer.token };
    const refundableBooking = await seedBooking("cancel.fee_refundable", { customerId: customer.id });
    await seedPayment(refundableBooking.id, "captured", { fee: "3.00", lines: lines(true) });
    const refundableQuote = await quote(refundableBooking.id, credential);
    refundable = {
      booking: refundableBooking,
      quoted: refundableQuote,
      res: await cancel(
        refundableBooking.id,
        credential,
        '"1"',
        cancellation(refundableQuote.body.estimatedRefund),
      ),
    };
    // Its refund reaches the fake Stripe API before the next scenario counts Stripe's requests.
    await finished(paymentsQueue, `refund-submit-${(await refundsOf(refundableBooking.id))[0]?.id ?? ""}`);
    const keptBooking = await seedBooking("cancel.fee_kept", { customerId: customer.id });
    const keptPayment = await seedPayment(keptBooking.id, "authorized", { fee: "3.00", lines: lines(false) });
    const keptQuote = await quote(keptBooking.id, credential);
    stripe.reset();
    await cancel(keptBooking.id, credential, '"1"', cancellation(keptQuote.body.estimatedRefund));
    keptCalls = [...stripe.requests];
    kept = { booking: keptBooking, payment: keptPayment, quoted: keptQuote };
    // A payment of before tenant migration 0004: no line, so nothing of its card fee is refundable.
    const legacyBooking = await seedBooking("cancel.fee_legacy", { customerId: customer.id });
    await seedPayment(legacyBooking.id, "captured", { fee: "3.00" });
    legacy = await quote(legacyBooking.id, credential);
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W28-CANCEL AC2] refunds a refundable card fee line and keeps the Amadeus fee", async () => {
    // 125.47 − 25.00 (fees and cancellation fee) − 1.00 (the Amadeus card fee).
    expect(refundable.quoted.body).toMatchObject({
      estimatedRefund: { amount: "99.47", currency: "EUR" },
      otaFee: { amount: "26.00", currency: "EUR" },
    });
    expect(answer(refundable.res)).toEqual([200, undefined]);
    expect((await refundsOf(refundable.booking.id)).map((row) => row.amount)).toEqual(["99.47"]);
  });

  it("[FIX-W28-CANCEL AC2] keeps a card fee whose rule is not refundable, in the estimate and in the capture", async () => {
    expect(kept.quoted.body).toMatchObject({
      estimatedRefund: { amount: "97.47", currency: "EUR" },
      otaFee: { amount: "28.00", currency: "EUR" },
    });
    expect(keptCalls.map((entry) => entry.headers["idempotency-key"])).toEqual([
      `pi:capture:${kept.payment.id}:cancellation:28.00`,
    ]);
    expect(await refundsOf(kept.booking.id)).toEqual([
      expect.objectContaining({ status: "succeeded", amount: "97.47", penalty_amount: "28.00" }),
    ]);
  });

  it("[FIX-W28-CANCEL AC2] keeps the whole card fee of a payment without lines", () => {
    expect(legacy.body).toMatchObject({
      estimatedRefund: { amount: "97.47", currency: "EUR" },
      otaFee: { amount: "28.00", currency: "EUR" },
    });
  });
});

describe("an airline-card booking ticketed today", () => {
  let booking: SeededBooking;
  let payment: { readonly id: string; readonly intentId: string | null };
  let quoted: Response;
  let res: Response;

  beforeAll(async () => {
    const customer = await newCustomer();
    const credential: Credential = { kind: "key", customerToken: customer.token };
    booking = await seedBooking("cancel.airline", {
      customerId: customer.id,
      ticketsIssuedAt: [new Date()],
      net: true,
    });
    payment = await seedPayment(booking.id, "airline");
    quoted = await quote(booking.id, credential);
    stripe.reset();
    res = await cancel(booking.id, credential, '"1"', cancellation(quoted.body.estimatedRefund));
  }, SCENARIO_TIMEOUT_MS);

  it("quotes the airline's whole charge back, without OTA fees", () => {
    expect(quoted.body).toMatchObject({
      mode: "void",
      amountPaid: { amount: "98.47", currency: "EUR" },
      estimatedRefund: { amount: "98.47", currency: "EUR" },
      otaFee: { amount: "0.00", currency: "EUR" },
    });
  });

  it("[OBE-049 AC3] cancels it with no Stripe call and writes the airline.void_expected payment event", async () => {
    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("cancelBooking", res);
    expect(res.body.cancellation).toMatchObject({
      status: "cancelled",
      refund: null,
      refundStatus: "not_applicable",
    });
    expect(stripe.requests).toEqual([]);
    expect(await paymentEventTypes(payment.id)).toEqual(["airline.void_expected"]);
    expect(await refundsOf(booking.id)).toEqual([]);
    expect(await paymentRow(payment.id)).toMatchObject({ status: "captured" });
    expect(await bookingRow(booking.id)).toMatchObject({ status: "cancelled" });
  });
});

describe("request_only: a guest asks to cancel a booking ticketed yesterday", () => {
  let booking: SeededBooking;
  let credential: Credential;
  let quoted: Response;
  let res: Response;
  let got: Response;
  let second: Response;
  let requoted: Response;

  beforeAll(async () => {
    booking = await seedBooking("cancel.request", {
      ticketsIssuedAt: [new Date(localDayOf(new Date(), TIME_ZONE).startsAt.getTime() - HOUR)],
    });
    await seedPayment(booking.id, "captured");
    credential = { kind: "key", bookingToken: await guestToken(booking.id) };
    quoted = await quote(booking.id, credential);
    stub.clearRequests();
    stripe.reset();
    res = await cancel(booking.id, credential, '"1"', cancellation(quoted.body.estimatedRefund));
    got = await request(api.server).get(`/v1/bookings/${booking.id}`).set(credentialHeaders(credential));
    second = await cancel(
      booking.id,
      credential,
      String(res.headers["etag"]),
      cancellation(quoted.body.estimatedRefund),
    );
    requoted = await quote(booking.id, credential);
  }, SCENARIO_TIMEOUT_MS);

  it("quotes a request for the staff, with nothing estimated and the warning", () => {
    expect(answer(quoted)).toEqual([200, undefined]);
    expectResponseToMatch("quoteBookingCancellation", quoted);
    expect(quoted.body).toMatchObject({
      mode: "request_only",
      cancellable: true,
      estimatedRefund: { amount: "0.00", currency: "EUR" },
      warnings: [REQUEST_ONLY_WARNING],
    });
  });

  it("answers 202 with a pending cancellation, no Amadeus call and the booking as it was", async () => {
    expect(answer(res)).toEqual([202, undefined]);
    expectResponseToMatch("cancelBooking", res);
    expect(res.headers["etag"]).toBe('"2"');
    expect(res.body.cancellation).toMatchObject({
      status: "pending",
      cancelledAt: null,
      cancelledBy: "customer",
      refund: null,
      refundStatus: "manual_review",
    });
    expect(res.body.booking).toMatchObject({ status: "ticketed", version: 2 });
    expect(amadeusCalls("cancelFlightOrder")).toEqual([]);
    expect(stripe.requests).toEqual([]);
    expect(await bookingRow(booking.id)).toMatchObject({ status: "ticketed", cancelled_at: null });
    expect(await refundsOf(booking.id)).toEqual([]);
  });

  it("writes booking.cancellation_requested, the traveller's e-mail and a staff alert", async () => {
    const added = (await eventsOf(booking.id)).filter((event) =>
      event.type.startsWith("booking.cancellation"),
    );
    expect(added.map((event) => [event.type, event.actor_type, event.visible_to_customer])).toEqual([
      ["booking.cancellation_requested", "api_key", true],
    ]);
    expect(added[0]?.data).toMatchObject({ mode: "request_only", cause: "request_only" });
    expect(
      (await notificationsOf(booking.id)).map((row) => [row.template_key, row.recipient, row.recipient_type]),
    ).toEqual([
      ["booking.cancellation_requested", booking.email, "guest"],
      ["staff.manual_review", OPS_EMAIL, "staff"],
    ]);
  });

  it("[FIX-W28-CANCEL AC3] shows the request in bookings.get as the pending cancellation, and offers no second one", () => {
    expect(answer(got)).toEqual([200, undefined]);
    expect(got.body.cancellation).toEqual(res.body.cancellation);
    expect(got.body.cancellation).toMatchObject({
      status: "pending",
      reasonCode: "change_of_plans",
      comment: "Trip postponed",
      estimatedRefund: { amount: "0.00", currency: "EUR" },
      refundStatus: "manual_review",
    });
    expect(got.body.allowedActions).toMatchObject({ canCancel: false, reasons: { canCancel: "pending" } });
  });

  it("refuses a second cancellation while the request waits for the staff", () => {
    expect(answer(second)).toEqual([409, "BOOKING_NOT_MODIFIABLE"]);
    expectResponseToMatch("cancelBooking", second);
    expect(second.body.error.details).toEqual({ reason: "pending", action: "canCancel" });
    expect(requoted.body).toMatchObject({
      mode: "not_allowed",
      notAllowedReason: "pending",
      cancellable: false,
    });
  });
});

describe("the airline refuses the DELETE", () => {
  let booking: SeededBooking;
  let res: Response;

  beforeAll(async () => {
    const customer = await newCustomer();
    const credential: Credential = { kind: "key", customerToken: customer.token };
    booking = await seedBooking("cancel.refused", { customerId: customer.id });
    await seedPayment(booking.id, "captured");
    const quoted = await quote(booking.id, credential);
    stub.clearRequests();
    const spy = nextDeleteWith("cancel-refused");
    res = await cancel(booking.id, credential, '"1"', cancellation(quoted.body.estimatedRefund));
    spy.mockRestore();
  }, SCENARIO_TIMEOUT_MS);

  it("hands the cancellation to the staff: 202 pending, the order and the money as they were", async () => {
    expect(answer(res)).toEqual([202, undefined]);
    expectResponseToMatch("cancelBooking", res);
    expect(res.body.cancellation).toMatchObject({ status: "pending", refundStatus: "manual_review" });
    expect(amadeusCalls("cancelFlightOrder").map((call) => call.status)).toEqual([400]);
    expect(await stubOrderStatus(booking.orderId)).toBe(200);
    expect(await bookingRow(booking.id)).toMatchObject({ status: "confirmed", version: 3 });
    expect(await refundsOf(booking.id)).toEqual([]);
    const requested = (await eventsOf(booking.id)).find(
      (event) => event.type === "booking.cancellation_requested",
    );
    expect(requested?.data).toMatchObject({
      mode: "release",
      cause: "refused",
      supplierCode: "SUPPLIER_REJECTED",
    });
  });
});

describe("a DELETE without an answer that the airline applied", () => {
  let booking: SeededBooking;
  let payment: { readonly id: string; readonly intentId: string | null };
  let timedOut: Response;
  let replayedBefore: Response;
  let check: Job;
  let replayedAfter: Response;
  let flagged: Awaited<ReturnType<typeof eventsOf>>;
  let statusBeforeCheck: string;
  let gotWhileFlagged: Response;

  beforeAll(async () => {
    const customer = await newCustomer();
    const credential: Credential = { kind: "key", customerToken: customer.token };
    booking = await seedBooking("cancel.timeout", { customerId: customer.id });
    payment = await seedPayment(booking.id, "captured");
    const quoted = await quote(booking.id, credential);
    stub.clearRequests();
    stripe.reset();
    const key = idempotencyKey();
    const body = cancellation(quoted.body.estimatedRefund);
    const spy = nextDeleteWith("timeout");
    timedOut = await cancel(booking.id, credential, '"1"', body, key);
    spy.mockRestore();
    flagged = await eventsOf(booking.id);
    statusBeforeCheck = (await bookingRow(booking.id)).status;
    gotWhileFlagged = await request(api.server)
      .get(`/v1/bookings/${booking.id}`)
      .set(credentialHeaders(credential));
    replayedBefore = await cancel(booking.id, credential, '"1"', body, key);

    // A concurrent insert holds the booking's FOR KEY SHARE (a document row): the check still claims it (OADR-0014
    // point 6, FOR NO KEY UPDATE SKIP LOCKED).
    const hold = holdKeyShare(tenantDb, ALPHA, { bookingId: booking.id, by: "booking_documents" });
    await hold.held;
    try {
      check = await runCheck(booking.id);
    } finally {
      hold.release();
      await hold.done;
    }
    // The refund job the check queued has sent the refund (`processing`) before the key is replayed.
    await finished(paymentsQueue, `refund-submit-${(await refundsOf(booking.id))[0]?.id ?? ""}`);
    replayedAfter = await cancel(booking.id, credential, '"1"', body, key);
  }, SCENARIO_TIMEOUT_MS);

  it("answers 504 SUPPLIER_TIMEOUT and flags the booking, which stays as it was", () => {
    expect(answer(timedOut)).toEqual([504, "SUPPLIER_TIMEOUT"]);
    expectResponseToMatch("cancelBooking", timedOut);
    expect(timedOut.body.error.details).toEqual({ bookingId: booking.id, replayed: false });
    expect(statusBeforeCheck).toBe("confirmed");
    const flag = flagged.find((event) => event.type === "booking.cancellation_timeout");
    expect(flag).toMatchObject({ actor_type: "customer", visible_to_customer: false });
    expect(flag?.data).toMatchObject({
      mode: "release",
      reasonCode: "change_of_plans",
      reason: "SUPPLIER_TIMEOUT",
    });
  });

  it("[FIX-W28-CANCEL AC3] shows the undecided cancellation in bookings.get as pending, and offers no second one", () => {
    expect(answer(gotWhileFlagged)).toEqual([200, undefined]);
    expect(gotWhileFlagged.body).toMatchObject({ status: "confirmed" });
    expect(gotWhileFlagged.body.cancellation).toMatchObject({
      status: "pending",
      cancelledAt: null,
      cancelledBy: "customer",
      reasonCode: "change_of_plans",
      comment: "Trip postponed",
      estimatedRefund: { amount: REFUND, currency: "EUR" },
      refund: null,
      refundStatus: "pending",
    });
    expect(gotWhileFlagged.body.allowedActions).toMatchObject({
      canCancel: false,
      reasons: { canCancel: "pending" },
    });
  });

  it("replays the 504 to the same key without calling Amadeus until the worker decides", () => {
    expect(answer(replayedBefore)).toEqual([504, "SUPPLIER_TIMEOUT"]);
    expectResponseToMatch("cancelBooking", replayedBefore);
    expect(replayedBefore.body.error.details).toEqual({ bookingId: booking.id, replayed: true });
  });

  it("[OBE-049 AC1] lets the worker find the order cancelled and run the money step once", async () => {
    expect(await check.getState()).toBe("completed");
    expect(check.returnvalue).toEqual({ tenantId: alphaId, bookingId: booking.id, outcome: "cancelled" });
    expect(amadeusCalls("cancelFlightOrder").map((call) => call.status)).toEqual([504]);
    expect(amadeusCalls("getFlightOrder").map((call) => call.status)).toEqual([404]);
    expect(await bookingRow(booking.id)).toMatchObject({ status: "cancelled", cancelled_by: "customer" });
    expect(await refundsOf(booking.id)).toEqual([
      expect.objectContaining({ payment_id: payment.id, amount: REFUND, requested_by_type: "customer" }),
    ]);
    const calls = stripe.requests.filter((entry) => entry.method === "POST" && entry.path === "/v1/refunds");
    expect(calls).toHaveLength(1);
    const cancelled = (await eventsOf(booking.id)).find((event) => event.type === "booking.cancelled");
    expect(cancelled?.data).toMatchObject({ cause: "checked_after_timeout", cancelledBy: "customer" });
  });

  it("then answers the same key with the final 200, its refund as it stands", () => {
    expect(answer(replayedAfter)).toEqual([200, undefined]);
    expectResponseToMatch("cancelBooking", replayedAfter);
    expect(replayedAfter.body.cancellation).toMatchObject({
      status: "cancelled",
      reasonCode: "change_of_plans",
      refund: { status: "processing", amount: { amount: REFUND, currency: "EUR" } },
      refundStatus: "processing",
      estimatedRefund: { amount: REFUND, currency: "EUR" },
    });
    expect(replayedAfter.body.booking).toMatchObject({ id: booking.id, status: "cancelled" });
  });
});

describe("a DELETE without an answer that never reached the order, then a second cancellation", () => {
  let booking: SeededBooking;
  let credential: Credential;
  let check: Job;
  let replayed: Response;
  let requoted: Response;
  let secondTimeout: Response;
  let secondCheck: Job;
  let afterCheck: {
    readonly orderStatus: number;
    readonly booking: Awaited<ReturnType<typeof bookingRow>>;
    readonly refunds: Awaited<ReturnType<typeof refundsOf>>;
  };

  beforeAll(async () => {
    const customer = await newCustomer();
    credential = { kind: "key", customerToken: customer.token };
    booking = await seedBooking("cancel.lost", { customerId: customer.id });
    await seedPayment(booking.id, "captured");
    const quoted = await quote(booking.id, credential);
    const key = idempotencyKey();
    const body = cancellation(quoted.body.estimatedRefund);
    const spy = nextDeleteWith("timeout-lost");
    const timedOut = await cancel(booking.id, credential, '"1"', body, key);
    spy.mockRestore();
    expect(answer(timedOut)).toEqual([504, "SUPPLIER_TIMEOUT"]);
    check = await runCheck(booking.id);
    afterCheck = {
      orderStatus: await stubOrderStatus(booking.orderId),
      booking: await bookingRow(booking.id),
      refunds: await refundsOf(booking.id),
    };
    replayed = await cancel(booking.id, credential, '"1"', body, key);
    requoted = await quote(booking.id, credential);

    // The customer tries again with a new key and the current ETag; this DELETE also gets no answer, but Amadeus
    // applied it: the second flag has a check chain of its own.
    const again = nextDeleteWith("timeout");
    secondTimeout = await cancel(
      booking.id,
      credential,
      `"${(await bookingRow(booking.id)).version}"`,
      cancellation(requoted.body.estimatedRefund),
    );
    again.mockRestore();
    secondCheck = await runCheck(booking.id, new Set([check.id ?? ""]));
    await finished(paymentsQueue, `refund-submit-${(await refundsOf(booking.id))[0]?.id ?? ""}`);
  }, SCENARIO_TIMEOUT_MS);

  it("lets the worker find the order active: nothing is cancelled or refunded", () => {
    expect(check.returnvalue).toEqual({ tenantId: alphaId, bookingId: booking.id, outcome: "not_applied" });
    expect(afterCheck.orderStatus).toBe(200);
    expect(afterCheck.booking).toMatchObject({ status: "confirmed" });
    expect(afterCheck.refunds).toEqual([]);
  });

  it("answers the same key with the final 502 SUPPLIER_ERROR, and the booking can be cancelled again", () => {
    expect(answer(replayed)).toEqual([502, "SUPPLIER_ERROR"]);
    expectResponseToMatch("cancelBooking", replayed);
    expect(replayed.body.error.details).toEqual({ bookingId: booking.id, cancellation: "not_applied" });
    expect(requoted.body).toMatchObject({ mode: "release", cancellable: true });
  });

  it("checks a second DELETE without an answer in a chain of its own, and cancels the booking once", async () => {
    expect(answer(secondTimeout)).toEqual([504, "SUPPLIER_TIMEOUT"]);
    expect(secondCheck.id).not.toBe(check.id);
    expect(secondCheck.returnvalue).toEqual({
      tenantId: alphaId,
      bookingId: booking.id,
      outcome: "cancelled",
    });
    expect(await stubOrderStatus(booking.orderId)).toBe(404);
    expect(await bookingRow(booking.id)).toMatchObject({ status: "cancelled", cancelled_by: "customer" });
    expect((await refundsOf(booking.id)).map((row) => row.amount)).toEqual([REFUND]);
  });
});

describe("a DELETE without an answer of a booking paid by an authorisation", () => {
  let booking: SeededBooking;
  let payment: { readonly id: string; readonly intentId: string | null };
  let check: Job;
  let replayed: Response;

  beforeAll(async () => {
    const customer = await newCustomer();
    const credential: Credential = { kind: "key", customerToken: customer.token };
    booking = await seedBooking("cancel.timeout_void", { customerId: customer.id });
    payment = await seedPayment(booking.id, "authorized");
    const quoted = await quote(booking.id, credential);
    stripe.reset();
    const key = idempotencyKey();
    const body = cancellation(quoted.body.estimatedRefund);
    const spy = nextDeleteWith("timeout");
    const timedOut = await cancel(booking.id, credential, '"1"', body, key);
    spy.mockRestore();
    expect(answer(timedOut)).toEqual([504, "SUPPLIER_TIMEOUT"]);
    check = await runCheck(booking.id);
    replayed = await cancel(booking.id, credential, '"1"', body, key);
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W28-CANCEL AC1] lets the worker cancel the booking, capture the kept amount once and release the rest", async () => {
    expect(check.returnvalue).toEqual({ tenantId: alphaId, bookingId: booking.id, outcome: "cancelled" });
    expect(await bookingRow(booking.id)).toMatchObject({ status: "cancelled", cancelled_by: "customer" });
    expect(
      stripeRequestsAbout(payment.intentId ?? "").map((entry) => [
        entry.method,
        entry.path,
        entry.headers["idempotency-key"],
      ]),
    ).toEqual([
      [
        "POST",
        `/v1/payment_intents/${payment.intentId}/capture`,
        `pi:capture:${payment.id}:cancellation:25.00`,
      ],
    ]);
    expect(await paymentRow(payment.id)).toMatchObject({ status: "captured", amount_captured: "25.00" });
    expect(await paymentEventTypes(payment.id)).toEqual(["payment.captured", "payment.released"]);
    expect(await refundsOf(booking.id)).toEqual([
      expect.objectContaining({ status: "succeeded", amount: REFUND, provider_refund_id: null }),
    ]);
  });

  it("answers the same key with the final 200 that shows the release as the refund", () => {
    expect(answer(replayed)).toEqual([200, undefined]);
    expectResponseToMatch("cancelBooking", replayed);
    expect(replayed.body.cancellation).toMatchObject({
      status: "cancelled",
      refund: { amount: { amount: REFUND, currency: "EUR" }, status: "succeeded" },
      refundStatus: "succeeded",
    });
  });
});

describe("a record step that fails after Amadeus cancelled the order", () => {
  let booking: SeededBooking;
  let failed: Response;
  let flagged: Awaited<ReturnType<typeof eventsOf>>;
  let statusBeforeCheck: string;
  let check: Job;
  let replayed: Response;

  beforeAll(async () => {
    const customer = await newCustomer();
    const credential: Credential = { kind: "key", customerToken: customer.token };
    booking = await seedBooking("cancel.record_failed", { customerId: customer.id });
    await seedPayment(booking.id, "captured");
    const quoted = await quote(booking.id, credential);
    stub.clearRequests();
    stripe.reset();
    const key = idempotencyKey();
    const body = cancellation(quoted.body.estimatedRefund);
    // The API's record step (T2) fails once after the DELETE's 204, as a lost database connection would.
    const recorder = api.app.get(CancellationRecorder, { strict: false });
    const spy = vi
      .spyOn(recorder, "recordCancelled")
      .mockRejectedValueOnce(new Error("the database connection was lost"));
    failed = await cancel(booking.id, credential, '"1"', body, key);
    spy.mockRestore();
    flagged = await eventsOf(booking.id);
    statusBeforeCheck = (await bookingRow(booking.id)).status;
    check = await runCheck(booking.id);
    await finished(paymentsQueue, `refund-submit-${(await refundsOf(booking.id))[0]?.id ?? ""}`);
    replayed = await cancel(booking.id, credential, '"1"', body, key);
  }, SCENARIO_TIMEOUT_MS);

  it("answers 504 and flags the booking as after a DELETE without an answer, never a 500", () => {
    expect(answer(failed)).toEqual([504, "SUPPLIER_TIMEOUT"]);
    expectResponseToMatch("cancelBooking", failed);
    expect(failed.body.error.details).toEqual({ bookingId: booking.id, replayed: false });
    expect(amadeusCalls("cancelFlightOrder").map((call) => call.status)).toEqual([204]);
    expect(statusBeforeCheck).toBe("confirmed");
    expect(flagged.find((event) => event.type === "booking.cancellation_timeout")?.data).toMatchObject({
      mode: "release",
      reason: "record_failed",
    });
  });

  it("[OBE-049 AC1] lets the worker record the cancellation and its refund once, then answers the key", async () => {
    expect(check.returnvalue).toEqual({ tenantId: alphaId, bookingId: booking.id, outcome: "cancelled" });
    expect(await bookingRow(booking.id)).toMatchObject({ status: "cancelled", cancelled_by: "customer" });
    expect((await refundsOf(booking.id)).map((row) => row.amount)).toEqual([REFUND]);
    expect(stripe.requests.filter((entry) => entry.path === "/v1/refunds")).toHaveLength(1);
    expect(answer(replayed)).toEqual([200, undefined]);
    expect(replayed.body.cancellation).toMatchObject({ status: "cancelled", refundStatus: "processing" });
  });
});

describe("an order that cannot be read for 15 minutes after a DELETE without an answer", () => {
  let booking: SeededBooking;
  let credential: Credential;
  let firstCheck: Job;
  let lastCheck: Job;
  let replayed: Response;
  let requoted: Response;

  beforeAll(async () => {
    const customer = await newCustomer();
    credential = { kind: "key", customerToken: customer.token };
    booking = await seedBooking("cancel.unreadable", { customerId: customer.id });
    await seedPayment(booking.id, "captured");
    const quoted = await quote(booking.id, credential);
    const key = idempotencyKey();
    const body = cancellation(quoted.body.estimatedRefund);
    const spy = nextDeleteWith("timeout-lost");
    const timedOut = await cancel(booking.id, credential, '"1"', body, key);
    spy.mockRestore();
    expect(answer(timedOut)).toEqual([504, "SUPPLIER_TIMEOUT"]);
    // The worker's reads of the order fail (Amadeus unavailable).
    const client = worker.get(AmadeusClient, { strict: false });
    const reads = vi.spyOn(client, "getFlightOrder").mockRejectedValue(new AppError("SUPPLIER_UNAVAILABLE"));
    try {
      firstCheck = await runCheck(booking.id);
      // The next check comes a minute later; the flag's 15 minutes have passed by then.
      const next = await waitFor("the second check", async () =>
        (await bookingsQueue.getJobs(["delayed", "waiting"])).find(
          (candidate) =>
            candidate.id?.startsWith(`${CANCELLATION_CHECK_JOB}:${booking.id}:`) === true &&
            candidate.id.endsWith("-2"),
        ),
      );
      await inTenant((trx) =>
        trx
          .updateTable("booking_events")
          .set({
            data: sql`jsonb_set(data, '{until}', to_jsonb(${new Date(Date.now() - MINUTE).toISOString()}::text))`,
          })
          .where("booking_id", "=", booking.id)
          .where("type", "=", "booking.cancellation_timeout")
          .execute(),
      );
      await next.promote();
      lastCheck = await finished(bookingsQueue, next.id ?? "");
    } finally {
      reads.mockRestore();
    }
    replayed = await cancel(booking.id, credential, '"1"', body, key);
    requoted = await quote(booking.id, credential);
  }, SCENARIO_TIMEOUT_MS);

  it("reads the order again a minute later while the 15 minutes run", () => {
    expect(firstCheck.returnvalue).toEqual({
      tenantId: alphaId,
      bookingId: booking.id,
      outcome: "rescheduled",
    });
  });

  it("then hands the booking to the staff, and the key keeps replaying the 504", async () => {
    expect(lastCheck.returnvalue).toEqual({
      tenantId: alphaId,
      bookingId: booking.id,
      outcome: "manual_review",
    });
    const review = (await eventsOf(booking.id)).find(
      (event) => event.type === "booking.cancellation_manual_review",
    );
    expect(review).toMatchObject({ actor_type: "system", visible_to_customer: false });
    expect(review?.data).toMatchObject({ code: "SUPPLIER_UNAVAILABLE" });
    expect(
      (await notificationsOf(booking.id)).map((row) => [row.template_key, row.recipient, row.dedupe_key]),
    ).toEqual([["staff.manual_review", OPS_EMAIL, `staff.manual_review:${booking.id}:cancellation_unknown`]]);
    expect(await bookingRow(booking.id)).toMatchObject({ status: "confirmed" });
    expect(await refundsOf(booking.id)).toEqual([]);
    expect(answer(replayed)).toEqual([504, "SUPPLIER_TIMEOUT"]);
    expect(replayed.body.error.details).toEqual({ bookingId: booking.id, replayed: true });
    expect(requoted.body).toMatchObject({ mode: "not_allowed", notAllowedReason: "pending" });
  });
});

describe("two cancellations at once with different keys (two tabs)", () => {
  let booking: SeededBooking;
  let answers: Response[];

  beforeAll(async () => {
    const customer = await newCustomer();
    const credential: Credential = { kind: "key", customerToken: customer.token };
    booking = await seedBooking("cancel.two_tabs", { customerId: customer.id });
    await seedPayment(booking.id, "captured");
    const quoted = await quote(booking.id, credential);
    stub.clearRequests();
    const body = cancellation(quoted.body.estimatedRefund);
    answers = await Promise.all([
      cancel(booking.id, credential, '"1"', body),
      cancel(booking.id, credential, '"1"', body),
    ]);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-049 AC1] sends one DELETE and asks for one refund; the other request is refused", async () => {
    expect(answers.filter((res) => res.status === 200)).toHaveLength(1);
    // The other one met the claim (503, nothing kept for its key), its moved version (412), the claim's fresh marker
    // (409 `pending`: its checks without a lock read the version before the first claim committed and the marker after
    // it, FIX-W32-OTA, lead decision (1b) of 2026-10-28) or the cancelled booking, whichever it reached first.
    const refused = answers.filter((res) => res.status !== 200);
    const others = refused.map(answer);
    expect(others).toHaveLength(1);
    expect([
      [503, "SERVICE_UNAVAILABLE"],
      [412, "PRECONDITION_FAILED"],
      [409, "BOOKING_NOT_MODIFIABLE"],
      [409, "BOOKING_ALREADY_CANCELLED"],
    ]).toContainEqual(others[0]);
    if (others[0]?.[1] === "BOOKING_NOT_MODIFIABLE") {
      expect(refused[0]?.body.error.details).toMatchObject({ reason: "pending" });
    }
    for (const res of answers) {
      expectResponseToMatch("cancelBooking", res);
    }
    expect(amadeusCalls("cancelFlightOrder").map((call) => call.status)).toEqual([204]);
    expect((await refundsOf(booking.id)).map((row) => row.amount)).toEqual([REFUND]);
  });
});

describe("the claim of a cancellation", () => {
  let booking: SeededBooking;
  let payment: { readonly id: string; readonly intentId: string | null };
  let busy: Response;
  let deletesWhileBusy: number;
  let retried: Response;
  let lockOrder: Awaited<ReturnType<typeof probeLockOrder>["result"]> | undefined;
  let documentJobs: Array<{ readonly kind: unknown; readonly bookingVersion: unknown }>;

  beforeAll(async () => {
    const customer = await newCustomer();
    const credential: Credential = { kind: "key", customerToken: customer.token };
    booking = await seedBooking("cancel.claim", { customerId: customer.id });
    payment = await seedPayment(booking.id, "captured");
    const quoted = await quote(booking.id, credential);
    stub.clearRequests();
    const key = idempotencyKey();
    const body = cancellation(quoted.body.estimatedRefund);

    // Another claim (a ticketing job, a sync) holds the booking FOR NO KEY UPDATE: the cancellation skips it.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markHeld: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    const holding = inTenant(async (trx) => {
      await trx.selectFrom("bookings").select("id").where("id", "=", booking.id).forNoKeyUpdate().execute();
      markHeld();
      await released;
    });
    await held;
    try {
      busy = await cancel(booking.id, credential, '"1"', body, key);
      deletesWhileBusy = amadeusCalls("cancelFlightOrder").length;
    } finally {
      release();
      await holding;
    }

    // The same key again while a document row is being inserted (the booking's FOR KEY SHARE): the claim takes the
    // booking all the same, and the DELETE goes out. The insert ends then; the probe holds the booking while the record
    // step starts, which must lock the booking before the payment (OADR-0003 point 11).
    const hold = holdKeyShare(tenantDb, ALPHA, { bookingId: booking.id, by: "booking_documents" });
    await hold.held;
    const client = api.app.get(AmadeusClient, { strict: false });
    const cancelOrder = client.cancelFlightOrder.bind(client);
    let probe: ReturnType<typeof probeLockOrder> | undefined;
    const spy = vi
      .spyOn(client, "cancelFlightOrder")
      .mockImplementationOnce(async (context, req, options) => {
        const reply = await cancelOrder(context, req, options);
        hold.release();
        await hold.done;
        probe = probeLockOrder(tenantDb, ALPHA, { bookingId: booking.id, paymentId: payment.id });
        await probe.locked;
        return reply;
      });
    try {
      retried = await cancel(booking.id, credential, '"1"', body, key);
    } finally {
      spy.mockRestore();
      hold.release();
      await hold.done;
    }
    lockOrder = await probe?.result;
    const documents = worker.get<Queue>(getQueueToken(OTA_QUEUE.documents), { strict: false });
    documentJobs = (await documents.getJobs(["waiting", "paused", "prioritized", "delayed", "active"]))
      .map((job) => job.data as JsonObject)
      .filter((data) => data["bookingId"] === booking.id)
      .map((data) => ({ kind: data["kind"], bookingVersion: data["bookingVersion"] }));
  }, SCENARIO_TIMEOUT_MS);

  it("skips a booking another claim holds (FOR NO KEY UPDATE SKIP LOCKED): 503, nothing sent or kept", () => {
    expect(answer(busy)).toEqual([503, "SERVICE_UNAVAILABLE"]);
    expectResponseToMatch("cancelBooking", busy);
    expect(deletesWhileBusy).toBe(0);
  });

  it("[FIX-W28-CANCEL AC5] answers that 503 with Retry-After (lead decision (8) of 2026-10-23)", () => {
    expect(busy.headers["retry-after"]).toBe("1");
  });

  it("[OBE-049 AC1] claims it under a concurrent key share, locks the booking before the payment, cancels once", async () => {
    expect(answer(retried)).toEqual([200, undefined]);
    expectResponseToMatch("cancelBooking", retried);
    expect(lockOrder).toEqual({ waiterSeen: true, paymentFree: true });
    expect(amadeusCalls("cancelFlightOrder").map((call) => call.status)).toEqual([204]);
    expect(await bookingRow(booking.id)).toMatchObject({ status: "cancelled", version: 3 });
    expect((await refundsOf(booking.id)).map((row) => row.amount)).toEqual([REFUND]);
  });

  it("asks for the cancelled itinerary through booking.cancelled (OBE-053's documents)", () => {
    expect(documentJobs).toContainEqual({ kind: "itinerary", bookingVersion: 3 });
  });
});

describe("an order Amadeus no longer has when the DELETE arrives", () => {
  let booking: SeededBooking;
  let res: Response;

  beforeAll(async () => {
    const customer = await newCustomer();
    const credential: Credential = { kind: "key", customerToken: customer.token };
    booking = await seedBooking("cancel.order_gone", { customerId: customer.id });
    await seedPayment(booking.id, "captured");
    const quoted = await quote(booking.id, credential);
    expect(answer(quoted)).toEqual([200, undefined]);
    // The order is cancelled outside Velexis after the quote (the terminal, the airline): DELETE answers 404.
    const gone = await fetch(`${stub.url}${orderPath(booking.orderId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await stubToken()}` },
    });
    expect(gone.status).toBe(204);
    stub.clearRequests();
    stripe.reset();
    res = await cancel(booking.id, credential, '"1"', cancellation(quoted.body.estimatedRefund));
  }, SCENARIO_TIMEOUT_MS);

  it("hands the cancellation to the staff: 202 pending, nothing refunded", async () => {
    expect(answer(res)).toEqual([202, undefined]);
    expectResponseToMatch("cancelBooking", res);
    expect(res.body.cancellation).toMatchObject({ status: "pending", refundStatus: "manual_review" });
    expect(amadeusCalls("cancelFlightOrder").map((call) => call.status)).toEqual([404]);
    expect(await bookingRow(booking.id)).toMatchObject({ status: "confirmed" });
    expect(await refundsOf(booking.id)).toEqual([]);
    expect(stripe.requests).toEqual([]);
    const requested = (await eventsOf(booking.id)).find(
      (event) => event.type === "booking.cancellation_requested",
    );
    expect(requested?.data).toMatchObject({ mode: "release", cause: "order_not_found" });
    expect((await notificationsOf(booking.id)).map((row) => row.template_key)).toEqual([
      "booking.cancellation_requested",
      "staff.manual_review",
    ]);
  });
});

describe("refusals that change nothing", () => {
  let credential: Credential;

  beforeAll(async () => {
    const customer = await newCustomer();
    credential = { kind: "key", customerToken: customer.token };
  }, SCENARIO_TIMEOUT_MS);

  it("answers 409 REFUND_AMOUNT_CHANGED for another or a missing expected refund, before any DELETE", async () => {
    const booking = await seedBooking("cancel.amount", { customerId: (await newCustomer()).id });
    const guest = { kind: "key", bookingToken: await guestToken(booking.id) } as const;
    await seedPayment(booking.id, "captured");
    stub.clearRequests();
    const other = await cancel(booking.id, guest, '"1"', cancellation({ amount: "125.47", currency: "EUR" }));
    const missing = await cancel(booking.id, guest, '"1"', { reasonCode: "illness" });
    expect(answer(other)).toEqual([409, "REFUND_AMOUNT_CHANGED"]);
    expectResponseToMatch("cancelBooking", other);
    expect(other.body.error.details).toEqual({
      expectedRefund: { amount: "125.47", currency: "EUR" },
      newRefund: { amount: REFUND, currency: "EUR" },
    });
    expect(answer(missing)).toEqual([409, "REFUND_AMOUNT_CHANGED"]);
    expect(missing.body.error.details).toEqual({
      expectedRefund: null,
      newRefund: { amount: REFUND, currency: "EUR" },
    });
    expect(amadeusCalls("cancelFlightOrder")).toEqual([]);
    expect(await bookingRow(booking.id)).toMatchObject({ status: "confirmed", version: 1 });
  });

  it("answers 412 for a stale If-Match and 409 for a booking that is already cancelled", async () => {
    const booking = await seedBooking("cancel.stale", { customerId: null });
    const guest = { kind: "key", bookingToken: await guestToken(booking.id) } as const;
    const stale = await cancel(booking.id, guest, '"7"', cancellation({ amount: "0.00", currency: "EUR" }));
    expect(answer(stale)).toEqual([412, "PRECONDITION_FAILED"]);
    expectResponseToMatch("cancelBooking", stale);
    expect(stale.body.error.details).toEqual({ currentVersion: 1 });

    const gone = await seedBooking("cancel.gone", { status: "cancelled" });
    const goneGuest = { kind: "key", bookingToken: await guestToken(gone.id) } as const;
    const again = await cancel(gone.id, goneGuest, '"1"', cancellation({ amount: "0.00", currency: "EUR" }));
    expect(answer(again)).toEqual([409, "BOOKING_ALREADY_CANCELLED"]);
    expectResponseToMatch("cancelBooking", again);
    const goneQuote = await quote(gone.id, goneGuest);
    expect(goneQuote.body).toMatchObject({
      mode: "not_allowed",
      notAllowedReason: "cancelled",
      cancellable: false,
    });
  });

  it("does not allow cancelling online within 3 hours of departure", async () => {
    const booking = await seedBooking("cancel.soon", { departInMs: 2 * HOUR });
    const guest = { kind: "key", bookingToken: await guestToken(booking.id) } as const;
    const quoted = await quote(booking.id, guest);
    expect(quoted.body).toMatchObject({ mode: "not_allowed", notAllowedReason: "too_close_to_departure" });
    const res = await cancel(booking.id, guest, '"1"', cancellation(quoted.body.estimatedRefund));
    expect(answer(res)).toEqual([409, "BOOKING_NOT_MODIFIABLE"]);
    expectResponseToMatch("cancelBooking", res);
    expect(res.body.error.details).toEqual({ reason: "too_close_to_departure", action: "canCancel" });
  });

  it("answers 403 FEATURE_DISABLED while the OTA has self-service cancellation off", async () => {
    const booking = await seedBooking("cancel.disabled", { customerId: null });
    const guest = { kind: "key", bookingToken: await guestToken(booking.id) } as const;
    await setSelfService(false);
    try {
      const quoted = await quote(booking.id, guest);
      expect(quoted.body).toMatchObject({ mode: "not_allowed", notAllowedReason: "disabled_by_ota" });
      const res = await cancel(booking.id, guest, '"1"', cancellation(quoted.body.estimatedRefund));
      expect(answer(res)).toEqual([403, "FEATURE_DISABLED"]);
      expectResponseToMatch("cancelBooking", res);
      expect(res.body.error.details).toEqual({ feature: "selfServiceCancellation" });
    } finally {
      await setSelfService(true);
    }
  });

  it("answers 409 VERSION_CONFLICT when Amadeus answers 2552, and records no cancellation", async () => {
    const booking = await seedBooking("cancel.conflict", { customerId: null });
    const guest = { kind: "key", bookingToken: await guestToken(booking.id) } as const;
    const quoted = await quote(booking.id, guest);
    const spy = nextDeleteWith("version-conflict");
    const res = await cancel(booking.id, guest, '"1"', cancellation(quoted.body.estimatedRefund));
    spy.mockRestore();
    expect(answer(res)).toEqual([409, "VERSION_CONFLICT"]);
    expectResponseToMatch("cancelBooking", res);
    expect(await stubOrderStatus(booking.orderId)).toBe(200);
    // The claim moved the version (a second request with the same ETag is stale); nothing else changed.
    expect(await bookingRow(booking.id)).toMatchObject({ status: "confirmed", version: 2 });
    expect((await eventsOf(booking.id)).map((event) => event.type)).not.toContain("booking.cancelled");
  });

  it("refuses the quote and the cancellation of a booking the caller may not open (404)", async () => {
    const booking = await seedBooking("cancel.foreign", { customerId: (await newCustomer()).id });
    const res = await cancel(
      booking.id,
      credential,
      '"1"',
      cancellation({ amount: "0.00", currency: "EUR" }),
    );
    const quoted = await quote(booking.id, credential);
    expect(answer(res)).toEqual([404, "NOT_FOUND"]);
    expect(answer(quoted)).toEqual([404, "NOT_FOUND"]);
  });
});

describe("one departure rule for canCancel and the cancellation (FIX-W30-OTA)", () => {
  it("[FIX-W30-OTA AC3] shows canCancel false for a booking whose first flight departed but did not land, and refuses its cancellation with flown", async () => {
    // Its flight left an hour ago and lands in an hour.
    const booking = await seedBooking("cancel.departed", { customerId: null, departInMs: -HOUR });
    const guest = { kind: "key", bookingToken: await guestToken(booking.id) } as const;
    await seedPayment(booking.id, "captured");

    const read = await request(api.server).get(`/v1/bookings/${booking.id}`).set(credentialHeaders(guest));
    expect(answer(read)).toEqual([200, undefined]);
    expectResponseToMatch("getBooking", read);
    expect(read.body.allowedActions).toMatchObject({
      canCancel: false,
      // Not landed: the contacts can still change.
      canModifyContacts: true,
      reasons: { canCancel: "flown" },
    });
    const quoted = await quote(booking.id, guest);
    expect(quoted.body).toMatchObject({ mode: "not_allowed", notAllowedReason: "flown", cancellable: false });
    stub.clearRequests();
    const res = await cancel(
      booking.id,
      guest,
      String(read.headers["etag"]),
      cancellation(quoted.body.estimatedRefund),
    );

    expect(answer(res)).toEqual([409, "BOOKING_NOT_MODIFIABLE"]);
    expectResponseToMatch("cancelBooking", res);
    expect(res.body.error.details).toEqual({ reason: "flown", action: "canCancel" });
    expect(amadeusCalls("cancelFlightOrder")).toEqual([]);
    expect(await bookingRow(booking.id)).toMatchObject({ status: "confirmed" });
  });
});

describe("a customer's cancellation while the tickets are being issued (FIX-W30-OTA)", () => {
  /** What the scenario of the ticketing job held at Flight Order Issue left. */
  let held: {
    readonly booking: SeededBooking;
    readonly payment: { readonly id: string; readonly intentId: string | null };
    /** The booking row when the cancellation was refused: the issuance's claim. */
    readonly claimed: Awaited<ReturnType<typeof bookingRow>>;
    readonly refused: Response;
    readonly deletes: number;
    readonly stripeCalls: number;
    readonly issuance: Job;
  };

  // The ticketing job claims the booking (`in_progress`, committed) and waits at Flight Order Issue, held by a barrier
  // on the worker's Amadeus client, while the customer reads the booking, quotes and cancels it; then the barrier
  // opens and the issuance ends. No timing between the two is assumed.
  beforeAll(async () => {
    const customer = await newCustomer();
    const credential: Credential = { kind: "key", customerToken: customer.token };
    const booking = await seedBooking("cancel.issuing", { customerId: customer.id });
    const payment = await seedPayment(booking.id, "captured");
    // Due for an issuance now (a retry whose time has come).
    await inTenant((trx) =>
      trx
        .updateTable("bookings")
        .set({ ticketing_next_attempt_at: new Date(Date.now() - MINUTE) })
        .where("id", "=", booking.id)
        .execute(),
    );
    const client = worker.get(AmadeusClient, { strict: false });
    const issue = client.issueFlightOrder.bind(client);
    let reached = false;
    let pass = (): void => undefined;
    const passed = new Promise<void>((resolvePass) => {
      pass = resolvePass;
    });
    const spy = vi.spyOn(client, "issueFlightOrder").mockImplementationOnce(async (context, req, options) => {
      reached = true;
      await passed;
      return await issue(context, req, options);
    });
    const ticketingQueue = worker.get<Queue>(getQueueToken(OTA_QUEUE.ticketing), { strict: false });
    const job = ticketingJob(alphaId, booking.id, minuteBucket(new Date()));
    try {
      await ticketingQueue.add(job.name, job.data, job.opts);
      await waitFor("the issuance to reach Flight Order Issue", () =>
        Promise.resolve(reached ? true : undefined),
      );
      const quoted = await quote(booking.id, credential);
      // The claim moved the booking's version: the customer cancels with the ETag they read now.
      const read = await request(api.server)
        .get(`/v1/bookings/${booking.id}`)
        .set(credentialHeaders(credential));
      stub.clearRequests();
      stripe.reset();
      const refused = await cancel(
        booking.id,
        credential,
        String(read.headers["etag"]),
        cancellation(quoted.body.estimatedRefund),
      );
      const deletes = amadeusCalls("cancelFlightOrder").length;
      const stripeCalls = stripeRequestsAbout(payment.intentId ?? "").length;
      const claimed = await bookingRow(booking.id);
      pass();
      const issuance = await finished(ticketingQueue, job.opts.jobId);
      held = { booking, payment, claimed, refused, deletes, stripeCalls, issuance };
    } finally {
      pass();
      spy.mockRestore();
    }
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W30-OTA AC2] answers the staff cancellation's 409 ticketing_in_progress: no DELETE racing the issuance, no money moved", async () => {
    expect(held.claimed).toMatchObject({ status: "confirmed", ticketing_status: "in_progress" });
    expect(answer(held.refused)).toEqual([409, "BOOKING_NOT_MODIFIABLE"]);
    expectResponseToMatch("cancelBooking", held.refused);
    expect(held.refused.body.error.details).toEqual({ reason: "ticketing_in_progress" });
    expect(held.deletes).toBe(0);
    expect(held.stripeCalls).toBe(0);
    expect(await refundsOf(held.booking.id)).toEqual([]);
    expect((await eventsOf(held.booking.id)).map((event) => event.type)).not.toContain("booking.cancelled");
  });

  it("[FIX-W30-OTA AC2] lets the issuance end undisturbed: the booking is ticketed and still cancellable once it ended", async () => {
    expect(held.issuance.returnvalue).toMatchObject({ outcome: "ticketed" });
    expect(await bookingRow(held.booking.id)).toMatchObject({
      status: "ticketed",
      ticketing_status: "issued",
    });
    expect(await stubOrderStatus(held.booking.orderId)).toBe(200);
    const read = await request(api.server)
      .get(`/v1/bookings/${held.booking.id}`)
      .set(credentialHeaders({ kind: "key", bookingToken: await guestToken(held.booking.id) }));
    expect(read.body.allowedActions).toMatchObject({ canCancel: true });
  });

  it("[FIX-W30-OTA AC2] refuses while a staff issuance's claim is fresh, and cancels once the claim is abandoned (5 minutes)", async () => {
    const booking = await seedBooking("cancel.claimed", { customerId: null });
    const guest = { kind: "key", bookingToken: await guestToken(booking.id) } as const;
    const payment = await seedPayment(booking.id, "captured");
    const claimAt = (at: Date) =>
      inTenant((trx) =>
        trx
          .updateTable("bookings")
          .set({ ticketing_status: "in_progress", ticketing_last_attempt_at: at })
          .where("id", "=", booking.id)
          .execute(),
      );
    await claimAt(new Date());
    const quoted = await quote(booking.id, guest);
    stub.clearRequests();
    stripe.reset();

    const refused = await cancel(booking.id, guest, '"1"', cancellation(quoted.body.estimatedRefund));
    expect(answer(refused)).toEqual([409, "BOOKING_NOT_MODIFIABLE"]);
    expect(refused.body.error.details).toEqual({ reason: "ticketing_in_progress" });
    expect(stub.requests().filter((entry) => entry.operation === "cancelFlightOrder")).toEqual([]);
    expect(stripeRequestsAbout(payment.intentId ?? "")).toEqual([]);

    await claimAt(new Date(Date.now() - 6 * MINUTE));
    const cancelled = await cancel(booking.id, guest, '"1"', cancellation(quoted.body.estimatedRefund));
    expect(answer(cancelled)).toEqual([200, undefined]);
    expect(amadeusCalls("cancelFlightOrder").map((call) => call.status)).toEqual([204]);
  });
});

describe("a DELETE without an answer whose check was never queued", () => {
  let booking: SeededBooking;
  let deadline: number;
  let jobsBefore: string[];
  let scans: Job[];
  let jobsQueued: string[];
  let check: Job;

  /** The ids of the booking's `booking.cancellation_check` jobs, whatever their state. */
  const checkJobsOf = async (bookingId: string): Promise<string[]> =>
    (await bookingsQueue.getJobs(["delayed", "waiting", "active", "completed", "failed", "paused"]))
      .map((job) => job.id ?? "")
      .filter((id) => id.startsWith(`${CANCELLATION_CHECK_JOB}:${bookingId}:`));

  beforeAll(async () => {
    const customer = await newCustomer();
    const credential: Credential = { kind: "key", customerToken: customer.token };
    booking = await seedBooking("cancel.check_lost", { customerId: customer.id });
    await seedPayment(booking.id, "captured");
    const quoted = await quote(booking.id, credential);
    stub.clearRequests();
    // The after-commit enqueue of the first check is lost (Redis did not answer it): CancellationRecorder.enqueue logs
    // such a failure and goes on, so the job is simply missing.
    const recorder = api.app.get(CancellationRecorder, { strict: false });
    const enqueue = recorder.enqueue.bind(recorder);
    const lost = vi
      .spyOn(recorder, "enqueue")
      .mockImplementation((queue, name, data, opts) =>
        name === CANCELLATION_CHECK_JOB ? Promise.resolve() : enqueue(queue, name, data, opts),
      );
    const spy = nextDeleteWith("timeout");
    const timedOut = await cancel(booking.id, credential, '"1"', cancellation(quoted.body.estimatedRefund));
    spy.mockRestore();
    lost.mockRestore();
    expect(answer(timedOut)).toEqual([504, "SUPPLIER_TIMEOUT"]);
    jobsBefore = await checkJobsOf(booking.id);
    // The flag is older than the sweep's minute (a scan a few minutes after the DELETE).
    const flag = await inTenant(async (trx) => {
      await sql`UPDATE booking_events SET created_at = created_at - interval '3 minutes'
        WHERE booking_id = ${booking.id} AND type = 'booking.cancellation_timeout'`.execute(trx);
      return await trx
        .selectFrom("booking_events")
        .select("data")
        .where("booking_id", "=", booking.id)
        .where("type", "=", "booking.cancellation_timeout")
        .executeTakeFirstOrThrow();
    });
    deadline = Date.parse(String((flag.data as JsonObject)["until"]));

    // Two scans (two minutes' iterations) while the bookings consumer waits: both add the flag's first check, which
    // BullMQ keeps once by its id.
    const maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
    const bookingsWorker = worker.get(ReconcileProcessor, { strict: false }).worker;
    await bookingsWorker.pause();
    scans = [];
    try {
      const bucket = minuteBucket(new Date());
      for (const minute of [bucket, bucket + 1]) {
        const spec = tenantJob(RECONCILE_SCAN_JOB, alphaId, minute);
        await maintenance.add(spec.name, spec.data, spec.opts);
        scans.push(await finished(maintenance, spec.opts.jobId));
      }
      jobsQueued = await checkJobsOf(booking.id);
    } finally {
      bookingsWorker.resume();
    }
    check = await finished(bookingsQueue, jobsQueued[0] ?? "");
    await finished(paymentsQueue, `refund-submit-${(await refundsOf(booking.id))[0]?.id ?? ""}`);
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W28-CANCEL AC4] lets the reconcile scan queue the lost check once, under the flag's own job id", () => {
    expect(jobsBefore).toEqual([]);
    for (const scan of scans) {
      expect(scan.returnvalue).toMatchObject({ counts: { cancellationChecks: 1 } });
    }
    expect(jobsQueued).toEqual([`${CANCELLATION_CHECK_JOB}:${booking.id}:${deadline}-1`]);
  });

  it("[FIX-W28-CANCEL AC4] checks the booking exactly once: the order is gone, the cancellation and its refund recorded", async () => {
    expect(check.returnvalue).toEqual({ tenantId: alphaId, bookingId: booking.id, outcome: "cancelled" });
    expect(check.attemptsMade).toBeLessThanOrEqual(1);
    expect(await checkJobsOf(booking.id)).toEqual(jobsQueued);
    expect(await bookingRow(booking.id)).toMatchObject({ status: "cancelled", cancelled_by: "customer" });
    expect((await refundsOf(booking.id)).map((row) => row.amount)).toEqual([REFUND]);
    expect(
      (await eventsOf(booking.id))
        .filter((event) => event.type === "booking.cancelled")
        .map((event) => event.type),
    ).toEqual(["booking.cancelled"]);
  });
});

describe("a DELETE without an answer whose later check was lost", () => {
  let booking: SeededBooking;
  let firstCheck: Job;
  let jobsAfterFirst: string[];
  let deadline: number;
  let scans: Job[];
  let jobsQueued: string[];
  let lastCheck: Job;

  /** The ids of the booking's `booking.cancellation_check` jobs, whatever their state, sorted. */
  const checkJobsOf = async (bookingId: string): Promise<string[]> =>
    (await bookingsQueue.getJobs(["delayed", "waiting", "active", "completed", "failed", "paused"]))
      .map((job) => job.id ?? "")
      .filter((id) => id.startsWith(`${CANCELLATION_CHECK_JOB}:${bookingId}:`))
      .sort();

  beforeAll(async () => {
    const customer = await newCustomer();
    const credential: Credential = { kind: "key", customerToken: customer.token };
    booking = await seedBooking("cancel.check_chain_lost", { customerId: customer.id });
    await seedPayment(booking.id, "captured");
    const quoted = await quote(booking.id, credential);
    stub.clearRequests();
    const spy = nextDeleteWith("timeout");
    const timedOut = await cancel(booking.id, credential, '"1"', cancellation(quoted.body.estimatedRefund));
    spy.mockRestore();
    expect(answer(timedOut)).toEqual([504, "SUPPLIER_TIMEOUT"]);

    // The first check cannot read the order (Amadeus unavailable) and queues the next one, whose enqueue is lost
    // (CancellationRecorder.enqueue logs such a failure and goes on): the chain ends there, the flag still undecided.
    const client = worker.get(AmadeusClient, { strict: false });
    const reads = vi.spyOn(client, "getFlightOrder").mockRejectedValue(new AppError("SUPPLIER_UNAVAILABLE"));
    const recorder = worker.get(CancellationRecorder, { strict: false });
    const enqueue = recorder.enqueue.bind(recorder);
    const lost = vi
      .spyOn(recorder, "enqueue")
      .mockImplementation((queue, name, data, opts) =>
        name === CANCELLATION_CHECK_JOB ? Promise.resolve() : enqueue(queue, name, data, opts),
      );
    try {
      firstCheck = await runCheck(booking.id);
    } finally {
      lost.mockRestore();
      reads.mockRestore();
    }
    jobsAfterFirst = await checkJobsOf(booking.id);

    // Six minutes after the flag's deadline: every check of a healthy chain after the deadline would have decided it.
    deadline = Date.now() - 6 * MINUTE;
    await inTenant((trx) =>
      trx
        .updateTable("booking_events")
        .set({
          data: sql`jsonb_set(data, '{until}', to_jsonb(${new Date(deadline).toISOString()}::text))`,
          created_at: sql`created_at - interval '21 minutes'`,
        })
        .where("booking_id", "=", booking.id)
        .where("type", "=", "booking.cancellation_timeout")
        .execute(),
    );

    // Two scans while the bookings consumer waits: both add the chain's last check, which BullMQ keeps once by its id.
    const maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
    const bookingsWorker = worker.get(ReconcileProcessor, { strict: false }).worker;
    await bookingsWorker.pause();
    scans = [];
    try {
      const bucket = minuteBucket(new Date()) + 10;
      for (const minute of [bucket, bucket + 1]) {
        const spec = tenantJob(RECONCILE_SCAN_JOB, alphaId, minute);
        await maintenance.add(spec.name, spec.data, spec.opts);
        scans.push(await finished(maintenance, spec.opts.jobId));
      }
      jobsQueued = await checkJobsOf(booking.id);
    } finally {
      bookingsWorker.resume();
    }
    lastCheck = await finished(
      bookingsQueue,
      `${CANCELLATION_CHECK_JOB}:${booking.id}:${deadline}-${CANCELLATION_CHECK_MAX_RUNS}`,
    );
    await finished(paymentsQueue, `refund-submit-${(await refundsOf(booking.id))[0]?.id ?? ""}`);
  }, SCENARIO_TIMEOUT_MS);

  it("[FIX-W28-CANCEL AC4] lets the reconcile scan queue the chain's last check once, after the deadline", () => {
    expect(firstCheck.returnvalue).toEqual({
      tenantId: alphaId,
      bookingId: booking.id,
      outcome: "rescheduled",
    });
    // The first check is the only job of the chain: the next one was lost.
    expect(jobsAfterFirst).toHaveLength(1);
    expect(jobsAfterFirst[0]).toMatch(new RegExp(`:${booking.id}:\\d+-1$`));
    for (const scan of scans) {
      expect(scan.returnvalue).toMatchObject({ counts: { cancellationChecks: 1 } });
    }
    expect(jobsQueued).toEqual(
      [
        ...jobsAfterFirst,
        `${CANCELLATION_CHECK_JOB}:${booking.id}:${deadline}-${CANCELLATION_CHECK_MAX_RUNS}`,
      ].sort(),
    );
  });

  it("[FIX-W28-CANCEL AC4] decides the cancellation exactly once: the order is gone, the cancellation and its refund recorded", async () => {
    expect(lastCheck.returnvalue).toEqual({ tenantId: alphaId, bookingId: booking.id, outcome: "cancelled" });
    expect(lastCheck.attemptsMade).toBeLessThanOrEqual(1);
    expect(await checkJobsOf(booking.id)).toEqual(jobsQueued);
    expect(await bookingRow(booking.id)).toMatchObject({ status: "cancelled", cancelled_by: "customer" });
    expect((await refundsOf(booking.id)).map((row) => row.amount)).toEqual([REFUND]);
    expect(
      (await eventsOf(booking.id))
        .filter((event) => event.type === "booking.cancelled")
        .map((event) => event.type),
    ).toEqual(["booking.cancelled"]);
  });
});

describe("the ticketing job while a customer's cancellation is undecided (FIX-W31-OTA)", () => {
  let ticketingQueue: Queue;
  /** The minute buckets of this block's ticketing jobs: far from the scenarios above, one per run. */
  let bucket = minuteBucket(new Date()) + 10_000;

  /** Runs one ticketing attempt of the booking in the worker and answers how it ended (the job's return value). */
  async function runTicketing(bookingId: string): Promise<JsonObject> {
    bucket += 1;
    const job = ticketingJob(alphaId, bookingId, bucket);
    await ticketingQueue.add(job.name, job.data, job.opts);
    const done = await finished(ticketingQueue, job.opts.jobId);
    expect(await done.getState()).toBe("completed");
    return done.returnvalue as JsonObject;
  }

  /** A customer's booking paid by Stripe whose issuance retry is due now (the ticketing job would claim it). */
  async function dueBooking(prefix: string): Promise<{ booking: SeededBooking; credential: Credential }> {
    const customer = await newCustomer();
    const booking = await seedBooking(prefix, { customerId: customer.id });
    await seedPayment(booking.id, "captured");
    await inTenant((trx) =>
      trx
        .updateTable("bookings")
        .set({
          ticketing_status: "failed",
          ticketing_attempts: 1,
          ticketing_error_code: "TICKETING_FAILED",
          ticketing_next_attempt_at: new Date(Date.now() - MINUTE),
        })
        .where("id", "=", booking.id)
        .execute(),
    );
    return { booking, credential: { kind: "key", customerToken: customer.token } };
  }

  beforeAll(() => {
    ticketingQueue = worker.get<Queue>(getQueueToken(OTA_QUEUE.ticketing), { strict: false });
  });

  it("[FIX-W31-OTA AC1] skips the booking while the customer's DELETE is in flight, then claims it as before once the airline's refusal made it a request", async () => {
    const { booking, credential } = await dueBooking("cancel.hold_request");
    const quoted = await quote(booking.id, credential);
    stub.clearRequests();
    const held = holdNextDelete("cancel-refused");
    let skipped: JsonObject;
    let claimedWhileHeld: Date | null;
    let cancelled: Response;
    try {
      const cancelling = cancel(
        booking.id,
        credential,
        '"1"',
        cancellation(quoted.body.estimatedRefund),
      ).then((res) => res);
      await held.reached;
      // T1 committed, the DELETE has not left: the ticketing job leaves the booking alone, nothing goes to Amadeus.
      claimedWhileHeld = await claimedAtOf(booking.id);
      skipped = await runTicketing(booking.id);
      held.pass();
      cancelled = await cancelling;
    } finally {
      held.pass();
      held.spy.mockRestore();
    }

    expect(claimedWhileHeld).toBeInstanceOf(Date);
    expect(skipped).toMatchObject({ outcome: "skipped", reason: "cancellation_pending" });
    expect(amadeusCalls("issueFlightOrder")).toEqual([]);
    expect(amadeusCalls("getFlightOrder").map((call) => call.status)).toEqual([]);
    // The airline refused the DELETE: a request for the staff (202), the order live, the claim's marker cleared.
    expect(answer(cancelled)).toEqual([202, undefined]);
    expectResponseToMatch("cancelBooking", cancelled);
    expect(await claimedAtOf(booking.id)).toBeNull();
    // The ticketing job claims the booking as before and issues the live order.
    expect(await runTicketing(booking.id)).toMatchObject({ outcome: "ticketed", via: "issue" });
    expect(await bookingRow(booking.id)).toMatchObject({ status: "ticketed", ticketing_status: "issued" });
  });

  it("[FIX-W31-OTA AC1] skips it while a DELETE without an answer is undecided, then claims it as before once the worker found the order active", async () => {
    const { booking, credential } = await dueBooking("cancel.hold_not_applied");
    const quoted = await quote(booking.id, credential);
    const spy = nextDeleteWith("timeout-lost");
    const timedOut = await cancel(booking.id, credential, '"1"', cancellation(quoted.body.estimatedRefund));
    spy.mockRestore();
    expect(answer(timedOut)).toEqual([504, "SUPPLIER_TIMEOUT"]);
    // The flag took over from the claim's marker in its transaction.
    expect(await claimedAtOf(booking.id)).toBeNull();
    stub.clearRequests();

    expect(await runTicketing(booking.id)).toMatchObject({
      outcome: "skipped",
      reason: "cancellation_pending",
    });
    expect(amadeusCalls("issueFlightOrder")).toEqual([]);

    const check = await runCheck(booking.id);
    expect(check.returnvalue).toMatchObject({ outcome: "not_applied" });
    expect(await runTicketing(booking.id)).toMatchObject({ outcome: "ticketed", via: "issue" });
  });

  it("[FIX-W31-OTA AC1] skips it while a DELETE without an answer is undecided, and as a cancelled booking once the worker found the order gone", async () => {
    const { booking, credential } = await dueBooking("cancel.hold_cancelled");
    const quoted = await quote(booking.id, credential);
    const spy = nextDeleteWith("timeout");
    const timedOut = await cancel(booking.id, credential, '"1"', cancellation(quoted.body.estimatedRefund));
    spy.mockRestore();
    expect(answer(timedOut)).toEqual([504, "SUPPLIER_TIMEOUT"]);
    stub.clearRequests();

    expect(await runTicketing(booking.id)).toMatchObject({
      outcome: "skipped",
      reason: "cancellation_pending",
    });

    const check = await runCheck(booking.id);
    expect(check.returnvalue).toMatchObject({ outcome: "cancelled" });
    // The worker's decision recorded the cancellation: the job skips the booking as any cancelled one, as before.
    expect(await runTicketing(booking.id)).toMatchObject({ outcome: "skipped", reason: "not_confirmed" });
    expect(amadeusCalls("issueFlightOrder")).toEqual([]);
    expect(await claimedAtOf(booking.id)).toBeNull();
  });

  it("[FIX-W31-OTA AC1] claims it again once a cancellation's claim is abandoned (5 minutes: a request that stopped mid-DELETE)", async () => {
    const { booking } = await dueBooking("cancel.hold_abandoned");
    const claimAt = (at: Date) =>
      inTenant((trx) =>
        trx
          .updateTable("bookings")
          .set({ cancellation_claimed_at: at })
          .where("id", "=", booking.id)
          .execute(),
      );
    await claimAt(new Date());
    stub.clearRequests();
    expect(await runTicketing(booking.id)).toMatchObject({
      outcome: "skipped",
      reason: "cancellation_pending",
    });
    expect(amadeusCalls("issueFlightOrder")).toEqual([]);

    await claimAt(new Date(Date.now() - 6 * MINUTE));
    // The attempt starts with its resync (the order is live here) and issues it.
    expect(await runTicketing(booking.id)).toMatchObject({ outcome: "ticketed", via: "issue" });
    expect(amadeusCalls("getFlightOrder").map((call) => call.status)).toEqual([200]);
  });

  it.each([
    { scenario: "version-conflict", prefix: "cancel.hold_conflict", answered: [409, "VERSION_CONFLICT"] },
    { scenario: "rate-limited", prefix: "cancel.hold_unsent", answered: [503, "SUPPLIER_UNAVAILABLE"] },
  ])(
    "[FIX-W31-OTA AC1] claims it as before at once when the DELETE applied nothing ($scenario: the claim's marker released)",
    async ({ scenario, prefix, answered }) => {
      const { booking, credential } = await dueBooking(prefix);
      const quoted = await quote(booking.id, credential);
      const spy = nextDeleteWith(scenario);
      const res = await cancel(booking.id, credential, '"1"', cancellation(quoted.body.estimatedRefund));
      spy.mockRestore();
      expect(answer(res)).toEqual(answered);
      expectResponseToMatch("cancelBooking", res);
      // Amadeus's 2552, or a request Amadeus refused before reading it: the order is live and nothing was recorded, so
      // the release cleared the marker instead of leaving it to hold the ticketing claims for its 5 minutes.
      expect(await claimedAtOf(booking.id)).toBeNull();
      expect(await bookingRow(booking.id)).toMatchObject({ status: "confirmed", version: 2 });
      stub.clearRequests();
      expect(await runTicketing(booking.id)).toMatchObject({ outcome: "ticketed", via: "issue" });
      expect(amadeusCalls("issueFlightOrder").map((call) => call.status)).toEqual([200]);
    },
  );
});

describe("a second cancellation while another one's DELETE is in flight (FIX-W32-OTA)", () => {
  /** A customer's booking paid in full by Stripe, and the customer's credential. */
  async function cancellableBooking(
    prefix: string,
  ): Promise<{ booking: SeededBooking; credential: Credential }> {
    const customer = await newCustomer();
    const booking = await seedBooking(prefix, { customerId: customer.id });
    await seedPayment(booking.id, "captured");
    return { booking, credential: { kind: "key", customerToken: customer.token } };
  }

  /**
   * The next refresh of an order the API makes (bookings.cancel's quote between its checks without a lock and its
   * claim) held by a barrier: `reached` resolves once the checks without a lock (T0) passed.
   */
  function holdNextRefresh() {
    const bookings = api.app.get(CustomerBookingsService, { strict: false });
    const refresh = bookings.refresh.bind(bookings);
    let reach = (): void => undefined;
    const reached = new Promise<void>((resolveReach) => {
      reach = resolveReach;
    });
    let pass = (): void => undefined;
    const passed = new Promise<void>((resolvePass) => {
      pass = resolvePass;
    });
    const spy = vi.spyOn(bookings, "refresh").mockImplementationOnce(async (...args) => {
      reach();
      await passed;
      return await refresh(...args);
    });
    return { reached, pass, spy };
  }

  it("[FIX-W32-OTA AC2] refuses a second cancellation sent with the ETag the first one's claim left: 409 pending, one DELETE", async () => {
    const { booking, credential } = await cancellableBooking("cancel.second_in_flight");
    const quoted = await quote(booking.id, credential);
    stub.clearRequests();
    const held = holdNextDelete();
    let second: Response;
    let first: Response;
    try {
      const cancelling = cancel(
        booking.id,
        credential,
        '"1"',
        cancellation(quoted.body.estimatedRefund),
      ).then((res) => res);
      await held.reached;
      // The first claim (T1) committed and moved the version; another tab reloads the booking and cancels with it.
      const { version } = await bookingRow(booking.id);
      expect(version).toBe(2);
      second = await cancel(
        booking.id,
        credential,
        `"${version}"`,
        cancellation(quoted.body.estimatedRefund),
      );
      held.pass();
      first = await cancelling;
    } finally {
      held.pass();
      held.spy.mockRestore();
    }

    expect(answer(second)).toEqual([409, "BOOKING_NOT_MODIFIABLE"]);
    expect(second.body.error.details).toMatchObject({ reason: "pending" });
    expectResponseToMatch("cancelBooking", second);
    expect(answer(first)).toEqual([200, undefined]);
    // One DELETE, one refund: the second request never reached Amadeus.
    expect(amadeusCalls("cancelFlightOrder").map((call) => call.status)).toEqual([204]);
    expect((await refundsOf(booking.id)).map((row) => row.amount)).toEqual([REFUND]);
    expect(await claimedAtOf(booking.id)).toBeNull();
  });

  it("[FIX-W32-OTA AC2] refuses it again under the claim's lock when another claim's marker appeared after the checks without a lock", async () => {
    const { booking, credential } = await cancellableBooking("cancel.second_in_t1");
    stub.clearRequests();
    const held = holdNextRefresh();
    const other = new Date();
    let res: Response;
    try {
      const cancelling = cancel(
        booking.id,
        credential,
        '"1"',
        cancellation({ amount: REFUND, currency: "EUR" }),
      ).then((answered) => answered);
      await held.reached;
      // Another claim's marker, written while this request quotes (its version left as it was, so only the claim's
      // own check under the lock can see it).
      await inTenant((trx) =>
        trx
          .updateTable("bookings")
          .set({ cancellation_claimed_at: other })
          .where("id", "=", booking.id)
          .execute(),
      );
      held.pass();
      res = await cancelling;
    } finally {
      held.pass();
      held.spy.mockRestore();
    }

    expect(answer(res)).toEqual([409, "BOOKING_NOT_MODIFIABLE"]);
    expect(res.body.error.details).toMatchObject({ reason: "pending" });
    expectResponseToMatch("cancelBooking", res);
    expect(amadeusCalls("cancelFlightOrder")).toEqual([]);
    // Nothing claimed: the version and the other claim's marker are as they were.
    expect(await bookingRow(booking.id)).toMatchObject({ status: "confirmed", version: 1 });
    expect(await claimedAtOf(booking.id)).toEqual(other);
  });

  it("[FIX-W32-OTA AC2] lets a cancellation claim once the other claim is abandoned (5 minutes)", async () => {
    const { booking, credential } = await cancellableBooking("cancel.second_abandoned");
    await inTenant((trx) =>
      trx
        .updateTable("bookings")
        .set({ cancellation_claimed_at: new Date(Date.now() - 6 * MINUTE) })
        .where("id", "=", booking.id)
        .execute(),
    );
    const quoted = await quote(booking.id, credential);
    stub.clearRequests();
    const res = await cancel(booking.id, credential, '"1"', cancellation(quoted.body.estimatedRefund));
    expect(answer(res)).toEqual([200, undefined]);
    expect(amadeusCalls("cancelFlightOrder").map((call) => call.status)).toEqual([204]);
    expect(await claimedAtOf(booking.id)).toBeNull();
  });

  it.each([
    {
      scenario: undefined,
      prefix: "cancel.own_marker_record",
      answered: [200, undefined],
      status: "cancelled",
    },
    {
      scenario: "cancel-refused",
      prefix: "cancel.own_marker_request",
      answered: [202, undefined],
      status: "confirmed",
    },
    {
      scenario: "timeout",
      prefix: "cancel.own_marker_flag",
      answered: [504, "SUPPLIER_TIMEOUT"],
      status: "confirmed",
    },
    {
      scenario: "version-conflict",
      prefix: "cancel.own_marker_release",
      answered: [409, "VERSION_CONFLICT"],
      status: "confirmed",
    },
  ])(
    "[FIX-W32-OTA AC2] clears only its own claim's marker when its outcome is recorded ($prefix)",
    async ({ scenario, prefix, answered, status }) => {
      const { booking, credential } = await cancellableBooking(prefix);
      const quoted = await quote(booking.id, credential);
      const held = holdNextDelete(scenario);
      // Another claim's marker, later than this one's (a claim taken while this request's DELETE was in flight).
      const other = new Date(Date.now() + MINUTE);
      let res: Response;
      try {
        const cancelling = cancel(
          booking.id,
          credential,
          '"1"',
          cancellation(quoted.body.estimatedRefund),
        ).then((answered) => answered);
        await held.reached;
        expect(await claimedAtOf(booking.id)).toBeInstanceOf(Date);
        await inTenant((trx) =>
          trx
            .updateTable("bookings")
            .set({ cancellation_claimed_at: other })
            .where("id", "=", booking.id)
            .execute(),
        );
        held.pass();
        res = await cancelling;
      } finally {
        held.pass();
        held.spy.mockRestore();
      }

      expect(answer(res)).toEqual(answered);
      expectResponseToMatch("cancelBooking", res);
      expect((await bookingRow(booking.id)).status).toBe(status);
      // The record, the request (its version bump), the flag and the release ended this claim only.
      expect(await claimedAtOf(booking.id)).toEqual(other);
    },
  );
});
