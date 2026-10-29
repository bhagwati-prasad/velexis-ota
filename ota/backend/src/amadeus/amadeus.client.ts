// AmadeusClient (OADR-0001, flows/amadeus-connection-and-tokens.md, ADR-0012; OBE-018): the one entry point of the OTA
// backend to Amadeus, one method per operation, typed by the generated types of `docs/amadeus-api/` (src/amadeus/
// generated). Business modules call it with a call context (call-context.ts) and never `fetch` Amadeus themselves
// (ESLint forbids `fetch` and HTTP client imports outside src/amadeus/).
//
// Every call, in order:
//   1. checks the call context, and that it names the tenant of the request or job context (the row of step 6 goes to
//      that tenant's schema);
//   2. resolves the tenant's connection (connection-resolver.ts: 424 SUPPLIER_NOT_CONFIGURED without one);
//   3. applies the offices (OADR-0001 point 10): a caller-provided office outside the connection's `officeIds` (an
//      order office, `queuingOfficeId`/`ownerOfficeId`/`automatedProcess[].officeId` of an order, Queue List's
//      `officeId`) answers 403 OFFICE_NOT_ALLOWED before any call; missing ones are filled from the connection;
//   4. takes a token from the credential set's and the tenant's buckets (rate-limiter.ts: 429 RATE_LIMITED with
//      `details.retryAfterSeconds`, no call; 503 without Redis);
//   5. gets the access token (token-provider.ts), once more after 300–800 ms when the token request failed on a network
//      error, a timeout or a `5xx`, and sends the request with the operation's timeout (limits.ts, AbortController),
//      `X-Stub-Scenario` only when APP_ENV is not `production`;
//   6. writes one `supplier_requests` row per request it sent, in a short tenant transaction of its own after the
//      answer (never inside the caller's transaction), and one `amadeus.call` log line without bodies;
//   7. on a `401` drops the token and sends the request once more; on a network error, a timeout or a `5xx` of a read,
//      sends it once more after 300–800 ms; never repeats a write (createFlightOrders, issueFlightOrder,
//      patchFlightOrder, cancelFlightOrder), which may have happened at Amadeus;
//   8. returns the parsed answer with the call's facts, or throws the mapped AppError (error-mapper.ts).
//
// Bodies are logged nowhere: the log line has ids, statuses, codes and durations; the row has the bodies through the
// shared redactor (supplier-requests.repository.ts). A caller that sends a card passes a copy redacted before the call
// as `redactedRequest` (OADR-0004), which the row stores instead of the request; a caller whose answers may hold what
// the tenant's row must not (another office's orders on the shared account) passes `recordedResponse`, which the client
// applies to the answer before it writes the row (FIX-W32-OTA, lead decision (1e) of 2026-10-28). A row that cannot be
// written is logged (`amadeus.supplier_request_not_recorded`) and never fails the call: the call happened at Amadeus.
import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppError } from "@velexis/errors";
import { CLS_REQ, ClsService } from "nestjs-cls";
import { PinoLogger } from "nestjs-pino";
import { IdGenerator } from "../common/ids";
import type { ApiConfig } from "../config";
import { NoTenantContextError, TenantContext } from "../tenancy/tenant-context";
import { TenantTx } from "../tenancy/tenant-tx";
import {
  checkCallContext,
  forwardedStubScenario,
  STUB_SCENARIO_HEADER,
  type AmadeusCallContext,
} from "./call-context";
import { ConnectionResolver, type ResolvedAmadeusConnection } from "./connection-resolver";
import {
  errorCodesOf,
  mapAmadeusError,
  outcomeOf,
  type AmadeusFailure,
  type AmadeusIssue,
  type AmadeusOutcome,
} from "./error-mapper";
import type {
  BrandedFaresUpsell,
  FlightAvailabilitiesSearch,
  FlightCreateOrders,
  FlightOffersPrice,
  FlightOffersSearch,
  FlightOrderIssue,
  FlightOrderManagement,
  GetFlightOrderByRecordLocator,
  QueueList,
} from "./generated";
import {
  AMADEUS_LIMITS,
  AMADEUS_OPERATIONS,
  DEFAULT_AMADEUS_LIMITS,
  isRetryable,
  retryDelayMs,
  type AmadeusLimits,
  type AmadeusOperationName,
  type AmadeusOperationSpec,
} from "./limits";
import { AmadeusRateLimiter } from "./rate-limiter";
import {
  isForeignKeyViolation,
  SupplierRequestsRepository,
  type SupplierRequestRecord,
} from "./supplier-requests.repository";
import { AMADEUS_FETCH, AmadeusTokenRequestError, TokenProvider, type AmadeusFetch } from "./token-provider";

