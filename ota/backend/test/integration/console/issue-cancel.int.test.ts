// console.bookings.issue and console.bookings.cancel (OBE-063; ota/docs/flows/console-operations.md §1 and §2 "Issue",
// "Cancel", OADR-0008 point 1, OADR-0018 point 8, change-and-cancel.md §3 step 6): the staff issuance that captures an
// authorised Stripe payment first and the staff cancellation with its refund modes, against PostgreSQL 16, Redis 7, the
// Amadeus stub and a fake of the Stripe API, through the API's whole pipeline (the OTA admin's service key with staff
// tokens, the permission guard, validation, idempotency, the audit interceptor) and the worker's queues (`refund.submit`
// on `ota-payments`, `booking.cancellation_check` on `ota-bookings`).
//
// The file clones the @velexis/testing template (tenant_alpha provisioned) and writes the platform rows as the platform
// does: alpha in test on the Velexis test Amadeus account, whose base URL is the stub's (the worker has no override),
// with a Velexis-mode Stripe connection, accounts and memberships of the roles the scenarios use. Staff sign in through
// the OTA admin's service key with portal tokens, each admin client with an end-user IP address of its own. Every
// booking points at an order created in the stub through its own HTTP API (one adult, not issued) and is written the
// way the record step writes it (the redacted snapshot, the order's contact, its record), with a synthetic traveller
// and a flight 10 days after now, a total of 125.47 EUR; payments are written as checkout.createPayment and the
// webhooks leave them, with their PaymentIntents in the fake. Both processes run in-process: the API (createTestApp)
// and the worker (WorkerModule.forRoot), whose schedulers are removed and whose e-mail and document consumers are
// paused (the outbox rows are what this file checks). Amadeus answers are chosen per call by giving the client a stub
// scenario (a spy, as cancel.int.test.ts does); the stub's `timeout` holds an answer for 100 ms instead of 30 s. Every
// answer is checked against the OTA document.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Global, Module, type DynamicModule, type INestApplicationContext } from "@nestjs/common";
import { encryptValue, sha256Hex, type KeyProvider } from "@velexis/crypto";
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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AmadeusClient } from "../../../src/amadeus/amadeus.client";
import { AMADEUS_LIMITS, DEFAULT_AMADEUS_LIMITS, type AmadeusLimits } from "../../../src/amadeus/limits";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import {
  CANCELLATION_CHECK_JOB,
  CancellationRecorder,
  ORDER_GONE_WARNING,
} from "../../../src/bookings/cancellation.service";
import { buildCreateOrderRequest } from "../../../src/bookings/order-request.builder";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { ticketingJob } from "../../../src/bookings/ticketing.processor";
import { minuteBucket } from "../../../src/jobs/fan-out";
import { loadWorkerConfig } from "../../../src/config";
import { ISSUE_CAPTURE_REASON } from "../../../src/console/console-booking-actions.service";
import { DocumentsProcessor } from "../../../src/documents/documents.processor";
import { NotificationsProcessor } from "../../../src/notifications/notifications.processor";
import { PaymentsProcessor } from "../../../src/payments/payments.processor";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { buildOrderContact, buildOrderRequestInput } from "../../builders/bookings";
import { testApiCredentials, testKeyProvider, testWorkerVariables } from "../../helpers/api-env";
import { startFakeStripe, stripeEndpointModule, type FakeStripe } from "../../helpers/fake-stripe";
import { MemorySink } from "../../helpers/log-sink";
import { runDelayedPaymentJob } from "../../helpers/payment-jobs";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type JsonObject = Record<string, unknown>;
type Role = "owner" | "admin" | "agent" | "finance" | "viewer";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ALPHA: TenantSchema = "tenant_alpha" as TenantSchema;
const BOOKINGS = "/v1/console/bookings";

/** The booking's total (EUR), as every seeded booking holds it, and its amount in Stripe's minor units. */
const TOTAL = "125.47";
const TOTAL_MINOR = 12547;

/** How long a scenario waits at most for the worker. */
const WAIT_MS = 20_000;

/**
 * The Amadeus client's buckets of this file: the scenarios make their calls one after the other for one tenant,
 * faster than the tenant bucket's 10-call burst refills, so the buckets hold enough for the whole file (as
 * cancel.int.test.ts does).
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
let alphaId: string;
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

interface Member {
  readonly accountId: string;
  readonly staffId: string;
  readonly email: string;
  readonly role: Role;
}

async function insertMember(role: Role): Promise<Member> {
  const email = `staff.${randomBytes(4).toString("hex")}@example.com`;
  const accountId = newId("acc");
  await migrator
    .insertInto("platform.accounts")
    .values({
      id: accountId,
      email,
      full_name: "Maria Lopez",
      status: "active",
      email_verified_at: new Date(),
      locale: "en-GB",
      time_zone: "Europe/Paris",
      mfa_enabled: true,
    })
    .execute();
  const staffId = newId("stf");
  await migrator
    .insertInto("platform.tenant_memberships")
    .values({ id: staffId, tenant_id: alphaId, account_id: accountId, role, status: "active" })
    .execute();
  return { accountId, staffId, email, role };
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Stores a portal token for `member` as the platform's API does (PADR-0007 item 1). */
async function portalTokenFor(member: Member): Promise<string> {
  let token = "ptk_";
  for (let index = 0; index < 43; index += 1) {
    token += BASE62[randomInt(BASE62.length)];
  }
  const value = JSON.stringify({
    v: 1,
    accountId: member.accountId,
    tenantId: alphaId,
    membershipId: member.staffId,
    role: member.role,
    mfa: true,
    issuedAt: new Date().toISOString(),
    requestId: randomUUID(),
  });
  expect(await redis.client.set(redisKeys.portalToken(sha256Hex(token)).key, value, "EX", 60, "NX")).toBe(
    "OK",
  );
  return token;
}

let ipCounter = 0;

/** A staff member signed in through the OTA admin (its service key, the staff member's IP, the test environment). */
class AdminSession {
  readonly ip: string;
  readonly userAgent = `Mozilla/5.0 (OTA admin test ${randomBytes(3).toString("hex")})`;
  accessToken = "";

  constructor(readonly member: Member) {
    ipCounter += 1;
    this.ip = `198.51.100.${ipCounter}`;
  }

  headers(): Record<string, string> {
    return {
      "X-Api-Key": testApiCredentials().serviceKey,
      "X-Velexis-End-User-IP": this.ip,
      "X-Velexis-End-User-Agent": this.userAgent,
      "X-Velexis-Environment": "test",
      ...(this.accessToken === "" ? {} : { Authorization: `Bearer ${this.accessToken}` }),
    };
  }

  async signIn(): Promise<this> {
    const res = await request(api.server)
      .post("/v1/console/auth/sign-in")
      .set({ ...this.headers(), "Idempotency-Key": randomUUID() })
      .send({ grantType: "portal_token", portalToken: await portalTokenFor(this.member) });
    expect([res.status, res.body.error?.code]).toEqual([200, undefined]);
    this.accessToken = (res.body.session as { accessToken: string }).accessToken;
    return this;
  }

  get(path: string) {
    return request(api.server).get(path).set(this.headers());
  }

  issue(bookingId: string, ifMatch: string, body: JsonObject, key: string = randomUUID()) {
    return request(api.server)
      .post(`${BOOKINGS}/${bookingId}/issuance`)
      .set({ ...this.headers(), "If-Match": ifMatch, "Idempotency-Key": key })
      .send(body);
  }

