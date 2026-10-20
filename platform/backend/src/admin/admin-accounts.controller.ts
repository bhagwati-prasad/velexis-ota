// Account support in the platform admin (PBE-032; platform/docs/api-inventory-admin.md §7, flows/platform-admin-
// operations.md §H, scope PF-87): search, detail, disable, enable, unlock and the MFA reset of an account, under
// `/v1/admin/accounts`. Every operation is `x-scope: platform_admin`, so AdminAuthGuard has checked the admin token and
// re-read the account; RecentMfaGuard adds the step-up of `adminResetAccountMfa` (`x-mfa-step-up`), and the validation
// interceptor the `reason` of 5–500 characters where the document requires it. Thin: each handler binds its
// operation, reads the validated request and makes one AdminAccountsService call.
import { Controller, Get, HttpCode, Post } from "@nestjs/common";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import {
  AdminAccountsService,
  type AdminAccount,
  type AdminAccountDetail,
  type AdminAccountList,
  type AdminReasonRequest,
  type ListAccountsQuery,
} from "./admin-accounts.service";

type RequestParameters = Readonly<Record<string, unknown>>;

@Controller("v1/admin/accounts")
export class AdminAccountsController {
  constructor(private readonly accounts: AdminAccountsService) {}

  @Get()
  @OpenApiOperation("adminListAccounts")
  adminListAccounts(@Validated("query") query: ListAccountsQuery): Promise<AdminAccountList> {
    return this.accounts.list(query);
  }

  @Get(":accountId")
  @OpenApiOperation("adminGetAccount")
  adminGetAccount(@Validated("path") path: RequestParameters): Promise<AdminAccountDetail> {
    return this.accounts.get(path["accountId"] as string);
  }

  @Post(":accountId/disable")
  @HttpCode(200)
  @OpenApiOperation("adminDisableAccount")
  adminDisableAccount(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("body") body: AdminReasonRequest,
  ): Promise<AdminAccount> {
    return this.accounts.disable(token, path["accountId"] as string, body);
  }

  @Post(":accountId/enable")
  @HttpCode(200)
  @OpenApiOperation("adminEnableAccount")
  adminEnableAccount(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("body") body: AdminReasonRequest,
  ): Promise<AdminAccount> {
    return this.accounts.enable(token, path["accountId"] as string, body);
  }

  @Post(":accountId/unlock")
  @HttpCode(200)
  @OpenApiOperation("adminUnlockAccount")
  adminUnlockAccount(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
  ): Promise<AdminAccount> {
    return this.accounts.unlock(token, path["accountId"] as string);
  }

  @Post(":accountId/reset-mfa")
  @HttpCode(200)
  @OpenApiOperation("adminResetAccountMfa")
  adminResetAccountMfa(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("body") body: AdminReasonRequest,
  ): Promise<AdminAccount> {
    return this.accounts.resetMfa(token, path["accountId"] as string, body);
  }
}
