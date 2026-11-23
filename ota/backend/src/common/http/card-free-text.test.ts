// The free-text card check (card-free-text.ts, FIX-W67-KI001 and FIX-W68-CARDTEXT): which fields it reads, what it
// answers, and that the list of fields is the whole of the free text the OTA stores or forwards. The second half walks
// every console, customer and both-scope operation of the OTA document (request bodies and query parameters) and fails
// for a string field (no `enum`, `format` or `const`, and no `pattern` that refuses every string holding a card
// number) that is neither checked nor classified below as no free text, so a new free-text field cannot reach the
// document without a decision; it also checks that every listed field exists and that its contract description names
// the refusal with the detector's rule. The HTTP path (refused before the idempotency key, the supplier and any row) is
// in the integration tests test/integration/console/{bookings-actions,pnr-import,issue-cancel,payments,raw-amadeus}
// .int.test.ts named `[FIX-W67-KI001 AC5]` and test/integration/{bookings/cancel,checkout/checkout,console/pnr-import,
// settings/pricing-rules}.int.test.ts named `[FIX-W68-CARDTEXT AC6]`. Card numbers here are test data only (Visa's
// documented test PAN).
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
import {
  loadOpenApiDocument,
  type OpenApiDocument,
  type OperationSpec,
} from "./openapi-validation.interceptor";

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
    // Metadata and ids are no free text of this check (see the classification below); tags are, since
    // FIX-W68-CARDTEXT (lead decision (37c)).
    expect(refusals("consolePatchBooking", bodyOf({ metadata: { ref: TEST_PAN }, reason: "Fix." }))).toEqual(
      [],
    );
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
      comment: "A comment never holds a card number: remove it.",
      emergencyContact: "An emergency contact's text never holds a card number: remove it.",
      tag: "A tag never holds a card number: remove it.",
      label: "A label never holds a card number: remove it.",
    });
  });
});

