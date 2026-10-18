// The `tenant_domains` repository (platform/docs/architecture.md §2.1: DomainsModule owns the table). PBE-018 brings
// the sub-domain row of a new OTA: `<key>.<STOREFRONT_BASE_DOMAIN>`, written in the create-OTA transaction, verified
// and primary from the start because Velexis owns the zone (scope PF-40 AC1, signup-and-create-ota.md step 6). The
// custom domains, the DNS checks and the TLS `ask` reads come with PBE-027 and M5. Kysely on the API's `PLATFORM_DB`,
// schema-qualified tables (ADR-0005).
import { Injectable } from "@nestjs/common";
import type { PlatformTransaction } from "../audit/audit.repository";

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

@Injectable()
export class DomainsRepository {
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
