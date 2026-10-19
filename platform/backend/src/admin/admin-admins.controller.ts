// Platform admins in the platform admin (PBE-032; platform/docs/api-inventory-admin.md §7, flows/platform-admin-
// operations.md §H, PADR-0006 "Access" items 4 to 6, scope PF-86): list, grant and revoke under `/v1/admin/admins`.
// Every operation is `x-scope: platform_admin` (AdminAuthGuard); the grant and the revocation need a TOTP step-up
// (`x-mfa-step-up`, RecentMfaGuard), and the grant a `reason` (the validation interceptor). Thin: each handler binds
// its operation, reads the validated request and makes one AdminAccountsService call.
import { Controller, Delete, Get, HttpCode, Post } from "@nestjs/common";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import {
  AdminAccountsService,
  type GrantAdminRequest,
  type PlatformAdmin,
  type PlatformAdminList,
} from "./admin-accounts.service";

type RequestParameters = Readonly<Record<string, unknown>>;

@Controller("v1/admin/admins")
export class AdminAdminsController {
  constructor(private readonly accounts: AdminAccountsService) {}

  @Get()
  @OpenApiOperation("adminListAdmins")
  adminListAdmins(): Promise<PlatformAdminList> {
    return this.accounts.listAdmins();
  }

  @Post()
  @HttpCode(201)
  @OpenApiOperation("adminGrantAdmin")
  adminGrantAdmin(
    @AccessToken() token: AccessTokenClaims,
    @Validated("body") body: GrantAdminRequest,
  ): Promise<PlatformAdmin> {
    return this.accounts.grantAdmin(token, body);
  }

  /** `204`; the optional `reason` of the query goes into the audit row. */
  @Delete(":accountId")
  @HttpCode(204)
  @OpenApiOperation("adminRevokeAdmin")
  adminRevokeAdmin(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("query") query: RequestParameters,
  ): Promise<void> {
    return this.accounts.revokeAdmin(
      token,
      path["accountId"] as string,
      query["reason"] as string | undefined,
    );
  }
}
