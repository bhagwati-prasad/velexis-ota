// console.settings.pages.list, create, get, update and delete (consoleListStorefrontPages, consoleCreateStorefrontPage,
// consoleGetStorefrontPage, consoleUpdateStorefrontPage, consoleDeleteStorefrontPage; `x-scope: console`,
// `x-permission: settings:read` / `settings:write`; OBE-072): thin handlers over PagesService. The global guards
// resolved the caller, the tenant, the staff member, the rate limits and the permission (OADR-0011 points 3 to 6), the
// validation interceptor checked the input against the OTA document (`If-Match` is required on update and delete), and
// the idempotency interceptor holds create's `Idempotency-Key`. Every answer is `Cache-Control: private, no-store`;
// get, create and update carry `ETag: "<version>"`, create `Location` too.
import { Controller, Delete, Get, HttpCode, Patch, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import {
  PAGES_CACHE_CONTROL,
  pageEtagOf,
  PagesService,
  type StorefrontPage,
  type StorefrontPagePage,
} from "./pages.service";

/** The path of the console's pages. */
const PAGES_PATH = "/v1/console/settings/pages";

/** The validated body of an operation; the validation interceptor refuses a request without one, never reached. */
function bodyOf<B>(operationId: string, body: B | undefined): B {
  if (body === undefined) {
    throw new Error(`${operationId} without a validated body`);
  }
  return body;
}

/** The headers of an answer with one page. */
function answer(res: Response, page: StorefrontPage): StorefrontPage {
  res.setHeader("ETag", pageEtagOf(page.version));
  res.setHeader("Cache-Control", PAGES_CACHE_CONTROL);
  return page;
}

@Controller("v1/console/settings/pages")
export class PagesController {
  constructor(private readonly pages: PagesService) {}

  @Get()
  @OpenApiOperation("consoleListStorefrontPages")
  async list(
    @OpenApiInput() input: ValidatedInput<"consoleListStorefrontPages">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StorefrontPagePage> {
    res.setHeader("Cache-Control", PAGES_CACHE_CONTROL);
    return await this.pages.list(input.query ?? {});
  }

  @Post()
  @OpenApiOperation("consoleCreateStorefrontPage")
  async create(
    @OpenApiInput() input: ValidatedInput<"consoleCreateStorefrontPage">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StorefrontPage> {
    const page = await this.pages.create(bodyOf("consoleCreateStorefrontPage", input.body));
    res.setHeader("Location", `${PAGES_PATH}/${page.id}`);
    return answer(res, page);
  }

  @Get(":pageId")
  @OpenApiOperation("consoleGetStorefrontPage")
  async get(
    @OpenApiInput() input: ValidatedInput<"consoleGetStorefrontPage">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StorefrontPage> {
    return answer(res, await this.pages.get(input.path.pageId));
  }

  @Patch(":pageId")
  @OpenApiOperation("consoleUpdateStorefrontPage")
  async update(
    @OpenApiInput() input: ValidatedInput<"consoleUpdateStorefrontPage">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StorefrontPage> {
    const page = await this.pages.update(
      input.path.pageId,
      bodyOf("consoleUpdateStorefrontPage", input.body),
      input.headers["If-Match"],
    );
    return answer(res, page);
  }

  @Delete(":pageId")
  @HttpCode(204)
  @OpenApiOperation("consoleDeleteStorefrontPage")
  async delete(
    @OpenApiInput() input: ValidatedInput<"consoleDeleteStorefrontPage">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    res.setHeader("Cache-Control", PAGES_CACHE_CONTROL);
    await this.pages.delete(input.path.pageId, input.headers["If-Match"]);
  }
}
