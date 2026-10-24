// src/lib/card-brand.js: the local card checks of the airline-card page (ota/frontend/docs/pages.md §9, OADR-0017
// point 5): the brand of the card-fee quote from the first digits, the Luhn digit and the expiry as the API checks
// them, and the security code length. Card numbers are Stripe's documented test numbers; the other networks are
// tested with first digits only.
import { describe, expect, it } from "vitest";

import {
  BIN_LENGTH,
  acceptedCardBrand,
  cardDigits,
  cardExpired,
  cardNetwork,
  luhnValid,
  securityCodeValid,
} from "../src/lib/card-brand.js";

/** Every brand of the Amadeus enum, as an OTA that accepts them all would list them. */
const ALL_BRANDS = [
  "VISA",
  "AMERICAN_EXPRESS",
  "MASTERCARD",
  "VISA_ELECTRON",
  "VISA_DEBIT",
  "MASTERCARD_DEBIT",
  "MAESTRO",
  "DINERS",
  "MASTERCARD_IXARIS",
  "VISA_IXARIS",
  "MASTERCARD_AIRPLUS",
  "UATP_AIRPLUS",
  "PYTON",
].map((amadeus) => ({ amadeus, psp: amadeus.toLowerCase(), label: `Label ${amadeus}` }));

describe("card-brand: the brand of the card-fee quote", () => {
  it("[OFE-014] tells the network from the first digits", () => {
    const cases = /** @type {Array<[string, string | null]>} */ ([
      ["4242424242424242", "visa"],
      ["4000056655665556", "visa"],
      ["5555555555554444", "mastercard"],
      ["2223003122003222", "mastercard"],
      ["5200828282828210", "mastercard"],
      ["378282246310005", "amex"],
      ["371449635398431", "amex"],
      ["3056930009020004", "diners"],
      ["36227206271667", "diners"],
      ["675964", "maestro"],
      ["501800", "maestro"],
      ["122000", "uatp"],
      ["491761", "visa"],
      // Discover, JCB and UnionPay are not airline-card brands (no Amadeus PaymentBrand).
      ["6011111111111117", null],
      ["3566002020360505", null],
      ["6200000000000005", null],
      ["", null],
    ]);
    for (const [digits, network] of cases) {
      expect(cardNetwork(digits), digits).toBe(network);
    }
    expect(BIN_LENGTH).toBe(6);
  });

  it("[OFE-014] picks the first Amadeus brand of the network that the OTA accepts, with its label", () => {
    expect(acceptedCardBrand("424242", ALL_BRANDS)).toEqual({ amadeus: "VISA", label: "Label VISA" });
    expect(acceptedCardBrand("491761", ALL_BRANDS)).toEqual({
      amadeus: "VISA_ELECTRON",
      label: "Label VISA_ELECTRON",
    });
    expect(acceptedCardBrand("555555", ALL_BRANDS)?.amadeus).toBe("MASTERCARD");
    expect(acceptedCardBrand("378282", ALL_BRANDS)?.amadeus).toBe("AMERICAN_EXPRESS");
    expect(acceptedCardBrand("305693", ALL_BRANDS)?.amadeus).toBe("DINERS");
    expect(acceptedCardBrand("675964", ALL_BRANDS)?.amadeus).toBe("MAESTRO");
    expect(acceptedCardBrand("122000", ALL_BRANDS)?.amadeus).toBe("UATP_AIRPLUS");

    // An OTA that takes Visa only as a debit card gets VISA_DEBIT for a Visa number; a Visa Electron card falls back to
    // VISA when the OTA does not list VISA_ELECTRON.
    const debitOnly = [{ amadeus: "VISA_DEBIT", psp: "visa", label: "Visa Debit" }];
    expect(acceptedCardBrand("400005", debitOnly)).toEqual({ amadeus: "VISA_DEBIT", label: "Visa Debit" });
    const visa = [{ amadeus: "VISA", psp: "visa", label: "" }];
    expect(acceptedCardBrand("491761", visa)).toEqual({ amadeus: "VISA", label: "VISA" });
  });

  it("[OFE-014] gives no brand for a network the OTA does not accept, or a number of no network", () => {
    const visaAndMastercard = ALL_BRANDS.filter((brand) => ["VISA", "MASTERCARD"].includes(brand.amadeus));
    expect(acceptedCardBrand("378282", visaAndMastercard)).toBeNull();
    expect(acceptedCardBrand("601111", ALL_BRANDS)).toBeNull();
    expect(acceptedCardBrand("424242", [])).toBeNull();
    expect(acceptedCardBrand("424242", null)).toBeNull();
    expect(acceptedCardBrand("424242", undefined)).toBeNull();
  });
});

describe("card-brand: the API's checks, made before anything is sent", () => {
  it("[OFE-014] reads the digits of a number typed with spaces or dashes, and refuses anything else", () => {
    expect(cardDigits("4242 4242 4242 4242")).toBe("4242424242424242");
    expect(cardDigits("4242-4242-4242-4242")).toBe("4242424242424242");
    expect(cardDigits("")).toBe("");
    expect(cardDigits("4242 42x2")).toBeNull();
    expect(cardDigits("４２４２")).toBeNull();
  });

  it("[OFE-014] checks the Luhn digit of 12 to 19 digits", () => {
    for (const valid of ["4242424242424242", "5555555555554444", "378282246310005", "36227206271667"]) {
      expect(luhnValid(valid), valid).toBe(true);
    }
    expect(luhnValid("4242424242424241")).toBe(false);
    expect(luhnValid("42424")).toBe(false);
    expect(luhnValid("4".repeat(20))).toBe(false);
    expect(luhnValid("")).toBe(false);
  });

  it("[OFE-014] a card expires at the end of its expiry month (UTC)", () => {
    const now = new Date(Date.UTC(2027, 5, 30, 23, 59));
    expect(cardExpired(6, 2027, now)).toBe(false);
    expect(cardExpired(5, 2027, now)).toBe(true);
    expect(cardExpired(12, 2026, now)).toBe(true);
    expect(cardExpired(1, 2028, now)).toBe(false);
  });

  it("[OFE-014] checks the security code length of the network", () => {
    expect(securityCodeValid("123", "visa")).toBe(true);
    expect(securityCodeValid("1234", "visa")).toBe(false);
    expect(securityCodeValid("1234", "amex")).toBe(true);
    expect(securityCodeValid("123", "amex")).toBe(false);
    expect(securityCodeValid("123", "uatp")).toBe(true);
    expect(securityCodeValid("1234", null)).toBe(true);
    expect(securityCodeValid("12", null)).toBe(false);
    expect(securityCodeValid("12a", "visa")).toBe(false);
  });
});
