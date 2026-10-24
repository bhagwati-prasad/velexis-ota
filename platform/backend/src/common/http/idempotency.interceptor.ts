// Idempotent requests (PBE-009; platform/docs/architecture.md §3 step 10, conventions §2 "Idempotency", api-inventory
// §2 `Idem`). An operation marked `x-idempotent: true` in the platform document requires an `Idempotency-Key` header,
// and a retry with the same key gets the first answer again for 24 hours instead of a second side effect:
//
// 1. The record `vx:idem:<accountId>:<key>` (redis-keys.ts) holds the fingerprint of the first request (a SHA-256 of
//    the operation, its validated path and query parameters and its body, with object keys sorted) and its answer
//    (status, body, `ETag` and `Location`). Keys are per account, so two accounts never share one.
// 2. Same key and same fingerprint: the stored status and body are answered again, and the handler does not run.
//    Same key, another fingerprint: `409 IDEMPOTENCY_KEY_REUSED`.
// 3. No record yet: the request takes the lock `vx:idem:<accountId>:<key>:lock` (10 s TTL, a random token as its
//    value), runs the handler, stores a 2xx answer, and releases the lock. While the handler runs, the lock is renewed
//    every 3 s (`extendKeyIfValue`: its 10 s TTL again, only while it still holds this request's token), so a handler
//    that waits longer than 10 s on Stripe (createTenant and createCheckoutSession: a 10 s timeout and one retry per
//    call, FIX-W29-PLATFORM, PADR-0002 revision of 2026-10-24) keeps it to the end; the renewal stops when the answer
//    is stored. A lock that was lost all the same (Redis unreachable for a whole TTL) is logged
//    (`idempotency.lock_lost`) and not renewed again; the token check keeps a request from ever renewing or releasing
//    the lock of another one. A concurrent duplicate waits for the lock (polling, at most 10 s) and then answers the
//    stored record; if the first request failed (nothing stored), the duplicate runs itself. A lock still held after
//    the duplicate's 10 s answers `503 SERVICE_UNAVAILABLE` ("still being processed; try again shortly"): the handler
//    never runs twice at once.
// 4. Errors are not stored, so a retry after a failure runs again. Neither are answers with `Cache-Control: no-store`
//    (they carry a secret shown once, api-inventory §2).
// 5. Redis down before the handler runs answers `503 SERVICE_UNAVAILABLE`, before anything is written. A failure to
//    store the answer after the handler succeeded is logged (`idempotency.store_failed`) and the answer is sent.
//
// It runs after the validation interceptor (CommonModule registers it second), so the header and the body are
// already validated against the document, and after the guards, so the account is in the request context.
import { createHash, randomUUID } from "node:crypto";
import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { AppError } from "@velexis/errors";
import type { Redis } from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { defer, lastValueFrom, type Observable } from "rxjs";
import {
  IDEMPOTENCY_LOCK_TTL_SECONDS,
  deleteKeyIfValue,
  extendKeyIfValue,
  redisKeys,
  setKey,
  setKeyIfAbsent,
  type RedisKey,
} from "../redis/redis-keys";
import { REDIS_CLIENT } from "../redis/redis.module";
import { boundOperationId, validatedRequestOf, type ValidatedRequest } from "./openapi-operation.decorator";
import { PlatformOpenApi } from "./openapi-validation.interceptor";
import { RequestContext } from "./request-context";

/** The request header, lower case as Node delivers it. */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
/**
 * The longest a concurrent duplicate waits for the first request (10 s, the lock's TTL): then it answers `503
 * SERVICE_UNAVAILABLE` if the first one still runs.
 */
export const IDEMPOTENCY_WAIT_MS = IDEMPOTENCY_LOCK_TTL_SECONDS * 1000;
/**
 * How often the request that holds the lock renews it while its handler runs: a third of its TTL, so two renewals in a
 * row may fail or come late before the lock can expire under a running handler.
 */
export const IDEMPOTENCY_LOCK_RENEW_MS = 3_000;
/** How often a waiting duplicate looks for the stored answer. */
export const IDEMPOTENCY_POLL_MS = 50;
/** The response headers stored with the answer and set again on a replay. */
const REPLAYED_HEADERS = ["etag", "location"] as const;

