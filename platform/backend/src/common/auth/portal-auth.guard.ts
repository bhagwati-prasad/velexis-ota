// PortalAuthGuard (platform/docs/architecture.md §3 step 5 and §3.1, PADR-0008 item 2, PADR-0009 item 4): the guard
// of every operation whose `x-scope` is `portal_unverified` or `portal`. It verifies an access token of the audience
// `portal`, so an admin token never works here:
//
// - no token, a malformed one or one of the other audience: `401 UNAUTHENTICATED`; an expired one: `401
//   TOKEN_EXPIRED` (the portal server then refreshes it);
// - `portal_unverified` (the account, MFA set-up, sessions, sign-out, resend) accepts an account whose e-mail is not
//   verified yet (`ev = false`);
// - `portal` needs `ev = true`, else `403 EMAIL_NOT_VERIFIED`.
//
// The account behind the token becomes the request's actor (`account`) and the claims stay on the request
// (`@AccessToken()`). Tenant roles are checked later by TenantRoleGuard (PBE-017), step-ups by RecentMfaGuard.
import type { IncomingHttpHeaders } from "node:http";
import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import { bearerTokenOf, TokenService } from "../../auth/token.service";
import { RequestContext } from "../http/request-context";
import { OperationPolicies, setAccessToken } from "./decorators";

@Injectable()
export class PortalAuthGuard implements CanActivate {
  constructor(
    private readonly policies: OperationPolicies,
    private readonly tokens: TokenService,
    private readonly context: RequestContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const scope = context.getType() === "http" ? this.policies.forContext(context).scope : undefined;
    if (scope !== "portal" && scope !== "portal_unverified") {
      return true;
    }
    const request = context.switchToHttp().getRequest<{ readonly headers: IncomingHttpHeaders }>();
    const claims = await this.tokens.verify(bearerTokenOf(request.headers), "portal");
    setAccessToken(request, claims);
    this.context.setActor({ type: "account", accountId: claims.sub });
    if (scope === "portal" && !claims.ev) {
      throw new AppError("EMAIL_NOT_VERIFIED");
    }
    return true;
  }
}
