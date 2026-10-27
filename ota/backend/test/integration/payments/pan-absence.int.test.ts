// The PAN-absence proof (OBE-052, OF-05 AC1; ota/docs/flows/checkout-airline-card.md §7, OADR-0004 point 2, ADR-0011
// §C "Never stored or logged"): the traveller's airline card exists in memory for one request only, so none of its
// values may be found anywhere afterwards. The file drives checkout.completeWithAirlineCard through every path of the
// task against PostgreSQL 16, Redis 7, the Amadeus stub and the fake Stripe API, with the API (createTestApp) and the
// worker (WorkerModule.forRoot) running in process on the same database and Redis, both logging at `debug`:
//
//   success              a Visa test card the airline charges (stub success); also scanned while the card is being sent
//   decline              the stub's declined card `4000000000000002`, three times: 402, 402, then 403
//                        PAYMENT_ATTEMPTS_EXCEEDED with the staff alert
//   timeout              the answer of Flight Create Orders lost, the order found by the reconciliation (stub `timeout`)
//   timeout-lost         the answer lost and no order made, the booking in the staff's review (stub `timeout-lost`)
//   validation-error     a bad Luhn digit, a schema error and a past expiry with the real number, a body that is not JSON
//                        and a body over the route's 10 KB limit, each carrying the card
//   idempotent-replay    the same Idempotency-Key and body again: the success's 201 and the lost answer's 504
//   cancel               the successful booking cancelled by its guest on the storefront (void: ticketed today)
//
// After each path the worker's queues are left to settle and test/support/pan-scanner.ts looks through every column of
// every tenant table (ciphertext columns decrypted), every Redis key and value, every BullMQ job and every log line the
// API and the worker wrote, plus anything written to the console or straight to stdout/stderr (log-capture.ts), for the
// card number, its last 12 digits, the security code `123` as a JSON value, and the holder's name and the expiry date
// (FIX-W29-SECURITY) of every card the file sent. None may appear after any path, and the scanner may not miss any place
// (a ciphertext that does not decrypt is a failure too). E-mails and booking documents are rendered from those rows.
//
// The last block proves the scanner can fail: values planted in a log line (the request body logged as text, as a
// careless change would log it), a text, a jsonb and a ciphertext column, a payment's expiry columns, a Redis key and
// value and a job are all found, while the same body logged as an object is censored by @velexis/logger's redaction
// (`*.card`).
//
// Manual check (AC2), done when this file was written (2026-10-27) and to be repeated after a change of the logging
// stack: on a scratch branch, log the request body in the completion's controller as a careless change would, before the
// card is wrapped, as the first line of `AirlineCardCompletionController.complete`
// (src/payments/airline-card/airline-card-completion.controller.ts, with `private readonly logger: PinoLogger` added to
// its constructor):
//
//   this.logger.info(`airline-card completion body ${JSON.stringify(req.body)}`);
//
// `pnpm --filter @velexis/ota-backend exec vitest run --config vitest.int.config.ts pan-absence` then fails at every
// path, naming the API's log line and the values found there (card number, last 12 digits, security code, card holder,
// expiry date); `console.log(req.body)` in its place fails the same way on the console's line. The body logged as an
// object (`this.logger.info({ body: req.body })`) passes: the redaction censors its card. Throw the branch away.
//
// CI: the file is part of the default `pnpm test:int` run (vitest.int.config.ts includes every
// `test/integration/**/*.int.test.ts`). It writes what it scanned, without any card value, to
// `node_modules/.cache/pan-absence/report.json` of this package, and the build-test job of .github/workflows/ci.yml
// fails when that report is missing (the file skipped, renamed or filtered out by a pattern), lacks a path, or found
// anything.
//
// Every scenario runs in its `beforeAll` hook, with a budget of its own, and keeps what it saw; its tests read it. Card
// values are test data only: Visa's documented test PAN, the stub's declined test card and a made-up holder and code.
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getQueueToken } from "@nestjs/bullmq";
import { Module, type INestApplicationContext } from "@nestjs/common";
import { aadFor, encryptValue, type KeyProvider } from "@velexis/crypto";
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
import {
  createTestDatabase,
  expectResponseToMatch,
  FakeClock,
  responseChecker,
  useRedis,
  type TestDatabase,
  type TestRedis,
} from "@velexis/testing";
import { startAmadeusStub, stubScenario, type AmadeusStub } from "@velexis/testing/amadeus";
import type { Job, Queue } from "bullmq";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AmadeusClient } from "../../../src/amadeus/amadeus.client";
import { createApiLogger } from "../../../src/app.module";
import { RECONCILE_SCAN_JOB, type ReconcileJobResult } from "../../../src/bookings/reconcile.processor";
import { reconcileJobId } from "../../../src/bookings/reconcile.service";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { OTA_BACKEND_QUEUES, OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { APP_DIR, loadWorkerConfig } from "../../../src/config";
import { minuteBucket, tenantJob } from "../../../src/jobs/fan-out";
import { AIRLINE_CARD_BODY_LIMIT_BYTES } from "../../../src/main";
import { seedDefaultMarkupRule } from "../../../src/provisioning/seeds/markup-rules.seed";
import { seedStorefrontSettings } from "../../../src/provisioning/seeds/storefront-settings.seed";
import type { TenantTransaction } from "../../../src/tenancy/tenant-tx";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { buildContactInput, buildTravelerInput, dateFromToday } from "../../builders/checkouts";
import { edgeHeaders, edgeWriteHeaders, testKeyProvider, testWorkerVariables } from "../../helpers/api-env";
import { startFakeStripe, stripeEndpointModule, type FakeStripe } from "../../helpers/fake-stripe";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../helpers/openapi";
import { createTestApp, type TestApp } from "../../support/create-test-app";
import { LogCapture } from "../../support/log-capture";
import {
  PanScanner,
  VALUE_LABELS,
  type CardUnderTest,
  type Finding,
  type ScanReport,
} from "../../support/pan-scanner";

const ALPHA_HOST = "alpha.ota.example.com";
const OPS_EMAIL = "ops@alpha-travel.example";
const FLIGHT_DATE = dateFromToday(60);
const LAST_TICKETING_DATE = dateFromToday(30);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const OPERATION = "completeCheckoutWithAirlineCard";

// Test data only: Visa's documented test PAN, the stub's declined test card, a number with a wrong Luhn digit, a
// made-up security code and a holder and an expiry that no traveller, contact or fixture of the stub uses, so a match
// can only come from a card.
const TEST_PAN = "4111111111111111";
const DECLINED_PAN = "4000000000000002";
const BAD_LUHN_PAN = "4111111111111112";
const TEST_CVV = "123";
const HOLDER_NAME = "Ottilie Brandtner";
const EXPIRY_MONTH = 7;
/** Eight years ahead: never expired, within the schema's 2026–2099, and far from every date the booking holds. */
const EXPIRY_YEAR = new Date().getUTCFullYear() + 8;

/**
 * Every card the file sends: each of their values must stay out of everything the backend keeps or writes. The declined
 * card's last 12 digits, eleven zeros and a 2, are also the end of the stub's second e-ticket number (`000-0000000002`,
 * `0000000000002` in a document's file name): they count as a number of their own, its whole number anywhere.
 */
const CARDS: readonly CardUnderTest[] = [TEST_PAN, DECLINED_PAN, BAD_LUHN_PAN].map((number) => ({
  number,
  securityCode: TEST_CVV,
  holderName: HOLDER_NAME,
  expiryMonth: EXPIRY_MONTH,
  expiryYear: EXPIRY_YEAR,
  last12: number === DECLINED_PAN ? "standalone" : "anywhere",
}));

/** The paths of OBE-052 step 2, in the order the file drives them. The report and CI's check name them. */
const PATHS = [
  "success",
  "decline",
  "timeout",
  "timeout-lost",
  "validation-error",
  "idempotent-replay",
  "cancel",
] as const;
type PathName = (typeof PATHS)[number];

/** What the file scanned, without any card value: CI checks it (the file header). */
const REPORT_FILE = join(APP_DIR, "node_modules", ".cache", "pan-absence", "report.json");

/**
 * The budget of a scenario hook: its checkouts (a search, a priced offer and six more API calls each), its
 * completions, the worker's jobs, up to two reconciliation attempts and a full scan after each step (about a second
 * each). Seconds locally, much longer on a busy 4-CPU runner.
 */
const SCENARIO_TIMEOUT_MS = 90_000;
/** How long a hook waits at most for the worker to finish what the API queued (milliseconds to a few seconds). */
const JOB_WAIT = { timeout: 30_000, interval: 50 } as const;

let db: TestDatabase;
let redis: TestRedis;
let api: TestApp;
let worker: INestApplicationContext;
let stub: AmadeusStub;
let stripe: FakeStripe;
let keys: KeyProvider;
let migratorPool: ReturnType<typeof createPool>;
let migrator: Kysely<PlatformDatabase>;
let otaPool: ReturnType<typeof createPool>;
let tenantDb: TenantDb;
let alphaId: string;
let queues: Queue[];
let bookingsQueue: Queue;
let maintenance: Queue;
const logs = new LogCapture();
const scanner = new PanScanner(CARDS);
/** The worker's time during a reconciliation (as in airline-card-completion.int.test.ts). */
const clock = new FakeClock();

/** Every scan of the file, in order: after each path, and during the success while the card is sent. */
const scans: Array<{ readonly path: PathName; readonly moment: string; readonly report: ScanReport }> = [];

const quietPoolLogger = { error: (): void => undefined };

interface MoneyBody {
  readonly amount: string;
  readonly currency: string;
}

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly details?: Record<string, unknown>;
    readonly fieldErrors?: Array<{ path: string; code: string }>;
  };
}

