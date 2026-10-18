// The dispatch of provisioning jobs without a database or Redis (PBE-019; platform/docs/flows/provisioning.md §1,
// PADR-0001 items 2 to 4): the gate, the checks in their order, the message and its BullMQ options, and
// ProvisioningDispatcher on a fake transaction and a fake queue: the add comes after the commit, never for a job that
// may not go out, and never fails the caller. The integration test (test/integration/provisioning/dispatch.int.test.ts)
// runs the same on PostgreSQL and Redis, with concurrent dispatches and the fake OTA worker.
import provisionFixture from "@velexis/api-types/fixtures/jobs/tenant-provision.json";
import { MessageValidationError, validateJob } from "@velexis/api-types/jobs";
import { FakeClock } from "@velexis/testing";
import type { JobsOptions, Queue } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PlatformDb } from "../common/database";
import type { RequestContext } from "../common/http/request-context";
import {
  checkDispatch,
  DISPATCH_ENQUEUE_TIMEOUT_MS,
  DISPATCH_LEASE_MS,
  isProvisionGateOpen,
  ProvisioningDispatcher,
  tenantOpsJobOptions,
  tenantOpsMessage,
  type ProvisionGateInput,
} from "./dispatcher";
import type {
  DispatchCandidateRow,
  DispatchTransition,
  ProvisioningJobsRepository,
} from "./provisioning-jobs.repository";

const JOB_ID = "job_01M4T9HVE0355QAKGD2AVSQWH2";
const TENANT_ID = "ten_01M4T9E68084G7ZWYRD6Z1RV0W";
const REQUEST_ID = "6f1c2b7e-0d4a-4c9e-8b3f-2a5d9e7c1b40";

beforeAll(() => {
  // validateJob compiles every message schema with Ajv on its first call: once here, not inside a test. 30 s covers a
  // slow CI runner.
  validateJob("tenant.provision", provisionFixture);
}, 30_000);

afterEach(() => {
  vi.useRealTimers();
});

/** A `provision` job of a `provisioning` tenant on a manual trial, due now, as lockForDispatch reads it. */
function candidate(overrides: Partial<DispatchCandidateRow> = {}): DispatchCandidateRow {
  return {
    id: JOB_ID,
    tenant_id: TENANT_ID,
    kind: "provision",
    status: "queued",
    scheduled_at: new Date("2026-01-15T10:00:00.000Z"),
    payload: {},
    tenant_status: "provisioning",
    subscription_status: "trialing",
    billing_provider: "manual",
    ...overrides,
  };
}

describe("isProvisionGateOpen", () => {
  const gate = (
    tenantStatus: string,
    subscription: ProvisionGateInput["subscription"],
  ): ProvisionGateInput => ({ tenantStatus, subscription });

  it("opens for a provisioning tenant whose current subscription is trialing, active or manual", () => {
    expect(
      [
        gate("provisioning", { status: "trialing", billingProvider: "manual" }),
        gate("provisioning", { status: "trialing", billingProvider: "stripe" }),
        gate("provisioning", { status: "active", billingProvider: "stripe" }),
        gate("provisioning", { status: "incomplete", billingProvider: "manual" }),
      ].map(isProvisionGateOpen),
    ).toEqual([true, true, true, true]);
  });

  it("[PBE-019 AC2] stays closed while the Stripe subscription is incomplete, for any other Stripe status, without a current subscription and for a tenant that is not provisioning", () => {
    expect(
      [
        gate("provisioning", { status: "incomplete", billingProvider: "stripe" }),
        gate("provisioning", { status: "past_due", billingProvider: "stripe" }),
        gate("provisioning", { status: "paused", billingProvider: "stripe" }),
        gate("provisioning", { status: "unpaid", billingProvider: "stripe" }),
        gate("provisioning", null),
        gate("active", { status: "trialing", billingProvider: "manual" }),
        gate("failed", { status: "trialing", billingProvider: "manual" }),
        gate("suspended", { status: "active", billingProvider: "stripe" }),
      ].map(isProvisionGateOpen),
    ).toEqual([false, false, false, false, false, false, false, false]);
  });
});

