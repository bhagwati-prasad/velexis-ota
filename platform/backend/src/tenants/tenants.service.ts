// The tenant use cases of the portal (platform/docs/api-inventory.md §7; scope PF-10 AC1, PF-13): the live key check
// of the create-OTA wizard, the caller's list of OTAs, the OTA overview and the profile update. Who may call them is
// TenantRoleGuard's (the membership arrives here already checked); this service owns the transaction of the update,
// its audit row and the `tenant` invalidation after the commit (architecture §4).
//
// `toTenant` and `toTenantSummary` map rows to the `Tenant` and `TenantSummary` schemas of the OpenAPI document;
// createTenant (PBE-018) answers its `tenant` with `toTenant` too.
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types/platform";
import { AppError, type FieldError } from "@velexis/errors";
import { AuditService } from "../audit/audit.service";
import type { TenantMembership, TenantRole, TenantStatus } from "../common/auth/tenant-role.guard";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import type { PlatformBackendConfig } from "../config";
import { storefrontHost, tenantKeyProblem } from "./tenant-key";
import {
  TenantsRepository,
  type TenantListRow,
  type TenantProfileChanges,
  type TenantWithHost,
} from "./tenants.repository";

export type Tenant = components["schemas"]["Tenant"];
export type TenantSummary = components["schemas"]["TenantSummary"];
export type TenantList = components["schemas"]["TenantList"];
export type KeyAvailability = components["schemas"]["KeyAvailability"];
export type UpdateTenantRequest = components["schemas"]["UpdateTenantRequest"];

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** The `Tenant` of the OpenAPI document for a row with its primary host, as a member of `role` sees it. */
export function toTenant(row: TenantWithHost, role: TenantRole, baseDomain: string): Tenant {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    legalName: row.legal_name,
    status: row.status as TenantStatus,
    suspensionReason: row.suspension_reason as Tenant["suspensionReason"],
    billingNotice: row.billing_notice as Tenant["billingNotice"],
    planCode: row.plan_code,
    defaultCurrency: row.default_currency,
    countryCode: row.country_code,
    timeZone: row.time_zone,
    supportEmail: row.support_email,
    storefrontEnvironment: row.storefront_environment as Tenant["storefrontEnvironment"],
    liveEnabledAt: iso(row.live_enabled_at),
    // Every OTA gets its verified sub-domain as primary at creation (PF-40); the sub-domain name is the fallback.
    primaryHost: row.primary_host ?? storefrontHost(row.key, baseDomain),
    schemaVersion: row.schema_version,
    createdAt: row.created_at.toISOString(),
    activatedAt: iso(row.activated_at),
    version: row.version,
    myRole: role,
  };
}

/** The `TenantSummary` of the OpenAPI document for one row of an account's list. */
export function toTenantSummary(row: TenantListRow, baseDomain: string): TenantSummary {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    status: row.status as TenantStatus,
    role: row.role as TenantRole,
    planCode: row.plan_code,
    storefrontUrl: `https://${row.primary_host ?? storefrontHost(row.key, baseDomain)}/`,
    storefrontEnvironment: row.storefront_environment as TenantSummary["storefrontEnvironment"],
  };
}

/** The profile fields of UpdateTenantRequest and their columns, in the order of the schema. */
const PROFILE_FIELDS = [
  ["name", "name"],
  ["legalName", "legal_name"],
  ["supportEmail", "support_email"],
  ["countryCode", "country_code"],
  ["timeZone", "time_zone"],
] as const satisfies ReadonlyArray<readonly [keyof UpdateTenantRequest, keyof TenantProfileChanges]>;

@Injectable()
export class TenantsService {
  private readonly baseDomain: string;

  constructor(
    private readonly tenants: TenantsRepository,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
  }

  /**
   * checkTenantKey: whether `key`, as typed, can name a new OTA. The first problem wins: `invalid` (the key rule),
   * `reserved`, then `taken` (any tenant row, in any status). Reads only.
   */
  async checkKey(key: string): Promise<KeyAvailability> {
    const host = storefrontHost(key, this.baseDomain);
    const reason = tenantKeyProblem(key) ?? ((await this.tenants.keyExists(key)) ? "taken" : undefined);
    return reason === undefined
      ? { key, available: true, storefrontHost: host }
      : { key, available: false, reason, storefrontHost: host };
  }

