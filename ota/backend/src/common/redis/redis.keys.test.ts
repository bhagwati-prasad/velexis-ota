// The Redis key builders (OBE-002; ota/docs/architecture.md §7): every builder is listed here with the key and TTL
// that §7 gives it, every key has a TTL (Redis runs with noeviction), every tenant-data key starts with
// `t:<tenantId>:<env>:`, and no file of `src/` other than redis.keys.ts hands the Redis client a key it wrote itself.
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { setImmediate } from "node:timers/promises";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_DIR } from "../../config";
import {
  AMADEUS_TOKEN_EXPIRES_IN_SECONDS,
  redisKeyPatterns,
  redisKeys,
  type RedisKey,
  type RedisKeyBuilderName,
  type RedisKeyKind,
} from "./redis.keys";

const TENANT_ID = "ten_01M4T9E68084G7ZWYRD6Z1RV0W";
const OTHER_TENANT_ID = "ten_01M4T9HVE0355QAKGD2AVSQWH2";
const ACCOUNT_ID = "acc_01M4TA0Z9N3QKX8V5B7C2D4E6F";
const KEY_ID = "key_01M4TA2B3C4D5E6F7G8H9J0K1M";
const BOOKING_ID = "bkg_01M4TA3N4P5Q6R7S8T9V0W1X2Y";
const CHECKOUT_ID = "chk_01M4TA4Z0A1B2C3D4E5F6G7H8J";
const AMADEUS_ACCOUNT_ID = "ama_01M4TA5K6M7N8P9Q0R1S2T3V4W";
const CONNECTION_ID = "sc_01M4TA6X7Y8Z9A0B1C2D3E4F5G";
const FAMILY_ID = "sfm_01M4TA7H8J9K0M1N2P3Q4R5S6T";
const STAFF_ID = "stf_01M4TA8V9W0X1Y2Z3A4B5C6D7E";
const HASH = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

/** Arguments for every builder. Typed by the builder names, so a new builder does not compile until it is listed. */
const SAMPLES: Readonly<Record<RedisKeyBuilderName, readonly unknown[]>> = {
  tenant: [TENANT_ID],
  tenantByKey: ["acme"],
  host: ["book.acme-travel.example"],
  apiKey: ["pk_live_3fA9x2"],
  member: [ACCOUNT_ID, TENANT_ID],
  conn: ["amadeus", TENANT_ID, "test"],
  amadeusAccount: [AMADEUS_ACCOUNT_ID],
  amadeusToken: [AMADEUS_ACCOUNT_ID, "live", 1799],
  amadeusTokenLock: [CONNECTION_ID, "test"],
  amadeusBadCredentials: [CONNECTION_ID],
  amadeusCredentialBucket: [AMADEUS_ACCOUNT_ID, "test"],
  amadeusTenantBucket: [TENANT_ID, "live"],
  staffSession: [FAMILY_ID],
  staffDeny: [FAMILY_ID],
  staffDenyAccount: [ACCOUNT_ID],
  staffDenyTenant: [TENANT_ID],
  staffDenyMember: [STAFF_ID],
  portalToken: [HASH],
  apiKeyUsed: [KEY_ID],
  throttle: ["signin", HASH, 60],
  sf: [TENANT_ID, "test", "en-GB"],
  search: [TENANT_ID, "live", HASH],
  cxq: [TENANT_ID, "test", BOOKING_ID],
  acChk: [TENANT_ID, "live", CHECKOUT_ID],
  authfail: [TENANT_ID, "test", HASH],
};

/** What ota/docs/architecture.md §7 (and the ADRs it cites) says each builder gives for the samples above. */
const EXPECTED: Readonly<Record<RedisKeyBuilderName, Omit<RedisKey, "key"> & { readonly key: string }>> = {
  tenant: { key: `tenant:${TENANT_ID}`, ttlSeconds: 60, kind: "shared" },
  tenantByKey: { key: "tenantkey:acme", ttlSeconds: 60, kind: "shared", negativeTtlSeconds: 10 },
  host: { key: "host:book.acme-travel.example", ttlSeconds: 60, kind: "shared", negativeTtlSeconds: 10 },
  apiKey: { key: "apikey:pk_live_3fA9x2", ttlSeconds: 60, kind: "shared", negativeTtlSeconds: 10 },
  member: { key: `member:${ACCOUNT_ID}:${TENANT_ID}`, ttlSeconds: 60, kind: "shared" },
  conn: { key: `conn:amadeus:${TENANT_ID}:test`, ttlSeconds: 60, kind: "shared" },
  amadeusAccount: { key: `amadeus:acct:${AMADEUS_ACCOUNT_ID}`, ttlSeconds: 60, kind: "credential" },
  amadeusToken: { key: `amadeus:token:${AMADEUS_ACCOUNT_ID}:live`, ttlSeconds: 1739, kind: "credential" },
  amadeusTokenLock: { key: `amadeus:tokenlock:${CONNECTION_ID}:test`, ttlSeconds: 10, kind: "credential" },
  amadeusBadCredentials: { key: `amadeus:badcred:${CONNECTION_ID}`, ttlSeconds: 300, kind: "credential" },
  amadeusCredentialBucket: {
    key: `rl:amadeus:cred:${AMADEUS_ACCOUNT_ID}:test`,
    ttlSeconds: 2,
    kind: "credential",
  },
  amadeusTenantBucket: { key: `rl:amadeus:ten:${TENANT_ID}:live`, ttlSeconds: 2, kind: "shared" },
  staffSession: { key: `staffsess:${FAMILY_ID}`, ttlSeconds: 12 * 3600, kind: "shared" },
  staffDeny: { key: `staffdeny:${FAMILY_ID}`, ttlSeconds: 12 * 3600, kind: "shared" },
  staffDenyAccount: { key: `staffdeny:acct:${ACCOUNT_ID}`, ttlSeconds: 30 * 86400, kind: "shared" },
  staffDenyTenant: { key: `staffdeny:tenant:${TENANT_ID}`, ttlSeconds: 30 * 86400, kind: "shared" },
  staffDenyMember: { key: `staffdeny:member:${STAFF_ID}`, ttlSeconds: 12 * 3600, kind: "shared" },
  portalToken: { key: `ptk:${HASH}`, ttlSeconds: 60, kind: "shared" },
  apiKeyUsed: { key: `apikey:used:${KEY_ID}`, ttlSeconds: 86400, kind: "shared" },
  throttle: { key: `rl:signin:${HASH}`, ttlSeconds: 60, kind: "shared" },
  sf: { key: `t:${TENANT_ID}:test:sf:en-GB`, ttlSeconds: 300, kind: "tenant" },
  search: { key: `t:${TENANT_ID}:live:search:${HASH}`, ttlSeconds: 30, kind: "tenant" },
  cxq: { key: `t:${TENANT_ID}:test:cxq:${BOOKING_ID}`, ttlSeconds: 600, kind: "tenant" },
  acChk: { key: `t:${TENANT_ID}:live:ac:chk:${CHECKOUT_ID}`, ttlSeconds: 7200, kind: "tenant" },
  authfail: { key: `t:${TENANT_ID}:test:authfail:${HASH}`, ttlSeconds: 900, kind: "tenant" },
};

