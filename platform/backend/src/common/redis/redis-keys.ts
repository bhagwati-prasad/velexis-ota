// Every Redis key of the platform backend (platform/docs/architecture.md §6.4), with its TTL, and the only helpers
// that write one (PBE-009). Redis runs with `maxmemory-policy noeviction` (ADR-0009 item 2): nothing is ever evicted,
// so a key written without a TTL would stay for ever. Hence two rules, both enforced by the source scan of
// redis-keys.test.ts:
//
// - a key is never written by hand: a module asks a builder here for `{ key, ttlSeconds }` (`redisKeys.portalToken
//   (digest)`), and no string or template literal elsewhere in `src/` starts with one of the key prefixes below;
// - a key is only written through the helpers at the end of this file (`setKey`, `setKeyIfAbsent`,
//   `incrementInWindow` and `setKeyIfHigher`, which always set the builder's TTL in the same command, and
//   `deleteKeyIfValue`, which releases a lock). No other file calls an ioredis
//   command that creates or changes a key (`set`, `incr`, `hset`, `eval`, `multi`, …). Reading (`get`, `getdel`,
//   `pttl`) and deleting (`del`) are free.
//
// Builders validate every part they put into a key (ids, host names, digests), so a key never holds a `:` from user
// input, or a raw secret where a digest belongs. Their errors name the builder, the part and its rule, never the
// value. The OTA backend has its own builders for the shared keys (`ptk:`, `staffdeny:acct:`, `apikey:used:`); both
// follow the table of architecture §6.4.
import type { Redis } from "ioredis";

/** A key built here. The brand keeps hand-written strings out of the helpers' signatures. */
export type RedisKeyName = string & { readonly __brand: "RedisKeyName" };

/** One key: the name to pass to the client and how long it lives after a write. */
export interface RedisKey {
  readonly key: RedisKeyName;
  /** Seconds the key lives after a write; always a positive integer. */
  readonly ttlSeconds: number;
}

/** A key builder, tagged with the key as architecture §6.4 writes it. */
export type RedisKeyBuilder<A extends readonly unknown[]> = ((...args: A) => RedisKey) & {
  /** The documented key, e.g. `vx:idem:<accountId>:<key>`. */
  readonly pattern: string;
};

// ---- TTLs (platform/docs/architecture.md §6.4) ----------------------------------------------------------------

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The one-time portal token of the staff SSO (PADR-0007), taken by the OTA API with `GETDEL`. */
export const PORTAL_TOKEN_TTL_SECONDS = MINUTE;
/** The account-wide staff revocation cut-off, as long as a staff family can live and more (PADR-0007). */
export const STAFF_DENY_ACCOUNT_TTL_SECONDS = 30 * DAY;
/** The last use of an API key, written by the OTA API and flushed by the platform worker every 5 minutes. */
export const API_KEY_USED_TTL_SECONDS = DAY;
/** A stored idempotent response is replayed for 24 hours (conventions §2, architecture §3 item 10). */
export const IDEMPOTENCY_TTL_SECONDS = DAY;
/** The lock a concurrent duplicate of an idempotent request waits on. */
export const IDEMPOTENCY_LOCK_TTL_SECONDS = 10;
/** An MFA challenge of the sign-in (PADR-0008). */
export const MFA_CHALLENGE_TTL_SECONDS = 5 * MINUTE;
/** A pending TOTP set-up (the encrypted secret) until it is confirmed. */
export const MFA_SETUP_TTL_SECONDS = 10 * MINUTE;
/**
 * The last TOTP time step an account used (PADR-0008 item 1): 90 s, the longest a code stays valid with the ±1 step
 * window (its own step and the steps before and after it), so a replayed code is refused for as long as it works.
 */
export const TOTP_LAST_STEP_TTL_SECONDS = 90;
/** The `state` of a Stripe Connect OAuth start (PADR-0011). */
export const STRIPE_OAUTH_STATE_TTL_SECONDS = 10 * MINUTE;
/** A positive answer of Caddy's TLS `ask` (PADR-0004 item 6); negative answers stay in process. */
export const TLS_ASK_TTL_SECONDS = MINUTE;

