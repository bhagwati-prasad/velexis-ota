// The console booking actions (OBE-062; ota/docs/flows/console-operations.md §2 "Amadeus order view", "Patch",
// "Resync, notes"): console.bookings.retrieve, patch, resync and addNote against PostgreSQL 16, Redis 7 and the Amadeus
// stub, through the API's whole pipeline (guards, validation, idempotency, the audit interceptor).
//
// The file clones the @velexis/testing template (tenant_alpha provisioned) and writes the platform rows as the platform
// does: alpha in test on the Velexis test Amadeus account (the stub), accounts and memberships, and a secret test key
// for the customer calls. Staff sign in through the OTA admin's service key with portal tokens, each admin client with
// an end-user IP address of its own. Every booking points at an order created in the stub through its own HTTP API and
// is written the way the record step writes it (the snapshot through the redactor, the traveller's passport sealed,
// its contacts and remarks), with synthetic travellers and flights relative to now. Every answer is checked against
// the OTA document. The stub's `timeout` scenario holds an answer for 100 ms instead of 30 s.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import type { ConfigService } from "@nestjs/config";
import { encryptValue, hashApiKey, sha256Hex, type KeyProvider } from "@velexis/crypto";
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
import type { Queue } from "bullmq";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AmadeusClient } from "../../../src/amadeus/amadeus.client";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { orderSegmentsOf } from "../../../src/bookings/order-diff";
import { buildCreateOrderRequest, buildIssueRequest } from "../../../src/bookings/order-request.builder";
import { BookingTravelerDocuments, readCreatedOrder } from "../../../src/bookings/order-recorder";
import type { StoredDocument } from "../../../src/checkout/traveler-documents";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import type { ApiConfig } from "../../../src/config";
import { documentRenderKey } from "../../../src/documents/documents.processor";
import { TokenService } from "../../../src/identity/token.service";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { buildOrderRequestInput, buildStoredPassport, pricedFlightOffer } from "../../builders/bookings";
import { newApiKey, testApiCredentials, testKeyProvider } from "../../helpers/api-env";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type JsonObject = Record<string, unknown>;
type Role = "owner" | "admin" | "agent" | "finance" | "viewer";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SCHEMA = "tenant_alpha" as TenantSchema;

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let stub: AmadeusStub;
let keys: KeyProvider;
let migratorPool: OtaPool;
let migrator: Kysely<PlatformDatabase>;
let otaPool: OtaPool;
let tenantDb: TenantDb;
let tokens: TokenService;
let amadeusAccountId: string;
let alphaId: string;
let alphaSk: string;
let office: string;
let stubCredentials: { readonly clientId: string; readonly clientSecret: string };

// ---- Platform rows -------------------------------------------------------------------------------------------------

async function insertAmadeusAccount(clientId: string, secret: string): Promise<string> {
  const id = newId("ama");
  const { ciphertext, kekId } = await encryptValue(secret, {
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
      client_id: clientId,
      client_secret_ciphertext: ciphertext,
      encryption_key_id: kekId,
      status: "active",
    })
    .execute();
  return id;
}

/** The active test tenant alpha with its test Amadeus connection (the stub). */
async function insertTenant(): Promise<string> {
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
      amadeus_account_id: amadeusAccountId,
      office_ids: [office],
      default_office_id: office,
      queuing_office_id: office,
      owner_office_id: office,
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

interface Member {
  readonly accountId: string;
  readonly staffId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly role: Role;
}

async function insertMember(tenantId: string, role: Role): Promise<Member> {
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
    .values({ id: staffId, tenant_id: tenantId, account_id: accountId, role, status: "active" })
    .execute();
  return { accountId, staffId, tenantId, email, role };
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
    tenantId: member.tenantId,
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

  /** The OTA admin's headers; with the staff token once signed in. */
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

  patch(bookingId: string, ifMatch: string, body: unknown) {
    return request(api.server)
      .patch(`/v1/console/bookings/${bookingId}`)
      .set({ ...this.headers(), "If-Match": ifMatch })
      .send(body as object);
  }

  post(path: string, body: unknown, extra: Record<string, string> = {}) {
    return request(api.server)
      .post(path)
      .set({ ...this.headers(), ...extra })
      .send(body as object);
  }
}

async function staffSession(role: Role): Promise<AdminSession> {
  return await new AdminSession(await insertMember(alphaId, role)).signIn();
}

// ---- Tenant rows ---------------------------------------------------------------------------------------------------

const inTenant = <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, SCHEMA, run);

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

/** An order created in the stub, with the passport it holds. */
interface StubOrder {
  readonly data: JsonObject;
  readonly id: string;
  readonly passport: StoredDocument;
}

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

