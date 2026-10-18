// The signed-in account's routes under `/v1/me` (platform/docs/api-inventory.md §5, `AccountsModule`; PBE-016): the
// account and its profile, the password change, and the session list with the revocation of one session. The MFA
// settings under `/v1/me/mfa` have a controller of their own (PBE-015). Thin: each handler binds its operation, reads
// the caller's access token (`sub` is the account, `sid` its family) and the validated input, and makes one service
// call. getMe, updateMe, listSessions and revokeSession are `portal_unverified` (an account that waits for its
// verification may use them, PADR-0008 item 2), changePassword `portal`.
//
// getMe and updateMe answer the account's version in `ETag`; updateMe takes it back in `If-Match`.
import { Controller, Delete, Get, HttpCode, Patch, Post, Res } from "@nestjs/common";
import type { ChangePasswordRequest } from "../auth/password-reset.service";
import type { Account } from "../auth/sessions.service";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { etagOf, versionOfIfMatch } from "../common/http/if-match";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import type { AccountSessionList, UpdateMeRequest } from "./accounts.mapper";
import { AccountsService } from "./accounts.service";

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

@Controller("v1/me")
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @OpenApiOperation("getMe")
  async getMe(
    @AccessToken() token: AccessTokenClaims,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<Account> {
    const account = await this.accounts.getMe(token.sub);
    res.setHeader("ETag", etagOf(account.version));
    return account;
  }

  @Patch()
  @OpenApiOperation("updateMe")
  async updateMe(
    @AccessToken() token: AccessTokenClaims,
    @Validated("header") header: Readonly<Record<string, unknown>>,
    @Validated("body") body: UpdateMeRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<Account> {
    const account = await this.accounts.updateMe(
      token.sub,
      versionOfIfMatch(header["if-match"] as string),
      body,
    );
    res.setHeader("ETag", etagOf(account.version));
    return account;
  }

  /** `204`: the password is changed and every other session of the account is revoked. */
  @Post("password")
  @HttpCode(204)
  @OpenApiOperation("changePassword")
  changePassword(
    @AccessToken() token: AccessTokenClaims,
    @Validated("body") body: ChangePasswordRequest,
  ): Promise<void> {
    return this.accounts.changePassword(token.sub, token.sid, body);
  }

  @Get("sessions")
  @OpenApiOperation("listSessions")
  listSessions(@AccessToken() token: AccessTokenClaims): Promise<AccountSessionList> {
    return this.accounts.listSessions(token.sub, token.sid);
  }

  @Delete("sessions/:familyId")
  @HttpCode(204)
  @OpenApiOperation("revokeSession")
  revokeSession(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    return this.accounts.revokeSession(token.sub, path["familyId"] as string);
  }
}
