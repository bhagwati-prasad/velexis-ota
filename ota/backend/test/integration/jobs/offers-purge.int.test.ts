// The scheduler framework and `offers.purge` against PostgreSQL 16 and Redis 7 (OBE-024; OADR-0014 points 1, 2, 4 and
// 5, OADR-0002 point 6, ota/docs/architecture.md §6). The file runs the real worker module graph
// (WorkerModule.forRoot: TenancyModule, QueuesModule, JobsModule) on a clone of the @velexis/testing template
// (`tenant_alpha` and `tenant_beta` provisioned) and a Redis database of its own. It plays the platform: four
// platform.tenants rows are inserted as velexis_migrator, `alpha` active, `beta` suspended, `gamma` provisioning and
// `delta` failed (the last two without a schema: a job that reached them would fail). Tenant rows are written through
// `tenantTx` as velexis_ota_app, as the API writes them.
//
// At start-up the worker registers `offers.purge`; the file reads the job BullMQ added for its first iteration, then
// removes that scheduler, so no iteration fires while it runs, and plays the scheduler instead: it adds `fan-out` jobs
// with the `prevMillis` of an iteration, as BullMQ's scheduler adds them, and waits for the jobs, whose ids it knows. Each test uses an iteration (a minute bucket) of its
// own, a day ahead of today. The purge reads the time from `Clock`, which every test points at its own FakeClock.
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplicationContext } from "@nestjs/common";
import { INVALIDATION_CHANNEL } from "@velexis/api-types/jobs";
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
import type { Job, JobSchedulerJson, Queue, Worker } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Clock } from "../../../src/common/clock";
import { newId } from "../../../src/common/ids";
import { OTA_QUEUE } from "../../../src/common/queues/queue-names";
import { redisKeys } from "../../../src/common/redis/redis.keys";
import { loadWorkerConfig } from "../../../src/config";
import {
  MaintenanceProcessor,
  minuteBucket,
  scheduledAt,
  tenantJob,
  tenantJobId,
  type FanOutResult,
  type TenantJobResult,
} from "../../../src/jobs/fan-out";
import { JOB_BATCH_LIMITS } from "../../../src/jobs/limits";
import { FAN_OUT_JOB } from "../../../src/jobs/schedulers";
import { RECONCILE_SCAN_JOB } from "../../../src/bookings/reconcile.processor";
import { TICKETING_SCAN_JOB } from "../../../src/bookings/ticketing.processor";
import { NOTIFICATIONS_SWEEP_JOB } from "../../../src/notifications/notifications.processor";
import { AUTHORISATION_WATCH_JOB } from "../../../src/payments/authorisation-watch.processor";
import { OFFERS_PURGE_JOB } from "../../../src/shopping/offers-purge.processor";
import { createWorkerApp, createWorkerLogger, WorkerModule } from "../../../src/worker.module";
import { testWorkerVariables } from "../../helpers/api-env";
import { MemorySink } from "../../helpers/log-sink";
import { useNextApplicationLoggerOutsideRequests } from "../../helpers/nest-pino";

/**
 * Cloning the template, opening the pools and starting the worker graph (BullMQ connections, the scheduler
 * registration) takes about 2 s locally; CI runs every package's tests at once on four CPUs.
 */
const SETUP_TIMEOUT_MS = 30_000;
/** How long a test waits at most for the worker to finish a job it added (they take milliseconds). */
const JOB_WAIT = { timeout: 4000, interval: 20 } as const;
const MINUTE_MS = 60_000;

const quietPoolLogger = { error: (): void => undefined };

let db: TestDatabase;
let redis: TestRedis;
let sink: MemorySink;
let app: INestApplicationContext;
let migratorPool: ReturnType<typeof createPool>;
/** velexis_migrator, the owner of the platform tables: inserts the tenants as the platform does. */
let migrator: Kysely<PlatformDatabase>;
let otaPool: ReturnType<typeof createPool>;
/** `tenantTx` as velexis_ota_app: writes the tenant rows as the API does. */
let tenantDb: TenantDb;
let queue: Queue;
let worker: Worker;
/** The schedulers of `ota-maintenance` right after start-up, before the file removed them. */
let registered: JobSchedulerJson[];
/** The `fan-out` jobs those schedulers had added for their next iteration, read before their removal. */
let firstIterations: Job[];
let clock: FakeClock;