/** A call to the stub's own HTTP API (as another Amadeus client would make it). */
async function stubFetch(
  path: string,
  init: { method: string; body?: unknown },
): Promise<globalThis.Response> {
  const res = await fetch(`${stub.url}${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${await stubToken()}`, "Content-Type": "application/vnd.amadeus+json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  expect(res.ok).toBe(true);
  return res;
}

const orderPath = (orderId: string): string => `/v1/booking/flight-orders/${encodeURIComponent(orderId)}`;

/** The fixture's offer 2 with its flight (2 h 05 min) departing at `departure` (a local time, UTC reading). */
function offerDepartingAt(departure: Date): JsonObject {
  const offer = pricedFlightOffer();
  for (const itinerary of offer["itineraries"] as JsonObject[]) {
    for (const segment of itinerary["segments"] as JsonObject[]) {
      (segment["departure"] as JsonObject)["at"] = local(departure);
      (segment["arrival"] as JsonObject)["at"] = local(new Date(departure.getTime() + 125 * MINUTE));
    }
  }
  return offer;
}

/**
 * An order of the stub (Flight Create Orders, not issued) of one adult with a fresh passport and a special request,
 * its flight 10 days after now (to the minute), so no calendar date matters.
 */
async function newStubOrder(): Promise<StubOrder> {
  const departure = new Date(Math.floor((Date.now() + 10 * DAY) / MINUTE) * MINUTE);
  const input = buildOrderRequestInput({ flightOffers: [offerDepartingAt(departure)] });
  const traveler = input.travelers[0];
  if (traveler === undefined) {
    throw new Error("the order request builder has no traveller");
  }
  const passport = buildStoredPassport();
  const built = buildCreateOrderRequest({
    ...input,
    travelers: [{ ...traveler, documents: [passport] }],
    remarks: [{ text: "Vegetarian meal please", travelerIds: ["1"] }],
    offices: { queuing: office, owner: office },
  });
  const res = await stubFetch("/v1/booking/flight-orders", { method: "POST", body: built.body });
  const data = ((await res.json()) as { data: JsonObject }).data;
  return { data, id: data["id"] as string, passport };
}

const records = (value: unknown): JsonObject[] =>
  Array.isArray(value)
    ? value.filter((item): item is JsonObject => typeof item === "object" && item !== null)
    : [];

/** What a seeded booking looks like. */
interface BookingSeed {
  readonly status?: string;
  readonly customerId?: string | null;
  readonly environment?: "test" | "live";
}

/** The segments of a stub order as the record step stores them. */
function orderSegmentsOfStub(order: StubOrder) {
  const created = readCreatedOrder({ data: order.data });
  if (created === undefined) {
    throw new Error("the stub's order cannot be read");
  }
  return orderSegmentsOf(created);
}

/**
 * A booking of `order` as the record step writes it: the bookings row (net 98.47 + markup 12.00 = 110.47 EUR), the
 * order's MAD–ORY flight (segment "3" of offer "2", the stub's offer; its local times read as UTC, the fixture's
 * airports having no time zone in the template's reference data), the adult with the order's passport sealed, the
 * order's contacts and remarks (the special request visible to the customer, the Velexis one not) and its record.
 */
async function seedBooking(order: StubOrder, seed: BookingSeed = {}): Promise<string> {
  const id = newId("bkg");
  const now = Date.now();
  const segments = orderSegmentsOfStub(order);
  const outbound = new Date(`${segments[0]?.departureLocal ?? local(new Date(now + 10 * DAY))}Z`);
  const lastArrival = new Date(
    Math.max(
      outbound.getTime(),
      ...segments.map((segment) => new Date(`${segment.arrivalLocal}Z`).getTime()),
    ),
  );
  const recordLocator =
    (records(order.data["associatedRecords"])[0]?.["reference"] as string | undefined) ?? "";
  const contact = records(order.data["contacts"])[0] ?? {};
  const contactName = (contact["addresseeName"] ?? {}) as JsonObject;
  const travelerRowId = newId("btr");
  const sealed = await api.app
    .get(BookingTravelerDocuments, { strict: false })
    .seal(SCHEMA, travelerRowId, [order.passport], []);
  const remarks = order.data["remarks"] as { general: JsonObject[] };
  await inTenant(async (trx) => {
    await trx
      .insertInto("bookings")
      .values({
        id,
        environment: seed.environment ?? "test",
        reference: newBookingReference(),
        channel: "storefront",
        customer_id: seed.customerId ?? null,
        status: seed.status ?? "confirmed",
        ticketing_status: "pending",
        amadeus_order_id: order.id,
        record_locator: recordLocator,
        origin_system_code: "GDS",
        owner_office_id: office,
        queuing_office_id: office,
        trip_type: "one_way",
        origin_iata: "MAD",
        destination_iata: "ORY",
        first_departure_at: outbound,
        last_arrival_at: lastArrival,
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
        ticketing_agreement: JSON.stringify(order.data["ticketingAgreement"] ?? null),
        automated_process: JSON.stringify(order.data["automatedProcess"] ?? []),
        form_of_payments: JSON.stringify(redactPayload(order.data["formOfPayments"] ?? [])),
        order_snapshot: JSON.stringify(redactPayload(order.data)),
        last_synced_at: new Date(now - HOUR),
        cancelled_at: seed.status === "cancelled" ? new Date(now - HOUR) : null,
        cancelled_by: seed.status === "cancelled" ? "staff" : null,
        created_at: new Date(now - HOUR),
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
        first_name: (contactName["firstName"] as string | undefined) ?? null,
        last_name: (contactName["lastName"] as string | undefined) ?? null,
        email: contact["emailAddress"] as string,
        phones: JSON.stringify(contact["phones"] ?? []),
        language: (contact["language"] as string | undefined) ?? null,
      })
      .execute();
    await trx
      .insertInto("booking_remarks")
      .values(
        remarks.general.map((remark, index) => ({
          id: newId("rmk"),
          booking_id: id,
          kind: "general",
          sub_type: remark["subType"] as string,
          text: remark["text"] as string,
          traveler_ids: (remark["travelerIds"] as string[] | undefined) ?? [],
          visible_to_customer: remark["subType"] !== "BACKOFFICE",
          created_at: new Date(now - HOUR + index),
        })),
      )
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
  });
  return id;
}

/** A pending booking: no Amadeus order yet. */
async function seedPendingBooking(): Promise<string> {
  const id = newId("bkg");
  const outbound = new Date(Date.now() + 10 * DAY);
  await inTenant((trx) =>
    trx
      .insertInto("bookings")
      .values({
        id,
        environment: "test",
        reference: newBookingReference(),
        channel: "storefront",
        status: "pending",
        ticketing_status: "pending",
        trip_type: "one_way",
        origin_iata: "MAD",
        destination_iata: "ORY",
        first_departure_at: outbound,
        last_arrival_at: new Date(outbound.getTime() + 2 * HOUR),
        travelers_count: 1,
        currency: "EUR",
        net_amount: "98.47",
        markup_amount: "12.00",
        taxes_amount: "42.47",
        total_amount: "110.47",
        contact_email: "contact-1@example.com",
        lead_last_name: "SAMPLE",
        create_order_started_at: new Date(),
      })
      .execute(),
  );
  return id;
}

const bookingRow = (bookingId: string) =>
  inTenant((trx) =>
    trx
      .selectFrom("bookings")
      .select([
        "version",
        "contact_email",
        "last_synced_at",
        "sync_error",
        "order_snapshot",
        "tags",
        "metadata",
        "ticketing_agreement",
        "status",
      ])
      .where("id", "=", bookingId)
      .executeTakeFirstOrThrow(),
  );

/**
 * The staff actions of a booking, oldest first, without the `bookings.get` rows of console.bookings.get (the audit
 * interceptor of OBE-060 writes one for every read; OADR-0011 point 8 as decided on 2026-10-21 asks for none).
 */
const staffActionsOf = (bookingId: string) =>
  inTenant((trx) =>
    trx
      .selectFrom("staff_actions")
      .select([
        "action",
        "outcome",
        "staff_id",
        "target_type",
        "target_id",
        "reason",
        "before",
        "after",
        "ip_address",
      ])
      .where((eb) => eb.or([eb("booking_id", "=", bookingId), eb("target_id", "=", bookingId)]))
      .where("action", "<>", "bookings.get")
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );

const eventsOf = (bookingId: string) =>
  inTenant((trx) =>
    trx
      .selectFrom("booking_events")
      .select(["id", "type", "visible_to_customer", "actor_type", "actor_id", "data", "summary"])
      .where("booking_id", "=", bookingId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );

const contactsOf = (bookingId: string) =>
  inTenant((trx) =>
    trx
      .selectFrom("booking_contacts")
      .select(["purpose", "is_primary", "email"])
      .where("booking_id", "=", bookingId)
      .execute(),
  );

const remarksOf = (bookingId: string) =>
  inTenant((trx) =>
    trx
      .selectFrom("booking_remarks")
      .select(["kind", "sub_type", "text", "created_by_staff_id", "visible_to_customer"])
      .where("booking_id", "=", bookingId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );

const amadeusCalls = (operation: string) => stub.requests().filter((entry) => entry.operation === operation);

/** The `[status, error code]` of an answer. */
const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

/** The console booking's ETag, as console.bookings.get answers it. */
async function etagOf(agent: AdminSession, bookingId: string): Promise<string> {
  const res = await agent.get(`/v1/console/bookings/${bookingId}`);
  expect(answer(res)).toEqual([200, undefined]);
  return res.headers["etag"] as string;
}

/** A new primary contact (Amadeus Contact). */
const newContact = (email: string): JsonObject => ({
  addresseeName: { firstName: "TESTA", lastName: "SAMPLE" },
  purpose: "STANDARD",
  emailAddress: email,
  phones: [{ deviceType: "MOBILE", countryCallingCode: "46", number: "709876543" }],
  language: "en",
});

// Cloning the template, starting the stub, building the API's module graph and compiling the response validators of
// the operations take several seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with
// its own budget, and the tests only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["consoleRetrieveFlightOrder", [200, 404, 409]],
    ["consolePatchBooking", [200, 400, 403, 409, 412, 504]],
    ["consoleResyncBooking", [200, 409, 422, 429]],
    ["consoleAddBookingNote", [201, 400, 404]],
    ["consoleGetBooking", [200]],
    ["listBookingEvents", [200]],
  ] as const) {
    for (const status of statuses) {
      checker.check(operationId, { status, body: {} });
    }
  }
  [db, redis, keys] = await Promise.all([createTestDatabase(), useRedis(), testKeyProvider()]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-writer",
    logger: { error: () => undefined },
    max: 2,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  stubCredentials = {
    clientId: `velexis-test-${randomBytes(4).toString("hex")}`,
    clientSecret: randomBytes(24).toString("base64url"),
  };
  office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
  amadeusAccountId = await insertAmadeusAccount(stubCredentials.clientId, stubCredentials.clientSecret);
  alphaId = await insertTenant();
  alphaSk = await issueKey(alphaId);
  await inTenant((trx) =>
    seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" }),
  );
  tokens = new TokenService(
    { get: () => testApiCredentials().jwtKeyFile } as unknown as ConfigService<ApiConfig, true>,
    new Clock(),
  );
  stub = await startAmadeusStub({
    credentials: stubCredentials,
    // The `timeout` scenario holds an answer for 100 ms, then gives up with its 504, as after 30 s.
    timers: {
      setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 100)),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
  });
  api = await createTestApp({ database: db, redis, env: { AMADEUS_BASE_URL_TEST: stub.url } });
  // The first sign-in and console calls of a process open the pools' connections and warm the token, validation and
  // Amadeus code; done once here, so that no test pays for it.
  const warmUp = await staffSession("owner");
  const warmOrder = await newStubOrder();
  const warmBooking = await seedBooking(warmOrder);
  expect((await warmUp.get(`/v1/console/bookings/${warmBooking}/amadeus-order`)).status).toBe(200);
  expect((await warmUp.get(`/v1/console/bookings/${warmBooking}`)).status).toBe(200);
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await stub?.stop();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

beforeEach(() => {
  stub.clearRequests();
});

describe("console.bookings.retrieve", () => {
  it("answers the verbatim order with net prices and the full passport, refreshes the snapshot and audits the read", async () => {
    const agent = await staffSession("agent");
    const order = await newStubOrder();
    const bookingId = await seedBooking(order);
    const before = await bookingRow(bookingId);

    const res = await agent.get(
      `/v1/console/bookings/${bookingId}/amadeus-order?include=bags&fareRules=refunds`,
    );

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleRetrieveFlightOrder", res);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body).toMatchObject({
      bookingId,
      flightOrderId: order.id,
      include: ["bags"],
      fareRules: ["refunds"],
      snapshotUpdated: true,
      call: {
        environment: "test",
        officeId: office,
        amadeusApi: "FlightOrderManagement",
        amadeusOperationId: "getFlightOrder",
        httpMethod: "GET",
        path: `${orderPath(order.id)}?include=bags&fareRules=refunds`,
        httpStatus: 200,
      },
    });
    // Verbatim: the net price and the full passport number, which no other answer shows; never in a log line.
    const amadeus = res.body.amadeus as { data: JsonObject };
    const offer = records(amadeus.data["flightOffers"])[0] as { price: JsonObject };
    expect(offer.price["grandTotal"]).toBe(
      (records(order.data["flightOffers"])[0] as { price: JsonObject }).price["grandTotal"],
    );
    const document = records(records(amadeus.data["travelers"])[0]?.["documents"])[0];
    expect(document?.["number"]).toBe(order.passport.number);
    expect(api.sink.text()).not.toContain(order.passport.number);
    // The call is logged as the console's, by the staff member; the snapshot is refreshed without a new version.
    const logged = await inTenant((trx) =>
      trx
        .selectFrom("supplier_requests")
        .select(["id", "operation", "staff_id"])
        .where("booking_id", "=", bookingId)
        .execute(),
    );
    expect(logged).toEqual([
      {
        id: res.body.call.supplierRequestId,
        operation: "console.bookings.retrieve",
        staff_id: agent.member.staffId,
      },
    ]);
    const after = await bookingRow(bookingId);
    expect(after.version).toBe(before.version);
    expect(after.last_synced_at?.getTime()).toBeGreaterThan(before.last_synced_at?.getTime() ?? 0);
    expect(JSON.stringify(after.order_snapshot)).not.toContain(order.passport.number);
    // One audited read: order.retrieve with the booking, from the staff member's address.
    expect(await staffActionsOf(bookingId)).toEqual([
      expect.objectContaining({
        action: "order.retrieve",
        outcome: "succeeded",
        staff_id: agent.member.staffId,
        target_type: "booking",
        target_id: bookingId,
        ip_address: agent.ip,
      }),
    ]);
  });

  it("keeps the snapshot with updateSnapshot=false, refuses a booking without an order, and answers 404 for an order Amadeus no longer has", async () => {
    const agent = await staffSession("finance");
    const order = await newStubOrder();
    const bookingId = await seedBooking(order);
    const pending = await seedPendingBooking();
    const gone = await newStubOrder();
    const goneBooking = await seedBooking(gone);
    await stubFetch(orderPath(gone.id), { method: "DELETE" });
    const before = await bookingRow(bookingId);

    const kept = await agent.get(`/v1/console/bookings/${bookingId}/amadeus-order?updateSnapshot=false`);
    const withoutOrder = await agent.get(`/v1/console/bookings/${pending}/amadeus-order`);
    const notFound = await agent.get(`/v1/console/bookings/${goneBooking}/amadeus-order`);
    const unknown = await agent.get(`/v1/console/bookings/${newId("bkg")}/amadeus-order`);

    expect(answer(kept)).toEqual([200, undefined]);
    expect(kept.body.snapshotUpdated).toBe(false);
    expect((await bookingRow(bookingId)).last_synced_at).toEqual(before.last_synced_at);
    expect(answer(withoutOrder)).toEqual([409, "BOOKING_NOT_MODIFIABLE"]);
    expectResponseToMatch("consoleRetrieveFlightOrder", withoutOrder);
    expect(answer(notFound)).toEqual([404, "NOT_FOUND"]);
    expectResponseToMatch("consoleRetrieveFlightOrder", notFound);
    expect(notFound.body.error.supplier).toMatchObject({ provider: "amadeus", status: 404 });
    expect(answer(unknown)).toEqual([404, "NOT_FOUND"]);
    expect(amadeusCalls("getFlightOrder")).toHaveLength(2);
  });
});

