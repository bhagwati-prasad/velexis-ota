// Idempotent requests of the OTA API (OBE-014; ota/docs/architecture-booking.md §5, conventions §2 "Idempotency",
// db README §8). The global `IdempotencyInterceptor` (idempotency.interceptor.ts) wraps every operation whose
// `Idempotency-Key` header parameter the document marks required; this service holds the rules, and
// `IdempotencyRepository` the records (`idempotency_keys` of the tenant schema, through `TenantTx`).
//
// 1. Scope: `<environment>:<principal>:<operationId>`. The principal is the actor of the request (`cus_…`, `stf_…`,
//    `key_…`), or `edge-<first 16 hex of sha256(__Host-vx_csrf)>` for a storefront visitor without a session.
// 2. Claim, in a short transaction of its own: insert the record `processing` with the request hash (SHA-256 of the
//    canonical `{operationId, path, query, body}`, or of what the operation's `hashInput` hook makes of it) and a lease
//    (`locked_until`, 2 minutes). The hash is unkeyed, so it never covers a value that is guessable from it: card and
//    identity document data count as the shared redactor keeps them (numbers by their last 4, security codes, birth
//    place and issuance location left out; OADR-0004, PCI DSS 3.5.1), and a request whose hashed input still carries a
//    password is refused before anything is hashed or stored (its operation needs a `hashInput` hook that leaves the
//    password out). Tokens stay in the hash: they are random, and leaving them out would let the key alone replay an
//    answer with a session. When the key was seen:
//    - another hash → `409 IDEMPOTENCY_KEY_REUSED`;
//    - `completed` or `failed` → the stored answer is replayed (through the operation's `resolveReplay` hook);
//    - `processing` → the request waits (polling, up to 60 s) and then replays, or answers `409 CONFLICT`; a record
//      whose lease ran out (its process died) is taken over by the waiting request;
//    - a record past its 24 h retention is gone: the key starts afresh.
// 3. Outcome, in another short transaction: 2xx (`completed`) and final 4xx (`failed`) answers are stored for 24 h,
//    and so is a `504` that the operation's `resourceOf` hook links to a resource (a booking being reconciled). The
//    other answers are transient and delete the record, so the same key can be sent again: `429`, `503`,
//    `502 PAYMENT_PROVIDER_ERROR` (nothing was charged) and every other 5xx.
// 4. Storage: `response_body` always holds the copy after the shared redactor of @velexis/logger. When the answer
//    carries a token, a cookie or unmasked data (the redactor changes it, or it sets a cookie), the verbatim answer
//    (body and `Set-Cookie`) is also stored envelope-encrypted in `response_ciphertext` (ADR-0010, associated data
//    `tenant_<key>.idempotency_keys.response_ciphertext:<idk_…>`) and replays come from there; the plain columns never
//    hold a token.
//
// Per-operation hooks come from providers decorated with `@IdempotencyHooksFor([...operationIds])`, found when the
// module starts: `hashInput` (OBE-051 hashes the airline card as `{brand, last4}`), `resourceOf` and `resolveReplay`
// (OBE-043: `CompleteCheckoutIdempotencyHooks` of bookings/booking-orchestrator.service.ts links a stored `504
// SUPPLIER_TIMEOUT` of checkout.complete to its pending booking and answers its replays from the booking: the same
// `504`, `details.replayed: true`, while the booking is pending, then the final `201` or the final error).
import { createHash } from "node:crypto";
import { Inject, Injectable, type FactoryProvider, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DiscoveryService } from "@nestjs/core";
import type { OtaOperationId } from "@velexis/api-types/operations";
import { aadFor, decryptValue, encryptValue, LocalFileKeyProvider, type KeyProvider } from "@velexis/crypto";
import type { TenantSchema } from "@velexis/db";
import { AppError } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import { PinoLogger } from "nestjs-pino";
import type { ApiConfig } from "../../config";
import { TenantContext, type RequestTenant } from "../../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../../tenancy/tenant-tx";
import { Clock } from "../clock";
import { IdGenerator } from "../ids";
import {
  IdempotencyRepository,
  type IdempotencyFinalStatus,
  type IdempotencyOutcome,
  type IdempotencyRow,
} from "./idempotency.repository";
import { OpenApiDocument } from "./openapi-validation.interceptor";

