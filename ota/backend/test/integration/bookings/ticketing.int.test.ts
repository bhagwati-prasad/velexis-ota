// The issuance retries of the ticketing job (OBE-044, OF-06; OADR-0008 points 3–5 and 8, OADR-0014 point 6,
// ota/docs/flows/ticketing-and-documents.md §2–§4 and §7) against PostgreSQL 16, Redis 7 and the Amadeus stub.
//
// The file runs the real worker module graph (WorkerModule.forRoot: the `ota-maintenance` fan-out, the `ticketing.scan`
// handler and the `ota-ticketing` consumer of BookingsWorkerModule, the worker's Amadeus client) on a clone of the
// @velexis/testing template (`tenant_alpha` and `tenant_beta` provisioned) and a Redis database of its own. It plays the
// platform: `alpha` (active) and `beta` (suspended) on the Velexis test Amadeus account, whose `base_url` is the stub's
// (the worker has no AMADEUS_BASE_URL_* override), each with an office of its own. Every booking's order is created on
// the stub through the worker's own Amadeus client, and its booking row is then written as checkout.complete leaves a
// booking whose first issuance failed (OBE-042: `confirmed`, `ticketing_status = failed`, one attempt, the next one
// 5 minutes later): an order of the stub's priced offer 2 for one traveller, without tickets.
//
// At start-up the worker registers its schedulers; the file removes them, so no iteration fires while it runs, and
// plays the scheduler instead: a `ticketing.scan` iteration is a `fan-out` job with the iteration's `prevMillis`, or the
// per-tenant scan job itself, and the file waits for the jobs whose ids it knows. `Clock` is pointed at a FakeClock that
// only moves forward: each test starts on a day of its own after the previous one. The stub's `timeout` scenario holds
// an answer for 100 ms instead of 30 s (its timers option).
import { randomBytes } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplicationContext } from "@nestjs/common";
import { encryptValue } from "@velexis/crypto";
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
import { startAmadeusStub, type AmadeusStub } from "@velexis/testing/amadeus";
import type { Job, Queue } from "bullmq";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AmadeusClient } from "../../../src/amadeus/amadeus.client";
import { newBookingReference } from "../../../src/bookings/booking-reference";
import { readCreatedOrder } from "../../../src/bookings/order-recorder";
import { buildCreateOrderRequest } from "../../../src/bookings/order-request.builder";
import {
  TICKETING_ISSUE_JOB,
  TICKETING_SCAN_JOB,
  ticketingJob,
  ticketingJobId,
  type TicketingJobResult,
} from "../../../src/bookings/ticketing.processor";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { loadWorkerConfig } from "../../../src/config";
import { jobTenant, minuteBucket, tenantJob, type TenantJobResult } from "../../../src/jobs/fan-out";
import { FAN_OUT_JOB } from "../../../src/jobs/schedulers";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import { PlatformCache } from "../../../src/tenancy/platform-cache";
import { TenantContext } from "../../../src/tenancy/tenant-context";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { buildOrderRequestInput } from "../../builders/bookings";
import { testKeyProvider, testWorkerVariables } from "../../helpers/api-env";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";

/**
 * Cloning the template, starting the stub and the worker graph (BullMQ connections, the scheduler registration, the
 * key files) takes a few seconds locally and much longer on a busy 4-CPU runner: all of it happens once, here.
 */
const SETUP_TIMEOUT_MS = 30_000;
/** How long a test waits at most for the worker to finish a job it added (they take milliseconds). */
const JOB_WAIT = { timeout: 4000, interval: 20 } as const;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The OTA's staff alert address (`storefront_settings.ops_alert_email`) of alpha. */
const ALPHA_OPS_EMAIL = "ops@alpha-travel.example";

const quietPoolLogger = { error: (): void => undefined };

type TenantKey = "alpha" | "beta";
type Schema = `tenant_${TenantKey}`;

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
let ticketing: Queue;
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

