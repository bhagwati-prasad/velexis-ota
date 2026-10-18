// The domain reads of the portal (PBE-027; platform/docs/api-inventory-resources.md §2, flows/custom-domains.md,
// PADR-0004; scope PF-40): `listDomains` answers the OTA's storefront hosts to any member. The Velexis sub-domain
// `<key>.<STOREFRONT_BASE_DOMAIN>` needs no DNS record; a custom domain (M5) lists the records its owner creates
// (PADR-0004 item 2): the ownership record `TXT _velexis.<host>` with the row's verification value, and the routing
// record `CNAME <host>` to the OTA's sub-domain. The apex alternative (`A`/`AAAA` to the storefront addresses) joins the
// list with `STOREFRONT_IPV4` and `STOREFRONT_IPV6`, which the M5 domain tasks add to the configuration (PBE-049).
// Who may call it is TenantRoleGuard's (every member); the membership arrives here checked.
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types/platform";
import type { TenantMembership } from "../common/auth/tenant-role.guard";
import type { PlatformBackendConfig } from "../config";
import { DomainsRepository, type DomainListRow } from "./domains.repository";

export type Domain = components["schemas"]["Domain"];
export type DomainList = components["schemas"]["DomainList"];
export type DnsRecord = components["schemas"]["DnsRecord"];

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/**
 * The DNS records of a domain row: none for the sub-domain (Velexis owns the zone); for a custom domain the ownership
 * `TXT _velexis.<host>` and the routing `CNAME <host>` to `<key>.<baseDomain>` (PADR-0004 item 2).
 */
export function dnsRecordsOf(row: DomainListRow, baseDomain: string): DnsRecord[] {
  if (row.kind !== "custom" || row.verification_token === null) {
    return [];
  }
  return [
    { type: "TXT", name: `_velexis.${row.hostname}`, value: row.verification_token },
    { type: "CNAME", name: row.hostname, value: `${row.tenant_key}.${baseDomain}` },
  ];
}

/** The `Domain` of the OpenAPI document for a row of the tenant. */
export function toDomain(row: DomainListRow, baseDomain: string): Domain {
  return {
    id: row.id,
    hostname: row.hostname,
    kind: row.kind as Domain["kind"],
    purpose: row.purpose as Domain["purpose"],
    isPrimary: row.is_primary,
    verificationStatus: row.verification_status as Domain["verificationStatus"],
    dnsRecords: dnsRecordsOf(row, baseDomain),
    verificationDeadlineAt: iso(row.verification_deadline_at),
    lastCheckedAt: iso(row.last_checked_at),
    lastCheckError: row.last_check_error,
    tlsStatus: row.tls_status as Domain["tlsStatus"],
    tlsExpiresAt: iso(row.tls_expires_at),
    createdAt: row.created_at.toISOString(),
  };
}

@Injectable()
export class DomainsService {
  private readonly baseDomain: string;

  constructor(
    private readonly domains: DomainsRepository,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
  }

  /** `listDomains`: the OTA's storefront hosts, primary first, then oldest first. */
  async list(membership: TenantMembership): Promise<DomainList> {
    const rows = await this.domains.listForTenant(membership.tenantId);
    return { data: rows.map((row) => toDomain(row, this.baseDomain)) };
  }
}