/** How long a stored answer is replayed, and how long a record in flight is kept at most. */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
/** How long a request waits for another one with the same key before it answers `409 CONFLICT`. */
export const IDEMPOTENCY_WAIT_MS = 60_000;
/**
 * The lease of a request in flight: longer than the longest handler (checkout.complete gives Amadeus 60 s), so only
 * a record whose process died is taken over.
 */
export const IDEMPOTENCY_LEASE_MS = 120_000;
/** The first pause of a waiting request; it doubles up to `IDEMPOTENCY_MAX_POLL_MS`. */
export const IDEMPOTENCY_POLL_MS = 100;
export const IDEMPOTENCY_MAX_POLL_MS = 1_000;

/** The cookie whose hash is the principal of a storefront visitor without a session (OADR-0006). */
export const EDGE_PRINCIPAL_COOKIE = "__Host-vx_csrf";

/** Injection token of the KEKs that encrypt `response_ciphertext` (MASTER_KEY_DIR, MASTER_KEY_CURRENT). */
export const IDEMPOTENCY_KEY_PROVIDER = "IDEMPOTENCY_KEY_PROVIDER";

/**
 * The KEKs of MASTER_KEY_DIR, MASTER_KEY_CURRENT wrapping new data keys (ADR-0010, ADR-0026). Nest awaits the
 * factory, so the API does not start without them (a missing current key, or a key file that group or others may
 * read, is a `KeyProviderError` naming the file, never its content).
 */
export const idempotencyKeyProvider: FactoryProvider<Promise<KeyProvider>> = {
  provide: IDEMPOTENCY_KEY_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<ApiConfig, true>) =>
    LocalFileKeyProvider.fromDir(
      config.get("MASTER_KEY_DIR", { infer: true }),
      config.get("MASTER_KEY_CURRENT", { infer: true }),
    ),
};

/** The validated request parts the hash covers: path and query parameters (coerced) and the parsed body. */
export interface IdempotentInput {
  readonly path: Readonly<Record<string, unknown>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly body: unknown;
}

/** An answer as the interceptor captures it and replays it. */
export interface IdempotencyResponse {
  readonly status: number;
  /** The replayed headers by lower-case name (`location`, `etag`, `cache-control`, `retry-after`). */
  readonly headers: Readonly<Record<string, string>>;
  /** `Set-Cookie` values: kept only in the ciphertext. */
  readonly setCookie: readonly string[];
  /** The body as the handler returned it or as JSON from a replay; `undefined` for an answer without one. */
  readonly body: unknown;
}

/** The resource an answer created or changed (`resource_type`, `resource_id`). */
export interface IdempotencyResource {
  /** `booking`, `checkout`, … */
  readonly type: string;
  /** `bkg_…`, `chk_…`, … */
  readonly id: string;
}

/** A stored outcome, as a `resolveReplay` hook gets it: the answer is the verbatim one (decrypted when encrypted). */
export interface IdempotencyRecord {
  /** `idk_…` */
  readonly id: string;
  readonly operationId: OtaOperationId;
  readonly scope: string;
  readonly status: IdempotencyFinalStatus;
  readonly response: IdempotencyResponse;
  readonly resource: IdempotencyResource | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date;
}

/**
 * Per-operation hooks, implemented by a provider decorated with `@IdempotencyHooksFor([...])`. Each hook of an
 * operation comes from at most one provider.
 */
export interface IdempotencyHooks {
  /**
   * What the request hash covers instead of the validated input: OBE-051 replaces the airline card by
   * `{brand, last4}`, so no hash of a card number is ever stored.
   */
  hashInput?(input: IdempotentInput): unknown;
  /**
   * The resource an answer is about (a `504 SUPPLIER_TIMEOUT` names its pending booking): stored with the outcome,
   * and a `504` with a resource is kept instead of being treated as transient.
   */
  resourceOf?(response: IdempotencyResponse): IdempotencyResource | undefined;
  /**
   * The answer a replay sends for a stored record; `undefined` replays the stored answer. checkout.complete's hook
   * (OBE-043) answers the same `504` while the linked booking is undecided, then the final `201` built from the booking
   * or the final error. It runs in the replaying request's context (its tenant, `TenantTx`), never in a transaction of
   * the service's.
   */
  resolveReplay?(record: IdempotencyRecord): Promise<IdempotencyResponse | undefined>;
}

/**
 * Marks a provider as the idempotency hooks of operations: `@IdempotencyHooksFor(["completeCheckout"])` on an
 * `@Injectable()` class that implements `IdempotencyHooks`, listed once in its module's providers.
 */
