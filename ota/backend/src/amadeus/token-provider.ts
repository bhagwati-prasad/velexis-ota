// Amadeus OAuth access tokens (OADR-0001 point 5, flows/amadeus-connection-and-tokens.md §1 and §3, ADR-0012;
// OBE-017): one token per credential set and environment, shared by every OTA on that set and by every process.
//
//   amadeus:badcred:<credId>         the credentials were refused: 424 SUPPLIER_NOT_CONFIGURED, no token request (5 min)
//   amadeus:token:<credId>:<env>     the access token, envelope-encrypted, until `expires_in` − 60 s
//   amadeus:tokenlock:<credId>:<env> single flight of a refresh: `SET NX EX 10` with a random owner value
//
// getToken(connection):
//   1. MGET badcred, token. A refused-credentials flag answers 424 at once; a cached token is decrypted and returned.
//   2. Otherwise take the lock and, after looking at the cache once more (another process may have just stored a
//      token), request one: POST {baseUrl}/v1/security/oauth2/token with `client_credentials`, the client secret
//      decrypted in memory for this one request (the Buffer is zeroed after use), a 10 s timeout. The token is
//      encrypted and stored with its TTL, then the lock is released (only by its owner).
//   3. Without the lock, wait up to 2 s for the token to appear, looking every 50 ms; take the lock if its holder
//      gave it up without a token (its request failed), and after 2 s request a token without the lock.
//
// dropToken(connection, token) deletes the cached token after an operation answered 401 with it (the client then
// retries once with a new one, OBE-018); a token another call has stored meanwhile is kept.
//
// A token request refused with 401, or with 400 `invalid_client`, sets the refused-credentials flag and answers 424;
// the platform's verification job owns fixing credentials. Timeouts answer 504 SUPPLIER_TIMEOUT, network errors,
// `429` and `5xx` 503 SUPPLIER_UNAVAILABLE, any other answer 502 SUPPLIER_ERROR. Retries of the token request (once,
// with jitter) belong to the client's limits (OBE-018): the cause of these errors, `AmadeusTokenRequestError`, says
// whether the request may be sent again (a network error, a timeout or a `5xx`; never a `429`).
//
// Without Redis there is no token cache and no single flight: every call answers 503 SERVICE_UNAVAILABLE (flow §7),
// which protects the shared account's quota.
//
// Secrets: the client secret and the token are never logged, never put in an error, and never stored in clear. The
// token's associated data is its Redis key, `redis.amadeus_token.access_token:amadeus:token:<credId>:<env>`, so a
// ciphertext copied to another credential set or environment does not decrypt. A cached token that does not decrypt
// (a KEK removed after a rotation, which flushes these keys instead of re-wrapping them) is a miss and is replaced.
import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { aadFor, decryptValue, DecryptionError, encryptValue, type KeyProvider } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import { PinoLogger } from "nestjs-pino";
import { redisKeys, type RedisKey } from "../common/redis/redis.keys";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import type { ResolvedAmadeusConnection } from "./connection-resolver";

/** Injection token of the process's `KeyProvider` (the KEKs of MASTER_KEY_DIR). */
export const KEY_PROVIDER = "KEY_PROVIDER";

/** Injection token of the `fetch` the Amadeus module uses: the built-in one, a fake in unit tests. */
export const AMADEUS_FETCH = "AMADEUS_FETCH";
export type AmadeusFetch = typeof fetch;

/** The token endpoint, after the base URL. */
export const OAUTH_TOKEN_PATH = "/v1/security/oauth2/token";

/** The timeout of a token request (flow §4). */
export const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
/** How long a call without the lock waits for another one's token (flow §3). */
export const TOKEN_WAIT_MS = 2_000;
/** How often it looks. */
export const TOKEN_POLL_INTERVAL_MS = 50;

