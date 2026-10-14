// The messages of the queue `ota-tenant-ops` (platform → OTA worker): `tenant.provision`, `tenant.migrate`,
// `tenant.suspend` and `tenant.resume`, as TypeScript types and JSON Schemas on the X-008 envelope (ADR-0009
// item 3, PADR-0001 items 3 and 9, PADR-0014, platform/docs/architecture.md §6.1). Task PBE-004.
//
// Every message belongs to a `platform.provisioning_jobs` row, so `jobId` is never `null`. Payloads carry ids and
// small parameters only (ADR-0009 item 10): the OTA worker reads everything else (key, name, currency, locale,
// schema name) from `platform.tenants` with its read-only role.
import {
  EMPTY_JOB_PAYLOAD_SCHEMA,
  jobMessageSchema,
  type EmptyJobPayload,
  type JOB_CONTRACT_VERSION,
  type JobEnvelope,
  type JobName,
  type JsonSchema,
} from "./envelope.js";

/**
 * A message of contract version 1 that belongs to a provisioning job: `v` is `1` and `jobId` is the
 * `platform.provisioning_jobs.id` (never `null`).
 */
export type TenantJobEnvelope<TName extends JobName, TPayload extends object> = JobEnvelope<
  TName,
  TPayload
> & {
  readonly v: typeof JOB_CONTRACT_VERSION;
  readonly jobId: string;
};

/**
 * A tenant migration version: the file name of a numbered tenant migration without `.sql`, for example
 * `0001_baseline` (the CHECK of `platform.tenant_schema_migrations.version` and of the tenant ledger).
 */
export const TENANT_MIGRATION_VERSION_PATTERN = "^[0-9]{4,14}(_[a-z0-9_]+)?$";

/** Why a tenant is suspended (PADR-0014 item 1, CHECK `tenants_suspension_reason_ck`). */
export const TENANT_SUSPENSION_REASONS = Object.freeze(["billing", "abuse", "request", "admin"] as const);
export type TenantSuspensionReason = (typeof TENANT_SUSPENSION_REASONS)[number];

// ---- Payloads -----------------------------------------------------------------------------------------------

/** `tenant.migrate`: apply the pending tenant migrations, up to `targetVersion` when given (else all). */
export interface TenantMigratePayload {
  /** The last migration to apply, for example `0003_add_loyalty`; absent: every pending migration. */
  readonly targetVersion?: string;
}

/** `tenant.suspend`: housekeeping after the platform suspended the tenant (PADR-0014 item 3). */
export interface TenantSuspendPayload {
  /** The `tenants.suspension_reason` the platform set. */
  readonly reason: TenantSuspensionReason;
}

// ---- Messages -----------------------------------------------------------------------------------------------

/** Create, migrate, grant and seed the tenant schema in one transaction (OADR-0007). No extra fields. */
export type TenantProvisionJob = TenantJobEnvelope<"tenant.provision", EmptyJobPayload>;
/** Apply pending migrations to the tenant schema (admin `adminMigrateTenant`). */
export type TenantMigrateJob = TenantJobEnvelope<"tenant.migrate", TenantMigratePayload>;
/** Expire open checkouts and deny staff refresh of a suspended tenant (PADR-0014 item 3). */
export type TenantSuspendJob = TenantJobEnvelope<"tenant.suspend", TenantSuspendPayload>;
/** Re-enable the tenant's schedulers and staff refresh after a resume (PADR-0014 item 4). No extra fields. */
export type TenantResumeJob = TenantJobEnvelope<"tenant.resume", EmptyJobPayload>;

/** Any message on `ota-tenant-ops`; it narrows on `name`. */
export type TenantOpsJob = TenantProvisionJob | TenantMigrateJob | TenantSuspendJob | TenantResumeJob;
/** The name of a message on `ota-tenant-ops`. */
export type TenantOpsJobName = TenantOpsJob["name"];

/** The names of the messages on `ota-tenant-ops`, in the order of architecture §6.1. */
export const TENANT_OPS_JOB_NAMES = Object.freeze([
  "tenant.provision",
  "tenant.migrate",
  "tenant.suspend",
  "tenant.resume",
] as const satisfies readonly TenantOpsJobName[]);

// ---- JSON Schemas -------------------------------------------------------------------------------------------

/** JSON Schema of {@link TenantProvisionJob}. */
export const tenantProvisionJobSchema: JsonSchema = jobMessageSchema({
  name: "tenant.provision",
  description:
    "Platform → OTA: create the tenant schema, apply every tenant migration, grant velexis_ota_app and seed " +
    "the defaults in one transaction as velexis_provisioner (PADR-0001, OADR-0007). Answered by " +
    "tenant.provisioned or tenant.provision_failed.",
  payload: EMPTY_JOB_PAYLOAD_SCHEMA,
});

/** JSON Schema of {@link TenantMigrateJob}. */
export const tenantMigrateJobSchema: JsonSchema = jobMessageSchema({
  name: "tenant.migrate",
  description:
    "Platform → OTA: apply the pending tenant migrations to the schema, up to targetVersion when given. " +
    "Answered by tenant.migrated or tenant.migration_failed.",
  payload: {
    type: "object",
    additionalProperties: false,
    properties: {
      targetVersion: {
        type: "string",
        pattern: TENANT_MIGRATION_VERSION_PATTERN,
        description: "The last migration to apply, e.g. 0003_add_loyalty; absent: every pending migration.",
      },
    },
  },
});

/** JSON Schema of {@link TenantSuspendJob}. */
export const tenantSuspendJobSchema: JsonSchema = jobMessageSchema({
  name: "tenant.suspend",
  description:
    "Platform → OTA: housekeeping for a suspended tenant (expire open checkouts and void their authorisations, " +
    "deny staff refresh). No-op if the tenant is no longer suspended (PADR-0014). Answered by tenant.suspended.",
  payload: {
    type: "object",
    additionalProperties: false,
    required: ["reason"],
    properties: {
      reason: {
        type: "string",
        enum: [...TENANT_SUSPENSION_REASONS],
        description: "The suspension reason the platform set (tenants.suspension_reason).",
      },
    },
  },
});

/** JSON Schema of {@link TenantResumeJob}. */
export const tenantResumeJobSchema: JsonSchema = jobMessageSchema({
  name: "tenant.resume",
  description:
    "Platform → OTA: re-enable the tenant's schedulers and staff refresh. No-op if the tenant is not active " +
    "(PADR-0014). Answered by tenant.resumed.",
  payload: EMPTY_JOB_PAYLOAD_SCHEMA,
});

/** The JSON Schema of every message on `ota-tenant-ops`, by name. */
export const TENANT_OPS_JOB_SCHEMAS: Readonly<Record<TenantOpsJobName, JsonSchema>> = Object.freeze({
  "tenant.provision": tenantProvisionJobSchema,
  "tenant.migrate": tenantMigrateJobSchema,
  "tenant.suspend": tenantSuspendJobSchema,
  "tenant.resume": tenantResumeJobSchema,
});