/** The task's list of tenant-data builders (OBE-002 step 2). */
const TENANT_DATA_BUILDERS: readonly RedisKeyBuilderName[] = ["sf", "search", "cxq", "acChk", "authfail"];

/** What a builder of any registry returns, unchecked: the test below also feeds it broken builders. */
interface LooseKey {
  readonly key?: unknown;
  readonly ttlSeconds?: unknown;
  readonly kind?: unknown;
}

type AnyBuilder = ((...args: never[]) => LooseKey) & { readonly kind?: RedisKeyKind };

/**
 * The rules every builder of a registry must follow, as messages (empty when it does): it is listed in `samples`,
 * returns a key with a positive whole-second TTL and the kind it is tagged with, and a tenant-data builder's key
 * starts with `t:<tenantId>:<env>:` of its first two arguments while no other key starts with `t:`.
 */
function registryProblems(
  registry: Readonly<Record<string, AnyBuilder>>,
  samples: Readonly<Record<string, readonly unknown[]>>,
): string[] {
  const problems: string[] = [];
  for (const [name, build] of Object.entries(registry)) {
    const args = samples[name];
    if (args === undefined) {
      problems.push(`${name}: not listed in the samples of this test`);
      continue;
    }
    const result = build(...(args as never[]));
    const ttl = result.ttlSeconds;
    if (typeof ttl !== "number" || !Number.isSafeInteger(ttl) || ttl < 1) {
      problems.push(`${name}: no positive TTL (Redis runs with noeviction)`);
    }
    if (typeof result.key !== "string" || result.key === "") {
      problems.push(`${name}: no key`);
      continue;
    }
    if (result.kind !== build.kind) {
      problems.push(`${name}: returns kind ${String(result.kind)} but is tagged ${String(build.kind)}`);
    }
    if (result.kind === "tenant") {
      const prefix = `t:${String(args[0])}:${String(args[1])}:`;
      if (!result.key.startsWith(prefix) || result.key.length === prefix.length) {
        problems.push(`${name}: tenant data whose key does not start with t:<tenantId>:<env>:`);
      }
    } else if (result.key.startsWith("t:")) {
      problems.push(`${name}: a ${String(result.kind)} key under the tenant prefix t:`);
    }
  }
  return problems;
}

