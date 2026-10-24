// The Stripe client of the platform (PBE-043; architecture §7 "Stripe", PADR-0002 item 10): the API version pinned in
// code, the 10-second timeout, one retry, no telemetry, `<purpose>:<rowId>` idempotency keys, and no client without
// STRIPE_SECRET_KEY. Nothing here talks to Stripe: creating an SDK client sends no request.
import type { ConfigService } from "@nestjs/config";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { FAKE_STRIPE_METHODS, FakeStripe } from "../../../test/support/fake-stripe";
import type { PlatformBackendConfig } from "../../config";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  idempotencyKey,
  SdkStripeClient,
  STRIPE_API_VERSION,
  STRIPE_MAX_NETWORK_RETRIES,
  STRIPE_TIMEOUT_MS,
  stripeClientOptions,
  StripeNotConfiguredError,
} from "./stripe.client";

/** A ConfigService with only STRIPE_SECRET_KEY. */
function configWith(secretKey: string | undefined): ConfigService<PlatformBackendConfig, true> {
  return {
    get: (name: string) => (name === "STRIPE_SECRET_KEY" ? secretKey : undefined),
  } as unknown as ConfigService<PlatformBackendConfig, true>;
}

/** The SDK's own record of a client's settings (`getApiField`, the SDK's accessor of its `_api` fields). */
function apiField(client: unknown, field: string): unknown {
  return (client as { getApiField(key: string): unknown }).getApiField(field);
}

describe("idempotencyKey", () => {
  it("[PBE-043] is <purpose>:<rowId> for every POST, the same for the same purpose and row", () => {
    expect(idempotencyKey("customer", "ten_01JTESTSTR1PE00000000000000")).toBe(
      "customer:ten_01JTESTSTR1PE00000000000000",
    );
    expect(idempotencyKey("checkout", "ten_01JTESTSTR1PE00000000000000:3f2a-idem")).toBe(
      "checkout:ten_01JTESTSTR1PE00000000000000:3f2a-idem",
    );
    expect(idempotencyKey("portal_session", "sub_1")).toBe(idempotencyKey("portal_session", "sub_1"));
  });

  it.each([
    ["an empty purpose", "", "ten_1"],
    ["an upper-case purpose", "Checkout", "ten_1"],
    ["a purpose with a colon", "checkout:x", "ten_1"],
    ["an empty row id", "checkout", ""],
    ["a row id with a space", "checkout", "ten 1"],
    ["a row id with a line break", "checkout", "ten_1\nX-Header: y"],
  ])("refuses %s", (_case, purpose, rowId) => {
    expect(() => idempotencyKey(purpose, rowId)).toThrow(TypeError);
  });

  it("refuses a key longer than Stripe takes", () => {
    const rowId = "x".repeat(IDEMPOTENCY_KEY_MAX_LENGTH - "checkout:".length);

    expect(idempotencyKey("checkout", rowId)).toHaveLength(IDEMPOTENCY_KEY_MAX_LENGTH);
    expect(() => idempotencyKey("checkout", `${rowId}x`)).toThrow(RangeError);
  });
});

describe("the SDK client", () => {
  it("[PBE-043] pins the API version of the installed stripe 18 SDK, with a 10-second timeout and one retry", () => {
    expect(STRIPE_API_VERSION).toBe(Stripe.API_VERSION);
    expect(stripeClientOptions()).toEqual({
      apiVersion: STRIPE_API_VERSION,
      timeout: 10_000,
      maxNetworkRetries: 1,
      telemetry: false,
      appInfo: { name: "velexis-platform-backend" },
    });

    const client = new SdkStripeClient(configWith("sk_test_dummy")).api();

    expect(apiField(client, "version")).toBe(STRIPE_API_VERSION);
    expect(apiField(client, "timeout")).toBe(STRIPE_TIMEOUT_MS);
    expect(apiField(client, "maxNetworkRetries")).toBe(STRIPE_MAX_NETWORK_RETRIES);
    expect(apiField(client, "host")).toBe("api.stripe.com");
  });

  it("creates the client once and keeps the key out of what the object shows", () => {
    const stripe = new SdkStripeClient(configWith("sk_test_unit_secret_value"));

    expect(stripe.isConfigured()).toBe(true);
    expect(stripe.api()).toBe(stripe.api());
    expect(JSON.stringify(stripe)).not.toContain("sk_test_unit_secret_value");
    expect(Object.values(stripe)).not.toContain("sk_test_unit_secret_value");
  });

  it("[PBE-043] has no client without STRIPE_SECRET_KEY: api() throws StripeNotConfiguredError", () => {
    const stripe = new SdkStripeClient(configWith(undefined));

    expect(stripe.isConfigured()).toBe(false);
    expect(() => stripe.api()).toThrow(StripeNotConfiguredError);
  });
});

