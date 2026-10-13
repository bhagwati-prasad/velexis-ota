import { describe, expect, it } from "vitest";
import { maskPan } from "./mask.js";
import { REDACT_CENSOR } from "./redact-paths.js";
import { CIRCULAR_REFERENCE, redactPayload } from "./redact-payload.js";

// Test data only: Visa's documented test PAN and a made-up password and token.
const TEST_PAN = "4111111111111111";
const TEST_CVV = "123";
const TEST_PASSWORD = "Hunter2!";
const TEST_TOKEN = "test-only-token-0a1b2c3d4e5f";

type Json = Record<string, unknown>;

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

/** An Amadeus Flight Create Orders request body with an airline-card form of payment. */
function createOrderBody(): Json {
  return {
    data: {
      type: "flight-order",
      flightOffers: [{ type: "flight-offer", id: "1" }],
      travelers: [
        {
          id: "1",
          name: { firstName: "JORGE", lastName: "GONZALES" },
          documents: [
            {
              documentType: "PASSPORT",
              number: "00000000X1234",
              birthPlace: "Madrid",
              issuanceLocation: "Madrid",
              issuanceCountry: "ES",
              nationality: "ES",
              expiryDate: "2030-04-14",
            },
          ],
          discountEligibility: [
            { subType: "SPANISH_RESIDENT", cardNumber: "12568215Z", certificateNumber: "12568216Y" },
          ],
        },
      ],
      formOfPayments: [
        {
          creditCard: {
            brand: "VISA",
            holder: "JORGE GONZALES",
            number: TEST_PAN,
            expiryDate: "2030-12",
            securityCode: TEST_CVV,
            flightOfferIds: ["1"],
          },
        },
      ],
    },
  };
}

