// The milestone feature switches of PADR-0015: six booleans of the platform backend's configuration, all `false`
// unless the environment turns them on (conventions §8: a switch that widens access defaults to `false`). The backend
// is the only place that enforces them:
//
// - `FeatureGuard` (common/auth/feature.guard.ts) answers `403 FEATURE_DISABLED` with `details.feature` for an
//   operation whose `x-feature` (or `@Feature(…)`) names a switch that is off;
// - the worker's scheduler registry skips the schedulers of a switch that is off (PBE-009);
// - `featuresFor()` builds the `features` object of `getMe` and `adminGetMe` (the `MilestoneFeatures` schema), from
//   which the portal and the admin hide what a switch turns off. They hold no switch of their own.
//
// The switch names are the `x-feature` values of the OpenAPI document (`F:<switch>` in the API inventory).
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types/platform";
import type { PlatformBackendConfig } from "../config";

/** The switches of PADR-0015, in the order of its table. */
export const FEATURES = Object.freeze([
  "stripe_billing",
  "own_stripe",
  "settlements",
  "own_amadeus",
  "custom_domains",
  "live_switch",
] as const);

/** A milestone switch: the value of `x-feature` and of `details.feature` in a `FEATURE_DISABLED` answer. */
export type Feature = (typeof FEATURES)[number];

/** The `features` object of `getMe` and `adminGetMe`: one boolean per switch, camelCase. */
export type MilestoneFeatures = components["schemas"]["MilestoneFeatures"];

/** The configuration variable of each switch (`FEATURE_<SWITCH>`, default `false`). */
export const FEATURE_VARIABLES = Object.freeze({
  stripe_billing: "FEATURE_STRIPE_BILLING",
  own_stripe: "FEATURE_OWN_STRIPE",
  settlements: "FEATURE_SETTLEMENTS",
  own_amadeus: "FEATURE_OWN_AMADEUS",
  custom_domains: "FEATURE_CUSTOM_DOMAINS",
  live_switch: "FEATURE_LIVE_SWITCH",
} as const satisfies { readonly [F in Feature]: `FEATURE_${Uppercase<F>}` });

/** A `FEATURE_*` variable of the configuration. */
export type FeatureVariable = (typeof FEATURE_VARIABLES)[Feature];

/** The property of each switch in `MilestoneFeatures`. */
export const FEATURE_PROPERTIES = Object.freeze({
  stripe_billing: "stripeBilling",
  own_stripe: "ownStripe",
  settlements: "settlements",
  own_amadeus: "ownAmadeus",
  custom_domains: "customDomains",
  live_switch: "liveSwitch",
} as const satisfies { readonly [F in Feature]: keyof MilestoneFeatures });

/** The switches of a configuration: the six `FEATURE_*` booleans. */
export type FeatureConfig = Pick<PlatformBackendConfig, FeatureVariable>;

/** True when `value` names a switch of PADR-0015. */
export function isFeature(value: unknown): value is Feature {
  return typeof value === "string" && (FEATURES as readonly string[]).includes(value);
}

/** True when the switch is on in `config`. */
export function isFeatureEnabled(config: FeatureConfig, feature: Feature): boolean {
  return config[FEATURE_VARIABLES[feature]];
}

/** The `features` object of `getMe` and `adminGetMe` for `config` (a new object every call). */
export function featuresFor(config: FeatureConfig): MilestoneFeatures {
  const features: Partial<Record<keyof MilestoneFeatures, boolean>> = {};
  for (const feature of FEATURES) {
    features[FEATURE_PROPERTIES[feature]] = isFeatureEnabled(config, feature);
  }
  return features as MilestoneFeatures;
}

/** The switches of this process, for guards, services and schedulers (provided by CommonModule). */
@Injectable()
export class FeatureSwitches {
  private readonly config: FeatureConfig;

  constructor(config: ConfigService<PlatformBackendConfig, true>) {
    const values: Partial<Record<FeatureVariable, boolean>> = {};
    for (const feature of FEATURES) {
      const variable = FEATURE_VARIABLES[feature];
      values[variable] = config.get(variable, { infer: true });
    }
    this.config = Object.freeze(values as FeatureConfig);
  }

  /** True when the switch is on. */
  isEnabled(feature: Feature): boolean {
    return isFeatureEnabled(this.config, feature);
  }

  /** The `features` object of `getMe` and `adminGetMe`. */
  features(): MilestoneFeatures {
    return featuresFor(this.config);
  }
}
