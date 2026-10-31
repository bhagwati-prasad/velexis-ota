// The `tenant_domains` repository (platform/docs/architecture.md §2.1: DomainsModule owns the table). PBE-018 brings
// the sub-domain row of a new OTA: `<key>.<STOREFRONT_BASE_DOMAIN>`, written in the create-OTA transaction, verified
// and primary from the start because Velexis owns the zone (scope PF-40 AC1, signup-and-create-ota.md step 6). PBE-027
// adds the reads of the portal's domain list and of the TLS `ask` endpoint (PADR-0004 item 6): one indexed lookup per
// host (the tenant's unique `key`, or the unique `hostname` of a custom domain), and the host names of a tenant for the
// `vx:invalidate` subscriber. PBE-049 adds the writes of the portal's custom domains (add, make primary, remove), each
// in the caller's transaction under the tenant's domain lock (`lockTenantDomains`), so two concurrent additions cannot
// both take the plan's last free domain and two primary changes cannot cross. PBE-050 adds the DNS verification: the
// pending custom domains of the 5-minute run (`pendingCustomDomainIds`, on the partial index of pending rows), the
// domain a `domain.verify` job checks (`findForCheck`, then `lockForCheck` in the job's transaction), the outcome
// (`markVerified`, `recordCheckFailure`), the restart of a failed domain's window by `checkDomain` (`restartWindow`),
// and the OTA's name and active owners for the owners' e-mails (`tenantLabel`, `activeOwners`, read only).
// Kysely on the process's `PLATFORM_DB` (the API's or the worker's pool), schema-qualified tables (ADR-0005).
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "@velexis/db";
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

/** What a domain write of the portal needs to know about the tenant: its status and its plan's limits. */
export interface DomainTenantState {
  readonly status: string;
  /** `plans.limits` of the tenant's plan (`customDomains` among them); `null` when the plan row is missing. */
  readonly limits: unknown;
}

/** A custom storefront domain as `addDomain` writes it. */
export interface NewCustomDomain {
  /** `dom_…`. */
  readonly id: string;
  readonly tenantId: string;
  /** The normalised host name (hostname-rules.ts). */
  readonly hostname: string;
  /** `vx-verify-` and 32 base32 characters, the value of `TXT _velexis.<host>`. */
  readonly verificationToken: string;
  /** The end of the 72-hour verification window. */
  readonly verificationDeadlineAt: Date;
  /** `acc_…` of the owner or admin who added it. */
  readonly createdByAccountId: string;
  /** The time of the addition: `created_at` and `updated_at`. */
  readonly now: Date;
}

/** One domain row, by its id and host name. */
export interface DomainRef {
  readonly id: string;
  readonly hostname: string;
}

/** A domain as a DNS check reads it: the portal's row with its tenant and the verification state. */
export interface DomainCheckRow extends DomainListRow {
  readonly tenant_id: string;
  readonly verified_at: Date | null;
  readonly check_failures: number;
}

/** The name, key, status and deletion time of a tenant, for the owners' e-mails. */
export interface DomainTenantLabel {
  readonly name: string;
  readonly key: string;
  readonly status: string;
  readonly deleted_at: Date | null;
}

/** An active owner of a tenant, with the address the owners' e-mails go to. */
export interface DomainOwner {
  readonly account_id: string;
  readonly email: string;
  readonly full_name: string;
}

