// The console's free-text card check (card-free-text.ts, FIX-W67-KI001): which fields it reads, what it answers, and
// that the list of fields is the whole of the console's staff free text. The second half walks every console
// operation of the OTA document and fails for a string field of a request body (no `enum`, `format`, `const` or
// `pattern`) that is neither checked nor classified below as no free text, so a new free-text field cannot reach the
// document without a decision; it also checks that every listed field exists and that its contract description names
// the refusal. The HTTP path (refused before the idempotency key, the supplier and any row) is in the integration tests
// test/integration/console/{bookings-actions,pnr-import,issue-cancel,payments,raw-amadeus}.int.test.ts named
// `[FIX-W67-KI001 AC5]`. Card numbers here are test data only (Visa's documented test PAN).
import type { OtaOperationId } from "@velexis/api-types/operations";
import { isAppError } from "@velexis/errors";
import { beforeAll, describe, expect, it } from "vitest";
import { OPENAPI_SETUP_TIMEOUT_MS, preloadOpenApiDocument } from "../../../test/helpers/openapi";
import {
  CARD_DATA_CODE,
  CARD_DATA_MESSAGES,
  CARD_FREE_TEXT_FIELDS,
  cardDataErrors,
  refuseCardData,
  type FreeTextInput,
} from "./card-free-text";
import { loadOpenApiDocument, type OpenApiDocument } from "./openapi-validation.interceptor";

const TEST_PAN = "4111 1111 1111 1111";

const bodyOf = (body: unknown): FreeTextInput => ({ body, query: {} });

/** The field errors of a request as `[path, code, message]`. */
function refusals(operationId: string, input: FreeTextInput): Array<[string, string, string]> {
  return cardDataErrors(operationId, input).map((error) => [error.path, error.code, error.message ?? ""]);
}

