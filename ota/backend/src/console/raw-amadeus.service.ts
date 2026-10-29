// The raw Amadeus reads of the console (OBE-067; OADR-0011 point 7, ota/docs/scope.md §3.4 `console.amadeus.*`,
// flows/console-operations.md §2 "Raw Amadeus (read)", the document's consoleAmadeus* operations): what OTA staff (or
// a `console:automation` key listing `amadeus:read`) send to Amadeus as it is, for support and investigation. The
// permission guard checked `amadeus:read` and the environment before this runs (OBE-060). The eight reads (`console.`
// left out of the SDK methods):
//
//   amadeus.searchFlightOffers          Flight Offers Search POST           body `amadeus`, `bookingId`, `reason`
//   amadeus.getFlightOffers             Flight Offers Search GET            the query as given
//   amadeus.searchFlightAvailabilities  Flight Availabilities Search        body `amadeus`, `bookingId`, `reason`
//   amadeus.upsellAirOffers             Branded Fares Upsell                body `amadeus`, `bookingId`, `reason`
//   amadeus.quoteAirOffers              Flight Offers Price                 the same body; `include`, `forceClass`
//   amadeus.getFlightOrder              Flight Order Management GET         `include`, `fareRules`
//   amadeus.getFlightOrderByReference   Get Flight Order By Record Locator  `reference`, `originSystemCode`, `include`
//   amadeus.getQueue                    Queue List                          `max`, `category`, `officeId`
//
// The four raw writes stay `deferred` (501 NOT_IMPLEMENTED, OADR-0011 point 7): bookings change through
// console.bookings.*, which keeps payments, tickets, events and documents consistent.
//
// Each read hands the request to the Amadeus client unchanged, except for the offices, which the client takes from
// the tenant's connection (OADR-0001 point 10): a caller-provided office outside the connection's `office_ids` (Queue
// List's `officeId`) answers `403 OFFICE_NOT_ALLOWED` before any call, and missing ones are the connection's. No
// transaction is open during the call. The client writes the call's `supplier_requests` row (`operation` the SDK
// method, the staff member, the booking of a body's `bookingId` or of an attached order) through the shared redactor.
// A body's `bookingId` must be a booking of the request's environment (`400 VALIDATION_FAILED` at `/bookingId`
// otherwise, before any call). The answer is Amadeus's, with the call's facts in `call` (ConsoleAmadeusCall): net
// prices (console scope, never shown to customers), full traveller documents of the order reads (never logged), the
// forms of payment of an order through the shared redactor (no card number reaches the console, OADR-0018 point 8),
// and the dictionaries reduced to `carriers` and `aircraft` (`dictionariesOf`: the document's AmadeusLocationEntry and
// AmadeusCurrencyEntry require a member Amadeus's maps by code never have, as console.bookings.retrieve answers them).
// Nothing is stored besides `supplier_requests`, `staff_actions` and, for Queue List, `queue_snapshots`.
//
// Office isolation on the shared account (ADR-0012, scope OF-09 AC3, lead addition of 2026-10-28). Every OTA's
// offices answer to the same Velexis credentials, so the order reads can return another OTA's orders. OBE-064's rule
// decides (pnr-import.service.ts `orderOfficeOf`): an order is the tenant's when the office that holds it, its owner
// office, or its queuing office when Amadeus gives no owner office, is one of the connection's `office_ids`.
//   - getFlightOrder: another office's order answers `403 OFFICE_NOT_ALLOWED`;
//   - getFlightOrderByReference: another office's orders are left out of `data` and `matches`, and so are `included`
//     and `dictionaries` (which describe every order Amadeus answered: its bag options, airports and carriers) when any
//     order was; no order left answers `403 OFFICE_NOT_ALLOWED`;
//   - getQueue: Queue List reads the queue of one of the tenant's offices (the client refuses another office before any
//     call); its entries name no office in the specification, so an entry is the queue office's unless it names an
//     owner (or queuing) office of its own, which then decides as for an order: another office's entries are left out
//     of the answer and of the stored snapshot. Velexis never puts an order on another OTA's queue (the client fills
//     the queuing and owner offices of Flight Create Orders from the creator's connection and refuses another office's
//     `automatedProcess[].officeId`), so another OTA's order on a tenant's queue can only come from outside Velexis;
//     telling it apart would take one by-reference read per entry, which this read does not make (as
//     console.queues.list, OBE-065).
// In each case the tenant's `supplier_requests` row of the call keeps another office's order (or entry) as its id and
// the `withheld` marker only (`rawRecordedResponseOf`), so the supplier log never shows another OTA's traveller, PNR
// or route either. `rawRecordedResponseOf` is pure and is the Amadeus client's `recordedResponse` hook (FIX-W32-OTA,
// lead decision (1e) of 2026-10-28) of each order read and Queue List read: the client applies it before it writes the
// row, so the row never holds another office's order, not even for a moment.
//
// Audit (OADR-0011 point 8 as decided on 2026-10-21): the raw reads are audited reads. Each handler opts in with
// `@AuditedRead`, and each use case writes its `succeeded` row `amadeus.<operation>` itself, after the read in a
// transaction of its own (Queue List's with its snapshot), with the request's `reason`, the booking, a target (the
// flight order, the record locator, the queue) and the call's facts, never a body; its id is answered as
// `call.staffActionId`. The interceptor then writes no second row. A refusal for another office's order is the use
// case's `denied` row; any other refused or failed call has the interceptor's row as every console call.
//
// Errors: Amadeus's own refusals keep every issue of its answer in `details.errors` with the call's
// `details.supplierRequestId` (console scope; `error.supplier` is the first issue). An Amadeus `4xx` is `422
// SUPPLIER_REJECTED` (the client's finer codes, such as `SOLD_OUT` or `PRICE_CHANGED`, which the raw reads do not
// document, included), Amadeus 404 of an order read `404 NOT_FOUND`, and Amadeus 403 of an order read or Queue List
// `403 OFFICE_NOT_ALLOWED`; the client's other codes pass as they are when the operation documents them (`5xx` →
// `502`/`503`, timeout `504`, `424`, `429`, and the `503` of the client's rate limiter without Redis), anything else is
// `502 SUPPLIER_ERROR`.
import { Injectable } from "@nestjs/common";
import type { components, operations } from "@velexis/api-types";
import { AppError, isAppError, type OtaErrorCode } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import {
  AmadeusClient,
  requestPath,
  type AmadeusCallInfo,
  type AmadeusCallOptions,
  type AmadeusResponse,
  type GetFlightOffersRequest,
  type GetFlightOrderByReferenceRequest,
  type GetFlightOrderRequest,
  type ListQueueRequest,
  type QuoteAirOffersRequest,
  type SearchFlightAvailabilitiesRequest,
  type SearchFlightOffersRequest,
  type UpsellAirOffersRequest,
} from "../amadeus/amadeus.client";
import type { AmadeusCallContext } from "../amadeus/call-context";
import { ConnectionResolver, type ResolvedAmadeusConnection } from "../amadeus/connection-resolver";
import { AmadeusCallError } from "../amadeus/error-mapper";
import { AMADEUS_OPERATIONS, type AmadeusOperationName } from "../amadeus/limits";
import { dictionariesOf } from "../bookings/bookings.mapper";
import { Clock } from "../common/clock";
import { IdGenerator } from "../common/ids";
import { TenantContext, type RequestTenant } from "../tenancy/tenant-context";
import { TenantTx, type TenantTransaction } from "../tenancy/tenant-tx";
import { consoleOrderReplyOf } from "./console-booking-actions.service";
import {
  attachedBookingOf,
  consoleOrderOf,
  orderOfficeOf,
  partitionOrders,
  PnrImportRepository,
  RECORD_LOCATOR_TARGET,
  withheldBody,
  WITHHELD_ORDER,
} from "./pnr-import.service";
import { QueueSnapshotsRepository } from "./queue-snapshots.repository";
import { queueEntriesOf } from "./queues.service";
import { consoleAction, StaffActionsWriter } from "./staff-actions.writer";

