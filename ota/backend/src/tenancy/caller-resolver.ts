// Caller classification (OADR-0009 point 1, ota/docs/architecture.md §3.1): who sent a request, decided from its
// headers before anything else of the request is used. `CallerGuard` (common/auth) runs it for every request and puts
// the result in the request context (`CallerContext`); the tenant guard (OBE-012) and the scope guard (OBE-013) read
// it from there, and modules never inspect these headers themselves.
//
// The order is the ADR's, and the first match decides:
//
//   X-Velexis-Edge and X-Api-Key together              → 400 INVALID_REQUEST (ambiguous)
//   1.1 X-Velexis-Edge equals VELEXIS_EDGE_SECRET       → edge (X-Velexis-Host required, else 400 INVALID_REQUEST);
//       compared in constant time, before any lookup; a wrong value is 401 INVALID_API_KEY
//   1.2 X-Api-Key equals OTA_ADMIN_SERVICE_KEY on a direct loopback connection → service (OBE-060)
//   1.3 X-Api-Key with a pk_ or sk_ prefix               → key (ApiKeyVerifier)
//   1.4 a route marked public or webhook                 → anonymous (the route verifies what it serves)
//   5   anything else                                    → 401 INVALID_API_KEY
//
// A route marked local (`/health/ready`, which Caddy blocks publicly) is anonymous on a direct loopback connection
// only: the test of rule 1.2 and of the platform's InternalOnlyGuard (socket peer on loopback, neither
// X-Forwarded-For nor X-Forwarded-Host, which Caddy sets on every proxied request).
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { timingSafeEqualStr } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import { ClsService } from "nestjs-cls";
import { PinoLogger } from "nestjs-pino";
import type { ApiConfig } from "../config";
import { ApiKeyVerifier, type VerifiedApiKey } from "./api-key.verifier";
import type { ApiKeyEnvironment } from "./platform-read.repository";

/** The request headers of caller classification, lower case as Node gives them. */
export const CALLER_HEADERS = Object.freeze({
  edge: "x-velexis-edge",
  host: "x-velexis-host",
  apiKey: "x-api-key",
  origin: "origin",
  forwardedFor: "x-forwarded-for",
  forwardedHost: "x-forwarded-host",
} as const);

/**
 * How a route may be called without a credential: `authenticated` (the default: a credential is required),
 * `public` (`/health/live`, `/v1/assets/*`, `/v1/files/*`), `webhook` (`/webhooks/*`, verified by signature) and
 * `local` (`/health/ready`: a direct loopback connection only).
 */
export type RouteAccess = "authenticated" | "public" | "webhook" | "local";

/** The hosted storefront, through Caddy (ADR-0018). */
export interface EdgeCaller {
  readonly type: "edge";
  readonly id: "edge";
  /** `X-Velexis-Host` in lower case: the storefront host the tenant guard resolves (OBE-012). */
  readonly host: string;
}

/** A publishable or secret API key of a tenant. */
export interface KeyCaller {
  readonly type: "key";
  /** The key id (`key_…`), as `keyId`. */
  readonly id: string;
  readonly keyId: string;
  readonly kind: VerifiedApiKey["kind"];
  /** The key's tenant: the tenant of the request (OADR-0009 point 2). */
  readonly tenantId: string;
  readonly environment: ApiKeyEnvironment;
  readonly scopes: readonly string[];
}

/** No credential, on a public, webhook or local route. */
export interface AnonymousCaller {
  readonly type: "anonymous";
  readonly id: "anonymous";
}

/** The caller of a request. The service caller of the OTA admin joins with OBE-060. */
export type Caller = EdgeCaller | KeyCaller | AnonymousCaller;

/** What classification reads from a request. */
export interface CallerRequest {
  /** The request headers by lower-case name, as Node gives them. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The socket peer (`req.socket.remoteAddress`), never `req.ip`, which X-Forwarded-For can set. */
  readonly remoteAddress: string | undefined;
}

const ANONYMOUS: AnonymousCaller = Object.freeze({ type: "anonymous", id: "anonymous" });

