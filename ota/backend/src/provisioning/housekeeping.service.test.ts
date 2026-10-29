// The housekeeping of `tenant.suspend` and `tenant.resume` (OBE-074, housekeeping.service.ts; PADR-0014 items 3, 4 and
// 7, OADR-0007 point 8) and its dispatch by the `ota-tenant-ops` consumer (tenant-ops.processor.ts), with doubles of
// the platform repository, the tenant context and transactions, Redis and the payments queue. The checkout expiry's
// statements (`lockOpenCheckouts`, `expireLockedCheckouts`, `voidablePaymentsOfCheckouts` of OBE-056's
// checkout-expiry.processor.ts) are replaced by doubles that write into one journal with the transactions, the Redis
// writes and the queue adds, so the tests read the order of the steps: the staff cut-off first, each batch in a
// transaction of its own, its voids after its commit, the next batch after the last id of the one before, and the
// re-read of the tenant at the end. What those statements select and lock (a checkout held by a pending booking, a
// claim that commits while the suspension waits for its lock), and the staff guard's refusal, run against PostgreSQL,
// Redis and the API in test/integration/provisioning/suspend-resume.int.test.ts.
import provisionFixture from "@velexis/api-types/fixtures/jobs/tenant-provision.json";
import { validateJob } from "@velexis/api-types/jobs";
import type { TenantSchema } from "@velexis/db";
import { FakeClock } from "@velexis/testing";
import { UnrecoverableError, type Job, type Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { PinoLogger } from "nestjs-pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as CheckoutExpiryModule from "../checkout/checkout-expiry.processor";
import type { Clock } from "../common/clock";
import { STAFF_DENY_TTL_SECONDS } from "../common/redis/redis.keys";
import { OTA_SCHEDULES } from "../jobs/schedulers";
import { DOCUMENT_TENANT_STATUSES } from "../documents/documents.processor";
import { NOTIFY_STATUSES } from "../notifications/notifications.processor";
import { PAYMENT_JOB_TENANT_STATUSES } from "../payments/payments.processor";
import { WEBHOOK_TENANT_STATUSES } from "../payments/webhooks/webhook-receiver.service";
import { BOOKING_SYNC_TENANT_STATUSES } from "../bookings/booking-sync.processor";
import { RECONCILE_TENANT_STATUSES } from "../bookings/reconcile.processor";
import { TICKETING_TENANT_STATUSES } from "../bookings/ticketing.processor";
import type { PlatformReadRepository } from "../tenancy/platform-read.repository";
import type { PlatformTenant, TenantStatus } from "../tenancy/platform-read.types";
import type { RequestTenant, TenantContext } from "../tenancy/tenant-context";
import type { TenantTransaction, TenantTx } from "../tenancy/tenant-tx";
import {
  HousekeepingService,
  SUSPENSION_EXPIRY_BATCH,
  type ResumeOutcome,
  type SuspendOutcome,
} from "./housekeeping.service";
import type { ProvisioningService } from "./provisioning.service";
import { TenantEventsProducer } from "./tenant-events.producer";
import { TenantOpsProcessor } from "./tenant-ops.processor";

/** Every step of a run, in order: transactions, the expiry's statements, Redis writes and queue adds. */
const journal = vi.hoisted(() => [] as string[]);
/** What the expiry's statement doubles answer, batch by batch (consumed in order). */
const script = vi.hoisted(
  () =>
    ({
      locked: [] as string[][],
      held: new Set<string>(),
      voidable: new Map<string, string[]>(),
      failAtBatch: undefined as number | undefined,
    }) as {
      locked: string[][];
      held: Set<string>;
      voidable: Map<string, string[]>;
      failAtBatch: number | undefined;
    },
);

vi.mock("../checkout/checkout-expiry.processor", async (importOriginal) => ({
  ...(await importOriginal<typeof CheckoutExpiryModule>()),
  lockOpenCheckouts: (_trx: unknown, after: string | undefined, limit: number): Promise<string[]> => {
    const batch = journal.filter((entry) => entry.startsWith("lock")).length;
    journal.push(`lock after=${after ?? "-"} limit=${limit}`);
    if (script.failAtBatch === batch) {
      return Promise.reject(
        Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }),
      );
    }
    return Promise.resolve(script.locked[batch] ?? []);
  },
  expireLockedCheckouts: (_trx: unknown, ids: readonly string[], now: Date) => {
    const expired = ids.filter((id) => !script.held.has(id));
    const held = ids.filter((id) => script.held.has(id));
    journal.push(`expire ${ids.length} at=${now.toISOString()} held=${held.length}`);
    return Promise.resolve({ expired, held });
  },
  voidablePaymentsOfCheckouts: (_trx: unknown, ids: readonly string[]): Promise<string[]> => {
    journal.push(`voidable of ${ids.length}`);
    return Promise.resolve(ids.flatMap((id) => script.voidable.get(id) ?? []));
  },
}));

