import { describe, expect, it } from "vitest";
import { holdsCardNumber } from "./card-number.js";

// The card-number detector of free text (card-number.ts). Card numbers here are test data only: Visa's and
// Mastercard's documented test PANs and numbers made up to pass or fail the Luhn check.

describe("holdsCardNumber", () => {
  it("[FIX-W67-KI001 AC1] finds a card number, grouped or not, wherever it stands among other digits", () => {
    for (const text of [
      "4111111111111111",
      "4111 1111 1111 1111",
      "The traveller paid with 4111111111111111.",
      "Card 4111 1111 1111 1111 was charged by the airline",
      "Card 5555-5555-5555-4444, ask the airline",
      // Next to other digits: a security code or an expiry after it, a reference before it.
      "Card 4111 1111 1111 1111 123 was charged",
      "4111111111111111 12 28 per the traveller",
      "Ref 12 4111111111111111",
      "PAN 4111111111111111",
      // Between other digit groups on both sides, and mixed single spaces and dashes.
      "Ref 12 4111 1111 1111 1111 99 seen",
      "card 4111-1111 1111-1111",
    ]) {
      expect([text, holdsCardNumber(text)]).toEqual([text, true]);
    }
  });

  it("[FIX-W67-KI001 AC1] takes the shortest and the longest card numbers, 12 and 19 digits, and nothing longer", () => {
    expect(holdsCardNumber("card 400000000002")).toBe(true);
    expect(holdsCardNumber("card 4111111111111111110")).toBe(true);
    expect(holdsCardNumber("card 4111 1111 1111 1111 110")).toBe(true);
    // 11 digits are too short, and one group of 20 digits is no card number even when it passes the Luhn check.
    expect(holdsCardNumber("ref 40000000006")).toBe(false);
    expect(holdsCardNumber("ref 41111111111111111115")).toBe(false);
  });

  it("[FIX-W67-KI001 AC1] joins groups only with a single space or dash: a tab, a line break or two spaces end the run", () => {
    for (const text of [
      "4111\t1111\t1111\t1111",
      "4111 1111\n1111 1111",
      "4111  1111  1111  1111",
      "4111/1111/1111/1111",
      "4111.1111.1111.1111",
    ]) {
      expect([text, holdsCardNumber(text)]).toEqual([text, false]);
    }
  });

  it("[FIX-W67-KI001 AC1] keeps numbers that are no card number: phones, references, amounts, dates, short runs", () => {
    for (const text of [
      "Called +46 70 123 45 67 about booking VX7K2Q.",
      "Called +44 20 7946 0958 back.",
      "Ticket 057-2412345678 is not in the office.",
      "Amount held 1364.06 EUR, queue 50 category 0.",
      "Refunded 1,234,567.89 USD on 2026-11-11.",
      "Checked 2026-11-11 10:05 to 10:20.",
      // Twelve digits that fail the Luhn check, and a Luhn-valid run no card brand starts with.
      "Order id 412345678901",
      "Reference 0000000000000000",
      "",
      "No digits at all.",
    ]) {
      expect([text, holdsCardNumber(text)]).toEqual([text, false]);
    }
  });

  it("[FIX-W67-KI001 AC1] never takes a ticket number of an airline code from 0, 1 or 7 to 9, even when it passes the Luhn check", () => {
    // 057-2412345678 and 999-1234567890 pass the Luhn check; their first digit is no card brand's.
    for (const ticket of [
      "057-2412345678",
      "0572412345678",
      "125-1234567890",
      "724-1234567890",
      "800-1234567890",
      "999-1234567890",
    ]) {
      expect([ticket, holdsCardNumber(`Ticket ${ticket} reissued.`)]).toEqual([ticket, false]);
    }
  });

  it("[FIX-W67-KI001 AC1] refuses, as its doc comment says, a 13-digit ticket number or a long phone of a code from 2 to 6 that passes the Luhn check", () => {
    expect(holdsCardNumber("Ticket 220-1234567891 reissued.")).toBe(true);
    expect(holdsCardNumber("Ticket 220-1234567890 reissued.")).toBe(false);
    expect(holdsCardNumber("Called +44 20 7946 0956 back.")).toBe(true);
  });

  it("[FIX-W67-KI001 AC1] answers a boolean and leaves the text alone", () => {
    const text = "Card 4111 1111 1111 1111";
    expect(holdsCardNumber(text)).toBe(true);
    expect(text).toBe("Card 4111 1111 1111 1111");
    // The global pattern keeps no state between calls.
    expect(holdsCardNumber(text)).toBe(true);
    expect(holdsCardNumber("Order id 412345678901")).toBe(false);
  });
});
