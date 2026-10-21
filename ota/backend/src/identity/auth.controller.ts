// The customer auth operations (`x-scope: customer`; OBE-033 for sign-in, refresh, sign-out and getSession; OBE-032 for
// sign-up, e-mail verification and its resend; OBE-034 adds the passwords here): thin handlers over SignInService,
// SignUpService, VerificationService and SessionsService. The global guards resolved the caller, the tenant and the
// scope, the customer guard read the access token where the operation takes one, the CSRF guard checked the edge's
// POSTs, the rate limits counted the request (`signIn`: 10 per minute per end-user IP; `signUp` and
// `resendEmailVerification`: 5 per hour per IP and 3 per hour per address), the validation interceptor checked the
// input against the OTA document and the idempotency interceptor stores each POST's answer under its
// `Idempotency-Key` (sign-in's and sign-up's without the password in their hash).
//
// auth.signUp answers `201` with `Location: /v1/account`; the session it opens goes into the edge's cookies with a new
// CSRF value (`session: null` in the body, api-changes §2.2) or into the body for key callers. auth.verifyEmail
// answers `200 EmailVerificationResult` and opens no session. auth.resendVerification answers the same `202
// AuthAcceptedResult` whatever it did (the document's anti-enumeration rule); a signed-in customer's token or cookie
// names the account, else the body's `email`.
//
// Two modes (OADR-0006 points 1, 4 and 5; api-changes §2.2):
//
// - edge mode, the hosted storefront through Caddy: the session lives in cookies the cookie writer sets
//   (`__Host-vx_at`, `__Host-vx_rt`, a new `__Host-vx_csrf` at sign-in and sign-out), and no body ever holds a token:
//   sign-in and refresh answer `AuthSessionInfo`. auth.refresh reads the `__Host-vx_rt` cookie and refuses a token in
//   the body (`400 INVALID_REQUEST`); a refused refresh (`REFRESH_TOKEN_REUSED`, which also revoked the family, or
//   `REFRESH_TOKEN_INVALID`) clears both session cookies. auth.signOut ends the session of the access cookie, else of
//   the refresh cookie (a body token is not read), and clears both cookies.
// - token (bearer) mode, key callers: no `Set-Cookie`, ever; sign-in and refresh answer `AuthSessionResult` with the
//   tokens, auth.refresh needs `refreshToken` in the body, and auth.signOut takes the bearer token or the body's
//   refresh token, as the contract has always said.
//
// auth.signOut also ends the session of the refresh token when the access token has expired (the document): the
// customer guard takes an expired token as none on this operation only, and the handler answers `401 TOKEN_EXPIRED`
// (refresh, then retry) when no refresh token comes with it either.
//
// The idempotency request hash of an edge refresh covers the `__Host-vx_rt` cookie (`RefreshIdempotencyHooks`), so a
// stored refresh is replayed only to the holder of the cookie it rotated.
//
// auth.getSession answers `AuthSessionInfo` in both modes. Every answer is `Cache-Control: no-store` (`private,
// no-store` for getSession, as the document asks). A locked address's `423` carries `Retry-After`.
import { Controller, Get, HttpCode, Injectable, Post, Req, Res } from "@nestjs/common";
import { AppError, isAppError } from "@velexis/errors";
import type { Request, Response } from "express";
import { CLS_REQ, ClsService } from "nestjs-cls";
import { CustomerContext } from "../common/auth/customer.guard";
import { CookieWriter, STOREFRONT_COOKIES, type SetSessionOptions } from "../common/http/cookie-writer";
import {
  IdempotencyHooksFor,
  type IdempotencyHooks,
  type IdempotentInput,
} from "../common/http/idempotency.service";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import { CallerContext } from "../tenancy/caller-resolver";
import {
  RESEND_ACCEPTED,
  toAuthSessionInfo,
  toAuthSessionResult,
  toAuthSignUpResult,
  toEmailVerificationResult,
  type AuthAcceptedResult,
  type AuthSessionInfo,
  type AuthSessionResult,
  type AuthSignUpResult,
  type EmailVerificationResult,
} from "./customers.mapper";
import { AccountLockedError } from "./lockout";
import { SessionsService, type SessionWithTokens } from "./sessions.service";
import { SignInService } from "./sign-in.service";
import { SignUpService } from "./sign-up.service";
import { VerificationService } from "./verification.service";

/** `Cache-Control` of the answers of sign-in, refresh and sign-out: they open, rotate or end a session. */
export const AUTH_CACHE_CONTROL = "no-store";
/** `Cache-Control` of auth.getSession (the document: never cached). */
export const SESSION_CACHE_CONTROL = "private, no-store";
/** `Location` of auth.signUp's `201`: the new customer is the caller's account. */
export const ACCOUNT_LOCATION = "/v1/account";

