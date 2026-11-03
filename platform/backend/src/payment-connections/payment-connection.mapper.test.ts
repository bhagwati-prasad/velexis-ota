import { describe, expect, it } from "vitest";
import {
  paymentConnectionWebhookUrl,
  stripeWebhookUrl,
  toPaymentConnection,
} from "./payment-connection.mapper";
import type { PaymentConnectionView } from "./payment-connections.repository";

const CONNECTION_ID = "ppc_01JATESTRW0000000000000001";
const SUBMISSION_ID = "crs_01JATESTRW0000000000000001";

/** An `api_keys` connection of the live environment as the repository reads it (no ciphertext). */
const API_KEYS_ROW = {
  id: CONNECTION_ID,
  tenant_id: "ten_01JATESTRW0000000000000001",
  provider: "stripe",
  environment: "live",
  account_mode: "api_keys",
  status: "active",
  account_reference: "acct_1TestOwnAccount",
  publishable_key: "pk_live_1TestPublishableKeyOnly",
  statement_descriptor_suffix: null,
  capabilities: { chargesEnabled: true, payoutsEnabled: "yes" },
  connected_at: new Date("2026-10-05T08:00:00.000Z"),
  disconnected_at: null,
  version: 3,
} as unknown as PaymentConnectionView;

describe("stripeWebhookUrl", () => {
  it("[FIX-W39-PLATFORM AC9] starts with PUBLIC_OTA_API_URL, whatever trailing slashes it has", () => {
    for (const otaApiUrl of [
      "https://api.ota.example.com",
      "https://api.ota.example.com/",
      "https://api.ota.example.com//",
    ]) {
      expect(stripeWebhookUrl(otaApiUrl, CONNECTION_ID), otaApiUrl).toBe(
        `https://api.ota.example.com/webhooks/stripe/c/${CONNECTION_ID}`,
      );
    }
    expect(stripeWebhookUrl("http://localhost:4000", CONNECTION_ID)).toBe(
      `http://localhost:4000/webhooks/stripe/c/${CONNECTION_ID}`,
    );
  });

  it("[FIX-W39-PLATFORM AC9] gives a connection a webhook URL in api_keys mode only", () => {
    expect(paymentConnectionWebhookUrl("https://api.ota.example.com", API_KEYS_ROW)).toBe(
      `https://api.ota.example.com/webhooks/stripe/c/${CONNECTION_ID}`,
    );
    for (const accountMode of ["velexis", "connect_standard"]) {
      expect(
        paymentConnectionWebhookUrl("https://api.ota.example.com", {
          id: CONNECTION_ID,
          account_mode: accountMode,
        }),
        accountMode,
      ).toBeNull();
    }
  });
});

describe("toPaymentConnection", () => {
  it("[FIX-W39-PLATFORM AC7] answers the row with its webhook URL and the pending submission of its environment", () => {
    const failed = { id: SUBMISSION_ID, status: "failed" as const, errorCode: "STRIPE_KEY_INVALID" };

    expect(
      toPaymentConnection(API_KEYS_ROW, {
        otaApiUrl: "https://api.ota.example.com",
        pending: { live: failed },
      }),
    ).toEqual({
      id: CONNECTION_ID,
      environment: "live",
      provider: "stripe",
      accountMode: "api_keys",
      status: "active",
      accountReference: "acct_1TestOwnAccount",
      publishableKey: "pk_live_1TestPublishableKeyOnly",
      statementDescriptorSuffix: null,
      capabilities: { chargesEnabled: true },
      connectedAt: "2026-10-05T08:00:00.000Z",
      disconnectedAt: null,
      webhookUrl: `https://api.ota.example.com/webhooks/stripe/c/${CONNECTION_ID}`,
      pendingSubmission: failed,
      version: 3,
    });
    expect(
      toPaymentConnection(API_KEYS_ROW, {
        otaApiUrl: "https://api.ota.example.com",
        pending: { test: failed },
      }).pendingSubmission,
    ).toBeNull();
  });
});
