// The abuse limits of checkout.completeWithAirlineCard (OBE-051; OADR-0004 point 6) against a stand-in Redis client:
// what the answers of the two scripts mean, and the `503` of a Redis that cannot answer (the route never runs without
// its limits, architecture §10). The scripts themselves run against Redis 7 in
// test/integration/payments/airline-card-completion.int.test.ts.
import { isAppError } from "@velexis/errors";
import { describe, expect, it, vi } from "vitest";
import {
  AIRLINE_CARD_MAX_ATTEMPTS,
  AIRLINE_CARD_TENANT_DECLINES,
  AirlineCardLimits,
  type AbuseLimitsRedis,
} from "./abuse-limits";

const SCOPE = {
  tenantId: "ten_01M4T9E68084G7ZWYRD6Z1RV0W",
  environment: "test",
  checkoutId: "chk_01M4TA4Z0A1B2C3D4E5F6G7H8J",
} as const;

/** A client in `status` whose `eval` answers `reply` (or rejects with it when it is an Error). */
function client(
  reply: unknown,
  status = "ready",
): AbuseLimitsRedis & { readonly eval: ReturnType<typeof vi.fn> } {
  const evalFn = vi.fn(() => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)));
  return { status, eval: evalFn } as unknown as AbuseLimitsRedis & {
    readonly eval: ReturnType<typeof vi.fn>;
  };
}

/** The AppError code (and `details.reason`) a call rejects with. */
async function refusal(run: Promise<unknown>): Promise<readonly [string, unknown]> {
  const error: unknown = await run.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  if (!isAppError(error)) {
    throw new Error("no AppError");
  }
  return [error.code, error.details?.["reason"]] as const;
}

describe("the limits before a completion", () => {
  it("let a checkout with fewer than three declines through, reading its counter and the suspension flag", async () => {
    const redis = client([AIRLINE_CARD_MAX_ATTEMPTS - 1, 0]);

    await new AirlineCardLimits(redis).assertAvailable(SCOPE);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      2,
      `t:${SCOPE.tenantId}:test:ac:chk:${SCOPE.checkoutId}`,
      `t:${SCOPE.tenantId}:test:ac:suspended`,
    );
  });

  it("refuse the fourth attempt on a checkout: 403 PAYMENT_ATTEMPTS_EXCEEDED [OBE-051 AC2]", async () => {
    expect(await refusal(new AirlineCardLimits(client([3, 0])).assertAvailable(SCOPE))).toEqual([
      "PAYMENT_ATTEMPTS_EXCEEDED",
      undefined,
    ]);
  });

  it("refuse every completion while the method is suspended: 403 FEATURE_DISABLED, reason suspended", async () => {
    expect(await refusal(new AirlineCardLimits(client([0, 1])).assertAvailable(SCOPE))).toEqual([
      "FEATURE_DISABLED",
      "suspended",
    ]);
  });

  it("answer 503 SERVICE_UNAVAILABLE when Redis cannot answer, rather than run without the limits", async () => {
    const down = client([0, 0], "reconnecting");
    expect((await refusal(new AirlineCardLimits(down).assertAvailable(SCOPE)))[0]).toBe(
      "SERVICE_UNAVAILABLE",
    );
    expect(down.eval).not.toHaveBeenCalled();
    expect(
      (await refusal(new AirlineCardLimits(client(new Error("ECONNRESET"))).assertAvailable(SCOPE)))[0],
    ).toBe("SERVICE_UNAVAILABLE");
    expect((await refusal(new AirlineCardLimits(client("OK")).assertAvailable(SCOPE)))[0]).toBe(
      "SERVICE_UNAVAILABLE",
    );
  });
});

describe("the suspension where the method is offered (FIX-W29-OTA)", () => {
  it("[FIX-W29-OTA AC1] reads the tenant's flag of the environment: available, suspended, or unknown without an answer", async () => {
    const free = client(0);
    expect(await new AirlineCardLimits(free).suspension(SCOPE.tenantId, "live")).toBe("available");
    expect(free.eval).toHaveBeenCalledWith(expect.any(String), 1, `t:${SCOPE.tenantId}:live:ac:suspended`);
    expect(await new AirlineCardLimits(client(1)).suspension(SCOPE.tenantId, "test")).toBe("suspended");
    // A Redis that waits to reconnect, fails or answers something else never lets the method be offered.
    const down = client(0, "reconnecting");
    expect(await new AirlineCardLimits(down).suspension(SCOPE.tenantId, "test")).toBe("unknown");
    expect(down.eval).not.toHaveBeenCalled();
    expect(
      await new AirlineCardLimits(client(new Error("ECONNRESET"))).suspension(SCOPE.tenantId, "test"),
    ).toBe("unknown");
    expect(await new AirlineCardLimits(client("OK")).suspension(SCOPE.tenantId, "test")).toBe("unknown");
    expect(await new AirlineCardLimits(client([0])).suspension(SCOPE.tenantId, "test")).toBe("unknown");
  });

  it("[FIX-W29-OTA AC1] refuses to prepare a payment while suspended (403 FEATURE_DISABLED, reason suspended), 503 when Redis cannot say", async () => {
    await new AirlineCardLimits(client(0)).assertNotSuspended(SCOPE.tenantId, "test");
    expect(
      await refusal(new AirlineCardLimits(client(1)).assertNotSuspended(SCOPE.tenantId, "test")),
    ).toEqual(["FEATURE_DISABLED", "suspended"]);
    expect(
      (await refusal(new AirlineCardLimits(client(0, "end")).assertNotSuspended(SCOPE.tenantId, "test")))[0],
    ).toBe("SERVICE_UNAVAILABLE");
  });
});

describe("a counted decline", () => {
  it("counts on the checkout and the tenant with their TTLs, and locks the checkout at the third", async () => {
    const second = client([2, 7, 0]);
    const third = client([3, 8, 0]);

    expect(await new AirlineCardLimits(second).countDecline(SCOPE)).toEqual({
      attempts: 2,
      declines: 7,
      suspendedNow: false,
      locked: false,
    });
    expect(await new AirlineCardLimits(third).countDecline(SCOPE)).toMatchObject({
      attempts: 3,
      locked: true,
    });
    expect(second.eval).toHaveBeenCalledWith(
      expect.any(String),
      3,
      `t:${SCOPE.tenantId}:test:ac:chk:${SCOPE.checkoutId}`,
      `t:${SCOPE.tenantId}:test:ac:declines`,
      `t:${SCOPE.tenantId}:test:ac:suspended`,
      "7200",
      "3600",
      "3600",
      String(AIRLINE_CARD_TENANT_DECLINES),
    );
  });

  it("tells the decline that suspended the method, once", async () => {
    expect(await new AirlineCardLimits(client([1, 20, 1])).countDecline(SCOPE)).toMatchObject({
      suspendedNow: true,
    });
    expect(await new AirlineCardLimits(client([1, 21, 0])).countDecline(SCOPE)).toMatchObject({
      suspendedNow: false,
    });
  });

  it("is 503 SERVICE_UNAVAILABLE when Redis cannot count it", async () => {
    expect((await refusal(new AirlineCardLimits(client([1])).countDecline(SCOPE)))[0]).toBe(
      "SERVICE_UNAVAILABLE",
    );
    expect((await refusal(new AirlineCardLimits(client([], "end")).countDecline(SCOPE)))[0]).toBe(
      "SERVICE_UNAVAILABLE",
    );
  });
});
