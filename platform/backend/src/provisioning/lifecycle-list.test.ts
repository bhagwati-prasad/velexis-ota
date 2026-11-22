// listTenants without a database (FIX-W69-LIMIT, known issue KI-010; provisioning/lifecycle.service.ts, its file
// header): the caller's OTAs as TenantsRepository lists them, mapped by `toTenantSummary`, and its `tenantLimit`, whose
// `max` is MAX_TENANTS_PER_ACCOUNT and whose `owned` is createTenant's own `MembershipsRepository.countOwnedTenants`,
// read on the pool (no transaction, no lock) for the same account, and answered as counted, above `max` included
// (KI-046). The repositories are fakes that record what they were asked; the rule of the count itself (owner
// memberships that are not removed, of OTAs that are not failed) is proven on PostgreSQL in
// test/integration/tenants/tenant-limit.int.test.ts.
import type { ConfigService } from "@nestjs/config";
import { FakeClock } from "@velexis/testing";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it } from "vitest";
import type { AuditService } from "../audit/audit.service";
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
import type { TenantListRow, TenantsRepository } from "../tenants/tenants.repository";
import type { ProvisioningDispatcher } from "./dispatcher";
import { LifecycleService } from "./lifecycle.service";
import type { ProvisioningJobsRepository } from "./provisioning-jobs.repository";

const ACCOUNT_ID = "acc_01J9ZK3Q5V8W2X4Y6Z8A0B2C4D";
const BASE_DOMAIN = "ota.example.com";

/** Two OTAs of the account, oldest first: one on its sub-domain, one whose primary host is a custom domain. */
const ROWS: TenantListRow[] = [
  {
    id: "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F",
    key: "acme",
    name: "Acme Travel",
    status: "active",
    plan_code: "early_access",
    storefront_environment: "test",
    role: "owner",
    primary_host: null,
  },
  {
    id: "ten_01JB3K4M8P2R6T0W4Y8A2C6E0G",
    key: "nordic",
    name: "Nordic Fares",
    status: "provisioning",
    plan_code: "early_access",
    storefront_environment: "test",
    role: "agent",
    primary_host: "book.nordicfares.example",
  },
];

/** A LifecycleService whose list and count are fakes; `limit` is MAX_TENANTS_PER_ACCOUNT, `owned` the count. */
function harness(options: {
  readonly limit: number;
  readonly owned: number;
  readonly rows?: TenantListRow[];
}) {
  const clock = new FakeClock();
  const db = { pool: "the API's PLATFORM_DB" } as unknown as PlatformDb;
  const listed: string[] = [];
  const counted: Array<{ readonly db: unknown; readonly accountId: string }> = [];
  const tenants = {
    listForMember: (accountId: string) => {
      listed.push(accountId);
      return Promise.resolve(options.rows ?? ROWS);
    },
  } as unknown as TenantsRepository;
  const memberships = {
    countOwnedTenants: (reader: unknown, accountId: string) => {
      counted.push({ db: reader, accountId });
      return Promise.resolve(options.owned);
    },
  } as unknown as MembershipsRepository;
  const config = {
    get: (name: string) => (name === "STOREFRONT_BASE_DOMAIN" ? BASE_DOMAIN : options.limit),
  } as unknown as ConfigService<PlatformBackendConfig, true>;
  const service = new LifecycleService(
    {} as AccountsRepository,
    tenants,
    memberships,
    {} as SubscriptionsRepository,
    {} as CheckoutService,
    {} as DomainsRepository,
    {} as ProvisioningJobsRepository,
    {} as ProvisioningDispatcher,
    {} as AuditService,
    {} as InvalidationPublisher,
    {} as EnvelopeService,
    {} as FeatureSwitches,
    new IdGenerator(clock as unknown as Clock),
    clock as unknown as Clock,
    db,
    {} as PinoLogger,
    config,
  );
  return { service, db, listed, counted };
}

describe("LifecycleService.listTenants", () => {
  it("[FIX-W69-LIMIT AC1] answers the caller's OTAs with its limit and createTenant's count of its owned OTAs", async () => {
    const { service, db, listed, counted } = harness({ limit: 3, owned: 2 });

    const list = await service.listTenants(ACCOUNT_ID);

    expect(list).toEqual({
      data: [
        {
          id: "ten_01JA2Z7Q4M9R2T6V0X3Z8B1D5F",
          key: "acme",
          name: "Acme Travel",
          status: "active",
          role: "owner",
          planCode: "early_access",
          storefrontUrl: "https://acme.ota.example.com/",
          storefrontEnvironment: "test",
        },
        {
          id: "ten_01JB3K4M8P2R6T0W4Y8A2C6E0G",
          key: "nordic",
          name: "Nordic Fares",
          status: "provisioning",
          role: "agent",
          planCode: "early_access",
          storefrontUrl: "https://book.nordicfares.example/",
          storefrontEnvironment: "test",
        },
      ],
      tenantLimit: { max: 3, owned: 2 },
    });
    // The caller's own list and count, the count on the pool: no transaction, no lock (createTenant counts again).
    expect(listed).toEqual([ACCOUNT_ID]);
    expect(counted).toEqual([{ db, accountId: ACCOUNT_ID }]);
  });

  it("[FIX-W69-LIMIT AC1] answers the count as it is: none owned, at the limit, and above it after an owner invitation", async () => {
    expect(
      (await harness({ limit: 3, owned: 0, rows: [] }).service.listTenants(ACCOUNT_ID)).tenantLimit,
    ).toEqual({
      max: 3,
      owned: 0,
    });
    expect((await harness({ limit: 1, owned: 1 }).service.listTenants(ACCOUNT_ID)).tenantLimit).toEqual({
      max: 1,
      owned: 1,
    });
    // KI-046: becoming an owner checks no limit, so `owned` can pass `max`; it is never capped.
    expect((await harness({ limit: 1, owned: 2 }).service.listTenants(ACCOUNT_ID)).tenantLimit).toEqual({
      max: 1,
      owned: 2,
    });
  });
});
