// console.settings.storefront.get and update (consoleGetStorefrontSettings, consoleUpdateStorefrontSettings;
// `x-scope: console`, `x-permission: settings:read` / `settings:write`; OBE-070): thin handlers over
// StorefrontSettingsService. The global guards resolved the caller, the tenant, the staff member, the rate limits and
// the permission (OADR-0011 points 3 to 6), the validation interceptor checked the input against the OTA document
// (`If-Match` is required on update). Both answers carry `ETag: "<version>"` and `Cache-Control: private, no-store`.
import { Controller, Get, Patch, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import {
  settingsEtagOf,
  STOREFRONT_SETTINGS_CACHE_CONTROL,
  type StorefrontSettings,
  type StorefrontSettingsUpdateResult,
} from "./storefront-settings.mapper";
import { StorefrontSettingsService } from "./storefront-settings.service";

/** The validated body of an operation; the validation interceptor refuses a request without one, never reached. */
function bodyOf<B>(operationId: string, body: B | undefined): B {
  if (body === undefined) {
    throw new Error(`${operationId} without a validated body`);
  }
  return body;
}

/** The headers of both answers. */
function answer<T extends StorefrontSettings>(res: Response, settings: T): T {
  res.setHeader("ETag", settingsEtagOf(settings.version));
  res.setHeader("Cache-Control", STOREFRONT_SETTINGS_CACHE_CONTROL);
  return settings;
}

@Controller("v1/console/settings/storefront")
export class StorefrontSettingsController {
  constructor(private readonly settings: StorefrontSettingsService) {}

  @Get()
  @OpenApiOperation("consoleGetStorefrontSettings")
  async get(@Res({ passthrough: true }) res: Response): Promise<StorefrontSettings> {
    return answer(res, await this.settings.get());
  }

  @Patch()
  @OpenApiOperation("consoleUpdateStorefrontSettings")
  async update(
    @OpenApiInput() input: ValidatedInput<"consoleUpdateStorefrontSettings">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StorefrontSettingsUpdateResult> {
    const result = await this.settings.update(
      bodyOf("consoleUpdateStorefrontSettings", input.body),
      input.headers["If-Match"],
    );
    return answer(res, result);
  }
}