type Schemas = components["schemas"];
type JsonObject = Record<string, unknown>;

export type ConsoleAmadeusCall = Schemas["ConsoleAmadeusCall"];
export type RawFlightOffersSearchRequest = Schemas["ConsoleAmadeusFlightOffersSearchRequest"];
export type RawAvailabilitiesRequest = Schemas["ConsoleAmadeusAvailabilitiesRequest"];
export type RawUpsellRequest = Schemas["ConsoleAmadeusUpsellRequest"];
export type RawPricingRequest = Schemas["ConsoleAmadeusPricingRequest"];
export type RawFlightOffersResult = Schemas["ConsoleAmadeusFlightOffersResult"];
export type RawAvailabilitiesResult = Schemas["ConsoleAmadeusAvailabilitiesResult"];
export type RawUpsellResult = Schemas["ConsoleAmadeusUpsellResult"];
export type RawPricingResult = Schemas["ConsoleAmadeusPricingResult"];
export type RawFlightOrderResult = Schemas["ConsoleAmadeusFlightOrderResult"];
export type RawFlightOrdersByReferenceResult = Schemas["ConsoleAmadeusFlightOrdersByReferenceResult"];
export type RawQueueResult = Schemas["ConsoleAmadeusQueueResult"];
export type RawGetFlightOffersQuery = operations["consoleAmadeusGetFlightOffers"]["parameters"]["query"];
export type RawQuoteQuery = NonNullable<operations["consoleAmadeusQuoteAirOffers"]["parameters"]["query"]>;
export type RawGetFlightOrderQuery = NonNullable<
  operations["consoleAmadeusGetFlightOrder"]["parameters"]["query"]
>;
export type RawByReferenceQuery =
  operations["consoleAmadeusGetFlightOrderByReference"]["parameters"]["query"];
export type RawQueueQuery = NonNullable<operations["consoleAmadeusGetQueue"]["parameters"]["query"]>;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const records = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

// ---- The reads ------------------------------------------------------------------------------------------------------

/** One raw read: its operation, the client method it calls, and how its errors are answered (see the file header). */
export interface RawRead {
  readonly operationId: RawReadOperationId;
  /** The AmadeusClient method. */
  readonly client: AmadeusOperationName;
  /** `supplier_requests.operation`: the SDK method. */
  readonly operation: string;
  /** `staff_actions.action` of a successful call: the SDK method without `console.` (`amadeus.getQueue`). */
  readonly action: string;
  /** Amadeus 404 answers `404 NOT_FOUND` with this message (the order reads); otherwise it is a `4xx` as any other. */
  readonly notFound: string | null;
  /** Amadeus 403 answers `403 OFFICE_NOT_ALLOWED` (the order reads and Queue List document it). */
  readonly officeRefusal: boolean;
}