// ---- Parts -------------------------------------------------------------------------------------------------------

/** Crockford base32 ULID, as `newId` of `@velexis/crypto` writes it after the type prefix. */
const ULID = "[0-9A-HJKMNP-TV-Z]{26}";

/** The value rules of the key parts: a pattern and the description used in errors. */
const PARTS = {
  accountId: { pattern: new RegExp(`^acc_${ULID}$`), rule: "an account id (acc_ + ULID)" },
  keyId: { pattern: new RegExp(`^key_${ULID}$`), rule: "an API key id (key_ + ULID)" },
  sha256: { pattern: /^[0-9a-f]{64}$/, rule: "a SHA-256 digest in lower-case hex" },
  idempotencyKey: {
    // The `IdempotencyKey` parameter of the platform document.
    pattern: /^[A-Za-z0-9_-]{16,128}$/,
    rule: "an Idempotency-Key of 16 to 128 letters, digits, _ and -",
  },
  hostname: {
    // PADR-0004 item 1: lower case, no trailing dot, not an IP address.
    pattern: /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    rule: "a lower-case host name without a trailing dot",
  },
  throttler: {
    pattern: /^[a-z][a-z0-9_]{0,39}$/,
    rule: "a throttler name of lower-case letters, digits and _",
  },
  tracker: { pattern: /^[A-Za-z0-9_-]{1,128}$/, rule: "a throttler tracker of letters, digits, _ and -" },
} as const satisfies Record<string, { readonly pattern: RegExp; readonly rule: string }>;

type PartName = keyof typeof PARTS;

/** `value` when it matches the part's rule. The error names the builder, the parameter and the rule, never the value. */
function part(builder: string, parameter: string, name: PartName, value: unknown): string {
  if (typeof value !== "string" || !PARTS[name].pattern.test(value)) {
    throw new TypeError(`redisKeys.${builder}: ${parameter} must be ${PARTS[name].rule}`);
  }
  return value;
}

/** Whole seconds of a positive, finite duration, at least 1. */
function seconds(builder: string, parameter: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`redisKeys.${builder}: ${parameter} must be a positive number of seconds`);
  }
  return Math.ceil(value);
}

function makeKey(segments: readonly string[], ttlSeconds: number): RedisKey {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
    // A bug in this file, never a caller's mistake: every builder has a positive TTL (noeviction).
    throw new RangeError("redis key without a positive TTL");
  }
  return Object.freeze({ key: segments.join(":") as RedisKeyName, ttlSeconds });
}

function builder<A extends readonly unknown[]>(
  pattern: string,
  build: (...args: A) => { readonly segments: readonly string[]; readonly ttlSeconds: number },
): RedisKeyBuilder<A> {
  const fn = (...args: A): RedisKey => {
    const { segments, ttlSeconds } = build(...args);
    return makeKey(segments, ttlSeconds);
  };
  return Object.freeze(Object.assign(fn, { pattern }));
}

/**
 * The key builders of the platform backend, one per key of architecture §6.4 (plus the lock of an idempotent
 * request). redis-keys.test.ts lists them by name: a new builder fails that test until its key and TTL are listed.
 */
