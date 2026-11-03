// OTA-owned Amadeus credentials and the releasing-office rule (OBE-079; OADR-0001 point 4, flows/amadeus-connection-
// and-tokens.md §2 rules 2, 3 and 6, PADR-0012 point 4) against PostgreSQL 16, Redis 7 and two Amadeus stubs.
//
// The file clones the @velexis/testing template (tenant_alpha and tenant_beta provisioned) and plays the platform as
// velexis_migrator: the Velexis test account, its office pool (`platform.amadeus_offices`) and the tenants' supplier
// connections, every client secret encrypted with the test KEK as the platform encrypts it. It runs the API's module
// graph (the Amadeus client, the connection resolver, the booking sync of the console's resync, the vx:invalidate
// subscriber) without AMADEUS_BASE_URL_TEST, so each credential set reaches the host its row names:
//
//   - the Velexis stub (`platform.amadeus_accounts.base_url`) accepts only the Velexis account's client id and secret;
//   - the OTA's stub (`platform.supplier_connections.base_url` of an own-credentials connection) accepts only alpha's
//     own client id and secret.
//
// A stub issues its own tokens and refuses any other (401), and only knows the orders created on it, so the stub a
// call reaches, and that it answers at the first attempt, proves which credential set and which token served it.
//
// Before the tests, alpha books on the Velexis account (its assigned office A1, and A2, an office of an earlier
// assignment already `releasing`; on A1 also an order on queue OLD_QUEUE, and one whose booking keeps no owner office,
// only its queuing office), then switches to its own credentials as the platform applies them (PBE-053): its
// connection becomes `tenant` with its own host, client id, re-encrypted secret and offices, A1 becomes `releasing`,
// and the platform publishes the `connection` and `amadeus_account` invalidations. Beta stays on the Velexis account
// (office B1). Tenants of the platform only (no schema) serve the tests that need the resolver and the token provider
// alone.
//
// FIX-W39-OTA (lead decision (2n) of 2026-11-02) adds the console after the switch: the raw order and queue reads
// accept the orders and the queue of alpha's releasing Velexis office (ConnectionResolver.tenantOffices) and still
// refuse another tenant's office, and the booking sync names the queuing office of a booking without an owner office
// (`bookingOrderOffice`), so its old order is still read through the Velexis account.
import { randomBytes } from "node:crypto";
import { INVALIDATION_CHANNEL } from "@velexis/api-types/jobs";
import { encryptValue, type KeyProvider } from "@velexis/crypto";
import { createPlatformDb, createPool, type Kysely, type PlatformDatabase } from "@velexis/db";
import { AppError } from "@velexis/errors";
import { createTestDatabase, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import { startAmadeusStub, TOKEN_OPERATION, type AmadeusStub } from "@velexis/testing/amadeus";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AmadeusClient } from "../../../src/amadeus/amadeus.client";
import type { AmadeusCallContext } from "../../../src/amadeus/call-context";
import { ConnectionResolver } from "../../../src/amadeus/connection-resolver";
import { TokenProvider } from "../../../src/amadeus/token-provider";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { BookingSyncService } from "../../../src/bookings/booking-sync.service";
import { orderSegmentsOf } from "../../../src/bookings/order-diff";
import { readCreatedOrder } from "../../../src/bookings/order-recorder";
import { buildCreateOrderRequest } from "../../../src/bookings/order-request.builder";
import { RawAmadeusService } from "../../../src/console/raw-amadeus.service";
import { newId } from "../../../src/common/ids";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import { CallerContext } from "../../../src/tenancy/caller-resolver";
import { TenantContext, type RequestTenant } from "../../../src/tenancy/tenant-context";
import { TenantTx } from "../../../src/tenancy/tenant-tx";
import type { OtaPool } from "../../../src/tenancy/tenancy.module";
import { buildOrderRequestInput, pricedFlightOffer } from "../../builders/bookings";
import { journeyAmadeusLimitsModule } from "../../helpers/amadeus-limits";
import { testKeyProvider } from "../../helpers/api-env";
import { createTestApp, type TestApp } from "../../support/create-test-app";

type JsonObject = Record<string, unknown>;

/** A credential set: its client id and secret in clear, random per run, held by the test only. */
interface Credentials {
  readonly clientId: string;
  readonly secret: string;
}

/** A tenant of a provisioned template schema, its Velexis offices and its request context. */
interface FileTenant {
  readonly id: string;
  readonly key: "alpha" | "beta";
  readonly connectionId: string;
  readonly context: RequestTenant;
}