export type RawReadOperationId =
  | "consoleAmadeusSearchFlightOffers"
  | "consoleAmadeusGetFlightOffers"
  | "consoleAmadeusSearchFlightAvailabilities"
  | "consoleAmadeusUpsellAirOffers"
  | "consoleAmadeusQuoteAirOffers"
  | "consoleAmadeusGetFlightOrder"
  | "consoleAmadeusGetFlightOrderByReference"
  | "consoleAmadeusGetQueue";

function rawRead(
  operationId: RawReadOperationId,
  client: AmadeusOperationName,
  options: { readonly notFound?: string; readonly officeRefusal?: boolean } = {},
): RawRead {
  const action = consoleAction(operationId);
  return Object.freeze({
    operationId,
    client,
    operation: `console.${action}`,
    action,
    notFound: options.notFound ?? null,
    officeRefusal: options.officeRefusal ?? false,
  });
}

/** The eight raw reads (OADR-0011 point 7). */
export const RAW_READS = Object.freeze({
  searchFlightOffers: rawRead("consoleAmadeusSearchFlightOffers", "searchFlightOffers"),
  getFlightOffers: rawRead("consoleAmadeusGetFlightOffers", "getFlightOffers"),
  searchFlightAvailabilities: rawRead(
    "consoleAmadeusSearchFlightAvailabilities",
    "searchFlightAvailabilities",
  ),
  upsellAirOffers: rawRead("consoleAmadeusUpsellAirOffers", "upsellAirOffers"),
  quoteAirOffers: rawRead("consoleAmadeusQuoteAirOffers", "quoteAirOffers"),
  getFlightOrder: rawRead("consoleAmadeusGetFlightOrder", "getFlightOrder", {
    notFound: "Amadeus has no order with this id.",
    officeRefusal: true,
  }),
  getFlightOrderByReference: rawRead("consoleAmadeusGetFlightOrderByReference", "getFlightOrderByReference", {
    notFound: "Amadeus has no order with this record locator.",
    officeRefusal: true,
  }),
  getQueue: rawRead("consoleAmadeusGetQueue", "listQueue", { officeRefusal: true }),
});

/** `staff_actions.target_type` of the order and queue reads (the record locator's is OBE-064's). */
export const FLIGHT_ORDER_TARGET = "flight_order";
export const QUEUE_TARGET = "queue";

/** `Cache-Control` of every answer: prices and personal data, never cached. */
export const RAW_AMADEUS_CACHE_CONTROL = "private, no-store";

// ---- Answers --------------------------------------------------------------------------------------------------------

/**
 * An Amadeus answer as a raw read returns it (see the file header): verbatim, its dictionaries reduced to `carriers`
 * and `aircraft` (left out when none of those is left).
 */
export function rawReplyOf(body: JsonObject): JsonObject {
  const { dictionaries: raw, ...rest } = body;
  const dictionaries = dictionariesOf(raw);
  return dictionaries === null ? rest : { ...rest, dictionaries };
}

/** The results of an answer (the audit's `after`): the entries of its `data` list, 1 for an object, else 0. */
export function resultCountOf(body: JsonObject): number {
  const data = body["data"];
  if (Array.isArray(data)) {
    return data.length;
  }
  return isRecord(data) ? 1 : 0;
}

// ---- Office isolation -----------------------------------------------------------------------------------------------

/** The orders of an answer: its `data` list (by reference), or its one `data` order (Management GET). */
export function ordersOf(body: unknown): JsonObject[] {
  if (!isRecord(body)) {
    return [];
  }
  const data = body["data"];
  return Array.isArray(data) ? records(data) : isRecord(data) ? [data] : [];
}

/**
 * The office that holds a Queue List entry: its owner office, else its queuing office (OBE-064's rule for an order),
 * else the office whose queue was read. The specification's entries name no office, so they are the queue office's.
 */
export function queueEntryOfficeOf(entry: JsonObject, queueOffice: string): string {
  return orderOfficeOf(entry) ?? queueOffice;
}

/** The entries of a Queue List answer, split into the tenant's and the others (`withheld`), each in Amadeus's order. */
export function partitionQueueEntries(
  entries: readonly JsonObject[],
  officeIds: readonly string[],
  queueOffice: string,
): { readonly allowed: JsonObject[]; readonly withheld: JsonObject[] } {
  const allowed: JsonObject[] = [];
  const withheld: JsonObject[] = [];
  for (const entry of entries) {
    (officeIds.includes(queueEntryOfficeOf(entry, queueOffice)) ? allowed : withheld).push(entry);
  }
  return { allowed, withheld };
}

/** A Queue List answer with the `withheld` entries reduced to their id and the WITHHELD_ORDER marker (the row's). */
export function withheldQueueBody(body: JsonObject, withheld: readonly JsonObject[]): JsonObject {
  if (withheld.length === 0) {
    return body;
  }
  const kept = new Set(withheld);
  return {
    ...body,
    data: records(body["data"]).map((entry) =>
      kept.has(entry)
        ? { type: entry["type"] ?? "pnrList", id: entry["id"] ?? null, withheld: WITHHELD_ORDER }
        : entry,
    ),
  };
}

