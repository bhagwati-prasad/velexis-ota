// The personal-data scrubber and the personal-data scan of the Amadeus stub's fixtures (X-034, ADR-0015).
//
// `scrub(body)` takes an Amadeus response body as recorded from the test environment and returns a copy in which every
// piece of personal data is replaced by a deterministic synthetic value: traveller names, dates of birth, document,
// resident-card and loyalty numbers, e-mail addresses (to `@example.com`), phone numbers (to reserved test ranges),
// postal addresses, record locators, flight-order ids (they embed the record locator and a name), ticket numbers and
// card data. What the tests need stays as it is: airports, carriers, flight numbers, fare bases, prices, offer and
// segment ids, dates of travel, offices.
//
// It works in two passes over the JSON:
//   1. collect: the fields that hold personal data by their key and position (the Amadeus schemas: `firstName`,
//      `documents[].number`, `phones[].number`, `associatedRecords[].reference`, ...) are collected in document order
//      and each distinct value gets its synthetic counterpart, numbered in order of first appearance. Nothing of the
//      original value goes into the synthetic one, so the same input always gives the same output and the output
//      reveals nothing about the input.
//   2. rewrite: those fields get their synthetic value, and every other string is searched for e-mail addresses,
//      international phone numbers, runs of 13 to 19 digits, passport numbers in free text and any value collected in
//      pass 1 (a name in a remark, a record locator in a link), which are replaced in one pass of one regular
//      expression, so a replacement is never replaced again.
//
// `scanForPersonalData(value)` is the check of test/fixtures-scan.test.ts over every committed fixture, and of the
// recorder before it writes a file. It reports, by JSON pointer and rule and never with the value: an e-mail address
// outside `example.com`, a run of 13 to 19 digits that does not start with the synthetic prefix `000`, a document,
// resident-card, loyalty or ticket number without that prefix (and a passport number in free text), a phone number
// outside the reserved test ranges, and a name field whose words are not in the synthetic name lists.

type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// ---- Synthetic values ------------------------------------------------------------------------------------------

/** The given names the scrubber writes (`firstName`, `middleName`), in order of first appearance. */
export const SYNTHETIC_GIVEN_NAMES: readonly string[] = Object.freeze([
  "ALEX",
  "BLAKE",
  "CASEY",
  "DANA",
  "ELLIS",
  "FINLEY",
  "GRAY",
  "HARPER",
  "INDIGO",
  "JORDAN",
  "KAI",
  "LOGAN",
  "MORGAN",
  "NOEL",
  "OAKLEY",
  "PARKER",
  "QUINN",
  "REMY",
  "SAGE",
  "TAYLOR",
]);

/** The family names the scrubber writes (`lastName`, `secondLastName`, unknown words of a card holder). */
export const SYNTHETIC_FAMILY_NAMES: readonly string[] = Object.freeze([
  "TESTER",
  "SAMPLE",
  "EXAMPLE",
  "FIXTURE",
  "PLACEHOLDER",
  "DUMMY",
  "MOCK",
  "STUB",
  "SYNTHETIC",
  "DEMO",
  "PROTO",
  "SPECIMEN",
  "MODEL",
  "TRIAL",
  "PILOT",
  "DRAFT",
  "MOCKUP",
  "TESTCASE",
  "SANDBOX",
  "STAGING",
]);

/** Titles that may stand next to a name (`STEPHANE MR`, `MR DUPON DAMIEN`); they are kept and allowed by the scan. */
export const NAME_TITLES: readonly string[] = Object.freeze([
  "MR",
  "MRS",
  "MS",
  "MISS",
  "MSTR",
  "MX",
  "DR",
  "PROF",
]);

/** Synthetic document, resident-card, loyalty and ticket numbers and synthetic digit runs start with this prefix. */
export const SYNTHETIC_PREFIX = "000";

/** The only domain a fixture's e-mail addresses may use. */
export const SYNTHETIC_EMAIL_DOMAIN = "example.com";

/**
 * Phone numbers reserved for fiction and tests; a fixture's phone numbers must be in one of them. The scrubber writes
 * the first: country calling code `44`, number `7700900nnn`.
 */