/** A booking as checkout.complete leaves one, on an order of one of the stubs. */
interface SeededBooking {
  readonly id: string;
  readonly orderId: string;
  readonly recordLocator: string;
  readonly office: string;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** The flight of the fixture's offer 2 takes 2 h 05 min. */
const FLIGHT_MS = 125 * MINUTE;
/** The queue of A1 that alpha's queued old order is on (the other orders are on no queue). */
const OLD_QUEUE = 57;
/** How long a test waits at most for an invalidation the platform published (the subscriber applies it at once). */
const INVALIDATION_WAIT = { timeout: 5000, interval: 20 } as const;

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let keys: KeyProvider;
let velexisStub: AmadeusStub;
let ownStub: AmadeusStub;
let migratorPool: OtaPool;
/** velexis_migrator, the owner of the platform tables: what writes the file's platform rows. */
let migrator: Kysely<PlatformDatabase>;
let client: AmadeusClient;
let resolver: ConnectionResolver;
let tokens: TokenProvider;
let sync: BookingSyncService;
let tenantContext: TenantContext;
let tx: TenantTx;
let raw: RawAmadeusService;
let callers: CallerContext;

let velexis: Credentials & { readonly accountId: string };
let alphaOwn: Credentials;
let alpha: FileTenant;
let beta: FileTenant;

/** A random Amadeus office id (`^[A-Z0-9]{9}$`); `prefix` of 5 characters says whose it is. */
const newOffice = (prefix: string): string => `${prefix}${randomBytes(2).toString("hex").toUpperCase()}`;

/** Alpha's offices: A1 assigned until the switch, A2 releasing from the start, O1 and O2 of its own account. */
const offices = {
  a1: newOffice("NCE1A"),
  a2: newOffice("NCE2A"),
  o1: newOffice("LON1A"),
  o2: newOffice("LON2A"),
};
/** Beta's office on the Velexis account. */
const betaOffice = newOffice("PAR1A");

const credentials = (prefix: string): Credentials => ({
  clientId: `${prefix}-${randomBytes(4).toString("hex")}`,
  secret: randomBytes(24).toString("base64url"),
});

/** The secret encrypted as the platform stores it for `table.client_secret_ciphertext:<id>`. */
async function sealed(secret: string, table: "amadeus_accounts" | "supplier_connections", id: string) {
  return await encryptValue(secret, { aad: `platform.${table}.client_secret_ciphertext:${id}`, keys });
}

/** Inserts an active tenant of the platform; `key` names a template schema, else a key nobody else uses. */
async function insertTenant(key?: "alpha" | "beta"): Promise<string> {
  const id = newId("ten");
  const tenantKey = key ?? `own${randomBytes(5).toString("hex")}`;
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key: tenantKey, name: `${tenantKey} Travel`, status: "active", plan_code: "early_access" })
    .execute();
  return id;
}

/** Inserts an office of the Velexis pool, serving `tenantId` in `status` (or `available` without a tenant). */
async function insertOffice(
  officeId: string,
  status: "assigned" | "releasing" | "available",
  tenantId: string | null,
): Promise<void> {
  await migrator
    .insertInto("platform.amadeus_offices")
    .values({
      id: newId("amo"),
      amadeus_account_id: velexis.accountId,
      office_id: officeId,
      status,
      assigned_tenant_id: tenantId,
      assigned_at: tenantId === null ? null : new Date(),
      release_requested_at: status === "releasing" ? new Date() : null,
    })
    .execute();
}

/** Inserts the tenant's connection on the Velexis account, with its `officeIds` (the first is the default). */
async function insertVelexisConnection(tenantId: string, officeIds: readonly string[]): Promise<string> {
  const id = newId("sc");
  const [first] = officeIds;
  await migrator
    .insertInto("platform.supplier_connections")
    .values({
      id,
      tenant_id: tenantId,
      environment: "test",
      credential_source: "velexis",
      amadeus_account_id: velexis.accountId,
      office_ids: [...officeIds],
      default_office_id: first,
      queuing_office_id: first,
      owner_office_id: first,
      status: "active",
    })
    .execute();
  return id;
}

/**
 * Switches a connection to the OTA's own credentials as the platform applies a verified submission (PBE-053): `tenant`,
 * no account, the OTA's host, client id, secret re-encrypted for the connection's row and offices, `version + 1`; the
 * tenant's assigned Velexis offices become `releasing`; then the `connection` and `amadeus_account` invalidations.
 */
async function switchToOwn(
  tenantId: string,
  connectionId: string,
  own: Credentials,
  ownOffices: readonly [string, ...string[]],
): Promise<void> {
  const { ciphertext, kekId } = await sealed(own.secret, "supplier_connections", connectionId);
  await migrator.transaction().execute(async (trx) => {
    await trx
      .updateTable("platform.supplier_connections")
      .set((eb) => ({
        credential_source: "tenant",
        amadeus_account_id: null,
        base_url: ownStub.url,
        client_id: own.clientId,
        client_secret_ciphertext: ciphertext,
        encryption_key_id: kekId,
        office_ids: [...ownOffices],
        default_office_id: ownOffices[0],
        queuing_office_id: ownOffices[0],
        owner_office_id: ownOffices[0],
        last_verified_at: new Date(),
        version: eb("version", "+", 1),
      }))
      .where("id", "=", connectionId)
      .execute();
    await trx
      .updateTable("platform.amadeus_offices")
      .set({ status: "releasing", release_requested_at: new Date() })
      .where("assigned_tenant_id", "=", tenantId)
      .where("status", "=", "assigned")
      .execute();
  });
  await publish({ v: 1, type: "connection", tenantId });
  await publish({ v: 1, type: "amadeus_account", id: velexis.accountId });
}

