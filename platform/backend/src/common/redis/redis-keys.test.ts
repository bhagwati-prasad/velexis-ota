// The Redis keys of the platform backend (PBE-009; platform/docs/architecture.md §6.4): every builder is listed here
// with the key and TTL that §6.4 gives it, every key has a TTL (Redis runs with noeviction), the write helpers always
// set it, and no file of `src/` other than redis-keys.ts writes a key by hand or writes to Redis past the helpers.
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { APP_DIR } from "../../config";
import {
  IDEMPOTENCY_LOCK_TTL_SECONDS,
  REDIS_KEY_PREFIXES,
  deleteKeyIfValue,
  incrementInWindow,
  redisKeys,
  setKey,
  setKeyIfAbsent,
  type RedisKey,
  type RedisKeyBuilderName,
  type RedisWriter,
} from "./redis-keys";

const ACCOUNT_ID = "acc_01M4TA0Z9N3QKX8V5B7C2D4E6F";
const KEY_ID = "key_01M4TA2B3C4D5E6F7G8H9J0K1M";
const HASH = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const IDEMPOTENCY_KEY = "8d3c6c1e-2f4b-4a51-9b7e-0c1d2e3f4a5b";

/** Arguments for every builder. Typed by the builder names, so a new builder does not compile until it is listed. */
const SAMPLES: Readonly<Record<RedisKeyBuilderName, readonly unknown[]>> = {
  portalToken: [HASH],
  staffDenyAccount: [ACCOUNT_ID],
  apiKeyUsed: [KEY_ID],
  idempotency: [ACCOUNT_ID, IDEMPOTENCY_KEY],
  idempotencyLock: [ACCOUNT_ID, IDEMPOTENCY_KEY],
  mfaChallenge: [HASH],
  mfaSetup: [ACCOUNT_ID],
  stripeOAuthState: [HASH],
  tlsAsk: ["travel.example.net"],
  throttle: ["sign_up", HASH, 3600],
};

/** What architecture §6.4 says each builder gives for the samples above. */
const EXPECTED: Readonly<Record<RedisKeyBuilderName, { readonly key: string; readonly ttlSeconds: number }>> =
  {
    portalToken: { key: `ptk:${HASH}`, ttlSeconds: 60 },
    staffDenyAccount: { key: `staffdeny:acct:${ACCOUNT_ID}`, ttlSeconds: 30 * 86400 },
    apiKeyUsed: { key: `apikey:used:${KEY_ID}`, ttlSeconds: 86400 },
    idempotency: { key: `vx:idem:${ACCOUNT_ID}:${IDEMPOTENCY_KEY}`, ttlSeconds: 86400 },
    idempotencyLock: { key: `vx:idem:${ACCOUNT_ID}:${IDEMPOTENCY_KEY}:lock`, ttlSeconds: 10 },
    mfaChallenge: { key: `mfach:${HASH}`, ttlSeconds: 300 },
    mfaSetup: { key: `mfasetup:${ACCOUNT_ID}`, ttlSeconds: 600 },
    stripeOAuthState: { key: `stripe:oauth:${HASH}`, ttlSeconds: 600 },
    tlsAsk: { key: "tlsask:travel.example.net", ttlSeconds: 60 },
    throttle: { key: `rl:sign_up:${HASH}`, ttlSeconds: 3600 },
  };

