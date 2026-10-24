// What the idempotency record of checkout.completeWithAirlineCard is computed from (OBE-051 step 2; OADR-0004 point 3)
// and how the controller lets go of the plain card (OADR-0004 point 2). The flow itself is
// test/integration/payments/airline-card-completion.int.test.ts.
import { describe, expect, it, vi } from "vitest";
import type { Clock } from "../../common/clock";
import { requestHash } from "../../common/http/idempotency.service";
import { AirlineCardCompletionController, forgetCard } from "./airline-card-completion.controller";
import {
  AirlineCardCompletionIdempotencyHooks,
  hashableBody,
  type AirlineCardCompletionRequest,
  type AirlineCardCompletionService,
} from "./airline-card-completion.service";

// Test data only: Visa's documented test PAN and a made-up security code, holder and expiry.
const TEST_PAN = "4111111111111111";

const body = (card: Record<string, unknown> = {}) => ({
  paymentId: "pay_01JA4CF6M3Q6T9W2Z5C8F1H4K7",
  expectedTotal: { amount: "120.50", currency: "EUR" },
  card: {
    brand: "VISA",
    holderName: "Anna Berg",
    number: TEST_PAN,
    expiryMonth: 12,
    expiryYear: 2030,
    securityCode: "123",
    ...card,
  },
});

describe("the request hash of checkout.completeWithAirlineCard", () => {
  it("covers the card as its brand and last 4 digits only [OBE-051 AC1]", () => {
    expect(hashableBody(body())).toEqual({
      paymentId: "pay_01JA4CF6M3Q6T9W2Z5C8F1H4K7",
      expectedTotal: { amount: "120.50", currency: "EUR" },
      card: { brand: "VISA", last4: "1111" },
    });
    const text = JSON.stringify(hashableBody(body()));
    expect(text).not.toContain(TEST_PAN);
    expect(text).not.toContain("Anna");
    expect(text).not.toContain("2030");
    expect(text).not.toContain('"123"');
  });

  it("is the same for the same brand and last 4 whatever the rest, and differs for another card", () => {
    const hooks = new AirlineCardCompletionIdempotencyHooks(undefined as never);
    const hash = (card: Record<string, unknown>) =>
      requestHash(
        "completeCheckoutWithAirlineCard",
        hooks.hashInput({ path: { checkoutId: "chk_1" }, query: {}, body: body(card) }),
      );

    expect(hash({ securityCode: "999", holderName: "Someone Else" })).toBe(hash({}));
    expect(hash({ number: "4000000000000002" })).not.toBe(hash({}));
    expect(hash({ brand: "MASTERCARD" })).not.toBe(hash({}));
  });

  it("leaves a body without a card object as it is, minus the card", () => {
    expect(hashableBody(undefined)).toBeUndefined();
    expect(hashableBody({ paymentId: "pay_1", card: "x" })).toEqual({ paymentId: "pay_1" });
  });
});

describe("the plain card of a request body", () => {
  it("is taken off the parsed body once the card is wrapped", () => {
    const parsed: Record<string, unknown> = body();

    forgetCard(parsed);
    forgetCard(undefined);
    forgetCard([]);

    expect(parsed).toEqual({
      paymentId: "pay_01JA4CF6M3Q6T9W2Z5C8F1H4K7",
      expectedTotal: { amount: "120.50", currency: "EUR" },
    });
  });

  /** The validated input's body and the request's parsed body of one request, with a card never expired. */
  function requestOf(card: Record<string, unknown>) {
    // Three years ahead of the clock.
    const values = { expiryYear: new Date().getUTCFullYear() + 3, ...card };
    return {
      validated: body(values) as Record<string, unknown>,
      req: { body: body(values) as Record<string, unknown> },
    };
  }

  /** The controller's handler over a stand-in service. */
  function controllerCall(
    request: ReturnType<typeof requestOf>,
    complete: AirlineCardCompletionService["complete"],
  ): Promise<unknown> {
    const clock = { now: () => new Date() } as unknown as Clock;
    const controller = new AirlineCardCompletionController(
      { complete } as unknown as AirlineCardCompletionService,
      clock,
    );
    return controller.complete(
      { path: { checkoutId: "chk_1" }, query: {}, headers: {}, body: request.validated } as never,
      request.req as never,
      { setHeader: vi.fn() } as never,
    );
  }

  it("is taken off the request even when the card cannot be wrapped", async () => {
    const complete = vi.fn();
    // A brand the request validation would have refused: SensitiveCard refuses it too, naming the field only.
    const request = requestOf({ brand: "visa" });

    await expect(controllerCall(request, complete)).rejects.toThrow(TypeError);
    expect(request.validated).not.toHaveProperty("card");
    expect(request.req.body).not.toHaveProperty("card");
    expect(complete).not.toHaveBeenCalled();
  });

  it("hands the service the card wrapped, and discards it once the service failed", async () => {
    let seen: AirlineCardCompletionRequest["card"] | undefined;
    const request = requestOf({});
    const run = controllerCall(request, (input) => {
      seen = input.card;
      expect(request.validated).not.toHaveProperty("card");
      expect(request.req.body).not.toHaveProperty("card");
      return Promise.reject(new Error("declined"));
    });

    await expect(run).rejects.toThrow("declined");
    expect(seen?.ok).toBe(true);
    expect(seen?.ok === true && seen.card.discarded).toBe(true);
    expect(JSON.stringify(seen)).not.toContain(TEST_PAN);
  });
});
