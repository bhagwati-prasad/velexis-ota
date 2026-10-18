// AmadeusAccountsService without a database or Redis (PBE-020; platform/docs/api-inventory-admin.md §5): the answers
// that the integration tests cannot provoke on a working Redis and a test configuration, that is
// `adminVerifyAmadeusAccount` while Redis does not take the job (`503 SERVICE_UNAVAILABLE`, and no audit row), its
// move of a disabled account to `pending_verification` before the enqueue, the verification enqueue that never fails a
// committed create or update, and the refusal of the loopback stub as a base URL in production.
import type { ConfigService } from "@nestjs/config";
import { AppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import type { Queue } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditService } from "../audit/audit.service";
import type { AccountAuthStates } from "../common/auth/admin-auth.guard";
import type { EnvelopeService } from "../common/crypto.provider";
import type { PlatformDb } from "../common/database";
import { IdGenerator } from "../common/ids";
import type { InvalidationPublisher } from "../common/redis/invalidation.publisher";
import type { PlatformBackendConfig } from "../config";
import type { AmadeusAccountsRepository } from "./amadeus-accounts.repository";
import { AmadeusAccountsService, VERIFY_ENQUEUE_TIMEOUT_MS } from "./amadeus-accounts.service";
import { AMADEUS_ACCOUNT_VERIFY_JOB } from "./verification.processor";

const ACCOUNT_ID = "ama_01JATESTRW0000000000000001";
const ADMIN = { sub: "acc_01JATESTRW0000000000000001" };

interface Harness {
  readonly service: AmadeusAccountsService;
  readonly added: Array<{ name: string; data: unknown }>;
  readonly warnings: string[];
  readonly audited: unknown[];
  readonly transactions: { count: number };
  /** The verification fields written to the account, and the invalidations published. */
  readonly written: unknown[];
  readonly published: unknown[];
  /** The order of the writes and the enqueue (`write`, `add`). */
  readonly steps: string[];
}

