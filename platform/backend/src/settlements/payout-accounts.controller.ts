// The payout account routes of the portal (PBE-058; platform/docs/api-inventory-resources.md §5, flows/
// stripe-payments-account.md §B, scope §1.2 "See settlements and the payout account (masked)" and "Set the payout bank
// account (MFA step-up)", PF-64). Thin: each handler binds its operation, reads the validated request and makes one
// PayoutAccountsService call.
//
// - `getPayoutAccount` (`GET …/payout-account`): owners and finance members see the account masked, with its version
//   in `ETag`.
// - `setPayoutAccount` (`PUT …/payout-account`): owners set or replace it. Its operation is `x-mfa-step-up` and
//   `x-feature: settlements`, so RecentMfaGuard answers `401 REAUTH_REQUIRED` (or `403 MFA_REQUIRED`) and FeatureGuard
//   `403 FEATURE_DISABLED` with `details.feature = settlements` before the handler runs. The bank fields of the body
//   are write-only: nothing here logs the body, and the answer is the masked account, with its new version in `ETag`.
//
// TenantRoleGuard answers `404` to non-members and `403` to the other roles before a handler runs.
import { Controller, Get, Put, Res } from "@nestjs/common";
import { CurrentMembership, TenantRoles, type TenantMembership } from "../common/auth/tenant-role.guard";
import { etagOf } from "../common/http/if-match";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import { tenantRolesOf } from "../memberships/tenant-roles";
import {
  PayoutAccountsService,
  toPayoutAccount,
  type PayoutAccount,
  type SetPayoutAccountRequest,
} from "./payout-accounts.service";

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

@Controller("v1/tenants/:tenantId/payout-account")
export class PayoutAccountsController {
  constructor(private readonly payoutAccounts: PayoutAccountsService) {}

  @Get()
  @OpenApiOperation("getPayoutAccount")
  @TenantRoles(...tenantRolesOf("getPayoutAccount"))
  async getPayoutAccount(
    @CurrentMembership() membership: TenantMembership,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<PayoutAccount> {
    const row = await this.payoutAccounts.get(membership.tenantId);
    res.setHeader("ETag", etagOf(row.version));
    return toPayoutAccount(row);
  }

  @Put()
  @OpenApiOperation("setPayoutAccount")
  @TenantRoles(...tenantRolesOf("setPayoutAccount"))
  async setPayoutAccount(
    @CurrentMembership() membership: TenantMembership,
    @Validated("body") body: SetPayoutAccountRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<PayoutAccount> {
    const row = await this.payoutAccounts.set(membership, body);
    res.setHeader("ETag", etagOf(row.version));
    return toPayoutAccount(row);
  }
}