/** An OAuth 2.0 bearer token (RFC 6750 `b64token`), at most 4 KB: anything else from the token endpoint is refused. */
const ACCESS_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;
const MAX_ACCESS_TOKEN_LENGTH = 4096;

/** ioredis statuses in which the command client cannot answer (as platform-cache.ts). */
const REDIS_DOWN: ReadonlySet<string> = new Set(["reconnecting", "close", "end"]);

/** Deletes KEYS[1] only while it still holds ARGV[1]: a lock's owner, or the token a caller saw. */
const DELETE_IF_UNCHANGED = `if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end
return 0`;

/** The value of the refused-credentials flag; only its presence counts. */
const BAD_CREDENTIALS_FLAG = "1";

/** The cause of a 424 for refused credentials: ids only. */
export class AmadeusCredentialsRefusedError extends Error {
  override readonly name = "AmadeusCredentialsRefusedError";

  constructor(
    readonly credId: string,
    readonly environment: string,
  ) {
    super(`Amadeus refused the credentials ${credId} (${environment}); calls answer 424 for 5 minutes`);
  }
}

/**
 * The cause of a failed token request (a timeout, a network error or an unexpected answer): its HTTP status (`null`
 * without an answer) and whether the client may send it once more (OADR-0001 point 7). Ids and codes only.
 */
export class AmadeusTokenRequestError extends Error {
  override readonly name = "AmadeusTokenRequestError";

  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** The associated data of a cached token: its Redis key, as a place (`redis.amadeus_token.access_token:<key>`). */
export function tokenAad(credId: string, environment: ResolvedAmadeusConnection["environment"]): string {
  return aadFor("redis", "amadeus_token", "access_token", redisKeys.amadeusToken(credId, environment).key);
}

interface CredentialKeys {
  readonly badCredentials: RedisKey;
  readonly token: RedisKey;
  readonly lock: RedisKey;
}

/** A token endpoint answer that carries a token. */
interface IssuedToken {
  readonly accessToken: string;
  readonly expiresIn: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAccessToken(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ACCESS_TOKEN_LENGTH && ACCESS_TOKEN.test(value);
}

/** The name of a thrown value (`TypeError`, `TimeoutError`), never its message. */
function errorName(error: unknown): string {
  return error instanceof Error || error instanceof DOMException ? error.name : typeof error;
}

/** The error code of a failed `fetch` (undici puts the socket error in `cause`). */
function networkCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === "string" ? cause.code : undefined;
}

/** True for a timeout of the request: the abort of `AbortSignal.timeout`, or a connection reset (flow §5). */
function isTimeout(error: unknown): boolean {
  const name = errorName(error);
  return name === "TimeoutError" || name === "AbortError" || networkCode(error) === "ECONNRESET";
}

@Injectable()
export class TokenProvider {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    @Inject(AMADEUS_FETCH) private readonly fetch: AmadeusFetch,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(TokenProvider.name);
  }

