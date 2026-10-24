// The server's checks of the airline card (OBE-051; ota/docs/api-changes.md §3.2, ota/docs/flows/checkout-airline-card.md
// §3 step 4 and §4): the Luhn digit, an expiry in the past and a blank holder are field errors with paths and codes
// only, never the value; a good card is wrapped in a SensitiveCard at once.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  CARD_FIELD_PATHS,
  cardExpired,
  cardFieldErrors,
  checkAirlineCard,
  luhnValid,
} from "./card-validation";
import { REDACTED_CARD, SensitiveCard, type AirlineCardInput } from "./sensitive-card";

// Test data only: Visa's documented test PAN, the declined test card of the Amadeus stub, and made-up details.
const TEST_PAN = "4111111111111111";
const DECLINED_TEST_PAN = "4000000000000002";
const TEST_CVV = "123";
const NOW = new Date("2027-06-15T12:00:00Z");

const card = (overrides: Partial<AirlineCardInput> = {}): AirlineCardInput => ({
  brand: "VISA",
  holderName: "Anna Berg",
  number: TEST_PAN,
  expiryMonth: 12,
  expiryYear: 2030,
  securityCode: TEST_CVV,
  ...overrides,
});

describe("the Luhn check of the card number", () => {
  it("accepts the documented test cards of the brands [OBE-051 AC1]", () => {
    for (const number of [
      TEST_PAN,
      DECLINED_TEST_PAN,
      "4242424242424242",
      "5555555555554444",
      "378282246310005",
      "6011111111111117",
      "4012888888881881",
    ]) {
      expect(luhnValid(number), number.slice(-4)).toBe(true);
    }
  });

  it("refuses a number whose check digit or any other digit is wrong, and anything but digits", () => {
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(luhnValid("4111111111111121")).toBe(false);
    expect(luhnValid("5555555555554443")).toBe(false);
    expect(luhnValid("")).toBe(false);
    expect(luhnValid("4")).toBe(false);
    expect(luhnValid("4111 1111 1111 1111")).toBe(false);
    expect(luhnValid("41111111111111a1")).toBe(false);
  });
});

describe("the expiry of the card", () => {
  it("is good until the end of its month, read in UTC", () => {
    expect(cardExpired(6, 2027, NOW)).toBe(false);
    expect(cardExpired(6, 2027, new Date("2027-06-30T23:59:59Z"))).toBe(false);
    expect(cardExpired(7, 2027, NOW)).toBe(false);
    expect(cardExpired(1, 2028, NOW)).toBe(false);
  });

  it("is past once its month has ended", () => {
    expect(cardExpired(6, 2027, new Date("2027-07-01T00:00:00Z"))).toBe(true);
    expect(cardExpired(5, 2027, NOW)).toBe(true);
    expect(cardExpired(12, 2026, NOW)).toBe(true);
  });
});

describe("the field errors of a card", () => {
  it("are none for a good card, which is wrapped in a SensitiveCard [OBE-051 AC1]", () => {
    const checked = checkAirlineCard(card(), NOW);

    expect(cardFieldErrors(card(), NOW)).toEqual([]);
    expect(checked.ok).toBe(true);
    if (!checked.ok) {
      return;
    }
    expect(checked.card).toBeInstanceOf(SensitiveCard);
    expect([checked.card.brand(), checked.card.bin(), checked.card.last4()]).toEqual([
      "VISA",
      "411111",
      "1111",
    ]);
    expect(JSON.stringify(checked)).toBe(JSON.stringify({ ok: true, card: REDACTED_CARD }));
  });

  it("name the number (luhn), the expiry (expired) and a blank holder (pattern) by path, never with the value", () => {
    const wrong = card({ number: "4111111111111112", expiryMonth: 1, expiryYear: 2027, holderName: "  " });

    const errors = cardFieldErrors(wrong, NOW);
    const checked = checkAirlineCard(wrong, NOW);

    expect(errors.map((error) => [error.path, error.code])).toEqual([
      [CARD_FIELD_PATHS.holderName, "pattern"],
      [CARD_FIELD_PATHS.number, "luhn"],
      [CARD_FIELD_PATHS.expiry, "expired"],
    ]);
    expect(checked).toEqual({ ok: false, fieldErrors: errors });
    const text = `${JSON.stringify(checked)} ${inspect(checked, { depth: 10 })}`;
    expect(text).not.toContain("4111111111111112");
    expect(text).not.toContain("111111111112");
    expect(text).not.toContain(`"${TEST_CVV}"`);
    expect(text).not.toContain("2027");
  });

  it("refuses only the field that is wrong", () => {
    expect(cardFieldErrors(card({ number: "4111111111111121" }), NOW).map((error) => error.code)).toEqual([
      "luhn",
    ]);
    expect(
      cardFieldErrors(card({ expiryMonth: 5, expiryYear: 2027 }), NOW).map((error) => error.code),
    ).toEqual(["expired"]);
    expect(cardFieldErrors(card({ holderName: " A " }), NOW).map((error) => error.code)).toEqual(["pattern"]);
  });
});