// ---- Types of the operations ---------------------------------------------------------------------------------------

/** The JSON body of a request of a generated operation. */
type BodyOf<O> = O extends { requestBody: { content: infer C } } ? C[keyof C] : never;
/** The query of a generated operation. */
type QueryOf<O> = O extends { parameters: { query?: infer Q } } ? Exclude<Q, undefined> : never;
/** The JSON body of a generated response (`undefined` for one without content, the 204 of a DELETE). */
type JsonOf<R> = R extends { content: infer C } ? C[keyof C] : undefined;

type Search = FlightOffersSearch.operations;
type Availability = FlightAvailabilitiesSearch.operations["searchFlightAvailabilities"];
type Upsell = BrandedFaresUpsell.operations["upsellAirOffers"];
type Price = FlightOffersPrice.operations["quoteAirOffers"];
type Create = FlightCreateOrders.operations["createFligtOrders"];
type Issue = FlightOrderIssue.operations["issueFlightOrder"];
type Management = FlightOrderManagement.operations;
type ByReference = GetFlightOrderByRecordLocator.operations["getFlightOrder"];
type Queue = QueueList.operations["GET/office/queues/{queue-id}"];

export interface SearchFlightOffersRequest {
  readonly body: BodyOf<Search["searchFlightOffers"]>;
}
export interface GetFlightOffersRequest {
  readonly query: QueryOf<Search["getFlightOffers"]>;
}
export interface SearchFlightAvailabilitiesRequest {
  readonly body: BodyOf<Availability>;
}
export interface UpsellAirOffersRequest {
  readonly body: BodyOf<Upsell>;
}
export interface QuoteAirOffersRequest {
  readonly body: BodyOf<Price>;
  readonly query?: QueryOf<Price>;
}
export interface CreateFlightOrdersRequest {
  readonly body: BodyOf<Create>;
  readonly query?: QueryOf<Create>;
}
export interface IssueFlightOrderRequest {
  readonly flightOrderId: string;
  readonly body: BodyOf<Issue>;
}
export interface GetFlightOrderRequest {
  readonly flightOrderId: string;
  readonly query?: QueryOf<Management["getFlightOrder"]>;
}
export interface PatchFlightOrderRequest {
  readonly flightOrderId: string;
  readonly body: BodyOf<Management["patchFlightOrder"]>;
}
export interface CancelFlightOrderRequest {
  readonly flightOrderId: string;
}
export interface GetFlightOrderByReferenceRequest {
  readonly query: QueryOf<ByReference>;
}
export interface ListQueueRequest {
  readonly queueId: number;
  readonly query?: QueryOf<Queue>;
}

export type SearchFlightOffersReply = JsonOf<Search["searchFlightOffers"]["responses"][200]>;
export type GetFlightOffersReply = JsonOf<Search["getFlightOffers"]["responses"][200]>;
export type SearchFlightAvailabilitiesReply = JsonOf<Availability["responses"][200]>;
export type UpsellAirOffersReply = JsonOf<Upsell["responses"][200]>;
export type QuoteAirOffersReply = JsonOf<Price["responses"][200]>;
export type CreateFlightOrdersReply = JsonOf<Create["responses"][201]>;
export type IssueFlightOrderReply = JsonOf<Issue["responses"][200]>;
export type GetFlightOrderReply = JsonOf<Management["getFlightOrder"]["responses"][200]>;
export type PatchFlightOrderReply = JsonOf<Management["patchFlightOrder"]["responses"][200]>;
export type CancelFlightOrderReply = JsonOf<Management["cancelFlightOrder"]["responses"][204]>;
export type GetFlightOrderByReferenceReply = JsonOf<ByReference["responses"][200]>;
export type ListQueueReply = JsonOf<Queue["responses"][200]>;