function harness(options: {
  readonly add: () => Promise<unknown>;
  readonly appEnv?: PlatformBackendConfig["APP_ENV"];
  /** The stored account's status (`active` by default). */
  readonly status?: string;
}): Harness {
  const added: Harness["added"] = [];
  const warnings: string[] = [];
  const audited: unknown[] = [];
  const transactions = { count: 0 };
  const written: unknown[] = [];
  const published: unknown[] = [];
  const steps: string[] = [];
  let status = options.status ?? "active";
  const account = (id: string) =>
    Promise.resolve(id === ACCOUNT_ID ? { id, environment: "test", status } : undefined);
  const clock = new FakeClock();
  const queue = {
    add: (name: string, data: unknown) => {
      added.push({ name, data });
      steps.push("add");
      return options.add();
    },
  } as unknown as Queue;
  const db = {
    transaction: () => ({
      execute: (fn: (trx: object) => Promise<unknown>) => {
        transactions.count += 1;
        return fn({});
      },
    }),
  } as unknown as PlatformDb;
  const service = new AmadeusAccountsService(
    {
      find: account,
      lock: (_trx: unknown, id: string) => account(id),
      recordVerification: (_trx: unknown, id: string, fields: { status: string }) => {
        written.push(fields);
        steps.push("write");
        status = fields.status;
        return account(id);
      },
    } as unknown as AmadeusAccountsRepository,
    {
      record: (_trx: unknown, entry: unknown) => Promise.resolve(void audited.push(entry)),
    } as unknown as AuditService,
    {
      publishAfterCommit: (_trx: unknown, event: unknown) => void published.push(event),
    } as unknown as InvalidationPublisher,
    {} as AccountAuthStates,
    {} as EnvelopeService,
    new IdGenerator(clock),
    clock,
    db,
    queue,
    { warn: (_fields: unknown, msg: string) => warnings.push(msg) } as unknown as PinoLogger,
    { get: () => options.appEnv ?? "test" } as unknown as ConfigService<PlatformBackendConfig, true>,
  );
  return { service, added, warnings, audited, transactions, written, published, steps };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AmadeusAccountsService", () => {
  it("queues amadeus_account.verify { amadeusAccountId } and then audits adminVerifyAmadeusAccount", async () => {
    const { service, added, audited } = harness({ add: () => Promise.resolve({ id: "1" }) });

    await service.requestVerification(ADMIN, ACCOUNT_ID);

    expect(added).toEqual([{ name: AMADEUS_ACCOUNT_VERIFY_JOB, data: { amadeusAccountId: ACCOUNT_ID } }]);
    expect(audited).toEqual([
      expect.objectContaining({
        actorType: "platform_admin",
        actorAccountId: ADMIN.sub,
        action: "amadeus_account.verification_requested",
        targetId: ACCOUNT_ID,
      }),
    ]);
  });

  it("takes a disabled account to pending_verification before it queues the job, and a 503 leaves it there", async () => {
    const queued = harness({ add: () => Promise.resolve({ id: "1" }), status: "disabled" });

    await queued.service.requestVerification(ADMIN, ACCOUNT_ID);

    // The job leaves a disabled account alone, so the account must leave `disabled` before the job can run.
    expect(queued.steps).toEqual(["write", "add"]);
    expect(queued.written).toEqual([{ status: "pending_verification", last_error: null }]);
    expect(queued.published).toEqual([{ v: 1, type: "amadeus_account", id: ACCOUNT_ID }]);
    expect(queued.audited).toEqual([
      expect.objectContaining({
        actorType: "platform_admin",
        actorAccountId: ADMIN.sub,
        action: "amadeus_account.verification_requested",
        targetId: ACCOUNT_ID,
        before: { status: "disabled" },
        after: { status: "pending_verification" },
      }),
    ]);

    const refused = harness({
      add: () => Promise.reject(new Error("Connection is closed.")),
      status: "disabled",
    });
    await expect(refused.service.requestVerification(ADMIN, ACCOUNT_ID)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(refused.written).toEqual([{ status: "pending_verification", last_error: null }]);
    expect(refused.audited).toHaveLength(1);
  });

  it("answers 503 SERVICE_UNAVAILABLE and writes nothing when Redis refuses or does not answer the job", async () => {
    const refused = harness({ add: () => Promise.reject(new Error("Connection is closed.")) });
    await expect(refused.service.requestVerification(ADMIN, ACCOUNT_ID)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(refused.audited).toEqual([]);
    expect(refused.transactions.count).toBe(0);
    expect(refused.warnings).toEqual(["amadeus_account.enqueue_failed"]);

    vi.useFakeTimers();
    const silent = harness({ add: () => new Promise(() => undefined) });
    const pending = silent.service.requestVerification(ADMIN, ACCOUNT_ID);
    const outcome = expect(pending).rejects.toBeInstanceOf(AppError);
    await vi.advanceTimersByTimeAsync(VERIFY_ENQUEUE_TIMEOUT_MS);
    await outcome;
    expect(silent.audited).toEqual([]);
    expect(silent.warnings).toEqual(["amadeus_account.enqueue_timeout"]);
  });

  it("answers 404 for an unknown account without queuing anything", async () => {
    const { service, added } = harness({ add: () => Promise.resolve({ id: "1" }) });

    await expect(service.requestVerification(ADMIN, "ama_01JATESTRW0000000000000999")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(added).toEqual([]);
  });

  it("never throws from the enqueue a committed create or update calls", async () => {
    const { service } = harness({ add: () => Promise.reject(new Error("Connection is closed.")) });

    await expect(service.enqueueVerification(ACCOUNT_ID)).resolves.toBe(false);
  });

  it("refuses the loopback stub as a base URL in production, before anything is encrypted or written", async () => {
    const { service, transactions } = harness({ add: () => Promise.resolve({}), appEnv: "production" });

    const refusal = service.create(ADMIN, {
      name: "Velexis test",
      environment: "test",
      baseUrl: "http://127.0.0.1:4900",
      clientId: "velexis-test-client",
      clientSecret: "not-a-real-secret",
    });

    await expect(refusal).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      fieldErrors: [expect.objectContaining({ path: "/baseUrl", code: "https" })],
    });
    expect(transactions.count).toBe(0);
  });
});
