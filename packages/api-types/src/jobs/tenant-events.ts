// The messages of the queue `platform-tenant-events` (OTA worker → platform): the results of the `ota-tenant-ops`
// messages and the reports of the deploy fan-out, as TypeScript types and JSON Schemas on the X-008 envelope
// (ADR-0009 item 3, PADR-0001 items 5 and 9, OADR-0007 items 5–7, platform/docs/architecture.md §6.1). PBE-004.
//
// `jobId` is the job the event answers. It may be `null` only on `tenant.migrated` and `tenant.migration_failed`,
// which the deploy fan-out (`tenants:report-migrations`) also publishes without a job row. Payloads carry the
// ledger rows, step names and error codes only, never secrets, DSNs or SQL parameters (ADR-0009 item 10).
import {
  EMPTY_JOB_PAYLOAD_SCHEMA,
  jobMessageSchema,
  type EmptyJobPayload,
  type JOB_CONTRACT_VERSION,
  type JobEnvelope,
  type JobName,
  type JsonSchema,
} from "./envelope.js";
import { TENANT_MIGRATION_VERSION_PATTERN, type TenantJobEnvelope } from "./tenant-ops.js";

/**
 * A report of contract version 1 that may come from the deploy fan-out: `jobId` is the job it answers, or `null`
 * when no job row asked for it (ADR-0009 item 3).
 */
export type TenantReportEnvelope<TName extends JobName, TPayload extends object> = JobEnvelope<
  TName,
  TPayload
> & {
  readonly v: typeof JOB_CONTRACT_VERSION;
  readonly jobId: string | null;
};

/**
 * A tenant schema name: `tenant_` and a lower-case key of 2 to 40 characters, the pattern of `assertTenantSchema`
 * in `@velexis/db` (ADR-0004).
 */
export const TENANT_SCHEMA_NAME_PATTERN = "^tenant_[a-z][a-z0-9_]{1,39}$";

/** Expand/contract phases of a numbered tenant migration (conventions §9; tenants have no repeatable files). */
export const TENANT_MIGRATION_PHASES = Object.freeze(["expand", "migrate", "contract"] as const);
export type TenantMigrationPhase = (typeof TENANT_MIGRATION_PHASES)[number];

/** The steps the OTA worker runs for `tenant.provision`, in order (PADR-0001 item 1). */
export const OTA_PROVISIONING_STEPS = Object.freeze([
  "create_schema",
  "run_migrations",
  "seed_defaults",
] as const);
export type OtaProvisioningStep = (typeof OTA_PROVISIONING_STEPS)[number];

/** How a reported step ended. */
export const PROVISIONING_STEP_STATUSES = Object.freeze(["succeeded", "failed", "skipped"] as const);
export type ProvisioningStepStatus = (typeof PROVISIONING_STEP_STATUSES)[number];

// ---- Payload parts ------------------------------------------------------------------------------------------

/** A failure: a stable code and a short message, without values, secrets or connection strings. */
export interface TenantJobError {
  /** Upper-case code, e.g. `LOCK_TIMEOUT`, `CHECKSUM_MISMATCH`, `TENANT_NOT_PROVISIONING`, or a SQLSTATE. */
  readonly code: string;
  /** What went wrong, for the job's error log and ops (at most 1,000 characters). */
  readonly message: string;
}

/** One applied tenant migration: a row of the schema's ledger, mirrored into `tenant_schema_migrations`. */
export interface TenantMigrationRecord {
  /** The ledger id, e.g. `0001_baseline`. */
  readonly version: string;
  /** SHA-256 of the file as applied, lower-case hex. */
  readonly checksum: string;
  readonly phase: TenantMigrationPhase;
  /** When it was applied (ISO 8601 UTC). */
  readonly appliedAt: string;
  /** How long it ran, in milliseconds; `null` when the ledger row has no `execution_ms`. */
  readonly durationMs: number | null;
}

/** One step of the OTA worker's run, appended by the platform to `provisioning_jobs.steps`. */
export interface ProvisioningStepRecord {
  /** The step name, snake case: one of {@link OTA_PROVISIONING_STEPS} today. */
  readonly step: string;
  readonly status: ProvisioningStepStatus;
  /** ISO 8601 UTC. */
  readonly startedAt: string;
  /** ISO 8601 UTC. */
  readonly finishedAt: string;
  /** Why a `failed` step failed. */
  readonly error?: TenantJobError;
}

// ---- Payloads -----------------------------------------------------------------------------------------------

/** `tenant.provisioned`: the schema is complete; the platform mirrors the ledger and runs its post-steps. */
export interface TenantProvisionedPayload {
  /** The tenant schema, e.g. `tenant_acme`. */
  readonly schemaName: string;
  /** The latest applied migration, the new `tenants.schema_version`, e.g. `0001_baseline`. */
  readonly schemaVersion: string;
  /** The schema's full ledger, in apply order. */
  readonly migrations: readonly TenantMigrationRecord[];
  /** The OTA worker's steps of this run. */
  readonly steps: readonly ProvisioningStepRecord[];
}