/** Publishes a platform invalidation event on `vx:invalidate`. */
async function publish(event: JsonObject): Promise<void> {
  await redis.client.publish(INVALIDATION_CHANNEL, JSON.stringify(event));
}

/** The request context of a template tenant (`tenant_alpha`, `tenant_beta`). */
function requestTenant(id: string, key: "alpha" | "beta"): RequestTenant {
  return {
    tenantId: id,
    key,
    schemaName: `tenant_${key}` as RequestTenant["schemaName"],
    environment: "test",
    caller: { type: "key", id: newId("key") },
    actor: { type: "system", id: null },
    requestId: `req-${key}-own-0001`,
  };
}

/** The call context of `tenant` for `operation`, with a request id of its own. */
function callContext(tenant: FileTenant, extra: Partial<AmadeusCallContext> = {}): AmadeusCallContext {
  return {
    tenantId: tenant.id,
    environment: "test",
    operation: "flights.search",
    requestId: `req-${randomBytes(6).toString("hex")}`,
    ...extra,
  };
}

/** Runs `fn` as the tenant's request does. */
const as = <T>(tenant: FileTenant, fn: () => Promise<T>): Promise<T> => tenantContext.run(tenant.context, fn);

const SEARCH = {
  originLocationCode: "MAD",
  destinationLocationCode: "ORY",
  departureDate: "2027-01-15",
  adults: 1,
  max: 5,
};

/** A local date-time as Amadeus writes one (`YYYY-MM-DDTHH:MM:SS`), here the UTC reading of `instant`. */
const localOf = (instant: Date): string => instant.toISOString().slice(0, 19);

/** Priced offer 2 of the stub's fixtures, its one segment departing 60 days from now (no calendar date matters). */
function futureOffer(): { readonly offer: JsonObject; readonly departure: Date } {
  const departure = new Date(Math.floor(Date.now() / MINUTE) * MINUTE + 60 * DAY);
  const offer = pricedFlightOffer();
  for (const itinerary of offer["itineraries"] as JsonObject[]) {
    for (const segment of itinerary["segments"] as JsonObject[]) {
      (segment["departure"] as JsonObject)["at"] = localOf(departure);
      (segment["arrival"] as JsonObject)["at"] = localOf(new Date(departure.getTime() + FLIGHT_MS));
    }
  }
  return { offer, departure };
}

/**
 * An order of one traveller created by `tenant` through the API's client, on `office` (or the connection's offices),
 * and the booking rows checkout.complete leaves for it (`confirmed`, its segments as the record step stores them).
 */
async function book(tenant: FileTenant, office?: string, queue?: number): Promise<SeededBooking> {
  const { offer, departure } = futureOffer();
  const request = buildCreateOrderRequest(
    buildOrderRequestInput({
      flightOffers: [offer],
      reference: newBookingReference(),
      queue: queue === undefined ? null : { number: queue, category: 0 },
      offices: { queuing: office ?? "", owner: office ?? "" },
      issue: false,
    }),
  );
  const body = request.body.data;
  if (office === undefined) {
    // The client fills the connection's offices in.
    delete body["queuingOfficeId"];
    delete body["ownerOfficeId"];
  }
  const reply = await as(tenant, () =>
    client.createFlightOrders(callContext(tenant, { operation: "test.setup" }), {
      body: request.body as unknown as Parameters<AmadeusClient["createFlightOrders"]>[1]["body"],
      query: request.query,
    }),
  );
  const order = readCreatedOrder(reply.body);
  const recordLocator = order?.records[0]?.reference;
  const orderOffice = reply.call.officeId;
  if (order === undefined || recordLocator === undefined || orderOffice === null) {
    throw new Error("the stub did not create a readable order");
  }
  const id = newId("bkg");
  const created = new Date(Date.now() - 2 * DAY);
  await as(tenant, () =>
    tx.run(async (trx) => {
      await trx
        .insertInto("bookings")
        .values({
          id,
          environment: "test",
          reference: newBookingReference(),
          status: "confirmed",
          amadeus_order_id: order.id,
          record_locator: recordLocator,
          origin_system_code: "GDS",
          queuing_office_id: orderOffice,
          owner_office_id: orderOffice,
          issue_requested: false,
          ticketing_status: "pending",
          trip_type: "one_way",
          origin_iata: "MAD",
          destination_iata: "ORY",
          first_departure_at: departure,
          last_arrival_at: new Date(departure.getTime() + FLIGHT_MS),
          validating_carrier: "IB",
          currency: "EUR",
          net_amount: "100.00",
          total_amount: "115.00",
          amount_paid: "115.00",
          contact_email: `traveller-${randomBytes(4).toString("hex")}@example.com`,
          lead_last_name: "SAMPLE",
          last_synced_at: created,
          created_at: created,
          updated_at: created,
        })
        .execute();
      await trx
        .insertInto("booking_travelers")
        .values({
          id: newId("btr"),
          booking_id: id,
          amadeus_traveler_id: "1",
          traveler_type: "ADULT",
          first_name: "TESTA",
          last_name: "SAMPLE",
        })
        .execute();
      const segments = orderSegmentsOf(order).map((segment) => ({
        id: newId("seg"),
        booking_id: id,
        amadeus_flight_offer_id: segment.amadeusFlightOfferId,
        amadeus_segment_id: segment.amadeusSegmentId,
        itinerary_index: segment.itineraryIndex,
        segment_index: segment.segmentIndex,
        carrier_code: segment.carrierCode,
        flight_number: segment.flightNumber,
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
        fare_details: JSON.stringify(segment.fareDetails),
      }));
      if (segments.length > 0) {
        await trx.insertInto("booking_segments").values(segments).execute();
      }
    }),
  );
  return { id, orderId: order.id, recordLocator, office: orderOffice };
}

