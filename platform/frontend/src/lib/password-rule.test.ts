import { describe, expect, it } from "vitest";

import {
  codePoints,
  meetsPasswordRule,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordFieldMessage,
} from "@/lib/password-rule";
import { SIGN_UP_STRINGS } from "@/lib/strings";

describe("the password rule of every portal account (lib/password-rule.ts)", () => {
  it("[FIX-W48-PLATFORM AC1] asks for 12 code points with a letter and a digit, as the API does", () => {
    expect([PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]).toEqual([12, 256]);
    expect(meetsPasswordRule("Copper-Lan4!")).toBe(true);
    expect(meetsPasswordRule("ÅÄÖ-жизнь-7-ü")).toBe(true);
    expect(meetsPasswordRule("🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂a1")).toBe(true);
    for (const weak of ["", "Fjord-La4", "Fjord-Lan4!", "Kettle-Morning!", "4815-1623-42", "🙂abcdefgh12"]) {
      expect(meetsPasswordRule(weak), weak).toBe(false);
    }
    // Code points, not UTF-16 units: six emoji are twelve units but six characters.
    expect(codePoints("🙂🙂🙂🙂🙂🙂")).toBe(6);
  });

  it("[FIX-W48-PLATFORM AC1] reads the API's field codes in the portal's words, and none it does not know", () => {
    expect(passwordFieldMessage("password_rule")).toBe(SIGN_UP_STRINGS.passwordRule);
    expect(passwordFieldMessage("minLength")).toBe(SIGN_UP_STRINGS.passwordRule);
    expect(passwordFieldMessage("breached")).toBe(SIGN_UP_STRINGS.passwordBreached);
    expect(passwordFieldMessage("maxLength")).toBe(SIGN_UP_STRINGS.passwordTooLong);
    // FIX-W47-PLATFORM's codes are no longer answered; the callers show their general message for them.
    for (const code of ["too_short", "privileged_rule", "something_else", undefined]) {
      expect(passwordFieldMessage(code), String(code)).toBeUndefined();
    }
  });
});
