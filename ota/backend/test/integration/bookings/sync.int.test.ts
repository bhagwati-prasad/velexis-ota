// The background booking sync (OBE-045; ota/docs/flows/ticketing-and-documents.md §3 step 5, OADR-0014 points 2, 4
// and 6, OADR-0008 point 8) against PostgreSQL 16, Redis 7 and the Amadeus stub.
//
// The file runs the real worker module graph (WorkerModule.forRoot: the `ota-maintenance` fan-out, the
// `bookings.sync_scan` handler and the `ota-bookings` consumer of BookingsWorkerModule that hands `booking.sync` jobs to
// BookingSyncJobs, the worker's Amadeus client) on a clone of the @velexis/testing template (`tenant_alpha` and
// `tenant_beta` provisioned) and a Redis database of its own. It plays the platform: `alpha` (active) and `beta`
// (suspended) on the Velexis test Amadeus account, whose `base_url` is the stub's, each with an office of its own.
// Every booking's order is created on the stub through the worker's own Amadeus client (priced offer 2 of the stub's
// fixtures for one traveller, its flight moved to 60 days after the test's day, so no calendar date matters), and its
// rows are then written as checkout.complete leaves them: `confirmed`, the segment as the record step stored it (the
// fixture's airports have no time zone in the template's reference data, so local times are read as UTC), last
// synchronised 7 hours before the test (due). What the airline does to the order is played on the stub's stored order
// (`stub.orders.changeSegment`, `stub.orders.cancelByAirline`), which the next Flight Order Management GET answers.
//
// At start-up the worker registers its schedulers; the file removes them, so no iteration fires while it runs, and
// plays the scheduler instead: a `bookings.sync_scan` iteration is the per-tenant scan job itself, and the file waits
// for the jobs whose ids it knows. The consumers of `ota-documents` and `ota-notifications` are paused, so a document
// render (whose write locks the booking for a moment before FIX-W26-BOOKINGS) or an e-mail never runs alongside a
// sync; the jobs they would run wait in their queues, where the file reads them. `Clock` is pointed at a FakeClock
// that only moves forward: each test starts on a day of its own after the previous one.
//
// FIX-W27-SYNC (lead decision (3) of 2026-10-23): the claim is `bookings.sync_claimed_at`, never a
// `booking.sync_requested` event; the refreshes of the API claim through the same BookingSyncService, which the worker
// graph holds too, so the file plays "a refresh at the same moment" with that service's `refresh` (its claim, its
// throttle and its record are the API's, AmadeusClient aside: a throttled refresh calls no Amadeus).
import { randomBytes } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Global, Module, type DynamicModule, type INestApplicationContext } from "@nestjs/common";
import { encryptValue } from "@velexis/crypto";
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
import { createTestDatabase, FakeClock, useRedis, type TestDatabase, type TestRedis } from "@velexis/testing";
import { startAmadeusStub, type AmadeusStub } from "@velexis/testing/amadeus";
import type { Job, Queue } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AmadeusClient } from "../../../src/amadeus/amadeus.client";
import { AMADEUS_LIMITS, DEFAULT_AMADEUS_LIMITS, type AmadeusLimits } from "../../../src/amadeus/limits";
import { REFRESH_THROTTLE_MS } from "../../../src/bookings/allowed-actions";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import {
  BOOKING_SYNC_JOB,
  BOOKING_SYNC_PRIORITY,
  BOOKING_SYNC_SCAN_BATCH,
  BOOKINGS_SYNC_SCAN_JOB,
  bookingSyncJob,
  bookingSyncJobId,
  type BookingSyncJobResult,
} from "../../../src/bookings/booking-sync.processor";
import {
  AIRLINE_CANCEL_REASON,
  AIRLINE_CANCELLED_ALERT,
  BOOKING_SYNC_DEADLINE_INTERVAL_MS,
  BOOKING_SYNC_INTERVAL_MS,
  BOOKING_SYNC_OPERATION,
  BOOKING_SYNC_RETRY_MS,
  BOOKING_SYNC_ROUNDS,
  BookingSyncService,
  SCHEDULE_CHANGED_EVENT,
  type RefreshOutcome,
} from "../../../src/bookings/booking-sync.service";
import { orderSegmentsOf } from "../../../src/bookings/order-diff";
import { readCreatedOrder } from "../../../src/bookings/order-recorder";
import { buildCreateOrderRequest } from "../../../src/bookings/order-request.builder";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { loadWorkerConfig } from "../../../src/config";
import { DocumentsProcessor } from "../../../src/documents/documents.processor";
import { jobTenant, minuteBucket, tenantJob, type TenantJobResult } from "../../../src/jobs/fan-out";
import { NotificationsProcessor } from "../../../src/notifications/notifications.processor";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import { PlatformCache } from "../../../src/tenancy/platform-cache";
import { TenantContext } from "../../../src/tenancy/tenant-context";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { buildOrderRequestInput, pricedFlightOffer } from "../../builders/bookings";
import { testKeyProvider, testWorkerVariables } from "../../helpers/api-env";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";

/**
 * Cloning the template, starting the stub and the worker graph (BullMQ connections, the scheduler registration, the
 * key files) takes a few seconds locally and much longer on a busy 4-CPU runner: all of it happens once, here.
 */
const SETUP_TIMEOUT_MS = 30_000;
/** The budget of the hooks that create a test's orders and bookings: a few stub calls and inserts each. */
const BOOKING_SETUP_TIMEOUT_MS = 15_000;
/** How long a test waits at most for the worker to finish a job it added (they take milliseconds). */
const JOB_WAIT = { timeout: 4000, interval: 20 } as const;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The flight of the fixture's offer 2 takes 2 h 05 min. */
const FLIGHT_MS = 125 * MINUTE;

const quietPoolLogger = { error: (): void => undefined };

/**
 * The Amadeus limits of the file: the defaults, with buckets deep enough for a scan's 20 reads of one tenant at one
 * instant. The buckets refill with `Clock`, which here only moves when a test moves it (limits.ts: tests pass their own).
 */
const LIMITS: AmadeusLimits = Object.freeze({
  ...DEFAULT_AMADEUS_LIMITS,
  credentialBucket: Object.freeze({ ratePerSecond: 20, burst: 200 }),
  tenantBucket: Object.freeze({ ratePerSecond: 5, burst: 200 }),
});

/** A global module that provides LIMITS to the worker's Amadeus client and rate limiter. */
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

type TenantKey = "alpha" | "beta";
type Schema = `tenant_${TenantKey}`;
type JsonObject = Record<string, unknown>;

let db: TestDatabase;
let redis: TestRedis;
let stub: AmadeusStub;
let app: INestApplicationContext;
let migratorPool: ReturnType<typeof createPool>;
/** velexis_migrator, the owner of the platform tables: writes the platform rows as the platform does. */
let migrator: Kysely<PlatformDatabase>;
let otaPool: ReturnType<typeof createPool>;
/** `tenantTx` as velexis_ota_app: writes and reads the tenant rows as the backend does. */
let tenantDb: TenantDb;
let maintenance: Queue;
let bookingsQueue: Queue;
let documentsQueue: Queue;
let clock: FakeClock;

const tenants: Record<TenantKey, { id: string; office: string; email: string }> = {
  alpha: { id: "", office: "", email: "" },
  beta: { id: "", office: "", email: "" },
};

/** Tomorrow at this minute: the first day of the file; each test runs on a day of its own after it. */
const BASE = new Date(Math.floor(Date.now() / MINUTE) * MINUTE + DAY);
let days = 0;
/** The next day of the file: time never goes back (the Amadeus token buckets refill with the clock). */
const nextDay = (): Date => new Date(BASE.getTime() + ++days * DAY);
const plus = (instant: Date, ms: number): Date => new Date(instant.getTime() + ms);
/** A local date-time as Amadeus writes one (`YYYY-MM-DDTHH:MM:SS`), here the UTC reading of `instant`. */
const localOf = (instant: Date): string => instant.toISOString().slice(0, 19);

