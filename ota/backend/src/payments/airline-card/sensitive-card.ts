// The airline card in memory (ADR-0011 (B, C), OADR-0004 point 2, ota/docs/flows/checkout-airline-card.md §3 steps
// 4–7; OBE-050). checkout.completeWithAirlineCard (OBE-051) wraps the validated `card` object of its body in a
// `SensitiveCard` before anything else touches it, hands that object (never the body) to the code that builds the
// Amadeus Flight Create Orders request, and drops its reference in `finally`. The card exists in one process, in one
// request, in one object whose accidental serialisation is harmless:
//
//   - the values sit in ECMAScript private fields (`#number`, …): no `Object.keys`, spread, `structuredClone`,
//     `JSON.stringify` or `util.inspect` (not even with `showHidden` or `customInspect: false`) can reach them;
//   - `toJSON()`, `toString()`, `Symbol.toPrimitive` and `util.inspect.custom` answer `"[redacted card]"`, so a pino
//     line, a template string, string concatenation, `console.log` and an error message built from it carry only that
//     text;
//   - `brand()`, `bin()` (first 6 digits) and `last4()` are the only readers: what ADR-0011 (B) allows to be kept;
//   - `toAmadeusCreditCard()` is the only method that returns the full values, for the Amadeus request body alone
//     (`formOfPayments[].creditCard`, OBE-051), and `toRedactedCreditCard()` the copy that may be persisted with the
//     supplier request (brand, holder and last 4; no security code, no expiry);
//   - `discard()` blanks the fields once the request is done; every reader refuses a discarded card.
//
// Nothing here logs, stores or throws a value: a malformed input is refused with the name of the field only.
import { inspect } from "node:util";

/** What every serialisation hook of a `SensitiveCard` answers. */
export const REDACTED_CARD = "[redacted card]";

/** The validated `card` object of AirlineCardCompletionRequest (ota/docs/api-changes.md §3.2). */
export interface AirlineCardInput {
  /** Amadeus PaymentBrand (`VISA`). */
  readonly brand: string;
  /** As on the card: letters, spaces, `.`, `'` and `-`. */
  readonly holderName: string;
  /** 12 to 19 digits. */
  readonly number: string;
  /** 1 to 12. */
  readonly expiryMonth: number;
  /** Four digits. */
  readonly expiryYear: number;
  /** 3 or 4 digits. */
  readonly securityCode: string;
}

/** The card part of Amadeus `formOfPayments[].creditCard` (FlightCreateOrders CreditCard, without `flightOfferIds`). */
export interface AmadeusCreditCard {
  readonly brand: string;
  /** The holder in upper case, as Amadeus expects it. */
  readonly holder: string;
  readonly number: string;
  /** `YYYY-MM`. */
  readonly expiryDate: string;
  readonly securityCode: string;
}

/** The copy of the card that may be persisted with a supplier request: no security code, no expiry, last 4 only. */
export interface RedactedCreditCard {
  readonly brand: string;
  readonly holder: string;
  /** The last 4 digits. */
  readonly number: string;
}

const DIGITS = /^[0-9]{12,19}$/;
const SECURITY_CODE = /^[0-9]{3,4}$/;
const HOLDER = /^[A-Za-z .'-]{2,64}$/;
const BRAND = /^[A-Z][A-Z_]{1,39}$/;

/** A refusal that names the field, never its value. */
function refused(field: keyof AirlineCardInput): TypeError {
  return new TypeError(`a SensitiveCard needs a well-formed ${field}`);
}

/** The airline card of one request; see the file header. */
export class SensitiveCard {
  #brand: string;
  #holderName: string;
  #number: string;
  #expiryMonth: number;
  #expiryYear: number;
  #securityCode: string;
  #discarded = false;

  private constructor(input: AirlineCardInput) {
    this.#brand = input.brand;
    this.#holderName = input.holderName;
    this.#number = input.number;
    this.#expiryMonth = input.expiryMonth;
    this.#expiryYear = input.expiryYear;
    this.#securityCode = input.securityCode;
  }

  /**
   * Wraps a card the request validation accepted. The shape is checked again (a `TypeError` naming the field, never
   * the value); the Luhn check, the expiry against today and the accepted brands are the completion's (OBE-051).
   */
  static from(input: AirlineCardInput): SensitiveCard {
    if (typeof input.brand !== "string" || !BRAND.test(input.brand)) {
      throw refused("brand");
    }
    if (typeof input.holderName !== "string" || !HOLDER.test(input.holderName.trim())) {
      throw refused("holderName");
    }
    if (typeof input.number !== "string" || !DIGITS.test(input.number)) {
      throw refused("number");
    }
    if (!Number.isInteger(input.expiryMonth) || input.expiryMonth < 1 || input.expiryMonth > 12) {
      throw refused("expiryMonth");
    }
    if (!Number.isInteger(input.expiryYear) || input.expiryYear < 1000 || input.expiryYear > 9999) {
      throw refused("expiryYear");
    }
    if (typeof input.securityCode !== "string" || !SECURITY_CODE.test(input.securityCode)) {
      throw refused("securityCode");
    }
    return new SensitiveCard({ ...input, holderName: input.holderName.trim() });
  }

  /** The Amadeus PaymentBrand. */
  brand(): string {
    this.#check();
    return this.#brand;
  }

  /** The first 6 digits (BIN), which may be stored (ADR-0011 (B)). */
  bin(): string {
    this.#check();
    return this.#number.slice(0, 6);
  }

  /** The last 4 digits, which may be stored (ADR-0011 (B)). */
  last4(): string {
    this.#check();
    return this.#number.slice(-4);
  }

  /**
   * The full card for the Amadeus Flight Create Orders body (`formOfPayments[].creditCard`), and for nothing else: the
   * only method that returns the number and the security code.
   */
  toAmadeusCreditCard(): AmadeusCreditCard {
    this.#check();
    return {
      brand: this.#brand,
      holder: this.#holderName.toUpperCase(),
      number: this.#number,
      expiryDate: `${String(this.#expiryYear).padStart(4, "0")}-${String(this.#expiryMonth).padStart(2, "0")}`,
      securityCode: this.#securityCode,
    };
  }

  /** The persisted copy of the card in a redacted supplier request: brand, holder and the last 4 digits. */
  toRedactedCreditCard(): RedactedCreditCard {
    this.#check();
    return { brand: this.#brand, holder: this.#holderName.toUpperCase(), number: this.last4() };
  }

  /** Blanks the card once the request is done (OBE-051's `finally`); every reader refuses it afterwards. */
  discard(): void {
    this.#brand = "";
    this.#holderName = "";
    this.#number = "";
    this.#expiryMonth = 0;
    this.#expiryYear = 0;
    this.#securityCode = "";
    this.#discarded = true;
  }

  /** Whether `discard()` was called. */
  get discarded(): boolean {
    return this.#discarded;
  }

  toJSON(): string {
    return REDACTED_CARD;
  }

  toString(): string {
    return REDACTED_CARD;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED_CARD;
  }

  [inspect.custom](): string {
    return REDACTED_CARD;
  }

  #check(): void {
    if (this.#discarded) {
      throw new Error("the card of this request was discarded");
    }
  }
}
