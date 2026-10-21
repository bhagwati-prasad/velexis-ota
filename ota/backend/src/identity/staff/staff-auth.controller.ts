// The staff-session operations of the console (`x-scope: console`, `x-permission: none`; OBE-059): thin handlers over
// StaffAuthService. The global guards resolved the caller (a secret key not scoped `storefront`; the OTA admin's
// service key joins with OBE-060), the tenant and the console scope, the staff guard read the access token where the
// operation takes one (required on console.auth.me, optional on console.auth.signOut), the rate limits counted the
// request (console.auth.signIn: 10 per minute per end-user IP), the validation interceptor checked the input and the
// idempotency interceptor stores each POST's answer under its `Idempotency-Key` (encrypted, it carries tokens; the
// refused password grant without its password).
//
// The staff member's user agent is a secret key's `X-Velexis-End-User-Agent` (its server calls for the staff member),
// else the request's own `User-Agent`; the IP is the end-user IP of the rate limits (rate-limits.ts). Every answer is
// `Cache-Control: no-store` (`private, no-store` for console.auth.me).
import { Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import type { Request, Response } from "express";
import { StaffContext } from "../../common/auth/staff.guard";
import { connectionIp, endUserIp } from "../../common/http/rate-limits";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../../common/http/openapi-operation.decorator";
import { CallerContext } from "../../tenancy/caller-resolver";
import { storedUserAgent } from "../sessions.service";
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
    private readonly callers: CallerContext,
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
    return this.auth.signIn({
      body: input.body,
      userAgent: this.endUserAgent(req, input.headers["X-Velexis-End-User-Agent"]),
      ip: this.endUserIp(req),
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
    if (principal === undefined && refreshToken === undefined && this.staff.presentedExpiredToken()) {
      // The access token expired and no refresh token came with it: refresh, then sign out with the new token.
      throw new AppError("TOKEN_EXPIRED");
    }
    await this.auth.signOut({
      scope: input.body?.scope ?? "current",
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

  /** The staff member's user agent: a secret key's `X-Velexis-End-User-Agent`, else the request's `User-Agent`. */
  private endUserAgent(req: Request, forwarded: string | undefined): string | null {
    const caller = this.callers.get();
    const secretKey = caller?.type === "key" && caller.kind === "secret";
    const value =
      secretKey && forwarded !== undefined && forwarded.trim() !== "" ? forwarded : req.headers["user-agent"];
    return storedUserAgent(value);
  }

  /** The staff member's IP: the end-user IP the rate limits count (a secret key's valid forwarded one). */
  private endUserIp(req: Request): string {
    const caller = this.callers.get();
    return caller === undefined ? connectionIp(req) : endUserIp(req, caller);
  }
}
