// AmadeusAccountsService without a database or Redis (PBE-020; platform/docs/api-inventory-admin.md §5): the answers
// that the integration tests cannot provoke on a working Redis and a test configuration, that is
// `adminVerifyAmadeusAccount` while Redis does not take the job (`503 SERVICE_UNAVAILABLE`, and no audit row), its
// move of a disabled account to `pending_verification` before the enqueue, the verification enqueue that never fails a
// committed create or update, and the refusal of the loopback stub as a base URL in production. PBE-074 adds the
// official Amadeus host rule of production (create and update, both environments, a trailing slash, look-alike hosts,
// the order of the checks) and the same requests outside production; the integration test covers it through the API.
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
import { AMADEUS_OFFICIAL_BASE_URLS, type PlatformBackendConfig } from "../config";
import type { AmadeusAccountsRepository } from "./amadeus-accounts.repository";
import {
  AmadeusAccountsService,
  OFFICIAL_HOST_CODE,
  OFFICIAL_HOST_MESSAGE,
  VERIFY_ENQUEUE_TIMEOUT_MS,
  type CreateAmadeusAccountRequest,
} from "./amadeus-accounts.service";
import { AMADEUS_ACCOUNT_VERIFY_JOB } from "./verification.processor";

const ACCOUNT_ID = "ama_01JATESTRW0000000000000001";
const ADMIN = { sub: "acc_01JATESTRW0000000000000001" };
/** The official Amadeus host of each environment (config.ts). */
const OFFICIAL = {
  test: AMADEUS_OFFICIAL_BASE_URLS.AMADEUS_BASE_URL_TEST,
  live: AMADEUS_OFFICIAL_BASE_URLS.AMADEUS_BASE_URL_LIVE,
} as const;

interface Harness {
  readonly service: AmadeusAccountsService;
  readonly added: Array<{ name: string; data: unknown }>;
  readonly warnings: string[];
  readonly audited: unknown[];
  readonly transactions: { count: number };
  /** The verification fields written to the account, and the invalidations published. */
  readonly written: unknown[];
  readonly published: unknown[];
  /** The order of the encryption, the writes and the enqueue (`encrypt`, `insert`, `update`, `write`, `add`). */
  readonly steps: string[];
  /** The changes of `update` written to the account. */
  readonly updated: unknown[];
  /** Claims of the admin with a TOTP step-up now. */
  readonly stepUp: { readonly sub: string; readonly mfa_at: number };
}

