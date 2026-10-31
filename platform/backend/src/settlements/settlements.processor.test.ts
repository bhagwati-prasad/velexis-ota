// The queue `platform-settlements` (PBE-059; architecture §5, flows/stripe-payments-account.md §F) on fakes: the job's
// data, the failures BullMQ retries and those it does not, SettlementJobs' enqueue with its timeout, the checks of
// `adminGenerateSettlements` (a month that has ended, a known tenant, the job before the audit row), the processor,
// and the `settlements.monthly` handler. The same against PostgreSQL, Redis and the worker's module graph runs in
// test/integration/settlements/settlement-generation.int.test.ts.
import { AppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import { UnrecoverableError, type Job, type Queue } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeStripe } from "../../test/support/fake-stripe";
import type { AuditService } from "../audit/audit.service";
import type { Clock } from "../common/clock";
import type { PlatformDb } from "../common/database";
import type { RequestContext } from "../common/http/request-context";
import { StripeNotConfiguredError } from "../common/stripe/stripe.client";
import { SettlementDataError } from "./settlement-formula";
import type { SettlementGenerationResult, SettlementGenerator } from "./settlement-generator";
import {
  SettlementEnqueueError,
  SETTLEMENTS_MONTHLY_JOB,
  SettlementsMonthlyScheduler,
} from "./settlements-monthly.scheduler";
import {
  describeSettlementFailure,
  parseSettlementGenerateJob,
  SETTLEMENT_ENQUEUE_TIMEOUT_MS,
  SETTLEMENT_GENERATE_JOB,
  SettlementJobs,
  SettlementsProcessor,
} from "./settlements.processor";
import type { SettlementsRepository } from "./settlements.repository";

const TENANT = "ten_01JSTMTPR0CESS0R000000000Z";
const ADMIN = "acc_01JSTMTADM1N0000000000000Z";
/** 2026-11-03 at 05:00 UTC: when settlements.monthly runs for October. */
const NOW = new Date("2026-11-03T05:00:00Z");

afterEach(() => {
  vi.useRealTimers();
});

describe("parseSettlementGenerateJob", () => {
  it("[PBE-059] reads {periodStart, tenantId?, requestId?}", () => {
    expect(parseSettlementGenerateJob({ periodStart: "2026-10-01T00:00:00.000Z" })).toEqual({
      periodStart: new Date("2026-10-01T00:00:00Z"),
    });
    expect(
      parseSettlementGenerateJob({
        periodStart: "2026-10-01T00:00:00Z",
        tenantId: TENANT,
        requestId: "req-1",
      }),
    ).toEqual({ periodStart: new Date("2026-10-01T00:00:00Z"), tenantId: TENANT, requestId: "req-1" });
  });

  it.each([
    ["not an object", "2026-10-01T00:00:00Z"],
    ["an array", []],
    ["no periodStart", {}],
    ["a mid-month start", { periodStart: "2026-10-15T00:00:00Z" }],
    ["a tenant id of another shape", { periodStart: "2026-10-01T00:00:00Z", tenantId: "ten_1" }],
    ["a request id with a line break", { periodStart: "2026-10-01T00:00:00Z", requestId: "a\nb" }],
    ["an unknown field", { periodStart: "2026-10-01T00:00:00Z", amount: "10.00" }],
  ])("refuses %s", (_case, data) => {
    expect(() => parseSettlementGenerateJob(data)).toThrow();
  });
});

describe("describeSettlementFailure", () => {
  it("[PBE-059] retries Stripe outages, rate limits and 5xx, and a database failure", () => {
    expect(describeSettlementFailure(FakeStripe.apiError(503))).toEqual({
      code: "STRIPE_API_ERROR",
      message: "STRIPE_API_ERROR: Stripe answered 503",
      retryable: true,
    });
    expect(describeSettlementFailure(FakeStripe.apiError(429)).retryable).toBe(true);
    expect(describeSettlementFailure(FakeStripe.connectionError())).toMatchObject({
      code: "STRIPE_CONNECTION_ERROR",
      retryable: true,
    });
    expect(describeSettlementFailure(new Error("connection terminated: secret value"))).toEqual({
      code: "INTERNAL_ERROR",
      message: "INTERNAL_ERROR: Error",
      retryable: true,
    });
  });

  it("[PBE-059] gives up on a Stripe 4xx, a missing key and data the statements cannot hold, without Stripe's message", () => {
    expect(describeSettlementFailure(FakeStripe.apiError(404, "resource_missing"))).toEqual({
      code: "STRIPE_INVALID_REQUEST_ERROR",
      message: "STRIPE_INVALID_REQUEST_ERROR: Stripe answered 404 (resource_missing)",
      retryable: false,
    });
    expect(describeSettlementFailure(new StripeNotConfiguredError())).toMatchObject({
      code: "STRIPE_NOT_CONFIGURED",
      retryable: false,
    });
    expect(
      describeSettlementFailure(new SettlementDataError("an amount does not fit numeric(12,2)")),
    ).toEqual({
      code: "SETTLEMENT_DATA_INVALID",
      message: "SETTLEMENT_DATA_INVALID: an amount does not fit numeric(12,2)",
      retryable: false,
    });
    expect(describeSettlementFailure(new UnrecoverableError("STRIPE_NOT_CONFIGURED: x"))).toEqual({
      code: "STRIPE_NOT_CONFIGURED",
      message: "STRIPE_NOT_CONFIGURED: x",
      retryable: false,
    });
  });
});

