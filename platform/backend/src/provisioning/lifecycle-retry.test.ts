// The owner's retry of a failed setup and MAX_TENANTS_PER_ACCOUNT, without a database (FIX-W67-KI002, lead decision
// (36e) of 2026-11-21; known issue KI-002; provisioning/lifecycle.service.ts, `retryProvisioning` in its file header):
// a failed OTA does not count towards the limit, so the retry counts the OTAs of each of its owners under their account
// locks, taken before the tenant's row as createTenant takes the account's, and refuses with createTenant's exact
// error, changing nothing. The repositories are fakes that record the order of the calls and what the transaction
// writes; test/integration/provisioning/retry-tenant-limit.int.test.ts runs the same rules on PostgreSQL, the
// concurrency and the admin's exemption included.
import type { ConfigService } from "@nestjs/config";
import { AppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it } from "vitest";
import type { PlatformTransaction } from "../audit/audit.repository";
import type { AuditEntry, AuditService } from "../audit/audit.service";
import type { AccountsRepository } from "../auth/accounts.repository";
import type { CheckoutService } from "../billing/checkout.service";
import type { SubscriptionsRepository } from "../billing/subscriptions.repository";
import type { TenantMembership } from "../common/auth/tenant-role.guard";
import type { Clock } from "../common/clock";
import type { EnvelopeService } from "../common/crypto.provider";
import type { PlatformDb } from "../common/database";
import type { FeatureSwitches } from "../common/features";
import { IdGenerator } from "../common/ids";
import type { InvalidationPublisher } from "../common/redis/invalidation.publisher";
import type { PlatformBackendConfig } from "../config";
import type { DomainsRepository } from "../domains/domains.repository";
import type { MembershipsRepository } from "../memberships/memberships.repository";
import type { TenantsRepository } from "../tenants/tenants.repository";
import type { ProvisioningDispatcher } from "./dispatcher";
import { LifecycleService, tenantLimitError } from "./lifecycle.service";
import type { ProvisioningJobsRepository } from "./provisioning-jobs.repository";

const LIMIT = 3;
const TENANT_ID = "ten_01J9ZK3Q5V8W2X4Y6Z8A0B2C4D";
/** The caller, and a second owner whose id sorts before it (the locks follow the ids, not who calls). */
const CALLER = "acc_01J9ZK3Q5V8W2X4Y6Z8A0B2C4F";
const CO_OWNER = "acc_01J9ZK3Q5V8W2X4Y6Z8A0B2C4E";

const MEMBERSHIP: TenantMembership = {
  membershipId: "stf_01J9ZK3Q5V8W2X4Y6Z8A0B2C4G",
  tenantId: TENANT_ID,
  accountId: CALLER,
  role: "owner",
};

interface Options {
  /** The tenant's status when the retry locks it (`failed` unless said otherwise). */
  readonly status?: string;
  /** The owners `ownerAccountIds` answers, in id order (the caller alone unless said otherwise). */
  readonly owners?: readonly string[];
  /** The OTAs that are not failed each account owns (0 unless said otherwise). */
  readonly owned?: Readonly<Record<string, number>>;
}

