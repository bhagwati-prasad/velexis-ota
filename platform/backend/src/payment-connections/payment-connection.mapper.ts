// The API's `PaymentConnection` of a `payment_provider_connections` row read without its ciphertexts (PBE-027, PBE-057;
// FIX-W39-PLATFORM, lead decisions (2k) and (2m) of 2026-11-02). One mapper for every answer that carries a payment
// connection, the portal's (`listPaymentConnections`, `updatePaymentConnection`, `useVelexisPayments`,
// `completeStripeConnect`) and the admin's (`adminGetTenant`, `adminSetConnectionStatus`), so they show the same thing:
// the mode, the status, the OTA's account id and Stripe publishable key where the mode has them, the statement descriptor
// suffix and the Connect capabilities, never a secret key or a webhook secret; the webhook URL of an `api_keys`
// connection (`<PUBLIC_OTA_API_URL>/webhooks/stripe/c/<ppc_id>`, the OTA backend's receiver of that connection); and its
// `pendingSubmission`, the latest submission of own Stripe keys of its environment while it is open or after it failed
// (CredentialSubmissionsService.pendingByEnvironment(tenantId, "stripe_api_keys"), common/credentials/
// pending-submissions.ts).
import type { components } from "@velexis/api-types/platform";
import { pendingSubmissionOf, type PendingSubmissions } from "../common/credentials/pending-submissions";
import type { PaymentConnectionView } from "./payment-connections.repository";

export type PaymentConnection = components["schemas"]["PaymentConnection"];
type PaymentCapabilities = components["schemas"]["PaymentCapabilities"];

/** What a connection's answer needs besides its row: PUBLIC_OTA_API_URL and the tenant's pending submissions. */
export interface PaymentConnectionContext {
  /** PUBLIC_OTA_API_URL: the OTA API's public base URL, where the webhook URL of an `api_keys` connection starts. */
  readonly otaApiUrl: string;
  /** The tenant's pending submissions of own Stripe keys, by environment. */
  readonly pending: PendingSubmissions;
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
 * The OTA backend's webhook receiver of the connection `connectionId`: `<otaApiUrl>/webhooks/stripe/c/<ppc_id>`, where
 * `otaApiUrl` is PUBLIC_OTA_API_URL (`https://api.ota.example.com` in production, an https URL there as Stripe needs;
 * FIX-W39-PLATFORM, lead decision (2m) of 2026-11-02), its trailing slashes dropped. Never a host taken from a request.
 */
export function stripeWebhookUrl(otaApiUrl: string, connectionId: string): string {
  return `${otaApiUrl.replace(/\/+$/, "")}/webhooks/stripe/c/${connectionId}`;
}

/**
 * The `webhookUrl` of a connection's answer (`PaymentConnection.webhookUrl`): its receiver (`stripeWebhookUrl`) in
 * `api_keys` mode, `null` in the other modes.
 */
export function paymentConnectionWebhookUrl(
  otaApiUrl: string,
  row: Pick<PaymentConnectionView, "id" | "account_mode">,
): string | null {
  return row.account_mode === "api_keys" ? stripeWebhookUrl(otaApiUrl, row.id) : null;
}

/** The `PaymentConnection` of a row read without its secrets, with its webhook URL and its pending submission. */
export function toPaymentConnection(
  row: PaymentConnectionView,
  context: PaymentConnectionContext,
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
    webhookUrl: paymentConnectionWebhookUrl(context.otaApiUrl, row),
    pendingSubmission: pendingSubmissionOf(context.pending, row.environment),
    version: row.version,
  };
}
