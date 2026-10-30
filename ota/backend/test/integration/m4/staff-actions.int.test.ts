// The console audit across every console operation (OBE-075 step 2; ota/docs/scope.md OF-09 AC1, OADR-0011 point 8 as
// decided on 2026-10-21, flows/console-operations.md §3 step 7 and §6, console/staff-actions.writer.ts): every
// state-changing console call (its success, a failure of its use case and an idempotent replay) and every refused one
// (a permission denial, a request validation refusal, and the idempotency refusals: a missing and a reused
// `Idempotency-Key`) writes exactly one `staff_actions` row, with redacted before and after; every successful audited
// read (customer view, PNR lookup, order retrieve, the eight raw Amadeus reads) writes exactly one; every other
// successful read writes none, and a `429 RATE_LIMITED` writes none (a `rate_limit.exceeded` log line only).
//
// The file clones the @velexis/testing template (tenant_alpha provisioned) and writes alpha's platform rows as the
// platform does: an OTA in test on the Velexis test Amadeus account (the stub) with an office of its own, its Velexis
// test Stripe connection (a fake of the Stripe API, test/helpers/fake-stripe.ts), accounts and memberships. Staff sign
// in through the OTA admin's service key with portal tokens. Every booking points at an order created in the stub
// through its own HTTP API and is written as the record step writes it (the snapshot through the redactor, the
// traveller's passport sealed); payments as checkout.createPayment and the webhooks leave them, their PaymentIntents in
// the fake. The worker does not run: what the console calls queue stays queued.
//
// Each call's rows are read by its request id (`staff_actions.request_id`, the answer's `X-Request-Id`), so a call is
// judged by its own rows only. A success's row is its use case's (`booking.patch`, `settings.markupRules.create`, with
// the before and after); a replay's, a refusal's and a failure's are the audit interceptor's or the guard's, with the
// operation's SDK method as the action (`bookings.patch`). The issuance here is of an unpaid booking (`allowUnpaid`):
// one that captures a payment first writes the capture's own `payment.capture` row next to `booking.issue` (OBE-063,
// flows/console-operations.md §3 step 8). The calls run in `beforeAll` hooks with budgets of their own; the tests read what they
// answered and wrote. Names, documents, keys and tokens are made up per run; none is a secret.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { otaOperations, type ApiOperation, type OtaOperationId } from "@velexis/api-types/operations";
import { encryptValue, sha256Hex, type KeyProvider } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
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
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { orderSegmentsOf } from "../../../src/bookings/order-diff";
import { BookingTravelerDocuments, readCreatedOrder } from "../../../src/bookings/order-recorder";
import { buildCreateOrderRequest } from "../../../src/bookings/order-request.builder";
import type { StoredDocument } from "../../../src/checkout/traveler-documents";
import { loadOpenApiDocument } from "../../../src/common/http/openapi-validation.interceptor";
import { PENDING_OPERATIONS } from "../../../src/common/http/pending-operations";
import { trackerDigest } from "../../../src/common/http/rate-limits";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { buildOrderRequestInput, buildStoredPassport, pricedFlightOffer } from "../../builders/bookings";
import { buildPng } from "../../builders/images";
import { journeyAmadeusLimitsModule } from "../../helpers/amadeus-limits";
import { testApiCredentials, testKeyProvider } from "../../helpers/api-env";
import { startFakeStripe, stripeEndpointModule, type FakeStripe } from "../../helpers/fake-stripe";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type JsonObject = Record<string, unknown>;
type Role = "owner" | "admin" | "agent" | "finance" | "viewer";
type Method = "get" | "post" | "put" | "patch" | "delete";

const SCHEMA = "tenant_alpha" as TenantSchema;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BOOKINGS = "/v1/console/bookings";
const SETTINGS = "/v1/console/settings";
const PAYMENTS = "/v1/console/payments";
const RAW = "/v1/console/amadeus";
/** The template the template calls change, in the storefront's default locale. */
const TEMPLATE = `${SETTINGS}/notification-templates/booking.cancelled/email/en`;

/**
 * Cloning the template, starting the stub, the fake Stripe API and the API's graph (it parses the OTA document), the
 * sign-ins and compiling the response validators of the console operations: a few seconds alone, much longer on a busy
 * 4-CPU runner. The bound only stops a start-up that hangs.
 */
const SETUP_TIMEOUT_MS = Math.max(OPENAPI_SETUP_TIMEOUT_MS, 120_000);
/** The calls of the audit table: about two hundred, a few of them to the stub; the bound only stops a run that hangs. */
const CALLS_TIMEOUT_MS = 120_000;

/** This run's Velexis test keys: Stripe's shapes, random, never a committed value. */
const SECRET_KEY = `sk_test_${randomBytes(20).toString("hex")}`;
const PUBLISHABLE_KEY = `pk_test_${randomBytes(20).toString("hex")}`;
/** A passport number a staff member enters as a form of identification: made up per run, never stored in full. */
const IDENTIFICATION_NUMBER = `PX${randomInt(10_000_000, 99_999_999)}`;

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let stub: AmadeusStub;
let stripe: FakeStripe;
let keys: KeyProvider;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let alphaId: string;
let office: string;
let paymentConnectionId: string;
let stubCredentials: { readonly clientId: string; readonly clientSecret: string };

const inTenant = <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, SCHEMA, run);

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
      base_url: "https://test.travel.api.amadeus.com",
      client_id: stubCredentials.clientId,
      client_secret_ciphertext: ciphertext,
      encryption_key_id: kekId,
      status: "active",
    })
    .execute();
  return id;
}

/** The active test tenant alpha with its Amadeus connection (the stub) and its Velexis test Stripe connection. */
async function insertTenant(amadeusAccountId: string): Promise<void> {
  alphaId = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id: alphaId, key: "alpha", name: "Alpha Travel", status: "active", plan_code: "early_access" })
    .execute();
  await migrator
    .insertInto("platform.supplier_connections")
    .values({
      id: newId("sc"),
      tenant_id: alphaId,
      environment: "test",
      credential_source: "velexis",
      amadeus_account_id: amadeusAccountId,
      office_ids: [office],
      default_office_id: office,
      queuing_office_id: office,
      owner_office_id: office,
      status: "active",
    })
    .execute();
  paymentConnectionId = newId("ppc");
  await migrator
    .insertInto("platform.payment_provider_connections")
    .values({
      id: paymentConnectionId,
      tenant_id: alphaId,
      provider: "stripe",
      environment: "test",
      account_mode: "velexis",
      capture_mode: "manual",
      is_default: true,
      status: "active",
    })
    .execute();
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

// ---- The OTA admin -------------------------------------------------------------------------------------------------

/** What a call sends besides the OTA admin's headers. */
interface Sent {
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** A `multipart/form-data` body (the asset upload): its `kind` and its file. */
  readonly multipart?: { readonly kind: string; readonly file: Buffer; readonly fileName: string };
}

let ipCounter = 0;

/** A staff member signed in through the OTA admin (its service key, the staff member's IP, the test environment). */
class AdminSession {
  readonly ip: string;
  readonly userAgent = `Mozilla/5.0 (OTA admin audit ${randomBytes(3).toString("hex")})`;
  accessToken = "";
  refreshToken = "";
  familyId = "";
  signIn: Response | undefined;

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

  async open(): Promise<this> {
    const res = await request(api.server)
      .post("/v1/console/auth/sign-in")
      .set({ ...this.headers(), "Idempotency-Key": randomUUID() })
      .send({ grantType: "portal_token", portalToken: await portalTokenFor(this.member) });
    expect([res.status, res.body.error?.code]).toEqual([200, undefined]);
    this.signIn = res;
    const session = res.body.session as { accessToken: string; refreshToken: string };
    this.accessToken = session.accessToken;
    this.refreshToken = session.refreshToken;
    const [, payload = ""] = session.accessToken.split(".");
    this.familyId = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sid: string }).sid;
    return this;
  }

  /** A console call with the OTA admin's headers and `sent`. */
  send(method: Method, path: string, sent: Sent = {}): Promise<Response> {
    const req = request(api.server)
      [method](path)
      .set({ ...this.headers(), ...sent.headers });
    if (sent.multipart !== undefined) {
      return req
        .field("kind", sent.multipart.kind)
        .attach("file", sent.multipart.file, { filename: sent.multipart.fileName, contentType: "image/png" })
        .then();
    }
    return sent.body === undefined ? req.then() : req.send(sent.body as object).then();
  }
}

async function staffSession(role: Role): Promise<AdminSession> {
  return await new AdminSession(await insertMember(role)).open();
}

// ---- Amadeus stub orders and the bookings of them ------------------------------------------------------------------

const local = (date: Date): string => date.toISOString().slice(0, 19);
const records = (value: unknown): JsonObject[] =>
  Array.isArray(value)
    ? value.filter((item): item is JsonObject => typeof item === "object" && item !== null)
    : [];