export const IdempotencyHooksFor = DiscoveryService.createDecorator<readonly OtaOperationId[]>();

/** One idempotent request, as the interceptor sees it after validation. */
export interface IdempotentRequest {
  readonly operationId: OtaOperationId;
  /** The `Idempotency-Key` header. */
  readonly key: string;
  readonly method: string;
  /** The request path, without the query string. */
  readonly path: string;
  readonly input: IdempotentInput;
  /** The `__Host-vx_csrf` cookie, when the request has one. */
  readonly csrfCookie: string | undefined;
}

/** The request holds the record `id` with the lease `lease`; its outcome is settled with them. */
export interface IdempotencyTicket {
  readonly id: string;
  readonly operationId: OtaOperationId;
  readonly schemaName: TenantSchema;
  readonly lease: Date;
}

/** What a request does after the claim: run the handler, or send a stored answer. */
export type IdempotencyClaim =
  | { readonly kind: "execute"; readonly ticket: IdempotencyTicket }
  | { readonly kind: "replay"; readonly response: IdempotencyResponse };

/** Whether an outcome is kept for replays or deleted, so the same key may be sent again. */
export type IdempotencyDisposition = "store" | "release";

/** The hooks of one operation, merged from the providers that give them. */
interface RegisteredHooks {
  readonly hashInput: ((input: IdempotentInput) => unknown) | undefined;
  readonly resourceOf: ((response: IdempotencyResponse) => IdempotencyResource | undefined) | undefined;
  readonly resolveReplay:
    ((record: IdempotencyRecord) => Promise<IdempotencyResponse | undefined>) | undefined;
}

const NO_HOOKS: RegisteredHooks = Object.freeze({
  hashInput: undefined,
  resourceOf: undefined,
  resolveReplay: undefined,
});

/** The verbatim answer in `response_ciphertext` (JSON, version 1). */
interface SealedAnswer {
  readonly v: 1;
  readonly empty: boolean;
  readonly body: unknown;
  readonly setCookie: readonly string[];
}

type ClaimAttempt =
  | { readonly kind: "claimed"; readonly id: string; readonly lease: Date }
  | { readonly kind: "stored"; readonly row: IdempotencyRow }
  | { readonly kind: "reused" }
  | { readonly kind: "busy" }
  | { readonly kind: "vanished" };

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

/** The operations whose `Idempotency-Key` header parameter is required, from the document. */
export function idempotentOperations(document: OpenApiDocument): ReadonlySet<string> {
  return new Set(
    document
      .operationList()
      .filter((operation) =>
        operation.parameters.some(
          (parameter) =>
            parameter.in === "header" &&
            parameter.required &&
            parameter.name.toLowerCase() === "idempotency-key",
        ),
      )
      .map((operation) => operation.operationId),
  );
}

/**
 * The principal of a request: its actor (`cus_…`, `stf_…`, `key_…`), or for a storefront visitor without a session
 * `edge-` and the first 16 hex characters of the SHA-256 of their `__Host-vx_csrf` cookie. An edge request without
 * the cookie is `403 CSRF_TOKEN_INVALID`, as the CSRF guard answers it. The OTA admin's service caller before a staff
 * member is known (console.auth.signIn and refresh, OBE-060) is `service`: its keys are the admin's random UUIDs, and
 * the request hash holds the portal or refresh token, so no two staff members' calls ever replay each other.
 */
export function idempotencyPrincipal(
  tenant: Pick<RequestTenant, "caller" | "actor">,
  csrfCookie: string | undefined,
): string {
  if (tenant.actor.id !== null) {
    return tenant.actor.id;
  }
  if (tenant.caller.type === "edge") {
    if (csrfCookie === undefined || csrfCookie === "") {
      throw new AppError("CSRF_TOKEN_INVALID", { details: { reason: "token_missing" } });
    }
    return `edge-${createHash("sha256").update(csrfCookie, "utf8").digest("hex").slice(0, 16)}`;
  }
  if (tenant.caller.type === "service") {
    return "service";
  }
  throw new Error(`An idempotent request of a ${tenant.caller.type} caller has no principal`);
}

/** The scope of a record: `<environment>:<principal>:<operationId>`. */
export function idempotencyScope(environment: string, principal: string, operationId: string): string {
  return `${environment}:${principal}:${operationId}`;
}

