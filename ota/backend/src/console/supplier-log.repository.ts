// The supplier log (OBE-066; ota/docs/flows/console-operations.md §2 "Supplier log", db README §8 "Redaction rule for
// jsonb copies" and §10 "B4 Console" (Diagnostics), the document's consoleListSupplierRequests and
// ConsoleSupplierRequest): the `supplier_requests` rows of the request's environment, newest first, as the Amadeus
// client wrote them (amadeus/supplier-requests.repository.ts).
//
// - Filters, AND-ed (list values OR-ed), every query leading with `environment` as the table's indexes do:
//   `bookingId`, `searchId`, `amadeusApi`, `amadeusOperationId` (exact), `outcome`, `httpStatus`, `errorCode` (one of
//   the row's Amadeus error codes, the GIN index), `staffId`, `requestId` (the Velexis `X-Request-Id`),
//   `correlationId` (Amadeus `ama-request-id`), `createdFrom` (at or after), `createdTo` (before). The keyset cursor is
//   the previous page's last `created_at` (UTC with microseconds) and id, bound to the environment and the filters.
// - Bodies only with `includeBodies=true` (otherwise they are not even read), and then at most 20 rows a page (the
//   document's "`limit` ≤ 20 then": a larger `limit` is `400 VALIDATION_FAILED` at `/query/limit`). They are the stored
//   copies, which the client wrote through the shared redactor and the contact masking (card numbers to their last 4,
//   card holder, expiry and security codes dropped, document numbers to their last 4, tokens and secrets
//   `[REDACTED]`, e-mail addresses and phone numbers masked, bodies above 64 KB truncated), and they pass the shared
//   redactor (`redactPayload`) once more on the way out: it changes nothing on a body redacted since FIX-W29-SECURITY,
//   and a row written before that, within the 90 days the rows are kept, never shows a card holder or expiry it may
//   still hold (OBE-052's rule: no card number, holder, expiry or document number in any answer). The one thing the
//   second pass cannot walk is the `preview` text of a truncated body (`{ truncated, bytes, preview }`): the writer cut
//   it from its own redacted copy, so it is as redacted as the writer was when the row was written. A stored body that
//   is not a JSON object (the document's bodies are objects) is answered as `{ "value": … }`.
//
// Like every tenant repository it takes the `tenantTx` transaction first, never opens one and never names a tenant
// schema.
import { Injectable } from "@nestjs/common";
import type { components, operations } from "@velexis/api-types";
import { sql } from "@velexis/db";
import { AppError } from "@velexis/errors";
import { redactPayload } from "@velexis/logger";
import { listFingerprint } from "../bookings/bookings.mapper";
import { invalidCursor } from "../reference/reference.mapper";
import type { TenantTransaction } from "../tenancy/tenant-tx";
import { toConsoleSupplierRequest } from "./console-bookings.mapper";
import type { ConsoleSupplierRequestRow } from "./console-bookings.repository";
import { DEFAULT_CONSOLE_PAGE_LIMIT } from "./console-bookings.service";

/** A SQL fragment of type `T` (Kysely's RawBuilder, which @velexis/db does not re-export by name). */
type RawBuilder<T> = ReturnType<typeof sql.raw<T>>;

type Schemas = components["schemas"];
export type ConsoleSupplierRequest = Schemas["ConsoleSupplierRequest"];
export type ConsoleSupplierRequestPage = Schemas["ConsoleSupplierRequestPage"];
export type ConsoleListSupplierRequestsQuery = NonNullable<
  operations["consoleListSupplierRequests"]["parameters"]["query"]
>;

/** `Cache-Control` of console.supplierRequests.list (supplier records, never cached). */
export const SUPPLIER_LOG_CACHE_CONTROL = "private, no-store";

/** The largest page with bodies (the document: "`limit` ≤ 20 then"). */
export const MAX_LIMIT_WITH_BODIES = 20;

/** The filters of console.supplierRequests.list, as validated. */
export interface SupplierLogFilters {
  readonly bookingId?: string | undefined;
  readonly searchId?: string | undefined;
  readonly amadeusApi?: readonly string[] | undefined;
  readonly amadeusOperationId?: string | undefined;
  readonly outcome?: readonly string[] | undefined;
  readonly httpStatus?: number | undefined;
  readonly errorCode?: number | undefined;
  readonly staffId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly correlationId?: string | undefined;
  /** ISO-8601 instants: `createdFrom` inclusive, `createdTo` exclusive. */
  readonly createdFrom?: string | undefined;
  readonly createdTo?: string | undefined;
}

