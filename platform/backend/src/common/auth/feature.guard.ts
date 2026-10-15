// FeatureGuard (platform/docs/architecture.md §3 step 8, PADR-0015 item 2): an operation whose `x-feature` (or
// `@Feature(…)`) names a milestone switch that is off answers `403 FEATURE_DISABLED` with `details.feature` (the
// switch, for example `custom_domains`), so half-finished M5 endpoints cannot be reached in production. It runs after
// the auth guards: an unauthenticated caller learns nothing about the switches.
//
// PADR-0015 item 2 also combines the plan's `limits` and `features` (for example `customDomains > 0`) with the
// switches. Those depend on the tenant of the request, so they are not checked here yet: the M5 operations that need
// them (PLAN_LIMIT_REACHED, LIVE_MODE_NOT_ENABLED) add that check with the tenant.
import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { AppError } from "@velexis/errors";
import { FeatureSwitches } from "../features";
import { OperationPolicies } from "./decorators";

@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly policies: OperationPolicies,
    private readonly switches: FeatureSwitches,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== "http") {
      return true;
    }
    for (const feature of this.policies.forContext(context).features) {
      if (!this.switches.isEnabled(feature)) {
        throw new AppError("FEATURE_DISABLED", { details: { feature } });
      }
    }
    return true;
  }
}