/** An order of the stub's priced offer 2 for one traveller, created as `key` through the worker's Amadeus client. */
async function createOrder(key: TenantKey): Promise<{ readonly id: string; readonly recordLocator: string }> {
  const tenant = await app.get(PlatformCache, { strict: false }).tenantById(tenants[key].id);
  if (tenant === null) {
    throw new Error(`tenant ${key} is not readable`);
  }
  const requestId = `ticketing-test-${randomBytes(4).toString("hex")}`;
  const office = tenants[key].office;
  const request = buildCreateOrderRequest(
    buildOrderRequestInput({
      reference: newBookingReference(),
      queue: null,
      offices: { queuing: office, owner: office },
      issue: false,
    }),
  );
  const client = app.get(AmadeusClient, { strict: false });
  const reply = await app
    .get(TenantContext, { strict: false })
    .run(jobTenant(tenant, { id: requestId, name: "setup" }), () =>
      client.createFlightOrders(
        { tenantId: tenant.id, environment: "test", operation: "test.setup", requestId },
        {
          body: request.body as unknown as Parameters<AmadeusClient["createFlightOrders"]>[1]["body"],
          query: request.query,
        },
      ),
    );
  const order = readCreatedOrder(reply.body);
  const recordLocator = order?.records[0]?.reference;
  if (order === undefined || recordLocator === undefined || order.tickets.length > 0) {
    throw new Error("the stub did not create an order without tickets");
  }
  return { id: order.id, recordLocator };
}

/** A booking as checkout.complete leaves one whose issuance failed, by default (see the file header). */
interface BookingSeed {
  readonly key: TenantKey;
  /** When the last attempt failed (`ticketing_last_attempt_at`). */
  readonly failedAt: Date;
  readonly attempts?: number;
  readonly status?: "failed" | "in_progress";
  /** `ticketing_next_attempt_at`; 5 minutes after `failedAt` by default. */
  readonly nextAttemptAt?: Date | null;
  readonly deadlineAt: Date | null;
  readonly errorCode?: string;
  readonly amountPaid?: string;
  /** Paid with an airline card (a `payments` row with `method = airline_card`). */
  readonly airlineCard?: boolean;
}

interface SeededBooking {
  readonly id: string;
  readonly key: TenantKey;
  readonly orderId: string;
  readonly reference: string;
}