/** A Queue List answer without the `withheld` entries, `meta.count` the entries left (the answer, the snapshot). */
export function queueAnswerOf(body: JsonObject, withheld: readonly JsonObject[]): JsonObject {
  if (withheld.length === 0) {
    return body;
  }
  const dropped = new Set(withheld);
  const data = records(body["data"]).filter((entry) => !dropped.has(entry));
  const meta = body["meta"];
  return {
    ...body,
    data,
    ...(isRecord(meta) && typeof meta["count"] === "number" ? { meta: { ...meta, count: data.length } } : {}),
  };
}

/** What `rawRecordedResponseOf` withholds: the orders of an order read, or the entries of a Queue List read. */
export type RecordedResponseKind =
  { readonly kind: "orders" } | { readonly kind: "queue"; readonly queueOffice: string };

/**
 * The answer of a raw read as the tenant's `supplier_requests` row may keep it (see the file header): the orders (or
 * queue entries) held by an office outside `officeIds` reduced to their id and the WITHHELD_ORDER marker, and, for
 * orders, `included` and `dictionaries` left out when any was (`withheldBody`); any other answer (an error, no order)
 * as it is, and the very same object when nothing is withheld. Pure, with the shape of the Amadeus client's
 * `recordedResponse` hook (FIX-W32-OTA).
 */
export function rawRecordedResponseOf(
  what: RecordedResponseKind,
  officeIds: readonly string[],
): (body: unknown) => unknown {
  const offices = [...officeIds];
  return (body: unknown): unknown => {
    if (!isRecord(body)) {
      return body;
    }
    if (what.kind === "orders") {
      return withheldBody(body, partitionOrders(ordersOf(body), offices).withheld);
    }
    const entries = queueEntriesOf(body) ?? [];
    return withheldQueueBody(body, partitionQueueEntries(entries, offices, what.queueOffice).withheld);
  };
}

// ---- Errors ---------------------------------------------------------------------------------------------------------

/** The client's codes every raw read passes on as they are (the operations' `x-error-codes`, and the `503`). */
const PASSED_CODES: ReadonlySet<string> = new Set<OtaErrorCode>([
  "SUPPLIER_REJECTED",
  "SUPPLIER_NOT_CONFIGURED",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
  "SUPPLIER_ERROR",
  "SUPPLIER_UNAVAILABLE",
  "SUPPLIER_TIMEOUT",
]);

/**
 * The answer of a raw read to an error of the Amadeus client (see the file header). `supplierRequestId` is the row of
 * the request that answered, when there was one.
 */
export function rawErrorOf(read: RawRead, error: unknown, supplierRequestId: string | null): unknown {
  if (!isAppError(error)) {
    return error;
  }
  const passed = (code: string): boolean =>
    PASSED_CODES.has(code) || (read.officeRefusal && code === "OFFICE_NOT_ALLOWED");
  const cause = error.cause instanceof AmadeusCallError ? error.cause : undefined;
  if (cause === undefined) {
    // Refused before Amadeus answered: the connection (424), the buckets (429, 503), an office of the request (403).
    return passed(error.code) ? error : new AppError("SUPPLIER_ERROR", { cause: error });
  }
  const details = {
    ...(error.details ?? {}),
    ...(supplierRequestId === null ? {} : { supplierRequestId }),
    errors: [...cause.issues],
  };
  const supplier = error.supplier === undefined ? {} : { supplier: error.supplier };
  const status = cause.httpStatus;
  if (status === 404 && read.notFound !== null) {
    return new AppError("NOT_FOUND", { message: read.notFound, details, ...supplier, cause: error });
  }
  if (passed(error.code)) {
    return new AppError(error.code, { message: error.message, details, ...supplier, cause });
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 401) {
    return new AppError("SUPPLIER_REJECTED", { details, ...supplier, cause: error });
  }
  return new AppError("SUPPLIER_ERROR", { details, ...supplier, cause: error });
}

// ---- The repository -------------------------------------------------------------------------------------------------

/** A booking of the environment that holds an Amadeus order. */
export interface OrderBooking {
  readonly id: string;
  /** Its owner office, else its queuing office: the office its order is read for. */
  readonly office: string | null;
}

