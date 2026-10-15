// `@OpenApiOperation("signUp")` binds a controller method to its operation of the platform OpenAPI document
// (conventions §2: "Controllers are thin. They bind the route to its OpenAPI operation"). The validation
// interceptor validates the request against that operation before the handler runs, the route parity test
// (test/contract/route-parity.contract.test.ts) checks that the route's method and path are the operation's, and later
// guards read the operation's `x-scope`, `x-feature` and `x-mfa-step-up` through the same id.
import { createParamDecorator, SetMetadata, type ExecutionContext } from "@nestjs/common";
import type { PlatformOperationId } from "@velexis/api-types/operations";

/** The metadata key of the bound `operationId` on a handler. */
export const OPENAPI_OPERATION_METADATA = "velexis:openapi-operation";

/**
 * Binds a handler to the platform document's operation `operationId`. Only ids of the document compile; a handler
 * bound to an id the document lacks (a cast) stops the API at start-up.
 */
export function OpenApiOperation(operationId: PlatformOperationId): MethodDecorator {
  const decorator = SetMetadata(OPENAPI_OPERATION_METADATA, operationId);
  return (target, key, descriptor) => decorator(target, key, descriptor);
}

/** The `operationId` bound to a handler, or `undefined`. */
export function boundOperationId(handler: unknown): string | undefined {
  if (typeof handler !== "function") {
    return undefined;
  }
  const value: unknown = Reflect.getMetadata(OPENAPI_OPERATION_METADATA, handler);
  return typeof value === "string" ? value : undefined;
}

/**
 * The request after validation: the path, query and header parameters of the operation with the types of their
 * schemas (`limit` a number, defaults applied), and the body as validated. Header names are lower case.
 */
export interface ValidatedRequest {
  readonly path: Readonly<Record<string, unknown>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly header: Readonly<Record<string, unknown>>;
  readonly body: unknown;
}

/** Where the validation interceptor keeps the ValidatedRequest on the Express request. */
export const VALIDATED_REQUEST = Symbol("velexis:validated-request");

/** The ValidatedRequest of a request; throws when no validation ran (the handler has no @OpenApiOperation). */
export function validatedRequestOf(request: object): ValidatedRequest {
  const validated: unknown = Reflect.get(request, VALIDATED_REQUEST);
  if (validated === undefined) {
    throw new Error(
      "validatedRequestOf: the handler has no @OpenApiOperation, so its request was not validated",
    );
  }
  return validated as ValidatedRequest;
}

/**
 * A parameter decorator for one part of the ValidatedRequest: `@Validated("query") query: Record<string, unknown>`,
 * or the whole of it without an argument. Prefer it to `@Query()` and `@Param()`, whose values are the raw strings.
 */
export const Validated = createParamDecorator(
  (part: keyof ValidatedRequest | undefined, context: ExecutionContext): unknown => {
    const validated = validatedRequestOf(context.switchToHttp().getRequest<object>());
    return part === undefined ? validated : validated[part];
  },
);