async function insertBooking(seed: BookingSeed): Promise<SeededBooking> {
  const order = await createOrder(seed.key);
  const id = newId("bkg");
  const reference = newBookingReference();
  const departure = plus(seed.failedAt, 30 * DAY);
  await tx(seed.key, async (trx) => {
    await trx
      .insertInto("bookings")
      .values({
        id,
        environment: "test",
        reference,
        status: "confirmed",
        amadeus_order_id: order.id,
        record_locator: order.recordLocator,
        origin_system_code: "1A",
        queuing_office_id: tenants[seed.key].office,
        owner_office_id: tenants[seed.key].office,
        ticketing_deadline_at: seed.deadlineAt,
        issue_requested: false,
        ticketing_status: seed.status ?? "failed",
        ticketing_requested_at: seed.failedAt,
        ticketing_attempts: seed.attempts ?? 1,
        ticketing_last_attempt_at: seed.failedAt,
        ticketing_next_attempt_at:
          seed.nextAttemptAt === undefined ? plus(seed.failedAt, 5 * MINUTE) : seed.nextAttemptAt,
        ticketing_error_code: seed.status === "in_progress" ? null : (seed.errorCode ?? "TICKETING_FAILED"),
        ticketing_error: seed.status === "in_progress" ? null : "Flight Order Issue failed",
        trip_type: "one_way",
        origin_iata: "MAD",
        destination_iata: "ORY",
        first_departure_at: departure,
        last_arrival_at: plus(departure, 2 * HOUR),
        currency: "EUR",
        net_amount: "100.00",
        total_amount: "115.00",
        amount_paid: seed.amountPaid ?? "115.00",
        contact_email: tenants[seed.key].email,
        lead_last_name: "SAMPLE",
        created_at: seed.failedAt,
        updated_at: seed.failedAt,
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
    if (seed.airlineCard === true) {
      await trx
        .insertInto("payments")
        .values({
          id: newId("pay"),
          environment: "test",
          booking_id: id,
          provider: "airline",
          method: "airline_card",
          capture_method: "automatic",
          currency: "EUR",
          amount: "100.00",
          status: "captured",
          card_brand: "VISA",
          card_last4: "1111",
        })
        .execute();
    }
  });
  return { id, key: seed.key, orderId: order.id, reference };
}

/** The ticketing columns of a booking. */
async function ticketingOf(booking: SeededBooking) {
  return await tx(booking.key, (trx) =>
    trx
      .selectFrom("bookings")
      .select([
        "status",
        "ticketing_status as ticketingStatus",
        "ticketing_attempts as attempts",
        "ticketing_last_attempt_at as lastAttemptAt",
        "ticketing_next_attempt_at as nextAttemptAt",
        "ticketing_error_code as errorCode",
        "issued_at as issuedAt",
        "last_synced_at as lastSyncedAt",
      ])
      .where("id", "=", booking.id)
      .executeTakeFirstOrThrow(),
  );
}

async function eventsOf(booking: SeededBooking) {
  return await tx(booking.key, (trx) =>
    trx
      .selectFrom("booking_events")
      .select(["type", "actor_type as actorType", "visible_to_customer as visible", "data"])
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
      .select(["template_key as templateKey", "recipient", "recipient_type as recipientType", "payload"])
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

/** The stub's requests about one order, by Amadeus operation. */
const callsOf = (booking: SeededBooking, operation: "getFlightOrder" | "issueFlightOrder") =>
  stub
    .requests()
    .filter(
      (entry) => entry.operation === operation && entry.path.includes(encodeURIComponent(booking.orderId)),
    );

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
 * One `ticketing.scan` of `key` at `at`, as the fan-out enqueues it (the per-tenant job of the iteration's minute):
 * the clock moves to `at` first. Resolves with the number of bookings it found due.
 */
async function scan(key: TenantKey, at: Date): Promise<number> {
  clock.set(at);
  const job = tenantJob(TICKETING_SCAN_JOB, tenants[key].id, minuteBucket(at));
  await maintenance.add(job.name, job.data, job.opts);
  const result = (await finished(maintenance, job.opts.jobId)).returnvalue as TenantJobResult;
  expect(result).toMatchObject({ task: TICKETING_SCAN_JOB, outcome: "done" });
  return result.outcome === "done" ? (result.counts["due"] ?? 0) : 0;
}

/** The `ticketing.issue` job the scan at `at` added for the booking, or `undefined` when it added none. */
async function issueJobOf(booking: SeededBooking, at: Date): Promise<Job | undefined> {
  return await ticketing.getJob(ticketingJobId(booking.id, minuteBucket(at)));
}

/** A scan of the booking's tenant at `at` and the booking's `ticketing.issue` job it enqueued, once finished. */
async function attemptAt(booking: SeededBooking, at: Date): Promise<TicketingJobResult> {
  await scan(booking.key, at);
  const job = await finished(ticketing, ticketingJobId(booking.id, minuteBucket(at)));
  return job.returnvalue as TicketingJobResult;
}

/** A scan at `at` that must not enqueue the booking. */
async function expectNotDue(booking: SeededBooking, at: Date): Promise<void> {
  await scan(booking.key, at);
  expect(
    await issueJobOf(booking, at),
    `a ticketing.issue job for ${booking.id} at ${at.toISOString()}`,
  ).toBe(undefined);
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
    max: 3,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });

  const clientId = `velexis-test-${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(24).toString("base64url");
  stub = await startAmadeusStub({
    credentials: { clientId, clientSecret: secret },
    // The `timeout` scenario holds an answer for 100 ms, then gives up with its 504, as after 30 s.
    timers: {
      setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 100)),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
  });
  const accountId = await insertAccount(clientId, secret);
  await insertTenant("alpha", "active", accountId);
  await insertTenant("beta", "suspended", accountId);
  for (const key of ["alpha", "beta"] as const) {
    await tx(key, async (trx) => {
      await seedStorefrontSettings(trx, {
        name: `${key} Travel`,
        defaultCurrency: "EUR",
        defaultLocale: "en",
      });
      // Alpha has an alert address; beta's alerts go to its support e-mail.
      await trx
        .updateTable("storefront_settings")
        .set(
          key === "alpha"
            ? { ops_alert_email: ALPHA_OPS_EMAIL, time_zone: "Europe/Madrid" }
            : { support_email: "support@beta-travel.example" },
        )
        .execute();
    });
  }

  const config = loadWorkerConfig({
    ...testWorkerVariables(),
    APP_ENV: "test",
    DATABASE_URL: db.urlFor("ota"),
    DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
    REDIS_URL: redis.url,
  });
  useNextApplicationLoggerOutsideRequests();
  app = await createWorkerApp(
    WorkerModule.forRoot(config, { logger: createWorkerLogger(config, new MemorySink()) }),
  );
  await app.init();
  maintenance = app.get<Queue>(getQueueToken(OTA_QUEUE.maintenance));
  ticketing = app.get<Queue>(getQueueToken(OTA_QUEUE.ticketing));
  // From here on the file plays the scheduler: no iteration of the real one may fire during a test.
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await stub?.stop();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
});

/** The budget of the hooks that create a test's orders and bookings: a few stub calls and inserts each. */
const BOOKING_SETUP_TIMEOUT_MS = 15_000;

beforeEach(() => {
  clock = new FakeClock(BASE);
  // restoreMocks undoes this after every test.
  vi.spyOn(app.get(Clock), "now").mockImplementation(() => clock.now());
  stub.setDefaultScenario("success");
});

describe("the retries of a failed issuance (stub ticketing-failed)", () => {
  let T0: Date;
  let booking: SeededBooking;

  beforeEach(async () => {
    T0 = clock.set(nextDay());
    // The deadline is 6 hours after the first failure: no attempt may start after T0 + 4 h.
    booking = await insertBooking({ key: "alpha", failedAt: T0, deadlineAt: plus(T0, 6 * HOUR) });
    stub.clearRequests();
    stub.setDefaultScenario("ticketing-failed");
  }, BOOKING_SETUP_TIMEOUT_MS);

  it("[OBE-044 AC1] follow the schedule, stop at the deadline − 2 h and write the alerts once [OF-06 AC1]", async () => {
    // Not due 4 minutes after the failure; due at +5 min.
    await expectNotDue(booking, plus(T0, 4 * MINUTE));
    const attempts: TicketingJobResult[] = [];
    attempts.push(await attemptAt(booking, plus(T0, 5 * MINUTE)));
    await expectNotDue(booking, plus(T0, 19 * MINUTE));
    attempts.push(await attemptAt(booking, plus(T0, 20 * MINUTE)));
    attempts.push(await attemptAt(booking, plus(T0, HOUR + 20 * MINUTE)));
    attempts.push(await attemptAt(booking, plus(T0, 3 * HOUR + 20 * MINUTE)));

    // +5 min, +15 min, +1 h, then 2 h: the 6th attempt would start at T0 + 5 h 20 min, after T0 + 4 h.
    expect(attempts).toEqual([
      expect.objectContaining({
        outcome: "retry_scheduled",
        attempts: 2,
        code: "TICKETING_FAILED",
        nextAttemptAt: plus(T0, 20 * MINUTE).toISOString(),
      }),
      expect.objectContaining({
        outcome: "retry_scheduled",
        attempts: 3,
        nextAttemptAt: plus(T0, HOUR + 20 * MINUTE).toISOString(),
      }),
      expect.objectContaining({
        outcome: "retry_scheduled",
        attempts: 4,
        nextAttemptAt: plus(T0, 3 * HOUR + 20 * MINUTE).toISOString(),
      }),
      expect.objectContaining({
        outcome: "gave_up",
        attempts: 5,
        code: "TICKETING_FAILED",
        reason: "deadline",
      }),
    ]);
    // Each attempt read the order first, then sent Flight Order Issue (answered 9112).
    expect(callsOf(booking, "getFlightOrder")).toHaveLength(4);
    expect(callsOf(booking, "issueFlightOrder").map((call) => call.status)).toEqual([400, 400, 400, 400]);
    expect(await ticketingOf(booking)).toMatchObject({
      status: "confirmed",
      ticketingStatus: "failed",
      attempts: 5,
      nextAttemptAt: null,
      lastAttemptAt: plus(T0, 3 * HOUR + 20 * MINUTE),
      errorCode: "TICKETING_FAILED",
      issuedAt: null,
    });

    // Given up: nothing is due any more, and a stray job changes nothing.
    await expectNotDue(booking, plus(T0, 5 * HOUR + 20 * MINUTE));
    const stray = ticketingJob(tenants.alpha.id, booking.id, minuteBucket(plus(T0, 5 * HOUR + 21 * MINUTE)));
    await ticketing.add(stray.name, stray.data, stray.opts);
    expect((await finished(ticketing, stray.opts.jobId)).returnvalue).toMatchObject({
      outcome: "skipped",
      reason: "not_due",
    });
    expect(callsOf(booking, "issueFlightOrder")).toHaveLength(4);

    // The alerts, once each: the staff's to ops_alert_email and the traveller's to the primary contact.
    const notifications = await notificationsOf(booking);
    expect(notifications.map((row) => [row.templateKey, row.recipient, row.recipientType])).toEqual([
      ["booking.ticketing_delayed", tenants.alpha.email, "guest"],
      ["staff.ticketing_failed", ALPHA_OPS_EMAIL, "staff"],
    ]);
    expect(notifications[1]?.payload).toMatchObject({
      booking: {
        reference: booking.reference,
        consoleUrl: `http://localhost:3002/bookings/${booking.id}`,
      },
      failure: { code: "TICKETING_FAILED", attempts: 5 },
    });
    expect(notifications[0]?.payload).toMatchObject({
      booking: {
        reference: booking.reference,
        url: `https://alpha.ota.example.com/booking.html?id=${booking.id}`,
        total: { amount: "115.00", currency: "EUR" },
        travellers: [{ firstName: "TESTA", lastName: "SAMPLE" }],
      },
    });
    // The timeline: four failures for staff, and one line for the traveller.
    const events = await eventsOf(booking);
    expect(events.map((event) => [event.type, event.actorType, event.visible])).toEqual([
      ["booking.ticketing_failed", "system", false],
      ["booking.ticketing_failed", "system", false],
      ["booking.ticketing_failed", "system", false],
      ["booking.ticketing_failed", "system", false],
      ["booking.ticketing_delayed", "system", true],
    ]);
    expect(events[3]?.data).toMatchObject({ attempt: 5, nextAttemptAt: null, stop: "deadline" });
  });
});

