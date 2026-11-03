// The domain use cases of the portal (platform/docs/api-inventory-resources.md §2, flows/custom-domains.md steps 1, 5
// and 7, PADR-0004; scope PF-40 and PF-41): `listDomains` (PBE-027) answers the OTA's storefront hosts to any member;
// `addDomain`, `makeDomainPrimary` and `removeDomain` (PBE-049) let owners and admins manage custom storefront domains.
// Who may call them is TenantRoleGuard's (the membership arrives here checked), and the `x-feature: custom_domains` of
// `addDomain` and `checkDomain` is FeatureGuard's (`403 FEATURE_DISABLED` while FEATURE_CUSTOM_DOMAINS is off;
// `checkDomain` since FIX-W39-PLATFORM, lead decision (2h) of 2026-11-02). `makeDomainPrimary` has no `x-feature` since
// that lead's decision (2a): the sub-domain is always allowed, so this service refuses a custom domain while the switch
// is off (FeatureSwitches). This service owns the transactions, their audit rows and the work after the commit
// (architecture §4).
//
// DNS records (PADR-0004 item 2): the Velexis sub-domain `<key>.<STOREFRONT_BASE_DOMAIN>` needs none; a custom domain
// lists the ownership record `TXT _velexis.<host>` with the row's verification value, and both routing options, the
// `CNAME <host>` to the OTA's sub-domain and, for a zone apex that cannot have a CNAME, `A <host>` to STOREFRONT_IPV4
// and `AAAA <host>` to STOREFRONT_IPV6 (each only while configured; STOREFRONT_IPV4 is required while the switch is
// on). Verification (PBE-050, domain-checks.ts) accepts either routing option.
//
// Every write runs in one transaction under the tenant's domain lock and needs an `active` OTA (`409
// TENANT_NOT_ACTIVE`, PADR-0014 item 5: a suspended OTA's domains are read-only):
// - `addDomain`: the plan must have custom domains (`limits.customDomains` above 0, else `403 FEATURE_DISABLED` with
//   `details.feature = custom_domains`, as the switch answers), and the OTA's custom domains in any status must stay
//   below it (`422 PLAN_LIMIT_REACHED` with `details.limit` and `details.used`); then the host name rules of
//   hostname-rules.ts (`422 DOMAIN_INVALID`) and a host no tenant has (`409 DOMAIN_TAKEN`, also when a concurrent
//   addition wins the unique index). The row is `pending` with a new verification value and a deadline 72 hours ahead.
//   Nothing is announced: neither the OTA backend nor TLS `ask` serves a pending domain (architecture §6.3 publishes
//   `domain` when a domain is verified, failed, removed or its primary flag moves).
// - `makeDomainPrimary`: making the OTA's sub-domain primary again is always allowed, whatever the switch or the plan
//   says (FIX-W39-PLATFORM, lead decision (2a) of 2026-11-02). A custom domain needs FEATURE_CUSTOM_DOMAINS (checked once
//   the domain is read) and a plan with custom domains (after the tenant's status), as for `addDomain` (`403
//   FEATURE_DISABLED` with `details.feature = custom_domains`, nothing written; FIX-W38-PLATFORM, lead decision (2e) of
//   2026-10-31); a verified domain only (`409 DOMAIN_NOT_VERIFIED`); the other primary storefront host loses the flag
//   before this one gets it (the partial unique index keeps one primary), and `domain` invalidations for both hosts
//   follow the commit. The primary domain answers unchanged, with no write.
// - `removeDomain`: custom domains only (`409 CONFLICT`, `details.reason = "subdomain"`); the row is deleted and, when
//   it was primary, the sub-domain becomes primary again; after the commit `domain` invalidations for the host (and the
//   sub-domain when the flag moved) are published and the cached `tlsask:<host>` answer is deleted (PADR-0004 item 6:
//   the platform deletes it itself, besides the invalidation), so neither the storefront nor the TLS gate serves the
//   host any more. The host name is then free for another tenant.
// - `checkDomain` (PBE-050), which owners and admins call to have a domain's DNS records checked now: the plan must have
//   custom domains, as for `addDomain` (`403 FEATURE_DISABLED` after the tenant's status, nothing written or queued;
//   FIX-W39-PLATFORM, lead decision (2h) of 2026-11-02); a `pending` or
//   `failed` custom domain only (`409 CONFLICT` with `details.reason = "subdomain"` for the sub-domain,
//   `"already_verified"` for a verified domain, which the daily re-check watches); a `failed` domain first gets a new
//   72-hour window with the same token (`pending` again, audit row `domain.verification_restarted`). After the commit
//   `domain.verify` is queued (DomainJobs); the job is the operation's effect, so a job that cannot be queued answers
//   `503 SERVICE_UNAVAILABLE` (the restart stands, and the 5-minute run checks the domain). The answer is the domain as
//   it is now; the result shows in `listDomains` once the job ran. Nothing is published: neither a pending nor a failed
//   domain is served (architecture §6.3). The limit of 1 call per domain per minute (`429 RATE_LIMITED`) is
//   RateLimitGuard's (`domainCheck`, throttler.config.ts).
//
// Audit rows hold host names, statuses and the primary flag, never the verification value (it is no secret, being
// published in DNS, but it has no place in the audit trail either).
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import type { TenantMembership } from "../common/auth/tenant-role.guard";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { FeatureSwitches } from "../common/features";
import { IdGenerator } from "../common/ids";
import { afterCommit, InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import { redisKeys } from "../common/redis/redis-keys";
import type { PlatformBackendConfig } from "../config";
import { DomainJobs } from "./domain-checks.processor";
import {
  HOSTNAME_UNIQUE_INDEX,
  DomainsRepository,
  type DomainListRow,
  type DomainTenantState,
} from "./domains.repository";
import {
  customHostnameOrThrow,
  newVerificationToken,
  velexisHostsOf,
  type HostnameRules,
} from "./hostname-rules";
import { customDomainLimit } from "./tls-ask.service";

export type Domain = components["schemas"]["Domain"];
export type DomainList = components["schemas"]["DomainList"];
export type DnsRecord = components["schemas"]["DnsRecord"];
export type AddDomainRequest = components["schemas"]["AddDomainRequest"];

/** How long a new custom domain may take to be verified (PADR-0004 item 4). */
export const VERIFICATION_WINDOW_MS = 72 * 60 * 60 * 1000;

/** PostgreSQL's SQLSTATE of a unique violation. */
const UNIQUE_VIOLATION = "23505";

/** The VM's public addresses, the targets of an apex domain's `A` and `AAAA` records (both optional). */
export interface StorefrontAddresses {
  readonly ipv4?: string | undefined;
  readonly ipv6?: string | undefined;
}

/**
 * The storefront addresses of this deployment (STOREFRONT_IPV4, STOREFRONT_IPV6), for every caller of `toDomain`: the
 * portal's domain routes and the admin's tenant view (admin-tenants.service.ts) show the same records.
 */
export function storefrontAddressesOf(
  config: ConfigService<PlatformBackendConfig, true>,
): StorefrontAddresses {
  return {
    ipv4: config.get("STOREFRONT_IPV4", { infer: true }),
    ipv6: config.get("STOREFRONT_IPV6", { infer: true }),
  };
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/**
 * The DNS records of a domain row: none for the sub-domain (Velexis owns the zone); for a custom domain the ownership
 * `TXT _velexis.<host>`, the routing `CNAME <host>` to `<key>.<baseDomain>`, and the apex alternative `A <host>` and
 * `AAAA <host>` to the storefront addresses that are configured (PADR-0004 item 2).
 */
export function dnsRecordsOf(
  row: DomainListRow,
  baseDomain: string,
  addresses: StorefrontAddresses,
): DnsRecord[] {
  if (row.kind !== "custom" || row.verification_token === null) {
    return [];
  }
  const records: DnsRecord[] = [
    { type: "TXT", name: `_velexis.${row.hostname}`, value: row.verification_token },
    { type: "CNAME", name: row.hostname, value: `${row.tenant_key}.${baseDomain}` },
  ];
  if (addresses.ipv4 !== undefined) {
    records.push({ type: "A", name: row.hostname, value: addresses.ipv4 });
  }
  if (addresses.ipv6 !== undefined) {
    records.push({ type: "AAAA", name: row.hostname, value: addresses.ipv6 });
  }
  return records;
}

/**
 * The `Domain` of the OpenAPI document for a row of the tenant. `addresses` has no default, so every caller passes the
 * deployment's (`storefrontAddressesOf`) and the portal and the admin never show different records.
 */
export function toDomain(row: DomainListRow, baseDomain: string, addresses: StorefrontAddresses): Domain {
  return {
    id: row.id,
    hostname: row.hostname,
    kind: row.kind as Domain["kind"],
    purpose: row.purpose as Domain["purpose"],
    isPrimary: row.is_primary,
    verificationStatus: row.verification_status as Domain["verificationStatus"],
    dnsRecords: dnsRecordsOf(row, baseDomain, addresses),
    verificationDeadlineAt: iso(row.verification_deadline_at),
    lastCheckedAt: iso(row.last_checked_at),
    lastCheckError: row.last_check_error,
    tlsStatus: row.tls_status as Domain["tlsStatus"],
    tlsExpiresAt: iso(row.tls_expires_at),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The plan's `limits.customDomains` of a tenant whose plan has custom domains; `403 FEATURE_DISABLED` with
 * `details.feature = custom_domains` (the answer of the switch) for a plan without them (0 or not set). `addDomain`,
 * `checkDomain` and `makeDomainPrimary` of a custom domain ask it (PADR-0015 item 2: the switch and the plan's limits
 * together).
 */
function customDomainLimitOrThrow(tenant: Pick<DomainTenantState, "limits">): number {
  const limit = customDomainLimit(tenant.limits);
  if (limit === 0) {
    throw new AppError("FEATURE_DISABLED", { details: { feature: "custom_domains" } });
  }
  return limit;
}

/**
 * True when `error` is the unique violation of a host name that a concurrent addition took between the check and the
 * insert (the `pg` error that Kysely passes through, with the name of the index).
 */
function isHostnameTaken(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && constraint === HOSTNAME_UNIQUE_INDEX;
}

@Injectable()
export class DomainsService {
  private readonly baseDomain: string;
  private readonly addresses: StorefrontAddresses;
  private readonly hostnameRules: HostnameRules;

  constructor(
    private readonly domains: DomainsRepository,
    private readonly jobs: DomainJobs,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly features: FeatureSwitches,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectPinoLogger(DomainsService.name) private readonly logger: PinoLogger,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
    this.addresses = storefrontAddressesOf(config);
    this.hostnameRules = {
      velexisHosts: velexisHostsOf({
        STOREFRONT_BASE_DOMAIN: this.baseDomain,
        PUBLIC_PORTAL_URL: config.get("PUBLIC_PORTAL_URL", { infer: true }),
        PUBLIC_PLATFORM_ADMIN_URL: config.get("PUBLIC_PLATFORM_ADMIN_URL", { infer: true }),
        PUBLIC_OTA_ADMIN_URL: config.get("PUBLIC_OTA_ADMIN_URL", { infer: true }),
        PUBLIC_OTA_API_URL: config.get("PUBLIC_OTA_API_URL", { infer: true }),
      }),
    };
  }

  /** `listDomains`: the OTA's storefront hosts, primary first, then oldest first. */
  async list(membership: TenantMembership): Promise<DomainList> {
    const rows = await this.domains.listForTenant(membership.tenantId);
    return { data: rows.map((row) => this.toDomain(row)) };
  }

  /**
   * `addDomain`: a new custom storefront domain, `pending`, with the verification value and deadline and the DNS records
   * to create, and a `domain.added` audit row.
   */
  async add(membership: TenantMembership, request: AddDomainRequest): Promise<Domain> {
    const { tenantId, accountId } = membership;
    const now = this.clock.now();
    return runInTransaction(this.db, async (trx) => {
      await this.domains.lockTenantDomains(trx, tenantId);
      const tenant = await this.writableTenant(trx, tenantId);
      const limit = customDomainLimitOrThrow(tenant);
      const used = await this.domains.countCustom(trx, tenantId);
      if (used >= limit) {
        throw new AppError("PLAN_LIMIT_REACHED", { details: { limit, used } });
      }
      const hostname = customHostnameOrThrow(request.hostname, this.hostnameRules);
      if (await this.domains.hostnameExists(trx, hostname)) {
        throw new AppError("DOMAIN_TAKEN");
      }
      const id = this.ids.new("dom");
      try {
        await this.domains.insertCustom(trx, {
          id,
          tenantId,
          hostname,
          verificationToken: newVerificationToken(),
          verificationDeadlineAt: new Date(now.getTime() + VERIFICATION_WINDOW_MS),
          createdByAccountId: accountId,
          now,
        });
      } catch (error) {
        if (isHostnameTaken(error)) {
          throw new AppError("DOMAIN_TAKEN");
        }
        throw error;
      }
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: accountId,
        action: "domain.added",
        targetType: "domain",
        targetId: id,
        tenantId,
        after: { hostname, kind: "custom", purpose: "storefront", verificationStatus: "pending" },
      });
      return this.toDomain(await this.reread(trx, tenantId, id));
    });
  }

  /**
   * `makeDomainPrimary`: the verified domain becomes the primary storefront host and the previous one loses the flag,
   * with a `domain.primary_changed` audit row and `domain` invalidations for both hosts after the commit. The primary
   * domain answers as it is. The OTA's sub-domain is always allowed (FIX-W39-PLATFORM, lead decision (2a) of
   * 2026-11-02); a custom domain answers `403 FEATURE_DISABLED` before anything is written while FEATURE_CUSTOM_DOMAINS
   * is off or the plan has no custom domains, as `addDomain` does (FIX-W38-PLATFORM, lead decision (2e) of 2026-10-31).
   */
  async makePrimary(membership: TenantMembership, domainId: string): Promise<Domain> {
    const { tenantId, accountId } = membership;
    const now = this.clock.now();
    return runInTransaction(this.db, async (trx) => {
      await this.domains.lockTenantDomains(trx, tenantId);
      const domain = await this.lockedDomain(trx, tenantId, domainId);
      const custom = domain.kind !== "subdomain";
      if (custom) {
        this.customDomainsSwitchOrThrow();
      }
      const tenant = await this.writableTenant(trx, tenantId);
      if (custom) {
        customDomainLimitOrThrow(tenant);
      }
      if (domain.verification_status !== "verified") {
        throw new AppError("DOMAIN_NOT_VERIFIED");
      }
      if (domain.is_primary) {
        return this.toDomain(domain);
      }
      const previous = await this.domains.lockPrimary(trx, tenantId, domain.purpose);
      if (previous !== undefined) {
        await this.domains.setPrimary(trx, previous.id, false, now);
      }
      await this.domains.setPrimary(trx, domain.id, true, now);
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: accountId,
        action: "domain.primary_changed",
        targetType: "domain",
        targetId: domain.id,
        tenantId,
        before: { primaryDomainId: previous?.id ?? null, primaryHostname: previous?.hostname ?? null },
        after: { primaryDomainId: domain.id, primaryHostname: domain.hostname },
      });
      if (previous !== undefined) {
        this.invalidations.publishAfterCommit(trx, { v: 1, type: "domain", hostname: previous.hostname });
      }
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "domain", hostname: domain.hostname });
      return this.toDomain(await this.reread(trx, tenantId, domain.id));
    });
  }

  /**
   * `checkDomain`: queues the DNS check of a pending or failed custom domain now, after restarting a failed domain's
   * window with the same token (a `domain.verification_restarted` audit row), and answers the domain as it is. A plan
   * without custom domains answers `403 FEATURE_DISABLED` before anything is written or queued, as `addDomain` does
   * (FIX-W39-PLATFORM, lead decision (2h) of 2026-11-02; the switch is the operation's `x-feature`).
   */
  async check(membership: TenantMembership, domainId: string): Promise<Domain> {
    const { tenantId, accountId } = membership;
    const now = this.clock.now();
    const domain = await runInTransaction(this.db, async (trx) => {
      await this.domains.lockTenantDomains(trx, tenantId);
      const locked = await this.lockedDomain(trx, tenantId, domainId);
      customDomainLimitOrThrow(await this.writableTenant(trx, tenantId));
      if (locked.kind !== "custom") {
        throw new AppError("CONFLICT", { details: { reason: "subdomain" } });
      }
      if (locked.verification_status === "verified") {
        throw new AppError("CONFLICT", { details: { reason: "already_verified" } });
      }
      if (locked.verification_status === "failed") {
        const deadline = new Date(now.getTime() + VERIFICATION_WINDOW_MS);
        await this.domains.restartWindow(trx, locked.id, deadline, now);
        await this.audit.record(trx, {
          actorType: "account",
          actorAccountId: accountId,
          action: "domain.verification_restarted",
          targetType: "domain",
          targetId: locked.id,
          tenantId,
          before: {
            verificationStatus: locked.verification_status,
            verificationDeadlineAt: locked.verification_deadline_at?.toISOString() ?? null,
          },
          after: { verificationStatus: "pending", verificationDeadlineAt: deadline.toISOString() },
          details: { hostname: locked.hostname },
        });
        return this.reread(trx, tenantId, locked.id);
      }
      return locked;
    });
    if (!(await this.jobs.enqueueVerify(domain.id))) {
      throw new AppError("SERVICE_UNAVAILABLE");
    }
    return this.toDomain(domain);
  }

  /**
   * `removeDomain`: deletes the custom domain; when it was primary, the sub-domain becomes primary again. A
   * `domain.removed` audit row, then, after the commit, `domain` invalidations for the host (and the sub-domain when the
   * flag moved) and the deletion of the host's cached `tlsask:` answer.
   */
  async remove(membership: TenantMembership, domainId: string): Promise<void> {
    const { tenantId, accountId } = membership;
    const now = this.clock.now();
    await runInTransaction(this.db, async (trx) => {
      await this.domains.lockTenantDomains(trx, tenantId);
      const domain = await this.lockedDomain(trx, tenantId, domainId);
      await this.writableTenant(trx, tenantId);
      if (domain.kind !== "custom") {
        throw new AppError("CONFLICT", { details: { reason: "subdomain" } });
      }
      await this.domains.delete(trx, domain.id);
      const promoted = domain.is_primary
        ? await this.domains.lockSubdomain(trx, tenantId, domain.purpose)
        : undefined;
      if (promoted !== undefined) {
        await this.domains.setPrimary(trx, promoted.id, true, now);
      }
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: accountId,
        action: "domain.removed",
        targetType: "domain",
        targetId: domain.id,
        tenantId,
        before: {
          hostname: domain.hostname,
          verificationStatus: domain.verification_status,
          isPrimary: domain.is_primary,
        },
        ...(promoted === undefined ? {} : { details: { primaryHostname: promoted.hostname } }),
      });
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "domain", hostname: domain.hostname });
      if (promoted !== undefined) {
        this.invalidations.publishAfterCommit(trx, { v: 1, type: "domain", hostname: promoted.hostname });
      }
      afterCommit(trx, () => this.forgetTlsAsk(domain.hostname));
    });
  }

  /**
   * `403 FEATURE_DISABLED` with `details.feature = custom_domains` while FEATURE_CUSTOM_DOMAINS is off: the answer
   * FeatureGuard gives the operations whose `x-feature` names the switch, for `makeDomainPrimary` of a custom domain.
   */
  private customDomainsSwitchOrThrow(): void {
    if (!this.features.isEnabled("custom_domains")) {
      throw new AppError("FEATURE_DISABLED", { details: { feature: "custom_domains" } });
    }
  }

  /** The `Domain` of a row, with this deployment's base domain and storefront addresses. */
  private toDomain(row: DomainListRow): Domain {
    return toDomain(row, this.baseDomain, this.addresses);
  }

  /** The tenant's state for a write: `404` when it is gone, `409 TENANT_NOT_ACTIVE` unless it is `active`. */
  private async writableTenant(trx: PlatformTransaction, tenantId: string): Promise<DomainTenantState> {
    const tenant = await this.domains.tenantState(trx, tenantId);
    if (tenant === undefined) {
      throw new AppError("NOT_FOUND");
    }
    if (tenant.status !== "active") {
      throw new AppError("TENANT_NOT_ACTIVE", { details: { status: tenant.status } });
    }
    return tenant;
  }

  /** The domain `domainId` of the tenant, locked; `404 NOT_FOUND` for a domain of another tenant or none. */
  private async lockedDomain(
    trx: PlatformTransaction,
    tenantId: string,
    domainId: string,
  ): Promise<DomainListRow> {
    const domain = await this.domains.lockForTenant(trx, tenantId, domainId);
    if (domain === undefined) {
      throw new AppError("NOT_FOUND");
    }
    return domain;
  }

  /** The domain as stored now, in `trx`. */
  private async reread(trx: PlatformTransaction, tenantId: string, domainId: string): Promise<DomainListRow> {
    const row = await this.domains.findForTenant(tenantId, domainId, trx);
    if (row === undefined) {
      throw new AppError("NOT_FOUND");
    }
    return row;
  }

  /**
   * Deletes the cached positive `ask` answer of a removed host (PADR-0004 item 6), besides the `domain` invalidation
   * that the API's subscriber also turns into this deletion. Redis is a cache here: a failure is logged and the
   * removal stands (the key expires within 60 s anyway).
   */
  private async forgetTlsAsk(hostname: string): Promise<void> {
    try {
      await this.redis.del(redisKeys.tlsAsk(hostname).key);
    } catch (error) {
      this.logger.warn({ err: error }, "domains.tls_ask_forget_failed");
    }
  }
}