/** One page of console.supplierRequests.list. */
export interface SupplierLogQuery extends SupplierLogFilters {
  readonly environment: string;
  readonly includeBodies: boolean;
  /** The keyset position of the previous page: its last row's `created_at` (cursor text) and id. */
  readonly after?: { readonly key: string; readonly id: string } | undefined;
  /** Rows to read (the page size plus one). */
  readonly limit: number;
}

/** A row of the supplier log: the call, its bodies when asked for (`undefined` otherwise), and its sort key. */
export interface SupplierLogRow extends ConsoleSupplierRequestRow {
  readonly requestBody: unknown;
  readonly responseBody: unknown;
  /** `created_at` in UTC with microseconds. */
  readonly sortKey: string;
}

/** The filters of a validated query. */
export function supplierLogFiltersOf(query: ConsoleListSupplierRequestsQuery): SupplierLogFilters {
  return {
    bookingId: query.bookingId,
    searchId: query.searchId,
    amadeusApi: query.amadeusApi,
    amadeusOperationId: query.amadeusOperationId,
    outcome: query.outcome,
    httpStatus: query.httpStatus,
    errorCode: query.errorCode,
    staffId: query.staffId,
    requestId: query.requestId,
    correlationId: query.correlationId,
    createdFrom: query.createdFrom,
    createdTo: query.createdTo,
  };
}

/**
 * The page size of a query: its `limit` (the document's default, 20); with bodies at most 20, a larger one is
 * `400 VALIDATION_FAILED` at `/query/limit`.
 */
export function supplierLogLimitOf(
  query: Pick<ConsoleListSupplierRequestsQuery, "limit" | "includeBodies">,
): number {
  const limit = query.limit ?? DEFAULT_CONSOLE_PAGE_LIMIT;
  if (query.includeBodies === true && limit > MAX_LIMIT_WITH_BODIES) {
    throw new AppError("VALIDATION_FAILED", {
      fieldErrors: [
        {
          path: "/query/limit",
          code: "maximum",
          message: `must be at most ${MAX_LIMIT_WITH_BODIES} with includeBodies=true`,
        },
      ],
    });
  }
  return limit;
}

// ---- Cursors -------------------------------------------------------------------------------------------------------

const CURSOR_VERSION = 1;
const INSTANT_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;
const SUPPLIER_REQUEST_ID = /^sreq_[0-9A-Za-z]{16,40}$/;
const MAX_CURSOR_LENGTH = 400;

/**
 * The fingerprint of a supplier log: the environment and every filter. `includeBodies` is not part of it: it changes
 * what a row shows, not which rows a page holds.
 */
export function supplierLogFingerprint(environment: string, filters: SupplierLogFilters): string {
  const sorted = (values: readonly string[] | undefined): string | undefined =>
    values === undefined ? undefined : [...values].sort().join(",");
  const instant = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : new Date(value).toISOString();
  const integer = (value: number | undefined): string | undefined =>
    value === undefined ? undefined : String(value);
  return listFingerprint({
    list: "console.supplierRequests",
    environment,
    bookingId: filters.bookingId,
    searchId: filters.searchId,
    amadeusApi: sorted(filters.amadeusApi),
    amadeusOperationId: filters.amadeusOperationId,
    outcome: sorted(filters.outcome),
    httpStatus: integer(filters.httpStatus),
    errorCode: integer(filters.errorCode),
    staffId: filters.staffId,
    requestId: filters.requestId,
    correlationId: filters.correlationId,
    createdFrom: instant(filters.createdFrom),
    createdTo: instant(filters.createdTo),
  });
}

/** The opaque cursor after the row with this `created_at` text and id. */
export function encodeSupplierLogCursor(fingerprint: string, key: string, id: string): string {
  return Buffer.from(JSON.stringify([CURSOR_VERSION, fingerprint, key, id])).toString("base64url");
}

/**
 * The keyset position of `value` for the log of `fingerprint`; `400 VALIDATION_FAILED` (`/query/cursor`) for a value
 * this API did not write or a cursor of other filters.
 */
export function decodeSupplierLogCursor(
  value: string,
  fingerprint: string,
): { readonly key: string; readonly id: string } {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalidCursor();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) {
    throw invalidCursor();
  }
  const [version, print, key, id] = parsed as unknown[];
  if (
    version !== CURSOR_VERSION ||
    print !== fingerprint ||
    typeof key !== "string" ||
    !INSTANT_KEY.test(key) ||
    typeof id !== "string" ||
    !SUPPLIER_REQUEST_ID.test(id)
  ) {
    throw invalidCursor();
  }
  return { key, id };
}

