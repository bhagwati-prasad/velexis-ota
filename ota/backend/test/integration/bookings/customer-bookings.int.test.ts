// The customer bookings reads (OBE-046, OF-07; ota/docs/flows/my-bookings-and-guest-lookup.md §3 steps 4–5, db README
// §10 "My trips"): bookings.list, bookings.get (with refresh), bookings.getTicketingStatus, bookings.listEvents and
// bookings.getFareRules against PostgreSQL 16, Redis 7 and the Amadeus stub.
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned) and writes the platform rows
// as the platform does: alpha on the Velexis test Amadeus account with a test storefront and a test and a live secret
// key; beta live (its storefront serves the live environment). Customers are inserted with their access tokens signed
// by the API's own key. Bookings are rows inserted the way the record step writes them (test/builders' synthetic
// travellers, flights moved relative to now, so no calendar date is fixed); the bookings that are refreshed point at
// orders created in the stub through its own HTTP API (their flight moved 10 days ahead of now) and hold that order's
// segments, as the record step stores them: since FIX-W27-SYNC a refresh records the order through the background
// sync's diff, so a booking whose segments differ from its order's sees a schedule change. Every answer is checked
// against the OTA document. One scenario
// (FIX-W26-BOOKINGS, a refresh that stores a new ticket) also starts the worker's module graph on the same database and
// Redis for a moment, so the `ota-documents` consumer renders the itinerary the refresh asks for.
import { randomBytes, randomInt } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getQueueToken } from "@nestjs/bullmq";
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
import { startAmadeusStub, stubScenario, type AmadeusStub } from "@velexis/testing/amadeus";
import { Job, type Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AmadeusClient } from "../../../src/amadeus/amadeus.client";
import { REFRESH_THROTTLE_MS } from "../../../src/bookings/allowed-actions";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { BookingsRepository, REFRESH_CLAIM_EVENT } from "../../../src/bookings/bookings.repository";
import { orderSegmentsOf } from "../../../src/bookings/order-diff";
import { readCreatedOrder } from "../../../src/bookings/order-recorder";
import { buildCreateOrderRequest, buildIssueRequest } from "../../../src/bookings/order-request.builder";
import { bookingTokenHash } from "../../../src/common/auth/booking-access.guard";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { loadWorkerConfig, type ApiConfig } from "../../../src/config";
import {
  documentRenderJob,
  documentRenderKey,
  type DocumentRenderJobResult,
} from "../../../src/documents/documents.processor";
import { TokenService } from "../../../src/identity/token.service";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { buildOrderRequestInput, pricedFlightOffer } from "../../builders/bookings";
import { newDocumentNumber } from "../../builders/checkouts";
import {
  edgeHeaders,
  newApiKey,
  TEST_STOREFRONT_BASE_DOMAIN,
  testApiCredentials,
  testKeyProvider,
  testWorkerVariables,
} from "../../helpers/api-env";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";
import { pdfText } from "../../support/pdf-text";

type JsonObject = Record<string, unknown>;
type Schema = "tenant_alpha" | "tenant_beta";

/**
 * The API's OPS_ALERT_EMAIL (FIX-W28-NOTIFY: both processes read it), the last recipient of a staff alert of an OTA
 * without an alert address or an owner (alpha has none).
 */
const VELEXIS_OPS = `velexis-ops-${randomBytes(4).toString("hex")}@example.com`;
const ALPHA_HOST = "alpha.ota.example.com";
const BETA_HOST = "beta.ota.example.com";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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
let accountId: string;
let alphaId: string;
let betaId: string;
let alphaSk: string;
let alphaLiveSk: string;
let office: string;
let stubCredentials: { readonly clientId: string; readonly clientSecret: string };

async function insertAccount(clientId: string, secret: string): Promise<string> {
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

async function insertTenant(key: "alpha" | "beta", live: boolean): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({
      id,
      key,
      name: `${key} Travel`,
      status: "active",
      plan_code: "early_access",
      ...(live ? { storefront_environment: "live", live_enabled_at: new Date() } : {}),
    })
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
  return id;
}

async function issueKey(tenantId: string, environment: "test" | "live"): Promise<string> {
  const key = newApiKey("sk", environment);
  await migrator
    .insertInto("platform.api_keys")
    .values({
      id: newId("key"),
      tenant_id: tenantId,
      name: `Server (${environment})`,
      kind: "secret",
      environment,
      prefix: key.slice(0, 14),
      key_hash: hashApiKey(key, testApiCredentials().pepper),
      last4: key.slice(-4),
    })
    .execute();
  return key;
}

const inTenant = <T>(schema: Schema, run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, schema, run);

/** A customer of `schema` and an access token for it (bearer for keys, `__Host-vx_at` for the edge). */
async function newCustomer(
  schema: Schema = "tenant_alpha",
): Promise<{ readonly id: string; readonly token: string }> {
  const id = newId("cus");
  await inTenant(schema, (trx) =>
    trx
      .insertInto("customers")
      .values({
        id,
        email: `${id.toLowerCase()}@example.com`,
        email_verified_at: new Date(),
        first_name: "TESTA",
        last_name: "CUSTOMER",
      })
      .execute(),
  );
  const signed = await tokens.signCustomerToken({
    sub: id,
    tid: schema === "tenant_alpha" ? alphaId : betaId,
    sid: newId("ses"),
  });
  return { id, token: signed.token };
}

const local = (date: Date): string => date.toISOString().slice(0, 19);

/** What a seeded booking looks like. */
interface BookingSeed {
  readonly customerId: string | null;
  readonly schema?: Schema;
  readonly environment?: "test" | "live";
  readonly status?: string;
  readonly ticketingStatus?: string;
  /** The first departure, relative to now; each flight lasts 2 hours. */
  readonly departInMs: number;
  /** A return flight this long after the outbound departure. */
  readonly returnAfterMs?: number;
  /** Rows for the flights (pending bookings have none). */
  readonly segments?: boolean;
  readonly createdAgoMs?: number;
  readonly amadeusOrderId?: string | null;
  readonly snapshot?: JsonObject;
  readonly tickets?: readonly string[];
  readonly lastSyncedAgoMs?: number;
}

/** The segments of a stored order snapshot (a stub order's `data`), or `undefined` when it holds no readable order. */
function snapshotSegmentsOf(snapshot: JsonObject | undefined) {
  const order = snapshot === undefined ? undefined : readCreatedOrder({ data: snapshot });
  return order === undefined ? undefined : orderSegmentsOf(order);
}

/**
 * A booking as the record step writes it: the bookings row, its MAD–ORY flight (segment "3" of offer "2", the stub's
 * offer) and, with a return, ORY–MAD; one adult traveller, a special request and the staff-only VELEXIS remark. A
 * booking of a stub order (`snapshot`) holds that order's segments instead, their local times read as UTC (the
 * fixture's airports have no time zone in the template's reference data), as the record step stores them.
 */