/** The outcome of a failed DNS check, as `recordCheckFailure` writes it. */
export interface DomainCheckFailure {
  /** The error code of domain-checks.ts (`txt_missing`, …). */
  readonly error: string;
  /** True when the verification window has ended: the domain becomes `failed`. */
  readonly failed: boolean;
  readonly now: Date;
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
    return this.domainRows(db)
      .where("d.tenant_id", "=", tenantId)
      .orderBy("d.is_primary", "desc")
      .orderBy("d.created_at")
      .orderBy("d.id")
      .execute();
  }

  /**
   * The domain `domainId` of the tenant, with the tenant's key, read in `trx` and locked (`FOR UPDATE` of the domain
   * row) until the transaction ends; `undefined` for a domain of another tenant or none.
   */
  async lockForTenant(
    trx: PlatformTransaction,
    tenantId: string,
    domainId: string,
  ): Promise<DomainListRow | undefined> {
    return this.domainRows(trx)
      .where("d.tenant_id", "=", tenantId)
      .where("d.id", "=", domainId)
      .forUpdate("d")
      .executeTakeFirst();
  }

  /** The domain `domainId` of the tenant as stored now, with the tenant's key, read on `db`. */
  async findForTenant(
    tenantId: string,
    domainId: string,
    db: PlatformDb | PlatformTransaction = this.db,
  ): Promise<DomainListRow | undefined> {
    return this.domainRows(db)
      .where("d.tenant_id", "=", tenantId)
      .where("d.id", "=", domainId)
      .executeTakeFirst();
  }

  /**
   * Serialises the domain writes of one tenant until `trx` ends (a transaction-scoped advisory lock): the plan limit of
   * `addDomain` counts and inserts under it, and the primary flag moves under it.
   */
  async lockTenantDomains(trx: PlatformTransaction, tenantId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`platform.tenant_domains:${tenantId}`}, 0))`.execute(
      trx,
    );
  }

  /** The tenant's status and plan limits, read in `trx`; `undefined` when there is no such tenant. */
  async tenantState(trx: PlatformTransaction, tenantId: string): Promise<DomainTenantState | undefined> {
    return trx
      .selectFrom("platform.tenants as t")
      .leftJoin("platform.plans as p", "p.code", "t.plan_code")
      .select(["t.status", "p.limits"])
      .where("t.id", "=", tenantId)
      .executeTakeFirst();
  }

  /** The tenant's custom domains in any status: what counts against `plans.limits.customDomains`. */
  async countCustom(trx: PlatformTransaction, tenantId: string): Promise<number> {
    const row = await trx
      .selectFrom("platform.tenant_domains")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("tenant_id", "=", tenantId)
      .where("kind", "=", "custom")
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /** True when any tenant has a domain row with this host name, in any status (`tenant_domains_hostname_uq`). */
  async hostnameExists(trx: PlatformTransaction, hostname: string): Promise<boolean> {
    const row = await trx
      .selectFrom("platform.tenant_domains")
      .select("id")
      .where("hostname", "=", hostname)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Inserts a custom storefront domain in `trx`: `kind = 'custom'`, `purpose = 'storefront'`, not primary, `pending`
   * with its verification value and deadline, TLS `pending`, and the creating account. A host name another row has
   * fails on `tenant_domains_hostname_uq` (HOSTNAME_UNIQUE_INDEX).
   */
  async insertCustom(trx: PlatformTransaction, domain: NewCustomDomain): Promise<void> {
    await trx
      .insertInto("platform.tenant_domains")
      .values({
        id: domain.id,
        tenant_id: domain.tenantId,
        hostname: domain.hostname,
        kind: "custom",
        purpose: "storefront",
        is_primary: false,
        verification_status: "pending",
        verification_token: domain.verificationToken,
        verification_deadline_at: domain.verificationDeadlineAt,
        created_by_account_id: domain.createdByAccountId,
        created_at: domain.now,
        updated_at: domain.now,
      })
      .execute();
  }

  /** The tenant's primary host for `purpose`, locked in `trx`; `undefined` when none is primary. */
  async lockPrimary(
    trx: PlatformTransaction,
    tenantId: string,
    purpose: string,
  ): Promise<DomainRef | undefined> {
    return trx
      .selectFrom("platform.tenant_domains")
      .select(["id", "hostname"])
      .where("tenant_id", "=", tenantId)
      .where("purpose", "=", purpose)
      .where("is_primary", "=", true)
      .forUpdate()
      .executeTakeFirst();
  }

  /** The tenant's sub-domain for `purpose` (`kind = 'subdomain'`), locked in `trx`; `undefined` when it has none. */
  async lockSubdomain(
    trx: PlatformTransaction,
    tenantId: string,
    purpose: string,
  ): Promise<DomainRef | undefined> {
    return trx
      .selectFrom("platform.tenant_domains")
      .select(["id", "hostname"])
      .where("tenant_id", "=", tenantId)
      .where("purpose", "=", purpose)
      .where("kind", "=", "subdomain")
      .orderBy("created_at")
      .orderBy("id")
      .forUpdate()
      .executeTakeFirst();
  }

  /** Sets the primary flag of one domain row at `now`. */
  async setPrimary(trx: PlatformTransaction, domainId: string, isPrimary: boolean, now: Date): Promise<void> {
    await trx
      .updateTable("platform.tenant_domains")
      .set({ is_primary: isPrimary, updated_at: now })
      .where("id", "=", domainId)
      .execute();
  }

  /** Deletes one domain row. */
  async delete(trx: PlatformTransaction, domainId: string): Promise<void> {
    await trx.deleteFrom("platform.tenant_domains").where("id", "=", domainId).execute();
  }

  /**
   * The ids of every `pending` custom domain, the oldest deadline first (`tenant_domains_pending_idx`): one
   * `domain.verify` job each in the 5-minute run.
   */
  async pendingCustomDomainIds(): Promise<string[]> {
    const rows = await this.db
      .selectFrom("platform.tenant_domains")
      .select("id")
      .where("verification_status", "=", "pending")
      .where("kind", "=", "custom")
      .orderBy("verification_deadline_at")
      .orderBy("id")
      .execute();
    return rows.map((row) => row.id);
  }

  /** The domain `domainId` with its tenant, as a DNS check reads it before asking DNS; `undefined` when it is gone. */
  async findForCheck(domainId: string): Promise<DomainCheckRow | undefined> {
    return this.checkRows(this.db).where("d.id", "=", domainId).executeTakeFirst();
  }

  /** The domain `domainId` with its tenant, read in `trx` and locked (`FOR UPDATE` of the domain row). */
  async lockForCheck(trx: PlatformTransaction, domainId: string): Promise<DomainCheckRow | undefined> {
    return this.checkRows(trx).where("d.id", "=", domainId).forUpdate("d").executeTakeFirst();
  }

  /** A passed check: `verified` at `now`, no failure counted, no error, checked at `now`. */
  async markVerified(trx: PlatformTransaction, domainId: string, now: Date): Promise<void> {
    await trx
      .updateTable("platform.tenant_domains")
      .set({
        verification_status: "verified",
        verified_at: now,
        check_failures: 0,
        last_checked_at: now,
        last_check_error: null,
        updated_at: now,
      })
      .where("id", "=", domainId)
      .execute();
  }

  /** A failed check: its time and error code, and `failed` when the window has ended. */
  async recordCheckFailure(
    trx: PlatformTransaction,
    domainId: string,
    failure: DomainCheckFailure,
  ): Promise<void> {
    await trx
      .updateTable("platform.tenant_domains")
      .set({
        last_checked_at: failure.now,
        last_check_error: failure.error,
        updated_at: failure.now,
        ...(failure.failed ? { verification_status: "failed" } : {}),
      })
      .where("id", "=", domainId)
      .execute();
  }

  /** A failed domain's new verification window: `pending` again until `deadline`, with the same token. */
  async restartWindow(trx: PlatformTransaction, domainId: string, deadline: Date, now: Date): Promise<void> {
    await trx
      .updateTable("platform.tenant_domains")
      .set({ verification_status: "pending", verification_deadline_at: deadline, updated_at: now })
      .where("id", "=", domainId)
      .execute();
  }

  /** The name, key, status and deletion time of the tenant `tenantId`, read in `trx`; `undefined` without one. */
  async tenantLabel(trx: PlatformTransaction, tenantId: string): Promise<DomainTenantLabel | undefined> {
    return trx
      .selectFrom("platform.tenants")
      .select(["name", "key", "status", "deleted_at"])
      .where("id", "=", tenantId)
      .executeTakeFirst();
  }

  /**
   * The active owners of `tenantId`, oldest membership first, with their e-mail address and name (read only), in
   * `trx`. An account that is disabled or deleted is left out.
   */
  async activeOwners(trx: PlatformTransaction, tenantId: string): Promise<DomainOwner[]> {
    return trx
      .selectFrom("platform.tenant_memberships as m")
      .innerJoin("platform.accounts as a", "a.id", "m.account_id")
      .select(["m.account_id", "a.email", "a.full_name"])
      .where("m.tenant_id", "=", tenantId)
      .where("m.role", "=", "owner")
      .where("m.status", "=", "active")
      .where("a.status", "not in", ["disabled", "deleted"])
      .where("a.deleted_at", "is", null)
      .orderBy("m.created_at")
      .orderBy("m.id")
      .execute();
  }

  /** The columns of DomainCheckRow: the portal's columns, the tenant and the verification state. */
  private checkRows(db: PlatformDb | PlatformTransaction) {
    return this.domainRows(db).select(["d.tenant_id", "d.verified_at", "d.check_failures"]);
  }

  /** The columns of DomainListRow: a domain row with its tenant's key. */
  private domainRows(db: PlatformDb | PlatformTransaction) {
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
      ]);
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
