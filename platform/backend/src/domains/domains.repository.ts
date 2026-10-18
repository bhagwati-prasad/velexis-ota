// The `tenant_domains` repository (platform/docs/architecture.md §2.1: DomainsModule owns the table). PBE-018 brings
// the sub-domain row of a new OTA: `<key>.<STOREFRONT_BASE_DOMAIN>`, written in the create-OTA transaction, verified
// and primary from the start because Velexis owns the zone (scope PF-40 AC1, signup-and-create-ota.md step 6). PBE-027
// adds the reads of the portal's domain list and of the TLS `ask` endpoint (PADR-0004 item 6): one indexed lookup per
// host (the tenant's unique `key`, or the unique `hostname` of a custom domain), and the host names of a tenant for the
// `vx:invalidate` subscriber. The custom domains and the DNS checks come with M5. Kysely on the API's `PLATFORM_DB`,
// schema-qualified tables (ADR-0005).
import { Inject, Injectable } from "@nestjs/common";
import type { PlatformTransaction } from "../audit/audit.repository";
import { PLATFORM_DB, type PlatformDb } from "../common/database";

/** The unique index on `tenant_domains.hostname` (migration 0001): one row per host name, in any tenant. */
export const HOSTNAME_UNIQUE_INDEX = "tenant_domains_hostname_uq";

/** The storefront sub-domain of a new OTA. */
export interface NewSubdomain {
  /** `dom_…`. */
  readonly id: string;
  readonly tenantId: string;
  /** `<key>.<STOREFRONT_BASE_DOMAIN>`, lower case (`tenant_domains.hostname` is unique and lower case). */
  readonly hostname: string;
  /** The time of the creation: `verified_at`, `created_at` and `updated_at`. */
  readonly now: Date;
}

/** The sub-domain row as written. */
export interface SubdomainRow {
  readonly id: string;
  readonly hostname: string;
  readonly is_primary: boolean;
  readonly verification_status: string;
}

/** A domain of a tenant as the portal lists it, with the tenant's key (the CNAME target of a custom domain). */
export interface DomainListRow {
  readonly id: string;
  readonly hostname: string;
  readonly kind: string;
  readonly purpose: string;
  readonly is_primary: boolean;
  readonly verification_status: string;
  /** The `TXT _velexis.<host>` value of a custom domain; `null` for the sub-domain. */
  readonly verification_token: string | null;
  readonly verification_deadline_at: Date | null;
  readonly last_checked_at: Date | null;
  readonly last_check_error: string | null;
  readonly tls_status: string;
  readonly tls_expires_at: Date | null;
  readonly created_at: Date;
  readonly tenant_key: string;
}

/** What the `ask` rule of a verified custom storefront domain needs: its tenant's status and plan limits. */
export interface CustomStorefrontTarget {
  readonly tenant_status: string;
  /** `plans.limits` of the tenant's plan (`customDomains` among them); `null` when the plan row is missing. */
  readonly limits: unknown;
}

/** A tenant's key and the host names of its domain rows (sub-domain and custom domains, any status). */
export interface TenantHosts {
  readonly key: string;
  readonly hostnames: readonly string[];
}

@Injectable()
export class DomainsRepository {
  constructor(@Inject(PLATFORM_DB) private readonly db: PlatformDb) {}

  /**
   * The domains of a tenant, primary first, then oldest first, each with the tenant's key, read on `db` (the pool, or
   * the caller's transaction).
   */
  async listForTenant(
    tenantId: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<DomainListRow[]> {
    return db
      .selectFrom("platform.tenant_domains as d")
      .innerJoin("platform.tenants as t", "t.id", "d.tenant_id")
      .select([
        "d.id",
        "d.hostname",
        "d.kind",
        "d.purpose",
        "d.is_primary",
        "d.verification_status",
        "d.verification_token",
        "d.verification_deadline_at",
        "d.last_checked_at",
        "d.last_check_error",
        "d.tls_status",
        "d.tls_expires_at",
        "d.created_at",
        "t.key as tenant_key",
      ])
      .where("d.tenant_id", "=", tenantId)
      .orderBy("d.is_primary", "desc")
      .orderBy("d.created_at")
      .orderBy("d.id")
      .execute();
  }

  /** The status of the tenant whose key is `key` (`tenants.key`, unique); `undefined` when no tenant has it. */
  async tenantStatusByKey(key: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom("platform.tenants")
      .select("status")
      .where("key", "=", key)
      .executeTakeFirst();
    return row?.status;
  }

  /**
   * The verified custom storefront domain `hostname` (`kind = 'custom'`, `purpose = 'storefront'`, `verification_status
   * = 'verified'`) with its tenant's status and plan limits; `undefined` when there is none. One lookup on the unique
   * host name index.
   */
  async verifiedCustomStorefront(hostname: string): Promise<CustomStorefrontTarget | undefined> {
    return this.db
      .selectFrom("platform.tenant_domains as d")
      .innerJoin("platform.tenants as t", "t.id", "d.tenant_id")
      .leftJoin("platform.plans as p", "p.code", "t.plan_code")
      .select(["t.status as tenant_status", "p.limits"])
      .where("d.hostname", "=", hostname)
      .where("d.kind", "=", "custom")
      .where("d.purpose", "=", "storefront")
      .where("d.verification_status", "=", "verified")
      .executeTakeFirst();
  }

  /** The tenant's key and the host names of all its domain rows; `undefined` when there is no such tenant. */
  async hostsOfTenant(tenantId: string): Promise<TenantHosts | undefined> {
    const rows = await this.db
      .selectFrom("platform.tenants as t")
      .leftJoin("platform.tenant_domains as d", "d.tenant_id", "t.id")
      .select(["t.key", "d.hostname"])
      .where("t.id", "=", tenantId)
      .execute();
    const [first] = rows;
    if (first === undefined) {
      return undefined;
    }
    return {
      key: first.key,
      hostnames: rows.flatMap((row) => (row.hostname === null ? [] : [row.hostname])),
    };
  }

  /**
   * Inserts the sub-domain of a new OTA in `trx`: `kind = 'subdomain'`, `purpose = 'storefront'`, primary, `verified`
   * at `now`, no verification token or deadline (only custom domains have them), TLS `pending` until the first HTTPS
   * request obtains a certificate, and no creating account (migration 0002: NULL for the provisioned sub-domain). A
   * host name another row has fails on `tenant_domains_hostname_uq`.
   */
  async insertSubdomain(trx: PlatformTransaction, domain: NewSubdomain): Promise<SubdomainRow> {
    return trx
      .insertInto("platform.tenant_domains")
      .values({
        id: domain.id,
        tenant_id: domain.tenantId,
        hostname: domain.hostname,
        kind: "subdomain",
        purpose: "storefront",
        is_primary: true,
        verification_status: "verified",
        verified_at: domain.now,
        created_at: domain.now,
        updated_at: domain.now,
      })
      .returning(["id", "hostname", "is_primary", "verification_status"])
      .executeTakeFirstOrThrow();
  }
}
