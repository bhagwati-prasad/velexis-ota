// The API key routes of the portal (platform/docs/api-inventory-resources.md §1, PBE-021): list, create, rename or
// change origins, roll and revoke. Thin: each handler binds its operation, reads the validated request and makes one
// service call. Owners and admins only (`manageApiKeys` of the role matrix); TenantRoleGuard answers `404` to
// non-members before the handler runs. The answers of create and roll carry the full key once, so they are sent with
// `Cache-Control: no-store`, which also keeps them out of the idempotency store; nothing here logs a body.
import { Controller, Get, HttpCode, Patch, Post, Res } from "@nestjs/common";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { CurrentMembership, TenantRoles, type TenantMembership } from "../common/auth/tenant-role.guard";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import { tenantRolesOf } from "../memberships/tenant-roles";
import {
  ApiKeysService,
  type ApiKey,
  type ApiKeyCreated,
  type ApiKeyList,
  type ApiKeyRolled,
  type CreateApiKeyRequest,
  type ListApiKeysQuery,
  type RollApiKeyRequest,
  type UpdateApiKeyRequest,
} from "./api-keys.service";

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

/** The answers that hold a key shown once are never cached (PADR-0005 item 4). */
function noStore(res: HeaderTarget): void {
  res.setHeader("Cache-Control", "no-store");
}

@Controller("v1/tenants/:tenantId/api-keys")
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  @OpenApiOperation("listApiKeys")
  @TenantRoles(...tenantRolesOf("listApiKeys"))
  listApiKeys(
    @CurrentMembership() membership: TenantMembership,
    @Validated("query") query: ListApiKeysQuery,
  ): Promise<ApiKeyList> {
    return this.apiKeys.list(membership, query);
  }

  @Post()
  @OpenApiOperation("createApiKey")
  @TenantRoles(...tenantRolesOf("createApiKey"))
  async createApiKey(
    @CurrentMembership() membership: TenantMembership,
    @AccessToken() token: AccessTokenClaims,
    @Validated("body") body: CreateApiKeyRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<ApiKeyCreated> {
    noStore(res);
    return this.apiKeys.create(membership, token, body);
  }

  @Patch(":keyId")
  @OpenApiOperation("updateApiKey")
  @TenantRoles(...tenantRolesOf("updateApiKey"))
  updateApiKey(
    @CurrentMembership() membership: TenantMembership,
    @Validated("path") path: Readonly<Record<string, unknown>>,
    @Validated("body") body: UpdateApiKeyRequest,
  ): Promise<ApiKey> {
    return this.apiKeys.update(membership, path["keyId"] as string, body);
  }

  @Post(":keyId/roll")
  @OpenApiOperation("rollApiKey")
  @TenantRoles(...tenantRolesOf("rollApiKey"))
  async rollApiKey(
    @CurrentMembership() membership: TenantMembership,
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: Readonly<Record<string, unknown>>,
    @Validated("body") body: RollApiKeyRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<ApiKeyRolled> {
    noStore(res);
    return this.apiKeys.roll(membership, token, path["keyId"] as string, body);
  }

  @Post(":keyId/revoke")
  @HttpCode(200)
  @OpenApiOperation("revokeApiKey")
  @TenantRoles(...tenantRolesOf("revokeApiKey"))
  revokeApiKey(
    @CurrentMembership() membership: TenantMembership,
    @Validated("path") path: Readonly<Record<string, unknown>>,
  ): Promise<ApiKey> {
    return this.apiKeys.revoke(membership, path["keyId"] as string);
  }
}
