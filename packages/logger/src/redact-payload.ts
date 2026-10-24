import { lastFourChars, lastFourDigits } from "./mask.js";
import { REDACT_CENSOR } from "./redact-paths.js";

/** Replaces a reference back to an enclosing object, so the copy is always JSON-serialisable. */
export const CIRCULAR_REFERENCE = "[Circular]";

/**
 * How the value of a key is treated:
 * - `card`: a payment card (`card`, `creditCard`, …), whose `number` keeps its last 4 digits and whose holder and
 *   expiry are dropped;
 * - `formOfPayment`: everything below an Amadeus `formOfPayments` list or nested inside a card, where the holder and
 *   the expiry of a card are dropped at any depth (FIX-W29-SECURITY);
 * - `documents` / `document`: identity documents (`documents`, `document`) and the forms of identification of an
 *   Amadeus flight order (`formOfIdentifications`: passport, identity card or driving licence numbers), whose
 *   `number` keeps its last 4 characters;
 * - `credentialBody`: an MFA or OAuth body (`mfa`, `oauth`), whose `code` and `state` are secrets at any depth;
 * - `plain`: anything else.
 */
type Kind = "plain" | "card" | "formOfPayment" | "documents" | "document" | "credentialBody";

/** Keys are compared in lower case without `-` and `_`, so `security_code` and `X-Api-Key` match too. */
function normalise(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

/** Parents whose `number` is a card number (Amadeus `creditCard`, `virtualCreditCardDetails`). */
const CARD_PARENTS = new Set(["card", "creditcard", "paymentcard", "virtualcreditcarddetails"]);
/** The forms of payment of an Amadeus flight order: everything below them belongs to a payment. */
const FORM_OF_PAYMENT_PARENTS = new Set(["formofpayments"]);
/**
 * Dropped from a card, from anything nested inside one and from anything below a form of payment (FIX-W29-SECURITY,
 * OADR-0004 point 2): the card holder's name and the expiry, as Amadeus spells them (`holder`, `expiryDate`) and as the airline-card completion body
 * does (`holderName`, `expiryMonth`, `expiryYear`). A stored copy of a card keeps at most its brand, BIN and last 4.
 * An identity document's `expiryDate` is not a card's and stays.
 */
const CARD_HOLDER_AND_EXPIRY_KEYS = new Set([
  "holder",
  "holdername",
  "expirydate",
  "expirymonth",
  "expiryyear",
]);
/** Lists of identity documents: Amadeus `documents` and `formOfIdentifications` (FIX-W26-SECURITY). */
const DOCUMENT_LIST_PARENTS = new Set(["documents", "formofidentifications"]);
const DOCUMENT_PARENTS = new Set(["document"]);
/** Parents of an MFA or OAuth body (platform/docs/architecture.md §8), and the keys that are secret below them. */
const CREDENTIAL_BODY_PARENTS = new Set(["mfa", "oauth"]);
const CREDENTIAL_BODY_SECRET_KEYS = new Set(["code", "state"]);

/** Dropped entirely: card security codes and the document fields db README §8 removes. */
const DROPPED_KEYS = new Set(["securitycode", "cvc", "cvv", "cvv2", "birthplace", "issuancelocation"]);

/** Masked to their last 4 characters wherever they appear (Amadeus `discountEligibility`). */
const LAST_FOUR_CHARS_KEYS = new Set(["cardnumber", "certificatenumber"]);

/** Masked to their last 4 digits wherever they appear. */
const LAST_FOUR_DIGITS_KEYS = new Set(["pan", "primaryaccountnumber"]);

/**
 * Replaced by `[REDACTED]`: credentials and every token value (the fragments also catch the platform's `secretKey`,
 * `webhookSecret`, `totpSecret`, `mfaChallengeToken`, `invitationToken` and an e-mail's `secretData`), bank numbers,
 * MFA recovery codes, `otpauth://` URLs and the e-mail links with tokens (`verifyUrl`, `resetUrl`, `acceptUrl`;
 * platform/docs/architecture.md §8).
 */
const SECRET_KEY_FRAGMENTS = ["password", "passphrase", "token", "secret", "apikey"];
const SECRET_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "mfacode",
  "xvelexisedge",
  "stripesignature",
  "iban",
  "accountnumber",
  "recoverycode",
  "recoverycodes",
  "otpauthurl",
  "verifyurl",
  "reseturl",
  "accepturl",
]);

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key) || SECRET_KEY_FRAGMENTS.some((fragment) => key.includes(fragment));
}

function maskScalar(value: unknown, mask: (raw: string | number) => string): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    return mask(value);
  }
  return REDACT_CENSOR;
}