/** `tenant.provision_failed`: the final result of a failed attempt (BullMQ retries inside it are done). */
export interface TenantProvisionFailedPayload {
  readonly error: TenantJobError;
  /** `true`: the platform may dispatch another attempt with backoff (PADR-0001 item 4). */
  readonly retryable: boolean;
  /** The OTA worker's steps of this run, the failed one last. */
  readonly steps: readonly ProvisioningStepRecord[];
}

/** `tenant.migrated`: the schema is at its target version; the platform mirrors the ledger. */
export interface TenantMigratedPayload {
  /** The latest applied migration, the new `tenants.schema_version`. */
  readonly schemaVersion: string;
  /** The schema's full ledger, in apply order. */
  readonly migrations: readonly TenantMigrationRecord[];
}

/** `tenant.migration_failed`: the migration transaction was rolled back; the platform alerts ops. */
export interface TenantMigrationFailedPayload {
  /** The failing (or first changed) migration, or `null` when no file was at fault (e.g. a lock timeout). */
  readonly version: string | null;
  readonly error: TenantJobError;
  /**
   * `true`: the platform may dispatch another attempt of the `migrate` job (OADR-0007 item 5). Absent counts as
   * `false`; the deploy fan-out reports (`jobId: null`) are never retried by the platform.
   */
  readonly retryable?: boolean;
}

// ---- Messages -----------------------------------------------------------------------------------------------

export type TenantProvisionedEvent = TenantJobEnvelope<"tenant.provisioned", TenantProvisionedPayload>;
export type TenantProvisionFailedEvent = TenantJobEnvelope<
  "tenant.provision_failed",
  TenantProvisionFailedPayload
>;
/** Also published by the deploy fan-out with `jobId: null`. */
export type TenantMigratedEvent = TenantReportEnvelope<"tenant.migrated", TenantMigratedPayload>;
/** Also published by the deploy fan-out with `jobId: null`. */
export type TenantMigrationFailedEvent = TenantReportEnvelope<
  "tenant.migration_failed",
  TenantMigrationFailedPayload
>;
export type TenantSuspendedEvent = TenantJobEnvelope<"tenant.suspended", EmptyJobPayload>;
export type TenantResumedEvent = TenantJobEnvelope<"tenant.resumed", EmptyJobPayload>;

/** Any message on `platform-tenant-events`; it narrows on `name`. */
export type TenantEvent =
  | TenantProvisionedEvent
  | TenantProvisionFailedEvent
  | TenantMigratedEvent
  | TenantMigrationFailedEvent
  | TenantSuspendedEvent
  | TenantResumedEvent;
/** The name of a message on `platform-tenant-events`. */
export type TenantEventName = TenantEvent["name"];

/** The names of the messages on `platform-tenant-events`, in the order of architecture §6.1. */
export const TENANT_EVENT_NAMES = Object.freeze([
  "tenant.provisioned",
  "tenant.provision_failed",
  "tenant.migrated",
  "tenant.migration_failed",
  "tenant.suspended",
  "tenant.resumed",
] as const satisfies readonly TenantEventName[]);

// ---- JSON Schemas -------------------------------------------------------------------------------------------

const UTC_DATE_TIME = {
  type: "string",
  format: "date-time",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$",
} as const;

const MIGRATION_VERSION = { type: "string", pattern: TENANT_MIGRATION_VERSION_PATTERN } as const;

const ERROR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message"],
  properties: {
    code: {
      type: "string",
      pattern: "^[A-Z0-9][A-Z0-9_]{1,63}$",
      description: "Stable upper-case code, e.g. LOCK_TIMEOUT or CHECKSUM_MISMATCH, or a SQLSTATE.",
    },
    message: {
      type: "string",
      minLength: 1,
      maxLength: 1000,
      description: "What went wrong, without values, secrets or connection strings.",
    },
  },
} as const;

const MIGRATIONS_SCHEMA = {
  type: "array",
  minItems: 1,
  description: "The schema's full ledger, in apply order.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["version", "checksum", "phase", "appliedAt", "durationMs"],
    properties: {
      version: { ...MIGRATION_VERSION, description: "Ledger id, e.g. 0001_baseline." },
      checksum: {
        type: "string",
        pattern: "^[0-9a-f]{64}$",
        description: "SHA-256 of the file as applied, lower-case hex.",
      },
      phase: { type: "string", enum: [...TENANT_MIGRATION_PHASES] },
      appliedAt: { ...UTC_DATE_TIME, description: "When it was applied." },
      durationMs: {
        type: ["integer", "null"],
        minimum: 0,
        maximum: 2147483647,
        description: "Execution time in milliseconds, or null when the ledger has none.",
      },
    },
  },
} as const;

