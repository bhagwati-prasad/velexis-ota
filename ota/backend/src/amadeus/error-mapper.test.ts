// The error table of flows/amadeus-connection-and-tokens.md §5 (OBE-018; OADR-0001 point 8): every row as a case, the
// field errors of traveller pointers, the raw issue kept for console scope, and a cause that names no body.
import { AppError, toErrorEnvelope, type OtaErrorCode } from "@velexis/errors";
import { serializeError } from "@velexis/logger";
import { describe, expect, it } from "vitest";
import {
  AMADEUS_CODE_TABLE,
  AMADEUS_DATA_CODES,
  AmadeusCallError,
  codeForStatus,
  errorCodesOf,
  mapAmadeusError,
  outcomeOf,
  travelerPath,
  type AmadeusFailure,
  type AmadeusIssue,
} from "./error-mapper";

/** An Amadeus error answer of one issue. */
function http(status: number, code?: number, source?: AmadeusIssue["source"]): AmadeusFailure {
  const issue: AmadeusIssue = {
    status,
    ...(code === undefined ? {} : { code }),
    title: "SOME TITLE",
    ...(source === undefined ? {} : { source }),
  };
  return { kind: "http", status, issues: [issue] };
}

const TRAVELER_POINTER = { pointer: "/data/travelers/0/documents/0/number" };