/** Per call options. */
export interface AmadeusCallOptions {
  /**
   * A copy of the request body redacted by the caller before the call (a request with a card, OADR-0004): the
   * `supplier_requests` row stores it instead of the request, after the same redaction steps.
   */
  readonly redactedRequest?: unknown;
  /**
   * What the `supplier_requests` row stores as the answer (FIX-W32-OTA, lead decision (1e) of 2026-10-28): the client
   * applies it to the parsed answer of every request it sends for the call (an order, an error answer, `undefined`
   * without one) before it writes that request's row, so the row never holds what the caller keeps out of it, not even
   * for a moment: another office's orders on the shared Amadeus account, say (PnrImportService's withheld body). Its
   * result goes through the same redaction and size rules as an answer. It changes only the row: the call answers the
   * answer as Amadeus sent it. A hook that throws leaves the row without an answer (`null`, log line
   * `amadeus.recorded_response_failed`), never with the answer it was given. Default: the answer as Amadeus sent it.
   */
  readonly recordedResponse?: (body: unknown) => unknown;
}

/** The facts of a call: what the console's raw calls return in `call`. */
export interface AmadeusCallInfo {
  /** `sreq_…` of the row of the request that answered; `null` when the row could not be written. */
  readonly supplierRequestId: string | null;
  readonly officeId: string | null;
  readonly status: number;
  readonly durationMs: number;
  /** `ama-request-id` of the answer. */
  readonly correlationId: string | null;
  /** Requests sent for this call: 1, or more after a `401` or a retried read. */
  readonly attempts: number;
}

export interface AmadeusResponse<T> {
  /** The parsed answer (`undefined` for a `204`). */
  readonly body: T;
  readonly call: AmadeusCallInfo;
}

// ---- Requests --------------------------------------------------------------------------------------------------------

/** What a method hands to `call`: path parameters, query and body, as the caller gave them. */
interface OutgoingRequest {
  readonly pathParams?: Readonly<Record<string, string | number>>;
  readonly query?: object | undefined;
  readonly body?: unknown;
}

/** The request after the offices were applied. */
interface PreparedRequest {
  readonly officeId: string;
  readonly query: Readonly<Record<string, unknown>> | undefined;
  readonly body: unknown;
  /** What the row stores as the request: the redacted copy or the request, with the same offices. */
  readonly recorded: unknown;
}

/** One request sent: an answer, or a failure without one. */
type Attempt =
  | {
      readonly kind: "answer";
      readonly status: number;
      readonly text: string;
      readonly correlationId: string | null;
      readonly durationMs: number;
    }
  | { readonly kind: "failure"; readonly failure: AmadeusFailure; readonly durationMs: number };

/** The parsed result of one request. */
interface Result {
  readonly ok: boolean;
  readonly status: number | null;
  readonly body: unknown;
  readonly failure: AmadeusFailure | undefined;
  readonly outcome: AmadeusOutcome;
  readonly errorCodes: readonly number[];
  readonly correlationId: string | null;
  readonly durationMs: number;
}

/** The media type of Amadeus requests and answers. */
const AMADEUS_JSON = "application/vnd.amadeus+json";

/** The cause of a 403 for an office the tenant may not act for: which field, never another tenant's data. */
export class AmadeusOfficeNotAllowedError extends Error {
  override readonly name = "AmadeusOfficeNotAllowedError";

  constructor(readonly field: string) {
    super(`the office of ${field} is not an office of the tenant's Amadeus connection`);
  }
}

/** The tenant of the call context is not the tenant of the request or job context: a bug of the caller. */
export class AmadeusTenantMismatchError extends Error {
  override readonly name = "AmadeusTenantMismatchError";

  constructor() {
    super("the Amadeus call context names another tenant than the request or job context");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A query value as Amadeus reads it: arrays comma-separated (`collectionFormat: csv`), booleans as `true`/`false`. */
function queryValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(",");
  }
  return String(value);
}

/** The path and query of a request (`/v1/booking/flight-orders/eJz…?include=bags`), parameters encoded. */
export function requestPath(
  template: string,
  pathParams: Readonly<Record<string, string | number>> = {},
  query: Readonly<Record<string, unknown>> = {},
): string {
  const path = template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = pathParams[name];
    if (value === undefined || String(value) === "") {
      throw new TypeError(`Amadeus request: the path parameter ${name} is missing`);
    }
    return encodeURIComponent(String(value));
  });
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    const text = queryValue(value);
    if (text !== undefined) {
      search.append(name, text);
    }
  }
  const text = search.toString();
  return text === "" ? path : `${path}?${text}`;
}