/** The tenant rows the raw reads read and write besides the shared ones (ADR-0004: `tenantTx`). */
@Injectable()
export class RawAmadeusRepository {
  /** True when `id` is a booking of `environment`. */
  async bookingExists(trx: TenantTransaction, environment: string, id: string): Promise<boolean> {
    const row = await trx
      .selectFrom("bookings")
      .select("id")
      .where("id", "=", id)
      .where("environment", "=", environment)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The booking of `environment` holding the order `flightOrderId` (`bookings_amadeus_order_uq`), or `undefined`. */
  async orderBooking(
    trx: TenantTransaction,
    environment: string,
    flightOrderId: string,
  ): Promise<OrderBooking | undefined> {
    const row = await trx
      .selectFrom("bookings")
      .select(["id", "owner_office_id", "queuing_office_id"])
      .where("environment", "=", environment)
      .where("amadeus_order_id", "=", flightOrderId)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : { id: row.id, office: row.owner_office_id ?? row.queuing_office_id };
  }

  /**
   * The last `supplier_requests` row the request `requestId` wrote for `operation` (`supplier_requests_request_idx`):
   * the request that answered a failed call.
   */
  async lastSupplierRequestId(
    trx: TenantTransaction,
    requestId: string,
    operation: string,
  ): Promise<string | undefined> {
    const row = await trx
      .selectFrom("supplier_requests")
      .select("id")
      .where("request_id", "=", requestId)
      .where("operation", "=", operation)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    return row?.id;
  }
}

// ---- The service ----------------------------------------------------------------------------------------------------

/** What a body's links name: the booking the call is about and the staff member's justification. */
interface RawLinks {
  readonly bookingId?: string | undefined;
  readonly reason?: string | undefined;
}

/** A successful call: its answer (an object) and its facts. */
interface RawReply {
  readonly body: JsonObject;
  readonly call: AmadeusCallInfo;
  readonly supplierRequestId: string;
}

/** One client call of a read, with the call context and the client's options. */
type AmadeusCall = (
  context: AmadeusCallContext,
  options: AmadeusCallOptions,
) => Promise<AmadeusResponse<unknown>>;

/** What a call is linked to, and what its `supplier_requests` row keeps of the answer (`rawRecordedResponseOf`). */
interface CallLink {
  readonly bookingId?: string | undefined;
  readonly orderOffice?: string | undefined;
  readonly recorded?: ((body: unknown) => unknown) | undefined;
}

@Injectable()
export class RawAmadeusService {
  constructor(
    private readonly tx: TenantTx,
    private readonly repository: RawAmadeusRepository,
    private readonly pnrImports: PnrImportRepository,
    private readonly snapshots: QueueSnapshotsRepository,
    private readonly amadeus: AmadeusClient,
    private readonly connections: ConnectionResolver,
    private readonly audit: StaffActionsWriter,
    private readonly tenants: TenantContext,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @InjectPinoLogger(RawAmadeusService.name) private readonly logger: PinoLogger,
  ) {}

  // ---- Shopping ----------------------------------------------------------------------------------------------------

  /** console.amadeus.searchFlightOffers: Flight Offers Search POST. */
  async searchFlightOffers(body: RawFlightOffersSearchRequest): Promise<RawFlightOffersResult> {
    return (await this.shopping(RAW_READS.searchFlightOffers, body, {}, (context, options) =>
      this.amadeus.searchFlightOffers(
        context,
        { body: body.amadeus as unknown as SearchFlightOffersRequest["body"] },
        options,
      ),
    )) as RawFlightOffersResult;
  }

  /** console.amadeus.getFlightOffers: Flight Offers Search GET, the query as given. */
  async getFlightOffers(query: RawGetFlightOffersQuery): Promise<RawFlightOffersResult> {
    return (await this.shopping(RAW_READS.getFlightOffers, {}, query, (context, options) =>
      this.amadeus.getFlightOffers(
        context,
        { query: query as unknown as GetFlightOffersRequest["query"] },
        options,
      ),
    )) as RawFlightOffersResult;
  }

  /** console.amadeus.searchFlightAvailabilities: Flight Availabilities Search. */
  async searchFlightAvailabilities(body: RawAvailabilitiesRequest): Promise<RawAvailabilitiesResult> {
    return (await this.shopping(RAW_READS.searchFlightAvailabilities, body, {}, (context, options) =>
      this.amadeus.searchFlightAvailabilities(
        context,
        { body: body.amadeus as unknown as SearchFlightAvailabilitiesRequest["body"] },
        options,
      ),
    )) as RawAvailabilitiesResult;
  }

  /** console.amadeus.upsellAirOffers: Branded Fares Upsell. */
  async upsellAirOffers(body: RawUpsellRequest): Promise<RawUpsellResult> {
    return (await this.shopping(RAW_READS.upsellAirOffers, body, {}, (context, options) =>
      this.amadeus.upsellAirOffers(
        context,
        { body: body.amadeus as unknown as UpsellAirOffersRequest["body"] },
        options,
      ),
    )) as RawUpsellResult;
  }

  /** console.amadeus.quoteAirOffers: Flight Offers Price, `include` and `forceClass` as Amadeus query parameters. */
  async quoteAirOffers(query: RawQuoteQuery, body: RawPricingRequest): Promise<RawPricingResult> {
    const amadeusQuery = {
      ...(query.include === undefined ? {} : { include: [...query.include] }),
      ...(query.forceClass === undefined ? {} : { forceClass: query.forceClass }),
    };
    return (await this.shopping(RAW_READS.quoteAirOffers, body, amadeusQuery, (context, options) =>
      this.amadeus.quoteAirOffers(
        context,
        {
          body: body.amadeus as unknown as QuoteAirOffersRequest["body"],
          ...(Object.keys(amadeusQuery).length === 0
            ? {}
            : { query: amadeusQuery as unknown as NonNullable<QuoteAirOffersRequest["query"]> }),
        },
        options,
      ),
    )) as RawPricingResult;
  }

  /** A shopping read (see the file header): the booking checked, the call, the audit row, the answer. */
  private async shopping(
    read: RawRead,
    links: RawLinks,
    query: Readonly<Record<string, unknown>>,
    send: AmadeusCall,
  ): Promise<{ readonly call: ConsoleAmadeusCall; readonly amadeus: JsonObject }> {
    const tenant = this.tenants.require();
    if (links.bookingId !== undefined) {
      await this.requireBooking(tenant, links.bookingId);
    }
    const reply = await this.send(tenant, read, send, { bookingId: links.bookingId });
    const staffActionId = await this.audit.recordAlone({
      action: read.action,
      reason: links.reason ?? null,
      ...(links.bookingId === undefined
        ? {}
        : { targetType: "booking", targetId: links.bookingId, bookingId: links.bookingId }),
      after: { ...this.facts(reply), results: resultCountOf(reply.body) },
    });
    return {
      call: this.callOf(tenant, read, reply, {}, query, staffActionId),
      amadeus: rawReplyOf(reply.body),
    };
  }