/** The documented pattern as a regular expression: each `<placeholder>` is one or more characters. */
function patternExpression(pattern: string): RegExp {
  const parts = pattern.split(/<[^>]+>/).map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join(".+")}$`);
}

describe("redisKeys", () => {
  it("lists every builder; each has a TTL and tenant data starts with t:<tenantId>:<env>: [OBE-002 AC1]", () => {
    expect(Object.keys(redisKeys).sort()).toEqual(Object.keys(SAMPLES).sort());
    expect(registryProblems(redisKeys as unknown as Record<string, AnyBuilder>, SAMPLES)).toEqual([]);

    const tenantBuilders = Object.entries(redisKeys)
      .filter(([, build]) => build.kind === "tenant")
      .map(([name]) => name);
    expect(tenantBuilders.sort()).toEqual([...TENANT_DATA_BUILDERS].sort());
  });

  it("fails on a builder without a TTL, an unlisted one, and tenant data outside the prefix [OBE-002 AC1]", () => {
    const tagged = (kind: RedisKeyKind, build: () => LooseKey): AnyBuilder => Object.assign(build, { kind });
    const broken: Record<string, AnyBuilder> = {
      noTtl: tagged("shared", () => ({ key: "tenant:x", kind: "shared" })),
      zeroTtl: tagged("shared", () => ({ key: "host:x", ttlSeconds: 0, kind: "shared" })),
      unlisted: tagged("shared", () => ({ key: "apikey:x", ttlSeconds: 60, kind: "shared" })),
      outsidePrefix: tagged("tenant", () => ({
        key: `sf:${TENANT_ID}:test:en`,
        ttlSeconds: 300,
        kind: "tenant",
      })),
      otherTenant: tagged("tenant", () => ({
        key: `t:${OTHER_TENANT_ID}:test:sf:en`,
        ttlSeconds: 300,
        kind: "tenant",
      })),
      sharedUnderPrefix: tagged("shared", () => ({
        key: `t:${TENANT_ID}:test:x`,
        ttlSeconds: 1,
        kind: "shared",
      })),
    };
    const samples = {
      noTtl: [],
      zeroTtl: [],
      outsidePrefix: [TENANT_ID, "test"],
      otherTenant: [TENANT_ID, "test"],
      sharedUnderPrefix: [],
    };

    expect(registryProblems(broken, samples)).toEqual([
      "noTtl: no positive TTL (Redis runs with noeviction)",
      "zeroTtl: no positive TTL (Redis runs with noeviction)",
      "unlisted: not listed in the samples of this test",
      "outsidePrefix: tenant data whose key does not start with t:<tenantId>:<env>:",
      "otherTenant: tenant data whose key does not start with t:<tenantId>:<env>:",
      "sharedUnderPrefix: a shared key under the tenant prefix t:",
    ]);
  });

  it("builds the keys and TTLs of architecture §7, frozen, matching each builder's pattern", () => {
    for (const [name, args] of Object.entries(SAMPLES) as Array<[RedisKeyBuilderName, readonly unknown[]]>) {
      const build = redisKeys[name] as unknown as ((...values: unknown[]) => RedisKey) & { pattern: string };
      const result = build(...args);

      expect({ ...result }, name).toEqual(EXPECTED[name]);
      expect(Object.isFrozen(result), name).toBe(true);
      expect(result.key, name).toMatch(patternExpression(build.pattern));
    }
    expect(Object.isFrozen(redisKeys)).toBe(true);
  });

  it("keeps the tenants and environments of tenant data apart", () => {
    const keys = [
      redisKeys.sf(TENANT_ID, "test", "en").key,
      redisKeys.sf(TENANT_ID, "live", "en").key,
      redisKeys.sf(OTHER_TENANT_ID, "test", "en").key,
    ];

    expect(new Set(keys).size).toBe(3);
    expect(keys[2]).toBe(`t:${OTHER_TENANT_ID}:test:sf:en`);
  });

  it("stores an Amadeus token until expires_in − 60 s, and at least one second", () => {
    expect(redisKeys.amadeusToken(CONNECTION_ID, "test", 3600).ttlSeconds).toBe(3540);
    expect(redisKeys.amadeusToken(CONNECTION_ID, "test", 899.5).ttlSeconds).toBe(839);
    expect(redisKeys.amadeusToken(CONNECTION_ID, "test", 30).ttlSeconds).toBe(1);
    expect(redisKeys.amadeusToken(CONNECTION_ID, "test").ttlSeconds).toBe(
      AMADEUS_TOKEN_EXPIRES_IN_SECONDS - 60,
    );
    for (const expiresIn of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => redisKeys.amadeusToken(CONNECTION_ID, "test", expiresIn), String(expiresIn)).toThrow(
        RangeError,
      );
    }
    expect(redisKeys.throttle("search", "abc_DEF-1", 0.2).ttlSeconds).toBe(1);
  });

  it("refuses parts that are not what the key expects, without echoing them", () => {
    const secret = "sk_live_0123456789abcdefABCDEF";
    const refusals: Array<[() => unknown, RegExp]> = [
      [() => redisKeys.tenant("ten_123"), /redisKeys\.tenant: tenantId must be a tenant id/],
      [() => redisKeys.tenant(`${TENANT_ID}:x`), /tenantId must be a tenant id/],
      [() => redisKeys.sf(TENANT_ID, "prod" as never, "en"), /redisKeys\.sf: env must be one of test, live/],
      [() => redisKeys.sf(TENANT_ID, "test", "en:GB"), /locale must be a BCP 47 locale/],
      [() => redisKeys.host("Book.Example.com"), /hostname must be a lower-case host name/],
      [() => redisKeys.host("192.168.0.1"), /hostname must be a lower-case host name/],
      [() => redisKeys.host("example.com."), /hostname must be a lower-case host name/],
      [() => redisKeys.apiKey(secret), /prefix must be an API key prefix/],
      [() => redisKeys.portalToken(secret), /tokenSha256 must be a SHA-256 digest/],
      [
        () => redisKeys.authfail(TENANT_ID, "test", "jane@example.com"),
        /emailSha256 must be a SHA-256 digest/,
      ],
      [() => redisKeys.conn("stripe" as never, TENANT_ID, "test"), /kind must be one of amadeus, payment/],
      [() => redisKeys.amadeusToken(TENANT_ID, "test"), /credentialId must be a credential set id/],
      [() => redisKeys.cxq(TENANT_ID, "test", CHECKOUT_ID), /bookingId must be a booking id/],
      [() => redisKeys.throttle("amadeus", HASH, 2), /throttler must not be amadeus/],
      [() => redisKeys.throttle("sign in", HASH, 2), /throttler must be a throttler name/],
      [() => redisKeys.member(TENANT_ID, ACCOUNT_ID), /accountId must be an account id/],
      [() => redisKeys.staffDenyMember(ACCOUNT_ID), /redisKeys\.staffDenyMember: staffId must be a staff id/],
      [() => redisKeys.tenantByKey("Acme"), /tenantKey must be a tenant key/],
    ];
    for (const [build, message] of refusals) {
      expect(build, String(message)).toThrow(message);
    }
    try {
      redisKeys.portalToken(secret);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe("redisKeyPatterns", () => {
  it("matches the cached memberships of one account and rebuilds only the keys of the member builder [OBE-012]", () => {
    const pattern = redisKeyPatterns.membersOfAccount(ACCOUNT_ID);

    expect(pattern.match).toBe(`member:${ACCOUNT_ID}:*`);
    expect(pattern.keyOf(redisKeys.member(ACCOUNT_ID, TENANT_ID).key)).toEqual(
      redisKeys.member(ACCOUNT_ID, TENANT_ID),
    );
    expect(pattern.keyOf(redisKeys.member(ACCOUNT_ID, OTHER_TENANT_ID).key)?.key).toBe(
      `member:${ACCOUNT_ID}:${OTHER_TENANT_ID}`,
    );
    for (const name of [
      redisKeys.member("acc_01M4TA0Z9N3QKX8V5B7C2D4E6G", TENANT_ID).key,
      `member:${ACCOUNT_ID}:${TENANT_ID}:extra`,
      `member:${ACCOUNT_ID}:ten_x`,
      `member:${ACCOUNT_ID}:`,
      redisKeys.tenant(TENANT_ID).key,
    ]) {
      expect([name, pattern.keyOf(name)]).toEqual([name, undefined]);
    }
    expect(Object.isFrozen(pattern)).toBe(true);
    expect(() => redisKeyPatterns.membersOfAccount("acc_*")).toThrow(
      /redisKeys\.membersOfAccount: accountId must be an account id/,
    );
  });
});

// ---- Source scan --------------------------------------------------------------------------------------------------

const SRC_DIR = join(APP_DIR, "src");
const KEYS_FILE = join(SRC_DIR, "common", "redis", "redis.keys.ts");

/** The production sources of the package: `src/**\/*.ts` without the tests. */
function productionSources(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return walk(path);
      }
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
    });
  return walk(SRC_DIR).sort();
}

