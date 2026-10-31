"use server";

import type { components } from "@velexis/api-types/platform";
import type { PlatformErrorCode } from "@velexis/errors";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { platformApi, type ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { COUNTRY_CODES, CURRENCY_CODES } from "@/lib/reference-options";
import { otaPath } from "@/lib/roles";
import { PAYOUT_ACCOUNT_STRINGS } from "@/lib/strings";
import { isTenantId } from "@/lib/tenant";

/**
 * The server action of the payout account page (README §2 `/otas/[tenantId]/payments/payout-account`;
 * flows/stripe-payments-account.md §B; PF-64). `savePayoutAccount` checks the form with the rules of the platform
 * document's `SetPayoutAccountRequest` (and the IBAN's mod-97 checksum, as the API does), then calls
 * `setPayoutAccount` (`PUT /v1/tenants/{tenantId}/payout-account`) with the session. The operation needs a TOTP
 * step-up within the last 15 minutes: `REAUTH_REQUIRED` answers `stepUp`, and `useStepUpAction` sends the same form
 * again after the code. Owners may call it; the API refuses other roles with `403` all the same.
 *
 * The bank identifiers (IBAN, BIC, account and routing numbers) are write-only: they go to the API and nowhere else.
 * The action never returns them in its state, never logs them and never puts them in an error; a refused submission
 * keeps them only in the browser form's own fields. Its answer is the masked account (`last4`), the API's answer. It
 * returns the portal's own text only, never the API's.
 */

type PayoutAccount = components["schemas"]["PayoutAccount"];
type SetPayoutAccountRequest = components["schemas"]["SetPayoutAccountRequest"];

/** How the bank identifies the account (`PayoutScheme`). */
export type PayoutScheme = components["schemas"]["PayoutScheme"];

/** The fields of the form, in form order. */
export type PayoutField =
  | "accountHolderName"
  | "countryCode"
  | "currency"
  | "scheme"
  | "iban"
  | "bic"
  | "accountNumber"
  | "routingNumber";

/** The fields whose values come back in the state: none of them is a bank identifier. */
export interface PayoutValues {
  readonly accountHolderName: string;
  readonly countryCode: string;
  readonly currency: string;
  readonly scheme: PayoutScheme;
}

/** What the form shows after a submission. */
export interface PayoutState {
  readonly status: "idle" | "saved" | "failed";
  /** The error code of a failure, for tests; never shown. */
  readonly code?: PlatformErrorCode;
  /** The holder, country, currency and scheme the fields show: the saved ones after a save, what was sent otherwise. */
  readonly values: PayoutValues;
  /** The problem of each field, in the portal's own words. */
  readonly fieldErrors: Readonly<Partial<Record<PayoutField, string>>>;
  /** A problem that belongs to no field (step-up cancelled, MFA off, feature off, rate limit, API unavailable). */
  readonly message?: string;
  /** The page is out of date: the form offers "Reload the page". */
  readonly reload?: true;
  /** The saved account as the API answered it, masked (`last4` only). */
  readonly account?: PayoutAccount;
  /** The API asked for a step-up (`REAUTH_REQUIRED`): `useStepUpAction` opens the dialog. */
  readonly stepUp?: true;
}

const PROBLEMS = PAYOUT_ACCOUNT_STRINGS.problems;

/** A text field of the submission; a file or a missing field reads as empty. */
function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** `PayoutAccountHolderName`: 1 to 200 characters, counted in code points as the API's validator counts them. */
const HOLDER_MAX_LENGTH = 200;

/** A normalised IBAN (iban.ts of the API): country code, check digits and 11 to 30 letters or digits. */
const NORMALISED_IBAN = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/;
/** `Bic` of the document: 8 or 11 characters. */
const BIC = /^[A-Za-z]{6}[A-Za-z0-9]{2}([A-Za-z0-9]{3})?$/;
/** `BankAccountNumber` and `BankRoutingNumber` of the document (their lengths apart). */
const NATIONAL_NUMBER = /^[A-Za-z0-9][A-Za-z0-9 -]*$/;

/** The IBAN as the API stores it: without spaces (or other white space), upper case. */
function normaliseIban(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/**
 * The IBAN's mod-97 check (ISO 7064 MOD 97-10), as the API's iban.ts runs it: check digits from 02 to 98, and the
 * first four characters moved to the end, each letter replaced by two digits (A = 10 … Z = 35), modulo 97 is 1.
 * `iban` is normalised and has the shape of `NORMALISED_IBAN`.
 */
function ibanChecksumHolds(iban: string): boolean {
  const checkDigits = Number(iban.slice(2, 4));
  if (checkDigits < 2 || checkDigits > 98) {
    return false;
  }
  let remainder = 0;
  for (const character of `${iban.slice(4)}${iban.slice(0, 4)}`) {
    const code = character.charCodeAt(0);
    // "0"–"9" are 48–57, "A"–"Z" 65–90: a letter adds two digits (10–35), a digit one.
    const digits = code <= 57 ? String(code - 48) : String(code - 55);
    for (const digit of digits) {
      remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
  }
  return remainder === 1;
}

/** The letters and digits of a national number. */
function alphanumerics(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "");
}

const COUNTRIES: ReadonlySet<string> = new Set(COUNTRY_CODES);
const CURRENCIES: ReadonlySet<string> = new Set(CURRENCY_CODES);

function isScheme(value: string): value is PayoutScheme {
  return value === "iban" || value === "local";
}

/** The values of a submission that come back in the state (a forged scheme reads as `iban`). */
function valuesOf(formData: FormData): PayoutValues {
  const scheme = text(formData, "scheme");
  return {
    accountHolderName: text(formData, "accountHolderName"),
    countryCode: text(formData, "countryCode"),
    currency: text(formData, "currency"),
    scheme: isScheme(scheme) ? scheme : "iban",
  };
}

/** The checked request body, or the problem of each field (in form order). */
type Checked =
  | { readonly body: SetPayoutAccountRequest; readonly fieldErrors?: undefined }
  | { readonly body?: undefined; readonly fieldErrors: Partial<Record<PayoutField, string>> };

/**
 * Checks a submission with the rules of `SetPayoutAccountRequest` and the API's own (a holder that is not blank, the
 * IBAN's checksum, an account number with 4 letters or digits) and builds the body: the holder trimmed, the IBAN
 * normalised, the BIC upper-cased (left out when empty), the national numbers trimmed. No problem holds a value.
 */
function check(formData: FormData): Checked {
  const fieldErrors: Partial<Record<PayoutField, string>> = {};
  const holder = text(formData, "accountHolderName").trim();
  const countryCode = text(formData, "countryCode");
  const currency = text(formData, "currency");
  const scheme = text(formData, "scheme");

  if (holder === "") {
    fieldErrors.accountHolderName = PROBLEMS.holderRequired;
  } else if ([...holder].length > HOLDER_MAX_LENGTH) {
    fieldErrors.accountHolderName = PROBLEMS.holderTooLong;
  }
  if (!COUNTRIES.has(countryCode)) {
    fieldErrors.countryCode = PROBLEMS.country;
  }
  if (!CURRENCIES.has(currency)) {
    fieldErrors.currency = PROBLEMS.currency;
  }
  if (!isScheme(scheme)) {
    fieldErrors.scheme = PROBLEMS.scheme;
    return { fieldErrors };
  }

  if (scheme === "iban") {
    const iban = normaliseIban(text(formData, "iban"));
    const bic = text(formData, "bic").trim();
    if (iban === "") {
      fieldErrors.iban = PROBLEMS.ibanRequired;
    } else if (!NORMALISED_IBAN.test(iban)) {
      fieldErrors.iban = PROBLEMS.ibanFormat;
    } else if (!ibanChecksumHolds(iban)) {
      fieldErrors.iban = PROBLEMS.ibanChecksum;
    }
    if (bic !== "" && !BIC.test(bic)) {
      fieldErrors.bic = PROBLEMS.bicFormat;
    }
    if (Object.keys(fieldErrors).length > 0) {
      return { fieldErrors };
    }
    return {
      body: {
        accountHolderName: holder,
        countryCode,
        currency,
        scheme,
        iban,
        ...(bic === "" ? {} : { bic: bic.toUpperCase() }),
      },
    };
  }

  const accountNumber = text(formData, "accountNumber").trim();
  const routingNumber = text(formData, "routingNumber").trim();
  if (accountNumber === "") {
    fieldErrors.accountNumber = PROBLEMS.accountNumberRequired;
  } else if (
    accountNumber.length > 34 ||
    !NATIONAL_NUMBER.test(accountNumber) ||
    alphanumerics(accountNumber).length < 4
  ) {
    fieldErrors.accountNumber = PROBLEMS.accountNumberFormat;
  }
  if (routingNumber === "") {
    fieldErrors.routingNumber = PROBLEMS.routingNumberRequired;
  } else if (routingNumber.length < 3 || routingNumber.length > 20 || !NATIONAL_NUMBER.test(routingNumber)) {
    fieldErrors.routingNumber = PROBLEMS.routingNumberFormat;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }
  return { body: { accountHolderName: holder, countryCode, currency, scheme, accountNumber, routingNumber } };
}

/** The fields each scheme sends, besides the holder, country and currency. */
const SCHEME_FIELDS: Readonly<Record<PayoutScheme, readonly PayoutField[]>> = {
  iban: ["iban", "bic"],
  local: ["accountNumber", "routingNumber"],
};

/**
 * Codes of the request validation that say nothing about the value of a field the form sent. `setPayoutAccount` takes
 * one of two shapes (`oneOf`), and the validator reports every rule of the shape that was not sent too: the IBAN as a
 * field the local shape does not allow, its missing account number, the other `scheme` constant.
 */
const STRUCTURAL_CODES: ReadonlySet<string> = new Set([
  "required",
  "additionalProperties",
  "unevaluatedProperties",
  "const",
  "oneOf",
  "anyOf",
]);

/** The portal's message for an API field error on `field`, by its code (the JSON Schema keyword or the API's rule). */
function apiFieldMessage(field: PayoutField, code: string): string {
  switch (field) {
    case "accountHolderName":
      return code === "maxLength" ? PROBLEMS.holderTooLong : PROBLEMS.holderRequired;
    case "countryCode":
      return PROBLEMS.country;
    case "currency":
      return PROBLEMS.currency;
    case "scheme":
      return PROBLEMS.scheme;
    case "iban":
      return code === "iban_checksum" ? PROBLEMS.ibanChecksum : PROBLEMS.ibanFormat;
    case "bic":
      return PROBLEMS.bicFormat;
    case "accountNumber":
      return PROBLEMS.accountNumberFormat;
    case "routingNumber":
      return PROBLEMS.routingNumberFormat;
  }
}

/**
 * The API's field errors on the fields the form sent, in the portal's words (the first one of each field); empty when
 * none is about such a field (a path the form has no field for reads as an expired form).
 */
function apiFieldErrors(error: ApiError, scheme: PayoutScheme): Partial<Record<PayoutField, string>> {
  const sent: readonly PayoutField[] = [
    "accountHolderName",
    "countryCode",
    "currency",
    ...SCHEME_FIELDS[scheme],
  ];
  const fieldErrors: Partial<Record<PayoutField, string>> = {};
  for (const fieldError of error.fieldErrors) {
    if (STRUCTURAL_CODES.has(fieldError.code)) {
      continue;
    }
    const field = sent.find((candidate) => fieldError.path === `/${candidate}`);
    if (field !== undefined && fieldErrors[field] === undefined) {
      fieldErrors[field] = apiFieldMessage(field, fieldError.code);
    }
  }
  return fieldErrors;
}

/** The messages of a refused `setPayoutAccount` that belong to no field, and whether they ask for a reload. */
const FAILURES: Readonly<Partial<Record<PlatformErrorCode, { message: string; reload?: true }>>> = {
  REAUTH_REQUIRED: { message: PAYOUT_ACCOUNT_STRINGS.stepUpCancelled },
  MFA_REQUIRED: { message: PAYOUT_ACCOUNT_STRINGS.mfaRequired },
  FEATURE_DISABLED: { message: PAYOUT_ACCOUNT_STRINGS.featureDisabled },
  FORBIDDEN: { message: PAYOUT_ACCOUNT_STRINGS.forbidden, reload: true },
  NOT_FOUND: { message: PAYOUT_ACCOUNT_STRINGS.removed, reload: true },
  VALIDATION_FAILED: { message: PAYOUT_ACCOUNT_STRINGS.formExpired, reload: true },
  RATE_LIMITED: { message: PAYOUT_ACCOUNT_STRINGS.rateLimited },
};

/**
 * Sets or replaces the OTA's payout account from the form's fields `accountHolderName`, `countryCode`, `currency`,
 * `scheme` and either `iban` (and `bic`) or `accountNumber` and `routingNumber`, with the hidden `tenantId`. Returns
 * the masked account the API answered (back in `pending_review` after a change, or as it was when the stored account
 * was typed again), or the problems; the page is revalidated after a save, so its masked view shows the new account.
 */
export async function savePayoutAccount(_previous: PayoutState, formData: FormData): Promise<PayoutState> {
  const tenantId = text(formData, "tenantId");
  const values = valuesOf(formData);
  const failed = (
    code: PlatformErrorCode,
    problem: {
      fieldErrors?: Partial<Record<PayoutField, string>>;
      message?: string;
      reload?: true;
      stepUp?: true;
    },
  ): PayoutState => ({ status: "failed", code, values, fieldErrors: {}, ...problem });

  if (!isTenantId(tenantId)) {
    // The form always carries it; without it the save could not name its OTA.
    return failed("VALIDATION_FAILED", { message: PAYOUT_ACCOUNT_STRINGS.formExpired, reload: true });
  }
  const checked = check(formData);
  if (checked.body === undefined) {
    return failed("VALIDATION_FAILED", { fieldErrors: checked.fieldErrors });
  }

  const api = await platformApi();
  const result = await api.PUT("/v1/tenants/{tenantId}/payout-account", {
    params: { path: { tenantId } },
    body: checked.body,
  });
  if (result.error !== undefined) {
    const { code } = result.error;
    if (code === "UNAUTHENTICATED" || code === "TOKEN_EXPIRED") {
      // The session ended (the middleware renews an access token that is only expired): sign in again.
      redirect(
        `/sign-in?${new URLSearchParams({ next: otaPath(tenantId, "/payments/payout-account") }).toString()}`,
      );
    }
    if (code === "EMAIL_NOT_VERIFIED") {
      redirect("/verify-pending");
    }
    if (code === "VALIDATION_FAILED") {
      const fieldErrors = apiFieldErrors(result.error, checked.body.scheme);
      if (Object.keys(fieldErrors).length > 0) {
        return failed(code, { fieldErrors });
      }
    }
    const failure = FAILURES[code] ?? { message: errorMessage(result.error) };
    return failed(code, code === "REAUTH_REQUIRED" ? { ...failure, stepUp: true } : failure);
  }

  // The masked view of the page shows the saved account and its review status: render the page again.
  revalidatePath(otaPath(tenantId, "/payments/payout-account"));
  const account = result.data;
  return {
    status: "saved",
    values: {
      accountHolderName: account.accountHolderName,
      countryCode: account.countryCode,
      currency: account.currency,
      scheme: account.scheme,
    },
    fieldErrors: {},
    account,
  };
}