  // ---- Orders ------------------------------------------------------------------------------------------------------

  /** console.amadeus.getFlightOrder: Flight Order Management GET of an order of the tenant's offices. */
  async getFlightOrder(flightOrderId: string, query: RawGetFlightOrderQuery): Promise<RawFlightOrderResult> {
    const read = RAW_READS.getFlightOrder;
    const tenant = this.tenants.require();
    const connection = await this.connection(tenant, read);
    const booking = await this.tx.run((trx) =>
      this.repository.orderBooking(trx, tenant.environment, flightOrderId),
    );
    const amadeusQuery = {
      ...(query.include === undefined ? {} : { include: [...query.include] }),
      ...(query.fareRules === undefined ? {} : { fareRules: [...query.fareRules] }),
    };
    const reply = await this.send(
      tenant,
      read,
      (context, options) =>
        this.amadeus.getFlightOrder(
          context,
          {
            flightOrderId,
            ...(Object.keys(amadeusQuery).length === 0
              ? {}
              : { query: amadeusQuery as unknown as NonNullable<GetFlightOrderRequest["query"]> }),
          },
          options,
        ),
      {
        bookingId: booking?.id,
        orderOffice: booking?.office ?? undefined,
        recorded: rawRecordedResponseOf({ kind: "orders" }, connection.officeIds),
      },
    );
    const [order] = ordersOf(reply.body);
    if (order === undefined || !isRecord(reply.body["data"])) {
      throw new AppError("SUPPLIER_ERROR", { message: "Amadeus answered without the order." });
    }
    if (partitionOrders([order], connection.officeIds).withheld.length > 0) {
      await this.denyOffice(read, FLIGHT_ORDER_TARGET, flightOrderId, reply, 1);
      throw new AppError("OFFICE_NOT_ALLOWED", {
        message: "This order belongs to an office outside this OTA.",
      });
    }
    const staffActionId = await this.audit.recordAlone({
      action: read.action,
      targetType: FLIGHT_ORDER_TARGET,
      targetId: flightOrderId,
      bookingId: booking?.id ?? null,
      after: { ...this.facts(reply), flightOrderId },
    });
    return {
      call: this.callOf(
        tenant,
        read,
        reply,
        { "flight-orderId": flightOrderId },
        amadeusQuery,
        staffActionId,
      ),
      flightOrderId,
      bookingId: booking?.id ?? null,
      bookingSynced: false,
      amadeus: consoleOrderReplyOf(reply.body) as RawFlightOrderResult["amadeus"],
    };
  }

  /** console.amadeus.getFlightOrderByReference: the tenant's orders with this record locator. */
  async getFlightOrderByReference(query: RawByReferenceQuery): Promise<RawFlightOrdersByReferenceResult> {
    const read = RAW_READS.getFlightOrderByReference;
    const tenant = this.tenants.require();
    const connection = await this.connection(tenant, read);
    const amadeusQuery = {
      reference: query.reference,
      originSystemCode: query.originSystemCode,
      ...(query.include === undefined ? {} : { include: [...query.include] }),
    };
    const reply = await this.send(
      tenant,
      read,
      (context, options) =>
        this.amadeus.getFlightOrderByReference(
          context,
          { query: amadeusQuery as unknown as GetFlightOrderByReferenceRequest["query"] },
          options,
        ),
      { recorded: rawRecordedResponseOf({ kind: "orders" }, connection.officeIds) },
    );
    const orders = records(reply.body["data"]);
    if (orders.length === 0) {
      throw new AppError("NOT_FOUND", { message: "Amadeus has no order with this record locator." });
    }
    const { allowed, withheld } = partitionOrders(orders, connection.officeIds);
    if (withheld.length > 0) {
      this.logger.warn(
        { operation: read.operation, withheldOrders: withheld.length, allowedOrders: allowed.length },
        "console.raw_amadeus_office_not_allowed",
      );
    }
    if (allowed.length === 0) {
      await this.denyOffice(read, RECORD_LOCATOR_TARGET, query.reference, reply, withheld.length);
      throw new AppError("OFFICE_NOT_ALLOWED", {
        message: "This record locator belongs to an office outside this OTA.",
      });
    }
    const bookings = await this.tx.run((trx) =>
      this.pnrImports.attachedBookings(
        trx,
        tenant.environment,
        recordsOfOrders(allowed, { reference: query.reference, originSystemCode: query.originSystemCode }),
        allowed.flatMap((order) => text(order["id"]) ?? []),
      ),
    );
    const matches = allowed.map((order) => ({
      flightOrderId: text(order["id"]) ?? "",
      bookingId: attachedBookingOf(order, bookings)?.id ?? null,
    }));
    const staffActionId = await this.audit.recordAlone({
      action: read.action,
      targetType: RECORD_LOCATOR_TARGET,
      targetId: query.reference,
      after: {
        ...this.facts(reply),
        originSystemCode: query.originSystemCode,
        flightOrderIds: matches.map((match) => match.flightOrderId),
        attachedBookingIds: matches.flatMap((match) => match.bookingId ?? []),
        withheldOrders: withheld.length,
      },
    });
    return {
      call: this.callOf(tenant, read, reply, {}, amadeusQuery, staffActionId),
      matches,
      amadeus: byReferenceReplyOf(reply.body, allowed, withheld.length > 0),
    };
  }