/** A LifecycleService over fakes that log, in order, every call the retry makes. */
function harness(options: Options = {}) {
  const clock = new FakeClock();
  const ids = new IdGenerator(clock as unknown as Clock);
  const owners = options.owners ?? [CALLER];
  const owned = options.owned ?? {};
  const calls: string[] = [];
  const written = {
    reopened: 0,
    invalidations: 0,
    jobs: [] as string[],
    audit: [] as AuditEntry[],
    dispatched: [] as string[],
  };
  const trx = {} as PlatformTransaction;
  const db = {
    transaction: () => ({ execute: <T>(work: (t: PlatformTransaction) => Promise<T>) => work(trx) }),
  } as unknown as PlatformDb;
  const accounts = {
    lockForUpdate: (_trx: unknown, accountId: string) => {
      calls.push(`lockForUpdate ${accountId}`);
      return Promise.resolve({ id: accountId, status: "active", email_verified_at: clock.now() });
    },
    lockForTenantCount: (_trx: unknown, accountIds: readonly string[]) => {
      calls.push(`lockForTenantCount ${[...accountIds].sort().join(",")}`);
      return Promise.resolve([...accountIds].sort());
    },
  } as unknown as AccountsRepository;
  const tenants = {
    lockForUpdate: () => {
      calls.push("lock tenant");
      return Promise.resolve({ id: TENANT_ID, key: "acmetravel", status: options.status ?? "failed" });
    },
    reopenFailed: () => {
      calls.push("reopenFailed");
      written.reopened += 1;
      return Promise.resolve(true);
    },
    countryExists: () => Promise.resolve(true),
    currencyExists: () => Promise.resolve(true),
    timeZoneExists: () => Promise.resolve(true),
    keyExists: () => Promise.resolve(false),
  } as unknown as TenantsRepository;
  const memberships = {
    ownerAccountIds: () => {
      calls.push("ownerAccountIds");
      return Promise.resolve([...owners]);
    },
    countOwnedTenants: (_trx: unknown, accountId: string) => {
      calls.push(`countOwnedTenants ${accountId}`);
      return Promise.resolve(owned[accountId] ?? 0);
    },
  } as unknown as MembershipsRepository;
  const jobs = {
    latestProvisionJob: () => Promise.resolve({ id: "job_01J9ZK3Q5V8W2X4Y6Z8A0B2C40", error: "boom" }),
    insertQueued: (_trx: unknown, job: { id: string; kind: string }) => {
      calls.push("insertQueued");
      written.jobs.push(job.kind);
      return Promise.resolve({ id: job.id, status: "queued" });
    },
    findProgress: (jobId: string) =>
      Promise.resolve({
        id: jobId,
        kind: "provision",
        status: "running",
        step: "dispatch",
        steps: [],
        attempt: 1,
        max_attempts: 5,
        error: null,
      }),
  } as unknown as ProvisioningJobsRepository;
  const dispatcher = {
    dispatch: (jobId: string) => {
      written.dispatched.push(jobId);
      return Promise.resolve({ dispatched: true, jobId });
    },
  } as unknown as ProvisioningDispatcher;
  const audit = {
    record: (_trx: unknown, entry: AuditEntry) => {
      calls.push(`audit ${entry.action}`);
      written.audit.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditService;
  const invalidations = {
    publishAfterCommit: () => {
      calls.push("publishAfterCommit");
      written.invalidations += 1;
    },
  } as unknown as InvalidationPublisher;
  const features = { isEnabled: () => false } as unknown as FeatureSwitches;
  const config = {
    get: (name: string) => (name === "STOREFRONT_BASE_DOMAIN" ? "ota.example.com" : LIMIT),
  } as unknown as ConfigService<PlatformBackendConfig, true>;
  const service = new LifecycleService(
    accounts,
    tenants,
    memberships,
    {} as SubscriptionsRepository,
    {} as CheckoutService,
    {} as DomainsRepository,
    jobs,
    dispatcher,
    audit,
    invalidations,
    {} as EnvelopeService,
    features,
    ids,
    clock as unknown as Clock,
    db,
    { warn: () => undefined } as unknown as PinoLogger,
    config,
  );
  return { service, calls, written };
}

/** The AppError `work` rejected with. */
async function refusalOf(work: Promise<unknown>): Promise<AppError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error("the call did not refuse");
}

/** What an answer carries of an AppError: its code, status, message and details. */
function shapeOf(error: AppError): Record<string, unknown> {
  return { code: error.code, status: error.status, message: error.message, details: error.details };
}

describe("retryProvisioning and MAX_TENANTS_PER_ACCOUNT (FIX-W67-KI002)", () => {
  it("[FIX-W67-KI002 AC1] refuses an owner who owns the limit already with createTenant's exact error, and writes nothing", async () => {
    const { service, written } = harness({ owned: { [CALLER]: LIMIT } });

    const refused = await refusalOf(service.retryProvisioning(MEMBERSHIP));

    expect(shapeOf(refused)).toEqual(shapeOf(tenantLimitError(LIMIT)));
    expect(refused.code).toBe("UNPROCESSABLE");
    expect(refused.details).toEqual({ reason: "tenant_limit", limit: LIMIT });
    // createTenant of the same account, at the same limit, refuses with the very same error.
    const created = await refusalOf(
      harness({ owned: { [CALLER]: LIMIT } }).service.createTenant(
        CALLER,
        {
          key: "acmetwo",
          name: "Acme Two",
          countryCode: "NO",
          defaultCurrency: "EUR",
          timeZone: "Europe/Oslo",
        },
        "idem-ki002",
      ),
    );
    expect(shapeOf(created)).toEqual(shapeOf(refused));
    // Nothing changed: the tenant stays failed, no job, no invalidation, no audit row, no dispatch.
    expect(written).toEqual({ reopened: 0, invalidations: 0, jobs: [], audit: [], dispatched: [] });
  });

  it("[FIX-W67-KI002 AC1] lets an owner below the limit retry as before: the OTA reopens with a new job", async () => {
    const { service, written } = harness({ owned: { [CALLER]: LIMIT - 1 } });

    const retried = await service.retryProvisioning(MEMBERSHIP);

    expect(retried).toMatchObject({ job: { kind: "provision", status: "running" }, checkoutUrl: null });
    expect(written.reopened).toBe(1);
    expect(written.invalidations).toBe(1);
    expect(written.jobs).toEqual(["provision"]);
    expect(written.audit.map((entry) => entry.action)).toEqual(["provisioning_job.retried"]);
    expect(written.dispatched).toHaveLength(1);
  });

  it("[FIX-W67-KI002 AC2] locks the owners' accounts, in id order, before the tenant's row, and counts after both", async () => {
    const { service, calls } = harness({ owners: [CO_OWNER, CALLER], owned: { [CALLER]: 1, [CO_OWNER]: 1 } });

    await service.retryProvisioning(MEMBERSHIP);

    expect(calls.slice(0, 6)).toEqual([
      "ownerAccountIds",
      `lockForTenantCount ${CO_OWNER},${CALLER}`,
      "lock tenant",
      // The owners are read again under the tenant's lock, then each one's OTAs counted, before the reopening.
      "ownerAccountIds",
      `countOwnedTenants ${CO_OWNER}`,
      `countOwnedTenants ${CALLER}`,
    ]);
    expect(calls[6]).toBe("reopenFailed");
    // createTenant's order is the same: the account first, its count while it holds the lock (at the limit here, so
    // it stops after the count).
    const create = harness({ owned: { [CALLER]: LIMIT } });
    await refusalOf(
      create.service.createTenant(
        CALLER,
        {
          key: "acmetwo",
          name: "Acme Two",
          countryCode: "NO",
          defaultCurrency: "EUR",
          timeZone: "Europe/Oslo",
        },
        "idem-ki002",
      ),
    );
    expect(create.calls.slice(0, 2)).toEqual([`lockForUpdate ${CALLER}`, `countOwnedTenants ${CALLER}`]);
  });

  it("[FIX-W67-KI002 AC1] counts every owner of the failed OTA: a co-owner at the limit refuses the retry too", async () => {
    const { service, written } = harness({
      owners: [CO_OWNER, CALLER],
      owned: { [CALLER]: 0, [CO_OWNER]: LIMIT },
    });

    const refused = await refusalOf(service.retryProvisioning(MEMBERSHIP));

    expect(shapeOf(refused)).toEqual(shapeOf(tenantLimitError(LIMIT)));
    expect(written).toEqual({ reopened: 0, invalidations: 0, jobs: [], audit: [], dispatched: [] });
  });

  it("[FIX-W67-KI002 AC1] answers 409 PROVISIONING_NOT_RETRYABLE for an OTA that is not failed before it counts anything", async () => {
    const { service, calls, written } = harness({ status: "provisioning", owned: { [CALLER]: LIMIT } });

    expect((await refusalOf(service.retryProvisioning(MEMBERSHIP))).code).toBe("PROVISIONING_NOT_RETRYABLE");
    expect(calls.filter((call) => call.startsWith("countOwnedTenants"))).toEqual([]);
    expect(written.reopened).toBe(0);
  });
});