  cancel(bookingId: string, ifMatch: string, body: JsonObject, key: string = randomUUID()) {
    return request(api.server)
      .post(`${BOOKINGS}/${bookingId}/cancellation`)
      .set({ ...this.headers(), "If-Match": ifMatch, "Idempotency-Key": key })
      .send(body);
  }
}

const sessions = new Map<Role, AdminSession>();

/** A signed-in staff member of `role` (one per role and file: the sign-in limit counts per IP). */
async function staff(role: Role): Promise<AdminSession> {
  const known = sessions.get(role);
  if (known !== undefined) {
    return known;
  }
  const session = await new AdminSession(await insertMember(role)).signIn();
  sessions.set(role, session);
  return session;
}

// ---- Tenant rows ---------------------------------------------------------------------------------------------------

const inTenant = <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, ALPHA, run);

const local = (date: Date): string => date.toISOString().slice(0, 19);

const records = (value: unknown): JsonObject[] =>
  Array.isArray(value)
    ? value.filter((item): item is JsonObject => typeof item === "object" && item !== null)
    : [];

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

/** The status of the order at the stub, as another Amadeus client reads it (404 once it is cancelled). */
async function stubOrderStatus(orderId: string): Promise<number> {
  const res = await fetch(`${stub.url}/v1/booking/flight-orders/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: `Bearer ${await stubToken()}` },
  });
  await res.body?.cancel();
  return res.status;
}

/**
 * An order of the stub (Flight Create Orders, not issued) of one adult, for `email`, its flight leaving at `outbound`
 * and landing 2 hours later (local times read as UTC, as the record step stores them for the template's airports).
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

/** What a seeded booking looks like. */
interface BookingSeed {
  /** `ticketing_status` (`manual_review` by default: the policy that leaves the issuance to the staff). */
  readonly ticketingStatus?: string;
  /** A ticketed booking (an e-ticket issued an hour ago), for a cancellation that voids it. */
  readonly ticketed?: boolean;
  /** The departure, relative to now (10 days by default); the flight lasts 2 hours. */
  readonly departInMs?: number;
}

interface SeededBooking {
  readonly id: string;
  readonly orderId: string;
  readonly email: string;
}

/**
 * A booking of a new stub order as the record step writes it: the bookings row (TOTAL, storefront), its MAD–ORY flight
 * (segment "3" of offer "2", the stub's offer), the adult, the order's contact (primary) and its record.
 */
async function seedBooking(prefix: string, seed: BookingSeed = {}): Promise<SeededBooking> {
  const email = uniqueEmail(prefix);
  const id = newId("bkg");
  const now = Date.now();
  const outbound = new Date(now + (seed.departInMs ?? 10 * DAY));
  const order = await newStubOrder(email, outbound);
  // The order's segment, whose terminals the booking keeps as the record step does (a refresh then changes nothing).
  const flight =
    records(records(records(order["flightOffers"])[0]?.["itineraries"])[0]?.["segments"])[0] ?? {};
  const recordLocator = (records(order["associatedRecords"])[0]?.["reference"] as string | undefined) ?? "";
  const contact = records(order["contacts"])[0] ?? {};
  const contactName = (contact["addresseeName"] ?? {}) as JsonObject;
  const ticketed = seed.ticketed === true;
  await inTenant(async (trx) => {
    await trx
      .insertInto("bookings")
      .values({
        id,
        environment: "test",
        reference: newBookingReference(),
        channel: "storefront",
        status: ticketed ? "ticketed" : "confirmed",
        ticketing_status: ticketed ? "issued" : (seed.ticketingStatus ?? "manual_review"),
        issued_at: ticketed ? new Date(now - HOUR) : null,
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
        pricing_mode: "markup_rules",
        net_amount: "98.47",
        net_base_amount: "56.00",
        net_fees_amount: "0.00",
        net_services_amount: "0.00",
        markup_amount: "27.00",
        fees_amount: "0.00",
        taxes_amount: "42.47",
        total_amount: TOTAL,
        contact_email: contact["emailAddress"] as string,
        lead_last_name: "SAMPLE",
        order_snapshot: JSON.stringify(redactPayload(order)),
        last_synced_at: new Date(now - HOUR),
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
        cabin: "ECONOMY",
        booking_class: "Q",
        status: "CONFIRMED",
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
    if (ticketed) {
      await trx
        .insertInto("booking_tickets")
        .values({
          id: newId("tkt"),
          booking_id: id,
          booking_traveler_id: travelerId,
          amadeus_traveler_id: "1",
          document_type: "ETICKET",
          document_number: `075-${String(randomInt(1_000_000_000, 9_999_999_999))}`,
          status: "ISSUED",
          segment_ids: ["3"],
          validating_carrier: "IB",
          issued_at: new Date(now - HOUR),
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
 * the fake: Stripe `captured` (TOTAL), Stripe `authorized` (TOTAL, not captured), an airline card the airline holds
 * without tickets (`processing`, nothing charged: OADR-0004), or one it charged (`airline_charged`, a ticketed
 * booking's). The booking's `amount_paid` follows.
 */
async function seedPayment(
  bookingId: string,
  kind: "captured" | "authorized" | "airline" | "airline_charged",
): Promise<{ readonly id: string; readonly intentId: string }> {
  const id = newId("pay");
  const airline = kind === "airline" || kind === "airline_charged";
  const charged = kind === "captured" || kind === "airline_charged";
  const intentId = stripeId("pi");
  await inTenant(async (trx) => {
    await trx
      .insertInto("payments")
      .values({
        id,
        environment: "test",
        booking_id: bookingId,
        provider: airline ? "airline" : "stripe",
        provider_connection_id: airline ? null : newId("ppc"),
        provider_payment_id: airline ? null : intentId,
        method: airline ? "airline_card" : "card",
        capture_method: airline ? "automatic" : "manual",
        currency: "EUR",
        amount: TOTAL,
        amount_authorized: kind === "airline" ? "0" : TOTAL,
        amount_captured: charged ? TOTAL : "0",
        status: charged ? "captured" : airline ? "processing" : "authorized",
        card_brand: "VISA",
        card_last4: "4242",
        authorized_at: kind === "airline" ? null : new Date(Date.now() - DAY),
        captured_at: charged ? new Date(Date.now() - DAY) : null,
        three_ds: airline ? null : JSON.stringify({ required: false, status: "not_required", version: null }),
        metadata: JSON.stringify({}),
        version: 2,
      })
      .execute();
    await trx
      .updateTable("bookings")
      .set({ amount_paid: charged ? TOTAL : "0" })
      .where("id", "=", bookingId)
      .execute();
  });
  if (!airline) {
    stripe.intents.set(intentId, {
      id: intentId,
      object: "payment_intent",
      status: kind === "authorized" ? "requires_capture" : "succeeded",
      amount: TOTAL_MINOR,
      amount_capturable: kind === "authorized" ? TOTAL_MINOR : 0,
      amount_received: kind === "authorized" ? 0 : TOTAL_MINOR,
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

// ---- What a scenario reads -----------------------------------------------------------------------------------------

const bookingRow = (bookingId: string) =>
  inTenant((trx) =>
    trx
      .selectFrom("bookings")
      .select([
        "version",
        "status",
        "ticketing_status",
        "ticketing_error_code",
        "cancelled_by",
        "cancel_reason",
        sql<string>`amount_paid::text`.as("amount_paid"),
      ])
      .where("id", "=", bookingId)
      .executeTakeFirstOrThrow(),
  );

const eventsOf = (bookingId: string) =>
  inTenant((trx) =>
    trx
      .selectFrom("booking_events")
      .select(["type", "actor_type", "actor_id", "visible_to_customer", "data"])
      .where("booking_id", "=", bookingId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );

const ticketsOf = (bookingId: string) =>
  inTenant((trx) =>
    trx
      .selectFrom("booking_tickets")
      .select(["status", "document_type"])
      .where("booking_id", "=", bookingId)
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
        "reason_note",
        "requested_by_type",
        "requested_by_id",
        sql<string>`amount::text`.as("amount"),
      ])
      .where("booking_id", "=", bookingId)
      .orderBy("created_at")
      .execute(),
  );

const paymentRow = (paymentId: string) =>
  inTenant((trx) =>
    trx
      .selectFrom("payments")
      .select(["status", sql<string>`amount_captured::text`.as("amount_captured")])
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
        .orderBy("id")
        .execute()
    ).map((row) => row.type),
  );

const notificationsOf = (bookingId: string) =>
  inTenant(async (trx) =>
    (
      await trx
        .selectFrom("notifications")
        .select("template_key")
        .where("booking_id", "=", bookingId)
        .orderBy("template_key")
        .execute()
    ).map((row) => row.template_key),
  );

/** The staff actions of a booking, oldest first. */
const staffActionsOf = (bookingId: string) =>
  inTenant((trx) =>
    trx
      .selectFrom("staff_actions")
      .select(["action", "outcome", "staff_id", "reason", "before", "after"])
      .where((eb) => eb.or([eb("booking_id", "=", bookingId), eb("target_id", "=", bookingId)]))
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );

const amadeusCalls = (operation: string) => stub.requests().filter((entry) => entry.operation === operation);

/** The Stripe requests about a PaymentIntent, its captures, cancel and refunds included. */
const stripeRequestsAbout = (intentId: string) =>
  stripe.requests.filter(
    (entry) =>
      entry.path.includes(intentId) ||
      (entry.path === "/v1/refunds" && entry.form["payment_intent"] === intentId),
  );

/** The `[status, error code]` of an answer. */
const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

/** The console booking's ETag, as console.bookings.get answers it. */
async function etagOf(session: AdminSession, bookingId: string): Promise<string> {
  const res = await session.get(`${BOOKINGS}/${bookingId}`);
  expect(answer(res)).toEqual([200, undefined]);
  return res.headers["etag"] as string;
}

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

/** Waits until the job `id` of `queue` has finished (completed or failed) and answers it. */
async function finished(queue: Queue, id: string): Promise<Job> {
  return await waitFor(`the job ${id}`, async () => {
    const state = await queue.getJobState(id);
    return state === "completed" || state === "failed" ? await queue.getJob(id) : undefined;
  });
}

/** The delayed first check of a booking's DELETE without an answer, run now (the API queued it 30 s later). */
async function runCheck(bookingId: string): Promise<Job> {
  const prefix = `${CANCELLATION_CHECK_JOB}:${bookingId}:`;
  const job = await waitFor(`the first check of ${bookingId}`, async () =>
    (await bookingsQueue.getJobs(["delayed", "waiting", "active", "completed", "failed"])).find(
      (candidate) => candidate.id?.startsWith(prefix) === true && candidate.id.endsWith("-1"),
    ),
  );
  if ((await job.getState()) === "delayed") {
    await job.promote();
  }
  return await finished(bookingsQueue, job.id ?? "");
}

/** The API client's next call of `method` with a stub scenario (only that call). */
function nextCallWith(method: "issueFlightOrder" | "cancelFlightOrder", scenario: string) {
  const client = api.app.get(AmadeusClient, { strict: false });
  if (method === "issueFlightOrder") {
    const issue = client.issueFlightOrder.bind(client);
    return vi
      .spyOn(client, "issueFlightOrder")
      .mockImplementationOnce((context, req, options) =>
        issue({ ...context, stubScenario: scenario }, req, options),
      );
  }
  const cancelOrder = client.cancelFlightOrder.bind(client);
  return vi
    .spyOn(client, "cancelFlightOrder")
    .mockImplementationOnce((context, req, options) =>
      cancelOrder({ ...context, stubScenario: scenario }, req, options),
    );
}

// Cloning the template, starting the stub and the fake Stripe API, building the API's and the worker's module graphs,
// the sign-ins and compiling the response validators take several seconds alone and much longer on a busy 4-CPU
// runner: all of it happens once here, with its own budget (OPENAPI_SETUP_TIMEOUT_MS), and the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["consoleIssueBooking", [200, 400, 402, 403, 409, 502, 504]],
    ["consoleCancelBooking", [200, 409, 422, 504]],
    ["consoleGetBooking", [200]],
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
  await inTenant((trx) =>
    seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" }),
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
  // The sign-ins and the first calls of a process open the pools' connections and warm the token, validation, Amadeus
  // and Stripe code: done once here, so that no test pays for it.
  for (const role of ["owner", "agent"] as const) {
    await staff(role);
  }
  const owner = await staff("owner");
  const warm = await seedBooking("issue.warm");
  await seedPayment(warm.id, "authorized");
  const warmIssue = await owner.issue(warm.id, await etagOf(owner, warm.id), {});
  expect(answer(warmIssue)).toEqual([200, undefined]);
  const warmCancel = await owner.cancel(warm.id, warmIssue.headers["etag"] as string, {
    reasonCode: "other",
    reason: "Warm-up of the test file",
  });
  expect(answer(warmCancel)).toEqual([200, undefined]);
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

beforeEach(() => {
  stub.clearRequests();
});

// ---- console.bookings.issue ----------------------------------------------------------------------------------------

describe("console.bookings.issue", () => {
  it("[OBE-063 AC1] captures a manual_review booking's authorisation, then issues it, once, with a double submit of one key", async () => {
    const agent = await staff("agent");
    const booking = await seedBooking("issue.manual");
    const payment = await seedPayment(booking.id, "authorized");
    const etag = await etagOf(agent, booking.id);
    stripe.reset();
    stub.clearRequests();
    const key = randomUUID();
    const body = { reason: "Payment confirmed by finance", notifyCustomer: true };

    const [first, second] = await Promise.all([
      agent.issue(booking.id, etag, body, key),
      agent.issue(booking.id, etag, body, key),
    ]);

    for (const res of [first, second]) {
      expect(answer(res)).toEqual([200, undefined]);
      expectResponseToMatch("consoleIssueBooking", res);
      expect(res.headers["cache-control"]).toBe("private, no-store");
    }
    expect(second.body).toEqual(first.body);
    expect(first.headers["etag"]).toBe(`"${String(first.body.version)}"`);
    expect(first.body).toMatchObject({
      id: booking.id,
      status: "ticketed",
      ticketing: { status: "issued" },
      paymentStatus: "paid",
    });
    expect((first.body.tickets as JsonObject[]).map((ticket) => ticket["status"])).toEqual(["ISSUED"]);
    // One capture of the whole authorisation, one Flight Order Issue: the second request replayed the first answer.
    const captures = stripeRequestsAbout(payment.intentId).filter((entry) => entry.path.endsWith("/capture"));
    expect(captures).toHaveLength(1);
    expect(captures[0]?.headers["idempotency-key"]).toBe(`pi:capture:${payment.id}:${TOTAL}`);
    expect(amadeusCalls("issueFlightOrder").map((call) => call.status)).toEqual([200]);
    expect(await paymentRow(payment.id)).toEqual({ status: "captured", amount_captured: TOTAL });
    expect(await bookingRow(booking.id)).toMatchObject({
      status: "ticketed",
      ticketing_status: "issued",
      amount_paid: TOTAL,
    });
    expect(await ticketsOf(booking.id)).toEqual([{ status: "ISSUED", document_type: "ETICKET" }]);
    // Captured first, then issued: the booking's timeline says so, as the staff member's.
    const events = await eventsOf(booking.id);
    expect(events.map((event) => event.type)).toEqual(["payment.captured", "booking.ticketed"]);
    expect(events[1]).toMatchObject({
      actor_type: "staff",
      actor_id: agent.member.staffId,
      visible_to_customer: true,
      data: { via: "console" },
    });
    // The capture's staff action, then the issuance's, with the redacted before and after.
    const actions = await staffActionsOf(booking.id);
    // The second request's idempotent replay keeps a row of its own (OADR-0011 point 8), as the audit's.
    expect(actions.map((action) => [action.action, action.outcome])).toEqual([
      ["payment.capture", "succeeded"],
      ["booking.issue", "succeeded"],
      ["bookings.issue", "succeeded"],
    ]);
    expect(actions[0]?.reason).toBe(body.reason);
    expect(actions[1]).toMatchObject({
      staff_id: agent.member.staffId,
      reason: body.reason,
      before: { status: "confirmed", ticketingStatus: "manual_review", payment: "capture" },
      after: {
        status: "ticketed",
        ticketingStatus: "issued",
        tickets: 1,
        captured: true,
        allowUnpaid: false,
      },
    });
    // The e-tickets e-mail is queued once.
    expect(await notificationsOf(booking.id)).toEqual(["booking.ticketed"]);
  });

  it("[OBE-063 AC2] refuses allowUnpaid to an agent (403, audited as denied) and lets an owner issue an unpaid booking", async () => {
    const agent = await staff("agent");
    const owner = await staff("owner");
    const booking = await seedBooking("issue.unpaid");
    const etag = await etagOf(owner, booking.id);

    const denied = await agent.issue(booking.id, etag, { allowUnpaid: true, reason: "Corporate account" });
    expect(answer(denied)).toEqual([403, "FORBIDDEN"]);
    expectResponseToMatch("consoleIssueBooking", denied);
    expect(denied.body.error.details).toMatchObject({ option: "allowUnpaid", role: "agent" });
    // Without allowUnpaid the agent meets the unpaid booking.
    const unpaid = await agent.issue(booking.id, etag, {});
    expect(answer(unpaid)).toEqual([402, "PAYMENT_REQUIRED"]);
    expect(amadeusCalls("issueFlightOrder")).toEqual([]);
    expect(await bookingRow(booking.id)).toMatchObject({
      status: "confirmed",
      ticketing_status: "manual_review",
    });

    const issued = await owner.issue(booking.id, etag, { allowUnpaid: true, reason: "Corporate account" });
    expect(answer(issued)).toEqual([200, undefined]);
    expectResponseToMatch("consoleIssueBooking", issued);
    expect(issued.body).toMatchObject({ status: "ticketed", paymentStatus: "unpaid" });
    expect(amadeusCalls("issueFlightOrder")).toHaveLength(1);
    const actions = await staffActionsOf(booking.id);
    expect(actions.map((action) => [action.action, action.outcome, action.staff_id])).toEqual([
      ["bookings.issue", "denied", agent.member.staffId],
      ["bookings.issue", "failed", agent.member.staffId],
      ["booking.issue", "succeeded", owner.member.staffId],
    ]);
    expect(actions[2]?.after).toMatchObject({ allowUnpaid: true, captured: false });
  });

  it("refuses a credit card before anything is read, and issues an airline-card booking with CASH only", async () => {
    const owner = await staff("owner");
    const booking = await seedBooking("issue.airline");
    await seedPayment(booking.id, "airline");
    const etag = await etagOf(owner, booking.id);

    const card = await owner.issue(booking.id, etag, {
      formOfPayments: [
        {
          creditCard: {
            brand: "VISA",
            holder: "TESTA SAMPLE",
            number: "4111111111111111",
            expiryDate: "2030-12",
          },
        },
      ],
    });
    expect(answer(card)).toEqual([403, "FEATURE_DISABLED"]);
    expect(card.body.error.details).toEqual({ feature: "consoleCardPayment" });
    // The card's number is in no row of the call (the audit keeps the action and the target only).
    expect(JSON.stringify(await staffActionsOf(booking.id))).not.toContain("4111111111111111");
    // An airline-card booking: an `other` form of payment, CASH or ACCOUNT, is required.
    const none = await owner.issue(booking.id, etag, { allowUnpaid: true });
    expect(answer(none)).toEqual([400, "VALIDATION_FAILED"]);
    expect(none.body.error.fieldErrors).toEqual([expect.objectContaining({ path: "/formOfPayments" })]);
    const check = await owner.issue(booking.id, etag, {
      allowUnpaid: true,
      formOfPayments: [{ other: { method: "CHECK", flightOfferIds: ["2"] } }],
    });
    expect(answer(check)).toEqual([400, "VALIDATION_FAILED"]);
    expect(amadeusCalls("issueFlightOrder")).toEqual([]);

    // The airline did not charge the card (no tickets): unpaid, so the owner issues it on the OTA's account.
    const cash = await owner.issue(booking.id, etag, {
      allowUnpaid: true,
      formOfPayments: [{ other: { method: "CASH", flightOfferIds: ["2"] } }],
      notifyCustomer: false,
    });
    expect(answer(cash)).toEqual([200, undefined]);
    expect(cash.body).toMatchObject({ status: "ticketed" });
    expect(amadeusCalls("issueFlightOrder")).toHaveLength(1);
    const sentRequests = await inTenant((trx) =>
      trx
        .selectFrom("supplier_requests")
        .select("request_body")
        .where("booking_id", "=", booking.id)
        .where("operation", "=", "console.bookings.issue")
        .where("amadeus_operation_id", "=", "issueFlightOrder")
        .execute(),
    );
    expect(sentRequests.map((row) => row.request_body)).toEqual([
      { data: { formOfPayments: [{ other: { method: "CASH", flightOfferIds: ["2"] } }] } },
    ]);
    // notifyCustomer false: no e-tickets e-mail.
    expect(await notificationsOf(booking.id)).toEqual([]);
  });

  it("releases its claim when the airline refuses: 502 TICKETING_FAILED, the capture stands, nothing issued", async () => {
    const agent = await staff("agent");
    const booking = await seedBooking("issue.refused");
    const payment = await seedPayment(booking.id, "authorized");
    const etag = await etagOf(agent, booking.id);
    nextCallWith("issueFlightOrder", "ticketing-failed");

    const res = await agent.issue(booking.id, etag, {});

    expect(answer(res)).toEqual([502, "TICKETING_FAILED"]);
    expectResponseToMatch("consoleIssueBooking", res);
    expect(await paymentRow(payment.id)).toEqual({ status: "captured", amount_captured: TOTAL });
    // The claim is released to the status it found, with the error; the staff see the failure.
    expect(await bookingRow(booking.id)).toMatchObject({
      status: "confirmed",
      ticketing_status: "manual_review",
      ticketing_error_code: "TICKETING_FAILED",
    });
    expect(await ticketsOf(booking.id)).toEqual([]);
    const events = await eventsOf(booking.id);
    expect(events.map((event) => [event.type, event.visible_to_customer])).toEqual([
      ["payment.captured", true],
      ["booking.ticketing_failed", false],
    ]);
    // What was done (the capture, with the issuance's default reason) and that the call failed.
    const actions = await staffActionsOf(booking.id);
    expect(actions.map((action) => [action.action, action.outcome, action.reason])).toEqual([
      ["payment.capture", "succeeded", ISSUE_CAPTURE_REASON],
      ["bookings.issue", "failed", null],
    ]);
    // A second attempt (a new key, the new ETag) issues it without capturing again.
    stripe.reset();
    const retried = await agent.issue(booking.id, await etagOf(agent, booking.id), {});
    expect(answer(retried)).toEqual([200, undefined]);
    expect(stripeRequestsAbout(payment.intentId)).toEqual([]);
  });

  it("records the tickets of an issuance whose answer was lost (resync on timeout), never issuing twice", async () => {
    const agent = await staff("agent");
    const booking = await seedBooking("issue.timeout");
    await seedPayment(booking.id, "captured");
    const etag = await etagOf(agent, booking.id);
    // The stub issues the order, then answers 504.
    nextCallWith("issueFlightOrder", "timeout");

    const res = await agent.issue(booking.id, etag, {});

    expect(answer(res)).toEqual([200, undefined]);
    expect(res.body).toMatchObject({ status: "ticketed", ticketing: { status: "issued" } });
    expect(amadeusCalls("issueFlightOrder")).toHaveLength(1);
    // The resync before the issuance (nothing issued yet), then the read back after the lost answer.
    expect(amadeusCalls("getFlightOrder")).toHaveLength(2);
    const ticketed = (await eventsOf(booking.id)).filter((event) => event.type === "booking.ticketed");
    expect(ticketed.map((event) => event.data)).toEqual([expect.objectContaining({ via: "console_resync" })]);
  });

  it("records the tickets an earlier, timed-out issuance made (the resync first), never issuing twice", async () => {
    const agent = await staff("agent");
    // The ticketing job's last attempt timed out: Amadeus issued the order, but its answer was lost.
    const booking = await seedBooking("issue.earlier", { ticketingStatus: "failed" });
    await seedPayment(booking.id, "captured");
    const issued = await fetch(
      `${stub.url}/v1/booking/flight-orders/${encodeURIComponent(booking.orderId)}/issuance`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await stubToken()}`,
          "Content-Type": "application/vnd.amadeus+json",
        },
        body: JSON.stringify({
          data: { formOfPayments: [{ other: { method: "CASH", flightOfferIds: ["2"] } }] },
        }),
      },
    );
    expect(issued.status).toBe(200);
    const etag = await etagOf(agent, booking.id);
    stub.clearRequests();

    const res = await agent.issue(booking.id, etag, {});

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleIssueBooking", res);
    expect(res.body).toMatchObject({ status: "ticketed", ticketing: { status: "issued" } });
    // One read, no Flight Order Issue: the stub would refuse a second issuance of the order (9112).
    expect(amadeusCalls("getFlightOrder")).toHaveLength(1);
    expect(amadeusCalls("issueFlightOrder")).toEqual([]);
    expect(await ticketsOf(booking.id)).toEqual([{ status: "ISSUED", document_type: "ETICKET" }]);
    const ticketed = (await eventsOf(booking.id)).filter((event) => event.type === "booking.ticketed");
    expect(ticketed.map((event) => event.data)).toEqual([expect.objectContaining({ via: "console_resync" })]);
    expect((await staffActionsOf(booking.id)).map((action) => [action.action, action.after])).toEqual([
      ["booking.issue", expect.objectContaining({ via: "resync", tickets: 1 })],
    ]);
  });

  it("releases its claim after an issuance without an answer that issued nothing: 504, the staff may try again", async () => {
    const agent = await staff("agent");
    const booking = await seedBooking("issue.lost");
    await seedPayment(booking.id, "captured");
    const etag = await etagOf(agent, booking.id);
    // The stub holds the answer without issuing, then gives up with a 504.
    nextCallWith("issueFlightOrder", "timeout-lost");

    const res = await agent.issue(booking.id, etag, {});

    expect(answer(res)).toEqual([504, "SUPPLIER_TIMEOUT"]);
    expectResponseToMatch("consoleIssueBooking", res);
    // The read back found no ticket: the claim is released to the status it found, with the error.
    expect(amadeusCalls("getFlightOrder")).toHaveLength(2);
    expect(await bookingRow(booking.id)).toMatchObject({
      status: "confirmed",
      ticketing_status: "manual_review",
      ticketing_error_code: "SUPPLIER_TIMEOUT",
    });
    expect(await ticketsOf(booking.id)).toEqual([]);
    expect(
      (await eventsOf(booking.id)).map((event) => [event.type, event.visible_to_customer, event.data]),
    ).toEqual([["booking.ticketing_failed", false, { via: "console", code: "SUPPLIER_TIMEOUT" }]]);
    // A new attempt (the new ETag) reads the order first, then issues it.
    stub.clearRequests();
    const retried = await agent.issue(booking.id, await etagOf(agent, booking.id), {});
    expect(answer(retried)).toEqual([200, undefined]);
    expect(amadeusCalls("issueFlightOrder").map((call) => call.status)).toEqual([200]);
  });

  it("answers 409 ALREADY_ISSUED for a ticketed booking and 412 for a stale ETag, without a call", async () => {
    const agent = await staff("agent");
    const ticketed = await seedBooking("issue.ticketed", { ticketed: true });
    const res = await agent.issue(ticketed.id, await etagOf(agent, ticketed.id), {});
    expect(answer(res)).toEqual([409, "ALREADY_ISSUED"]);
    const booking = await seedBooking("issue.stale");
    const stale = await agent.issue(booking.id, '"99"', {});
    expect(answer(stale)).toEqual([412, "PRECONDITION_FAILED"]);
    expect(amadeusCalls("issueFlightOrder")).toEqual([]);
  });
});