async function seedBooking(seed: BookingSeed): Promise<string> {
  const id = newId("bkg");
  const schema = seed.schema ?? "tenant_alpha";
  const now = Date.now();
  const ordered = snapshotSegmentsOf(seed.snapshot);
  const orderedFirst = ordered?.[0];
  const outbound =
    orderedFirst === undefined
      ? new Date(now + seed.departInMs)
      : new Date(`${orderedFirst.departureLocal}Z`);
  const inbound =
    seed.returnAfterMs === undefined ? undefined : new Date(outbound.getTime() + seed.returnAfterMs);
  const lastArrival =
    ordered !== undefined && ordered.length > 0
      ? new Date(Math.max(...ordered.map((segment) => new Date(`${segment.arrivalLocal}Z`).getTime())))
      : new Date((inbound ?? outbound).getTime() + 2 * HOUR);
  const status = seed.status ?? "confirmed";
  await inTenant(schema, async (trx) => {
    await trx
      .insertInto("bookings")
      .values({
        id,
        environment: seed.environment ?? "test",
        reference: newBookingReference(),
        customer_id: seed.customerId,
        status,
        ticketing_status:
          seed.ticketingStatus ??
          (status === "ticketed" ? "issued" : status === "failed" ? "not_applicable" : "pending"),
        amadeus_order_id: seed.amadeusOrderId === undefined ? `ORDER-${id.slice(-10)}` : seed.amadeusOrderId,
        record_locator:
          status === "pending" || status === "failed" ? null : randomBytes(3).toString("hex").toUpperCase(),
        origin_system_code: "GDS",
        owner_office_id: office,
        queuing_office_id: office,
        trip_type: inbound === undefined ? "one_way" : "round_trip",
        origin_iata: "MAD",
        destination_iata: "ORY",
        first_departure_at: outbound,
        last_arrival_at: lastArrival,
        travelers_count: 1,
        currency: "EUR",
        net_amount: "98.47",
        net_base_amount: "56.00",
        net_fees_amount: "0.00",
        markup_amount: "12.00",
        taxes_amount: "42.47",
        total_amount: "110.47",
        contact_email: "contact-1@example.com",
        lead_last_name: "SAMPLE",
        cancelled_at: status === "cancelled" ? new Date(now - HOUR) : null,
        cancelled_by: status === "cancelled" ? "customer" : null,
        order_snapshot: JSON.stringify(seed.snapshot ?? {}),
        last_synced_at: seed.lastSyncedAgoMs === undefined ? null : new Date(now - seed.lastSyncedAgoMs),
        created_at: new Date(now - (seed.createdAgoMs ?? 0)),
      })
      .execute();
    if (seed.segments === false || status === "pending") {
      return;
    }
    if (ordered !== undefined && ordered.length > 0) {
      await trx
        .insertInto("booking_segments")
        .values(
          ordered.map((segment) => ({
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
            ...(segment.isFlown === null ? {} : { is_flown: segment.isFlown }),
          })),
        )
        .execute();
    }
    const flights =
      ordered !== undefined && ordered.length > 0
        ? []
        : [
            { from: "MAD", to: "ORY", at: outbound, segmentId: "3", itinerary: 0 },
            ...(inbound === undefined
              ? []
              : [{ from: "ORY", to: "MAD", at: inbound, segmentId: "4", itinerary: 1 }]),
          ];
    for (const flight of flights) {
      await trx
        .insertInto("booking_segments")
        .values({
          id: newId("seg"),
          booking_id: id,
          amadeus_flight_offer_id: "2",
          amadeus_segment_id: flight.segmentId,
          itinerary_index: flight.itinerary,
          segment_index: 0,
          carrier_code: "IB",
          flight_number: "3436",
          departure_iata: flight.from,
          departure_local: local(flight.at),
          departure_at: flight.at,
          arrival_iata: flight.to,
          arrival_local: local(new Date(flight.at.getTime() + 2 * HOUR)),
          arrival_at: new Date(flight.at.getTime() + 2 * HOUR),
          duration_minutes: 120,
          cabin: "ECONOMY",
          booking_class: "Q",
          is_flown: flight.at.getTime() + 2 * HOUR < now,
        })
        .execute();
    }
    await trx
      .insertInto("booking_travelers")
      .values({
        id: newId("btr"),
        booking_id: id,
        amadeus_traveler_id: "1",
        traveler_type: "ADULT",
        first_name: "TESTA",
        last_name: "SAMPLE",
        date_of_birth: "1988-04-12",
        gender: "FEMALE",
      })
      .execute();
    await trx
      .insertInto("booking_remarks")
      .values([
        {
          id: newId("rmk"),
          booking_id: id,
          kind: "general",
          sub_type: "GENERAL_MISCELLANEOUS",
          text: "VEGETARIAN MEAL PLEASE",
          traveler_ids: ["1"],
          visible_to_customer: true,
        },
        {
          id: newId("rmk"),
          booking_id: id,
          kind: "general",
          sub_type: "BACKOFFICE",
          text: "VELEXIS VX7K2M9Q",
          visible_to_customer: false,
        },
      ])
      .execute();
    for (const number of seed.tickets ?? []) {
      await trx
        .insertInto("booking_tickets")
        .values({
          id: newId("tkt"),
          booking_id: id,
          amadeus_traveler_id: "1",
          document_type: "ETICKET",
          document_number: number,
          segment_ids: ["3"],
          issued_at: new Date(now - HOUR),
        })
        .execute();
    }
  });
  return id;
}

/** Appends an event to a booking. */
async function seedEvent(
  bookingId: string,
  event: {
    readonly type: string;
    readonly actorType: string;
    readonly actorId?: string | null;
    readonly visible: boolean;
    readonly agoMs: number;
    readonly summary: string;
    readonly data?: JsonObject;
  },
): Promise<string> {
  const id = newId("evt");
  const createdAt = new Date(Date.now() - event.agoMs);
  await inTenant("tenant_alpha", (trx) =>
    trx
      .insertInto("booking_events")
      .values({
        id,
        booking_id: bookingId,
        type: event.type,
        actor_type: event.actorType,
        actor_id: event.actorId ?? null,
        summary: event.summary,
        data: JSON.stringify(event.data ?? {}),
        visible_to_customer: event.visible,
        created_at: createdAt,
        updated_at: createdAt,
      })
      .execute(),
  );
  return id;
}

// ---- The stub's orders ---------------------------------------------------------------------------------------------