/** The `errors` of an Amadeus error answer, or none. */
function issuesOf(body: unknown): AmadeusIssue[] {
  const errors = isRecord(body) ? body["errors"] : undefined;
  return Array.isArray(errors) ? errors.filter(isRecord) : [];
}

/** The parsed JSON of a text, `undefined` for an empty or malformed one. */
function parseJson(text: string): { readonly ok: boolean; readonly value: unknown } {
  if (text === "") {
    return { ok: true, value: undefined };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, value: undefined };
  }
}

/** The socket error code of a failed `fetch` (undici puts it in `cause`). */
function networkCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === "string" ? cause.code : undefined;
}

/** A network error, a timeout or a `5xx`: worth one more request for a read. */
function isTransient(failure: AmadeusFailure): boolean {
  return failure.kind !== "http" || failure.status >= 500;
}

/** A token request that failed on a network error, a timeout or a `5xx` (AmadeusTokenRequestError). */
function isRetryableTokenFailure(error: unknown): boolean {
  return (
    error instanceof AppError && error.cause instanceof AmadeusTokenRequestError && error.cause.retryable
  );
}

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

@Injectable()
export class AmadeusClient {
  private readonly limits: AmadeusLimits;
  private readonly appEnv: string;

  constructor(
    private readonly resolver: ConnectionResolver,
    private readonly tokens: TokenProvider,
    private readonly rateLimiter: AmadeusRateLimiter,
    private readonly supplierRequests: SupplierRequestsRepository,
    private readonly tx: TenantTx,
    private readonly tenants: TenantContext,
    private readonly ids: IdGenerator,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
    @Inject(AMADEUS_FETCH) private readonly fetch: AmadeusFetch,
    config: ConfigService<ApiConfig, true>,
    @Optional() @Inject(AMADEUS_LIMITS) limits?: AmadeusLimits,
  ) {
    logger.setContext(AmadeusClient.name);
    this.appEnv = config.get("APP_ENV", { infer: true });
    this.limits = limits ?? DEFAULT_AMADEUS_LIMITS;
  }

  // ---- Shopping ------------------------------------------------------------------------------------------------------

  /** Flight Offers Search, POST (`X-HTTP-Method-Override: GET`). */
  searchFlightOffers(
    context: AmadeusCallContext,
    request: SearchFlightOffersRequest,
    options?: AmadeusCallOptions,
  ): Promise<AmadeusResponse<SearchFlightOffersReply>> {
    return this.call("searchFlightOffers", context, { body: request.body }, options);
  }

  /** Flight Offers Search, GET. */
  getFlightOffers(
    context: AmadeusCallContext,
    request: GetFlightOffersRequest,
    options?: AmadeusCallOptions,
  ): Promise<AmadeusResponse<GetFlightOffersReply>> {
    return this.call("getFlightOffers", context, { query: request.query }, options);
  }

  /** Flight Availabilities Search (`X-HTTP-Method-Override: GET`). */
  searchFlightAvailabilities(
    context: AmadeusCallContext,
    request: SearchFlightAvailabilitiesRequest,
    options?: AmadeusCallOptions,
  ): Promise<AmadeusResponse<SearchFlightAvailabilitiesReply>> {
    return this.call("searchFlightAvailabilities", context, { body: request.body }, options);
  }

  /** Branded Fares Upsell. */
  upsellAirOffers(
    context: AmadeusCallContext,
    request: UpsellAirOffersRequest,
    options?: AmadeusCallOptions,
  ): Promise<AmadeusResponse<UpsellAirOffersReply>> {
    return this.call("upsellAirOffers", context, { body: request.body }, options);
  }

  /** Flight Offers Price. */
  quoteAirOffers(
    context: AmadeusCallContext,
    request: QuoteAirOffersRequest,
    options?: AmadeusCallOptions,
  ): Promise<AmadeusResponse<QuoteAirOffersReply>> {
    return this.call("quoteAirOffers", context, { body: request.body, query: request.query }, options);
  }