// ---- console.bookings.cancel ---------------------------------------------------------------------------------------

describe("console.bookings.cancel", () => {
  it("[OBE-063 AC3] cancels with refund.mode amount: one DELETE, one refund row and one Stripe refund", async () => {
    const agent = await staff("agent");
    const booking = await seedBooking("cancel.amount");
    const payment = await seedPayment(booking.id, "captured");
    const etag = await etagOf(agent, booking.id);
    stripe.reset();
    stub.clearRequests();
    const key = randomUUID();
    const body = {
      reasonCode: "airline_request",
      reason: "Airline changed the schedule; partial refund agreed by phone",
      refund: { mode: "amount", amount: { amount: "60.00", currency: "EUR" } },
    };

    // The payments consumer waits meanwhile, so the answers show the refund as the cancellation asked for it
    // (`pending`), never as its job may already have moved it: no reliance on the timing between the request and the job.
    const paymentsWorker = worker.get(PaymentsProcessor, { strict: false }).worker;
    await paymentsWorker.pause();
    let first: Response;
    let second: Response;
    try {
      [first, second] = await Promise.all([
        agent.cancel(booking.id, etag, body, key),
        agent.cancel(booking.id, etag, body, key),
      ]);
    } finally {
      paymentsWorker.resume();
    }

    for (const res of [first, second]) {
      expect(answer(res)).toEqual([200, undefined]);
      expectResponseToMatch("consoleCancelBooking", res);
    }
    expect(second.body).toEqual(first.body);
    expect(first.body).toMatchObject({
      id: booking.id,
      status: "cancelled",
      cancellation: {
        status: "cancelled",
        cancelledBy: "staff",
        reasonCode: "airline_request",
        comment: body.reason,
        refund: { amount: { amount: "60.00", currency: "EUR" }, reason: "booking_cancelled" },
        refundStatus: "pending",
      },
    });
    expect(amadeusCalls("cancelFlightOrder").map((call) => call.status)).toEqual([204]);
    expect(await stubOrderStatus(booking.orderId)).toBe(404);
    expect(await bookingRow(booking.id)).toMatchObject({
      status: "cancelled",
      cancelled_by: "staff",
      cancel_reason: `airline_request: ${body.reason}`,
    });
    const refunds = await refundsOf(booking.id);
    expect(refunds).toEqual([
      {
        id: expect.stringMatching(/^rfd_/),
        payment_id: payment.id,
        status: expect.any(String),
        reason: "booking_cancelled",
        reason_note: body.reason,
        requested_by_type: "staff",
        requested_by_id: agent.member.staffId,
        amount: "60.00",
      },
    ]);
    // The payments queue sends it to Stripe once, with the refund's own key.
    await finished(paymentsQueue, `refund-submit-${refunds[0]?.id ?? ""}`);
    const sent = stripe.requests.filter((entry) => entry.method === "POST" && entry.path === "/v1/refunds");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.form).toMatchObject({ payment_intent: payment.intentId, amount: "6000" });
    expect(sent[0]?.headers["idempotency-key"]).toBe(`refund:${refunds[0]?.id ?? ""}`);
    // The customer-visible events never carry the staff member's text; the staff action does.
    const events = await eventsOf(booking.id);
    expect(events.map((event) => event.type)).toEqual(["booking.cancelled", "refund.requested"]);
    expect(events[0]).toMatchObject({
      actor_type: "staff",
      visible_to_customer: true,
      data: { cancelledBy: "staff", reasonCode: "airline_request", refundMode: "amount" },
    });
    expect(JSON.stringify(events)).not.toContain(body.reason);
    const actions = await staffActionsOf(booking.id);
    // The second request's idempotent replay keeps a row of its own.
    expect(actions.map((action) => [action.action, action.outcome])).toEqual([
      ["booking.cancel", "succeeded"],
      ["bookings.cancel", "succeeded"],
    ]);
    expect(actions[0]).toMatchObject({
      reason: body.reason,
      before: { status: "confirmed" },
      after: {
        status: "cancelled",
        refundMode: "amount",
        refund: { amount: "60.00", currency: "EUR" },
        refundStatus: "pending",
      },
    });
    expect(await notificationsOf(booking.id)).toEqual(["booking.cancelled"]);
  });

  it("voids an authorisation without a refund, and captures the kept amount with refund.mode amount", async () => {
    const owner = await staff("owner");
    const voided = await seedBooking("cancel.void");
    const authorised = await seedPayment(voided.id, "authorized");
    const kept = await seedBooking("cancel.kept");
    const partial = await seedPayment(kept.id, "authorized");
    stripe.reset();

    const whole = await owner.cancel(voided.id, await etagOf(owner, voided.id), {
      reasonCode: "duplicate",
      reason: "Booked twice by the agency",
      notifyCustomer: false,
    });
    expect(answer(whole)).toEqual([200, undefined]);
    expect(whole.body.cancellation).toMatchObject({ refundStatus: "authorization_voided" });
    expect(await paymentRow(authorised.id)).toMatchObject({ status: "canceled" });
    expect(stripeRequestsAbout(authorised.intentId).map((entry) => entry.path)).toEqual([
      `/v1/payment_intents/${authorised.intentId}/cancel`,
    ]);
    // notifyCustomer false: no cancellation e-mail.
    expect(await notificationsOf(voided.id)).toEqual([]);

    const res = await owner.cancel(kept.id, await etagOf(owner, kept.id), {
      reasonCode: "customer_request",
      reason: "Customer called; the change fee is kept",
      refund: { mode: "amount", amount: { amount: "100.47", currency: "EUR" } },
    });
    expect(answer(res)).toEqual([200, undefined]);
    // 25.00 kept and captured, 100.47 released (a succeeded refunds row, no Stripe refund).
    const captures = stripeRequestsAbout(partial.intentId).filter((entry) => entry.path.endsWith("/capture"));
    expect(captures.map((entry) => entry.headers["idempotency-key"])).toEqual([
      `pi:capture:${partial.id}:cancellation:25.00`,
    ]);
    expect(await refundsOf(kept.id)).toEqual([
      expect.objectContaining({
        status: "succeeded",
        amount: "100.47",
        reason: "customer_request",
        requested_by_type: "staff",
      }),
    ]);
    expect(res.body.cancellation).toMatchObject({ refundStatus: "succeeded" });
  });

  it("refuses a refund of an airline card (422 refund_via_airline) before any call, and records its void expectation", async () => {
    const owner = await staff("owner");
    const booking = await seedBooking("cancel.airline", { ticketed: true });
    const payment = await seedPayment(booking.id, "airline_charged");
    const etag = await etagOf(owner, booking.id);

    const refused = await owner.cancel(booking.id, etag, {
      reasonCode: "customer_request",
      reason: "Customer asked for a refund",
      refund: { mode: "full" },
    });
    expect(answer(refused)).toEqual([422, "UNPROCESSABLE"]);
    expectResponseToMatch("consoleCancelBooking", refused);
    expect(refused.body.error.details).toMatchObject({ reason: "refund_via_airline" });
    expect(amadeusCalls("cancelFlightOrder")).toEqual([]);

    const res = await owner.cancel(booking.id, etag, {
      reasonCode: "customer_request",
      reason: "Customer asked for a cancellation",
    });
    expect(answer(res)).toEqual([200, undefined]);
    expect(await paymentEventTypes(payment.id)).toEqual(["airline.void_expected"]);
    expect(await refundsOf(booking.id)).toEqual([]);
  });

  it("refuses to issue or cancel a booking whose tickets are being issued (a fresh claim), without a call", async () => {
    const owner = await staff("owner");
    const booking = await seedBooking("claim.fresh");
    const payment = await seedPayment(booking.id, "authorized");
    // A staff issuance (or the ticketing job) claimed it a moment ago and is capturing or issuing now.
    const claimAt = (at: Date) =>
      inTenant((trx) =>
        trx
          .updateTable("bookings")
          .set({ ticketing_status: "in_progress", ticketing_last_attempt_at: at })
          .where("id", "=", booking.id)
          .execute(),
      );
    await claimAt(new Date());
    const etag = await etagOf(owner, booking.id);
    stripe.reset();
    stub.clearRequests();
    const body = { reasonCode: "other", reason: "Customer changed their mind" };

    const issue = await owner.issue(booking.id, etag, {});
    expect(answer(issue)).toEqual([409, "BOOKING_NOT_MODIFIABLE"]);
    expectResponseToMatch("consoleIssueBooking", issue);
    expect(issue.body.error.details).toMatchObject({ reason: "ticketing_in_progress" });
    const cancel = await owner.cancel(booking.id, etag, body);
    expect(answer(cancel)).toEqual([409, "BOOKING_NOT_MODIFIABLE"]);
    expectResponseToMatch("consoleCancelBooking", cancel);
    expect(cancel.body.error.details).toMatchObject({ reason: "ticketing_in_progress" });
    // Nothing read, sent, captured or voided while the claim holds the booking.
    expect(stub.requests()).toEqual([]);
    expect(stripeRequestsAbout(payment.intentId)).toEqual([]);
    expect(await paymentRow(payment.id)).toMatchObject({ status: "authorized" });

    // A claim abandoned 5 minutes ago or more no longer holds the booking: the staff cancel it.
    await claimAt(new Date(Date.now() - 6 * MINUTE));
    const cancelled = await owner.cancel(booking.id, await etagOf(owner, booking.id), body);
    expect(answer(cancelled)).toEqual([200, undefined]);
    expect(await paymentRow(payment.id)).toMatchObject({ status: "canceled" });
  });

  it("answers the airline's refusal with 422 SUPPLIER_REJECTED and changes nothing but the version", async () => {
    const agent = await staff("agent");
    const booking = await seedBooking("cancel.refused", { ticketed: true });
    const payment = await seedPayment(booking.id, "captured");
    const etag = await etagOf(agent, booking.id);
    nextCallWith("cancelFlightOrder", "cancel-refused");

    const res = await agent.cancel(booking.id, etag, {
      reasonCode: "customer_request",
      reason: "Customer asked; outside the void window",
      refund: { mode: "full" },
    });

    expect(answer(res)).toEqual([422, "SUPPLIER_REJECTED"]);
    expectResponseToMatch("consoleCancelBooking", res);
    expect(await bookingRow(booking.id)).toMatchObject({ status: "ticketed", cancelled_by: null });
    expect(await refundsOf(booking.id)).toEqual([]);
    expect(await paymentRow(payment.id)).toMatchObject({ status: "captured" });
    expect((await staffActionsOf(booking.id)).map((action) => [action.action, action.outcome])).toEqual([
      ["bookings.cancel", "failed"],
    ]);
  });

  it("flags a DELETE without an answer (504), lets the worker decide it, and answers the same key with the booking", async () => {
    const agent = await staff("agent");
    const booking = await seedBooking("cancel.timeout", { ticketed: true });
    const payment = await seedPayment(booking.id, "captured");
    const etag = await etagOf(agent, booking.id);
    // The stub cancels the order, then answers 504.
    nextCallWith("cancelFlightOrder", "timeout");
    const key = randomUUID();
    const body = { reasonCode: "fraud", reason: "Card reported stolen", refund: { mode: "full" } };

    const timedOut = await agent.cancel(booking.id, etag, body, key);
    expect(answer(timedOut)).toEqual([504, "SUPPLIER_TIMEOUT"]);
    expect(timedOut.body.error.details).toMatchObject({ bookingId: booking.id });
    const pending = await agent.cancel(booking.id, etag, body, key);
    expect(answer(pending)).toEqual([504, "SUPPLIER_TIMEOUT"]);
    expect(pending.body.error.details).toMatchObject({ replayed: true });
    expect(await refundsOf(booking.id)).toEqual([]);

    // The payments consumer waits while the check records the refund and the replay reads it (`pending`).
    const paymentsWorker = worker.get(PaymentsProcessor, { strict: false }).worker;
    await paymentsWorker.pause();
    let check: Job;
    let replayed: Response;
    try {
      check = await runCheck(booking.id);
      replayed = await agent.cancel(booking.id, etag, body, key);
    } finally {
      paymentsWorker.resume();
    }
    expect(check.returnvalue).toMatchObject({ outcome: "cancelled" });
    expect(answer(replayed)).toEqual([200, undefined]);
    expectResponseToMatch("consoleCancelBooking", replayed);
    expect(replayed.body).toMatchObject({
      status: "cancelled",
      cancellation: { cancelledBy: "staff", reasonCode: "fraud", refundStatus: "pending" },
    });
    // The worker recorded the staff's cancellation with its full refund, once.
    expect(await bookingRow(booking.id)).toMatchObject({
      cancelled_by: "staff",
      cancel_reason: "fraud: Card reported stolen",
    });
    expect(await refundsOf(booking.id)).toEqual([
      expect.objectContaining({
        payment_id: payment.id,
        amount: TOTAL,
        reason: "fraud",
        requested_by_type: "staff",
        requested_by_id: agent.member.staffId,
      }),
    ]);
    expect(amadeusCalls("cancelFlightOrder")).toHaveLength(1);
  });

  it("cancels a booking whose order Amadeus no longer has, with a warning", async () => {
    const owner = await staff("owner");
    const booking = await seedBooking("cancel.gone");
    // Cancelled at the airline outside Velexis (the stub answers 404 from now on).
    const cancelled = await fetch(
      `${stub.url}/v1/booking/flight-orders/${encodeURIComponent(booking.orderId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${await stubToken()}` } },
    );
    expect(cancelled.status).toBe(204);

    const res = await owner.cancel(booking.id, await etagOf(owner, booking.id), {
      reasonCode: "airline_request",
      reason: "Cancelled at the airline by phone",
    });

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleCancelBooking", res);
    expect(res.body).toMatchObject({ status: "cancelled", warnings: [ORDER_GONE_WARNING] });
    expect(
      (await eventsOf(booking.id)).find((event) => event.type === "booking.cancelled")?.data,
    ).toMatchObject({
      cause: "order_not_found",
    });
  });
});