describe("console.bookings.patch", () => {
  it("[OBE-062 AC1] answers 412 for a stale If-Match and makes no Amadeus call", async () => {
    const agent = await staffSession("agent");
    const bookingId = await seedBooking(await newStubOrder());
    const etag = await etagOf(agent, bookingId);
    const stale = `"${Number(JSON.parse(etag)) + 1}"`;

    const res = await agent.patch(bookingId, stale, { contacts: [newContact("stale@example.com")] });

    expect(answer(res)).toEqual([412, "PRECONDITION_FAILED"]);
    expectResponseToMatch("consolePatchBooking", res);
    expect(amadeusCalls("patchFlightOrder")).toEqual([]);
    expect((await bookingRow(bookingId)).version).toBe(Number(JSON.parse(etag)));
    expect(await staffActionsOf(bookingId)).toEqual([
      expect.objectContaining({ action: "bookings.patch", outcome: "failed", target_id: bookingId }),
    ]);
  });

  it("[OBE-062 AC1] answers 403 FEATURE_DISABLED for a creditCard form of payment and makes no Amadeus call", async () => {
    const agent = await staffSession("owner");
    const bookingId = await seedBooking(await newStubOrder());
    const etag = await etagOf(agent, bookingId);
    stub.clearRequests();
    // Stripe's documented Visa test number: it must reach no log line and no row.
    const testCardNumber = "4242424242424242";

    const res = await agent.patch(bookingId, etag, {
      formOfPayments: [
        {
          creditCard: {
            brand: "VISA",
            holder: "TESTA SAMPLE",
            number: testCardNumber,
            expiryDate: "2030-12",
            securityCode: "123",
          },
        },
      ],
      reason: "Pay by card",
    });

    expect(answer(res)).toEqual([403, "FEATURE_DISABLED"]);
    expectResponseToMatch("consolePatchBooking", res);
    expect(res.body.error.details).toEqual({ feature: "consoleCardPayment" });
    expect(amadeusCalls("patchFlightOrder")).toEqual([]);
    expect(stub.requests()).toEqual([]);
    expect((await bookingRow(bookingId)).version).toBe(Number(JSON.parse(etag)));
    expect(api.sink.text()).not.toContain(testCardNumber);
    const actions = await staffActionsOf(bookingId);
    expect(actions).toEqual([expect.objectContaining({ action: "bookings.patch", outcome: "failed" })]);
    expect(JSON.stringify(actions)).not.toContain(testCardNumber);
  });

  it("refuses elements the MVP does not patch, the ticketing agreement's read-only fields and a booking without an order before any call", async () => {
    const agent = await staffSession("agent");
    const bookingId = await seedBooking(await newStubOrder());
    const etag = await etagOf(agent, bookingId);
    stub.clearRequests();

    const services = await agent.patch(bookingId, etag, {
      flightOffers: [{ type: "flight-offer", id: "2" }],
    });
    const readOnly = await agent.patch(bookingId, etag, {
      ticketingAgreement: { option: "DELAY_TO_CANCEL", dateTime: "2027-01-01" },
    });
    const empty = await agent.patch(bookingId, etag, { reason: "Nothing" });
    const pending = await seedPendingBooking();
    const withoutOrder = await agent.patch(pending, await etagOf(agent, pending), {
      contacts: [newContact("pending@example.com")],
    });

    expect(answer(withoutOrder)).toEqual([409, "BOOKING_NOT_MODIFIABLE"]);
    expectResponseToMatch("consolePatchBooking", withoutOrder);
    expect(answer(services)).toEqual([403, "FEATURE_DISABLED"]);
    expect(services.body.error.details).toEqual({
      feature: "consolePatchElements",
      elements: ["flightOffers"],
    });
    expect(answer(readOnly)).toEqual([400, "VALIDATION_FAILED"]);
    expect(readOnly.body.error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/ticketingAgreement/dateTime", code: "read_only" }),
    ]);
    expect(answer(empty)).toEqual([400, "VALIDATION_FAILED"]);
    for (const res of [services, readOnly, empty]) {
      expectResponseToMatch("consolePatchBooking", res);
    }
    expect(stub.requests()).toEqual([]);
  });

  it("changes the contacts and adds a remark at Amadeus and in the booking, with a new version, an event and the audit", async () => {
    const agent = await staffSession("agent");
    const customer = await newCustomer();
    const order = await newStubOrder();
    const bookingId = await seedBooking(order, { customerId: customer.id });
    const etag = await etagOf(agent, bookingId);
    const email = `new.${randomBytes(3).toString("hex")}@example.com`;

    const res = await agent.patch(bookingId, etag, {
      contacts: [newContact(email)],
      remarks: { general: [{ subType: "GENERAL_MISCELLANEOUS", text: "CUSTOMER CALLED - PAYS TOMORROW" }] },
      reason: "Call log",
    });

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consolePatchBooking", res);
    const version = Number(JSON.parse(etag)) + 1;
    expect(res.headers["etag"]).toBe(`"${version}"`);
    expect(res.body).toMatchObject({ version, contactEmail: email });
    expect(amadeusCalls("patchFlightOrder")).toEqual([expect.objectContaining({ status: 200 })]);
    // Amadeus holds the new contact and every remark: the stored ones (the Velexis one included) and the new one.
    const atAmadeus = (await (await stubFetch(orderPath(order.id), { method: "GET" })).json()) as {
      data: JsonObject;
    };
    expect(records(atAmadeus.data["contacts"]).map((contact) => contact["emailAddress"])).toEqual([email]);
    expect(
      records((atAmadeus.data["remarks"] as JsonObject)["general"]).map((remark) => remark["text"]),
    ).toEqual([
      "VEGETARIAN MEAL PLEASE",
      expect.stringMatching(/^VELEXIS /),
      "CUSTOMER CALLED - PAYS TOMORROW",
    ]);
    // The booking follows: its contact, its e-mail, the staff member's remark, the others as they were.
    expect(await contactsOf(bookingId)).toEqual([{ purpose: "STANDARD", is_primary: true, email }]);
    expect(await remarksOf(bookingId)).toEqual([
      expect.objectContaining({
        text: "VEGETARIAN MEAL PLEASE",
        visible_to_customer: true,
        created_by_staff_id: null,
      }),
      expect.objectContaining({ sub_type: "BACKOFFICE", visible_to_customer: false }),
      expect.objectContaining({
        text: "CUSTOMER CALLED - PAYS TOMORROW",
        visible_to_customer: false,
        created_by_staff_id: agent.member.staffId,
      }),
    ]);
    const row = await bookingRow(bookingId);
    expect(row).toMatchObject({ version, contact_email: email });
    expect((row.order_snapshot as JsonObject)["contacts"]).toEqual([
      expect.objectContaining({ emailAddress: email }),
    ]);
    const events = await eventsOf(bookingId);
    expect(events.filter((event) => event.type === "booking.patched")).toEqual([
      expect.objectContaining({
        visible_to_customer: true,
        actor_type: "staff",
        actor_id: agent.member.staffId,
        data: { elements: ["contacts", "remarks"] },
      }),
    ]);
    const actions = await staffActionsOf(bookingId);
    expect(actions).toEqual([
      expect.objectContaining({ action: "booking.patch", outcome: "succeeded", reason: "Call log" }),
    ]);
    expect(JSON.stringify(actions[0]?.after)).toContain(email);
    expect(JSON.stringify(actions[0]?.before)).toContain(
      records(order.data["contacts"])[0]?.["emailAddress"] as string,
    );
    // The customer's timeline shows the change, not the staff member.
    const timeline = await request(api.server)
      .get(`/v1/bookings/${bookingId}/events`)
      .set({ "X-Api-Key": alphaSk, Authorization: `Bearer ${customer.token}` });
    expect(answer(timeline)).toEqual([200, undefined]);
    expect((timeline.body.data as JsonObject[]).map((event) => event["type"])).toContain("booking.patched");
    // A replay of the same If-Match is stale now.
    const replay = await agent.patch(bookingId, etag, { contacts: [newContact(email)] });
    expect(answer(replay)).toEqual([412, "PRECONDITION_FAILED"]);
  });

  it("merges a traveller's document over the stored one: the passport keeps its number, the expiry changes", async () => {
    const agent = await staffSession("admin");
    const order = await newStubOrder();
    const bookingId = await seedBooking(order);
    const etag = await etagOf(agent, bookingId);

    const res = await agent.patch(bookingId, etag, {
      travelers: [{ id: "1", documents: [{ documentType: "PASSPORT", expiryDate: "2034-06-30" }] }],
      reason: "New expiry date from the passport copy",
      notifyCustomer: true,
    });

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consolePatchBooking", res);
    // No e-mail template for the change yet (OBE-055): the answer says the traveller was not told.
    expect(res.body.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "CUSTOMER NOT NOTIFIED" })]),
    );
    const traveler = (res.body.travelers as JsonObject[])[0] as { documents: JsonObject[]; name: JsonObject };
    expect(traveler.documents).toEqual([
      expect.objectContaining({
        documentType: "PASSPORT",
        expiryDate: "2034-06-30",
        numberMasked: expect.stringMatching(new RegExp(`${order.passport.number.slice(-4)}$`)),
      }),
    ]);
    const row = await inTenant((trx) =>
      trx
        .selectFrom("booking_travelers")
        .select(["id", "documents_ciphertext", "discount_eligibility_ciphertext", "document_expiry_date"])
        .where("booking_id", "=", bookingId)
        .executeTakeFirstOrThrow(),
    );
    const opened = await api.app.get(BookingTravelerDocuments, { strict: false }).open(SCHEMA, {
      id: row.id,
      documentsCiphertext: row.documents_ciphertext,
      discountEligibilityCiphertext: row.discount_eligibility_ciphertext,
    });
    expect(opened.documents).toEqual([
      expect.objectContaining({ number: order.passport.number, expiryDate: "2034-06-30", nationality: "SE" }),
    ]);
    // The full number reached Amadeus, never a log line or the audit (cut to its last 4 there).
    expect(api.sink.text()).not.toContain(order.passport.number);
    const actions = await staffActionsOf(bookingId);
    expect(actions).toEqual([expect.objectContaining({ action: "booking.patch", outcome: "succeeded" })]);
    expect(JSON.stringify(actions)).not.toContain(order.passport.number);
    expect(JSON.stringify(actions)).toContain("2034-06-30");
  });

  it("sends a form of identification's full number to Amadeus only: the audit, the supplier log and the booking keep its last 4", async () => {
    const agent = await staffSession("agent");
    const order = await newStubOrder();
    const bookingId = await seedBooking(order);
    const etag = await etagOf(agent, bookingId);
    // A synthetic passport number, used as the traveller's form of identification for the e-ticket.
    const passportNumber = `PX${randomInt(10_000_000, 99_999_999)}`;
    const client = api.app.get(AmadeusClient, { strict: false });
    const patch = vi.spyOn(client, "patchFlightOrder");

    const res = await agent.patch(bookingId, etag, {
      formOfIdentifications: [
        { identificationType: "PASSPORT", carrierCode: "IB", number: passportNumber, travelerIds: ["1"] },
      ],
      reason: "Passport as form of identification",
    });

    const sent = patch.mock.calls[0]?.[1] as { body: { data: JsonObject } } | undefined;
    patch.mockRestore();
    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consolePatchBooking", res);
    expect(res.body.formOfIdentifications).toEqual([
      expect.objectContaining({ identificationType: "PASSPORT", number: passportNumber.slice(-4) }),
    ]);
    // Amadeus received the full number ...
    expect(records(sent?.body.data["formOfIdentifications"])[0]?.["number"]).toBe(passportNumber);
    // ... and no row or log line of Velexis holds it.
    const rows = await inTenant(async (trx) => ({
      booking: await trx
        .selectFrom("bookings")
        .select(["form_of_identifications", "order_snapshot"])
        .where("id", "=", bookingId)
        .executeTakeFirstOrThrow(),
      supplierRequests: await trx
        .selectFrom("supplier_requests")
        .select(["request_body", "response_body"])
        .where("booking_id", "=", bookingId)
        .execute(),
      events: await eventsOf(bookingId),
      actions: await staffActionsOf(bookingId),
    }));
    expect(rows.booking.form_of_identifications).toEqual([
      expect.objectContaining({ identificationType: "PASSPORT", number: passportNumber.slice(-4) }),
    ]);
    expect(rows.supplierRequests).toHaveLength(1);
    expect(rows.actions).toEqual([
      expect.objectContaining({ action: "booking.patch", outcome: "succeeded" }),
    ]);
    expect(JSON.stringify(rows.actions[0]?.after)).toContain(passportNumber.slice(-4));
    expect(JSON.stringify(rows)).not.toContain(passportNumber);
    expect(api.sink.text()).not.toContain(passportNumber);
  });

  it("answers 409 VERSION_CONFLICT for Amadeus 2552 and changes nothing locally", async () => {
    const agent = await staffSession("agent");
    const bookingId = await seedBooking(await newStubOrder());
    const etag = await etagOf(agent, bookingId);
    const before = await bookingRow(bookingId);

    const res = await agent
      .patch(bookingId, etag, { contacts: [newContact("conflict@example.com")] })
      .set("X-Stub-Scenario", "version-conflict");

    expect(answer(res)).toEqual([409, "VERSION_CONFLICT"]);
    expectResponseToMatch("consolePatchBooking", res);
    expect(await bookingRow(bookingId)).toEqual(before);
    expect((await contactsOf(bookingId)).map((contact) => contact.email)).not.toContain(
      "conflict@example.com",
    );
  });

  it("resyncs after a timed-out PATCH, then answers 504: the booking shows what Amadeus applied", async () => {
    const agent = await staffSession("agent");
    const order = await newStubOrder();
    const bookingId = await seedBooking(order);
    const etag = await etagOf(agent, bookingId);
    const email = `timeout.${randomBytes(3).toString("hex")}@example.com`;
    // The PATCH times out at the stub after applying the change (scenario `timeout`, chosen for that one call).
    const client = api.app.get(AmadeusClient, { strict: false });
    const patch = client.patchFlightOrder.bind(client);
    vi.spyOn(client, "patchFlightOrder").mockImplementationOnce((context, req, options) =>
      patch({ ...context, stubScenario: "timeout" }, req, options),
    );

    const res = await agent.patch(bookingId, etag, { contacts: [newContact(email)] });

    expect(answer(res)).toEqual([504, "SUPPLIER_TIMEOUT"]);
    expectResponseToMatch("consolePatchBooking", res);
    expect(amadeusCalls("patchFlightOrder").map((call) => call.status)).toEqual([504]);
    expect(amadeusCalls("getFlightOrder").map((call) => call.status)).toEqual([200]);
    // The resync recorded the contact Amadeus holds, with a new version: a retry with the old If-Match is stale.
    expect(await contactsOf(bookingId)).toEqual([{ purpose: "STANDARD", is_primary: true, email }]);
    const row = await bookingRow(bookingId);
    expect(row.version).toBe(Number(JSON.parse(etag)) + 1);
    expect(row.contact_email).toBe(email);
    const events = await eventsOf(bookingId);
    expect(events.filter((event) => event.type === "booking.synced")).toEqual([
      expect.objectContaining({
        visible_to_customer: false,
        data: { cause: "patch_timeout", elements: ["contacts"] },
      }),
    ]);
    // What was done and that the call failed.
    expect((await staffActionsOf(bookingId)).map((action) => [action.action, action.outcome])).toEqual([
      ["booking.resync", "succeeded"],
      ["bookings.patch", "failed"],
    ]);
  });

  it("changes tags and metadata locally in any status: no Amadeus call, a new version and the audit", async () => {
    const agent = await staffSession("agent");
    const bookingId = await seedBooking(await newStubOrder(), { status: "cancelled" });
    const etag = await etagOf(agent, bookingId);
    stub.clearRequests();

    const res = await agent.patch(bookingId, etag, {
      tags: ["corporate", "vip"],
      metadata: { costCenter: "4411" },
      reason: "Account manager request",
    });
    const amadeusElement = await agent.patch(bookingId, res.headers["etag"] as string, {
      contacts: [newContact("cancelled@example.com")],
    });

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consolePatchBooking", res);
    expect(res.body).toMatchObject({ tags: ["corporate", "vip"], metadata: { costCenter: "4411" } });
    expect(await bookingRow(bookingId)).toMatchObject({
      version: Number(JSON.parse(etag)) + 1,
      tags: ["corporate", "vip"],
      metadata: { costCenter: "4411" },
    });
    expect(stub.requests()).toEqual([]);
    expect(answer(amadeusElement)).toEqual([409, "BOOKING_ALREADY_CANCELLED"]);
    expect((await staffActionsOf(bookingId)).map((action) => [action.action, action.outcome])).toEqual([
      ["booking.tags_updated", "succeeded"],
      ["bookings.patch", "failed"],
    ]);
  });
});