describe("checkDispatch", () => {
  const now = new Date("2026-01-15T10:00:00.000Z");

  it("names the message of a queued, due job whose gate is open", () => {
    expect(checkDispatch(candidate(), now)).toEqual({ name: "tenant.provision" });
    expect(checkDispatch(candidate({ scheduled_at: new Date(now.getTime() - 1) }), now)).toEqual({
      name: "tenant.provision",
    });
  });

  it("refuses a job that is not queued, not due, of a kind without a message, or behind a closed gate, in that order", () => {
    const reasons = [
      candidate({ status: "running" }),
      candidate({ status: "failed", tenant_status: "failed" }),
      candidate({ scheduled_at: new Date(now.getTime() + 1) }),
      candidate({ kind: "export" }),
      candidate({ kind: "rotate_secrets", status: "succeeded" }),
      candidate({ subscription_status: "incomplete", billing_provider: "stripe" }),
      candidate({ subscription_status: null, billing_provider: null }),
    ].map((job) => {
      const checked = checkDispatch(job, now);
      return "dispatched" in checked ? `${checked.reason} (${checked.status ?? "none"})` : checked.name;
    });

    expect(reasons).toEqual([
      "not_queued (running)",
      "not_queued (failed)",
      "not_due (queued)",
      "unsupported_kind (queued)",
      "not_queued (succeeded)",
      "gate_closed (queued)",
      "gate_closed (queued)",
    ]);
  });

  it("applies the gate to provision jobs only: migrate, suspend and resume go out whatever the subscription", () => {
    const closed = { subscription_status: "incomplete", billing_provider: "stripe" } as const;

    expect(
      [
        candidate({ ...closed, kind: "migrate", tenant_status: "active" }),
        candidate({ ...closed, kind: "suspend", tenant_status: "suspended" }),
        candidate({
          subscription_status: null,
          billing_provider: null,
          kind: "resume",
          tenant_status: "active",
        }),
      ].map((job) => checkDispatch(job, now)),
    ).toEqual([{ name: "tenant.migrate" }, { name: "tenant.suspend" }, { name: "tenant.resume" }]);
  });
});

describe("tenantOpsMessage", () => {
  it("[PBE-019 AC3] builds the tenant.provision message of the shared fixture, valid against its JSON Schema", () => {
    const message = tenantOpsMessage({
      name: "tenant.provision",
      jobId: provisionFixture.jobId,
      tenantId: provisionFixture.tenantId,
      payload: {},
      requestedAt: new Date(provisionFixture.requestedAt),
      requestId: provisionFixture.requestId,
    });

    expect(message).toEqual(provisionFixture);
    expect(validateJob("tenant.provision", message)).toEqual(message);
  });

  it("[PBE-019 AC3] carries the job's payload: targetVersion for tenant.migrate, reason for tenant.suspend", () => {
    const base = { jobId: JOB_ID, tenantId: TENANT_ID, requestedAt: new Date(0), requestId: REQUEST_ID };

    expect(
      tenantOpsMessage({
        ...base,
        name: "tenant.migrate",
        payload: { targetVersion: "0002_add_mvp_tenant_deltas" },
      }).payload,
    ).toEqual({ targetVersion: "0002_add_mvp_tenant_deltas" });
    expect(
      tenantOpsMessage({ ...base, name: "tenant.suspend", payload: { reason: "admin" } }).payload,
    ).toEqual({
      reason: "admin",
    });
  });

  it("refuses a payload outside the message's contract and a request id of another shape, naming paths only", () => {
    const base = { jobId: JOB_ID, tenantId: TENANT_ID, requestedAt: new Date(0), requestId: REQUEST_ID };
    const attempts = [
      () =>
        tenantOpsMessage({
          ...base,
          name: "tenant.provision",
          payload: { clientSecret: "not-a-real-secret" },
        }),
      () => tenantOpsMessage({ ...base, name: "tenant.suspend", payload: {} }),
      () => tenantOpsMessage({ ...base, name: "tenant.provision", payload: {}, requestId: "short" }),
    ];

    const errors = attempts.map((attempt) => {
      try {
        attempt();
        return "accepted";
      } catch (error) {
        expect(error).toBeInstanceOf(MessageValidationError);
        expect((error as Error).message).not.toContain("not-a-real-secret");
        return (error as MessageValidationError).issues.map((issue) => issue.path).join(", ");
      }
    });

    expect(errors).toEqual(["/payload/clientSecret", "/payload/reason", "/requestId"]);
  });
});