/** The record of `vx:idem:<accountId>:<key>`. */
export interface IdempotencyRecord {
  readonly v: 1;
  /** The request fingerprint (`requestFingerprint`). */
  readonly fingerprint: string;
  readonly status: number;
  /** The JSON body as sent; `null` with `empty` when there was none. */
  readonly body: unknown;
  readonly empty: boolean;
  readonly headers: Readonly<Record<string, string>>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** `value` with the keys of every object sorted, so the same JSON in another key order has the same text. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

/**
 * The fingerprint of an idempotent request: SHA-256 (hex) of its operation and its validated path parameters, query
 * parameters and body. The same key with another fingerprint is another request (`409 IDEMPOTENCY_KEY_REUSED`).
 */
export function requestFingerprint(operationId: string, validated: ValidatedRequest): string {
  const text = JSON.stringify(
    canonical({
      operationId,
      path: validated.path,
      query: validated.query,
      body: validated.body ?? null,
    }),
  );
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The `operationId`s of the document's operations with `x-idempotent: true`. */
export function idempotentOperations(api: PlatformOpenApi): ReadonlySet<string> {
  const paths = isObject(api.document["paths"]) ? api.document["paths"] : {};
  const ids = new Set<string>();
  for (const operation of api.operations()) {
    const item = paths[operation.path];
    const definition = isObject(item) ? item[operation.method] : undefined;
    if (isObject(definition) && definition["x-idempotent"] === true) {
      ids.add(operation.operationId);
    }
  }
  return ids;
}

/** The parts of an Express request and response the interceptor uses. */
interface HttpRequest {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

interface HttpResponse {
  statusCode: number;
  status(code: number): unknown;
  getHeader(name: string): number | string | readonly string[] | undefined;
  setHeader(name: string, value: string): unknown;
}

/** The `IdempotencyKey` parameter of the platform document. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * `400 VALIDATION_FAILED` naming the header, without its value. The validation interceptor already answers it for an
 * operation that documents the parameter; this covers one that would not.
 */
function invalidKey(missing: boolean): AppError {
  return new AppError("VALIDATION_FAILED", {
    fieldErrors: [
      missing
        ? { path: "/header/Idempotency-Key", code: "required", message: "This parameter is required." }
        : {
            path: "/header/Idempotency-Key",
            code: "pattern",
            message: "Must be 16 to 128 letters, digits, _ or -.",
          },
    ],
  });
}

function storeUnavailable(cause: unknown): AppError {
  return new AppError("SERVICE_UNAVAILABLE", { cause });
}

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** True when the response says it must never be stored (`Cache-Control: no-store`). */
function isNoStore(res: HttpResponse): boolean {
  const value = res.getHeader("cache-control");
  const text = Array.isArray(value) ? value.join(",") : String(value ?? "");
  return /(?:^|,)\s*no-store\s*(?:,|$)/i.test(text);
}

/** The global idempotency interceptor (CommonModule); see the file header. */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly operations: ReadonlySet<string>;

  constructor(
    api: PlatformOpenApi,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly context: RequestContext,
    @InjectPinoLogger(IdempotencyInterceptor.name) private readonly logger: PinoLogger,
  ) {
    this.operations = idempotentOperations(api);
  }

  intercept(execution: ExecutionContext, next: CallHandler): Observable<unknown> {
    const operationId = execution.getType() === "http" ? boundOperationId(execution.getHandler()) : undefined;
    if (operationId === undefined || !this.operations.has(operationId)) {
      return next.handle();
    }
    const http = execution.switchToHttp();
    return defer(() =>
      this.run(operationId, http.getRequest<HttpRequest>(), http.getResponse<HttpResponse>(), next),
    );
  }

  private async run(
    operationId: string,
    req: HttpRequest,
    res: HttpResponse,
    next: CallHandler,
  ): Promise<unknown> {
    const header = req.headers[IDEMPOTENCY_KEY_HEADER];
    const idempotencyKey = Array.isArray(header) ? undefined : (header as string | undefined);
    if (idempotencyKey === undefined || idempotencyKey === "") {
      throw invalidKey(true);
    }
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw invalidKey(false);
    }
    const accountId = this.context.actor?.accountId;
    if (accountId === undefined) {
      // x-idempotent operations are authenticated: the auth guard has set the account before this runs.
      throw new Error(`${operationId} is idempotent but the request has no authenticated account`);
    }
    const fingerprint = requestFingerprint(operationId, validatedRequestOf(req));
    const record = redisKeys.idempotency(accountId, idempotencyKey);
    const lock = redisKeys.idempotencyLock(accountId, idempotencyKey);
    const deadline = Date.now() + IDEMPOTENCY_WAIT_MS;

    for (;;) {
      const stored = await this.read(record);
      if (stored !== undefined) {
        return this.replay(stored, fingerprint, res);
      }
      const token = randomUUID();
      if (await this.lock(lock, token)) {
        const renewal = this.keepLocked(operationId, lock, token);
        try {
          // A duplicate may have stored its answer between the read above and the lock.
          const raced = await this.read(record);
          if (raced !== undefined) {
            return this.replay(raced, fingerprint, res);
          }
          const body = await lastValueFrom(next.handle(), { defaultValue: undefined });
          await this.store(record, fingerprint, res, body);
          return body;
        } finally {
          renewal.stop();
          await this.unlock(lock, token);
        }
      }
      if (Date.now() >= deadline) {
        throw new AppError("SERVICE_UNAVAILABLE", {
          message: "A request with this Idempotency-Key is still being processed; try again shortly.",
        });
      }
      await sleep(IDEMPOTENCY_POLL_MS);
    }
  }

  private async read(key: RedisKey): Promise<IdempotencyRecord | undefined> {
    let text: string | null;
    try {
      text = await this.redis.get(key.key);
    } catch (error) {
      throw storeUnavailable(error);
    }
    return text === null ? undefined : (JSON.parse(text) as IdempotencyRecord);
  }

  private async lock(key: RedisKey, token: string): Promise<boolean> {
    try {
      return await setKeyIfAbsent(this.redis, key, token);
    } catch (error) {
      throw storeUnavailable(error);
    }
  }

  /**
   * Renews the lock `key` of the request that holds it with `token`, every IDEMPOTENCY_LOCK_RENEW_MS until `stop()`
   * (file header, item 3). A renewal that finds the lock gone or held by another request logs
   * `idempotency.lock_lost` and ends the renewals; a Redis error is logged (`idempotency.lock_renew_failed`) and the
   * next renewal tries again, the lock lasting its TTL from the last renewal that worked. One renewal at a time: the
   * next is scheduled when the previous one has answered.
   */
  private keepLocked(operationId: string, key: RedisKey, token: string): { stop(): void } {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const renew = async (): Promise<void> => {
      let held = true;
      try {
        held = await extendKeyIfValue(this.redis, key, token);
      } catch (error) {
        this.logger.warn({ err: error, operationId }, "idempotency.lock_renew_failed");
      }
      if (stopped) {
        return;
      }
      if (!held) {
        this.logger.warn({ operationId }, "idempotency.lock_lost");
        return;
      }
      schedule();
    };
    const schedule = (): void => {
      timer = setTimeout(() => void renew(), IDEMPOTENCY_LOCK_RENEW_MS);
      // A request in flight keeps the process up, not its renewal timer.
      timer.unref();
    };
    schedule();
    return {
      stop: () => {
        stopped = true;
        clearTimeout(timer);
      },
    };
  }

  private async unlock(key: RedisKey, token: string): Promise<void> {
    try {
      await deleteKeyIfValue(this.redis, key, token);
    } catch (error) {
      // The lock expires on its own 10 s after its last renewal.
      this.logger.warn({ err: error }, "idempotency.unlock_failed");
    }
  }

  /** Stores a 2xx answer that may be stored; a failure is logged, the answer is sent anyway. */
  private async store(key: RedisKey, fingerprint: string, res: HttpResponse, body: unknown): Promise<void> {
    if (res.statusCode < 200 || res.statusCode > 299 || isNoStore(res)) {
      return;
    }
    const headers: Record<string, string> = {};
    for (const name of REPLAYED_HEADERS) {
      const value = res.getHeader(name);
      if (value !== undefined) {
        headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
      }
    }
    const entry: IdempotencyRecord = {
      v: 1,
      fingerprint,
      status: res.statusCode,
      // The JSON the client receives (dates as strings), so a replay is byte for byte the same body.
      body: body === undefined ? null : (JSON.parse(JSON.stringify(body)) as unknown),
      empty: body === undefined,
      headers,
    };
    try {
      await setKey(this.redis, key, JSON.stringify(entry));
    } catch (error) {
      this.logger.warn({ err: error }, "idempotency.store_failed");
    }
  }

  private replay(stored: IdempotencyRecord, fingerprint: string, res: HttpResponse): unknown {
    if (stored.fingerprint !== fingerprint) {
      throw new AppError("IDEMPOTENCY_KEY_REUSED");
    }
    // Nest answers with the status the response already has (the handler's @HttpCode otherwise).
    res.status(stored.status);
    for (const [name, value] of Object.entries(stored.headers)) {
      res.setHeader(name, value);
    }
    return stored.empty ? undefined : stored.body;
  }
}
