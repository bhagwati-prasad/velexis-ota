// The live switch of the OTA's own credentials (FIX-W40-PLATFORM, lead decision (2g) of 2026-11-03): the rule the
// services of `submitAmadeusCredentials` and `submitStripeApiKeys` ask first. The HTTP answers are proven in
// test/integration/supplier-connections/own-credentials.int.test.ts and
// test/integration/connections/stripe-api-keys.int.test.ts.
import { AppError } from "@velexis/errors";
import { describe, expect, it } from "vitest";
import type { Feature } from "../features";
import { liveSwitchOrThrow } from "./live-switch";

const switchesWith = (...on: Feature[]) => ({
  isEnabled: (feature: Feature): boolean => on.includes(feature),
});

/** The error `liveSwitchOrThrow` throws, or `undefined`. */
function thrown(work: () => void): unknown {
  try {
    work();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("liveSwitchOrThrow", () => {
  it("[FIX-W40-PLATFORM AC7] refuses the live environment with FEATURE_DISABLED (live_switch) while the live switch is off", () => {
    const error = thrown(() => liveSwitchOrThrow(switchesWith("own_amadeus", "own_stripe"), "live"));

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "FEATURE_DISABLED", details: { feature: "live_switch" } });
  });

  it("[FIX-W40-PLATFORM AC7] lets the live environment through with the switch on, and the test environment always", () => {
    expect(thrown(() => liveSwitchOrThrow(switchesWith("live_switch"), "live"))).toBeUndefined();
    expect(thrown(() => liveSwitchOrThrow(switchesWith(), "test"))).toBeUndefined();
    expect(thrown(() => liveSwitchOrThrow(switchesWith("live_switch"), "test"))).toBeUndefined();
  });
});