describe("tenantOpsJobOptions", () => {
  it("gives attempt n the BullMQ id <jobId>-<n>, 3 tries and an exponential backoff from 30 s", () => {
    expect(tenantOpsJobOptions(JOB_ID, 1)).toEqual({
      jobId: `${JOB_ID}-1`,
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
    });
    expect(tenantOpsJobOptions(JOB_ID, 4).jobId).toBe(`${JOB_ID}-4`);
  });
});

interface Harness {
  readonly dispatcher: ProvisioningDispatcher;
  readonly clock: FakeClock;
  /** What happened, in order: `lock`, `update`, `commit`, `rollback`, `add`. */
  readonly events: string[];
  readonly transitions: DispatchTransition[];
  readonly added: Array<{ name: string; data: unknown; opts: JobsOptions }>;
  readonly logs: Array<{ level: string; fields: Record<string, unknown>; msg: string }>;
}

interface HarnessOptions {
  readonly job?: DispatchCandidateRow | undefined;
  /** The attempt markDispatched returns; `undefined` when no row changed. */
  readonly attempt?: number | undefined;
  readonly add?: () => Promise<unknown>;
  readonly requestId?: string;
}

function harness(options: HarnessOptions = {}): Harness {
  const clock = new FakeClock();
  const events: string[] = [];
  const transitions: DispatchTransition[] = [];
  const added: Harness["added"] = [];
  const logs: Harness["logs"] = [];
  const job = "job" in options ? options.job : candidate();
  const attempt = "attempt" in options ? options.attempt : 1;
  const repository = {
    lockForDispatch: () => {
      events.push("lock");
      return Promise.resolve(job);
    },
    markDispatched: (_trx: unknown, transition: DispatchTransition) => {
      events.push("update");
      transitions.push(transition);
      return Promise.resolve(attempt);
    },
  } as unknown as ProvisioningJobsRepository;
  // runInTransaction's view of Kysely: `transaction().execute(fn)`, committing when fn resolves.
  const db = {
    transaction: () => ({
      execute: async (fn: (trx: object) => Promise<unknown>) => {
        try {
          const result = await fn({});
          events.push("commit");
          return result;
        } catch (error) {
          events.push("rollback");
          throw error;
        }
      },
    }),
  } as unknown as PlatformDb;
  const queue = {
    add: (name: string, data: unknown, opts: JobsOptions) => {
      events.push("add");
      added.push({ name, data, opts });
      return options.add === undefined ? Promise.resolve({}) : options.add();
    },
  } as unknown as Queue;
  const log =
    (level: string) =>
    (fields: Record<string, unknown>, msg: string): void => {
      logs.push({ level, fields, msg });
    };
  const logger = { info: log("info"), warn: log("warn") } as unknown as PinoLogger;
  const requestContext =
    options.requestId === undefined ? undefined : ({ requestId: options.requestId } as RequestContext);
  const dispatcher = new ProvisioningDispatcher(repository, db, clock, queue, logger, requestContext);
  return { dispatcher, clock, events, transitions, added, logs };
}

