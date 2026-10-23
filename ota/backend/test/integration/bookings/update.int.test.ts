// bookings.update (OBE-048, OF-08 AC1; ota/docs/flows/change-and-cancel.md §1, §3 steps 1–2, §4): the contacts and
// special requests of a booking changed at Amadeus and in the booking, against PostgreSQL 16, Redis 7, the Amadeus stub
// and Mailpit, through the API's whole pipeline (edge and key callers, CSRF, the booking access guard, validation).
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned) and writes the platform rows
// as the platform does: alpha in test on the Velexis test Amadeus account (the stub) with a secret test key. Customers
// are inserted with their access tokens signed by the API's own key; guests hold a booking token row. Every booking
// points at an order created in the stub through its own HTTP API and is written the way the record step writes it
// (the snapshot through the redactor, the order's contact and remarks), with synthetic travellers and flights relative
// to now. Both processes run in-process: the API (createTestApp) and the worker (WorkerModule.forRoot), whose
// ota-notifications consumer sends the confirmations through Mailpit (its schedulers are removed: the `notify` job that
// follows each commit is what sends). The confirmation's template is a tenant row of alpha, as an OTA writes one: the
// code defaults of the booking e-mails are OBE-055's. Every e-mail goes to a recipient of its own (`uniqueEmail`).
// Every answer is checked against the OTA document. The stub's `timeout` scenario holds an answer for 100 ms instead of
// 30 s.
import { randomBytes } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplicationContext } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import { encryptValue, hashApiKey, type KeyProvider } from "@velexis/crypto";
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
import { uniqueEmail, waitForMessage, type MailpitMessage } from "@velexis/testing/mailpit";
import type { Queue } from "bullmq";
import request, { type Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AmadeusClient } from "../../../src/amadeus/amadeus.client";
import { BookingChangesRepository } from "../../../src/bookings/booking-changes.service";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { orderSegmentsOf } from "../../../src/bookings/order-diff";
import { readCreatedOrder } from "../../../src/bookings/order-recorder";
import { buildCreateOrderRequest } from "../../../src/bookings/order-request.builder";
import { newBookingToken } from "../../../src/bookings/guest-access.service";
import { bookingTokenHash } from "../../../src/common/auth/booking-access.guard";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { APP_DIR, loadWorkerConfig, type ApiConfig } from "../../../src/config";
import { TokenService } from "../../../src/identity/token.service";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { buildOrderContact, buildOrderRequestInput, pricedFlightOffer } from "../../builders/bookings";
import {
  edgeWriteHeaders,
  newApiKey,
  testApiCredentials,
  testKeyProvider,
  testWorkerVariables,
} from "../../helpers/api-env";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type JsonObject = Record<string, unknown>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ALPHA: TenantSchema = "tenant_alpha" as TenantSchema;
const BETA: TenantSchema = "tenant_beta" as TenantSchema;
const ALPHA_HOST = "alpha.ota.example.com";

/**
 * A scenario updates a booking (one Flight Order Management PATCH at the stub, one more read after a timeout) and, for
 * the contacts, waits for the worker to send two e-mails through Mailpit: well under a second each locally; the bound
 * allows for CI load and only stops a scenario that hangs.
 */
const SCENARIO_TIMEOUT_MS = 60_000;
/** How long a scenario waits at most for the worker and Mailpit. */
const MAIL_WAIT_MS = 20_000;

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let worker: INestApplicationContext;
const workerSink = new MemorySink();
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

/** The development SMTP_URL (Mailpit) of the environment, where the worker sends. */
function mailpitSmtpUrl(): string {
  loadDevEnvFiles({ appDir: APP_DIR });
  return defineConfig({ SMTP_URL: env.url({ protocols: ["smtp:"] }) }).SMTP_URL;
}

// ---- Tenant rows ---------------------------------------------------------------------------------------------------

const inTenant = <T>(run: (trx: TenantTransaction) => Promise<T>, schema: TenantSchema = ALPHA): Promise<T> =>
  tenantTx(tenantDb, schema, run);

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

