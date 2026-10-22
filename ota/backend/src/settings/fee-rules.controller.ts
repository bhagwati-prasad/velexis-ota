// console.settings.feeRules.list, create, get, update and delete (consoleListFeeRules, consoleCreateFeeRule,
// consoleGetFeeRule, consoleUpdateFeeRule, consoleDeleteFeeRule; `x-scope: console`, `x-permission: settings:read` /
// `settings:write`; OBE-069): thin handlers over PricingRulesService, as markup-rules.controller.ts is for markup rules.
// Every answer is `Cache-Control: private, no-store`; get, create and update carry `ETag: "<version>"`, create
// `Location` too.
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
  type ConsoleFeeRule,
  type FeeRulePage,
} from "./pricing-rules.mapper";
import { PricingRulesService, type SavedFeeRule } from "./pricing-rules.service";

/** The validated body of an operation; the validation interceptor refuses a request without one, never reached. */
function bodyOf<B>(operationId: string, body: B | undefined): B {
  if (body === undefined) {
    throw new Error(`${operationId} without a validated body`);
  }
  return body;
}

/** The headers of an answer with one rule. */
function answer<T extends ConsoleFeeRule>(res: Response, rule: T): T {
  res.setHeader("ETag", ruleEtagOf(rule.version));
  res.setHeader("Cache-Control", PRICING_RULES_CACHE_CONTROL);
  return rule;
}

@Controller("v1/console/settings/fee-rules")
export class FeeRulesController {
  constructor(private readonly rules: PricingRulesService) {}

  @Get()
  @OpenApiOperation("consoleListFeeRules")
  async list(
    @OpenApiInput() input: ValidatedInput<"consoleListFeeRules">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FeeRulePage> {
    res.setHeader("Cache-Control", PRICING_RULES_CACHE_CONTROL);
    return await this.rules.listFeeRules(input.query ?? {});
  }

  @Post()
  @OpenApiOperation("consoleCreateFeeRule")
  async create(
    @OpenApiInput() input: ValidatedInput<"consoleCreateFeeRule">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SavedFeeRule> {
    const rule = await this.rules.createFeeRule(bodyOf("consoleCreateFeeRule", input.body));
    res.setHeader("Location", `/v1/console/settings/fee-rules/${rule.id}`);
    return answer(res, rule);
  }

  @Get(":feeRuleId")
  @OpenApiOperation("consoleGetFeeRule")
  async get(
    @OpenApiInput() input: ValidatedInput<"consoleGetFeeRule">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConsoleFeeRule> {
    return answer(res, await this.rules.getFeeRule(input.path.feeRuleId));
  }

  @Patch(":feeRuleId")
  @OpenApiOperation("consoleUpdateFeeRule")
  async update(
    @OpenApiInput() input: ValidatedInput<"consoleUpdateFeeRule">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SavedFeeRule> {
    const rule = await this.rules.updateFeeRule(
      input.path.feeRuleId,
      bodyOf("consoleUpdateFeeRule", input.body),
      input.headers["If-Match"],
    );
    return answer(res, rule);
  }

  @Delete(":feeRuleId")
  @HttpCode(204)
  @OpenApiOperation("consoleDeleteFeeRule")
  async delete(
    @OpenApiInput() input: ValidatedInput<"consoleDeleteFeeRule">,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    res.setHeader("Cache-Control", PRICING_RULES_CACHE_CONTROL);
    await this.rules.deleteFeeRule(input.path.feeRuleId, input.headers["If-Match"]);
  }
}