describe("redactPayload", () => {
  it("keeps 1111 of an Amadeus formOfPayments[0].creditCard number, removes securityCode and leaves the input unchanged [X-003 AC3]", () => {
    const input = createOrderBody();
    const snapshot = structuredClone(input);
    deepFreeze(input);

    const output = redactPayload(input);

    expect(input).toEqual(snapshot);
    expect(output).not.toBe(input);
    const data = output["data"] as Json;
    expect(data["formOfPayments"]).toEqual([
      {
        creditCard: {
          brand: "VISA",
          holder: "JORGE GONZALES",
          number: "1111",
          expiryDate: "2030-12",
          flightOfferIds: ["1"],
        },
      },
    ]);
    expect(JSON.stringify(output)).not.toContain(TEST_PAN);
    expect(JSON.stringify(output)).not.toContain("securityCode");
  });

  it("returns a deep copy that shares no object with the input [X-003 AC3]", () => {
    const input = createOrderBody();
    const output = redactPayload(input);
    const inputData = input["data"] as Json;
    const outputData = output["data"] as Json;
    expect(outputData).not.toBe(inputData);
    expect(outputData["flightOffers"]).not.toBe(inputData["flightOffers"]);
    expect(outputData["flightOffers"]).toEqual(inputData["flightOffers"]);
    (outputData["flightOffers"] as Json[]).push({ id: "2" });
    expect(inputData["flightOffers"]).toHaveLength(1);
  });

  it("masks identity documents and resident discount numbers to their last 4 characters (db README §8)", () => {
    const output = redactPayload(createOrderBody());
    const [traveler] = (output["data"] as { travelers: Json[] }).travelers;
    expect(traveler?.["documents"]).toEqual([
      {
        documentType: "PASSPORT",
        number: "1234",
        issuanceCountry: "ES",
        nationality: "ES",
        expiryDate: "2030-04-14",
      },
    ]);
    expect(traveler?.["discountEligibility"]).toEqual([
      { subType: "SPANISH_RESIDENT", cardNumber: "215Z", certificateNumber: "216Y" },
    ]);
  });

  it("drops securityCode, cvc and cvv wherever they appear", () => {
    const output = redactPayload({
      card: { number: "4111 1111 1111 1111", cvc: TEST_CVV },
      payment: { card: { number: TEST_PAN, cvv: TEST_CVV, security_code: TEST_CVV } },
      securityCode: TEST_CVV,
    });
    expect(output).toEqual({ card: { number: "1111" }, payment: { card: { number: "1111" } } });
  });

  it("replaces password, token, secret and apiKey fields with [REDACTED]", () => {
    const output = redactPayload({
      email: "a@example.com",
      password: TEST_PASSWORD,
      newPassword: TEST_PASSWORD,
      accessToken: TEST_TOKEN,
      refresh_token: TEST_TOKEN,
      bookingToken: TEST_TOKEN,
      clientSecret: TEST_TOKEN,
      secret: { nested: TEST_TOKEN },
      apiKey: TEST_TOKEN,
      mfaCode: "123456",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        Cookie: `__Host-session=${TEST_TOKEN}`,
        "X-Api-Key": TEST_TOKEN,
        "x-csrf-token": TEST_TOKEN,
        "x-velexis-edge": TEST_TOKEN,
        accept: "application/json",
      },
    });
    expect(output).toEqual({
      email: "a@example.com",
      password: REDACT_CENSOR,
      newPassword: REDACT_CENSOR,
      accessToken: REDACT_CENSOR,
      refresh_token: REDACT_CENSOR,
      bookingToken: REDACT_CENSOR,
      clientSecret: REDACT_CENSOR,
      secret: REDACT_CENSOR,
      apiKey: REDACT_CENSOR,
      mfaCode: REDACT_CENSOR,
      headers: {
        Authorization: REDACT_CENSOR,
        Cookie: REDACT_CENSOR,
        "X-Api-Key": REDACT_CENSOR,
        "x-csrf-token": REDACT_CENSOR,
        "x-velexis-edge": REDACT_CENSOR,
        accept: "application/json",
      },
    });
    expect(JSON.stringify(output)).not.toContain(TEST_TOKEN);
    expect(JSON.stringify(output)).not.toContain(TEST_PASSWORD);
  });

  it("handles arrays at the top level and inside objects", () => {
    const output = redactPayload([
      { creditCard: { number: TEST_PAN, securityCode: TEST_CVV } },
      [{ card: { number: 4111111111111111 } }],
      "plain",
      42,
      null,
    ]);
    expect(output).toEqual([
      { creditCard: { number: "1111" } },
      [{ card: { number: "1111" } }],
      "plain",
      42,
      null,
    ]);
  });

  it("does not loop on cycles and replaces the back reference", () => {
    const node: Json = { id: "bkg_01", creditCard: { number: TEST_PAN } };
    node["self"] = node;
    node["list"] = [node];
    const shared = { id: "shared" };

    const output = redactPayload({ node, a: shared, b: shared });

    expect(output).toEqual({
      node: {
        id: "bkg_01",
        creditCard: { number: "1111" },
        self: CIRCULAR_REFERENCE,
        list: [CIRCULAR_REFERENCE],
      },
      a: { id: "shared" },
      b: { id: "shared" },
    });
    expect(() => JSON.stringify(output)).not.toThrow();
  });

  it("redacts what JSON.stringify would persist and copies dates", () => {
    const createdAt = new Date("2026-10-13T08:00:00.000Z");
    const card = { toJSON: () => ({ number: TEST_PAN, securityCode: TEST_CVV }) };
    const output = redactPayload({ createdAt, card, label: "x" });
    expect(output.createdAt).toEqual(createdAt);
    expect(output.createdAt).not.toBe(createdAt);
    expect(output.card).toEqual({ number: "1111" });
  });

  it("keeps a __proto__ key as data", () => {
    const input = JSON.parse('{"__proto__": {"password": "x"}, "id": "1"}') as Json;
    const output = redactPayload(input);
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(Object.keys(output)).toEqual(["__proto__", "id"]);
    expect(Object.getOwnPropertyDescriptor(output, "__proto__")?.value).toEqual({ password: REDACT_CENSOR });
  });

  it("returns primitives unchanged", () => {
    expect(redactPayload("text")).toBe("text");
    expect(redactPayload(7)).toBe(7);
    expect(redactPayload(null)).toBeNull();
    expect(redactPayload(undefined)).toBeUndefined();
  });
});

describe("maskPan", () => {
  it("keeps the BIN and the last 4 digits (ADR-0011)", () => {
    expect(maskPan(TEST_PAN)).toBe("411111******1111");
    expect(maskPan("4111 1111 1111 1111")).toBe("411111******1111");
    expect(maskPan("378282246310005")).toBe("378282*****0005");
    expect(maskPan(4111111111111111)).toBe("411111******1111");
  });

  it("never shows more than the last 4 digits of a value too short to be a card number", () => {
    expect(maskPan("12345678")).toBe("****5678");
    expect(maskPan("1234")).toBe("****");
    expect(maskPan("")).toBe("");
  });
});