/** console.bookings.resync of the booking as the API runs one: a refresh without throttle, in the tenant's context. */
async function resync(tenant: FileTenant, booking: SeededBooking) {
  const context = callContext(tenant);
  return await as(tenant, () =>
    sync.refresh({ id: tenant.id, key: tenant.key }, booking.id, {
      operation: "console.bookings.resync",
      requestId: context.requestId,
      environment: "test",
      query: {},
      throttleMs: 0,
    }),
  );
}

/** The booking's sync columns. */
async function syncStateOf(tenant: FileTenant, booking: SeededBooking) {
  return await as(tenant, () =>
    tx.run((trx) =>
      trx
        .selectFrom("bookings")
        .select(["last_synced_at as lastSyncedAt", "sync_error as syncError"])
        .where("id", "=", booking.id)
        .executeTakeFirstOrThrow(),
    ),
  );
}

/** The office of the tenant's `supplier_requests` rows of one operation, newest first. */
async function supplierOffices(tenant: FileTenant, bookingId: string): Promise<Array<string | null>> {
  const rows = await as(tenant, () =>
    tx.run((trx) =>
      trx
        .selectFrom("supplier_requests")
        .select(["office_id"])
        .where("booking_id", "=", bookingId)
        .orderBy("id", "desc")
        .execute(),
    ),
  );
  return rows.map((row) => row.office_id);
}

/** A stub's requests of `operation`. */
const requestsOf = (stub: AmadeusStub, operation: string) =>
  stub.requests().filter((request) => request.operation === operation);

/** The AppError a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

/**
 * Runs `fn` as a console call of a `console:automation` key of `tenant` (the request's caller, which the raw reads'
 * audit rows name as their actor).
 */
const asConsoleKey = <T>(tenant: FileTenant, fn: () => Promise<T>): Promise<T> =>
  tenantContext.run(tenant.context, async () => {
    const keyId = tenant.context.caller.id;
    callers.set({
      type: "key",
      id: keyId,
      keyId,
      kind: "secret",
      tenantId: tenant.id,
      environment: "test",
      scopes: ["console:automation"],
    });
    return await fn();
  });

/** The answer the tenant's newest `supplier_requests` row of `operation` keeps. */
async function recordedAnswer(tenant: FileTenant, operation: string): Promise<unknown> {
  const row = await as(tenant, () =>
    tx.run((trx) =>
      trx
        .selectFrom("supplier_requests")
        .select(["response_body"])
        .where("operation", "=", operation)
        .orderBy("id", "desc")
        .executeTakeFirstOrThrow(),
    ),
  );
  return row.response_body;
}

/** Empties both stubs' request logs, so a test asserts on its own requests only. */
function clearStubs(): void {
  velexisStub.clearRequests();
  ownStub.clearRequests();
}

// Cloning the template, starting two stubs, building the API's module graph (Nest, the pools, Redis, the vx:invalidate
// subscriber), booking alpha's two old orders and switching alpha to its own credentials take a few seconds alone and
// much longer on a busy 4-CPU CI runner: all of it happens once here, with its own budget, and the tests only make
// calls.
const SETUP_TIMEOUT_MS = 120_000;

let oldBooking: SeededBooking;
let releasedBooking: SeededBooking;
/** Alpha's old order on A1's queue OLD_QUEUE. */
let queuedBooking: SeededBooking;
/** Alpha's old order on A1 whose booking keeps its queuing office only (`owner_office_id` null). */
let queuingOnlyBooking: SeededBooking;