describe("the error table of flow §5 [OBE-018]", () => {
  const cases: ReadonlyArray<readonly [string, AmadeusFailure, number, OtaErrorCode]> = [
    ["client timeout", { kind: "timeout" }, 504, "SUPPLIER_TIMEOUT"],
    ["connection reset", { kind: "network", code: "ECONNRESET" }, 504, "SUPPLIER_TIMEOUT"],
    ["socket closed by the server", { kind: "network", code: "UND_ERR_SOCKET" }, 504, "SUPPLIER_TIMEOUT"],
    ["connection refused", { kind: "network", code: "ECONNREFUSED" }, 503, "SUPPLIER_UNAVAILABLE"],
    ["DNS failure", { kind: "network", code: "ENOTFOUND" }, 503, "SUPPLIER_UNAVAILABLE"],
    ["network error without a code", { kind: "network" }, 503, "SUPPLIER_UNAVAILABLE"],
    ["HTTP 500, 141 SYSTEM ERROR", http(500, 141), 502, "SUPPLIER_ERROR"],
    ["HTTP 500 without a body", { kind: "http", status: 500, issues: [] }, 502, "SUPPLIER_ERROR"],
    ["HTTP 502", http(502), 503, "SUPPLIER_UNAVAILABLE"],
    ["HTTP 503", http(503), 503, "SUPPLIER_UNAVAILABLE"],
    ["HTTP 504 of Amadeus's gateway", http(504, 141), 504, "SUPPLIER_TIMEOUT"],
    ["HTTP 429 of the shared quota", http(429, 38194), 503, "SUPPLIER_UNAVAILABLE"],
    ["34651 segment sell failure", http(400, 34651), 409, "SOLD_OUT"],
    ["37200 price discrepancy", http(400, 37200), 409, "PRICE_CHANGED"],
    ["2552 simultaneous update", http(409, 2552), 409, "VERSION_CONFLICT"],
    ["9112 ticketing", http(400, 9112), 502, "TICKETING_FAILED"],
    ["1304 credit card not accepted", http(400, 1304), 402, "PAYMENT_DECLINED"],
    ["4926 on a traveller", http(400, 4926, TRAVELER_POINTER), 422, "TRAVELER_DATA_INVALID"],
    [
      "32171 on a traveller",
      http(400, 32171, { pointer: "/data/travelers/1/dateOfBirth" }),
      422,
      "TRAVELER_DATA_INVALID",
    ],
    ["4926 elsewhere", http(400, 4926, { pointer: "/data/flightOffers/0/price" }), 422, "SUPPLIER_REJECTED"],
    [
      "32171 on a query parameter",
      http(400, 32171, { parameter: "originLocationCode" }),
      422,
      "SUPPLIER_REJECTED",
    ],
    ["477 invalid format", http(400, 477), 422, "SUPPLIER_REJECTED"],
    ["404 order not found", http(404, 1797), 422, "SUPPLIER_REJECTED"],
    ["409 without 2552", http(409, 1), 422, "SUPPLIER_REJECTED"],
    ["403 office refused", http(403, 38197), 403, "OFFICE_NOT_ALLOWED"],
    ["401 after the retry with a new token", http(401, 38190), 502, "SUPPLIER_ERROR"],
    ["a 2xx that is not JSON", { kind: "http", status: 200, issues: [] }, 502, "SUPPLIER_ERROR"],
    ["a redirect", { kind: "http", status: 302, issues: [] }, 502, "SUPPLIER_ERROR"],
  ];

  it.each(cases)("maps %s to %i %s", (_name, failure, status, code) => {
    const error = mapAmadeusError("quoteAirOffers", failure);

    expect(error).toBeInstanceOf(AppError);
    expect([error.status, error.code]).toEqual([status, code]);
    expect(error.cause).toBeInstanceOf(AmadeusCallError);
  });

  it("is a constant: the code table and the data codes", () => {
    expect(AMADEUS_CODE_TABLE).toEqual({
      34651: "SOLD_OUT",
      37200: "PRICE_CHANGED",
      2552: "VERSION_CONFLICT",
      9112: "TICKETING_FAILED",
      1304: "PAYMENT_DECLINED",
    });
    expect(AMADEUS_DATA_CODES).toEqual({ 4926: "invalid", 32171: "required" });
    expect(Object.isFrozen(AMADEUS_CODE_TABLE)).toBe(true);
    expect([401, 403, 418, 429, 500, 501, 502, 503, 504].map(codeForStatus)).toEqual([
      "SUPPLIER_ERROR",
      "OFFICE_NOT_ALLOWED",
      "SUPPLIER_REJECTED",
      "SUPPLIER_UNAVAILABLE",
      "SUPPLIER_ERROR",
      "SUPPLIER_ERROR",
      "SUPPLIER_UNAVAILABLE",
      "SUPPLIER_UNAVAILABLE",
      "SUPPLIER_TIMEOUT",
    ]);
  });

  it("lets the first issue with a code of the table decide, and applies the codes to 4xx answers only", () => {
    const soldOutSecond: AmadeusFailure = {
      kind: "http",
      status: 400,
      issues: [
        { code: 477, title: "INVALID FORMAT" },
        { code: 34651, title: "SEGMENT SELL FAILURE" },
      ],
    };
    const serverWithCode = http(500, 34651);

    expect(mapAmadeusError("createFlightOrders", soldOutSecond).code).toBe("SOLD_OUT");
    expect(mapAmadeusError("createFlightOrders", soldOutSecond).supplier).toMatchObject({ code: 34651 });
    expect(mapAmadeusError("createFlightOrders", serverWithCode).code).toBe("SUPPLIER_ERROR");
  });
});

describe("TRAVELER_DATA_INVALID", () => {
  it("has one field error per traveller pointer, with the OTA path and no value", () => {
    const failure: AmadeusFailure = {
      kind: "http",
      status: 400,
      issues: [
        {
          status: 400,
          code: 4926,
          title: "INVALID DATA RECEIVED",
          detail: "123456789 is not valid",
          source: TRAVELER_POINTER,
        },
        {
          status: 400,
          code: 32171,
          title: "MANDATORY DATA MISSING",
          source: { pointer: "/data/travelers[1]/dateOfBirth" },
        },
        { status: 400, code: 4926, title: "INVALID DATA RECEIVED", source: { pointer: "/data/contacts/0" } },
      ],
    };

    const error = mapAmadeusError("createFlightOrders", failure);

    expect(error.code).toBe("TRAVELER_DATA_INVALID");
    expect(error.fieldErrors).toEqual([
      { path: "/travelers/0/documents/0/number", code: "invalid", message: "INVALID DATA RECEIVED" },
      { path: "/travelers/1/dateOfBirth", code: "required", message: "MANDATORY DATA MISSING" },
    ]);
    expect(JSON.stringify(error.fieldErrors)).not.toContain("123456789");
  });

  it("reads pointers into the travellers only", () => {
    expect(travelerPath("/data/travelers")).toBe("/travelers");
    expect(travelerPath("/data/travelers/0/name/firstName")).toBe("/travelers/0/name/firstName");
    expect(travelerPath("/data/travelers[2]/documents[0]/number")).toBe("/travelers/2/documents/0/number");
    expect(travelerPath("/data/travelersX/0")).toBeUndefined();
    expect(travelerPath("/data/flightOffers/0")).toBeUndefined();
    expect(travelerPath(undefined)).toBeUndefined();
  });
});

