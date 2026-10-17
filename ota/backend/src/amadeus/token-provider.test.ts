// TokenProvider against an in-memory Redis, a fake `fetch` and the test KEKs (OBE-017; OADR-0001 point 5, flows/
// amadeus-connection-and-tokens.md §3): the token request, the encrypted cache entry and its TTL, single flight, the
// refused-credentials flag, the errors of a failed request, dropToken and a Redis that does not answer. The provider
// against the stub and Redis 7 is test/integration/amadeus/resolver.int.test.ts. Waits run on fake timers.
import { randomBytes } from "node:crypto";
import { decryptValue, encryptValue, type KeyProvider } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import type { PinoLogger } from "nestjs-pino";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testKeyProvider } from "../../test/helpers/api-env";
import { newId } from "../common/ids";
import { redisKeys } from "../common/redis/redis.keys";
import type { ResolvedAmadeusConnection } from "./connection-resolver";
import {
  AmadeusCredentialsRefusedError,
  OAUTH_TOKEN_PATH,
  TOKEN_POLL_INTERVAL_MS,
  TOKEN_REQUEST_TIMEOUT_MS,
  TOKEN_WAIT_MS,
  tokenAad,
  TokenProvider,
  type AmadeusFetch,
} from "./token-provider";

const BASE_URL = "http://127.0.0.1:4900";

/** One key of the in-memory Redis: its value and its TTL in seconds (`undefined` for none). */
interface Entry {
  value: string;
  ttlSeconds: number | undefined;
}

/**
 * The commands the provider sends, on a Map: GET, MGET, SET with `EX` and `NX`, and EVAL of its compare-and-delete
 * script. `status` and `failing` stand in for a Redis that reconnects or fails its commands. Keys do not expire.
 */
class MemoryRedis {
  readonly entries = new Map<string, Entry>();
  status = "ready";
  failing = false;
  readonly calls: string[] = [];

  private check(command: string): void {
    this.calls.push(command);
    if (this.failing) {
      throw new Error("Connection is closed.");
    }
  }

  get(key: string): Promise<string | null> {
    this.check("get");
    return Promise.resolve(this.entries.get(key)?.value ?? null);
  }

  mget(...keys: string[]): Promise<Array<string | null>> {
    this.check("mget");
    return Promise.resolve(keys.map((key) => this.entries.get(key)?.value ?? null));
  }

  set(key: string, value: string, ...options: Array<string | number>): Promise<"OK" | null> {
    this.check("set");
    if (options.includes("NX") && this.entries.has(key)) {
      return Promise.resolve(null);
    }
    const ex = options.indexOf("EX");
    this.entries.set(key, { value, ttlSeconds: ex === -1 ? undefined : Number(options[ex + 1]) });
    return Promise.resolve("OK");
  }

  eval(script: string, keyCount: number, key: string, expected: string): Promise<number> {
    this.check("eval");
    expect([script.includes('redis.call("GET", KEYS[1]) == ARGV[1]'), keyCount]).toEqual([true, 1]);
    if (this.entries.get(key)?.value !== expected) {
      return Promise.resolve(0);
    }
    this.entries.delete(key);
    return Promise.resolve(1);
  }
}

/** The log lines of the provider, as `[level, fields, message]`. */
type LogLine = [string, Record<string, unknown>, string];

let keys: KeyProvider;
let redis: MemoryRedis;
let fetchMock: ReturnType<typeof vi.fn<AmadeusFetch>>;
let logs: LogLine[];
let provider: TokenProvider;
/** The client secret of the connection: random per test, never written anywhere. */
let secret: string;
let connection: ResolvedAmadeusConnection;

beforeAll(async () => {
  keys = await testKeyProvider();
});

async function connectionFor(
  credId = newId("ama"),
  environment: "test" | "live" = "test",
): Promise<ResolvedAmadeusConnection> {
  const aad = `platform.amadeus_accounts.client_secret_ciphertext:${credId}`;
  const { ciphertext } = await encryptValue(secret, { aad, keys });
  return Object.freeze({
    tenantId: newId("ten"),
    environment,
    connectionId: newId("sc"),
    credentialSource: "velexis",
    credId,
    clientId: "velexis-test-client",
    encryptedSecret: { ciphertext: ciphertext.toString("base64"), aad },
    baseUrl: BASE_URL,
    offices: { queuing: "NCE1A0955", owner: "NCE1A0955", queue: "NCE1A0955", retrieval: "NCE1A0955" },
    officeIds: ["NCE1A0955"],
  });
}

