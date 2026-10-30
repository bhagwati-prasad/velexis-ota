// The payout accounts in the platform admin (PBE-058; platform/docs/api-inventory-admin.md §6, flows/
// stripe-payments-account.md §B item 3, PADR-0003 item 10, PADR-0006, scope PF-64 AC2), under
// `/v1/admin/tenants/{tenantId}/payout-account`. Every operation is `x-scope: platform_admin`, so AdminAuthGuard checks
// the admin token and re-reads the account first. Thin: each handler binds its operation, reads the validated request
// and makes one call of SettlementsModule's PayoutAccountsService.
//
// - `adminGetPayoutAccount`: the account masked, as the portal shows it, with its version in `ETag` (the `If-Match` of
//   the review). Not audited: it holds no bank number.
// - `adminRevealPayoutAccount` (`POST …/reveal`): the full bank identifiers, to pay a statement by bank transfer. Its
//   operation is `x-mfa-step-up` (RecentMfaGuard: `401 REAUTH_REQUIRED` without a TOTP step-up in the last 15
//   minutes) and needs a `reason` of 5–500 characters (the request validation; the service also refuses one that is
//   shorter once trimmed). The answer is sent with `Cache-Control: no-store`, set before the service runs so the
//   service's own refusals carry it too; the service writes the audit row `payout_account.revealed` before it answers.
//   Nothing here logs the answer.
// - `adminReviewPayoutAccount` (`POST …/review`, `If-Match`): `verified`, or `rejected` with a note; the owners are
//   e-mailed. The answer is the reviewed account, masked, with its new version in `ETag`.
import { Controller, Get, HttpCode, Post, Res } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import type { AccessTokenClaims } from "../auth/token.service";
import { AccessToken } from "../common/auth/decorators";
import { etagOf, versionOfIfMatch } from "../common/http/if-match";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import {
  PayoutAccountsService,
  toPayoutAccount,
  type PayoutAccount,
  type RevealedPayoutAccount,
  type ReviewPayoutAccountRequest,
} from "../settlements/payout-accounts.service";

type AdminReasonRequest = components["schemas"]["AdminReasonRequest"];

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

type RequestParameters = Readonly<Record<string, unknown>>;

@Controller("v1/admin/tenants/:tenantId/payout-account")
export class AdminPayoutsController {
  constructor(private readonly payoutAccounts: PayoutAccountsService) {}

  @Get()
  @OpenApiOperation("adminGetPayoutAccount")
  async adminGetPayoutAccount(
    @Validated("path") path: RequestParameters,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<PayoutAccount> {
    const row = await this.payoutAccounts.get(path["tenantId"] as string);
    res.setHeader("ETag", etagOf(row.version));
    return toPayoutAccount(row);
  }

  @Post("reveal")
  @HttpCode(200)
  @OpenApiOperation("adminRevealPayoutAccount")
  adminRevealPayoutAccount(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("body") body: AdminReasonRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<RevealedPayoutAccount> {
    res.setHeader("Cache-Control", "no-store");
    return this.payoutAccounts.reveal(token, path["tenantId"] as string, body.reason);
  }

  @Post("review")
  @HttpCode(200)
  @OpenApiOperation("adminReviewPayoutAccount")
  async adminReviewPayoutAccount(
    @AccessToken() token: AccessTokenClaims,
    @Validated("path") path: RequestParameters,
    @Validated("header") header: RequestParameters,
    @Validated("body") body: ReviewPayoutAccountRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<PayoutAccount> {
    const row = await this.payoutAccounts.review(
      token,
      path["tenantId"] as string,
      versionOfIfMatch(header["if-match"] as string),
      body,
    );
    res.setHeader("ETag", etagOf(row.version));
    return toPayoutAccount(row);
  }
}