/** SHA-256 (hex) of the canonical JSON of `{operationId, request}`: the same request in another key order hashes alike. */
export function requestHash(operationId: string, request: unknown): string {
  const text = JSON.stringify(canonical({ operationId, request: request ?? null }));
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Keys compared as the shared redactor compares them (redact-payload.ts of @velexis/logger): lower case, no `-`, `_`. */
const normaliseKey = (key: string): string => key.toLowerCase().replace(/[-_]/g, "");

/**
 * The keys whose value is card or identity document data, as the shared redactor treats them: the parents whose
 * `number` it masks (`card`, Amadeus `creditCard` and `virtualCreditCardDetails`, `documents`, and an Amadeus order's
 * `formOfIdentifications`, FIX-W26-SECURITY), the numbers it masks wherever they are (`pan`, `cardNumber`,
 * `certificateNumber`), and the fields it drops (security codes, birth place, issuance location). Their values are
 * hashed as the redactor keeps them.
 */
const MASKED_FOR_HASH = new Set([
  "card",
  "creditcard",
  "paymentcard",
  "virtualcreditcarddetails",
  "documents",
  "document",
  "formofidentifications",
  "pan",
  "primaryaccountnumber",
  "cardnumber",
  "certificatenumber",
  "securitycode",
  "cvc",
  "cvv",
  "cvv2",
  "birthplace",
  "issuancelocation",
]);

/** A password has no safe unkeyed hash (the redactor's `password` and `passphrase` key fragments). */
const isPasswordKey = (normalised: string): boolean =>
  normalised.includes("password") || normalised.includes("passphrase");

/** Thrown, before anything is hashed or stored, for a hashed input that carries a password. */
export class UnhashableIdempotentInputError extends Error {
  override readonly name = "UnhashableIdempotentInputError";

  constructor(operationId: string) {
    super(
      `${operationId}: the idempotency request hash would cover a password; the operation needs a hashInput hook ` +
        "(@IdempotencyHooksFor) that leaves it out",
    );
  }
}

/**
 * What the request hash covers of `material` (the validated input, or the output of the operation's `hashInput`
 * hook): a copy in which card and identity document data are what the shared redactor keeps of them, so no hash of a
 * card or document number is ever stored. A password anywhere in it is `UnhashableIdempotentInputError`.
 */
export function hashMaterialOf(operationId: string, material: unknown): unknown {
  if (Array.isArray(material)) {
    return material.map((item) => hashMaterialOf(operationId, item));
  }
  if (!isObject(material)) {
    return material;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(material)) {
    const normalised = normaliseKey(key);
    if (isPasswordKey(normalised)) {
      throw new UnhashableIdempotentInputError(operationId);
    }
    // defineProperty keeps a `__proto__` key of parsed JSON as data, as the redactor does.
    const define = (kept: unknown): void => {
      Object.defineProperty(copy, key, { value: kept, enumerable: true, writable: true, configurable: true });
    };
    if (MASKED_FOR_HASH.has(normalised)) {
      const redacted: Record<string, unknown> = redactPayload({ [key]: value });
      if (Object.hasOwn(redacted, key)) {
        define(redacted[key]);
      }
    } else {
      define(hashMaterialOf(operationId, value));
    }
  }
  return copy;
}

/**
 * Whether an outcome is stored or released: answers below 400 and final 4xx are stored; `429` and the 5xx answers are
 * transient, except a `504` linked to a resource (a booking that the reconciliation job decides later).
 */
export function outcomeDisposition(status: number, linkedToResource: boolean): IdempotencyDisposition {
  if (status < 400) {
    return "store";
  }
  if (status === 429) {
    return "release";
  }
  if (status < 500) {
    return "store";
  }
  return status === 504 && linkedToResource ? "store" : "release";
}

/** The JSON a client receives for `body` (dates as strings), or `undefined` when nothing is sent. */
function toJson(body: unknown): unknown {
  if (body === undefined || body === null) {
    return undefined;
  }
  const text = JSON.stringify(body);
  return text === undefined ? undefined : (JSON.parse(text) as unknown);
}

/**
 * The plain copy of an answer for `response_body` (the shared redactor's, `null` without a body), and whether the
 * answer must also be kept encrypted: it sets a cookie, or the redactor changed something (a token, a document or
 * card number, a secret).
 */
export function plainCopyOf(response: IdempotencyResponse): {
  readonly body: unknown;
  readonly sensitive: boolean;
} {
  const json = toJson(response.body);
  const cookies = response.setCookie.length > 0;
  if (json === undefined) {
    return { body: null, sensitive: cookies };
  }
  const redacted = redactPayload(json);
  return { body: redacted, sensitive: cookies || JSON.stringify(redacted) !== JSON.stringify(json) };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });

