// The staff-session operations of the console (`x-scope: console`, `x-permission: none`; OBE-059): thin handlers over
// StaffAuthService. The global guards resolved the caller (a secret key not scoped `storefront`, or the OTA admin's
// service key, OBE-060), the tenant and the console scope, the staff guard read the access token where the operation
// takes one (required on console.auth.me, optional on console.auth.signOut), the rate limits counted the request
// (console.auth.signIn: 10 per minute per end-user IP), the validation interceptor checked the input and the
// idempotency interceptor stores each POST's answer under its `Idempotency-Key` (encrypted, it carries tokens; the
// refused password grant without its password).
//
// The staff member's IP and user agent are the request's end user, which the caller guard decided (OADR-0009 point 8):
// the OTA admin's forwarded `X-Velexis-End-User-IP` and `-Agent` for the service caller, a secret key's forwarded ones
// (its server calls for the staff member), else the connection's address and the request's own `User-Agent`. Every
// answer is `Cache-Control: no-store` (`private, no-store` for console.auth.me).
//
// The service caller's tenant is the one its credential names (tenant.guard.ts): a sign-in with a portal token, a
// refresh with a refresh token or a sign-out whose credentials name no tenant has none, and is answered as an unknown
// credential here: `401 PORTAL_TOKEN_INVALID` (the password grant still `403 FEATURE_DISABLED` first),
// `401 REFRESH_TOKEN_INVALID`, and for the sign-out the 204 of a refresh token no family issued (`scope: all`, or no
// credential at all, `401 UNAUTHENTICATED`).
import { Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import type { Request, Response } from "express";
import { cutUserAgent } from "../../common/auth/caller.guard";
import { StaffContext } from "../../common/auth/staff.guard";
import { connectionIp } from "../../common/http/rate-limits";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../../common/http/openapi-operation.decorator";
import { RequestContext } from "../../common/http/request-context";
import { TenantContext } from "../../tenancy/tenant-context";
import { StaffAuthService, type ConsoleStaffProfile, type ConsoleStaffSession } from "./staff-auth.service";

/** `Cache-Control` of sign-in, refresh and sign-out: they open, rotate or end a session. */
export const STAFF_AUTH_CACHE_CONTROL = "no-store";
/** `Cache-Control` of console.auth.me (the document: `private, no-store`). */
export const STAFF_PROFILE_CACHE_CONTROL = "private, no-store";

@Controller("v1/console/auth")
export class StaffAuthController {
  constructor(
    private readonly auth: StaffAuthService,
    private readonly staff: StaffContext,
    private readonly context: RequestContext,
    private readonly tenants: TenantContext,
  ) {}

  @Post("sign-in")
  @HttpCode(200)
  @OpenApiOperation("consoleSignIn")
  async signIn(
    @OpenApiInput() input: ValidatedInput<"consoleSignIn">,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsoleStaffSession> {
    if (input.body === undefined) {
      // The validation interceptor refuses a request without its required body; this is never reached.
      throw new Error("consoleSignIn without a validated body");
    }
    res.setHeader("Cache-Control", STAFF_AUTH_CACHE_CONTROL);
    if (input.body.grantType === "portal_token" && this.tenants.get() === undefined) {
      // The OTA admin's sign-in with a portal token the tenant guard did not find: unknown, used or expired.
      throw new AppError("PORTAL_TOKEN_INVALID");
    }
    const endUser = this.context.endUser();
    return this.auth.signIn({
      body: input.body,
      userAgent: endUser === undefined ? cutUserAgent(req.headers["user-agent"] ?? "") : endUser.userAgent,
      ip: endUser?.ip ?? connectionIp(req),
    });
  }

  @Post("refresh")
  @HttpCode(200)
  @OpenApiOperation("consoleRefreshSession")
  async refresh(
    @OpenApiInput() input: ValidatedInput<"consoleRefreshSession">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsoleStaffSession> {
    if (input.body === undefined) {
      throw new Error("consoleRefreshSession without a validated body");
    }
    res.setHeader("Cache-Control", STAFF_AUTH_CACHE_CONTROL);
    if (this.tenants.get() === undefined) {
      // The OTA admin's refresh with a refresh token that names no family.
      throw new AppError("REFRESH_TOKEN_INVALID");
    }
    return this.auth.refresh(input.body.refreshToken);
  }

  @Post("sign-out")
  @HttpCode(204)
  @OpenApiOperation("consoleSignOut")
  async signOut(
    @OpenApiInput() input: ValidatedInput<"consoleSignOut">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    res.setHeader("Cache-Control", STAFF_AUTH_CACHE_CONTROL);
    const principal = this.staff.get();
    const refreshToken = input.body?.refreshToken;
    const scope = input.body?.scope ?? "current";
    if (this.tenants.get() === undefined) {
      // The OTA admin's sign-out whose credentials name no tenant (the staff guard refused any access token): a
      // refresh token no family issued ends nothing.
      if (refreshToken === undefined || scope === "all") {
        throw new AppError("UNAUTHENTICATED");
      }
      return;
    }
    if (principal === undefined && refreshToken === undefined && this.staff.presentedExpiredToken()) {
      // The access token expired and no refresh token came with it: refresh, then sign out with the new token.
      throw new AppError("TOKEN_EXPIRED");
    }
    await this.auth.signOut({
      scope,
      principal,
      refreshToken,
      endedSession: this.staff.endedSession(),
    });
  }

  @Get("me")
  @OpenApiOperation("consoleGetMe")
  async me(@Res({ passthrough: true }) res: Response): Promise<ConsoleStaffProfile> {
    res.setHeader("Cache-Control", STAFF_PROFILE_CACHE_CONTROL);
    // The staff guard requires the access token on this operation.
    return this.auth.me(this.staff.require());
  }
}