beforeAll(async () => {
  [db, redis, keys] = await Promise.all([createTestDatabase(), useRedis(), testKeyProvider()]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: { error: () => undefined },
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  velexis = { ...credentials("velexis-test"), accountId: newId("ama") };
  alphaOwn = credentials("alpha-own");
  [velexisStub, ownStub] = await Promise.all([
    startAmadeusStub({ credentials: { clientId: velexis.clientId, clientSecret: velexis.secret } }),
    startAmadeusStub({ credentials: { clientId: alphaOwn.clientId, clientSecret: alphaOwn.secret } }),
  ]);
  const account = await sealed(velexis.secret, "amadeus_accounts", velexis.accountId);
  await migrator
    .insertInto("platform.amadeus_accounts")
    .values({
      id: velexis.accountId,
      name: "Velexis test",
      environment: "test",
      // The stub, as dev:seed writes it in development: no AMADEUS_BASE_URL_TEST in this file.
      base_url: velexisStub.url,
      client_id: velexis.clientId,
      client_secret_ciphertext: account.ciphertext,
      encryption_key_id: account.kekId,
      status: "active",
    })
    .execute();
  const [alphaId, betaId] = [await insertTenant("alpha"), await insertTenant("beta")];
  await insertOffice(offices.a1, "assigned", alphaId);
  await insertOffice(offices.a2, "releasing", alphaId);
  await insertOffice(betaOffice, "assigned", betaId);
  alpha = {
    id: alphaId,
    key: "alpha",
    connectionId: await insertVelexisConnection(alphaId, [offices.a1, offices.a2]),
    context: requestTenant(alphaId, "alpha"),
  };
  beta = {
    id: betaId,
    key: "beta",
    connectionId: await insertVelexisConnection(betaId, [betaOffice]),
    context: requestTenant(betaId, "beta"),
  };

  api = await createTestApp({ database: db, redis, imports: [journeyAmadeusLimitsModule()] });
  client = api.app.get(AmadeusClient, { strict: false });
  resolver = api.app.get(ConnectionResolver, { strict: false });
  tokens = api.app.get(TokenProvider, { strict: false });
  sync = api.app.get(BookingSyncService, { strict: false });
  tenantContext = api.app.get(TenantContext, { strict: false });
  tx = api.app.get(TenantTx, { strict: false });
  raw = api.app.get(RawAmadeusService, { strict: false });
  callers = api.app.get(CallerContext, { strict: false });
  for (const tenant of [alpha, beta]) {
    await as(tenant, () =>
      tx.run((trx) =>
        seedStorefrontSettings(trx, {
          name: `${tenant.key} Travel`,
          defaultCurrency: "EUR",
          defaultLocale: "en",
        }),
      ),
    );
  }

  // Alpha's old orders, booked on the Velexis account: the Velexis token is cached from here on.
  oldBooking = await book(alpha, offices.a1);
  releasedBooking = await book(alpha, offices.a2);
  queuedBooking = await book(alpha, offices.a1, OLD_QUEUE);
  queuingOnlyBooking = await book(alpha, offices.a1);
  await as(alpha, () =>
    tx.run((trx) =>
      trx
        .updateTable("bookings")
        .set({ owner_office_id: null })
        .where("id", "=", queuingOnlyBooking.id)
        .execute(),
    ),
  );

  // The switch, and the moment the API serves it (the connection's cached row is dropped by the invalidation).
  await switchToOwn(alpha.id, alpha.connectionId, alphaOwn, [offices.o1, offices.o2]);
  await vi.waitFor(async () => {
    expect((await resolver.resolve(alpha.id, "test")).credentialSource).toBe("tenant");
  }, INVALIDATION_WAIT);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await Promise.all([velexisStub?.stop(), ownStub?.stop()]);
  await redis?.close();
  await migratorPool?.end();
  await db?.drop();
});

describe("after a switch to the OTA's own credentials", () => {
  it("serves a new search with the tenant's credentials, its host, its offices and a token of its own [OBE-079 AC1]", async () => {
    clearStubs();

    const reply = await as(alpha, () => client.getFlightOffers(callContext(alpha), { query: SEARCH }));

    expect(reply.body.data?.length).toBeGreaterThan(0);
    // The OTA's stub answered at the first attempt: the token was one it issued to alpha's own client id, never the
    // Velexis account's cached one (which it would refuse with 401).
    expect(reply.call).toMatchObject({ status: 200, officeId: offices.o1, attempts: 1 });
    expect(requestsOf(ownStub, "getFlightOffers")).toEqual([
      expect.objectContaining({ status: 200, query: expect.objectContaining({ originLocationCode: "MAD" }) }),
    ]);
    expect(ownStub.requests().every((request) => request.status === 200)).toBe(true);
    expect(velexisStub.requests()).toEqual([]);
    // Two credential sets, two tokens: the Velexis account's (cached since the old bookings) and alpha's own.
    expect(await redis.client.exists(redisKeys.amadeusToken(velexis.accountId, "test").key)).toBe(1);
    expect(await redis.client.exists(redisKeys.amadeusToken(alpha.connectionId, "test").key)).toBe(1);
  });

  it("creates a new order with the tenant's credentials on its own office", async () => {
    clearStubs();

    const booking = await book(alpha);

    expect(booking.office).toBe(offices.o1);
    expect(requestsOf(ownStub, "createFlightOrders")).toEqual([expect.objectContaining({ status: 201 })]);
    expect(velexisStub.requests()).toEqual([]);
  });

  it("still syncs a booking made before the switch through the Velexis account, on its office [OBE-079 AC1]", async () => {
    clearStubs();
    const before = await syncStateOf(alpha, oldBooking);

    const outcome = await resync(alpha, oldBooking);

    expect(outcome).toMatchObject({ kind: "refreshed" });
    expect(requestsOf(velexisStub, "getFlightOrder")).toEqual([
      expect.objectContaining({ status: 200, path: `/v1/booking/flight-orders/${oldBooking.orderId}` }),
    ]);
    expect(velexisStub.requests().every((request) => request.status === 200)).toBe(true);
    expect(ownStub.requests()).toEqual([]);
    const after = await syncStateOf(alpha, oldBooking);
    expect(after.syncError).toBeNull();
    expect(after.lastSyncedAt?.getTime()).toBeGreaterThan(before.lastSyncedAt?.getTime() ?? 0);
    expect((await supplierOffices(alpha, oldBooking.id))[0]).toBe(offices.a1);
  });

  it("syncs a booking made after the switch through the tenant's credentials", async () => {
    const booking = await book(alpha);
    clearStubs();

    expect(await resync(alpha, booking)).toMatchObject({ kind: "refreshed" });
    expect(requestsOf(ownStub, "getFlightOrder")).toEqual([expect.objectContaining({ status: 200 })]);
    expect(velexisStub.requests()).toEqual([]);
  });

  it("reads the queue of a releasing office through the Velexis account and its own queues with its credentials", async () => {
    clearStubs();

    const old = await as(alpha, () =>
      client.listQueue(callContext(alpha, { operation: "console.amadeus.getQueue" }), {
        queueId: 50,
        query: { officeId: offices.a1 },
      }),
    );
    const own = await as(alpha, () =>
      client.listQueue(callContext(alpha, { operation: "console.amadeus.getQueue" }), { queueId: 50 }),
    );

    expect([old.call.officeId, own.call.officeId]).toEqual([offices.a1, offices.o1]);
    expect(requestsOf(velexisStub, "listQueue")).toEqual([
      expect.objectContaining({ status: 200, query: expect.objectContaining({ officeId: offices.a1 }) }),
    ]);
    expect(requestsOf(ownStub, "listQueue")).toEqual([
      expect.objectContaining({ status: 200, query: expect.objectContaining({ officeId: offices.o1 }) }),
    ]);
  });

  it("looks for an order sent before the switch by its record locator through the Velexis account when the read names its office [OBE-079 AC1]", async () => {
    clearStubs();
    const query = { reference: oldBooking.recordLocator, originSystemCode: "GDS" };

    // The timeout reconciliation names the booking's queuing office (reconcile.service.ts `reconcileCallContext`).
    const named = await as(alpha, () =>
      client.getFlightOrderByReference(
        callContext(alpha, {
          operation: "booking.reconcile",
          bookingId: oldBooking.id,
          orderOffice: offices.a1,
        }),
        { query },
      ),
    );

    expect(named.call).toMatchObject({ status: 200, officeId: offices.a1, attempts: 1 });
    expect(JSON.stringify(named.body)).toContain(oldBooking.orderId);
    expect(requestsOf(velexisStub, "getFlightOrderByReference")).toEqual([
      expect.objectContaining({ status: 200 }),
    ]);
    expect(ownStub.requests()).toEqual([]);
    // A read that names no office (a PNR lookup) uses the current credentials, which cannot see the old order: Amadeus
    // answers 404, which the reconciliation would count as "not ours".
    clearStubs();
    const unnamed = await rejection(
      as(alpha, () =>
        client.getFlightOrderByReference(callContext(alpha, { operation: "console.pnr.lookup" }), { query }),
      ),
    );
    expect(unnamed.cause).toMatchObject({ httpStatus: 404 });
    expect(requestsOf(ownStub, "getFlightOrderByReference")).toEqual([
      expect.objectContaining({ status: 404 }),
    ]);
    expect(velexisStub.requests()).toEqual([]);
  });

  it("caches the new rows with the secret as ciphertext only, and the Velexis offices with the account", async () => {
    // A resolution of an old order reads (and caches) both rows.
    await resolver.resolve(alpha.id, "test", offices.a1);

    const cachedConnection: unknown = JSON.parse(
      (await redis.client.get(redisKeys.conn("amadeus", alpha.id, "test").key)) ?? "null",
    );
    const cachedAccount: unknown = JSON.parse(
      (await redis.client.get(redisKeys.amadeusAccount(velexis.accountId).key)) ?? "null",
    );

    expect(cachedConnection).toMatchObject({
      v: 1,
      value: {
        id: alpha.connectionId,
        credentialSource: "tenant",
        amadeusAccountId: null,
        velexisAccountId: velexis.accountId,
        clientId: alphaOwn.clientId,
        baseUrl: ownStub.url,
        officeIds: [offices.o1, offices.o2],
      },
    });
    expect(cachedAccount).toMatchObject({
      v: 1,
      value: {
        id: velexis.accountId,
        offices: expect.arrayContaining([
          { officeId: offices.a1, tenantId: alpha.id, status: "releasing" },
          { officeId: betaOffice, tenantId: beta.id, status: "assigned" },
        ]),
      },
    });
    const everything = JSON.stringify([cachedConnection, cachedAccount]);
    expect(everything).not.toContain(alphaOwn.secret);
    expect(everything).not.toContain(velexis.secret);
  });

  it("keeps every other OTA's office out of reach: neither tenant acts for the other's office", async () => {
    clearStubs();

    const attempts = [
      as(alpha, () =>
        client.getFlightOrder(callContext(alpha, { orderOffice: betaOffice }), {
          flightOrderId: "eJzTd9cPCXQ",
        }),
      ),
      as(beta, () =>
        client.getFlightOrder(callContext(beta, { orderOffice: offices.a1 }), {
          flightOrderId: "eJzTd9cPCXQ",
        }),
      ),
    ];
    for (const attempt of attempts) {
      const error = await rejection(attempt);

      expect([error.status, error.code]).toEqual([403, "OFFICE_NOT_ALLOWED"]);
    }
    expect([velexisStub.requests(), ownStub.requests()]).toEqual([[], []]);
    // Beta, still on the Velexis account, searches with it as before.
    const search = await as(beta, () => client.getFlightOffers(callContext(beta), { query: SEARCH }));
    expect(search.call).toMatchObject({ status: 200, officeId: betaOffice });
    expect(requestsOf(velexisStub, "getFlightOffers")).toHaveLength(1);
    expect(ownStub.requests()).toEqual([]);
  });

  it("no longer routes an office released to the pool to the Velexis account, from the amadeus_account invalidation on [OBE-079 AC2]", async () => {
    clearStubs();
    // While A2 is releasing, its order is read through the Velexis account.
    const before = await as(alpha, () =>
      client.getFlightOrder(callContext(alpha, { orderOffice: offices.a2, bookingId: releasedBooking.id }), {
        flightOrderId: releasedBooking.orderId,
      }),
    );
    expect(before.call).toMatchObject({ status: 200, officeId: offices.a2 });
    expect(requestsOf(velexisStub, "getFlightOrder")).toHaveLength(1);

    // A platform admin releases A2 (PBE-054): `available`, no tenant, and only the account's invalidation.
    await migrator
      .updateTable("platform.amadeus_offices")
      .set({ status: "available", assigned_tenant_id: null, released_at: new Date() })
      .where("amadeus_account_id", "=", velexis.accountId)
      .where("office_id", "=", offices.a2)
      .execute();
    await publish({ v: 1, type: "amadeus_account", id: velexis.accountId });

    // The tenant's own credentials serve the order now, and the office is not one of theirs: 403 before any call.
    await vi.waitFor(async () => {
      const error = await rejection(
        as(alpha, () =>
          client.getFlightOrder(callContext(alpha, { orderOffice: offices.a2 }), {
            flightOrderId: releasedBooking.orderId,
          }),
        ),
      );
      expect([error.status, error.code]).toEqual([403, "OFFICE_NOT_ALLOWED"]);
    }, INVALIDATION_WAIT);
    clearStubs();
    const refused = await rejection(resync(alpha, releasedBooking));

    expect(refused.cause).toMatchObject({ code: "OFFICE_NOT_ALLOWED" });
    expect((await syncStateOf(alpha, releasedBooking)).syncError).toBe("OFFICE_NOT_ALLOWED");
    expect([velexisStub.requests(), ownStub.requests()]).toEqual([[], []]);
    // A1, still releasing, keeps its old order on the Velexis account.
    expect(await resolver.resolve(alpha.id, "test", offices.a1)).toMatchObject({
      credentialSource: "velexis",
      credId: velexis.accountId,
      officeIds: [offices.a1],
    });
  });
});

describe("the console after a switch (lead decision (2n) of 2026-11-02)", () => {
  it("[FIX-W39-OTA AC4] counts the tenant's releasing Velexis office among its own, never another tenant's", async () => {
    const { connection, orderOfficeIds } = await resolver.tenantOffices(alpha.id, "test");

    // The OTA's own offices first, then its releasing Velexis offices (A2 too while it was not yet released).
    expect(orderOfficeIds.slice(0, 3)).toEqual([offices.o1, offices.o2, offices.a1]);
    expect(orderOfficeIds).not.toContain(betaOffice);
    expect(connection).toMatchObject({ credentialSource: "tenant", officeIds: [offices.o1, offices.o2] });
    expect((await resolver.tenantOffices(beta.id, "test")).orderOfficeIds).toEqual([betaOffice]);
  });

  it("[FIX-W39-OTA AC4] answers a raw read of an old order of a releasing office through the Velexis account, kept as it is", async () => {
    clearStubs();

    const result = await asConsoleKey(alpha, () => raw.getFlightOrder(oldBooking.orderId, {}));

    expect(result).toMatchObject({
      flightOrderId: oldBooking.orderId,
      bookingId: oldBooking.id,
      call: { officeId: offices.a1, httpStatus: 200 },
      amadeus: { data: { id: oldBooking.orderId } },
    });
    expect(requestsOf(velexisStub, "getFlightOrder")).toEqual([expect.objectContaining({ status: 200 })]);
    expect(ownStub.requests()).toEqual([]);
    // The supplier log keeps the tenant's own order, not a withheld marker.
    const recorded = JSON.stringify(await recordedAnswer(alpha, "console.amadeus.getFlightOrder"));
    expect(recorded).toContain(oldBooking.orderId);
    expect(recorded).not.toContain("office_not_allowed");
  });

  it("[FIX-W39-OTA AC4] reads the queue of a releasing office with its entries, and refuses another tenant's office before any call", async () => {
    clearStubs();

    const result = await asConsoleKey(alpha, () => raw.getQueue(OLD_QUEUE, { officeId: offices.a1 }));
    const refused = await rejection(
      asConsoleKey(alpha, () => raw.getQueue(OLD_QUEUE, { officeId: betaOffice })),
    );

    const ids = (result.amadeus.data as JsonObject[]).map((entry) => String(entry["id"]));
    expect(ids).toHaveLength(1);
    expect(ids[0]?.startsWith(queuedBooking.recordLocator)).toBe(true);
    expect(result.call).toMatchObject({ officeId: offices.a1, httpStatus: 200 });
    expect(requestsOf(velexisStub, "listQueue")).toEqual([
      expect.objectContaining({ status: 200, query: expect.objectContaining({ officeId: offices.a1 }) }),
    ]);
    expect([refused.status, refused.code]).toEqual([403, "OFFICE_NOT_ALLOWED"]);
    expect(ownStub.requests()).toEqual([]);
    expect(requestsOf(velexisStub, "listQueue")).toHaveLength(1);
  });

  it("[FIX-W39-OTA AC4] syncs a booking without an owner office through the Velexis account of its queuing office", async () => {
    clearStubs();

    const outcome = await resync(alpha, queuingOnlyBooking);

    // Before, the sync named no office: the OTA's own credentials read the order, which their stub does not know.
    expect(outcome).toMatchObject({ kind: "refreshed" });
    expect(requestsOf(velexisStub, "getFlightOrder")).toEqual([
      expect.objectContaining({
        status: 200,
        path: `/v1/booking/flight-orders/${queuingOnlyBooking.orderId}`,
      }),
    ]);
    expect(ownStub.requests()).toEqual([]);
    expect((await syncStateOf(alpha, queuingOnlyBooking)).syncError).toBeNull();
    expect((await supplierOffices(alpha, queuingOnlyBooking.id))[0]).toBe(offices.a1);
  });
});

describe("the connection and amadeus_account invalidations", () => {
  it("make a switch of a cached connection serve the tenant's credentials, and its old office the Velexis account", async () => {
    const tenantId = await insertTenant();
    const velexisOffice = newOffice("NCE3A");
    await insertOffice(velexisOffice, "assigned", tenantId);
    const connectionId = await insertVelexisConnection(tenantId, [velexisOffice]);
    const own = credentials("gamma-own");
    const ownOffice = newOffice("LON3A");
    // Cached before the switch: the connection row, and the account with its offices.
    expect(await resolver.resolve(tenantId, "test")).toMatchObject({ credentialSource: "velexis" });

    await switchToOwn(tenantId, connectionId, own, [ownOffice]);

    await vi.waitFor(async () => {
      expect(await resolver.resolve(tenantId, "test")).toMatchObject({
        credentialSource: "tenant",
        credId: connectionId,
        clientId: own.clientId,
        baseUrl: ownStub.url,
        encryptedSecret: { aad: `platform.supplier_connections.client_secret_ciphertext:${connectionId}` },
        officeIds: [ownOffice],
      });
    }, INVALIDATION_WAIT);
    expect(await resolver.resolve(tenantId, "test", velexisOffice)).toMatchObject({
      credentialSource: "velexis",
      credId: velexis.accountId,
      officeIds: [velexisOffice],
    });
  });
});

describe("the tokens of the two credential sets", () => {
  it("are kept apart: credentials Amadeus refuses block the OTA's set only, never the Velexis account's", async () => {
    const tenantId = await insertTenant();
    const velexisOffice = newOffice("NCE4A");
    await insertOffice(velexisOffice, "assigned", tenantId);
    const connectionId = await insertVelexisConnection(tenantId, [velexisOffice]);
    // The OTA's stub accepts alpha's own credentials only: these are refused.
    await switchToOwn(tenantId, connectionId, credentials("refused-own"), [newOffice("LON4A")]);
    await vi.waitFor(async () => {
      expect((await resolver.resolve(tenantId, "test")).credentialSource).toBe("tenant");
    }, INVALIDATION_WAIT);
    clearStubs();

    const own = await rejection(tokens.getToken(await resolver.resolve(tenantId, "test")));
    const velexisToken = await tokens.getToken(await resolver.resolve(tenantId, "test", velexisOffice));

    expect([own.status, own.code]).toEqual([424, "SUPPLIER_NOT_CONFIGURED"]);
    expect(requestsOf(ownStub, TOKEN_OPERATION)).toEqual([expect.objectContaining({ status: 401 })]);
    expect(await redis.client.exists(redisKeys.amadeusBadCredentials(connectionId).key)).toBe(1);
    expect(await redis.client.exists(redisKeys.amadeusBadCredentials(velexis.accountId).key)).toBe(0);
    expect(velexisToken).not.toBe("");
    expect(api.sink.records()).toContainEqual(
      expect.objectContaining({ level: 50, msg: "amadeus.credentials_refused", credId: connectionId }),
    );
  });
});
