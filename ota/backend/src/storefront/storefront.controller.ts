// `storefront.get` (getStorefront, `x-scope: both`; OBE-016): the storefront bootstrap configuration for the hosted
// storefront's edge and for key callers, with the tenant resolved by the global guards.
//
// Edge mode (OADR-0006, api-changes §2.2): the response sets the double-submit CSRF cookie `__Host-vx_csrf` (256 random
// bits, base64url, readable by the storefront's JavaScript) when the request has none or a malformed one, and says
// `Cache-Control: private`. Key callers never get a cookie and may cache the answer publicly for a minute
// (`public, max-age=60, stale-while-revalidate=600`). Both vary by `Accept-Language`, key answers also by the key.
// Express adds a weak `ETag` of the body and answers `304` to a matching `If-None-Match` (the cookie still set); the
// error filter replaces `Cache-Control` with `no-store` on errors.
import { Controller, Get, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { CookieWriter, isWellFormedCsrfValue, newCsrfValue } from "../common/http/cookie-writer";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import { CSRF_COOKIE } from "../common/auth/csrf.guard";
import type { StorefrontConfig } from "./storefront.mapper";
import { StorefrontService } from "./storefront.service";

/** `Cache-Control` of a key caller's answer (the document's getStorefront). */
export const KEY_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=600";
/** `Cache-Control` of the edge's answer: it sets a cookie and is the visitor's own. */
export const EDGE_CACHE_CONTROL = "private";

@Controller("v1/storefront")
export class StorefrontController {
  constructor(
    private readonly storefront: StorefrontService,
    private readonly cookies: CookieWriter,
  ) {}

  @Get()
  @OpenApiOperation("getStorefront")
  async get(
    @OpenApiInput() input: ValidatedInput<"getStorefront">,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StorefrontConfig> {
    const edge = this.cookies.isEdge();
    const config = await this.storefront.get(edge ? "edge" : "key", input.headers?.["Accept-Language"]);
    if (edge) {
      const cookies: unknown = req.cookies;
      const current =
        typeof cookies === "object" && cookies !== null
          ? (cookies as Record<string, unknown>)[CSRF_COOKIE]
          : undefined;
      if (!isWellFormedCsrfValue(current)) {
        this.cookies.write(res, "csrf", newCsrfValue());
      }
      res.setHeader("Cache-Control", EDGE_CACHE_CONTROL);
      res.vary("Accept-Language");
    } else {
      res.setHeader("Cache-Control", KEY_CACHE_CONTROL);
      // Appended, so a `Vary` an earlier layer set (for example `Origin` for CORS) is kept for shared caches.
      res.vary("Accept-Language").vary("X-Api-Key");
    }
    return config;
  }
}
