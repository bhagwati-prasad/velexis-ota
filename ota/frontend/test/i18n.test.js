// lib/i18n.js (ota/frontend/README.md §7): English UI strings with `{name}` placeholders, plural forms chosen with
// Intl.PluralRules, and field-error messages by code that never repeat the rejected value.
import { describe, expect, it } from "vitest";

import { LANGUAGE, STRINGS, fieldErrorMessage, hasString, t } from "../src/lib/i18n.js";

describe("t", () => {
  it("[OFE-002 AC1] picks plural forms with Intl.PluralRules", () => {
    expect(t("results.count", { count: 0 })).toBe("0 flights");
    expect(t("results.count", { count: 1 })).toBe("1 flight");
    expect(t("results.count", { count: 2 })).toBe("2 flights");
    expect(t("results.count", { count: 1234 })).toBe("1,234 flights");
    expect(t("form.errorSummary.title", { count: 1 })).toBe("There is 1 problem");
    expect(t("form.errorSummary.title", { count: 3 })).toBe("There are 3 problems");
  });

  it("[OFE-002 AC1] fills placeholders as plain text and keeps unknown keys and placeholders visible", () => {
    expect(t("duration.hoursMinutes", { hours: 7, minutes: 35 })).toBe("7 h 35 min");
    expect(t("duration.hours", { hours: "<b>2</b>" })).toBe("<b>2</b> h");
    expect(t("duration.hours")).toBe("{hours} h");
    expect(t("no.such.key")).toBe("no.such.key");
    expect(t("toString")).toBe("toString");
    expect(hasString("app.loading")).toBe(true);
    expect(hasString("constructor")).toBe(false);
  });

  it("[OFE-002 AC1] holds English strings only, each plural entry with both forms", () => {
    expect(LANGUAGE).toBe("en");
    expect(Object.isFrozen(STRINGS)).toBe(true);
    for (const [key, entry] of Object.entries(STRINGS)) {
      if (typeof entry === "string") {
        expect(entry.trim(), key).not.toBe("");
      } else {
        expect(Object.keys(entry).sort(), key).toEqual(["one", "other"]);
      }
    }
  });
});

describe("fieldErrorMessage", () => {
  it("[OFE-002 AC1] gives a message by code and never the API's text or the value", () => {
    expect(fieldErrorMessage({ code: "required" })).toBe("Fill in this field");
    expect(fieldErrorMessage({ code: "luhn" })).toBe("Check the card number");
    expect(fieldErrorMessage({ code: "expired" })).toBe("The card has expired");
    expect(fieldErrorMessage({ code: "somethingNew", message: "4111 1111 1111 1111 is wrong" })).toBe(
      "Check this field",
    );
    expect(fieldErrorMessage({ code: undefined })).toBe("Check this field");
  });

  it("[OFE-002 AC1] has a message for every TravelerFieldErrorCode of the OTA API", () => {
    // The enum of components.schemas.TravelerFieldErrorCode (ota/backend/openapi), checked by name here so that a new
    // code shows up in review with its English text.
    const codes = [
      "REQUIRED",
      "INVALID_FORMAT",
      "INVALID_CHARACTERS",
      "NAME_TOO_LONG",
      "AGE_MISMATCH_TRAVELER_TYPE",
      "INFANT_OLDER_THAN_ADULT",
      "UNKNOWN_TRAVELER_ID",
      "DUPLICATE_TRAVELER",
      "SAVED_TRAVELER_NOT_FOUND",
      "DOCUMENT_EXPIRED",
      "DOCUMENT_EXPIRES_BEFORE_RETURN",
      "DOCUMENT_TYPE_NOT_ACCEPTED",
      "DISCOUNT_DATA_REQUIRED",
      "EMAIL_INVALID",
      "PHONE_INVALID",
      "MOBILE_PHONE_REQUIRED",
      "COUNTRY_CALLING_CODE_REQUIRED",
      "PRIMARY_CONTACT_REQUIRED",
      "INVOICE_ADDRESS_REQUIRED",
      "POSTAL_CODE_REQUIRED",
      "TOO_MANY_CONTACTS",
      "REJECTED_BY_AIRLINE",
    ];
    for (const code of codes) {
      expect(hasString(`field.${code}`), code).toBe(true);
    }
    expect(fieldErrorMessage({ code: "DOCUMENT_EXPIRES_BEFORE_RETURN" })).toBe(
      "This document expires before the last flight",
    );
  });
});
