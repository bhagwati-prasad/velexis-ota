import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AmadeusSpecs, loadFixture, STUB_OPERATIONS } from "../src/index";
import {
  isReservedTestPhone,
  isSyntheticName,
  isSyntheticNumber,
  scanForPersonalData,
  scrub,
  SYNTHETIC_EMAIL_DOMAIN,
  SYNTHETIC_FAMILY_NAMES,
  SYNTHETIC_GIVEN_NAMES,
} from "../src/scrub";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const CREATE_ORDERS_SPEC = resolve(
  REPO_ROOT,
  "docs/amadeus-api/FlightCreateOrders_v1_Version_1.16_swagger_specification.json",
);

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json => value as Json;

/**
 * A recorded-style Flight Create Orders response: the 201 example of the specification (travellers STEPHANE, JULES
 * and EMILIE MARTIN, passport 012345678, the order id whose base64 holds the record locator and the name WATSON),
 * with what a real response adds: e-mail addresses, an emergency contact, resident and loyalty numbers, a form of
 * identification, a ticket, a card (Stripe's documented test number) and remarks that repeat all of it in free text.
 */
function recordedCreateOrdersResponse(): Json {
  const spec = JSON.parse(readFileSync(CREATE_ORDERS_SPEC, "utf8")) as {
    responses: { returnFlightOrders: { schema: { example: Json } } };
  };
  const response = structuredClone(spec.responses.returnFlightOrders.schema.example);
  const order = asObject(response["data"]);
  const travelers = order["travelers"] as Json[];
  const stephane = asObject(travelers[0]);
  asObject(stephane["name"])["middleName"] = "PIERRE";
  asObject(stephane["contact"])["emailAddress"] = "stephane.martin@mail.com";
  asObject((stephane["documents"] as Json[])[0])["birthPlace"] = "LYON";
  asObject((stephane["documents"] as Json[])[0])["issuanceLocation"] = "LONDON";
  stephane["emergencyContact"] = { addresseeName: "EMILIE MARTIN", countryCode: "FR", number: "612345678" };
  stephane["loyaltyPrograms"] = [{ programOwner: "AF", id: "2081234567" }];
  stephane["discountEligibility"] = [
    {
      subType: "SPANISH_RESIDENT",
      cityName: "MADRID",
      travelerType: "SPANISH_CITIZEN",
      cardNumber: "12568215Z",
      certificateNumber: "12568216Z",
    },
  ];
  order["formOfIdentifications"] = [
    { identificationType: "PASSPORT", carrierCode: "AF", number: "XN0019390", travelerIds: ["1"] },
  ];
  order["tickets"] = [
    { documentType: "ETICKET", documentNumber: "172-2400000001", documentStatus: "ISSUED", travelerId: "1" },
  ];
  order["formOfPayments"] = [
    {
      creditCard: {
        brand: "VISA",
        holder: "MR STEPHANE MARTIN",
        number: "4242424242424242",
        expiryDate: "2028-08",
        securityCode: "123",
      },
    },
  ];
  order["remarks"] = {
    general: [
      {
        subType: "GENERAL_MISCELLANEOUS",
        text:
          "PAX Stephane Martin CTCE STEPHANE.MARTIN//MAIL.COM CTCM +33 6 12 34 56 78 PASSPORT NO 512345678 " +
          "DOCS P/GBR/012345678/GBR REF 2ZYVAL CARD 4242 4242 4242 4242",
      },
    ],
  };
  response["meta"] = {
    links: {
      self: `https://test.travel.api.amadeus.com/v1/booking/flight-orders/${String(order["id"])}`,
      byReference:
        "https://test.travel.api.amadeus.com/v1/booking/flight-orders/by-reference?reference=2ZYVAL&originSystemCode=GDS",
    },
  };
  return response;
}