const tenants = { alpha: "", beta: "", gamma: "", delta: "" };
/** Tomorrow at this minute: the first iteration of the file; each test adds hours to it. */
const BASE = new Date(Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS + 24 * 60 * MINUTE_MS);
const at = (hours: number, minutes = 0): Date =>
  new Date(BASE.getTime() + (hours * 60 + minutes) * MINUTE_MS);

async function insertTenant(key: string, status: string): Promise<string> {
  const id = newId("ten");
  await migrator
    .insertInto("platform.tenants")
    .values({ id, key, name: `${key} Travel`, status, plan_code: "early_access" })
    .execute();
  return id;
}

beforeAll(async () => {
  db = await createTestDatabase();
  redis = await useRedis();
  migratorPool = createPool(db.urlFor("migrator"), {
    applicationName: "ota-test-migrator",
    logger: quietPoolLogger,
    max: 2,
  });
  migrator = createPlatformDb<PlatformDatabase>(migratorPool);
  otaPool = createPool(db.urlFor("ota"), {
    applicationName: "ota-test-app",
    logger: quietPoolLogger,
    max: 2,
  });
  tenantDb = createTenantDb(otaPool, { appEnv: "test" });
  tenants.alpha = await insertTenant("alpha", "active");
  tenants.beta = await insertTenant("beta", "suspended");
  tenants.gamma = await insertTenant("gamma", "provisioning");
  tenants.delta = await insertTenant("delta", "failed");

  const config = loadWorkerConfig({
    ...testWorkerVariables(),
    APP_ENV: "test",
    DATABASE_URL: db.urlFor("ota"),
    DATABASE_PROVISIONER_URL: db.urlFor("provisioner"),
    REDIS_URL: redis.url,
  });
  sink = new MemorySink();
  useNextApplicationLoggerOutsideRequests();
  app = await createWorkerApp(WorkerModule.forRoot(config, { logger: createWorkerLogger(config, sink) }));
  await app.init();
  queue = app.get<Queue>(getQueueToken(OTA_QUEUE.maintenance));
  worker = app.get(MaintenanceProcessor).worker;
  await worker.waitUntilReady();
  registered = await queue.getJobSchedulers(0, -1);
  firstIterations = (await queue.getJobs(["delayed", "waiting"])).filter(
    (queued) => queued.name === FAN_OUT_JOB,
  );
  // From here on the file plays the scheduler: no iteration of the real one may fire during a test.
  for (const scheduler of registered) {
    await queue.removeJobScheduler(scheduler.key);
  }
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await redis?.close();
  await migratorPool?.end();
  await otaPool?.end();
  await db?.drop();
});

beforeEach(() => {
  clock = new FakeClock(BASE);
  // restoreMocks undoes this after every test.
  vi.spyOn(app.get(Clock), "now").mockImplementation(() => clock.now());
});

// ---- The scheduler's side ---------------------------------------------------------------------------------------