  /**
   * A valid access token for the connection's credential set (see the file header). Throws `424` for refused
   * credentials, `503 SERVICE_UNAVAILABLE` without Redis, and the supplier codes of a failed token request.
   */
  async getToken(connection: ResolvedAmadeusConnection): Promise<string> {
    const keys = this.keysOf(connection);
    const cached = await this.cached(connection, keys);
    if (cached !== undefined) {
      return cached;
    }
    const owner = randomBytes(16).toString("hex");
    for (let waited = 0; ; waited += TOKEN_POLL_INTERVAL_MS) {
      if (await this.acquire(keys.lock, owner)) {
        return this.refreshLocked(connection, keys, owner);
      }
      if (waited >= TOKEN_WAIT_MS) {
        // The holder is still at it after 2 s (a slow Amadeus, or a process that died with the lock): fetch alone.
        return this.refresh(connection, keys);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, TOKEN_POLL_INTERVAL_MS));
      const token = await this.cached(connection, keys);
      if (token !== undefined) {
        return token;
      }
    }
  }

  /**
   * Deletes the cached token of the connection's credential set when it is still `token` (an operation answered 401
   * with it), so the next `getToken` requests a new one. A newer token, stored meanwhile by another call, is kept.
   */
  async dropToken(connection: ResolvedAmadeusConnection, token: string): Promise<void> {
    const key = this.keysOf(connection).token;
    const stored = await this.command(() => this.redis.get(key.key));
    if (stored === null) {
      return;
    }
    const current = await this.decryptToken(connection, stored);
    if (current === undefined || current === token) {
      await this.command(() => this.redis.eval(DELETE_IF_UNCHANGED, 1, key.key, stored));
    }
  }

  private keysOf(connection: ResolvedAmadeusConnection): CredentialKeys {
    return {
      badCredentials: redisKeys.amadeusBadCredentials(connection.credId),
      token: redisKeys.amadeusToken(connection.credId, connection.environment),
      lock: redisKeys.amadeusTokenLock(connection.credId, connection.environment),
    };
  }

  /** The cached token, or `undefined`; 424 while the refused-credentials flag is set. */
  private async cached(
    connection: ResolvedAmadeusConnection,
    keys: CredentialKeys,
  ): Promise<string | undefined> {
    const [refused, stored] = await this.command(() =>
      this.redis.mget(keys.badCredentials.key, keys.token.key),
    );
    if (refused !== null && refused !== undefined) {
      throw this.refused(connection);
    }
    if (stored === null || stored === undefined) {
      return undefined;
    }
    const token = await this.decryptToken(connection, stored);
    if (token === undefined) {
      this.logger.warn(
        { credId: connection.credId, environment: connection.environment },
        "amadeus.token_unreadable",
      );
      await this.command(() => this.redis.eval(DELETE_IF_UNCHANGED, 1, keys.token.key, stored));
    }
    return token;
  }

  /** The token of a stored value, or `undefined` when it does not decrypt to a token. */
  private async decryptToken(
    connection: ResolvedAmadeusConnection,
    stored: string,
  ): Promise<string | undefined> {
    let plaintext: Buffer;
    try {
      plaintext = await decryptValue(Buffer.from(stored, "base64"), {
        aad: tokenAad(connection.credId, connection.environment),
        keys: this.keys,
      });
    } catch (error) {
      if (error instanceof DecryptionError) {
        return undefined;
      }
      throw error;
    }
    const token = plaintext.toString("utf8");
    plaintext.fill(0);
    return isAccessToken(token) ? token : undefined;
  }

  /** `SET lock owner NX EX 10`: true when this call now holds the lock. */
  private async acquire(lock: RedisKey, owner: string): Promise<boolean> {
    const result = await this.command(() => this.redis.set(lock.key, owner, "EX", lock.ttlSeconds, "NX"));
    return result === "OK";
  }

  /** Refreshes under the lock, after one more look at the cache, and gives the lock up whatever happens. */
  private async refreshLocked(
    connection: ResolvedAmadeusConnection,
    keys: CredentialKeys,
    owner: string,
  ): Promise<string> {
    try {
      return (await this.cached(connection, keys)) ?? (await this.refresh(connection, keys));
    } finally {
      // Only the owner deletes the lock; when Redis fails here, the lock expires after its 10 s.
      await this.redis.eval(DELETE_IF_UNCHANGED, 1, keys.lock.key, owner).catch(() => undefined);
    }
  }

  /** Requests a token, then stores it encrypted with its TTL. */
  private async refresh(connection: ResolvedAmadeusConnection, keys: CredentialKeys): Promise<string> {
    const issued = await this.requestToken(connection, keys);
    const { ciphertext } = await encryptValue(issued.accessToken, {
      aad: tokenAad(connection.credId, connection.environment),
      keys: this.keys,
    });
    const key = redisKeys.amadeusToken(connection.credId, connection.environment, issued.expiresIn);
    await this.command(() => this.redis.set(key.key, ciphertext.toString("base64"), "EX", key.ttlSeconds));
    return issued.accessToken;
  }

  /** One `client_credentials` request; see the file header for the answers and their errors. */
  private async requestToken(
    connection: ResolvedAmadeusConnection,
    keys: CredentialKeys,
  ): Promise<IssuedToken> {
    const secret = await decryptValue(Buffer.from(connection.encryptedSecret.ciphertext, "base64"), {
      aad: connection.encryptedSecret.aad,
      keys: this.keys,
    });
    let body: string;
    try {
      body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: connection.clientId,
        client_secret: secret.toString("utf8"),
      }).toString();
    } finally {
      secret.fill(0);
    }

    const started = performance.now();
    const log = (outcome: string, status: number | null): void => {
      this.logger.info(
        {
          credId: connection.credId,
          environment: connection.environment,
          amadeusApi: "Authorization",
          status,
          outcome,
          durationMs: Math.round(performance.now() - started),
        },
        "amadeus.token_request",
      );
    };

    let response: Response;
    let text: string;
    try {
      response = await this.fetch(`${connection.baseUrl}${OAUTH_TOKEN_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
      text = await response.text();
    } catch (error) {
      const timeout = isTimeout(error);
      log(timeout ? "timeout" : "network_error", null);
      // The cause keeps the error's name and code only: an undici error may quote the request.
      const cause = new AmadeusTokenRequestError(
        `token request failed: ${networkCode(error) ?? errorName(error)}`,
        null,
        true,
      );
      throw new AppError(timeout ? "SUPPLIER_TIMEOUT" : "SUPPLIER_UNAVAILABLE", { cause });
    }

    const json = parseJson(text);
    if (response.status === 401 || (response.status === 400 && json?.["error"] === "invalid_client")) {
      log("credentials_refused", response.status);
      await this.command(() =>
        this.redis.set(keys.badCredentials.key, BAD_CREDENTIALS_FLAG, "EX", keys.badCredentials.ttlSeconds),
      );
      // The ops alert of flow §3 (an e-mail) comes with the notifications outbox (M3); this line is its trigger.
      this.logger.error(
        { credId: connection.credId, environment: connection.environment, status: response.status },
        "amadeus.credentials_refused",
      );
      throw this.refused(connection);
    }
    if (response.status === 429 || response.status >= 500) {
      log("unavailable", response.status);
      throw new AppError("SUPPLIER_UNAVAILABLE", {
        cause: new AmadeusTokenRequestError(
          `token request: HTTP ${response.status}`,
          response.status,
          response.status >= 500,
        ),
      });
    }
    const accessToken = json?.["access_token"];
    const expiresIn = json?.["expires_in"];
    if (
      response.status !== 200 ||
      !isAccessToken(accessToken) ||
      typeof expiresIn !== "number" ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0
    ) {
      log("unexpected_answer", response.status);
      throw new AppError("SUPPLIER_ERROR", {
        cause: new AmadeusTokenRequestError(
          `token request: unexpected answer, HTTP ${response.status}`,
          response.status,
          false,
        ),
      });
    }
    log("ok", response.status);
    return { accessToken, expiresIn };
  }

  private refused(connection: ResolvedAmadeusConnection): AppError {
    return new AppError("SUPPLIER_NOT_CONFIGURED", {
      cause: new AmadeusCredentialsRefusedError(connection.credId, connection.environment),
    });
  }

  /** A Redis command; a Redis that cannot answer is `503 SERVICE_UNAVAILABLE` (flow §7). */
  private async command<T>(run: () => Promise<T>): Promise<T> {
    if (REDIS_DOWN.has(this.redis.status)) {
      throw new AppError("SERVICE_UNAVAILABLE");
    }
    try {
      return await run();
    } catch (error) {
      throw new AppError("SERVICE_UNAVAILABLE", { cause: error });
    }
  }
}

/** The JSON object of a body, or `undefined`. */
function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