async function stubFetch(path: string, init: { method: string; body?: unknown }): Promise<JsonObject> {
  const tokenRes = await fetch(`${stub.url}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: stubCredentials.clientId,
      client_secret: stubCredentials.clientSecret,
    }).toString(),
  });
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };
  const res = await fetch(`${stub.url}${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/vnd.amadeus+json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as JsonObject;
}

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
 * An order of the stub (Flight Create Orders, not issued), with a fresh passport number, its flight 10 days after now
 * (to the minute), so no calendar date matters; its `data`.
 */
async function newStubOrder(documentNumber = newDocumentNumber()): Promise<JsonObject> {
  const departure = new Date(Math.floor((Date.now() + 10 * DAY) / MINUTE) * MINUTE);
  const input = buildOrderRequestInput({ flightOffers: [offerDepartingAt(departure)] });
  const traveler = input.travelers[0];
  const document = traveler?.documents[0];
  if (traveler === undefined || document === undefined) {
    throw new Error("the order request builder has no traveller with a document");
  }
  const built = buildCreateOrderRequest({
    ...input,
    travelers: [{ ...traveler, documents: [{ ...document, number: documentNumber }] }],
    remarks: [{ text: "Vegetarian meal please", travelerIds: ["1"] }],
    offices: { queuing: office, owner: office },
  });
  const created = await stubFetch("/v1/booking/flight-orders", { method: "POST", body: built.body });
  return created["data"] as JsonObject;
}

// ---- Requests ------------------------------------------------------------------------------------------------------

const bearer = (token: string, key = alphaSk): Record<string, string> => ({
  "X-Api-Key": key,
  Authorization: `Bearer ${token}`,
});
const edge = (host: string, token?: string): Record<string, string> => ({
  ...edgeHeaders(host),
  ...(token === undefined ? {} : { Cookie: `__Host-vx_at=${token}` }),
});
const get = (path: string, headers: Record<string, string>) => request(api.server).get(path).set(headers);

interface PageBody<T> {
  readonly data: T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number };
}
interface SummaryBody {
  readonly id: string;
  readonly status: string;
  readonly timeframe: string;
}
interface BookingBody {
  readonly id: string;
  readonly status: string;
  readonly version: number;
  readonly syncStatus: string;
  readonly allowedActions: { readonly canRefresh: boolean; readonly reasons: Record<string, string> };
  readonly amadeus: { readonly order: JsonObject } | null;
  readonly tickets: ReadonlyArray<{ readonly documentNumber: string }>;
  readonly warnings?: ReadonlyArray<{ readonly title: string }>;
}
interface ErrorBody {
  readonly error: { readonly code: string };
}

const listIds = (body: unknown): string[] => (body as PageBody<SummaryBody>).data.map((row) => row.id);
const amadeusCalls = (operation: string) => stub.requests().filter((entry) => entry.operation === operation);

async function bookingColumns(bookingId: string) {
  return await inTenant("tenant_alpha", (trx) =>
    trx
      .selectFrom("bookings")
      .select(["status", "ticketing_status", "version", "sync_error", "last_synced_at", "order_included"])
      .where("id", "=", bookingId)
      .executeTakeFirstOrThrow(),
  );
}

/**
 * How long and how often the concurrency test polls for requests that wait for the booking's row lock: they queue
 * within milliseconds, and the poll stays well inside Vitest's 5 s test bound.
 */
const LOCK_WAIT_POLL = { timeout: 2_000, interval: 20 };

/** How many sessions of this file's database wait for a lock right now (the row lock the test holds). */
async function lockWaiters(): Promise<number> {
  const { rows } = await otaPool.query<{ waiting: number }>(
    "SELECT count(DISTINCT l.pid)::int AS waiting FROM pg_locks l JOIN pg_stat_activity a USING (pid) " +
      "WHERE NOT l.granted AND a.datname = current_database()",
  );
  return rows[0]?.waiting ?? -1;
}

/** The booking's claim of a synchronisation (`sync_claimed_at`, FIX-W27-SYNC). */
async function syncClaimedAt(bookingId: string): Promise<Date | null> {
  const row = await inTenant("tenant_alpha", (trx) =>
    trx
      .selectFrom("bookings")
      .select("sync_claimed_at")
      .where("id", "=", bookingId)
      .executeTakeFirstOrThrow(),
  );
  return row.sync_claimed_at;
}

/** The booking's `booking.sync_requested` events: none since FIX-W27-SYNC (the claim is a column). */
async function claimEvents(bookingId: string): Promise<number> {
  const rows = await inTenant("tenant_alpha", (trx) =>
    trx
      .selectFrom("booking_events")
      .select("id")
      .where("booking_id", "=", bookingId)
      .where("type", "=", REFRESH_CLAIM_EVENT)
      .execute(),
  );
  return rows.length;
}

// Cloning the template, starting the stub and building the API's module graph take several seconds alone and much
// longer on a busy 4-CPU runner: all of it happens once here, with its own budget.
beforeAll(async () => {
  preloadOpenApiDocument();
  // The response validators of these operations compile on their first check: here, with every status checked below.
  const checker = responseChecker("ota");
  for (const [operationId, statuses] of [
    ["listBookings", [200, 400, 401]],
    ["getBooking", [200, 401, 404, 502]],
    ["getBookingTicketingStatus", [200, 404]],
    ["listBookingEvents", [200, 404]],
    ["getBookingFareRules", [200, 404, 429]],
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
  accountId = await insertAccount(stubCredentials.clientId, stubCredentials.clientSecret);
  alphaId = await insertTenant("alpha", false);
  betaId = await insertTenant("beta", true);
  alphaSk = await issueKey(alphaId, "test");
  alphaLiveSk = await issueKey(alphaId, "live");
  for (const [schema, name] of [
    ["tenant_alpha", "Alpha Travel"],
    ["tenant_beta", "Beta Trips"],
  ] as const) {
    await inTenant(schema, async (trx) => {
      await seedStorefrontSettings(trx, { name, defaultCurrency: "EUR", defaultLocale: "en" });
      await seedDefaultMarkupRule(trx);
    });
  }
  tokens = new TokenService(
    { get: () => testApiCredentials().jwtKeyFile } as unknown as ConfigService<ApiConfig, true>,
    new Clock(),
  );
  stub = await startAmadeusStub({ credentials: stubCredentials });
  api = await createTestApp({
    database: db,
    redis,
    env: { AMADEUS_BASE_URL_TEST: stub.url, OPS_ALERT_EMAIL: VELEXIS_OPS },
  });
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await stub?.stop();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

beforeEach(async () => {
  // Full Amadeus buckets and no cached platform rows from the previous test.
  await redis.client.flushdb();
  stub.clearRequests();
});

describe("bookings.list: the customer's trips by tab", () => {
  /** One customer's bookings of every kind, and the bookings that must never be listed for them. */
  let customer: { readonly id: string; readonly token: string };
  let seeded: Record<string, string>;

  // Ten bookings and two customers: the setup of this block, under its own budget.
  beforeAll(async () => {
    customer = await newCustomer();
    const other = await newCustomer();
    seeded = {
      upcomingLater: await seedBooking({
        customerId: customer.id,
        departInMs: 10 * DAY,
        returnAfterMs: 7 * DAY,
      }),
      upcomingSoon: await seedBooking({
        customerId: customer.id,
        status: "ticketed",
        departInMs: 3 * DAY,
        tickets: ["075-2412345678"],
      }),
      pending: await seedBooking({
        customerId: customer.id,
        status: "pending",
        departInMs: 20 * DAY,
        amadeusOrderId: null,
      }),
      // Out yesterday, the return flight lands in an hour: still upcoming (db README §10: last_arrival_at >= now).
      inFlight: await seedBooking({ customerId: customer.id, departInMs: -DAY, returnAfterMs: DAY - HOUR }),
      pastOlder: await seedBooking({
        customerId: customer.id,
        status: "ticketed",
        departInMs: -30 * DAY,
        createdAgoMs: 40 * DAY,
      }),
      pastNewer: await seedBooking({
        customerId: customer.id,
        status: "partially_ticketed",
        ticketingStatus: "partially_issued",
        departInMs: -10 * DAY,
        createdAgoMs: 20 * DAY,
      }),
      cancelledLater: await seedBooking({
        customerId: customer.id,
        status: "cancelled",
        ticketingStatus: "not_applicable",
        departInMs: 40 * DAY,
      }),
      cancelledEarlier: await seedBooking({
        customerId: customer.id,
        status: "cancelled",
        ticketingStatus: "not_applicable",
        departInMs: -5 * DAY,
      }),
      failed: await seedBooking({
        customerId: customer.id,
        status: "failed",
        departInMs: 15 * DAY,
        amadeusOrderId: null,
      }),
      live: await seedBooking({ customerId: customer.id, environment: "live", departInMs: 12 * DAY }),
      otherCustomer: await seedBooking({ customerId: other.id, departInMs: 11 * DAY }),
      guest: await seedBooking({ customerId: null, departInMs: 9 * DAY }),
    };
  }, 30_000);

  it("[OBE-046 AC1] [OF-07 AC1] lists upcoming, past and cancelled bookings as db README §10 defines them", async () => {
    const tab = async (timeframe?: string) => {
      const res = await get(
        `/v1/bookings${timeframe === undefined ? "" : `?timeframe=${timeframe}`}`,
        bearer(customer.token),
      );
      expect(res.status).toBe(200);
      expectResponseToMatch("listBookings", res);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      return res.body as PageBody<SummaryBody>;
    };

    const upcoming = await tab();
    expect(upcoming.data.map((row) => row.id)).toEqual([
      seeded["inFlight"],
      seeded["upcomingSoon"],
      seeded["upcomingLater"],
      seeded["pending"],
    ]);
    expect(upcoming.data.every((row) => row.timeframe === "upcoming")).toBe(true);
    expect(listIds(await tab("upcoming"))).toEqual(upcoming.data.map((row) => row.id));
    const past = await tab("past");
    expect(past.data.map((row) => row.id)).toEqual([seeded["pastNewer"], seeded["pastOlder"]]);
    expect(past.data.every((row) => row.timeframe === "past")).toBe(true);
    const cancelled = await tab("cancelled");
    expect(cancelled.data.map((row) => row.id)).toEqual([
      seeded["cancelledLater"],
      seeded["cancelledEarlier"],
    ]);
    expect(cancelled.data.every((row) => row.timeframe === "cancelled")).toBe(true);
    // Every status but failed, newest booking first; never the live booking, another customer's or a guest's.
    const all = listIds(await tab("all"));
    expect([...all].sort()).toEqual(
      [
        "upcomingLater",
        "upcomingSoon",
        "pending",
        "inFlight",
        "pastOlder",
        "pastNewer",
        "cancelledLater",
        "cancelledEarlier",
      ]
        .map((name) => seeded[name])
        .sort(),
    );
    expect(all.slice(-2)).toEqual([seeded["pastNewer"], seeded["pastOlder"]]);
  });

  it("shows a card of each booking in selling amounts", async () => {
    const res = await get("/v1/bookings?timeframe=upcoming", bearer(customer.token));

    const cards = (res.body as PageBody<JsonObject>).data;
    const roundTrip = cards.find((card) => card["id"] === seeded["upcomingLater"]);
    expect(roundTrip).toMatchObject({
      status: "confirmed",
      tripType: "round_trip",
      originCode: "MAD",
      destinationCode: "ORY",
      leadTravelerName: "TESTA SAMPLE",
      travelersCount: 1,
      total: { amount: "110.47", currency: "EUR" },
      ticketingStatus: "pending",
      hasScheduleChange: false,
      cancelledAt: null,
    });
    expect((roundTrip?.["legs"] as unknown[]).length).toBe(2);
    expect(roundTrip?.["returnAt"]).toEqual((roundTrip?.["legs"] as JsonObject[])[1]?.["departureAt"]);
    // A pending booking has no flight rows yet: its card comes from the booking row.
    expect(cards.find((card) => card["id"] === seeded["pending"])).toMatchObject({
      status: "pending",
      legs: [],
      leadTravelerName: "SAMPLE",
    });
    expect(JSON.stringify(cards)).not.toContain("98.47");
  });

  it("pages with a cursor of the same filters and refuses one of other filters", async () => {
    const first = await get("/v1/bookings?timeframe=upcoming&limit=3", bearer(customer.token));
    const firstPage = first.body as PageBody<SummaryBody>;
    expect(firstPage.data).toHaveLength(3);
    expect(firstPage.page).toMatchObject({ limit: 3 });
    const cursor = firstPage.page.nextCursor ?? "";
    expect(cursor).not.toBe("");

    const second = await get(
      `/v1/bookings?timeframe=upcoming&limit=3&cursor=${cursor}`,
      bearer(customer.token),
    );
    expect(second.status).toBe(200);
    expect(listIds(second.body)).toEqual([seeded["pending"]]);
    expect((second.body as PageBody<SummaryBody>).page.nextCursor).toBeNull();

    const mismatch = await get(`/v1/bookings?timeframe=past&cursor=${cursor}`, bearer(customer.token));
    expect(mismatch.status).toBe(400);
    expectResponseToMatch("listBookings", mismatch);
    expect((mismatch.body as ErrorBody).error.code).toBe("VALIDATION_FAILED");
  });

  it("filters by the local date of the first departure and by booking time", async () => {
    const date = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 10);

    const departing = await get(
      `/v1/bookings?timeframe=upcoming&departureFrom=${date(9 * DAY)}&departureTo=${date(11 * DAY)}`,
      bearer(customer.token),
    );
    expect(listIds(departing.body)).toEqual([seeded["upcomingLater"]]);

    const booked = await get(
      `/v1/bookings?timeframe=past&createdFrom=${new Date(Date.now() - 30 * DAY).toISOString()}`,
      bearer(customer.token),
    );
    expect(listIds(booked.body)).toEqual([seeded["pastNewer"]]);
  });

  it("answers the hosted storefront's cookie session, and needs a signed-in customer", async () => {
    const viaEdge = await get("/v1/bookings?timeframe=past", edge(ALPHA_HOST, customer.token));
    expect(viaEdge.status).toBe(200);
    expect(listIds(viaEdge.body)).toEqual([seeded["pastNewer"], seeded["pastOlder"]]);

    const anonymous = await get("/v1/bookings", { "X-Api-Key": alphaSk });
    expect(anonymous.status).toBe(401);
    expectResponseToMatch("listBookings", anonymous);
    expect((anonymous.body as ErrorBody).error.code).toBe("UNAUTHENTICATED");
  });

  it("[OBE-046 AC2] lists only the bookings of the caller's environment", async () => {
    const live = await get("/v1/bookings?timeframe=all", bearer(customer.token, alphaLiveSk));

    expect(live.status).toBe(200);
    expect(listIds(live.body)).toEqual([seeded["live"]]);
  });
});

describe("one booking: who may read it", () => {
  it("[OBE-046 AC2] answers 404 to another customer on every booking operation, and 401 without a credential", async () => {
    const owner = await newCustomer();
    const other = await newCustomer();
    const bookingId = await seedBooking({ customerId: owner.id, departInMs: 10 * DAY });
    const paths = ["", "/ticketing", "/events", "/fare-rules"].map(
      (suffix) => `/v1/bookings/${bookingId}${suffix}`,
    );
    const operations = [
      "getBooking",
      "getBookingTicketingStatus",
      "listBookingEvents",
      "getBookingFareRules",
    ];

    for (const [index, path] of paths.entries()) {
      const res = await get(path, bearer(other.token));
      expect(res.status).toBe(404);
      expectResponseToMatch(operations[index] as "getBooking", res);
      expect((res.body as ErrorBody).error.code).toBe("NOT_FOUND");
    }
    // The same answer as an id that does not exist, apart from the request id.
    const withoutRequestId = (body: unknown) => ({ ...(body as ErrorBody).error, requestId: undefined });
    const unknown = await get(`/v1/bookings/${newId("bkg")}`, bearer(other.token));
    const foreign = await get(paths[0] ?? "", bearer(other.token));
    expect(unknown.status).toBe(404);
    expect(withoutRequestId(unknown.body)).toEqual(withoutRequestId(foreign.body));
    // Without a customer or a guest token the request is not authenticated for any booking.
    const anonymous = await get(paths[0] ?? "", { "X-Api-Key": alphaSk });
    expect(anonymous.status).toBe(401);
    expectResponseToMatch("getBooking", anonymous);
    expect(amadeusCalls("getFlightOrder")).toHaveLength(0);
    // The owner reads it.
    expect((await get(paths[0] ?? "", bearer(owner.token))).status).toBe(200);
  });

  it("[OBE-046 AC2] answers 404 for a test booking seen from a live storefront, and serves its live bookings", async () => {
    const customer = await newCustomer("tenant_beta");
    const testBooking = await seedBooking({
      schema: "tenant_beta",
      customerId: customer.id,
      departInMs: 10 * DAY,
    });
    const liveBooking = await seedBooking({
      schema: "tenant_beta",
      customerId: customer.id,
      environment: "live",
      departInMs: 12 * DAY,
    });

    const test = await get(`/v1/bookings/${testBooking}`, edge(BETA_HOST, customer.token));
    expect(test.status).toBe(404);
    expectResponseToMatch("getBooking", test);
    for (const suffix of ["/ticketing", "/events", "/fare-rules"]) {
      expect(
        (await get(`/v1/bookings/${testBooking}${suffix}`, edge(BETA_HOST, customer.token))).status,
      ).toBe(404);
    }
    const live = await get(`/v1/bookings/${liveBooking}`, edge(BETA_HOST, customer.token));
    expect(live.status).toBe(200);
    expectResponseToMatch("getBooking", live);
    const listed = await get("/v1/bookings", edge(BETA_HOST, customer.token));
    expect(listIds(listed.body)).toEqual([liveBooking]);
  });

  it("[OBE-046 AC2] answers 404 for a test booking read with the tenant's live key", async () => {
    const customer = await newCustomer();
    const bookingId = await seedBooking({ customerId: customer.id, departInMs: 10 * DAY });

    const res = await get(`/v1/bookings/${bookingId}`, bearer(customer.token, alphaLiveSk));

    expect(res.status).toBe(404);
    expect((await get(`/v1/bookings/${bookingId}`, bearer(customer.token))).status).toBe(200);
  });

  it("finds the guest token of a booking by its hash only while it is live (the token sources come with OBE-047)", async () => {
    const bookingId = await seedBooking({ customerId: null, departInMs: 10 * DAY });
    const otherBooking = await seedBooking({ customerId: null, departInMs: 11 * DAY });
    const revokedBooking = await seedBooking({ customerId: null, departInMs: 12 * DAY });
    const token = randomBytes(32).toString("base64url");
    const insertToken = (booking: string, values: { expires: Date; revoked?: Date }) =>
      inTenant("tenant_alpha", (trx) =>
        trx
          .insertInto("booking_access_tokens")
          .values({
            id: newId("bat"),
            booking_id: booking,
            token_hash: bookingTokenHash(`${booking}.${token}`),
            issued_via: "booking_created",
            expires_at: values.expires,
            revoked_at: values.revoked ?? null,
          })
          .execute(),
      );
    await insertToken(bookingId, { expires: new Date(Date.now() + DAY) });
    await insertToken(otherBooking, { expires: new Date(Date.now() - MINUTE) });
    await insertToken(revokedBooking, { expires: new Date(Date.now() + DAY), revoked: new Date() });
    const repository = new BookingsRepository();
    const grant = (booking: string, presented: string) =>
      inTenant("tenant_alpha", (trx) =>
        repository.bookingAccess(trx, booking, [bookingTokenHash(presented)], new Date()),
      );

    expect(await grant(bookingId, `${bookingId}.${token}`)).toMatchObject({
      tokenGranted: true,
      customerId: null,
    });
    // A token of another booking, an expired token, a revoked token and a wrong one open nothing.
    expect(await grant(otherBooking, `${bookingId}.${token}`)).toMatchObject({ tokenGranted: false });
    expect(await grant(otherBooking, `${otherBooking}.${token}`)).toMatchObject({ tokenGranted: false });
    expect(await grant(revokedBooking, `${revokedBooking}.${token}`)).toMatchObject({
      tokenGranted: false,
    });
    expect(await grant(bookingId, `${bookingId}.${randomBytes(32).toString("base64url")}`)).toMatchObject({
      tokenGranted: false,
    });
    // No source presents guest tokens yet: a guest gets 401 and the page offers the lookup.
    expect((await get(`/v1/bookings/${bookingId}`, edge(ALPHA_HOST))).status).toBe(401);
  });
});

describe("bookings.get", () => {
  it("answers the booking in customer scope with its ETag and allowed actions", async () => {
    const customer = await newCustomer();
    const documentNumber = newDocumentNumber();
    const order = await newStubOrder(documentNumber);
    const bookingId = await seedBooking({
      customerId: customer.id,
      departInMs: 10 * DAY,
      amadeusOrderId: order["id"] as string,
      snapshot: redactPayload(order),
      lastSyncedAgoMs: HOUR,
    });

    const res = await get(`/v1/bookings/${bookingId}`, bearer(customer.token));

    expect(res.status).toBe(200);
    expectResponseToMatch("getBooking", res);
    expect(res.headers["etag"]).toBe('"1"');
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const booking = res.body as BookingBody & JsonObject;
    expect(booking).toMatchObject({
      id: bookingId,
      status: "confirmed",
      customerId: customer.id,
      isGuest: false,
      syncStatus: "fresh",
      totals: { base: { amount: "68.00" }, total: { amount: "110.47", currency: "EUR" } },
      remarks: [expect.objectContaining({ text: "VEGETARIAN MEAL PLEASE" })],
      allowedActions: {
        canModifyContacts: true,
        canAddRemarks: true,
        canRefresh: true,
        canCancel: false,
        canModifyTravelerDocuments: false,
        reasons: { canCancel: "disabled_by_ota", canModifyTravelerDocuments: "disabled_by_ota" },
      },
    });
    const amadeusOrder = booking.amadeus?.order ?? {};
    expect(amadeusOrder).not.toHaveProperty("queuingOfficeId");
    expect(amadeusOrder).not.toHaveProperty("automatedProcess");
    expect(amadeusOrder["remarks"]).toEqual({
      general: [{ subType: "GENERAL_MISCELLANEOUS", text: "VEGETARIAN MEAL PLEASE", travelerIds: ["1"] }],
    });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(documentNumber);
    expect(body).not.toContain(office);
    expect(body).not.toContain("VELEXIS");
    expect(body).not.toContain("98.47");
    // No Amadeus call without refresh.
    expect(amadeusCalls("getFlightOrder")).toHaveLength(0);
  });

  it("refreshes from Flight Order Management at most once a minute", async () => {
    const customer = await newCustomer();
    const order = await newStubOrder();
    const bookingId = await seedBooking({
      customerId: customer.id,
      departInMs: 10 * DAY,
      amadeusOrderId: order["id"] as string,
      snapshot: redactPayload(order),
    });

    const first = await get(`/v1/bookings/${bookingId}?refresh=true`, bearer(customer.token));
    expect(first.status).toBe(200);
    expectResponseToMatch("getBooking", first);
    expect((first.body as BookingBody).syncStatus).toBe("refreshed");
    expect((first.body as BookingBody).allowedActions).toMatchObject({
      canRefresh: false,
      reasons: { canRefresh: "throttled" },
    });
    // The order's associated records the booking did not have (here: all of them) are added.
    const records = (order["associatedRecords"] as JsonObject[]).map((record) => ({
      reference: record["reference"],
      originSystemCode: record["originSystemCode"],
    }));
    expect(records.length).toBeGreaterThan(0);
    expect((first.body as JsonObject)["recordLocators"]).toEqual(
      records.map((record) => expect.objectContaining(record)),
    );
    const second = await get(`/v1/bookings/${bookingId}?refresh=true`, bearer(customer.token));
    expect((second.body as BookingBody).syncStatus).toBe("throttled");

    expect(amadeusCalls("getFlightOrder")).toHaveLength(1);
    // The claim is the booking's column, never an event (lead decision (3) of 2026-10-23).
    expect(await claimEvents(bookingId)).toBe(0);
    expect(await syncClaimedAt(bookingId)).not.toBeNull();
    const columns = await bookingColumns(bookingId);
    expect(columns).toMatchObject({ sync_error: null, version: 1 });
    expect(columns.last_synced_at).not.toBeNull();
    // A minute later the next refresh goes to Amadeus again.
    const shift = `${REFRESH_THROTTLE_MS} milliseconds`;
    await inTenant("tenant_alpha", async (trx) => {
      await sql`UPDATE bookings SET last_synced_at = last_synced_at - ${shift}::interval,
        sync_claimed_at = sync_claimed_at - ${shift}::interval WHERE id = ${bookingId}`.execute(trx);
    });
    const third = await get(`/v1/bookings/${bookingId}?refresh=true`, bearer(customer.token));
    expect((third.body as BookingBody).syncStatus).toBe("refreshed");
    expect(amadeusCalls("getFlightOrder")).toHaveLength(2);
    // A record the booking has already is not added twice.
    expect((third.body as JsonObject)["recordLocators"]).toHaveLength(records.length);
  });

  it("calls Amadeus once for two refreshes that arrive together: the second waits for the first claim and is throttled", async () => {
    const customer = await newCustomer();
    const order = await newStubOrder();
    const bookingId = await seedBooking({
      customerId: customer.id,
      departInMs: 10 * DAY,
      amadeusOrderId: order["id"] as string,
      snapshot: redactPayload(order),
    });

    // The test holds the booking's row lock until both refreshes wait for it in their claim, so both read the
    // booking before either claim is committed; then it lets them go one after the other.
    let pending: Promise<request.Response>[] = [];
    await inTenant("tenant_alpha", async (trx) => {
      await sql`SELECT id FROM bookings WHERE id = ${bookingId} FOR UPDATE`.execute(trx);
      pending = [1, 2].map(() =>
        get(`/v1/bookings/${bookingId}?refresh=true`, bearer(customer.token)).then((res) => res),
      );
      await vi.waitFor(async () => {
        expect(await lockWaiters()).toBe(2);
      }, LOCK_WAIT_POLL);
    });
    const responses = await Promise.all(pending);

    for (const res of responses) {
      expect(res.status).toBe(200);
      expectResponseToMatch("getBooking", res);
    }
    expect(responses.map((res) => (res.body as BookingBody).syncStatus).sort()).toEqual([
      "refreshed",
      "throttled",
    ]);
    expect(amadeusCalls("getFlightOrder")).toHaveLength(1);
    // One claim, in the column (the second refresh saw it and wrote nothing), and no claim event.
    expect(await claimEvents(bookingId)).toBe(0);
    expect(await syncClaimedAt(bookingId)).not.toBeNull();
  });

  it("[FIX-W27-SYNC AC2] reports a schedule change it sees first as the background sync does: booking.schedule_changed and a new itinerary", async () => {
    const customer = await newCustomer();
    const order = await newStubOrder();
    const bookingId = await seedBooking({
      customerId: customer.id,
      departInMs: 10 * DAY,
      amadeusOrderId: order["id"] as string,
      snapshot: redactPayload(order),
    });
    const [segment] = snapshotSegmentsOf(redactPayload(order)) ?? [];
    if (segment === undefined) {
      throw new Error("the stub order has no segment");
    }
    const departure = new Date(new Date(`${segment.departureLocal}Z`).getTime() + 90 * MINUTE);
    const arrival = new Date(new Date(`${segment.arrivalLocal}Z`).getTime() + 90 * MINUTE);
    stub.orders.changeSegment(order["id"] as string, segment.amadeusSegmentId, {
      departureAt: local(departure),
      arrivalAt: local(arrival),
    });
    const documents = api.app.get<Queue>(getQueueToken(OTA_QUEUE.documents), { strict: false });

    const res = await get(`/v1/bookings/${bookingId}?refresh=true`, bearer(customer.token));

    expect(res.status).toBe(200);
    expectResponseToMatch("getBooking", res);
    expect((res.body as BookingBody).syncStatus).toBe("refreshed");
    // The segment's new times, and a new version: the documents follow it.
    expect(res.headers["etag"]).toBe('"2"');
    const itineraries = (res.body as { itineraries: Array<{ segments: JsonObject[] }> }).itineraries;
    expect(itineraries[0]?.segments[0]).toMatchObject({
      departure: expect.objectContaining({ at: local(departure) }) as unknown,
      arrival: expect.objectContaining({ at: local(arrival) }) as unknown,
    });
    // The background sync's event, visible to the customer (times changed), once.
    expect(await eventsOfType(bookingId, "booking.schedule_changed")).toBe(1);
    const events = await get(`/v1/bookings/${bookingId}/events`, bearer(customer.token));
    expect(events.status).toBe(200);
    expect((events.body as PageBody<{ type: string }>).data.map((event) => event.type)).toContain(
      "booking.schedule_changed",
    );
    // A new itinerary of the new version was asked for (DOCUMENT_TRIGGERS, FIX-W27-SYNC).
    expect(
      await documents.getDeduplicationJobId(
        documentRenderKey({ bookingId, kind: "itinerary", bookingVersion: 2 }),
      ),
    ).not.toBe(null);
    // What changed, for the console's differences.
    const stored = await inTenant("tenant_alpha", (trx) =>
      trx
        .selectFrom("bookings")
        .select(["sync_changes", "first_departure_at"])
        .where("id", "=", bookingId)
        .executeTakeFirstOrThrow(),
    );
    expect(stored.first_departure_at).toEqual(departure);
    expect(stored.sync_changes).toEqual([
      expect.objectContaining({ path: "/itineraries/0/segments/0/departure/at", after: local(departure) }),
      expect.objectContaining({ path: "/itineraries/0/segments/0/arrival/at", after: local(arrival) }),
    ]);
  });

  it("[FIX-W27-SYNC AC3] records an airline cancellation it sees first as the background sync does, and alerts staff once about the captured payment", async () => {
    const customer = await newCustomer();
    const order = await newStubOrder();
    const bookingId = await seedBooking({
      customerId: customer.id,
      departInMs: 10 * DAY,
      amadeusOrderId: order["id"] as string,
      snapshot: redactPayload(order),
    });
    const paymentId = newId("pay");
    const opsAddress = `ops-${randomBytes(4).toString("hex")}@example.com`;
    await inTenant("tenant_alpha", async (trx) => {
      await trx
        .insertInto("payments")
        .values({
          id: paymentId,
          environment: "test",
          booking_id: bookingId,
          provider: "stripe",
          provider_payment_id: `pi_${randomBytes(12).toString("hex")}`,
          currency: "EUR",
          amount: "110.47",
          amount_authorized: "110.47",
          amount_captured: "110.47",
          status: "captured",
        })
        .execute();
      // The OTA's own address comes first (StaffRecipients' rule 1), before the API's OPS_ALERT_EMAIL.
      await trx.updateTable("storefront_settings").set({ ops_alert_email: opsAddress }).execute();
    });
    stub.orders.cancelByAirline(order["id"] as string);
    const notifications = () =>
      inTenant("tenant_alpha", (trx) =>
        trx
          .selectFrom("notifications")
          .select(["template_key as templateKey", "recipient", "dedupe_key as dedupeKey", "payload"])
          .where("booking_id", "=", bookingId)
          .orderBy("template_key")
          .execute(),
      );

    try {
      const res = await get(`/v1/bookings/${bookingId}?refresh=true`, bearer(customer.token));

      expect(res.status).toBe(200);
      expectResponseToMatch("getBooking", res);
      expect(res.body).toMatchObject({ status: "cancelled", syncStatus: "refreshed" });
      expect(await bookingColumns(bookingId)).toMatchObject({ status: "cancelled" });
      // booking.cancelled through OrderRecorder.event, once, and the traveller's e-mail and the staff alert.
      expect(await eventsOfType(bookingId, "booking.cancelled")).toBe(1);
      expect(await notifications()).toEqual([
        expect.objectContaining({
          templateKey: "booking.cancelled",
          dedupeKey: `booking.cancelled:${bookingId}`,
        }),
        {
          templateKey: "staff.manual_review",
          recipient: opsAddress,
          dedupeKey: `staff.manual_review:${bookingId}:airline_cancelled`,
          payload: {
            // The API links the console at admin.<STOREFRONT_BASE_DOMAIN>, as checkout.complete's alerts do.
            booking: expect.objectContaining({
              consoleUrl: `https://admin.${TEST_STOREFRONT_BASE_DOMAIN}/bookings/${bookingId}`,
            }) as unknown,
            review: { reason: expect.stringContaining(`${paymentId} captured 110.47 EUR`) as unknown },
          },
        },
      ]);

      // A cancelled booking is no longer refreshed: no second read, no second alert.
      stub.clearRequests();
      const again = await get(`/v1/bookings/${bookingId}?refresh=true`, bearer(customer.token));
      expect(again.status).toBe(200);
      expect(amadeusCalls("getFlightOrder")).toHaveLength(0);
      expect((await notifications()).filter((row) => row.templateKey === "staff.manual_review")).toHaveLength(
        1,
      );
    } finally {
      await inTenant("tenant_alpha", (trx) =>
        trx.updateTable("storefront_settings").set({ ops_alert_email: null }).execute(),
      );
    }
  });

  it("[FIX-W28-NOTIFY AC2] sends the alert of a refresh to the API's OPS_ALERT_EMAIL when the OTA has no alert address and no owner", async () => {
    const customer = await newCustomer();
    const order = await newStubOrder();
    const bookingId = await seedBooking({
      customerId: customer.id,
      departInMs: 10 * DAY,
      amadeusOrderId: order["id"] as string,
      snapshot: redactPayload(order),
    });
    const paymentId = newId("pay");
    await inTenant("tenant_alpha", async (trx) => {
      await trx
        .insertInto("payments")
        .values({
          id: paymentId,
          environment: "test",
          booking_id: bookingId,
          provider: "stripe",
          provider_payment_id: `pi_${randomBytes(12).toString("hex")}`,
          currency: "EUR",
          amount: "110.47",
          amount_authorized: "110.47",
          amount_captured: "110.47",
          status: "captured",
        })
        .execute();
      await trx.updateTable("storefront_settings").set({ ops_alert_email: null }).execute();
    });
    stub.orders.cancelByAirline(order["id"] as string);

    const res = await get(`/v1/bookings/${bookingId}?refresh=true`, bearer(customer.token));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "cancelled", syncStatus: "refreshed" });
    const alerts = await inTenant("tenant_alpha", (trx) =>
      trx
        .selectFrom("notifications")
        .select([
          "template_key as templateKey",
          "recipient",
          "recipient_type as recipientType",
          "dedupe_key as dedupeKey",
        ])
        .where("booking_id", "=", bookingId)
        .where("template_key", "=", "staff.manual_review")
        .execute(),
    );
    // Before FIX-W28-NOTIFY the API had no OPS_ALERT_EMAIL and skipped this alert.
    expect(alerts).toEqual([
      {
        templateKey: "staff.manual_review",
        recipient: VELEXIS_OPS,
        recipientType: "staff",
        dedupeKey: `staff.manual_review:${bookingId}:airline_cancelled`,
      },
    ]);
    expect(api.sink.text()).not.toContain(VELEXIS_OPS);
  });

  it("writes nothing over a booking that another writer changed while its order was read", async () => {
    const customer = await newCustomer();
    const order = await newStubOrder();
    const bookingId = await seedBooking({
      customerId: customer.id,
      departInMs: 10 * DAY,
      amadeusOrderId: order["id"] as string,
      snapshot: redactPayload(order),
    });
    const written = { ...redactPayload(order), writtenBy: "the other writer" };
    const client = api.app.get(AmadeusClient);
    const read = client.getFlightOrder.bind(client);
    // Between the read of the order and its record, another writer (the ticketing job, a change) records the booking.
    const spy = vi.spyOn(client, "getFlightOrder").mockImplementationOnce(async (...args) => {
      const reply = await read(...args);
      await inTenant("tenant_alpha", (trx) =>
        trx
          .updateTable("bookings")
          .set({ order_snapshot: JSON.stringify(written), version: sql`version + 1` })
          .where("id", "=", bookingId)
          .execute(),
      );
      return reply;
    });

    try {
      const res = await get(`/v1/bookings/${bookingId}?refresh=true`, bearer(customer.token));

      expect(res.status).toBe(200);
      expectResponseToMatch("getBooking", res);
      expect(res.headers["etag"]).toBe('"2"');
      expect((res.body as BookingBody).syncStatus).toBe("stale");
      expect(amadeusCalls("getFlightOrder")).toHaveLength(1);
      const stored = await inTenant("tenant_alpha", (trx) =>
        trx
          .selectFrom("bookings")
          .select(["order_snapshot", "last_synced_at", "version"])
          .where("id", "=", bookingId)
          .executeTakeFirstOrThrow(),
      );
      expect(stored).toMatchObject({ order_snapshot: written, last_synced_at: null, version: 2 });
    } finally {
      spy.mockRestore();
    }
  });

  it("answers a failed refresh with the supplier's error and records it, then shows the stored booking", async () => {
    const customer = await newCustomer();
    const order = await newStubOrder();
    const bookingId = await seedBooking({
      customerId: customer.id,
      departInMs: 10 * DAY,
      amadeusOrderId: order["id"] as string,
      snapshot: redactPayload(order),
    });

    const failed = await get(`/v1/bookings/${bookingId}?refresh=true`, {
      ...bearer(customer.token),
      ...stubScenario("server-error"),
    });
    expect(failed.status).toBe(502);
    expectResponseToMatch("getBooking", failed);
    expect((failed.body as ErrorBody).error.code).toBe("SUPPLIER_ERROR");
    expect((await bookingColumns(bookingId)).sync_error).toBe("SUPPLIER_ERROR");

    const stored = await get(`/v1/bookings/${bookingId}`, bearer(customer.token));
    expect(stored.status).toBe(200);
    expect((stored.body as BookingBody).syncStatus).toBe("failed");
  });

  it("keeps the stored booking with a warning when Amadeus no longer has the order", async () => {
    const customer = await newCustomer();
    const bookingId = await seedBooking({
      customerId: customer.id,
      departInMs: 10 * DAY,
      amadeusOrderId: Buffer.from(`ZZZZZZ|${new Date().toISOString().slice(0, 10)}`).toString("base64url"),
    });

    const res = await get(`/v1/bookings/${bookingId}?refresh=true`, bearer(customer.token));

    expect(res.status).toBe(200);
    expectResponseToMatch("getBooking", res);
    expect(res.body).toMatchObject({
      syncStatus: "failed",
      warnings: [{ title: "ORDER NOT FOUND AT THE AIRLINE" }],
    });
    expect((await bookingColumns(bookingId)).sync_error).toBe("ORDER_NOT_FOUND");
  });
});

// ---- FIX-W26-BOOKINGS (lead decision (6a) of 2026-10-22): a refresh that stores tickets moves the version -----------

/** Issues a stub order at the airline (staff, outside Velexis): the number of its first e-ticket. */
async function issueStubOrder(orderId: string): Promise<string> {
  const issued = await stubFetch(`/v1/booking/flight-orders/${encodeURIComponent(orderId)}/issuance`, {
    method: "POST",
    body: buildIssueRequest(["2"]),
  });
  const tickets = ((issued["data"] as JsonObject)["tickets"] ?? []) as JsonObject[];
  const number = tickets.find((ticket) => ticket["documentType"] === "ETICKET")?.["documentNumber"];
  if (typeof number !== "string") {
    throw new Error("the stub issued no e-ticket");
  }
  return number;
}

/** A ticket number of the booking's airline that no stub order holds (an earlier ticket, exchanged since). */
const earlierTicketNumber = (): string => `075-${randomInt(1_000_000_000, 9_999_999_999)}`;

/** The booking events of `type`. */
async function eventsOfType(bookingId: string, type: string): Promise<number> {
  const rows = await inTenant("tenant_alpha", (trx) =>
    trx
      .selectFrom("booking_events")
      .select("id")
      .where("booking_id", "=", bookingId)
      .where("type", "=", type)
      .execute(),
  );
  return rows.length;
}

describe("a refresh that stores a new ticket of a ticketed booking (FIX-W26-BOOKINGS)", () => {
  /**
   * The worker's module graph (the `ota-documents` consumer) on this file's database and Redis, a storage folder of its
   * own: started, used and closed in the hook, which also renders the first PDF of the process (pdfmake and the fonts).
   */
  const DOCUMENTS_SETUP_TIMEOUT_MS = 60_000;
  /** How long the hook waits at most for a render job (a few hundred milliseconds once the renderer is loaded). */
  const RENDER_WAIT = { timeout: 15_000, interval: 25 } as const;

  let storageDir: string;
  let earlier: string;
  let added: string;
  let firstItinerary: DocumentRenderJobResult;
  let versionBefore: number;
  let etagBefore: string | undefined;
  let refreshed: request.Response;
  let versionAfter: number;
  let ticketedEvents: number;
  let nextItinerary: DocumentRenderJobResult;
  let itineraries: Array<{ readonly status: string; readonly text: string }>;

  beforeAll(async () => {
    await redis.client.flushdb();
    stub.clearRequests();
    storageDir = mkdtempSync(join(tmpdir(), "velexis-ota-refresh-documents-"));
    const config = loadWorkerConfig({
      ...testWorkerVariables(),
      APP_ENV: "test",
      DATABASE_URL: db.urlFor("ota"),
      DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
      REDIS_URL: redis.url,
      STORAGE_DIR: storageDir,
    });
    useNextApplicationLoggerOutsideRequests();
    const worker = await createWorkerApp(
      WorkerModule.forRoot(config, { logger: createWorkerLogger(config, new MemorySink()) }),
    );
    try {
      await worker.init();
      const maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance));
      // No scheduler iteration may fire while the worker runs.
      for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
        await maintenance.removeJobScheduler(scheduler.key);
      }
      const documents = worker.get<Queue>(getQueueToken(OTA_QUEUE.documents));
      const finished = async (key: string): Promise<DocumentRenderJobResult> => {
        const job = await vi.waitFor(async () => {
          const id = await documents.getDeduplicationJobId(key);
          const found = id === null ? undefined : await Job.fromId(documents, id);
          const state = await found?.getState();
          if (found === undefined || (state !== "completed" && state !== "failed")) {
            throw new Error(`job ${key} has not finished`);
          }
          return found;
        }, RENDER_WAIT);
        expect(await job.getState(), `job ${key}: ${job.failedReason ?? ""}`).toBe("completed");
        return job.returnvalue as DocumentRenderJobResult;
      };

      // A ticketed booking with its e-ticket; then the airline issues the order again (an exchange, say), so Flight
      // Order Management holds a ticket the booking does not have, and the booking's status stays `ticketed`.
      const customer = await newCustomer();
      const order = await newStubOrder();
      earlier = earlierTicketNumber();
      const bookingId = await seedBooking({
        customerId: customer.id,
        status: "ticketed",
        departInMs: 10 * DAY,
        amadeusOrderId: order["id"] as string,
        snapshot: redactPayload(order),
        tickets: [earlier],
      });
      added = await issueStubOrder(order["id"] as string);
      // Its itinerary of version 1, as the record step asked for it (booking.created).
      const first = documentRenderJob({ tenantId: alphaId, bookingId, kind: "itinerary", bookingVersion: 1 });
      await documents.add(first.name, first.data, first.opts);
      firstItinerary = await finished(documentRenderKey(first.data));

      const shown = await get(`/v1/bookings/${bookingId}`, bearer(customer.token));
      versionBefore = (await bookingColumns(bookingId)).version;
      etagBefore = shown.headers["etag"];
      refreshed = await get(`/v1/bookings/${bookingId}?refresh=true`, bearer(customer.token));
      versionAfter = (await bookingColumns(bookingId)).version;
      ticketedEvents = await eventsOfType(bookingId, "booking.ticketed");
      // The itinerary the refresh's booking.ticketed asked for, at the version it left.
      nextItinerary = await finished(
        documentRenderKey({ bookingId, kind: "itinerary", bookingVersion: versionAfter }),
      );
      const rows = await inTenant("tenant_alpha", (trx) =>
        trx
          .selectFrom("booking_documents")
          .select(["status", "storage_key as storageKey"])
          .where("booking_id", "=", bookingId)
          .where("kind", "=", "itinerary")
          .orderBy("created_at")
          .orderBy("id")
          .execute(),
      );
      itineraries = rows.map((row) => ({
        status: row.status,
        text: pdfText(readFileSync(join(storageDir, ...row.storageKey.split("/")))),
      }));
    } finally {
      await worker.close();
    }
  }, DOCUMENTS_SETUP_TIMEOUT_MS);

  afterAll(() => {
    if (storageDir !== undefined) {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it("[FIX-W26-BOOKINGS AC3] moves the version and the ETag, and the itinerary rendered next lists the new ticket", () => {
    expect(firstItinerary).toMatchObject({ outcome: "rendered" });
    expect(versionBefore).toBe(1);
    expect(etagBefore).toBe('"1"');
    expect(refreshed.status).toBe(200);
    expectResponseToMatch("getBooking", refreshed);
    expect(refreshed.body).toMatchObject({ status: "ticketed", syncStatus: "refreshed", version: 2 });
    expect(refreshed.headers["etag"]).toBe('"2"');
    expect((refreshed.body as BookingBody).tickets.map((ticket) => ticket.documentNumber).sort()).toEqual(
      [earlier, added].sort(),
    );
    expect(versionAfter).toBe(2);
    expect(ticketedEvents).toBe(1);
    // A new job of version 2, so the itinerary is rendered again: the first one superseded, the new one with both.
    expect(nextItinerary).toMatchObject({ outcome: "rendered", superseded: 1 });
    expect(itineraries.map((row) => row.status)).toEqual(["superseded", "ready"]);
    expect(itineraries[0]?.text).toContain(earlier);
    expect(itineraries[0]?.text).not.toContain(added);
    expect(itineraries[1]?.text).toContain(earlier);
    expect(itineraries[1]?.text).toContain(added);
  });
});

describe("a refresh that stores no new ticket (FIX-W26-BOOKINGS)", () => {
  it("[FIX-W26-BOOKINGS AC3] keeps the version and the ETag when it changes nothing the documents show, and asks for no document", async () => {
    const customer = await newCustomer();
    const order = await newStubOrder();
    const number = await issueStubOrder(order["id"] as string);
    // The booking holds the order's ticket as Amadeus holds it: the refresh finds nothing new.
    const bookingId = await seedBooking({
      customerId: customer.id,
      status: "ticketed",
      departInMs: 10 * DAY,
      amadeusOrderId: order["id"] as string,
      snapshot: redactPayload(order),
      tickets: [number],
    });
    const documents = api.app.get<Queue>(getQueueToken(OTA_QUEUE.documents), { strict: false });
    const before = await get(`/v1/bookings/${bookingId}`, bearer(customer.token));

    const res = await get(`/v1/bookings/${bookingId}?refresh=true`, bearer(customer.token));

    expect(res.status).toBe(200);
    expectResponseToMatch("getBooking", res);
    expect((res.body as BookingBody).syncStatus).toBe("refreshed");
    expect(amadeusCalls("getFlightOrder")).toHaveLength(1);
    expect(before.headers["etag"]).toBe('"1"');
    expect(res.headers["etag"]).toBe('"1"');
    expect((await bookingColumns(bookingId)).version).toBe(1);
    expect(await eventsOfType(bookingId, "booking.ticketed")).toBe(0);
    expect(
      await documents.getDeduplicationJobId(
        documentRenderKey({ bookingId, kind: "itinerary", bookingVersion: 1 }),
      ),
    ).toBe(null);
  });

  it("[FIX-W26-BOOKINGS AC3] moves the version when it changes the status of a stored ticket (the receipt shows it)", async () => {
    const customer = await newCustomer();
    const order = await newStubOrder();
    const number = await issueStubOrder(order["id"] as string);
    const bookingId = await seedBooking({
      customerId: customer.id,
      status: "ticketed",
      departInMs: 10 * DAY,
      amadeusOrderId: order["id"] as string,
      snapshot: redactPayload(order),
      tickets: [number],
    });
    // The booking still shows the ticket as it was before the airline reissued it.
    await inTenant("tenant_alpha", (trx) =>
      trx
        .updateTable("booking_tickets")
        .set({ status: "ORIGINAL" })
        .where("booking_id", "=", bookingId)
        .execute(),
    );

    const res = await get(`/v1/bookings/${bookingId}?refresh=true`, bearer(customer.token));

    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBe('"2"');
    expect((await bookingColumns(bookingId)).version).toBe(2);
    expect((res.body as BookingBody & JsonObject)["tickets"]).toEqual([
      expect.objectContaining({ documentNumber: number, status: "ISSUED" }),
    ]);
  });
});

describe("bookings.getTicketingStatus", () => {
  it("picks up tickets issued at the airline meanwhile when asked to refresh", async () => {
    const customer = await newCustomer();
    const order = await newStubOrder();
    const bookingId = await seedBooking({
      customerId: customer.id,
      departInMs: 10 * DAY,
      amadeusOrderId: order["id"] as string,
      snapshot: redactPayload(order),
    });
    const before = await get(`/v1/bookings/${bookingId}/ticketing`, bearer(customer.token));
    expect(before.status).toBe(200);
    expectResponseToMatch("getBookingTicketingStatus", before);
    expect(before.headers["cache-control"]).toBe("no-store");
    expect(before.body).toMatchObject({
      bookingStatus: "confirmed",
      status: "pending",
      policy: "issue_after_payment",
      tickets: [],
      pollAfterSeconds: 5,
    });
    // Staff issue the order at the airline.
    await stubFetch(`/v1/booking/flight-orders/${encodeURIComponent(order["id"] as string)}/issuance`, {
      method: "POST",
      body: buildIssueRequest(["2"]),
    });

    const after = await get(`/v1/bookings/${bookingId}/ticketing?refresh=true`, bearer(customer.token));

    expect(after.status).toBe(200);
    expectResponseToMatch("getBookingTicketingStatus", after);
    expect(after.body).toMatchObject({
      bookingStatus: "ticketed",
      status: "issued",
      pollAfterSeconds: null,
      tickets: [expect.objectContaining({ documentType: "ETICKET", status: "ISSUED", travelerId: "1" })],
    });
    expect(await bookingColumns(bookingId)).toMatchObject({
      status: "ticketed",
      ticketing_status: "issued",
      version: 2,
    });
    const booking = await get(`/v1/bookings/${bookingId}`, bearer(customer.token));
    expect(booking.headers["etag"]).toBe('"2"');
    const events = await get(`/v1/bookings/${bookingId}/events`, bearer(customer.token));
    expect((events.body as PageBody<{ type: string }>).data.map((event) => event.type)).toEqual([
      "booking.ticketed",
    ]);
  });

  it("asks a pending booking's client to keep polling and ignores refresh (no order id yet)", async () => {
    const customer = await newCustomer();
    const bookingId = await seedBooking({
      customerId: customer.id,
      status: "pending",
      departInMs: 10 * DAY,
      amadeusOrderId: null,
    });

    const res = await get(`/v1/bookings/${bookingId}/ticketing?refresh=true`, bearer(customer.token));

    expect(res.status).toBe(200);
    expectResponseToMatch("getBookingTicketingStatus", res);
    expect(res.body).toMatchObject({
      bookingStatus: "pending",
      status: "pending",
      pollAfterSeconds: 10,
      tickets: [],
    });
    expect(amadeusCalls("getFlightOrder")).toHaveLength(0);
  });
});

describe("bookings.listEvents", () => {
  it("[OBE-046 AC3] lists the customer-visible events newest first and never a staff note", async () => {
    const customer = await newCustomer();
    const bookingId = await seedBooking({
      customerId: customer.id,
      status: "ticketed",
      departInMs: 10 * DAY,
    });
    const created = await seedEvent(bookingId, {
      type: "booking.created",
      actorType: "customer",
      actorId: customer.id,
      visible: true,
      agoMs: 3 * HOUR,
      summary: "Booking confirmed by the airline.",
    });
    await seedEvent(bookingId, {
      type: "booking.note_added",
      actorType: "staff",
      actorId: newId("stf"),
      visible: false,
      agoMs: 2 * HOUR,
      summary: "Staff note",
      data: { note: "CUSTOMER CALLED ABOUT A REFUND, CHECK WITH THE AIRLINE" },
    });
    const ticketed = await seedEvent(bookingId, {
      type: "booking.ticketed",
      actorType: "system",
      visible: true,
      agoMs: HOUR,
      summary: "E-tickets issued.",
      data: { tickets: ["075-2412345678"] },
    });
    await seedEvent(bookingId, {
      type: "booking.supplier_diagnostics",
      actorType: "supplier",
      visible: false,
      agoMs: 30 * MINUTE,
      summary: "Amadeus 141 SYSTEM ERROR",
    });

    const res = await get(`/v1/bookings/${bookingId}/events`, bearer(customer.token));

    expect(res.status).toBe(200);
    expectResponseToMatch("listBookingEvents", res);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    const page = res.body as PageBody<JsonObject>;
    expect(page.data.map((event) => event["id"])).toEqual([ticketed, created]);
    expect(page.data[1]).toMatchObject({
      type: "booking.created",
      actorType: "customer",
      summary: "Booking confirmed by the airline.",
    });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("CUSTOMER CALLED ABOUT A REFUND");
    expect(body).not.toContain("SYSTEM ERROR");
    expect(body).not.toContain(customer.id);

    const firstPage = await get(`/v1/bookings/${bookingId}/events?limit=1`, bearer(customer.token));
    const cursor = (firstPage.body as PageBody<JsonObject>).page.nextCursor ?? "";
    const secondPage = await get(
      `/v1/bookings/${bookingId}/events?limit=1&cursor=${cursor}`,
      bearer(customer.token),
    );
    expect((secondPage.body as PageBody<JsonObject>).data.map((event) => event["id"])).toEqual([created]);
    expect((secondPage.body as PageBody<JsonObject>).page.nextCursor).toBeNull();
  });
});

describe("bookings.getFareRules", () => {
  it("loads the eligibility from Amadeus once and serves it from the booking for an hour", async () => {
    const customer = await newCustomer();
    const order = await newStubOrder();
    const bookingId = await seedBooking({
      customerId: customer.id,
      departInMs: 10 * DAY,
      amadeusOrderId: order["id"] as string,
      snapshot: redactPayload(order),
    });

    const first = await get(`/v1/bookings/${bookingId}/fare-rules`, bearer(customer.token));
    expect(first.status).toBe(200);
    expectResponseToMatch("getBookingFareRules", first);
    expect(first.headers["cache-control"]).toBe("private, no-store");
    // The stub accepts `fareRules` and adds no rule.
    expect(first.body).toMatchObject({
      bookingId,
      currency: "EUR",
      available: false,
      types: ["rebooks", "refunds"],
      rules: [],
    });
    const calls = amadeusCalls("getFlightOrder");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.query).toMatchObject({ fareRules: "rebooks,refunds" });

    const cached = await get(`/v1/bookings/${bookingId}/fare-rules?types=refunds`, bearer(customer.token));
    expect(cached.status).toBe(200);
    expect((cached.body as JsonObject)["loadedAt"]).toBe((first.body as JsonObject)["loadedAt"]);
    // A refresh within the minute is throttled and answers the stored rules.
    const throttled = await get(`/v1/bookings/${bookingId}/fare-rules?refresh=true`, bearer(customer.token));
    expect(throttled.status).toBe(200);
    expect(amadeusCalls("getFlightOrder")).toHaveLength(1);
    expect((await bookingColumns(bookingId)).order_included).toMatchObject({
      fareRules: { types: ["rebooks", "refunds"] },
    });
  });

  it("answers 429 with Retry-After when no rules were ever loaded and the booking was refreshed a moment ago", async () => {
    const customer = await newCustomer();
    const order = await newStubOrder();
    const bookingId = await seedBooking({
      customerId: customer.id,
      departInMs: 10 * DAY,
      amadeusOrderId: order["id"] as string,
      snapshot: redactPayload(order),
    });
    // A refresh without fareRules: the order is read, the fare rules are not.
    expect((await get(`/v1/bookings/${bookingId}?refresh=true`, bearer(customer.token))).status).toBe(200);

    const res = await get(`/v1/bookings/${bookingId}/fare-rules`, bearer(customer.token));

    expect(res.status).toBe(429);
    expectResponseToMatch("getBookingFareRules", res);
    expect((res.body as ErrorBody).error.code).toBe("RATE_LIMITED");
    const retryAfter = Number(res.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(REFRESH_THROTTLE_MS / 1000);
    expect(amadeusCalls("getFlightOrder")).toHaveLength(1);
  });
});