const tx = <T>(key: TenantKey, run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, `tenant_${key}` satisfies Schema, run);

async function insertAccount(clientId: string, secret: string): Promise<string> {
  const id = newId("ama");
  const { ciphertext, kekId } = await encryptValue(secret, {
    aad: `platform.amadeus_accounts.client_secret_ciphertext:${id}`,
    keys: await testKeyProvider(),
  });
  await migrator
    .insertInto("platform.amadeus_accounts")
    .values({
      id,
      name: "Velexis test",
      environment: "test",
      // The stub, as dev:seed writes it in development: the worker reads the account's base URL.
      base_url: stub.url,
      client_id: clientId,
      client_secret_ciphertext: ciphertext,
      encryption_key_id: kekId,
      status: "active",
    })
    .execute();
  return id;
}

async function insertTenant(key: TenantKey, status: string, accountId: string): Promise<void> {
  const id = newId("ten");
  const office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name: `${key} Travel`, status, plan_code: "early_access" })
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
  tenants[key] = { id, office, email: `traveller-${randomBytes(4).toString("hex")}@example.com` };
}

/** Priced offer 2 of the stub's fixtures with its one segment (id 3) departing at `departure` (local, UTC reading). */
function offerOn(departure: Date): JsonObject {
  const offer = pricedFlightOffer();
  for (const itinerary of offer["itineraries"] as JsonObject[]) {
    for (const segment of itinerary["segments"] as JsonObject[]) {
      (segment["departure"] as JsonObject)["at"] = localOf(departure);
      (segment["arrival"] as JsonObject)["at"] = localOf(plus(departure, FLIGHT_MS));
    }
  }
  return offer;
}

/** Runs `call` with the worker's Amadeus client in a job context of tenant `key`, as a test's setup. */
async function asTenant<T>(
  key: TenantKey,
  call: (client: AmadeusClient, context: { tenantId: string; requestId: string }) => Promise<T>,
): Promise<T> {
  const tenant = await app.get(PlatformCache, { strict: false }).tenantById(tenants[key].id);
  if (tenant === null) {
    throw new Error(`tenant ${key} is not readable`);
  }
  const requestId = `sync-test-${randomBytes(4).toString("hex")}`;
  const client = app.get(AmadeusClient, { strict: false });
  return await app
    .get(TenantContext, { strict: false })
    .run(jobTenant(tenant, { id: requestId, name: "setup" }), () =>
      call(client, { tenantId: tenant.id, requestId }),
    );
}

/** An order of `offerOn(departure)` for one traveller, created as `key` through the worker's Amadeus client. */
async function createOrder(
  key: TenantKey,
  options: {
    readonly departure: Date;
    readonly issue: boolean;
    readonly identifications?: readonly JsonObject[] | undefined;
  },
): Promise<{ readonly id: string; readonly recordLocator: string; readonly body: unknown }> {
  const office = tenants[key].office;
  const request = buildCreateOrderRequest(
    buildOrderRequestInput({
      flightOffers: [offerOn(options.departure)],
      reference: newBookingReference(),
      queue: null,
      offices: { queuing: office, owner: office },
      issue: options.issue,
    }),
  );
  const body =
    options.identifications === undefined
      ? request.body
      : {
          ...request.body,
          data: {
            ...(request.body as { data: JsonObject }).data,
            formOfIdentifications: options.identifications,
          },
        };
  const reply = await asTenant(key, (client, context) =>
    client.createFlightOrders(
      { ...context, environment: "test", operation: "test.setup" },
      {
        body: body as unknown as Parameters<AmadeusClient["createFlightOrders"]>[1]["body"],
        query: request.query,
      },
    ),
  );
  const order = readCreatedOrder(reply.body);
  const recordLocator = order?.records[0]?.reference;
  if (order === undefined || recordLocator === undefined) {
    throw new Error("the stub did not create a readable order");
  }
  return { id: order.id, recordLocator, body: reply.body };
}

/** Cancels the booking's order at the stub with Management DELETE (a cancellation outside Velexis): it is gone. */
async function deleteOrder(booking: SeededBooking): Promise<void> {
  await asTenant(booking.key, (client, context) =>
    client.cancelFlightOrder(
      { ...context, environment: "test", operation: "test.setup" },
      { flightOrderId: booking.orderId },
    ),
  );
}

/**
 * Marks every booking of both tenants synchronised at `at`, so a test's scans see its own bookings only until they are
 * due again (each test's scans also wait for every job they enqueued, see `scan`).
 */
async function syncedEverything(at: Date): Promise<void> {
  for (const key of ["alpha", "beta"] as const) {
    await tx(key, (trx) => trx.updateTable("bookings").set({ last_synced_at: at }).execute());
  }
}

/** A booking as checkout.complete leaves one (see the file header), and what a test may change of it. */
interface BookingSeed {
  readonly key: TenantKey;
  /** The test's day: the booking was made 2 days earlier and flies 60 days later, by default. */
  readonly at: Date;
  /** `last_synced_at`; 7 hours before `at` by default (due). */
  readonly lastSyncedAt?: Date | null;
  readonly status?: "confirmed" | "ticketed" | "pending" | "cancelled";
  readonly amountPaid?: string;
  /** The order is created issued at the stub (one e-ticket), while the booking holds none. */
  readonly issuedAtAirline?: boolean;
  /** No order at the stub: the booking names an order id the stub does not know (it answers 404). */
  readonly unknownOrder?: boolean;
  /** The trip's first departure and last arrival, when they differ from the flight's (a trip that is over). */
  readonly trip?: { readonly departure: Date; readonly arrival: Date };
  /** `ticketing_deadline_at`; none by default. */
  readonly ticketingDeadlineAt?: Date;
  /** Forms of identification of the order at the stub (an airline that asks for them), in full. */
  readonly identifications?: readonly JsonObject[];
}

interface SeededBooking {
  readonly id: string;
  readonly key: TenantKey;
  readonly orderId: string;
  readonly reference: string;
  readonly departure: Date;
}

