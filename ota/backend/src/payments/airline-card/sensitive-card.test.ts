// The airline card in memory (OBE-050; OADR-0004 point 2, ota/docs/flows/checkout-airline-card.md §3 steps 4–7): a
// `SensitiveCard` gives brand, BIN and last 4 to anyone, the full card to `toAmadeusCreditCard()` only, and
// `"[redacted card]"` to every way a value ends up as text: JSON, template strings, concatenation, `util.inspect` and
// `util.format` (so `console.log`), a pino line, an error message, and the copies a careless caller might make.
import { format, inspect } from "node:util";
import { createLogger } from "@velexis/logger";
import { describe, expect, it } from "vitest";
import { REDACTED_CARD, SensitiveCard, type AirlineCardInput } from "./sensitive-card";

// Test data only: Visa's documented test PAN and a made-up security code, holder and expiry.
const TEST_PAN = "4111111111111111";
const TEST_PAN_LAST_12 = TEST_PAN.slice(-12);
const TEST_CVV = "123";
const HOLDER = "Jorge Gonzales";

const input = (overrides: Partial<AirlineCardInput> = {}): AirlineCardInput => ({
  brand: "VISA",
  holderName: HOLDER,
  number: TEST_PAN,
  expiryMonth: 7,
  expiryYear: 2030,
  securityCode: TEST_CVV,
  ...overrides,
});

/** Fails when `text` shows the number, its last 12 digits, the security code as a JSON value, the holder or expiry. */
function expectNothingOfTheCard(text: string): void {
  expect(text).not.toContain(TEST_PAN);
  expect(text).not.toContain(TEST_PAN_LAST_12);
  expect(text).not.toContain(`"${TEST_CVV}"`);
  expect(text).not.toContain(HOLDER);
  expect(text).not.toContain(HOLDER.toUpperCase());
  expect(text).not.toContain("2030");
}

describe("a SensitiveCard serialised by accident", () => {
  it("answers [redacted card] to JSON.stringify, alone and inside other objects and arrays [OBE-050 AC3]", () => {
    const card = SensitiveCard.from(input());
    const texts = [
      JSON.stringify(card),
      JSON.stringify({ card }),
      JSON.stringify({ body: { card, paymentId: "pay_1" } }),
      JSON.stringify([card, card]),
      JSON.stringify({ card }, null, 2),
    ];

    expect(texts[0]).toBe(JSON.stringify(REDACTED_CARD));
    expect(JSON.parse(texts[2] ?? "{}")).toEqual({ body: { card: REDACTED_CARD, paymentId: "pay_1" } });
    for (const text of texts) {
      expectNothingOfTheCard(text);
    }
  });

  it("answers [redacted card] in template strings, concatenation, String() and error messages [OBE-050 AC3]", () => {
    const card = SensitiveCard.from(input());
    const error = new Error(`The card ${card} was refused`);
    const texts = [
      `${card}`,
      `card: ${card}`,
      "card: " + String(card),
      // The mistake this test guards against: a card concatenated as if it were a string.
      "card: " + (card as unknown as string),
      [card].join(", "),
      card.toString(),
      error.message,
      error.stack ?? "",
    ];

    expect(texts[0]).toBe(REDACTED_CARD);
    expect(error.message).toBe(`The card ${REDACTED_CARD} was refused`);
    for (const text of texts) {
      expectNothingOfTheCard(text);
    }
  });

  it("answers [redacted card] to util.inspect with any option and to util.format, as console.log uses [OBE-050 AC3]", () => {
    const card = SensitiveCard.from(input());
    const texts = [
      inspect(card),
      inspect({ card }, { depth: Infinity, showHidden: true }),
      inspect(card, { customInspect: false, showHidden: true, depth: Infinity }),
      inspect([card], { customInspect: false, showHidden: true }),
      format("%s %o %O %j", card, card, card, { card }),
      format(card),
    ];

    expect(texts[0]).toBe(REDACTED_CARD);
    for (const text of texts) {
      expectNothingOfTheCard(text);
    }
  });

  it("keeps the values out of keys, spreads, structuredClone and property descriptors [OBE-050 AC3]", () => {
    const card = SensitiveCard.from(input());
    const copies: unknown[] = [
      { ...card },
      Object.assign({}, card),
      structuredClone(card),
      Object.entries(card),
      Object.getOwnPropertyDescriptors(card),
    ];

    expect(Object.keys(card)).toEqual([]);
    expect(Reflect.ownKeys(card)).toEqual([]);
    for (const copy of copies) {
      expectNothingOfTheCard(inspect(copy, { showHidden: true, depth: Infinity }));
      expectNothingOfTheCard(JSON.stringify(copy));
    }
  });

  it("logs as [redacted card] through the central logger, also under keys the redaction list does not know [OBE-050 AC3]", () => {
    const lines: string[] = [];
    const logger = createLogger({
      app: "ota-api",
      env: "test",
      level: "debug",
      destination: { write: (line: string) => lines.push(line) },
    });
    const card = SensitiveCard.from(input());

    logger.info({ card, checkoutId: "chk_1" }, "airline_card.received");
    logger.warn({ attempt: { sensitive: card, wrapped: [card] } }, "airline_card.attempt");
    logger.error({ err: new Error(`refused ${card}`) }, "airline_card.failed");

    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const { time: _time, ...rest } = JSON.parse(line) as Record<string, unknown>;
      expectNothingOfTheCard(JSON.stringify(rest));
    }
    const attempt = (JSON.parse(lines[1] ?? "{}") as { attempt: unknown }).attempt;
    expect(attempt).toEqual({ sensitive: REDACTED_CARD, wrapped: [REDACTED_CARD] });
  });
});