describe("console.bookings.resync", () => {
  it("records the tickets Amadeus issued and the contacts it holds, and answers the differences", async () => {
    const agent = await staffSession("agent");
    const order = await newStubOrder();
    const bookingId = await seedBooking(order);
    const email = `resync.${randomBytes(3).toString("hex")}@example.com`;
    // Outside Velexis: the order was issued, and its contact changed.
    await stubFetch(`${orderPath(order.id)}/issuance`, { method: "POST", body: buildIssueRequest(["2"]) });
    await stubFetch(orderPath(order.id), {
      method: "PATCH",
      body: {
        data: {
          type: "flight-order",
          flightOffers: [{ type: "flight-offer", id: "2" }],
          contacts: [newContact(email)],
        },
      },
    });
    stub.clearRequests();
    const versionBefore = (await bookingRow(bookingId)).version;

    const res = await agent.post(`/v1/console/bookings/${bookingId}/resync`, { include: ["bags"] });
    const again = await agent.post(`/v1/console/bookings/${bookingId}/resync`, {});

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleResyncBooking", res);
    expect(res.body).toMatchObject({
      statusChanged: true,
      previousStatus: "confirmed",
      booking: {
        status: "ticketed",
        contactEmail: email,
        syncStatus: "refreshed",
        supplierSync: { status: "refreshed" },
      },
    });
    expect(res.headers["etag"]).toBe(`"${(res.body.booking as { version: number }).version}"`);
    const paths = (res.body.changes as JsonObject[]).map((change) => change["path"]);
    expect(paths).toEqual(
      expect.arrayContaining(["/status", "/ticketing/status", "/tickets/0", "/contacts"]),
    );
    expect(await contactsOf(bookingId)).toEqual([{ purpose: "STANDARD", is_primary: true, email }]);
    expect(amadeusCalls("getFlightOrder")).toHaveLength(1);
    // Throttled to one in 10 seconds.
    expect(answer(again)).toEqual([429, "RATE_LIMITED"]);
    expectResponseToMatch("consoleResyncBooking", again);
    expect(Number(again.headers["retry-after"])).toBeGreaterThan(0);
    const events = (await eventsOf(bookingId)).map((event) => event.type);
    expect(events).toEqual(expect.arrayContaining(["booking.ticketed", "booking.synced"]));
    // The claim is the booking's column since FIX-W27-SYNC, never an event.
    expect(events).not.toContain("booking.sync_requested");
    const actions = await staffActionsOf(bookingId);
    expect(actions.map((action) => [action.action, action.outcome])).toEqual([
      ["booking.resync", "succeeded"],
      ["bookings.resync", "failed"],
    ]);
    // The audit's before is the booking before the refresh, its after the booking the answer shows.
    expect([actions[0]?.before, actions[0]?.after]).toEqual([
      { status: "confirmed", version: versionBefore },
      {
        status: "ticketed",
        version: (res.body.booking as { version: number }).version,
        elements: expect.arrayContaining(["contacts"]),
      },
    ]);
  });

  it("[FIX-W27-SYNC AC2] reports a schedule change through the background sync's diff: its changes, booking.schedule_changed and a new itinerary", async () => {
    const agent = await staffSession("agent");
    const order = await newStubOrder();
    const bookingId = await seedBooking(order);
    const [segment] = orderSegmentsOfStub(order);
    if (segment === undefined) {
      throw new Error("the stub order has no segment");
    }
    // The airline moves the flight by 2 hours (outside Velexis).
    const departure = local(new Date(new Date(`${segment.departureLocal}Z`).getTime() + 2 * HOUR));
    const arrival = local(new Date(new Date(`${segment.arrivalLocal}Z`).getTime() + 2 * HOUR));
    stub.orders.changeSegment(order.id, segment.amadeusSegmentId, {
      departureAt: departure,
      arrivalAt: arrival,
    });
    stub.clearRequests();
    const versionBefore = (await bookingRow(bookingId)).version;
    const documents = api.app.get<Queue>(getQueueToken(OTA_QUEUE.documents), { strict: false });

    const res = await agent.post(`/v1/console/bookings/${bookingId}/resync`, {});

    // The contract is the same: the booking, the changes, whether the status changed, the audit row.
    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleResyncBooking", res);
    expect(res.body).toMatchObject({ statusChanged: false, previousStatus: "confirmed" });
    expect(res.body.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/itineraries/0/segments/0/departure/at",
          before: segment.departureLocal,
          after: departure,
        }),
        expect.objectContaining({
          path: "/itineraries/0/segments/0/arrival/at",
          before: segment.arrivalLocal,
          after: arrival,
        }),
      ]),
    );
    const booking = res.body.booking as {
      version: number;
      itineraries: Array<{ segments: Array<{ departure: { at: string } }> }>;
      supplierSync: { differences: JsonObject[] };
    };
    expect(booking.itineraries[0]?.segments[0]?.departure.at).toBe(departure);
    // The console's differences are the sync's diff (FIX-W27-SYNC AC5).
    expect(booking.supplierSync.differences.map((change) => change["path"])).toEqual([
      "/itineraries/0/segments/0/departure/at",
      "/itineraries/0/segments/0/arrival/at",
    ]);
    // The background sync's events: booking.schedule_changed (visible: times changed), then booking.synced.
    const events = await eventsOf(bookingId);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["booking.schedule_changed", "booking.synced"]),
    );
    // A new itinerary at the version the record left (DOCUMENT_TRIGGERS).
    expect(booking.version).toBeGreaterThan(versionBefore);
    expect(
      await documents.getDeduplicationJobId(
        documentRenderKey({ bookingId, kind: "itinerary", bookingVersion: versionBefore + 1 }),
      ),
    ).not.toBe(null);
    // One Flight Order Management GET, logged as the console's resync with the staff member; the staff action.
    expect(amadeusCalls("getFlightOrder")).toHaveLength(1);
    const logged = await inTenant((trx) =>
      trx
        .selectFrom("supplier_requests")
        .select(["operation", "staff_id"])
        .where("booking_id", "=", bookingId)
        .execute(),
    );
    expect(logged).toEqual([{ operation: "console.bookings.resync", staff_id: agent.member.staffId }]);
    expect((await staffActionsOf(bookingId)).map((action) => [action.action, action.outcome])).toEqual([
      ["booking.resync", "succeeded"],
    ]);
  });

  it("[FIX-W26-BOOKINGS AC3] moves the version when it stores a new ticket of a ticketed booking, so the itinerary is asked for again", async () => {
    const agent = await staffSession("agent");
    const order = await newStubOrder();
    const bookingId = await seedBooking(order);
    // The booking was ticketed with a ticket the airline has replaced since (an exchange, say): Flight Order
    // Management now holds a ticket the booking does not have, and the booking's status stays `ticketed`.
    const earlier = `075-${randomInt(1_000_000_000, 9_999_999_999)}`;
    await inTenant(async (trx) => {
      await trx
        .updateTable("bookings")
        .set({ status: "ticketed", ticketing_status: "issued", issued_at: new Date() })
        .where("id", "=", bookingId)
        .execute();
      await trx
        .insertInto("booking_tickets")
        .values({
          id: newId("tkt"),
          booking_id: bookingId,
          amadeus_traveler_id: "1",
          document_type: "ETICKET",
          document_number: earlier,
          segment_ids: ["3"],
          issued_at: new Date(),
        })
        .execute();
    });
    const issued = (await (
      await stubFetch(`${orderPath(order.id)}/issuance`, { method: "POST", body: buildIssueRequest(["2"]) })
    ).json()) as { data: { tickets?: JsonObject[] } };
    const added = issued.data.tickets?.find((ticket) => ticket["documentType"] === "ETICKET")?.[
      "documentNumber"
    ];
    stub.clearRequests();
    const versionBefore = (await bookingRow(bookingId)).version;
    const documents = api.app.get<Queue>(getQueueToken(OTA_QUEUE.documents), { strict: false });
    const itineraryAt = (bookingVersion: number) =>
      documents.getDeduplicationJobId(documentRenderKey({ bookingId, kind: "itinerary", bookingVersion }));

    const res = await agent.post(`/v1/console/bookings/${bookingId}/resync`, {});

    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("consoleResyncBooking", res);
    expect(res.body).toMatchObject({ statusChanged: false, booking: { status: "ticketed" } });
    const booking = res.body.booking as { version: number; tickets: Array<{ documentNumber: string }> };
    expect(booking.tickets.map((ticket) => ticket.documentNumber).sort()).toEqual([earlier, added].sort());
    // The refresh's record moved the version (the projection may move it once more): the booking.ticketed of the new
    // ticket asked for the itinerary at the moved version, so it is not deduplicated against the one of before.
    expect(await itineraryAt(versionBefore + 1)).not.toBe(null);
    expect(await itineraryAt(versionBefore)).toBe(null);
    expect(booking.version).toBeGreaterThan(versionBefore);
    expect(res.headers["etag"]).toBe(`"${booking.version}"`);
    expect((await eventsOf(bookingId)).map((event) => event.type)).toContain("booking.ticketed");
  });

  it("refuses a booking without an order and answers 422 for an order Amadeus no longer has", async () => {
    const agent = await staffSession("owner");
    const pending = await seedPendingBooking();
    const gone = await newStubOrder();
    const goneBooking = await seedBooking(gone);
    await stubFetch(orderPath(gone.id), { method: "DELETE" });
    stub.clearRequests();

    const withoutOrder = await agent.post(`/v1/console/bookings/${pending}/resync`, {});
    const notFound = await agent.post(`/v1/console/bookings/${goneBooking}/resync`, {});
    const view = await agent.get(`/v1/console/bookings/${goneBooking}`);

    expect(answer(withoutOrder)).toEqual([409, "BOOKING_NOT_MODIFIABLE"]);
    expect(answer(notFound)).toEqual([422, "SUPPLIER_REJECTED"]);
    for (const res of [withoutOrder, notFound]) {
      expectResponseToMatch("consoleResyncBooking", res);
    }
    expect(view.body.supplierSync).toMatchObject({ status: "order_not_found" });
    expect(amadeusCalls("getFlightOrder").map((call) => call.status)).toEqual([404]);
  });
});