export const redisKeys = Object.freeze({
  // -- shared with the OTA backend -------------------------------------------------------------------------------
  /** `ptk:<sha256(token)>`: the one-time portal token of the staff SSO (PADR-0007). */
  portalToken: builder("ptk:<sha256>", (tokenSha256: string) => ({
    segments: ["ptk", part("portalToken", "tokenSha256", "sha256", tokenSha256)],
    ttlSeconds: PORTAL_TOKEN_TTL_SECONDS,
  })),
  /** `staffdeny:acct:<accountId>`: epoch ms before which the account's staff families are revoked. */
  staffDenyAccount: builder("staffdeny:acct:<accountId>", (accountId: string) => ({
    segments: ["staffdeny", "acct", part("staffDenyAccount", "accountId", "accountId", accountId)],
    ttlSeconds: STAFF_DENY_ACCOUNT_TTL_SECONDS,
  })),
  /** `apikey:used:<keyId>`: `{at, ip}` of a key's last use, read with `GETDEL` by the usage flush. */
  apiKeyUsed: builder("apikey:used:<keyId>", (keyId: string) => ({
    segments: ["apikey", "used", part("apiKeyUsed", "keyId", "keyId", keyId)],
    ttlSeconds: API_KEY_USED_TTL_SECONDS,
  })),

  // -- platform only ---------------------------------------------------------------------------------------------
  /** `vx:idem:<accountId>:<key>`: the request fingerprint and the response of an idempotent request. */
  idempotency: builder("vx:idem:<accountId>:<key>", (accountId: string, idempotencyKey: string) => ({
    segments: [
      "vx",
      "idem",
      part("idempotency", "accountId", "accountId", accountId),
      part("idempotency", "idempotencyKey", "idempotencyKey", idempotencyKey),
    ],
    ttlSeconds: IDEMPOTENCY_TTL_SECONDS,
  })),
  /** `vx:idem:<accountId>:<key>:lock`: held while the first of concurrent duplicates runs. */
  idempotencyLock: builder("vx:idem:<accountId>:<key>:lock", (accountId: string, idempotencyKey: string) => ({
    segments: [
      "vx",
      "idem",
      part("idempotencyLock", "accountId", "accountId", accountId),
      part("idempotencyLock", "idempotencyKey", "idempotencyKey", idempotencyKey),
      "lock",
    ],
    ttlSeconds: IDEMPOTENCY_LOCK_TTL_SECONDS,
  })),
  /** `mfach:<sha256(challenge token)>`: an MFA challenge of the sign-in. */
  mfaChallenge: builder("mfach:<sha256>", (challengeSha256: string) => ({
    segments: ["mfach", part("mfaChallenge", "challengeSha256", "sha256", challengeSha256)],
    ttlSeconds: MFA_CHALLENGE_TTL_SECONDS,
  })),
  /**
   * `mfach:<sha256(challenge token)>:attempts`: the codes tried against a challenge (`incrementInWindow`), living as
   * long as a challenge can (PBE-015).
   */
  mfaChallengeAttempts: builder("mfach:<sha256>:attempts", (challengeSha256: string) => ({
    segments: [
      "mfach",
      part("mfaChallengeAttempts", "challengeSha256", "sha256", challengeSha256),
      "attempts",
    ],
    ttlSeconds: MFA_CHALLENGE_TTL_SECONDS,
  })),
  /** `mfasetup:<accountId>`: the pending TOTP secret of an account, encrypted. */
  mfaSetup: builder("mfasetup:<accountId>", (accountId: string) => ({
    segments: ["mfasetup", part("mfaSetup", "accountId", "accountId", accountId)],
    ttlSeconds: MFA_SETUP_TTL_SECONDS,
  })),
  /** `mfastep:<accountId>`: the last TOTP time step the account used (`setKeyIfHigher`), against replays (PBE-015). */
  totpLastStep: builder("mfastep:<accountId>", (accountId: string) => ({
    segments: ["mfastep", part("totpLastStep", "accountId", "accountId", accountId)],
    ttlSeconds: TOTP_LAST_STEP_TTL_SECONDS,
  })),
  /** `stripe:oauth:<sha256(state)>`: the state of a Connect OAuth start. */
  stripeOAuthState: builder("stripe:oauth:<sha256>", (stateSha256: string) => ({
    segments: ["stripe", "oauth", part("stripeOAuthState", "stateSha256", "sha256", stateSha256)],
    ttlSeconds: STRIPE_OAUTH_STATE_TTL_SECONDS,
  })),
  /** `tlsask:<host>`: a positive answer of the TLS `ask` endpoint. */
  tlsAsk: builder("tlsask:<host>", (hostname: string) => ({
    segments: ["tlsask", part("tlsAsk", "hostname", "hostname", hostname)],
    ttlSeconds: TLS_ASK_TTL_SECONDS,
  })),
  /** `rl:<throttler>:<tracker>`: a throttler's counter of one tracker, living for its window. */
  throttle: builder(
    "rl:<throttler>:<tracker>",
    (throttler: string, tracker: string, windowSeconds: number) => ({
      segments: [
        "rl",
        part("throttle", "throttler", "throttler", throttler),
        part("throttle", "tracker", "tracker", tracker),
      ],
      ttlSeconds: seconds("throttle", "windowSeconds", windowSeconds),
    }),
  ),
});