/** The documented pattern as a regular expression: each `<placeholder>` is one or more characters. */
function patternExpression(pattern: string): RegExp {
  const parts = pattern.split(/<[^>]+>/).map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join(".+")}$`);
}

describe("redisKeys", () => {
  it("builds every key of architecture §6.4 with its TTL, frozen, matching its documented pattern", () => {
    expect(Object.keys(redisKeys).sort()).toEqual(Object.keys(SAMPLES).sort());
    for (const [name, args] of Object.entries(SAMPLES) as Array<[RedisKeyBuilderName, readonly unknown[]]>) {
      const build = redisKeys[name] as unknown as ((...values: unknown[]) => RedisKey) & { pattern: string };
      const result = build(...args);

      expect({ ...result }, name).toEqual(EXPECTED[name]);
      expect(Number.isSafeInteger(result.ttlSeconds) && result.ttlSeconds > 0, name).toBe(true);
      expect(Object.isFrozen(result), name).toBe(true);
      expect(result.key, name).toMatch(patternExpression(build.pattern));
      expect(
        REDIS_KEY_PREFIXES.some((prefix) => result.key.startsWith(prefix)),
        name,
      ).toBe(true);
    }
    expect(Object.isFrozen(redisKeys)).toBe(true);
  });

  it("gives a throttler counter its window as TTL, in whole seconds and at least one", () => {
    expect(redisKeys.throttle("sign_in", HASH, 60).ttlSeconds).toBe(60);
    expect(redisKeys.throttle("sign_in", HASH, 0.2).ttlSeconds).toBe(1);
    for (const window of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => redisKeys.throttle("sign_in", HASH, window), String(window)).toThrow(RangeError);
    }
  });

  it("refuses parts that are not what the key expects, without echoing them", () => {
    const token = "Zm9yZ2VkLXBvcnRhbC10b2tlbi12YWx1ZS0x";
    const refusals: Array<[() => unknown, RegExp]> = [
      [() => redisKeys.portalToken(token), /redisKeys\.portalToken: tokenSha256 must be a SHA-256 digest/],
      [() => redisKeys.mfaChallenge(HASH.toUpperCase()), /challengeSha256 must be a SHA-256 digest/],
      [() => redisKeys.staffDenyAccount("acc_123"), /accountId must be an account id/],
      [() => redisKeys.mfaSetup(`${ACCOUNT_ID}:x`), /accountId must be an account id/],
      [() => redisKeys.apiKeyUsed(ACCOUNT_ID), /keyId must be an API key id/],
      [() => redisKeys.idempotency(ACCOUNT_ID, "short"), /idempotencyKey must be an Idempotency-Key/],
      [() => redisKeys.idempotency(ACCOUNT_ID, `${IDEMPOTENCY_KEY}:lock`), /idempotencyKey must be/],
      [() => redisKeys.idempotencyLock("ten_01M4T9E68084G7ZWYRD6Z1RV0W", IDEMPOTENCY_KEY), /accountId/],
      [() => redisKeys.tlsAsk("Travel.Example.net"), /hostname must be a lower-case host name/],
      [() => redisKeys.tlsAsk("192.0.2.10"), /hostname must be a lower-case host name/],
      [() => redisKeys.tlsAsk("travel.example.net."), /hostname must be a lower-case host name/],
      [() => redisKeys.throttle("Sign-Up", HASH, 60), /throttler must be a throttler name/],
      [() => redisKeys.throttle("sign_up", "203.0.113.7", 60), /tracker must be a throttler tracker/],
      [() => redisKeys.stripeOAuthState("state:1"), /stateSha256 must be a SHA-256 digest/],
    ];
    for (const [build, message] of refusals) {
      expect(build, String(message)).toThrow(message);
    }
    try {
      redisKeys.portalToken(token);
    } catch (error) {
      expect(String(error)).not.toContain(token);
    }
  });
});

/** A Redis double that records the commands of the write helpers. */
function recordingClient(replies: { set?: unknown; eval?: unknown } = {}): {
  client: RedisWriter;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  const client = {
    set: vi.fn((...args: unknown[]) => {
      calls.push(["set", ...args]);
      return Promise.resolve("set" in replies ? replies.set : "OK");
    }),
    eval: vi.fn((...args: unknown[]) => {
      calls.push(["eval", ...args]);
      return Promise.resolve("eval" in replies ? replies.eval : [1, 60_000]);
    }),
  };
  return { client: client as unknown as RedisWriter, calls };
}

describe("the write helpers", () => {
  const key = redisKeys.mfaSetup(ACCOUNT_ID);
  const lock = redisKeys.idempotencyLock(ACCOUNT_ID, IDEMPOTENCY_KEY);

  it("setKey writes with the key's TTL (SET … EX)", async () => {
    const { client, calls } = recordingClient();

    await setKey(client, key, "ciphertext");

    expect(calls).toEqual([["set", key.key, "ciphertext", "EX", 600]]);
  });

  it("setKeyIfAbsent writes with the key's TTL only when the key is absent (SET … EX … NX)", async () => {
    const taken = recordingClient();
    const busy = recordingClient({ set: null });

    await expect(setKeyIfAbsent(taken.client, lock, "token-1")).resolves.toBe(true);
    await expect(setKeyIfAbsent(busy.client, lock, "token-2")).resolves.toBe(false);

    expect(taken.calls).toEqual([["set", lock.key, "token-1", "EX", IDEMPOTENCY_LOCK_TTL_SECONDS, "NX"]]);
  });

  it("incrementInWindow counts in one script that sets the window as TTL on the first hit or a lost TTL", async () => {
    const counter = redisKeys.throttle("sign_up", HASH, 3600);
    const { client, calls } = recordingClient({ eval: [6, 1_234_567] });

    await expect(incrementInWindow(client, counter)).resolves.toEqual({ hits: 6, expiresInMs: 1_234_567 });

    const [call] = calls;
    expect(call?.slice(0, 1)).toEqual(["eval"]);
    expect(call?.slice(2)).toEqual([1, counter.key, "3600000"]);
    const script = String(call?.[1]);
    expect(script).toContain("redis.call('INCR', KEYS[1])");
    expect(script).toMatch(/if hits == 1 or ttl < 0 then\s+redis\.call\('PEXPIRE', KEYS\[1\], ARGV\[1\]\)/);
  });

  it("incrementInWindow refuses a reply it cannot read", async () => {
    const { client } = recordingClient({ eval: "OK" });

    await expect(incrementInWindow(client, redisKeys.throttle("sign_up", HASH, 60))).rejects.toThrow(
      /unexpected reply/,
    );
  });

  it("deleteKeyIfValue deletes only while the key holds the value", async () => {
    const released = recordingClient({ eval: 1 });
    const stolen = recordingClient({ eval: 0 });

    await expect(deleteKeyIfValue(released.client, lock, "token-1")).resolves.toBe(true);
    await expect(deleteKeyIfValue(stolen.client, lock, "token-1")).resolves.toBe(false);
    expect(released.calls[0]?.slice(2)).toEqual([1, lock.key, "token-1"]);
  });
});

// ---- Source scan --------------------------------------------------------------------------------------------------

const SRC_DIR = join(APP_DIR, "src");
const KEYS_FILE = join(SRC_DIR, "common", "redis", "redis-keys.ts");

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

/**
 * The ioredis commands that create or change a key, or that send commands the scan cannot read (`eval`, `multi`,
 * `call`, …). Only the helpers of redis-keys.ts may call them. `Buffer` variants count as their command.
 */
const WRITE_COMMANDS = new Set(
  `
  append bitfield bitop blmove brpoplpush call copy decr decrby eval eval_ro evalsha evalsha_ro fcall fcall_ro geoadd
  georadius georadiusbymember geosearchstore getex getset hincrby hincrbyfloat hmset hset hsetnx incr incrby
  incrbyfloat linsert lmove lpush lpushx lset migrate move mset msetnx multi persist pexpireat pfadd pfmerge pipeline
  psetex rename renamenx restore rpoplpush rpush rpushx sadd sdiffstore sendCommand set setbit setex setnx setrange
  sinterstore smove sort sunionstore xadd xgroup zadd zdiffstore zincrby zinterstore zrangestore zunionstore
