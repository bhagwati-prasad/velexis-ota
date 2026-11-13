// createTenant's key rules without a database (PBE-018, PBE-075; provisioning/lifecycle.service.ts, its file header):
// every caller gets `409 TENANT_KEY_UNAVAILABLE` for a reserved key, `demo` included, and only the option of Velexis's
// own OTAs (VelexisOwnTenant, which the platform command `tenants:create-demo` alone passes) lets `demo` through, never
// another key. With it the OTA gets the portal's six rows on the manual trial of `early_access` whatever the billing
// switch says, and audit rows that name the command. The repositories are fakes that record what the transaction
// writes; the integration test test/integration/tenants/demo-ota.int.test.ts runs the command on PostgreSQL and Redis.
import type { ConfigService } from "@nestjs/config";
import { AppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import type { PlatformTransaction } from "../audit/audit.repository";
import type { AuditEntry, AuditService } from "../audit/audit.service";
import type { AccountsRepository } from "../auth/accounts.repository";
import type { CheckoutService } from "../billing/checkout.service";
import type { SubscriptionsRepository } from "../billing/subscriptions.repository";
import type { Clock } from "../common/clock";
import type { EnvelopeService } from "../common/crypto.provider";
import type { PlatformDb } from "../common/database";
import type { FeatureSwitches } from "../common/features";
import { IdGenerator } from "../common/ids";
import type { InvalidationPublisher } from "../common/redis/invalidation.publisher";
import type { PlatformBackendConfig } from "../config";
import type { DomainsRepository } from "../domains/domains.repository";
import type { MembershipsRepository } from "../memberships/memberships.repository";
import { RESERVED_TENANT_KEYS } from "../tenants/tenant-key";
import type { TenantsRepository } from "../tenants/tenants.repository";
import type { ProvisioningDispatcher } from "./dispatcher";
import {
  LifecycleService,
  ownKeyAllowed,
  PRE_M5_PLAN_CODE,
  type CreateTenantRequest,
  type VelexisOwnTenant,
} from "./lifecycle.service";
import type { ProvisioningJobsRepository } from "./provisioning-jobs.repository";

const ACCOUNT_ID = "acc_01J9ZK3Q5V8W2X4Y6Z8A0B2C4D";
const BASE_DOMAIN = "ota.example.com";

/** The option the command passes (tenants/demo-ota.command.ts builds the same one). */
const OWN: VelexisOwnTenant = {
  actorLabel: "cli tenants:create-demo by Developer One",
  details: { command: "tenants:create-demo", operator: "Developer One" },
};

function request(key: string, overrides: Partial<CreateTenantRequest> = {}): CreateTenantRequest {
  return {
    key,
    name: "Velexis demo",
    countryCode: "NO",
    defaultCurrency: "EUR",
    timeZone: "Europe/Oslo",
    ...overrides,
  };
}

/** What one createTenant wrote through the fakes. */
interface Written {
  readonly tenants: Array<{ readonly key: string; readonly planCode: string }>;
  readonly owners: number;
  readonly manualTrials: Array<{ readonly planCode: string }>;
  readonly incomplete: number;
  readonly subdomains: string[];
  readonly jobs: string[];
  readonly audit: AuditEntry[];
  readonly dispatched: string[];
}

/** A LifecycleService over fakes: the key is free unless `taken`; the billing switch is on with `stripeBilling`. */
function harness(options: { readonly taken?: boolean; readonly stripeBilling?: boolean } = {}) {
  const clock = new FakeClock();
  const ids = new IdGenerator(clock as unknown as Clock);
  const written = {
    tenants: [] as Array<{ key: string; planCode: string }>,
    owners: 0,
    manualTrials: [] as Array<{ planCode: string }>,
    incomplete: 0,
    subdomains: [] as string[],
    jobs: [] as string[],
    audit: [] as AuditEntry[],
    dispatched: [] as string[],
  };
  let stored: { id: string; key: string; name: string; planCode: string } | undefined;
  const trx = {} as PlatformTransaction;
  const db = {
    transaction: () => ({ execute: <T>(work: (t: PlatformTransaction) => Promise<T>) => work(trx) }),
  } as unknown as PlatformDb;
  const accounts = {
    lockForUpdate: () =>
      Promise.resolve({ id: ACCOUNT_ID, status: "active", email_verified_at: clock.now() }),
  } as unknown as AccountsRepository;
  const tenants = {
    countryExists: () => Promise.resolve(true),
    currencyExists: () => Promise.resolve(true),
    timeZoneExists: () => Promise.resolve(true),
    keyExists: () => Promise.resolve(options.taken === true),
    insert: (_trx: unknown, tenant: { id: string; key: string; name: string; planCode: string }) => {
      stored = tenant;
      written.tenants.push({ key: tenant.key, planCode: tenant.planCode });
      return Promise.resolve();
    },
    findWithHost: () =>
      Promise.resolve(
        stored === undefined
          ? undefined
          : {
              id: stored.id,
              key: stored.key,
              name: stored.name,
              legal_name: null,
              status: "provisioning",
              suspension_reason: null,
              billing_notice: null,
              plan_code: stored.planCode,
              default_currency: "EUR",
              country_code: "NO",
              time_zone: "Europe/Oslo",
              support_email: null,
              storefront_environment: "test",
              live_enabled_at: null,
              primary_host: `${stored.key}.${BASE_DOMAIN}`,
              schema_version: null,
              created_at: clock.now(),
              activated_at: null,
              version: 1,
            },
      ),
  } as unknown as TenantsRepository;
  const memberships = {
    countOwnedTenants: () => Promise.resolve(0),
    insertOwner: () => {
      written.owners += 1;
      return Promise.resolve();
    },
  } as unknown as MembershipsRepository;
  const subscriptions = {
    insertManualTrial: (_trx: unknown, row: { id: string; planCode: string }) => {
      written.manualTrials.push({ planCode: row.planCode });
      return Promise.resolve({ id: row.id, status: "trialing", billing_provider: "manual" });
    },
    insertIncomplete: (_trx: unknown, row: { id: string }) => {
      written.incomplete += 1;
      return Promise.resolve({ id: row.id, status: "incomplete", billing_provider: "stripe" });
    },
  } as unknown as SubscriptionsRepository;
  const checkout = {
    planFor: vi.fn(() => Promise.resolve({ code: "growth", interval: "month" })),
    start: vi.fn(() => Promise.resolve({ url: "https://checkout.stripe.com/c/pay/cs_test_fake" })),
  };
  const domains = {
    insertSubdomain: (_trx: unknown, row: { hostname: string }) => {
      written.subdomains.push(row.hostname);
      return Promise.resolve();
    },
  } as unknown as DomainsRepository;
  const jobs = {
    insertQueued: (_trx: unknown, job: { id: string; kind: string }) => {
      written.jobs.push(job.kind);
      return Promise.resolve({ id: job.id, status: "queued" });
    },
  } as unknown as ProvisioningJobsRepository;
  const dispatcher = {
    dispatch: (jobId: string) => {
      written.dispatched.push(jobId);
      return Promise.resolve({ dispatched: true, jobId });
    },
  } as unknown as ProvisioningDispatcher;
  const audit = {
    record: (_trx: unknown, entry: AuditEntry) => {
      written.audit.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditService;
  const features = {
    isEnabled: (feature: string) => feature === "stripe_billing" && options.stripeBilling === true,
  } as unknown as FeatureSwitches;
  const logger = { warn: vi.fn() } as unknown as PinoLogger;
  const config = {
    get: (name: string) => (name === "STOREFRONT_BASE_DOMAIN" ? BASE_DOMAIN : 3),
  } as unknown as ConfigService<PlatformBackendConfig, true>;
  const service = new LifecycleService(
    accounts,
    tenants,
    memberships,
    subscriptions,
    checkout as unknown as CheckoutService,
    domains,
    jobs,
    dispatcher,
    audit,
    {} as InvalidationPublisher,
    {} as EnvelopeService,
    features,
    ids,
    clock as unknown as Clock,
    db,
    logger,
    config,
  );
  return { service, written: written as Written, checkout };
}

/** The error code createTenant rejected with. */
async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("createTenant did not refuse");
}

describe("ownKeyAllowed", () => {
  it("[PBE-075 AC2] lets demo through for the command's option only, and no other key", () => {
    expect(ownKeyAllowed("demo", OWN)).toBe(true);
    expect(ownKeyAllowed("demo", undefined)).toBe(false);
    for (const key of ["admin", "test", "acme", "Demo"]) {
      expect(ownKeyAllowed(key, OWN), key).toBe(false);
    }
  });
});

describe("createTenant and the reserved keys", () => {
  it("[PBE-075 AC3] answers 409 TENANT_KEY_UNAVAILABLE for demo, and every reserved key, without the option", async () => {
    for (const key of RESERVED_TENANT_KEYS) {
      const { service, written } = harness();
      expect(await refusal(service.createTenant(ACCOUNT_ID, request(key), "idem-1")), key).toBe(
        "TENANT_KEY_UNAVAILABLE",
      );
      expect(written.tenants, key).toEqual([]);
      expect(written.audit, key).toEqual([]);
    }
  });

  it("[PBE-075 AC2] refuses any key but Velexis's own with the option: reserved or free, nothing written", async () => {
    for (const key of ["admin", "test", "acme"]) {
      const { service, written } = harness();
      expect(await refusal(service.createTenant(ACCOUNT_ID, request(key), "idem-1", OWN)), key).toBe(
        "TENANT_KEY_UNAVAILABLE",
      );
      expect(written.tenants, key).toEqual([]);
      expect(written.jobs, key).toEqual([]);
      expect(written.audit, key).toEqual([]);
    }
  });

  it("[PBE-075 AC2] refuses demo with the option when a tenant row has it already", async () => {
    const { service, written } = harness({ taken: true });
    expect(await refusal(service.createTenant(ACCOUNT_ID, request("demo"), "idem-1", OWN))).toBe(
      "TENANT_KEY_UNAVAILABLE",
    );
    expect(written.tenants).toEqual([]);
  });
});

describe("createTenant for Velexis's own OTA (PBE-075)", () => {
  it("[PBE-075 AC1] writes the portal's rows for demo on the manual trial of early_access, even with billing on", async () => {
    const { service, written, checkout } = harness({ stripeBilling: true });
    // A portal request with the billing switch on must name its plan (400); the command's needs none.
    const created = await service.createTenant(ACCOUNT_ID, request("demo"), "tenants:create-demo", OWN);

    expect(created.tenant).toMatchObject({
      key: "demo",
      name: "Velexis demo",
      status: "provisioning",
      planCode: PRE_M5_PLAN_CODE,
      storefrontEnvironment: "test",
      primaryHost: `demo.${BASE_DOMAIN}`,
      myRole: "owner",
    });
    expect(created.checkoutUrl).toBeNull();
    expect(created.provisioningJob.status).toBe("running");
    expect(written.tenants).toEqual([{ key: "demo", planCode: PRE_M5_PLAN_CODE }]);
    expect(written.owners).toBe(1);
    expect(written.manualTrials).toEqual([{ planCode: PRE_M5_PLAN_CODE }]);
    expect(written.incomplete).toBe(0);
    expect(written.subdomains).toEqual([`demo.${BASE_DOMAIN}`]);
    expect(written.jobs).toEqual(["provision"]);
    expect(written.dispatched).toEqual([created.provisioningJob.id]);
    expect(checkout.planFor).not.toHaveBeenCalled();
    expect(checkout.start).not.toHaveBeenCalled();
  });

  it("[PBE-075 AC1] names the command in tenant.created and writes tenant.reserved_key_used beside it", async () => {
    const { service, written } = harness();
    const created = await service.createTenant(ACCOUNT_ID, request("demo"), "tenants:create-demo", OWN);
    const tenantId = created.tenant.id;

    expect(written.audit.map((entry) => entry.action)).toEqual([
      "tenant.created",
      "tenant.reserved_key_used",
    ]);
    const [tenantCreated, reservedKeyUsed] = written.audit;
    expect(tenantCreated).toMatchObject({
      actorType: "system",
      actorLabel: "cli tenants:create-demo by Developer One",
      targetType: "tenant",
      targetId: tenantId,
      tenantId,
      tenantKey: "demo",
      after: {
        key: "demo",
        status: "provisioning",
        planCode: PRE_M5_PLAN_CODE,
        storefrontEnvironment: "test",
      },
      details: {
        command: "tenants:create-demo",
        operator: "Developer One",
        ownerAccountId: ACCOUNT_ID,
        subscriptionStatus: "trialing",
        billingProvider: "manual",
      },
    });
    expect(tenantCreated?.actorAccountId).toBeUndefined();
    expect(reservedKeyUsed).toEqual({
      actorType: "system",
      actorLabel: "cli tenants:create-demo by Developer One",
      action: "tenant.reserved_key_used",
      targetType: "tenant",
      targetId: tenantId,
      tenantId,
      tenantKey: "demo",
      details: {
        command: "tenants:create-demo",
        operator: "Developer One",
        key: "demo",
        ownerAccountId: ACCOUNT_ID,
      },
    });
  });

  it("keeps the portal's own creation as it was: the account as the actor and one audit row", async () => {
    const { service, written } = harness();
    await service.createTenant(ACCOUNT_ID, request("acme"), "idem-1");

    expect(written.audit).toHaveLength(1);
    expect(written.audit[0]).toMatchObject({
      actorType: "account",
      actorAccountId: ACCOUNT_ID,
      action: "tenant.created",
    });
    expect(written.audit[0]?.actorLabel).toBeUndefined();
    expect(Object.keys(written.audit[0]?.details ?? {})).not.toContain("command");
  });
});