async function insertBooking(seed: BookingSeed): Promise<SeededBooking> {
  const departure = plus(seed.at, 60 * DAY);
  const order = seed.unknownOrder
    ? { id: `SYNCTEST${randomBytes(8).toString("hex").toUpperCase()}`, recordLocator: null, body: null }
    : await createOrder(seed.key, {
        departure,
        issue: seed.issuedAtAirline === true,
        identifications: seed.identifications,
      });
  const id = newId("bkg");
  const reference = newBookingReference();
  const status = seed.status ?? "confirmed";
  const created = plus(seed.at, -2 * DAY);
  await tx(seed.key, async (trx) => {
    await trx
      .insertInto("bookings")
      .values({
        id,
        environment: "test",
        reference,
        status,
        amadeus_order_id: status === "pending" ? null : order.id,
        record_locator: status === "pending" ? null : order.recordLocator,
        origin_system_code: order.recordLocator === null ? null : "GDS",
        queuing_office_id: tenants[seed.key].office,
        owner_office_id: tenants[seed.key].office,
        issue_requested: false,
        ticketing_status: status === "ticketed" ? "issued" : "pending",
        ticketing_deadline_at: seed.ticketingDeadlineAt ?? null,
        trip_type: "one_way",
        origin_iata: "MAD",
        destination_iata: "ORY",
        first_departure_at: seed.trip?.departure ?? departure,
        last_arrival_at: seed.trip?.arrival ?? plus(departure, FLIGHT_MS),
        validating_carrier: "IB",
        currency: "EUR",
        net_amount: "100.00",
        total_amount: "115.00",
        amount_paid: seed.amountPaid ?? "115.00",
        contact_email: tenants[seed.key].email,
        lead_last_name: "SAMPLE",
        last_synced_at: seed.lastSyncedAt === undefined ? plus(seed.at, -7 * HOUR) : seed.lastSyncedAt,
        ...(status === "cancelled" ? { cancelled_at: created, cancelled_by: "customer" } : {}),
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
    await trx
      .insertInto("booking_contacts")
      .values({
        id: newId("bco"),
        booking_id: id,
        purpose: "STANDARD",
        is_primary: true,
        first_name: "TESTA",
        last_name: "SAMPLE",
        email: tenants[seed.key].email,
        phones: JSON.stringify([]),
        language: "en",
      })
      .execute();
    const read = order.body === null ? undefined : readCreatedOrder(order.body);
    const segments =
      read === undefined
        ? []
        : orderSegmentsOf(read).map((segment) => ({
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
  });
  return { id, key: seed.key, orderId: order.id, reference, departure };
}

/** The columns of a booking the sync writes. */
async function bookingOf(booking: SeededBooking) {
  return await tx(booking.key, (trx) =>
    trx
      .selectFrom("bookings")
      .select([
        "status",
        "version",
        "tags",
        "ticketing_status as ticketingStatus",
        "ticketing_next_attempt_at as nextAttemptAt",
        "issued_at as issuedAt",
        "last_synced_at as lastSyncedAt",
        "sync_claimed_at as syncClaimedAt",
        "sync_error as syncError",
        "cancelled_at as cancelledAt",
        "cancelled_by as cancelledBy",
        "cancel_reason as cancelReason",
        "first_departure_at as firstDepartureAt",
        "last_arrival_at as lastArrivalAt",
        "order_snapshot as orderSnapshot",
        "form_of_identifications as formOfIdentifications",
        "sync_changes as syncChanges",
      ])
      .where("id", "=", booking.id)
      .executeTakeFirstOrThrow(),
  );
}

async function segmentsOf(booking: SeededBooking) {
  return await tx(booking.key, (trx) =>
    trx
      .selectFrom("booking_segments")
      .select([
        "amadeus_segment_id as segmentId",
        "status",
        "departure_at as departureAt",
        "arrival_at as arrivalAt",
        sql<string>`to_char(departure_local, 'YYYY-MM-DD"T"HH24:MI:SS')`.as("departureLocal"),
        sql<string>`to_char(arrival_local, 'YYYY-MM-DD"T"HH24:MI:SS')`.as("arrivalLocal"),
      ])
      .where("booking_id", "=", booking.id)
      .orderBy("itinerary_index")
      .orderBy("segment_index")
      .execute(),
  );
}

async function eventsOf(booking: SeededBooking) {
  return await tx(booking.key, (trx) =>
    trx
      .selectFrom("booking_events")
      .select([
        "type",
        "actor_type as actorType",
        "visible_to_customer as visible",
        "status_from as statusFrom",
        "status_to as statusTo",
        "data",
      ])
      .where("booking_id", "=", booking.id)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
  );
}

async function notificationsOf(booking: SeededBooking) {
  return await tx(booking.key, (trx) =>
    trx
      .selectFrom("notifications")
      .select([
        "template_key as templateKey",
        "recipient",
        "recipient_type as recipientType",
        "dedupe_key as dedupeKey",
        "payload",
      ])
      .where("booking_id", "=", booking.id)
      .orderBy("template_key")
      .execute(),
  );
}

async function ticketsOf(booking: SeededBooking) {
  return await tx(booking.key, (trx) =>
    trx
      .selectFrom("booking_tickets")
      .select(["document_number as documentNumber", "amadeus_traveler_id as travelerId", "status"])
      .where("booking_id", "=", booking.id)
      .execute(),
  );
}

/** The stub's Flight Order Management GETs of one order. */
const readsOf = (booking: SeededBooking) =>
  stub
    .requests()
    .filter(
      (entry) =>
        entry.operation === "getFlightOrder" && entry.path.includes(encodeURIComponent(booking.orderId)),
    );

/** The `document.render` jobs waiting for the booking in the paused `ota-documents` queue. */
async function renderJobsOf(booking: SeededBooking): Promise<JsonObject[]> {
  const jobs = await documentsQueue.getJobs(["waiting", "paused", "prioritized"]);
  return jobs
    .map((job) => job.data as JsonObject)
    .filter((data) => data["bookingId"] === booking.id)
    .map((data) => ({ kind: data["kind"], bookingVersion: data["bookingVersion"] }));
}

// ---- The scheduler's side ---------------------------------------------------------------------------------------

/** The job with this id once the worker has finished it, completed (a failed attempt names its reason). */
async function finished(queue: Queue, id: string): Promise<Job> {
  let found: Job | undefined;
  await vi.waitFor(async () => {
    found = await queue.getJob(id);
    expect(
      found?.finishedOn,
      `job ${id} is finished; ${found?.failedReason ?? "no attempt failed"}`,
    ).toBeDefined();
  }, JOB_WAIT);
  if (found === undefined) {
    throw new Error(`job ${id} not found`);
  }
  expect(await found.getState(), `job ${id}: ${found.failedReason ?? ""}`).toBe("completed");
  return found;
}

/**
 * One `bookings.sync_scan` of `key` at `at`, as the fan-out enqueues it (the per-tenant job of the iteration's minute):
 * the clock moves to `at` first. Resolves with the number of bookings it found due.
 */
async function scan(key: TenantKey, at: Date): Promise<number> {
  clock.set(at);
  const bucket = minuteBucket(at);
  const job = tenantJob(BOOKINGS_SYNC_SCAN_JOB, tenants[key].id, bucket);
  await maintenance.add(job.name, job.data, job.opts);
  const result = (await finished(maintenance, job.opts.jobId)).returnvalue as TenantJobResult;
  expect(result).toMatchObject({ task: BOOKINGS_SYNC_SCAN_JOB, outcome: "done", continued: false });
  // Every booking.sync job of the run finishes before the test goes on, so none runs into the next step or test.
  await vi.waitFor(async () => {
    const open = await bookingsQueue.getJobs(["waiting", "active", "delayed", "prioritized", "paused"]);
    expect(
      open.filter((entry) => entry.name === BOOKING_SYNC_JOB && String(entry.id).endsWith(`:${bucket}`)),
    ).toEqual([]);
  }, JOB_WAIT);
  return result.outcome === "done" ? (result.counts["due"] ?? 0) : 0;
}

/** The `booking.sync` job the scan at `at` added for the booking, or `undefined` when it added none. */
async function syncJobOf(booking: SeededBooking, at: Date): Promise<Job | undefined> {
  return await bookingsQueue.getJob(bookingSyncJobId(booking.id, minuteBucket(at)));
}

/** A scan of the booking's tenant at `at` and the booking's `booking.sync` job it enqueued, once finished. */
async function syncAt(booking: SeededBooking, at: Date): Promise<BookingSyncJobResult> {
  await scan(booking.key, at);
  const job = await finished(bookingsQueue, bookingSyncJobId(booking.id, minuteBucket(at)));
  return job.returnvalue as BookingSyncJobResult;
}

/** One `booking.sync` job of the booking at `at`, added directly (as a scan would), once finished. */
async function syncJob(booking: SeededBooking, at: Date): Promise<BookingSyncJobResult> {
  clock.set(at);
  const job = bookingSyncJob(tenants[booking.key].id, booking.id, minuteBucket(at));
  await bookingsQueue.add(job.name, job.data, job.opts);
  return (await finished(bookingsQueue, job.opts.jobId)).returnvalue as BookingSyncJobResult;
}

/** Bumps the booking's version as another writer (a console patch of its tags) would, in a transaction of its own. */
async function concurrentChange(booking: SeededBooking, tag: string): Promise<void> {
  await tx(booking.key, (trx) =>
    trx
      .updateTable("bookings")
      .set({ tags: sql<string[]>`array_append(tags, ${tag})`, version: sql`version + 1` })
      .where("id", "=", booking.id)
      .execute(),
  );
}

/**
 * A refresh of the booking as the API runs one (bookings.get with `refresh=true`: BookingSyncService.refresh with the
 * customer's 60 s throttle), in a request context of its tenant, at the clock's time.
 */
async function refreshAs(booking: SeededBooking): Promise<RefreshOutcome> {
  return await asTenant(booking.key, (_client, context) =>
    app
      .get(BookingSyncService, { strict: false })
      .refresh({ id: context.tenantId, key: booking.key }, booking.id, {
        operation: "bookings.get",
        requestId: context.requestId,
        environment: "test",
        query: {},
        throttleMs: REFRESH_THROTTLE_MS,
      }),
  );
}

/** A Stripe payment of the booking that holds the traveller's money (`captured` or `authorized`) for its total. */
async function insertPayment(
  booking: SeededBooking,
  status: "captured" | "authorized",
  method: "stripe" | "airline_card" = "stripe",
): Promise<string> {
  const id = newId("pay");
  await tx(booking.key, (trx) =>
    trx
      .insertInto("payments")
      .values({
        id,
        environment: "test",
        booking_id: booking.id,
        currency: "EUR",
        amount: "115.00",
        amount_authorized: "115.00",
        amount_captured: status === "captured" ? "115.00" : "0",
        status,
        ...(method === "stripe"
          ? { provider: "stripe", provider_payment_id: `pi_${randomBytes(12).toString("hex")}` }
          : // A card the airline charged (OADR-0004): no PSP reference, captured at once by the airline.
            { provider: "airline", method: "airline_card", capture_method: "automatic" }),
      })
      .execute(),
  );
  return id;
}

/** A transaction of the test that holds a lock on the booking until `release()` (then rolls back). */
interface BookingHold {
  readonly held: Promise<void>;
  release(): void;
  readonly done: Promise<void>;
}

const ROLLBACK = new Error("the test's hold rolls back");

/**
 * Holds the booking: `key_share` by an uncommitted insert of a booking event (the `FOR KEY SHARE` its foreign key
 * takes, as a document or outbox insert does), `update` by `SELECT … FOR UPDATE` (a writer of the booking).
 */
function holdBooking(booking: SeededBooking, how: "key_share" | "update"): BookingHold {
  let markHeld: () => void = () => undefined;
  let failHeld: (error: unknown) => void = () => undefined;
  const held = new Promise<void>((resolve, reject) => {
    markHeld = resolve;
    failHeld = reject;
  });
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = tx(booking.key, async (trx) => {
    if (how === "key_share") {
      await trx
        .insertInto("booking_events")
        .values({
          id: `evt_${randomBytes(13).toString("hex").toUpperCase()}`,
          booking_id: booking.id,
          type: "test.key_share",
          actor_type: "system",
          summary: "A concurrent insert of the test.",
          visible_to_customer: false,
        })
        .execute();
    } else {
      await trx.selectFrom("bookings").select("id").where("id", "=", booking.id).forUpdate().execute();
    }
    markHeld();
    await released;
    throw ROLLBACK;
  }).then(
    () => undefined,
    (error: unknown) => {
      if (error !== ROLLBACK) {
        failHeld(error);
        throw error;
      }
    },
  );
  void done.catch(() => undefined);
  return { held, release, done };
}

beforeAll(async () => {
  [db, redis] = await Promise.all([createTestDatabase(), useRedis()]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: quietPoolLogger,
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-app",
    logger: quietPoolLogger,
    max: 4,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });

  const clientId = `velexis-test-${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(24).toString("base64url");
  stub = await startAmadeusStub({ credentials: { clientId, clientSecret: secret } });
  const accountId = await insertAccount(clientId, secret);
  await insertTenant("alpha", "active", accountId);
  await insertTenant("beta", "suspended", accountId);
  for (const key of ["alpha", "beta"] as const) {
    await tx(key, (trx) =>
      seedStorefrontSettings(trx, { name: `${key} Travel`, defaultCurrency: "EUR", defaultLocale: "en" }),
    );
  }

  const config = loadWorkerConfig({
    ...testWorkerVariables(),
    APP_ENV: "test",
    DATABASE_URL: db.urlFor("ota"),
    DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
    REDIS_URL: redis.url,
  });
  @Module({
    imports: [
      amadeusLimitsModule(),
      WorkerModule.forRoot(config, { logger: createWorkerLogger(config, new MemorySink()) }),
    ],
  })
  class WorkerRootModule {}
  useNextApplicationLoggerOutsideRequests();
  app = await createWorkerApp(WorkerRootModule);
  await app.init();
  maintenance = app.get<Queue>(getQueueToken(OTA_QUEUE.maintenance));
  bookingsQueue = app.get<Queue>(getQueueToken(OTA_QUEUE.bookings));
  documentsQueue = app.get<Queue>(getQueueToken(OTA_QUEUE.documents));
  // From here on the file plays the scheduler: no iteration of the real one may fire during a test.
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
  // Nor may a document render or an e-mail run alongside a sync (see the file header).
  await app.get(DocumentsProcessor).worker.pause();
  await app.get(NotificationsProcessor).worker.pause();
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await stub?.stop();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
});

beforeEach(() => {
  clock = new FakeClock(BASE);
  // restoreMocks undoes this after every test.
  vi.spyOn(app.get(Clock), "now").mockImplementation(() => clock.now());
  stub.setDefaultScenario("success");
});

describe("a schedule change by the airline", () => {
  let T0: Date;
  let booking: SeededBooking;
  let version: number;

  beforeEach(async () => {
    T0 = clock.set(nextDay());
    await syncedEverything(T0);
    booking = await insertBooking({ key: "alpha", at: T0 });
    version = (await bookingOf(booking)).version;
    stub.clearRequests();
  }, BOOKING_SETUP_TIMEOUT_MS);

  it("[OBE-045 AC1] produces one booking.schedule_changed event and an updated segment", async () => {
    const departure = plus(booking.departure, 90 * MINUTE);
    const arrival = plus(departure, FLIGHT_MS);
    expect(
      stub.orders.changeSegment(booking.orderId, "3", {
        departureAt: localOf(departure),
        arrivalAt: localOf(arrival),
      }),
    ).toMatchObject({ version: 2 });

    const result = await syncAt(booking, T0);

    expect(result).toMatchObject({
      outcome: "synced",
      rounds: 1,
      changes: {
        segmentsChanged: 1,
        segmentsAdded: 0,
        segmentsRemoved: 0,
        scheduleChanged: true,
        cancelledByAirline: false,
        versionMoved: true,
      },
    });
    // One Flight Order Management GET, with the bags.
    expect(readsOf(booking).map((call) => [call.query["include"], call.status])).toEqual([["bags", 200]]);
    expect(await segmentsOf(booking)).toEqual([
      {
        segmentId: "3",
        status: "CONFIRMED",
        departureLocal: localOf(departure),
        arrivalLocal: localOf(arrival),
        departureAt: departure,
        arrivalAt: arrival,
      },
    ]);
    const row = await bookingOf(booking);
    expect(row).toMatchObject({
      status: "confirmed",
      version: version + 1,
      lastSyncedAt: T0,
      syncError: null,
      firstDepartureAt: departure,
      lastArrivalAt: arrival,
    });
    // The redacted snapshot is the order as read.
    expect(JSON.stringify(row.orderSnapshot)).toContain(localOf(departure));

    // The claim is the booking's column (lead decision (3) of 2026-10-23): no booking.sync_requested event.
    expect(row.syncClaimedAt).toEqual(T0);
    const events = await eventsOf(booking);
    expect(events.map((event) => [event.type, event.actorType, event.visible])).toEqual([
      [SCHEDULE_CHANGED_EVENT, "supplier", true],
    ]);
    expect(events[0]).toMatchObject({
      statusFrom: "confirmed",
      statusTo: "confirmed",
      data: {
        changed: [
          {
            segmentId: "3",
            flight: "IB3436",
            changes: {
              departureAt: { from: localOf(booking.departure), to: localOf(departure) },
              arrivalAt: { from: localOf(plus(booking.departure, FLIGHT_MS)), to: localOf(arrival) },
            },
          },
        ],
        added: [],
        removed: [],
        via: BOOKING_SYNC_OPERATION,
      },
    });
    // No customer e-mail for a schedule change in the MVP; a new itinerary of the new version (FIX-W27-SYNC).
    expect(await notificationsOf(booking)).toEqual([]);
    expect(await renderJobsOf(booking)).toEqual([{ kind: "itinerary", bookingVersion: version + 1 }]);

    // Not due again before 6 hours have passed. The next due sync reads the same order: nothing changed, so no second
    // event and the same version; only the synchronisation time moves.
    const early = plus(T0, BOOKING_SYNC_INTERVAL_MS - MINUTE);
    await scan("alpha", early);
    expect(await syncJobOf(booking, early)).toBeUndefined();
    const next = plus(T0, BOOKING_SYNC_INTERVAL_MS);
    const again = await syncAt(booking, next);
    expect(again).toMatchObject({
      outcome: "synced",
      changes: { scheduleChanged: false, segmentsChanged: 0, versionMoved: false },
    });
    expect((await eventsOf(booking)).filter((event) => event.type === SCHEDULE_CHANGED_EVENT)).toHaveLength(
      1,
    );
    expect(await bookingOf(booking)).toMatchObject({ version: version + 1, lastSyncedAt: next });
  });

  it("[FIX-W27-SYNC AC5] keeps what the sync changed as the booking's last differences, and an empty list once nothing changes", async () => {
    const departure = plus(booking.departure, 45 * MINUTE);
    stub.orders.changeSegment(booking.orderId, "3", { departureAt: localOf(departure) });

    expect(await syncJob(booking, T0)).toMatchObject({
      outcome: "synced",
      changes: { scheduleChanged: true },
    });

    expect((await bookingOf(booking)).syncChanges).toEqual([
      {
        path: "/itineraries/0/segments/0/departure/at",
        label: "IB3436 departure time",
        before: localOf(booking.departure),
        after: localOf(departure),
      },
    ]);
    // The next due sync reads the same order: nothing changed since, so the differences are empty.
    const next = plus(T0, BOOKING_SYNC_INTERVAL_MS);
    expect(await syncAt(booking, next)).toMatchObject({
      outcome: "synced",
      changes: { versionMoved: false },
    });
    expect((await bookingOf(booking)).syncChanges).toEqual([]);
  });

  it("[OBE-045 AC1] records a status change of a segment as a schedule change for staff only", async () => {
    stub.orders.changeSegment(booking.orderId, "3", { bookingStatus: "WAITLISTED" });
    const waitlisted = await syncJob(booking, T0);
    expect(waitlisted).toMatchObject({
      outcome: "synced",
      changes: { scheduleChanged: true, segmentsChanged: 1 },
    });
    expect((await segmentsOf(booking)).map((segment) => segment.status)).toEqual(["WAITLISTED"]);
    const staffOnly = (await eventsOf(booking)).filter((event) => event.type === SCHEDULE_CHANGED_EVENT);
    expect(staffOnly).toEqual([
      expect.objectContaining({
        visible: false,
        data: expect.objectContaining({
          changed: [
            expect.objectContaining({ changes: { status: { from: "CONFIRMED", to: "WAITLISTED" } } }),
          ],
        }) as unknown,
      }),
    ]);
    expect((await bookingOf(booking)).version).toBe(version + 1);
  });
});

describe("a cancellation by the airline", () => {
  let T0: Date;
  let booking: SeededBooking;
  let version: number;

  beforeEach(async () => {
    T0 = clock.set(nextDay());
    await syncedEverything(T0);
    booking = await insertBooking({ key: "alpha", at: T0 });
    // A booking whose issuance waits for a retry: the cancellation stops it.
    await tx("alpha", (trx) =>
      trx
        .updateTable("bookings")
        .set({ ticketing_status: "failed", ticketing_next_attempt_at: plus(T0, HOUR) })
        .where("id", "=", booking.id)
        .execute(),
    );
    version = (await bookingOf(booking)).version;
    stub.clearRequests();
  }, BOOKING_SETUP_TIMEOUT_MS);

  it("[OBE-045 AC2] makes an order cancelled in the stub cancelled with cancelled_by = airline", async () => {
    expect(stub.orders.cancelByAirline(booking.orderId)).toMatchObject({ status: "active" });

    const result = await syncJob(booking, T0);

    expect(result).toMatchObject({
      outcome: "synced",
      changes: { cancelledByAirline: true, versionMoved: true, segmentsChanged: 1 },
    });
    expect(await bookingOf(booking)).toMatchObject({
      status: "cancelled",
      cancelledBy: "airline",
      cancelledAt: T0,
      cancelReason: AIRLINE_CANCEL_REASON,
      nextAttemptAt: null,
      version: version + 1,
      lastSyncedAt: T0,
      syncError: null,
    });
    expect((await segmentsOf(booking)).map((segment) => segment.status)).toEqual(["CANCELLED"]);
    // booking.cancelled through OrderRecorder.event, visible to the customer; the schedule change is part of it.
    const events = await eventsOf(booking);
    expect(events.map((event) => [event.type, event.actorType, event.visible])).toEqual([
      ["booking.cancelled", "supplier", true],
    ]);
    expect(events[0]).toMatchObject({
      statusFrom: "confirmed",
      statusTo: "cancelled",
      data: { cancelledBy: "airline" },
    });
    // The documents follow the event: the cancelled itinerary of the new version waits in `ota-documents`.
    expect(await renderJobsOf(booking)).toEqual([{ kind: "itinerary", bookingVersion: version + 1 }]);
    // The traveller's e-mail, once per booking; nothing refunded (the money is staff's).
    expect(await notificationsOf(booking)).toEqual([
      {
        templateKey: "booking.cancelled",
        recipient: tenants.alpha.email,
        recipientType: "guest",
        dedupeKey: `booking.cancelled:${booking.id}`,
        payload: expect.objectContaining({
          booking: expect.objectContaining({
            reference: booking.reference,
            url: `https://alpha.ota.example.com/booking.html?id=${booking.id}`,
          }) as unknown,
          refund: { amount: "", currency: "" },
        }) as unknown,
      },
    ]);

    // A cancelled booking is no longer synchronised: the scan leaves it out, a stray job skips it.
    const later = plus(T0, 7 * HOUR);
    await scan("alpha", later);
    expect(await syncJobOf(booking, later)).toBeUndefined();
    expect(await syncJob(booking, plus(later, MINUTE))).toMatchObject({
      outcome: "skipped",
      reason: "not_active",
    });
    expect(readsOf(booking)).toHaveLength(1);
  });

  it("[FIX-W27-SYNC AC3] alerts staff once when the airline cancels a booking whose payment holds the money", async () => {
    const paymentId = await insertPayment(booking, "captured");
    stub.orders.cancelByAirline(booking.orderId);

    expect(await syncJob(booking, T0)).toMatchObject({
      outcome: "synced",
      changes: { cancelledByAirline: true },
    });

    const alerts = (await notificationsOf(booking)).filter(
      (row) => row.templateKey === "staff.manual_review",
    );
    expect(alerts).toEqual([
      {
        templateKey: "staff.manual_review",
        // No ops_alert_email and no owner of the OTA: Velexis ops (OPS_ALERT_EMAIL, StaffRecipients).
        recipient: "ops@example.com",
        recipientType: "staff",
        dedupeKey: `staff.manual_review:${booking.id}:${AIRLINE_CANCELLED_ALERT}`,
        payload: {
          booking: {
            reference: booking.reference,
            recordLocator: expect.stringMatching(/^[A-Z0-9]{6}$/) as unknown,
            consoleUrl: `http://localhost:3002/bookings/${booking.id}`,
          },
          review: { reason: expect.stringContaining(`${paymentId} captured 115.00 EUR`) as unknown },
        },
      },
    ]);
    // A Stripe payment keeps the console's wording (FIX-W28-NOTIFY AC4: the airline-card wording is its own).
    expect(JSON.stringify(alerts[0]?.payload)).toContain(
      "Release the authorisation or refund the payment from the console.",
    );
    // booking.cancelled through OrderRecorder.event, and the traveller's e-mail, as for any cancellation.
    expect((await eventsOf(booking)).map((event) => event.type)).toEqual(["booking.cancelled"]);
    expect((await notificationsOf(booking)).map((row) => row.templateKey)).toEqual([
      "booking.cancelled",
      "staff.manual_review",
    ]);
    // Once: neither a stray sync job nor a refresh of the cancelled booking alerts again.
    expect(await syncJob(booking, plus(T0, 7 * HOUR))).toMatchObject({
      outcome: "skipped",
      reason: "not_active",
    });
    expect(await refreshAs(booking)).toEqual({ kind: "skipped" });
    expect(
      (await notificationsOf(booking)).filter((row) => row.templateKey === "staff.manual_review"),
    ).toHaveLength(1);
  });

  it("[FIX-W28-NOTIFY AC4] words the alert of an airline-card payment for a refund through the airline, not the console", async () => {
    const paymentId = await insertPayment(booking, "captured", "airline_card");
    stub.orders.cancelByAirline(booking.orderId);

    expect(await syncJob(booking, T0)).toMatchObject({
      outcome: "synced",
      changes: { cancelledByAirline: true },
    });

    const alerts = (await notificationsOf(booking)).filter(
      (row) => row.templateKey === "staff.manual_review",
    );
    expect(alerts).toEqual([
      expect.objectContaining({
        dedupeKey: `staff.manual_review:${booking.id}:${AIRLINE_CANCELLED_ALERT}`,
        payload: expect.objectContaining({
          review: {
            reason: expect.stringContaining(
              `${paymentId} charged by the airline 115.00 EUR). The refund goes through the airline`,
            ) as unknown,
          },
        }) as unknown,
      }),
    ]);
    const reason = JSON.stringify(alerts[0]?.payload);
    expect(reason).not.toContain("Release the authorisation or refund the payment from the console");
  });

  it("[FIX-W27-SYNC AC3] alerts staff about an authorised payment too, and not about a booking without one", async () => {
    await insertPayment(booking, "authorized");
    const unpaid = await insertBooking({ key: "alpha", at: T0 });
    stub.orders.cancelByAirline(booking.orderId);
    stub.orders.cancelByAirline(unpaid.orderId);

    await syncJob(booking, T0);
    await syncJob(unpaid, T0);

    expect((await notificationsOf(booking)).map((row) => row.templateKey)).toEqual([
      "booking.cancelled",
      "staff.manual_review",
    ]);
    expect((await notificationsOf(booking))[1]?.payload).toMatchObject({
      review: { reason: expect.stringContaining("authorised 115.00 EUR") as unknown },
    });
    expect((await notificationsOf(unpaid)).map((row) => row.templateKey)).toEqual(["booking.cancelled"]);
  });

  it("[OBE-045 AC2] never cancels a booking whose order Amadeus no longer returns: ORDER_NOT_FOUND for staff", async () => {
    // Cancelled outside Velexis (Management DELETE): the stub answers 404 for it from now on.
    await deleteOrder(booking);
    stub.clearRequests();

    const result = await syncJob(booking, T0);

    expect(result).toMatchObject({ outcome: "failed", code: "ORDER_NOT_FOUND", rounds: 1 });
    expect(await bookingOf(booking)).toMatchObject({
      status: "confirmed",
      cancelledBy: null,
      syncError: "ORDER_NOT_FOUND",
      version,
      lastSyncedAt: plus(T0, -7 * HOUR),
      syncClaimedAt: T0,
    });
    expect((await eventsOf(booking)).map((event) => event.type)).toEqual([]);
    // Its claim keeps it out of the scans for 30 minutes, then the read is tried again.
    const soon = plus(T0, 10 * MINUTE);
    await scan("alpha", soon);
    expect(await syncJobOf(booking, soon)).toBeUndefined();
    const retry = plus(T0, BOOKING_SYNC_RETRY_MS);
    await scan("alpha", retry);
    expect((await syncJobOf(booking, retry))?.returnvalue).toMatchObject({
      outcome: "failed",
      code: "ORDER_NOT_FOUND",
    });
  });
});