const TENANT_ID = provisionFixture.tenantId;
const NOW = new Date("2026-10-28T09:15:00.000Z");
const CUT_OFF_KEY = `staffdeny:tenant:${TENANT_ID}`;

/** The `n`-th checkout's id (zero-padded, so the ids sort as the numbers do). */
const checkoutId = (n: number): string => `chk_01JBSUSPEND${String(n).padStart(15, "0")}`;
const paymentId = (n: number): string => `pay_01JBSUSPEND${String(n).padStart(15, "0")}`;
const checkouts = (from: number, count: number): string[] =>
  Array.from({ length: count }, (_, index) => checkoutId(from + index));

function tenant(status: TenantStatus): PlatformTenant {
  return {
    id: TENANT_ID,
    key: "acme",
    name: "Acme Travel",
    status,
    schemaName: "tenant_acme" as TenantSchema,
    storefrontEnvironment: "test",
    defaultCurrency: "EUR",
    defaultLocale: "en",
    billingNotice: null,
  };
}

interface Harness {
  readonly service: HousekeepingService;
  /** The tenant contexts the service opened. */
  readonly contexts: RequestTenant[];
  /** The tenant reads the service made, in order. */
  readonly reads: string[];
}

/**
 * The service with doubles. `statuses` are the answers of the successive tenant reads (`null`: no such tenant); the
 * last one repeats.
 */
function harness(statuses: ReadonlyArray<TenantStatus | null>): Harness {
  const reads: string[] = [];
  const contexts: RequestTenant[] = [];
  let read = 0;
  const platform = {
    tenantById: (id: string) => {
      reads.push(id);
      const status = statuses[Math.min(read, statuses.length - 1)] ?? null;
      read += 1;
      journal.push(`read tenant ${status ?? "none"}`);
      return Promise.resolve(status === null ? null : tenant(status));
    },
  } as unknown as PlatformReadRepository;
  const tenants = {
    run: <T>(context: RequestTenant, fn: () => Promise<T>): Promise<T> => {
      contexts.push(context);
      return fn();
    },
  } as unknown as TenantContext;
  const tx = {
    run: async <T>(fn: (trx: TenantTransaction) => Promise<T>): Promise<T> => {
      journal.push("begin");
      try {
        const result = await fn({} as TenantTransaction);
        journal.push("commit");
        return result;
      } catch (error) {
        journal.push("rollback");
        throw error;
      }
    },
  } as unknown as TenantTx;
  const redis = {
    set: (key: string, value: string, mode: string, ttl: number) => {
      journal.push(`set ${key} ${value} ${mode} ${ttl}`);
      return Promise.resolve("OK");
    },
    del: (key: string) => {
      journal.push(`del ${key}`);
      return Promise.resolve(1);
    },
  } as unknown as Redis;
  const payments = {
    addBulk: (jobs: ReadonlyArray<{ name: string; data: unknown; opts: { jobId: string } }>) => {
      journal.push(`queue ${jobs.map((job) => `${job.name}:${job.opts.jobId}`).join(",")}`);
      for (const job of jobs) {
        expect(job.data).toEqual({ tenantId: TENANT_ID, id: job.opts.jobId.replace("payment-void-", "") });
      }
      return Promise.resolve([]);
    },
  } as unknown as Queue;
  const service = new HousekeepingService(
    platform,
    tenants,
    tx,
    new FakeClock(NOW) as Clock,
    redis,
    payments,
  );
  return { service, contexts, reads };
}