`
    .split(/\s+/)
    .filter((name) => name !== ""),
);

/** True when the symbol (or the symbol it aliases) is declared by ioredis. */
function isDeclaredByIoredis(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): boolean {
  const target =
    symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return (target?.declarations ?? []).some((declaration) =>
    declaration.getSourceFile().fileName.replaceAll("\\", "/").includes("/node_modules/ioredis/"),
  );
}

/** True when the call is a method of an ioredis client (`Redis`, `Pipeline`, `ChainableCommander`, …). */
function isRedisCommand(checker: ts.TypeChecker, access: ts.PropertyAccessExpression): boolean {
  if (isDeclaredByIoredis(checker, checker.getSymbolAtLocation(access.name))) {
    return true;
  }
  const receiver = checker.getNonNullableType(checker.getTypeAtLocation(access.expression));
  const members = receiver.isUnion() ? receiver.types : [receiver];
  return members.every((member) => isDeclaredByIoredis(checker, member.getSymbol() ?? member.aliasSymbol));
}

/** The text of a string or template literal (the head of a template), or `undefined`. */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)) {
    return node.text;
  }
  return undefined;
}

/**
 * Every place in `files` that writes Redis past redis-keys.ts: a string or template literal that starts with a key
 * prefix (a key written by hand), and a call of an ioredis write command, as `<file>:<line> <what>: <reason>`.
 */
function redisWritesOutsideHelpers(program: ts.Program, files: readonly string[]): string[] {
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
      const text = literalText(node);
      const prefix = text === undefined ? undefined : REDIS_KEY_PREFIXES.find((p) => text.startsWith(p));
      if (prefix !== undefined) {
        report(node, prefix, "a key written by hand (use redisKeys)");
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        isRedisCommand(checker, node.expression)
      ) {
        const command = node.expression.name.text.replace(/Buffer$/, "");
        if (WRITE_COMMANDS.has(command)) {
          report(node.expression.name, command, "a Redis write outside the helpers of redis-keys.ts");
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return problems;
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

/** A program over `files`, plus in-memory files (absolute path → text) that resolve modules from their folder. */
function createProgram(files: readonly string[], virtual: Readonly<Record<string, string>> = {}): ts.Program {
  const options = compilerOptions();
  const host = ts.createCompilerHost(options, true);
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

describe("source scan for Redis writes past redis-keys.ts", () => {
  const PROBE = join(SRC_DIR, "common", "redis", "redis-write-scan.probe.ts");
  const PROBE_SOURCE = [
    'import { INVALIDATION_CHANNEL } from "@velexis/api-types/jobs";',
    'import type { Redis } from "ioredis";',
    'import { redisKeys, setKey } from "./redis-keys";',
    "",
    "export async function probe(client: Redis, accountId: string, raw: string): Promise<void> {",
    "  await client.get(redisKeys.mfaSetup(accountId).key);",
    '  await client.set(redisKeys.mfaSetup(accountId).key, "x");',
    "  await client.incr(`rl:sign_up:${raw}`);",
    '  await client.getdel("ptk:" + raw);',
    '  await client.multi().set(raw, "1").exec();',
    '  await client.eval("return 1", 0);',
    '  await setKey(client, redisKeys.mfaSetup(accountId), "x");',
    "  await client.del(redisKeys.mfaSetup(accountId).key);",
    '  await client.publish(INVALIDATION_CHANNEL, "{}");',
    '  new Map<string, string>().set("vx:idem:x", "y");',
    "}",
    "",
  ].join("\n");

  let sources: string[];
  let program: ts.Program;
  let scanned: string[];
  let findings: string[];

  // Building the program parses the package and the declarations it imports (NestJS, BullMQ, ioredis), and the scan
  // resolves the type of every call in src/ with the type checker: a few seconds that grow with the package, several
  // times that under a full parallel `pnpm test`. Both happen once, in this hook with its own timeout, so the tests
  // below only compare results.
  beforeAll(() => {
    sources = productionSources();
    program = createProgram(sources, { [PROBE]: PROBE_SOURCE });
    scanned = sources.filter((file) => file !== KEYS_FILE);
    findings = redisWritesOutsideHelpers(program, scanned);
  }, 60_000);

  it("finds no hand-written key and no Redis write outside redis-keys.ts in src/", () => {
    expect(scanned.map((file) => relative(APP_DIR, file))).toEqual(
      expect.arrayContaining([
        "src/common/http/idempotency.interceptor.ts",
        "src/common/http/throttler.config.ts",
        "src/common/redis/invalidation.publisher.ts",
        "src/health/health.service.ts",
      ]),
    );

    expect(findings).toEqual([]);
  });

  it("reports hand-written keys and writes that bypass the helpers, and lets reads, deletes and publish through", () => {
    const probe = relative(APP_DIR, PROBE);

    expect(redisWritesOutsideHelpers(program, [PROBE])).toEqual([
      `${probe}:7 set: a Redis write outside the helpers of redis-keys.ts`,
      `${probe}:8 incr: a Redis write outside the helpers of redis-keys.ts`,
      `${probe}:8 rl:: a key written by hand (use redisKeys)`,
      `${probe}:9 ptk:: a key written by hand (use redisKeys)`,
      `${probe}:10 set: a Redis write outside the helpers of redis-keys.ts`,
      `${probe}:10 multi: a Redis write outside the helpers of redis-keys.ts`,
      `${probe}:11 eval: a Redis write outside the helpers of redis-keys.ts`,
      `${probe}:15 vx:idem:: a key written by hand (use redisKeys)`,
    ]);
  });

  it("compiles the probe, so the scan saw the types it relies on", () => {
    const diagnostics = ts.getPreEmitDiagnostics(program, program.getSourceFile(PROBE));

    expect(
      diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    ).toEqual([]);
  });
});