/** A fresh token in the shape Amadeus issues (base64url), as the stub does. */
const newToken = (): string => randomBytes(21).toString("base64url");

function tokenResponse(token = newToken(), expiresIn = 1799): Response {
  return Response.json({
    type: "amadeusOAuth2Token",
    token_type: "Bearer",
    access_token: token,
    expires_in: expiresIn,
  });
}

const oauthError = (status: number, error: string): Response =>
  Response.json({ error, error_description: "Client credentials are invalid", code: 38187 }, { status });

/** The AppError a promise rejects with, as `[status, code]`. */
async function refusal(promise: Promise<unknown>): Promise<[number, string]> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  return [(error as AppError).status, (error as AppError).code];
}

const tokenKey = (c = connection) => redisKeys.amadeusToken(c.credId, c.environment).key;
const lockKey = (c = connection) => redisKeys.amadeusTokenLock(c.credId, c.environment).key;
const badCredentialsKey = (c = connection) => redisKeys.amadeusBadCredentials(c.credId).key;

/** The token a stored entry decrypts to. */
async function storedToken(c = connection): Promise<string> {
  const stored = redis.entries.get(tokenKey(c));
  expect(stored).toBeDefined();
  const plaintext = await decryptValue(Buffer.from(stored?.value ?? "", "base64"), {
    aad: tokenAad(c.credId, c.environment),
    keys,
  });
  return plaintext.toString("utf8");
}