  /** listTenants: the OTAs in which the account has an active membership, oldest first. */
  async list(accountId: string): Promise<TenantList> {
    const rows = await this.tenants.listForMember(accountId);
    return { data: rows.map((row) => toTenantSummary(row, this.baseDomain)) };
  }

  /** getTenant: the OTA of the caller's membership, with the caller's role. */
  async get(membership: TenantMembership): Promise<Tenant> {
    const row = await this.tenants.findWithHost(membership.tenantId);
    if (row === undefined) {
      throw new AppError("NOT_FOUND");
    }
    return toTenant(row, membership.role, this.baseDomain);
  }

  /**
   * updateTenant: writes the profile fields of `request` when `expectedVersion` is the tenant's version (else `412
   * PRECONDITION_FAILED`) and the tenant is `active` (else `409 TENANT_NOT_ACTIVE` with `details.status`), with one
   * `tenant.updated` audit row of the fields that changed and a `tenant` invalidation after the commit. A request that
   * changes nothing writes nothing and answers the tenant as it is.
   */
  async update(
    membership: TenantMembership,
    expectedVersion: number,
    request: UpdateTenantRequest,
  ): Promise<Tenant> {
    const requested = await this.checkedChanges(request);
    const { tenantId, accountId } = membership;
    return runInTransaction(this.db, async (trx) => {
      const current = await this.tenants.lockForUpdate(trx, tenantId);
      if (current === undefined) {
        throw new AppError("NOT_FOUND");
      }
      if (current.version !== expectedVersion) {
        throw new AppError("PRECONDITION_FAILED");
      }
      if (current.status !== "active") {
        throw new AppError("TENANT_NOT_ACTIVE", { details: { status: current.status } });
      }
      const changed = PROFILE_FIELDS.filter(([, column]) => {
        const value = requested[column];
        return value !== undefined && value !== current[column];
      });
      if (changed.length > 0) {
        const changes: Record<string, unknown> = {};
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        for (const [field, column] of changed) {
          changes[column] = requested[column];
          before[field] = current[column];
          after[field] = requested[column];
        }
        await this.tenants.updateProfile(trx, tenantId, changes as TenantProfileChanges, this.clock.now());
        await this.audit.record(trx, {
          actorType: "account",
          actorAccountId: accountId,
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
      return toTenant(row, membership.role, this.baseDomain);
    });
  }

  /**
   * The columns of an update request, after the checks the schema cannot make: the time zone must be a zone of
   * `reference.time_zones` and the country one of `reference.countries`, both by value and stored as sent (never
   * rewritten to another alias, so `Europe/Kyiv` stays `Europe/Kyiv`). Problems answer `400 VALIDATION_FAILED` with
   * field errors that never echo the value.
   */
  private async checkedChanges(request: UpdateTenantRequest): Promise<TenantProfileChanges> {
    const fieldErrors: FieldError[] = [];
    if (request.timeZone !== undefined && !(await this.tenants.timeZoneExists(request.timeZone))) {
      fieldErrors.push({
        path: "/timeZone",
        code: "unknown",
        message: "Must be an IANA time zone of the reference data.",
      });
    }
    if (request.countryCode !== undefined && !(await this.tenants.countryExists(request.countryCode))) {
      fieldErrors.push({
        path: "/countryCode",
        code: "unknown",
        message: "Must be a known ISO 3166-1 alpha-2 country code.",
      });
    }
    if (fieldErrors.length > 0) {
      throw new AppError("VALIDATION_FAILED", { fieldErrors });
    }
    const changes: { -readonly [K in keyof TenantProfileChanges]: TenantProfileChanges[K] } = {};
    if (request.name !== undefined) {
      changes.name = request.name;
    }
    if (request.legalName !== undefined) {
      changes.legal_name = request.legalName;
    }
    if (request.supportEmail !== undefined) {
      changes.support_email = request.supportEmail;
    }
    if (request.countryCode !== undefined) {
      changes.country_code = request.countryCode;
    }
    if (request.timeZone !== undefined) {
      changes.time_zone = request.timeZone;
    }
    return changes;
  }
}
