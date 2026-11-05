// PortalAuthGuard (platform/docs/architecture.md §3 step 5 and §3.1, PADR-0008 item 2, PADR-0009 item 4): the guard
// of every operation whose `x-scope` is `portal_unverified` or `portal`. It verifies an access token of the audience
// `portal`, so an admin token never works here:
//
// - no token, a malformed one or one of the other audience: `401 UNAUTHENTICATED`; an expired one: `401
//   TOKEN_EXPIRED` (the portal server then refreshes it);
// - then it re-reads the account behind the token (`AccountAuthStates`: one primary-key read per request, no cache,
//   as AdminAuthGuard does): an account that is gone, erased (`deleted_at`), `deleted` or `disabled` answers `401
//   UNAUTHENTICATED` at once, as a missing token does, before the e-mail check (PBE-067; lead decision (5a) of
//   2026-11-05 on finding F-1 of platform/docs/security-review.md). Disabling an account is the platform admin's
//   answer to a compromised or abusive one, and revoking its refresh families does not end the access token it already
//   holds: without this read the holder kept up to 15 minutes to mint API keys, change the payout account or remove
//   members. `locked` (a sign-in lockout, not a revocation) and `pending_verification` keep their answers;
// - `portal_unverified` (the account, MFA set-up, sessions, sign-out, resend) accepts an account whose e-mail is not
//   verified yet (`ev = false`);
// - `portal` needs `ev = true`, else `403 EMAIL_NOT_VERIFIED`.
//
// The account behind the token becomes the request's actor (`account`) and the claims stay on the request
// (`@AccessToken()`); a refused account leaves neither. Tenant roles are checked later by TenantRoleGuard (PBE-017),
// step-ups by RecentMfaGuard.
import type { IncomingHttpHeaders } from "node:http";
import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import { bearerTokenOf, TokenService } from "../../auth/token.service";
import { RequestContext } from "../http/request-context";
import { AccountAuthStates, type AccountAuthState, type AccountStatus } from "./admin-auth.guard";
import { OperationPolicies, setAccessToken } from "./decorators";

/**
 * The account states whose unexpired portal tokens still work: `active`, `pending_verification` (the e-mail check
 * decides) and `locked` (a sign-in lockout, not a revocation). `disabled` and `deleted` do not, and neither does a
 * state that a later migration adds until it is listed here.
 */
const PORTAL_TOKEN_STATUSES: ReadonlySet<AccountStatus> = new Set<AccountStatus>([
  "active",
  "pending_verification",
  "locked",
]);

/** True when the portal tokens of the account may be used now: it exists, is not erased, disabled or deleted. */
export function mayUsePortalToken(state: AccountAuthState | undefined): boolean {
  return state !== undefined && PORTAL_TOKEN_STATUSES.has(state.status);
}

@Injectable()
export class PortalAuthGuard implements CanActivate {
  constructor(
    private readonly policies: OperationPolicies,
    private readonly tokens: TokenService,
    private readonly accounts: AccountAuthStates,
    private readonly context: RequestContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const scope = context.getType() === "http" ? this.policies.forContext(context).scope : undefined;
    if (scope !== "portal" && scope !== "portal_unverified") {
      return true;
    }
    const request = context.switchToHttp().getRequest<{ readonly headers: IncomingHttpHeaders }>();
    const claims = await this.tokens.verify(bearerTokenOf(request.headers), "portal");
    if (!mayUsePortalToken(await this.accounts.read(claims.sub))) {
      throw new AppError("UNAUTHENTICATED");
    }
    setAccessToken(request, claims);
    this.context.setActor({ type: "account", accountId: claims.sub });
    if (scope === "portal" && !claims.ev) {
      throw new AppError("EMAIL_NOT_VERIFIED");
    }
    return true;
  }
}