@Injectable()
export class IdempotencyService implements OnModuleInit {
  private readonly operations: ReadonlySet<string>;
  private readonly hooks = new Map<string, RegisteredHooks>();

  constructor(
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly records: IdempotencyRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    @Inject(IDEMPOTENCY_KEY_PROVIDER) private readonly keys: KeyProvider,
    document: OpenApiDocument,
    private readonly discovery: DiscoveryService,
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(IdempotencyService.name);
    this.operations = idempotentOperations(document);
  }

  /** Registers the hooks of every provider decorated with `@IdempotencyHooksFor`. */
  onModuleInit(): void {
    for (const wrapper of this.discovery.getProviders({ metadataKey: IdempotencyHooksFor.KEY })) {
      const operationIds = this.discovery.getMetadataByDecorator(IdempotencyHooksFor, wrapper);
      const instance: unknown = wrapper.instance;
      if (!wrapper.isDependencyTreeStatic() || !isObject(instance) || !Array.isArray(operationIds)) {
        throw new Error(
          `${String(wrapper.name)}: idempotency hooks must be a singleton provider with operation ids`,
        );
      }
      this.register(operationIds, instance);
    }
  }

  /** True when `operationId` requires `Idempotency-Key` (the interceptor applies to it). */
  isIdempotent(operationId: string): boolean {
    return this.operations.has(operationId);
  }

  /** True when the current request has a tenant, whose schema holds its record. */
  hasTenant(): boolean {
    return this.tenants.get() !== undefined;
  }

  /** Adds hooks for operations; an operation that is not idempotent, or a hook given twice, fails the start-up. */
  register(operationIds: readonly string[], hooks: IdempotencyHooks): void {
    for (const operationId of operationIds) {
      if (!this.isIdempotent(operationId)) {
        throw new Error(`Idempotency hooks for ${operationId}, which does not require Idempotency-Key`);
      }
      const current = this.hooks.get(operationId) ?? NO_HOOKS;
      for (const name of ["hashInput", "resourceOf", "resolveReplay"] as const) {
        if (typeof hooks[name] === "function" && current[name] !== undefined) {
          throw new Error(`Two idempotency ${name} hooks for ${operationId}`);
        }
      }
      this.hooks.set(operationId, {
        hashInput: current.hashInput ?? hooks.hashInput?.bind(hooks),
        resourceOf: current.resourceOf ?? hooks.resourceOf?.bind(hooks),
        resolveReplay: current.resolveReplay ?? hooks.resolveReplay?.bind(hooks),
      });
    }
  }

  /**
   * The request hash of `input` for `operationId`: of what the operation's `hashInput` hook makes of it, with card and
   * document data masked (`hashMaterialOf`). Throws `UnhashableIdempotentInputError` for a password.
   */
  hashOf(operationId: string, input: IdempotentInput): string {
    const hashInput = this.hooks.get(operationId)?.hashInput;
    const material = hashInput === undefined ? input : hashInput(input);
    return requestHash(operationId, hashMaterialOf(operationId, material));
  }

  /**
   * Claims the key of `request` for this request, or finds the answer to replay. Throws `409 IDEMPOTENCY_KEY_REUSED`
   * for the key of another request, and `409 CONFLICT` when a request with the key is still running after 60 s.
   */
  async claim(request: IdempotentRequest): Promise<IdempotencyClaim> {
    const tenant = this.tenants.require();
    const scope = idempotencyScope(
      tenant.environment,
      idempotencyPrincipal(tenant, request.csrfCookie),
      request.operationId,
    );
    const hash = this.hashOf(request.operationId, request.input);
    const deadline = this.clock.now().getTime() + IDEMPOTENCY_WAIT_MS;
    let pause = IDEMPOTENCY_POLL_MS;
    for (;;) {
      const attempt = await this.tx.run((trx) => this.attempt(trx, request, scope, hash));
      switch (attempt.kind) {
        case "claimed":
          return {
            kind: "execute",
            ticket: {
              id: attempt.id,
              operationId: request.operationId,
              schemaName: tenant.schemaName,
              lease: attempt.lease,
            },
          };
        case "stored":
          return {
            kind: "replay",
            response: await this.replay(attempt.row, request.operationId, tenant.schemaName),
          };
        case "reused":
          throw new AppError("IDEMPOTENCY_KEY_REUSED");
        case "busy":
        case "vanished": {
          const remaining = deadline - this.clock.now().getTime();
          if (remaining <= 0) {
            this.logger.info({ operationId: request.operationId }, "idempotency.still_processing");
            throw new AppError("CONFLICT", {
              message:
                "A request with this Idempotency-Key is still being processed; retry in a few seconds.",
              details: { reason: "idempotency_key_in_use" },
            });
          }
          if (attempt.kind === "busy") {
            await sleep(Math.min(pause, remaining));
            pause = Math.min(pause * 2, IDEMPOTENCY_MAX_POLL_MS);
          }
        }
      }
    }
  }

