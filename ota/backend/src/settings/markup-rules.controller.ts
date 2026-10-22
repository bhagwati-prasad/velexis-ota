// console.settings.markupRules.list, create, get, update and delete (consoleListMarkupRules, consoleCreateMarkupRule,
// consoleGetMarkupRule, consoleUpdateMarkupRule, consoleDeleteMarkupRule; `x-scope: console`, `x-permission:
// settings:read` / `settings:write`; OBE-069): thin handlers over PricingRulesService. The global guards resolved the
// caller, the tenant, the staff member, the rate limits and the permission (OADR-0011 points 3 to 6), the validation
// interceptor checked the input against the OTA document (`If-Match` is required on update and delete), and the
// idempotency interceptor holds create's `Idempotency-Key`. Every answer is `Cache-Control: private, no-store`; get,
// create and update carry `ETag: "<version>"`, create `Location` too.
import { Controller, Delete, Get, HttpCode, Patch, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  OpenApiInput,
  OpenApiOperation,
  type ValidatedInput,
} from "../common/http/openapi-operation.decorator";
import {
  PRICING_RULES_CACHE_CONTROL,
  ruleEtagOf,
  type ConsoleMarkupRule,
  type MarkupRulePage,
} from "./pricing-rules.mapper";
import { PricingRulesService, type SavedMarkupRule } from "./pricing-rules.service";

/** The validated body of an operation; the validation interceptor refuses a request without one, never reached. */
function bodyOf<B>(operationId: string, body: B | undefined): B {
  if (body === undefined) {
    throw new Error(`${operationId} without a validated body`);
  }
  return body;
}

/** The headers of an answer with one rule. */
function answer<T extends ConsoleMarkupRule>(res: Response, rule: T): T {
  res.setHeader("ETag", ruleEtagOf(rule.version));
  res.setHeader("Cache-Control", PRICING_RULES_CACHE_CONTROL);
  return rule;
}

@Controller("v1/console/settings/markup-rules")
export class MarkupRulesController {
  constructor(private readonly rules: PricingRulesService) {}

  @Get()
  @OpenApiOperation("consoleListMarkupRules")
  async list(
    @OpenApiInput() input: ValidatedInput<"consoleListMarkupRules">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MarkupRulePage> {
    res.setHeader("Cache-Control", PRICING_RULES_CACHE_CONTROL);
    return await this.rules.listMarkupRules(input.query ?? {});
  }

  @Post()
  @OpenApiOperation("consoleCreateMarkupRule")
  async create(
    @OpenApiInput() input: ValidatedInput<"consoleCreateMarkupRule">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SavedMarkupRule> {
    const rule = await this.rules.createMarkupRule(bodyOf("consoleCreateMarkupRule", input.body));
    res.setHeader("Location", `/v1/console/settings/markup-rules/${rule.id}`);
    return answer(res, rule);
  }

  @Get(":markupRuleId")
  @OpenApiOperation("consoleGetMarkupRule")
  async get(
    @OpenApiInput() input: ValidatedInput<"consoleGetMarkupRule">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsoleMarkupRule> {
    return answer(res, await this.rules.getMarkupRule(input.path.markupRuleId));
  }

  @Patch(":markupRuleId")
  @OpenApiOperation("consoleUpdateMarkupRule")
  async update(
    @OpenApiInput() input: ValidatedInput<"consoleUpdateMarkupRule">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SavedMarkupRule> {
    const rule = await this.rules.updateMarkupRule(
      input.path.markupRuleId,
      bodyOf("consoleUpdateMarkupRule", input.body),
      input.headers["If-Match"],
    );
    return answer(res, rule);
  }

  @Delete(":markupRuleId")
  @HttpCode(204)
  @OpenApiOperation("consoleDeleteMarkupRule")
  async delete(
    @OpenApiInput() input: ValidatedInput<"consoleDeleteMarkupRule">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    res.setHeader("Cache-Control", PRICING_RULES_CACHE_CONTROL);
    await this.rules.deleteMarkupRule(input.path.markupRuleId, input.headers["If-Match"]);
  }
}