  // ---- Orders (writes are never retried) -----------------------------------------------------------------------------

  /** Flight Create Orders: `queuingOfficeId` and `ownerOfficeId` come from the connection when the body has none. */
  createFlightOrders(
    context: AmadeusCallContext,
    request: CreateFlightOrdersRequest,
    options?: AmadeusCallOptions,
  ): Promise<AmadeusResponse<CreateFlightOrdersReply>> {
    return this.call("createFlightOrders", context, { body: request.body, query: request.query }, options);
  }

  /** Flight Order Issue. */
  issueFlightOrder(
    context: AmadeusCallContext,
    request: IssueFlightOrderRequest,
    options?: AmadeusCallOptions,
  ): Promise<AmadeusResponse<IssueFlightOrderReply>> {
    return this.call(
      "issueFlightOrder",
      context,
      { pathParams: { "flight-orderId": request.flightOrderId }, body: request.body },
      options,
    );
  }

  /** Flight Order Management, GET. */
  getFlightOrder(
    context: AmadeusCallContext,
    request: GetFlightOrderRequest,
    options?: AmadeusCallOptions,
  ): Promise<AmadeusResponse<GetFlightOrderReply>> {
    return this.call(
      "getFlightOrder",
      context,
      { pathParams: { "flight-orderId": request.flightOrderId }, query: request.query },
      options,
    );
  }

  /** Flight Order Management, PATCH. */
  patchFlightOrder(
    context: AmadeusCallContext,
    request: PatchFlightOrderRequest,
    options?: AmadeusCallOptions,
  ): Promise<AmadeusResponse<PatchFlightOrderReply>> {
    return this.call(
      "patchFlightOrder",
      context,
      { pathParams: { "flight-orderId": request.flightOrderId }, body: request.body },
      options,
    );
  }

  /** Flight Order Management, DELETE (`204` without a body). */
  cancelFlightOrder(
    context: AmadeusCallContext,
    request: CancelFlightOrderRequest,
    options?: AmadeusCallOptions,
  ): Promise<AmadeusResponse<CancelFlightOrderReply>> {
    return this.call(
      "cancelFlightOrder",
      context,
      { pathParams: { "flight-orderId": request.flightOrderId } },
      options,
    );
  }

  /** Get Flight Order by record locator, as the tenant's retrieval office. */
  getFlightOrderByReference(
    context: AmadeusCallContext,
    request: GetFlightOrderByReferenceRequest,
    options?: AmadeusCallOptions,
  ): Promise<AmadeusResponse<GetFlightOrderByReferenceReply>> {
    return this.call("getFlightOrderByReference", context, { query: request.query }, options);
  }

  /** Queue List: `officeId` is the tenant's queue office unless the caller names another of its offices. */
  listQueue(
    context: AmadeusCallContext,
    request: ListQueueRequest,
    options?: AmadeusCallOptions,
  ): Promise<AmadeusResponse<ListQueueReply>> {
    return this.call(
      "listQueue",
      context,
      { pathParams: { "queue-id": request.queueId }, query: request.query },
      options,
    );
  }

  // ---- The call ------------------------------------------------------------------------------------------------------

