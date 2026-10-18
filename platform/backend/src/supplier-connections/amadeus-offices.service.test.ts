// The pure rules of the office pool (PBE-020, PADR-0012): the ids of a bulk addition, the list's cursor and the text
// of the pool level alert.
import { describe, expect, it } from "vitest";
import { decodeOfficeCursor, encodeOfficeCursor, officeIdEntries } from "./amadeus-offices.service";
import { poolLevelAlert, POOL_LEVEL_MINIMUM } from "./pool-level.scheduler";

const OFFICE_ROW_ID = "amo_01JATESTRW0000000000000007";

describe("officeIdEntries", () => {
  it("upper-cases every id and marks each repeat of an earlier id, in request order", () => {
    expect(officeIdEntries(["NCE1A0955", "nce1a0955", "PAR1A0001", "par1a0001", "NCE1A0955"])).toEqual([
      { officeId: "NCE1A0955", repeat: false },
      { officeId: "NCE1A0955", repeat: true },
      { officeId: "PAR1A0001", repeat: false },
      { officeId: "PAR1A0001", repeat: true },
      { officeId: "NCE1A0955", repeat: true },
    ]);
  });
});

describe("the office list cursor", () => {
  it("round-trips the last office's row id and refuses anything else", () => {
    expect(decodeOfficeCursor(encodeOfficeCursor(OFFICE_ROW_ID))).toBe(OFFICE_ROW_ID);
    for (const cursor of [
      "",
      "not base64 !",
      Buffer.from("[]").toString("base64url"),
      Buffer.from(JSON.stringify({ id: "ama_01JATESTRW0000000000000007" })).toString("base64url"),
      Buffer.from(JSON.stringify({ id: OFFICE_ROW_ID, more: 1 })).toString("base64url"),
      "x".repeat(513),
    ]) {
      expect(decodeOfficeCursor(cursor), cursor).toBeUndefined();
    }
  });
});

describe("poolLevelAlert", () => {
  it("names the environment, the account and the count, and what to do", () => {
    const alert = poolLevelAlert({
      amadeusAccountId: "ama_01JATESTRW0000000000000001",
      name: "Velexis test",
      environment: "test",
      available: 2,
    });
    expect(alert.title).toBe("Amadeus office pool low (test): 2 available");
    expect(alert.message).toContain('"Velexis test" (ama_01JATESTRW0000000000000001, test)');
    expect(alert.message).toContain(`the minimum is ${POOL_LEVEL_MINIMUM}`);
    expect(alert.title).not.toContain("\n");
  });
});