describe("a concurrent change of the booking", () => {
  let T0: Date;
  let booking: SeededBooking;
  let version: number;

  beforeEach(async () => {
    T0 = clock.set(nextDay());
    await syncedEverything(T0);
    booking = await insertBooking({ key: "alpha", at: T0 });
    version = (await bookingOf(booking)).version;
    stub.clearRequests();
  }, BOOKING_SETUP_TIMEOUT_MS);

  it("[OBE-045 AC3] makes the sync read the order again instead of overwriting the booking", async () => {
    const first = plus(booking.departure, 60 * MINUTE);
    const second = plus(booking.departure, 150 * MINUTE);
    stub.orders.changeSegment(booking.orderId, "3", { departureAt: localOf(first) });
    // While the sync reads the order, the airline changes it again and another writer records the booking (its
    // version moves): what the sync read is stale.
    const client = app.get(AmadeusClient, { strict: false });
    const read = client.getFlightOrder.bind(client);
    vi.spyOn(client, "getFlightOrder").mockImplementationOnce(async (context, request, options) => {
      const reply = await read(context, request, options);
      stub.orders.changeSegment(booking.orderId, "3", { departureAt: localOf(second) });
      await concurrentChange(booking, "concurrent");
      return reply;
    });

    const result = await syncJob(booking, T0);

    expect(result).toMatchObject({ outcome: "synced", rounds: 2, changes: { scheduleChanged: true } });
    expect(readsOf(booking)).toHaveLength(2);
    // The second read was recorded, on top of the other writer's change; the stale one never was.
    expect((await segmentsOf(booking)).map((segment) => segment.departureLocal)).toEqual([localOf(second)]);
    expect(await bookingOf(booking)).toMatchObject({ version: version + 2, tags: ["concurrent"] });
    const changes = (await eventsOf(booking)).filter((event) => event.type === SCHEDULE_CHANGED_EVENT);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.data).toMatchObject({
      changed: [{ changes: { departureAt: { from: localOf(booking.departure), to: localOf(second) } } }],
    });
  });

  it("[OBE-045 AC3] writes nothing when every read is overtaken by another writer, and tries again when due", async () => {
    stub.orders.changeSegment(booking.orderId, "3", { departureAt: localOf(plus(booking.departure, HOUR)) });
    const client = app.get(AmadeusClient, { strict: false });
    const read = client.getFlightOrder.bind(client);
    let writes = 0;
    vi.spyOn(client, "getFlightOrder").mockImplementation(async (context, request, options) => {
      const reply = await read(context, request, options);
      writes += 1;
      await concurrentChange(booking, `writer-${writes}`);
      return reply;
    });

    const result = await syncJob(booking, T0);

    expect(result).toMatchObject({ outcome: "superseded", rounds: BOOKING_SYNC_ROUNDS });
    expect(readsOf(booking)).toHaveLength(BOOKING_SYNC_ROUNDS);
    expect((await segmentsOf(booking)).map((segment) => segment.departureLocal)).toEqual([
      localOf(booking.departure),
    ]);
    expect(await bookingOf(booking)).toMatchObject({
      version: version + BOOKING_SYNC_ROUNDS,
      lastSyncedAt: plus(T0, -7 * HOUR),
      syncClaimedAt: T0,
    });
    expect((await eventsOf(booking)).map((event) => event.type)).toEqual([]);

    // Once its claim is 30 minutes old, with the other writers gone, it records the change.
    vi.mocked(client.getFlightOrder).mockRestore();
    expect(await syncAt(booking, plus(T0, BOOKING_SYNC_RETRY_MS))).toMatchObject({
      outcome: "synced",
      changes: { scheduleChanged: true },
    });
  });
});