export const RESERVED_TEST_PHONE_RANGES: readonly {
  readonly description: string;
  readonly pattern: RegExp;
}[] = Object.freeze([
  { description: "UK mobile 07700 900000 to 900999 (Ofcom, drama)", pattern: /^(?:44|0)?7700900\d{3}$/ },
  { description: "UK London 020 7946 0000 to 0999 (Ofcom, drama)", pattern: /^(?:44|0)?2079460\d{3}$/ },
  { description: "UK 01632 960000 to 960999 (Ofcom, drama)", pattern: /^(?:44|0)?1632960\d{3}$/ },
  { description: "North America 555-0100 to 555-0199 (NANPA, fiction)", pattern: /^1?[2-9]\d{2}55501\d{2}$/ },
]);

const SYNTHETIC_NAME_WORDS: ReadonlySet<string> = new Set([
  ...SYNTHETIC_GIVEN_NAMES,
  ...SYNTHETIC_FAMILY_NAMES,
  ...NAME_TITLES,
]);
const TITLE_WORDS: ReadonlySet<string> = new Set(NAME_TITLES);

/** A word of a name: letters, marks, digits and apostrophes (`O'NEIL`); spaces and hyphens separate words. */
const NAME_WORD = /[\p{L}\p{M}\p{N}'’]+/gu;

const normaliseWord = (word: string): string => word.replace(/['’]/g, "").toUpperCase();

/** Whether every word of `value` is a synthetic name or a title (an empty value is). */
export function isSyntheticName(value: string): boolean {
  return (value.match(NAME_WORD) ?? []).every((word) => SYNTHETIC_NAME_WORDS.has(normaliseWord(word)));
}

/** Whether a document, card, loyalty or ticket number is marked synthetic: its letters and digits start with `000`. */
export function isSyntheticNumber(value: string): boolean {
  return value.replace(/[^\p{L}\p{N}]/gu, "").startsWith(SYNTHETIC_PREFIX);
}

/** Whether a phone number (digits only; with or without its country calling code) is in a reserved test range. */
export function isReservedTestPhone(digits: string): boolean {
  const normalised = digits.replace(/\D/g, "").replace(/^00/, "");
  return RESERVED_TEST_PHONE_RANGES.some(({ pattern }) => pattern.test(normalised));
}

// ---- Where personal data lives ---------------------------------------------------------------------------------

/** What a field holds, from its key, the key its object sits under (`owner`) and its object. */
type FieldKind =
  | "givenName"
  | "familyName"
  | "fullName"
  | "dateOfBirth"
  | "document"
  | "discountNumber"
  | "loyaltyId"
  | "ticket"
  | "place"
  | "phone"
  | "callingCode"
  | "phoneCountry"
  | "email"
  | "addressLines"
  | "postalCode"
  | "city"
  | "state"
  | "postalBox"
  | "locator"
  | "pnrId"
  | "orderId"
  | "cardNumber"
  | "cardExpiry"
  | "securityCode";

const PHONE_KEYS =
  /^(?:phone|phoneNumber|mobile|mobileNumber|mobilePhone|fax|faxNumber|telephone|telephoneNumber)$/i;
/** The fields of an `address` object, by key. */
const ADDRESS_FIELDS: Readonly<Record<string, FieldKind>> = Object.freeze({
  postalCode: "postalCode",
  cityName: "city",
  stateName: "state",
  postalBox: "postalBox",
});

/** A Queue List PNR id: the record locator and the creation date (`ABC123-2019-10-05`). */
const PNR_ID = /^([A-Z0-9]{6})(-\d{4}-\d{2}-\d{2})$/;

/**
 * The kind of personal data a field holds, or `undefined`. `owner` is the key the field's object sits under (the
 * array's key for an array element): `number` is a document number under `documents`, a phone number under `phones`,
 * a flight number under `segments`.
 */
function classify(
  key: string,
  value: unknown,
  owner: string | undefined,
  parent: JsonObject,
): FieldKind | undefined {
  if (Array.isArray(value)) {
    return owner === "address" && key === "lines" ? "addressLines" : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  switch (key) {
    case "firstName":
    case "middleName":
      return "givenName";
    case "lastName":
    case "secondLastName":
      return "familyName";
    case "addresseeName":
    case "holder":
      return "fullName";
    case "dateOfBirth":
      return "dateOfBirth";
    case "cardNumber":
    case "certificateNumber":
      return "discountNumber";
    case "documentNumber":
      return "ticket";
    case "birthPlace":
    case "issuanceLocation":
      return "place";
    case "emailAddress":
    case "email":
      return "email";
    case "securityCode":
      return "securityCode";
    default:
      break;
  }
  if (PHONE_KEYS.test(key)) {
    return "phone";
  }
  if (/passport/i.test(key)) {
    return "document";
  }
  switch (owner) {
    case "documents":
    case "formOfIdentifications":
      return key === "number" ? "document" : undefined;
    case "loyaltyPrograms":
      return key === "id" ? "loyaltyId" : undefined;
    case "phones":
      return key === "number" ? "phone" : key === "countryCallingCode" ? "callingCode" : undefined;
    case "emergencyContact":
      return key === "number" ? "phone" : key === "countryCode" ? "phoneCountry" : undefined;
    case "address":
      return ADDRESS_FIELDS[key];
    case "associatedRecords":
      return key === "reference" ? "locator" : undefined;
    case "creditCard":
    case "virtualCreditCardDetails":
      return key === "number" ? "cardNumber" : key === "expiryDate" ? "cardExpiry" : undefined;
    default:
      break;
  }
  if (key === "id") {
    if (parent["type"] === "flight-order") {
      return "orderId";
    }
    if (PNR_ID.test(value)) {
      return "pnrId";
    }
  }
  return undefined;
}

/** The digits that identify a phone: country calling code (when its object has one) and number, no trunk zero. */
function phoneKey(number: string, owner: string | undefined, parent: JsonObject): string {
  const digits = number.replace(/\D/g, "");
  const callingCode =
    owner === "phones" && typeof parent["countryCallingCode"] === "string"
      ? parent["countryCallingCode"].replace(/\D/g, "").replace(/^00/, "")
      : "";
  return callingCode === "" ? digits : callingCode + digits.replace(/^0+/, "");
}

// ---- Patterns in free text -------------------------------------------------------------------------------------

const DOMAIN = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+`;
/** An e-mail address. */
const EMAIL_SOURCE = String.raw`[A-Za-z0-9._%+-]+@${DOMAIN}`;
/** An e-mail address as a PNR's SSR elements write it (`JOHN.SMITH//MAIL.COM`). */
const SSR_EMAIL_SOURCE = String.raw`[A-Za-z0-9._%+-]+\/\/${DOMAIN}`;
/** A passport or identity-card number after a keyword (`PASSPORT NO 512345678`); it must contain a digit. */
const PASSPORT_TEXT_SOURCE = String.raw`\b(?:PASSPORT|PASSEPORT|PASAPORTE|PSPT|PPT)\b[^A-Za-z0-9]{0,4}(?:(?:NO|NBR|NUM|NUMBER)\b[^A-Za-z0-9]{0,4})?(?<ppnum>(?=[A-Za-z]*\d)[A-Za-z0-9]{6,12})\b`;
/** The document number of an SSR DOCS text (`P/GBR/512345678/...`). */
const DOCS_TEXT_SOURCE = String.raw`\b[PI]\/[A-Za-z]{2,3}\/(?<docsnum>(?=[A-Za-z]*\d)[A-Za-z0-9]{5,15})\/`;
/** A phone number in international format (`+33 4 87 69 27 04`); 8 to 15 digits are checked. */
const PHONE_TEXT_SOURCE = String.raw`\+\d[\d ().-]{6,18}\d`;
/** 13 to 19 digits, single spaces or hyphens allowed between them (a card or ticket number). */
const DIGIT_RUN_SOURCE = String.raw`(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)`;

const FREE_TEXT_ALTERNATIVES = [
  `(?<email>${EMAIL_SOURCE})`,
  `(?<ssr>${SSR_EMAIL_SOURCE})`,
  `(?<passport>${PASSPORT_TEXT_SOURCE})`,
  `(?<docs>${DOCS_TEXT_SOURCE})`,
  `(?<phone>${PHONE_TEXT_SOURCE})`,
  `(?<digits>${DIGIT_RUN_SOURCE})`,
];

/** The free-text patterns, without values collected from a body (the scan uses this one). */
const FREE_TEXT = new RegExp(FREE_TEXT_ALTERNATIVES.join("|"), "giu");

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const digitsOf = (text: string): string => text.replace(/\D/g, "");

const isPhoneLength = (digits: string): boolean => digits.length >= 8 && digits.length <= 15;

function domainOf(address: string, separator: "@" | "//"): string {
  return address.slice(address.lastIndexOf(separator) + separator.length).toLowerCase();
}

interface FreeTextGroups {
  readonly email?: string;
  readonly ssr?: string;
  readonly passport?: string;
  readonly ppnum?: string;
  readonly docs?: string;
  readonly docsnum?: string;
  readonly phone?: string;
  readonly digits?: string;
  readonly known?: string;
}

/** The named groups of a match: the last argument of a `replace` callback, or `match.groups`. */
const groupsOf = (value: unknown): FreeTextGroups => (isRecord(value) ? (value as FreeTextGroups) : {});

// ---- Scrubbing -------------------------------------------------------------------------------------------------

/** What `scrub` counts: replaced values per category. */
export type ScrubCategory =
  | "names"
  | "datesOfBirth"
  | "documents"
  | "emails"
  | "phones"
  | "addresses"
  | "recordLocators"
  | "orderIds"
  | "ticketNumbers"
  | "cardData"
  | "digitRuns";

export const SCRUB_CATEGORIES: readonly ScrubCategory[] = Object.freeze([
  "names",
  "datesOfBirth",
  "documents",
  "emails",
  "phones",
  "addresses",
  "recordLocators",
  "orderIds",
  "ticketNumbers",
  "cardData",
  "digitRuns",
]);

export interface ScrubResult {
  /** The scrubbed copy; the input is never changed. */
  readonly value: unknown;
  /** How many values were replaced (or removed), per category. */
  readonly replaced: Readonly<Record<ScrubCategory, number>>;
}

/** Original → synthetic, numbered from 1 in order of first appearance. */
class SyntheticValues {
  readonly #values = new Map<string, string>();
  readonly #make: (index: number, original: string) => string;

  constructor(make: (index: number, original: string) => string) {
    this.#make = make;
  }

  get(key: string): string | undefined {
    return this.#values.get(key);
  }

  assign(key: string, original: string = key): string {
    let synthetic = this.#values.get(key);
    if (synthetic === undefined) {
      synthetic = this.#make(this.#values.size + 1, original);
      this.#values.set(key, synthetic);
    }
    return synthetic;
  }

  entries(): IterableIterator<[string, string]> {
    return this.#values.entries();
  }
}

const pad = (value: number, length: number): string => String(value).padStart(length, "0");
const cycle = (list: readonly string[], index: number): string => list[(index - 1) % list.length] ?? "";

/** `000` and the counter, `length` digits in all (at least the prefix and the counter). */
const syntheticDigits = (length: number, index: number): string =>
  SYNTHETIC_PREFIX + pad(index, Math.max(length - SYNTHETIC_PREFIX.length, String(index).length));

/** `original` with its digits replaced, in order, by those of `digits` (separators and letters stay). */
function withDigits(original: string, digits: string): string {
  let next = 0;
  const replaced = original.replace(/\d/g, () => digits[next++] ?? "");
  return next < digits.length ? replaced + digits.slice(next) : replaced;
}

/** `value` in the letter case of `template`: upper, lower or capitalised. */
function inCaseOf(template: string, value: string): string {
  if (template === template.toUpperCase() && template !== template.toLowerCase()) {
    return value.toUpperCase();
  }
  if (template === template.toLowerCase() && template !== template.toUpperCase()) {
    return value.toLowerCase();
  }
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/** A value collected in pass 1 that pass 2 also replaces in free text. */
interface KnownValue {
  readonly category: ScrubCategory;
  /** The synthetic replacement of one occurrence. */
  readonly replace: (occurrence: string) => string;
  /** A name word: as a whole string it is only replaced from 4 characters on, so `LIS` stays an airport code. */
  readonly nameWord: boolean;
}

interface CollectedField {
  readonly kind: FieldKind;
  readonly value: string;
  readonly owner: string | undefined;
  readonly parent: JsonObject;
}

/** The order in which pass 1 numbers the collected values, so names come first whatever the document order. */
const COLLECTION_ORDER: readonly FieldKind[] = [
  "givenName",
  "familyName",
  "fullName",
  "email",
  "phone",
  "document",
  "discountNumber",
  "loyaltyId",
  "ticket",
  "locator",
  "pnrId",
  "orderId",
  "addressLines",
];

class Scrubber {
  readonly replaced: Record<ScrubCategory, number> = Object.fromEntries(
    SCRUB_CATEGORIES.map((category) => [category, 0]),
  ) as Record<ScrubCategory, number>;

  readonly #given = new SyntheticValues((index) => cycle(SYNTHETIC_GIVEN_NAMES, index));
  readonly #family = new SyntheticValues((index) => cycle(SYNTHETIC_FAMILY_NAMES, index));
  readonly #emails = new SyntheticValues((index) => `person${index}@${SYNTHETIC_EMAIL_DOMAIN}`);
  readonly #phones = new SyntheticValues((index) => `7700900${pad(index % 1000, 3)}`);
  readonly #documents = new SyntheticValues((index) => SYNTHETIC_PREFIX + pad(index, 6));
  readonly #discountNumbers = new SyntheticValues((index) => `${SYNTHETIC_PREFIX}${pad(index, 5)}Z`);
  readonly #loyaltyIds = new SyntheticValues((index) => SYNTHETIC_PREFIX + pad(index, 7));
  readonly #digitRuns = new SyntheticValues((index, original) => syntheticDigits(original.length, index));
  readonly #locators = new SyntheticValues((index) => `SYN${pad(index % 1000, 3)}`);
  readonly #orderIds = new SyntheticValues((index) =>
    Buffer.from(`SYNTHETIC-ORDER-${index}`).toString("base64url"),
  );
  readonly #addressLines = new SyntheticValues((index) => `${index} EXAMPLE STREET`);
  readonly #known = new Map<string, KnownValue>();
  #freeText: RegExp = FREE_TEXT;

  scrub(body: unknown): unknown {
    const collected: CollectedField[] = [];
    this.#collect(body, undefined, collected);
    for (const kind of COLLECTION_ORDER) {
      for (const field of collected) {
        if (field.kind === kind) {
          this.#register(field);
        }
      }
    }
    this.#buildFreeText();
    return this.#rewrite(body, undefined);
  }

  // Pass 1 -----------------------------------------------------------------------------------------------------

  #collect(value: unknown, owner: string | undefined, out: CollectedField[]): void {
    if (Array.isArray(value)) {
      for (const item of value) {
        this.#collect(item, owner, out);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const kind = classify(key, child, owner, value);
      if (kind === "addressLines" && Array.isArray(child)) {
        for (const line of child) {
          if (typeof line === "string") {
            out.push({ kind, value: line, owner, parent: value });
          }
        }
      } else if (kind !== undefined && typeof child === "string") {
        out.push({ kind, value: child, owner, parent: value });
      } else {
        this.#collect(child, key, out);
      }
    }
  }

  #register(field: CollectedField): void {
    const { kind, value } = field;
    switch (kind) {
      case "givenName":
      case "familyName":
        for (const word of value.match(NAME_WORD) ?? []) {
          this.#registerNameWord(word, kind === "givenName" ? this.#given : this.#family);
        }
        return;
      case "fullName":
        for (const word of value.match(NAME_WORD) ?? []) {
          const key = normaliseWord(word);
          if (this.#given.get(key) === undefined) {
            this.#registerNameWord(word, this.#family);
          }
        }
        return;
      case "email":
        this.#emails.assign(value.replace("//", "@").toLowerCase());
        return;
      case "phone": {
        const key = phoneKey(value, field.owner, field.parent);
        if (key === "") {
          return;
        }
        const synthetic = this.#phones.assign(key);
        const national = digitsOf(value);
        this.#addKnown(national, "phones", () => synthetic, 5);
        this.#addKnown(key, "phones", () => (key === national ? synthetic : `44${synthetic}`), 5);
        return;
      }
      case "document":
        this.#addKnownId(value, "documents", this.#documents.assign(value.toUpperCase()));
        return;
      case "discountNumber":
        this.#addKnownId(value, "documents", this.#discountNumbers.assign(value.toUpperCase()));
        return;
      case "loyaltyId":
        this.#addKnownId(value, "documents", this.#loyaltyIds.assign(value.toUpperCase()));
        return;
      case "ticket": {
        const digits = digitsOf(value);
        if (digits === "") {
          return;
        }
        const synthetic = this.#digitRuns.assign(digits);
        this.#addKnownId(value, "ticketNumbers", withDigits(value, synthetic));
        this.#addKnownId(digits, "ticketNumbers", synthetic);
        return;
      }
      case "locator":
        this.#addKnownId(value, "recordLocators", this.#locators.assign(value.toUpperCase()));
        return;
      case "pnrId": {
        const locator = PNR_ID.exec(value)?.[1];
        if (locator !== undefined) {
          this.#addKnownId(locator, "recordLocators", this.#locators.assign(locator));
        }
        return;
      }
      case "orderId": {
        const synthetic = this.#orderIds.assign(value);
        for (const form of new Set([value, encodeURIComponent(value), safeDecode(value)])) {
          this.#addKnown(form, "orderIds", () => synthetic, 4);
        }
        return;
      }
      case "addressLines": {
        const line = value.trim();
        const synthetic = this.#addressLines.assign(line.toUpperCase());
        this.#addKnown(line, "addresses", () => synthetic, 6);
        return;
      }
      default:
        return;
    }
  }

  #registerNameWord(word: string, names: SyntheticValues): void {
    const key = normaliseWord(word);
    if (TITLE_WORDS.has(key) || key === "") {
      return;
    }
    const synthetic = names.assign(key);
    // Free text may write the name with or without its apostrophe (O'NEIL, ONEIL).
    for (const form of new Set([key, word.toUpperCase()])) {
      if (form.length >= 2 && !this.#known.has(form)) {
        this.#known.set(form, {
          category: "names",
          replace: (occurrence) => inCaseOf(occurrence, synthetic),
          nameWord: true,
        });
      }
    }
  }

  #addKnownId(original: string, category: ScrubCategory, synthetic: string): void {
    this.#addKnown(original, category, () => synthetic, 4);
  }

  #addKnown(original: string, category: ScrubCategory, replace: () => string, minLength: number): void {
    const key = original.toUpperCase();
    if (key.length >= minLength && !this.#known.has(key)) {
      this.#known.set(key, { category, replace, nameWord: false });
    }
  }

  #buildFreeText(): void {
    if (this.#known.size === 0) {
      this.#freeText = new RegExp(FREE_TEXT.source, FREE_TEXT.flags);
      return;
    }
    const known = [...this.#known.keys()]
      .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
      .map(escapeRegExp)
      .join("|");
    this.#freeText = new RegExp(
      [...FREE_TEXT_ALTERNATIVES, `(?<known>(?<![\\p{L}\\p{N}_])(?:${known})(?![\\p{L}\\p{N}_]))`].join("|"),
      "giu",
    );
  }

  // Pass 2 -----------------------------------------------------------------------------------------------------

  #rewrite(value: unknown, owner: string | undefined): unknown {
    if (typeof value === "string") {
      return this.#rewriteText(value);
    }
    if (Array.isArray(value)) {
      return value.map((item: unknown) => this.#rewrite(item, owner));
    }
    if (!isRecord(value)) {
      return value;
    }
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      const kind = classify(key, child, owner, value);
      if (kind === "securityCode") {
        this.replaced.cardData += 1;
        continue;
      }
      out[key] =
        kind === undefined ? this.#rewrite(child, key) : this.#rewriteField(kind, child, owner, value);
    }
    return out;
  }

  #rewriteField(kind: FieldKind, value: unknown, owner: string | undefined, parent: JsonObject): unknown {
    if (kind === "addressLines") {
      this.replaced.addresses += 1;
      return Array.isArray(value)
        ? value.map((line: unknown) =>
            typeof line === "string" ? this.#addressLines.assign(line.trim().toUpperCase()) : line,
          )
        : value;
    }
    if (typeof value !== "string") {
      return value;
    }
    switch (kind) {
      case "givenName":
        return this.#count(
          "names",
          this.#rewriteName(value, (key) => this.#given.get(key)),
        );
      case "familyName":
        return this.#count(
          "names",
          this.#rewriteName(value, (key) => this.#family.get(key)),
        );
      case "fullName":
        return this.#count(
          "names",
          this.#rewriteName(value, (key) => this.#given.get(key) ?? this.#family.get(key)),
        );
      case "dateOfBirth": {
        const year = /^(\d{4})-\d{2}-\d{2}$/.exec(value)?.[1] ?? "1980";
        return this.#count("datesOfBirth", `${year}-01-01`);
      }
      case "document":
        return this.#count("documents", this.#documents.assign(value.toUpperCase()));
      case "discountNumber":
        return this.#count("documents", this.#discountNumbers.assign(value.toUpperCase()));
      case "loyaltyId":
        return this.#count("documents", this.#loyaltyIds.assign(value.toUpperCase()));
      case "ticket": {
        const digits = digitsOf(value);
        return digits === ""
          ? value
          : this.#count("ticketNumbers", withDigits(value, this.#digitRuns.assign(digits)));
      }
      case "phone": {
        const key = phoneKey(value, owner, parent);
        return key === "" ? value : this.#count("phones", this.#phones.assign(key));
      }
      case "callingCode":
        return "44";
      case "phoneCountry":
        return "GB";
      case "email":
        return value.includes("@") || value.includes("//")
          ? this.#count("emails", this.#email(value))
          : value;
      case "place":
      case "city":
        return this.#count("addresses", "EXAMPLE CITY");
      case "postalCode":
        return this.#count("addresses", "00000");
      case "state":
        return this.#count("addresses", "EXAMPLE STATE");
      case "postalBox":
        return this.#count("addresses", "BP 1");
      case "locator":
        return this.#count("recordLocators", this.#locators.assign(value.toUpperCase()));
      case "pnrId": {
        const match = PNR_ID.exec(value);
        return match?.[1] === undefined
          ? value
          : this.#count("recordLocators", this.#locators.assign(match[1]) + (match[2] ?? ""));
      }
      case "orderId":
        return this.#count("orderIds", this.#orderIds.assign(value));
      case "cardNumber":
        return this.#count("cardData", `${"X".repeat(Math.max(value.length - 4, 0))}0000`);
      case "cardExpiry":
        return this.#count("cardData", "2099-12");
      case "securityCode":
        return value;
      default:
        return this.#unreachable(kind);
    }
  }

  #unreachable(kind: never): never {
    throw new Error(`scrub: unhandled field kind ${String(kind)}`);
  }

  #count<T>(category: ScrubCategory, value: T): T {
    this.replaced[category] += 1;
    return value;
  }

  /** Each word of a name through `lookup` (registered in pass 1); titles stay. */
  #rewriteName(value: string, lookup: (key: string) => string | undefined): string {
    return value.replace(NAME_WORD, (word) => {
      const key = normaliseWord(word);
      if (TITLE_WORDS.has(key)) {
        return word;
      }
      return inCaseOf(word, lookup(key) ?? this.#family.assign(key));
    });
  }

  /** A synthetic address for `address`, in its letter case and in its form (`a@b.c` or the SSR `A//B.C`). */
  #email(address: string): string {
    const ssr = !address.includes("@") && address.includes("//");
    const synthetic = this.#emails.assign(address.replace("//", "@").toLowerCase());
    const cased = address === address.toUpperCase() ? synthetic.toUpperCase() : synthetic;
    return ssr ? cased.replace("@", "//") : cased;
  }

  #rewriteText(text: string): string {
    return text.replace(this.#freeText, (match: string, ...rest: unknown[]) => {
      const groups = groupsOf(rest.at(-1));
      if (groups.email !== undefined || groups.ssr !== undefined) {
        return this.#count("emails", this.#email(match));
      }
      if (groups.passport !== undefined && groups.ppnum !== undefined) {
        const synthetic = this.#documents.assign(groups.ppnum.toUpperCase());
        return this.#count("documents", match.slice(0, match.length - groups.ppnum.length) + synthetic);
      }
      if (groups.docs !== undefined && groups.docsnum !== undefined) {
        const synthetic = this.#documents.assign(groups.docsnum.toUpperCase());
        return this.#count(
          "documents",
          `${match.slice(0, match.length - groups.docsnum.length - 1)}${synthetic}/`,
        );
      }
      if (groups.phone !== undefined) {
        const digits = digitsOf(match);
        return isPhoneLength(digits) ? this.#count("phones", `+44${this.#phones.assign(digits)}`) : match;
      }
      if (groups.digits !== undefined) {
        const digits = digitsOf(match);
        return this.#count("digitRuns", withDigits(match, this.#digitRuns.assign(digits)));
      }
      if (groups.known !== undefined) {
        const known = this.#known.get(match.toUpperCase());
        if (known === undefined || (known.nameWord && match === text && match.length < 4)) {
          return match;
        }
        return this.#count(known.category, known.replace(match));
      }
      return match;
    });
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * A copy of an Amadeus response body with every piece of personal data replaced by a deterministic synthetic value
 * (see the top of this file), and the count of replacements per category. The same input always gives the same
 * output; the input is not changed.
 */