describe("console.bookings.addNote", () => {
  it("[OBE-062 AC2] adds a staff-only note: in the console booking, never in the customer's bookings.listEvents", async () => {
    const agent = await staffSession("agent");
    const customer = await newCustomer();
    const bookingId = await seedBooking(await newStubOrder(), { customerId: customer.id });
    const version = (await bookingRow(bookingId)).version;
    const key = randomUUID();
    const text = "Customer asked to be called back before issuance.";

    const res = await agent.post(
      `/v1/console/bookings/${bookingId}/notes`,
      { text },
      { "Idempotency-Key": key },
    );
    const replay = await agent.post(
      `/v1/console/bookings/${bookingId}/notes`,
      { text },
      { "Idempotency-Key": key },
    );
    const view = await agent.get(`/v1/console/bookings/${bookingId}`);
    const timeline = await request(api.server)
      .get(`/v1/bookings/${bookingId}/events`)
      .set({ "X-Api-Key": alphaSk, Authorization: `Bearer ${customer.token}` });

    expect(answer(res)).toEqual([201, undefined]);
    expectResponseToMatch("consoleAddBookingNote", res);
    expect(res.body).toMatchObject({
      bookingId,
      text,
      visibleToCustomer: false,
      author: { type: "staff", id: agent.member.staffId, email: agent.member.email, role: "agent" },
    });
    expect(res.headers["location"]).toBe(`/v1/console/bookings/${bookingId}#${res.body.id as string}`);
    // The same key replays the same note: one event.
    expect([replay.status, replay.body.id]).toEqual([201, res.body.id]);
    const notes = (await eventsOf(bookingId)).filter((event) => event.type === "staff.note");
    expect(notes).toEqual([
      expect.objectContaining({
        id: res.body.id,
        visible_to_customer: false,
        actor_id: agent.member.staffId,
      }),
    ]);
    // In the console: the notes and the timeline; the booking's version does not change.
    expect(answer(view)).toEqual([200, undefined]);
    expectResponseToMatch("consoleGetBooking", view);
    expect(view.body.notes).toEqual([
      expect.objectContaining({ id: res.body.id, text, visibleToCustomer: false }),
    ]);
    expect((view.body.events as JsonObject[]).map((event) => event["id"])).toContain(res.body.id);
    expect(view.body.version).toBe(version);
    // Never in the customer's timeline.
    expect(answer(timeline)).toEqual([200, undefined]);
    expectResponseToMatch("listBookingEvents", timeline);
    expect((timeline.body.data as JsonObject[]).map((event) => event["type"])).not.toContain("staff.note");
    expect(JSON.stringify(timeline.body)).not.toContain(text);
    // Audited with the note's id and not its text; the replay is recorded as the call it replays (OBE-060).
    const actions = await staffActionsOf(bookingId);
    expect(actions.map((action) => [action.action, action.outcome])).toEqual([
      ["booking.note", "succeeded"],
      ["bookings.addNote", "succeeded"],
    ]);
    expect(actions[0]?.after).toEqual({ noteId: res.body.id, visibleToCustomer: false });
    expect(JSON.stringify(actions)).not.toContain(text);
  });

  it("shows a note the staff member makes visible in the customer's timeline (the document's visibleToCustomer)", async () => {
    const agent = await staffSession("agent");
    const customer = await newCustomer();
    const bookingId = await seedBooking(await newStubOrder(), { customerId: customer.id });
    const text = "Your seats are confirmed together.";

    const res = await agent.post(
      `/v1/console/bookings/${bookingId}/notes`,
      { text, visibleToCustomer: true },
      { "Idempotency-Key": randomUUID() },
    );
    const timeline = await request(api.server)
      .get(`/v1/bookings/${bookingId}/events`)
      .set({ "X-Api-Key": alphaSk, Authorization: `Bearer ${customer.token}` });

    expect(answer(res)).toEqual([201, undefined]);
    expect(res.body.visibleToCustomer).toBe(true);
    expect(timeline.body.data).toEqual([
      expect.objectContaining({ id: res.body.id, type: "staff.note", actorType: "staff", summary: text }),
    ]);
  });

  it("requires an Idempotency-Key and answers 404 for a booking of another environment", async () => {
    const agent = await staffSession("agent");
    const live = await seedBooking(await newStubOrder(), { environment: "live" });

    const withoutKey = await agent.post(`/v1/console/bookings/${live}/notes`, { text: "No key" });
    const otherEnvironment = await agent.post(
      `/v1/console/bookings/${live}/notes`,
      { text: "Wrong environment" },
      { "Idempotency-Key": randomUUID() },
    );

    expect(answer(withoutKey)).toEqual([400, "VALIDATION_FAILED"]);
    expect(answer(otherEnvironment)).toEqual([404, "NOT_FOUND"]);
    for (const res of [withoutKey, otherEnvironment]) {
      expectResponseToMatch("consoleAddBookingNote", res);
    }
    expect((await eventsOf(live)).filter((event) => event.type === "staff.note")).toEqual([]);
  });
});