function harness(options: {
  readonly add: () => Promise<unknown>;
  readonly appEnv?: PlatformBackendConfig["APP_ENV"];
  /** The stored account's status (`active` by default). */
  readonly status?: string;
  /** The stored account's environment (`test` by default) and base URL (that environment's official host). */
  readonly environment?: "test" | "live";
  readonly baseUrl?: string;
}): Harness {
  const added: Harness["added"] = [];
  const warnings: string[] = [];
  const audited: unknown[] = [];
  const transactions = { count: 0 };
  const written: unknown[] = [];
  const published: unknown[] = [];
  const steps: string[] = [];
  const updated: unknown[] = [];
  let status = options.status ?? "active";
  const clock = new FakeClock();
  const environment = options.environment ?? "test";
  /** The stored account, as `platform.amadeus_accounts` holds it (a dummy ciphertext). */
  const record = (id: string) => ({
    id,
    name: `Velexis ${environment}`,
    environment,
    base_url: options.baseUrl ?? OFFICIAL[environment],
    client_id: "velexis-test-client",
    client_secret_ciphertext: Buffer.from([1, 2, 3]),
    encryption_key_id: "local:v1",
    status,
    last_verified_at: null,
    last_error: null,
    created_by_account_id: ADMIN.sub,
    created_at: clock.now(),
    updated_at: clock.now(),
    version: 1,
  });
  const account = (id: string) => Promise.resolve(id === ACCOUNT_ID ? record(id) : undefined);
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
      insertIfNew: (_trx: unknown, row: Record<string, unknown>) => {
        steps.push("insert");
        return Promise.resolve({
          ...row,
          status: "pending_verification",
          last_verified_at: null,
          last_error: null,
          version: 1,
        });
      },
      update: (_trx: unknown, id: string, changes: Record<string, unknown>) => {
        updated.push(changes);
        steps.push("update");
        return Promise.resolve({ ...record(id), ...changes, version: 2 });
      },
      officeCounts: () => Promise.resolve(new Map()),
    } as unknown as AmadeusAccountsRepository,
    {
      record: (_trx: unknown, entry: unknown) => Promise.resolve(void audited.push(entry)),
    } as unknown as AuditService,
    {
      publishAfterCommit: (_trx: unknown, event: unknown) => void published.push(event),
    } as unknown as InvalidationPublisher,
    {
      read: () => Promise.resolve({ status: "active", isPlatformAdmin: true, mfaEnabled: true }),
    } as unknown as AccountAuthStates,
    {
      // A dummy envelope: the step is what the tests look at, never a secret.
      encrypt: () => {
        steps.push("encrypt");
        return Promise.resolve({ ciphertext: new Uint8Array([1, 2, 3]), kekId: "local:v1" });
      },
    } as unknown as EnvelopeService,
    new IdGenerator(clock),
    clock,
    db,
    queue,
    { warn: (_fields: unknown, msg: string) => warnings.push(msg) } as unknown as PinoLogger,
    { get: () => options.appEnv ?? "test" } as unknown as ConfigService<PlatformBackendConfig, true>,
  );
  const stepUp = { sub: ADMIN.sub, mfa_at: Math.floor(clock.now().getTime() / 1000) };
  return { service, added, warnings, audited, transactions, written, published, steps, updated, stepUp };
}

/** A create request of `environment` on `baseUrl`, with dummy credentials. */
function createRequest(environment: "test" | "live", baseUrl: string): CreateAmadeusAccountRequest {
  return {
    name: `Velexis ${environment}`,
    environment,
    baseUrl,
    clientId: "velexis-test-client",
    clientSecret: "not-a-real-secret",
  };
}

const queued = () => Promise.resolve({ id: "1" });

/** The refusal of a base URL that is not the official host of the account's environment (PBE-074). */
const OFFICIAL_HOST_REFUSAL = {
  code: "VALIDATION_FAILED",
  fieldErrors: [{ path: "/baseUrl", code: OFFICIAL_HOST_CODE, message: OFFICIAL_HOST_MESSAGE }],
};

/** Base URLs that are not the official Amadeus host of the environment, each `https` and valid for the contract. */
const NOT_OFFICIAL: ReadonlyArray<readonly ["test" | "live", string, string]> = [
  ["test", OFFICIAL.live, "the live host for a test account"],
  ["live", OFFICIAL.test, "the test host for a live account"],
  ["live", "https://travel.api.amadeus.com.example.net", "a look-alike host"],
  ["test", "https://test.travel.api.amadeus.com.example.net/", "a look-alike host with a trailing slash"],
  ["live", "https://amadeus.example.com", "another https host"],
  ["live", `${OFFICIAL.live}/v1`, "the official host with a path"],
  ["test", `${OFFICIAL.test}//`, "the official host with two trailing slashes"],
];

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