/** SettlementJobs on fakes: the queue's `add`, the tenant lookup, the audit and a transaction that just runs. */
function settlementJobs(options: { add?: Queue["add"]; tenants?: readonly string[]; active?: boolean } = {}) {
  const add = vi.fn<Queue["add"]>(options.add ?? (() => Promise.resolve({} as Job)));
  const record = vi
    .fn<AuditService["record"]>()
    .mockResolvedValue({} as Awaited<ReturnType<AuditService["record"]>>);
  const tenants = new Set(options.tenants ?? [TENANT]);
  const repository = {
    tenantExists: (tenantId: string) => Promise.resolve(tenants.has(tenantId)),
  } as unknown as SettlementsRepository;
  const db = {
    transaction: () => ({ execute: (work: (trx: unknown) => Promise<unknown>) => work({}) }),
  } as unknown as PlatformDb;
  const logger = { info: vi.fn(), warn: vi.fn() };
  const context = { active: options.active ?? true, requestId: "req-admin-1" } as unknown as RequestContext;
  const jobs = new SettlementJobs(
    { add } as unknown as Queue,
    repository,
    { record } as unknown as AuditService,
    new FakeClock(NOW) as unknown as Clock,
    db,
    logger as unknown as PinoLogger,
    context,
  );
  return { jobs, add, record, logger };
}

