// The SDK contract test (OADR-0016 point 4, ota/sdk/docs/types-and-builds.md §4, task SDK-006): the hand-written
// assertions and the helpers of the generated per-method assertions in methods.generated.ts. This project is compiled
// with `tsc --noEmit` (test/contract/tsconfig.json) against three module names:
//
// - `velexis-contract`, the frozen TypeScript contract docs/velexis-sdk/sdk/src/index.d.ts, which is never edited;
// - `@velexis/ota-sdk`, the declarations that `tsc -p tsconfig.build.json` emits from the JSDoc of src/;
// - `@velexis/api-types`, the types generated from the working OpenAPI document, for both, so they share one schema.
//
// Every assertion is a type whose type arguments must satisfy a constraint, so a mismatch is a compile error that names
// both types. Direction matters: the SDK must accept everything the contract accepts (the contract's parameters are
// assignable to the SDK's) and resolve with at least what the contract promises (the SDK's results are assignable to
// the contract's). Additions are allowed; removing or narrowing anything is not (ADR-0019). What the SDK does not have
// yet is listed in pending-namespaces.js; the approved deviations are in deviations.ts.
import type * as Sdk from "@velexis/ota-sdk";
import type * as Contract from "velexis-contract";

import type { ContractClient } from "./deviations.js";
import type { PENDING } from "./pending-namespaces.js";

/* ------------------------------------------------------------------------------------------------------------ */
/* Helpers                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

/** Compiles only when `Source` is assignable to `Target`; the error shows both types. */
export type Assignable<Target, Source extends Target> = [Target, Source];

/** Any function, for the shape checks. */
type AnyFunction = (...args: never[]) => unknown;

/** What fails an assertion in place of a type: the compiler error shows the reason. */
type Problem<Reason extends string, Method extends string = never> = { problem: Reason; method: Method };

declare const _missing: unique symbol;
/** What `Member` finds where a dotted path names nothing. */
export type Missing = typeof _missing;

/** The member of `T` at a dotted path (`"reference.locations.search"`), or `Missing`. */
export type Member<T, Path extends string> = Path extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? Member<T[Head], Rest>
    : Missing
  : Path extends keyof T
    ? T[Path]
    : Missing;

/** The namespaces and methods that pending-namespaces.js lists. */
export type PendingEntry = (typeof PENDING)[number]["entry"];

/** Whether an entry of pending-namespaces.js covers a method. */
export type IsPending<Method extends string> = Method extends PendingEntry | `${PendingEntry}.${string}`
  ? true
  : false;

export type PendingListAssertions = [
  // pending-namespaces.js keeps its names as literal types (`@type {const}`): with plain `string` every method would
  // count as pending, and the assertions of a missing method would hold by themselves.
  Assignable<{ literalNames: true }, { literalNames: string extends PendingEntry ? false : true }>,
];

/** Whether the SDK client has the namespace of a dotted path (`"console"` for `"console.bookings.get"`). */
type HasNamespace<Method extends string> = Method extends `${infer Head}.${string}`
  ? Head extends keyof Sdk.VelexisClient
    ? true
    : false
  : false;

/** What a pending method stands in with: `StandIn`, unless a contract method's namespace is already written. */
type PendingStandIn<Method extends string, StandIn, OfContract extends boolean> = OfContract extends true
  ? HasNamespace<Method> extends true
    ? Problem<"a method of the contract missing from a namespace that the SDK client already has", Method>
    : StandIn
  : StandIn;

/**
 * The SDK client's method at a dotted path. A pending method that the client does not have yet is replaced by
 * `StandIn`, so its assertions hold until the SDK task that writes it; a method that is neither there nor pending is
 * a `Problem` that fails every assertion with the reason. A method of the frozen contract (`OfContract`) stands in
 * only while the client has no namespace of that name at all: once an SDK task writes the namespace, every contract
 * method in it is checked, even while the namespace stays pending for its additions (SDK-011 writes the contract's
 * `console` methods and keeps `console` pending until SDK-012 adds `console.settings` and `console.payments`).
 */
type SdkMethodOr<Method extends string, StandIn, OfContract extends boolean> =
  Member<Sdk.VelexisClient, Method> extends infer Found
    ? [Found] extends [Missing]
      ? IsPending<Method> extends true
        ? PendingStandIn<Method, StandIn, OfContract>
        : Problem<"missing from the SDK client and not listed in pending-namespaces.js", Method>
      : Found
    : never;