describe("the retries without a deadline", () => {
  let T0: Date;
  let booking: SeededBooking;

  beforeEach(async () => {
    T0 = clock.set(nextDay());
    booking = await insertBooking({ key: "alpha", failedAt: T0, deadlineAt: null });
    stub.clearRequests();
    stub.setDefaultScenario("ticketing-failed");
  }, BOOKING_SETUP_TIMEOUT_MS);

  it("[OBE-044 AC1] stop after the 8th attempt and alert once", async () => {
    const offsets = [5, 20, 80, 200, 320, 440, 560].map((minutes) => minutes * MINUTE);
    const outcomes: string[] = [];
    for (const offset of offsets) {
      outcomes.push((await attemptAt(booking, plus(T0, offset))).outcome);
    }

    expect(outcomes).toEqual([...Array<string>(6).fill("retry_scheduled"), "gave_up"]);
    expect(callsOf(booking, "issueFlightOrder")).toHaveLength(7);
    expect(await ticketingOf(booking)).toMatchObject({
      attempts: 8,
      nextAttemptAt: null,
      ticketingStatus: "failed",
    });
    expect((await notificationsOf(booking)).map((row) => row.templateKey)).toEqual([
      "booking.ticketing_delayed",
      "staff.ticketing_failed",
    ]);
    const last = (await eventsOf(booking))
      .filter((event) => event.type === "booking.ticketing_failed")
      .at(-1);
    expect(last?.data).toMatchObject({ attempt: 8, stop: "attempts_exhausted" });
  });
});