const REQUEST = { tenantId: TENANT_ID, requestId: `${provisionFixture.jobId}-1` };
const cutOffWrite = (at: Date): string => `set ${CUT_OFF_KEY} ${at.getTime()} EX ${STAFF_DENY_TTL_SECONDS}`;

beforeEach(() => {
  journal.length = 0;
  script.locked = [];
  script.held = new Set();
  script.voidable = new Map();
  script.failAtBatch = undefined;
});

describe("HousekeepingService.suspend", () => {
  it("writes the staff cut-off, expires every open checkout batch by batch and queues each batch's voids after its commit [OBE-074 AC1]", async () => {
    const first = checkouts(1, SUSPENSION_EXPIRY_BATCH);
    const second = checkouts(SUSPENSION_EXPIRY_BATCH + 1, 2);
    script.locked = [first, second];
    script.voidable = new Map([
      [checkoutId(1), [paymentId(1)]],
      [checkoutId(SUSPENSION_EXPIRY_BATCH + 2), [paymentId(2), paymentId(3)]],
    ]);
    const { service, contexts } = harness(["suspended"]);

    const outcome = await service.suspend(REQUEST);

    expect(outcome).toEqual<SuspendOutcome>({
      status: "applied",
      expired: SUSPENSION_EXPIRY_BATCH + 2,
      held: 0,
      voids: 3,
      staffDenied: true,
    });
    expect(journal).toEqual([
      "read tenant suspended",
      // 30 days, the cut-off at the job's now (epoch ms): every staff session created until then is refused.
      cutOffWrite(NOW),
      "begin",
      `lock after=- limit=${SUSPENSION_EXPIRY_BATCH}`,
      `expire ${SUSPENSION_EXPIRY_BATCH} at=${NOW.toISOString()} held=0`,
      `voidable of ${SUSPENSION_EXPIRY_BATCH}`,
      "commit",
      `queue payment.void:payment-void-${paymentId(1)}`,
      // A full batch: the next one starts after its last id.
      "begin",
      `lock after=${checkoutId(SUSPENSION_EXPIRY_BATCH)} limit=${SUSPENSION_EXPIRY_BATCH}`,
      `expire 2 at=${NOW.toISOString()} held=0`,
      "voidable of 2",
      "commit",
      `queue payment.void:payment-void-${paymentId(2)},payment.void:payment-void-${paymentId(3)}`,
      // The tenant read again: still suspended, so the cut-off stays.
      "read tenant suspended",
    ]);
    expect(STAFF_DENY_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
    // The expiry runs in the tenant's context, as a system actor, under the message's job id.
    expect(contexts).toEqual([
      expect.objectContaining({
        tenantId: TENANT_ID,
        schemaName: "tenant_acme",
        actor: { type: "system", id: null },
        requestId: REQUEST.requestId,
      }),
    ]);
  });

  it("leaves a checkout a claim committed meanwhile as it was, without its void [OBE-074 AC2]", async () => {
    // Locked, then found held by the booking a claim committed while the suspension waited for the lock.
    script.locked = [[checkoutId(1), checkoutId(2), checkoutId(3)]];
    script.held = new Set([checkoutId(2)]);
    script.voidable = new Map([
      [checkoutId(1), [paymentId(1)]],
      [checkoutId(2), [paymentId(2)]],
    ]);
    const { service } = harness(["suspended"]);

    const outcome = await service.suspend(REQUEST);

    expect(outcome).toEqual<SuspendOutcome>({
      status: "applied",
      expired: 2,
      held: 1,
      voids: 1,
      staffDenied: true,
    });
    // Only the voids of the checkouts the batch expired are looked for and queued.
    expect(journal).toContain("voidable of 2");
    expect(journal).toContain(`queue payment.void:payment-void-${paymentId(1)}`);
    expect(journal.join("\n")).not.toContain(paymentId(2));
  });

  it("queues nothing when no checkout is open, and still writes the cut-off", async () => {
    const { service } = harness(["suspended"]);

    expect(await service.suspend(REQUEST)).toEqual<SuspendOutcome>({
      status: "applied",
      expired: 0,
      held: 0,
      voids: 0,
      staffDenied: true,
    });
    expect(journal.filter((entry) => entry.startsWith("queue"))).toEqual([]);
    expect(journal).toContain(cutOffWrite(NOW));
  });

  it.each([
    ["active", "active"],
    ["provisioning", "provisioning"],
    ["failed", "failed"],
    ["gone", null],
  ] as const)(
    "is a no-op for a tenant that is %s now: nothing is written, expired or queued (PADR-0014 item 7)",
    async (_label, status) => {
      const { service, contexts } = harness([status]);

      expect(await service.suspend(REQUEST)).toEqual<SuspendOutcome>({
        status: "skipped",
        tenantStatus: status,
      });
      expect(journal).toEqual([`read tenant ${status ?? "none"}`]);
      expect(contexts).toEqual([]);
    },
  );

  it("removes the cut-off again when the tenant was resumed while the suspension ran", async () => {
    script.locked = [[checkoutId(1)]];
    const { service } = harness(["suspended", "active"]);

    const outcome = await service.suspend(REQUEST);

    expect(outcome).toMatchObject({ status: "applied", expired: 1, staffDenied: false });
    expect(journal.slice(-2)).toEqual(["read tenant active", `del ${CUT_OFF_KEY}`]);
  });

  it("fails with the statement's error, rolls the batch back and keeps the voids of the batches committed before", async () => {
    script.locked = [checkouts(1, SUSPENSION_EXPIRY_BATCH)];
    script.voidable = new Map([[checkoutId(1), [paymentId(1)]]]);
    script.failAtBatch = 1;
    const { service } = harness(["suspended"]);

    await expect(service.suspend(REQUEST)).rejects.toMatchObject({ code: "57014" });
    expect(journal.slice(-4)).toEqual([
      `queue payment.void:payment-void-${paymentId(1)}`,
      "begin",
      `lock after=${checkoutId(SUSPENSION_EXPIRY_BATCH)} limit=${SUSPENSION_EXPIRY_BATCH}`,
      "rollback",
    ]);
  });
});

describe("HousekeepingService.resume", () => {
  it("deletes the staff cut-off of a tenant that is active again [OBE-074 AC3]", async () => {
    const { service, contexts } = harness(["active"]);

    expect(await service.resume(REQUEST)).toEqual<ResumeOutcome>({ status: "applied", staffDenied: false });
    expect(journal).toEqual(["read tenant active", `del ${CUT_OFF_KEY}`, "read tenant active"]);
    // Nothing of the tenant's own data changes: no tenant transaction.
    expect(contexts).toEqual([]);
  });

  it.each([
    ["suspended", "suspended"],
    ["gone", null],
  ] as const)("is a no-op for a tenant that is %s now (PADR-0014 item 7)", async (_label, status) => {
    const { service } = harness([status]);

    expect(await service.resume(REQUEST)).toEqual<ResumeOutcome>({ status: "skipped", tenantStatus: status });
    expect(journal).toEqual([`read tenant ${status ?? "none"}`]);
  });

  it("writes the cut-off again when the tenant was suspended once more while the resume ran", async () => {
    const { service } = harness(["active", "suspended"]);

    expect(await service.resume(REQUEST)).toEqual<ResumeOutcome>({ status: "applied", staffDenied: true });
    expect(journal).toEqual([
      "read tenant active",
      `del ${CUT_OFF_KEY}`,
      "read tenant suspended",
      cutOffWrite(NOW),
    ]);
  });
});

describe("TenantOpsProcessor: tenant.suspend and tenant.resume", () => {
  const JOB_ID = `${provisionFixture.jobId}-2`;

  function processorWith(housekeeping: {
    suspend?: () => Promise<SuspendOutcome>;
    resume?: () => Promise<ResumeOutcome>;
  }) {
    const added: Array<{ name: string; data: unknown; opts: unknown }> = [];
    const queue = {
      add: (name: string, data: unknown, opts: unknown) => {
        added.push({ name, data, opts });
        return Promise.resolve({ id: "1" });
      },
    } as unknown as Queue;
    const lines: Array<{ level: string; fields: Record<string, unknown>; msg: string }> = [];
    const log = (level: string) => (fields: Record<string, unknown>, msg: string) =>
      void lines.push({ level, fields, msg });
    const logger = { info: log("info"), warn: log("warn"), error: log("error") } as unknown as PinoLogger;
    const suspend = vi.fn(
      housekeeping.suspend ?? (() => Promise.reject(new Error("suspend is not expected"))),
    );
    const resume = vi.fn(housekeeping.resume ?? (() => Promise.reject(new Error("resume is not expected"))));
    const provisioning = {
      provisionTenant: () => Promise.reject(new Error("provisionTenant is not expected")),
      migrateTenant: () => Promise.reject(new Error("migrateTenant is not expected")),
    } as unknown as ProvisioningService;
    const processor = new TenantOpsProcessor(
      provisioning,
      { suspend, resume } as unknown as HousekeepingService,
      new TenantEventsProducer(queue, new FakeClock(NOW) as Clock),
      logger,
    );
    return { processor, suspend, resume, added, lines };
  }

  const message = (name: "tenant.suspend" | "tenant.resume") => ({
    ...provisionFixture,
    name,
    payload: name === "tenant.suspend" ? { reason: "abuse" } : {},
  });

  const job = (name: "tenant.suspend" | "tenant.resume"): Job =>
    ({
      id: JOB_ID,
      name,
      data: message(name),
      queueName: "ota-tenant-ops",
      attemptsMade: 0,
      opts: { attempts: 3 },
    }) as unknown as Job;

  const APPLIED: SuspendOutcome = { status: "applied", expired: 3, held: 1, voids: 2, staffDenied: true };

  it("runs the suspension and answers tenant.suspended with the attempt's job id; the event validates [OBE-074 AC3]", async () => {
    const { processor, suspend, added, lines } = processorWith({ suspend: () => Promise.resolve(APPLIED) });

    const result = await processor.process(job("tenant.suspend"));

    expect(suspend).toHaveBeenCalledWith({ tenantId: TENANT_ID, requestId: JOB_ID });
    expect(result).toEqual({ event: "tenant.suspended", outcome: APPLIED });
    expect(added).toEqual([
      {
        name: "tenant.suspended",
        data: {
          v: 1,
          name: "tenant.suspended",
          jobId: provisionFixture.jobId,
          tenantId: TENANT_ID,
          requestedAt: NOW.toISOString(),
          requestId: provisionFixture.requestId,
          payload: {},
        },
        opts: { jobId: JOB_ID },
      },
    ]);
    // PBE-004's schema of the event (the producer validated it before the add too).
    expect(validateJob("tenant.suspended", added[0]?.data)).toEqual(added[0]?.data);
    expect(lines).toEqual([
      {
        level: "info",
        msg: "tenant_ops.suspended",
        fields: expect.objectContaining({
          tenantId: TENANT_ID,
          reason: "abuse",
          status: "applied",
          expired: 3,
          held: 1,
          voids: 2,
          staffDenied: true,
        }),
      },
    ]);
  });

  it("runs the resumption and answers tenant.resumed; the event validates [OBE-074 AC3]", async () => {
    const { processor, resume, added } = processorWith({
      resume: () => Promise.resolve({ status: "applied", staffDenied: false }),
    });

    const result = await processor.process(job("tenant.resume"));

    expect(resume).toHaveBeenCalledWith({ tenantId: TENANT_ID, requestId: JOB_ID });
    expect(result).toEqual({ event: "tenant.resumed", outcome: { status: "applied", staffDenied: false } });
    expect(added.map(({ name, opts }) => [name, opts])).toEqual([["tenant.resumed", { jobId: JOB_ID }]]);
    expect(validateJob("tenant.resumed", added[0]?.data)).toEqual(
      expect.objectContaining({ name: "tenant.resumed", jobId: provisionFixture.jobId, payload: {} }),
    );
  });

  it("answers a message that no longer matches the tenant's status all the same (a no-op, PADR-0014 item 7)", async () => {
    const { processor, added } = processorWith({
      suspend: () => Promise.resolve({ status: "skipped", tenantStatus: "active" }),
      resume: () => Promise.resolve({ status: "skipped", tenantStatus: "suspended" }),
    });

    expect(await processor.process(job("tenant.suspend"))).toEqual({
      event: "tenant.suspended",
      outcome: { status: "skipped", tenantStatus: "active" },
    });
    expect(await processor.process(job("tenant.resume"))).toEqual({
      event: "tenant.resumed",
      outcome: { status: "skipped", tenantStatus: "suspended" },
    });
    expect(added.map(({ name }) => name)).toEqual(["tenant.suspended", "tenant.resumed"]);
  });

  it("throws a failure of the housekeeping back to BullMQ to try again, logs its code only and publishes nothing", async () => {
    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), {
      code: "57014",
    });
    const redisDown = new Error("Connection is closed.");
    const { processor, added, lines } = processorWith({
      suspend: () => Promise.reject(timeout),
      resume: () => Promise.reject(redisDown),
    });

    const suspendError = await processor.process(job("tenant.suspend")).catch((error: unknown) => error);
    const resumeError = await processor.process(job("tenant.resume")).catch((error: unknown) => error);

    expect(suspendError).toBe(timeout);
    expect(suspendError).not.toBeInstanceOf(UnrecoverableError);
    expect(resumeError).toBe(redisDown);
    expect(added).toEqual([]);
    expect(lines.map(({ level, msg, fields }) => [level, msg, fields["code"]])).toEqual([
      ["warn", "tenant_ops.suspend_failed", "57014"],
      ["warn", "tenant_ops.resume_failed", "Error"],
    ]);
    expect(JSON.stringify(lines)).not.toContain("canceling statement");
  });
});

