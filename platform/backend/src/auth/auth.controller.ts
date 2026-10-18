// The portal identity routes (platform/docs/api-inventory.md §4, `AuthModule`): sign-up, e-mail verification and the
// resend of the verification link (PBE-013); sign-in, refresh, sign-out and sign-out everywhere (PBE-014); the MFA
// steps verifyMfa and stepUp (PBE-015). The password reset (PBE-016) joins this controller. Thin: each handler binds
// its operation, reads the validated body (and the caller's access token) and makes one service call. Sign-up,
// verification, resend, sign-in, verifyMfa and refresh are `public`, the two sign-outs `portal_unverified`, stepUp
// `portal`; the rate limits are the operations' throttlers, except verifyMfa's per-account limit, which its service
// counts once the challenge names the account. The MFA steps go to `MfaVerification`, which AccountsModule's
// MfaService implements (mfa-challenge.store.ts).
//
// The answers of signIn, verifyMfa, refreshSession and stepUp carry tokens, so they are sent with `Cache-Control:
// no-store`; a `423 ACCOUNT_LOCKED` and verifyMfa's `429 RATE_LIMITED` get `Retry-After` with the seconds left.
// Nothing here logs a body.
import { Controller, HttpCode, Post, Res } from "@nestjs/common";
import { AccessToken } from "../common/auth/decorators";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import {
  MfaRateLimitedError,
  MfaVerification,
  type TotpCodeRequest,
  type VerifyMfaRequest,
} from "./mfa-challenge.store";
import {
  SessionsService,
  type PortalSession,
  type RefreshSessionRequest,
  type SignOutRequest,
} from "./sessions.service";
import { AccountLockedError, SignInService, type SignInRequest, type SignInResult } from "./sign-in.service";
import {
  SignUpService,
  type EmailVerified,
  type ResendVerificationRequest,
  type SignUpAccepted,
  type SignUpRequest,
  type VerifyEmailRequest,
} from "./sign-up.service";
import type { AccessTokenClaims } from "./token.service";

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

/** Answers that carry tokens are never stored by a cache (PADR-0009 items 3 and 11). */
function noStore(res: HeaderTarget): void {
  res.setHeader("Cache-Control", "no-store");
}

@Controller("v1/auth")
export class AuthController {
  constructor(
    private readonly signUps: SignUpService,
    private readonly signIns: SignInService,
    private readonly sessions: SessionsService,
    private readonly mfa: MfaVerification,
  ) {}

  @Post("sign-up")
  @HttpCode(202)
  @OpenApiOperation("signUp")
  signUp(@Validated("body") body: SignUpRequest): Promise<SignUpAccepted> {
    return this.signUps.signUp(body);
  }

  @Post("verify-email")
  @HttpCode(200)
  @OpenApiOperation("verifyEmail")
  verifyEmail(@Validated("body") body: VerifyEmailRequest): Promise<EmailVerified> {
    return this.signUps.verifyEmail(body.token);
  }

  /** `202` without a body, whatever the address. */
  @Post("resend-verification")
  @HttpCode(202)
  @OpenApiOperation("resendVerification")
  resendVerification(@Validated("body") body: ResendVerificationRequest): Promise<void> {
    return this.signUps.resendVerification(body);
  }

  /** A `PortalSession`, or an MFA challenge for verifyMfa. */
  @Post("sign-in")
  @HttpCode(200)
  @OpenApiOperation("signIn")
  async signIn(
    @Validated("body") body: SignInRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<SignInResult> {
    noStore(res);
    try {
      return await this.signIns.signIn(body);
    } catch (error) {
      if (error instanceof AccountLockedError) {
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
      }
      throw error;
    }
  }

  /** A `PortalSession` for a TOTP or unused recovery code of the challenge's account. */
  @Post("mfa/verify")
  @HttpCode(200)
  @OpenApiOperation("verifyMfa")
  async verifyMfa(
    @Validated("body") body: VerifyMfaRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<PortalSession> {
    noStore(res);
    try {
      return await this.mfa.verifyMfa(body);
    } catch (error) {
      if (error instanceof AccountLockedError || error instanceof MfaRateLimitedError) {
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
      }
      throw error;
    }
  }

  /** A new session of the caller's family whose access token carries `mfa_at` = now. */
  @Post("step-up")
  @HttpCode(200)
  @OpenApiOperation("stepUp")
  stepUp(
    @AccessToken() token: AccessTokenClaims,
    @Validated("body") body: TotpCodeRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<PortalSession> {
    noStore(res);
    return this.mfa.stepUp(token, body);
  }

  @Post("refresh")
  @HttpCode(200)
  @OpenApiOperation("refreshSession")
  refreshSession(
    @Validated("body") body: RefreshSessionRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<PortalSession> {
    noStore(res);
    return this.sessions.refresh(body.refreshToken);
  }

  /** `204`, also for a refresh token that is unknown, revoked or not the caller's. */
  @Post("sign-out")
  @HttpCode(204)
  @OpenApiOperation("signOut")
  signOut(@AccessToken() token: AccessTokenClaims, @Validated("body") body: SignOutRequest): Promise<void> {
    return this.sessions.signOut(token.sub, body.refreshToken);
  }

  @Post("sign-out-everywhere")
  @HttpCode(204)
  @OpenApiOperation("signOutEverywhere")
  signOutEverywhere(@AccessToken() token: AccessTokenClaims): Promise<void> {
    return this.sessions.signOutEverywhere(token.sub);
  }
}