export function scrub(body: unknown): ScrubResult {
  const scrubber = new Scrubber();
  const value = scrubber.scrub(body);
  return { value, replaced: Object.freeze({ ...scrubber.replaced }) };
}

// ---- The personal-data scan ------------------------------------------------------------------------------------

export type ScanRule = "email" | "digit-run" | "document-number" | "phone" | "name";

/** One finding of the scan: where (a JSON pointer) and which rule, never the value. */
export interface ScanFinding {
  readonly pointer: string;
  readonly rule: ScanRule;
  readonly message: string;
}

export const SCAN_MESSAGES: Readonly<Record<ScanRule, string>> = Object.freeze({
  email: `an e-mail address outside ${SYNTHETIC_EMAIL_DOMAIN}`,
  "digit-run": `a run of 13 to 19 digits not marked synthetic (synthetic runs start with ${SYNTHETIC_PREFIX})`,
  "document-number": `a document, resident-card, loyalty or ticket number not marked synthetic (they start with ${SYNTHETIC_PREFIX})`,
  phone: "a phone number outside the reserved test ranges",
  name: "a name that is not in the synthetic name lists",
});

const pointerToken = (token: string | number): string =>
  String(token).replace(/~/g, "~0").replace(/\//g, "~1");

class Scan {
  readonly findings: ScanFinding[] = [];
  readonly #seen = new Set<string>();

  add(pointer: string, rule: ScanRule): void {
    const key = `${pointer}\u0000${rule}`;
    if (!this.#seen.has(key)) {
      this.#seen.add(key);
      this.findings.push({ pointer: pointer === "" ? "/" : pointer, rule, message: SCAN_MESSAGES[rule] });
    }
  }

  /** The free-text rules that `text` breaks. */
  rulesIn(text: string): ScanRule[] {
    const rules: ScanRule[] = [];
    for (const match of text.matchAll(FREE_TEXT)) {
      const groups = groupsOf(match.groups);
      const value = match[0];
      if (groups.email !== undefined && domainOf(value, "@") !== SYNTHETIC_EMAIL_DOMAIN) {
        rules.push("email");
      } else if (groups.ssr !== undefined && domainOf(value, "//") !== SYNTHETIC_EMAIL_DOMAIN) {
        rules.push("email");
      } else if (groups.ppnum !== undefined && !isSyntheticNumber(groups.ppnum)) {
        rules.push("document-number");
      } else if (groups.docsnum !== undefined && !isSyntheticNumber(groups.docsnum)) {
        rules.push("document-number");
      } else if (groups.phone !== undefined) {
        const digits = digitsOf(value);
        if (isPhoneLength(digits) && !isReservedTestPhone(digits)) {
          rules.push("phone");
        }
      } else if (groups.digits !== undefined && !digitsOf(value).startsWith(SYNTHETIC_PREFIX)) {
        rules.push("digit-run");
      }
    }
    return rules;
  }

  value(value: unknown, pointer: string, owner: string | undefined): void {
    if (typeof value === "string") {
      for (const rule of this.rulesIn(value)) {
        this.add(pointer, rule);
      }
    } else if (typeof value === "number") {
      // A number cannot carry the synthetic prefix, so any 13 to 19 digit integer part is a finding.
      if (Number.isFinite(value) && /^\d{13,19}$/.test(String(Math.abs(Math.trunc(value))))) {
        this.add(pointer, "digit-run");
      }
    } else if (Array.isArray(value)) {
      value.forEach((item: unknown, index) => this.value(item, `${pointer}/${index}`, owner));
    } else if (isRecord(value)) {
      Object.entries(value).forEach(([key, child], index) => {
        // A key that holds personal data is named by its position in its object (`<key 0>`), so that neither its own
        // finding nor those below it quote it.
        const keyRules = this.rulesIn(key);
        const childPointer = `${pointer}/${keyRules.length === 0 ? pointerToken(key) : `<key ${index}>`}`;
        for (const rule of keyRules) {
          this.add(`${childPointer} (key)`, rule);
        }
        this.value(child, childPointer, key);
        if (typeof child === "string") {
          this.field(classify(key, child, owner, value), child, childPointer, owner, value);
        }
      });
    }
  }

  field(
    kind: FieldKind | undefined,
    value: string,
    pointer: string,
    owner: string | undefined,
    parent: JsonObject,
  ): void {
    switch (kind) {
      case "givenName":
      case "familyName":
      case "fullName":
        if (!isSyntheticName(value)) {
          this.add(pointer, "name");
        }
        return;
      case "document":
      case "discountNumber":
      case "loyaltyId":
      case "ticket":
        if (value.trim() !== "" && !isSyntheticNumber(value)) {
          this.add(pointer, "document-number");
        }
        return;
      case "phone": {
        const key = phoneKey(value, owner, parent);
        if (key !== "" && !isReservedTestPhone(key)) {
          this.add(pointer, "phone");
        }
        return;
      }
      default:
        return;
    }
  }
}

/**
 * The personal data left in `value` (a fixture file's JSON, header included), by JSON pointer and rule: an e-mail
 * address outside example.com, a run of 13 to 19 digits without the prefix `000`, a document, resident-card, loyalty
 * or ticket number without it (or a passport number in free text), a phone number outside the reserved test ranges,
 * a name field whose words are not synthetic names. Empty when the value is clean. Findings never quote a value.
 */
export function scanForPersonalData(value: unknown): ScanFinding[] {
  const scan = new Scan();
  scan.value(value, "", undefined);
  return scan.findings;
}
