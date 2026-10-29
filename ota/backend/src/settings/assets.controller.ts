// console.settings.assets.list, upload and delete (consoleListStorefrontAssets, consoleUploadStorefrontAsset,
// consoleDeleteStorefrontAsset; `x-scope: console`, `x-permission: settings:read` / `settings:write`; OBE-071): thin
// handlers over AssetsService. The global guards resolved the caller, the tenant, the staff member, the rate limits and
// the permission (OADR-0011 points 3 to 6); the validation interceptor checked the parameters against the OTA document
// and passed the upload's parts on as its body (the body parsers read the `multipart/form-data` body on this route
// only, body-parsers.ts), and the idempotency interceptor holds the upload's `Idempotency-Key`. Every answer is
// `Cache-Control: private, no-store`: the upload `201` with the asset, the delete `204`.
import { Controller, Delete, Get, HttpCode, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import {
  ASSETS_CACHE_CONTROL,
  AssetsService,
  type StorefrontAsset,
  type StorefrontAssetPage,
} from "./assets.service";

@Controller("v1/console/settings/assets")
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  @OpenApiOperation("consoleListStorefrontAssets")
  async list(
    @OpenApiInput() input: ValidatedInput<"consoleListStorefrontAssets">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StorefrontAssetPage> {
    res.setHeader("Cache-Control", ASSETS_CACHE_CONTROL);
    return await this.assets.list(input.query ?? {});
  }

  @Post()
  @OpenApiOperation("consoleUploadStorefrontAsset")
  async upload(
    @OpenApiInput() input: ValidatedInput<"consoleUploadStorefrontAsset">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StorefrontAsset> {
    res.setHeader("Cache-Control", ASSETS_CACHE_CONTROL);
    // The multipart body is no JSON body of the document's types: the parts as the body parsers read them.
    const { body }: { readonly body: unknown } = input;
    return await this.assets.upload(body);
  }

  @Delete(":assetId")
  @HttpCode(204)
  @OpenApiOperation("consoleDeleteStorefrontAsset")
  async delete(
    @OpenApiInput() input: ValidatedInput<"consoleDeleteStorefrontAsset">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    res.setHeader("Cache-Control", ASSETS_CACHE_CONTROL);
    await this.assets.delete(input.path.assetId);
  }
}