describe("the schedulers of a suspended tenant (OBE-024; OADR-0014 point 4, PADR-0014 item 3)", () => {
  it("skip it in the queue poller only; ticketing, sync, reconciliation, refunds, expiry and e-mails continue", () => {
    const statuses = new Map(OTA_SCHEDULES.map((schedule) => [schedule.id, schedule.statuses]));
    // New supplier activity: the queue poller's Queue List reads stop while the tenant is suspended.
    expect(statuses.get("queues.poll")).toEqual(["active"]);
    for (const id of [
      "ticketing.scan",
      "bookings.sync_scan",
      "bookings.reconcile_scan",
      "refunds.sweep",
      "notifications.sweep",
      "checkouts.expire",
      "payments.authorisation_watch",
    ]) {
      expect(statuses.get(id), id).toEqual(["active", "suspended"]);
    }
    // The queue poller is the only schedule that leaves a suspended tenant out.
    expect(
      OTA_SCHEDULES.filter((schedule) => !schedule.statuses.includes("suspended")).map(({ id }) => id),
    ).toEqual(["queues.poll"]);
    // The consumers those schedules feed run for a suspended tenant too, and so do the Stripe events and the booking
    // documents of the transactional e-mails (OADR-0014 point 4).
    for (const [name, allowed] of [
      ["ticketing", TICKETING_TENANT_STATUSES],
      ["booking sync", BOOKING_SYNC_TENANT_STATUSES],
      ["reconciliation", RECONCILE_TENANT_STATUSES],
      ["payments and refunds", PAYMENT_JOB_TENANT_STATUSES],
      ["e-mails", NOTIFY_STATUSES],
      ["documents", DOCUMENT_TENANT_STATUSES],
      ["Stripe events", WEBHOOK_TENANT_STATUSES],
    ] as const) {
      expect(allowed, name).toEqual(["active", "suspended"]);
    }
  });
});