beforeEach(async () => {
  redis = new MemoryRedis();
  fetchMock = vi.fn<AmadeusFetch>();
  logs = [];
  const logger = {
    setContext: () => undefined,
    info: (fields: Record<string, unknown>, message: string) => logs.push(["info", fields, message]),
    warn: (fields: Record<string, unknown>, message: string) => logs.push(["warn", fields, message]),
    error: (fields: Record<string, unknown>, message: string) => logs.push(["error", fields, message]),
  } as unknown as PinoLogger;
  provider = new TokenProvider(redis as unknown as Redis, keys, fetchMock, logger);
  secret = randomBytes(18).toString("base64url");
  connection = await connectionFor();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a token request", () => {
  it("posts client_credentials with the decrypted secret to the connection's base URL", async () => {
    const token = newToken();
    fetchMock.mockResolvedValueOnce(tokenResponse(token));

    expect(await provider.getToken(connection)).toBe(token);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE_URL}${OAUTH_TOKEN_PATH}`);
    expect(init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      redirect: "error",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      grant_type: "client_credentials",
      client_id: "velexis-test-client",
      client_secret: secret,
    });
  });

  it("stores the token as ciphertext under amadeus:token:<credId>:<env> until expires_in − 60 s [OBE-017 AC2]", async () => {
    const token = newToken();
    fetchMock.mockResolvedValueOnce(tokenResponse(token, 1799));

    await provider.getToken(connection);

    const stored = redis.entries.get(tokenKey());
    expect(stored?.ttlSeconds).toBe(1739);
    expect(stored?.value).not.toContain(token);
    expect(Buffer.from(stored?.value ?? "", "base64").toString("latin1")).not.toContain(token);
    expect(await storedToken()).toBe(token);
    // The associated data binds it to its key: under another credential set it does not decrypt.
    await expect(
      decryptValue(Buffer.from(stored?.value ?? "", "base64"), { aad: tokenAad(newId("ama"), "test"), keys }),
    ).rejects.toThrow("Decryption failed");
    expect(tokenAad(connection.credId, "test")).toBe(
      `redis.amadeus_token.access_token:amadeus:token:${connection.credId}:test`,
    );
  });

  it("is made once: later calls read the cached token, and the lock is given up", async () => {
    const token = newToken();
    fetchMock.mockResolvedValueOnce(tokenResponse(token));

    const tokens = [await provider.getToken(connection), await provider.getToken(connection)];

    expect(tokens).toEqual([token, token]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(redis.entries.has(lockKey())).toBe(false);
  });

  it("is made once for 50 concurrent calls of one process [OBE-017 AC1]", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const token = newToken();
    fetchMock.mockResolvedValue(tokenResponse(token));

    const calls = Array.from({ length: 50 }, () => provider.getToken(connection));
    await vi.advanceTimersByTimeAsync(TOKEN_POLL_INTERVAL_MS);

    expect(await Promise.all(calls)).toEqual(Array.from({ length: 50 }, () => token));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keys the token by credential set and environment: another set or environment requests its own", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(tokenResponse()));
    const live = await connectionFor(connection.credId, "live");
    const other = await connectionFor();

    const tokens = new Set([
      await provider.getToken(connection),
      await provider.getToken(live),
      await provider.getToken(other),
      await provider.getToken(connection),
    ]);

    expect(tokens.size).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("caches a token that lives no longer than the margin for one second", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse(newToken(), 30));

    await provider.getToken(connection);

    expect(redis.entries.get(tokenKey())?.ttlSeconds).toBe(1);
  });
});

describe("single flight across processes", () => {
  it("waits for the token another process is fetching, without a request of its own", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    redis.entries.set(lockKey(), { value: "another-process", ttlSeconds: 10 });
    const token = newToken();

    const call = provider.getToken(connection);
    await vi.advanceTimersByTimeAsync(3 * TOKEN_POLL_INTERVAL_MS);
    const { ciphertext } = await encryptValue(token, { aad: tokenAad(connection.credId, "test"), keys });
    redis.entries.set(tokenKey(), { value: ciphertext.toString("base64"), ttlSeconds: 1739 });
    await vi.advanceTimersByTimeAsync(TOKEN_POLL_INTERVAL_MS);

    expect(await call).toBe(token);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(redis.entries.get(lockKey())?.value).toBe("another-process");
  });

  it("takes the lock when its holder gave it up without a token", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    redis.entries.set(lockKey(), { value: "another-process", ttlSeconds: 10 });
    const token = newToken();
    fetchMock.mockResolvedValueOnce(tokenResponse(token));

    const call = provider.getToken(connection);
    await vi.advanceTimersByTimeAsync(TOKEN_POLL_INTERVAL_MS);
    expect(fetchMock).not.toHaveBeenCalled();
    redis.entries.delete(lockKey());
    await vi.advanceTimersByTimeAsync(TOKEN_POLL_INTERVAL_MS);

    expect(await call).toBe(token);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(redis.entries.has(lockKey())).toBe(false);
  });

  it("requests a token itself after waiting 2 s for a holder that does not finish", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    redis.entries.set(lockKey(), { value: "another-process", ttlSeconds: 10 });
    const token = newToken();
    fetchMock.mockResolvedValueOnce(tokenResponse(token));

    const call = provider.getToken(connection);
    await vi.advanceTimersByTimeAsync(TOKEN_WAIT_MS - TOKEN_POLL_INTERVAL_MS);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(TOKEN_POLL_INTERVAL_MS);

    expect(await call).toBe(token);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The other process's lock is left alone.
    expect(redis.entries.get(lockKey())?.value).toBe("another-process");
  });

  it("does not request a token when one was stored between its cache read and taking the lock", async () => {
    const token = newToken();
    const { ciphertext } = await encryptValue(token, { aad: tokenAad(connection.credId, "test"), keys });
    const mget = redis.mget.bind(redis);
    let reads = 0;
    vi.spyOn(redis, "mget").mockImplementation(async (...names: string[]) => {
      const answer = await mget(...names);
      reads += 1;
      if (reads === 1) {
        // Another process stores its token and releases its lock right after this call's first look.
        redis.entries.set(tokenKey(), { value: ciphertext.toString("base64"), ttlSeconds: 1739 });
      }
      return answer;
    });

    expect(await provider.getToken(connection)).toBe(token);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(redis.entries.has(lockKey())).toBe(false);
  });
});

describe("refused credentials", () => {
  it.each([
    ["401 invalid_client", () => oauthError(401, "invalid_client")],
    ["400 invalid_client", () => oauthError(400, "invalid_client")],
    ["401 without a body", () => new Response(null, { status: 401 })],
  ])(
    "set amadeus:badcred:<credId> for 5 minutes and answer 424 on %s [OBE-017 AC2]",
    async (_case, answer) => {
      fetchMock.mockResolvedValueOnce(answer());

      expect(await refusal(provider.getToken(connection))).toEqual([424, "SUPPLIER_NOT_CONFIGURED"]);

      expect(redis.entries.get(badCredentialsKey())).toEqual({ value: "1", ttlSeconds: 300 });
      expect(redis.entries.has(tokenKey())).toBe(false);
      expect(redis.entries.has(lockKey())).toBe(false);
      expect(logs).toContainEqual([
        "error",
        { credId: connection.credId, environment: "test", status: answer().status },
        "amadeus.credentials_refused",
      ]);
    },
  );

  it("answer 424 without a new token request while the flag is set [OBE-017 AC2]", async () => {
    redis.entries.set(badCredentialsKey(), { value: "1", ttlSeconds: 300 });

    const error = await provider.getToken(connection).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ status: 424, code: "SUPPLIER_NOT_CONFIGURED" });
    expect((error as AppError).cause).toBeInstanceOf(AmadeusCredentialsRefusedError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(redis.calls).toEqual(["mget"]);
  });

  it("stop a call that waits for another process's token as soon as the flag appears", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    redis.entries.set(lockKey(), { value: "another-process", ttlSeconds: 10 });

    const call = refusal(provider.getToken(connection));
    await vi.advanceTimersByTimeAsync(TOKEN_POLL_INTERVAL_MS);
    redis.entries.set(badCredentialsKey(), { value: "1", ttlSeconds: 300 });
    await vi.advanceTimersByTimeAsync(TOKEN_POLL_INTERVAL_MS);

    expect(await call).toEqual([424, "SUPPLIER_NOT_CONFIGURED"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a failed token request", () => {
  const timeout = (): never => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  const reset = (): never => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    });
  };
  const refused = (): never => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
    });
  };

  it.each([
    ["a timeout", timeout, [504, "SUPPLIER_TIMEOUT"]],
    ["a connection reset", reset, [504, "SUPPLIER_TIMEOUT"]],
    ["a refused connection", refused, [503, "SUPPLIER_UNAVAILABLE"]],
    [
      "HTTP 500",
      () => Response.json({ errors: [{ status: 500, code: 141 }] }, { status: 500 }),
      [503, "SUPPLIER_UNAVAILABLE"],
    ],
    ["HTTP 503", () => new Response("unavailable", { status: 503 }), [503, "SUPPLIER_UNAVAILABLE"]],
    ["HTTP 429", () => new Response(null, { status: 429 }), [503, "SUPPLIER_UNAVAILABLE"]],
    ["400 invalid_request", () => oauthError(400, "invalid_request"), [502, "SUPPLIER_ERROR"]],
    ["200 without a token", () => Response.json({ expires_in: 1799 }), [502, "SUPPLIER_ERROR"]],
    [
      "200 with a malformed token",
      () => Response.json({ access_token: "a b", expires_in: 1799 }),
      [502, "SUPPLIER_ERROR"],
    ],
    ["200 without expires_in", () => Response.json({ access_token: newToken() }), [502, "SUPPLIER_ERROR"]],
    ["200 with a negative expires_in", () => tokenResponse(newToken(), -5), [502, "SUPPLIER_ERROR"]],
    ["200 that is not JSON", () => new Response("<html>"), [502, "SUPPLIER_ERROR"]],
  ] as const)(
    "answers %s with the supplier code, caches nothing and frees the lock",
    async (_case, answer, expected) => {
      fetchMock.mockImplementationOnce(() => Promise.resolve().then(answer));

      expect(await refusal(provider.getToken(connection))).toEqual(expected);

      expect([...redis.entries.keys()]).toEqual([]);
      expect(logs.filter(([, , message]) => message === "amadeus.token_request")).toHaveLength(1);
    },
  );

  it("gives up after its own 10 s timeout", async () => {
    const timeoutSignal = vi.spyOn(AbortSignal, "timeout");
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((_url, init) => {
      signal = init?.signal ?? undefined;
      return Promise.reject(new DOMException("aborted", "TimeoutError"));
    });

    try {
      expect(await refusal(provider.getToken(connection))).toEqual([504, "SUPPLIER_TIMEOUT"]);

      expect(TOKEN_REQUEST_TIMEOUT_MS).toBe(10_000);
      // The request carries the signal of AbortSignal.timeout(10 s), which also bounds reading the body.
      expect(timeoutSignal).toHaveBeenCalledExactlyOnceWith(TOKEN_REQUEST_TIMEOUT_MS);
      expect(signal).toBe(timeoutSignal.mock.results[0]?.value);
    } finally {
      timeoutSignal.mockRestore();
    }
  });

  it("lets the next call try again", async () => {
    const token = newToken();
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(tokenResponse(token));

    await refusal(provider.getToken(connection));

    expect(await provider.getToken(connection)).toBe(token);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("dropToken", () => {
  it("deletes the cached token an operation was refused with, so the next call requests a new one", async () => {
    const [first, second] = [newToken(), newToken()];
    fetchMock.mockResolvedValueOnce(tokenResponse(first)).mockResolvedValueOnce(tokenResponse(second));
    const token = await provider.getToken(connection);

    await provider.dropToken(connection, token);

    expect(redis.entries.has(tokenKey())).toBe(false);
    expect(await provider.getToken(connection)).toBe(second);
  });

  it("keeps a newer token that another call stored meanwhile", async () => {
    const [stale, fresh] = [newToken(), newToken()];
    fetchMock.mockResolvedValueOnce(tokenResponse(fresh));
    await provider.getToken(connection);

    await provider.dropToken(connection, stale);

    expect(await storedToken()).toBe(fresh);
  });
});

describe("the cache entry", () => {
  it("is replaced when it does not decrypt (another place's ciphertext, a removed KEK)", async () => {
    const copied = await encryptValue(newToken(), { aad: tokenAad(newId("ama"), "test"), keys });
    redis.entries.set(tokenKey(), { value: copied.ciphertext.toString("base64"), ttlSeconds: 1739 });
    const token = newToken();
    fetchMock.mockResolvedValueOnce(tokenResponse(token));

    expect(await provider.getToken(connection)).toBe(token);

    expect(await storedToken()).toBe(token);
    expect(logs).toContainEqual([
      "warn",
      { credId: connection.credId, environment: "test" },
      "amadeus.token_unreadable",
    ]);
  });
});

describe("without Redis", () => {
  it("answers 503 SERVICE_UNAVAILABLE while the client reconnects, without a token request", async () => {
    redis.status = "reconnecting";

    expect(await refusal(provider.getToken(connection))).toEqual([503, "SERVICE_UNAVAILABLE"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 503 SERVICE_UNAVAILABLE when a command fails", async () => {
    redis.failing = true;

    expect(await refusal(provider.getToken(connection))).toEqual([503, "SERVICE_UNAVAILABLE"]);
    expect(await refusal(provider.dropToken(connection, newToken()))).toEqual([503, "SERVICE_UNAVAILABLE"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("secrets", () => {
  it("never puts the client secret or a token in a log line or an error", async () => {
    const token = newToken();
    fetchMock
      .mockResolvedValueOnce(tokenResponse(token))
      .mockResolvedValueOnce(oauthError(401, "invalid_client"));
    await provider.getToken(connection);
    const other = await connectionFor();
    const error = await provider.getToken(other).catch((reason: unknown) => reason);

    const text = JSON.stringify(logs) + String(error) + String((error as Error).cause);
    expect(logs.map(([, , message]) => message)).toEqual([
      "amadeus.token_request",
      "amadeus.token_request",
      "amadeus.credentials_refused",
    ]);
    expect(logs[0]?.[1]).toMatchObject({ amadeusApi: "Authorization", status: 200, outcome: "ok" });
    expect(text).not.toContain(secret);
    expect(text).not.toContain(token);
    expect(JSON.stringify([...redis.entries.values()])).not.toContain(secret);
  });
});
