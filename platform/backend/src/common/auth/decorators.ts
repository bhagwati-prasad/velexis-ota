// What the auth guards know about a handler (platform/docs/architecture.md §3, steps 5, 7 and 8), and the decorators
// and request helpers around them:
//
// - `OperationPolicies` reads each operation of the platform document once, at start-up: its `x-scope` from the
//   operations index (`@velexis/api-types/operations`), its `x-mfa-step-up` and `x-feature` from the document. A scope,
//   step-up flag or switch it does not know stops the API. The guards ask it for the policy of the handler a request
//   reached (`@OpenApiOperation`), so a route is protected by what its operation says, never by what a controller
//   remembers to add.
// - `@RequireRecentMfa()` and `@Feature("custom_domains")` (architecture §3, PADR-0015 item 2) add a step-up or a
//   switch to a handler or a controller on top of its operation; they never remove one.
// - The auth guards keep the verified access token on the request (`accessTokenOf`, `@AccessToken()`) and the actor in
//   the request context.
//
// A handler without @OpenApiOperation has no policy and no guard acts on it, as the validation interceptor does not
// validate it: the route parity test (test/contract/route-parity.contract.test.ts) fails for any route of the API
// without one, so only test-only controllers have such handlers.
import { createParamDecorator, SetMetadata, type ExecutionContext } from "@nestjs/common";
import { platformOperations, type ApiOperation } from "@velexis/api-types/operations";
import type { AccessTokenClaims } from "../../auth/token.service";
import { isFeature, type Feature as FeatureName } from "../features";
import { boundOperationId } from "../http/openapi-operation.decorator";
import type { PlatformOpenApi } from "../http/openapi-validation.interceptor";

/** The `x-scope` values of the platform document (platform/backend/openapi/README.md §4). */
export const OPERATION_SCOPES = Object.freeze([
  "public",
  "portal_unverified",
  "portal",
  "platform_admin",
  "internal",
  "webhook",
] as const);
export type OperationScope = (typeof OPERATION_SCOPES)[number];

/** The scopes whose operations need an access token: the portal's two and the admin's. */
export const TOKEN_SCOPES = Object.freeze(["portal_unverified", "portal", "platform_admin"] as const);
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export function isTokenScope(scope: OperationScope | undefined): scope is TokenScope {
  return (TOKEN_SCOPES as readonly (string | undefined)[]).includes(scope);
}

/** What the guards enforce for one handler. */
export interface OperationPolicy {
  /** The bound operation; `undefined` for a handler without @OpenApiOperation. */
  readonly operationId: string | undefined;
  /** `x-scope`; `undefined` for a handler without @OpenApiOperation (no auth guard acts). */
  readonly scope: OperationScope | undefined;
  /** `x-mfa-step-up: true` or `@RequireRecentMfa()`: a TOTP verification within 15 minutes. */
  readonly mfaStepUp: boolean;
  /** `x-feature` and `@Feature(…)`: every switch must be on. */
  readonly features: readonly FeatureName[];
}

/** The metadata key of `@RequireRecentMfa()`. */
export const RECENT_MFA_METADATA = "velexis:require-recent-mfa";
/** The metadata key of `@Feature(…)`. */
export const FEATURE_METADATA = "velexis:feature";

/**
 * The handler (or every handler of the controller) needs a TOTP step-up within the last 15 minutes (RecentMfaGuard),
 * as if its operation had `x-mfa-step-up: true`. It needs a portal or admin token, so put it only on handlers whose
 * scope has one.
 */
export function RequireRecentMfa(): MethodDecorator & ClassDecorator {
  return SetMetadata(RECENT_MFA_METADATA, true);
}