/** The parameter list of a function, or the value itself when it is none (it then fails the assertion). */
type ParamsOf<F> = [F] extends [(...args: infer Params) => unknown] ? Params : F;

/** The awaited result of a function, or the value itself when it is none (it then fails the assertion). */
type ResultOf<F> = [F] extends [(...args: never[]) => infer Result] ? Awaited<Result> : F;

/** A result that proves nothing (`any` or `never`) becomes a `Problem` that fails the assertion with the reason. */
type Meaningful<Result> = 0 extends 1 & Result
  ? Problem<"the SDK method resolves with any">
  : [Result] extends [never]
    ? Problem<"the SDK method resolves with never">
    : Result;

/** The contract's member at a dotted path, with the approved deviations of deviations.ts applied. */
export type ContractMember<Method extends string> = Member<ContractClient, Method>;

/** The contract's parameters of a method. */
export type ContractParams<Method extends string> = ParamsOf<ContractMember<Method>>;

/** The contract's awaited result of a method. */
export type ContractResult<Method extends string> = ResultOf<ContractMember<Method>>;

/** The SDK's parameters of a contract method (the contract's own while its namespace is pending and absent). */
export type SdkParams<Method extends string> = ParamsOf<SdkMethodOr<Method, ContractMember<Method>, true>>;

/** The SDK's awaited result of a contract method (the contract's own while its namespace is pending and absent). */
export type SdkResult<Method extends string> = Meaningful<
  ResultOf<SdkMethodOr<Method, ContractMember<Method>, true>>
>;

/** The SDK's method for an addition to the contract (any method while it is pending and absent). */
export type SdkMember<Method extends string> = SdkMethodOr<
  Method,
  (...args: never[]) => Promise<unknown>,
  false
>;

/**
 * The assertion of one contract method (methods.generated.ts): compiles only when the contract's parameters are
 * assignable to the SDK's and the SDK's awaited result is assignable to the contract's. Explicit, because TypeScript
 * compares the methods of two interfaces bivariantly, so plain assignability of the namespaces would miss a narrowed
 * parameter.
 */
export type Conforms<
  SdkParameters,
  ContractParameters extends SdkParameters,
  ContractResolves,
  SdkResolves extends ContractResolves,
> = [SdkParameters, ContractParameters, ContractResolves, SdkResolves];

/**
 * The assertion of one addition to the contract (an `x-sdk-method` that the frozen contract does not have,
 * ota/sdk/docs/extensions.md): the client has it as a method that returns a promise, and the contract really lacks it.
 */
export type Addition<
  SdkMethod extends (...args: never[]) => Promise<unknown>,
  ContractMethod extends Missing,
> = [SdkMethod, ContractMethod];

/** The dotted paths of every method of `T` and its nested objects. */
type MethodPaths<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends AnyFunction ? `${Prefix}${K}` : MethodPaths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Every method of the contract client by its dotted path (`flights.search`), without `withOptions` and `request`. */
export type ContractMethodPath = Exclude<MethodPaths<ContractClient>, "withOptions" | "request">;

/** `T` without the members at the given dotted paths (namespaces or methods). */
type OmitPaths<T, Paths extends string> = {
  [K in keyof T as K extends Paths ? never : K]: K extends string
    ? T[K] extends AnyFunction
      ? T[K]
      : OmitPaths<T[K], Paths extends `${K}.${infer Rest}` ? Rest : never>
    : T[K];
};

/* ------------------------------------------------------------------------------------------------------------ */
/* createVelexisClient, VelexisClient, VERSION                                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

type SdkClient = Sdk.VelexisClient;
/** The contract client without what the SDK does not have yet (pending-namespaces.js). */
type ContractClientSoFar = OmitPaths<Omit<ContractClient, "withOptions">, PendingEntry>;

