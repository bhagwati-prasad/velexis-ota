// The call context of every Amadeus call (OADR-0001 point 3; OBE-018): who asks, for which tenant and environment,
// and what the call belongs to. The client checks it before anything else, logs it (ids only) and writes it into the
// `supplier_requests` row of the call:
//
//   { tenantId, environment, operation, requestId, staffId?, bookingId?, searchId?, orderOffice?, stubScenario? }
//
// - `operation` is the Velexis use case or SDK method (`flights.search`, `bookings.create`,
//   `console.amadeus.quoteAirOffers`), `supplier_requests.operation`; the Amadeus operation is the client method.
// - `orderOffice` is the booking's owner or queuing office for calls on an existing order: it must be an office of the
//   tenant's connection (403 OFFICE_NOT_ALLOWED otherwise). From M5 the resolver also applies the releasing-office
//   rule with it (OBE-079).
// - `stubScenario` picks a scenario of the Amadeus stub (`X-Stub-Scenario`) for a call made outside an HTTP request
//   (a job, a test). Inside a request the client forwards the request's own `X-Stub-Scenario` header instead. Either is
//   sent only when APP_ENV is not `production`.
//
// The context holds ids, never a body, a token or personal data, so it may be logged as it is.
import { REQUEST_ID_PATTERN } from "@velexis/logger";
import type { AmadeusEnvironment } from "../tenancy/platform-read.repository";
import { AMADEUS_OFFICE_ID } from "./connection-resolver";

export interface AmadeusCallContext {
  /** `ten_…`: the tenant the call is made for; it must be the tenant of the request or job context. */
  readonly tenantId: string;
  readonly environment: AmadeusEnvironment;
  /** The use case or SDK method (`flights.search`, `bookings.create`); `supplier_requests.operation`. */
  readonly operation: string;
  /** `X-Request-Id` of the triggering API call, or the job's request id (`REQUEST_ID_PATTERN` of @velexis/logger). */
  readonly requestId: string;
  /** `stf_…` for console calls of a staff member. */
  readonly staffId?: string | undefined;
  /** `bkg_…`: the booking the call belongs to. */
  readonly bookingId?: string | undefined;
  /** `srch_…`: the search the call belongs to. */
  readonly searchId?: string | undefined;
  /** The booking's owner or queuing office, for calls on an existing order. */
  readonly orderOffice?: string | undefined;
  /** A stub scenario for calls outside an HTTP request (never sent in production). */
  readonly stubScenario?: string | undefined;
}

/** The request header of the Amadeus stub that picks a scenario (tools/amadeus-stub). */
export const STUB_SCENARIO_HEADER = "X-Stub-Scenario";

/** A stub scenario name: lower-case words joined by hyphens (`server-error`, `timeout-lost`). */
export const STUB_SCENARIO = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,5}$/;

/** A Velexis operation name: an SDK method or use case, dot-separated words (`console.amadeus.quoteAirOffers`). */
const OPERATION = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*){0,4}$/;
const MAX_OPERATION_LENGTH = 100;

/** Crockford base32 ULID after a prefix (`newId` of @velexis/crypto). */
const prefixed = (prefix: string): RegExp => new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`);
const TENANT_ID = prefixed("ten");
const STAFF_ID = prefixed("stf");
const BOOKING_ID = prefixed("bkg");
const SEARCH_ID = prefixed("srch");

/** A call context that breaks a rule above: a bug of the caller, never the customer's input. */
export class InvalidAmadeusCallContextError extends Error {
  override readonly name = "InvalidAmadeusCallContextError";

  constructor(readonly field: keyof AmadeusCallContext) {
    super(`invalid Amadeus call context: ${field}`);
  }
}

function check(valid: boolean, field: keyof AmadeusCallContext): void {
  if (!valid) {
    throw new InvalidAmadeusCallContextError(field);
  }
}

function optional(value: unknown, pattern: RegExp): boolean {
  return value === undefined || (typeof value === "string" && pattern.test(value));
}

/**
 * The context, checked and frozen. A malformed field is a bug of the calling code: it throws
 * `InvalidAmadeusCallContextError` (naming the field, never its value; the API answers `500 INTERNAL_ERROR` and logs
 * it) before the connection is resolved, so nothing reaches Amadeus.
 */
export function checkCallContext(context: AmadeusCallContext): AmadeusCallContext {
  check(typeof context.tenantId === "string" && TENANT_ID.test(context.tenantId), "tenantId");
  check(context.environment === "test" || context.environment === "live", "environment");
  check(
    typeof context.operation === "string" &&
      context.operation.length <= MAX_OPERATION_LENGTH &&
      OPERATION.test(context.operation),
    "operation",
  );
  check(typeof context.requestId === "string" && REQUEST_ID_PATTERN.test(context.requestId), "requestId");
  check(optional(context.staffId, STAFF_ID), "staffId");
  check(optional(context.bookingId, BOOKING_ID), "bookingId");
  check(optional(context.searchId, SEARCH_ID), "searchId");
  check(optional(context.orderOffice, AMADEUS_OFFICE_ID), "orderOffice");
  check(optional(context.stubScenario, STUB_SCENARIO), "stubScenario");
  return Object.freeze({
    tenantId: context.tenantId,
    environment: context.environment,
    operation: context.operation,
    requestId: context.requestId,
    staffId: context.staffId,
    bookingId: context.bookingId,
    searchId: context.searchId,
    orderOffice: context.orderOffice,
    stubScenario: context.stubScenario,
  });
}

/**
 * The stub scenario a call forwards: none in production; else the context's own, else the `X-Stub-Scenario` header of
 * the current HTTP request (`requestHeader`), when it is a well-formed name. Anything else is dropped, never sent.
 */
export function forwardedStubScenario(
  appEnv: string,
  context: Pick<AmadeusCallContext, "stubScenario">,
  requestHeader: unknown,
): string | undefined {
  if (appEnv === "production") {
    return undefined;
  }
  const candidate = context.stubScenario ?? (Array.isArray(requestHeader) ? requestHeader[0] : requestHeader);
  return typeof candidate === "string" && STUB_SCENARIO.test(candidate) ? candidate : undefined;
}
