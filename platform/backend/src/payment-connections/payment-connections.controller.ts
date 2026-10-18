// The payment connection routes of the portal (platform/docs/api-inventory-resources.md §4; scope §1.2 "See Amadeus and
// payment connections (masked)"): `listPaymentConnections` since PBE-027. Owners, admins and finance members see the
// Stripe connection of each environment; TenantRoleGuard answers `404` to non-members and `403` to the other roles
// before the handler runs. The rows are read without the secrets' ciphertexts, and `toPaymentConnection` answers what
// the portal shows: the mode, the status, the OTA's account id and Stripe publishable key where the mode has them, the
// statement descriptor suffix and the Connect capabilities, never a secret key or a webhook secret. `webhookUrl` (API-key
// mode) and `pendingSubmission` stay `null` until the M5 API-key connections and credential submissions (PBE-052,
// PBE-057); the descriptor update comes with M3 (PBE-038).
import { Controller, Get } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { CurrentMembership, TenantRoles, type TenantMembership } from "../common/auth/tenant-role.guard";
import { OpenApiOperation } from "../common/http/openapi-operation.decorator";
import { tenantRolesOf } from "../memberships/tenant-roles";
import { PaymentConnectionsRepository, type PaymentConnectionView } from "./payment-connections.repository";

export type PaymentConnection = components["schemas"]["PaymentConnection"];
export type PaymentConnectionList = components["schemas"]["PaymentConnectionList"];
type PaymentCapabilities = components["schemas"]["PaymentCapabilities"];

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

/** The `PaymentConnection` of the OpenAPI document for a row read without its secrets. */
export function toPaymentConnection(row: PaymentConnectionView): PaymentConnection {
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
    webhookUrl: null,
    pendingSubmission: null,
    version: row.version,
  };
}

@Controller("v1/tenants/:tenantId/payment-connections")
export class PaymentConnectionsController {
  constructor(private readonly connections: PaymentConnectionsRepository) {}

  @Get()
  @OpenApiOperation("listPaymentConnections")
  @TenantRoles(...tenantRolesOf("listPaymentConnections"))
  async listPaymentConnections(
    @CurrentMembership() membership: TenantMembership,
  ): Promise<PaymentConnectionList> {
    const rows = await this.connections.listForTenant(membership.tenantId);
    return { data: rows.map(toPaymentConnection) };
  }
}
