// The pure rules of the settlement review (PBE-060; PADR-0003 item 7 and its note of 2026-10-30): the approval's check
// that a draft's `carry_forward` line holds exactly the carried-forward balances it absorbs now, read from the text the
// generator writes (settlement-generator.ts `carryForwardLine`, so a change of that text fails here first), and the
// opaque cursors of the admin's lists. No database: the approval's locks and refusals are in
// test/integration/settlements/settlement-review.int.test.ts.
import { describe, expect, it } from "vitest";
import { carryForwardLine, settlementPeriod } from "./settlement-generator";
import {
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
