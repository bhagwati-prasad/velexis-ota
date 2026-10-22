// StripeSignatureGuard(endpoint) (PBE-043; PADR-0002 item 4): `Stripe-Signature` on the raw body, with the endpoint's
// secret and the 5-minute tolerance on the process's Clock. A refusal is `400 WEBHOOK_SIGNATURE_INVALID` and a security
// event that never holds the body, the header or the secret. The fixtures are the X-028 events, signed here with a
// secret made for this file. The receiver's whole pipeline runs in test/integration/billing/billing-webhook.int.test.ts.
import { randomBytes } from "node:crypto";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { AppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import { signedStripeEvent } from "@velexis/testing/stripe";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import type { PlatformBackendConfig } from "../../config";
import type { Clock } from "../clock";
import type { RequestContext } from "../http/request-context";
import type { StripeEndpoint } from "./stripe-events.repository";
import {
  STRIPE_WEBHOOK_SECRET_VARIABLES,
  StripeSignatureGuard,
  verifiedStripeEventOf,
} from "./stripe-signature.guard";

const SECRET = `whsec_${randomBytes(24).toString("base64url")}`;
const OTHER_SECRET = `whsec_${randomBytes(24).toString("base64url")}`;
const IP = "203.0.113.9";

interface Harness {
  readonly guard: CanActivate;
  readonly clock: FakeClock;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly error: ReturnType<typeof vi.fn>;
}

function harness(endpoint: StripeEndpoint, secrets: Partial<Record<string, string>>): Harness {
  const clock = new FakeClock();
  const warn = vi.fn();
  const error = vi.fn();
  const config = { get: (name: string) => secrets[name] } as unknown as ConfigService<
    PlatformBackendConfig,
    true
  >;
  const Guard = StripeSignatureGuard(endpoint);
  const guard = new Guard(
    config,
    clock as unknown as Clock,
    { ip: IP } as unknown as RequestContext,
    { warn, error } as unknown as PinoLogger,
  );
  return { guard, clock, warn, error };
}

/** A request as the JSON parser of `/webhooks/*` leaves it: the raw bytes next to the parsed body. */
function request(
  payload: string | undefined,
  signature: string | string[] | undefined,
): Record<string, unknown> {
  return {
    headers: signature === undefined ? {} : { "stripe-signature": signature },
    ...(payload === undefined
      ? {}
      : { rawBody: Buffer.from(payload, "utf8"), body: JSON.parse(payload) as unknown }),
  };
}

function contextOf(req: object): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

/** The guard's answer: `true`, or the code of the AppError it threw. */
function verdict(guard: CanActivate, req: object): unknown {
  try {
    return guard.canActivate(contextOf(req));
  } catch (thrown) {
    return thrown instanceof AppError ? `${thrown.status} ${thrown.code}` : thrown;
  }
}

const billingSecrets = { [STRIPE_WEBHOOK_SECRET_VARIABLES.billing]: SECRET };

describe("StripeSignatureGuard", () => {
  it("[PBE-043 AC1] accepts each billing fixture signed with the endpoint's secret and keeps the verified event", () => {
    const { guard, clock } = harness("billing", billingSecrets);
    for (const type of [
      "checkout.session.completed",
      "customer.subscription.updated",
      "invoice.paid",
    ] as const) {
      const { payload, header, event } = signedStripeEvent(type, undefined, SECRET, {
        timestamp: clock.now(),
      });
      const req = request(payload, header);

      expect(verdict(guard, req)).toBe(true);
      expect(verifiedStripeEventOf(req)).toEqual(event);
    }
  });

  it("[PBE-043 AC1] refuses a payload changed after signing, and logs a security event without the body", () => {
    const { guard, clock, warn } = harness("billing", billingSecrets);
    const { payload, header } = signedStripeEvent("invoice.paid", undefined, SECRET, {
      timestamp: clock.now(),
    });
    const changed = payload.replace('"status": "paid"', '"status": "void"');
    expect(changed).not.toBe(payload);
    const req = request(changed, header);

    expect(verdict(guard, req)).toBe("400 WEBHOOK_SIGNATURE_INVALID");
    expect(verifiedStripeEventOf(req)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      {
        securityEvent: "stripe.webhook_signature_invalid",
        endpoint: "billing",
        reason: "signature_mismatch",
        ip: IP,
      },
      "stripe.webhook_signature_invalid",
    );
    const logged = JSON.stringify(warn.mock.calls);
    for (const value of [SECRET, header, "in_test_alpha_1"]) {
      expect(logged).not.toContain(value);
    }
  });

  it.each([
    [
      "another endpoint's secret",
      () => ({ secret: OTHER_SECRET, at: 0, header: undefined }),
      "signature_mismatch",
    ],
    [
      "a timestamp more than 5 minutes old",
      () => ({ secret: SECRET, at: -301_000, header: undefined }),
      "signature_mismatch",
    ],
    ["no Stripe-Signature header", () => ({ secret: SECRET, at: 0, header: null }), "no_signature"],
    [
      "two Stripe-Signature headers",
      () => ({ secret: SECRET, at: 0, header: ["t=1,v1=a", "t=1,v1=b"] }),
      "no_signature",
    ],
    [
      "an oversized header",
      () => ({ secret: SECRET, at: 0, header: `t=1,v1=${"a".repeat(4096)}` }),
      "no_signature",
    ],
    [
      "a header that is not Stripe's",
      () => ({ secret: SECRET, at: 0, header: "sha256=abc" }),
      "signature_mismatch",
    ],
  ] as const)("refuses %s", (_case, setup, reason) => {
    const { guard, clock, warn } = harness("billing", billingSecrets);
    const { secret, at, header } = setup();
    const signed = signedStripeEvent("invoice.paid", undefined, secret, {
      timestamp: new Date(clock.now().getTime() + at),
    });
    const sent = header === undefined ? signed.header : header === null ? undefined : header;

    expect(verdict(guard, request(signed.payload, sent))).toBe("400 WEBHOOK_SIGNATURE_INVALID");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason }),
      "stripe.webhook_signature_invalid",
    );
  });

  it("accepts a signature within the tolerance on the process's clock, not the machine's", () => {
    const { guard, clock } = harness("billing", billingSecrets);
    const signed = signedStripeEvent("invoice.paid", undefined, SECRET, {
      timestamp: new Date(clock.now().getTime() - 290_000),
    });

    expect(verdict(guard, request(signed.payload, signed.header))).toBe(true);
    clock.advance(20_000);
    expect(verdict(guard, request(signed.payload, signed.header))).toBe("400 WEBHOOK_SIGNATURE_INVALID");
  });

  it("refuses a request without a raw body (the JSON parser keeps one on /webhooks/* only)", () => {
    const { guard, warn } = harness("billing", billingSecrets);

    expect(verdict(guard, { headers: { "stripe-signature": "t=1,v1=a" }, body: {} })).toBe(
      "400 WEBHOOK_SIGNATURE_INVALID",
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "no_body" }),
      "stripe.webhook_signature_invalid",
    );
  });

  it("[PBE-043] refuses every delivery while the endpoint has no secret, with an error line naming the variable", () => {
    const { guard, clock, error, warn } = harness("billing", {});
    const signed = signedStripeEvent("invoice.paid", undefined, SECRET, { timestamp: clock.now() });

    expect(verdict(guard, request(signed.payload, signed.header))).toBe("400 WEBHOOK_SIGNATURE_INVALID");
    expect(error).toHaveBeenCalledWith(
      { endpoint: "billing", variable: "STRIPE_BILLING_WEBHOOK_SECRET" },
      "stripe.webhook_secret_missing",
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "secret_missing" }),
      expect.any(String),
    );
  });

  it("checks each endpoint with its own secret, one guard class per endpoint", () => {
    expect(StripeSignatureGuard("billing")).toBe(StripeSignatureGuard("billing"));
    expect(StripeSignatureGuard("billing")).not.toBe(StripeSignatureGuard("connect_accounts"));
    const connect = harness("connect_accounts", {
      [STRIPE_WEBHOOK_SECRET_VARIABLES.billing]: SECRET,
      [STRIPE_WEBHOOK_SECRET_VARIABLES.connect_accounts]: OTHER_SECRET,
    });
    const billingSigned = signedStripeEvent("account.updated", undefined, SECRET, {
      timestamp: connect.clock.now(),
    });
    const connectSigned = signedStripeEvent("account.updated", undefined, OTHER_SECRET, {
      timestamp: connect.clock.now(),
    });

    expect(verdict(connect.guard, request(billingSigned.payload, billingSigned.header))).toBe(
      "400 WEBHOOK_SIGNATURE_INVALID",
    );
    expect(verdict(connect.guard, request(connectSigned.payload, connectSigned.header))).toBe(true);
    expect(() => StripeSignatureGuard("payments" as StripeEndpoint)).toThrow(TypeError);
  });
});
