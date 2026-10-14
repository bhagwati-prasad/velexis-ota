import { ERROR_CATALOGUE, PLATFORM_ERROR_CODES } from "@velexis/errors";
import { describe, expect, it } from "vitest";

import { errorMessage, isPlatformErrorCode } from "./errors";
import { ERROR_MESSAGES, UNKNOWN_ERROR_MESSAGE } from "./strings";

describe("error messages", () => {
  it("[PFE-002 AC3] every code of the generated platform catalogue has a message", () => {
    const missing = PLATFORM_ERROR_CODES.filter(
      (code) => typeof ERROR_MESSAGES[code] !== "string" || ERROR_MESSAGES[code].trim() === "",
    );

    expect(PLATFORM_ERROR_CODES.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it("[PFE-002 AC3] has no message for a code outside the platform catalogue", () => {
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual([...PLATFORM_ERROR_CODES].sort());
  });

  it("[PFE-002 AC3] maps every platform code to its own message", () => {
    for (const code of PLATFORM_ERROR_CODES) {
      expect(errorMessage(code)).toBe(ERROR_MESSAGES[code]);
      expect(errorMessage({ code })).toBe(ERROR_MESSAGES[code]);
      expect(isPlatformErrorCode(code)).toBe(true);
    }
  });

  it("messages are whole sentences and never ask for an internal detail", () => {
    for (const code of PLATFORM_ERROR_CODES) {
      const message = ERROR_MESSAGES[code];
      expect(message, code).toMatch(/^[A-Z].*\.$/);
      expect(message, code).not.toMatch(/requestId|Retry-After|Idempotency-Key|If-Match|\{|\}/);
    }
  });

  it("does not show the API's catalogue text, which is written for developers", () => {
    const developerTexts = PLATFORM_ERROR_CODES.filter(
      (code) => ERROR_MESSAGES[code] === ERROR_CATALOGUE[code].description,
    );

    expect(developerTexts).toEqual([]);
  });

  it.each(["PRICE_CHANGED", "NOT_A_CODE", "toString", "__proto__", "constructor", ""])(
    "falls back to a generic message for %j",
    (code) => {
      expect(isPlatformErrorCode(code)).toBe(false);
      expect(errorMessage(code)).toBe(UNKNOWN_ERROR_MESSAGE);
      expect(errorMessage({ code })).toBe(UNKNOWN_ERROR_MESSAGE);
    },
  );

  it("is frozen", () => {
    expect(Object.isFrozen(ERROR_MESSAGES)).toBe(true);
  });
});