  /**
   * Stores or releases the outcome of the request that holds `ticket` (`outcomeDisposition`). A failure is logged,
   * never thrown: the answer is sent either way, and the record in flight is taken over when its lease runs out.
   */
  async settle(ticket: IdempotencyTicket, response: IdempotencyResponse): Promise<void> {
    try {
      const resource = this.hooks.get(ticket.operationId)?.resourceOf?.(response) ?? null;
      if (outcomeDisposition(response.status, resource !== null) === "release") {
        await this.releaseRecord(ticket);
        return;
      }
      const outcome = await this.outcomeOf(ticket, response, resource);
      const stored = await this.tx.run((trx) => this.records.complete(trx, ticket.id, ticket.lease, outcome));
      if (!stored) {
        this.logger.warn({ operationId: ticket.operationId }, "idempotency.lease_lost");
      }
    } catch (error) {
      this.logger.error({ err: error, operationId: ticket.operationId }, "idempotency.settle_failed");
    }
  }

  /** Deletes the record in flight of `ticket` (an answer that cannot be stored); failures are logged, never thrown. */
  async release(ticket: IdempotencyTicket): Promise<void> {
    try {
      await this.releaseRecord(ticket);
    } catch (error) {
      this.logger.error({ err: error, operationId: ticket.operationId }, "idempotency.settle_failed");
    }
  }

  private async releaseRecord(ticket: IdempotencyTicket): Promise<void> {
    const released = await this.tx.run((trx) => this.records.release(trx, ticket.id, ticket.lease));
    if (!released) {
      this.logger.warn({ operationId: ticket.operationId }, "idempotency.lease_lost");
    }
  }