/** tsconfig.json's compiler options (type checking only). */
function compilerOptions(): ts.CompilerOptions {
  const file = ts.findConfigFile(APP_DIR, (path) => ts.sys.fileExists(path), "tsconfig.json");
  if (file === undefined) {
    throw new Error(`no tsconfig.json in ${APP_DIR}`);
  }
  const { config } = ts.readConfigFile(file, (path) => ts.sys.readFile(path)) as { config: unknown };
  return {
    ...ts.parseJsonConfigFileContent(config, ts.sys, APP_DIR).options,
    noEmit: true,
    incremental: false,
  };
}

/** A set of command names, written as one space-separated list. */
function commands(names: string): ReadonlySet<string> {
  return new Set(names.split(/\s+/).filter((name) => name !== ""));
}

/**
 * Methods whose arguments hold no key: commands whose first argument is a subcommand, cursor or channel, the
 * client's connection methods and its event emitter methods (`on("error", …)`).
 */
const NO_KEY = commands(`
  acl auth bgrewriteaof bgsave client cluster command config connect dbsize debug defineCommand
  disconnect discard duplicate echo end exec failover flushall flushdb function hello info lastsave latency lolwut
  module monitor ping psubscribe publish pubsub punsubscribe quit randomkey readonly readwrite reset
  role save scan scanBufferStream scanStream script select shutdown slowlog spublish ssubscribe subscribe
  sunsubscribe swapdb time unsubscribe unwatch wait waitaof xread xreadgroup
  addListener emit listenerCount listeners off on once prependListener prependOnceListener rawListeners
  removeAllListeners removeListener setMaxListeners
`);
/** Methods that send a prepared command object, whose keys the scan cannot see. */
const OPAQUE = commands("sendCommand");
/** Commands whose every string argument is a key. */
const ALL_KEYS = commands(`
  del exists mget pfcount pfmerge sdiff sdiffstore sinter sinterstore sunion sunionstore touch unlink watch
`);
/** Blocking pops: every argument but the last (the timeout) is a key. */
const KEYS_THEN_TIMEOUT = commands("blpop brpop bzpopmin bzpopmax");
/** Commands with an operation first and keys after it. */
const OPERATION_THEN_KEYS = commands("bitop");
/** Commands that take a command name and its arguments (`call("GET", key)`). */
const GENERIC = commands("call callBuffer");
/** Commands that take queued commands as data (`multi([["set", key, value]])`), or options. */
const QUEUED = commands("multi pipeline");
/** Commands with two keys first, then values or options. */
const TWO_KEYS = commands(
  "blmove brpoplpush copy geosearchstore lmove rename renamenx rpoplpush smove zrangestore",
);
/** Commands with a subcommand first and the key second. */
const SECOND_KEY = commands("memory object xgroup xinfo");
/** Commands with `numkeys`, then the keys: the index of `numkeys`, the index of the first key, a destination key first. */
const COUNTED_KEYS: Readonly<Record<string, readonly [count: number, first: number, destination: boolean]>> =
  {
    eval: [1, 2, false],
    evalsha: [1, 2, false],
    eval_ro: [1, 2, false],
    evalsha_ro: [1, 2, false],
    fcall: [1, 2, false],
    fcall_ro: [1, 2, false],
    sintercard: [0, 1, false],
    zdiff: [0, 1, false],
    zinter: [0, 1, false],
    zintercard: [0, 1, false],
    zunion: [0, 1, false],
    lmpop: [0, 1, false],
    zmpop: [0, 1, false],
    blmpop: [1, 2, false],
    bzmpop: [1, 2, false],
    zdiffstore: [1, 2, true],
    zinterstore: [1, 2, true],
    zunionstore: [1, 2, true],
  };

