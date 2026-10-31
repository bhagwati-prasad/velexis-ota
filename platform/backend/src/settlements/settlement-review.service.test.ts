// The pure rules of the settlement review (PBE-060; PADR-0003 item 7 and its note of 2026-10-30): the approval's check
// that a draft's `carry_forward` line holds exactly the carried-forward balances it absorbs now, read from the text the
// generator writes (settlement-generator.ts `carryForwardLine`, so a change of that text fails here first), the
// opaque cursors of the admin's lists, and an adjustment's decimals against its currency's exponent (FIX-W37-PLATFORM,
// lead decision (2j) of 2026-10-31). No database: the approval's locks and refusals, and the adjustment's refusal
// through HTTP, are in test/integration/settlements/settlement-review.int.test.ts.
import { isAppError, toErrorEnvelope } from "@velexis/errors";
import { describe, expect, it } from "vitest";
import { carryForwardLine, settlementPeriod } from "./settlement-generator";
import {
  amountPrecisionError,
  carryForwardMatches,
  decodeIdCursor,
  encodeIdCursor,
  namedStatementIds,
} from "./settlement-review.service";
import type { CarriedForwardStatement } from "./settlements.repository";

// Test ids in the platform's form (`stl_` and 26 Crockford base32 characters).
const SEPTEMBER: CarriedForwardStatement = {
  id: "stl_01JC7T1V5X9Z3B7D1F5H9K3N7Q",
  period_start: new Date("2026-09-01T00:00:00.000Z"),
  net_amount: "-50.00",
};
const AUGUST: CarriedForwardStatement = {
  id: "stl_01JB2K4M8P2R6T0W4Y8A2C6E0G",
  period_start: new Date("2026-08-01T00:00:00.000Z"),
  net_amount: "-12.35",
};
const OCTOBER = settlementPeriod(new Date("2026-10-01T00:00:00.000Z"));

/** The `carry_forward` line the generator writes for a draft of October that absorbs `statements`. */
function generatedLine(statements: readonly CarriedForwardStatement[]): {
  amount: string;
  description: string | null;
} {
  const line = carryForwardLine(statements, OCTOBER);
  if (line === undefined) {
    throw new Error("the generator wrote no carry_forward line");
  }
  return { amount: line.amount, description: line.description };
}

describe("namedStatementIds", () => {
  it("[PBE-060 AC1] reads the statements the generator names in a carry_forward line, in its order", () => {
    expect(namedStatementIds(generatedLine([AUGUST, SEPTEMBER]).description)).toEqual([
      AUGUST.id,
      SEPTEMBER.id,
    ]);
    expect(namedStatementIds(generatedLine([SEPTEMBER]).description)).toEqual([SEPTEMBER.id]);
    expect(namedStatementIds(null)).toEqual([]);
    expect(namedStatementIds("Balance carried forward from 2026-09 (stl_not-an-id)")).toEqual([]);
  });
});

describe("carryForwardMatches", () => {
  it("[PBE-060 AC1] accepts the line the generator writes for exactly the balances the draft absorbs now", () => {
    const line = generatedLine([AUGUST, SEPTEMBER]);

    expect(carryForwardMatches([line], [AUGUST, SEPTEMBER])).toBe(true);
    // The order of the statements does not matter.
    expect(carryForwardMatches([line], [SEPTEMBER, AUGUST])).toBe(true);
    // No line and nothing to absorb.
    expect(carryForwardMatches([], [])).toBe(true);
    // A balance of zero is still named, with an amount of zero.
    const zero = { ...SEPTEMBER, net_amount: "0.00" };
    expect(carryForwardMatches([generatedLine([zero])], [zero])).toBe(true);
  });

  it("[PBE-060 AC1] refuses a line that names another set of balances than the draft absorbs now", () => {
    const both = generatedLine([AUGUST, SEPTEMBER]);
    const september = generatedLine([SEPTEMBER]);

    // Another statement absorbed August since the draft was generated.
    expect(carryForwardMatches([both], [SEPTEMBER])).toBe(false);
    // August was carried forward after the draft was generated.
    expect(carryForwardMatches([september], [AUGUST, SEPTEMBER])).toBe(false);
    // A balance the draft no longer absorbs at all, and a draft without the line it needs.
    expect(carryForwardMatches([september], [])).toBe(false);
    expect(carryForwardMatches([], [SEPTEMBER])).toBe(false);
  });

  it("[PBE-060 AC1] refuses a balance named twice and an amount that is not the balances' net", () => {
    const september = generatedLine([SEPTEMBER]);

    // Two lines naming one statement count its balance twice, even when the ids alone would match.
    expect(carryForwardMatches([september, september], [SEPTEMBER])).toBe(false);
    // ... and even when the count of names and the amounts add up: August is not named at all.
    const twice = [september, { ...september, amount: AUGUST.net_amount }];
    expect(carryForwardMatches(twice, [AUGUST, SEPTEMBER])).toBe(false);
    expect(carryForwardMatches([{ ...september, amount: "-49.99" }], [SEPTEMBER])).toBe(false);
    expect(carryForwardMatches([{ ...september, amount: "50.00" }], [SEPTEMBER])).toBe(false);
    // The amounts are compared as decimals, not as text.
    expect(carryForwardMatches([{ ...september, amount: "-50.0" }], [SEPTEMBER])).toBe(true);
  });
});