describe("the claim", () => {
  let T0: Date;
  let booking: SeededBooking;

  beforeEach(async () => {
    T0 = clock.set(nextDay());
    await syncedEverything(T0);
    booking = await insertBooking({ key: "alpha", at: T0 });
    stub.clearRequests();
  }, BOOKING_SETUP_TIMEOUT_MS);

  it("[OBE-045] claims a booking whose FOR KEY SHARE another transaction holds, and skips one a writer holds", async () => {
    // An event, outbox or document insert of the booking in progress (lead decision (1) of 2026-10-22).
    const keyShare = holdBooking(booking, "key_share");
    await keyShare.held;
    try {
      stub.orders.changeSegment(booking.orderId, "3", {
        departureAt: localOf(plus(booking.departure, HOUR)),
      });
      expect(await syncJob(booking, T0)).toMatchObject({
        outcome: "synced",
        changes: { scheduleChanged: true },
      });
    } finally {
      keyShare.release();
      await keyShare.done;
    }

    // A writer that locked the booking: the claim skips it and writes nothing.
    const writer = holdBooking(booking, "update");
    await writer.held;
    const later = plus(T0, 7 * HOUR);
    try {
      expect(await syncJob(booking, later)).toMatchObject({ outcome: "skipped", reason: "not_claimable" });
    } finally {
      writer.release();
      await writer.done;
    }
    // Only the first sync claimed it (`sync_claimed_at`, no event); the skipped one wrote nothing.
    expect((await bookingOf(booking)).syncClaimedAt).toEqual(T0);
    expect((await eventsOf(booking)).filter((event) => event.type === "booking.sync_requested")).toEqual([]);
    expect(readsOf(booking)).toHaveLength(1);
  });

  it("[OBE-045] records the tickets the airline issued: the booking becomes ticketed and the receipts are asked for", async () => {
    const issued = await insertBooking({ key: "alpha", at: T0, issuedAtAirline: true });
    const before = (await bookingOf(issued)).version;

    const result = await syncJob(issued, T0);

    expect(result).toMatchObject({
      outcome: "synced",
      changes: { ticketsAdded: 1, ticketed: true, scheduleChanged: false, versionMoved: true },
    });
    expect(await ticketsOf(issued)).toEqual([
      { documentNumber: expect.stringMatching(/^000-\d{10}$/) as unknown, travelerId: "1", status: "ISSUED" },
    ]);
    expect(await bookingOf(issued)).toMatchObject({
      status: "ticketed",
      ticketingStatus: "issued",
      issuedAt: T0,
      version: before + 1,
    });
    const events = await eventsOf(issued);
    expect(events.map((event) => [event.type, event.visible])).toEqual([["booking.ticketed", true]]);
    expect((await renderJobsOf(issued)).map((job) => job["kind"]).sort()).toEqual([
      "e_ticket_receipt",
      "itinerary",
    ]);
  });

  it("[OBE-045] refuses a booking.sync job that is not {tenantId, bookingId} at once", async () => {
    const id = `${BOOKING_SYNC_JOB}:invalid:${minuteBucket(T0)}`;
    await bookingsQueue.add(
      BOOKING_SYNC_JOB,
      { tenantId: tenants.alpha.id, bookingId: booking.id, extra: true },
      { jobId: id },
    );
    let job: Job | undefined;
    await vi.waitFor(async () => {
      job = await bookingsQueue.getJob(id);
      expect(job?.finishedOn).toBeDefined();
    }, JOB_WAIT);
    expect(await job?.getState()).toBe("failed");
    expect(job?.attemptsMade).toBe(1);
    expect(readsOf(booking)).toEqual([]);
  });
});