/** Every piece of personal data of `recordedCreateOrdersResponse`, as it must never appear in the output. */
const PERSONAL_DATA = [
  "STEPHANE",
  "MARTIN",
  "JULES",
  "EMILIE",
  "PIERRE",
  "1982-01-16",
  "2018-03-24",
  "2007-10-11",
  "012345678",
  "512345678",
  "XN0019390",
  "12568215Z",
  "12568216Z",
  "2081234567",
  "MAIL.COM",
  "487692704",
  "480080070",
  "612345678",
  "6 12 34 56 78",
  "485 ROUTE DU PIN MONTARD",
  "SOPHIA ANTIPOLIS",
  "LYON",
  "LONDON",
  "2ZYVAL",
  "MLPZVKFMFFDBVFNPTNWYMDE1LTEXLTAY",
  "172-2400000001",
  "2400000001",
  "4242424242424242",
  "4242 4242 4242 4242",
  "2028-08",
  '"123"',
];

const operationSpec = (name: string) => {
  const operation = STUB_OPERATIONS.find((candidate) => candidate.name === name);
  if (operation === undefined) {
    throw new Error(`no operation ${name}`);
  }
  return operation.spec;
};

describe("scrub", () => {
  it("removes the names, the passport number, the e-mail address and the phone number of a recorded Flight Create Orders response [X-034 AC1]", () => {
    const input = recordedCreateOrdersResponse();
    const before = JSON.stringify(input).toUpperCase();
    for (const value of PERSONAL_DATA) {
      expect(before, `the input holds ${value}`).toContain(value);
    }

    const scrubbed = scrub(input).value;
    const output = JSON.stringify(scrubbed).toUpperCase();
    for (const value of PERSONAL_DATA) {
      expect(output, `the output still holds ${value}`).not.toContain(value);
    }
    // The flight-order id is base64 of "<record locator>|<name>|<date>"; its replacement holds neither.
    const decodedId = (body: unknown) =>
      Buffer.from(String(asObject(asObject(body)["data"])["id"]), "base64").toString("utf8");
    expect(decodedId(input)).toContain("WATSON");
    expect(decodedId(scrubbed)).toBe("SYNTHETIC-ORDER-1");
  });

  it("gives the same output for the same input every time, and leaves the input unchanged [X-034 AC1]", () => {
    const input = recordedCreateOrdersResponse();
    const copy = structuredClone(input);
    const first = scrub(input);
    const second = scrub(input);
    const third = scrub(recordedCreateOrdersResponse());

    expect(JSON.stringify(second.value)).toBe(JSON.stringify(first.value));
    expect(JSON.stringify(third.value)).toBe(JSON.stringify(first.value));
    expect(second.replaced).toEqual(first.replaced);
    expect(input).toEqual(copy);
    // Scrubbing a scrubbed body changes nothing more.
    expect(JSON.stringify(scrub(first.value).value)).toBe(JSON.stringify(first.value));
  });

  it("writes deterministic synthetic values that the personal-data scan accepts [X-034 AC1]", () => {
    const input = recordedCreateOrdersResponse();
    expect(new Set(scanForPersonalData(input).map((finding) => finding.rule))).toEqual(
      new Set(["name", "document-number", "email", "phone", "digit-run"]),
    );

    const { value, replaced } = scrub(input);
    expect(scanForPersonalData(value)).toEqual([]);

    const order = asObject(asObject(value)["data"]);
    const travelers = order["travelers"] as Json[];
    const stephane = asObject(travelers[0]);
    expect(stephane["name"]).toEqual({
      firstName: SYNTHETIC_GIVEN_NAMES[0],
      lastName: SYNTHETIC_FAMILY_NAMES[0],
      middleName: SYNTHETIC_GIVEN_NAMES[1],
    });
    // The family stays one family; each given name gets its own synthetic name, in order of first appearance.
    expect(travelers.map((traveler) => asObject(traveler["name"]))).toEqual([
      expect.objectContaining({ firstName: "ALEX", lastName: "TESTER" }),
      { firstName: "CASEY", lastName: "TESTER" },
      { firstName: "DANA", lastName: "TESTER" },
    ]);
    // The year of birth stays (the passenger type depends on it); month and day do not.
    expect(travelers.map((traveler) => traveler["dateOfBirth"])).toEqual([
      "1982-01-01",
      "2018-01-01",
      "2007-01-01",
    ]);
    expect(stephane["contact"]).toEqual({
      phones: [{ countryCallingCode: "44", number: "7700900001" }],
      emailAddress: `person1@${SYNTHETIC_EMAIL_DOMAIN}`,
    });
    expect(asObject((stephane["documents"] as Json[])[0])).toEqual({
      documentType: "PASSPORT",
      number: "000000001",
      expiryDate: "2009-04-14",
      issuanceCountry: "GB",
      nationality: "GB",
      holder: true,
      birthPlace: "EXAMPLE CITY",
      issuanceLocation: "EXAMPLE CITY",
    });
    expect(stephane["emergencyContact"]).toEqual({
      addresseeName: "DANA TESTER",
      countryCode: "GB",
      number: "7700900002",
    });
    expect(stephane["loyaltyPrograms"]).toEqual([{ programOwner: "AF", id: "0000000001" }]);
    expect(stephane["discountEligibility"]).toEqual([
      expect.objectContaining({
        cityName: "MADRID",
        cardNumber: "00000001Z",
        certificateNumber: "00000002Z",
      }),
    ]);
    expect(order["tickets"]).toEqual([
      {
        documentType: "ETICKET",
        documentNumber: "000-0000000001",
        documentStatus: "ISSUED",
        travelerId: "1",
      },
    ]);
    expect(order["formOfPayments"]).toEqual([
      {
        creditCard: {
          brand: "VISA",
          holder: "MR ALEX TESTER",
          number: "XXXXXXXXXXXX0000",
          expiryDate: "2099-12",
        },
      },
    ]);
    expect(order["associatedRecords"]).toEqual([
      expect.objectContaining({ reference: "SYN001", originSystemCode: "1A" }),
    ]);
    expect(Buffer.from(String(order["id"]), "base64url").toString("utf8")).toBe("SYNTHETIC-ORDER-1");
    expect(asObject(asObject(value)["meta"])["links"]).toEqual({
      self: `https://test.travel.api.amadeus.com/v1/booking/flight-orders/${String(order["id"])}`,
      byReference:
        "https://test.travel.api.amadeus.com/v1/booking/flight-orders/by-reference?reference=SYN001&originSystemCode=GDS",
    });
    expect(asObject(order["remarks"])["general"]).toEqual([
      {
        subType: "GENERAL_MISCELLANEOUS",
        text:
          "PAX Alex Tester CTCE PERSON1//EXAMPLE.COM CTCM +447700900004 PASSPORT NO 000000003 " +
          "DOCS P/GBR/000000001/GBR REF SYN001 CARD 0000 0000 0000 0002",
      },
    ]);
    expect(replaced).toMatchObject({ names: expect.any(Number), emails: 3, phones: 5, orderIds: 2 });
  });

  it("keeps airports, carriers, fare bases, prices, offer ids, offices and dictionaries as they are [X-034 AC1]", () => {
    const input = recordedCreateOrdersResponse();
    const output = asObject(scrub(input).value);
    const order = asObject(input["data"]);
    const scrubbed = asObject(output["data"]);

    expect(scrubbed["flightOffers"]).toEqual(order["flightOffers"]);
    expect(output["dictionaries"]).toEqual(input["dictionaries"]);
    expect(scrubbed["queuingOfficeId"]).toBe(order["queuingOfficeId"]);
    expect(scrubbed["ticketingAggreement"]).toEqual(order["ticketingAggreement"]);
    expect((scrubbed["travelers"] as Json[]).map((traveler) => traveler["id"])).toEqual(["1", "3", "2"]);
    expect(asObject(asObject((scrubbed["contacts"] as Json[])[0])["address"])["countryCode"]).toBe("FR");
  });

  it("introduces no difference from the Flight Create Orders response schema [X-034 AC1]", () => {
    const specs = new AmadeusSpecs();
    const spec = operationSpec("createFlightOrders");
    const input = recordedCreateOrdersResponse();
    const problems = (body: unknown) =>
      specs
        .validateResponse(spec, 201, body)
        .map((problem) => `${problem.instancePath} ${problem.keyword}`)
        .sort();

    // The specification's own example has known defects (co2 weights as strings, sliceDiceIndicator values).
    expect(problems(scrub(input).value)).toEqual(problems(input));
  });

  it("leaves the committed synthetic fixtures unchanged", () => {
    const { body } = loadFixture("flight-offers-search", "success");
    const result = scrub(body);
    expect(result.value).toEqual(body);
    expect(Object.values(result.replaced).every((count) => count === 0)).toBe(true);
  });

  it("keeps a three-letter code that equals a traveller's name, and replaces the name in free text", () => {
    const body = {
      data: {
        type: "flight-order",
        id: "ORDERID",
        travelers: [{ id: "1", name: { firstName: "ANA", lastName: "LIS" } }],
        flightOffers: [{ itineraries: [{ segments: [{ departure: { iataCode: "LIS" } }] }] }],
        remarks: { general: [{ subType: "GENERAL_MISCELLANEOUS", text: "PAX ANA LIS TO LIS" }] },
      },
    };
    const data = asObject(asObject(scrub(body).value)["data"]);
    expect(JSON.stringify(data["flightOffers"])).toBe(JSON.stringify(body.data.flightOffers));
    expect(data["travelers"]).toEqual([{ id: "1", name: { firstName: "ALEX", lastName: "TESTER" } }]);
    expect(asObject(data["remarks"])["general"]).toEqual([
      { subType: "GENERAL_MISCELLANEOUS", text: "PAX ALEX TESTER TO TESTER" },
    ]);
  });

  it("scrubs names with apostrophes, accents and titles, in their fields and in free text", () => {
    const body = {
      data: {
        travelers: [{ id: "1", name: { firstName: "JOSÉ MR", lastName: "O'NEIL-GARCÍA" } }],
        remarks: { general: [{ subType: "GENERAL_MISCELLANEOUS", text: "Mr José O'Neil-García (ONEIL)" }] },
      },
    };
    const { value } = scrub(body);
    expect(asObject(value)["data"]).toEqual({
      travelers: [{ id: "1", name: { firstName: "ALEX MR", lastName: "TESTER-SAMPLE" } }],
      remarks: { general: [{ subType: "GENERAL_MISCELLANEOUS", text: "Mr Alex Tester-Sample (TESTER)" }] },
    });
    expect(scanForPersonalData(value)).toEqual([]);
  });

  it("scrubs the record locator of a Queue List PNR id and the names of its travellers", () => {
    const body = {
      data: [
        {
          type: "pnr",
          id: "K7M2QF-2027-01-10",
          travelers: [{ names: [{ firstName: "JULES", lastName: "MARTIN" }] }],
        },
      ],
    };
    expect(scrub(body).value).toEqual({
      data: [
        {
          type: "pnr",
          id: "SYN001-2027-01-10",
          travelers: [{ names: [{ firstName: "ALEX", lastName: "TESTER" }] }],
        },
      ],
    });
  });
});

describe("synthetic markers", () => {
  it("accepts only the reserved test phone ranges", () => {
    expect(isReservedTestPhone("447700900123")).toBe(true);
    expect(isReservedTestPhone("07700900123")).toBe(true);
    expect(isReservedTestPhone("+44 20 7946 0123")).toBe(true);
    expect(isReservedTestPhone("+1 202 555 0143")).toBe(true);
    expect(isReservedTestPhone("33487692704")).toBe(false);
    expect(isReservedTestPhone("447700901123")).toBe(false);
    expect(isReservedTestPhone("+1 202 555 0200")).toBe(false);
  });

  it("accepts synthetic names with titles, and synthetic numbers by their 000 prefix", () => {
    expect(isSyntheticName("MR ALEX TESTER")).toBe(true);
    expect(isSyntheticName("Blake-Sample")).toBe(true);
    expect(isSyntheticName("STEPHANE")).toBe(false);
    expect(isSyntheticNumber("000000001")).toBe(true);
    expect(isSyntheticNumber("000-0000000001")).toBe(true);
    expect(isSyntheticNumber("012345678")).toBe(false);
  });
});