interface PaymentBody {
  readonly id: string;
  readonly amount: MoneyBody;
}

interface CompletionBody {
  readonly booking: { readonly id: string; readonly status: string };
}

interface CheckoutBody {
  readonly id: string;
}

/** A supertest answer, as a scenario keeps it. */
interface Answer {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

/** What a scenario completes: a guest checkout of alpha with its airline-card payment and the VISA card hint. */
interface AirlineCheckout {
  readonly checkout: CheckoutBody;
  readonly payment: PaymentBody;
}

/** The card of a request body: Visa's test PAN, the file's holder, expiry and security code, unless told otherwise. */
const cardOf = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  brand: "VISA",
  holderName: HOLDER_NAME,
  number: TEST_PAN,
  expiryMonth: EXPIRY_MONTH,
  expiryYear: EXPIRY_YEAR,
  securityCode: TEST_CVV,
  ...overrides,
});

const idempotencyKey = (): string => randomBytes(16).toString("hex");
const edgeWrite = (): Record<string, string> => ({ ...edgeWriteHeaders(ALPHA_HOST) });
const alphaTx = <T>(run: (trx: TenantTransaction) => Promise<T>): Promise<T> =>
  tenantTx(tenantDb, "tenant_alpha", run);
const errorOf = (answer: Answer): ErrorBody["error"] => (answer.body as ErrorBody).error;
const completionOf = (answer: Answer): CompletionBody => answer.body as CompletionBody;
const answerOf = (res: request.Response): Answer => ({
  status: res.status,
  body: res.body as unknown,
  text: res.text,
  headers: res.headers as Record<string, string | string[] | undefined>,
});

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