export type ClientAssertions = [
  // createVelexisClient takes the contract's options and returns the SDK's client.
  Assignable<Parameters<typeof Sdk.createVelexisClient>, Parameters<typeof Contract.createVelexisClient>>,
  Assignable<SdkClient, ReturnType<typeof Sdk.createVelexisClient>>,
  // The client has every namespace and method of the contract that is not pending; the strict per-method checks are
  // in methods.generated.ts.
  Assignable<ContractClientSoFar, Omit<SdkClient, "withOptions">>,
  // withOptions takes the contract's overrides and returns a client of the same kind.
  Assignable<Parameters<SdkClient["withOptions"]>, Parameters<Contract.VelexisClient["withOptions"]>>,
  Assignable<SdkClient, ReturnType<SdkClient["withOptions"]>>,
  // request: the contract's escape hatch, generic in its result.
  Assignable<Parameters<SdkClient["request"]>, Parameters<Contract.VelexisClient["request"]>>,
  Assignable<Contract.VelexisClient["request"], SdkClient["request"]>,
  Assignable<Contract.HttpMethod, Sdk.HttpMethod>,
  Assignable<Sdk.HttpMethod, Contract.HttpMethod>,
  Assignable<string, typeof Sdk.VERSION>,
];

/* ------------------------------------------------------------------------------------------------------------ */
/* Options, RequestOptions, ListParams and the shared types                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

export type OptionAssertions = [
  // Every client option of the contract, with the augmentations of identity.d.ts (hostingKey, host, endUser) and
  // console.d.ts (sessionKind, onStaffSessionRefreshed), is an option of the SDK that takes the contract's values.
  Assignable<keyof Sdk.VelexisClientOptions, keyof Contract.VelexisClientOptions>,
  Assignable<Sdk.VelexisClientOptions, Contract.VelexisClientOptions>,
  // The same for the options of every call, with the identity.d.ts augmentation (endUser, host).
  Assignable<keyof Sdk.RequestOptions, keyof Contract.RequestOptions>,
  Assignable<Sdk.RequestOptions, Contract.RequestOptions>,
  // And for the list parameters.
  Assignable<keyof Sdk.ListParams, keyof Contract.ListParams>,
  Assignable<Sdk.ListParams, Contract.ListParams>,
];

export type SharedTypeAssertions = [
  // Both sides read the same generated schemas.
  Assignable<Contract.Schemas, Sdk.Schemas>,
  Assignable<Sdk.Schemas, Contract.Schemas>,
  Assignable<Contract.Money, Sdk.Money>,
  Assignable<Sdk.Money, Contract.Money>,
  Assignable<Contract.Warning, Sdk.Warning>,
  Assignable<Contract.ApiError, Sdk.ApiError>,
  Assignable<Contract.WithWarnings, Sdk.WithWarnings>,
  // The open error-code union, the token sources and the end-user context take the same values.
  Assignable<Contract.ErrorCode, Sdk.ErrorCode>,
  Assignable<Sdk.ErrorCode, Contract.ErrorCode>,
  Assignable<Sdk.TokenSource, Contract.TokenSource>,
  Assignable<Contract.TokenSource, Sdk.TokenSource>,
  Assignable<Sdk.EndUserContext, Contract.EndUserContext>,
  Assignable<Sdk.EndUserSource, Contract.EndUserSource>,
];

/* ------------------------------------------------------------------------------------------------------------ */
/* Page<T>                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

type Item = Contract.Schemas["Airline"];

export type PageAssertions = [
  // A page of the SDK is a page of the contract, for one item type and for every item type.
  Assignable<Contract.Page<Item>, Sdk.Page<Item>>,
  Assignable<<T>() => Contract.Page<T>, <T>() => Sdk.Page<T>>,
  // `page` carries the same cursor and limit, `next()` resolves with a page or null, and pages are async-iterable.
  Assignable<Contract.Page<Item>["page"], Sdk.Page<Item>["page"]>,
  Assignable<Sdk.Page<Item>["page"], Contract.Page<Item>["page"]>,
  Assignable<Contract.Page<Item>["next"], Sdk.Page<Item>["next"]>,
  Assignable<AsyncIterable<Item>, Sdk.Page<Item>>,
];

/* ------------------------------------------------------------------------------------------------------------ */
/* Error classes and isVelexisError                                                                              */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * For each error class: the constructor takes the contract's arguments (checked on their own, because TypeScript
 * compares constructor declarations bivariantly), and an instance has every field of the contract's class with a type
 * the contract allows, including `PriceChangedError.newPrice`, `.oldPrice`, `.pricedOfferId` (the flights.d.ts
 * augmentation) and `RateLimitError.retryAfterSeconds`.
 */