describe("the card check of a console request", () => {
  it("[FIX-W67-KI001 AC2] refuses a note, a reason or a remark that holds a card number, at its plain body pointer", () => {
    expect(refusals("consoleAddBookingNote", bodyOf({ text: `card ${TEST_PAN}` }))).toEqual([
      ["/text", "card_data", "A note never holds a card number: remove it."],
    ]);
    expect(
      refusals("consoleCancelBooking", bodyOf({ reasonCode: "other", reason: `card ${TEST_PAN}` })),
    ).toEqual([["/reason", "card_data", "A reason never holds a card number: remove it."]]);
    expect(
      refusals("consoleRefundPayment", bodyOf({ reason: "other", reasonNote: `card ${TEST_PAN}` })),
    ).toEqual([["/reasonNote", "card_data", "A reason never holds a card number: remove it."]]);
    expect(
      refusals(
        "consolePatchBooking",
        bodyOf({ remarks: { general: [{ subType: "GENERAL_MISCELLANEOUS", text: `card ${TEST_PAN}` }] } }),
      ),
    ).toEqual([["/remarks/general/0/text", "card_data", "A remark never holds a card number: remove it."]]);
  });

  it("[FIX-W67-KI001 AC2] collects every offending field of the whole request, items included, in one answer", () => {
    const body = {
      travelers: [
        { id: "1", emergencyContact: { text: "Mother" } },
        { id: "2", emergencyContact: { text: `pays with ${TEST_PAN}` } },
      ],
      remarks: {
        general: [{ text: "Window seat." }, { text: `PAN ${TEST_PAN.replaceAll(" ", "")}` }],
        airline: [{ text: `card ${TEST_PAN.replaceAll(" ", "-")}` }],
      },
      automatedProcess: [{ code: "IMMEDIATE", text: `cc ${TEST_PAN}` }],
      reason: `the traveller read out ${TEST_PAN}`,
    };
    expect(refusals("consolePatchBooking", bodyOf(body)).map(([path, code]) => [path, code])).toEqual([
      ["/remarks/general/1/text", "card_data"],
      ["/remarks/airline/0/text", "card_data"],
      ["/automatedProcess/0/text", "card_data"],
      ["/travelers/1/emergencyContact/text", "card_data"],
      ["/reason", "card_data"],
    ]);
    let caught: unknown;
    try {
      refuseCardData("consolePatchBooking", bodyOf(body));
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught) && [caught.code, caught.status, caught.fieldErrors?.length]).toEqual([
      "VALIDATION_FAILED",
      400,
      5,
    ]);
    // Never the value, whole or in part.
    expect(JSON.stringify(caught)).not.toMatch(/4111/);
  });

  it("[FIX-W67-KI001 AC2] reads a query parameter at /query/<name>", () => {
    expect(
      refusals("consoleAmadeusCancelFlightOrder", { body: undefined, query: { reason: `card ${TEST_PAN}` } }),
    ).toEqual([["/query/reason", "card_data", "A reason never holds a card number: remove it."]]);
    expect(
      refusals("consoleAmadeusCancelFlightOrder", { body: { reason: TEST_PAN }, query: { reason: "Void" } }),
    ).toEqual([]);
  });

  it("[FIX-W67-KI001 AC2] passes text without a card number, fields it does not list and operations without free text", () => {
    expect(
      refusals("consoleAddBookingNote", bodyOf({ text: "Called +46 70 123 45 67, ticket 057-2412345678." })),
    ).toEqual([]);
    // Tags, metadata and ids are no free text of this check (see the classification below).
    expect(
      refusals(
        "consolePatchBooking",
        bodyOf({ tags: [TEST_PAN], metadata: { ref: TEST_PAN }, reason: "Fix." }),
      ),
    ).toEqual([]);
    expect(refusals("consoleGetBooking", bodyOf({ text: TEST_PAN }))).toEqual([]);
    // The review closure's note is refuseClosureRequest's, with its outcome rules (review-closure.service.ts).
    expect(refusals("consoleCloseBookingReview", bodyOf({ outcome: "not_booked", note: TEST_PAN }))).toEqual(
      [],
    );
    expect(() => refuseCardData("consoleAddBookingNote", bodyOf({ text: "Rebooked." }))).not.toThrow();
  });

  it("[FIX-W67-KI001 AC2] reads only strings where the list says, and never fails on another shape", () => {
    for (const body of [
      undefined,
      null,
      "text",
      [],
      { text: 4111111111111111 },
      { remarks: { general: { text: TEST_PAN } } },
      { remarks: { general: [null, 7, { text: null }] } },
      { travelers: "x" },
    ]) {
      expect([body, refusals("consolePatchBooking", bodyOf(body))]).toEqual([body, []]);
      expect([body, refusals("consoleAddBookingNote", bodyOf(body))]).toEqual([body, []]);
    }
    // An inherited property is no field of the body.
    const inherited = Object.create({ text: TEST_PAN }) as object;
    expect(refusals("consoleAddBookingNote", bodyOf(inherited))).toEqual([]);
  });

  it("[FIX-W67-KI001 AC2] answers each kind with its own message and the card_data code", () => {
    expect(CARD_DATA_CODE).toBe("card_data");
    expect(CARD_DATA_MESSAGES).toEqual({
      note: "A note never holds a card number: remove it.",
      reason: "A reason never holds a card number: remove it.",
      remark: "A remark never holds a card number: remove it.",
    });
  });
});

// ---- The classification of every console string field -------------------------------------------------------------

/**
 * The console request strings that are no staff free text of the check, by operation (a list or `*` for every console
 * operation) and pointer pattern (`*` one segment, `**` any number of them), with the reason. The report of
 * FIX-W67-KI001 shows this table.
 */