describe("AmadeusAccountsService: the official Amadeus host with APP_ENV=production (PBE-074)", () => {
  it("[PBE-074 AC1] the refusal's message names the two official hosts", () => {
    expect(OFFICIAL_HOST_CODE).toBe("official_host");
    expect(OFFICIAL_HOST_MESSAGE).toContain("https://test.travel.api.amadeus.com for test");
    expect(OFFICIAL_HOST_MESSAGE).toContain("https://travel.api.amadeus.com for live");
  });

  it.each(NOT_OFFICIAL)(
    "[PBE-074 AC1] refuses a %s account on %s (%s): 400 /baseUrl official_host, nothing encrypted, stored, audited or queued",
    async (environment, baseUrl) => {
      const h = harness({ add: queued, appEnv: "production" });

      await expect(h.service.create(ADMIN, createRequest(environment, baseUrl))).rejects.toMatchObject(
        OFFICIAL_HOST_REFUSAL,
      );
      expect(h.steps).toEqual([]);
      expect(h.transactions.count).toBe(0);
      expect(h.audited).toEqual([]);
      expect(h.added).toEqual([]);
    },
  );

  it("[PBE-074 AC1] creates the account of each environment on its official host, with or without a trailing slash", async () => {
    for (const [environment, baseUrl] of [
      ["test", OFFICIAL.test],
      ["test", `${OFFICIAL.test}/`],
      ["live", OFFICIAL.live],
      ["live", `${OFFICIAL.live}/`],
    ] as const) {
      const h = harness({ add: queued, appEnv: "production" });

      const created = await h.service.create(ADMIN, createRequest(environment, baseUrl));

      expect(created).toMatchObject({ environment, baseUrl, status: "pending_verification" });
      expect(h.steps).toEqual(["encrypt", "insert", "add"]);
      expect(h.audited).toEqual([expect.objectContaining({ action: "amadeus_account.created" })]);
      expect(h.added).toEqual([{ name: AMADEUS_ACCOUNT_VERIFY_JOB, data: { amadeusAccountId: created.id } }]);
    }
  });

  it("[PBE-074 AC1] keeps the https refusal of the loopback stub, for a create and an update, before the official host rule", async () => {
    const h = harness({ add: queued, appEnv: "production" });
    const https = {
      code: "VALIDATION_FAILED",
      fieldErrors: [expect.objectContaining({ path: "/baseUrl", code: "https" })],
    };

    await expect(
      h.service.create(ADMIN, createRequest("test", "http://127.0.0.1:4900")),
    ).rejects.toMatchObject(https);
    await expect(
      h.service.update(h.stepUp, ACCOUNT_ID, 1, { baseUrl: "http://127.0.0.1:4900" }),
    ).rejects.toMatchObject(https);
    expect(h.steps).toEqual([]);
    expect(h.transactions.count).toBe(0);
  });

  it.each(NOT_OFFICIAL)(
    "[PBE-074 AC1] refuses an update of a stored %s account's base URL alone to %s (%s): nothing written, audited, published or queued",
    async (environment, baseUrl) => {
      const h = harness({ add: queued, appEnv: "production", environment });

      await expect(h.service.update(h.stepUp, ACCOUNT_ID, 1, { baseUrl })).rejects.toMatchObject(
        OFFICIAL_HOST_REFUSAL,
      );
      expect(h.steps).toEqual([]);
      expect(h.audited).toEqual([]);
      expect(h.published).toEqual([]);
      expect(h.added).toEqual([]);
    },
  );

  it("[PBE-074 AC1] checks an update against the stored account's environment, after the 404 and before the 412 and the step-up", async () => {
    const h = harness({ add: queued, appEnv: "production", environment: "live" });

    // The live host is the official one of a live account, never of a test account (and the other way round).
    await expect(h.service.update(h.stepUp, ACCOUNT_ID, 1, { baseUrl: OFFICIAL.test })).rejects.toMatchObject(
      OFFICIAL_HOST_REFUSAL,
    );
    // An unknown account answers 404 first; a stale version or a missing step-up does not hide the refusal.
    await expect(
      h.service.update(h.stepUp, "ama_01JATESTRW0000000000000999", 1, { baseUrl: OFFICIAL.test }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(h.service.update(h.stepUp, ACCOUNT_ID, 7, { baseUrl: OFFICIAL.test })).rejects.toMatchObject(
      OFFICIAL_HOST_REFUSAL,
    );
    await expect(
      h.service.update(ADMIN, ACCOUNT_ID, 1, { baseUrl: OFFICIAL.test, clientSecret: "not-a-real-secret" }),
    ).rejects.toMatchObject(OFFICIAL_HOST_REFUSAL);
    await expect(h.service.update(h.stepUp, ACCOUNT_ID, 7, { baseUrl: OFFICIAL.live })).rejects.toMatchObject(
      {
        code: "PRECONDITION_FAILED",
      },
    );
    await expect(
      h.service.update(ADMIN, ACCOUNT_ID, 1, { baseUrl: `${OFFICIAL.live}/` }),
    ).rejects.toMatchObject({
      code: "REAUTH_REQUIRED",
    });
    expect(h.updated).toEqual([]);
    expect(h.audited).toEqual([]);
    expect(h.added).toEqual([]);
  });

  it("[PBE-074 AC1] updates the base URL alone to the official host of the stored environment, with or without a trailing slash", async () => {
    for (const [environment, baseUrl] of [
      ["test", `${OFFICIAL.test}/`],
      ["live", `${OFFICIAL.live}/`],
    ] as const) {
      const h = harness({
        add: queued,
        appEnv: "production",
        environment,
        baseUrl: "https://amadeus.example.com",
      });

      const updated = await h.service.update(h.stepUp, ACCOUNT_ID, 1, { baseUrl });

      expect(updated).toMatchObject({ environment, baseUrl, status: "pending_verification", version: 2 });
      expect(h.steps).toEqual(["update", "add"]);
      expect(h.updated).toEqual([
        expect.objectContaining({ base_url: baseUrl, status: "pending_verification", last_error: null }),
      ]);
      expect(h.audited).toEqual([
        expect.objectContaining({
          action: "amadeus_account.updated",
          after: expect.objectContaining({ baseUrl }),
        }),
      ]);
      expect(h.added).toEqual([{ name: AMADEUS_ACCOUNT_VERIFY_JOB, data: { amadeusAccountId: ACCOUNT_ID } }]);
    }
  });

  it("[PBE-074 AC1] checks every base URL sent, the stored one too, and no request without one", async () => {
    // An account entered with another host before the rule: it takes the official host before its name changes.
    const h = harness({ add: queued, appEnv: "production", baseUrl: "https://amadeus.example.com" });

    await expect(
      h.service.update(h.stepUp, ACCOUNT_ID, 1, {
        name: "Velexis shared test",
        baseUrl: "https://amadeus.example.com",
      }),
    ).rejects.toMatchObject(OFFICIAL_HOST_REFUSAL);
    expect(h.steps).toEqual([]);

    await expect(
      h.service.update(ADMIN, ACCOUNT_ID, 1, { name: "Velexis shared test" }),
    ).resolves.toMatchObject({
      name: "Velexis shared test",
    });
    await expect(h.service.update(ADMIN, ACCOUNT_ID, 1, { status: "disabled" })).resolves.toMatchObject({
      status: "disabled",
    });
    expect(h.steps).toEqual(["update", "update"]);
  });

  it("[PBE-074 AC1] outside production takes every https host and the loopback stub, for a create and an update, as before", async () => {
    for (const appEnv of ["test", "development"] as const) {
      for (const [environment, baseUrl] of [
        ["test", "http://127.0.0.1:4900"],
        ["live", "https://amadeus.example.com"],
        ["live", OFFICIAL.test],
        ["test", "https://test.travel.api.amadeus.com.example.net"],
        ["test", `${OFFICIAL.test}/`],
      ] as const) {
        const created = harness({ add: queued, appEnv });
        await expect(
          created.service.create(ADMIN, createRequest(environment, baseUrl)),
        ).resolves.toMatchObject({
          environment,
          baseUrl,
        });
        expect(created.steps).toEqual(["encrypt", "insert", "add"]);

        const updated = harness({ add: queued, appEnv, environment });
        await expect(
          updated.service.update(updated.stepUp, ACCOUNT_ID, 1, { baseUrl }),
        ).resolves.toMatchObject({
          environment,
          baseUrl,
        });
        expect(updated.steps).toEqual(["update", "add"]);
      }
    }
  });
});