describe("FakeStripe (test/support/fake-stripe.ts)", () => {
  it("is a StripeClient whose retrieve answers copies of what was put, expanded on request, and 404 otherwise", async () => {
    const stripe = new FakeStripe().put({ id: "sub_test_alpha_1", object: "subscription" }, {
      id: "cs_test_alpha_1",
      object: "checkout.session",
      subscription: "sub_test_alpha_1",
    } as never);
    const api = stripe.api();

    const session = await api.checkout.sessions.retrieve("cs_test_alpha_1", { expand: ["subscription"] });
    expect(session.subscription).toEqual({ id: "sub_test_alpha_1", object: "subscription" });
    expect((await api.checkout.sessions.retrieve("cs_test_alpha_1")).subscription).toBe("sub_test_alpha_1");
    (await api.subscriptions.retrieve("sub_test_alpha_1")).status = "canceled";
    expect(stripe.get("sub_test_alpha_1")).toEqual({ id: "sub_test_alpha_1", object: "subscription" });
    // Another id, or an id of another object type, is what Stripe answers 404 for.
    for (const missing of [api.invoices.retrieve("in_missing"), api.invoices.retrieve("sub_test_alpha_1")]) {
      await expect(missing).rejects.toMatchObject({ statusCode: 404, code: "resource_missing" });
    }
    expect(stripe.calls.map((call) => `${call.method} ${call.id ?? ""}`)).toEqual([
      "checkout.sessions.retrieve cs_test_alpha_1",
      "checkout.sessions.retrieve cs_test_alpha_1",
      "subscriptions.retrieve sub_test_alpha_1",
      "invoices.retrieve in_missing",
      "invoices.retrieve sub_test_alpha_1",
    ]);
  });

  it("[PBE-043] refuses a POST without an idempotency key, and replays one with the same key as Stripe does", async () => {
    const stripe = new FakeStripe();
    const api = stripe.api();
    const params = { email: "owner@example.com", metadata: { velexis_tenant_id: "ten_test_alpha" } };
    const options = { idempotencyKey: idempotencyKey("customer", "ten_test_alpha") };

    await expect(api.customers.create(params)).rejects.toThrow(/without an idempotency key/);
    const created = await api.customers.create(params, options);
    expect(created).toMatchObject({ id: "cus_fake1", object: "customer", email: "owner@example.com" });
    expect((await api.customers.create(params, options)).id).toBe(created.id);
    await expect(
      api.customers.create({ ...params, email: "other@example.com" }, options),
    ).rejects.toBeInstanceOf(Stripe.errors.StripeIdempotencyError);
    expect((await api.customers.retrieve(created.id)).id).toBe(created.id);
    const checkout = await api.checkout.sessions.create(
      { mode: "subscription", customer: created.id },
      { idempotencyKey: "checkout:ten_test_alpha:k1" },
    );
    expect(checkout.url).toBe(`https://checkout.stripe.com/c/pay/${checkout.id}`);
    const portal = await api.billingPortal.sessions.create(
      { customer: created.id },
      { idempotencyKey: "portal_session:ten_test_alpha:1" },
    );
    expect(portal.url).toBe(`https://billing.stripe.com/p/session/${portal.id}`);
    expect(stripe.callsOf("customers.create").map((call) => call.idempotencyKey)).toEqual([
      undefined,
      "customer:ten_test_alpha",
      "customer:ten_test_alpha",
      "customer:ten_test_alpha",
    ]);
  });

  it("throws the failures queued for a method, one per call, and can play an unconfigured client", async () => {
    const stripe = new FakeStripe()
      .put({ id: "price_test_growth_month", object: "price" })
      .failNext("prices.retrieve", FakeStripe.apiError(503))
      .failNext("prices.retrieve", FakeStripe.connectionError());
    const api = stripe.api();

    await expect(api.prices.retrieve("price_test_growth_month")).rejects.toBeInstanceOf(
      Stripe.errors.StripeAPIError,
    );
    await expect(api.prices.retrieve("price_test_growth_month")).rejects.toBeInstanceOf(
      Stripe.errors.StripeConnectionError,
    );
    expect((await api.prices.retrieve("price_test_growth_month")).id).toBe("price_test_growth_month");
    expect(stripe.calls).toHaveLength(3);
    expect(FAKE_STRIPE_METHODS).toHaveLength(9);

    expect(() => stripe.notConfigured().api()).toThrow(StripeNotConfiguredError);
    expect(stripe.isConfigured()).toBe(false);
    expect(stripe.reset().isConfigured()).toBe(true);
    expect(stripe.calls).toEqual([]);
  });

  it("[FIX-W29-PLATFORM AC2] plays what Stripe keeps of a failed create: the object made, and the failure replayed for the key", async () => {
    const stripe = new FakeStripe();
    const api = stripe.api();
    const params = { email: "owner@example.com", metadata: { velexis_tenant_id: "ten_test_alpha" } };
    const search = { query: "metadata['velexis_tenant_id']:'ten_test_alpha'" };
    // Made, then a 500 that the key replays: the Customer exists and is found, the key answers the 500 again.
    stripe.failNext("customers.create", FakeStripe.apiError(500), { created: true, storedForKey: true });
    await expect(api.customers.create(params, { idempotencyKey: "customer:ten_test_alpha" })).rejects.toThrow(
      /500/,
    );
    const [made] = (await api.customers.search(search)).data;
    expect(made).toMatchObject({ object: "customer", email: "owner@example.com" });
    await expect(
      api.customers.create(params, { idempotencyKey: "customer:ten_test_alpha" }),
    ).rejects.toBeInstanceOf(Stripe.errors.StripeAPIError);
    // Nothing made, a stored 500: replayed, and still nothing to find.
    const other = { ...params, metadata: { velexis_tenant_id: "ten_test_beta" } };
    stripe.failNext("customers.create", FakeStripe.apiError(500), { storedForKey: true });
    await expect(api.customers.create(other, { idempotencyKey: "customer:ten_test_beta" })).rejects.toThrow(
      /500/,
    );
    await expect(api.customers.create(other, { idempotencyKey: "customer:ten_test_beta" })).rejects.toThrow(
      /500/,
    );
    expect(
      (await api.customers.search({ query: "metadata['velexis_tenant_id']:'ten_test_beta'" })).data,
    ).toEqual([]);
    // Made, but no answer: the key answers the object afterwards.
    const gamma = { ...params, metadata: { velexis_tenant_id: "ten_test_gamma" } };
    stripe.failNext("customers.create", FakeStripe.connectionError(), { created: true });
    await expect(
      api.customers.create(gamma, { idempotencyKey: "customer:ten_test_gamma" }),
    ).rejects.toBeInstanceOf(Stripe.errors.StripeConnectionError);
    const replayed = await api.customers.create(gamma, { idempotencyKey: "customer:ten_test_gamma" });
    expect(
      (await api.customers.search({ query: "metadata['velexis_tenant_id']:'ten_test_gamma'" })).data,
    ).toEqual([expect.objectContaining({ id: replayed.id })]);

    await expect(api.customers.search({ query: "email:'owner@example.com'" })).rejects.toThrow(/knows only/);
    expect(() =>
      stripe.failNext("prices.retrieve", FakeStripe.apiError(500), { storedForKey: true }),
    ).toThrow(/for creates/);
    expect(stripe.callsOf("customers.search").map((call) => call.idempotencyKey)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});