async function stubToken(): Promise<string> {
  const res = await fetch(`${stub.url}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: stubCredentials.clientId,
      client_secret: stubCredentials.clientSecret,
    }).toString(),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

/** An order created in the stub, as a GDS terminal would create it, with the passport it holds. */
interface StubOrder {
  readonly data: JsonObject;
  readonly id: string;
  readonly recordLocator: string;
  readonly passport: StoredDocument;
}

/** An order of the stub (not issued) of one adult with a fresh passport, its flight 10 days after now, for alpha. */
async function newStubOrder(): Promise<StubOrder> {
  const departure = new Date(Math.floor((Date.now() + 10 * DAY) / MINUTE) * MINUTE);
  const offer = pricedFlightOffer();
  for (const itinerary of offer["itineraries"] as JsonObject[]) {
    for (const segment of itinerary["segments"] as JsonObject[]) {
      (segment["departure"] as JsonObject)["at"] = local(departure);
      (segment["arrival"] as JsonObject)["at"] = local(new Date(departure.getTime() + 125 * MINUTE));
    }
  }
  const input = buildOrderRequestInput({ flightOffers: [offer] });
  const traveler = input.travelers[0];
  if (traveler === undefined) {
    throw new Error("the order request builder has no traveller");
  }
  const passport = buildStoredPassport();
  const built = buildCreateOrderRequest({
    ...input,
    travelers: [{ ...traveler, documents: [passport] }],
    offices: { queuing: office, owner: office },
  });
  const res = await fetch(`${stub.url}/v1/booking/flight-orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await stubToken()}`, "Content-Type": "application/vnd.amadeus+json" },
    body: JSON.stringify(built.body),
  });
  expect(res.status).toBe(201);
  const data = ((await res.json()) as { data: JsonObject }).data;
  return {
    data,
    id: data["id"] as string,
    recordLocator: (records(data["associatedRecords"])[0]?.["reference"] as string | undefined) ?? "",
    passport,
  };
}

/**
 * A booking of `order` as the record step writes it: the bookings row (net 98.47 + markup 12.00 = 110.47 EUR), the
 * order's flight, the adult with the order's passport sealed, the order's contact and its record; confirmed, its
 * issuance left to the staff (`manual_review`), unpaid.
 */
async function seedBooking(order: StubOrder): Promise<string> {
  const id = newId("bkg");
  const now = Date.now();
  const created = readCreatedOrder({ data: order.data });
  if (created === undefined) {
    throw new Error("the stub's order cannot be read");
  }
  const segments = orderSegmentsOf(created);
  const outbound = new Date(`${segments[0]?.departureLocal ?? local(new Date(now + 10 * DAY))}Z`);
  const contact = records(order.data["contacts"])[0] ?? {};
  const travelerRowId = newId("btr");
  const sealed = await api.app
    .get(BookingTravelerDocuments, { strict: false })
    .seal(SCHEMA, travelerRowId, [order.passport], []);
  await inTenant(async (trx) => {
    await trx
      .insertInto("bookings")
      .values({
        id,
        environment: "test",
        reference: newBookingReference(),
        channel: "storefront",
        status: "confirmed",
        ticketing_status: "manual_review",
        amadeus_order_id: order.id,
        record_locator: order.recordLocator,
        origin_system_code: "GDS",
        owner_office_id: office,
        queuing_office_id: office,
        trip_type: "one_way",
        origin_iata: "MAD",
        destination_iata: "ORY",
        first_departure_at: outbound,
        last_arrival_at: new Date(outbound.getTime() + 125 * MINUTE),
        validating_carrier: "IB",
        travelers_count: 1,
        currency: "EUR",
        net_amount: "98.47",
        net_base_amount: "56.00",
        net_fees_amount: "0.00",
        net_services_amount: "0.00",
        markup_amount: "12.00",
        taxes_amount: "42.47",
        total_amount: "110.47",
        contact_email: contact["emailAddress"] as string,
        lead_last_name: "SAMPLE",
        order_snapshot: JSON.stringify(redactPayload(order.data)),
        last_synced_at: new Date(now - HOUR),
        created_at: new Date(now - DAY),
      })
      .execute();
    await trx
      .insertInto("booking_segments")
      .values(
        segments.map((segment) => ({
          id: newId("seg"),
          booking_id: id,
          amadeus_flight_offer_id: segment.amadeusFlightOfferId,
          amadeus_segment_id: segment.amadeusSegmentId,
          itinerary_index: segment.itineraryIndex,
          segment_index: segment.segmentIndex,
          carrier_code: segment.carrierCode,
          flight_number: segment.flightNumber,
          operating_carrier_code: segment.operatingCarrierCode,
          aircraft_code: segment.aircraftCode,
          departure_iata: segment.departureIata,
          departure_terminal: segment.departureTerminal,
          departure_local: segment.departureLocal,
          departure_at: new Date(`${segment.departureLocal}Z`),
          arrival_iata: segment.arrivalIata,
          arrival_terminal: segment.arrivalTerminal,
          arrival_local: segment.arrivalLocal,
          arrival_at: new Date(`${segment.arrivalLocal}Z`),
          duration_minutes: segment.durationMinutes,
          cabin: segment.cabin,
          booking_class: segment.bookingClass,
          fare_basis: segment.fareBasis,
          ...(segment.status === null ? {} : { status: segment.status }),
        })),
      )
      .execute();
    await trx
      .insertInto("booking_travelers")
      .values({
        id: travelerRowId,
        booking_id: id,
        amadeus_traveler_id: "1",
        traveler_type: "ADULT",
        first_name: "TESTAA",
        last_name: "SAMPLE",
        date_of_birth: "1988-04-12",
        gender: "FEMALE",
        documents_ciphertext: sealed.documentsCiphertext,
        encryption_key_id: sealed.encryptionKeyId,
        document_type: "PASSPORT",
        document_last4: order.passport.number.slice(-4),
        document_expiry_date: order.passport.expiryDate ?? null,
      })
      .execute();
    await trx
      .insertInto("booking_contacts")
      .values({
        id: newId("bco"),
        booking_id: id,
        purpose: "STANDARD",
        is_primary: true,
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
        reference: order.recordLocator,
        origin_system_code: "GDS",
        flight_offer_id: "2",
        is_primary: true,
      })
      .execute();
  });
  return id;
}

/** A booking of alpha without an order, which waits for its money (the payments' booking). */
async function seedPaymentBooking(): Promise<string> {
  const id = newId("bkg");
  const departure = new Date(Date.now() + 30 * DAY);
  await inTenant((trx) =>
    trx
      .insertInto("bookings")
      .values({
        id,
        environment: "test",
        reference: newBookingReference(),
        status: "confirmed",
        ticketing_status: "manual_review",
        trip_type: "one_way",
        origin_iata: "MAD",
        destination_iata: "ORY",
        first_departure_at: departure,
        last_arrival_at: new Date(departure.getTime() + 3 * HOUR),
        currency: "EUR",
        net_amount: "400.00",
        total_amount: "452.10",
        contact_email: `${id.toLowerCase()}@example.com`,
        lead_last_name: "SAMPLE",
      })
      .execute(),
  );
  return id;
}

/** A fresh Stripe-shaped id of this run (`pi_test_…`). */
const stripeId = (prefix: string): string => `${prefix}_test_${randomBytes(10).toString("hex")}`;

/**
 * A card payment of 452.10 EUR of `bookingId`, `authorized` (its PaymentIntent waiting for its capture) or `captured`,
 * as checkout.createPayment and the webhooks leave it, with its PaymentIntent in the fake.
 */
async function seedPayment(bookingId: string, status: "authorized" | "captured"): Promise<string> {
  const id = newId("pay");
  const intentId = stripeId("pi");
  const captured = status === "captured";
  await inTenant((trx) =>
    trx
      .insertInto("payments")
      .values({
        id,
        environment: "test",
        booking_id: bookingId,
        provider: "stripe",
        provider_connection_id: paymentConnectionId,
        provider_payment_id: intentId,
        method: "card",
        capture_method: "manual",
        currency: "EUR",
        amount: "452.10",
        amount_authorized: "452.10",
        amount_captured: captured ? "452.10" : "0",
        amount_refunded: "0",
        status,
        card_brand: "VISA",
        card_last4: "4242",
        authorized_at: new Date(Date.now() - DAY),
        captured_at: captured ? new Date(Date.now() - HOUR) : null,
        three_ds: JSON.stringify({ required: false, status: "not_required", version: null }),
        metadata: JSON.stringify({}),
        version: 1,
      })
      .execute(),
  );
  stripe.intents.set(intentId, {
    id: intentId,
    object: "payment_intent",
    status: captured ? "succeeded" : "requires_capture",
    amount: 45210,
    amount_capturable: captured ? 0 : 45210,
    amount_received: captured ? 45210 : 0,
    currency: "eur",
    capture_method: "manual",
    client_secret: `${intentId}_secret_${randomBytes(8).toString("hex")}`,
    metadata: { velexis_tenant_id: alphaId, velexis_environment: "test", payment_id: id },
    payment_method: {
      id: stripeId("pm"),
      object: "payment_method",
      card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 },
    },
    latest_charge: captured ? stripeId("ch") : null,
    last_payment_error: null,
    livemode: false,
  });
  return id;
}

/** A customer of alpha (the one console.customers.get shows). */
async function seedCustomer(): Promise<string> {
  const id = newId("cus");
  await inTenant((trx) =>
    trx
      .insertInto("customers")
      .values({
        id,
        email: `${id.toLowerCase()}@example.com`,
        email_verified_at: new Date(),
        first_name: "Anna",
        last_name: "Berg",
      })
      .execute(),
  );
  return id;
}

// ---- Bodies --------------------------------------------------------------------------------------------------------

const dayFromNow = (days: number): string => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

/** A markup rule's body (the document's `longHaul` example). */
const MARKUP_RULE = {
  name: "Long-haul economy",
  scope: { originCountries: ["FR"], cabins: ["ECONOMY"], minNet: "400.00" },
  calculation: "percentage",
  percentage: "4.0000",
  appliesPer: "traveler",
  min: { amount: "15.00", currency: "EUR" },
  priority: 100,
};

/** A fee rule's body. */
const FEE_RULE = {
  name: "Service fee",
  label: "Service fee",
  feeType: "booking_service",
  scope: {},
  calculation: "fixed",
  fixed: { amount: "10.00", currency: "EUR" },
};

/** A validity window that ends before it starts: the schema takes it, the rule's own check refuses it. */
const BACKWARDS_WINDOW = {
  activeFrom: new Date(Date.now() + 2 * DAY).toISOString(),
  activeUntil: new Date(Date.now() + DAY).toISOString(),
};

/** A content page's body. */
const pageBody = (slug: string) => ({
  slug,
  locale: "en",
  title: "Baggage rules",
  bodyMarkdown: "## Baggage\n\n- One cabin bag per traveller",
  isPublished: false,
});

/** A Flight Offers Search POST body (getFlightOffersQuery), Madrid to Paris a month from now. */
const searchQuery = (): JsonObject => ({
  currencyCode: "EUR",
  originDestinations: [
    {
      id: "1",
      originLocationCode: "MAD",
      destinationLocationCode: "PAR",
      departureDateTimeRange: { date: dayFromNow(30) },
    },
  ],
  travelers: [{ id: "1", travelerType: "ADULT" }],
  sources: ["GDS"],
});

// ---- What the calls answered and wrote ------------------------------------------------------------------------------

/** What one call is in the audit table. */
type Kind =
  | "success"
  | "replay"
  | "failure"
  | "denied"
  | "validation"
  | "missing key"
  | "reused key"
  | "audited read"
  | "read"
  | "rate limited";

/** One call: what it was, who made it, its answer, and what the test expects of it. */
interface Call {
  readonly kind: Kind;
  readonly operationId: OtaOperationId;
  readonly session: AdminSession;
  readonly res: Response;
  /** The `[status, error code]` expected. */
  readonly answer: readonly [number, string | undefined];
  /** The action and outcome of its one row; `null`: no row at all. */
  readonly row: { readonly action: string; readonly outcome: "succeeded" | "failed" | "denied" } | null;
}

const calls: Call[] = [];
/** The tenant's `staff_actions` rows after every call, by request id. */
const rowsByRequest = new Map<string, Array<Record<string, unknown>>>();
let allRows: Array<Record<string, unknown>> = [];
/** The values no row may hold. */
const secrets: string[] = [];
/** The patch's row, which must show the form of identification's number by its last 4 only. */
let identificationRow: Record<string, unknown> | undefined;

const requestIdOf = (res: Response): string => String(res.headers["x-request-id"]);
const rowsOf = (res: Response): Array<Record<string, unknown>> => rowsByRequest.get(requestIdOf(res)) ?? [];
const answerOf = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

/** The console operations served (not pending) whose permission the permission guard checks. */
const GUARDED: readonly ApiOperation<OtaOperationId>[] = otaOperations.filter(
  (operation) =>
    operation.scope === "console" &&
    !Object.hasOwn(PENDING_OPERATIONS, operation.operationId) &&
    operation.permission !== "none",
);
const isRead = (operation: ApiOperation<OtaOperationId>): boolean =>
  /:read$/.test(String(operation.permission));
/** The state-changing console operations: a permission that is not a read permission. */
const CHANGES = GUARDED.filter((operation) => !isRead(operation));
/** The reads that opt in to the audit (`@AuditedRead`), with the action of their row (OADR-0011 point 8). */
const AUDITED_READS: Readonly<Partial<Record<OtaOperationId, string>>> = {
  consoleGetCustomer: "customer.view",
  consoleFindBookingByRecordLocator: "pnr.lookup",
  consoleRetrieveFlightOrder: "order.retrieve",
  consoleAmadeusSearchFlightOffers: "amadeus.searchFlightOffers",
  consoleAmadeusGetFlightOffers: "amadeus.getFlightOffers",
  consoleAmadeusSearchFlightAvailabilities: "amadeus.searchFlightAvailabilities",
  consoleAmadeusUpsellAirOffers: "amadeus.upsellAirOffers",
  consoleAmadeusQuoteAirOffers: "amadeus.quoteAirOffers",
  consoleAmadeusGetFlightOrder: "amadeus.getFlightOrder",
  consoleAmadeusGetFlightOrderByReference: "amadeus.getFlightOrderByReference",
  consoleAmadeusGetQueue: "amadeus.getQueue",
};
/** The reads that do not: every other console read, and the staff-session reads and calls. */
const PLAIN_READS = [
  ...GUARDED.filter((operation) => isRead(operation) && AUDITED_READS[operation.operationId] === undefined),
  ...otaOperations.filter((operation) =>
    ["consoleGetMe", "consoleRefreshSession", "consoleSignOut"].includes(operation.operationId),
  ),
];

/** Whether the document requires an `Idempotency-Key` on `operationId`. */
const takesIdempotencyKey = new Set<OtaOperationId>();

let owner: AdminSession;
let viewer: AdminSession;
let agent: AdminSession;

/** Sends `method path` for `session` and keeps the call with what is expected of it. */
async function call(
  kind: Kind,
  operationId: OtaOperationId,
  session: AdminSession,
  method: Method,
  path: string,
  sent: Sent,
  answer: readonly [number, string | undefined],
  row: Call["row"],
): Promise<Response> {
  const res = await session.send(method, path, sent);
  calls.push({ kind, operationId, session, res, answer, row });
  return res;
}

/** A new `Idempotency-Key` header. */
const newKey = (): Record<string, string> => ({ "Idempotency-Key": randomUUID() });

// Cloning the template, starting the stub, the fake Stripe API and the API's graph, the sign-ins and compiling the
// response validators of the console operations: all of it happens once here, with its own budget.
beforeAll(async () => {
  preloadOpenApiDocument();
  const checker = responseChecker("ota");
  for (const operation of [...GUARDED, ...PLAIN_READS]) {
    for (const status of [200, 201, 204, 400, 403, 404, 409, 412, 422, 429]) {
      checker.check(operation.operationId, { status, body: {} });
    }
  }
  const document = loadOpenApiDocument().document as JsonObject;
  for (const operation of CHANGES) {
    const item = (document["paths"] as Record<string, JsonObject>)[operation.path] ?? {};
    const parameters = ((item[operation.method] as JsonObject | undefined)?.["parameters"] ??
      []) as JsonObject[];
    if (parameters.some((parameter) => parameter["$ref"] === "#/components/parameters/IdempotencyKey")) {
      takesIdempotencyKey.add(operation.operationId);
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
  stub = await startAmadeusStub({ credentials: stubCredentials });
  await insertTenant(await insertAmadeusAccount());
  await inTenant(async (trx) => {
    await seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" });
    await seedDefaultMarkupRule(trx);
  });
  api = await createTestApp({
    database: db,
    redis,
    imports: [stripeEndpointModule(stripe.endpoint), journeyAmadeusLimitsModule()],
    env: {
      AMADEUS_BASE_URL_TEST: stub.url,
      STRIPE_SECRET_KEY_TEST: SECRET_KEY,
      STRIPE_PUBLISHABLE_KEY_TEST: PUBLISHABLE_KEY,
    },
  });
  [owner, viewer, agent] = [
    await staffSession("owner"),
    await staffSession("viewer"),
    await staffSession("agent"),
  ];
  secrets.push(
    testApiCredentials().serviceKey,
    SECRET_KEY,
    PUBLISHABLE_KEY,
    IDENTIFICATION_NUMBER,
    ...[owner, viewer, agent].flatMap((session) => [session.accessToken, session.refreshToken]),
  );
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await stub?.stop();
  await stripe?.close();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

// The state-changing calls: for each operation its success, a failure of its use case, an idempotent replay and the
// refusals (a denied call, a validation refusal, a missing and a reused key where the operation takes one).
beforeAll(async () => {
  const ok = (status: number): readonly [number, undefined] => [status, undefined];
  const succeeded = (action: string) => ({ action, outcome: "succeeded" as const });
  const failed = (action: string) => ({ action, outcome: "failed" as const });
  const denied = (action: string) => ({ action, outcome: "denied" as const });

  // ---- console.bookings.patch, resync, addNote (one booking), issue and cancel (one booking each) ----
  const patchOrder = await newStubOrder();
  const patchBooking = await seedBooking(patchOrder);
  secrets.push(patchOrder.passport.number);
  const patched = await call(
    "success",
    "consolePatchBooking",
    owner,
    "patch",
    `${BOOKINGS}/${patchBooking}`,
    {
      headers: { "If-Match": '"1"' },
      body: {
        formOfIdentifications: [
          {
            identificationType: "PASSPORT",
            carrierCode: "IB",
            number: IDENTIFICATION_NUMBER,
            travelerIds: ["1"],
          },
        ],
        reason: "Passport as form of identification",
      },
    },
    ok(200),
    succeeded("booking.patch"),
  );
  // The stale ETag: the patch moved the version.
  await call(
    "failure",
    "consolePatchBooking",
    owner,
    "patch",
    `${BOOKINGS}/${patchBooking}`,
    { headers: { "If-Match": '"1"' }, body: { tags: ["corporate"] } },
    [412, "PRECONDITION_FAILED"],
    failed("bookings.patch"),
  );
  await call(
    "validation",
    "consolePatchBooking",
    owner,
    "patch",
    `${BOOKINGS}/${patchBooking}`,
    { headers: { "If-Match": String(patched.headers["etag"]) }, body: {} },
    [400, "VALIDATION_FAILED"],
    failed("bookings.patch"),
  );
  await call(
    "denied",
    "consolePatchBooking",
    viewer,
    "patch",
    `${BOOKINGS}/${patchBooking}`,
    { headers: { "If-Match": String(patched.headers["etag"]) }, body: { tags: ["corporate"] } },
    [403, "FORBIDDEN"],
    denied("bookings.patch"),
  );

  // A booking of its own, last synchronised an hour ago: the patch's booking was synchronised a moment ago, which the
  // console's resync throttle (10 s) refuses.
  const resyncBooking = await seedBooking(await newStubOrder());
  await call(
    "success",
    "consoleResyncBooking",
    owner,
    "post",
    `${BOOKINGS}/${resyncBooking}/resync`,
    { body: {} },
    ok(200),
    succeeded("booking.resync"),
  );
  await call(
    "failure",
    "consoleResyncBooking",
    owner,
    "post",
    `${BOOKINGS}/${newId("bkg")}/resync`,
    { body: {} },
    [404, "NOT_FOUND"],
    failed("bookings.resync"),
  );
  await call(
    "validation",
    "consoleResyncBooking",
    owner,
    "post",
    `${BOOKINGS}/${resyncBooking}/resync`,
    { body: { include: ["seats"] } },
    [400, "VALIDATION_FAILED"],
    failed("bookings.resync"),
  );
  await call(
    "denied",
    "consoleResyncBooking",
    viewer,
    "post",
    `${BOOKINGS}/${resyncBooking}/resync`,
    { body: {} },
    [403, "FORBIDDEN"],
    denied("bookings.resync"),
  );

  const noteKey = newKey();
  const note = { text: "Customer asked for a window seat" };
  await call(
    "success",
    "consoleAddBookingNote",
    owner,
    "post",
    `${BOOKINGS}/${patchBooking}/notes`,
    { headers: noteKey, body: note },
    ok(201),
    succeeded("booking.note"),
  );
  await call(
    "replay",
    "consoleAddBookingNote",
    owner,
    "post",
    `${BOOKINGS}/${patchBooking}/notes`,
    { headers: noteKey, body: note },
    ok(201),
    succeeded("bookings.addNote"),
  );
  await call(
    "reused key",
    "consoleAddBookingNote",
    owner,
    "post",
    `${BOOKINGS}/${patchBooking}/notes`,
    { headers: noteKey, body: { text: "Another note" } },
    [409, "IDEMPOTENCY_KEY_REUSED"],
    failed("bookings.addNote"),
  );
  await call(
    "missing key",
    "consoleAddBookingNote",
    owner,
    "post",
    `${BOOKINGS}/${patchBooking}/notes`,
    { body: note },
    [400, "VALIDATION_FAILED"],
    failed("bookings.addNote"),
  );
  await call(
    "failure",
    "consoleAddBookingNote",
    owner,
    "post",
    `${BOOKINGS}/${newId("bkg")}/notes`,
    { headers: newKey(), body: note },
    [404, "NOT_FOUND"],
    failed("bookings.addNote"),
  );
  await call(
    "validation",
    "consoleAddBookingNote",
    owner,
    "post",
    `${BOOKINGS}/${patchBooking}/notes`,
    { headers: newKey(), body: { text: "" } },
    [400, "VALIDATION_FAILED"],
    failed("bookings.addNote"),
  );
  await call(
    "denied",
    "consoleAddBookingNote",
    viewer,
    "post",
    `${BOOKINGS}/${patchBooking}/notes`,
    { headers: newKey(), body: note },
    [403, "FORBIDDEN"],
    denied("bookings.addNote"),
  );

  const issueBooking = await seedBooking(await newStubOrder());
  const issueKey = newKey();
  const issueBody = { allowUnpaid: true, reason: "Corporate account settles monthly" };
  const issued = await call(
    "success",
    "consoleIssueBooking",
    owner,
    "post",
    `${BOOKINGS}/${issueBooking}/issuance`,
    { headers: { ...issueKey, "If-Match": '"1"' }, body: issueBody },
    ok(200),
    succeeded("booking.issue"),
  );
  await call(
    "replay",
    "consoleIssueBooking",
    owner,
    "post",
    `${BOOKINGS}/${issueBooking}/issuance`,
    { headers: { ...issueKey, "If-Match": '"1"' }, body: issueBody },
    ok(200),
    succeeded("bookings.issue"),
  );
  await call(
    "reused key",
    "consoleIssueBooking",
    owner,
    "post",
    `${BOOKINGS}/${issueBooking}/issuance`,
    { headers: { ...issueKey, "If-Match": '"1"' }, body: { ...issueBody, reason: "Another reason" } },
    [409, "IDEMPOTENCY_KEY_REUSED"],
    failed("bookings.issue"),
  );
  await call(
    "missing key",
    "consoleIssueBooking",
    owner,
    "post",
    `${BOOKINGS}/${issueBooking}/issuance`,
    { headers: { "If-Match": String(issued.headers["etag"]) }, body: issueBody },
    [400, "VALIDATION_FAILED"],
    failed("bookings.issue"),
  );
  await call(
    "failure",
    "consoleIssueBooking",
    owner,
    "post",
    `${BOOKINGS}/${issueBooking}/issuance`,
    { headers: { ...newKey(), "If-Match": String(issued.headers["etag"]) }, body: issueBody },
    [409, "ALREADY_ISSUED"],
    failed("bookings.issue"),
  );
  await call(
    "validation",
    "consoleIssueBooking",
    owner,
    "post",
    `${BOOKINGS}/${issueBooking}/issuance`,
    { headers: { ...newKey(), "If-Match": String(issued.headers["etag"]) }, body: { allowUnpaid: "yes" } },
    [400, "VALIDATION_FAILED"],
    failed("bookings.issue"),
  );
  await call(
    "denied",
    "consoleIssueBooking",
    viewer,
    "post",
    `${BOOKINGS}/${issueBooking}/issuance`,
    { headers: { ...newKey(), "If-Match": String(issued.headers["etag"]) }, body: {} },
    [403, "FORBIDDEN"],
    denied("bookings.issue"),
  );

  const cancelBooking = await seedBooking(await newStubOrder());
  const cancelKey = newKey();
  const cancelBody = { reasonCode: "customer_request", reason: "The customer no longer travels" };
  const cancelled = await call(
    "success",
    "consoleCancelBooking",
    owner,
    "post",
    `${BOOKINGS}/${cancelBooking}/cancellation`,
    { headers: { ...cancelKey, "If-Match": '"1"' }, body: cancelBody },
    ok(200),
    succeeded("booking.cancel"),
  );
  await call(
    "replay",
    "consoleCancelBooking",
    owner,
    "post",
    `${BOOKINGS}/${cancelBooking}/cancellation`,
    { headers: { ...cancelKey, "If-Match": '"1"' }, body: cancelBody },
    ok(200),
    succeeded("bookings.cancel"),
  );
  await call(
    "reused key",
    "consoleCancelBooking",
    owner,
    "post",
    `${BOOKINGS}/${cancelBooking}/cancellation`,
    { headers: { ...cancelKey, "If-Match": '"1"' }, body: { ...cancelBody, reasonCode: "other" } },
    [409, "IDEMPOTENCY_KEY_REUSED"],
    failed("bookings.cancel"),
  );
  await call(
    "missing key",
    "consoleCancelBooking",
    owner,
    "post",
    `${BOOKINGS}/${cancelBooking}/cancellation`,
    { headers: { "If-Match": String(cancelled.headers["etag"]) }, body: cancelBody },
    [400, "VALIDATION_FAILED"],
    failed("bookings.cancel"),
  );
  await call(
    "failure",
    "consoleCancelBooking",
    owner,
    "post",
    `${BOOKINGS}/${cancelBooking}/cancellation`,
    { headers: { ...newKey(), "If-Match": String(cancelled.headers["etag"]) }, body: cancelBody },
    [409, "BOOKING_ALREADY_CANCELLED"],
    failed("bookings.cancel"),
  );
  await call(
    "validation",
    "consoleCancelBooking",
    owner,
    "post",
    `${BOOKINGS}/${cancelBooking}/cancellation`,
    {
      headers: { ...newKey(), "If-Match": String(cancelled.headers["etag"]) },
      body: { reasonCode: "customer_request" },
    },
    [400, "VALIDATION_FAILED"],
    failed("bookings.cancel"),
  );
  await call(
    "denied",
    "consoleCancelBooking",
    viewer,
    "post",
    `${BOOKINGS}/${cancelBooking}/cancellation`,
    { headers: { ...newKey(), "If-Match": String(cancelled.headers["etag"]) }, body: cancelBody },
    [403, "FORBIDDEN"],
    denied("bookings.cancel"),
  );

  // ---- console.bookings.import ----
  const importOrder = await newStubOrder();
  secrets.push(importOrder.passport.number);
  const importKey = newKey();
  const importBody = { reference: importOrder.recordLocator, pricing: { mode: "net" } };
  await call(
    "success",
    "consoleImportBooking",
    owner,
    "post",
    `${BOOKINGS}/imports`,
    { headers: importKey, body: importBody },
    ok(201),
    succeeded("booking.import"),
  );
  await call(
    "replay",
    "consoleImportBooking",
    owner,
    "post",
    `${BOOKINGS}/imports`,
    { headers: importKey, body: importBody },
    ok(201),
    succeeded("bookings.import"),
  );
  await call(
    "reused key",
    "consoleImportBooking",
    owner,
    "post",
    `${BOOKINGS}/imports`,
    { headers: importKey, body: { ...importBody, tags: ["terminal"] } },
    [409, "IDEMPOTENCY_KEY_REUSED"],
    failed("bookings.import"),
  );
  await call(
    "missing key",
    "consoleImportBooking",
    owner,
    "post",
    `${BOOKINGS}/imports`,
    { body: importBody },
    [400, "VALIDATION_FAILED"],
    failed("bookings.import"),
  );
  await call(
    "failure",
    "consoleImportBooking",
    owner,
    "post",
    `${BOOKINGS}/imports`,
    { headers: newKey(), body: importBody },
    [409, "ORDER_ALREADY_IMPORTED"],
    failed("bookings.import"),
  );
  await call(
    "validation",
    "consoleImportBooking",
    owner,
    "post",
    `${BOOKINGS}/imports`,
    { headers: newKey(), body: { reference: "x" } },
    [400, "VALIDATION_FAILED"],
    failed("bookings.import"),
  );
  await call(
    "denied",
    "consoleImportBooking",
    viewer,
    "post",
    `${BOOKINGS}/imports`,
    { headers: newKey(), body: importBody },
    [403, "FORBIDDEN"],
    denied("bookings.import"),
  );

  // ---- console.settings.markupRules and feeRules: create, update, delete ----
  for (const [kind, body, prefix, noun] of [
    ["markupRules", MARKUP_RULE, "MarkupRule", "markup-rules"],
    ["feeRules", FEE_RULE, "FeeRule", "fee-rules"],
  ] as const) {
    const create = `consoleCreate${prefix}` as OtaOperationId;
    const update = `consoleUpdate${prefix}` as OtaOperationId;
    const remove = `consoleDelete${prefix}` as OtaOperationId;
    const path = `${SETTINGS}/${noun}`;
    const action = (verb: string): string => `settings.${kind}.${verb}`;
    const key = newKey();
    const created = await call(
      "success",
      create,
      owner,
      "post",
      path,
      { headers: key, body },
      ok(201),
      succeeded(action("create")),
    );
    await call(
      "replay",
      create,
      owner,
      "post",
      path,
      { headers: key, body },
      ok(201),
      succeeded(action("create")),
    );
    await call(
      "reused key",
      create,
      owner,
      "post",
      path,
      { headers: key, body: { ...body, name: "Another rule" } },
      [409, "IDEMPOTENCY_KEY_REUSED"],
      failed(action("create")),
    );
    await call(
      "missing key",
      create,
      owner,
      "post",
      path,
      { body },
      [400, "VALIDATION_FAILED"],
      failed(action("create")),
    );
    await call(
      "failure",
      create,
      owner,
      "post",
      path,
      { headers: newKey(), body: { ...body, ...BACKWARDS_WINDOW } },
      [400, "VALIDATION_FAILED"],
      failed(action("create")),
    );
    await call(
      "validation",
      create,
      owner,
      "post",
      path,
      { headers: newKey(), body: { ...body, name: "" } },
      [400, "VALIDATION_FAILED"],
      failed(action("create")),
    );
    await call(
      "denied",
      create,
      viewer,
      "post",
      path,
      { headers: newKey(), body },
      [403, "FORBIDDEN"],
      denied(action("create")),
    );

    const ruleId = String(created.body.id);
    await call(
      "success",
      update,
      owner,
      "patch",
      `${path}/${ruleId}`,
      { headers: { "If-Match": '"1"' }, body: { priority: 200 } },
      ok(200),
      succeeded(action("update")),
    );
    await call(
      "failure",
      update,
      owner,
      "patch",
      `${path}/${ruleId}`,
      { headers: { "If-Match": '"1"' }, body: { priority: 300 } },
      [412, "PRECONDITION_FAILED"],
      failed(action("update")),
    );
    await call(
      "validation",
      update,
      owner,
      "patch",
      `${path}/${ruleId}`,
      { headers: { "If-Match": '"2"' }, body: {} },
      [400, "VALIDATION_FAILED"],
      failed(action("update")),
    );
    await call(
      "denied",
      update,
      viewer,
      "patch",
      `${path}/${ruleId}`,
      { headers: { "If-Match": '"2"' }, body: { priority: 300 } },
      [403, "FORBIDDEN"],
      denied(action("update")),
    );

    await call(
      "success",
      remove,
      owner,
      "delete",
      `${path}/${ruleId}`,
      { headers: { "If-Match": '"2"' } },
      ok(204),
      succeeded(action("delete")),
    );
    await call(
      "failure",
      remove,
      owner,
      "delete",
      `${path}/${ruleId}`,
      { headers: { "If-Match": '"2"' } },
      [404, "NOT_FOUND"],
      failed(action("delete")),
    );
    await call(
      "validation",
      remove,
      owner,
      "delete",
      `${path}/${ruleId}`,
      {},
      [400, "VALIDATION_FAILED"],
      failed(action("delete")),
    );
    await call(
      "denied",
      remove,
      viewer,
      "delete",
      `${path}/${ruleId}`,
      { headers: { "If-Match": '"2"' } },
      [403, "FORBIDDEN"],
      denied(action("delete")),
    );
  }

  // ---- console.settings.storefront.update ----
  const storefront = `${SETTINGS}/storefront`;
  const support = (email: string) => ({
    support: { email, phone: null, hours: null, helpCenterUrl: null, emergencyPhone: null },
  });
  const settingsEtag = String((await owner.send("get", storefront)).headers["etag"]);
  const updated = await call(
    "success",
    "consoleUpdateStorefrontSettings",
    owner,
    "patch",
    storefront,
    { headers: { "If-Match": settingsEtag }, body: support("help@alpha-travel.example") },
    ok(200),
    succeeded("settings.storefront.update"),
  );
  await call(
    "failure",
    "consoleUpdateStorefrontSettings",
    owner,
    "patch",
    storefront,
    { headers: { "If-Match": settingsEtag }, body: support("desk@alpha-travel.example") },
    [412, "PRECONDITION_FAILED"],
    failed("settings.storefront.update"),
  );
  await call(
    "validation",
    "consoleUpdateStorefrontSettings",
    owner,
    "patch",
    storefront,
    { headers: { "If-Match": String(updated.headers["etag"]) }, body: { colour: "red" } },
    [400, "VALIDATION_FAILED"],
    failed("settings.storefront.update"),
  );
  await call(
    "denied",
    "consoleUpdateStorefrontSettings",
    viewer,
    "patch",
    storefront,
    { headers: { "If-Match": String(updated.headers["etag"]) }, body: support("desk@alpha-travel.example") },
    [403, "FORBIDDEN"],
    denied("settings.storefront.update"),
  );

  // ---- console.settings.pages: create, update, delete ----
  const pages = `${SETTINGS}/pages`;
  const pageKey = newKey();
  const page = pageBody(`baggage-${randomBytes(3).toString("hex")}`);
  const createdPage = await call(
    "success",
    "consoleCreateStorefrontPage",
    owner,
    "post",
    pages,
    { headers: pageKey, body: page },
    ok(201),
    succeeded("settings.pages.create"),
  );
  await call(
    "replay",
    "consoleCreateStorefrontPage",
    owner,
    "post",
    pages,
    { headers: pageKey, body: page },
    ok(201),
    succeeded("settings.pages.create"),
  );
  await call(
    "reused key",
    "consoleCreateStorefrontPage",
    owner,
    "post",
    pages,
    { headers: pageKey, body: { ...page, title: "Cabin bags" } },
    [409, "IDEMPOTENCY_KEY_REUSED"],
    failed("settings.pages.create"),
  );
  await call(
    "missing key",
    "consoleCreateStorefrontPage",
    owner,
    "post",
    pages,
    { body: page },
    [400, "VALIDATION_FAILED"],
    failed("settings.pages.create"),
  );
  await call(
    "failure",
    "consoleCreateStorefrontPage",
    owner,
    "post",
    pages,
    { headers: newKey(), body: page },
    [409, "CONFLICT"],
    failed("settings.pages.create"),
  );
  await call(
    "validation",
    "consoleCreateStorefrontPage",
    owner,
    "post",
    pages,
    { headers: newKey(), body: { slug: page.slug, locale: "en" } },
    [400, "VALIDATION_FAILED"],
    failed("settings.pages.create"),
  );
  await call(
    "denied",
    "consoleCreateStorefrontPage",
    viewer,
    "post",
    pages,
    { headers: newKey(), body: page },
    [403, "FORBIDDEN"],
    denied("settings.pages.create"),
  );
  const pageId = String(createdPage.body.id);
  await call(
    "success",
    "consoleUpdateStorefrontPage",
    owner,
    "patch",
    `${pages}/${pageId}`,
    { headers: { "If-Match": '"1"' }, body: { title: "Baggage" } },
    ok(200),
    succeeded("settings.pages.update"),
  );
  await call(
    "failure",
    "consoleUpdateStorefrontPage",
    owner,
    "patch",
    `${pages}/${pageId}`,
    { headers: { "If-Match": '"1"' }, body: { title: "Bags" } },
    [412, "PRECONDITION_FAILED"],
    failed("settings.pages.update"),
  );
  await call(
    "validation",
    "consoleUpdateStorefrontPage",
    owner,
    "patch",
    `${pages}/${pageId}`,
    { headers: { "If-Match": '"2"' }, body: {} },
    [400, "VALIDATION_FAILED"],
    failed("settings.pages.update"),
  );
  await call(
    "denied",
    "consoleUpdateStorefrontPage",
    viewer,
    "patch",
    `${pages}/${pageId}`,
    { headers: { "If-Match": '"2"' }, body: { title: "Bags" } },
    [403, "FORBIDDEN"],
    denied("settings.pages.update"),
  );
  await call(
    "success",
    "consoleDeleteStorefrontPage",
    owner,
    "delete",
    `${pages}/${pageId}`,
    { headers: { "If-Match": '"2"' } },
    ok(204),
    succeeded("settings.pages.delete"),
  );
  await call(
    "failure",
    "consoleDeleteStorefrontPage",
    owner,
    "delete",
    `${pages}/${pageId}`,
    { headers: { "If-Match": '"2"' } },
    [404, "NOT_FOUND"],
    failed("settings.pages.delete"),
  );
  await call(
    "validation",
    "consoleDeleteStorefrontPage",
    owner,
    "delete",
    `${pages}/${pageId}`,
    {},
    [400, "VALIDATION_FAILED"],
    failed("settings.pages.delete"),
  );
  await call(
    "denied",
    "consoleDeleteStorefrontPage",
    viewer,
    "delete",
    `${pages}/${pageId}`,
    { headers: { "If-Match": '"2"' } },
    [403, "FORBIDDEN"],
    denied("settings.pages.delete"),
  );

  // ---- console.settings.assets: upload, delete ----
  const assets = `${SETTINGS}/assets`;
  const assetKey = newKey();
  const logo = {
    kind: "logo",
    file: buildPng({ width: 640, height: 160, shade: randomInt(256) }),
    fileName: "logo.png",
  };
  const uploaded = await call(
    "success",
    "consoleUploadStorefrontAsset",
    owner,
    "post",
    assets,
    { headers: assetKey, multipart: logo },
    ok(201),
    succeeded("settings.assets.upload"),
  );
  await call(
    "replay",
    "consoleUploadStorefrontAsset",
    owner,
    "post",
    assets,
    { headers: assetKey, multipart: logo },
    ok(201),
    succeeded("settings.assets.upload"),
  );
  await call(
    "reused key",
    "consoleUploadStorefrontAsset",
    owner,
    "post",
    assets,
    { headers: assetKey, multipart: { ...logo, kind: "favicon" } },
    [409, "IDEMPOTENCY_KEY_REUSED"],
    failed("settings.assets.upload"),
  );
  await call(
    "missing key",
    "consoleUploadStorefrontAsset",
    owner,
    "post",
    assets,
    { multipart: logo },
    [400, "VALIDATION_FAILED"],
    failed("settings.assets.upload"),
  );
  await call(
    "failure",
    "consoleUploadStorefrontAsset",
    owner,
    "post",
    assets,
    {
      headers: newKey(),
      multipart: { ...logo, file: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") },
    },
    [422, "ASSET_INVALID"],
    failed("settings.assets.upload"),
  );
  await call(
    "validation",
    "consoleUploadStorefrontAsset",
    owner,
    "post",
    assets,
    { headers: newKey(), multipart: { ...logo, kind: "wallpaper" } },
    [400, "VALIDATION_FAILED"],
    failed("settings.assets.upload"),
  );
  await call(
    "denied",
    "consoleUploadStorefrontAsset",
    viewer,
    "post",
    assets,
    { headers: newKey(), multipart: logo },
    [403, "FORBIDDEN"],
    denied("settings.assets.upload"),
  );
  const assetId = String(uploaded.body.id);
  await call(
    "success",
    "consoleDeleteStorefrontAsset",
    owner,
    "delete",
    `${assets}/${assetId}`,
    {},
    ok(204),
    succeeded("settings.assets.delete"),
  );
  await call(
    "failure",
    "consoleDeleteStorefrontAsset",
    owner,
    "delete",
    `${assets}/${assetId}`,
    {},
    [404, "NOT_FOUND"],
    failed("settings.assets.delete"),
  );
  await call(
    "validation",
    "consoleDeleteStorefrontAsset",
    owner,
    "delete",
    `${assets}/not-an-asset`,
    {},
    [400, "VALIDATION_FAILED"],
    failed("settings.assets.delete"),
  );
  await call(
    "denied",
    "consoleDeleteStorefrontAsset",
    viewer,
    "delete",
    `${assets}/${assetId}`,
    {},
    [403, "FORBIDDEN"],
    denied("settings.assets.delete"),
  );

  // ---- console.settings.templates: put, reset ----
  const template = {
    subject: "Your booking is cancelled",
    bodyHtml: "<p>Your booking is cancelled. We are sorry to see you go.</p>",
    bodyText: "Your booking is cancelled. We are sorry to see you go.",
  };
  await call(
    "success",
    "consolePutNotificationTemplate",
    owner,
    "put",
    TEMPLATE,
    { body: template },
    ok(200),
    succeeded("settings.templates.put"),
  );
  // A row exists now: a put without If-Match would write over it.
  await call(
    "failure",
    "consolePutNotificationTemplate",
    owner,
    "put",
    TEMPLATE,
    { body: template },
    [412, "PRECONDITION_FAILED"],
    failed("settings.templates.put"),
  );
  await call(
    "validation",
    "consolePutNotificationTemplate",
    owner,
    "put",
    TEMPLATE,
    { headers: { "If-Match": '"1"' }, body: { subject: "Cancelled" } },
    [400, "VALIDATION_FAILED"],
    failed("settings.templates.put"),
  );
  await call(
    "denied",
    "consolePutNotificationTemplate",
    viewer,
    "put",
    TEMPLATE,
    { headers: { "If-Match": '"1"' }, body: template },
    [403, "FORBIDDEN"],
    denied("settings.templates.put"),
  );
  await call(
    "success",
    "consoleResetNotificationTemplate",
    owner,
    "post",
    `${TEMPLATE}/reset`,
    {},
    ok(200),
    succeeded("settings.templates.reset"),
  );
  await call(
    "validation",
    "consoleResetNotificationTemplate",
    owner,
    "post",
    `${SETTINGS}/notification-templates/booking.lost/email/en/reset`,
    {},
    [400, "VALIDATION_FAILED"],
    failed("settings.templates.reset"),
  );
  await call(
    "denied",
    "consoleResetNotificationTemplate",
    viewer,
    "post",
    `${TEMPLATE}/reset`,
    {},
    [403, "FORBIDDEN"],
    denied("settings.templates.reset"),
  );

  // ---- console.payments.capture, refund ----
  const captureBooking = await seedPaymentBooking();
  const authorised = await seedPayment(captureBooking, "authorized");
  const captureKey = newKey();
  const captureBody = { reason: "Manual review passed; booking confirmed with the airline" };
  const captured = await call(
    "success",
    "consoleCapturePayment",
    owner,
    "post",
    `${PAYMENTS}/${authorised}/capture`,
    { headers: { ...captureKey, "If-Match": '"1"' }, body: captureBody },
    ok(200),
    succeeded("payment.capture"),
  );
  await call(
    "replay",
    "consoleCapturePayment",
    owner,
    "post",
    `${PAYMENTS}/${authorised}/capture`,
    { headers: { ...captureKey, "If-Match": '"1"' }, body: captureBody },
    ok(200),
    succeeded("payments.capture"),
  );
  await call(
    "reused key",
    "consoleCapturePayment",
    owner,
    "post",
    `${PAYMENTS}/${authorised}/capture`,
    { headers: { ...captureKey, "If-Match": '"1"' }, body: { reason: "Another reason" } },
    [409, "IDEMPOTENCY_KEY_REUSED"],
    failed("payments.capture"),
  );
  await call(
    "missing key",
    "consoleCapturePayment",
    owner,
    "post",
    `${PAYMENTS}/${authorised}/capture`,
    { headers: { "If-Match": String(captured.headers["etag"]) }, body: captureBody },
    [400, "VALIDATION_FAILED"],
    failed("payments.capture"),
  );
  await call(
    "failure",
    "consoleCapturePayment",
    owner,
    "post",
    `${PAYMENTS}/${authorised}/capture`,
    { headers: { ...newKey(), "If-Match": String(captured.headers["etag"]) }, body: captureBody },
    [409, "CONFLICT"],
    failed("payments.capture"),
  );
  await call(
    "validation",
    "consoleCapturePayment",
    owner,
    "post",
    `${PAYMENTS}/${authorised}/capture`,
    { headers: { ...newKey(), "If-Match": String(captured.headers["etag"]) }, body: { reason: "ok" } },
    [400, "VALIDATION_FAILED"],
    failed("payments.capture"),
  );
  await call(
    "denied",
    "consoleCapturePayment",
    viewer,
    "post",
    `${PAYMENTS}/${authorised}/capture`,
    { headers: { ...newKey(), "If-Match": String(captured.headers["etag"]) }, body: captureBody },
    [403, "FORBIDDEN"],
    denied("payments.capture"),
  );

  const refundBooking = await seedPaymentBooking();
  const capturedPayment = await seedPayment(refundBooking, "captured");
  const refundKey = newKey();
  const refundBody = {
    amount: { amount: "50.00", currency: "EUR" },
    reason: "goodwill",
    reasonNote: "Delayed outbound flight",
  };
  await call(
    "success",
    "consoleRefundPayment",
    owner,
    "post",
    `${PAYMENTS}/${capturedPayment}/refunds`,
    { headers: refundKey, body: refundBody },
    ok(201),
    succeeded("payment.refund"),
  );
  await call(
    "replay",
    "consoleRefundPayment",
    owner,
    "post",
    `${PAYMENTS}/${capturedPayment}/refunds`,
    { headers: refundKey, body: refundBody },
    ok(201),
    succeeded("payments.refund"),
  );
  await call(
    "reused key",
    "consoleRefundPayment",
    owner,
    "post",
    `${PAYMENTS}/${capturedPayment}/refunds`,
    { headers: refundKey, body: { ...refundBody, reason: "other" } },
    [409, "IDEMPOTENCY_KEY_REUSED"],
    failed("payments.refund"),
  );
  await call(
    "missing key",
    "consoleRefundPayment",
    owner,
    "post",
    `${PAYMENTS}/${capturedPayment}/refunds`,
    { body: refundBody },
    [400, "VALIDATION_FAILED"],
    failed("payments.refund"),
  );
  await call(
    "failure",
    "consoleRefundPayment",
    owner,
    "post",
    `${PAYMENTS}/${capturedPayment}/refunds`,
    { headers: newKey(), body: { ...refundBody, amount: { amount: "999.00", currency: "EUR" } } },
    [422, "UNPROCESSABLE"],
    failed("payments.refund"),
  );
  await call(
    "validation",
    "consoleRefundPayment",
    owner,
    "post",
    `${PAYMENTS}/${capturedPayment}/refunds`,
    { headers: newKey(), body: { ...refundBody, reason: "nope" } },
    [400, "VALIDATION_FAILED"],
    failed("payments.refund"),
  );
  await call(
    "denied",
    "consoleRefundPayment",
    viewer,
    "post",
    `${PAYMENTS}/${capturedPayment}/refunds`,
    { headers: newKey(), body: refundBody },
    [403, "FORBIDDEN"],
    denied("payments.refund"),
  );

  for (const intent of stripe.intents.values()) {
    if (typeof intent["client_secret"] === "string") {
      secrets.push(intent["client_secret"]);
    }
  }
}, CALLS_TIMEOUT_MS);

// The reads: the audited ones, every other one, and the staff-session calls.
beforeAll(async () => {
  const ok: readonly [number, undefined] = [200, undefined];
  const customerId = await seedCustomer();
  const order = await newStubOrder();
  const bookingId = await seedBooking(order);
  const pnr = await newStubOrder();
  secrets.push(order.passport.number, pnr.passport.number);
  const audited = (action: string) => ({ action, outcome: "succeeded" as const });

  // The eleven audited reads, each also refused once (a permission or environment denial, a validation refusal).
  await call(
    "audited read",
    "consoleGetCustomer",
    owner,
    "get",
    `/v1/console/customers/${customerId}`,
    {},
    ok,
    audited("customer.view"),
  );
  await call(
    "audited read",
    "consoleFindBookingByRecordLocator",
    owner,
    "get",
    `${BOOKINGS}/by-record-locator?reference=${pnr.recordLocator}&originSystemCode=GDS`,
    {},
    ok,
    audited("pnr.lookup"),
  );
  await call(
    "audited read",
    "consoleRetrieveFlightOrder",
    owner,
    "get",
    `${BOOKINGS}/${bookingId}/amadeus-order`,
    {},
    ok,
    audited("order.retrieve"),
  );
  await call(
    "audited read",
    "consoleAmadeusSearchFlightOffers",
    owner,
    "post",
    `${RAW}/v2/shopping/flight-offers`,
    { body: { amadeus: searchQuery(), reason: "Check availability for a corporate request" } },
    ok,
    audited("amadeus.searchFlightOffers"),
  );
  const simple = new URLSearchParams({
    originLocationCode: "MAD",
    destinationLocationCode: "PAR",
    departureDate: dayFromNow(30),
    adults: "1",
    max: "5",
  });
  const offers = await call(
    "audited read",
    "consoleAmadeusGetFlightOffers",
    owner,
    "get",
    `${RAW}/v2/shopping/flight-offers?${simple.toString()}`,
    {},
    ok,
    audited("amadeus.getFlightOffers"),
  );
  const offer = structuredClone((offers.body.amadeus.data as JsonObject[])[0] ?? {});
  await call(
    "audited read",
    "consoleAmadeusSearchFlightAvailabilities",
    owner,
    "post",
    `${RAW}/v1/shopping/availability/flight-availabilities`,
    {
      body: {
        amadeus: {
          originDestinations: [
            {
              id: "1",
              originLocationCode: "MAD",
              destinationLocationCode: "PAR",
              departureDateTime: { date: dayFromNow(30), time: "06:00:00" },
            },
          ],
          travelers: [{ id: "1", travelerType: "ADULT" }],
          sources: ["GDS"],
        },
      },
    },
    ok,
    audited("amadeus.searchFlightAvailabilities"),
  );
  await call(
    "audited read",
    "consoleAmadeusUpsellAirOffers",
    owner,
    "post",
    `${RAW}/v1/shopping/flight-offers/upselling`,
    { body: { amadeus: { data: { type: "flight-offers-upselling", flightOffers: [offer] } } } },
    ok,
    audited("amadeus.upsellAirOffers"),
  );
  await call(
    "audited read",
    "consoleAmadeusQuoteAirOffers",
    owner,
    "post",
    `${RAW}/v1/shopping/flight-offers/pricing`,
    { body: { amadeus: { data: { type: "flight-offers-pricing", flightOffers: [offer] } } } },
    ok,
    audited("amadeus.quoteAirOffers"),
  );
  await call(
    "audited read",
    "consoleAmadeusGetFlightOrder",
    owner,
    "get",
    `${RAW}/v1/booking/flight-orders/${order.id}`,
    {},
    ok,
    audited("amadeus.getFlightOrder"),
  );
  await call(
    "audited read",
    "consoleAmadeusGetFlightOrderByReference",
    owner,
    "get",
    `${RAW}/v1/booking/flight-orders/by-reference?reference=${pnr.recordLocator}&originSystemCode=GDS`,
    {},
    ok,
    audited("amadeus.getFlightOrderByReference"),
  );
  await call(
    "audited read",
    "consoleAmadeusGetQueue",
    owner,
    "get",
    `${RAW}/office/queues/50`,
    {},
    ok,
    audited("amadeus.getQueue"),
  );
  // Their refusals: the viewer has no amadeus:read; bookings:read and customers:read are every role's, so the owner
  // asks for the live environment of an OTA that is not live; and a query or path the validation refuses.
  const live = { "X-Velexis-Environment": "live" };
  await call(
    "denied",
    "consoleGetCustomer",
    owner,
    "get",
    `/v1/console/customers/${customerId}`,
    { headers: live },
    [403, "ENVIRONMENT_NOT_ALLOWED"],
    { action: "customers.get", outcome: "denied" },
  );
  await call(
    "denied",
    "consoleFindBookingByRecordLocator",
    owner,
    "get",
    `${BOOKINGS}/by-record-locator?reference=${pnr.recordLocator}&originSystemCode=GDS`,
    { headers: live },
    [403, "ENVIRONMENT_NOT_ALLOWED"],
    { action: "bookings.findByRecordLocator", outcome: "denied" },
  );
  await call(
    "denied",
    "consoleRetrieveFlightOrder",
    owner,
    "get",
    `${BOOKINGS}/${bookingId}/amadeus-order`,
    { headers: live },
    [403, "ENVIRONMENT_NOT_ALLOWED"],
    { action: "bookings.retrieve", outcome: "denied" },
  );
  await call(
    "denied",
    "consoleAmadeusGetFlightOrder",
    viewer,
    "get",
    `${RAW}/v1/booking/flight-orders/${order.id}`,
    {},
    [403, "FORBIDDEN"],
    { action: "amadeus.getFlightOrder", outcome: "denied" },
  );
  await call(
    "validation",
    "consoleGetCustomer",
    owner,
    "get",
    "/v1/console/customers/not-a-customer",
    {},
    [400, "VALIDATION_FAILED"],
    { action: "customers.get", outcome: "failed" },
  );
  await call(
    "validation",
    "consoleFindBookingByRecordLocator",
    owner,
    "get",
    `${BOOKINGS}/by-record-locator?reference=x&originSystemCode=GDS`,
    {},
    [400, "VALIDATION_FAILED"],
    { action: "bookings.findByRecordLocator", outcome: "failed" },
  );
  await call(
    "validation",
    "consoleAmadeusGetQueue",
    owner,
    "get",
    `${RAW}/office/queues/100`,
    {},
    [400, "VALIDATION_FAILED"],
    { action: "amadeus.getQueue", outcome: "failed" },
  );

  // Every other read succeeds without a row.
  const markupRuleId = String(
    (await owner.send("post", `${SETTINGS}/markup-rules`, { headers: newKey(), body: MARKUP_RULE })).body.id,
  );
  const feeRuleId = String(
    (await owner.send("post", `${SETTINGS}/fee-rules`, { headers: newKey(), body: FEE_RULE })).body.id,
  );
  const readPage = pageBody(`faq-${randomBytes(3).toString("hex")}`);
  const pageId = String(
    (await owner.send("post", `${SETTINGS}/pages`, { headers: newKey(), body: readPage })).body.id,
  );
  const paymentId = await seedPayment(await seedPaymentBooking(), "authorized");
  const reads: ReadonlyArray<readonly [OtaOperationId, Method, string, Sent?]> = [
    ["consoleListBookings", "get", BOOKINGS],
    ["consoleGetBooking", "get", `${BOOKINGS}/${bookingId}`],
    ["consoleListQueue", "get", "/v1/console/queues/50"],
    ["consoleListQueueSnapshots", "get", "/v1/console/queue-snapshots"],
    ["consoleListCustomers", "get", "/v1/console/customers"],
    ["consoleListSupplierRequests", "get", "/v1/console/supplier-requests"],
    ["consoleListMarkupRules", "get", `${SETTINGS}/markup-rules`],
    ["consoleGetMarkupRule", "get", `${SETTINGS}/markup-rules/${markupRuleId}`],
    ["consoleListFeeRules", "get", `${SETTINGS}/fee-rules`],
    ["consoleGetFeeRule", "get", `${SETTINGS}/fee-rules/${feeRuleId}`],
    ["consoleGetStorefrontSettings", "get", `${SETTINGS}/storefront`],
    ["consoleListStorefrontPages", "get", `${SETTINGS}/pages`],
    ["consoleGetStorefrontPage", "get", `${SETTINGS}/pages/${pageId}`],
    ["consoleListStorefrontAssets", "get", `${SETTINGS}/assets`],
    ["consoleListNotificationTemplates", "get", `${SETTINGS}/notification-templates`],
    ["consoleGetNotificationTemplate", "get", TEMPLATE],
    ["consolePreviewNotificationTemplate", "post", `${TEMPLATE}/preview`, { body: {} }],
    ["consoleListPayments", "get", PAYMENTS],
    ["consoleGetPayment", "get", `${PAYMENTS}/${paymentId}`],
    ["consoleGetMe", "get", "/v1/console/auth/me"],
  ];
  for (const [operationId, method, path, sent] of reads) {
    await call("read", operationId, agent, method, path, sent ?? {}, ok, null);
  }
  await call(
    "read",
    "consoleRefreshSession",
    agent,
    "post",
    "/v1/console/auth/refresh",
    { headers: newKey(), body: { refreshToken: agent.refreshToken } },
    ok,
    null,
  );
  const rotated = calls.at(-1)?.res.body.session as { accessToken: string; refreshToken: string };
  agent.accessToken = rotated.accessToken;
  agent.refreshToken = rotated.refreshToken;
  secrets.push(rotated.accessToken, rotated.refreshToken);
}, CALLS_TIMEOUT_MS);

// The rate limit: a staff member 600 calls into the console minute is refused before anything else, without a row.
let limitedLines: Array<Record<string, unknown>> = [];
beforeAll(async () => {
  const limited = await staffSession("agent");
  secrets.push(limited.accessToken, limited.refreshToken);
  await redis.client.set(
    `rl:ota_console:${trackerDigest("principal", `staff:${limited.familyId}`)}`,
    "600",
    "EX",
    60,
  );
  await call(
    "rate limited",
    "consoleAddBookingNote",
    limited,
    "post",
    `${BOOKINGS}/${newId("bkg")}/notes`,
    { headers: newKey(), body: { text: "Over the limit" } },
    [429, "RATE_LIMITED"],
    null,
  );
  await call(
    "rate limited",
    "consoleGetCustomer",
    limited,
    "get",
    `/v1/console/customers/${newId("cus")}`,
    {},
    [429, "RATE_LIMITED"],
    null,
  );
  await call(
    "rate limited",
    "consoleCreateMarkupRule",
    limited,
    "post",
    `${SETTINGS}/markup-rules`,
    { headers: newKey(), body: MARKUP_RULE },
    [429, "RATE_LIMITED"],
    null,
  );
  limitedLines = api.sink
    .records()
    .filter((line) => line["msg"] === "rate_limit.exceeded" && line["staffId"] === limited.member.staffId);
  // The sign-outs of the agent's session, after its last call: a staff-session call without a row.
  await call(
    "read",
    "consoleSignOut",
    agent,
    "post",
    "/v1/console/auth/sign-out",
    { headers: newKey(), body: { refreshToken: agent.refreshToken } },
    [204, undefined],
    null,
  );
}, CALLS_TIMEOUT_MS);

// The rows every call wrote.
beforeAll(async () => {
  allRows = (await inTenant((trx) =>
    trx.selectFrom("staff_actions").selectAll().orderBy("created_at").orderBy("id").execute(),
  )) as Array<Record<string, unknown>>;
  for (const row of allRows) {
    const key = String(row["request_id"]);
    rowsByRequest.set(key, [...(rowsByRequest.get(key) ?? []), row]);
  }
  const patch = calls.find(
    (entry) => entry.kind === "success" && entry.operationId === "consolePatchBooking",
  );
  identificationRow = patch === undefined ? undefined : rowsOf(patch.res)[0];
});

describe("the calls of the audit table", () => {
  it("[OBE-075 AC1] covers every state-changing console operation: success, failure, refusals and, with a key, its replay", () => {
    expect(CHANGES).toHaveLength(22);
    for (const operation of CHANGES) {
      const kinds = new Set(
        calls
          .filter((entry) => entry.operationId === operation.operationId && entry.kind !== "rate limited")
          .map((entry) => entry.kind),
      );
      const expected: Kind[] = ["success", "denied", "validation"];
      // A reset has no refusal of its own once the request is valid: it deletes the row, or finds none.
      if (operation.operationId !== "consoleResetNotificationTemplate") {
        expected.push("failure");
      }
      if (takesIdempotencyKey.has(operation.operationId)) {
        expected.push("replay", "missing key", "reused key");
      }
      expect([operation.operationId, [...kinds].sort()]).toEqual([
        operation.operationId,
        [...expected].sort(),
      ]);
    }
    expect([...takesIdempotencyKey].sort()).toEqual(
      [
        "consoleAddBookingNote",
        "consoleCancelBooking",
        "consoleCapturePayment",
        "consoleCreateFeeRule",
        "consoleCreateMarkupRule",
        "consoleCreateStorefrontPage",
        "consoleImportBooking",
        "consoleIssueBooking",
        "consoleRefundPayment",
        "consoleUploadStorefrontAsset",
      ].sort(),
    );
  });

  it("[OBE-075 AC1] covers the eleven audited reads and every other console read", () => {
    const auditedCalls = new Set(
      calls.filter((entry) => entry.kind === "audited read").map((entry) => entry.operationId),
    );
    expect([...auditedCalls].sort()).toEqual(Object.keys(AUDITED_READS).sort());
    const plain = new Set(calls.filter((entry) => entry.kind === "read").map((entry) => entry.operationId));
    expect([...plain].sort()).toEqual(PLAIN_READS.map((operation) => operation.operationId).sort());
    // Every console operation served is in one of the two lists, or a state-changing one, or the sign-in.
    expect(
      [
        ...auditedCalls,
        ...plain,
        ...CHANGES.map((operation) => operation.operationId),
        "consoleSignIn",
      ].sort(),
    ).toEqual(
      otaOperations
        .filter(
          (operation) =>
            operation.scope === "console" && !Object.hasOwn(PENDING_OPERATIONS, operation.operationId),
        )
        .map((operation) => operation.operationId)
        .sort(),
    );
  });

  it("[OBE-075 AC1] answers every call as expected, and as the OTA document says", () => {
    expect(calls.map((entry) => [entry.kind, entry.operationId, ...answerOf(entry.res)])).toEqual(
      calls.map((entry) => [entry.kind, entry.operationId, ...entry.answer]),
    );
    for (const entry of calls.filter((candidate) => candidate.res.status !== 204)) {
      expectResponseToMatch(entry.operationId, entry.res);
    }
  });
});

describe("staff_actions rows (OADR-0011 point 8 as decided on 2026-10-21)", () => {
  /** Checks that each call of `kinds` wrote exactly its one expected row, as the staff member who made it. */
  function expectOneRowEach(kinds: readonly Kind[]): void {
    const selected = calls.filter((entry) => kinds.includes(entry.kind));
    expect(selected.length).toBeGreaterThan(0);
    expect(
      selected.map((entry) => [
        entry.kind,
        entry.operationId,
        rowsOf(entry.res).map((row) => [row["action"], row["outcome"]]),
      ]),
    ).toEqual(
      selected.map((entry) => [entry.kind, entry.operationId, [[entry.row?.action, entry.row?.outcome]]]),
    );
    for (const entry of selected) {
      const rows = rowsOf(entry.res);
      expect(rows[0]).toMatchObject({
        actor_type: "staff",
        actor_id: entry.session.member.staffId,
        staff_id: entry.session.member.staffId,
        staff_role: entry.session.member.role,
        ip_address: entry.session.ip,
        user_agent: entry.session.userAgent,
      });
    }
  }

  it("[OBE-075 AC1] [OF-09 AC1] writes one succeeded row per successful change, with its before and after", () => {
    expectOneRowEach(["success"]);
    // The settings changes and the booking actions carry what changed (redacted below).
    for (const entry of calls.filter((candidate) => candidate.kind === "success")) {
      const [row] = rowsOf(entry.res);
      expect([entry.operationId, row?.["before"] !== null || row?.["after"] !== null]).toEqual([
        entry.operationId,
        true,
      ]);
    }
  });

  it("[OBE-075 AC1] [OF-09 AC1] writes one succeeded row per idempotent replay: the replay keeps its row", () => {
    expectOneRowEach(["replay"]);
  });

  it("[OBE-075 AC1] [OF-09 AC1] writes one failed row per change its use case refuses", () => {
    expectOneRowEach(["failure"]);
    // The rules' failures are refused by the rule's own check of the window (pricing-rules.mapper.ts `window`), which
    // the schema cannot make, so they are failures of the use case and not validation refusals.
    const ruleFailures = calls.filter(
      (entry) =>
        entry.kind === "failure" &&
        ["consoleCreateMarkupRule", "consoleCreateFeeRule"].includes(entry.operationId),
    );
    expect(ruleFailures).toHaveLength(2);
    for (const entry of ruleFailures) {
      expect([entry.operationId, entry.res.body.error?.fieldErrors]).toEqual([
        entry.operationId,
        [expect.objectContaining({ code: "window" })],
      ]);
    }
  });

  it("[OBE-075 AC1] [OF-09 AC1] writes one denied row per refused call: the permission guard's denials of changes and reads", () => {
    expectOneRowEach(["denied"]);
  });

  it("[OBE-075 AC1] [OF-09 AC1] writes one failed row per validation refusal, with the action and target only", () => {
    expectOneRowEach(["validation"]);
    for (const entry of calls.filter((candidate) => candidate.kind === "validation")) {
      expect(rowsOf(entry.res)[0]).toMatchObject({ reason: null, before: null, after: null });
    }
  });

  it("[OBE-075 AC1] [OF-09 AC1] writes one failed row per idempotency refusal: a missing and a reused Idempotency-Key", () => {
    expectOneRowEach(["missing key", "reused key"]);
    for (const entry of calls.filter(
      (candidate) => candidate.kind === "reused key" || candidate.kind === "missing key",
    )) {
      expect(rowsOf(entry.res)[0]).toMatchObject({ reason: null, before: null, after: null });
    }
  });

  it("[OBE-075 AC1] [OF-09 AC1] writes one succeeded row per audited read: customer view, PNR lookup, order retrieve and the eight raw Amadeus reads", () => {
    expectOneRowEach(["audited read"]);
  });

  it("[OBE-075 AC1] writes no row for any other successful read, nor for console.auth.me, refresh or signOut", () => {
    const reads = calls.filter((entry) => entry.kind === "read");
    expect(reads.length).toBe(PLAIN_READS.length);
    expect(reads.map((entry) => [entry.operationId, entry.res.status < 300, rowsOf(entry.res)])).toEqual(
      reads.map((entry) => [entry.operationId, true, []]),
    );
    // The sign-ins wrote theirs.
    for (const session of [owner, viewer, agent]) {
      expect(rowsOf(session.signIn as Response)).toEqual([
        expect.objectContaining({
          action: "staff.sign_in",
          outcome: "succeeded",
          staff_id: session.member.staffId,
        }),
      ]);
    }
  });

  it("[OBE-075 AC1] writes no row for a 429 RATE_LIMITED, only a rate_limit.exceeded log line", () => {
    const limited = calls.filter((entry) => entry.kind === "rate limited");
    expect(limited).toHaveLength(3);
    for (const entry of limited) {
      expect([entry.operationId, rowsOf(entry.res)]).toEqual([entry.operationId, []]);
      expect(entry.res.headers["retry-after"]).toMatch(/^\d+$/);
    }
    expect(limitedLines.map((line) => line["operationId"]).sort()).toEqual(
      ["consoleAddBookingNote", "consoleCreateMarkupRule", "consoleGetCustomer"].sort(),
    );
    for (const line of limitedLines) {
      expect(line).toMatchObject({ limit: "ota_console", maxRequests: 600, callerType: "service" });
    }
    // The limited staff member has its sign-in row only.
    const session = limited[0]?.session as AdminSession;
    expect(
      allRows.filter((row) => row["staff_id"] === session.member.staffId).map((row) => row["action"]),
    ).toEqual(["staff.sign_in"]);
  });
});

describe("redaction of before and after (db README §8)", () => {
  it("[OBE-075 AC1] keeps a document number's last 4 only in the patch's before and after", () => {
    expect(identificationRow).toBeDefined();
    // The form of identification the patch sent, its number cut to the last 4 characters (not merely 4 digits that
    // happen to appear somewhere in the row, such as in a timestamp).
    const after = identificationRow?.["after"] as JsonObject;
    expect(after["formOfIdentifications"]).toEqual([
      expect.objectContaining({
        identificationType: "PASSPORT",
        number: IDENTIFICATION_NUMBER.slice(-4),
      }),
    ]);
    expect(JSON.stringify(after)).not.toContain(IDENTIFICATION_NUMBER);
    expect(JSON.stringify(identificationRow?.["before"] ?? null)).not.toContain(IDENTIFICATION_NUMBER);
  });

  it("[OBE-075 AC1] [OF-09 AC1] holds no token, key, client secret or full document number in any row or log line", () => {
    const stored = JSON.stringify(allRows);
    expect(allRows.length).toBeGreaterThan(calls.length / 2);
    const logged = api.sink.text();
    expect(logged.length).toBeGreaterThan(0);
    for (const secret of secrets) {
      expect([secret.slice(0, 6), stored.includes(secret), logged.includes(secret)]).toEqual([
        secret.slice(0, 6),
        false,
        false,
      ]);
    }
  });
});
