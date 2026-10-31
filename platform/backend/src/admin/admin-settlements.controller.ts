// The settlements of the platform admin (platform/docs/api-inventory-admin.md §6, flows/stripe-payments-account.md §F,
// flows/platform-admin-operations.md "Sequence: settlement review and payout", PADR-0003, scope PF-63, PF-91), under
// `/v1/admin/settlements`. Every operation is `x-scope: platform_admin`, so AdminAuthGuard checks the admin token and
// re-reads the account first. Thin: each handler binds its operation, reads the validated request and makes one call of
// SettlementsModule.
//
// - `adminGenerateSettlements` (`POST …/generate`, PBE-059): queues `settlement.generate {periodStart, tenantId?}` for
//   a month that has ended and answers `202` with no body before the job runs (SettlementJobs.request: `400
//   VALIDATION_FAILED` with `period_not_closed`, `404 NOT_FOUND` for an unknown tenant, `503 SERVICE_UNAVAILABLE`
//   while Redis does not take the job, and the audit row `settlement.generation_requested`).
// - The review workflow (PBE-060, SettlementReviewService): `adminListSettlements` (filters and cursor),
//   `adminGetSettlement` (with the OTA and its payout account status; the version in `ETag`), `adminListSettlementLines`
//   (cursor) and `adminDownloadSettlementLines` (the CSV file, `text/csv` with `Cache-Control: no-store` and an
//   attachment named after the OTA, month and currency: the file holds an OTA's payment records). The writes answer the
//   statement with its new version in `ETag`: `adminAddSettlementAdjustment` (**reason**, drafts only; an amount
//   with more decimals than the statement currency's exponent answers `422 UNPROCESSABLE`, `details.reason =
//   amount_precision`, from the service, FIX-W37-PLATFORM), `adminApproveSettlement` and `adminMarkSettlementPaid`
//   (`x-mfa-step-up`: RecentMfaGuard answers `401 REAUTH_REQUIRED` without a TOTP step-up in the last 15 minutes;
//   `If-Match`), `adminVoidSettlement` (**reason**, drafts only). The request validation trims every admin reason
//   before it counts its 5–500 characters (FIX-W35-PLATFORM).
import { Controller, Get, HttpCode, Post, Res, StreamableFile } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { etagOf, versionOfIfMatch } from "../common/http/if-match";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import { SETTLEMENT_CSV_CONTENT_TYPE } from "../settlements/settlement-csv";
import type { AdminStatementRecord } from "../settlements/settlement-review.repository";
import {
  SettlementReviewService,
  toAdminSettlement,
  type AddSettlementAdjustmentRequest,
  type AdminSettlement,
  type AdminSettlementLineList,
  type AdminSettlementList,
  type ListAdminSettlementsQuery,
  type ListSettlementLinesQuery,
  type MarkSettlementPaidRequest,
} from "../settlements/settlement-review.service";
import { SettlementJobs, type GenerateSettlementsRequest } from "../settlements/settlements.processor";

type AdminReasonRequest = components["schemas"]["AdminReasonRequest"];

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

type RequestParameters = Readonly<Record<string, unknown>>;

/** The `AdminSettlement` of `row`, with its version in `ETag` (the `If-Match` of approve and mark-paid). */
function withEtag(res: HeaderTarget, row: AdminStatementRecord): AdminSettlement {
  res.setHeader("ETag", etagOf(row.version));
  return toAdminSettlement(row);
}

@Controller("v1/admin/settlements")
export class AdminSettlementsController {
  constructor(
    private readonly jobs: SettlementJobs,
    private readonly review: SettlementReviewService,
  ) {}

  @Get()
  @OpenApiOperation("adminListSettlements")
  adminListSettlements(@Validated("query") query: ListAdminSettlementsQuery): Promise<AdminSettlementList> {
    return this.review.adminList(query);
  }

  @Post("generate")
  @HttpCode(202)
  @OpenApiOperation("adminGenerateSettlements")
  async adminGenerateSettlements(
    @AccessToken() token: AccessTokenClaims,
    @Validated("body") body: GenerateSettlementsRequest,
  ): Promise<void> {
    await this.jobs.request(token, body);
  }

  @Get(":settlementId")
  @OpenApiOperation("adminGetSettlement")
  async adminGetSettlement(
    @Validated("path") path: RequestParameters,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<AdminSettlement> {
    return withEtag(res, await this.review.adminGet(path["settlementId"] as string));
  }

  @Get(":settlementId/lines")
  @OpenApiOperation("adminListSettlementLines")
  adminListSettlementLines(
    @Validated("path") path: RequestParameters,
    @Validated("query") query: ListSettlementLinesQuery,
  ): Promise<AdminSettlementLineList> {
    return this.review.adminListLines(path["settlementId"] as string, query);
  }

  @Get(":settlementId/lines.csv")
  @OpenApiOperation("adminDownloadSettlementLines")
  async adminDownloadSettlementLines(
    @Validated("path") path: RequestParameters,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<StreamableFile> {
    const file = await this.review.adminCsv(path["settlementId"] as string);
    res.setHeader("Cache-Control", "no-store");
    return new StreamableFile(Buffer.from(file.body, "utf8"), {
      type: SETTLEMENT_CSV_CONTENT_TYPE,
      disposition: file.disposition,
    });
  }

  @Post(":settlementId/adjustments")
  @HttpCode(200)
  @OpenApiOperation("adminAddSettlementAdjustment")
  async adminAddSettlementAdjustment(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("body") body: AddSettlementAdjustmentRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<AdminSettlement> {
    return withEtag(res, await this.review.addAdjustment(token, path["settlementId"] as string, body));
  }

  @Post(":settlementId/approve")
  @HttpCode(200)
  @OpenApiOperation("adminApproveSettlement")
  async adminApproveSettlement(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("header") header: RequestParameters,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<AdminSettlement> {
    const version = versionOfIfMatch(header["if-match"] as string);
    return withEtag(res, await this.review.approve(token, path["settlementId"] as string, version));
  }

  @Post(":settlementId/mark-paid")
  @HttpCode(200)
  @OpenApiOperation("adminMarkSettlementPaid")
  async adminMarkSettlementPaid(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("header") header: RequestParameters,
    @Validated("body") body: MarkSettlementPaidRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<AdminSettlement> {
    const version = versionOfIfMatch(header["if-match"] as string);
    return withEtag(res, await this.review.markPaid(token, path["settlementId"] as string, version, body));
  }

  @Post(":settlementId/void")
  @HttpCode(200)
  @OpenApiOperation("adminVoidSettlement")
  async adminVoidSettlement(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("body") body: AdminReasonRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<AdminSettlement> {
    return withEtag(res, await this.review.void(token, path["settlementId"] as string, body.reason));
  }
}