describe("a timed-out issuance", () => {
  let T0: Date;
  let booking: SeededBooking;

  beforeEach(async () => {
    T0 = clock.set(nextDay());
    booking = await insertBooking({ key: "alpha", failedAt: T0, deadlineAt: plus(T0, 10 * DAY) });
    stub.clearRequests();
  }, BOOKING_SETUP_TIMEOUT_MS);

  it("[OBE-044 AC2] is followed by a resync that records the tickets: no second issue call [OF-06 AC2]", async () => {
    // The next Flight Order Issue times out at the stub after issuing (scenario `timeout`, chosen for that one call).
    const client = app.get(AmadeusClient, { strict: false });
    const issue = client.issueFlightOrder.bind(client);
    vi.spyOn(client, "issueFlightOrder").mockImplementationOnce((context, request, options) =>
      issue({ ...context, stubScenario: "timeout" }, request, options),
    );

    const timedOut = await attemptAt(booking, plus(T0, 5 * MINUTE));

    // "May have issued": no immediate retry, the next attempt 15 minutes later.
    expect(timedOut).toMatchObject({
      outcome: "retry_scheduled",
      attempts: 2,
      code: "SUPPLIER_TIMEOUT",
      nextAttemptAt: plus(T0, 20 * MINUTE).toISOString(),
    });
    expect(callsOf(booking, "issueFlightOrder").map((call) => call.status)).toEqual([504]);
    expect(await ticketsOf(booking)).toEqual([]);

    const resynced = await attemptAt(booking, plus(T0, 20 * MINUTE));

    expect(resynced).toMatchObject({ outcome: "ticketed", via: "resync", coverage: "full", attempts: 3 });
    // One issue call in all: the second attempt's GET found the ticket the timed-out call had issued.
    expect(callsOf(booking, "issueFlightOrder")).toHaveLength(1);
    expect(callsOf(booking, "getFlightOrder")).toHaveLength(2);
    const tickets = await ticketsOf(booking);
    expect(tickets).toEqual([
      { documentNumber: expect.stringMatching(/^[0-9]{3}-?[0-9]{6,13}$/), travelerId: "1", status: "ISSUED" },
    ]);
    expect(await ticketingOf(booking)).toMatchObject({
      status: "ticketed",
      ticketingStatus: "issued",
      nextAttemptAt: null,
      errorCode: null,
      issuedAt: plus(T0, 20 * MINUTE),
      lastSyncedAt: plus(T0, 20 * MINUTE),
    });
    const events = await eventsOf(booking);
    expect(events.map((event) => event.type)).toEqual(["booking.ticketing_failed", "booking.ticketed"]);
    expect(events[1]).toMatchObject({ visible: true, data: { via: "resync", attempt: 3 } });
    // No alert: the booking is ticketed.
    expect(await notificationsOf(booking)).toEqual([]);
  });
});