const STEPS_SCHEMA = {
  type: "array",
  description: "The OTA worker's steps of this run, in order.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["step", "status", "startedAt", "finishedAt"],
    properties: {
      step: {
        type: "string",
        pattern: "^[a-z][a-z0-9_]{0,63}$",
        description: `Step name, snake case: ${OTA_PROVISIONING_STEPS.join(", ")}.`,
      },
      status: { type: "string", enum: [...PROVISIONING_STEP_STATUSES] },
      startedAt: UTC_DATE_TIME,
      finishedAt: UTC_DATE_TIME,
      error: ERROR_SCHEMA,
    },
  },
} as const;

/** JSON Schema of {@link TenantProvisionedEvent}. */
export const tenantProvisionedEventSchema: JsonSchema = jobMessageSchema({
  name: "tenant.provisioned",
  description:
    "OTA → platform: the tenant schema is complete. The platform mirrors the ledger into " +
    "tenant_schema_migrations and runs its post-steps (PADR-0001).",
  payload: {
    type: "object",
    additionalProperties: false,
    required: ["schemaName", "schemaVersion", "migrations", "steps"],
    properties: {
      schemaName: {
        type: "string",
        pattern: TENANT_SCHEMA_NAME_PATTERN,
        description: "The tenant schema, e.g. tenant_acme.",
      },
      schemaVersion: { ...MIGRATION_VERSION, description: "The latest applied migration." },
      migrations: MIGRATIONS_SCHEMA,
      steps: STEPS_SCHEMA,
    },
  },
});

/** JSON Schema of {@link TenantProvisionFailedEvent}. */
export const tenantProvisionFailedEventSchema: JsonSchema = jobMessageSchema({
  name: "tenant.provision_failed",
  description:
    "OTA → platform: the attempt failed. The platform re-dispatches with backoff when retryable, otherwise " +
    "fails the job and the tenant (PADR-0001 items 4 and 7).",
  payload: {
    type: "object",
    additionalProperties: false,
    required: ["error", "retryable", "steps"],
    properties: {
      error: ERROR_SCHEMA,
      retryable: { type: "boolean", description: "True: another attempt may succeed." },
      steps: STEPS_SCHEMA,
    },
  },
});

/** JSON Schema of {@link TenantMigratedEvent}. */
export const tenantMigratedEventSchema: JsonSchema = jobMessageSchema({
  name: "tenant.migrated",
  nullableJobId: true,
  description:
    "OTA → platform: the schema is migrated. Answers tenant.migrate, or is a deploy fan-out report with " +
    "jobId null. The platform mirrors the ledger and tenants.schema_version.",
  payload: {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "migrations"],
    properties: {
      schemaVersion: { ...MIGRATION_VERSION, description: "The latest applied migration." },
      migrations: MIGRATIONS_SCHEMA,
    },
  },
});

/** JSON Schema of {@link TenantMigrationFailedEvent}. */
export const tenantMigrationFailedEventSchema: JsonSchema = jobMessageSchema({
  name: "tenant.migration_failed",
  nullableJobId: true,
  description:
    "OTA → platform: migrating the schema failed and was rolled back. Answers tenant.migrate, or is a deploy " +
    "fan-out report with jobId null. The platform alerts ops.",
  payload: {
    type: "object",
    additionalProperties: false,
    required: ["version", "error"],
    properties: {
      version: {
        type: ["string", "null"],
        pattern: TENANT_MIGRATION_VERSION_PATTERN,
        description: "The failing (or first changed) migration, or null when no file was at fault.",
      },
      error: ERROR_SCHEMA,
      retryable: {
        type: "boolean",
        description: "True: another attempt of the migrate job may succeed. Absent counts as false.",
      },
    },
  },
});

/** JSON Schema of {@link TenantSuspendedEvent}. */
export const tenantSuspendedEventSchema: JsonSchema = jobMessageSchema({
  name: "tenant.suspended",
  description: "OTA → platform: the suspend housekeeping is done (or was a no-op). The job succeeds.",
  payload: EMPTY_JOB_PAYLOAD_SCHEMA,
});

/** JSON Schema of {@link TenantResumedEvent}. */
export const tenantResumedEventSchema: JsonSchema = jobMessageSchema({
  name: "tenant.resumed",
  description: "OTA → platform: the resume housekeeping is done (or was a no-op). The job succeeds.",
  payload: EMPTY_JOB_PAYLOAD_SCHEMA,
});

/** The JSON Schema of every message on `platform-tenant-events`, by name. */
export const TENANT_EVENT_SCHEMAS: Readonly<Record<TenantEventName, JsonSchema>> = Object.freeze({
  "tenant.provisioned": tenantProvisionedEventSchema,
  "tenant.provision_failed": tenantProvisionFailedEventSchema,
  "tenant.migrated": tenantMigratedEventSchema,
  "tenant.migration_failed": tenantMigrationFailedEventSchema,
  "tenant.suspended": tenantSuspendedEventSchema,
  "tenant.resumed": tenantResumedEventSchema,
});
