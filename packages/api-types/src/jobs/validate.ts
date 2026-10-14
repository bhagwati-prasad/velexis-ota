// Validation of the cross-backend messages with Ajv (ADR-0009 item 3, ADR-0006: Ajv 2020 and ajv-formats):
// `validateJob` for the `tenant.*` messages of both queues and `validateInvalidation` for the `vx:invalidate`
// events. The schemas are compiled once, on the first call, by one Ajv instance in strict mode. Task PBE-004.
//
// Producers validate before `queue.add` or `publish`, consumers on receipt; an invalid message is a bug of the
// other side and is not retried (the OTA worker turns it into BullMQ's `UnrecoverableError`, OBE-002). The errors
// name the failing paths and rules only, never the values, so they can be logged without the payload.
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { JsonSchema } from "./envelope.js";
import {
  INVALIDATION_CHANNEL,
  INVALIDATION_EVENT_SCHEMA,
  INVALIDATION_EVENT_SCHEMAS,
  INVALIDATION_TYPES,
  type InvalidationEvent,
  type InvalidationType,
} from "./invalidation.js";
import {
  TENANT_EVENT_SCHEMAS,
  type TenantEvent,
  type TenantEventName,
  type TenantMigratedEvent,
  type TenantMigrationFailedEvent,
  type TenantProvisionedEvent,
  type TenantProvisionFailedEvent,
  type TenantResumedEvent,
  type TenantSuspendedEvent,
} from "./tenant-events.js";
import {
  TENANT_OPS_JOB_SCHEMAS,
  type TenantMigrateJob,
  type TenantOpsJob,
  type TenantOpsJobName,
  type TenantProvisionJob,
  type TenantResumeJob,
  type TenantSuspendJob,
} from "./tenant-ops.js";

/** The name of any `tenant.*` message of the two queues. */
export type TenantJobName = TenantOpsJobName | TenantEventName;
/** Any `tenant.*` message of the two queues; it narrows on `name`. */
export type TenantJobMessage = TenantOpsJob | TenantEvent;

/** The message type of each name, for `validateJob(name, data)`. */
export interface TenantJobMessageMap {
  "tenant.provision": TenantProvisionJob;
  "tenant.migrate": TenantMigrateJob;
  "tenant.suspend": TenantSuspendJob;
  "tenant.resume": TenantResumeJob;
  "tenant.provisioned": TenantProvisionedEvent;
  "tenant.provision_failed": TenantProvisionFailedEvent;
  "tenant.migrated": TenantMigratedEvent;
  "tenant.migration_failed": TenantMigrationFailedEvent;
  "tenant.suspended": TenantSuspendedEvent;
  "tenant.resumed": TenantResumedEvent;
}

/** The JSON Schema of every `tenant.*` message of the two queues, by name. */
export const TENANT_JOB_SCHEMAS: Readonly<Record<TenantJobName, JsonSchema>> = Object.freeze({
  ...TENANT_OPS_JOB_SCHEMAS,
  ...TENANT_EVENT_SCHEMAS,
});

/** True when `name` is the name of a `tenant.*` message of the two queues. */
export function isTenantJobName(name: unknown): name is TenantJobName {
  return typeof name === "string" && Object.hasOwn(TENANT_JOB_SCHEMAS, name);
}

/** True when `type` is an invalidation type. */
export function isInvalidationType(type: unknown): type is InvalidationType {
  return typeof type === "string" && (INVALIDATION_TYPES as readonly string[]).includes(type);
}

/** One reason a message was refused: the JSON Pointer of the failing value, the rule, and a message. */
export interface MessageValidationIssue {
  /** JSON Pointer into the message, e.g. `/payload/clientSecret` or `/jobId`; `""` for the message itself. */
  readonly path: string;
  /** The JSON Schema keyword that failed, e.g. `required`, `additionalProperties`, `pattern`. */
  readonly keyword: string;
  /** What is wrong, without the value. */
  readonly message: string;
}

/** The issues shown in an error message; `issues` always holds them all. */
const MAX_ISSUES_IN_MESSAGE = 10;
/** Names longer than this are shortened in error messages. */
const MAX_NAME_IN_MESSAGE = 64;

/**
 * Thrown by {@link validateJob} and {@link validateInvalidation} when a message does not match its contract.
 * The message and `issues` name paths and rules only, never values, so the error can be logged as it is.
 */
export class MessageValidationError extends Error {
  override readonly name = "MessageValidationError";
  /** The message name (`tenant.provision`) or the channel (`vx:invalidate`). */
  readonly subject: string;
  readonly issues: readonly MessageValidationIssue[];

