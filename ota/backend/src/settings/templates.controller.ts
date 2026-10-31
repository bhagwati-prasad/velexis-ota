// console.settings.templates.list, get, put, preview and reset (consoleListNotificationTemplates,
// consoleGetNotificationTemplate, consolePutNotificationTemplate, consolePreviewNotificationTemplate,
// consoleResetNotificationTemplate; `x-scope: console`, `x-permission: settings:read` / `settings:write`; OBE-073):
// thin handlers over TemplateSettingsService. The global guards resolved the caller, the tenant, the staff member, the
// rate limits and the permission (OADR-0011 points 3 to 6), and the validation interceptor checked the input against
// the OTA document (the key, the `email` channel and the locale of the path, the bodies). Preview and reset are POSTs
// that are safe to repeat (`x-idempotent-by-design`): no `Idempotency-Key`, and `200`. Every answer is `Cache-Control:
// private, no-store`; a customised template (get, put) carries `ETag: "<version>"`, a code default (get, reset) none,
// not even the weak one Express would generate (`withoutGeneratedEtag`).
import { Controller, Get, HttpCode, Post, Put, Res } from "@nestjs/common";
import type { OtaOperationId } from "@velexis/api-types/operations";
import type { Response } from "express";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import type { TemplateKey } from "../notifications/templates/registry";
import {
  templateEtagOf,
  TEMPLATES_CACHE_CONTROL,
  TemplateSettingsService,
  type ConsoleNotificationTemplate,
  type NotificationTemplateList,
  type NotificationTemplatePreview,
  type TemplateAddress,
} from "./templates.service";

/** The operations whose path names one template. */
type TemplateOperation =
  | "consoleGetNotificationTemplate"
  | "consolePutNotificationTemplate"
  | "consolePreviewNotificationTemplate"
  | "consoleResetNotificationTemplate";

/** The template the path names (the schema's key enum is the registry's, which the assignment checks). */
function addressOf(input: ValidatedInput<TemplateOperation>): TemplateAddress {
  const key: TemplateKey = input.path.templateKey;
  return { key, channel: input.path.channel, locale: input.path.locale };
}

/** The validated body of an operation; the validation interceptor refuses a request without one, never reached. */
function bodyOf<B>(operationId: OtaOperationId, body: B | undefined): B {
  if (body === undefined) {
    throw new Error(`${operationId} without a validated body`);
  }
  return body;
}

/**
 * Keeps Express' automatic weak `ETag` (its `etag` setting, applied by `res.send` to an answer without one) off this
 * answer: a code default has no version, and a client that took a generated ETag for one would send it as `If-Match`
 * to put, which a template without a row refuses (`412`). Only this response's `setHeader` is shadowed, for `ETag`.
 */
function withoutGeneratedEtag(res: Response): void {
  const setHeader = res.setHeader.bind(res);
  const shadow = (name: string, value: number | string | readonly string[]): Response =>
    name.toLowerCase() === "etag" ? res : setHeader(name, value);
  res.setHeader = shadow as Response["setHeader"];
}

/** The headers of an answer with one template: its `ETag` when it is the OTA's row, none for a code default. */
function answer(res: Response, template: ConsoleNotificationTemplate): ConsoleNotificationTemplate {
  if (template.version === null) {
    withoutGeneratedEtag(res);
  } else {
    res.setHeader("ETag", templateEtagOf(template.version));
  }
  res.setHeader("Cache-Control", TEMPLATES_CACHE_CONTROL);
  return template;
}

@Controller("v1/console/settings/notification-templates")
export class NotificationTemplatesController {
  constructor(private readonly templates: TemplateSettingsService) {}

  @Get()
  @OpenApiOperation("consoleListNotificationTemplates")
  async list(@Res({ passthrough: true }) res: Response): Promise<NotificationTemplateList> {
    res.setHeader("Cache-Control", TEMPLATES_CACHE_CONTROL);
    return await this.templates.list();
  }

  @Get(":templateKey/:channel/:locale")
  @OpenApiOperation("consoleGetNotificationTemplate")
  async get(
    @OpenApiInput() input: ValidatedInput<"consoleGetNotificationTemplate">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsoleNotificationTemplate> {
    return answer(res, await this.templates.get(addressOf(input)));
  }

  @Put(":templateKey/:channel/:locale")
  @OpenApiOperation("consolePutNotificationTemplate")
  async put(
    @OpenApiInput() input: ValidatedInput<"consolePutNotificationTemplate">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsoleNotificationTemplate> {
    const template = await this.templates.put(
      addressOf(input),
      bodyOf("consolePutNotificationTemplate", input.body),
      input.headers["If-Match"],
    );
    return answer(res, template);
  }

  @Post(":templateKey/:channel/:locale/preview")
  @HttpCode(200)
  @OpenApiOperation("consolePreviewNotificationTemplate")
  async preview(
    @OpenApiInput() input: ValidatedInput<"consolePreviewNotificationTemplate">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NotificationTemplatePreview> {
    res.setHeader("Cache-Control", TEMPLATES_CACHE_CONTROL);
    return await this.templates.preview(addressOf(input), input.body);
  }

  @Post(":templateKey/:channel/:locale/reset")
  @HttpCode(200)
  @OpenApiOperation("consoleResetNotificationTemplate")
  async reset(
    @OpenApiInput() input: ValidatedInput<"consoleResetNotificationTemplate">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsoleNotificationTemplate> {
    return answer(res, await this.templates.reset(addressOf(input)));
  }
}
