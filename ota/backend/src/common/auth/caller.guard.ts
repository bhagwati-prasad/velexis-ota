// The caller guard (architecture §3 step 4, OADR-0009 point 1): the first guard of every request. It classifies the
// caller with `CallerResolver` (tenancy/caller-resolver.ts: edge secret, API key, anonymous) and records it in the
// request context (`CallerContext`) for the guards and handlers after it; a request it refuses never reaches them.
// It is global (`APP_GUARD` in app.module.ts), so a route needs no decorator to be protected: without one a credential
// is required.
//
// Routes that may be called without a credential say so on the handler or the controller:
//
//   @PublicRoute()   /health/live, and the public asset and signed file downloads (/v1/assets/*, /v1/files/*)
//   @WebhookRoute()  the Stripe receivers (/webhooks/*): anonymous; the handler verifies the signature
//   @LocalRoute()    /health/ready: anonymous on a direct loopback connection only (Caddy blocks it publicly)
//
// A credential sent to such a route is still checked: an edge header or an API key classifies the caller as on any
// other route, and a wrong one is refused there too.
import {
  Injectable,
  SetMetadata,
  type CanActivate,
  type CustomDecorator,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { CallerContext, CallerResolver, type RouteAccess } from "../../tenancy/caller-resolver";

/** Metadata key of the route access decorators on a handler or a controller. */
export const ROUTE_ACCESS = "velexis:route-access";

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

@Injectable()
export class CallerGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: CallerResolver,
    private readonly callers: CallerContext,
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
    return true;
  }
}