/** A key argument of a Redis call, or a part of the call where the scan cannot tell which arguments are keys. */
type KeyArgument = { readonly key: ts.Expression } | { readonly unreadable: string; readonly at: ts.Node };

/** The string literal text of a command name, lower case, or `undefined` when it is not a literal. */
function commandName(expression: ts.Expression | undefined): string | undefined {
  const node = expression === undefined ? undefined : unwrap(expression);
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text.toLowerCase()
    : undefined;
}

/**
 * The key arguments of a command called with `args`. `call("SET", key, …)` and the queued commands of
 * `multi([[name, key, …], …])` are read like the command they name; a name, a queued command or a key count that is
 * not a literal is reported as unreadable, because the keys could not be found.
 */
function keyArguments(command: string, args: readonly ts.Expression[]): KeyArgument[] {
  const keysAt = (positions: (index: number) => boolean): KeyArgument[] =>
    args.filter((_, index) => positions(index)).map((key) => ({ key }));
  const last = args.length - 1;
  if (NO_KEY.has(command)) {
    return [];
  }
  if (OPAQUE.has(command)) {
    return args.map((argument) => ({ unreadable: "a prepared command object", at: argument }));
  }
  if (GENERIC.has(command)) {
    const [name, ...rest] = args;
    if (name === undefined) {
      return [];
    }
    const named = commandName(name);
    return named === undefined
      ? [{ unreadable: "a command name that is not a string literal", at: name }]
      : keyArguments(named, rest);
  }
  if (QUEUED.has(command)) {
    return args.flatMap((argument): KeyArgument[] => {
      const list = unwrap(argument);
      if (ts.isObjectLiteralExpression(list)) {
        return []; // multi({ pipeline: false })
      }
      if (!ts.isArrayLiteralExpression(list)) {
        return [{ unreadable: "queued commands that are not an array literal", at: argument }];
      }
      return list.elements.flatMap((element): KeyArgument[] => {
        const queued = ts.isSpreadElement(element) ? undefined : unwrap(element);
        if (queued === undefined || !ts.isArrayLiteralExpression(queued)) {
          return [{ unreadable: "a queued command that is not an array literal", at: element }];
        }
        const [name, ...rest] = queued.elements;
        const named = name === undefined || ts.isSpreadElement(name) ? undefined : commandName(name);
        return named === undefined
          ? [{ unreadable: "a queued command whose name is not a string literal", at: element }]
          : keyArguments(named, rest);
      });
    });
  }
  if (ALL_KEYS.has(command)) {
    return keysAt(() => true);
  }
  if (KEYS_THEN_TIMEOUT.has(command)) {
    return keysAt((index) => index < last);
  }
  if (OPERATION_THEN_KEYS.has(command)) {
    return keysAt((index) => index > 0);
  }
  if (TWO_KEYS.has(command)) {
    return keysAt((index) => index < 2);
  }
  if (SECOND_KEY.has(command)) {
    return keysAt((index) => index === 1);
  }
  if (command === "mset" || command === "msetnx") {
    return keysAt((index) => index % 2 === 0);
  }
  // Own keys only: `toString` or `constructor` would find Object.prototype's.
  const counted = Object.hasOwn(COUNTED_KEYS, command) ? COUNTED_KEYS[command] : undefined;
  if (counted !== undefined) {
    const [countAt, firstAt, destination] = counted;
    const count = args[countAt];
    if (count === undefined) {
      return keysAt((index) => destination && index === 0);
    }
    const node = unwrap(count);
    if (!ts.isNumericLiteral(node)) {
      return [{ unreadable: "a key count (numkeys) that is not a number literal", at: count }];
    }
    const keys = Number(node.text);
    return keysAt((index) => (destination && index === 0) || (index >= firstAt && index < firstAt + keys));
  }
  return keysAt((index) => index === 0);
}

/** The expression without parentheses, type assertions and `!`. */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** True when the expression writes key text itself: a string or template literal, or text concatenated to one. */
function isHandWritten(expression: ts.Expression): boolean {
  const node = unwrap(expression);
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node) ||
    ts.isTaggedTemplateExpression(node)
  ) {
    return true;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return isHandWritten(node.left) || isHandWritten(node.right);
  }
  if (ts.isConditionalExpression(node)) {
    return isHandWritten(node.whenTrue) || isHandWritten(node.whenFalse);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.some((element) =>
      isHandWritten(ts.isSpreadElement(element) ? element.expression : element),
    );
  }
  return false;
}

/** True when every value of the type is a `RedisKeyName` (the brand of redis.keys.ts). */
function isBuiltKeyType(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.isUnion()) {
    return type.types.every((member) => isBuiltKeyType(checker, member));
  }
  const brand = checker.getPropertyOfType(type, "__brand");
  if (brand === undefined) {
    return false;
  }
  const brandType = checker.getTypeOfSymbol(brand);
  return brandType.isStringLiteral() && brandType.value === "RedisKeyName";
}

