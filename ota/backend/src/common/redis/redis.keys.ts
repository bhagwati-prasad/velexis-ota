// Every Redis key of the OTA backend (ota/docs/architecture.md §7), with its TTL (OBE-002). No other file writes a
// key string: a module asks a builder here for `{ key, ttlSeconds, kind }` and passes `key` to the client, and the
// source scan of redis.keys.test.ts fails on a string or template literal key anywhere else in `src/`, on a cast to
// `RedisKeyName` or `RedisKey`, and on a Redis call whose keys it cannot read.
//
// Redis runs with `maxmemory-policy noeviction` (ADR-0009 item 2), so nothing is ever evicted: every key has a TTL,
// and every write sets it (`SET … EX ttlSeconds`, or `EXPIRE` in the same MULTI). Each builder is tagged with its
// kind:
//
// - `tenant`: tenant data, always under `t:<tenantId>:<env>:` (db README §5), so a tenant's keys can be found and
//   removed by prefix and two tenants or two environments never share one;
// - `shared`: the keys outside that prefix named by the cross-cutting table of docs/mvp/architecture.md ("Redis keys
//   shared between the backends") and platform/docs/architecture.md §6.4 (platform row caches, staff sessions and
//   revocations, portal tokens, key usage, the per-tenant Amadeus bucket), plus the throttler counters (`rl:*`);
// - `credential`: the keys of one Amadeus credential set (the Velexis shared account `ama_…` or an OTA-owned
//   connection `sc_…`), which every OTA on that set shares: tokens, token locks, refused credentials, the
//   per-credential bucket and the shared account cache (ADR-0012, OADR-0001).
//
// Builders validate every part they put into a key (ids, environments, host names, hashes), so a key never holds a
// `:` from user input or a raw secret where a hash belongs. Their errors name the part, never its value.

/** What a key holds; see the file header. */
export type RedisKeyKind = "tenant" | "shared" | "credential";

/** The storefront and API key environments of a tenant (`tenants.storefront_environment`, `api_keys.environment`). */
export type KeyEnvironment = "test" | "live";

/** The connection caches of a tenant (`conn:<kind>:<tenantId>:<env>`). */
export type ConnectionKind = "amadeus" | "payment";

/** A Redis key built by this file. The brand keeps hand-written strings out of the client calls (redis.keys.test.ts). */
export type RedisKeyName = string & { readonly __brand: "RedisKeyName" };

/** One key: the name to pass to the client, how long it lives, and what it holds. */
export interface RedisKey<K extends RedisKeyKind = RedisKeyKind> {
  readonly key: RedisKeyName;
  /** Seconds the key lives after a write (`SET … EX`); always a positive integer. */
  readonly ttlSeconds: number;
  readonly kind: K;
  /**
   * Seconds a "not found" answer is cached under the same key, shorter than `ttlSeconds` (unknown host, tenant key
   * or API key prefix, to absorb scans; OADR-0009 point 4). Only on those caches.
   */
  readonly negativeTtlSeconds?: number;
}

/** A key builder: a function returning a `RedisKey`, tagged with its kind and the documented pattern. */
export type RedisKeyBuilder<A extends readonly unknown[], K extends RedisKeyKind> = ((
  ...args: A
) => RedisKey<K>) & {
  readonly kind: K;
  /** The key as ota/docs/architecture.md §7 writes it, e.g. `t:<tenantId>:<env>:sf:<locale>`. */
  readonly pattern: string;
};

