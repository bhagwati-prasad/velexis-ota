// The tenant lifecycle use cases (platform/docs/architecture.md §2.1: ProvisioningModule, layer 2; PADR-0001). PBE-018
// brings `createTenant` (platform/docs/flows/signup-and-create-ota.md steps 5 to 7, scope PF-10 and PF-40): the checks,
// then one transaction that writes the six rows of a new OTA. The dispatch of its job (PBE-019), the retries and the
// key reveal (PBE-023), suspend, resume, migrate and go-live (later tasks) follow.
//
// createTenant, in order:
//
// 1. Before M5 (`FEATURE_STRIPE_BILLING` off) the plan is always `early_access`, whatever the request says (ADR-0013
//    point 4). With the switch on the request is refused before anything is read: the Checkout path is PBE-044's.
// 2. The country, currency and time zone must be values of the reference data (`400 VALIDATION_FAILED`, field errors
//    that never echo the value), as `updateTenant` checks them; the key's pattern was checked by the schema.
// 3. One transaction (`runInTransaction`):
//    - the account's row is locked (`FOR UPDATE`): it must be verified and `active` (`403 EMAIL_NOT_VERIFIED`), and two
//      creations of one account run one after the other, so the tenant limit below holds under concurrency;
//    - the key must be neither reserved nor used by any tenant row in any status (`409 TENANT_KEY_UNAVAILABLE`);
//    - the account must own fewer than `MAX_TENANTS_PER_ACCOUNT` OTAs that are not `failed` (`422 UNPROCESSABLE`,
//      `details.reason = "tenant_limit"`);
//    - then the tenant (`provisioning`, storefront `test`, `created_by_account_id`), the owner membership, the manual
//      trial (`trialing`, `manual`, `trial_ends_at = now + plans.trial_days`), the verified primary sub-domain
//      `<key>.<STOREFRONT_BASE_DOMAIN>`, the `provision` job (`queued`, 5 attempts) and the audit row `tenant.created`.
//    Any error rolls all of it back. A key taken by a concurrent creation between the check and the insert fails on
//    the unique index, which also answers `409 TENANT_KEY_UNAVAILABLE`.
// 4. The answer is `202 {tenant, provisioningJob {id, status: "queued"}, checkoutUrl: null}`. The job stays `queued`
//    until PBE-019 dispatches it after the commit.
//
// The operation is idempotent through the global IdempotencyInterceptor (`x-idempotent: true`, PBE-009): a retry with
// the same `Idempotency-Key` and body gets the stored `202` without running this again, and while Redis is down the
// interceptor answers `503` before this service runs.
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types/platform";
import { AppError, type FieldError } from "@velexis/errors";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import { AccountsRepository } from "../auth/accounts.repository";
import { SubscriptionsRepository } from "../billing/subscriptions.repository";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { FeatureSwitches } from "../common/features";
import { IdGenerator } from "../common/ids";
import { runInTransaction } from "../common/redis/invalidation.publisher";
import type { PlatformBackendConfig } from "../config";
import { DomainsRepository, HOSTNAME_UNIQUE_INDEX } from "../domains/domains.repository";
import { MembershipsRepository } from "../memberships/memberships.repository";
import { isReservedTenantKey, storefrontHost } from "../tenants/tenant-key";
import { TENANT_KEY_CONSTRAINTS, TenantsRepository } from "../tenants/tenants.repository";
import { toTenant } from "../tenants/tenants.service";
import { ProvisioningJobsRepository } from "./provisioning-jobs.repository";

export type CreateTenantRequest = components["schemas"]["CreateTenantRequest"];
export type TenantCreated = components["schemas"]["TenantCreated"];

/** The plan of every OTA created before M5 (ADR-0013 point 4; seeded by migration 0002). */
export const PRE_M5_PLAN_CODE = "early_access";

/** PostgreSQL's SQLSTATE of a unique violation. */
const UNIQUE_VIOLATION = "23505";

/** The unique constraints a new OTA's key can break: the key, the schema name and the sub-domain derived from it. */
const KEY_CONFLICT_CONSTRAINTS: ReadonlySet<string> = new Set([
  ...TENANT_KEY_CONSTRAINTS,
  HOSTNAME_UNIQUE_INDEX,
]);

/**
 * True when `error` is the unique violation of a key that a concurrent creation took between the check and the insert
 * (the `pg` error that Kysely passes through, with the name of the constraint).
 */
function isKeyConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return (
    code === UNIQUE_VIOLATION && typeof constraint === "string" && KEY_CONFLICT_CONSTRAINTS.has(constraint)
  );
}

/** `409 TENANT_KEY_UNAVAILABLE`: reserved, used by a tenant row, or taken meanwhile; the answer never says which. */
function keyUnavailable(cause?: unknown): AppError {
  return new AppError("TENANT_KEY_UNAVAILABLE", cause === undefined ? {} : { cause });
}

@Injectable()
export class LifecycleService {
  private readonly baseDomain: string;
  private readonly maxTenantsPerAccount: number;

  constructor(
    private readonly accounts: AccountsRepository,
    private readonly tenants: TenantsRepository,
    private readonly memberships: MembershipsRepository,
    private readonly subscriptions: SubscriptionsRepository,
    private readonly domains: DomainsRepository,
    private readonly jobs: ProvisioningJobsRepository,
    private readonly audit: AuditService,
    private readonly features: FeatureSwitches,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
    this.maxTenantsPerAccount = config.get("MAX_TENANTS_PER_ACCOUNT", { infer: true });
  }