describe("console.bookings.cancel: the departure rule and the release's requester (FIX-W30-OTA)", () => {
  it("[FIX-W30-OTA AC3] shows canCancel false for a booking whose first flight departed but did not land, and refuses its cancellation with flown", async () => {
    const owner = await staff("owner");
    // Its flight left an hour ago and lands in an hour.
    const booking = await seedBooking("cancel.departed", { departInMs: -HOUR });
    await seedPayment(booking.id, "captured");

    const read = await owner.get(`${BOOKINGS}/${booking.id}`);
    expect(answer(read)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetBooking", read);
    expect(read.body.consoleActions).toMatchObject({
      canCancel: false,
      canPatch: true,
      reasons: { canCancel: "flown" },
    });
    stub.clearRequests();
    const res = await owner.cancel(booking.id, read.headers["etag"] as string, {
      reasonCode: "customer_request",
      reason: "Customer asked after take-off",
    });

    expect(answer(res)).toEqual([409, "BOOKING_NOT_MODIFIABLE"]);
    expectResponseToMatch("consoleCancelBooking", res);
    expect(res.body.error.details).toMatchObject({ reason: "flown" });
    expect(amadeusCalls("cancelFlightOrder")).toEqual([]);
    expect(await bookingRow(booking.id)).toMatchObject({ status: "confirmed" });
  });

  it("[FIX-W30-OTA AC7] records the release that a capture retry makes as asked for by the staff member who cancelled", async () => {
    const agent = await staff("agent");
    const booking = await seedBooking("cancel.net_staff");
    const payment = await seedPayment(booking.id, "authorized");
    const etag = await etagOf(agent, booking.id);
    stripe.reset();
    // The API stops between the record step's commit and the capture of the kept amount (simulated): the capture is
    // left to the record step's safety net, `payment.capture_retry` of the payments queue.
    const recorder = api.app.get(CancellationRecorder, { strict: false });
    const crash = vi
      .spyOn(recorder, "settleAuthorisation")
      .mockRejectedValue(new Error("the process stopped before the Stripe call (simulated)"));
    let res: Response;
    try {
      res = await agent.cancel(booking.id, etag, {
        reasonCode: "customer_request",
        reason: "Customer called; the change fee is kept",
        refund: { mode: "amount", amount: { amount: "100.47", currency: "EUR" } },
      });
    } finally {
      crash.mockRestore();
    }
    expect(res.status).toBe(500);
    expect(stripeRequestsAbout(payment.intentId)).toEqual([]);

    const net = await runDelayedPaymentJob(worker, paymentsQueue, `capture-retry-cancellation-${payment.id}`);

    expect(net).toEqual({ state: "completed", returnvalue: expect.objectContaining({ outcome: "applied" }) });
    expect(await paymentRow(payment.id)).toMatchObject({ status: "captured", amount_captured: "25.00" });
    expect(await refundsOf(booking.id)).toEqual([
      expect.objectContaining({
        status: "succeeded",
        amount: "100.47",
        reason: "customer_request",
        requested_by_type: "staff",
        requested_by_id: agent.member.staffId,
      }),
    ]);
  });
});

describe("the ticketing claims while a staff cancellation is undecided (FIX-W31-OTA)", () => {
  let ticketingQueue: Queue;
  /** The minute buckets of this block's ticketing jobs, one per run. */
  let bucket = minuteBucket(new Date()) + 20_000;

  /** Runs one ticketing attempt of the booking in the worker and answers how it ended (the job's return value). */
  async function runTicketing(bookingId: string): Promise<JsonObject> {
    bucket += 1;
    const job = ticketingJob(alphaId, bookingId, bucket);
    await ticketingQueue.add(job.name, job.data, job.opts);
    const done = await finished(ticketingQueue, job.opts.jobId);
    expect(await done.getState()).toBe("completed");
    return done.returnvalue as JsonObject;
  }

  /** A booking paid in full by Stripe whose issuance retry is due now (the ticketing job would claim it). */
  async function dueBooking(prefix: string): Promise<SeededBooking> {
    const booking = await seedBooking(prefix, { ticketingStatus: "failed" });
    await seedPayment(booking.id, "captured");
    await inTenant((trx) =>
      trx
        .updateTable("bookings")
        .set({
          ticketing_attempts: 1,
          ticketing_error_code: "TICKETING_FAILED",
          ticketing_next_attempt_at: new Date(Date.now() - MINUTE),
        })
        .where("id", "=", booking.id)
        .execute(),
    );
    return booking;
  }

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
    const spy = vi
      .spyOn(client, "cancelFlightOrder")
      .mockImplementationOnce(async (context, req, options) => {
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

  /** What the ticketing job and a staff issuance answered while the staff's DELETE was held. */
  interface Held {
    readonly claimedAt: Date | null;
    readonly job: JsonObject;
    readonly issue: Response;
    readonly cancelled: Response;
  }

  /** The owner cancels `booking`; while the DELETE is held, the ticketing job runs and the owner tries to issue. */
  async function cancelHeld(booking: SeededBooking, scenario?: string): Promise<Held> {
    const owner = await staff("owner");
    const etag = await etagOf(owner, booking.id);
    const held = holdNextDelete(scenario);
    try {
      const cancelling = owner
        .cancel(booking.id, etag, { reasonCode: "customer_request", reason: "Customer asked by phone" })
        .then((res) => res);
      await held.reached;
      stub.clearRequests();
      const claimedAt = await claimedAtOf(booking.id);
      const job = await runTicketing(booking.id);
      // The claim moved the version: the issuance is sent with the ETag of the booking as it is now.
      const issue = await owner.issue(booking.id, await etagOf(owner, booking.id), {});
      expect(amadeusCalls("issueFlightOrder")).toEqual([]);
      expect(amadeusCalls("getFlightOrder")).toEqual([]);
      held.pass();
      return { claimedAt, job, issue, cancelled: await cancelling };
    } finally {
      held.pass();
      held.spy.mockRestore();
    }
  }

  beforeAll(() => {
    ticketingQueue = worker.get<Queue>(getQueueToken(OTA_QUEUE.ticketing), { strict: false });
  });

  it("[FIX-W31-OTA AC1] holds the ticketing job and a staff issuance while the staff's DELETE is in flight, and treats the cancelled booking as before", async () => {
    const booking = await dueBooking("hold.cancelled");

    const held = await cancelHeld(booking);

    expect(held.claimedAt).toBeInstanceOf(Date);
    expect(held.job).toMatchObject({ outcome: "skipped", reason: "cancellation_pending" });
    expect(answer(held.issue)).toEqual([409, "BOOKING_NOT_MODIFIABLE"]);
    expectResponseToMatch("consoleIssueBooking", held.issue);
    expect(held.issue.body.error.details).toMatchObject({ reason: "cancellation_pending" });
    expect(answer(held.cancelled)).toEqual([200, undefined]);
    expect(await bookingRow(booking.id)).toMatchObject({ status: "cancelled", cancelled_by: "staff" });
    expect(await claimedAtOf(booking.id)).toBeNull();
    // After the outcome, as before: the job skips a cancelled booking and the staff cannot issue it.
    expect(await runTicketing(booking.id)).toMatchObject({ outcome: "skipped", reason: "not_confirmed" });
    const owner = await staff("owner");
    const issued = await owner.issue(booking.id, await etagOf(owner, booking.id), {});
    expect(answer(issued)).toEqual([409, "BOOKING_ALREADY_CANCELLED"]);
    expect(amadeusCalls("issueFlightOrder")).toEqual([]);
  });

  it("[FIX-W31-OTA AC1] lets the claims go on as before once the airline refused the staff's DELETE (not applied)", async () => {
    const booking = await dueBooking("hold.refused");

    const held = await cancelHeld(booking, "cancel-refused");

    expect(held.job).toMatchObject({ outcome: "skipped", reason: "cancellation_pending" });
    expect(held.issue.body.error.details).toMatchObject({ reason: "cancellation_pending" });
    expect(answer(held.cancelled)).toEqual([422, "SUPPLIER_REJECTED"]);
    // The refusal released the claim's marker: the order is live and the staff issue it.
    expect(await claimedAtOf(booking.id)).toBeNull();
    const owner = await staff("owner");
    const issued = await owner.issue(booking.id, await etagOf(owner, booking.id), {});
    expect(answer(issued)).toEqual([200, undefined]);
    expectResponseToMatch("consoleIssueBooking", issued);
    expect(await bookingRow(booking.id)).toMatchObject({ status: "ticketed", ticketing_status: "issued" });
  });

  it("[FIX-W31-OTA AC1] holds both while a staff DELETE without an answer is undecided, and lets them go on once the worker found the order active", async () => {
    const owner = await staff("owner");
    const booking = await dueBooking("hold.undecided");
    nextCallWith("cancelFlightOrder", "timeout-lost");
    const timedOut = await owner.cancel(booking.id, await etagOf(owner, booking.id), {
      reasonCode: "customer_request",
      reason: "Customer asked by phone",
    });
    expect(answer(timedOut)).toEqual([504, "SUPPLIER_TIMEOUT"]);
    // The flag took over from the claim's marker in its transaction.
    expect(await claimedAtOf(booking.id)).toBeNull();
    stub.clearRequests();

    expect(await runTicketing(booking.id)).toMatchObject({
      outcome: "skipped",
      reason: "cancellation_pending",
    });
    const refused = await owner.issue(booking.id, await etagOf(owner, booking.id), {});
    expect(answer(refused)).toEqual([409, "BOOKING_NOT_MODIFIABLE"]);
    expect(refused.body.error.details).toMatchObject({ reason: "cancellation_pending" });
    expect(amadeusCalls("issueFlightOrder")).toEqual([]);

    const check = await runCheck(booking.id);
    expect(check.returnvalue).toMatchObject({ outcome: "not_applied" });
    expect(await runTicketing(booking.id)).toMatchObject({ outcome: "ticketed", via: "issue" });
  });

  it("[FIX-W31-OTA AC1] refuses a staff issuance while a cancellation's claim is fresh, and issues once it is abandoned (5 minutes)", async () => {
    const owner = await staff("owner");
    const booking = await dueBooking("hold.abandoned");
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
    const refused = await owner.issue(booking.id, await etagOf(owner, booking.id), {});
    expect(answer(refused)).toEqual([409, "BOOKING_NOT_MODIFIABLE"]);
    expect(refused.body.error.details).toMatchObject({ reason: "cancellation_pending" });
    expect(stub.requests()).toEqual([]);

    // A request that stopped mid-DELETE left its marker: 5 minutes later it holds nothing back. The issuance reads the
    // order first, as always (an order the DELETE removed would answer 422 here, never be issued).
    await claimAt(new Date(Date.now() - 6 * MINUTE));
    const issued = await owner.issue(booking.id, await etagOf(owner, booking.id), {});
    expect(answer(issued)).toEqual([200, undefined]);
    expect(amadeusCalls("getFlightOrder").map((call) => call.status)).toEqual([200]);
    expect(amadeusCalls("issueFlightOrder").map((call) => call.status)).toEqual([200]);
  });
});
