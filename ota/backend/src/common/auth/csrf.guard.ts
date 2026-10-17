// The CSRF guard (architecture §3 step 9, OADR-0006 point 3, api-changes §2.4): the hosted storefront's sessions live
// in `__Host-` cookies that the browser sends with every same-site request, so every state-changing request of the
// edge caller must prove it comes from the storefront's own pages. On an edge `POST`, `PUT`, `PATCH` or `DELETE`:
//
//   - `X-CSRF-Token` equals the `__Host-vx_csrf` cookie, compared in constant time; both are the 256-bit base64url
//     value `storefront.get` issues (43 characters). The double submit works because a third-party page can neither
//     read the cookie nor set a header on a cross-site request;
//   - and `Origin` is `https://<X-Velexis-Host>`, the verified storefront host Caddy forwards; a request without
//     `Origin` passes only with `Sec-Fetch-Site: same-origin`.
//
// Anything else is `403 CSRF_TOKEN_INVALID` with `details.reason` (`token_missing`, `token_mismatch`,
// `origin_mismatch`). The anonymous POSTs of the storefront (search, checkout, lookup) are covered from the first call:
// the cookie is not tied to a session. GET and HEAD never change state and are not checked; key callers (servers and
// browsers with a publishable key) send no cookies the API reads (OADR-0006 point 1) and are never checked.
//
// Like the tenant and scope guards it acts on handlers bound to an operation (`@OpenApiOperation`): the 501 routes of
// pending operations change nothing. It runs after the scope guard and before the rate limits.
import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { timingSafeEqualStr } from "@velexis/crypto";
import { AppError } from "@velexis/errors";
import type { Request } from "express";
import { CallerContext } from "../../tenancy/caller-resolver";
import { OPENAPI_OPERATION } from "../http/openapi-operation.decorator";

/** The double-submit cookie (OADR-0006 point 2): not HttpOnly, so the storefront's SDK can copy it. */
export const CSRF_COOKIE = "__Host-vx_csrf";
/** The header the SDK copies the cookie into, lower case as Node gives header names. */
export const CSRF_HEADER = "x-csrf-token";
/** 32 random bytes in base64url without padding (api-changes §2.1 `CsrfToken`). */
export const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The methods that may change state and need the check. */
export const CSRF_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Why an edge request failed the check (`details.reason`). */
export type CsrfRefusal = "token_missing" | "token_mismatch" | "origin_mismatch";

/** What the check reads from an edge request. */
export interface CsrfRequest {
  /** The verified storefront host of the edge caller (`X-Velexis-Host`, lower case). */
  readonly host: string;
  /** The request headers by lower-case name, as Node gives them. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The cookies as cookie-parser gives them. */
  readonly cookies: Readonly<Record<string, unknown>> | undefined;
}

/** A header's value; Node joins repeated headers into one string, which the checks below then refuse. */
function header(request: CsrfRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(", ") : value;
}

/** Why `request` fails the double-submit and origin checks, or `undefined` when it passes. */
export function csrfProblem(request: CsrfRequest): CsrfRefusal | undefined {
  const cookie = request.cookies?.[CSRF_COOKIE];
  const token = header(request, CSRF_HEADER);
  if (typeof cookie !== "string" || token === undefined || token === "") {
    return "token_missing";
  }
  if (
    !CSRF_TOKEN_PATTERN.test(cookie) ||
    !CSRF_TOKEN_PATTERN.test(token) ||
    !timingSafeEqualStr(token, cookie)
  ) {
    return "token_mismatch";
  }
  const origin = header(request, "origin");
  if (origin === undefined) {
    return header(request, "sec-fetch-site") === "same-origin" ? undefined : "origin_mismatch";
  }
  return origin.toLowerCase() === `https://${request.host}` ? undefined : "origin_mismatch";
}

const MESSAGES: Readonly<Record<CsrfRefusal, string>> = {
  token_missing: "X-CSRF-Token and the CSRF cookie are required on this request.",
  token_mismatch: "X-CSRF-Token does not match the CSRF cookie.",
  origin_mismatch: "The request does not come from the storefront's own origin.",
};

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly callers: CallerContext,
  ) {}

  canActivate(execution: ExecutionContext): boolean {
    if (execution.getType() !== "http") {
      return true;
    }
    if (this.reflector.get<string | undefined>(OPENAPI_OPERATION, execution.getHandler()) === undefined) {
      return true;
    }
    const caller = this.callers.get();
    if (caller === undefined) {
      throw new Error("CsrfGuard ran without a caller in the request context; CallerGuard must run first");
    }
    const req = execution.switchToHttp().getRequest<Request>();
    if (caller.type !== "edge" || !CSRF_METHODS.has(req.method.toUpperCase())) {
      return true;
    }
    const cookies: unknown = req.cookies;
    const reason = csrfProblem({
      host: caller.host,
      headers: req.headers,
      cookies:
        typeof cookies === "object" && cookies !== null ? (cookies as Record<string, unknown>) : undefined,
    });
    if (reason !== undefined) {
      throw new AppError("CSRF_TOKEN_INVALID", { message: MESSAGES[reason], details: { reason } });
    }
    return true;
  }
}
