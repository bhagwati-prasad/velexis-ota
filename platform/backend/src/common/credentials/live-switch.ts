// The live switch of the OTA's own credentials (FIX-W40-PLATFORM, lead decision (2g) of 2026-11-03; PADR-0015,
// PADR-0010): `submitAmadeusCredentials` and `submitStripeApiKeys` for the `live` environment need FEATURE_LIVE_SWITCH
// as well as their own switch (`own_amadeus`, `own_stripe`, the operations' `x-feature`), as live API keys do
// (ApiKeysService). The operations' `x-feature` cannot say "only for live", so each service asks this first, after the
// guards and before any other rule of the request; the `test` environment never needs it.
import { AppError } from "@velexis/errors";
import type { Feature } from "../features";

/** The part of FeatureSwitches the check reads. */
export interface LiveSwitchReader {
  isEnabled(feature: Feature): boolean;
}

/**
 * Throws `403 FEATURE_DISABLED` with `details.feature = live_switch` for the `live` environment while the live switch
 * is off; returns for the `test` environment, and for `live` while the switch is on.
 */
export function liveSwitchOrThrow(switches: LiveSwitchReader, environment: "test" | "live"): void {
  if (environment === "live" && !switches.isEnabled("live_switch")) {
    throw new AppError("FEATURE_DISABLED", { details: { feature: "live_switch" } });
  }
}
