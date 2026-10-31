// The payment connection routes of the portal (platform/docs/api-inventory-resources.md §4; scope §1.2 "See Amadeus and
// payment connections (masked)", PF-62): `listPaymentConnections` since PBE-027, `updatePaymentConnection` since
// PBE-038, and `submitStripeApiKeys` and `useVelexisPayments` since PBE-057. Thin: each handler binds its operation,
// reads the validated request and makes one service call.
//
// - `listPaymentConnections`: owners, admins and finance members see the Stripe connection of each environment. The
//   rows are read without the secrets' ciphertexts, and `toPaymentConnectionWith` answers what the portal shows: the
//   mode, the status, the OTA's account id and Stripe publishable key where the mode has them, the statement descriptor
//   suffix and the Connect capabilities, never a secret key or a webhook secret; for `api_keys` mode the webhook URL to
//   configure in Stripe, and `pendingSubmission`, the latest submission of own Stripe keys of the environment while it
//   is open or after it failed (StripeApiKeysService.listConnections, PBE-057).
// - `updatePaymentConnection` (`PATCH …/payment-connections/{environment}`, `If-Match`): owners and admins change the
//   card statement descriptor suffix (payment-connections.service.ts); the answer is the connection as the list maps
//   it, with its new version in `ETag`.
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
import type { PaymentConnectionView, PaymentEnvironment } from "./payment-connections.repository";
import { PaymentConnectionsService } from "./payment-connections.service";
import {
  StripeApiKeysService,
  type PaymentConnectionExtras,
  type StripeApiKeysSubmitted,
  type SubmitStripeApiKeysRequest,
} from "./stripe-api-keys.service";
import { UseVelexisService } from "./use-velexis.service";

export type PaymentConnection = components["schemas"]["PaymentConnection"];
export type PaymentConnectionList = components["schemas"]["PaymentConnectionList"];
export type UpdatePaymentConnectionRequest = components["schemas"]["UpdatePaymentConnectionRequest"];
type PaymentCapabilities = components["schemas"]["PaymentCapabilities"];

/** The part of the Express response the handlers write. */
interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
}

/** The capability flags of `PaymentCapabilities`, as `account.updated` stores them (M5). */
const CAPABILITY_FLAGS = ["chargesEnabled", "payoutsEnabled", "detailsSubmitted"] as const;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** The `PaymentCapabilities` of the `capabilities` column: its three flags where they are booleans, nothing else. */
export function paymentCapabilities(capabilities: unknown): PaymentCapabilities {
  const flags: { -readonly [F in keyof PaymentCapabilities]: PaymentCapabilities[F] } = {};
  if (capabilities !== null && typeof capabilities === "object" && !Array.isArray(capabilities)) {
    for (const flag of CAPABILITY_FLAGS) {
      const value = (capabilities as Record<string, unknown>)[flag];
      if (typeof value === "boolean") {
        flags[flag] = value;
      }
    }
  }
  return flags;
}

/**
 * The `PaymentConnection` of the OpenAPI document for a row read without its secrets, without what the row alone does
 * not give (`webhookUrl` and `pendingSubmission` are `null`): the Connect callback's answer, whose connections are all
 * in `connect_standard` mode. The admin's answers add the webhook URL (`toPaymentConnectionWith` with
 * `paymentConnectionWebhookUrl`).
 */
export function toPaymentConnection(row: PaymentConnectionView): PaymentConnection {
  return toPaymentConnectionWith(row, {});
}

/**
 * The `PaymentConnection` of a row read without its secrets with what the row alone does not give (PBE-057): the
 * webhook URL of an `api_keys` connection and the pending submission of own Stripe keys, each `null` when absent.
 */
export function toPaymentConnectionWith(
  row: PaymentConnectionView,
  extras: PaymentConnectionExtras,
): PaymentConnection {
  return {
    id: row.id,
    environment: row.environment as PaymentConnection["environment"],
    provider: row.provider as PaymentConnection["provider"],
    accountMode: row.account_mode as PaymentConnection["accountMode"],
    status: row.status as PaymentConnection["status"],
    accountReference: row.account_reference,
    publishableKey: row.publishable_key,
    statementDescriptorSuffix: row.statement_descriptor_suffix,
    capabilities: paymentCapabilities(row.capabilities),
    connectedAt: iso(row.connected_at),
    disconnectedAt: iso(row.disconnected_at),
    webhookUrl: extras.webhookUrl ?? null,
    pendingSubmission: extras.pendingSubmission ?? null,
    version: row.version,
  };
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
    const listed = await this.apiKeys.listConnections(membership.tenantId);
    return { data: listed.map(({ row, extras }) => toPaymentConnectionWith(row, extras)) };
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
    return toPaymentConnectionWith(row, await this.extrasOf(membership.tenantId, row));
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
    return toPaymentConnectionWith(row, await this.extrasOf(membership.tenantId, row));
  }

  /** What a single connection's answer adds to its row, as the list shows it. */
  private async extrasOf(tenantId: string, row: PaymentConnectionView): Promise<PaymentConnectionExtras> {
    return {
      webhookUrl: this.apiKeys.webhookUrlFor(row),
      pendingSubmission: await this.apiKeys.pendingSubmissionFor(
        tenantId,
        row.environment as PaymentEnvironment,
      ),
    };
  }
}