/** A call to the stub's own HTTP API (as another Amadeus client would make it); its `data`. */
async function stubFetch(path: string, init: { method: string; body?: unknown }): Promise<JsonObject> {
  const res = await fetch(`${stub.url}${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${await stubToken()}`, "Content-Type": "application/vnd.amadeus+json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { data: JsonObject }).data;
}

const orderPath = (orderId: string): string => `/v1/booking/flight-orders/${encodeURIComponent(orderId)}`;

/** The order as the stub holds it now. */
const stubOrder = (orderId: string): Promise<JsonObject> => stubFetch(orderPath(orderId), { method: "GET" });

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
 * An order of the stub (Flight Create Orders, not issued) of one adult with a special request, for `email`, its flight
 * 10 days after now (to the minute), so no calendar date matters.
 */
async function newStubOrder(email: string): Promise<JsonObject> {
  const departure = new Date(Math.floor((Date.now() + 10 * DAY) / MINUTE) * MINUTE);
  const input = buildOrderRequestInput({ flightOffers: [offerDepartingAt(departure)] });
  const built = buildCreateOrderRequest({
    ...input,
    contacts: [buildOrderContact({ email })],
    remarks: [{ text: "Vegetarian meal please", travelerIds: ["1"] }],
    offices: { queuing: office, owner: office },
  });
  return await stubFetch("/v1/booking/flight-orders", { method: "POST", body: built.body });
}

const records = (value: unknown): JsonObject[] =>
  Array.isArray(value)
    ? value.filter((item): item is JsonObject => typeof item === "object" && item !== null)
    : [];

/** What a seeded booking looks like. */
interface BookingSeed {
  readonly customerId?: string | null;
  readonly status?: string;
  /**
   * The departure, relative to now, of a booking whose flight differs from its order's (a trip that is over); without
   * it the booking holds the order's flight, as the record step stores it.
   */
  readonly departInMs?: number;
}

/**
 * A booking of `order` as the record step writes it: the bookings row (110.47 EUR), the order's MAD–ORY flight
 * (segment "3" of offer "2", the stub's offer; local times read as UTC, the fixture's airports having no time zone in
 * the template's reference data; since FIX-W27-SYNC a refresh records the order through the background sync's diff, so
 * another flight would be a schedule change), the adult, the order's contact (primary) and remarks (the special request
 * visible to the customer, the Velexis one not) and its record.
 */
async function seedBooking(order: JsonObject, seed: BookingSeed = {}): Promise<string> {
  const id = newId("bkg");
  const now = Date.now();
  const [segment] = orderSegmentsOf(
    readCreatedOrder({ data: order }) ??
      ((): never => {
        throw new Error("the stub's order cannot be read");
      })(),
  );
  const ordered = seed.departInMs === undefined ? segment : undefined;
  const outbound =
    ordered === undefined
      ? new Date(now + (seed.departInMs ?? 10 * DAY))
      : new Date(`${ordered.departureLocal}Z`);
  const arrival =
    ordered === undefined ? new Date(outbound.getTime() + 2 * HOUR) : new Date(`${ordered.arrivalLocal}Z`);
  const recordLocator = (records(order["associatedRecords"])[0]?.["reference"] as string | undefined) ?? "";
  const contact = records(order["contacts"])[0] ?? {};
  const contactName = (contact["addresseeName"] ?? {}) as JsonObject;
  const remarks = order["remarks"] as { general: JsonObject[] };
  const status = seed.status ?? "confirmed";
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
        ticketing_status: status === "cancelled" ? "not_applicable" : "pending",
        amadeus_order_id: order["id"] as string,
        record_locator: recordLocator,
        origin_system_code: "GDS",
        owner_office_id: office,
        queuing_office_id: office,
        trip_type: "one_way",
        origin_iata: "MAD",
        destination_iata: "ORY",
        first_departure_at: outbound,
        last_arrival_at: arrival,
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
        order_snapshot: JSON.stringify(redactPayload(order)),
        last_synced_at: new Date(now - HOUR),
        cancelled_at: status === "cancelled" ? new Date(now - HOUR) : null,
        cancelled_by: status === "cancelled" ? "customer" : null,
        created_at: new Date(now - HOUR),
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
        departure_terminal: ordered?.departureTerminal ?? null,
        departure_local: local(outbound),
        departure_at: outbound,
        arrival_iata: "ORY",
        arrival_terminal: ordered?.arrivalTerminal ?? null,
        arrival_local: local(arrival),
        arrival_at: arrival,
        duration_minutes: ordered?.durationMinutes ?? 120,
        cabin: "ECONOMY",
        booking_class: "Q",
        is_flown: arrival.getTime() < now,
      })
      .execute();
    await trx
      .insertInto("booking_travelers")
      .values({
        id: newId("btr"),
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

// ---- What a scenario reads -----------------------------------------------------------------------------------------

const bookingRow = (bookingId: string) =>
  inTenant((trx) =>
    trx
      .selectFrom("bookings")
      .select(["version", "status", "contact_email", "order_snapshot", "last_synced_at", "sync_error"])
      .where("id", "=", bookingId)
      .executeTakeFirstOrThrow(),
  );

const contactsOf = (bookingId: string) =>
  inTenant((trx) =>
    trx
      .selectFrom("booking_contacts")
      .select(["purpose", "is_primary", "email", "first_name", "last_name", "phones"])
      .where("booking_id", "=", bookingId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );

const remarksOf = (bookingId: string) =>
  inTenant((trx) =>
    trx
      .selectFrom("booking_remarks")
      .select(["kind", "sub_type", "text", "traveler_ids", "visible_to_customer"])
      .where("booking_id", "=", bookingId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );

const eventsOf = (bookingId: string) =>
  inTenant((trx) =>
    trx
      .selectFrom("booking_events")
      .select(["type", "actor_type", "visible_to_customer", "data", "summary"])
      .where("booking_id", "=", bookingId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );

const notificationsOf = (bookingId: string) =>
  inTenant((trx) =>
    trx
      .selectFrom("notifications")
      .select(["template_key", "recipient", "recipient_type", "locale", "dedupe_key", "payload"])
      .where("booking_id", "=", bookingId)
      // The two confirmations of a change may share a millisecond (and ids are random within one): by dedupe key,
      // `…:new` before `…:old`.
      .orderBy("dedupe_key")
      .execute(),
  );

/** Everything a refused update must leave as it was. */
async function localState(bookingId: string) {
  return {
    booking: await bookingRow(bookingId),
    contacts: await contactsOf(bookingId),
    remarks: await remarksOf(bookingId),
    events: await eventsOf(bookingId),
    notifications: await notificationsOf(bookingId),
  };
}

const amadeusCalls = (operation: string) => stub.requests().filter((entry) => entry.operation === operation);

/** The `[status, error code]` of an answer. */
const answer = (res: Response): [number, unknown] => [res.status, res.body?.error?.code];

/** A new primary contact (ContactInput). */
const newContact = (email: string): JsonObject => ({
  purpose: "STANDARD",
  isPrimary: true,
  addresseeName: { firstName: "TESTB", lastName: "SAMPLE" },
  emailAddress: email,
  phones: [{ deviceType: "MOBILE", countryCallingCode: "46", number: "709876543" }],
  language: "sv",
});

/** bookings.update as the storefront edge sends it for a signed-in customer (cookies, CSRF, the storefront's Origin). */
function edgeUpdate(bookingId: string, accessToken: string, ifMatch: string, body: unknown) {
  const headers = edgeWriteHeaders(ALPHA_HOST);
  return request(api.server)
    .patch(`/v1/bookings/${bookingId}`)
    .set({
      ...headers,
      Cookie: `${headers["Cookie"] ?? ""}; __Host-vx_at=${accessToken}`,
      "If-Match": ifMatch,
    })
    .send(body as object);
}

/** bookings.update as a storefront server sends it with its secret key, for a customer or a guest. */
function keyUpdate(
  bookingId: string,
  credential: { readonly customerToken?: string; readonly bookingToken?: string },
  ifMatch: string,
  body: unknown,
  extra: Record<string, string> = {},
) {
  return request(api.server)
    .patch(`/v1/bookings/${bookingId}`)
    .set({
      "X-Api-Key": alphaSk,
      ...(credential.customerToken === undefined
        ? {}
        : { Authorization: `Bearer ${credential.customerToken}` }),
      ...(credential.bookingToken === undefined ? {} : { "X-Booking-Token": credential.bookingToken }),
      "If-Match": ifMatch,
      ...extra,
    })
    .send(body as object);
}

// Cloning the template, starting the stub, building the API's and the worker's module graphs and compiling the
// response validators take several seconds alone and much longer on a busy 4-CPU runner: all of it happens once here,
// with its own budget, and the scenarios only make calls.
beforeAll(async () => {
  preloadOpenApiDocument();
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["updateBooking", [200, 400, 401, 403, 404, 409, 412, 422, 502, 504]],
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
  await inTenant(async (trx) => {
    await seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" });
    // The OTA's own confirmation e-mail in Swedish, the new contacts' language (the code defaults of the booking
    // e-mails come with OBE-055).
    await trx
      .insertInto("notification_templates")
      .values({
        id: newId("ntt"),
        key: "booking.confirmed",
        channel: "email",
        locale: "sv",
        subject: "{{brand.name}}: bokning {{booking.reference}}",
        body_html:
          "<p>Hej {{booking.contact.firstName}} {{booking.contact.lastName}}, din bokning " +
          '{{booking.reference}}: <a href="{{booking.url}}">visa den</a>.</p>',
        body_text:
          "Hej {{booking.contact.firstName}} {{booking.contact.lastName}}, din bokning {{booking.reference}}: " +
          "{{booking.url}}",
      })
      .execute();
  });
  await inTenant(
    (trx) => seedStorefrontSettings(trx, { name: "Beta Trips", defaultCurrency: "EUR", defaultLocale: "en" }),
    BETA,
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
  const config = loadWorkerConfig({
    ...testWorkerVariables(),
    APP_ENV: "test",
    DATABASE_URL: db.urlFor("ota"),
    DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
    REDIS_URL: redis.url,
    SMTP_URL: mailpitSmtpUrl(),
  });
  useNextApplicationLoggerOutsideRequests();
  worker = await createWorkerApp(
    WorkerModule.forRoot(config, { logger: createWorkerLogger(config, workerSink) }),
  );
  await worker.init();
  // No scheduler iteration may fire while the file runs: each commit's `notify` job sends the e-mails.
  const maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
  // The first calls of a process open the pools' connections and warm the token, validation and Amadeus code; done
  // once here, so that no test pays for it.
  const warmCustomer = await newCustomer();
  const warmBooking = await seedBooking(await newStubOrder(uniqueEmail("update.warm")), {
    customerId: warmCustomer.id,
  });
  const warm = await keyUpdate(warmBooking, { customerToken: warmCustomer.token }, '"1"', {
    remarks: [{ text: "Warm up" }],
  });
  expect(answer(warm)).toEqual([200, undefined]);
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await api?.close();
  await stub?.stop();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

describe("a signed-in customer changes the contacts and adds a special request (storefront edge)", () => {
  const oldEmail = uniqueEmail("update.old");
  const newEmail = uniqueEmail("update.new");
  let bookingId: string;
  let orderId: string;
  let res: Response;
  let before: Awaited<ReturnType<typeof localState>>;
  let after: Awaited<ReturnType<typeof localState>>;
  let atAmadeus: JsonObject;
  let patches: ReturnType<typeof amadeusCalls>;
  let events: Response;
  let mails: MailpitMessage[];

  beforeAll(async () => {
    const customer = await newCustomer();
    const order = await newStubOrder(oldEmail);
    orderId = order["id"] as string;
    bookingId = await seedBooking(order, { customerId: customer.id });
    before = await localState(bookingId);
    stub.clearRequests();

    res = await edgeUpdate(bookingId, customer.token, '"1"', {
      contacts: [newContact(newEmail)],
      remarks: [{ text: "Wheelchair at arrival", travelerIds: ["1"] }],
    });

    patches = amadeusCalls("patchFlightOrder");
    atAmadeus = await stubOrder(orderId);
    after = await localState(bookingId);
    const headers = edgeWriteHeaders(ALPHA_HOST);
    events = await request(api.server)
      .get(`/v1/bookings/${bookingId}/events`)
      .set({ ...headers, Cookie: `${headers["Cookie"] ?? ""}; __Host-vx_at=${customer.token}` });
    mails = await Promise.all([
      waitForMessage({ to: newEmail, timeoutMs: MAIL_WAIT_MS }),
      waitForMessage({ to: oldEmail, timeoutMs: MAIL_WAIT_MS }),
    ]);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-048 AC1] answers 200 with the updated booking and the ETag of its next version", () => {
    expect(answer(res)).toEqual([200, undefined]);
    expectResponseToMatch("updateBooking", res);
    expect(res.headers["etag"]).toBe('"2"');
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const body = res.body as {
      version: number;
      contacts: Array<{ emailAddress: string; isPrimary: boolean }>;
      remarks: Array<{ text: string; travelerIds: string[] }>;
    };
    expect(body.version).toBe(2);
    expect(body.contacts.map((contact) => [contact.emailAddress, contact.isPrimary])).toEqual([
      [newEmail, true],
    ]);
    expect(body.remarks.map((remark) => [remark.text, remark.travelerIds])).toEqual([
      ["VEGETARIAN MEAL PLEASE", ["1"]],
      ["WHEELCHAIR AT ARRIVAL", ["1"]],
    ]);
  });

  it("[OBE-048 AC1] changes the order at Amadeus with one PATCH: every contact, the remarks kept and the new one", () => {
    expect(patches.map((call) => call.status)).toEqual([200]);
    expect(records(atAmadeus["contacts"]).map((contact) => contact["emailAddress"])).toEqual([newEmail]);
    expect(records(atAmadeus["contacts"])[0]).not.toHaveProperty("isPrimary");
    const general = records((atAmadeus["remarks"] as JsonObject)["general"]);
    expect(general.map((remark) => [remark["subType"], remark["text"]])).toEqual([
      ["GENERAL_MISCELLANEOUS", "VEGETARIAN MEAL PLEASE"],
      ["BACKOFFICE", expect.stringMatching(/^VELEXIS [A-Z0-9]+$/)],
      ["GENERAL_MISCELLANEOUS", "WHEELCHAIR AT ARRIVAL"],
    ]);
  });

  it("[OBE-048 AC1] records the contacts, the contact e-mail, the special request, the snapshot and the new version", () => {
    expect(after.booking.version).toBe(before.booking.version + 1);
    expect(after.booking.contact_email).toBe(newEmail);
    expect(after.contacts).toEqual([
      {
        purpose: "STANDARD",
        is_primary: true,
        email: newEmail,
        first_name: "TESTB",
        last_name: "SAMPLE",
        phones: [{ deviceType: "MOBILE", countryCallingCode: "46", number: "709876543" }],
      },
    ]);
    expect(after.remarks).toEqual([
      ...before.remarks,
      {
        kind: "general",
        sub_type: "GENERAL_MISCELLANEOUS",
        text: "WHEELCHAIR AT ARRIVAL",
        traveler_ids: ["1"],
        visible_to_customer: true,
      },
    ]);
    const snapshot = after.booking.order_snapshot as JsonObject;
    expect(records(snapshot["contacts"]).map((contact) => contact["emailAddress"])).toEqual([newEmail]);
    expect(after.booking.sync_error).toBeNull();
  });

  it("[OBE-048 AC1] writes the customer-visible events, which bookings.listEvents shows", () => {
    expect(after.events.slice(before.events.length)).toEqual([
      {
        type: "booking.contacts_updated",
        actor_type: "customer",
        visible_to_customer: true,
        data: { contacts: 1 },
        summary: "Contact details updated.",
      },
      {
        type: "booking.remark_added",
        actor_type: "customer",
        visible_to_customer: true,
        data: { remarks: 1 },
        summary: "Special request added.",
      },
    ]);
    expect(answer(events)).toEqual([200, undefined]);
    expectResponseToMatch("listBookingEvents", events);
    expect((events.body as { data: Array<{ type: string }> }).data.map((event) => event.type)).toEqual([
      "booking.remark_added",
      "booking.contacts_updated",
    ]);
  });

  it("[OBE-048 AC1] e-mails the confirmation to the new and the old address, once each", () => {
    expect(
      after.notifications.map((row) => [
        row.template_key,
        row.recipient,
        row.recipient_type,
        row.locale,
        row.dedupe_key,
      ]),
    ).toEqual([
      ["booking.confirmed", newEmail, "customer", "sv", `booking.contacts_updated:${bookingId}:v2:new`],
      ["booking.confirmed", oldEmail, "customer", "sv", `booking.contacts_updated:${bookingId}:v2:old`],
    ]);
    expect(mails.map((mail) => mail.To.map((address) => address.Address))).toEqual([[newEmail], [oldEmail]]);
    for (const mail of mails) {
      expect(mail.Subject).toMatch(/^Alpha Travel: bokning [A-Z0-9]+$/);
      expect(mail.Text).toContain("Hej TESTB SAMPLE");
      expect(mail.Text).toContain(`https://alpha.ota.example.com/booking.html?id=${bookingId}`);
    }
  });

  it("never writes the addresses into a log line", () => {
    for (const address of [newEmail, oldEmail]) {
      expect(api.sink.text()).not.toContain(address);
      expect(workerSink.text()).not.toContain(address);
    }
  });
});

describe("a guest holding the booking token adds a special request (secret key)", () => {
  let bookingId: string;
  let first: Response;
  let again: Response;
  let before: Awaited<ReturnType<typeof localState>>;
  let after: Awaited<ReturnType<typeof localState>>;
  let patches: ReturnType<typeof amadeusCalls>;

  beforeAll(async () => {
    bookingId = await seedBooking(await newStubOrder(uniqueEmail("update.guest")));
    const token = await guestToken(bookingId);
    before = await localState(bookingId);
    stub.clearRequests();

    first = await keyUpdate(bookingId, { bookingToken: token }, '"1"', {
      remarks: [{ text: "Extra legroom please" }],
    });
    // The same request again with the new ETag: the order has it already, so nothing is sent or changed.
    again = await keyUpdate(bookingId, { bookingToken: token }, String(first.headers["etag"]), {
      remarks: [{ text: "extra legroom please" }],
    });

    patches = amadeusCalls("patchFlightOrder");
    after = await localState(bookingId);
  }, SCENARIO_TIMEOUT_MS);

  it("adds the request at Amadeus and in the booking, with an event of the key and no e-mail", () => {
    expect(answer(first)).toEqual([200, undefined]);
    expectResponseToMatch("updateBooking", first);
    expect(first.headers["etag"]).toBe('"2"');
    expect(after.remarks.slice(before.remarks.length)).toEqual([
      {
        kind: "general",
        sub_type: "GENERAL_MISCELLANEOUS",
        text: "EXTRA LEGROOM PLEASE",
        traveler_ids: [],
        visible_to_customer: true,
      },
    ]);
    expect(after.events.slice(before.events.length).map((event) => [event.type, event.actor_type])).toEqual([
      // The storefront server's key acted for the token holder (tenant.guard.ts `initialActor`).
      ["booking.remark_added", "api_key"],
    ]);
    expect(after.contacts).toEqual(before.contacts);
    expect(after.notifications).toEqual([]);
  });

  it("answers a repeated request with the booking as it is: no second PATCH, no new version", () => {
    expect(answer(again)).toEqual([200, undefined]);
    expect(again.headers["etag"]).toBe('"2"');
    expect(patches).toHaveLength(1);
    expect(after.booking.version).toBe(2);
  });
});

describe("Amadeus refuses the PATCH with 2552 (the order changed meanwhile)", () => {
  let bookingId: string;
  let orderId: string;
  let res: Response;
  let before: Awaited<ReturnType<typeof localState>>;
  let after: Awaited<ReturnType<typeof localState>>;
  let orderBefore: JsonObject;
  let orderAfter: JsonObject;

  beforeAll(async () => {
    const customer = await newCustomer();
    const order = await newStubOrder(uniqueEmail("update.conflict"));
    orderId = order["id"] as string;
    bookingId = await seedBooking(order, { customerId: customer.id });
    before = await localState(bookingId);
    orderBefore = await stubOrder(orderId);

    res = await keyUpdate(
      bookingId,
      { customerToken: customer.token },
      '"1"',
      { contacts: [newContact(uniqueEmail("update.conflict.new"))], remarks: [{ text: "Window seat" }] },
      { "X-Stub-Scenario": "version-conflict" },
    );

    after = await localState(bookingId);
    orderAfter = await stubOrder(orderId);
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-048 AC2] answers 409 VERSION_CONFLICT", () => {
    expect(answer(res)).toEqual([409, "VERSION_CONFLICT"]);
    expectResponseToMatch("updateBooking", res);
  });

  it("[OBE-048 AC2] changes nothing locally: the booking, its contacts, remarks, events and e-mails stay as they were", () => {
    expect(after).toEqual(before);
    expect(orderAfter).toEqual(orderBefore);
  });
});

describe("a PATCH that times out (the change was applied at Amadeus)", () => {
  const oldEmail = uniqueEmail("update.timeout.old");
  const newEmail = uniqueEmail("update.timeout.new");
  let bookingId: string;
  let customerToken: string;
  let res: Response;
  let retry: Response;
  let before: Awaited<ReturnType<typeof localState>>;
  let after: Awaited<ReturnType<typeof localState>>;
  let calls: Array<[string | undefined, number | undefined]>;

  beforeAll(async () => {
    const customer = await newCustomer();
    customerToken = customer.token;
    bookingId = await seedBooking(await newStubOrder(oldEmail), { customerId: customer.id });
    before = await localState(bookingId);
    stub.clearRequests();
    // The PATCH times out at the stub after applying the change (scenario `timeout`, chosen for that one call).
    const client = api.app.get(AmadeusClient, { strict: false });
    const patch = client.patchFlightOrder.bind(client);
    const spy = vi
      .spyOn(client, "patchFlightOrder")
      .mockImplementationOnce((context, req, options) =>
        patch({ ...context, stubScenario: "timeout" }, req, options),
      );

    res = await keyUpdate(bookingId, { customerToken }, '"1"', {
      contacts: [newContact(newEmail)],
      remarks: [{ text: "Wheelchair at arrival" }],
    });
    spy.mockRestore();
    calls = stub
      .requests()
      .filter((entry) => entry.operation === "patchFlightOrder" || entry.operation === "getFlightOrder")
      .map((entry) => [entry.operation, entry.status]);
    after = await localState(bookingId);
    retry = await keyUpdate(bookingId, { customerToken }, '"1"', { contacts: [newContact(newEmail)] });
    await Promise.all([
      waitForMessage({ to: newEmail, timeoutMs: MAIL_WAIT_MS }),
      waitForMessage({ to: oldEmail, timeoutMs: MAIL_WAIT_MS }),
    ]);
  }, SCENARIO_TIMEOUT_MS);

  it("reads the order back, then answers 504 SUPPLIER_TIMEOUT", () => {
    expect(answer(res)).toEqual([504, "SUPPLIER_TIMEOUT"]);
    expectResponseToMatch("updateBooking", res);
    expect(calls).toEqual([
      ["patchFlightOrder", 504],
      ["getFlightOrder", 200],
    ]);
  });

  it("records what Amadeus applied, with a new version, the events and both e-mails", () => {
    expect(after.booking.version).toBe(before.booking.version + 1);
    expect(after.booking.contact_email).toBe(newEmail);
    expect(after.contacts.map((contact) => [contact.email, contact.is_primary])).toEqual([[newEmail, true]]);
    expect(after.remarks.slice(before.remarks.length).map((remark) => remark.text)).toEqual([
      "WHEELCHAIR AT ARRIVAL",
    ]);
    const added = after.events.slice(before.events.length).filter((event) => event.visible_to_customer);
    expect(added.map((event) => [event.type, event.data])).toEqual([
      ["booking.contacts_updated", { cause: "resync_after_timeout", contacts: 1 }],
      ["booking.remark_added", { cause: "resync_after_timeout", remarks: 1 }],
    ]);
    expect(after.notifications.map((row) => row.recipient)).toEqual([newEmail, oldEmail]);
  });

  it("makes a retry with the old If-Match stale: 412 PRECONDITION_FAILED", () => {
    expect(answer(retry)).toEqual([412, "PRECONDITION_FAILED"]);
    expectResponseToMatch("updateBooking", retry);
  });
});

describe("a PATCH whose outcome is unknown but that changed nothing (a lost answer, then an Amadeus 500)", () => {
  let bookingId: string;
  let orderId: string;
  let lost: Response;
  let failed: Response;
  let retry: Response;
  let before: Awaited<ReturnType<typeof localState>>;
  let afterFailures: Awaited<ReturnType<typeof localState>>;
  let after: Awaited<ReturnType<typeof localState>>;
  let calls: Array<[string | undefined, number | undefined]>;
  let atAmadeus: JsonObject;

  beforeAll(async () => {
    const customer = await newCustomer();
    const order = await newStubOrder(uniqueEmail("update.lost"));
    orderId = order["id"] as string;
    bookingId = await seedBooking(order, { customerId: customer.id });
    before = await localState(bookingId);
    stub.clearRequests();
    // The first PATCH times out at the stub without applying anything (`timeout-lost`), the second fails with a 500
    // (`server-error`); each scenario is chosen for that one call, so the reads back answer as usual.
    const client = api.app.get(AmadeusClient, { strict: false });
    const patch = client.patchFlightOrder.bind(client);
    const spy = vi
      .spyOn(client, "patchFlightOrder")
      .mockImplementationOnce((context, req, options) =>
        patch({ ...context, stubScenario: "timeout-lost" }, req, options),
      )
      .mockImplementationOnce((context, req, options) =>
        patch({ ...context, stubScenario: "server-error" }, req, options),
      );
    const body = { remarks: [{ text: "Bassinet seat" }] };

    lost = await keyUpdate(bookingId, { customerToken: customer.token }, '"1"', body);
    failed = await keyUpdate(bookingId, { customerToken: customer.token }, '"1"', body);
    spy.mockRestore();
    afterFailures = await localState(bookingId);
    // The same request with the same ETag, as the storefront retries it.
    retry = await keyUpdate(bookingId, { customerToken: customer.token }, '"1"', body);

    calls = stub
      .requests()
      .filter((entry) => entry.operation === "patchFlightOrder" || entry.operation === "getFlightOrder")
      .map((entry) => [entry.operation, entry.status]);
    after = await localState(bookingId);
    atAmadeus = await stubOrder(orderId);
  }, SCENARIO_TIMEOUT_MS);

  it("reads the order back after each failure and answers 504, then 502", () => {
    expect(answer(lost)).toEqual([504, "SUPPLIER_TIMEOUT"]);
    expectResponseToMatch("updateBooking", lost);
    expect(answer(failed)).toEqual([502, "SUPPLIER_ERROR"]);
    expectResponseToMatch("updateBooking", failed);
    expect(calls).toEqual([
      ["patchFlightOrder", 504],
      ["getFlightOrder", 200],
      ["patchFlightOrder", 500],
      ["getFlightOrder", 200],
      ["patchFlightOrder", 200],
    ]);
  });

  it("records nothing the customer sees while the order does not hold the change: same version, remarks and events", () => {
    expect(afterFailures.booking.version).toBe(before.booking.version);
    expect(afterFailures.remarks).toEqual(before.remarks);
    expect(afterFailures.contacts).toEqual(before.contacts);
    expect(afterFailures.events.filter((event) => event.visible_to_customer)).toEqual(
      before.events.filter((event) => event.visible_to_customer),
    );
    expect(afterFailures.notifications).toEqual([]);
  });

  it("lets the retry with the same If-Match add the special request once, at Amadeus and in the booking", () => {
    expect(answer(retry)).toEqual([200, undefined]);
    expect(retry.headers["etag"]).toBe('"2"');
    const general = records((atAmadeus["remarks"] as JsonObject)["general"]);
    expect(general.filter((remark) => remark["text"] === "BASSINET SEAT")).toHaveLength(1);
    expect(after.remarks.slice(before.remarks.length).map((remark) => remark.text)).toEqual([
      "BASSINET SEAT",
    ]);
    expect(
      after.events.slice(before.events.length).filter((event) => event.type === "booking.remark_added"),
    ).toHaveLength(1);
  });
});

describe("the refusals before Amadeus", () => {
  let customer: { readonly id: string; readonly token: string };
  let bookingId: string;
  let before: Awaited<ReturnType<typeof localState>>;

  beforeAll(async () => {
    customer = await newCustomer();
    bookingId = await seedBooking(await newStubOrder(uniqueEmail("update.refused")), {
      customerId: customer.id,
    });
    before = await localState(bookingId);
  }, SCENARIO_TIMEOUT_MS);

  const update = (body: unknown, ifMatch = '"1"', target = bookingId) =>
    keyUpdate(target, { customerToken: customer.token }, ifMatch, body);

  it("[OBE-048 AC1] answers traveller changes with 403 FEATURE_DISABLED travelerChanges", async () => {
    stub.clearRequests();

    const res = await update({
      contacts: [newContact(uniqueEmail("update.refused.new"))],
      travelers: [{ travelerId: "1", loyaltyPrograms: [{ programOwner: "AF", id: "2099887766" }] }],
    });

    expect(answer(res)).toEqual([403, "FEATURE_DISABLED"]);
    expectResponseToMatch("updateBooking", res);
    expect(res.body.error.details).toEqual({ feature: "travelerChanges" });
    expect(amadeusCalls("patchFlightOrder")).toEqual([]);
    expect(await localState(bookingId)).toEqual(before);
  });

  it("answers a stale If-Match with 412 PRECONDITION_FAILED", async () => {
    const res = await update({ remarks: [{ text: "Window seat" }] }, '"7"');

    expect(answer(res)).toEqual([412, "PRECONDITION_FAILED"]);
    expectResponseToMatch("updateBooking", res);
  });

  it("answers invalid contacts with 422 CONTACT_DATA_INVALID and an unknown traveller with 400", async () => {
    const contacts = await update({
      contacts: [{ purpose: "INVOICE", emailAddress: uniqueEmail("update.refused.invoice") }],
    });
    const remarks = await update({ remarks: [{ text: "Window seat", travelerIds: ["5"] }] });

    expect(answer(contacts)).toEqual([422, "CONTACT_DATA_INVALID"]);
    expectResponseToMatch("updateBooking", contacts);
    expect(contacts.body.error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/contacts/0/purpose" }),
    ]);
    expect(answer(remarks)).toEqual([400, "VALIDATION_FAILED"]);
    expectResponseToMatch("updateBooking", remarks);
    expect(remarks.body.error.fieldErrors).toEqual([
      expect.objectContaining({ path: "/remarks/0/travelerIds/0" }),
    ]);
    expect(await localState(bookingId)).toEqual(before);
  });

  it("answers a special request of blanks only with 400, without calling Amadeus", async () => {
    stub.clearRequests();

    const res = await update({ remarks: [{ text: "   " }] });

    expect(answer(res)).toEqual([400, "VALIDATION_FAILED"]);
    expectResponseToMatch("updateBooking", res);
    expect(res.body.error.fieldErrors).toEqual([expect.objectContaining({ path: "/remarks/0/text" })]);
    expect(amadeusCalls("patchFlightOrder")).toEqual([]);
    expect(await localState(bookingId)).toEqual(before);
  });

  it("answers a cancelled booking with 409 BOOKING_ALREADY_CANCELLED and a trip that is over with 409", async () => {
    const cancelled = await seedBooking(await newStubOrder(uniqueEmail("update.cancelled")), {
      customerId: customer.id,
      status: "cancelled",
    });
    const flown = await seedBooking(await newStubOrder(uniqueEmail("update.flown")), {
      customerId: customer.id,
      departInMs: -5 * DAY,
    });

    const onCancelled = await update({ remarks: [{ text: "Window seat" }] }, '"1"', cancelled);
    const onFlown = await update({ contacts: [newContact(uniqueEmail("update.flown.new"))] }, '"1"', flown);

    expect(answer(onCancelled)).toEqual([409, "BOOKING_ALREADY_CANCELLED"]);
    expectResponseToMatch("updateBooking", onCancelled);
    expect(answer(onFlown)).toEqual([409, "BOOKING_NOT_MODIFIABLE"]);
    expect(onFlown.body.error.details).toEqual({ reason: "flown", action: "canModifyContacts" });
  });

  it("answers another customer's booking with 404 and a call without a credential with 401", async () => {
    const other = await newCustomer();

    const foreign = await keyUpdate(bookingId, { customerToken: other.token }, '"1"', {
      remarks: [{ text: "Window seat" }],
    });
    const anonymous = await keyUpdate(bookingId, {}, '"1"', { remarks: [{ text: "Window seat" }] });

    expect(answer(foreign)).toEqual([404, "NOT_FOUND"]);
    expectResponseToMatch("updateBooking", foreign);
    expect(answer(anonymous)).toEqual([401, "UNAUTHENTICATED"]);
    expect(await localState(bookingId)).toEqual(before);
  });
});

describe("tenant isolation", () => {
  it("never reaches another tenant's booking: alpha's caller gets 404, its repository changes nothing of beta", async () => {
    const customer = await newCustomer();
    const betaBooking = newId("bkg");
    const outbound = new Date(Date.now() + 10 * DAY);
    await inTenant(async (trx) => {
      await trx
        .insertInto("bookings")
        .values({
          id: betaBooking,
          environment: "test",
          reference: newBookingReference(),
          customer_id: null,
          status: "confirmed",
          amadeus_order_id: `ORDER-${betaBooking.slice(-10)}`,
          first_departure_at: outbound,
          last_arrival_at: new Date(outbound.getTime() + 2 * HOUR),
          currency: "EUR",
          net_amount: "98.47",
          total_amount: "110.47",
          contact_email: "beta-contact@example.com",
          lead_last_name: "SAMPLE",
        })
        .execute();
      await trx
        .insertInto("booking_contacts")
        .values({
          id: newId("bco"),
          booking_id: betaBooking,
          purpose: "STANDARD",
          is_primary: true,
          email: "beta-contact@example.com",
        })
        .execute();
    }, BETA);

    const res = await keyUpdate(betaBooking, { customerToken: customer.token }, '"1"', {
      contacts: [newContact(uniqueEmail("update.isolation"))],
    });
    const repository = new BookingChangesRepository();
    await inTenant((trx) => repository.replaceContacts(trx, betaBooking, []));

    expect(answer(res)).toEqual([404, "NOT_FOUND"]);
    const betaContacts = await inTenant(
      (trx) =>
        trx.selectFrom("booking_contacts").select("email").where("booking_id", "=", betaBooking).execute(),
      BETA,
    );
    expect(betaContacts).toEqual([{ email: "beta-contact@example.com" }]);
    expect(await inTenant((trx) => repository.bookingRequirements(trx, newId("prc")))).toBeUndefined();
  });
});