/** The job with this id once the worker has finished it (completed or failed). */
async function finished(id: string): Promise<Job> {
  let found: Job | undefined;
  await vi.waitFor(async () => {
    found = await queue.getJob(id);
    // A failed attempt waits 30 s for its retry (ADR-0009): name its reason when the wait runs out.
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

/** The ids of the per-tenant purge jobs of one fan-out (`offers.purge:<tenantId>:<bucket>`). */
function purgeJobId(tenantId: string, due: Date, continuation = 0): string {
  return tenantJobId(OFFERS_PURGE_JOB, tenantId, minuteBucket(due), continuation);
}

/** Runs one scheduler iteration due at `due`: its `fan-out` job, then the per-tenant jobs of the targets. */
async function iteration(
  due: Date,
  targets: readonly string[] = [tenants.alpha, tenants.beta],
): Promise<void> {
  const fanOut = await queue.add(FAN_OUT_JOB, { task: OFFERS_PURGE_JOB }, { prevMillis: due.getTime() });
  await finished(fanOut.id ?? "");
  for (const tenantId of targets) {
    await finished(purgeJobId(tenantId, due));
  }
}

/** Every job of the queue named `offers.purge`, whatever its state. */
async function purgeJobs(): Promise<Job[]> {
  const jobs = await queue.getJobs(["waiting", "active", "delayed", "completed", "failed", "prioritized"]);
  return jobs.filter((queued) => queued.name === OFFERS_PURGE_JOB);
}

// ---- The tenant's rows ------------------------------------------------------------------------------------------

type TenantSchemaName = "tenant_alpha" | "tenant_beta";

interface Shopping {
  readonly searchId: string;
  readonly offerId: string;
  readonly upsellId: string;
  readonly upsoldOfferId: string;
  readonly pricedOfferId: string;
  readonly childPricedOfferId: string;
}

/**
 * A search as flights.search, upsell and price leave it: one offer, an upsell with one upsold offer, a priced offer of
 * the offer and a child priced offer of it (checkout.setAncillaries). The search and its offers expire at `expires`,
 * the priced offers at `pricedExpires`.
 */
async function insertShopping(
  schema: TenantSchemaName,
  expires: Date,
  pricedExpires: Date,
): Promise<Shopping> {
  const ids: Shopping = {
    searchId: newId("srch"),
    offerId: newId("off"),
    upsellId: newId("ups"),
    upsoldOfferId: newId("off"),
    pricedOfferId: newId("prc"),
    childPricedOfferId: newId("prc"),
  };
  const departure = new Date(expires.getTime() + 30 * 24 * 60 * MINUTE_MS).toISOString().slice(0, 19);
  const offer = (id: string, amadeusOfferId: string) => ({
    id,
    environment: "test",
    search_id: ids.searchId,
    amadeus_offer_id: amadeusOfferId,
    payload: JSON.stringify({ type: "flight-offer", id: amadeusOfferId }),
    currency: "EUR",
    net_total: "100.00",
    markup_amount: "10.00",
    selling_total: "110.00",
    first_departure_local: departure,
    expires_at: expires,
  });
  const priced = (id: string, parent: string | null) => ({
    id,
    environment: "test",
    offer_id: ids.offerId,
    parent_priced_offer_id: parent,
    offer_ids: [ids.offerId],
    amadeus_request: JSON.stringify({ data: { type: "flight-offers-pricing" } }),
    response: JSON.stringify({ data: { type: "flight-offers-pricing" } }),
    currency: "EUR",
    net_total: "100.00",
    markup_amount: "10.00",
    fee_amount: "5.00",
    selling_total: "115.00",
    expires_at: pricedExpires,
  });
  await tenantTx(tenantDb, schema, async (trx) => {
    await trx
      .insertInto("flight_searches")
      .values({
        id: ids.searchId,
        environment: "test",
        criteria: JSON.stringify({
          mode: "simple",
          originLocationCode: "MAD",
          destinationLocationCode: "ORY",
        }),
        amadeus_request: JSON.stringify({ originLocationCode: "MAD", destinationLocationCode: "ORY" }),
        status: "completed",
        result_count: 1,
        expires_at: expires,
      })
      .execute();
    await trx.insertInto("flight_offers").values(offer(ids.offerId, "1")).execute();
    await trx
      .insertInto("offer_upsells")
      .values({
        id: ids.upsellId,
        base_offer_id: ids.offerId,
        amadeus_request: JSON.stringify({ data: { type: "flight-offers-upselling" } }),
        result_count: 1,
        expires_at: expires,
      })
      .execute();
    await trx
      .insertInto("flight_offers")
      .values({ ...offer(ids.upsoldOfferId, "1"), origin: "upsell", upsell_id: ids.upsellId })
      .execute();
    await trx.insertInto("priced_offers").values(priced(ids.pricedOfferId, null)).execute();
    await trx.insertInto("priced_offers").values(priced(ids.childPricedOfferId, ids.pricedOfferId)).execute();
  });
  return ids;
}

/** A guest checkout opened with `basePricedOfferId` and buying `pricedOfferId`, as checkout.create writes it. */
async function insertCheckout(
  schema: TenantSchemaName,
  basePricedOfferId: string,
  pricedOfferId: string,
): Promise<string> {
  const id = newId("chk");
  await tenantTx(tenantDb, schema, (trx) =>
    trx
      .insertInto("checkouts")
      .values({
        id,
        environment: "test",
        is_guest: true,
        base_priced_offer_id: basePricedOfferId,
        priced_offer_id: pricedOfferId,
        currency: "EUR",
        offer_amount: "115.00",
        total_amount: "115.00",
        expires_at: new Date(clock.now().getTime() + 30 * MINUTE_MS),
      })
      .execute(),
  );
  return id;
}

/** Which of the rows of `shopping` are still there, by table. */
async function remaining(schema: TenantSchemaName, shopping: Shopping): Promise<Record<string, number>> {
  return tenantTx(tenantDb, schema, async (trx) => {
    const count = async (
      table: "flight_searches" | "flight_offers" | "offer_upsells" | "priced_offers",
      ids: string[],
    ) => (await trx.selectFrom(table).select("id").where("id", "in", ids).execute()).length;
    return {
      searches: await count("flight_searches", [shopping.searchId]),
      offers: await count("flight_offers", [shopping.offerId, shopping.upsoldOfferId]),
      upsells: await count("offer_upsells", [shopping.upsellId]),
      pricedOffers: await count("priced_offers", [shopping.pricedOfferId, shopping.childPricedOfferId]),
    };
  });
}

const ALL = { searches: 1, offers: 2, upsells: 1, pricedOffers: 2 };
const NONE = { searches: 0, offers: 0, upsells: 0, pricedOffers: 0 };

/**
 * The scheduler of offers.purge among those registered at start-up (the outbox sweep of OBE-030, the authorisation
 * watch of OBE-040, the ticketing scan of OBE-044 and the reconciliation scan of OBE-043 are the others).
 */
const purgeScheduler = (): JobSchedulerJson | undefined =>
  registered.find((scheduler) => scheduler.key === OFFERS_PURGE_JOB);

describe("the schedulers", () => {
  it("register offers.purge on ota-maintenance at start-up: every 15 minutes, in UTC, as a fan-out job", () => {
    expect(registered.map((scheduler) => scheduler.key).sort()).toEqual([
      RECONCILE_SCAN_JOB,
      NOTIFICATIONS_SWEEP_JOB,
      OFFERS_PURGE_JOB,
      AUTHORISATION_WATCH_JOB,
      TICKETING_SCAN_JOB,
    ]);
    expect(purgeScheduler()).toEqual(
      expect.objectContaining({
        key: OFFERS_PURGE_JOB,
        pattern: "*/15 * * * *",
        tz: "UTC",
        template: expect.objectContaining({ data: { task: OFFERS_PURGE_JOB } }),
      }),
    );
    expect(purgeScheduler()?.name).toBe(FAN_OUT_JOB);
    expect(sink.records()).toContainEqual(
      expect.objectContaining({
        msg: "scheduler.registered",
        registered: [
          OFFERS_PURGE_JOB,
          NOTIFICATIONS_SWEEP_JOB,
          AUTHORISATION_WATCH_JOB,
          TICKETING_SCAN_JOB,
          RECONCILE_SCAN_JOB,
        ],
        removed: [],
      }),
    );
  });

  it("add each iteration's fan-out job with the quarter hour it is due as prevMillis, the bucket of its jobs", () => {
    const next = purgeScheduler()?.next;
    expect(next).toBeTypeOf("number");
    const due = next ?? 0;
    expect(due % (15 * MINUTE_MS)).toBe(0);
    const purgeIterations = firstIterations.filter(
      (queued) => (queued.data as { task?: unknown }).task === OFFERS_PURGE_JOB,
    );
    expect(purgeIterations).toHaveLength(1);
    const [first] = purgeIterations;
    expect(first?.id).toBe(`repeat:${OFFERS_PURGE_JOB}:${due}`);
    expect(first?.data).toEqual({ task: OFFERS_PURGE_JOB });
    // The bucket of the iteration's per-tenant jobs is its due minute, whenever a worker takes the job.
    expect(first === undefined ? undefined : scheduledAt(first, clock)).toEqual(new Date(due));
  });
});

describe("the fan-out", () => {
  it("[OBE-024 AC1] enqueues one job per tenant for two overlapping scheduler runs (deterministic ids)", async () => {
    const due = at(1);
    const before = (await purgeJobs()).length;

    // Two runs of one iteration at once (a duplicate, a retry): the worker takes both (concurrency 2).
    await worker.pause();
    const runs = await queue.addBulk([
      { name: FAN_OUT_JOB, data: { task: OFFERS_PURGE_JOB }, opts: { prevMillis: due.getTime() } },
      { name: FAN_OUT_JOB, data: { task: OFFERS_PURGE_JOB }, opts: { prevMillis: due.getTime() } },
    ]);
    worker.resume();
    const results = await Promise.all(runs.map(async (run) => (await finished(run.id ?? "")).returnvalue));

    const bucket = minuteBucket(due);
    expect(results).toEqual<FanOutResult[]>([
      { task: OFFERS_PURGE_JOB, bucket, tenants: 2 },
      { task: OFFERS_PURGE_JOB, bucket, tenants: 2 },
    ]);
    await finished(purgeJobId(tenants.alpha, due));
    await finished(purgeJobId(tenants.beta, due));
    const jobs = await purgeJobs();
    expect(jobs).toHaveLength(before + 2);
    expect(
      jobs
        .filter((queued) => (queued.data as { bucket: number }).bucket === bucket)
        .map((queued) => queued.id)
        .sort(),
    ).toEqual([purgeJobId(tenants.alpha, due), purgeJobId(tenants.beta, due)].sort());
  });

  it("[OBE-024 AC3] skips provisioning and failed tenants: no job from the fan-out, nothing done by a stray job", async () => {
    const due = at(2);

    await iteration(due);

    const ids = (await purgeJobs()).map((queued) => queued.id ?? "");
    for (const skipped of [tenants.gamma, tenants.delta]) {
      expect(ids.filter((id) => id.includes(skipped))).toEqual([]);
    }
    // A job for them anyway (added before their status changed, by hand): it completes without touching a schema.
    for (const [tenantId, reason] of [
      [tenants.gamma, "tenant_provisioning"],
      [tenants.delta, "tenant_failed"],
    ] as const) {
      const stray = tenantJob(OFFERS_PURGE_JOB, tenantId, minuteBucket(due));
      await queue.add(stray.name, stray.data, stray.opts);
      expect((await finished(stray.opts.jobId)).returnvalue).toEqual<TenantJobResult>({
        task: OFFERS_PURGE_JOB,
        tenantId,
        outcome: "skipped",
        reason,
      });
    }
  });

  it("[OBE-024 AC3] re-reads the tenant through the cache: a tenant that failed after the fan-out is skipped", async () => {
    const due = at(3);
    await iteration(due);
    const cached = redisKeys.tenant(tenants.alpha).key;
    expect(await redis.client.exists(cached)).toBe(1);

    // The platform marks alpha failed and publishes the invalidation, which the worker's subscriber applies.
    await migrator
      .updateTable("platform.tenants")
      .set({ status: "failed" })
      .where("id", "=", tenants.alpha)
      .execute();
    await redis.client.publish(
      INVALIDATION_CHANNEL,
      JSON.stringify({ v: 1, type: "tenant", id: tenants.alpha }),
    );
    await vi.waitFor(async () => expect(await redis.client.exists(cached)).toBe(0), JOB_WAIT);
    try {
      const late = tenantJob(OFFERS_PURGE_JOB, tenants.alpha, minuteBucket(due), 1);
      await queue.add(late.name, late.data, late.opts);
      expect((await finished(late.opts.jobId)).returnvalue).toMatchObject({
        outcome: "skipped",
        reason: "tenant_failed",
      });
    } finally {
      await migrator
        .updateTable("platform.tenants")
        .set({ status: "active" })
        .where("id", "=", tenants.alpha)
        .execute();
      await redis.client.del(cached);
    }
  });
});

describe("offers.purge", () => {
  it("[OBE-024 AC2] deletes an expired search and keeps one whose priced offer a checkout references (FakeClock)", async () => {
    const due = at(4);
    clock.set(due);
    const now = clock.now().getTime();
    const minutes = (n: number) => new Date(now + n * MINUTE_MS);
    // Alpha (active): expired 5 minutes ago, its priced offers too.
    const expired = await insertShopping("tenant_alpha", minutes(-5), minutes(-1));
    // Expired, but held by one checkout through one column each: it buys the child priced offer of `bought`
    // (`priced_offer_id`) and was opened with the base priced offer of `opened` (`base_priced_offer_id`). Both columns
    // are NOT NULL, so only a checkout whose two priced offers belong to different searches shows that each column
    // holds a search on its own: a purge that ignored either one would hit the RESTRICT foreign key and fail the job.
    const bought = await insertShopping("tenant_alpha", minutes(-40), minutes(-10));
    const opened = await insertShopping("tenant_alpha", minutes(-40), minutes(-10));
    await insertCheckout("tenant_alpha", opened.pricedOfferId, bought.childPricedOfferId);
    // Expired, but its priced offers were priced later and are still valid for 10 minutes.
    const stillPriced = await insertShopping("tenant_alpha", minutes(-5), minutes(10));
    // Valid for another 5 minutes.
    const fresh = await insertShopping("tenant_alpha", minutes(5), minutes(5));
    // Beta (suspended) is purged too.
    const betaExpired = await insertShopping("tenant_beta", minutes(-5), minutes(-5));

    await iteration(due);

    expect(await remaining("tenant_alpha", expired)).toEqual(NONE);
    for (const kept of [bought, opened, stillPriced, fresh]) {
      expect(await remaining("tenant_alpha", kept)).toEqual(ALL);
    }
    expect(await remaining("tenant_beta", betaExpired)).toEqual(NONE);
    expect((await queue.getJob(purgeJobId(tenants.alpha, due)))?.returnvalue).toEqual<TenantJobResult>({
      task: OFFERS_PURGE_JOB,
      tenantId: tenants.alpha,
      outcome: "done",
      counts: { searches: 1 },
      continued: false,
    });

    // 20 minutes later the late priced offers and the fresh search have expired; the checkouts still hold theirs.
    const next = at(4, 20);
    clock.set(next);
    await iteration(next);

    expect(await remaining("tenant_alpha", stillPriced)).toEqual(NONE);
    expect(await remaining("tenant_alpha", fresh)).toEqual(NONE);
    expect(await remaining("tenant_alpha", bought)).toEqual(ALL);
    expect(await remaining("tenant_alpha", opened)).toEqual(ALL);
    const purged = sink.records().filter((line) => line["msg"] === "offers.purged");
    expect(purged).toContainEqual(expect.objectContaining({ tenantId: tenants.alpha, searches: 2 }));
    // Counts only: no search, offer or checkout id reaches a log line.
    expect(sink.text()).not.toContain(expired.searchId);
    expect(sink.text()).not.toContain(bought.pricedOfferId);
  });

  it("re-enqueues itself while a full batch of 500 was deleted, and the continuation deletes the rest", async () => {
    const due = at(5);
    clock.set(due);
    const expires = new Date(due.getTime() - MINUTE_MS);
    const count = JOB_BATCH_LIMITS.searchPurge + 1;
    await tenantTx(tenantDb, "tenant_beta", (trx) =>
      trx
        .insertInto("flight_searches")
        .values(
          Array.from({ length: count }, () => ({
            id: newId("srch"),
            environment: "test",
            criteria: JSON.stringify({ mode: "simple" }),
            amadeus_request: JSON.stringify({}),
            expires_at: expires,
          })),
        )
        .execute(),
    );

    await iteration(due);
    const continuation = await finished(purgeJobId(tenants.beta, due, 1));

    expect((await queue.getJob(purgeJobId(tenants.beta, due)))?.returnvalue).toMatchObject({
      outcome: "done",
      counts: { searches: JOB_BATCH_LIMITS.searchPurge },
      continued: true,
    });
    expect(continuation.returnvalue).toMatchObject({
      outcome: "done",
      counts: { searches: 1 },
      continued: false,
    });
    expect(continuation.data).toEqual({ tenantId: tenants.beta, bucket: minuteBucket(due), continuation: 1 });
    const left = await tenantTx(tenantDb, "tenant_beta", (trx) =>
      trx.selectFrom("flight_searches").select("id").where("expires_at", "<=", due).execute(),
    );
    expect(left).toEqual([]);
  });
});