describe("the claim as a column (FIX-W27-SYNC)", () => {
  let T0: Date;
  let booking: SeededBooking;

  beforeEach(async () => {
    T0 = clock.set(nextDay());
    await syncedEverything(T0);
    booking = await insertBooking({ key: "alpha", at: T0 });
    stub.clearRequests();
  }, BOOKING_SETUP_TIMEOUT_MS);

  it("[FIX-W27-SYNC AC1] a sync claim writes no event and makes a refresh of the same moment stand back", async () => {
    stub.orders.changeSegment(booking.orderId, "3", { departureAt: localOf(plus(booking.departure, HOUR)) });
    // While the sync reads the order (its claim committed), a customer opens the booking with refresh=true.
    const client = app.get(AmadeusClient, { strict: false });
    const read = client.getFlightOrder.bind(client);
    let concurrent: RefreshOutcome | undefined;
    let eventsDuringRead: string[] = [];
    vi.spyOn(client, "getFlightOrder").mockImplementationOnce(async (context, request, options) => {
      eventsDuringRead = (await eventsOf(booking)).map((event) => event.type);
      concurrent = await refreshAs(booking);
      return await read(context, request, options);
    });

    const result = await syncJob(booking, T0);

    expect(result).toMatchObject({ outcome: "synced", changes: { scheduleChanged: true } });
    // The claim: the column, no event (none was written by the time Amadeus was called).
    expect(eventsDuringRead).toEqual([]);
    expect((await bookingOf(booking)).syncClaimedAt).toEqual(T0);
    // The refresh found the sync's claim within its 60 s throttle: throttled, no second Flight Order Management GET.
    expect(concurrent).toEqual({ kind: "throttled", retryAfterSeconds: REFRESH_THROTTLE_MS / 1000 });
    expect(readsOf(booking)).toHaveLength(1);
    expect((await eventsOf(booking)).map((event) => event.type)).toEqual([SCHEDULE_CHANGED_EVENT]);
  });

  it("[FIX-W27-SYNC AC1] a refresh's claim keeps the background sync away for 30 minutes, as the sync's own does", async () => {
    // A refresh whose read fails (Amadeus 500): its claim stays, the booking is not synchronised.
    stub.setDefaultScenario("server-error");
    await expect(refreshAs(booking)).rejects.toMatchObject({ code: "SUPPLIER_ERROR" });
    stub.setDefaultScenario("success");
    expect(await bookingOf(booking)).toMatchObject({
      syncClaimedAt: T0,
      syncError: "SUPPLIER_ERROR",
      lastSyncedAt: plus(T0, -7 * HOUR),
    });
    expect(await eventsOf(booking)).toEqual([]);

    // Due by its last synchronisation, but claimed: not before 30 minutes have passed.
    const soon = plus(T0, BOOKING_SYNC_RETRY_MS - MINUTE);
    await scan("alpha", soon);
    expect(await syncJobOf(booking, soon)).toBeUndefined();
    expect(await syncJob(booking, plus(soon, 30_000))).toMatchObject({
      outcome: "skipped",
      reason: "not_due",
    });
    const later = plus(T0, BOOKING_SYNC_RETRY_MS);
    expect(await syncAt(booking, later)).toMatchObject({ outcome: "synced" });
    expect(await bookingOf(booking)).toMatchObject({
      syncClaimedAt: later,
      lastSyncedAt: later,
      syncError: null,
    });
  });

  it("[FIX-W27-SYNC AC4] projects the order's forms of identification with their last 4 characters only", async () => {
    const numbers = [
      `P${randomBytes(5).toString("hex").toUpperCase()}`,
      `ID${randomBytes(5).toString("hex").toUpperCase()}`,
    ];
    const identified = await insertBooking({
      key: "alpha",
      at: T0,
      identifications: [
        { identificationType: "PASSPORT", number: numbers[0], travelerIds: ["1"] },
        { identificationType: "NATIONAL_IDENTITY_CARD", number: numbers[1], travelerIds: ["1"] },
      ],
    });

    expect(await syncJob(identified, T0)).toMatchObject({ outcome: "synced" });

    const row = await bookingOf(identified);
    expect(row.formOfIdentifications).toEqual([
      { identificationType: "PASSPORT", number: numbers[0]?.slice(-4), travelerIds: ["1"] },
      { identificationType: "NATIONAL_IDENTITY_CARD", number: numbers[1]?.slice(-4), travelerIds: ["1"] },
    ]);
    for (const number of numbers) {
      expect(JSON.stringify(row)).not.toContain(number);
    }
  });
});