describe("SettlementJobs", () => {
  it("[PBE-059] queues settlement.generate with the job's data", async () => {
    const { jobs, add } = settlementJobs();

    expect(await jobs.enqueue({ periodStart: "2026-10-01T00:00:00.000Z" })).toBe(true);
    expect(add).toHaveBeenCalledWith(SETTLEMENT_GENERATE_JOB, { periodStart: "2026-10-01T00:00:00.000Z" });
  });

  it("[PBE-059] answers false, logged, when Redis fails or does not answer in time", async () => {
    const failing = settlementJobs({ add: () => Promise.reject(new Error("Connection is closed.")) });
    expect(await failing.jobs.enqueue({ periodStart: "2026-10-01T00:00:00.000Z" })).toBe(false);
    expect(failing.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ periodStart: "2026-10-01T00:00:00.000Z" }),
      "settlement.enqueue_failed",
    );

    vi.useFakeTimers();
    const silent = settlementJobs({ add: () => new Promise<Job>(() => undefined) });
    const queued = silent.jobs.enqueue({ periodStart: "2026-10-01T00:00:00.000Z" });
    await vi.advanceTimersByTimeAsync(SETTLEMENT_ENQUEUE_TIMEOUT_MS);
    expect(await queued).toBe(false);
    expect(silent.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: SETTLEMENT_ENQUEUE_TIMEOUT_MS }),
      "settlement.enqueue_timeout",
    );
  });

  it("[PBE-059] adminGenerateSettlements: queues a closed month, then writes the audit row with the request id in the job", async () => {
    const { jobs, add, record } = settlementJobs();

    await jobs.request({ sub: ADMIN }, { periodStart: "2026-10-01T00:00:00Z", tenantId: TENANT });

    expect(add).toHaveBeenCalledWith(SETTLEMENT_GENERATE_JOB, {
      periodStart: "2026-10-01T00:00:00.000Z",
      tenantId: TENANT,
      requestId: "req-admin-1",
    });
    expect(record).toHaveBeenCalledWith(expect.anything(), {
      actorType: "platform_admin",
      actorAccountId: ADMIN,
      action: "settlement.generation_requested",
      targetType: "settlement",
      targetId: null,
      tenantId: TENANT,
      details: { periodStart: "2026-10-01T00:00:00.000Z", tenantId: TENANT },
    });
    expect(add.mock.invocationCallOrder[0]).toBeLessThan(record.mock.invocationCallOrder[0] ?? 0);
  });

  it("[PBE-059] adminGenerateSettlements: refuses the current and a future month with period_not_closed", async () => {
    const { jobs, add, record } = settlementJobs();

    for (const periodStart of ["2026-11-01T00:00:00Z", "2027-02-01T00:00:00Z"]) {
      const error = await jobs.request({ sub: ADMIN }, { periodStart }).catch((caught: unknown) => caught);
      expect(error, periodStart).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        code: "VALIDATION_FAILED",
        fieldErrors: [
          { path: "/periodStart", code: "period_not_closed", message: "Choose a month that has ended." },
        ],
      });
    }
    expect(add).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("[PBE-059] adminGenerateSettlements: 404 for an unknown tenant, 503 when the job is not queued, no audit row", async () => {
    const unknown = settlementJobs({ tenants: [] });
    await expect(
      unknown.jobs.request({ sub: ADMIN }, { periodStart: "2026-10-01T00:00:00Z", tenantId: TENANT }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(unknown.add).not.toHaveBeenCalled();

    const down = settlementJobs({
      add: () => Promise.reject(new Error("Connection is closed.")),
      active: false,
    });
    await expect(
      down.jobs.request({ sub: ADMIN }, { periodStart: "2026-10-01T00:00:00Z" }),
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(down.add).toHaveBeenCalledWith(SETTLEMENT_GENERATE_JOB, {
      periodStart: "2026-10-01T00:00:00.000Z",
    });
    expect(down.record).not.toHaveBeenCalled();
  });
});

describe("SettlementsProcessor", () => {
  const RESULT = { periodStart: "2026-10-01T00:00:00.000Z" } as SettlementGenerationResult;

  function processor(generate: SettlementGenerator["generate"]) {
    const logger = { info: vi.fn(), error: vi.fn() };
    const generator = { generate: vi.fn(generate) };
    return {
      processor: new SettlementsProcessor(
        generator as unknown as SettlementGenerator,
        logger as unknown as PinoLogger,
      ),
      generator,
      logger,
    };
  }

  const job = (name: string, data: unknown) => ({ name, data, attemptsMade: 0 }) as unknown as Job;

  it("[PBE-059] runs the generator for settlement.generate and returns its counts", async () => {
    const { processor: under, generator } = processor(() => Promise.resolve(RESULT));

    await expect(
      under.process(
        job(SETTLEMENT_GENERATE_JOB, { periodStart: "2026-10-01T00:00:00.000Z", tenantId: TENANT }),
      ),
    ).resolves.toBe(RESULT);
    expect(generator.generate).toHaveBeenCalledWith({
      periodStart: new Date("2026-10-01T00:00:00Z"),
      tenantId: TENANT,
    });
  });

  it("[PBE-059] ends the attempts at once for another job name, invalid data or a failure no retry mends", async () => {
    const { processor: under, generator } = processor(() => Promise.reject(new StripeNotConfiguredError()));

    await expect(under.process(job("settlement.other", {}))).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(under.process(job(SETTLEMENT_GENERATE_JOB, { periodStart: "soon" }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(generator.generate).not.toHaveBeenCalled();
    await expect(
      under.process(job(SETTLEMENT_GENERATE_JOB, { periodStart: "2026-10-01T00:00:00.000Z" })),
    ).rejects.toThrow(new UnrecoverableError("STRIPE_NOT_CONFIGURED: STRIPE_SECRET_KEY is not set"));
  });

  it("[PBE-059] lets BullMQ try again after Stripe was down, and logs each failure without Stripe's payload", async () => {
    const outage = FakeStripe.apiError(503);
    const { processor: under, logger } = processor(() => Promise.reject(outage));
    const failed = job(SETTLEMENT_GENERATE_JOB, {
      periodStart: "2026-10-01T00:00:00.000Z",
      tenantId: TENANT,
    });

    await expect(under.process(failed)).rejects.toBe(outage);
    under.onFailed(failed, outage);

    expect(logger.error).toHaveBeenCalledWith(
      {
        queue: "platform-settlements",
        job: SETTLEMENT_GENERATE_JOB,
        attempt: 0,
        periodStart: "2026-10-01T00:00:00.000Z",
        tenantId: TENANT,
        code: "STRIPE_API_ERROR",
        failure: "STRIPE_API_ERROR: Stripe answered 503",
      },
      "settlement.generate_failed",
    );
  });
});

describe("SettlementsMonthlyScheduler", () => {
  it("[PBE-059] is the settlements.monthly schedule and queues the previous month", async () => {
    const { jobs, add } = settlementJobs({ active: false });
    const logger = { info: vi.fn() };
    const scheduler = new SettlementsMonthlyScheduler(
      jobs,
      new FakeClock(NOW) as unknown as Clock,
      logger as unknown as PinoLogger,
    );

    expect(SETTLEMENTS_MONTHLY_JOB).toBe("settlements.monthly");
    expect(await scheduler.run()).toEqual({ periodStart: "2026-10-01T00:00:00.000Z" });
    expect(add).toHaveBeenCalledWith(SETTLEMENT_GENERATE_JOB, { periodStart: "2026-10-01T00:00:00.000Z" });
    expect(logger.info).toHaveBeenCalledWith(
      { periodStart: "2026-10-01T00:00:00.000Z" },
      "settlements.monthly_queued",
    );
  });

  it("[PBE-059] fails its run when the job cannot be queued, so BullMQ tries again", async () => {
    const { jobs } = settlementJobs({ add: () => Promise.reject(new Error("Connection is closed.")) });
    const scheduler = new SettlementsMonthlyScheduler(
      jobs,
      new FakeClock(NOW) as unknown as Clock,
      { info: vi.fn() } as unknown as PinoLogger,
    );

    await expect(scheduler.run()).rejects.toBeInstanceOf(SettlementEnqueueError);
  });
});