/** True when the file is one of ioredis's own (its declaration files). */
function isIoredisFile(fileName: string): boolean {
  return fileName.replaceAll("\\", "/").includes("/node_modules/ioredis/");
}

/** True when the symbol (or the symbol it aliases) is declared by ioredis. */
function isDeclaredByIoredis(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): boolean {
  const target =
    symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return (target?.declarations ?? []).some((declaration) =>
    isIoredisFile(declaration.getSourceFile().fileName),
  );
}

/** The global types whose members property access finds on every object type (Object) and function type. */
const OBJECT_AND_FUNCTION = new Set(["Object", "Function", "CallableFunction", "NewableFunction"]);
const memberNamesOfPrograms = new WeakMap<ts.Program, ReadonlySet<string>>();

/**
 * Every method name a call can have when `isRedisCommand` holds for it, as a superset: the names of the members
 * that ioredis's declaration files declare (the commands and the methods of its clients, pipelines, streams, errors
 * and options), the properties of every type declared there, with those it inherits from Node.js (EventEmitter,
 * Readable, Error) and the commands this package adds with defineCommand (they merge into RedisCommander), the names
 * ioredis exports, and the members of Object and Function, which property access finds on every object and function.
 * A call by any other name has no method declared by ioredis and no receiver of an ioredis type, so the scan need
 * not ask the type checker about it. (Two internal option types of ioredis, in cluster/util.d.ts and
 * utils/index.d.ts, also take any name through `[key: string]: any`; no Redis command is sent through them.)
 */