  // ---- Queue List --------------------------------------------------------------------------------------------------

  /** console.amadeus.getQueue: Queue List of one of the tenant's offices, kept as a `queue_snapshots` row. */
  async getQueue(queueId: number, query: RawQueueQuery): Promise<RawQueueResult> {
    const read = RAW_READS.getQueue;
    const tenant = this.tenants.require();
    const connection = await this.connection(tenant, read);
    const amadeusQuery = {
      ...(query.max === undefined ? {} : { max: query.max }),
      ...(query.category === undefined ? {} : { category: query.category }),
      ...(query.officeId === undefined ? {} : { officeId: query.officeId }),
    };
    // The office whose queue is read, as the client chooses it: the caller's (one of the connection's), else the
    // connection's queue office.
    const queueOffice = query.officeId ?? connection.offices.queue;
    const reply = await this.send(
      tenant,
      read,
      (context, options) =>
        this.amadeus.listQueue(
          context,
          {
            queueId,
            ...(Object.keys(amadeusQuery).length === 0
              ? {}
              : { query: amadeusQuery as unknown as NonNullable<ListQueueRequest["query"]> }),
          },
          options,
        ),
      { recorded: rawRecordedResponseOf({ kind: "queue", queueOffice }, connection.officeIds) },
    );
    const entries = queueEntriesOf(reply.body);
    if (entries === undefined) {
      this.logger.warn(
        { queueId, supplierRequestId: reply.supplierRequestId },
        "console.raw_amadeus_unreadable_queue",
      );
      throw new AppError("SUPPLIER_ERROR", { message: "The supplier's queue answer could not be read." });
    }
    const { withheld } = partitionQueueEntries(entries, connection.officeIds, queueOffice);
    if (withheld.length > 0) {
      this.logger.warn(
        { operation: read.operation, queueId, withheldItems: withheld.length },
        "console.raw_amadeus_office_not_allowed",
      );
    }
    const answer = queueAnswerOf(reply.body, withheld);
    const category = query.category ?? 0;
    const queueSnapshotId = this.ids.newId("qsn");
    const staffActionId = await this.tx.run(async (trx) => {
      await this.snapshots.insert(trx, {
        id: queueSnapshotId,
        environment: tenant.environment,
        officeId: queueOffice,
        queueId,
        category,
        maxRequested: query.max ?? null,
        itemCount: entries.length - withheld.length,
        response: redactPayload(answer),
        fetchedByStaffId: staffIdOf(tenant) ?? null,
        supplierRequestId: reply.supplierRequestId,
        fetchedAt: this.clock.now(),
      });
      return await this.audit.record(trx, {
        action: read.action,
        targetType: QUEUE_TARGET,
        targetId: String(queueId),
        after: {
          ...this.facts(reply),
          queueId,
          category,
          queueSnapshotId,
          itemCount: entries.length - withheld.length,
          withheldItems: withheld.length,
        },
      });
    });
    return {
      call: this.callOf(
        tenant,
        read,
        reply,
        { "queue-id": queueId },
        { ...amadeusQuery, officeId: queueOffice },
        staffActionId,
      ),
      queueSnapshotId,
      amadeus: answer as RawQueueResult["amadeus"],
    };
  }

  // ---- The call ----------------------------------------------------------------------------------------------------

  /**
   * One Amadeus call (no transaction open): the client's errors answered as the raw reads answer them (`rawErrorOf`),
   * an answer that is not a JSON object `502 SUPPLIER_ERROR`, a call whose row could not be written a failure. With
   * `recorded` (`rawRecordedResponseOf`), the client's `recordedResponse` hook, the call's `supplier_requests` row keeps
   * only what it leaves of the answer, from the row's first write.
   */
  private async send(
    tenant: RequestTenant,
    read: RawRead,
    call: AmadeusCall,
    link: CallLink = {},
  ): Promise<RawReply> {
    const context = this.context(tenant, read, link.bookingId, link.orderOffice);
    // The client applies `link.recorded` before it writes the row (lead decision (1e) of 2026-10-28).
    const options: AmadeusCallOptions =
      link.recorded === undefined ? {} : { recordedResponse: link.recorded };
    let reply: AmadeusResponse<unknown>;
    try {
      reply = await call(context, options);
    } catch (error) {
      const supplierRequestId =
        isAppError(error) && error.cause instanceof AmadeusCallError
          ? await this.answeringRequest(context.requestId, read)
          : null;
      throw rawErrorOf(read, error, supplierRequestId);
    }
    const supplierRequestId = reply.call.supplierRequestId;
    if (supplierRequestId === null) {
      // The answer names its supplier_requests row, which could not be written (the client's log line says why).
      throw new Error(`${read.operation}: the Amadeus call could not be recorded`);
    }
    if (!isRecord(reply.body)) {
      throw new AppError("SUPPLIER_ERROR", {
        message: "Amadeus answered with something that is not an object.",
      });
    }
    return { body: reply.body, call: reply.call, supplierRequestId };
  }