describe("the readers of a SensitiveCard", () => {
  it("give the brand, the BIN and the last 4 digits only", () => {
    const card = SensitiveCard.from(input({ brand: "MASTERCARD", number: "5555555555554444" }));

    expect([card.brand(), card.bin(), card.last4()]).toEqual(["MASTERCARD", "555555", "4444"]);
  });

  it("give the full card to the Amadeus request body: holder upper case, expiry YYYY-MM", () => {
    const card = SensitiveCard.from(input({ holderName: "  Jorge Gonzales " }));

    expect(card.toAmadeusCreditCard()).toEqual({
      brand: "VISA",
      holder: "JORGE GONZALES",
      number: TEST_PAN,
      expiryDate: "2030-07",
      securityCode: TEST_CVV,
    });
  });

  it("give a redacted copy for a persisted supplier request: brand and last 4, no holder, no expiry, no security code [FIX-W29-SECURITY AC2]", () => {
    const redacted = SensitiveCard.from(input()).toRedactedCreditCard();

    expect(redacted).toEqual({ brand: "VISA", number: "1111" });
    const text = JSON.stringify(redacted);
    expectNothingOfTheCard(text);
    expect(text).not.toMatch(/holder|expiry/i);
  });

  it("refuse a discarded card, which still serialises as [redacted card]", () => {
    const card = SensitiveCard.from(input());

    card.discard();

    expect(card.discarded).toBe(true);
    for (const read of [
      () => card.brand(),
      () => card.bin(),
      () => card.last4(),
      () => card.toAmadeusCreditCard(),
      () => card.toRedactedCreditCard(),
    ]) {
      expect(read).toThrow("the card of this request was discarded");
    }
    expect([JSON.stringify(card), `${card}`, inspect(card)]).toEqual([
      JSON.stringify(REDACTED_CARD),
      REDACTED_CARD,
      REDACTED_CARD,
    ]);
  });
});

describe("SensitiveCard.from", () => {
  it("refuses a malformed field by its name, never with its value", () => {
    const cases: Array<[keyof AirlineCardInput, Partial<AirlineCardInput>]> = [
      ["brand", { brand: "visa card" }],
      ["holderName", { holderName: `${TEST_PAN} <script>` }],
      ["number", { number: `${TEST_PAN}x` }],
      ["number", { number: "41111" }],
      ["expiryMonth", { expiryMonth: 13 }],
      ["expiryYear", { expiryYear: 30 }],
      ["securityCode", { securityCode: `${TEST_CVV}45` }],
    ];

    for (const [field, overrides] of cases) {
      let error: unknown;
      try {
        SensitiveCard.from(input(overrides));
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(TypeError);
      const message = (error as TypeError).message;
      expect([field, message]).toEqual([field, `a SensitiveCard needs a well-formed ${field}`]);
      expectNothingOfTheCard(message);
      expect(message).not.toContain(TEST_CVV);
    }
  });
});