function ioredisMemberNames(program: ts.Program): ReadonlySet<string> {
  const known = memberNamesOfPrograms.get(program);
  if (known !== undefined) {
    return known;
  }
  const checker = program.getTypeChecker();
  const names = new Set<string>();
  const addPropertiesOf = (type: ts.Type): void => {
    for (const property of checker.getPropertiesOfType(checker.getApparentType(type))) {
      names.add(property.name);
    }
  };
  const visit = (node: ts.Node): void => {
    const name =
      ts.isClassElement(node) || ts.isTypeElement(node) || ts.isEnumMember(node) ? node.name : undefined;
    if (
      name !== undefined &&
      (ts.isIdentifier(name) ||
        ts.isPrivateIdentifier(name) ||
        ts.isStringLiteral(name) ||
        ts.isNumericLiteral(name))
    ) {
      names.add(name.text);
    }
    if (
      (ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name !== undefined
    ) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol !== undefined) {
        // The members of a union are receivers of their own; isRedisCommand asks each for its symbol.
        const declared = checker.getDeclaredTypeOfSymbol(symbol);
        for (const member of declared.isUnion() ? declared.types : [declared]) {
          if (isDeclaredByIoredis(checker, member.getSymbol() ?? member.aliasSymbol)) {
            addPropertiesOf(member);
          }
        }
        if (ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) {
          addPropertiesOf(checker.getTypeOfSymbol(symbol)); // the static side: `Redis.Cluster`, …
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  let anyFile: ts.SourceFile | undefined;
  for (const source of program.getSourceFiles().filter((file) => isIoredisFile(file.fileName))) {
    anyFile = source;
    const moduleSymbol = checker.getSymbolAtLocation(source);
    for (const exported of moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol)) {
      names.add(exported.name);
    }
    visit(source);
  }
  if (anyFile === undefined) {
    throw new Error("ioredis is not part of the program");
  }
  for (const global of checker.getSymbolsInScope(anyFile, ts.SymbolFlags.Interface)) {
    if (OBJECT_AND_FUNCTION.has(global.name)) {
      addPropertiesOf(checker.getDeclaredTypeOfSymbol(global));
    }
  }
  memberNamesOfPrograms.set(program, names);
  return names;
}

/**
 * False when the scan cannot report a call `x.<method>(…)`, whatever `x` is, so the type checker need not resolve
 * `x` (resolving the receivers of all calls, Kysely's query builder chains among them, was most of the scan's
 * time): when the arguments `keyArguments` takes as keys are none or only function expressions (`rows.map((row) =>
 * …)`), which `handWrittenKeys` passes over as callbacks, and when no ioredis type has the method (see
 * `ioredisMemberNames`), as then it is no Redis command.
 */
function mayBeReported(program: ts.Program, call: ts.CallExpression, method: string): boolean {
  return (
    keyArguments(method, call.arguments).some(
      (found) =>
        "unreadable" in found || !(ts.isArrowFunction(found.key) || ts.isFunctionExpression(found.key)),
    ) && ioredisMemberNames(program).has(method)
  );
}

/**
 * True when the call is a method of an ioredis client: the method is declared by ioredis (`Redis`, `Pipeline`,
 * `ChainableCommander`, …), or the object it is called on is an ioredis client, so a command added with
 * `defineCommand` and declared in this package is scanned too.
 */
function isRedisCommand(checker: ts.TypeChecker, access: ts.PropertyAccessExpression): boolean {
  if (isDeclaredByIoredis(checker, checker.getSymbolAtLocation(access.name))) {
    return true;
  }
  const receiver = checker.getNonNullableType(checker.getTypeAtLocation(access.expression));
  const members = receiver.isUnion() ? receiver.types : [receiver];
  return members.every((member) => isDeclaredByIoredis(checker, member.getSymbol() ?? member.aliasSymbol));
}

/** True when the type is a `RedisKeyName`, a `RedisKey` (its `key` is one) or an array of them. */
function holdsBuiltKey(checker: ts.TypeChecker, type: ts.Type): boolean {
  const isKeyOrRedisKey = (candidate: ts.Type): boolean => {
    const key = checker.getPropertyOfType(candidate, "key");
    return (
      isBuiltKeyType(checker, candidate) ||
      (key !== undefined && isBuiltKeyType(checker, checker.getTypeOfSymbol(key)))
    );
  };
  // One level of elements only: a string's number index is a string again.
  const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  return isKeyOrRedisKey(type) || (element !== undefined && isKeyOrRedisKey(element));
}

/**
 * Every place in `files` where a key escapes redis.keys.ts: a Redis command whose key is written by hand (a string
 * or template literal, or text concatenated to one) or is not a `RedisKeyName` from redis.keys.ts, a call whose keys
 * cannot be found (see `keyArguments`), and a value cast to `RedisKeyName` or `RedisKey`, as
 * `<file>:<line> <command or cast>: <reason>`.
 */
function handWrittenKeys(program: ts.Program, files: readonly string[]): string[] {
  const checker = program.getTypeChecker();
  const problems: string[] = [];
  for (const fileName of files) {
    const source = program.getSourceFile(fileName);
    if (source === undefined) {
      throw new Error(`not in the program: ${fileName}`);
    }
    const report = (at: ts.Node, what: string, reason: string): void => {
      const { line } = source.getLineAndCharacterOfPosition(at.getStart(source));
      problems.push(`${relative(APP_DIR, fileName)}:${line + 1} ${what}: ${reason}`);
    };
    const visit = (node: ts.Node): void => {
      if (
        (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
        holdsBuiltKey(checker, checker.getTypeAtLocation(node)) &&
        !holdsBuiltKey(checker, checker.getTypeAtLocation(node.expression))
      ) {
        report(node, "cast", "a key cast to RedisKeyName (use redisKeys)");
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        mayBeReported(program, node, node.expression.name.text) &&
        isRedisCommand(checker, node.expression)
      ) {
        const command = node.expression.name.text;
        for (const found of keyArguments(command, node.arguments)) {
          if ("unreadable" in found) {
            report(found.at, command, `${found.unreadable} (the keys cannot be checked)`);
            continue;
          }
          const argument = found.key;
          const value = ts.isSpreadElement(argument) ? argument.expression : argument;
          const type = checker.getTypeAtLocation(value);
          if (type.getCallSignatures().length > 0) {
            continue; // a callback, not a key
          }
          if (isHandWritten(value)) {
            report(argument, command, "a key written by hand (use redisKeys)");
            continue;
          }
          const element = ts.isSpreadElement(argument)
            ? checker.getIndexTypeOfType(type, ts.IndexKind.Number)
            : type;
          if (element === undefined || !isBuiltKeyType(checker, element)) {
            report(argument, command, "a key not built by redisKeys");
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return problems;
}

/**
 * A program over `files`, plus in-memory files (absolute path → text) that resolve modules from their folder. As
 * tsc's own host, it leaves setting parent nodes to the binder; and it skips the JSDoc comments of TypeScript files,
 * which give no type there (about a third of building the program goes to parsing those of the declaration files).
 */
function createProgram(files: readonly string[], virtual: Readonly<Record<string, string>> = {}): ts.Program {
  const options = compilerOptions();
  const host = ts.createCompilerHost(options);
  host.jsDocParsingMode = ts.JSDocParsingMode.ParseForTypeInfo;
  const { getSourceFile, fileExists, readFile } = host;
  host.fileExists = (path) => Object.hasOwn(virtual, path) || fileExists.call(host, path);
  host.readFile = (path) => virtual[path] ?? readFile.call(host, path);
  host.getSourceFile = (path, language, ...rest) => {
    const text = virtual[path];
    return text === undefined
      ? getSourceFile.call(host, path, language, ...rest)
      : ts.createSourceFile(path, text, language, true);
  };
  return ts.createProgram({ rootNames: [...files, ...Object.keys(virtual)], options, host });
}

describe("source scan for hand-written Redis keys", () => {
  const PROBE = join(SRC_DIR, "common", "redis", "redis-key-scan.probe.ts");
  const PROBE_SOURCE = [
    'import { INVALIDATION_CHANNEL } from "@velexis/api-types/jobs";',
    'import type { Redis, Result } from "ioredis";',
    'import { redisKeys, type RedisKey, type RedisKeyName } from "./redis.keys";',
    "",
    "export async function probe(client: Redis, tenantId: string, raw: string): Promise<void> {",
    '  await client.get("tenant:ten_01M4T9E68084G7ZWYRD6Z1RV0W");',
    '  await client.set(`t:${tenantId}:test:sf:en`, "{}", "EX", 300);',
    '  await client.del(redisKeys.tenant(tenantId).key, "host:" + raw);',
    "  await client.expire(raw, 60);",
    "  await client.multi().incr(`rl:signin:${raw}`).expire(redisKeys.host(raw).key, 60).exec();",
    '  const key = redisKeys.sf(tenantId, "test", "en");',
    '  await client.set(key.key, "{}", "EX", key.ttlSeconds);',
    "  await client.del(...[redisKeys.tenant(tenantId).key, redisKeys.apiKey(raw).key]);",
    '  await client.eval("return 1", 1, redisKeys.cxq(tenantId, "live", raw).key, "value");',
    '  await client.ping("probe");',
    '  await client.publish(INVALIDATION_CHANNEL, "{}");',
    '  new Map<string, string>().get("tenant:not-redis");',
    "}",
    "",
    "export async function probeMore(client: Redis, tenantId: string, raw: string, keys: string[]): Promise<void> {",
    "  const cast = `host:${raw}` as RedisKeyName;",
    "  await client.get(cast);",
    '  await client.call("SET", `tenant:${raw}`, "{}", "EX", 60);',
    '  await client.call("GET", redisKeys.tenant(tenantId).key);',
    "  await client.call(raw, redisKeys.tenant(tenantId).key);",
    '  await client.multi([["del", "host:x"], ["expire", redisKeys.host(raw).key, 60]]).exec();',
    '  await client.pipeline(keys.map((name) => ["get", name])).exec();',
    "  await client.evalsha(raw, keys.length, ...keys);",
    '  await client.blpop(redisKeys.cxq(tenantId, "live", raw).key, 5);',
    "  await client.probeBucket(`rl:probe:${raw}`, 1);",
    '  await client.probeBucket(redisKeys.amadeusTenantBucket(tenantId, "test").key, 1);',
    '  const forged = { key: raw, ttlSeconds: 60, kind: "shared" } as RedisKey;',
    "  await client.del(forged.key);",
    "}",
    "",
    // A command added with defineCommand, declared the way the ioredis README shows.
    'declare module "ioredis" {',
    "  interface RedisCommander<Context> {",
    "    probeBucket(key: string, cost: number): Result<number, Context>;",
    "  }",
    "}",
    "",
  ].join("\n");

  let program: ts.Program;
  let scanned: string[];
  let sourceProblems: string[];

  // Building the program parses the package and the declarations it imports (NestJS, Kysely, Stripe, BullMQ,
  // ioredis), and the scan of the sources asks the type checker about every call that may be a Redis command. Until
  // wave 27 the program parsed the JSDoc of every declaration file and the scan asked about every call with a
  // property access, resolving the receivers of Kysely's query chains among them: with 210 production files about
  // 2.5 s for the program and 6 s for the scan on an idle 4-CPU machine (8.5 s for this test file) and from 41 s to
  // 46 s under the full parallel `pnpm test` there (from 43 s to more than 60 s in wave 26's integration runs). Now
  // the program skips that JSDoc (about 1.9 s) and the scan asks about the 1 000 of 9 900 calls that can be reported
  // (see `mayBeReported`; about 2.4 s, half of it for the five `exists(…)` of Kysely's expression builders): 5.3 s
  // idle for this test file and from 12 s to 30 s under the full parallel `pnpm test`. Both happen once, in this hook
  // with its own budget (180 s, as the worst case stays near 30 s); the tests below only assert on the results. The
  // scan takes one file at a time and gives the event loop back in between: one synchronous run of more than 60 s
  // made vitest's worker miss its RPC deadline ("Timeout calling onTaskUpdate"), which fails the run although every
  // test passed.
  beforeAll(async () => {
    const sources = productionSources();
    program = createProgram(sources, { [PROBE]: PROBE_SOURCE });
    scanned = sources.filter((file) => file !== KEYS_FILE);
    sourceProblems = [];
    for (const file of scanned) {
      sourceProblems.push(...handWrittenKeys(program, [file]));
      await setImmediate();
    }
  }, 180_000);

  it("finds no key written by hand outside redis.keys.ts in src/ [OBE-002 AC1]", () => {
    expect(scanned.map((file) => relative(APP_DIR, file))).toEqual(
      expect.arrayContaining(["src/main.ts", "src/worker.ts", "src/health/health.service.ts"]),
    );

    expect(sourceProblems).toEqual([]);
  });

  it("reports string, template and concatenated keys and keys not built by redisKeys [OBE-002 AC1]", () => {
    const probe = relative(APP_DIR, PROBE);
    const unreadable = "(the keys cannot be checked)";

    expect(handWrittenKeys(program, [PROBE])).toEqual([
      `${probe}:6 get: a key written by hand (use redisKeys)`,
      `${probe}:7 set: a key written by hand (use redisKeys)`,
      `${probe}:8 del: a key written by hand (use redisKeys)`,
      `${probe}:9 expire: a key not built by redisKeys`,
      `${probe}:10 incr: a key written by hand (use redisKeys)`,
      // Keys that reach the client another way: a cast, `call`, queued commands, a computed key count, a command
      // added with defineCommand, and a forged RedisKey. The blpop timeout (line 29) is not a key.
      `${probe}:21 cast: a key cast to RedisKeyName (use redisKeys)`,
      `${probe}:23 call: a key written by hand (use redisKeys)`,
      `${probe}:25 call: a command name that is not a string literal ${unreadable}`,
      `${probe}:26 multi: a key written by hand (use redisKeys)`,
      `${probe}:27 pipeline: queued commands that are not an array literal ${unreadable}`,
      `${probe}:28 evalsha: a key count (numkeys) that is not a number literal ${unreadable}`,
      `${probe}:30 probeBucket: a key written by hand (use redisKeys)`,
      `${probe}:32 cast: a key cast to RedisKeyName (use redisKeys)`,
    ]);
  });

  it("compiles the probe, so the scan saw the types it relies on", () => {
    const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(PROBE));

    expect(
      diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    ).toEqual([]);
  });
});