/** A header's value; Node joins repeated headers of these names into one string. */
function header(request: CallerRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

/** True for an IPv4 loopback address (127.0.0.0/8), `::1`, and IPv4 loopback mapped into IPv6. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) {
    return false;
  }
  const v4 = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return address === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * True when the request came straight from a local process: the socket peer is loopback and the request carries
 * neither `X-Forwarded-For` nor `X-Forwarded-Host`. Caddy reaches the API from 127.0.0.1 too, but sets both headers on
 * every request it proxies, and a client cannot remove them (OADR-0009 rule 1.2).
 */
export function isDirectLocalRequest(request: CallerRequest): boolean {
  return (
    isLoopbackAddress(request.remoteAddress) &&
    request.headers[CALLER_HEADERS.forwardedFor] === undefined &&
    request.headers[CALLER_HEADERS.forwardedHost] === undefined
  );
}

@Injectable()
export class CallerResolver {
  private readonly edgeSecret: string;

  constructor(
    config: ConfigService<ApiConfig, true>,
    private readonly keys: ApiKeyVerifier,
    private readonly logger: PinoLogger,
  ) {
    this.edgeSecret = config.get("VELEXIS_EDGE_SECRET", { infer: true });
    logger.setContext(CallerResolver.name);
  }

  /**
   * Classifies a request reaching a route with `access`. Resolves to its caller; throws `AppError`
   * `INVALID_REQUEST` (400), `INVALID_API_KEY` (401), or what the key verifier throws (`ORIGIN_NOT_ALLOWED`,
   * `SERVICE_UNAVAILABLE`).
   */
  async resolve(request: CallerRequest, access: RouteAccess): Promise<Caller> {
    const edge = header(request, CALLER_HEADERS.edge);
    const apiKey = header(request, CALLER_HEADERS.apiKey);
    if (edge !== undefined && apiKey !== undefined) {
      throw new AppError("INVALID_REQUEST", {
        message: "Send either the storefront edge credential or X-Api-Key, not both.",
        details: { reason: "edge_with_api_key" },
      });
    }
    if (edge !== undefined) {
      return this.edgeCaller(request, edge);
    }
    if (apiKey !== undefined) {
      if (apiKey.startsWith("pk_") || apiKey.startsWith("sk_")) {
        return this.keyCaller(request, apiKey);
      }
      // Not a key the API serves: hosting keys (hk_) come after the MVP, the service key with OBE-060.
      this.logger.info({ reason: "unsupported_kind" }, "caller.api_key_refused");
      throw new AppError("INVALID_API_KEY");
    }
    if (
      access === "public" ||
      access === "webhook" ||
      (access === "local" && isDirectLocalRequest(request))
    ) {
      return ANONYMOUS;
    }
    throw new AppError("INVALID_API_KEY");
  }

  /** Rule 1.1: the secret first, compared in constant time; nothing is looked up for an edge request here. */
  private edgeCaller(request: CallerRequest, presented: string): EdgeCaller {
    if (!timingSafeEqualStr(presented, this.edgeSecret)) {
      // Caddy replaces any client value, so a wrong one is a misconfigured proxy or a local process probing.
      this.logger.warn({ reason: "edge_secret_mismatch" }, "caller.edge_refused");
      throw new AppError("INVALID_API_KEY");
    }
    const host = header(request, CALLER_HEADERS.host)?.trim().toLowerCase() ?? "";
    if (host === "") {
      throw new AppError("INVALID_REQUEST", {
        message: "X-Velexis-Host is required with the storefront edge credential.",
        details: { reason: "edge_host_missing" },
      });
    }
    return Object.freeze({ type: "edge", id: "edge", host });
  }

  /** Rule 1.3. */
  private async keyCaller(request: CallerRequest, presented: string): Promise<KeyCaller> {
    const key = await this.keys.verify(presented, { origin: header(request, CALLER_HEADERS.origin) });
    return Object.freeze({
      type: "key",
      id: key.id,
      keyId: key.id,
      kind: key.kind,
      tenantId: key.tenantId,
      environment: key.environment,
      scopes: key.scopes,
    });
  }
}

const CALLER_KEY = "tenancy.caller";

/**
 * The caller of the current request in the request context (nestjs-cls), set once by `CallerGuard`. The tenant
 * context of OBE-012 builds on it.
 */
@Injectable()
export class CallerContext {
  constructor(private readonly cls: ClsService) {}

  /** Records the caller of the current request; outside a request it does nothing. */
  set(caller: Caller): void {
    if (this.cls.isActive()) {
      this.cls.set(CALLER_KEY, caller);
    }
  }

  /** The caller of the current request, or `undefined` before the guard ran or outside a request. */
  get(): Caller | undefined {
    if (!this.cls.isActive()) {
      return undefined;
    }
    const caller: unknown = this.cls.get(CALLER_KEY);
    return typeof caller === "object" && caller !== null ? (caller as Caller) : undefined;
  }
}