// ---- The answer ----------------------------------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A stored body as the log answers it (see the file header): redacted once more, an object, or `null` for none. */
export function answeredBody(stored: unknown): JsonObject | null {
  if (stored === undefined || stored === null) {
    return null;
  }
  return isRecord(stored) ? redactPayload(stored) : { value: redactPayload(stored) };
}

/** A row of the log; with `includeBodies` its redacted bodies. */
export function toSupplierLogEntry(row: SupplierLogRow, includeBodies: boolean): ConsoleSupplierRequest {
  const call = toConsoleSupplierRequest(row);
  return includeBodies
    ? { ...call, requestBody: answeredBody(row.requestBody), responseBody: answeredBody(row.responseBody) }
    : call;
}

/** The conditions of `filters` on supplier request `r` (environment excluded). */
function conditionsOf(filters: SupplierLogFilters): RawBuilder<boolean>[] {
  const conditions: RawBuilder<boolean>[] = [];
  const list = (values: readonly string[] | undefined) =>
    values !== undefined && values.length > 0 ? [...values] : undefined;
  const equal = (column: string, value: string | number | undefined) => {
    if (value !== undefined) {
      conditions.push(sql<boolean>`${sql.ref(column)} = ${value}`);
    }
  };
  equal("r.booking_id", filters.bookingId);
  equal("r.search_id", filters.searchId);
  const apis = list(filters.amadeusApi);
  if (apis !== undefined) {
    conditions.push(sql<boolean>`r.amadeus_api = ANY(${apis}::text[])`);
  }
  equal("r.amadeus_operation_id", filters.amadeusOperationId);
  const outcomes = list(filters.outcome);
  if (outcomes !== undefined) {
    conditions.push(sql<boolean>`r.outcome = ANY(${outcomes}::text[])`);
  }
  equal("r.http_status", filters.httpStatus);
  if (filters.errorCode !== undefined) {
    conditions.push(sql<boolean>`r.error_codes @> ARRAY[${filters.errorCode}]::integer[]`);
  }
  equal("r.staff_id", filters.staffId);
  equal("r.request_id", filters.requestId);
  equal("r.correlation_id", filters.correlationId);
  if (filters.createdFrom !== undefined) {
    conditions.push(sql<boolean>`r.created_at >= ${filters.createdFrom}::timestamptz`);
  }
  if (filters.createdTo !== undefined) {
    conditions.push(sql<boolean>`r.created_at < ${filters.createdTo}::timestamptz`);
  }
  return conditions;
}

@Injectable()
export class SupplierLogRepository {
  /** One page of the log, newest first (see the file header). */
  async page(trx: TenantTransaction, query: SupplierLogQuery): Promise<SupplierLogRow[]> {
    const conditions = conditionsOf(query);
    if (query.after !== undefined) {
      conditions.push(
        sql<boolean>`(r.created_at, r.id) < (${query.after.key}::timestamp AT TIME ZONE 'UTC', ${query.after.id})`,
      );
    }
    // Bodies are read only when they are answered.
    const body = (column: string) =>
      query.includeBodies ? sql<unknown>`${sql.ref(column)}` : sql<unknown>`NULL`;
    let select = trx
      .selectFrom("supplier_requests as r")
      .select([
        "r.id as id",
        "r.environment as environment",
        "r.operation as operation",
        "r.amadeus_api as amadeusApi",
        "r.amadeus_operation_id as amadeusOperationId",
        "r.http_method as httpMethod",
        "r.path as path",
        "r.office_id as officeId",
        "r.http_status as httpStatus",
        "r.outcome as outcome",
        "r.error_codes as errorCodes",
        "r.duration_ms as durationMs",
        "r.correlation_id as correlationId",
        "r.request_id as requestId",
        "r.booking_id as bookingId",
        "r.search_id as searchId",
        "r.staff_id as staffId",
        "r.redacted as redacted",
        "r.truncated as truncated",
        "r.created_at as createdAt",
        body("r.request_body").as("requestBody"),
        body("r.response_body").as("responseBody"),
        sql<string>`to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`.as("sortKey"),
      ])
      .where("r.environment", "=", query.environment);
    if (conditions.length > 0) {
      select = select.where(sql<boolean>`${sql.join(conditions, sql` AND `)}`);
    }
    return await select.orderBy("r.created_at", "desc").orderBy("r.id", "desc").limit(query.limit).execute();
  }
}