async function insertTenant(accountId: string): Promise<string> {
  const id = newId("ten");
  const office = `NCE1A${randomBytes(2).toString("hex").toUpperCase()}`;
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key: "alpha", name: "Alpha Travel", status: "active", plan_code: "early_access" })
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
      statement_descriptor_suffix: "ALPHA TRAVEL",
    })
    .execute();
  return id;
}

let searchCount = 0;

/** A priced offer of alpha for the stub's offer 2 of a new search, its flight moved 60 days ahead. */
async function newPricedOffer(): Promise<string> {
  searchCount += 1;
  const searched = await request(api.server)
    .post("/v1/flight-searches")
    .set({ ...edgeWrite(), "Idempotency-Key": idempotencyKey() })
    .send({
      mode: "simple",
      originLocationCode: "MAD",
      destinationLocationCode: "ORY",
      departureDate: dateFromToday(60 + searchCount),
      adults: 1,
    });
  expect(searched.status).toBe(201);
  const searchId = (searched.body as { id: string }).id;
  const offerId = await alphaTx(async (trx) => {
    await trx
      .updateTable("flight_offers")
      .set({
        payload: sql`jsonb_set(jsonb_set(jsonb_set(payload,
          '{itineraries,0,segments,0,departure,at}', to_jsonb(${`${FLIGHT_DATE}T07:15:00`}::text)),
          '{itineraries,0,segments,0,arrival,at}', to_jsonb(${`${FLIGHT_DATE}T09:20:00`}::text)),
          '{lastTicketingDate}', to_jsonb(${LAST_TICKETING_DATE}::text))`,
        last_ticketing_date: LAST_TICKETING_DATE,
      })
      .where("search_id", "=", searchId)
      .execute();
    const row = await trx
      .selectFrom("flight_offers")
      .select("id")
      .where("search_id", "=", searchId)
      .where("amadeus_offer_id", "=", "2")
      .executeTakeFirstOrThrow();
    return row.id;
  });
  const priced = await request(api.server)
    .post("/v1/priced-offers")
    .set({ ...edgeWrite(), "Idempotency-Key": idempotencyKey() })
    .send({ offerIds: [offerId] });
  expect(priced.status).toBe(201);
  return (priced.body as { id: string }).id;
}

/** A guest checkout of alpha with its traveller, contact, airline-card payment and the VISA card hint. */
async function airlineCheckout(): Promise<AirlineCheckout> {
  const pricedOfferId = await newPricedOffer();
  const created = await request(api.server)
    .post("/v1/checkouts")
    .set({ ...edgeWrite(), "Idempotency-Key": idempotencyKey() })
    .send({ pricedOfferId });
  expect(created.status).toBe(201);
  const checkout = created.body as CheckoutBody;
  const travelers = await request(api.server)
    .put(`/v1/checkouts/${checkout.id}/travelers`)
    .set(edgeWrite())
    .send({ travelers: [buildTravelerInput()] });
  expect(travelers.status).toBe(200);
  const contacts = await request(api.server)
    .put(`/v1/checkouts/${checkout.id}/contacts`)
    .set(edgeWrite())
    .send({ contacts: [buildContactInput()] });
  expect(contacts.status).toBe(200);
  const paid = await request(api.server)
    .post(`/v1/checkouts/${checkout.id}/payments`)
    .set({ ...edgeWrite(), "Idempotency-Key": idempotencyKey() })
    .send({ method: "airline_card", termsAccepted: true });
  expect(paid.status).toBe(201);
  const hinted = await request(api.server)
    .patch(`/v1/payments/${(paid.body as PaymentBody).id}`)
    .set(edgeWrite())
    .send({ card: { brand: "VISA", bin: TEST_PAN.slice(0, 6) } });
  expect(hinted.status).toBe(200);
  return { checkout, payment: hinted.body as PaymentBody };
}

/** The request of checkout.completeWithAirlineCard, before its body. */
const completion = (checkoutId: string, headers: Record<string, string>, key: string) =>
  request(api.server)
    .post(`/v1/checkouts/${checkoutId}/airline-card-completion`)
    .set({ ...headers, "Idempotency-Key": key });

/** checkout.completeWithAirlineCard on the edge, its answer checked against the OTA document. */
async function complete(
  { checkout, payment }: AirlineCheckout,
  options: {
    readonly card?: Record<string, unknown>;
    readonly key?: string;
    readonly headers?: Record<string, string>;
    readonly extra?: Record<string, unknown>;
  } = {},
): Promise<Answer> {
  const res = await completion(
    checkout.id,
    options.headers ?? edgeWrite(),
    options.key ?? idempotencyKey(),
  ).send({
    paymentId: payment.id,
    expectedTotal: payment.amount,
    card: options.card ?? cardOf(),
    ...options.extra,
  });
  expectResponseToMatch(OPERATION, res);
  return answerOf(res);
}