describe("the card check of a customer request (FIX-W68-CARDTEXT, lead decision (37c))", () => {
  it("[FIX-W68-CARDTEXT AC1] refuses a cancellation comment, a special request and an emergency contact's text, at the plain body pointer", () => {
    expect(
      refusals("cancelBooking", bodyOf({ reasonCode: "other", comment: `Refund to ${TEST_PAN}` })),
    ).toEqual([["/comment", "card_data", "A comment never holds a card number: remove it."]]);
    expect(
      refusals(
        "setCheckoutRemarks",
        bodyOf({ remarks: [{ text: "Window seat" }, { text: `PAY WITH ${TEST_PAN}` }] }),
      ),
    ).toEqual([["/remarks/1/text", "card_data", "A remark never holds a card number: remove it."]]);
    for (const operationId of ["setCheckoutTravelers", "priceFlightOffers"]) {
      expect([
        operationId,
        refusals(
          operationId,
          bodyOf({
            travelers: [
              { travelerId: "1", emergencyContact: { addresseeName: "Erik Berg", text: "Husband" } },
              { travelerId: "2", emergencyContact: { text: `card ${TEST_PAN.replaceAll(" ", "")}` } },
            ],
          }),
        ),
      ]).toEqual([
        operationId,
        [
          [
            "/travelers/1/emergencyContact/text",
            "card_data",
            "An emergency contact's text never holds a card number: remove it.",
          ],
        ],
      ]);
    }
  });

  it("[FIX-W68-CARDTEXT AC1] collects the remarks and emergency contacts of bookings.update, and a saved traveller's label and emergency contact", () => {
    expect(
      refusals(
        "updateBooking",
        bodyOf({
          remarks: [{ text: `PAN ${TEST_PAN.replaceAll(" ", "-")}` }],
          travelers: [{ travelerId: "1", emergencyContact: { text: `card ${TEST_PAN}` } }],
        }),
      ).map(([path, code]) => [path, code]),
    ).toEqual([
      ["/remarks/0/text", "card_data"],
      ["/travelers/0/emergencyContact/text", "card_data"],
    ]);
    for (const operationId of ["createSavedTraveler", "updateSavedTraveler"]) {
      expect([
        operationId,
        refusals(
          operationId,
          bodyOf({ label: `Visa ${TEST_PAN}`, emergencyContact: { text: `card ${TEST_PAN}` } }),
        ),
      ]).toEqual([
        operationId,
        [
          ["/label", "card_data", "A label never holds a card number: remove it."],
          [
            "/emergencyContact/text",
            "card_data",
            "An emergency contact's text never holds a card number: remove it.",
          ],
        ],
      ]);
    }
    // A cleared label or emergency contact (null) is no text.
    expect(refusals("updateSavedTraveler", bodyOf({ label: null, emergencyContact: null }))).toEqual([]);
  });

  it("[FIX-W68-CARDTEXT AC1] passes customer text without a card number, and text the OTA never keeps or that has a defined meaning", () => {
    expect(
      refusals(
        "setCheckoutRemarks",
        bodyOf({ remarks: [{ text: "WHEELCHAIR AT GATE 12, FLIGHT IB3436 ON 2026-12-01" }] }),
      ),
    ).toEqual([]);
    expect(
      refusals("cancelBooking", bodyOf({ reasonCode: "other", comment: "Call +46 70 123 45 67" })),
    ).toEqual([]);
    // A lookup's last name is never stored and metadata is never free text (the account deletion's comment, never kept
    // either, is checked since lead decision (38b): see the next test).
    expect(refusals("lookupBooking", bodyOf({ reference: "ABC123", lastName: TEST_PAN }))).toEqual([]);
    expect(refusals("createCheckout", bodyOf({ metadata: { crm: TEST_PAN } }))).toEqual([]);
  });

  it("[FIX-W70-API AC5] refuses a card number in an account deletion's comment, which the idempotency record's request hash covers (lead decision (38b))", () => {
    expect(
      refusals("deleteAccount", bodyOf({ reason: "other", comment: `My card ${TEST_PAN} is closed` })),
    ).toEqual([["/comment", "card_data", "A comment never holds a card number: remove it."]]);
    expect(
      refusals("deleteAccount", bodyOf({ comment: TEST_PAN.replaceAll(" ", "-") })).map(([path]) => path),
    ).toEqual(["/comment"]);
    // A comment without one, or no comment at all, passes; the password is a credential and never inspected.
    expect(
      refusals("deleteAccount", bodyOf({ reason: "other", comment: "Moving to another agency" })),
    ).toEqual([]);
    expect(refusals("deleteAccount", bodyOf({ currentPassword: TEST_PAN.replaceAll(" ", "") }))).toEqual([]);
    let caught: unknown;
    try {
      refuseCardData("deleteAccount", bodyOf({ reason: "other", comment: `card ${TEST_PAN}` }));
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught) && [caught.code, caught.status]).toEqual(["VALIDATION_FAILED", 400]);
    expect(JSON.stringify(caught)).not.toMatch(/4111/);
  });

  it("[FIX-W68-CARDTEXT AC1] refuses a customer request as a 400 VALIDATION_FAILED that never repeats the value", () => {
    let caught: unknown;
    try {
      refuseCardData("cancelBooking", bodyOf({ reasonCode: "other", comment: `card ${TEST_PAN}` }));
    } catch (error) {
      caught = error;
    }
    expect(isAppError(caught) && [caught.code, caught.status, caught.fieldErrors]).toEqual([
      "VALIDATION_FAILED",
      400,
      [{ path: "/comment", code: "card_data", message: "A comment never holds a card number: remove it." }],
    ]);
    expect(JSON.stringify(caught)).not.toMatch(/4111/);
  });
});

describe("the card check of the console's tags and markup notes (FIX-W68-CARDTEXT, lead decision (37c))", () => {
  it("[FIX-W68-CARDTEXT AC2] refuses a tag of an import, a created or a patched booking at its item's pointer", () => {
    for (const operationId of ["consoleImportBooking", "consoleCreateBooking", "consolePatchBooking"]) {
      expect([operationId, refusals(operationId, bodyOf({ tags: ["vip", TEST_PAN] }))]).toEqual([
        operationId,
        [["/tags/1", "card_data", "A tag never holds a card number: remove it."]],
      ]);
    }
    expect(refusals("consolePatchBooking", bodyOf({ tags: ["vip", "group-2026"] }))).toEqual([]);
  });

  it("[FIX-W68-CARDTEXT AC2] refuses a markup rule's notes for staff, never its name or a fee rule's name and label", () => {
    for (const operationId of ["consoleCreateMarkupRule", "consoleUpdateMarkupRule"]) {
      expect([
        operationId,
        refusals(operationId, bodyOf({ name: "Ten percent", description: `Paid by ${TEST_PAN}` })),
      ]).toEqual([
        operationId,
        [["/description", "card_data", "A note never holds a card number: remove it."]],
      ]);
    }
    // Settings content (lead decision (37c)): rule names and labels stay unchecked.
    expect(refusals("consoleCreateMarkupRule", bodyOf({ name: TEST_PAN }))).toEqual([]);
    expect(refusals("consoleCreateFeeRule", bodyOf({ name: TEST_PAN, label: TEST_PAN }))).toEqual([]);
  });
});