describe("which bookings are retried", () => {
  let T0: Date;

  beforeEach(() => {
    T0 = clock.set(nextDay());
  });

  // A booking a test leaves due (a fresh claim becomes an abandoned one) would be retried by the next test's scans.
  afterEach(async () => {
    for (const key of ["alpha", "beta"] as const) {
      await tx(key, (trx) =>
        trx
          .updateTable("bookings")
          .set({ ticketing_status: "manual_review", ticketing_next_attempt_at: null })
          .where("ticketing_status", "in", ["pending", "failed", "in_progress"])
          .execute(),
      );
    }
  });

  it("issues at the next attempt when the airline accepts, through the fan-out of both tenants", async () => {
    const alpha = await insertBooking({ key: "alpha", failedAt: T0, deadlineAt: null });
    // A suspended OTA's paid booking is still ticketed (OADR-0008 point 8).
    const beta = await insertBooking({ key: "beta", failedAt: T0, deadlineAt: null });
    stub.clearRequests();
    const due = plus(T0, 5 * MINUTE);
    clock.set(due);

    const fanOut = await maintenance.add(
      FAN_OUT_JOB,
      { task: TICKETING_SCAN_JOB },
      { prevMillis: due.getTime() },
    );
    await finished(maintenance, fanOut.id ?? "");
    for (const booking of [alpha, beta]) {
      const job = await finished(ticketing, ticketingJobId(booking.id, minuteBucket(due)));
      expect(job.data).toEqual({ tenantId: tenants[booking.key].id, bookingId: booking.id });
      expect(job.returnvalue).toMatchObject({
        outcome: "ticketed",
        via: "issue",
        coverage: "full",
        attempts: 2,
      });
      expect(callsOf(booking, "issueFlightOrder").map((call) => call.status)).toEqual([200]);
      expect(await ticketingOf(booking)).toMatchObject({ status: "ticketed", ticketingStatus: "issued" });
      expect(await ticketsOf(booking)).toHaveLength(1);
    }
  });

  it("never retries an airline-card booking, nor a suspended tenant's unpaid one", async () => {
    const airlineCard = await insertBooking({
      key: "alpha",
      failedAt: T0,
      deadlineAt: null,
      airlineCard: true,
    });
    const unpaid = await insertBooking({ key: "beta", failedAt: T0, deadlineAt: null, amountPaid: "0.00" });
    stub.clearRequests();
    const due = plus(T0, 6 * MINUTE);

    await expectNotDue(airlineCard, due);
    await expectNotDue(unpaid, due);

    // A job for them anyway (by hand): the claim checks again and changes nothing.
    for (const [booking, reason] of [
      [airlineCard, "airline_card"],
      [unpaid, "unpaid"],
    ] as const) {
      const stray = ticketingJob(tenants[booking.key].id, booking.id, minuteBucket(due) + 1);
      await ticketing.add(stray.name, stray.data, stray.opts);
      expect((await finished(ticketing, stray.opts.jobId)).returnvalue).toMatchObject({
        outcome: "skipped",
        reason,
      });
      expect(await ticketingOf(booking)).toMatchObject({ ticketingStatus: "failed", attempts: 1 });
    }
    expect(stub.requests().filter((call) => call.operation === "issueFlightOrder")).toEqual([]);
  });

  it("takes over a claim older than 5 minutes, and leaves a fresh one alone", async () => {
    const abandoned = await insertBooking({
      key: "alpha",
      failedAt: T0,
      status: "in_progress",
      attempts: 2,
      nextAttemptAt: null,
      deadlineAt: null,
    });
    const fresh = await insertBooking({
      key: "alpha",
      failedAt: plus(T0, 4 * MINUTE),
      status: "in_progress",
      attempts: 2,
      nextAttemptAt: null,
      deadlineAt: null,
    });
    stub.clearRequests();
    const at = plus(T0, 6 * MINUTE);

    const result = await attemptAt(abandoned, at);

    expect(result).toMatchObject({ outcome: "ticketed", via: "issue", attempts: 3 });
    expect(await issueJobOf(fresh, at)).toBeUndefined();
    expect(await ticketingOf(fresh)).toMatchObject({ ticketingStatus: "in_progress", attempts: 2 });
  });

  it("skips a booking that another transaction holds (FOR UPDATE SKIP LOCKED), without calling Amadeus", async () => {
    const booking = await insertBooking({ key: "alpha", failedAt: T0, deadlineAt: null });
    stub.clearRequests();
    const due = plus(T0, 5 * MINUTE);

    // A request (or another worker) holds the booking's row while the scan and the job run.
    const held = await tx("alpha", async (trx) => {
      await trx.selectFrom("bookings").select("id").where("id", "=", booking.id).forUpdate().execute();
      return await attemptAt(booking, due);
    });

    expect(held).toMatchObject({ outcome: "skipped", reason: "not_claimable" });
    expect(stub.requests()).toEqual([]);
    expect(await ticketingOf(booking)).toMatchObject({
      ticketingStatus: "failed",
      attempts: 1,
      nextAttemptAt: due,
    });
    // Once the row is free, the next scan's job claims it.
    expect(await attemptAt(booking, plus(due, MINUTE))).toMatchObject({ outcome: "ticketed", attempts: 2 });
  });

  it("commits the claim before Amadeus is called, and writes nothing once the claim was taken over", async () => {
    const booking = await insertBooking({ key: "alpha", failedAt: T0, deadlineAt: null });
    stub.clearRequests();
    const due = plus(T0, 5 * MINUTE);
    const takenOverAt = plus(due, MINUTE);
    const atResync: unknown[] = [];
    // During the resync: the claim is visible to another connection and its row lock is released (NOWAIT would fail
    // on a lock that an open transaction of the job still held). Then another worker takes the claim over.
    const client = app.get(AmadeusClient, { strict: false });
    const getOrder = client.getFlightOrder.bind(client);
    vi.spyOn(client, "getFlightOrder").mockImplementationOnce(async (context, request, options) => {
      atResync.push(
        await tx("alpha", async (trx) => {
          await trx
            .selectFrom("bookings")
            .select("id")
            .where("id", "=", booking.id)
            .forUpdate()
            .noWait()
            .execute();
          return await trx
            .selectFrom("bookings")
            .select(["ticketing_status as ticketingStatus", "ticketing_attempts as attempts"])
            .where("id", "=", booking.id)
            .executeTakeFirstOrThrow();
        }),
      );
      await tx("alpha", (trx) =>
        trx
          .updateTable("bookings")
          .set({ ticketing_last_attempt_at: takenOverAt, updated_at: takenOverAt })
          .where("id", "=", booking.id)
          .execute(),
      );
      return await getOrder(context, request, options);
    });

    const lost = await attemptAt(booking, due);

    expect(atResync).toEqual([{ ticketingStatus: "in_progress", attempts: 2 }]);
    // The job issued (the order had no ticket), but its result is not written: the claim is the other worker's.
    expect(lost).toMatchObject({ outcome: "claim_lost" });
    expect(callsOf(booking, "issueFlightOrder").map((call) => call.status)).toEqual([200]);
    expect(await ticketingOf(booking)).toMatchObject({
      status: "confirmed",
      ticketingStatus: "in_progress",
      attempts: 2,
      lastAttemptAt: takenOverAt,
      issuedAt: null,
    });
    expect(await ticketsOf(booking)).toEqual([]);
    expect(await eventsOf(booking)).toEqual([]);

    // That claim is abandoned in turn: the next attempt's resync records the tickets, with no second issue call.
    expect(await attemptAt(booking, plus(takenOverAt, 6 * MINUTE))).toMatchObject({
      outcome: "ticketed",
      via: "resync",
      attempts: 3,
    });
    expect(callsOf(booking, "issueFlightOrder")).toHaveLength(1);
    expect(await ticketsOf(booking)).toHaveLength(1);
  });

  it("only re-reads the order when the deadline is less than 2 hours away, then gives up", async () => {
    // checkout.complete set the next attempt 5 minutes after its failure, 2 h 3 min before the deadline.
    const late = await insertBooking({
      key: "alpha",
      failedAt: T0,
      deadlineAt: plus(T0, 2 * HOUR + 3 * MINUTE),
    });
    stub.clearRequests();

    const result = await attemptAt(late, plus(T0, 5 * MINUTE));

    expect(result).toMatchObject({
      outcome: "gave_up",
      reason: "deadline",
      code: "TICKETING_FAILED",
      attempts: 1,
    });
    // The stub would issue (scenario success), but no attempt starts after the deadline − 2 h.
    expect(callsOf(late, "getFlightOrder")).toHaveLength(1);
    expect(callsOf(late, "issueFlightOrder")).toEqual([]);
    expect(await ticketingOf(late)).toMatchObject({
      ticketingStatus: "failed",
      attempts: 1,
      nextAttemptAt: null,
    });
    expect((await notificationsOf(late)).map((row) => row.templateKey)).toEqual([
      "booking.ticketing_delayed",
      "staff.ticketing_failed",
    ]);
  });

  it("gives up without issuing after a failure for payment reasons", async () => {
    const declined = await insertBooking({
      key: "alpha",
      failedAt: T0,
      deadlineAt: null,
      errorCode: "PAYMENT_DECLINED",
    });
    stub.clearRequests();

    const result = await attemptAt(declined, plus(T0, 7 * MINUTE));

    expect(result).toMatchObject({
      outcome: "gave_up",
      reason: "payment",
      code: "PAYMENT_DECLINED",
      attempts: 1,
    });
    // The resync only: an order whose form of payment was refused is never issued again automatically.
    expect(callsOf(declined, "getFlightOrder")).toHaveLength(1);
    expect(callsOf(declined, "issueFlightOrder")).toEqual([]);
    expect((await notificationsOf(declined)).map((row) => row.templateKey)).toEqual([
      "booking.ticketing_delayed",
      "staff.ticketing_failed",
    ]);
  });

  it("finds a booking only in the tenant of the job (two tenants)", async () => {
    const beta = await insertBooking({ key: "beta", failedAt: T0, deadlineAt: null });
    stub.clearRequests();
    const due = plus(T0, 8 * MINUTE);
    clock.set(due);

    // A job that names alpha with beta's booking: alpha's schema has no such booking.
    const crossed = ticketingJob(tenants.alpha.id, beta.id, minuteBucket(due));
    await ticketing.add(crossed.name, crossed.data, crossed.opts);

    expect((await finished(ticketing, crossed.opts.jobId)).returnvalue).toMatchObject({
      tenantId: tenants.alpha.id,
      outcome: "skipped",
      reason: "not_claimable",
    });
    expect(await ticketingOf(beta)).toMatchObject({ ticketingStatus: "failed", attempts: 1 });
    expect(stub.requests()).toEqual([]);
    // Alpha's scan does not see beta's due booking; beta's does.
    await expectNotDue({ ...beta, key: "alpha" }, plus(due, MINUTE));
    expect(await scan("beta", plus(due, 2 * MINUTE))).toBeGreaterThanOrEqual(1);
    await finished(ticketing, ticketingJobId(beta.id, minuteBucket(plus(due, 2 * MINUTE))));
  });

  it("refuses a job that is not ticketing.issue {tenantId, bookingId} at once", async () => {
    const job = await ticketing.add(TICKETING_ISSUE_JOB, { tenantId: tenants.alpha.id, bookingId: "bkg_x" });

    await vi.waitFor(async () => expect(await job.getState()).toBe("failed"), JOB_WAIT);
    const failed = await ticketing.getJob(job.id ?? "");
    expect(failed?.attemptsMade).toBe(1);
    expect(failed?.failedReason).toBe("the job is not ticketing.issue {tenantId, bookingId}");
  });
});