const NOT_FREE_TEXT: ReadonlyArray<{
  readonly operations: readonly string[] | "*";
  readonly pointer: string;
  readonly why: string;
}> = [
  {
    operations: ["consoleSignIn"],
    pointer: "/password",
    why: "a credential: never inspected, logged or echoed",
  },
  {
    operations: ["consoleRefreshSession", "consoleSignOut"],
    pointer: "/refreshToken",
    why: "a credential: never inspected, logged or echoed",
  },
  {
    operations: "*",
    pointer: "/amadeus/**",
    why: "the raw Amadeus request, forwarded verbatim (codes, ids, dates, search criteria, offers); kept only in supplier_requests through the shared redactor",
  },
  {
    operations: ["searchFlightAvailabilities"],
    pointer: "/query/**",
    why: "the Amadeus availability query of flights.availability (codes, ids, times), forwarded to Amadeus (deferred)",
  },
  {
    operations: ["consoleImportBooking"],
    pointer: "/flightOrderId",
    why: "an Amadeus order id",
  },
  {
    operations: ["consoleImportBooking", "consoleCreateBooking", "consolePatchBooking"],
    pointer: "/tags/*",
    why: "a staff tag (a label of at most 40 characters for filters); see the report's questions",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking"],
    pointer: "/metadata/*",
    why: "an OTA key/value for its own systems (ids of a CRM or a back office), where a numeric id would be refused one time in ten; see the report's questions",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking"],
    pointer: "/travelers/*/id",
    why: "an id of the order's traveller",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking"],
    pointer: "/travelers/*/name/*",
    why: "the traveller's name, personal data with a defined meaning, forwarded to Amadeus",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking"],
    pointer: "/travelers/*/documents/*/*",
    why: "a travel document's number and places, masked or dropped by the shared redactor before storage",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking"],
    pointer: "/travelers/*/loyaltyPrograms/*/*",
    why: "a loyalty programme's airline code and number",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking"],
    pointer: "/travelers/*/discountEligibility/*/cityName",
    why: "a city of residence",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking"],
    pointer: "/travelers/*/contact/**",
    why: "the traveller's contact: names, postal address, language, company and e-mail, personal data with a defined meaning",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking"],
    pointer: "/contacts/**",
    why: "an order contact: names, postal address, language, company and e-mail, personal data with a defined meaning",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking"],
    pointer: "/remarks/*/*/travelerIds/*",
    why: "an id of the order's traveller",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking"],
    pointer: "/remarks/*/*/flightOfferIds/*",
    why: "an id of the order's flight offer",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking"],
    pointer: "/remarks/airline/*/keyword",
    why: "an Amadeus keyword code",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking"],
    pointer: "/remarks/airline/*/airlineCode",
    why: "an IATA airline code",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking"],
    pointer: "/ticketingAgreement/**",
    why: "the ticketing agreement's delay (`2D`), date and segment ids",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking"],
    pointer: "/automatedProcess/*/queue/*",
    why: "a queue number and category",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking"],
    pointer: "/automatedProcess/*/delay",
    why: "an Amadeus delay (`1D`)",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking"],
    pointer: "/automatedProcess/*/officeId",
    why: "an Amadeus office id",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking", "consoleIssueBooking"],
    pointer: "/formOfPayments/**",
    why: "a form of payment's structured fields (wallet ids, reporting data, a card's holder, expiry and 3-D Secure values, amounts); a creditCard answers 403 FEATURE_DISABLED in the console and the shared redactor drops or masks card fields",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking"],
    pointer: "/commissions/**",
    why: "a commission's amounts and the ids of the travellers and segments it applies to",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking"],
    pointer: "/formOfIdentifications/**",
    why: "an identification's carrier code, number (a ticket or booking number) and ids",
  },
  {
    operations: ["consolePatchBooking"],
    pointer: "/associatedRecords/**",
    why: "an associated record's locator, date, origin system code and offer id",
  },
  {
    operations: ["consolePatchBooking"],
    pointer: "/tickets/**",
    why: "a ticket's document number (13 digits that the card check would refuse one time in ten for an airline code from 2 to 6) and ids",
  },
  {
    operations: ["consolePatchBooking"],
    pointer: "/flightOffers/**",
    why: "a partial Amadeus flight offer (ids, codes, prices, fare rules) that adds services",
  },
  {
    operations: [
      "consoleCreateMarkupRule",
      "consoleUpdateMarkupRule",
      "consoleCreateFeeRule",
      "consoleUpdateFeeRule",
    ],
    pointer: "/*",
    why: "a pricing rule's name, label or description: settings content about the OTA's prices, not a traveller; see the report's questions",
  },
  {
    operations: ["consoleUpdateStorefrontSettings"],
    pointer: "/**",
    why: "storefront settings shown to every visitor (brand, markets, legal and consent texts, support hours, SEO); see the report's questions",
  },
  {
    operations: ["consoleCreateStorefrontPage", "consoleUpdateStorefrontPage"],
    pointer: "/*",
    why: "a public storefront page's title and Markdown body; see the report's questions",
  },
  {
    operations: ["consolePutNotificationTemplate", "consolePreviewNotificationTemplate"],
    pointer: "/*",
    why: "an e-mail template's subject and bodies with their placeholders; see the report's questions",
  },
];