  private async call<T>(
    name: AmadeusOperationName,
    rawContext: AmadeusCallContext,
    request: OutgoingRequest,
    options: AmadeusCallOptions = {},
  ): Promise<AmadeusResponse<T>> {
    const spec = AMADEUS_OPERATIONS[name];
    const context = checkCallContext(rawContext);
    this.requireTenant(context);
    const connection = await this.resolver.resolve(context.tenantId, context.environment);
    const prepared = prepareOffices(spec, connection, context, request, options.redactedRequest);
    const path = requestPath(spec.path, request.pathParams, prepared.query);
    const scenario = forwardedStubScenario(this.appEnv, context, this.requestScenarioHeader());

    let attempts = 0;
    let tokenDropped = false;
    let retried = false;
    for (;;) {
      attempts += 1;
      await this.rateLimiter.take({
        credId: connection.credId,
        tenantId: context.tenantId,
        environment: context.environment,
      });
      const token = await this.token(connection);
      const result = parse(await this.send(spec, connection, path, token, prepared.body, scenario));
      const supplierRequestId = await this.record(context, spec, prepared, path, result, options);
      this.logCall(context, spec, prepared.officeId, result, attempts, supplierRequestId);

      if (result.ok) {
        return {
          body: result.body as T,
          call: Object.freeze({
            supplierRequestId,
            officeId: prepared.officeId,
            status: result.status ?? 0,
            durationMs: result.durationMs,
            correlationId: result.correlationId,
            attempts,
          }),
        };
      }
      const failure = result.failure ?? { kind: "http", status: result.status ?? 0, issues: [] };
      if (failure.kind === "http" && failure.status === 401 && !tokenDropped) {
        // Amadeus refused the token before doing anything: a new one, and the same request once more.
        tokenDropped = true;
        await this.tokens.dropToken(connection, token);
        continue;
      }
      if (!retried && isRetryable(spec) && isTransient(failure)) {
        retried = true;
        await sleep(retryDelayMs(this.limits, Math.random));
        continue;
      }
      if (failure.kind === "http" && failure.status === 429) {
        // The shared quota answered before our buckets did: they are too large (flow §5, an ops alert).
        this.logger.error(
          { credId: connection.credId, environment: context.environment, amadeusOperation: name },
          "amadeus.quota_exceeded",
        );
      }
      throw mapAmadeusError(name, failure);
    }
  }

  /** The tenant of the request or job context must be the call's: the row is written to that tenant's schema. */
  private requireTenant(context: AmadeusCallContext): void {
    const tenant = this.tenants.get();
    if (tenant === undefined) {
      throw new NoTenantContextError();
    }
    if (tenant.tenantId !== context.tenantId) {
      throw new AmadeusTenantMismatchError();
    }
  }

  /** `X-Stub-Scenario` of the current HTTP request, if there is one. */
  private requestScenarioHeader(): unknown {
    if (!this.cls.isActive()) {
      return undefined;
    }
    const req: unknown = this.cls.get(CLS_REQ);
    const headers = isRecord(req) ? req["headers"] : undefined;
    return isRecord(headers) ? headers[STUB_SCENARIO_HEADER.toLowerCase()] : undefined;
  }

  /** The access token; the token request is sent once more after a network error, a timeout or a `5xx`. */
  private async token(connection: ResolvedAmadeusConnection): Promise<string> {
    try {
      return await this.tokens.getToken(connection);
    } catch (error) {
      if (!isRetryableTokenFailure(error)) {
        throw error;
      }
      await sleep(retryDelayMs(this.limits, Math.random));
      return await this.tokens.getToken(connection);
    }
  }

