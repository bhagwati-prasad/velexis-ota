// The cache invalidation events on the Redis channel `vx:invalidate` (platform → OTA backend), as TypeScript
// types and JSON Schemas (platform/docs/architecture.md §6.3, docs/mvp/architecture.md §4 "Redis keys shared
// between the backends", PADR-0016 item 3). Task PBE-004.
//
// The platform publishes one event after the commit of every change to a row the OTA backend caches; the OTA
// backend deletes the matching cache keys (OBE plan). An event is `{ v: 1, type, …ids }` and nothing else: no
// secrets and no row values. Lost events are covered by the 60 s TTL of the cached keys.
import { JOB_SCHEMA_DIALECT, type JsonSchema } from "./envelope.js";

/** The Redis pub/sub channel of the invalidation events. */
export const INVALIDATION_CHANNEL = "vx:invalidate";

/** The contract version every invalidation event carries in `v` today. */
export const INVALIDATION_CONTRACT_VERSION = 1;

interface InvalidationBase<TType extends string> {
  /** Contract version, `1` today ({@link INVALIDATION_CONTRACT_VERSION}). */
  readonly v: typeof INVALIDATION_CONTRACT_VERSION;
  /** What changed; the OTA backend dispatches on it. */
  readonly type: TType;
}

/** Status, plan, `storefront_environment` or profile of a tenant changed. Key `tenant:<id>`. */
export interface TenantInvalidation extends InvalidationBase<"tenant"> {
  /** Tenant id (`ten_` + ULID). */
  readonly id: string;
}

/** A domain was verified, failed or removed, or the primary domain changed. Key `host:<hostname>`. */
export interface DomainInvalidation extends InvalidationBase<"domain"> {
  /** The fully qualified host name, lower case. */
  readonly hostname: string;
}

/** An API key was revoked, got an expiry or changed its origins. Key `apikey:<prefix>`. */
export interface ApiKeyInvalidation extends InvalidationBase<"api_key"> {
  /** The key's visible prefix, e.g. `pk_live_3fA9x2` (PADR-0005). */
  readonly prefix: string;
}

/** The tenant's supplier or payment connection changed. Keys `conn:amadeus:<tenantId>:*`, `conn:payment:…`. */
export interface ConnectionInvalidation extends InvalidationBase<"connection"> {
  /** Tenant id (`ten_` + ULID). */
  readonly tenantId: string;
}

/** A membership's role or status changed, or it was removed. Key `member:<accountId>:<tenantId>`. */
export interface MembershipInvalidation extends InvalidationBase<"membership"> {
  /** Account id (`acc_` + ULID). */
  readonly accountId: string;
  /** Tenant id (`ten_` + ULID). */
  readonly tenantId: string;
}

/** An account was disabled or locked, or its MFA or password changed. */
export interface AccountInvalidation extends InvalidationBase<"account"> {
  /** Account id (`acc_` + ULID). */
  readonly accountId: string;
}

/** The shared Amadeus credentials were rotated or disabled, or an office status changed. */
export interface AmadeusAccountInvalidation extends InvalidationBase<"amadeus_account"> {
  /** Amadeus account id (`ama_` + ULID). */
  readonly id: string;
}

/** A plan's limits or features changed. */
export interface PlanInvalidation extends InvalidationBase<"plan"> {
  /** The plan code, e.g. `early_access`. */
  readonly code: string;
}

/** Any event on `vx:invalidate`; it narrows on `type`. */
export type InvalidationEvent =
  | TenantInvalidation
  | DomainInvalidation
  | ApiKeyInvalidation
  | ConnectionInvalidation
  | MembershipInvalidation
  | AccountInvalidation
  | AmadeusAccountInvalidation
  | PlanInvalidation;
/** The `type` of an invalidation event. */
export type InvalidationType = InvalidationEvent["type"];

/** The invalidation types, in the order of platform architecture §6.3. */
export const INVALIDATION_TYPES = Object.freeze([
  "tenant",
  "domain",
  "api_key",
  "connection",
  "membership",
  "account",
  "amadeus_account",
  "plan",
] as const satisfies readonly InvalidationType[]);

// ---- JSON Schemas -------------------------------------------------------------------------------------------

/** Crockford base32 ULID, as `newId` of `@velexis/crypto` writes it after the type prefix. */
const ULID = "[0-9A-HJKMNP-TV-Z]{26}";

