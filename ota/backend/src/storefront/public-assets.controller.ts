// The public image URL of the storefront assets, `GET /v1/assets/{tenantKey}/{assetId}.{ext}` (getPublicAsset;
// `security: []`, `x-sdk-exclude`; OBE-071, OADR-0012 point 3, api-changes part 2 §4.2): what storefront.get's logo,
// favicon and Open Graph URLs, the page images and the console's `StorefrontAsset.url` point at. The hosted storefront
// loads it same-origin as `/api/v1/assets/…` (Caddy adds the edge header, so `img-src 'self'` of ADR-0018 holds); key
// callers get the absolute `PUBLIC_OTA_API_URL` URL. A thin handler over AssetsService.publicFile, which the settings
// module provides and this controller's module registers (SettingsModule: the uploads are its own).
//
// The route is public (`@PublicRoute()`): a browser loads the image without a credential, and one that comes with it is
// classified by the caller guard as on any route (a wrong key is refused) but neither chooses nor refuses the OTA: the
// tenant guard leaves this operation alone, the path's tenant key decides, and a suspended OTA's images are served
// (its maintenance page shows its logo). The rate limit (120 per minute per IP, `publicDownloads` of rate-limits.ts,
// shared with the document downloads) ran before.
//
// The answer is the file as uploaded with the type sniffed at upload, `Cache-Control: public, max-age=31536000,
// immutable` (an asset id never changes content), `X-Content-Type-Options: nosniff`, `Content-Security-Policy:
// default-src 'none'` and `Content-Disposition: inline`, so a file opened directly runs nothing, and
// `Cross-Origin-Resource-Policy: cross-origin` over helmet's `same-origin`, so a key caller's own site can show it.
// The headers are set only once the file is found: an error is never cached as the image.
import { Controller, Get, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";
import { PublicRoute } from "../common/auth/caller.guard";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import { AssetsService } from "../settings/assets.service";

/** The `Cache-Control` of an image: its URL never changes content (a new image is a new asset). */
export const PUBLIC_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** The `Content-Security-Policy` of an image opened directly: nothing may load or run. */
export const PUBLIC_ASSET_CSP = "default-src 'none'";

@Controller("v1/assets")
@PublicRoute()
export class PublicAssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get(":tenantKey/:assetId.:ext")
  @OpenApiOperation("getPublicAsset")
  async get(
    @OpenApiInput() input: ValidatedInput<"getPublicAsset">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { tenantKey, assetId, ext } = input.path;
    const file = await this.assets.publicFile(tenantKey, assetId, ext);
    res.setHeader("Cache-Control", PUBLIC_ASSET_CACHE_CONTROL);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", PUBLIC_ASSET_CSP);
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    return new StreamableFile(file.bytes, {
      type: file.contentType,
      disposition: "inline",
      length: file.bytes.length,
    });
  }
}