  /** The tenant's connection (its offices); `424 SUPPLIER_NOT_CONFIGURED` as the client answers it. */
  private async connection(tenant: RequestTenant, read: RawRead): Promise<ResolvedAmadeusConnection> {
    try {
      return await this.connections.resolve(tenant.tenantId, tenant.environment);
    } catch (error) {
      throw rawErrorOf(read, error, null);
    }
  }

  /** The row of the request that answered a failed call, or `null` (never failing the answer). */
  private async answeringRequest(requestId: string, read: RawRead): Promise<string | null> {
    try {
      return (
        (await this.tx.run((trx) => this.repository.lastSupplierRequestId(trx, requestId, read.operation))) ??
        null
      );
    } catch (error) {
      this.logger.warn({ err: error, operation: read.operation }, "console.raw_amadeus_request_not_found");
      return null;
    }
  }

  /** The `denied` staff action of a read refused for another office's order (a transaction of its own). */
  private async denyOffice(
    read: RawRead,
    targetType: string,
    targetId: string,
    reply: RawReply,
    withheldOrders: number,
  ): Promise<void> {
    await this.audit.recordAlone({
      action: read.action,
      outcome: "denied",
      targetType,
      targetId,
      after: { code: "OFFICE_NOT_ALLOWED", withheldOrders, supplierRequestId: reply.supplierRequestId },
    });
  }

  /** A body's `bookingId` must be a booking of the environment (`400 VALIDATION_FAILED` at `/bookingId`). */
  private async requireBooking(tenant: RequestTenant, bookingId: string): Promise<void> {
    const exists = await this.tx.run((trx) =>
      this.repository.bookingExists(trx, tenant.environment, bookingId),
    );
    if (!exists) {
      throw new AppError("VALIDATION_FAILED", {
        fieldErrors: [
          { path: "/bookingId", code: "not_found", message: "No booking of this environment has this id." },
        ],
      });
    }
  }

  /** The call's facts for the audit row's `after` (never a body). */
  private facts(reply: RawReply): JsonObject {
    return {
      supplierRequestId: reply.supplierRequestId,
      officeId: reply.call.officeId,
      httpStatus: reply.call.status,
    };
  }

  /** The call information of an answer (ConsoleAmadeusCall). */
  private callOf(
    tenant: RequestTenant,
    read: RawRead,
    reply: RawReply,
    pathParams: Readonly<Record<string, string | number>>,
    query: Readonly<Record<string, unknown>>,
    staffActionId: string,
  ): ConsoleAmadeusCall {
    const spec = AMADEUS_OPERATIONS[read.client];
    return {
      supplierRequestId: reply.supplierRequestId,
      environment: tenant.environment,
      officeId: reply.call.officeId,
      amadeusApi: spec.api,
      amadeusOperationId: spec.operationId,
      httpMethod: spec.method,
      path: requestPath(spec.path, pathParams, query),
      httpStatus: reply.call.status,
      durationMs: reply.call.durationMs,
      correlationId: reply.call.correlationId,
      staffActionId,
    };
  }

  private context(
    tenant: RequestTenant,
    read: RawRead,
    bookingId: string | undefined,
    orderOffice: string | undefined,
  ): AmadeusCallContext {
    const staffId = staffIdOf(tenant);
    return {
      tenantId: tenant.tenantId,
      environment: tenant.environment,
      operation: read.operation,
      requestId: this.tenants.requestId() ?? tenant.requestId,
      ...(staffId === undefined ? {} : { staffId }),
      ...(bookingId === undefined ? {} : { bookingId }),
      ...(orderOffice === undefined ? {} : { orderOffice }),
    };
  }
}

/** The staff member of the request, if it has one (a key-only call has none). */
function staffIdOf(tenant: RequestTenant): string | undefined {
  return tenant.actor.type === "staff" && tenant.actor.id !== null ? tenant.actor.id : undefined;
}

/** The records of the orders (their associated records) and the one asked for, to find the bookings they belong to. */
function recordsOfOrders(
  orders: readonly JsonObject[],
  asked: { readonly reference: string; readonly originSystemCode: string },
): { readonly reference: string; readonly originSystemCode: string }[] {
  const keys = new Map([[`${asked.reference}|${asked.originSystemCode}`, asked]]);
  for (const order of orders) {
    for (const record of records(order["associatedRecords"])) {
      const reference = text(record["reference"]);
      const originSystemCode = text(record["originSystemCode"]);
      if (reference !== undefined && originSystemCode !== undefined) {
        keys.set(`${reference}|${originSystemCode}`, { reference, originSystemCode });
      }
    }
  }
  return [...keys.values()];
}

/**
 * The by-reference answer (ConsoleAmadeusFlightOrdersByReferenceResult.amadeus): the tenant's orders verbatim (forms
 * of payment through the shared redactor), and, when no order was withheld, `included` and the dictionaries reduced to
 * carriers and aircraft.
 */
export function byReferenceReplyOf(
  body: JsonObject,
  allowed: readonly JsonObject[],
  anyWithheld: boolean,
): RawFlightOrdersByReferenceResult["amadeus"] {
  const { included, dictionaries: raw, data: _data, ...rest } = body;
  const dictionaries = anyWithheld ? null : dictionariesOf(raw);
  return {
    ...rest,
    data: allowed.map(consoleOrderOf),
    ...(anyWithheld || !isRecord(included) ? {} : { included }),
    ...(dictionaries === null ? {} : { dictionaries }),
  } as RawFlightOrdersByReferenceResult["amadeus"];
}
