// The platform admin's tenant views (PBE-029; platform/docs/api-inventory-admin.md §3, flows/platform-admin-
// operations.md §B, scope PF-81): the OTA search, the control-plane view of one OTA and the edit of its internal notes
// and legal name. Every route is `x-scope: platform_admin`, so AdminAuthGuard has verified an admin access token and
// re-read the account before the controller calls this service.
//
// AdminModule owns no table (architecture §2.1): every read goes through the exported repository of the table's owner
// and is mapped by the owner's mapper where the portal shows the same record, so the admin sees exactly the portal's
// masked shapes, never a secret, a ciphertext, a hash or a token. Admin endpoints never touch tenant schemas
// (PADR-0006 item 8).
//
// - adminListTenants (`list`): every OTA in the statuses of `TenantStatus`, newest first, filtered by `q` (part of the
//   key, the name or an active owner's e-mail address, ignoring letter case), `status` and `planCode`. The cursor is
//   opaque: base64url of `{"id": "<tenant id>"}`, the last tenant of the page; anything else, or the id of no tenant,
//   answers `400 VALIDATION_FAILED` on `/query/cursor`.
// - adminGetTenant (`get`): the OTA, its active members (oldest first), its pending invitations (newest first), the
//   subscription the portal shows (`null` when there is none), its Amadeus and payment connections (`test` before
//   `live`), its domains, its last 20 jobs and its last 50 audit rows (newest first). An unknown id, or a tenant being
//   deprovisioned or deleted (no `TenantStatus`), answers `404 NOT_FOUND`.
// - adminUpdateTenant (`update`): `notes` (`tenants.metadata.notes`, never shown to the OTA) and `legalName`, `null`
//   clearing either, in every tenant status, with `If-Match` (`412 PRECONDITION_FAILED`). One transaction locks the row,
//   writes the change (`version + 1`) and one `tenant.updated` audit row (`actor_type = 'platform_admin'`, the changed
//   fields before and after); after the commit a `tenant` invalidation is published. A request that changes nothing
//   writes nothing and answers the OTA as it is.
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import { AuditService } from "../audit/audit.service";
import type { AccessTokenClaims } from "../auth/token.service";
import { toSubscription } from "../billing/subscriptions.controller";
import { SubscriptionsRepository } from "../billing/subscriptions.repository";
import { MEMBER_VISIBLE_TENANT_STATUSES, type TenantStatus } from "../common/auth/tenant-role.guard";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import type { PlatformBackendConfig } from "../config";
import { DomainsRepository } from "../domains/domains.repository";
import { storefrontAddressesOf, toDomain, type StorefrontAddresses } from "../domains/domains.service";
import { InvitationsRepository } from "../memberships/invitations.repository";
import { toInvitation } from "../memberships/invitations.service";
import { toMember } from "../memberships/members.service";
import { MembershipsRepository } from "../memberships/memberships.repository";
import { toPaymentConnection } from "../payment-connections/payment-connections.controller";
import { PaymentConnectionsRepository } from "../payment-connections/payment-connections.repository";
import { ProvisioningJobsRepository } from "../provisioning/provisioning-jobs.repository";
import {
  SupplierConnectionsRepository,
  toAmadeusConnection,
} from "../supplier-connections/supplier-connections.repository";
import { TenantsRepository, type TenantAdminChanges } from "../tenants/tenants.repository";
import {
  notesOf,
  toAdminProvisioningJob,
  toAdminTenant,
  toAdminTenantSummary,
  toAuditEntry,
  type AdminTenant,
} from "./admin-tenants.mapper";

export type { AdminTenant };
export type AdminTenantList = components["schemas"]["AdminTenantList"];
export type AdminTenantDetail = components["schemas"]["AdminTenantDetail"];
export type UpdateAdminTenantRequest = components["schemas"]["UpdateAdminTenantRequest"];