/** Empties the API's throttler counters (5 completions per minute and IP, 60 per hour and tenant). */
async function resetRateLimits(): Promise<void> {
  const found = await redis.client.keys("rl:*");
  if (found.length > 0) {
    await redis.client.del(...found);
  }
}

/** Points the worker's Clock at the file's FakeClock (restoreMocks undoes it after the hook). */
function useWorkerClock(): void {
  vi.spyOn(worker.get(Clock, { strict: false }), "now").mockImplementation(() => clock.now());
}

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

/** The first attempt: the worker's clock at `at`, the API's delayed `booking.reconcile` promoted, its result. */
async function firstAttempt(bookingId: string, at: Date): Promise<ReconcileJobResult> {
  clock.set(at);
  const job = await bookingsQueue.getJob(reconcileJobId(bookingId, "first"));
  if (job === undefined) {
    throw new Error("the completion queued no booking.reconcile");
  }
  await job.promote();
  return (await finished(bookingsQueue, reconcileJobId(bookingId, "first")))
    .returnvalue as ReconcileJobResult;
}

/** One `bookings.reconcile_scan` of alpha at `at`, and the booking's `booking.reconcile` it added. */
async function scanAttempt(bookingId: string, at: Date): Promise<ReconcileJobResult> {
  clock.set(at);
  const scan = tenantJob(RECONCILE_SCAN_JOB, alphaId, minuteBucket(at));
  await (await maintenance.getJob(scan.opts.jobId))?.remove();
  await maintenance.add(scan.name, scan.data, scan.opts);
  await finished(maintenance, scan.opts.jobId);
  return (await finished(bookingsQueue, reconcileJobId(bookingId, minuteBucket(at))))
    .returnvalue as ReconcileJobResult;
}

/** `create_order_started_at` of the booking plus `ms`. */
async function afterOrderStarted(bookingId: string, ms: number): Promise<Date> {
  const row = await alphaTx((trx) =>
    trx
      .selectFrom("bookings")
      .select("create_order_started_at")
      .where("id", "=", bookingId)
      .executeTakeFirstOrThrow(),
  );
  return new Date((row.create_order_started_at?.getTime() ?? 0) + ms);
}

/** Waits until no queue has a job waiting or running: what the API queued has been processed (delayed jobs wait). */
async function settled(): Promise<void> {
  await vi.waitFor(async () => {
    for (const queue of queues) {
      const counts = await queue.getJobCounts("active", "wait", "prioritized", "waiting-children");
      expect(
        Object.values(counts).every((count) => count === 0),
        `${queue.name}: ${JSON.stringify(counts)}`,
      ).toBe(true);
    }
  }, JOB_WAIT);
}

/** One full scan (pan-scanner.ts), kept for the path's tests and the report. */
async function scanNow(path: PathName, moment: string): Promise<ScanReport> {
  const report = await scanner.scan({
    platformDb: migrator,
    tenantDb,
    keys,
    redis: redis.client,
    queues,
    logs,
  });
  scans.push({ path, moment, report });
  return report;
}

/** The scan after `path`, once the worker has processed what it queued. */
async function scanAfter(path: PathName): Promise<ScanReport> {
  await settled();
  return await scanNow(path, "after");
}

/**
 * Runs `run` while the API's next Flight Create Orders is held just before it is sent, with a full scan taken at that
 * moment: what the request wrote before the card left (its idempotency row, the claim, the limits, its log lines).
 */
async function scanningWhileSent<T>(path: PathName, run: () => Promise<T>): Promise<T> {
  const client = api.app.get(AmadeusClient, { strict: false });
  const real = client.createFlightOrders.bind(client);
  const spy = vi
    .spyOn(client, "createFlightOrders")
    .mockImplementationOnce(async (context, input, options) => {
      await scanNow(path, "while the card is sent");
      return await real(context, input, options);
    });
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}

/** The findings and the blind spots of a scan, for one assertion that prints both. */
const outcomeOf = (report: ScanReport) => ({ findings: report.findings, errors: report.errors });

/** The scans of `path`. */
const scansOf = (path: PathName) => scans.filter((scan) => scan.path === path);

/** Asserts that every scan of `path` ran, read every kind of place, and found nothing. */
function expectNothingFoundAfter(path: PathName): void {
  const ofPath = scansOf(path);
  expect(ofPath.map((scan) => scan.moment)).toContain("after");
  for (const { moment, report } of ofPath) {
    expect(outcomeOf(report), `${path}, ${moment}`).toEqual({ findings: [], errors: [] });
    const { counts } = report;
    expect(
      [
        counts.tenantSchemas,
        counts.tables,
        counts.rows,
        counts.redisKeys,
        counts.queues,
        counts.logLines,
      ].every((count) => count > 0),
      `${path}, ${moment}: every kind of place was read (${JSON.stringify(counts)})`,
    ).toBe(true);
  }
}

/** Writes the report CI checks: the scans, their counts and their (masked) findings, never a card value. */
function writeReport(): void {
  const after = new Map(
    scans.filter((scan) => scan.moment === "after").map((scan) => [scan.path, scan.report]),
  );
  const complete =
    PATHS.every((path) => after.has(path)) &&
    scans.every(({ report }) => report.findings.length === 0 && report.errors.length === 0);
  const report = {
    task: "OBE-052",
    test: "ota/backend/test/integration/payments/pan-absence.int.test.ts",
    values: Object.values(VALUE_LABELS),
    cards: CARDS.length,
    paths: PATHS,
    scans: scans.map(({ path, moment, report: scan }) => ({
      path,
      moment,
      findings: scan.findings,
      errors: scan.errors,
      counts: scan.counts,
    })),
    complete,
  };
  mkdirSync(join(REPORT_FILE, ".."), { recursive: true });
  writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
}