export type ErrorClassAssertions = [
  Assignable<
    ConstructorParameters<typeof Sdk.VelexisError>,
    ConstructorParameters<typeof Contract.VelexisError>
  >,
  Assignable<Contract.VelexisError, Sdk.VelexisError>,
  Assignable<
    ConstructorParameters<typeof Sdk.ValidationError>,
    ConstructorParameters<typeof Contract.ValidationError>
  >,
  Assignable<Contract.ValidationError, Sdk.ValidationError>,
  Assignable<
    ConstructorParameters<typeof Sdk.AuthenticationError>,
    ConstructorParameters<typeof Contract.AuthenticationError>
  >,
  Assignable<Contract.AuthenticationError, Sdk.AuthenticationError>,
  Assignable<
    ConstructorParameters<typeof Sdk.PermissionError>,
    ConstructorParameters<typeof Contract.PermissionError>
  >,
  Assignable<Contract.PermissionError, Sdk.PermissionError>,
  Assignable<
    ConstructorParameters<typeof Sdk.NotFoundError>,
    ConstructorParameters<typeof Contract.NotFoundError>
  >,
  Assignable<Contract.NotFoundError, Sdk.NotFoundError>,
  Assignable<
    ConstructorParameters<typeof Sdk.ConflictError>,
    ConstructorParameters<typeof Contract.ConflictError>
  >,
  Assignable<Contract.ConflictError, Sdk.ConflictError>,
  Assignable<
    ConstructorParameters<typeof Sdk.PriceChangedError>,
    ConstructorParameters<typeof Contract.PriceChangedError>
  >,
  Assignable<Contract.PriceChangedError, Sdk.PriceChangedError>,
  Assignable<
    ConstructorParameters<typeof Sdk.SoldOutError>,
    ConstructorParameters<typeof Contract.SoldOutError>
  >,
  Assignable<Contract.SoldOutError, Sdk.SoldOutError>,
  Assignable<
    ConstructorParameters<typeof Sdk.ExpiredError>,
    ConstructorParameters<typeof Contract.ExpiredError>
  >,
  Assignable<Contract.ExpiredError, Sdk.ExpiredError>,
  Assignable<
    ConstructorParameters<typeof Sdk.PaymentError>,
    ConstructorParameters<typeof Contract.PaymentError>
  >,
  Assignable<Contract.PaymentError, Sdk.PaymentError>,
  Assignable<
    ConstructorParameters<typeof Sdk.RateLimitError>,
    ConstructorParameters<typeof Contract.RateLimitError>
  >,
  Assignable<Contract.RateLimitError, Sdk.RateLimitError>,
  Assignable<
    ConstructorParameters<typeof Sdk.SupplierError>,
    ConstructorParameters<typeof Contract.SupplierError>
  >,
  Assignable<Contract.SupplierError, Sdk.SupplierError>,
  Assignable<
    ConstructorParameters<typeof Sdk.ConnectionError>,
    ConstructorParameters<typeof Contract.ConnectionError>
  >,
  Assignable<Contract.ConnectionError, Sdk.ConnectionError>,
  Assignable<
    ConstructorParameters<typeof Sdk.ServerError>,
    ConstructorParameters<typeof Contract.ServerError>
  >,
  Assignable<Contract.ServerError, Sdk.ServerError>,
  // The classes themselves (the static side), and the fields the contract names.
  Assignable<typeof Contract.PriceChangedError, typeof Sdk.PriceChangedError>,
  Assignable<typeof Contract.RateLimitError, typeof Sdk.RateLimitError>,
  Assignable<Contract.PriceChangedError["newPrice"], Sdk.PriceChangedError["newPrice"]>,
  Assignable<Contract.PriceChangedError["pricedOfferId"], Sdk.PriceChangedError["pricedOfferId"]>,
  Assignable<Contract.RateLimitError["retryAfterSeconds"], Sdk.RateLimitError["retryAfterSeconds"]>,
];

export type IsVelexisErrorAssertions = [
  // isVelexisError takes the contract's arguments and is a type guard for (at least) the contract's VelexisError.
  Assignable<Parameters<typeof Sdk.isVelexisError>, Parameters<typeof Contract.isVelexisError>>,
  Assignable<typeof Contract.isVelexisError, typeof Sdk.isVelexisError>,
];

/**
 * The guard in use: after `isVelexisError(error, code)` the value is the contract's `VelexisError` without a cast.
 * @param error any thrown value
 * @param isVelexisError the SDK's guard
 */
export function narrowsToTheContractError(
  error: unknown,
  isVelexisError: typeof Sdk.isVelexisError,
): Contract.VelexisError | undefined {
  return isVelexisError(error, "PRICE_CHANGED") ? error : undefined;
}