/** The query of adminListTenants, as the validation interceptor passes it on (`limit` defaults to 50). */
export interface ListAdminTenantsQuery {
  readonly q?: string | undefined;
  readonly status?: TenantStatus | undefined;
  readonly planCode?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** The page size without `limit` (the document's default). */
export const DEFAULT_TENANT_PAGE_LIMIT = 50;

/** The jobs adminGetTenant shows (`recentJobs`, `maxItems: 20`). */
export const RECENT_JOBS_LIMIT = 20;

/** The audit rows adminGetTenant shows (`recentAudit`, `maxItems: 50`). */
export const RECENT_AUDIT_LIMIT = 50;

const TENANT_ID = /^ten_[0-9A-HJKMNP-TV-Z]{26}$/;

/** An opaque cursor: base64url of `{"id": "<tenant id>"}`, the last tenant of the page. */
export function encodeTenantCursor(tenantId: string): string {
  return Buffer.from(JSON.stringify({ id: tenantId }), "utf8").toString("base64url");
}

/** The tenant id of a cursor of the admin search, or `undefined` when it is not one. */
export function decodeTenantCursor(cursor: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const id: unknown = (value as Record<string, unknown>)["id"];
    return Object.keys(value).length === 1 && typeof id === "string" && TENANT_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function invalidCursor(): AppError<"VALIDATION_FAILED"> {
  return new AppError("VALIDATION_FAILED", {
    fieldErrors: [{ path: "/query/cursor", code: "cursor", message: "Is not a cursor of this list." }],
  });
}

/** True when the admin can see a tenant of `status`: the statuses of `TenantStatus`. */
function isShownStatus(status: string): status is TenantStatus {
  return (MEMBER_VISIBLE_TENANT_STATUSES as readonly string[]).includes(status);
}

@Injectable()
export class AdminTenantsService {
  private readonly baseDomain: string;
  private readonly storefrontAddresses: StorefrontAddresses;

  constructor(
    private readonly tenants: TenantsRepository,
    private readonly memberships: MembershipsRepository,
    private readonly invitations: InvitationsRepository,
    private readonly subscriptions: SubscriptionsRepository,
    private readonly amadeusConnections: SupplierConnectionsRepository,
    private readonly paymentConnections: PaymentConnectionsRepository,
    private readonly domains: DomainsRepository,
    private readonly jobs: ProvisioningJobsRepository,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
    this.storefrontAddresses = storefrontAddressesOf(config);
  }

  /** adminListTenants: one page of OTAs, newest first, with the filters of the query. */
  async list(query: ListAdminTenantsQuery): Promise<AdminTenantList> {
    const limit = query.limit ?? DEFAULT_TENANT_PAGE_LIMIT;
    let afterId: string | undefined;
    if (query.cursor !== undefined) {
      afterId = decodeTenantCursor(query.cursor);
      if (afterId === undefined || !(await this.tenants.exists(afterId))) {
        throw invalidCursor();
      }
    }
    const rows = await this.tenants.listForAdmin(
      { q: query.q, status: query.status, planCode: query.planCode },
      afterId,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(toAdminTenantSummary),
      page: {
        nextCursor: rows.length > limit && last !== undefined ? encodeTenantCursor(last.id) : null,
        limit,
      },
    };
  }

  /**
   * adminGetTenant: the control-plane view of the OTA `tenantId`. The reads run one after the other on the pool (an
   * admin page, not a hot path: it never holds more than one of the API's connections).
   */
  async get(tenantId: string): Promise<AdminTenantDetail> {
    const row = await this.tenants.findWithHost(tenantId);
    if (row === undefined || !isShownStatus(row.status)) {
      throw new AppError("NOT_FOUND");
    }
    const members = await this.memberships.listActive(tenantId);
    const invitations = await this.invitations.listPending(tenantId);
    const subscription = await this.subscriptions.findShownForTenant(tenantId);
    const amadeusConnections = await this.amadeusConnections.listForTenant(tenantId);
    const paymentConnections = await this.paymentConnections.listForTenant(tenantId);
    const domains = await this.domains.listForTenant(tenantId);
    const jobs = await this.jobs.recentForTenant(tenantId, RECENT_JOBS_LIMIT);
    const auditRows = await this.audit.recentForTenant(this.db, tenantId, RECENT_AUDIT_LIMIT);
    return {
      tenant: toAdminTenant(row, this.baseDomain),
      members: members.map(toMember),
      invitations: invitations.map(toInvitation),
      subscription: subscription === undefined ? null : toSubscription(subscription),
      amadeusConnections: amadeusConnections.map(toAmadeusConnection),
      paymentConnections: paymentConnections.map(toPaymentConnection),
      domains: domains.map((domain) => toDomain(domain, this.baseDomain, this.storefrontAddresses)),
      recentJobs: jobs.map(toAdminProvisioningJob),
      recentAudit: auditRows.map(toAuditEntry),
    };
  }

  /**
   * adminUpdateTenant: writes `notes` and `legalName` of `request` when `expectedVersion` is the tenant's version (else
   * `412 PRECONDITION_FAILED`), with one `tenant.updated` audit row of the fields that changed and a `tenant`
   * invalidation after the commit.
   */
  async update(
    claims: Pick<AccessTokenClaims, "sub">,
    tenantId: string,
    expectedVersion: number,
    request: UpdateAdminTenantRequest,
  ): Promise<AdminTenant> {
    return runInTransaction(this.db, async (trx) => {
      const current = await this.tenants.lockForUpdate(trx, tenantId);
      if (current === undefined || !isShownStatus(current.status)) {
        throw new AppError("NOT_FOUND");
      }
      if (current.version !== expectedVersion) {
        throw new AppError("PRECONDITION_FAILED");
      }
      const changes: { -readonly [K in keyof TenantAdminChanges]: TenantAdminChanges[K] } = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      if (request.legalName !== undefined && request.legalName !== current.legal_name) {
        changes.legal_name = request.legalName;
        before["legalName"] = current.legal_name;
        after["legalName"] = request.legalName;
      }
      const notes = notesOf(current.metadata);
      if (request.notes !== undefined && request.notes !== notes) {
        changes.notes = request.notes;
        before["notes"] = notes;
        after["notes"] = request.notes;
      }
      if (Object.keys(changes).length > 0) {
        await this.tenants.updateAdminDetails(trx, tenantId, changes, this.clock.now());
        await this.audit.record(trx, {
          actorType: "platform_admin",
          actorAccountId: claims.sub,
          action: "tenant.updated",
          targetType: "tenant",
          targetId: tenantId,
          tenantId,
          before,
          after,
        });
        this.invalidations.publishAfterCommit(trx, { v: 1, type: "tenant", id: tenantId });
      }
      const row = await this.tenants.findWithHost(tenantId, trx);
      if (row === undefined) {
        throw new AppError("NOT_FOUND");
      }
      return toAdminTenant(row, this.baseDomain);
    });
  }
}
