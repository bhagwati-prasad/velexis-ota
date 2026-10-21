// The caller guard (architecture §3 step 4, OADR-0009 point 1): the first guard of every request. It classifies the
// caller with `CallerResolver` (tenancy/caller-resolver.ts: edge secret, the OTA admin's service key, API key,
// anonymous) and records it in the request context (`CallerContext`) for the guards and handlers after it; a request it
// refuses never reaches them. It is global (`APP_GUARD` in app.module.ts), so a route needs no decorator to be
// protected: without one a credential is required.
//
// Routes that may be called without a credential say so on the handler or the controller:
//
//   @PublicRoute()   /health/live, and the public asset and signed file downloads (/v1/assets/*, /v1/files/*)
//   @WebhookRoute()  the Stripe receivers (/webhooks/*): anonymous; the handler verifies the signature
//   @LocalRoute()    /health/ready: anonymous on a direct loopback connection only (Caddy blocks it publicly)
//
// A credential sent to such a route is still checked: an edge header or an API key classifies the caller as on any
// other route, and a wrong one is refused there too.
//
// The service branch (OBE-060, OADR-0009 rule 1.2): `X-Api-Key` equal to OTA_ADMIN_SERVICE_KEY (constant time), the
// socket peer (`req.socket.remoteAddress`, never `req.ip`) on loopback, and neither `X-Forwarded-For` nor
// `X-Forwarded-Host` (Caddy sets both on every request it proxies, `api.ota.example.com` and the storefronts'
// `/api/*`). The same key any other way is no service request: the resolver logs it as a security event without the
// value, and it ends as an unknown key (`401 INVALID_API_KEY`), or with the edge header beside it as an ambiguous
// request (`400 INVALID_REQUEST`). What the service caller may call (console operations only, with a staff token and
// `X-Velexis-Environment`) is the tenant, scope, staff and permission guards' business.
//
// The guard also decides the request's end user (`RequestContext.endUser`, OADR-0009 point 8), the IP address and user
// agent that the rate limits, staff sessions and the console audit (`staff_actions`) use:
//
//   service     `X-Velexis-End-User-IP` (required: missing or not an IPv4 or IPv6 address → `400 VALIDATION_FAILED`
//               at `/header/X-Velexis-End-User-IP`) and `X-Velexis-End-User-Agent` (cut to 512 characters): the
//               staff member's, which the OTA admin forwards (the right-most X-Forwarded-For entry Caddy gave it)
//   secret key  a valid `X-Velexis-End-User-IP` (an invalid one is ignored, as the contract says) and a non-empty
//               `X-Velexis-End-User-Agent`, else the connection's
//   others      the connection's address (Express' `req.ip`: Caddy's client address) and `User-Agent`; the forwarding
//               headers are ignored
import { isIP } from "node:net";
import {
  Injectable,
  SetMetadata,
  type CanActivate,
  type CustomDecorator,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AppError } from "@velexis/errors";
import type { Request } from "express";
import { CallerContext, CallerResolver, type Caller, type RouteAccess } from "../../tenancy/caller-resolver";
import { endUserIp, END_USER_IP_HEADER, type AddressedRequest } from "../http/rate-limits";
import { RequestContext, type EndUser } from "../http/request-context";

/** Metadata key of the route access decorators on a handler or a controller. */
export const ROUTE_ACCESS = "velexis:route-access";

/** `X-Velexis-End-User-Agent`, lower case as Node gives header names. */
export const END_USER_AGENT_HEADER = "x-velexis-end-user-agent";

/** The longest user agent kept (`customer_sessions.user_agent`, staff families, `staff_actions.user_agent`). */
export const MAX_END_USER_AGENT_LENGTH = 512;

/** The route may be called without a credential (OADR-0009 rule 1.4). */
export function PublicRoute(): CustomDecorator<string> {
  return SetMetadata(ROUTE_ACCESS, "public" satisfies RouteAccess);
}

/** A webhook receiver: no credential, its own signature check (OADR-0009 rule 1.4). */
export function WebhookRoute(): CustomDecorator<string> {
  return SetMetadata(ROUTE_ACCESS, "webhook" satisfies RouteAccess);
}

/** No credential on a direct loopback connection (no X-Forwarded-For or X-Forwarded-Host); a credential otherwise. */
export function LocalRoute(): CustomDecorator<string> {
  return SetMetadata(ROUTE_ACCESS, "local" satisfies RouteAccess);
}

/** A header's value, trimmed; Node joins repeated headers of these names into one string. */
function headerText(request: AddressedRequest, name: string): string {
  const value = request.headers[name];
  return (Array.isArray(value) ? value.join(", ") : (value ?? "")).trim();
}

/** A user agent as it is kept: trimmed, at most 512 characters, `null` when empty. */
export function cutUserAgent(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, MAX_END_USER_AGENT_LENGTH);
}

/**
 * The end user of a request from `caller` (see the file header). Throws `AppError` `VALIDATION_FAILED` (400) for a
 * service request without a valid `X-Velexis-End-User-IP`; the value is never echoed.
 */
export function endUserOf(request: AddressedRequest, caller: Caller): EndUser {
  if (caller.type === "service") {
    const ip = headerText(request, END_USER_IP_HEADER);
    if (isIP(ip) === 0) {
      throw new AppError("VALIDATION_FAILED", {
        fieldErrors: [
          {
            path: "/header/X-Velexis-End-User-IP",
            code: ip === "" ? "required" : "format",
            message: "X-Velexis-End-User-IP must be the staff member's IPv4 or IPv6 address",
          },
        ],
      });
    }
    return { ip, userAgent: cutUserAgent(headerText(request, END_USER_AGENT_HEADER)) };
  }
  const forwardedAgent =
    caller.type === "key" && caller.kind === "secret"
      ? cutUserAgent(headerText(request, END_USER_AGENT_HEADER))
      : null;
  return {
    ip: endUserIp(request, caller),
    userAgent: forwardedAgent ?? cutUserAgent(headerText(request, "user-agent")),
  };
}

@Injectable()
export class CallerGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: CallerResolver,
    private readonly callers: CallerContext,
    private readonly context: RequestContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") {
      return true;
    }
    const req = context.switchToHttp().getRequest<Request>();
    const access =
      this.reflector.getAllAndOverride<RouteAccess | undefined>(ROUTE_ACCESS, [
        context.getHandler(),
        context.getClass(),
      ]) ?? "authenticated";
    const caller = await this.resolver.resolve(
      { headers: req.headers, remoteAddress: req.socket.remoteAddress },
      access,
    );
    this.callers.set(caller);
    this.context.setEndUser(endUserOf(req, caller));
    return true;
  }
}
