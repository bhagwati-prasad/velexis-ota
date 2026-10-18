// The platform admin's identity routes (PBE-028; platform/docs/api-inventory-admin.md §2, PADR-0006 "Access"): the
// password step and the TOTP step of the admin sign-in, the refresh of admin sessions, the step-up, sign-out and the
// signed-in admin. Thin: each handler binds its operation, reads the validated body (and the caller's admin access
// token) and makes one AdminAuthService call.
//
// adminSignIn, adminVerifyMfa and adminRefresh are `public` (adminSignIn under the sign-in throttle of 10 per end-user
// IP per minute; adminVerifyMfa counts the account's `mfa` limit in MfaService once the challenge names the account);
// adminStepUp (`mfa` limit by the guard), adminSignOut and adminGetMe are `platform_admin`, so AdminAuthGuard has
// verified an admin access token and re-read the account first. The answers that carry tokens are sent with
// `Cache-Control: no-store`; `423 ACCOUNT_LOCKED` and adminVerifyMfa's `429 RATE_LIMITED` get `Retry-After` with the
// seconds left. Nothing here logs a body.
import { Controller, Get, HttpCode, Post, Res } from "@nestjs/common";
import { MfaRateLimitedError } from "../auth/mfa-challenge.store";
import { AccountLockedError } from "../auth/sign-in.service";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import {
  AdminAuthService,
  type AdminMe,
  type AdminMfaChallenge,
  type AdminSession,
  type RefreshSessionRequest,
  type SignInRequest,
  type SignOutRequest,
  type TotpCodeRequest,
  type VerifyMfaRequest,
} from "./admin-auth.service";

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

/** Answers that carry tokens are never stored by a cache (PADR-0009 items 3 and 11). */
function noStore(res: HeaderTarget): void {
  res.setHeader("Cache-Control", "no-store");
}

/** Sets `Retry-After` for a lockout or a rate limit counted by a service, then rethrows. */
function withRetryAfter(res: HeaderTarget, error: unknown): never {
  if (error instanceof AccountLockedError || error instanceof MfaRateLimitedError) {
    res.setHeader("Retry-After", String(error.retryAfterSeconds));
  }
  throw error;
}

@Controller("v1/admin")
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  /** An MFA challenge for adminVerifyMfa: every admin sign-in needs a TOTP or recovery code. */
  @Post("auth/sign-in")
  @HttpCode(200)
  @OpenApiOperation("adminSignIn")
  async adminSignIn(
    @Validated("body") body: SignInRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<AdminMfaChallenge> {
    noStore(res);
    try {
      return await this.auth.signIn(body);
    } catch (error) {
      return withRetryAfter(res, error);
    }
  }

  /** An `AdminSession` (12-hour family) for a TOTP or unused recovery code of the challenge's admin. */
  @Post("auth/mfa/verify")
  @HttpCode(200)
  @OpenApiOperation("adminVerifyMfa")
  async adminVerifyMfa(
    @Validated("body") body: VerifyMfaRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<AdminSession> {
    noStore(res);
    try {
      return await this.auth.verifyMfa(body);
    } catch (error) {
      return withRetryAfter(res, error);
    }
  }

  @Post("auth/refresh")
  @HttpCode(200)
  @OpenApiOperation("adminRefresh")
  adminRefresh(
    @Validated("body") body: RefreshSessionRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<AdminSession> {
    noStore(res);
    return this.auth.refresh(body.refreshToken);
  }

  /** A new session of the caller's admin family whose access token carries `mfa_at` = now. */
  @Post("auth/step-up")
  @HttpCode(200)
  @OpenApiOperation("adminStepUp")
  adminStepUp(
    @AccessToken() token: AccessTokenClaims,
    @Validated("body") body: TotpCodeRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<AdminSession> {
    noStore(res);
    return this.auth.stepUp(token, body);
  }

  /** `204`, also for a refresh token that is unknown, revoked, of a portal family or not the caller's. */
  @Post("auth/sign-out")
  @HttpCode(204)
  @OpenApiOperation("adminSignOut")
  adminSignOut(
    @AccessToken() token: AccessTokenClaims,
    @Validated("body") body: SignOutRequest,
  ): Promise<void> {
    return this.auth.signOut(token.sub, body.refreshToken);
  }

  @Get("me")
  @OpenApiOperation("adminGetMe")
  adminGetMe(@AccessToken() token: AccessTokenClaims): Promise<AdminMe> {
    return this.auth.me(token.sub);
  }
}
