// The pure parts of the `platform-emails` processor (PBE-011; ADR-0009): the only payload `email.send` accepts, and
// when an attempt is the last one BullMQ makes. The processor itself runs against PostgreSQL, Redis and Mailpit in
// test/integration/notifications/email-outbox.int.test.ts.
import { describe, expect, it } from "vitest";
import { emailIdOf, isLastTry } from "./email.processor";
import { idempotentEmailId } from "./outbox.service";

describe("emailIdOf", () => {
  it("accepts { emailId } with a generated or derived e-mail id, and nothing else", () => {
    const derived = idempotentEmailId("tenant.welcome", "ana@example.com", "job_1");

    expect(emailIdOf({ emailId: "eml_01JTESTPR0CESS0R0000000000" })).toBe("eml_01JTESTPR0CESS0R0000000000");
    expect(emailIdOf({ emailId: derived })).toBe(derived);
    for (const data of [
      undefined,
      null,
      "eml_01JTESTPR0CESS0R0000000000",
      [],
      {},
      { emailId: "ten_01JTESTPR0CESS0R0000000000" },
      { emailId: "eml_short" },
      { emailId: "eml_01JTESTPR0CESS0R0000000000", verifyUrl: "https://platform.example.com/x?token=t" },
    ]) {
      expect(emailIdOf(data)).toBeUndefined();
    }
  });
});

describe("isLastTry", () => {
  it("is true on the fifth of five attempts, and for a job with one attempt", () => {
    expect([0, 1, 2, 3, 4].map((attemptsMade) => isLastTry({ attemptsMade, opts: { attempts: 5 } }))).toEqual(
      [false, false, false, false, true],
    );
    expect(isLastTry({ attemptsMade: 0, opts: {} })).toBe(true);
  });
});
