// The envelope of every message on the cross-backend queues `ota-tenant-ops` (platform → OTA) and
// `platform-tenant-events` (OTA → platform): ADR-0009 item 3, PADR-0001 item 9, platform/docs/architecture.md §6.1.
// Task X-008 defines the envelope and its JSON Schema; the concrete messages (`tenant.provision`,
// `tenant.provisioned`, …), the queue names and the Ajv validator are added on top of it by the platform plan
// (PBE-004, PADR-0016 item 3), and the OTA plan extends them only backward compatibly for one release.
//
// Payload rule (ADR-0009 item 10): messages carry ids and small parameters only, never secrets, card data, tokens
// or traveller documents. The schemas are closed (`additionalProperties: false`), so a stray field is refused.

/** A message name: dotted lower case, `<subject>.<event>`, for example `tenant.provision` or `tenant.migrated`. */
export type JobName = `${string}.${string}`;

/** The payload of a message: a JSON object. Each message defines its own (PBE-004). */
export type JobPayload = Readonly<Record<string, unknown>>;

/** The payload of a message without extra fields, such as `tenant.provision` or `tenant.resume`. */
export type EmptyJobPayload = Readonly<Record<string, never>>;

/**
 * The contract version that every message carries in `v` today (architecture §6.1). A change that is not
 * backward compatible needs a new version, and consumers accept both for one release (ADR-0009, Consequences).
 */
export const JOB_CONTRACT_VERSION = 1;

/**
 * One message on a cross-backend queue. Every message has the same six fields around its own `payload`.
 *
 * `jobId` is the `platform.provisioning_jobs.id` the message belongs to. It is `null` only in the
 * `tenant.migrated` and `tenant.migration_failed` reports of the deploy fan-out, which no job row asked for
 * (ADR-0009 item 3); a message that always answers a job narrows it with `& { readonly jobId: string }`.
 */
export interface JobEnvelope<TName extends JobName = JobName, TPayload extends object = JobPayload> {
  /** Contract version of the message, `1` today ({@link JOB_CONTRACT_VERSION}). */
  readonly v: number;
  /** Message name, for example `tenant.provision`. Consumers dispatch on it. */
  readonly name: TName;
  /** Provisioning job id (`job_` + ULID), or `null` for deploy fan-out reports. */
  readonly jobId: string | null;
  /** Tenant id (`ten_` + ULID) the message is about. */
  readonly tenantId: string;
  /** When the message was produced: ISO 8601 in UTC, as `Date.prototype.toISOString` writes it. */
  readonly requestedAt: string;
  /** Request id of the HTTP request or job run that caused the message, for log correlation (ADR-0016). */
  readonly requestId: string;
  /** The message's own fields: ids and small parameters only (ADR-0009 item 10). */
  readonly payload: TPayload;
}

/** A JSON Schema (draft 2020-12) as a read-only object, ready for Ajv. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** The JSON Schema dialect of every message schema. Compile them with `Ajv2020` (`ajv/dist/2020`). */
export const JOB_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

const ULID = "[0-9A-HJKMNP-TV-Z]{26}";

/** Freezes a schema and everything in it, so a shared schema cannot be changed by one consumer for all. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/** The JSON Schemas of the envelope fields, shared by the envelope and every message schema. */
const FIELD_SCHEMAS = {
  v: { type: "integer", minimum: 1, description: "Contract version of the message." },
  name: {
    type: "string",
    pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$",
    description: "Message name, dotted lower case, for example tenant.provision.",
  },
  jobId: {
    type: "string",
    pattern: `^job_${ULID}$`,
    description: "Id of the platform.provisioning_jobs row the message belongs to (job_ + ULID).",
  },
  tenantId: {
    type: "string",
    pattern: `^ten_${ULID}$`,
    description: "Id of the tenant the message is about (ten_ + ULID).",
  },
  requestedAt: {
    type: "string",
    format: "date-time",
    pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$",
    description: "When the message was produced, ISO 8601 in UTC (Date.prototype.toISOString).",
  },
  requestId: {
    // The pattern of a valid X-Request-Id in @velexis/logger (REQUEST_ID_PATTERN) and the Caddyfile.
    type: "string",
    pattern: "^[A-Za-z0-9._-]{8,128}$",
    description: "Request id of the HTTP request or job run that caused the message.",
  },
} as const;