  constructor(subject: string, issues: readonly MessageValidationIssue[]) {
    const shown = issues
      .slice(0, MAX_ISSUES_IN_MESSAGE)
      .map((issue) => `${issue.path === "" ? "(message)" : issue.path} ${issue.message}`);
    if (issues.length > shown.length) {
      shown.push(`and ${issues.length - shown.length} more`);
    }
    super(`invalid ${subject} message: ${shown.join("; ")}`);
    this.subject = subject;
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}

/** A name from the message (a property or message name), shortened so it never fills a log line. */
function shortened(value: string): string {
  return value.length > MAX_NAME_IN_MESSAGE ? `${value.slice(0, MAX_NAME_IN_MESSAGE)}…` : value;
}

/** One JSON Pointer segment (RFC 6901), shortened. */
function pointerSegment(name: unknown): string {
  return shortened(String(name)).replaceAll("~", "~0").replaceAll("/", "~1");
}

/** A message name for the error: quoted and shortened. */
function quoted(value: string): string {
  return JSON.stringify(shortened(value));
}

/** Ajv's error as an issue: the path of the failing property and a message without the value. */
function toIssue(error: ErrorObject): MessageValidationIssue {
  const params = error.params as Record<string, unknown>;
  const child = (name: unknown): string => `${error.instancePath}/${pointerSegment(name)}`;
  switch (error.keyword) {
    case "required":
      return { path: child(params["missingProperty"]), keyword: error.keyword, message: "is required" };
    case "additionalProperties":
      return {
        path: child(params["additionalProperty"]),
        keyword: error.keyword,
        message: "is not allowed (additionalProperties: false)",
      };
    case "const":
      return {
        path: error.instancePath,
        keyword: error.keyword,
        message: `must be ${JSON.stringify(params["allowedValue"])}`,
      };
    case "enum":
      return {
        path: error.instancePath,
        keyword: error.keyword,
        message: `must be one of ${(params["allowedValues"] as readonly unknown[]).map((value) => JSON.stringify(value)).join(", ")}`,
      };
    default:
      // Ajv's own messages name the rule (`must match pattern "…"`, `must match format "date-time"`,
      // `must be string`), never the value, because the instance is compiled without `verbose`.
      return { path: error.instancePath, keyword: error.keyword, message: error.message ?? "is invalid" };
  }
}

interface Validators {
  readonly jobs: ReadonlyMap<string, ValidateFunction>;
  readonly invalidations: ReadonlyMap<string, ValidateFunction>;
  readonly invalidation: ValidateFunction;
}

let compiled: Validators | undefined;

/** Compiles every schema once, with one Ajv 2020 instance in strict mode and the `date-time` format. */
function validators(): Validators {
  if (compiled === undefined) {
    const ajv = new Ajv2020({ strict: true, allErrors: true, logger: false });
    addFormats(ajv, ["date-time"]);
    compiled = {
      jobs: new Map(Object.entries(TENANT_JOB_SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema)])),
      invalidations: new Map(
        Object.entries(INVALIDATION_EVENT_SCHEMAS).map(([type, schema]) => [type, ajv.compile(schema)]),
      ),
      invalidation: ajv.compile(INVALIDATION_EVENT_SCHEMA),
    };
  }
  return compiled;
}

/**
 * Checks a `tenant.*` message against the JSON Schema of `name` and returns it, typed. Use it before `queue.add`
 * and when a job is taken from the queue (pass BullMQ's `job.name` and `job.data`).
 *
 * @throws {MessageValidationError} when `name` is not a `tenant.*` message, or `data` is not a valid message of
 *   that name: a missing or extra field (a `clientSecret` has no place in any message), a wrong id, a `jobId`
 *   that is `null` where it may not be, another `name` or `v`.
 */
export function validateJob<TName extends TenantJobName>(
  name: TName,
  data: unknown,
): TenantJobMessageMap[TName];
export function validateJob(name: string, data: unknown): TenantJobMessage;
export function validateJob(name: string, data: unknown): TenantJobMessage {
  const validate = validators().jobs.get(name);
  if (validate === undefined) {
    throw new MessageValidationError(quoted(name), [
      {
        path: "/name",
        keyword: "name",
        message: `is not a tenant.* message: use one of ${Object.keys(TENANT_JOB_SCHEMAS).join(", ")}`,
      },
    ]);
  }
  if (!validate(data)) {
    throw new MessageValidationError(name, (validate.errors ?? []).map(toIssue));
  }
  return data as TenantJobMessage;
}

/**
 * Checks an event of the `vx:invalidate` channel (after `JSON.parse` on the subscriber side) and returns it,
 * typed. The platform validates before it publishes.
 *
 * @throws {MessageValidationError} when the event is not exactly one of the invalidation types.
 */
export function validateInvalidation(event: unknown): InvalidationEvent {
  const { invalidations, invalidation } = validators();
  const type =
    event !== null && typeof event === "object" && !Array.isArray(event)
      ? (event as Record<string, unknown>)["type"]
      : undefined;
  // A known type is checked against its own schema, which gives one clear issue per problem; anything else
  // against the union, without the noise of the eight `oneOf` branches.
  const validate = isInvalidationType(type) ? invalidations.get(type) : undefined;
  if (validate !== undefined) {
    if (!validate(event)) {
      throw new MessageValidationError(INVALIDATION_CHANNEL, (validate.errors ?? []).map(toIssue));
    }
    return event as InvalidationEvent;
  }
  if (invalidation(event)) {
    return event as InvalidationEvent;
  }
  const errors = invalidation.errors ?? [];
  const outside = errors.filter((error) => !error.schemaPath.startsWith("#/oneOf"));
  throw new MessageValidationError(
    INVALIDATION_CHANNEL,
    (outside.length > 0 ? outside : errors).map(toIssue),
  );
}