// ---- The classification of every non-internal string field -------------------------------------------------------

/** The operations that carry a list of travellers whose items share the console's AmadeusTraveler classification. */
const TRAVELER_LISTS = [
  "consoleCreateBooking",
  "consolePatchBooking",
  "priceFlightOffers",
  "setCheckoutTravelers",
  "updateBooking",
] as const;
/** The saved-traveller operations (deferred), whose body is one traveller. */
const SAVED_TRAVELER = ["createSavedTraveler", "updateSavedTraveler"] as const;
/** A credential: never inspected, logged or echoed. */
const CREDENTIAL = "a credential: never inspected, logged or echoed";

/**
 * The request strings of the console, customer and both-scope operations that are no free text of the check, by
 * operation (a list or `*` for every one) and pointer pattern (`*` one segment, `**` any number of them; `/query/<name>`
 * is a query parameter, except under createFlightSearch, whose body has a `query` member), with the reason. The reports
 * of FIX-W67-KI001 and FIX-W68-CARDTEXT show this table.
 */
const NOT_FREE_TEXT: ReadonlyArray<{
  readonly operations: readonly string[] | "*";
  readonly pointer: string;
  readonly why: string;
}> = [
  // ---- Every operation
  { operations: "*", pointer: "/query/cursor", why: "an opaque page cursor the API issued" },
  {
    operations: "*",
    pointer: "/**/amount",
    why: "a Money amount: a decimal string of the `^-?[0-9]+(\\.[0-9]{1,4})?$` kind, never text",
  },
  // ---- Customer accounts (OBE-035) and their saved travellers (deferred)
  { operations: ["signUp", "signIn"], pointer: "/password", why: CREDENTIAL },
  { operations: ["resetPassword", "changePassword"], pointer: "/newPassword", why: CREDENTIAL },
  {
    operations: ["changePassword", "updateAccount", "deleteAccount"],
    pointer: "/currentPassword",
    why: CREDENTIAL,
  },
  {
    operations: ["signUp", "updateAccount"],
    pointer: "/firstName",
    why: "the account holder's name, personal data with a defined meaning",
  },
  {
    operations: ["signUp", "updateAccount"],
    pointer: "/lastName",
    why: "the account holder's name, personal data with a defined meaning",
  },
  { operations: ["signUp"], pointer: "/termsVersion", why: "the version of the terms the customer accepted" },
  {
    operations: ["updateAccount"],
    pointer: "/phone/number",
    why: "the account holder's phone number (digits), personal data with a defined meaning",
  },
  {
    operations: [...SAVED_TRAVELER],
    pointer: "/documents/*/*",
    why: "a travel document's number and places, personal data with a defined meaning (the number encrypted at rest)",
  },
  {
    operations: [...SAVED_TRAVELER],
    pointer: "/loyaltyPrograms/*/*",
    why: "a loyalty programme's airline code and number",
  },
  {
    operations: [...SAVED_TRAVELER],
    pointer: "/discountEligibility/*/*",
    why: "a discount eligibility's city, resident card number and certificate number, personal data with a defined meaning (a residence document, not a payment card; Amadeus' unanchored pattern does not constrain it): the shared redactor keeps the last 4 of both numbers in stored payloads",
  },
  {
    operations: [...SAVED_TRAVELER],
    pointer: "/contact/**",
    why: "the traveller's contact: names, postal address, language, company, e-mail and phones, personal data with a defined meaning",
  },
  {
    operations: [...SAVED_TRAVELER],
    pointer: "/emergencyContact/addresseeName",
    why: "the emergency contact's name, personal data with a defined meaning",
  },
  {
    operations: [...SAVED_TRAVELER],
    pointer: "/emergencyContact/countryCode",
    why: "the emergency contact's country code",
  },
  {
    operations: [...SAVED_TRAVELER],
    pointer: "/emergencyContact/number",
    why: "the emergency contact's phone number (digits), personal data with a defined meaning",
  },
  // ---- Storefront, reference data, flights, files and guest lookups
  {
    operations: ["resolveStorefrontHost"],
    pointer: "/query/host",
    why: "the host name of a visitor's request (deferred)",
  },
  {
    operations: ["searchLocations"],
    pointer: "/query/keyword",
    why: "a location search prefix, matched against the shared reference tables; never stored, forwarded or logged (query strings are never logged)",
  },
  {
    operations: ["createFlightSearch"],
    pointer: "/query/**",
    why: "the flight search criteria of the body's `query` (codes, ids, times, loyalty and corporate codes), forwarded to Amadeus Flight Offers Search",
  },
  {
    operations: ["searchFlightAvailabilities"],
    pointer: "/query/**",
    why: "the Amadeus availability query of flights.availability (codes, ids, times), forwarded to Amadeus (deferred)",
  },
  {
    operations: ["listFlightSearchResults"],
    pointer: "/query/minPrice",
    why: "a price filter: a decimal string, never stored",
  },
  {
    operations: ["listFlightSearchResults"],
    pointer: "/query/maxPrice",
    why: "a price filter: a decimal string, never stored",
  },
  {
    operations: ["listFlightSearchResults"],
    pointer: "/query/brandedFares",
    why: "branded fare codes to filter by (codes of the brandedFares facet), never stored",
  },
  {
    operations: ["priceFlightOffers"],
    pointer: "/amadeusFlightOffers/**",
    why: "Amadeus flight offers sent back verbatim for Flight Offers Price (supplier data: ids, codes, prices, fare rules)",
  },
  {
    operations: ["priceFlightOffers"],
    pointer: "/additionalServices/**",
    why: "the ids of the traveller and segments of an additional service",
  },
  {
    operations: ["setCheckoutAncillaries"],
    pointer: "/selections/**",
    why: "the ids of the traveller and segments of an ancillary selection",
  },
  { operations: ["downloadFile"], pointer: "/query/sig", why: "the signature of a signed file URL" },
  {
    operations: ["lookupBooking"],
    pointer: "/lastName",
    why: "a traveller's last name that finds a booking with its reference, compared and never stored",
  },
  {
    operations: ["completeCheckoutWithAirlineCard"],
    pointer: "/card/number",
    why: "the card number itself on the airline-card path: held in memory for one request and never stored, logged or queued (OADR-0004)",
  },
  // ---- Console credentials, lists and raw Amadeus calls
  { operations: ["consoleSignIn"], pointer: "/password", why: CREDENTIAL },
  { operations: ["consoleRefreshSession", "consoleSignOut"], pointer: "/refreshToken", why: CREDENTIAL },
  {
    operations: "*",
    pointer: "/amadeus/**",
    why: "the raw Amadeus request, forwarded verbatim (codes, ids, dates, search criteria, offers); kept only in supplier_requests through the shared redactor",
  },
  {
    operations: ["consoleListBookings"],
    pointer: "/query/q",
    why: "a search filter, matched against the tenant's rows; never stored, forwarded or logged",
  },
  {
    operations: ["consoleListBookings"],
    pointer: "/query/travelerLastName",
    why: "a search filter, matched against the tenant's rows; never stored, forwarded or logged",
  },
  {
    operations: ["consoleListBookings"],
    pointer: "/query/tag",
    why: "a search filter, matched against the tenant's rows; never stored, forwarded or logged",
  },
  {
    operations: ["consoleListCustomers"],
    pointer: "/query/q",
    why: "a search filter, matched against the tenant's rows; never stored, forwarded or logged",
  },
  {
    operations: ["consoleListSupplierRequests"],
    pointer: "/query/*",
    why: "an id filter (Amadeus operation id, request id, correlation id)",
  },
  // ---- Bookings: the order's elements (console create and patch; customer pricing, checkout and update)
  {
    operations: ["consoleImportBooking"],
    pointer: "/flightOrderId",
    why: "an Amadeus order id",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking", "createCheckout"],
    pointer: "/metadata/*",
    why: "an OTA key/value for its own systems (ids of a CRM or a back office), where a numeric id would be refused one time in ten; the contract says metadata never holds card data (lead decision (37c))",
  },
  {
    operations: [...TRAVELER_LISTS],
    pointer: "/travelers/*/id",
    why: "an id of the order's traveller",
  },
  {
    operations: [...TRAVELER_LISTS],
    pointer: "/travelers/*/name/*",
    why: "the traveller's name, personal data with a defined meaning, forwarded to Amadeus",
  },
  {
    operations: [...TRAVELER_LISTS],
    pointer: "/travelers/*/documents/*/*",
    why: "a travel document's number and places, masked or dropped by the shared redactor before storage (encrypted at rest in a checkout)",
  },
  {
    operations: [...TRAVELER_LISTS],
    pointer: "/travelers/*/loyaltyPrograms/*/*",
    why: "a loyalty programme's airline code and number",
  },
  {
    operations: [...TRAVELER_LISTS],
    pointer: "/travelers/*/discountEligibility/*/*",
    why: "a discount eligibility's city, resident card number and certificate number, personal data with a defined meaning (a residence document, not a payment card; Amadeus' unanchored pattern does not constrain it): the shared redactor keeps the last 4 of both numbers in stored payloads (encrypted at rest in a checkout)",
  },
  {
    operations: [...TRAVELER_LISTS],
    pointer: "/travelers/*/contact/**",
    why: "the traveller's contact: names, postal address, language, company, e-mail and phones, personal data with a defined meaning",
  },
  {
    operations: [...TRAVELER_LISTS],
    pointer: "/travelers/*/emergencyContact/addresseeName",
    why: "the emergency contact's name, personal data with a defined meaning",
  },
  {
    operations: [...TRAVELER_LISTS],
    pointer: "/travelers/*/emergencyContact/countryCode",
    why: "the emergency contact's country code",
  },
  {
    operations: [...TRAVELER_LISTS],
    pointer: "/travelers/*/emergencyContact/number",
    why: "the emergency contact's phone number (digits), personal data with a defined meaning",
  },
  {
    operations: ["consoleCreateBooking", "consolePatchBooking", "setCheckoutContacts", "updateBooking"],
    pointer: "/contacts/**",
    why: "an order contact: names, postal address, language, company, e-mail and phones, personal data with a defined meaning",
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
    pointer: "/remarks/general/*/category",
    why: "an Amadeus remark category letter",
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
  // ---- Console settings: content shown to travellers or used by the OTA (lead decision (37c))
  {
    operations: ["consoleCreateMarkupRule", "consoleUpdateMarkupRule"],
    pointer: "/name",
    why: "a markup rule's name shown in the OTA admin: settings content about the OTA's prices, not a traveller (lead decision (37c))",
  },
  {
    operations: ["consoleCreateFeeRule", "consoleUpdateFeeRule"],
    pointer: "/name",
    why: "a fee rule's internal name: settings content about the OTA's prices, not a traveller (lead decision (37c))",
  },
  {
    operations: ["consoleCreateFeeRule", "consoleUpdateFeeRule"],
    pointer: "/label",
    why: "a fee rule's label shown in every price breakdown: public settings content (lead decision (37c))",
  },
  {
    operations: ["consoleUpdateStorefrontSettings"],
    pointer: "/**",
    why: "storefront settings shown to every visitor (brand, markets, legal and consent texts, support hours, SEO): public settings content (lead decision (37c))",
  },
  {
    operations: ["consoleCreateStorefrontPage", "consoleUpdateStorefrontPage"],
    pointer: "/*",
    why: "a public storefront page's title and Markdown body: public settings content (lead decision (37c))",
  },
  {
    operations: ["consolePutNotificationTemplate", "consolePreviewNotificationTemplate"],
    pointer: "/*",
    why: "an e-mail template's subject and bodies with their placeholders: settings content (lead decision (37c))",
  },
];

/** The fields checked outside CARD_FREE_TEXT_FIELDS, with where. */
const CHECKED_ELSEWHERE: ReadonlyArray<{ readonly operation: string; readonly pointer: string }> = [
  { operation: "consoleCloseBookingReview", pointer: "/note" },
];

/**
 * Strings that hold a card number (a bare run of every length the detector reads, 12 to 19 digits, and Visa's test PAN
 * grouped by spaces and by dashes), alone and after or before a letter, a word, a plus sign or a zero. A `pattern` that
 * matches one of them admits a card number, so it does not exempt its field from the classification (setCheckoutRemarks'
 * `^[A-Za-z0-9 .,'()/:?+-]+$` matches them, and so would `^[0-9]{13}$`; a date's, an id's or a three-letter code's
 * matches none).
 */
const CARD_NUMBER_SAMPLES: readonly string[] = [
  ...Array.from({ length: 8 }, (_, extra) => `4${"1".repeat(11 + extra)}`),
  "4111 1111 1111 1111",
  "4111-1111-1111-1111",
].flatMap((card) =>
  ["", "+", "0", "A", "AB", "a "].flatMap((before) =>
    ["", "A", " a"].map((after) => `${before}${card}${after}`),
  ),
);

/** Whether a JSON Schema `pattern` (ECMAScript, Unicode, unanchored) matches a string that holds a card number. */
const patternAdmitsCardNumber = (pattern: string): boolean =>
  CARD_NUMBER_SAMPLES.some((sample) => new RegExp(pattern, "u").test(sample));

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

/**
 * Whether a string schema could hold free text: no `enum`, `format` or `const`, and no `pattern` that refuses every
 * string holding a card number.
 */
const unconstrained = (schema: Json): boolean =>
  !["enum", "format", "const"].some((keyword) => schema[keyword] !== undefined) &&
  (typeof schema["pattern"] !== "string" || patternAdmitsCardNumber(schema["pattern"]));

/** A string field of a request, with the descriptions of the properties on its path. */
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
    if (types.includes("string") && unconstrained(resolved)) {
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

/**
 * The unconstrained string query parameters of an operation (a string, or an array of strings), as `/query/<name>` with
 * the parameter's description.
 */
function queryFields(document: OpenApiDocument, operation: OperationSpec): StringField[] {
  const fields: StringField[] = [];
  for (const parameter of operation.parameters) {
    const schema = document.resolve(parameter.schema);
    if (parameter.in !== "query" || !isObject(schema)) {
      continue;
    }
    const items = document.resolve(schema["items"]);
    const text =
      (schema["type"] === "string" && unconstrained(schema)) ||
      (schema["type"] === "array" && isObject(items) && items["type"] === "string" && unconstrained(items));
    if (text) {
      fields.push({
        pointer: `/query/${parameter.name}`,
        descriptions: [queryParameterDescription(document, operation.path, operation.method, parameter.name)],
      });
    }
  }
  return fields;
}

/** The description of the query parameter `name` of the operation at `path` and `method`; "" without one. */
function queryParameterDescription(
  document: OpenApiDocument,
  path: string,
  method: string,
  name: string,
): string {
  const paths = document.document["paths"];
  const item = isObject(paths) ? paths[path] : undefined;
  const operation = isObject(item) ? item[method] : undefined;
  const parameters = [
    ...(isObject(item) && Array.isArray(item["parameters"]) ? item["parameters"] : []),
    ...(isObject(operation) && Array.isArray(operation["parameters"]) ? operation["parameters"] : []),
  ];
  let description = "";
  for (const raw of parameters) {
    const parameter = document.resolve(raw);
    if (isObject(parameter) && parameter["in"] === "query" && parameter["name"] === name) {
      description = typeof parameter["description"] === "string" ? parameter["description"] : "";
    }
  }
  return description;
}

/** The detector's rule as every `card_data` description of the document states it (lead decision (37c)). */
const DETECTOR_RULE = "12 to 19 digits that start with 2 to 6 and pass the Luhn check";

describe("the free-text fields of the console, customer and both-scope operations", () => {
  let document: OpenApiDocument;
  let operations: ReadonlyArray<{
    readonly operationId: string;
    readonly scope: string;
    readonly body: StringField[];
    readonly query: StringField[];
  }>;

  // The OTA document's parse and compile, and one walk of every non-internal request schema, done once (budget of
  // test/helpers/openapi.ts; the walk itself takes milliseconds).
  beforeAll(() => {
    preloadOpenApiDocument();
    document = loadOpenApiDocument();
    operations = document
      .operationList()
      .filter((operation) => operation.scope !== null)
      .map((operation) => ({
        operationId: operation.operationId,
        scope: operation.scope ?? "",
        // The descriptions of the body's own schema are left out: each field's description must say it.
        body:
          operation.body === undefined ? [] : stringFields(document, document.resolve(operation.body.schema)),
        query: queryFields(document, operation),
      }));
  }, OPENAPI_SETUP_TIMEOUT_MS);

  /** The listed field of an operation that answers `pointer`, from its body or its query parameters. */
  const fieldOf = (operationId: string, pointer: string): StringField | undefined => {
    const operation = operations.find((entry) => entry.operationId === operationId);
    return pointer.startsWith("/query/") && operationId !== "createFlightSearch"
      ? operation?.query.find((entry) => entry.pointer === pointer)
      : operation?.body.find((entry) => entry.pointer === pointer);
  };

  it("[FIX-W68-CARDTEXT AC1] walks every console, customer and both-scope operation, and no internal one", () => {
    const scopes = new Set(operations.map((operation) => operation.scope));
    expect([...scopes].sort()).toEqual(["both", "console", "customer"]);
    expect(operations.filter((operation) => operation.scope === "console").length).toBeGreaterThan(50);
    expect(operations.filter((operation) => operation.scope !== "console").length).toBeGreaterThan(60);
    // The internal operations (Stripe and platform webhooks, health) are no caller's free text.
    expect(document.operationList().filter((operation) => operation.scope === null).length).toBeGreaterThan(
      0,
    );
    // setCheckoutRemarks' `pattern` admits a card number, so its text is walked; a date-time's pattern is not.
    expect(fieldOf("setCheckoutRemarks", "/remarks/*/text")).toBeDefined();
    expect(patternAdmitsCardNumber("^[A-Za-z0-9 .,'()/:?+-]+$")).toBe(true);
    // Every length of a card number counts, not only a 12- or a 16-digit one.
    expect(patternAdmitsCardNumber("^[0-9]{13}$")).toBe(true);
    expect(patternAdmitsCardNumber("^[A-Z][0-9]{19}$")).toBe(true);
    expect(patternAdmitsCardNumber("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")).toBe(false);
    expect(patternAdmitsCardNumber("^[A-Z]{3}$")).toBe(false);
  });

  it("[FIX-W67-KI001 AC2] [FIX-W68-CARDTEXT AC1] classifies every request string: checked, checked elsewhere or no free text", () => {
    const unclassified: string[] = [];
    for (const { operationId, body, query } of operations) {
      const listed = CARD_FREE_TEXT_FIELDS[operationId as OtaOperationId] ?? [];
      for (const { pointer } of [...body, ...query]) {
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

  it("[FIX-W67-KI001 AC2] [FIX-W68-CARDTEXT AC1] lists only non-internal operations and fields that the document has, as unconstrained strings", () => {
    const missing: string[] = [];
    for (const [operationId, listed] of Object.entries(CARD_FREE_TEXT_FIELDS)) {
      const operation = document.operation(operationId);
      expect([operationId, ["console", "customer", "both"].includes(operation.scope ?? "")]).toEqual([
        operationId,
        true,
      ]);
      for (const field of listed ?? []) {
        if (fieldOf(operationId, field.pointer) === undefined) {
          missing.push(`${operationId} ${field.pointer}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("[FIX-W67-KI001 AC4] [FIX-W68-CARDTEXT AC5] says in each listed field's contract description that a card number answers card_data, with the detector's rule", () => {
    const undocumented: string[] = [];
    for (const [operationId, listed] of Object.entries(CARD_FREE_TEXT_FIELDS)) {
      for (const field of listed ?? []) {
        const descriptions = fieldOf(operationId, field.pointer)?.descriptions ?? [];
        if (!descriptions.some((text) => text.includes("`card_data`") && text.includes(DETECTOR_RULE))) {
          undocumented.push(`${operationId} ${field.pointer}`);
        }
      }
    }
    expect(undocumented).toEqual([]);
    // The review closure's note says it too.
    expect(
      fieldOf("consoleCloseBookingReview", "/note")?.descriptions.some(
        (text) => text.includes("`card_data`") && text.includes(DETECTOR_RULE),
      ),
    ).toBe(true);
  });

  it("[FIX-W68-CARDTEXT AC5] states the detector's rule with its first digit wherever the document names card_data, and says metadata never holds card data", () => {
    const text = JSON.stringify(document.document);
    // Every `card_data` description that spells the digits out names the first digit too.
    expect(text.match(/12 to 19 digits that pass the Luhn check/g) ?? []).toEqual([]);
    expect((text.match(new RegExp(DETECTOR_RULE, "g")) ?? []).length).toBeGreaterThan(30);
    for (const operationId of ["createCheckout", "consoleCreateBooking", "consolePatchBooking"]) {
      const metadata = fieldOf(operationId, "/metadata/*");
      expect([
        operationId,
        metadata?.descriptions.some((entry) => entry.includes("never holds card data")),
      ]).toEqual([operationId, true]);
    }
  });
});
