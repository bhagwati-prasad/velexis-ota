import { describe, expect, it } from "vitest";

import {
  MALFORMED_ANSWER,
  OTPAUTH_URL,
  pendingSetupOf,
  RECOVERY_CODE_COUNT,
  recoveryCodesOf,
  TOTP_CODE,
  TOTP_SECRET,
} from "@/lib/mfa-checks";
import { QR_MAX_TEXT_LENGTH, qrCode } from "@/lib/qr";

// The checks both MFA pages share (FIX-W46-PLATFORM, lead decision (11c)): security.test.tsx and
// mfa-enrolment.test.tsx run them through their actions; these tests pin the rules themselves. Dummies only: no real
// secret, URI or recovery code.

/** A pending secret and its URI as `startMfaSetup` answers them (base32 letters only). */
const SECRET = "FIXWFOURSIXDUMMYSECRETNEVERREAL";
const URI = `otpauth://totp/Velexis:anna.berg%40example.com?secret=${SECRET}&issuer=Velexis`;

/** Ten recovery codes of the document's shape (Crockford base32: no I, L, O or U). */
const CODES = Array.from({ length: RECOVERY_CODE_COUNT }, (_, index) => `FX0${index}-7D7M-MYRC-0DE${index}`);

describe("lib/mfa-checks.ts", () => {
  it("[FIX-W46-PLATFORM AC3] takes a setup answer of the document's MfaSetup, with its QR code made here", () => {
    expect(pendingSetupOf({ secret: SECRET, otpauthUrl: URI, expiresIn: 600 })).toEqual({
      secret: SECRET,
      qr: qrCode(URI),
      expiresIn: 600,
    });
    // Base32 padding, and a URI exactly as long as a QR code may hold.
    const padded = `${SECRET}A=`;
    const longest = `${URI}&x=${"a".repeat(QR_MAX_TEXT_LENGTH - URI.length - 3)}`;
    expect(longest).toHaveLength(QR_MAX_TEXT_LENGTH);
    expect(pendingSetupOf({ secret: padded, otpauthUrl: longest, expiresIn: 1 })?.secret).toBe(padded);
  });

  it("[FIX-W46-PLATFORM AC3] refuses a setup answer that is not the document's, whole", () => {
    const answer = { secret: SECRET, otpauthUrl: URI, expiresIn: 600 };
    for (const broken of [
      { ...answer, secret: SECRET.toLowerCase() },
      { ...answer, secret: `${SECRET}1` },
      { ...answer, secret: "" },
      { ...answer, otpauthUrl: "https://evil.example/qr" },
      { ...answer, otpauthUrl: URI.replace("otpauth://totp/", "otpauth://hotp/") },
      { ...answer, otpauthUrl: `${URI}&x=${"a".repeat(QR_MAX_TEXT_LENGTH)}` },
      { ...answer, expiresIn: 0 },
      { ...answer, expiresIn: 1.5 },
      { ...answer, expiresIn: Number.NaN },
    ]) {
      expect(pendingSetupOf(broken)).toBeUndefined();
    }
    // Answers are not validated at run time: a field of another type, or no object at all, is refused too, even where
    // its text would pass the pattern (the number 234567 reads as base32, a one-element array as its URI).
    for (const broken of [
      { ...answer, secret: 234567 },
      { ...answer, otpauthUrl: [URI] },
      { ...answer, expiresIn: "600" },
      { secret: SECRET, expiresIn: 600 },
      null,
      undefined,
      SECRET,
    ]) {
      expect(pendingSetupOf(broken as never)).toBeUndefined();
    }
    expect(TOTP_SECRET.test(SECRET)).toBe(true);
    expect(OTPAUTH_URL.test(URI)).toBe(true);
    // What the actions answer instead: the general error, nothing of the answer.
    expect(MALFORMED_ANSWER).toEqual({ code: "INTERNAL_ERROR", status: 500, fieldErrors: [], details: {} });
    expect(Object.isFrozen(MALFORMED_ANSWER)).toBe(true);
  });

  it("[FIX-W46-PLATFORM AC3] takes exactly ten recovery codes of the document's format, frozen", () => {
    const codes = recoveryCodesOf([...CODES]);
    expect(codes).toEqual(CODES);
    expect(Object.isFrozen(codes)).toBe(true);
  });

  it("[FIX-W46-PLATFORM AC3] refuses recovery codes that are not the document's RecoveryCodes", () => {
    for (const broken of [
      CODES.slice(1),
      [...CODES, CODES[0]],
      [...CODES.slice(1), "fx00-7d7m-myrc-0de0"],
      [...CODES.slice(1), "FX0I-7D7M-MYRC-0DE0"],
      [...CODES.slice(1), "FX00-7D7M-MYRC"],
      [...CODES.slice(1), "FX007D7MMYRC0DE0"],
      [...CODES.slice(1), 1234],
      [...CODES.slice(1), null],
      "FX00-7D7M-MYRC-0DE0",
      undefined,
      {},
    ]) {
      expect(recoveryCodesOf(broken)).toBeUndefined();
    }
  });

  it("[FIX-W46-PLATFORM AC3] reads a typed code as the document's TotpCode, spaces dropped", () => {
    expect(TOTP_CODE.safeParse("492039").data).toBe("492039");
    expect(TOTP_CODE.safeParse(" 492 039 ").data).toBe("492039");
    for (const typed of ["49203", "4920399", "49203a", "", "４９２０３９"]) {
      expect(TOTP_CODE.safeParse(typed).success).toBe(false);
    }
  });
});