/** The handler (or every handler of the controller) needs the milestone switch on (FeatureGuard, PADR-0015). */
export function Feature(feature: FeatureName): MethodDecorator & ClassDecorator {
  if (!isFeature(feature)) {
    throw new TypeError("@Feature(): not a switch of PADR-0015");
  }
  return SetMetadata(FEATURE_METADATA, feature);
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The operation object of the document at `paths[path][method]`. */
function operationObject(api: PlatformOpenApi, path: string, method: string): JsonObject {
  const paths = api.document["paths"];
  const item = isObject(paths) ? paths[path] : undefined;
  const operation = isObject(item) ? item[method] : undefined;
  return isObject(operation) ? operation : {};
}

/** A policy before the decorators of a handler are added. */
type OperationEntry = Pick<OperationPolicy, "scope" | "mfaStepUp" | "features">;

const NO_OPERATION: OperationEntry = Object.freeze({ scope: undefined, mfaStepUp: false, features: [] });

/**
 * The policy of every operation of the platform document. Built once per application (CommonModule provides it from
 * the PlatformOpenApi of the process); `index` is the operations index, replaceable in unit tests together with a
 * small document.
 */
export class OperationPolicies {
  private readonly byId = new Map<string, OperationEntry>();
  private readonly byHandler = new WeakMap<object, OperationPolicy>();

  constructor(api: PlatformOpenApi, index: readonly ApiOperation[] = platformOperations) {
    const scopes = new Map(index.map((operation) => [operation.operationId, operation.scope]));
    for (const { operationId, method, path } of api.operations()) {
      const scope = scopes.get(operationId);
      if (!(OPERATION_SCOPES as readonly unknown[]).includes(scope)) {
        throw new Error(
          `${operationId}: the operations index gives no x-scope of ${OPERATION_SCOPES.join(", ")} (run pnpm contracts:generate)`,
        );
      }
      const operation = operationObject(api, path, method);
      const stepUp = operation["x-mfa-step-up"];
      const feature = operation["x-feature"];
      if (stepUp !== undefined && typeof stepUp !== "boolean") {
        throw new Error(`${operationId}: x-mfa-step-up must be true or false`);
      }
      if (stepUp === true && !isTokenScope(scope as OperationScope)) {
        throw new Error(`${operationId}: x-mfa-step-up needs a portal or platform_admin scope`);
      }
      if (feature !== undefined && !isFeature(feature)) {
        throw new Error(`${operationId}: x-feature is not a switch of PADR-0015`);
      }
      this.byId.set(
        operationId,
        Object.freeze({
          scope: scope as OperationScope,
          mfaStepUp: stepUp === true,
          features: Object.freeze(feature === undefined ? [] : [feature]),
        }),
      );
    }
  }

  /** The policy of an operation of the document, without decorators; `undefined` when the document lacks it. */
  forOperation(operationId: string): OperationEntry | undefined {
    return this.byId.get(operationId);
  }

  /**
   * The policy of the handler a request reached: its operation's, plus `@RequireRecentMfa()` and `@Feature(…)` on the
   * handler or its controller. A handler bound to an operation the document lacks throws (the validation
   * interceptor already refuses to start with one).
   */
  forContext(context: ExecutionContext): OperationPolicy {
    const handler = context.getHandler();
    let policy = this.byHandler.get(handler);
    if (policy === undefined) {
      policy = this.compose(handler, context.getClass());
      this.byHandler.set(handler, policy);
    }
    return policy;
  }

  private compose(handler: object, controller: object): OperationPolicy {
    const operationId = boundOperationId(handler);
    const entry = operationId === undefined ? NO_OPERATION : this.byId.get(operationId);
    if (entry === undefined) {
      throw new Error(
        `@OpenApiOperation("${operationId ?? ""}"): the platform document has no such operation`,
      );
    }
    const decorated = (key: string): unknown[] =>
      [handler, controller].map((target): unknown => Reflect.getMetadata(key, target));
    const features = new Set<FeatureName>(entry.features);
    for (const feature of decorated(FEATURE_METADATA)) {
      if (isFeature(feature)) {
        features.add(feature);
      }
    }
    return Object.freeze({
      operationId,
      scope: entry.scope,
      mfaStepUp: entry.mfaStepUp || decorated(RECENT_MFA_METADATA).includes(true),
      features: Object.freeze([...features]),
    });
  }
}

/** Where the auth guards keep the verified access token on the request. */
const ACCESS_TOKEN = Symbol("velexis:access-token");

/** Keeps the verified claims on the request (PortalAuthGuard, AdminAuthGuard). */
export function setAccessToken(request: object, claims: AccessTokenClaims): void {
  Reflect.set(request, ACCESS_TOKEN, claims);
}

/** The verified access token of the request; `undefined` before an auth guard verified one (or for `public`). */
export function accessTokenOf(request: object): AccessTokenClaims | undefined {
  const claims: unknown = Reflect.get(request, ACCESS_TOKEN);
  return claims === undefined ? undefined : (claims as AccessTokenClaims);
}

/**
 * The verified access token of a `portal_unverified`, `portal` or `platform_admin` handler:
 * `@AccessToken() token: AccessTokenClaims` (`token.sub` is the account). Throws on a handler that has none.
 */
export const AccessToken = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AccessTokenClaims => {
    const claims = accessTokenOf(context.switchToHttp().getRequest<object>());
    if (claims === undefined) {
      throw new Error(
        "@AccessToken(): no auth guard verified a token for this handler (is its x-scope public?)",
      );
    }
    return claims;
  },
);
