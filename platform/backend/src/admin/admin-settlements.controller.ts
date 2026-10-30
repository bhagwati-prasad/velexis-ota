// The settlements of the platform admin (platform/docs/api-inventory-admin.md §6, flows/stripe-payments-account.md §F,
// PADR-0003, scope PF-63), under `/v1/admin/settlements`. Every operation is `x-scope: platform_admin`, so
// AdminAuthGuard checks the admin token and re-reads the account first. Thin: each handler binds its operation, reads
// the validated request and makes one call of SettlementsModule.
//
// - `adminGenerateSettlements` (`POST …/generate`, PBE-059): queues `settlement.generate {periodStart, tenantId?}` for
//   a month that has ended and answers `202` with no body before the job runs (SettlementJobs.request: `400
//   VALIDATION_FAILED` with `period_not_closed`, `404 NOT_FOUND` for an unknown tenant, `503 SERVICE_UNAVAILABLE`
//   while Redis does not take the job, and the audit row `settlement.generation_requested`).
//
// The review workflow (list, detail, lines, CSV, adjustments, approve, mark paid, void) joins it with PBE-060.
import { Controller, HttpCode, Post } from "@nestjs/common";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import { SettlementJobs, type GenerateSettlementsRequest } from "../settlements/settlements.processor";

@Controller("v1/admin/settlements")
export class AdminSettlementsController {
  constructor(private readonly jobs: SettlementJobs) {}

  @Post("generate")
  @HttpCode(202)
  @OpenApiOperation("adminGenerateSettlements")
  async adminGenerateSettlements(
    @AccessToken() token: AccessTokenClaims,
    @Validated("body") body: GenerateSettlementsRequest,
  ): Promise<void> {
    await this.jobs.request(token, body);
  }
}