/** The names of the builders. */
export type RedisKeyBuilderName = keyof typeof redisKeys;

/**
 * The start of every key above, for the source scan of redis-keys.test.ts: a string or template literal that starts
 * with one of them anywhere else in `src/` is a key written by hand.
 */
export const REDIS_KEY_PREFIXES = Object.freeze([
  "ptk:",
  "staffdeny:",
  "apikey:used:",
  "vx:idem:",
  "mfach:",
  "mfasetup:",
  "mfastep:",
  "stripe:oauth:",
  "tlsask:",
  "rl:",
] as const);

// ---- Writes ------------------------------------------------------------------------------------------------------

/** The commands the helpers send: an ioredis client, or a test double with the same methods. */
export type RedisWriter = Pick<Redis, "set" | "eval">;

/** `SET key value EX ttl`: writes the value with the key's TTL. */
export async function setKey(client: RedisWriter, key: RedisKey, value: string): Promise<void> {
  await client.set(key.key, value, "EX", key.ttlSeconds);
}

/** `SET key value EX ttl NX`: writes the value with the key's TTL unless the key exists; true when written. */
export async function setKeyIfAbsent(client: RedisWriter, key: RedisKey, value: string): Promise<boolean> {
  return (await client.set(key.key, value, "EX", key.ttlSeconds, "NX")) === "OK";
}

/**
 * Counts one hit of a fixed window: `INCR`, and the key's TTL as the window when the hit is the first, in one
 * script. A counter that somehow lost its TTL gets it back on the next hit, so the key can never stay for ever.
 * Answers the hits in the window so far, this one included, and the milliseconds until the window ends.
 */
const INCREMENT_IN_WINDOW = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if hits == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }
`;

/**
 * Raises a counter: writes ARGV[1] with the key's TTL only when the key is absent or holds a lower integer, in one
 * script, so of two concurrent writes of one value only one succeeds.
 */
const SET_IF_HIGHER = `
local current = tonumber(redis.call('GET', KEYS[1]))
if current ~= nil and current >= tonumber(ARGV[1]) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;

/** Releases a lock: `DEL` only while the key still holds this holder's token. */
const DELETE_IF_VALUE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** One hit of a fixed-window counter (`redisKeys.throttle`). */
export interface WindowCount {
  /** The hits in the current window, this one included. */
  readonly hits: number;
  /** Milliseconds until the window ends and the counter starts again. */
  readonly expiresInMs: number;
}

/** Counts one hit in the window of `key`, whose TTL is the window (see the script above). */
export async function incrementInWindow(client: RedisWriter, key: RedisKey): Promise<WindowCount> {
  const reply = await client.eval(INCREMENT_IN_WINDOW, 1, key.key, String(key.ttlSeconds * 1000));
  const [hits, expiresInMs] = Array.isArray(reply) ? reply.map(Number) : [];
  if (hits === undefined || expiresInMs === undefined || !Number.isFinite(hits + expiresInMs)) {
    throw new Error("incrementInWindow: unexpected reply from Redis");
  }
  return { hits, expiresInMs };
}

/**
 * Writes the safe integer `value` to `key` with the key's TTL when the key is absent or holds a lower number (see the
 * script above); true when written. `totpLastStep` uses it so a TOTP time step is accepted once and never after a
 * later one.
 */
export async function setKeyIfHigher(client: RedisWriter, key: RedisKey, value: number): Promise<boolean> {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("setKeyIfHigher: the value must be a safe integer");
  }
  return Number(await client.eval(SET_IF_HIGHER, 1, key.key, String(value), String(key.ttlSeconds))) === 1;
}

/** Deletes `key` only while it holds `value` (the release of a lock taken with `setKeyIfAbsent`). */
export async function deleteKeyIfValue(client: RedisWriter, key: RedisKey, value: string): Promise<boolean> {
  return Number(await client.eval(DELETE_IF_VALUE, 1, key.key, value)) === 1;
}