describe("the scan", () => {
  let T0: Date;
  let due: SeededBooking[];
  let notDue: Record<string, SeededBooking>;
  let suspendedPaid: SeededBooking;
  let suspendedUnpaid: SeededBooking;

  beforeEach(async () => {
    T0 = clock.set(nextDay());
    // Every booking of the earlier tests is synchronised now: only this test's bookings may be due.
    await syncedEverything(T0);
    // BOOKING_SYNC_SCAN_BATCH + 2 due bookings, oldest synced first: one never synced, then 7 h + 21 min … 7 h ago.
    due = [await insertBooking({ key: "alpha", at: T0, unknownOrder: true, lastSyncedAt: null })];
    for (let index = BOOKING_SYNC_SCAN_BATCH; index >= 0; index -= 1) {
      due.push(
        await insertBooking({
          key: "alpha",
          at: T0,
          unknownOrder: true,
          lastSyncedAt: plus(T0, -7 * HOUR - index * MINUTE),
        }),
      );
    }
    // Claimed by a refresh 10 minutes ago (`sync_claimed_at`, lead decision (3) of 2026-10-23).
    const claimed = await insertBooking({ key: "alpha", at: T0, unknownOrder: true });
    await tx("alpha", (trx) =>
      trx
        .updateTable("bookings")
        .set({ sync_claimed_at: plus(T0, -10 * MINUTE) })
        .where("id", "=", claimed.id)
        .execute(),
    );
    notDue = {
      synced5hAgo: await insertBooking({
        key: "alpha",
        at: T0,
        unknownOrder: true,
        lastSyncedAt: plus(T0, -5 * HOUR),
      }),
      claimed10MinutesAgo: claimed,
      tripOver: await insertBooking({
        key: "alpha",
        at: T0,
        unknownOrder: true,
        trip: { departure: plus(T0, -3 * HOUR), arrival: plus(T0, -MINUTE) },
      }),
      pending: await insertBooking({ key: "alpha", at: T0, unknownOrder: true, status: "pending" }),
      cancelled: await insertBooking({ key: "alpha", at: T0, unknownOrder: true, status: "cancelled" }),
    };
    suspendedPaid = await insertBooking({ key: "beta", at: T0, unknownOrder: true });
    suspendedUnpaid = await insertBooking({ key: "beta", at: T0, unknownOrder: true, amountPaid: "0.00" });
    stub.clearRequests();
    // 30 bookings without a stub call each: inserts only.
  }, BOOKING_SETUP_TIMEOUT_MS);

  it("[OBE-045] enqueues booking.sync for the 20 oldest synced due bookings per tenant, paid ones only when suspended", async () => {
    expect(await scan("alpha", T0)).toBe(BOOKING_SYNC_SCAN_BATCH);
    const enqueued = due.slice(0, BOOKING_SYNC_SCAN_BATCH);
    const left = due.slice(BOOKING_SYNC_SCAN_BATCH);
    expect(left).toHaveLength(2);
    for (const booking of enqueued) {
      const job = await syncJobOf(booking, T0);
      expect(job?.data, `the sync job of ${booking.id}`).toEqual({
        tenantId: tenants.alpha.id,
        bookingId: booking.id,
      });
      // After the reconciliation's jobs of the queue, which carry no priority.
      expect(job?.opts.priority).toBe(BOOKING_SYNC_PRIORITY);
    }
    for (const booking of [...left, ...Object.values(notDue)]) {
      expect(await syncJobOf(booking, T0), `no sync job for ${booking.id}`).toBeUndefined();
    }
    // The jobs ran: the stub knows none of these orders, so each recorded ORDER_NOT_FOUND.
    for (const booking of enqueued) {
      const job = await finished(bookingsQueue, bookingSyncJobId(booking.id, minuteBucket(T0)));
      expect(job.returnvalue).toMatchObject({ outcome: "failed", code: "ORDER_NOT_FOUND" });
    }

    // The next run, 10 minutes later, takes the two left: the others were claimed.
    const next = plus(T0, 10 * MINUTE);
    expect(await scan("alpha", next)).toBe(2);
    for (const booking of left) {
      await finished(bookingsQueue, bookingSyncJobId(booking.id, minuteBucket(next)));
    }

    // A suspended tenant's bookings: the paid one only (OADR-0008 point 8).
    expect(await scan("beta", next)).toBe(1);
    expect(await syncJobOf(suspendedPaid, next)).toBeDefined();
    expect(await syncJobOf(suspendedUnpaid, next)).toBeUndefined();
    await finished(bookingsQueue, bookingSyncJobId(suspendedPaid.id, minuteBucket(next)));
  });
});

