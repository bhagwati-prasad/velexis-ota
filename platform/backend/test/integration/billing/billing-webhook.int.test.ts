// The Stripe Billing webhook and the inbox behind it (PBE-043; subscription-billing flow §C and §D, PADR-0002 items 4
// and 5, PADR-0015 item 4): `POST /webhooks/stripe/billing` of the API (createTestApp) on this file's database clone
// and Redis database, then the worker's module graph (WorkerModule, as dist/worker.js builds it) on the same ones, with
// the FakeClock of the API, the FakeStripe of test/support/fake-stripe.ts and a test handler of
// `customer.subscription.updated`. The events are the X-028 fixtures of the billing endpoint, signed here with a
// secret made for this file (`@velexis/testing/stripe`), at the FakeClock's time.
//
// The intake tests run before the worker starts, so the queue shows exactly what the receiver queued. The worker's
// milestone switches are a set the tests change (FeatureSwitches replaced), and its job schedulers are not registered
// (JobSchedulerRegistry replaced): the sweep runs when a test adds its job to `platform-maintenance`, as the scheduler
// would, after moving the FakeClock.
import { randomBytes } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { expectResponseToMatch } from "@velexis/testing";
import { signedStripeEvent, type StripeFixtureEventType } from "@velexis/testing/stripe";
import { UnrecoverableError, type Job, type Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { StripeEventsProcessor } from "../../../src/billing/sync/stripe-events.processor";
import {
  STRIPE_EVENTS_SWEEP_JOB,
  SWEEP_AGE_MS,
  SWEEP_PROCESSING_AGE_MS,
  type StripeEventsSweepResult,
} from "../../../src/billing/sync/stripe-events-sweep.scheduler";
import { Clock } from "../../../src/common/clock";
import { PLATFORM_DB, PLATFORM_POOL, type PlatformDb, type PlatformPool } from "../../../src/common/database";
import { FeatureSwitches, type Feature } from "../../../src/common/features";
import { PLATFORM_QUEUE } from "../../../src/common/queues/queue-names";
import { JobSchedulerRegistry } from "../../../src/common/queues/scheduler.registry";
import { StripeClient } from "../../../src/common/stripe/stripe.client";
import {
  StripeEventsRepository,
  type StripeEventRecord,
} from "../../../src/common/stripe/stripe-events.repository";
import {
  HandlesStripeEvents,
  STRIPE_EVENT_JOB,
  StripeEventFailure,
  type StripeEventOutcome,
  type StripeInboxEvent,
} from "../../../src/common/stripe/stripe-inbox.service";
import { createProcessLogger, PLATFORM_PROCESSES } from "../../../src/config";
import { WorkerModule } from "../../../src/worker.module";
import { insertOta } from "../../builders/tenants";
import { createTestApp, LogSink, type TestApp } from "../../support/app";
import { FakeStripe } from "../../support/fake-stripe";

/** Starting the API and the worker's module graph takes seconds; the bound allows for a loaded 4-CPU CI runner. */
const SETUP_TIMEOUT_MS = 60_000;
/** How long a test waits for the worker (a job is taken within milliseconds; the bound stays under Vitest's 5 s). */
const WAIT = { timeout: 4_000, interval: 20 } as const;

/** The signing secret of `/webhooks/stripe/billing` in this file only. */
const SECRET = `whsec_${randomBytes(24).toString("base64url")}`;
/** The X-028 fixtures of the billing endpoint (the contract test's WEBHOOK_FIXTURES of receiveStripeBillingEvent). */
const BILLING_FIXTURES = [
  "checkout.session.completed",
  "customer.subscription.updated",
  "invoice.paid",
] as const;
const PATH = "/webhooks/stripe/billing";
const MINUTE_MS = 60_000;

/** The worker's milestone switches: off unless a test turns one on. */
const switchedOn = new Set<Feature>();
const switches = { isEnabled: (feature: Feature): boolean => switchedOn.has(feature) };

/** What the test handler does with its next events: succeed (the default) or throw the errors queued here. */
const handlerFailures: Error[] = [];
let handlerTenantId: string | null = null;

/**
 * The handler of `customer.subscription.updated` of the tests: it re-fetches the subscription from the FakeStripe, as
 * the handlers of PBE-045 will, and resolves the event to `handlerTenantId`.
 */
@Injectable()
@HandlesStripeEvents("billing", ["customer.subscription.updated"])
class TestSubscriptionHandler {
  readonly seen: StripeInboxEvent[] = [];

  constructor(private readonly stripe: StripeClient) {}

  async handle(event: StripeInboxEvent): Promise<StripeEventOutcome> {
    this.seen.push(event);
    const failure = handlerFailures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    await this.stripe.api().subscriptions.retrieve(event.objectId ?? "");
    return { status: "processed", tenantId: handlerTenantId };
  }
}

const stripe = new FakeStripe();
let t: TestApp;
let pool: PlatformPool;
let apiQueue: Queue;
let apiRepository: StripeEventsRepository;
let nextId = 1;

beforeAll(async () => {
  // The API holds a Stripe client since PBE-044 (Checkout, the Customer Portal): the same FakeStripe, so the intake
  // tests can show that the receiver never calls it.
  t = await createTestApp({
    env: { STRIPE_BILLING_WEBHOOK_SECRET: SECRET },
    overrides: [{ provide: StripeClient, useValue: stripe }],
  });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  apiQueue = t.app.get<Queue>(getQueueToken(PLATFORM_QUEUE.stripeEvents), { strict: false });
  apiRepository = t.app.get(StripeEventsRepository, { strict: false });
  // The subscription of the fixtures, as Stripe would answer the handler's re-fetch.
  stripe.put({ id: "sub_test_alpha_1", object: "subscription" });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT_MS);

/** A signing secret that is not the endpoint's. */
const otherSecret = (): string => `whsec_${randomBytes(24).toString("base64url")}`;

/** A new event id of the fixtures' shape. */
const newEventId = (label: string): string => `evt_test_pbe043_${label}_${nextId++}`;

/** The fixture of `type` signed with SECRET at the FakeClock's time, with `overrides` deep-merged. */
function sign(type: StripeFixtureEventType, overrides?: Record<string, unknown>) {
  return signedStripeEvent(type, overrides, SECRET, { timestamp: t.clock.now() });
}

/** Posts `payload` to the billing endpoint as Stripe does, with `signature` unless it is `undefined`. */
function deliver(payload: string, signature: string | undefined) {
  const call = t.http.post(PATH).set("Content-Type", "application/json");
  return (signature === undefined ? call : call.set("Stripe-Signature", signature)).send(payload);
}

async function row(id: string): Promise<StripeEventRecord | undefined> {
  const { rows } = await pool.query<StripeEventRecord>("SELECT * FROM platform.stripe_events WHERE id = $1", [
    id,
  ]);
  return rows[0];
}

async function rowCount(id: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM platform.stripe_events WHERE id = $1",
    [id],
  );
  return rows[0]?.n ?? 0;
}

describe("POST /webhooks/stripe/billing (receiveStripeBillingEvent)", () => {
  it("[PBE-043 AC1] stores each billing fixture once and queues it once, also when Stripe delivers it twice", async () => {
    const signed = BILLING_FIXTURES.map((type) => sign(type));

    for (const { payload, header } of [...signed, ...signed]) {
      const res = await deliver(payload, header);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      expect(res.headers["cache-control"]).toBe("no-store");
      expectResponseToMatch("receiveStripeBillingEvent", res, { document: "platform" });
    }
    for (const { event } of signed) {
      expect(await row(event.id)).toMatchObject({
        id: event.id,
        endpoint: "billing",
        type: event.type,
        livemode: false,
        account: null,
        object_type: (event.data.object as { object: string }).object,
        object_id: (event.data.object as { id: string }).id,
        api_version: event.api_version,
        stripe_created_at: new Date(event.created * 1000),
        status: "received",
        attempts: 0,
        last_error: null,
        tenant_id: null,
        received_at: t.clock.now(),
        processed_at: null,
      });
      expect(await rowCount(event.id)).toBe(1);
      const job = await apiQueue.getJob(event.id);
      expect([job?.name, job?.data]).toEqual([STRIPE_EVENT_JOB, { eventId: event.id }]);
    }
    // Six deliveries, three jobs: BullMQ adds one job per event id, and nothing else was queued.
    const counts = await apiQueue.getJobCounts();
    expect(counts["waiting"]).toBe(3);
    expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(3);
    // Stripe is never called inline: the API's Stripe client (the FakeStripe) got no call from the receiver.
    expect(t.app.get(StripeClient, { strict: false })).toBe(stripe);
    expect(stripe.calls).toEqual([]);
    expect(t.logs.withMessage("stripe.webhook_stored")).toHaveLength(3);
    expect(t.logs.withMessage("stripe.webhook_duplicate")).toHaveLength(3);
  });

  it("[PBE-043 AC1] refuses a payload changed after signing with 400 WEBHOOK_SIGNATURE_INVALID, a security event", async () => {
    const id = newEventId("changed");
    const { payload, header } = sign("invoice.paid", { id });
    const changed = payload.replace('"amount_paid": 4900', '"amount_paid": 1');
    expect(changed).not.toBe(payload);
    const before = t.logs.lines.length;

    const res = await deliver(changed, header);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "WEBHOOK_SIGNATURE_INVALID", status: 400 });
    expectResponseToMatch("receiveStripeBillingEvent", res, { document: "platform" });
    expect(await rowCount(id)).toBe(0);
    expect(await apiQueue.getJob(id)).toBeUndefined();
    const lines = t.logs.lines.slice(before);
    expect(lines.filter((line) => line["msg"] === "stripe.webhook_signature_invalid")).toEqual([
      expect.objectContaining({
        securityEvent: "stripe.webhook_signature_invalid",
        endpoint: "billing",
        reason: "signature_mismatch",
      }),
    ]);
    for (const value of [SECRET, header, id, '"amount_paid"']) {
      expect(JSON.stringify(lines)).not.toContain(value);
    }
  });

  it.each<[string, (payload: string) => string | undefined]>([
    ["no Stripe-Signature header", () => undefined],
    [
      "the signature of another secret",
      (payload) =>
        signedStripeEvent("invoice.paid", JSON.parse(payload) as Record<string, unknown>, otherSecret(), {
          timestamp: t.clock.now(),
        }).header,
    ],
    [
      "a signature older than 5 minutes on the FakeClock",
      (payload) =>
        signedStripeEvent("invoice.paid", JSON.parse(payload) as Record<string, unknown>, SECRET, {
          timestamp: new Date(t.clock.now().getTime() - 6 * MINUTE_MS),
        }).header,
    ],
  ])("refuses %s with 400 WEBHOOK_SIGNATURE_INVALID before reading the body", async (_case, signatureOf) => {
    const id = newEventId("refused");
    const { payload } = sign("invoice.paid", { id });

    const res = await deliver(payload, signatureOf(payload));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");
    expect(await rowCount(id)).toBe(0);
  });

  it("[PBE-043] refuses a live-mode event in a test deployment with 400 VALIDATION_FAILED livemode_mismatch", async () => {
    const id = newEventId("live");
    const { payload, header } = sign("customer.subscription.updated", { id, livemode: true });

    const res = await deliver(payload, header);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: "VALIDATION_FAILED",
      fieldErrors: [{ path: "/livemode", code: "livemode_mismatch" }],
    });
    expectResponseToMatch("receiveStripeBillingEvent", res, { document: "platform" });
    expect(await rowCount(id)).toBe(0);
    expect(await apiQueue.getJob(id)).toBeUndefined();
  });

  it("refuses a signed body that is not a Stripe event with 400 VALIDATION_FAILED", async () => {
    const id = newEventId("not_event");
    const { payload, header } = sign("invoice.paid", { id, object: "charge" });

    const res = await deliver(payload, header);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
    expect(await rowCount(id)).toBe(0);
  });

  it("[PBE-043] answers 500 when the inbox cannot be written, so Stripe delivers the event again", async () => {
    const id = newEventId("db_down");
    const { payload, header } = sign("invoice.paid", { id });
    vi.spyOn(apiRepository, "insertIfAbsent").mockRejectedValueOnce(
      new Error("Connection terminated unexpectedly"),
    );

    const failed = await deliver(payload, header);

    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe("INTERNAL_ERROR");
    expectResponseToMatch("receiveStripeBillingEvent", failed, { document: "platform" });
    expect(await rowCount(id)).toBe(0);
    expect(await apiQueue.getJob(id)).toBeUndefined();
    // Stripe's next try is stored and queued.
    expect((await deliver(payload, header)).status).toBe(200);
    expect(await rowCount(id)).toBe(1);
    expect((await apiQueue.getJob(id))?.data).toEqual({ eventId: id });
  });

  it("[PBE-043] answers 200 when Redis loses the enqueue: the event is committed, and a redelivery queues it", async () => {
    const id = newEventId("redis_down");
    const { payload, header } = sign("invoice.paid", { id });
    vi.spyOn(apiQueue, "add").mockRejectedValueOnce(new Error("Connection is closed."));

    const res = await deliver(payload, header);

    expect(res.status).toBe(200);
    expect((await row(id))?.status).toBe("received");
    expect(await apiQueue.getJob(id)).toBeUndefined();
    expect(t.logs.withMessage("stripe.webhook_enqueue_failed")).toEqual([
      expect.objectContaining({ eventId: id, endpoint: "billing" }),
    ]);
    expect((await deliver(payload, header)).status).toBe(200);
    expect((await apiQueue.getJob(id))?.data).toEqual({ eventId: id });
  });
});