/** The field schemas of the ids, shared by the event types. */
const FIELDS = {
  tenantId: { type: "string", pattern: `^ten_${ULID}$`, description: "Tenant id (ten_ + ULID)." },
  accountId: { type: "string", pattern: `^acc_${ULID}$`, description: "Account id (acc_ + ULID)." },
  amadeusAccountId: {
    type: "string",
    pattern: `^ama_${ULID}$`,
    description: "Amadeus account id (ama_ + ULID).",
  },
  hostname: {
    // PADR-0004 item 1: lower case, labels of 1–63 characters of a-z, 0-9 and inner hyphens (punycode allowed),
    // at least two labels, no trailing dot, at most 253 characters; the last label starts with a letter, so an
    // IPv4 address is refused.
    type: "string",
    maxLength: 253,
    pattern: "^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$",
    description: "Fully qualified host name, lower case, without a trailing dot.",
  },
  apiKeyPrefix: {
    // PADR-0005 items 1–2: `<kind>_<environment>_` and the first 6 secret characters, 14 characters in all.
    type: "string",
    pattern: "^(pk|sk|hk)_(test|live)_[A-Za-z0-9]{6}$",
    description: "Visible API key prefix, e.g. pk_live_3fA9x2.",
  },
  planCode: {
    type: "string",
    pattern: "^[a-z][a-z0-9_]{1,39}$",
    description: "Plan code, e.g. early_access.",
  },
} as const;

/** The id fields of each invalidation type, with their schemas. */
const TYPE_FIELDS: Readonly<Record<InvalidationType, Readonly<Record<string, JsonSchema>>>> = {
  tenant: { id: FIELDS.tenantId },
  domain: { hostname: FIELDS.hostname },
  api_key: { prefix: FIELDS.apiKeyPrefix },
  connection: { tenantId: FIELDS.tenantId },
  membership: { accountId: FIELDS.accountId, tenantId: FIELDS.tenantId },
  account: { accountId: FIELDS.accountId },
  amadeus_account: { id: FIELDS.amadeusAccountId },
  plan: { code: FIELDS.planCode },
};

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

/** The schema of one type, without `$schema`, so it can sit inside the union too. */
function typeSchema(type: InvalidationType): JsonSchema {
  const fields = TYPE_FIELDS[type];
  return {
    title: `${type} invalidation`,
    type: "object",
    additionalProperties: false,
    required: ["v", "type", ...Object.keys(fields)],
    properties: {
      v: { type: "integer", const: INVALIDATION_CONTRACT_VERSION, description: "Contract version." },
      type: { type: "string", const: type, description: "What changed." },
      ...structuredClone(fields),
    },
  };
}

/** The standalone schema of one type: {@link typeSchema} with the dialect. */
function standaloneSchema(type: InvalidationType): JsonSchema {
  return { $schema: JOB_SCHEMA_DIALECT, ...typeSchema(type) };
}

/** The JSON Schema of each invalidation type, by type: `v` and `type` are constants, no other field travels. */
export const INVALIDATION_EVENT_SCHEMAS: Readonly<Record<InvalidationType, JsonSchema>> = deepFreeze({
  tenant: standaloneSchema("tenant"),
  domain: standaloneSchema("domain"),
  api_key: standaloneSchema("api_key"),
  connection: standaloneSchema("connection"),
  membership: standaloneSchema("membership"),
  account: standaloneSchema("account"),
  amadeus_account: standaloneSchema("amadeus_account"),
  plan: standaloneSchema("plan"),
});

/** The JSON Schema of {@link InvalidationEvent}: exactly one of the types (`oneOf`). */
export const INVALIDATION_EVENT_SCHEMA: JsonSchema = deepFreeze({
  $schema: JOB_SCHEMA_DIALECT,
  title: "InvalidationEvent",
  description: `An event on the Redis channel ${INVALIDATION_CHANNEL} (platform architecture §6.3).`,
  type: "object",
  required: ["v", "type"],
  properties: {
    v: { type: "integer", const: INVALIDATION_CONTRACT_VERSION },
    type: { type: "string", enum: [...INVALIDATION_TYPES] },
  },
  oneOf: INVALIDATION_TYPES.map(typeSchema),
});