describe("the ticketing deadline", () => {
  let T0: Date;
  let near: SeededBooking;
  let notDue: Record<string, SeededBooking>;

  beforeEach(async () => {
    T0 = clock.set(nextDay());
    await syncedEverything(T0);
    const deadline = plus(T0, 20 * HOUR);
    const hourAgo = plus(T0, -BOOKING_SYNC_DEADLINE_INTERVAL_MS);
    // Waits for its tickets, its ticketing deadline 20 hours away, synchronised an hour ago.
    near = await insertBooking({
      key: "alpha",
      at: T0,
      lastSyncedAt: hourAgo,
      ticketingDeadlineAt: deadline,
    });
    notDue = {
      syncedLessThanAnHourAgo: await insertBooking({
        key: "alpha",
        at: T0,
        unknownOrder: true,
        lastSyncedAt: plus(hourAgo, MINUTE),
        ticketingDeadlineAt: deadline,
      }),
      ticketed: await insertBooking({
        key: "alpha",
        at: T0,
        unknownOrder: true,
        status: "ticketed",
        lastSyncedAt: hourAgo,
        ticketingDeadlineAt: deadline,
      }),
      deadlineMoreThan24hAway: await insertBooking({
        key: "alpha",
        at: T0,
        unknownOrder: true,
        lastSyncedAt: hourAgo,
        ticketingDeadlineAt: plus(T0, 24 * HOUR + MINUTE),
      }),
      deadlinePassed: await insertBooking({
        key: "alpha",
        at: T0,
        unknownOrder: true,
        lastSyncedAt: hourAgo,
        ticketingDeadlineAt: plus(T0, -MINUTE),
      }),
    };
    stub.clearRequests();
  }, BOOKING_SETUP_TIMEOUT_MS);

  it("[OBE-045] synchronises a booking that waits for tickets hourly in the 24 h before its ticketing deadline", async () => {
    // The document's ConsoleSupplierSync.nextScheduledSyncAt: "every 6 h …, hourly in the 24 h before the deadline".
    expect(await scan("alpha", T0)).toBe(1);
    expect((await syncJobOf(near, T0))?.returnvalue).toMatchObject({ outcome: "synced" });
    for (const [name, booking] of Object.entries(notDue)) {
      expect(await syncJobOf(booking, T0), `no sync job for ${name}`).toBeUndefined();
      // The claim checks the same rule, whatever a job says.
      expect(await syncJob(booking, T0), name).toMatchObject({ outcome: "skipped", reason: "not_due" });
    }

    // An hour after that synchronisation it is due again, not a minute before.
    const early = plus(T0, BOOKING_SYNC_DEADLINE_INTERVAL_MS - MINUTE);
    await scan("alpha", early);
    expect(await syncJobOf(near, early)).toBeUndefined();
    const next = plus(T0, BOOKING_SYNC_DEADLINE_INTERVAL_MS);
    expect(await syncAt(near, next)).toMatchObject({ outcome: "synced" });
    expect(readsOf(near)).toHaveLength(2);
  });
});
