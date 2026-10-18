// The MFA settings of the signed-in account (PBE-015; platform/docs/api-inventory.md §5, scope PF-04, PADR-0008):
// startMfaSetup and enableMfa (`portal_unverified`), disableMfa and regenerateRecoveryCodes (`portal` with
// `x-mfa-step-up`, which RecentMfaGuard enforces before the handler runs). Thin: each handler binds its operation,
// reads the caller's access token and the validated body and makes one MfaService call. The answers that carry the
// TOTP secret or recovery codes are sent with `Cache-Control: no-store`, so no cache keeps them and the idempotency
// interceptor never stores them. Nothing here logs a body.
import { Controller, HttpCode, Post, Res } from "@nestjs/common";
import type { TotpCodeRequest } from "../auth/mfa-challenge.store";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import { MfaService, type MfaSetup, type RecoveryCodes } from "./mfa.service";

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

/** Secrets shown once are never stored by a cache (api-inventory §2). */
function noStore(res: HeaderTarget): void {
  res.setHeader("Cache-Control", "no-store");
}

@Controller("v1/me/mfa")
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  /** A pending TOTP secret and its `otpauth://` URI, for 10 minutes. */
  @Post("setup")
  @HttpCode(200)
  @OpenApiOperation("startMfaSetup")
  startMfaSetup(
    @AccessToken() token: AccessTokenClaims,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<MfaSetup> {
    noStore(res);
    return this.mfa.startSetup(token.sub);
  }

  /** MFA on; the ten recovery codes, shown once. */
  @Post("enable")
  @HttpCode(200)
  @OpenApiOperation("enableMfa")
  enableMfa(
    @AccessToken() token: AccessTokenClaims,
    @Validated("body") body: TotpCodeRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<RecoveryCodes> {
    noStore(res);
    return this.mfa.enable(token.sub, body);
  }

  /** MFA off (never for a platform admin). */
  @Post("disable")
  @HttpCode(204)
  @OpenApiOperation("disableMfa")
  disableMfa(@AccessToken() token: AccessTokenClaims): Promise<void> {
    return this.mfa.disable(token.sub);
  }

  /** Ten new recovery codes, shown once; the earlier ones stop working. */
  @Post("recovery-codes")
  @HttpCode(200)
  @OpenApiOperation("regenerateRecoveryCodes")
  regenerateRecoveryCodes(
    @AccessToken() token: AccessTokenClaims,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<RecoveryCodes> {
    noStore(res);
    return this.mfa.regenerateRecoveryCodes(token.sub);
  }
}