// Cloning the template, starting the stub and the fake Stripe API and building both module graphs take several
// seconds alone and much longer on a busy 4-CPU runner: all of it happens once here, with its own timeout.
beforeAll(async () => {
  // A report of an earlier run never stands for this one.
  rmSync(REPORT_FILE, { force: true });
  logs.start();
  preloadOpenApiDocument();
  // The response validators of the operation compile on their first check: here, with every status checked below.
  const checker = responseChecker("ota");
  for (const status of [201, 400, 402, 403, 504]) {
    checker.check(OPERATION, { status, body: {} });
  }
  [db, redis, keys, stripe] = await Promise.all([
    createTestDatabase(),
    useRedis(),
    testKeyProvider(),
    startFakeStripe(),
  ]);
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: quietPoolLogger,
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-writer",
    logger: quietPoolLogger,
    max: 3,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  const clientId = `velexis-test-${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(24).toString("base64url");
  stub = await startAmadeusStub({
    credentials: { clientId, clientSecret: secret },
    // The `timeout` scenarios hold an answer for 100 ms, then give up with their 504, as after 30 s.
    timers: {
      setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 100)),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
  });
  alphaId = await insertTenant(await insertAccount(clientId, secret));
  await alphaTx(async (trx) => {
    await seedStorefrontSettings(trx, { name: "Alpha Travel", defaultCurrency: "EUR", defaultLocale: "en" });
    await seedDefaultMarkupRule(trx);
    // The OTA turned the airline card on for its test environment (console settings, OBE-070), and lets its customers
    // cancel on the storefront (the cancel path).
    await trx
      .updateTable("storefront_settings")
      .set({
        airline_card_enabled_test: true,
        ops_alert_email: OPS_EMAIL,
        features: sql`jsonb_set(features, '{selfServiceCancellation}', 'true'::jsonb)`,
      })
      .execute();
  });
  const stripeKeys = {
    STRIPE_SECRET_KEY_TEST: `sk_test_${randomBytes(20).toString("hex")}`,
    STRIPE_PUBLISHABLE_KEY_TEST: `pk_test_${randomBytes(20).toString("hex")}`,
  };
  api = await createTestApp({
    database: db,
    redis,
    imports: [stripeEndpointModule(stripe.endpoint)],
    // The most verbose level the backend has: a debug line is a log line too.
    env: { AMADEUS_BASE_URL_TEST: stub.url, AIRLINE_CARD_ENABLED: "true", LOG_LEVEL: "debug", ...stripeKeys },
  });
  logs.attach("api", api.sink);
  const config = loadWorkerConfig({
    ...testWorkerVariables(),
    ...stripeKeys,
    APP_ENV: "test",
    LOG_LEVEL: "debug",
    DATABASE_URL: db.urlFor("ota"),
    DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
    REDIS_URL: redis.url,
  });
  @Module({
    imports: [
      stripeEndpointModule(stripe.endpoint),
      WorkerModule.forRoot(config, { logger: createWorkerLogger(config, logs.destination("worker")) }),
    ],
  })
  class WorkerRootModule {}
  useNextApplicationLoggerOutsideRequests();
  worker = await createWorkerApp(WorkerRootModule);
  await worker.init();
  queues = OTA_BACKEND_QUEUES.map((name) => worker.get<Queue>(getQueueToken(name), { strict: false }));
  bookingsQueue = worker.get<Queue>(getQueueToken(OTA_QUEUE.bookings), { strict: false });
  maintenance = worker.get<Queue>(getQueueToken(OTA_QUEUE.maintenance), { strict: false });
  // From here on the file plays the scheduler: no iteration of the real one may fire while it runs.
  for (const scheduler of await maintenance.getJobSchedulers(0, -1)) {
    await maintenance.removeJobScheduler(scheduler.key);
  }
}, OPENAPI_SETUP_TIMEOUT_MS);

afterAll(async () => {
  logs.stop();
  writeReport();
  await worker?.close();
  await api?.close();
  await stub?.stop();
  await stripe?.close();
  await redis?.close();
  await otaPool?.end();
  await migratorPool?.end();
  await db?.drop();
});

/** The successful booking: the idempotent replay and the cancellation use it. */
let success: {
  readonly paid: AirlineCheckout;
  readonly key: string;
  readonly headers: Record<string, string>;
};
let successAnswer: Answer;

describe("success: a card the airline charges", () => {
  beforeAll(async () => {
    await resetRateLimits();
    const paid = await airlineCheckout();
    success = { paid, key: idempotencyKey(), headers: edgeWrite() };
    successAnswer = await scanningWhileSent("success", () =>
      complete(paid, { key: success.key, headers: success.headers }),
    );
    await scanAfter("success");
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-052 AC1] books and tickets the order with the card", () => {
    expect(successAnswer.status).toBe(201);
    expect(completionOf(successAnswer).booking.status).toBe("ticketed");
    expect(scanner.valuesIn(successAnswer.text)).toEqual([]);
    expect(scansOf("success").map((scan) => scan.moment)).toEqual(["while the card is sent", "after"]);
  });

  it("[OBE-052 AC1] finds none of the card's values anywhere, while the card is sent and after [OF-05 AC1]", () => {
    expectNothingFoundAfter("success");
  });
});

describe("decline: cards the airline refuses (stub card 4000000000000002)", () => {
  let answers: Answer[];

  beforeAll(async () => {
    await resetRateLimits();
    const paid = await airlineCheckout();
    answers = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      answers.push(await complete(paid, { card: cardOf({ number: DECLINED_PAN }) }));
    }
    await scanAfter("decline");
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-052 AC1] answers 402 twice, then 403 PAYMENT_ATTEMPTS_EXCEEDED with the staff alert", () => {
    expect(answers.map((answer) => [answer.status, errorOf(answer).code])).toEqual([
      [402, "PAYMENT_DECLINED"],
      [402, "PAYMENT_DECLINED"],
      [403, "PAYMENT_ATTEMPTS_EXCEEDED"],
    ]);
    for (const answer of answers) {
      expect(scanner.valuesIn(answer.text)).toEqual([]);
    }
  });

  it("[OBE-052 AC1] finds none of the card's values anywhere after the declines [OF-05 AC1]", () => {
    expectNothingFoundAfter("decline");
  });
});

describe("timeout: an order whose answer was lost but that exists (stub timeout)", () => {
  let timedOut: Answer;
  let found: ReconcileJobResult;

  beforeAll(async () => {
    useWorkerClock();
    await resetRateLimits();
    const paid = await airlineCheckout();
    timedOut = await complete(paid, { headers: { ...edgeWrite(), ...stubScenario("timeout") } });
    const bookingId = String(errorOf(timedOut).details?.["bookingId"]);
    found = await firstAttempt(bookingId, await afterOrderStarted(bookingId, 30 * SECOND));
    await scanAfter("timeout");
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-052 AC1] answers 504 SUPPLIER_TIMEOUT, then the reconciliation records the order", () => {
    expect([timedOut.status, errorOf(timedOut).code]).toEqual([504, "SUPPLIER_TIMEOUT"]);
    expect(found).toMatchObject({ outcome: "found", status: "ticketed" });
    expect(scanner.valuesIn(timedOut.text)).toEqual([]);
  });

  it("[OBE-052 AC1] finds none of the card's values anywhere after the reconciliation [OF-05 AC1]", () => {
    expectNothingFoundAfter("timeout");
  });
});

/** The lost answer of `timeout-lost`, which the idempotent replay sends again. */
let lost: { readonly paid: AirlineCheckout; readonly key: string; readonly headers: Record<string, string> };

describe("timeout-lost: an order whose answer was lost and that was never created (stub timeout-lost)", () => {
  let timedOut: Answer;
  let decision: ReconcileJobResult;

  beforeAll(async () => {
    useWorkerClock();
    await resetRateLimits();
    const paid = await airlineCheckout();
    lost = { paid, key: idempotencyKey(), headers: edgeWrite() };
    timedOut = await complete(paid, {
      key: lost.key,
      headers: { ...lost.headers, ...stubScenario("timeout-lost") },
    });
    const bookingId = String(errorOf(timedOut).details?.["bookingId"]);
    await firstAttempt(bookingId, await afterOrderStarted(bookingId, 30 * SECOND));
    decision = await scanAttempt(bookingId, await afterOrderStarted(bookingId, 15 * MINUTE));
    await scanAfter("timeout-lost");
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-052 AC1] answers 504, then the reconciliation hands the booking to the staff (manual_review)", () => {
    expect([timedOut.status, errorOf(timedOut).code]).toEqual([504, "SUPPLIER_TIMEOUT"]);
    expect(decision).toMatchObject({ outcome: "manual_review" });
    expect(scanner.valuesIn(timedOut.text)).toEqual([]);
  });

  it("[OBE-052 AC1] finds none of the card's values anywhere after the manual review [OF-05 AC1]", () => {
    expectNothingFoundAfter("timeout-lost");
  });
});

describe("validation-error: requests the server refuses before anything is sent", () => {
  let answers: Array<readonly [string, Answer]>;
  let creates: number;

  beforeAll(async () => {
    await resetRateLimits();
    const paid = await airlineCheckout();
    stub.clearRequests();
    const body = (card: Record<string, unknown>): Record<string, unknown> => ({
      paymentId: paid.payment.id,
      expectedTotal: paid.payment.amount,
      card,
    });
    // A body that is not JSON: the card's object is cut off before its end.
    const broken = JSON.stringify(body(cardOf())).slice(0, -3);
    const raw = async (text: string): Promise<Answer> => {
      const res = await completion(paid.checkout.id, edgeWrite(), idempotencyKey())
        .set("Content-Type", "application/json")
        .send(text);
      expectResponseToMatch(OPERATION, res);
      return answerOf(res);
    };
    answers = [
      ["a bad Luhn digit", await complete(paid, { card: cardOf({ number: BAD_LUHN_PAN }) })],
      ["a schema error", await complete(paid, { card: cardOf({ expiryMonth: 13 }) })],
      ["a past expiry", await complete(paid, { card: cardOf({ expiryMonth: 1, expiryYear: 2026 }) })],
    ];
    await resetRateLimits();
    answers.push(
      ["a body that is not JSON", await raw(broken)],
      [
        "a body over 10 KB",
        await complete(paid, { extra: { padding: "x".repeat(AIRLINE_CARD_BODY_LIMIT_BYTES) } }),
      ],
    );
    creates = stub.requests().filter((entry) => entry.operation === "createFlightOrders").length;
    await scanAfter("validation-error");
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-052 AC1] answers 400 to each, sends nothing, and echoes none of the card's values", () => {
    // Each refusal for its own reason: the card's field and rule, or the body itself (never a value).
    expect(
      answers.map(([what, answer]) => [
        what,
        answer.status,
        errorOf(answer).code,
        (errorOf(answer).fieldErrors ?? []).map((field) => `${field.path} ${field.code}`),
      ]),
    ).toEqual([
      ["a bad Luhn digit", 400, "VALIDATION_FAILED", ["/card/number luhn"]],
      ["a schema error", 400, "VALIDATION_FAILED", ["/card/expiryMonth maximum"]],
      ["a past expiry", 400, "VALIDATION_FAILED", ["/card/expiryYear expired"]],
      ["a body that is not JSON", 400, "INVALID_REQUEST", []],
      ["a body over 10 KB", 400, "INVALID_REQUEST", []],
    ]);
    expect(creates).toBe(0);
    for (const [what, answer] of answers) {
      expect(scanner.valuesIn(answer.text), what).toEqual([]);
    }
  });

  it("[OBE-052 AC1] finds none of the card's values anywhere after the refusals [OF-05 AC1]", () => {
    expectNothingFoundAfter("validation-error");
  });
});

describe("idempotent-replay: the same key and body sent again", () => {
  let replayed: Answer;
  let lostReplay: Answer;
  let creates: number;

  beforeAll(async () => {
    await resetRateLimits();
    stub.clearRequests();
    replayed = await complete(success.paid, { key: success.key, headers: success.headers });
    lostReplay = await complete(lost.paid, { key: lost.key, headers: lost.headers });
    creates = stub.requests().filter((entry) => entry.operation === "createFlightOrders").length;
    await scanAfter("idempotent-replay");
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-052 AC1] answers the stored outcomes without sending the card again", () => {
    expect(replayed.status).toBe(201);
    expect(replayed.body).toEqual(successAnswer.body);
    expect([lostReplay.status, errorOf(lostReplay).details?.["replayed"]]).toEqual([504, true]);
    expect(creates).toBe(0);
    for (const answer of [replayed, lostReplay]) {
      expect(scanner.valuesIn(answer.text)).toEqual([]);
    }
  });

  it("[OBE-052 AC1] finds none of the card's values anywhere after the replays [OF-05 AC1]", () => {
    expectNothingFoundAfter("idempotent-replay");
  });
});

describe("cancel: the successful booking cancelled by its guest", () => {
  let quoted: Answer;
  let cancelled: Answer;
  let paymentEvents: string[];

  beforeAll(async () => {
    await resetRateLimits();
    stripe.reset();
    const bookingId = completionOf(successAnswer).booking.id;
    const cookies = ([] as string[]).concat(successAnswer.headers["set-cookie"] ?? []);
    const guest = cookies.find((cookie) => cookie.startsWith("__Host-vx_bt="))?.split(";", 1)[0];
    if (guest === undefined) {
      throw new Error("the completion set no guest cookie");
    }
    const read = { ...edgeHeaders(ALPHA_HOST), Cookie: guest };
    quoted = answerOf(
      await request(api.server).get(`/v1/bookings/${bookingId}/cancellation-quote`).set(read),
    );
    const current = await request(api.server).get(`/v1/bookings/${bookingId}`).set(read);
    const write = edgeWrite();
    const res = await request(api.server)
      .post(`/v1/bookings/${bookingId}/cancellation`)
      .set({
        ...write,
        Cookie: `${write["Cookie"] ?? ""}; ${guest}`,
        "If-Match": String(current.headers["etag"]),
        "Idempotency-Key": idempotencyKey(),
      })
      .send({
        reasonCode: "change_of_plans",
        expectedRefund: (quoted.body as { estimatedRefund: MoneyBody }).estimatedRefund,
      });
    expectResponseToMatch("cancelBooking", res);
    cancelled = answerOf(res);
    paymentEvents = (
      await alphaTx((trx) =>
        trx
          .selectFrom("payment_events")
          .select("type")
          .where("payment_id", "=", success.paid.payment.id)
          .orderBy("created_at")
          .orderBy("id")
          .execute(),
      )
    ).map((row) => row.type);
    await scanAfter("cancel");
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-052 AC1] voids the order and records the airline's reversal, with no Stripe call", () => {
    expect([quoted.status, (quoted.body as { mode: string }).mode]).toEqual([200, "void"]);
    expect(cancelled.status).toBe(200);
    expect((cancelled.body as { cancellation: { status: string } }).cancellation.status).toBe("cancelled");
    expect(paymentEvents.at(-1)).toBe("airline.void_expected");
    expect(stripe.requests).toEqual([]);
    for (const answer of [quoted, cancelled]) {
      expect(scanner.valuesIn(answer.text)).toEqual([]);
    }
  });

  it("[OBE-052 AC1] finds none of the card's values anywhere after the cancellation [OF-05 AC1]", () => {
    expectNothingFoundAfter("cancel");
  });
});

describe("every path (OBE-052 step 2)", () => {
  it("[OBE-052 AC1] none of the values appears anywhere after any path [OF-05 AC1]", () => {
    expect(scans.filter((scan) => scan.moment === "after").map((scan) => scan.path)).toEqual([...PATHS]);
    expect(scans.flatMap(({ report }) => [...report.findings, ...report.errors])).toEqual([]);
    // Both processes' pino lines reached the capture (a logger writing past it would leave its source empty).
    const counts = logs.counts();
    expect(
      [counts["api"] ?? 0, counts["worker"] ?? 0].every((count) => count > 0),
      JSON.stringify(counts),
    ).toBe(true);
  });
});

describe("the scanner itself: values planted in each place are found", () => {
  const planted = {
    row: newId("idk"),
    payment: newId("pay"),
    redisKey: `pan-absence:planted:${TEST_PAN}`,
  };
  let jobId: string;
  let report: ScanReport;

  beforeAll(async () => {
    // The request body of a completion, logged as an object (the redaction censors its card) and as text, as a careless
    // change would log it: the manual check of the file header, in a logger built like the API's.
    const body = { paymentId: newId("pay"), card: cardOf() };
    const careless = createApiLogger(api.config, logs.destination("planted"));
    careless.info({ body }, "airline-card completion body");
    careless.info(`airline-card completion body ${JSON.stringify(body)}`);
    // A text, a jsonb and a ciphertext column of a tenant table (the other tenant's, which no path writes).
    const { ciphertext, kekId } = await encryptValue(JSON.stringify({ holder: HOLDER_NAME.toUpperCase() }), {
      aad: aadFor("tenant_beta", "idempotency_keys", "response_ciphertext", planted.row),
      keys,
    });
    await tenantTx(tenantDb, "tenant_beta", (trx) =>
      trx
        .insertInto("idempotency_keys")
        .values({
          id: planted.row,
          scope: "test:pan-absence:planted",
          key: idempotencyKey(),
          request_method: "POST",
          request_path: "/v1/planted",
          request_hash: TEST_PAN,
          status: "completed",
          response_body: JSON.stringify({
            card: { securityCode: TEST_CVV, expiryMonth: EXPIRY_MONTH, expiryYear: EXPIRY_YEAR },
          }),
          response_ciphertext: ciphertext,
          encryption_key_id: kekId,
          expires_at: new Date(Date.now() + 24 * 60 * MINUTE),
        })
        .execute(),
    );
    // The card's expiry in the expiry columns of a (Stripe) payment: plain numbers, found by the columns' names.
    await tenantTx(tenantDb, "tenant_beta", (trx) =>
      trx
        .insertInto("payments")
        .values({
          id: planted.payment,
          environment: "test",
          provider: "stripe",
          currency: "EUR",
          amount: "10.00",
          card_exp_month: EXPIRY_MONTH,
          card_exp_year: EXPIRY_YEAR,
        })
        .execute(),
    );
    // A Redis key named after the card, holding its code; a job holding its holder, delayed so nothing runs it.
    await redis.client.set(planted.redisKey, JSON.stringify({ cvc: TEST_CVV }), "EX", 3600);
    const documents = queues.find((queue) => queue.name === OTA_QUEUE.documents);
    const job = await documents?.add(
      "pan-absence.planted",
      { holderName: HOLDER_NAME },
      { delay: 3_600_000 },
    );
    jobId = String(job?.id);
    report = await scanner.scan({ platformDb: migrator, tenantDb, keys, redis: redis.client, queues, logs });
  }, SCENARIO_TIMEOUT_MS);

  it("[OBE-052 AC2] finds the request body logged as text, and nothing of it logged as an object", () => {
    const line = (n: number): string[] =>
      report.findings
        .filter((finding) => finding.where === `log planted line ${n}`)
        .map((finding) => finding.value);
    expect(new Set(line(2))).toEqual(new Set(Object.values(VALUE_LABELS)));
    expect(line(1)).toEqual([]);
  });

  it("[OBE-052 AC2] finds values planted in a text, a jsonb, a ciphertext and an expiry column, a Redis key and value and a job", () => {
    const labels = (where: string): Set<string> =>
      new Set(report.findings.filter((finding) => finding.where === where).map((finding) => finding.value));
    const row = "tenant_beta.idempotency_keys";
    const redisKey = `redis string pan-absence:planted:[${VALUE_LABELS.number}]`;
    const expected: Array<readonly [string, readonly string[]]> = [
      [`${row}.request_hash (id ${planted.row})`, [VALUE_LABELS.number, VALUE_LABELS.last12]],
      [`${row}.response_body (id ${planted.row})`, [VALUE_LABELS.securityCode, VALUE_LABELS.expiry]],
      [`${row}.response_ciphertext (id ${planted.row}), decrypted`, [VALUE_LABELS.holder]],
      [`tenant_beta.payments.card_exp_month (id ${planted.payment})`, [VALUE_LABELS.expiry]],
      [`tenant_beta.payments.card_exp_year (id ${planted.payment})`, [VALUE_LABELS.expiry]],
      [`${redisKey} (its name)`, [VALUE_LABELS.number, VALUE_LABELS.last12]],
      [redisKey, [VALUE_LABELS.securityCode]],
      [`redis hash vx:${OTA_QUEUE.documents}:${jobId}`, [VALUE_LABELS.holder]],
      [`job ${OTA_QUEUE.documents} pan-absence.planted #${jobId}`, [VALUE_LABELS.holder]],
      ["log planted line 2", Object.values(VALUE_LABELS)],
    ];
    for (const [where, values] of expected) {
      expect(labels(where), where).toEqual(new Set(values));
    }
    // Nothing else: every path left the stores clean, and a finding names a place, never the value.
    const places = new Set(expected.map(([where]) => where));
    expect(report.findings.filter((finding: Finding) => !places.has(finding.where))).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(TEST_PAN);
    expect(JSON.stringify(report).toLowerCase()).not.toContain("brandtner");
  });
});