  /** Sends one request with the operation's timeout; the answer is read completely within it. */
  private async send(
    spec: AmadeusOperationSpec,
    connection: ResolvedAmadeusConnection,
    path: string,
    token: string,
    body: unknown,
    scenario: string | undefined,
  ): Promise<Attempt> {
    const headers: Record<string, string> = {
      accept: `${AMADEUS_JSON}, application/json`,
      authorization: `Bearer ${token}`,
    };
    if (body !== undefined) {
      headers["content-type"] = AMADEUS_JSON;
    }
    if (spec.methodOverride) {
      headers["x-http-method-override"] = "GET";
    }
    if (scenario !== undefined) {
      headers[STUB_SCENARIO_HEADER] = scenario;
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.limits.timeoutMs[spec.name]);
    const started = performance.now();
    const elapsed = (): number => Math.round(performance.now() - started);
    try {
      const response = await this.fetch(`${connection.baseUrl}${path}`, {
        method: spec.method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: controller.signal,
      });
      const text = await response.text();
      return {
        kind: "answer",
        status: response.status,
        text,
        correlationId: response.headers.get("ama-request-id"),
        durationMs: elapsed(),
      };
    } catch (error) {
      const failure: AmadeusFailure = timedOut
        ? { kind: "timeout" }
        : { kind: "network", code: networkCode(error) };
      return { kind: "failure", failure, durationMs: elapsed() };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The answer as the row stores it: the caller's `recordedResponse` of it (AmadeusCallOptions), else the answer. A hook
   * that throws stores no answer, and its error is logged by name only (it may quote the answer).
   */
  private recordedResponse(
    context: AmadeusCallContext,
    spec: AmadeusOperationSpec,
    options: AmadeusCallOptions,
    body: unknown,
  ): unknown {
    if (options.recordedResponse === undefined) {
      return body;
    }
    try {
      return options.recordedResponse(body);
    } catch (error) {
      this.logger.warn(
        {
          tenantId: context.tenantId,
          amadeusOperation: spec.name,
          requestId: context.requestId,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        "amadeus.recorded_response_failed",
      );
      return null;
    }
  }

  /** Writes the row of one request in a transaction of its own; `null` (and a log line) when that fails. */
  private async record(
    context: AmadeusCallContext,
    spec: AmadeusOperationSpec,
    prepared: PreparedRequest,
    path: string,
    result: Result,
    options: AmadeusCallOptions,
  ): Promise<string | null> {
    const record: SupplierRequestRecord = {
      id: this.ids.newId("sreq"),
      environment: context.environment,
      operation: context.operation,
      amadeusApi: spec.api,
      amadeusOperationId: spec.operationId,
      httpMethod: spec.method,
      path,
      officeId: prepared.officeId,
      httpStatus: result.status,
      outcome: result.outcome,
      errorCodes: result.errorCodes,
      durationMs: result.durationMs,
      correlationId: result.correlationId,
      requestId: context.requestId,
      requestBody: prepared.recorded,
      responseBody: this.recordedResponse(context, spec, options, result.body),
      bookingId: context.bookingId ?? null,
      searchId: context.searchId ?? null,
      staffId: context.staffId ?? null,
    };
    try {
      try {
        await this.tx.run((trx) => this.supplierRequests.insert(trx, record));
      } catch (error) {
        if (!isForeignKeyViolation(error) || (record.bookingId === null && record.searchId === null)) {
          throw error;
        }
        // The booking or search is not committed (or not the tenant's): keep the row without the link.
        this.logger.warn(
          { supplierRequestId: record.id, bookingId: record.bookingId, searchId: record.searchId },
          "amadeus.supplier_request_unlinked",
        );
        await this.tx.run((trx) =>
          this.supplierRequests.insert(trx, { ...record, bookingId: null, searchId: null }),
        );
      }
      return record.id;
    } catch (error) {
      this.logger.warn(
        { err: error, tenantId: context.tenantId, amadeusOperation: spec.name, requestId: context.requestId },
        "amadeus.supplier_request_not_recorded",
      );
      return null;
    }
  }

  /** The one log line of a request: ids, status, codes and duration, never a body. */
  private logCall(
    context: AmadeusCallContext,
    spec: AmadeusOperationSpec,
    officeId: string,
    result: Result,
    attempt: number,
    supplierRequestId: string | null,
  ): void {
    const fields = {
      tenantId: context.tenantId,
      environment: context.environment,
      operation: context.operation,
      amadeusOperation: spec.name,
      amadeusApi: spec.api,
      method: spec.method,
      officeId,
      status: result.status,
      outcome: result.outcome,
      errorCodes: result.errorCodes,
      durationMs: result.durationMs,
      correlationId: result.correlationId,
      attempt,
      supplierRequestId,
      requestId: context.requestId,
    };
    if (result.outcome === "success" || result.outcome === "client_error") {
      this.logger.info(fields, "amadeus.call");
    } else {
      this.logger.warn(fields, "amadeus.call");
    }
  }
}

/** One request's answer, parsed: success, an Amadeus error with its issues, or a failure without an answer. */
function parse(attempt: Attempt): Result {
  if (attempt.kind === "failure") {
    return {
      ok: false,
      status: null,
      body: undefined,
      failure: attempt.failure,
      outcome: outcomeOf(attempt.failure),
      errorCodes: [],
      correlationId: null,
      durationMs: attempt.durationMs,
    };
  }
  const { status, correlationId, durationMs } = attempt;
  const json = parseJson(attempt.text);
  if (status >= 200 && status < 300 && json.ok) {
    return {
      ok: true,
      status,
      body: json.value,
      failure: undefined,
      outcome: "success",
      errorCodes: [],
      correlationId,
      durationMs,
    };
  }
  const issues = issuesOf(json.value);
  const failure: AmadeusFailure = { kind: "http", status, issues };
  return {
    ok: false,
    status,
    body: json.value,
    failure,
    outcome: outcomeOf(failure),
    errorCodes: errorCodesOf(issues),
    correlationId,
    durationMs,
  };
}

/** True when `office` is one the connection may act for. */
function allowed(connection: ResolvedAmadeusConnection, office: unknown): office is string {
  return typeof office === "string" && connection.officeIds.includes(office);
}

function refuse(field: string): AppError {
  return new AppError("OFFICE_NOT_ALLOWED", { cause: new AmadeusOfficeNotAllowedError(field) });
}

/**
 * The offices of an order body (`data` of Flight Create Orders or a Management PATCH): every one the caller set must
 * be the tenant's; with `fill`, missing queuing and owner offices come from the connection. Returns the body to send.
 */
function orderBodyOffices(connection: ResolvedAmadeusConnection, body: unknown, fill: boolean): unknown {
  if (!isRecord(body) || !isRecord(body["data"])) {
    return body;
  }
  const data = body["data"];
  for (const field of ["queuingOfficeId", "ownerOfficeId"] as const) {
    if (data[field] !== undefined && !allowed(connection, data[field])) {
      throw refuse(`data.${field}`);
    }
  }
  const processes = data["automatedProcess"];
  if (Array.isArray(processes)) {
    for (const process of processes) {
      if (
        isRecord(process) &&
        process["officeId"] !== undefined &&
        !allowed(connection, process["officeId"])
      ) {
        throw refuse("data.automatedProcess.officeId");
      }
    }
  }
  if (!fill) {
    return body;
  }
  return {
    ...body,
    data: {
      ...data,
      queuingOfficeId: data["queuingOfficeId"] ?? connection.offices.queuing,
      ownerOfficeId: data["ownerOfficeId"] ?? connection.offices.owner,
    },
  };
}

/**
 * Applies the offices of OADR-0001 point 10 to a request (and to the caller's redacted copy, so the row matches what
 * was sent): 403 OFFICE_NOT_ALLOWED for a caller-provided office outside the connection's list, before any call.
 */
function prepareOffices(
  spec: AmadeusOperationSpec,
  connection: ResolvedAmadeusConnection,
  context: AmadeusCallContext,
  request: OutgoingRequest,
  redactedRequest: unknown,
): PreparedRequest {
  if (context.orderOffice !== undefined && !allowed(connection, context.orderOffice)) {
    throw refuse("orderOffice");
  }
  const query = request.query === undefined ? undefined : { ...(request.query as Record<string, unknown>) };
  const recordedOf = (body: unknown, apply: (value: unknown) => unknown): unknown => {
    if (redactedRequest !== undefined) {
      return apply(redactedRequest);
    }
    return body ?? (query !== undefined && Object.keys(query).length > 0 ? query : undefined);
  };
  switch (spec.office) {
    case "shopping":
      return {
        officeId: connection.offices.queue,
        query,
        body: request.body,
        recorded: recordedOf(request.body, (value) => value),
      };
    case "create": {
      const apply = (value: unknown): unknown => orderBodyOffices(connection, value, true);
      const body = apply(request.body);
      const officeId = isRecord(body) && isRecord(body["data"]) ? body["data"]["queuingOfficeId"] : undefined;
      return {
        officeId: typeof officeId === "string" ? officeId : connection.offices.queuing,
        query,
        body,
        recorded: recordedOf(body, apply),
      };
    }
    case "order": {
      const apply = (value: unknown): unknown => orderBodyOffices(connection, value, false);
      const body = apply(request.body);
      return {
        officeId: context.orderOffice ?? connection.offices.owner,
        query,
        body,
        recorded: recordedOf(body, apply),
      };
    }
    case "retrieval":
      return {
        officeId: connection.offices.retrieval,
        query,
        body: request.body,
        recorded: recordedOf(request.body, (value) => value),
      };
    case "queue": {
      const requested = query?.["officeId"];
      if (requested !== undefined && !allowed(connection, requested)) {
        throw refuse("officeId");
      }
      const officeId = typeof requested === "string" ? requested : connection.offices.queue;
      const withOffice = { ...query, officeId };
      return {
        officeId,
        query: withOffice,
        body: request.body,
        recorded: redactedRequest ?? withOffice,
      };
    }
  }
}