describe("the cursors of the admin's lists", () => {
  const SETTLEMENT_ID = /^stl_[0-9A-HJKMNP-TV-Z]{26}$/;

  it("decodes what it encodes, and nothing else", () => {
    const cursor = encodeIdCursor(SEPTEMBER.id);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeIdCursor(cursor, SETTLEMENT_ID)).toBe(SEPTEMBER.id);
    // Another kind of id, extra keys, other JSON, not base64url, and an empty cursor are no cursor of the list.
    expect(decodeIdCursor(encodeIdCursor("sln_01JD9X1B2C3D4E5F6G7H8J9K0M"), SETTLEMENT_ID)).toBeUndefined();
    const extra = Buffer.from(JSON.stringify({ id: SEPTEMBER.id, at: 1 }), "utf8").toString("base64url");
    expect(decodeIdCursor(extra, SETTLEMENT_ID)).toBeUndefined();
    for (const json of ["[1]", "null", '"stl_01JC7T1V5X9Z3B7D1F5H9K3N7Q"', "{"]) {
      expect(
        decodeIdCursor(Buffer.from(json, "utf8").toString("base64url"), SETTLEMENT_ID),
        json,
      ).toBeUndefined();
    }
    expect(decodeIdCursor("not a cursor", SETTLEMENT_ID)).toBeUndefined();
    expect(decodeIdCursor("", SETTLEMENT_ID)).toBeUndefined();
  });
});

describe("amountPrecisionError", () => {
  /** The `details` of the refusal of `amount` in `currency` with `decimals`, or `undefined` when it passes. */
  const refusal = (amount: string, currency: string, decimals: number): unknown =>
    amountPrecisionError(amount, currency, decimals)?.details;

  it("[FIX-W37-PLATFORM AC4] lets EUR amounts have two decimals and no more", () => {
    for (const amount of ["100", "100.5", "100.50", "-25.50", "0.01", "9999999999.99"]) {
      expect([amount, refusal(amount, "EUR", 2)]).toEqual([amount, undefined]);
    }
    expect(refusal("1.005", "EUR", 2)).toEqual({
      reason: "amount_precision",
      path: "/amount/amount",
      currency: "EUR",
      decimals: 2,
    });
  });

  it("[FIX-W37-PLATFORM AC4] refuses any decimal of a JPY amount, but not trailing zeros", () => {
    for (const amount of ["1500", "-300", "1500.0", "1500.00"]) {
      expect([amount, refusal(amount, "JPY", 0)]).toEqual([amount, undefined]);
    }
    for (const amount of ["1500.5", "1500.50", "-0.01", "0.10"]) {
      expect([amount, refusal(amount, "JPY", 0)]).toEqual([
        amount,
        { reason: "amount_precision", path: "/amount/amount", currency: "JPY", decimals: 0 },
      ]);
    }
  });

  it("[FIX-W37-PLATFORM AC4] lets a three-decimal currency (KWD) have three decimals and refuses a fourth", () => {
    for (const amount of ["12", "12.25", "12.255", "-0.001", "12.2500"]) {
      expect([amount, refusal(amount, "KWD", 3)]).toEqual([amount, undefined]);
    }
    expect(refusal("12.2551", "KWD", 3)).toEqual({
      reason: "amount_precision",
      path: "/amount/amount",
      currency: "KWD",
      decimals: 3,
    });
  });

  it("[FIX-W37-PLATFORM AC4] answers 422 UNPROCESSABLE whose message names the currency's rule, never the amount", () => {
    const yen = amountPrecisionError("1500.5", "JPY", 0);
    const dinar = amountPrecisionError("12.2551", "KWD", 3);

    expect(isAppError(yen) && isAppError(dinar)).toBe(true);
    expect([yen?.code, yen?.status, yen?.message]).toEqual([
      "UNPROCESSABLE",
      422,
      "An amount in JPY has no decimals.",
    ]);
    expect(dinar?.message).toBe("An amount in KWD has at most 3 decimals.");
    // A one-decimal exponent (none in ISO 4217 today, but reference.currencies decides) reads in the singular.
    expect(amountPrecisionError("1.25", "XTS", 1)?.message).toBe("An amount in XTS has at most 1 decimal.");
    // The envelope carries the details (UNPROCESSABLE takes no fieldErrors) and never the refused amount.
    const { status, body } = toErrorEnvelope(yen, "req_01JA2Z9W5K7Q3M8N4P6R2T0V1X", {
      exposeSupplier: false,
    });
    expect(status).toBe(422);
    expect(body.error.details).toEqual({
      reason: "amount_precision",
      path: "/amount/amount",
      currency: "JPY",
      decimals: 0,
    });
    expect(JSON.stringify([body, dinar?.message])).not.toMatch(/1500\.5|12\.2551/);
  });
});