describe("the raw issue", () => {
  const failure: AmadeusFailure = {
    kind: "http",
    status: 400,
    issues: [
      {
        status: 400,
        code: 32171,
        title: "MANDATORY DATA MISSING",
        detail: "query parameter originLocationCode is required",
        source: { parameter: "originLocationCode" },
      },
      { status: 400, code: 477, title: "INVALID FORMAT" },
    ],
  };

  it("is kept in error.supplier and shown in console scope only [OBE-018]", () => {
    const error = mapAmadeusError("getFlightOffers", failure);
    const supplier = {
      provider: "amadeus",
      status: 400,
      code: 32171,
      title: "MANDATORY DATA MISSING",
      detail: "query parameter originLocationCode is required",
      source: { parameter: "originLocationCode" },
    };

    expect(error.code).toBe("SUPPLIER_REJECTED");
    expect(error.supplier).toEqual(supplier);
    expect(toErrorEnvelope(error, "req-1", { exposeSupplier: true }).body.error.supplier).toEqual(supplier);
    expect(toErrorEnvelope(error, "req-1", { exposeSupplier: false }).body.error).not.toHaveProperty(
      "supplier",
    );
    expect(toErrorEnvelope(error, "req-1", { exposeSupplier: false }).body.error).not.toHaveProperty(
      "details",
    );
  });

  it("keeps every issue on the cause, and a cause the logger serialises without bodies", () => {
    const error = mapAmadeusError("getFlightOffers", failure);
    const cause = error.cause as AmadeusCallError;

    expect(cause.issues.map((issue) => issue.code)).toEqual([32171, 477]);
    expect(cause).toMatchObject({ httpStatus: 400, outcome: "client_error", errorCodes: [32171, 477] });
    expect(cause.message).toBe("Amadeus getFlightOffers: HTTP 400, codes 32171, 477");
    const logged = JSON.stringify(serializeError(error));
    expect(logged).toContain("AmadeusCallError");
    expect(logged).not.toContain("originLocationCode");
  });

  it("names the socket error of a network failure as the cause's code", () => {
    const cause = mapAmadeusError("listQueue", { kind: "network", code: "ECONNREFUSED" })
      .cause as AmadeusCallError;

    expect(cause).toMatchObject({ code: "ECONNREFUSED", outcome: "network_error", httpStatus: undefined });
    expect(cause.message).toBe("Amadeus listQueue: network error ECONNREFUSED");
  });
});

describe("outcomes and error codes", () => {
  it("classifies each failure for supplier_requests.outcome", () => {
    expect(outcomeOf({ kind: "timeout" })).toBe("timeout");
    expect(outcomeOf({ kind: "network", code: "ECONNRESET" })).toBe("network_error");
    expect(outcomeOf(http(400))).toBe("client_error");
    expect(outcomeOf(http(503))).toBe("server_error");
    expect(outcomeOf({ kind: "http", status: 200, issues: [] })).toBe("server_error");
  });

  it("lists each integer code once, in order", () => {
    expect(
      errorCodesOf([{ code: 4926 }, { code: 32171 }, { code: 4926 }, { title: "no code" }, { code: 1.5 }]),
    ).toEqual([4926, 32171]);
  });
});
