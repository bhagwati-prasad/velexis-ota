// The airline-card gateway (ota/docs/architecture.md §5.1, ADR-0011 (B, D), OADR-0004 points 1, 4 and 5; OBE-050):
// the payment method whose card goes to the airline inside Flight Create Orders, so there is no payment provider to
// call. It is inert next to `StripeGateway`: `createSession` makes no call and only gives the columns of the new
// `payments` row, and nothing else of a provider exists on this path (the card is charged by the airline in the
// booking call of checkout.completeWithAirlineCard, OBE-051, and voids and refunds are the airline's).
//
// Enabled only when both switches are on (OADR-0004 point 1): the global kill switch `AIRLINE_CARD_ENABLED` of the
// API's configuration, and `storefront_settings.airline_card_enabled_<env>` for the request's environment. Either off
// is `403 FEATURE_DISABLED` with `details.feature = "airlineCard"`. Who may use it (the storefront edge only, `403
// SCOPE_NOT_ALLOWED` for every key caller) is checked by the payment step (payments.service.ts).
//
// The row of an airline-card payment satisfies `payments_airline_card_ck` (ota/docs/data-model.md §3.1): `provider =
// 'airline'`, `method = 'airline_card'`, `capture_method = 'automatic'`, and no provider payment or customer id, no
// expiry, no 3-D Secure data and no stored `next_action`. Its `nextAction` (`airline_card_form` while the card is
// awaited) and its 3-D Secure state (never required) are derived from its status here, never stored.
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types";
import { AppError } from "@velexis/errors";
import type { ApiConfig } from "../../config";

type Schemas = components["schemas"];
type PaymentNextAction = Schemas["PaymentNextAction"];
type PaymentThreeDSecure = Schemas["PaymentThreeDSecure"];

/** `payments.provider` of an airline-card payment. */
export const AIRLINE_PROVIDER = "airline";
/** `payments.method` of an airline-card payment (PaymentCreateRequest.method). */
export const AIRLINE_CARD_METHOD = "airline_card";
/** `details.feature` of the `403 FEATURE_DISABLED` of a refused airline card. */
export const AIRLINE_CARD_FEATURE = "airlineCard";

/** The settings columns of the tenant's airline card (`storefront_settings.airline_card_enabled_test/live`). */
export interface AirlineCardSettings {
  readonly airlineCardEnabledTest: boolean;
  readonly airlineCardEnabledLive: boolean;
}

/** Whether the airline card is on for `environment`: the global switch and the tenant's setting of the environment. */
export function airlineCardEnabled(
  globalSwitch: boolean,
  settings: AirlineCardSettings,
  environment: "test" | "live",
): boolean {
  return (
    globalSwitch &&
    (environment === "live" ? settings.airlineCardEnabledLive : settings.airlineCardEnabledTest)
  );
}

/** The `403 FEATURE_DISABLED` of an airline card that is not enabled (either switch). */
export function airlineCardDisabled(): AppError<"FEATURE_DISABLED"> {
  return new AppError("FEATURE_DISABLED", {
    message: "The airline card is not enabled for this storefront.",
    details: { feature: AIRLINE_CARD_FEATURE },
  });
}

/** The columns a new airline-card payment gets from the gateway: no provider, nothing a provider would give. */
export interface AirlinePaymentColumns {
  readonly provider: typeof AIRLINE_PROVIDER;
  readonly method: typeof AIRLINE_CARD_METHOD;
  readonly provider_connection_id: null;
  readonly provider_payment_id: null;
  readonly provider_customer_id: null;
  readonly capture_method: "automatic";
  readonly status: "requires_payment_method";
  readonly card_exp_month: null;
  readonly card_exp_year: null;
  readonly three_ds: null;
  readonly next_action: null;
}

/** What the front end does next with an airline-card payment in `status` (PaymentNextAction). */
export function airlineCardNextAction(status: string): PaymentNextAction {
  if (status === "requires_payment_method") {
    return { type: "airline_card_form", redirectUrl: null };
  }
  return { type: status === "processing" ? "wait" : "none", redirectUrl: null };
}

/** The 3-D Secure state of every airline-card payment: none is run (OADR-0004, ADR-0011 (B)). */
export const AIRLINE_CARD_THREE_D_SECURE: Readonly<PaymentThreeDSecure> = Object.freeze({
  required: false,
  status: "not_required",
  version: null,
});

@Injectable()
export class AirlineCardGateway {
  private readonly globalSwitch: boolean;

  constructor(config: ConfigService<ApiConfig, true>) {
    this.globalSwitch = config.get("AIRLINE_CARD_ENABLED", { infer: true });
  }

  /** `AIRLINE_CARD_ENABLED`: the global kill switch. */
  get globallyEnabled(): boolean {
    return this.globalSwitch;
  }

  /** Refuses the method while the global kill switch is off (`403 FEATURE_DISABLED`). */
  assertGloballyEnabled(): void {
    if (!this.globalSwitch) {
      throw airlineCardDisabled();
    }
  }

  /** Refuses the method unless both switches are on for `environment` (`403 FEATURE_DISABLED`). */
  assertEnabled(environment: "test" | "live", settings: AirlineCardSettings): void {
    if (!airlineCardEnabled(this.globalSwitch, settings, environment)) {
      throw airlineCardDisabled();
    }
  }

  /** A new airline-card payment: no provider call, only the columns its row gets (see the file header). */
  createSession(): AirlinePaymentColumns {
    return {
      provider: AIRLINE_PROVIDER,
      method: AIRLINE_CARD_METHOD,
      provider_connection_id: null,
      provider_payment_id: null,
      provider_customer_id: null,
      capture_method: "automatic",
      status: "requires_payment_method",
      card_exp_month: null,
      card_exp_year: null,
      three_ds: null,
      next_action: null,
    };
  }
}