describe("ProvisioningDispatcher.dispatch", () => {
  it("[PBE-019 AC3] moves the job to running with a 15-minute lease, then adds the validated message after the commit", async () => {
    const h = harness({ requestId: REQUEST_ID });
    const now = h.clock.now();

    const result = await h.dispatcher.dispatch(JOB_ID);

    expect(h.events).toEqual(["lock", "update", "commit", "add"]);
    expect(h.transitions).toEqual([
      { jobId: JOB_ID, now, lockedUntil: new Date(now.getTime() + DISPATCH_LEASE_MS) },
    ]);
    expect(DISPATCH_LEASE_MS).toBe(15 * 60 * 1000);
    expect(h.added).toEqual([
      {
        name: "tenant.provision",
        data: {
          v: 1,
          name: "tenant.provision",
          jobId: JOB_ID,
          tenantId: TENANT_ID,
          requestedAt: now.toISOString(),
          requestId: REQUEST_ID,
          payload: {},
        },
        opts: { jobId: `${JOB_ID}-1`, attempts: 3, backoff: { type: "exponential", delay: 30_000 } },
      },
    ]);
    expect(validateJob("tenant.provision", h.added[0]?.data)).toBeDefined();
    expect(result).toEqual({
      dispatched: true,
      jobId: JOB_ID,
      tenantId: TENANT_ID,
      kind: "provision",
      attempt: 1,
      bullmqJobId: `${JOB_ID}-1`,
      enqueued: true,
    });
    expect(h.logs.map(({ level, msg }) => `${level} ${msg}`)).toEqual(["info provisioning.dispatched"]);
  });

  it("[PBE-019 AC2] changes and adds nothing when the gate is closed (Stripe subscription incomplete)", async () => {
    const h = harness({ job: candidate({ subscription_status: "incomplete", billing_provider: "stripe" }) });

    const result = await h.dispatcher.dispatch(JOB_ID);

    expect(result).toEqual({ dispatched: false, jobId: JOB_ID, reason: "gate_closed", status: "queued" });
    expect(h.events).toEqual(["lock", "commit"]);
    expect(h.added).toEqual([]);
    expect(h.logs).toEqual([
      {
        level: "info",
        fields: { jobId: JOB_ID, reason: "gate_closed", status: "queued" },
        msg: "provisioning.not_dispatched",
      },
    ]);
  });

  it("[PBE-019 AC1] adds nothing for a job another dispatch moved to running, nor for an unknown job", async () => {
    const running = harness({ job: candidate({ status: "running" }) });
    const unknown = harness({ job: undefined });

    expect(await running.dispatcher.dispatch(JOB_ID)).toEqual({
      dispatched: false,
      jobId: JOB_ID,
      reason: "not_queued",
      status: "running",
    });
    expect(await unknown.dispatcher.dispatch(JOB_ID)).toEqual({
      dispatched: false,
      jobId: JOB_ID,
      reason: "not_found",
      status: null,
    });
    expect([...running.added, ...unknown.added]).toEqual([]);
    expect([running.events, unknown.events]).toEqual([
      ["lock", "commit"],
      ["lock", "commit"],
    ]);
  });

  it("adds nothing when the conditional update changes no row", async () => {
    const h = harness({ attempt: undefined });

    const result = await h.dispatcher.dispatch(JOB_ID);

    expect(result).toEqual({ dispatched: false, jobId: JOB_ID, reason: "not_due", status: "queued" });
    expect(h.events).toEqual(["lock", "update", "commit"]);
  });

  it("rolls the update back and adds nothing when the job's payload is not a valid message", async () => {
    const h = harness({ job: candidate({ payload: { clientSecret: "not-a-real-secret" } }) });

    await expect(h.dispatcher.dispatch(JOB_ID)).rejects.toBeInstanceOf(MessageValidationError);
    expect(h.events).toEqual(["lock", "update", "rollback"]);
    expect(h.added).toEqual([]);
  });

  it("uses the caller's request id first, then the HTTP request's, else a new one", async () => {
    const fromCaller = harness({ requestId: REQUEST_ID });
    const fromRequest = harness({ requestId: "req-from-the-http-request" });
    const fresh = harness();

    await fromCaller.dispatcher.dispatch(JOB_ID, { requestId: "job-run-0001" });
    await fromRequest.dispatcher.dispatch(JOB_ID);
    await fresh.dispatcher.dispatch(JOB_ID);

    const requestIdOf = (h: Harness): unknown => (h.added[0]?.data as { requestId?: unknown }).requestId;
    expect(requestIdOf(fromCaller)).toBe("job-run-0001");
    expect(requestIdOf(fromRequest)).toBe("req-from-the-http-request");
    expect(requestIdOf(fresh)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("never fails the caller when Redis refuses the add: the job stays running for the reconciler", async () => {
    const h = harness({ add: () => Promise.reject(new Error("Connection is closed.")) });

    const result = await h.dispatcher.dispatch(JOB_ID);

    expect(result).toMatchObject({ dispatched: true, attempt: 1, enqueued: false });
    expect(
      h.logs.map(({ level, msg, fields }) => `${level} ${msg} ${String(fields["bullmqJobId"])}`),
    ).toEqual([`warn provisioning.enqueue_failed ${JOB_ID}-1`]);
  });

  it("gives up waiting for Redis after DISPATCH_ENQUEUE_TIMEOUT_MS without failing the caller", async () => {
    vi.useFakeTimers();
    const h = harness({ add: () => new Promise(() => undefined) });

    const pending = h.dispatcher.dispatch(JOB_ID);
    await vi.advanceTimersByTimeAsync(DISPATCH_ENQUEUE_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({ dispatched: true, enqueued: false });
    expect(h.logs.map(({ level, msg }) => `${level} ${msg}`)).toEqual(["warn provisioning.enqueue_timeout"]);
  });
});