/** The fields checked outside CARD_FREE_TEXT_FIELDS, with where. */
const CHECKED_ELSEWHERE: ReadonlyArray<{ readonly operation: string; readonly pointer: string }> = [
  { operation: "consoleCloseBookingReview", pointer: "/note" },
];

/** Whether `pointer` (concrete segments or `*`) matches `pattern` (`*` one segment, `**` any number). */
function matches(pattern: string, pointer: string): boolean {
  const want = pattern.split("/").slice(1);
  const have = pointer.split("/").slice(1);
  const walk = (i: number, j: number): boolean => {
    if (i === want.length) {
      return j === have.length;
    }
    if (want[i] === "**") {
      return walk(i + 1, j) || (j < have.length && walk(i, j + 1));
    }
    return j < have.length && (want[i] === "*" || want[i] === have[j]) && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A string field of a request body, with the descriptions of the properties on its path. */
interface StringField {
  readonly pointer: string;
  readonly descriptions: readonly string[];
}

/** Every unconstrained string of `schema` (`*` for an array item or a map value), following `$ref`s and the combiners. */
function stringFields(document: OpenApiDocument, schema: unknown): StringField[] {
  const found = new Map<string, string[]>();
  const visit = (node: unknown, pointer: string, descriptions: string[], refs: readonly string[]): void => {
    if (!isObject(node)) {
      return;
    }
    const own = typeof node["description"] === "string" ? [node["description"]] : [];
    const ref = typeof node["$ref"] === "string" ? node["$ref"] : undefined;
    if (ref !== undefined && refs.includes(ref)) {
      return;
    }
    const resolved = document.resolve(node);
    if (!isObject(resolved)) {
      return;
    }
    const nextRefs = ref === undefined ? refs : [...refs, ref];
    const here = [...descriptions, ...own];
    for (const combiner of ["allOf", "oneOf", "anyOf"]) {
      const list = resolved[combiner];
      if (Array.isArray(list)) {
        list.forEach((item) => visit(item, pointer, here, nextRefs));
      }
    }
    const types = Array.isArray(resolved["type"]) ? resolved["type"] : [resolved["type"]];
    const constrained = ["enum", "format", "const", "pattern"].some(
      (keyword) => resolved[keyword] !== undefined,
    );
    if (types.includes("string") && !constrained) {
      found.set(pointer, [...(found.get(pointer) ?? []), ...here]);
    }
    if (isObject(resolved["properties"])) {
      for (const [name, child] of Object.entries(resolved["properties"])) {
        visit(child, `${pointer}/${name}`, here, nextRefs);
      }
    }
    if (isObject(resolved["additionalProperties"])) {
      visit(resolved["additionalProperties"], `${pointer}/*`, here, nextRefs);
    }
    if (resolved["items"] !== undefined) {
      visit(resolved["items"], `${pointer}/*`, here, nextRefs);
    }
  };
  visit(schema, "", [], []);
  return [...found.entries()].map(([pointer, descriptions]) => ({ pointer, descriptions }));
}

/** The description of the query parameter `/query/<name>` of the operation at `path` and `method`; "" without one. */
function queryParameterDescription(
  document: OpenApiDocument,
  path: string,
  method: string,
  pointer: string,
): string {
  const paths = document.document["paths"];
  const item = isObject(paths) ? paths[path] : undefined;
  const operation = isObject(item) ? item[method] : undefined;
  const parameters =
    isObject(operation) && Array.isArray(operation["parameters"]) ? operation["parameters"] : [];
  for (const raw of parameters) {
    const parameter = document.resolve(raw);
    if (
      isObject(parameter) &&
      parameter["in"] === "query" &&
      `/query/${String(parameter["name"])}` === pointer
    ) {
      return typeof parameter["description"] === "string" ? parameter["description"] : "";
    }
  }
  return "";
}

describe("the free-text fields of the console operations", () => {
  let document: OpenApiDocument;
  let consoleOperations: ReadonlyArray<{ readonly operationId: string; readonly fields: StringField[] }>;

  // The OTA document's parse and compile, and one walk of every console request schema, done once (budget of
  // test/helpers/openapi.ts; the walk itself takes milliseconds).
  beforeAll(() => {
    preloadOpenApiDocument();
    document = loadOpenApiDocument();
    consoleOperations = document
      .operationList()
      .filter((operation) => operation.scope === "console")
      .map((operation) => ({
        operationId: operation.operationId,
        // The descriptions of the body's own schema are left out: each field's description must say it.
        fields:
          operation.body === undefined ? [] : stringFields(document, document.resolve(operation.body.schema)),
      }));
  }, OPENAPI_SETUP_TIMEOUT_MS);

  it("[FIX-W67-KI001 AC2] classifies every string of a console request body: checked, checked elsewhere or no free text", () => {
    expect(consoleOperations.length).toBeGreaterThan(50);
    const unclassified: string[] = [];
    for (const { operationId, fields } of consoleOperations) {
      const listed = CARD_FREE_TEXT_FIELDS[operationId as OtaOperationId] ?? [];
      for (const { pointer } of fields) {
        const checked =
          listed.some((field) => field.pointer === pointer) ||
          CHECKED_ELSEWHERE.some((entry) => entry.operation === operationId && entry.pointer === pointer);
        const exempt = NOT_FREE_TEXT.some(
          (entry) =>
            (entry.operations === "*" || entry.operations.includes(operationId)) &&
            matches(entry.pointer, pointer),
        );
        if (checked === exempt) {
          unclassified.push(`${operationId} ${pointer} (${checked ? "checked and exempt" : "neither"})`);
        }
      }
    }
    expect(unclassified).toEqual([]);
  });

  it("[FIX-W67-KI001 AC2] lists only console operations and fields that the document has, as unconstrained strings", () => {
    const missing: string[] = [];
    for (const [operationId, listed] of Object.entries(CARD_FREE_TEXT_FIELDS)) {
      const operation = document.operation(operationId);
      expect([operationId, operation.scope]).toEqual([operationId, "console"]);
      const fields = consoleOperations.find((entry) => entry.operationId === operationId)?.fields ?? [];
      for (const field of listed ?? []) {
        if (field.pointer.startsWith("/query/")) {
          const name = field.pointer.slice("/query/".length);
          const parameter = operation.parameters.find((entry) => entry.in === "query" && entry.name === name);
          const schema = document.resolve(parameter?.schema);
          if (!isObject(schema) || schema["type"] !== "string" || schema["pattern"] !== undefined) {
            missing.push(`${operationId} ${field.pointer}`);
          }
        } else if (!fields.some((entry) => entry.pointer === field.pointer)) {
          missing.push(`${operationId} ${field.pointer}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("[FIX-W67-KI001 AC4] says in each listed field's contract description that a card number answers card_data", () => {
    const undocumented: string[] = [];
    for (const [operationId, listed] of Object.entries(CARD_FREE_TEXT_FIELDS)) {
      const operation = document.operation(operationId);
      const fields = consoleOperations.find((entry) => entry.operationId === operationId)?.fields ?? [];
      for (const field of listed ?? []) {
        const descriptions = field.pointer.startsWith("/query/")
          ? [queryParameterDescription(document, operation.path, operation.method, field.pointer)]
          : (fields.find((entry) => entry.pointer === field.pointer)?.descriptions ?? []);
        if (!descriptions.some((text) => text.includes("`card_data`"))) {
          undocumented.push(`${operationId} ${field.pointer}`);
        }
      }
    }
    expect(undocumented).toEqual([]);
    // The review closure's note says it too.
    const closure = consoleOperations.find((entry) => entry.operationId === "consoleCloseBookingReview");
    expect(
      closure?.fields
        .find((entry) => entry.pointer === "/note")
        ?.descriptions.some((text) => text.includes("`card_data`")),
    ).toBe(true);
  });
});
