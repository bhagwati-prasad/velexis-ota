// storefront.listPages and storefront.getPage (listStorefrontPages, getStorefrontPage; `x-scope: both`; OBE-072,
// api-changes part 2 §4.1): the published content pages for the hosted storefront's edge and for key callers, with the
// tenant resolved by the global guards. Thin handlers over PublicPagesService (public-pages.service.ts), which reads
// the pages through the storefront context's own `TenantTx`: nothing here imports the settings context (lead decision
// (2a) of 2026-10-30).
//
// Headers as storefront.get's (storefront.controller.ts): the edge's answers are `Cache-Control: private` (only the
// image URLs differ by caller, and the edge's are its own origin's), key callers may keep them for a minute
// (`public, max-age=60, stale-while-revalidate=600`); both vary by `Accept-Language`, key answers also by the key. The
// error filter replaces `Cache-Control` with `no-store` on errors, so a `404` is never kept. Reads only: no cookie, no
// CSRF check.
import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import { CookieWriter } from "../common/http/cookie-writer";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import {
  PublicPagesService,
  type StorefrontPageContent,
  type StorefrontPageList,
} from "./public-pages.service";
import { EDGE_CACHE_CONTROL, KEY_CACHE_CONTROL } from "./storefront.controller";

@Controller("v1/storefront/pages")
export class PublicPagesController {
  constructor(
    private readonly pages: PublicPagesService,
    private readonly cookies: CookieWriter,
  ) {}

  @Get()
  @OpenApiOperation("listStorefrontPages")
  async list(
    @OpenApiInput() input: ValidatedInput<"listStorefrontPages">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StorefrontPageList> {
    const list = await this.pages.list(input.query?.locale, input.headers?.["Accept-Language"]);
    this.cacheHeaders(res);
    return list;
  }

  @Get(":slug")
  @OpenApiOperation("getStorefrontPage")
  async get(
    @OpenApiInput() input: ValidatedInput<"getStorefrontPage">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StorefrontPageContent> {
    const page = await this.pages.page(
      input.path.slug,
      input.query?.locale,
      input.headers?.["Accept-Language"],
      this.cookies.isEdge() ? "edge" : "key",
    );
    this.cacheHeaders(res);
    return page;
  }

  private cacheHeaders(res: Response): void {
    if (this.cookies.isEdge()) {
      res.setHeader("Cache-Control", EDGE_CACHE_CONTROL);
      res.vary("Accept-Language");
    } else {
      res.setHeader("Cache-Control", KEY_CACHE_CONTROL);
      // Appended, so a `Vary` an earlier layer set (for example `Origin` for CORS) is kept for shared caches.
      res.vary("Accept-Language").vary("X-Api-Key");
    }
  }
}