describe("the worker: stripe.event and stripe_events.sweep", () => {
  let worker: TestingModule;
  let processor: StripeEventsProcessor;
  let handler: TestSubscriptionHandler;
  let maintenance: Queue;
  let tenantId: string;
  const workerLogs = new LogSink();

  beforeAll(async () => {
    const logger = createProcessLogger(PLATFORM_PROCESSES.worker, t.config, workerLogs);
    worker = await Test.createTestingModule({
      imports: [WorkerModule.forRoot(t.config, logger)],
      // The test handler injects the Stripe client as the worker's own handlers do.
      providers: [TestSubscriptionHandler, { provide: StripeClient, useValue: stripe }],
    })
      .overrideProvider(Clock)
      .useValue(t.clock)
      .overrideProvider(JobSchedulerRegistry)
      .useValue({})
      .overrideProvider(FeatureSwitches)
      .useValue(switches)
      .overrideProvider(StripeClient)
      .useValue(stripe)
      .compile();
    await worker.init();
    processor = worker.get(StripeEventsProcessor, { strict: false });
    handler = worker.get(TestSubscriptionHandler);
    maintenance = worker.get<Queue>(getQueueToken(PLATFORM_QUEUE.maintenance), { strict: false });
    tenantId = (await insertOta(pool)).tenant.id;
    // The events the intake tests queued are processed now (every switch off): wait until the inbox is quiet.
    await vi.waitFor(
      async () => {
        const { rows } = await pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM platform.stripe_events WHERE status IN ('received', 'processing')",
        );
        expect(rows[0]?.n).toBe(0);
      },
      { timeout: 20_000, interval: 50 },
    );
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await worker?.close();
  }, SETUP_TIMEOUT_MS);

  /** Waits until the row of `id` has `status`, and returns it. */
  async function settled(id: string, status: string): Promise<StripeEventRecord> {
    return vi.waitFor(async () => {
      const found = await row(id);
      expect(found?.status).toBe(status);
      return found as StripeEventRecord;
    }, WAIT);
  }

  /** Delivers a new event of `type` whose `stripe.event` is lost (Redis fails once), and returns its id. */
  async function deliverLost(type: StripeFixtureEventType): Promise<string> {
    const id = newEventId("lost");
    const { payload, header } = sign(type, { id });
    vi.spyOn(apiQueue, "add").mockRejectedValueOnce(new Error("Connection is closed."));
    expect((await deliver(payload, header)).status).toBe(200);
    expect(await apiQueue.getJob(id)).toBeUndefined();
    return id;
  }

  /** Runs `stripe_events.sweep` as its job scheduler starts it: a job named after the schedule on `platform-maintenance`. */
  async function runSweep(): Promise<StripeEventsSweepResult> {
    const job = await maintenance.add(STRIPE_EVENTS_SWEEP_JOB, {});
    const done: Job = await vi.waitFor(async () => {
      const current = await maintenance.getJob(job.id ?? "");
      expect(await current?.getState()).toBe("completed");
      return current as Job;
    }, WAIT);
    return done.returnvalue as StripeEventsSweepResult;
  }

  it("[PBE-043 AC2] with FEATURE_STRIPE_BILLING=false stores the events and ends them ignored, without a handler", async () => {
    switchedOn.clear();
    const ids: string[] = [];
    for (const type of BILLING_FIXTURES) {
      const id = newEventId("switch_off");
      const { payload, header } = sign(type, { id });
      expect((await deliver(payload, header)).status).toBe(200);
      ids.push(id);
    }

    for (const id of ids) {
      expect(await settled(id, "ignored")).toMatchObject({
        attempts: 1,
        last_error: "FEATURE_DISABLED: FEATURE_STRIPE_BILLING is off",
        processed_at: t.clock.now(),
      });
    }
    expect(handler.seen.map((event) => event.id).filter((id) => ids.includes(id))).toEqual([]);
    expect(stripe.calls).toEqual([]);
    // The fixtures of the intake tests ended the same way.
    for (const type of BILLING_FIXTURES) {
      expect((await row(sign(type).event.id))?.status).toBe("ignored");
    }
  });

  it("[PBE-043] with the switch on routes an event to its handler, which re-fetches it, and ignores unhandled types", async () => {
    switchedOn.add("stripe_billing");
    handlerTenantId = tenantId;
    const subscription = sign("customer.subscription.updated", { id: newEventId("handled") });
    const invoice = sign("invoice.paid", { id: newEventId("unhandled") });
    const before = stripe.callsOf("subscriptions.retrieve").length;

    for (const { payload, header } of [subscription, invoice]) {
      expect((await deliver(payload, header)).status).toBe(200);
    }

    expect(await settled(subscription.event.id, "processed")).toMatchObject({
      attempts: 1,
      last_error: null,
      tenant_id: tenantId,
      processed_at: t.clock.now(),
    });
    expect(await settled(invoice.event.id, "ignored")).toMatchObject({
      last_error: "UNHANDLED_EVENT_TYPE: no handler for invoice.paid",
      tenant_id: null,
    });
    expect(handler.seen.filter((event) => event.id === subscription.event.id)).toEqual([
      expect.objectContaining({
        type: "customer.subscription.updated",
        objectId: "sub_test_alpha_1",
        attempt: 1,
      }),
    ]);
    expect(
      stripe
        .callsOf("subscriptions.retrieve")
        .slice(before)
        .map((call) => call.id),
    ).toEqual(["sub_test_alpha_1"]);
    // A redelivery of a processed event stores and processes nothing again.
    expect((await deliver(subscription.payload, subscription.header)).status).toBe(200);
    expect((await row(subscription.event.id))?.attempts).toBe(1);
  });

  it("[PBE-043 AC3] queues an event whose enqueue was lost after the commit with the sweep, once it is 2 minutes old", async () => {
    switchedOn.add("stripe_billing");
    const id = await deliverLost("customer.subscription.updated");

    t.clock.advance(SWEEP_AGE_MS - 1000);
    expect(await runSweep()).toEqual({ candidates: 0, enqueued: 0 });
    expect((await row(id))?.status).toBe("received");
    expect(await apiQueue.getJob(id)).toBeUndefined();

    t.clock.advance(2000);
    expect(await runSweep()).toEqual({ candidates: 1, enqueued: 1 });
    expect(await settled(id, "processed")).toMatchObject({ attempts: 1, last_error: null });
    // nestjs-pino writes through one root logger per process, so the worker's lines may land in either sink.
    expect(
      [...t.logs.lines, ...workerLogs.lines].filter((line) => line["msg"] === "stripe_events.sweep"),
    ).toEqual([expect.objectContaining({ candidates: 1, enqueued: 1 })]);
  });

  it("[PBE-043] records a failed attempt as retryable, and the sweep queues the event again until it is processed", async () => {
    switchedOn.add("stripe_billing");
    const id = await deliverLost("customer.subscription.updated");
    handlerFailures.push(FakeStripe.apiError(503));

    // The first attempt, as BullMQ makes it (first of five), while Stripe answers 503.
    const thrown = await processor
      .processEvent(id, { attemptsMade: 0, opts: { attempts: 5 } })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(UnrecoverableError);
    expect(await row(id)).toMatchObject({
      status: "failed",
      attempts: 1,
      last_error: "STRIPE_API_ERROR: Stripe answered 503",
      processed_at: null,
    });
    // Its BullMQ job is missing (the attempt ran outside the queue): the sweep queues it once it is 2 minutes old.
    t.clock.advance(SWEEP_AGE_MS + 1000);
    expect(await runSweep()).toEqual({ candidates: 1, enqueued: 1 });
    expect(await settled(id, "processed")).toMatchObject({ attempts: 2, last_error: null });
  });

  it("[PBE-043] fails an event for good on a failure no retry mends, and the sweep leaves it to the admin", async () => {
    switchedOn.add("stripe_billing");
    const id = await deliverLost("customer.subscription.updated");
    handlerFailures.push(
      new StripeEventFailure("UNKNOWN_PRICE", "price_test_unlinked is linked to no plan", {
        retryable: false,
      }),
    );

    await expect(processor.processEvent(id, { attemptsMade: 0, opts: { attempts: 5 } })).rejects.toThrow(
      UnrecoverableError,
    );
    expect(await row(id)).toMatchObject({
      status: "failed",
      attempts: 1,
      last_error: "UNKNOWN_PRICE: price_test_unlinked is linked to no plan",
      processed_at: t.clock.now(),
    });
    t.clock.advance(SWEEP_AGE_MS + 1000);
    expect(await runSweep()).toEqual({ candidates: 0, enqueued: 0 });
    // A stray job of the event finds it done and changes nothing.
    expect(await processor.processEvent(id, { attemptsMade: 0, opts: { attempts: 5 } })).toEqual({
      eventId: id,
      status: "skipped",
    });
    expect((await row(id))?.attempts).toBe(1);
  });

  it("[PBE-043] queues an event left processing by an attempt that never ended once it is 10 minutes old", async () => {
    switchedOn.add("stripe_billing");
    const id = await deliverLost("customer.subscription.updated");
    // An attempt claimed the row, and its worker stopped before it recorded anything; BullMQ holds no job of it.
    expect(await apiRepository.claim(t.app.get<PlatformDb>(PLATFORM_DB), id, t.clock.now())).toMatchObject({
      status: "processing",
      attempts: 1,
    });

    t.clock.advance(SWEEP_AGE_MS + 1000);
    expect(await runSweep()).toEqual({ candidates: 0, enqueued: 0 });
    expect((await row(id))?.status).toBe("processing");

    t.clock.advance(SWEEP_PROCESSING_AGE_MS - SWEEP_AGE_MS);
    expect(await runSweep()).toEqual({ candidates: 1, enqueued: 1 });
    expect(await settled(id, "processed")).toMatchObject({ attempts: 2, last_error: null });
  });
});