// ---- TTLs (ota/docs/architecture.md §7) ------------------------------------------------------------------------

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Platform row and connection caches, deleted early on `vx:invalidate` (OADR-0009 point 4). */
export const PLATFORM_CACHE_TTL_SECONDS = MINUTE;
/** A cached "not found" for a host, tenant key or API key prefix (OADR-0009 point 4). */
export const NEGATIVE_CACHE_TTL_SECONDS = 10;
/** The caller-independent part of `storefront.get` (OADR-0012 point 7). */
export const STOREFRONT_CACHE_TTL_SECONDS = 5 * MINUTE;
/** Single flight of identical concurrent searches (OADR-0002 point 2). */
export const SEARCH_SINGLE_FLIGHT_TTL_SECONDS = 30;
/** A cancellation quote. */
export const CANCELLATION_QUOTE_TTL_SECONDS = 10 * MINUTE;
/** Airline-card attempts of one checkout (OADR-0004). */
export const AIRLINE_CARD_ATTEMPTS_TTL_SECONDS = 2 * HOUR;
/** Customer sign-in lockout counter (ADR-0008). */
export const SIGN_IN_LOCKOUT_TTL_SECONDS = 15 * MINUTE;
/** Amadeus tokens are stored until `expires_in` minus this margin (ADR-0012, OADR-0001 point 5). */
export const AMADEUS_TOKEN_EXPIRY_MARGIN_SECONDS = 60;
/** `expires_in` of an Amadeus `client_credentials` token, used when a reader builds the key without a response. */
export const AMADEUS_TOKEN_EXPIRES_IN_SECONDS = 1799;
/** Single flight of a token refresh. */
export const AMADEUS_TOKEN_LOCK_TTL_SECONDS = 10;
/** Credentials refused by Amadeus answer `424` without a new token request for this long. */
export const AMADEUS_BAD_CREDENTIALS_TTL_SECONDS = 5 * MINUTE;
/** The Amadeus token buckets per credential set and per tenant. */
export const AMADEUS_BUCKET_TTL_SECONDS = 2;
/** Absolute lifetime of a staff refresh family (OADR-0011 point 2); its revocation lives as long. */
export const STAFF_FAMILY_LIFETIME_SECONDS = 12 * HOUR;
/** Cross-boundary staff revocations by account and by tenant. */
export const STAFF_DENY_TTL_SECONDS = 30 * DAY;
/** The one-time portal token of the staff SSO (PADR-0007). */
export const PORTAL_TOKEN_TTL_SECONDS = MINUTE;
/** Last use of an API key, flushed by the platform worker every 5 minutes. */
export const API_KEY_USED_TTL_SECONDS = DAY;

// ---- Parts -------------------------------------------------------------------------------------------------------

/** Crockford base32 ULID, as `newId` of `@velexis/crypto` writes it after the type prefix. */
const ULID = "[0-9A-HJKMNP-TV-Z]{26}";

function prefixedId(prefixes: string): RegExp {
  return new RegExp(`^(?:${prefixes})_${ULID}$`);
}

/** The value rules of the key parts: a pattern and the description used in errors. */
const PARTS = {
  tenantId: { pattern: prefixedId("ten"), rule: "a tenant id (ten_ + ULID)" },
  accountId: { pattern: prefixedId("acc"), rule: "an account id (acc_ + ULID)" },
  keyId: { pattern: prefixedId("key"), rule: "an API key id (key_ + ULID)" },
  bookingId: { pattern: prefixedId("bkg"), rule: "a booking id (bkg_ + ULID)" },
  checkoutId: { pattern: prefixedId("chk"), rule: "a checkout id (chk_ + ULID)" },
  amadeusAccountId: { pattern: prefixedId("ama"), rule: "an Amadeus account id (ama_ + ULID)" },
  credentialId: {
    pattern: prefixedId("ama|sc"),
    rule: "a credential set id: the Amadeus account (ama_ + ULID) or the supplier connection (sc_ + ULID)",
  },
  familyId: { pattern: prefixedId("[a-z]{2,4}"), rule: "a staff session family id (a prefixed ULID)" },
  tenantKey: { pattern: /^[a-z][a-z0-9_]{1,39}$/, rule: "a tenant key (the CHECK of platform.tenants.key)" },
  hostname: {
    // PADR-0004 item 1, as the `domain` invalidation event: lower case, no trailing dot, not an IP address.
    pattern: /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    rule: "a lower-case host name without a trailing dot",
  },
  apiKeyPrefix: {
    pattern: /^(?:pk|sk|hk)_(?:test|live)_[A-Za-z0-9]{6}$/,
    rule: "an API key prefix (PADR-0005), e.g. pk_live_3fA9x2",
  },
  sha256: { pattern: /^[0-9a-f]{64}$/, rule: "a SHA-256 digest in lower-case hex" },
  locale: { pattern: /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/, rule: "a BCP 47 locale, e.g. en-GB" },
  throttler: {
    pattern: /^[a-z][a-z0-9_-]{0,39}$/,
    rule: "a throttler name of lower-case letters, digits, _ and -",
  },
  tracker: { pattern: /^[A-Za-z0-9_-]{1,128}$/, rule: "a throttler tracker key of letters, digits, _ and -" },
} as const satisfies Record<string, { readonly pattern: RegExp; readonly rule: string }>;

