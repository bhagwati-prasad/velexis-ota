// Binding a controller method to its OpenAPI operation (ADR-0006, conventions §2 "Controllers are thin"):
//
//   @Post("v1/auth/sign-in")
//   @OpenApiOperation("signIn")
//   signIn(@OpenApiInput() input: ValidatedInput<"signIn">) { … }
//
// The validation interceptor (openapi-validation.interceptor.ts) reads the operation id, validates path, query,
// headers and body against the operation's schemas before the method runs, and leaves the validated input on the
// request. Path and query values arrive coerced to their schema types (`?limit=10` is the number 10), also through
// Nest's own `@Param()` and `@Query()`. The route-parity contract test checks that every handler's method and path
// are those of the operation it names.
import { createParamDecorator, SetMetadata, type ExecutionContext } from "@nestjs/common";
import type { operations } from "@velexis/api-types";
import type { OtaOperationId } from "@velexis/api-types/operations";

/** Metadata key of `@OpenApiOperation` on a handler. */
export const OPENAPI_OPERATION = "velexis:openapi-operation";

/** Binds a handler to an operation of the OTA document; a misspelt id does not compile. */
export function OpenApiOperation(operationId: OtaOperationId): MethodDecorator {
  return SetMetadata(OPENAPI_OPERATION, operationId);
}

/** Where the validation interceptor leaves the validated input on the request. */
export const VALIDATED_INPUT = Symbol("velexis:openapi-validated-input");

type OperationParameters<Id extends OtaOperationId> = operations[Id] extends { parameters: infer P }
  ? P
  : never;
type Part<P, K extends string> = P extends { [key in K]?: infer V }
  ? [V] extends [never]
    ? undefined
    : V
  : undefined;

/** The JSON request body of an operation, or `undefined` for operations without one. */
export type OperationBody<Id extends OtaOperationId> = operations[Id] extends {
  requestBody?: { content: { "application/json": infer B } };
}
  ? B
  : undefined;

/**
 * The validated input of a request bound to `Id`: path, query and header parameters by their documented names (header
 * names as written in the document, `Idempotency-Key`), coerced to their schema types, and the body as parsed.
 * Absent optional parameters are absent; nothing is defaulted.
 */
export interface ValidatedInput<Id extends OtaOperationId = OtaOperationId> {
  readonly operationId: Id;
  readonly path: Part<OperationParameters<Id>, "path">;
  readonly query: Part<OperationParameters<Id>, "query">;
  readonly headers: Part<OperationParameters<Id>, "header">;
  /** The parsed JSON body (absent when the operation has no body or an optional one was not sent). */
  readonly body: OperationBody<Id> | undefined;
}

/** Request with the validated input the interceptor attached. */
interface RequestWithInput {
  [VALIDATED_INPUT]?: ValidatedInput;
}

/**
 * The validated input of the current request (`ValidatedInput<"signIn">`). Only on handlers with
 * `@OpenApiOperation`: elsewhere there is nothing validated, and the decorator throws.
 */
export const OpenApiInput = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const input = context.switchToHttp().getRequest<RequestWithInput>()[VALIDATED_INPUT];
  if (input === undefined) {
    throw new Error("@OpenApiInput() is used on a handler without @OpenApiOperation()");
  }
  return input;
});