/** The refresh cookie as cookie-parser gives it; anything but a non-empty string is no token. */
function refreshCookieOf(cookies: unknown): string | undefined {
  const value =
    cookies !== null && typeof cookies === "object"
      ? (cookies as Record<string, unknown>)[STOREFRONT_COOKIES.refreshToken]
      : undefined;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The refusals of auth.refresh after which the edge's session cookies are useless. */
const ENDED_SESSION_CODES: ReadonlySet<string> = new Set(["REFRESH_TOKEN_REUSED", "REFRESH_TOKEN_INVALID"]);

/**
 * The idempotency request hash of auth.refresh (idempotency.service.ts). Tokens stay in the hash, so that the key
 * alone never replays an answer that carries a session. A key caller's refresh token is in the body, which the hash
 * covers already; the edge's is the `__Host-vx_rt` cookie, which the validated input does not hold. Without it, script
 * on the storefront page, which can read the CSRF cookie (the edge's idempotency principal) and see the SDK's
 * `Idempotency-Key`, but never the httpOnly refresh cookie, could replay a refresh from elsewhere and receive the new
 * session cookies (OADR-0006: no token is ever readable by the page). So for the edge the hash also covers the
 * presented refresh cookie: a browser that missed the answer retries with the cookie it still holds and gets the same
 * new pair; any other request with the key gets `409 IDEMPOTENCY_KEY_REUSED`.
 */
@Injectable()
@IdempotencyHooksFor(["refreshSession"])
export class RefreshIdempotencyHooks implements IdempotencyHooks {
  constructor(
    private readonly cls: ClsService,
    private readonly cookies: CookieWriter,
  ) {}

  hashInput(input: IdempotentInput): unknown {
    if (!this.cookies.isEdge()) {
      return input;
    }
    // The request of the context (nestjs-cls keeps it); cookie-parser has filled its cookies by now.
    const req: unknown = this.cls.isActive() ? this.cls.get(CLS_REQ) : undefined;
    const cookies =
      req !== null && typeof req === "object" ? (req as Record<string, unknown>)["cookies"] : undefined;
    return { ...input, refreshCookie: refreshCookieOf(cookies) ?? null };
  }
}

@Controller("v1/auth")
export class AuthController {
  constructor(
    private readonly signIns: SignInService,
    private readonly signUps: SignUpService,
    private readonly verifications: VerificationService,
    private readonly sessions: SessionsService,
    private readonly cookies: CookieWriter,
    private readonly customers: CustomerContext,
    private readonly callers: CallerContext,
  ) {}

  @Post("sign-up")
  @HttpCode(201)
  @OpenApiOperation("signUp")
  async signUp(
    @OpenApiInput() input: ValidatedInput<"signUp">,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSignUpResult> {
    if (input.body === undefined) {
      // The validation interceptor refuses a request without its required body; this is never reached.
      throw new Error("signUp without a validated body");
    }
    res.setHeader("Cache-Control", AUTH_CACHE_CONTROL);
    const { body } = input;
    const signedUp = await this.signUps.signUp({
      email: body.email,
      password: body.password,
      firstName: body.firstName,
      lastName: body.lastName,
      marketingConsent: body.marketingConsent,
      termsVersion: body.termsVersion,
      locale: body.locale,
      currency: body.currency,
      returnPath: body.returnPath,
      acceptLanguage: input.headers["Accept-Language"],
      userAgent: this.endUserAgent(req, input.headers["X-Velexis-End-User-Agent"]),
    });
    res.setHeader("Location", ACCOUNT_LOCATION);
    // OADR-0006 point 2: a sign-up that opens a session rotates the CSRF value, as a sign-in does.
    const edge = this.cookies.setSession(res, signedUp.session, { rotateCsrf: true });
    return toAuthSignUpResult(signedUp.customer, edge ? null : signedUp.session, signedUp.verification);
  }

  @Post("email-verification/confirm")
  @HttpCode(200)
  @OpenApiOperation("verifyEmail")
  async verifyEmail(
    @OpenApiInput() input: ValidatedInput<"verifyEmail">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EmailVerificationResult> {
    if (input.body === undefined) {
      // The validation interceptor refuses a request without its required body; this is never reached.
      throw new Error("verifyEmail without a validated body");
    }
    res.setHeader("Cache-Control", AUTH_CACHE_CONTROL);
    return toEmailVerificationResult(await this.verifications.verify(input.body.token));
  }

  @Post("email-verification/resend")
  @HttpCode(202)
  @OpenApiOperation("resendEmailVerification")
  async resendVerification(
    @OpenApiInput() input: ValidatedInput<"resendEmailVerification">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthAcceptedResult> {
    res.setHeader("Cache-Control", AUTH_CACHE_CONTROL);
    await this.verifications.resend({
      customerId: this.customers.get()?.customerId,
      email: input.body?.email,
    });
    return { ...RESEND_ACCEPTED };
  }

  @Post("sign-in")
  @HttpCode(200)
  @OpenApiOperation("signIn")
  async signIn(
    @OpenApiInput() input: ValidatedInput<"signIn">,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionResult | AuthSessionInfo> {
    if (input.body === undefined) {
      // The validation interceptor refuses a request without its required body; this is never reached.
      throw new Error("signIn without a validated body");
    }
    res.setHeader("Cache-Control", AUTH_CACHE_CONTROL);
    let opened: SessionWithTokens;
    try {
      opened = await this.signIns.signIn({
        email: input.body.email,
        password: input.body.password,
        rememberMe: input.body.rememberMe,
        userAgent: this.endUserAgent(req, input.headers["X-Velexis-End-User-Agent"]),
      });
    } catch (error) {
      if (error instanceof AccountLockedError) {
        res.setHeader("Retry-After", String(error.retryAfterSeconds));
      }
      throw error;
    }
    return this.answer(res, opened, { rotateCsrf: true });
  }

  @Post("refresh")
  @HttpCode(200)
  @OpenApiOperation("refreshSession")
  async refresh(
    @OpenApiInput() input: ValidatedInput<"refreshSession">,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSessionResult | AuthSessionInfo> {
    res.setHeader("Cache-Control", AUTH_CACHE_CONTROL);
    const edge = this.cookies.isEdge();
    const bodyToken = input.body?.refreshToken;
    let token: string | undefined;
    if (edge) {
      if (bodyToken !== undefined) {
        // OADR-0006 point 5: the storefront's JavaScript never holds a refresh token; the cookie is the only source.
        throw new AppError("INVALID_REQUEST", { details: { reason: "refresh_token_in_body" } });
      }
      token = refreshCookieOf(req.cookies);
    } else {
      if (bodyToken === undefined) {
        throw new AppError("VALIDATION_FAILED", {
          fieldErrors: [
            { path: "/refreshToken", code: "required", message: "refreshToken is required with an API key" },
          ],
        });
      }
      token = bodyToken;
    }
    let refreshed: SessionWithTokens;
    try {
      if (token === undefined) {
        throw new AppError("REFRESH_TOKEN_INVALID");
      }
      refreshed = await this.sessions.refreshSession(token);
    } catch (error) {
      if (edge && isAppError(error) && ENDED_SESSION_CODES.has(error.code)) {
        this.cookies.clearSession(res);
      }
      throw error;
    }
    // OADR-0006 point 2: a refresh rotates the session cookies, not the CSRF value.
    return this.answer(res, refreshed, { rotateCsrf: false });
  }

  @Post("sign-out")
  @HttpCode(204)
  @OpenApiOperation("signOut")
  async signOut(
    @OpenApiInput() input: ValidatedInput<"signOut">,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    res.setHeader("Cache-Control", AUTH_CACHE_CONTROL);
    const principal = this.customers.get();
    // api-changes §2.2: in edge mode the refresh token comes from the cookie; a body token is not read.
    const refreshToken = this.cookies.isEdge() ? refreshCookieOf(req.cookies) : input.body?.refreshToken;
    if (principal === undefined && refreshToken === undefined && this.customers.presentedExpiredToken()) {
      // The access token expired and no refresh token came with it: refresh, then sign out with the new token.
      throw new AppError("TOKEN_EXPIRED");
    }
    await this.sessions.signOut({ scope: input.body?.scope ?? "current", principal, refreshToken });
    this.cookies.clearSession(res);
  }

  @Get("session")
  @OpenApiOperation("getSession")
  async getSession(@Res({ passthrough: true }) res: Response): Promise<AuthSessionInfo> {
    res.setHeader("Cache-Control", SESSION_CACHE_CONTROL);
    // The customer guard requires the access token on this operation.
    const principal = this.customers.require();
    const view = await this.sessions.current(principal);
    return toAuthSessionInfo(view.customer, view.details, principal.accessTokenExpiresAt);
  }

  /**
   * The answer of a session with new tokens: in edge mode the tokens go into cookies and the body is
   * `AuthSessionInfo`; for key callers the body is `AuthSessionResult` with the tokens.
   */
  private answer(
    res: Response,
    session: SessionWithTokens,
    options: SetSessionOptions,
  ): AuthSessionResult | AuthSessionInfo {
    if (this.cookies.setSession(res, session.tokens, options)) {
      return toAuthSessionInfo(session.customer, session.details, session.tokens.accessTokenExpiresAt);
    }
    return toAuthSessionResult(session.tokens, session.customer);
  }

  /**
   * The end user's user agent (`AuthSessionDetails.userAgent`): a secret key's `X-Velexis-End-User-Agent` (its server
   * calls for the visitor), else the request's own `User-Agent` (the edge forwards the browser's; a publishable key's
   * calls come from the browser itself).
   */
  private endUserAgent(req: Request, forwarded: string | undefined): string | undefined {
    const caller = this.callers.get();
    if (
      caller?.type === "key" &&
      caller.kind === "secret" &&
      forwarded !== undefined &&
      forwarded.trim() !== ""
    ) {
      return forwarded;
    }
    return req.headers["user-agent"];
  }
}
