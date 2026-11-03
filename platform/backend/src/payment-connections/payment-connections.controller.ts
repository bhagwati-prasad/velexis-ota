// The payment connection routes of the portal (platform/docs/api-inventory-resources.md §4; scope §1.2 "See Amadeus and
// payment connections (masked)", PF-62): `listPaymentConnections` since PBE-027, `updatePaymentConnection` since
// PBE-038, and `submitStripeApiKeys` and `useVelexisPayments` since PBE-057. Thin: each handler binds its operation,
// reads the validated request and makes one service call.
//
// - `listPaymentConnections`: owners, admins and finance members see the Stripe connection of each environment. The
//   rows are read without the secrets' ciphertexts, and `toPaymentConnection` (payment-connection.mapper.ts) answers
//   what the portal shows: the mode, the status, the OTA's account id and Stripe publishable key where the mode has
//   them, the statement descriptor suffix and the Connect capabilities, never a secret key or a webhook secret; for
//   `api_keys` mode the webhook URL to configure in Stripe (`<PUBLIC_OTA_API_URL>/webhooks/stripe/c/<ppc_id>`), and
//   `pendingSubmission`, the latest submission of own Stripe keys of the environment while it is open or after it
//   failed (StripeApiKeysService.listConnections, PBE-057; FIX-W39-PLATFORM).
// - `updatePaymentConnection` (`PATCH …/payment-connections/{environment}`, `If-Match`): owners and admins change the
//   card statement descriptor suffix (payment-connections.service.ts); the answer is the connection as the list maps
//   it (StripeApiKeysService.connectionOf), with its new version in `ETag`.
// - `submitStripeApiKeys` (`PUT …/payment-connections/{environment}/api-keys`): owners and admins with a TOTP step-up
//   (RecentMfaGuard) while `FEATURE_OWN_STRIPE` is on (FeatureGuard) submit the OTA's own publishable key, secret or
//   restricted key and webhook signing secret; the answer is `202 {submission, webhookUrl, webhookEvents}`, the
//   submission `pending` until the worker verifies it (stripe-api-keys.service.ts, stripe-api-keys.verifier.ts). The
//   secrets are never answered or logged.
// - `useVelexisPayments` (`POST …/payment-connections/{environment}/use-velexis`): owners with a TOTP step-up return
//   the connection to the Velexis account (use-velexis.service.ts); the answer is the connection as the list maps it,
//   with its version in `ETag`.
//
// TenantRoleGuard answers `404` to non-members and `403` to the other roles before a handler runs.
import { Controller, Get, HttpCode, Patch, Post, Put, Res } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { CurrentMembership, TenantRoles, type TenantMembership } from "../common/auth/tenant-role.guard";
import { etagOf, versionOfIfMatch } from "../common/http/if-match";
import { OpenApiOperation, Validated } from "../common/http/openapi-operation.decorator";
import { tenantRolesOf } from "../memberships/tenant-roles";
import type { PaymentConnection } from "./payment-connection.mapper";
import type { PaymentEnvironment } from "./payment-connections.repository";
import { PaymentConnectionsService } from "./payment-connections.service";
import {
  StripeApiKeysService,
  type StripeApiKeysSubmitted,
  type SubmitStripeApiKeysRequest,
} from "./stripe-api-keys.service";
import { UseVelexisService } from "./use-velexis.service";

export type { PaymentConnection };
export type PaymentConnectionList = components["schemas"]["PaymentConnectionList"];
export type UpdatePaymentConnectionRequest = components["schemas"]["UpdatePaymentConnectionRequest"];

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

@Controller("v1/tenants/:tenantId/payment-connections")
export class PaymentConnectionsController {
  constructor(
    private readonly connections: PaymentConnectionsService,
    private readonly apiKeys: StripeApiKeysService,
    private readonly velexis: UseVelexisService,
  ) {}

  @Get()
  @OpenApiOperation("listPaymentConnections")
  @TenantRoles(...tenantRolesOf("listPaymentConnections"))
  async listPaymentConnections(
    @CurrentMembership() membership: TenantMembership,
  ): Promise<PaymentConnectionList> {
    return { data: await this.apiKeys.listConnections(membership.tenantId) };
  }

  @Patch(":environment")
  @OpenApiOperation("updatePaymentConnection")
  @TenantRoles(...tenantRolesOf("updatePaymentConnection"))
  async updatePaymentConnection(
    @CurrentMembership() membership: TenantMembership,
    @Validated("path") path: Readonly<Record<string, unknown>>,
    @Validated("header") header: Readonly<Record<string, unknown>>,
    @Validated("body") body: UpdatePaymentConnectionRequest,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<PaymentConnection> {
    const row = await this.connections.updateStatementDescriptor(
      membership,
      path["environment"] as PaymentEnvironment,
      versionOfIfMatch(header["if-match"] as string),
      body.statementDescriptorSuffix,
    );
    res.setHeader("ETag", etagOf(row.version));
    return this.apiKeys.connectionOf(membership.tenantId, row);
  }

  @Put(":environment/api-keys")
  @HttpCode(202)
  @OpenApiOperation("submitStripeApiKeys")
  @TenantRoles(...tenantRolesOf("submitStripeApiKeys"))
  submitStripeApiKeys(
    @CurrentMembership() membership: TenantMembership,
    @Validated("path") path: Readonly<Record<string, unknown>>,
    @Validated("body") body: SubmitStripeApiKeysRequest,
  ): Promise<StripeApiKeysSubmitted> {
    return this.apiKeys.submit(membership, path["environment"] as PaymentEnvironment, body);
  }

  @Post(":environment/use-velexis")
  @HttpCode(200)
  @OpenApiOperation("useVelexisPayments")
  @TenantRoles(...tenantRolesOf("useVelexisPayments"))
  async useVelexisPayments(
    @CurrentMembership() membership: TenantMembership,
    @Validated("path") path: Readonly<Record<string, unknown>>,
    @Res({ passthrough: true }) res: HeaderTarget,
  ): Promise<PaymentConnection> {
    const row = await this.velexis.useVelexis(membership, path["environment"] as PaymentEnvironment);
    res.setHeader("ETag", etagOf(row.version));
    return this.apiKeys.connectionOf(membership.tenantId, row);
  }
}