const ENVELOPE_FIELDS = ["v", "name", "jobId", "tenantId", "requestedAt", "requestId", "payload"] as const;

/**
 * The JSON Schema of {@link JobEnvelope}: any message with the six envelope fields and an object payload, `jobId`
 * nullable. Compile it with `Ajv2020` (`ajv/dist/2020`) and `ajv-formats` (for `date-time`), as ADR-0006 sets
 * Ajv up everywhere. Concrete messages use {@link jobMessageSchema}, which pins `name` and `v` and closes the
 * payload.
 */
export const JOB_ENVELOPE_SCHEMA = deepFreeze({
  $schema: JOB_SCHEMA_DIALECT,
  title: "JobEnvelope",
  description: "A message on a cross-backend queue (ADR-0009 item 3, PADR-0001 item 9).",
  type: "object",
  additionalProperties: false,
  required: ENVELOPE_FIELDS,
  properties: {
    ...FIELD_SCHEMAS,
    jobId: { ...FIELD_SCHEMAS.jobId, type: ["string", "null"] },
    payload: { type: "object", description: "The message's own fields." },
  },
} as const);

/** The payload schema of a message without extra fields. */
export const EMPTY_JOB_PAYLOAD_SCHEMA = deepFreeze({
  type: "object",
  additionalProperties: false,
  properties: {},
} as const);

export interface JobMessageSchemaOptions<TName extends JobName> {
  /** The message name, for example `tenant.provision`; the schema accepts only this name. */
  readonly name: TName;
  /**
   * The JSON Schema of `payload`: `type: "object"` with `additionalProperties: false`, so no field outside the
   * contract (a secret, a token) can travel in it. Default: {@link EMPTY_JOB_PAYLOAD_SCHEMA}.
   */
  readonly payload?: JsonSchema;
  /** The contract version the schema accepts. Default: {@link JOB_CONTRACT_VERSION}. */
  readonly version?: number;
  /** `true` only for the deploy fan-out reports whose `jobId` may be `null` (ADR-0009 item 3). Default: `false`. */
  readonly nullableJobId?: boolean;
  /** A description of the message for the schema. */
  readonly description?: string;
}

/**
 * The JSON Schema of one concrete message on the envelope: `name` and `v` are constants, `jobId` is required and
 * non-null unless `nullableJobId`, and `payload` is the given closed object schema. The result is deep-frozen.
 *
 * @throws {TypeError} on an invalid name or version, or a payload schema that is not a closed object schema.
 */
export function jobMessageSchema<TName extends JobName>(options: JobMessageSchemaOptions<TName>): JsonSchema {
  const { name, payload = EMPTY_JOB_PAYLOAD_SCHEMA, version = JOB_CONTRACT_VERSION } = options;
  if (!new RegExp(FIELD_SCHEMAS.name.pattern).test(name)) {
    throw new TypeError(
      `invalid job message name ${JSON.stringify(name)}: use dotted lower case (tenant.provision)`,
    );
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError(`invalid job contract version ${String(version)}: use an integer of at least 1`);
  }
  if (payload["type"] !== "object" || payload["additionalProperties"] !== false) {
    throw new TypeError(
      `the payload schema of ${name} must be a closed object schema (type "object", additionalProperties false)`,
    );
  }
  return deepFreeze({
    $schema: JOB_SCHEMA_DIALECT,
    title: name,
    ...(options.description === undefined ? {} : { description: options.description }),
    type: "object",
    additionalProperties: false,
    required: [...ENVELOPE_FIELDS],
    properties: {
      ...FIELD_SCHEMAS,
      v: { ...FIELD_SCHEMAS.v, const: version },
      name: { ...FIELD_SCHEMAS.name, const: name },
      jobId:
        options.nullableJobId === true
          ? { ...FIELD_SCHEMAS.jobId, type: ["string", "null"] }
          : FIELD_SCHEMAS.jobId,
      payload: structuredClone(payload),
    },
  });
}