type PartName = keyof typeof PARTS;

/** `value` when it matches the part's rule. The error names the builder, the parameter and the rule, never the value. */
function part(builder: string, parameter: string, name: PartName, value: unknown): string {
  if (typeof value !== "string" || !PARTS[name].pattern.test(value)) {
    throw new TypeError(`redisKeys.${builder}: ${parameter} must be ${PARTS[name].rule}`);
  }
  return value;
}

function oneOf<T extends string>(
  builder: string,
  parameter: string,
  allowed: readonly T[],
  value: unknown,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new TypeError(`redisKeys.${builder}: ${parameter} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

const ENVIRONMENTS: readonly KeyEnvironment[] = ["test", "live"];
const CONNECTION_KINDS: readonly ConnectionKind[] = ["amadeus", "payment"];

/** `value` when it is a positive, finite duration in seconds. */
function seconds(builder: string, parameter: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`redisKeys.${builder}: ${parameter} must be a positive number of seconds`);
  }
  return value;
}

// ---- Builders ----------------------------------------------------------------------------------------------------

interface KeyParts {
  readonly segments: readonly string[];
  readonly ttlSeconds: number;
  readonly negativeTtlSeconds?: number;
}

function makeKey<K extends RedisKeyKind>(kind: K, parts: KeyParts): RedisKey<K> {
  if (!Number.isSafeInteger(parts.ttlSeconds) || parts.ttlSeconds < 1) {
    // A bug in this file, never a caller's mistake: every builder has a positive TTL (noeviction).
    throw new RangeError(`redis key of kind ${kind} without a positive TTL`);
  }
  const key: RedisKey<K> = {
    key: parts.segments.join(":") as RedisKeyName,
    ttlSeconds: parts.ttlSeconds,
    kind,
    ...(parts.negativeTtlSeconds === undefined ? {} : { negativeTtlSeconds: parts.negativeTtlSeconds }),
  };
  return Object.freeze(key);
}

function builder<A extends readonly unknown[], K extends RedisKeyKind>(
  kind: K,
  pattern: string,
  build: (...args: A) => KeyParts,
): RedisKeyBuilder<A, K> {
  const fn = (...args: A): RedisKey<K> => makeKey(kind, build(...args));
  return Object.freeze(Object.assign(fn, { kind, pattern }));
}

/**
 * A tenant-data builder: the first two parameters are always the tenant id and the environment, and the key always
 * starts with `t:<tenantId>:<env>:`; `build` only adds what follows the prefix.
 */
function tenantBuilder<A extends readonly unknown[]>(
  name: string,
  pattern: string,
  build: (...args: A) => KeyParts,
): RedisKeyBuilder<[tenantId: string, env: KeyEnvironment, ...rest: A], "tenant"> {
  return builder("tenant", pattern, (tenantId: string, env: KeyEnvironment, ...rest: A) => {
    const prefix = ["t", part(name, "tenantId", "tenantId", tenantId), oneOf(name, "env", ENVIRONMENTS, env)];
    const parts = build(...rest);
    return { ...parts, segments: [...prefix, ...parts.segments] };
  });
}

/**
 * The key builders of the OTA backend, one per key of ota/docs/architecture.md §7. redis.keys.test.ts lists them by
 * name: a new builder fails that test until it is listed there, where its TTL and its prefix are checked.
 */
export const redisKeys = Object.freeze({
  // -- shared: platform row caches (OADR-0009 point 4), deleted on `vx:invalidate` -----------------------------
  /** `tenant:<tenantId>`: the `platform.tenants` row. */
  tenant: builder("shared", "tenant:<tenantId>", (tenantId: string) => ({
    segments: ["tenant", part("tenant", "tenantId", "tenantId", tenantId)],
    ttlSeconds: PLATFORM_CACHE_TTL_SECONDS,
  })),
  /** `tenantkey:<key>`: tenant key → tenant id, for `<key>.<STOREFRONT_BASE_DOMAIN>` hosts. */
  tenantByKey: builder("shared", "tenantkey:<key>", (tenantKey: string) => ({
    segments: ["tenantkey", part("tenantByKey", "tenantKey", "tenantKey", tenantKey)],
    ttlSeconds: PLATFORM_CACHE_TTL_SECONDS,
    negativeTtlSeconds: NEGATIVE_CACHE_TTL_SECONDS,
  })),
  /** `host:<hostname>`: a verified storefront domain → tenant id. */
  host: builder("shared", "host:<hostname>", (hostname: string) => ({
    segments: ["host", part("host", "hostname", "hostname", hostname)],
    ttlSeconds: PLATFORM_CACHE_TTL_SECONDS,
    negativeTtlSeconds: NEGATIVE_CACHE_TTL_SECONDS,
  })),
  /** `apikey:<prefix>`: the `platform.api_keys` row of a key prefix. */
  apiKey: builder("shared", "apikey:<prefix>", (prefix: string) => ({
    segments: ["apikey", part("apiKey", "prefix", "apiKeyPrefix", prefix)],
    ttlSeconds: PLATFORM_CACHE_TTL_SECONDS,
    negativeTtlSeconds: NEGATIVE_CACHE_TTL_SECONDS,
  })),
  /** `member:<accountId>:<tenantId>`: a staff member's membership (role, status). */
  member: builder("shared", "member:<accountId>:<tenantId>", (accountId: string, tenantId: string) => ({
    segments: [
      "member",
      part("member", "accountId", "accountId", accountId),
      part("member", "tenantId", "tenantId", tenantId),
    ],
    ttlSeconds: PLATFORM_CACHE_TTL_SECONDS,
  })),
  /** `conn:<kind>:<tenantId>:<env>`: a tenant's supplier or payment connection; ciphertext stays encrypted. */
  conn: builder(
    "shared",
    "conn:<amadeus|payment>:<tenantId>:<env>",
    (kind: ConnectionKind, tenantId: string, env: KeyEnvironment) => ({
      segments: [
        "conn",
        oneOf("conn", "kind", CONNECTION_KINDS, kind),
        part("conn", "tenantId", "tenantId", tenantId),
        oneOf("conn", "env", ENVIRONMENTS, env),
      ],
      ttlSeconds: PLATFORM_CACHE_TTL_SECONDS,
    }),
  ),

  // -- credential: one Amadeus credential set, shared by every OTA on it (ADR-0012, OADR-0001) -----------------
  /** `amadeus:acct:<id>`: the Velexis shared Amadeus account row; ciphertext stays encrypted. */
  amadeusAccount: builder("credential", "amadeus:acct:<id>", (amadeusAccountId: string) => ({
    segments: [
      "amadeus",
      "acct",
      part("amadeusAccount", "amadeusAccountId", "amadeusAccountId", amadeusAccountId),
    ],
    ttlSeconds: PLATFORM_CACHE_TTL_SECONDS,
  })),
  /**
   * `amadeus:token:<credId>:<env>`: the encrypted OAuth access token, kept until `expires_in` − 60 s. Writers pass
   * the token response's `expires_in`; readers may omit it (the TTL is then the one of a standard Amadeus token).
   */
  amadeusToken: builder(
    "credential",
    "amadeus:token:<credId>:<env>",
    (
      credentialId: string,
      env: KeyEnvironment,
      expiresInSeconds: number = AMADEUS_TOKEN_EXPIRES_IN_SECONDS,
    ) => ({
      segments: [
        "amadeus",
        "token",
        part("amadeusToken", "credentialId", "credentialId", credentialId),
        oneOf("amadeusToken", "env", ENVIRONMENTS, env),
      ],
      // A token that lives no longer than the margin is still cached for a second rather than written without a TTL.
      ttlSeconds: Math.max(
        1,
        Math.floor(seconds("amadeusToken", "expiresInSeconds", expiresInSeconds)) -
          AMADEUS_TOKEN_EXPIRY_MARGIN_SECONDS,
      ),
    }),
  ),
  /** `amadeus:tokenlock:<credId>:<env>`: single flight of a token refresh (`SET NX EX 10`). */
  amadeusTokenLock: builder(
    "credential",
    "amadeus:tokenlock:<credId>:<env>",
    (credentialId: string, env: KeyEnvironment) => ({
      segments: [
        "amadeus",
        "tokenlock",
        part("amadeusTokenLock", "credentialId", "credentialId", credentialId),
        oneOf("amadeusTokenLock", "env", ENVIRONMENTS, env),
      ],
      ttlSeconds: AMADEUS_TOKEN_LOCK_TTL_SECONDS,
    }),
  ),
  /** `amadeus:badcred:<credId>`: credentials refused by Amadeus; calls answer `424` without a token request. */
  amadeusBadCredentials: builder("credential", "amadeus:badcred:<credId>", (credentialId: string) => ({
    segments: [
      "amadeus",
      "badcred",
      part("amadeusBadCredentials", "credentialId", "credentialId", credentialId),
    ],
    ttlSeconds: AMADEUS_BAD_CREDENTIALS_TTL_SECONDS,
  })),
  /** `rl:amadeus:cred:<credId>:<env>`: the token bucket of a credential set. */
  amadeusCredentialBucket: builder(
    "credential",
    "rl:amadeus:cred:<credId>:<env>",
    (credentialId: string, env: KeyEnvironment) => ({
      segments: [
        "rl",
        "amadeus",
        "cred",
        part("amadeusCredentialBucket", "credentialId", "credentialId", credentialId),
        oneOf("amadeusCredentialBucket", "env", ENVIRONMENTS, env),
      ],
      ttlSeconds: AMADEUS_BUCKET_TTL_SECONDS,
    }),
  ),

  // -- shared: per-tenant Amadeus bucket, staff sessions and revocations, hand-offs ----------------------------
  /** `rl:amadeus:ten:<tenantId>:<env>`: the token bucket of a tenant. */
  amadeusTenantBucket: builder(
    "shared",
    "rl:amadeus:ten:<tenantId>:<env>",
    (tenantId: string, env: KeyEnvironment) => ({
      segments: [
        "rl",
        "amadeus",
        "ten",
        part("amadeusTenantBucket", "tenantId", "tenantId", tenantId),
        oneOf("amadeusTenantBucket", "env", ENVIRONMENTS, env),
      ],
      ttlSeconds: AMADEUS_BUCKET_TTL_SECONDS,
    }),
  ),
  /** `staffsess:<familyId>`: a staff refresh family; rotations keep its absolute expiry (`KEEPTTL`). */
  staffSession: builder("shared", "staffsess:<familyId>", (familyId: string) => ({
    segments: ["staffsess", part("staffSession", "familyId", "familyId", familyId)],
    ttlSeconds: STAFF_FAMILY_LIFETIME_SECONDS,
  })),
  /** `staffdeny:<familyId>`: a revoked staff family, as long as the family could live. */
  staffDeny: builder("shared", "staffdeny:<familyId>", (familyId: string) => ({
    segments: ["staffdeny", part("staffDeny", "familyId", "familyId", familyId)],
    ttlSeconds: STAFF_FAMILY_LIFETIME_SECONDS,
  })),
  /** `staffdeny:acct:<accountId>`: the platform's revocation cut-off of an account (read here, PADR-0007). */
  staffDenyAccount: builder("shared", "staffdeny:acct:<accountId>", (accountId: string) => ({
    segments: ["staffdeny", "acct", part("staffDenyAccount", "accountId", "accountId", accountId)],
    ttlSeconds: STAFF_DENY_TTL_SECONDS,
  })),
  /** `staffdeny:tenant:<tenantId>`: written on `tenant.suspend`, deleted on `tenant.resume` (OADR-0007). */
  staffDenyTenant: builder("shared", "staffdeny:tenant:<tenantId>", (tenantId: string) => ({
    segments: ["staffdeny", "tenant", part("staffDenyTenant", "tenantId", "tenantId", tenantId)],
    ttlSeconds: STAFF_DENY_TTL_SECONDS,
  })),
  /** `ptk:<sha256(token)>`: the platform's one-time portal token, taken with `GETDEL` (PADR-0007). */
  portalToken: builder("shared", "ptk:<sha256>", (tokenSha256: string) => ({
    segments: ["ptk", part("portalToken", "tokenSha256", "sha256", tokenSha256)],
    ttlSeconds: PORTAL_TOKEN_TTL_SECONDS,
  })),
  /** `apikey:used:<keyId>`: `{at, ip}` of a key's last use, flushed by the platform worker. */
  apiKeyUsed: builder("shared", "apikey:used:<keyId>", (keyId: string) => ({
    segments: ["apikey", "used", part("apiKeyUsed", "keyId", "keyId", keyId)],
    ttlSeconds: API_KEY_USED_TTL_SECONDS,
  })),
  /**
   * `rl:<throttler>:<tracker>`: a throttler counter (architecture §8), living for its window. `amadeus` is reserved
   * for the Amadeus buckets above.
   */
  throttle: builder(
    "shared",
    "rl:<throttler>:<tracker>",
    (throttler: string, tracker: string, windowSeconds: number) => {
      if (part("throttle", "throttler", "throttler", throttler) === "amadeus") {
        throw new TypeError("redisKeys.throttle: throttler must not be amadeus (the Amadeus buckets use it)");
      }
      return {
        segments: ["rl", throttler, part("throttle", "tracker", "tracker", tracker)],
        ttlSeconds: Math.ceil(seconds("throttle", "windowSeconds", windowSeconds)),
      };
    },
  ),

  // -- tenant: tenant data under t:<tenantId>:<env>: (db README §5) --------------------------------------------
  /** `t:<tenantId>:<env>:sf:<locale>`: the caller-independent part of `storefront.get` (OADR-0012 point 7). */
  sf: tenantBuilder("sf", "t:<tenantId>:<env>:sf:<locale>", (locale: string) => ({
    segments: ["sf", part("sf", "locale", "locale", locale)],
    ttlSeconds: STOREFRONT_CACHE_TTL_SECONDS,
  })),
  /** `t:<tenantId>:<env>:search:<sha256>`: single flight of identical searches (normalised criteria hash). */
  search: tenantBuilder("search", "t:<tenantId>:<env>:search:<sha256>", (criteriaSha256: string) => ({
    segments: ["search", part("search", "criteriaSha256", "sha256", criteriaSha256)],
    ttlSeconds: SEARCH_SINGLE_FLIGHT_TTL_SECONDS,
  })),
  /** `t:<tenantId>:<env>:cxq:<bookingId>`: a cancellation quote. */
  cxq: tenantBuilder("cxq", "t:<tenantId>:<env>:cxq:<bookingId>", (bookingId: string) => ({
    segments: ["cxq", part("cxq", "bookingId", "bookingId", bookingId)],
    ttlSeconds: CANCELLATION_QUOTE_TTL_SECONDS,
  })),
  /** `t:<tenantId>:<env>:ac:chk:<checkoutId>`: airline-card attempts of one checkout (at most 3). */
  acChk: tenantBuilder("acChk", "t:<tenantId>:<env>:ac:chk:<checkoutId>", (checkoutId: string) => ({
    segments: ["ac", "chk", part("acChk", "checkoutId", "checkoutId", checkoutId)],
    ttlSeconds: AIRLINE_CARD_ATTEMPTS_TTL_SECONDS,
  })),
  /** `t:<tenantId>:<env>:authfail:<sha256(email)>`: customer sign-in failures of one identity. */
  authfail: tenantBuilder("authfail", "t:<tenantId>:<env>:authfail:<sha256>", (emailSha256: string) => ({
    segments: ["authfail", part("authfail", "emailSha256", "sha256", emailSha256)],
    ttlSeconds: SIGN_IN_LOCKOUT_TTL_SECONDS,
  })),
});

/** The names of the builders. */
export type RedisKeyBuilderName = keyof typeof redisKeys;
