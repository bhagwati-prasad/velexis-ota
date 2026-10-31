// The settlement statements of the portal (PBE-060; platform/docs/api-inventory-resources.md §5, flows/
// stripe-payments-account.md §F item 5, PADR-0003 item 11, scope §1.2 "See settlements and the payout account
// (masked)", PF-63 AC3), under `/v1/tenants/{tenantId}/settlements`. Owners and finance members (TenantRoleGuard
// answers `404` to non-members and `403` to the other roles before a handler runs) see the OTA's statements once a
// platform admin approved them: `approved`, `paid` and `carried_forward`, never a draft or a voided draft (`404
// NOT_FOUND`, as for a statement of another OTA). Thin: each handler binds its operation and makes one
// SettlementReviewService call.
//
// - `listSettlements`: the statements, newest period first, not paginated (one or two a month).
// - `getSettlement`: one statement with its totals.
// - `downloadSettlementLines`: its lines as the portal's CSV file (settlement-csv.ts: the inventory's columns), as
//   `text/csv` with `Cache-Control: no-store` (the file holds the OTA's payment records) and an attachment named
//   `velexis-statement-<yyyy-mm>-<currency>.csv`.
import { Controller, Get, Res, StreamableFile } from "@nestjs/common";
import { CurrentMembership, TenantRoles, type TenantMembership } from "../common/auth/tenant-role.guard";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import { tenantRolesOf } from "../memberships/tenant-roles";
import { SETTLEMENT_CSV_CONTENT_TYPE } from "./settlement-csv";
import {
  SettlementReviewService,
  toSettlement,
  type Settlement,
  type SettlementList,
} from "./settlement-review.service";

/** The part of the Express response the CSV handler writes. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

type RequestParameters = Readonly<Record<string, unknown>>;

@Controller("v1/tenants/:tenantId/settlements")
export class SettlementsController {
  constructor(private readonly review: SettlementReviewService) {}

  @Get()
  @OpenApiOperation("listSettlements")
  @TenantRoles(...tenantRolesOf("listSettlements"))
  listSettlements(@CurrentMembership() membership: TenantMembership): Promise<SettlementList> {
    return this.review.portalList(membership.tenantId);
  }

  @Get(":settlementId")
  @OpenApiOperation("getSettlement")
  @TenantRoles(...tenantRolesOf("getSettlement"))
  async getSettlement(
    @CurrentMembership() membership: TenantMembership,
    @Validated("path") path: RequestParameters,
  ): Promise<Settlement> {
    return toSettlement(await this.review.portalGet(membership.tenantId, path["settlementId"] as string));
  }

  @Get(":settlementId/lines.csv")
  @OpenApiOperation("downloadSettlementLines")
  @TenantRoles(...tenantRolesOf("downloadSettlementLines"))
  async downloadSettlementLines(
    @CurrentMembership() membership: TenantMembership,
    @Validated("path") path: RequestParameters,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<StreamableFile> {
    const file = await this.review.portalCsv(membership.tenantId, path["settlementId"] as string);
    res.setHeader("Cache-Control", "no-store");
    return new StreamableFile(Buffer.from(file.body, "utf8"), {
      type: SETTLEMENT_CSV_CONTENT_TYPE,
      disposition: file.disposition,
    });
  }
}