  /** One claim attempt, in its own transaction. */
  private async attempt(
    trx: TenantTransaction,
    request: IdempotentRequest,
    scope: string,
    hash: string,
  ): Promise<ClaimAttempt> {
    const now = this.clock.now();
    const lease = new Date(now.getTime() + IDEMPOTENCY_LEASE_MS);
    const insert = async (): Promise<ClaimAttempt | undefined> => {
      const id = this.ids.newId("idk");
      const inserted = await this.records.insertProcessing(trx, {
        id,
        scope,
        key: request.key,
        requestMethod: request.method,
        requestPath: request.path,
        requestHash: hash,
        lockedUntil: lease,
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_RETENTION_MS),
        now,
      });
      return inserted ? { kind: "claimed", id, lease } : undefined;
    };
    const claimed = await insert();
    if (claimed !== undefined) {
      return claimed;
    }
    const existing = await this.records.lockByScopeAndKey(trx, scope, request.key);
    if (existing === undefined) {
      // Released between the insert and the read: the next attempt inserts it.
      return { kind: "vanished" };
    }
    if (existing.expires_at.getTime() <= now.getTime()) {
      // Past its retention (the daily purge has not run yet): the key starts afresh.
      await this.records.deleteExpired(trx, existing.id, now);
      return (await insert()) ?? { kind: "vanished" };
    }
    if (existing.request_hash !== hash) {
      return { kind: "reused" };
    }
    if (existing.status === "processing") {
      if (existing.locked_until !== null && existing.locked_until.getTime() > now.getTime()) {
        return { kind: "busy" };
      }
      // The request that held it is gone (its process died): this one runs it.
      await this.records.renewLease(trx, existing.id, lease, now);
      this.logger.warn({ operationId: request.operationId }, "idempotency.lease_taken_over");
      return { kind: "claimed", id: existing.id, lease };
    }
    return { kind: "stored", row: existing };
  }

  /** The answer a replay sends for a stored row. */
  private async replay(
    row: IdempotencyRow,
    operationId: OtaOperationId,
    schemaName: TenantSchema,
  ): Promise<IdempotencyResponse> {
    const record = await this.recordOf(row, operationId, schemaName);
    const resolveReplay = this.hooks.get(operationId)?.resolveReplay;
    const response =
      (resolveReplay === undefined ? undefined : await resolveReplay(record)) ?? record.response;
    this.logger.info(
      { operationId, status: response.status, encrypted: row.response_ciphertext !== null },
      "idempotency.replayed",
    );
    return response;
  }

  private async recordOf(
    row: IdempotencyRow,
    operationId: OtaOperationId,
    schemaName: TenantSchema,
  ): Promise<IdempotencyRecord> {
    if ((row.status !== "completed" && row.status !== "failed") || row.response_status === null) {
      throw new Error(`The idempotency record ${row.id} has no stored outcome`);
    }
    const headers: Record<string, string> = {};
    if (isObject(row.response_headers)) {
      for (const [name, value] of Object.entries(row.response_headers)) {
        if (typeof value === "string") {
          headers[name] = value;
        }
      }
    }
    const sealed =
      row.response_ciphertext === null
        ? undefined
        : await this.unseal(row.response_ciphertext, schemaName, row.id);
    return {
      id: row.id,
      operationId,
      scope: row.scope,
      status: row.status,
      response: {
        status: row.response_status,
        headers,
        setCookie: sealed?.setCookie ?? [],
        body:
          sealed === undefined ? (row.response_body ?? undefined) : sealed.empty ? undefined : sealed.body,
      },
      resource:
        row.resource_type === null || row.resource_id === null
          ? null
          : { type: row.resource_type, id: row.resource_id },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  }

  /** The row of a stored outcome; the verbatim answer is encrypted when `plainCopyOf` calls it sensitive. */
  private async outcomeOf(
    ticket: IdempotencyTicket,
    response: IdempotencyResponse,
    resource: IdempotencyResource | null,
  ): Promise<IdempotencyOutcome> {
    const now = this.clock.now();
    const plain = plainCopyOf(response);
    let sealed: { ciphertext: Buffer; kekId: string } | undefined;
    if (plain.sensitive) {
      const json = toJson(response.body);
      const answer: SealedAnswer = {
        v: 1,
        empty: json === undefined,
        body: json ?? null,
        setCookie: [...response.setCookie],
      };
      sealed = await encryptValue(JSON.stringify(answer), {
        aad: this.associatedData(ticket.schemaName, ticket.id),
        keys: this.keys,
      });
    }
    return {
      status: response.status < 400 ? "completed" : "failed",
      responseStatus: response.status,
      responseHeaders: Object.keys(response.headers).length > 0 ? response.headers : null,
      responseBody: plain.body,
      responseCiphertext: sealed?.ciphertext ?? null,
      encryptionKeyId: sealed?.kekId ?? null,
      resourceType: resource?.type ?? null,
      resourceId: resource?.id ?? null,
      expiresAt: new Date(now.getTime() + IDEMPOTENCY_RETENTION_MS),
      now,
    };
  }

  /** Decrypts the verbatim answer of the record `id`; the plaintext bytes are zeroed. */
  private async unseal(ciphertext: Buffer, schemaName: TenantSchema, id: string): Promise<SealedAnswer> {
    const plaintext = await decryptValue(ciphertext, {
      aad: this.associatedData(schemaName, id),
      keys: this.keys,
    });
    try {
      const answer: unknown = JSON.parse(plaintext.toString("utf8"));
      if (
        !isObject(answer) ||
        answer["v"] !== 1 ||
        typeof answer["empty"] !== "boolean" ||
        !Array.isArray(answer["setCookie"]) ||
        !answer["setCookie"].every((cookie) => typeof cookie === "string")
      ) {
        throw new Error(`The sealed answer of the idempotency record ${id} is not of version 1`);
      }
      return answer as unknown as SealedAnswer;
    } finally {
      plaintext.fill(0);
    }
  }

  /** `tenant_<key>.idempotency_keys.response_ciphertext:<idk_…>` (ADR-0010). */
  private associatedData(schemaName: TenantSchema, id: string): string {
    return aadFor(schemaName, "idempotency_keys", "response_ciphertext", id);
  }
}