function childKind(key: string, kind: Kind): Kind {
  if (CARD_PARENTS.has(key)) {
    return "card";
  }
  if (DOCUMENT_LIST_PARENTS.has(key)) {
    return "documents";
  }
  if (DOCUMENT_PARENTS.has(key)) {
    return "document";
  }
  // Everything below an MFA or OAuth body stays part of it. Everything below a form of payment, and everything nested
  // inside a card (`formOfPayments[].creditCard.<object>` included), keeps dropping a card's holder and expiry.
  if (kind === "credentialBody" || CREDENTIAL_BODY_PARENTS.has(key)) {
    return "credentialBody";
  }
  return kind === "card" || kind === "formOfPayment" || FORM_OF_PAYMENT_PARENTS.has(key)
    ? "formOfPayment"
    : "plain";
}

/** Whether `key` (normalised) of an object of `kind` is left out of the copy. */
function dropped(key: string, kind: Kind): boolean {
  return (
    DROPPED_KEYS.has(key) ||
    ((kind === "card" || kind === "formOfPayment") && CARD_HOLDER_AND_EXPIRY_KEYS.has(key))
  );
}

function redactEntry(key: string, value: unknown, kind: Kind, ancestors: Set<object>): unknown {
  const normalised = normalise(key);
  if (isSecretKey(normalised)) {
    return REDACT_CENSOR;
  }
  if (kind === "credentialBody" && CREDENTIAL_BODY_SECRET_KEYS.has(normalised)) {
    return REDACT_CENSOR;
  }
  if (normalised === "number" && kind === "card") {
    return maskScalar(value, lastFourDigits);
  }
  if (normalised === "number" && kind === "document") {
    return maskScalar(value, lastFourChars);
  }
  if (LAST_FOUR_CHARS_KEYS.has(normalised)) {
    return maskScalar(value, lastFourChars);
  }
  if (LAST_FOUR_DIGITS_KEYS.has(normalised)) {
    return maskScalar(value, lastFourDigits);
  }
  return redactValue(value, childKind(normalised, kind), ancestors);
}

function redactObject(source: object, kind: Kind, ancestors: Set<object>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (dropped(normalise(key), kind)) {
      continue;
    }
    // defineProperty keeps a `__proto__` key of parsed JSON as data instead of changing the prototype.
    Object.defineProperty(copy, key, {
      value: redactEntry(key, value, kind, ancestors),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

function redactValue(value: unknown, kind: Kind, ancestors: Set<object>): unknown {
  if (typeof value !== "object" || value === null) {
    // A card given as a bare number (`card: "4111…"`) is still a card number.
    return kind === "card" ? maskScalar(value, lastFourDigits) : value;
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (ancestors.has(value)) {
    return CIRCULAR_REFERENCE;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const itemKind: Kind = kind === "documents" ? "document" : kind;
      return value.map((item: unknown) => redactValue(item, itemKind, ancestors));
    }
    const toJSON: unknown = Reflect.get(value, "toJSON");
    if (typeof toJSON === "function") {
      // Redact what would be persisted, as JSON.stringify would see it.
      return redactValue(toJSON.call(value), kind, ancestors);
    }
    return redactObject(value, kind === "documents" ? "document" : kind, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

/**
 * The shared redactor for persisted payload copies (db README §8): `supplier_requests` bodies,
 * `order_snapshot`, `booking_events.data`, `staff_actions` before/after, `idempotency_keys.response_body`,
 * `payment_events.payload`, `notifications.payload`, `priced_offers.amadeus_request` and the platform
 * audit log (`platform_audit_log.details`). It returns a deep copy and never mutates its input:
 * - card `number` fields (under `card`, `creditCard`, …) keep their last 4 digits, and a card's holder and expiry
 *   (`holder`, `holderName`, `expiryDate`, `expiryMonth`, `expiryYear`) are dropped, anywhere in a card and anywhere
 *   below `formOfPayments` (FIX-W29-SECURITY: a stored card keeps at most its brand, BIN and last 4);
 * - `documents[].number`, `formOfIdentifications[].number`, `cardNumber` and `certificateNumber` keep their last 4
 *   characters;
 * - `securityCode`, `cvc`, `cvv`, `birthPlace` and `issuanceLocation` are dropped;
 * - password, token, secret and API key fields (and credential headers), bank numbers (`iban`, `accountNumber`),
 *   recovery codes, `otpauthUrl`, the e-mail links with tokens (`verifyUrl`, `resetUrl`, `acceptUrl`), and the `code`
 *   and `state` anywhere below `mfa` or `oauth` become `[REDACTED]`;
 * - arrays are handled, and a reference back to an enclosing object becomes `[Circular]`.
 *
 * The static type is the input type for convenience; masked fields hold the masked strings.
 */
export function redactPayload<T>(value: T): T {
  return redactValue(value, "plain", new Set()) as T;
}
