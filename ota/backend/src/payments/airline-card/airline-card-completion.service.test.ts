// What the idempotency record of checkout.completeWithAirlineCard is computed from (OBE-051 step 2; OADR-0004 point 3)
// and how the controller lets go of the plain card (OADR-0004 point 2). The flow itself is
// test/integration/payments/airline-card-completion.int.test.ts.
import { ConfigService } from "@nestjs/config";
import { AppError, isAppError } from "@velexis/errors";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import type { BookingOrchestrator } from "../../bookings/booking-orchestrator.service";
import type { Clock } from "../../common/clock";
import { requestHash } from "../../common/http/idempotency.service";
import type { OutboxService } from "../../notifications/outbox.service";
import type { StaffRecipients } from "../../notifications/staff-recipients";
import type { CallerContext } from "../../tenancy/caller-resolver";
import type { TenantContext } from "../../tenancy/tenant-context";
import type { TenantTx } from "../../tenancy/tenant-tx";
import type { PaymentsRepository } from "../payments.repository";
import type { AirlineCardLimits } from "./abuse-limits";
import { AirlineCardCompletionController, forgetCard } from "./airline-card-completion.controller";
import {
  AirlineCardCompletionIdempotencyHooks,
  AirlineCardCompletionService,
  hashableBody,
  type AirlineCardCompletionRequest,
} from "./airline-card-completion.service";
import type { AirlineCardGateway } from "./airline-card.gateway";
import type { SensitiveCard } from "./sensitive-card";

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

describe("the Velexis ops copy of the abuse alerts (FIX-W29-OTA)", () => {
  /**
   * The service over stand-ins, with the shared configuration `config`: a completion whose card the airline declines
   * for the third time on its checkout, so it alerts. Answers the outbox's calls (the OTA's alert goes through
   * StaffRecipients, here to the OTA's own alert address).
   */
  async function thirdDecline(config: Record<string, string>): Promise<{
    readonly code: string | undefined;
    readonly ops: ReadonlyArray<{ readonly to: string; readonly dedupeKey: string }>;
  }> {
    const enqueue = vi.fn((_trx: unknown, input: { to: string; dedupeKey: string }) =>
      Promise.resolve({ notificationId: "ntf_1", queued: input.to.length > 0 }),
    );
    const staffEnqueue = vi.fn(() =>
      Promise.resolve({
        queued: true,
        recipients: [{ email: "alerts@alpha.example", source: "ops_alert_email", accountId: null }],
      }),
    );
    // The service reads the card's brand only; the orchestrator (a stand-in) would send it.
    const card = { brand: () => "VISA" } as unknown as SensitiveCard;
    const service = new AirlineCardCompletionService(
      { run: (work: (trx: unknown) => Promise<unknown>) => work({}) } as unknown as TenantTx,
      {
        require: () => ({ tenantId: "ten_1", key: "alpha", environment: "test", requestId: "req_1" }),
      } as unknown as TenantContext,
      { get: () => ({ type: "edge" }) } as unknown as CallerContext,
      { assertGloballyEnabled: vi.fn(), assertEnabled: vi.fn() } as unknown as AirlineCardGateway,
      {
        settings: () => Promise.resolve({ acceptedCardBrands: ["VISA"] }),
      } as unknown as PaymentsRepository,
      {
        assertAvailable: () => Promise.resolve(),
        countDecline: () => Promise.resolve({ attempts: 3, declines: 3, suspendedNow: false, locked: true }),
      } as unknown as AirlineCardLimits,
      {
        completeWithAirlineCard: async (input: {
          declined: (booking: unknown, error: AppError) => Promise<AppError>;
        }) => {
          throw await input.declined(
            { id: "bkg_1", reference: "VX7K2M9Q", checkoutId: "chk_1", locale: "en" },
            new AppError("PAYMENT_DECLINED"),
          );
        },
      } as unknown as BookingOrchestrator,
      { enqueue: staffEnqueue } as unknown as StaffRecipients,
      { enqueue } as unknown as OutboxService,
      { now: () => new Date() } as unknown as Clock,
      new ConfigService(config) as never,
      { setContext: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as PinoLogger,
    );
    const error: unknown = await service
      .complete({
        checkoutId: "chk_1",
        paymentId: "pay_1",
        expectedTotal: { amount: "120.50", currency: "EUR" },
        card: { ok: true, card },
      })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );
    return {
      code: isAppError(error) ? error.code : undefined,
      ops: enqueue.mock.calls.map(([, input]) => ({ to: input.to, dedupeKey: input.dedupeKey })),
    };
  }

  it("[FIX-W29-OTA AC1] reads OPS_ALERT_EMAIL through the typed shared key and sends Velexis ops their copy", async () => {
    // ConfigService reads the process environment first: the configurations below decide alone.
    vi.stubEnv("OPS_ALERT_EMAIL", undefined);
    const withOps = await thirdDecline({
      STOREFRONT_BASE_DOMAIN: "ota.example.com",
      OPS_ALERT_EMAIL: "ops@velexis.example",
    });
    const withoutOps = await thirdDecline({ STOREFRONT_BASE_DOMAIN: "ota.example.com" });

    expect(withOps.code).toBe("PAYMENT_ATTEMPTS_EXCEEDED");
    expect(withOps.ops).toEqual([
      { to: "ops@velexis.example", dedupeKey: "staff.airline_card_alert:repeated_declines:chk_1:ops" },
    ]);
    expect(withoutOps.code).toBe("PAYMENT_ATTEMPTS_EXCEEDED");
    expect(withoutOps.ops).toEqual([]);
  });
});
