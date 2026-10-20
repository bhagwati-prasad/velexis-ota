// The rows of the platform admin's tenant views (PBE-029; platform/docs/api-inventory-admin.md §3) as the schemas of
// the OpenAPI document: `AdminTenant` (the portal's `Tenant` without the caller's role, plus the suspension time and
// the internal notes of `tenants.metadata.notes`), `AdminTenantSummary` (one row of the search), `AdminProvisioningJob`
// (a tenant job in the admin lists) and `AuditEntry` (one audit row). The members, invitations, subscription,
// connections and domains of the detail use the mappers of their owners (`toMember`, `toInvitation`,
// `toSubscription`, `toAmadeusConnection`, `toPaymentConnection`, `toDomain`), so the admin shows exactly the masked
// shapes of the portal. Nothing here reads a secret: the rows are selected without ciphertext columns.
import type { components } from "@velexis/api-types/platform";
import type { AuditLogRecord } from "../audit/audit.repository";
import type { TenantStatus } from "../common/auth/tenant-role.guard";
import { MAX_JOB_ERROR_LENGTH, type AdminJobRow } from "../provisioning/provisioning-jobs.repository";
import { storefrontHost } from "../tenants/tenant-key";
import type { AdminTenantListRow, TenantWithHost } from "../tenants/tenants.repository";

export type AdminTenant = components["schemas"]["AdminTenant"];
export type AdminTenantSummary = components["schemas"]["AdminTenantSummary"];
export type AdminProvisioningJob = components["schemas"]["AdminProvisioningJob"];
export type AuditEntry = components["schemas"]["AuditEntry"];

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The internal notes of a `tenants.metadata` value: its `notes` key when that is a string, otherwise `null`. */
export function notesOf(metadata: unknown): string | null {
  const notes = isPlainObject(metadata) ? metadata["notes"] : undefined;
  return typeof notes === "string" ? notes : null;
}

/** The `AdminTenant` of the OpenAPI document for a tenant row with its primary host. */
export function toAdminTenant(row: TenantWithHost, baseDomain: string): AdminTenant {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    legalName: row.legal_name,
    status: row.status as TenantStatus,
    suspensionReason: row.suspension_reason as AdminTenant["suspensionReason"],
    suspendedAt: iso(row.suspended_at),
    billingNotice: row.billing_notice as AdminTenant["billingNotice"],
    planCode: row.plan_code,
    defaultCurrency: row.default_currency,
    countryCode: row.country_code,
    timeZone: row.time_zone,
    supportEmail: row.support_email,
    storefrontEnvironment: row.storefront_environment as AdminTenant["storefrontEnvironment"],
    liveEnabledAt: iso(row.live_enabled_at),
    // Every OTA gets its verified sub-domain as primary at creation (PF-40); the sub-domain name is the fallback.
    primaryHost: row.primary_host ?? storefrontHost(row.key, baseDomain),
    schemaVersion: row.schema_version,
    notes: notesOf(row.metadata),
    createdAt: row.created_at.toISOString(),
    activatedAt: iso(row.activated_at),
    version: row.version,
  };
}

/** The `AdminTenantSummary` of the OpenAPI document for one row of the admin search. */
export function toAdminTenantSummary(row: AdminTenantListRow): AdminTenantSummary {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    status: row.status as TenantStatus,
    planCode: row.plan_code,
    ownerEmail: row.owner_email,
    createdAt: row.created_at.toISOString(),
    activatedAt: iso(row.activated_at),
  };
}

/**
 * The `AdminProvisioningJob` of the OpenAPI document: never the payload, the result or a ciphertext. `error` is cut to
 * the document's 1000 characters, as the portal's `toProvisioningJob` does (the step log's writes store it as given).
 */
export function toAdminProvisioningJob(row: AdminJobRow): AdminProvisioningJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantKey: row.tenant_key,
    kind: row.kind as AdminProvisioningJob["kind"],
    status: row.status as AdminProvisioningJob["status"],
    step: row.step,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    error: row.error === null ? null : row.error.slice(0, MAX_JOB_ERROR_LENGTH),
    scheduledAt: row.scheduled_at.toISOString(),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  };
}

/** The `AuditEntry` of the OpenAPI document for a stored audit row (redacted when it was written). */
export function toAuditEntry(row: AuditLogRecord): AuditEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantKey: row.tenant_key,
    actorType: row.actor_type as AuditEntry["actorType"],
    actorAccountId: row.actor_account_id,
    actorLabel: row.actor_label,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    requestId: row.request_id,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    details: isPlainObject(row.details) ? row.details : {},
    createdAt: row.created_at.toISOString(),
  };
}