  /** createTenant for the account `accountId` (see the file header). */
  async createTenant(accountId: string, request: CreateTenantRequest): Promise<TenantCreated> {
    if (this.features.isEnabled("stripe_billing")) {
      // The Checkout path of M5 (an `incomplete` Stripe subscription, the Checkout Session) is PBE-044's: refusing
      // here, before anything is written, is better than a manual trial that the switch says should not exist.
      throw new Error("createTenant with FEATURE_STRIPE_BILLING on is not implemented before PBE-044");
    }
    await this.checkReferences(request);
    try {
      return await runInTransaction(this.db, (trx) => this.create(trx, accountId, request));
    } catch (error) {
      if (isKeyConflict(error)) {
        throw keyUnavailable(error);
      }
      throw error;
    }
  }

  /** The transaction of createTenant: the checks that need the database, then the six rows. */
  private async create(
    trx: PlatformTransaction,
    accountId: string,
    request: CreateTenantRequest,
  ): Promise<TenantCreated> {
    const account = await this.accounts.lockForUpdate(trx, accountId);
    if (account === undefined || account.status !== "active" || account.email_verified_at === null) {
      throw new AppError("EMAIL_NOT_VERIFIED");
    }
    const { key } = request;
    if (isReservedTenantKey(key) || (await this.tenants.keyExists(key, trx))) {
      throw keyUnavailable();
    }
    const owned = await this.memberships.countOwnedTenants(trx, accountId);
    if (owned >= this.maxTenantsPerAccount) {
      throw new AppError("UNPROCESSABLE", {
        details: { reason: "tenant_limit", limit: this.maxTenantsPerAccount },
      });
    }

    const now = this.clock.now();
    const tenantId = this.ids.new("ten");
    const planCode = PRE_M5_PLAN_CODE;
    const hostname = storefrontHost(key, this.baseDomain);
    await this.tenants.insert(trx, {
      id: tenantId,
      key,
      name: request.name,
      planCode,
      countryCode: request.countryCode,
      defaultCurrency: request.defaultCurrency,
      timeZone: request.timeZone,
      createdByAccountId: accountId,
      now,
    });
    await this.memberships.insertOwner(trx, { id: this.ids.new("stf"), tenantId, accountId, now });
    const subscription = await this.subscriptions.insertManualTrial(trx, {
      id: this.ids.new("sub"),
      tenantId,
      planCode,
      now,
    });
    await this.domains.insertSubdomain(trx, { id: this.ids.new("dom"), tenantId, hostname, now });
    const job = await this.jobs.insertQueued(trx, {
      id: this.ids.new("job"),
      tenantId,
      kind: "provision",
      requestedByAccountId: accountId,
      now,
    });
    await this.audit.record(trx, {
      actorType: "account",
      actorAccountId: accountId,
      action: "tenant.created",
      targetType: "tenant",
      targetId: tenantId,
      tenantId,
      tenantKey: key,
      after: {
        key,
        name: request.name,
        status: "provisioning",
        planCode,
        countryCode: request.countryCode,
        defaultCurrency: request.defaultCurrency,
        timeZone: request.timeZone,
        storefrontEnvironment: "test",
        primaryHost: hostname,
      },
      details: {
        provisioningJobId: job.id,
        subscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
        billingProvider: subscription.billing_provider,
      },
    });

    const row = await this.tenants.findWithHost(tenantId, trx);
    if (row === undefined) {
      throw new Error("createTenant: the tenant row written in this transaction cannot be read back");
    }
    return {
      tenant: toTenant(row, "owner", this.baseDomain),
      provisioningJob: { id: job.id, status: job.status },
      checkoutUrl: null,
    };
  }

  /**
   * The checks of the request that the schema cannot make: the country, the currency and the time zone must be values
   * of `reference.countries`, `reference.currencies` and `reference.time_zones`, by value and stored as sent (the OTA
   * worker copies them into the tenant's settings, which are checked against the same tables). Problems answer `400
   * VALIDATION_FAILED` with field errors that never echo the value.
   */
  private async checkReferences(request: CreateTenantRequest): Promise<void> {
    const [country, currency, timeZone] = await Promise.all([
      this.tenants.countryExists(request.countryCode),
      this.tenants.currencyExists(request.defaultCurrency),
      this.tenants.timeZoneExists(request.timeZone),
    ]);
    const fieldErrors: FieldError[] = [];
    if (!country) {
      fieldErrors.push({
        path: "/countryCode",
        code: "unknown",
        message: "Must be a known ISO 3166-1 alpha-2 country code.",
      });
    }
    if (!currency) {
      fieldErrors.push({
        path: "/defaultCurrency",
        code: "unknown",
        message: "Must be a known ISO 4217 currency code.",
      });
    }
    if (!timeZone) {
      fieldErrors.push({
        path: "/timeZone",
        code: "unknown",
        message: "Must be an IANA time zone of the reference data.",
      });
    }
    if (fieldErrors.length > 0) {
      throw new AppError("VALIDATION_FAILED", { fieldErrors });
    }
  }
}
