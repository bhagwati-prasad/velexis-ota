// RecentMfaGuard (platform/docs/architecture.md §3 step 7, PADR-0008 "Sensitive actions"): the step-up of the
// operations marked `x-mfa-step-up: true` (or `@RequireRecentMfa()`): entering credentials, live keys, payout data,
// go-live, granting `owner`, turning MFA off, regenerating recovery codes and the sensitive admin actions. It runs
// after PortalAuthGuard or AdminAuthGuard has verified the token:
//
// - an account without MFA (read fresh from `platform.accounts`, so turning MFA on or off acts at once) answers
//   `403 MFA_REQUIRED`: the portal asks the person to set MFA up;
// - with MFA, the token's `mfa_at` must be at most 15 minutes old, otherwise `401 REAUTH_REQUIRED`: the portal or the
//   admin asks for a TOTP code (`stepUp`, `adminStepUp`) and retries with the new token.
//
// Times come from the injected Clock.
import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import type { AccessTokenClaims } from "../../auth/token.service";
import { Clock } from "../clock";
import { AccountAuthStates, type AccountAuthState } from "./admin-auth.guard";
import { accessTokenOf, OperationPolicies } from "./decorators";

/** How long a TOTP verification counts as recent: 15 minutes (PADR-0008). */
export const MFA_STEP_UP_WINDOW_SECONDS = 15 * 60;

/** True when the token's `mfa_at` lies within the step-up window that ends at `now` (epoch seconds). */
export function hasRecentMfa(claims: Pick<AccessTokenClaims, "mfa_at">, nowSeconds: number): boolean {
  if (claims.mfa_at === undefined) {
    return false;
  }
  const age = nowSeconds - claims.mfa_at;
  return age >= 0 && age <= MFA_STEP_UP_WINDOW_SECONDS;
}

/**
 * The step-up rule of PADR-0008, for the guard and for services whose step-up depends on the request (for example
 * adminUpdateAmadeusAccount, which needs it only for a new secret, client id or host): throws `MFA_REQUIRED` for an
 * account without MFA and `REAUTH_REQUIRED` when the token's `mfa_at` is missing or older than 15 minutes.
 */
export function assertRecentMfa(
  account: Pick<AccountAuthState, "mfaEnabled">,
  claims: Pick<AccessTokenClaims, "mfa_at">,
  now: Date,
): void {
  if (!account.mfaEnabled) {
    throw new AppError("MFA_REQUIRED");
  }
  if (!hasRecentMfa(claims, Math.floor(now.getTime() / 1000))) {
    throw new AppError("REAUTH_REQUIRED");
  }
}

@Injectable()
export class RecentMfaGuard implements CanActivate {
  constructor(
    private readonly policies: OperationPolicies,
    private readonly accounts: AccountAuthStates,
    private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http" || !this.policies.forContext(context).mfaStepUp) {
      return true;
    }
    const claims = accessTokenOf(context.switchToHttp().getRequest<object>());
    if (claims === undefined) {
      // A step-up on a handler that no auth guard covered (a decorator on a public route): refuse, never wave through.
      throw new AppError("UNAUTHENTICATED");
    }
    const account = await this.accounts.read(claims.sub);
    if (account === undefined) {
      throw new AppError("UNAUTHENTICATED");
    }
    assertRecentMfa(account, claims, this.clock.now());
    return true;
  }
}
