// Checkout requirements and the checks of travellers, contacts and remarks (OBE-036; ota/docs/flows/checkout-stripe.md
// §1 and §2 steps 1–2, the OTA document's createCheckout, setCheckoutTravelers, setCheckoutContacts and
// setCheckoutRemarks, SDK guide B3 §2.1–§2.5). Pure functions: no I/O and no clock (the caller passes `today`); dates
// are `YYYY-MM-DD` strings, compared as text and moved with UTC calendar arithmetic, never through local time.
//
// Requirements (`requirementsOf`) come from the priced offer: the contact flags of Amadeus `bookingRequirements` (the
// primary e-mail is always required: confirmations and guest access go there), one entry per traveller of the offer
// (`travelerPricings`) with its type, its held infant's adult, the fields its `travelerRequirements` flag (name always,
// and the date of birth of every type whose fare depends on age: every type but ADULT), the date-of-birth range of its
// type over the travel dates (CHILD 2–11, infants under 2, SENIOR 60 and over, every other type 12 and over; the
// minimum at the last flight's date, the maximum at the first flight's date), and the accepted identity documents:
// `PASSPORT` for an international trip, `PASSPORT` or `IDENTITY_CARD` when every airport is in one country or in the
// Schengen area (an airport whose country is unknown makes the trip international).
//
// Traveller checks (`travelerErrors`) judge the data a request sends, never what it leaves out: a multi-step form saves
// one traveller at a time, so a required field that is still missing is accepted and reported in `progress.missing`
// and the traveller's `missingFields` (`missingFieldsOf`, `missingErrorsOf`); createPayment refuses an incomplete
// checkout (OBE-038). What is sent must be valid: a traveller id of the offer, sent once; Latin names of at most 57
// characters in total; a date of birth not after today and in its type's range, and a held infant younger than its
// adult; identity documents of an accepted type that do not expire before the last flight; complete discount entries
// with well-formed card and certificate numbers (a masked value from a response never is); well-formed phones, e-mails
// and codes; no two travellers with the same name and date of birth. Saved travellers are deferred in the MVP
// (scope.md §3), so a `savedTravelerId` never exists: `SAVED_TRAVELER_NOT_FOUND`. Error paths are JSON pointers into
// the request; messages never contain a submitted value.
//
// Contact checks (`contactErrors`) judge the whole list, which the request replaces: exactly one primary contact
// (`isPrimary`, the first contact by default), of purpose STANDARD, with an e-mail; then the flags of the requirements.
// The same function reports what a stored list (or none) still lacks, with paths into the checkout.
import type { components } from "@velexis/api-types";

type Schemas = components["schemas"];
export type CheckoutRequirements = Schemas["CheckoutRequirements"];
export type CheckoutTravelerRequirement = Schemas["CheckoutTravelerRequirement"];
export type CheckoutContactRequirements = Schemas["CheckoutContactRequirements"];
export type TravelerInput = Schemas["TravelerInput"];
export type ContactInput = Schemas["ContactInput"];
export type RemarkInput = Schemas["RemarkInput"];
export type FieldError = Schemas["FieldError"];
export type RequiredField = CheckoutTravelerRequirement["requiredFields"][number];
export type TravelerType = Schemas["AmadeusTravelerType"];
export type DocumentType = Schemas["AmadeusDocumentType"];
type BookingRequirements = Schemas["PricingBookingRequirements"];
type PricedOffer = Schemas["PricedOffer"];
type FieldCode = Schemas["TravelerFieldErrorCode"];
type AmadeusName = Schemas["AmadeusName"];
type AmadeusContact = Schemas["AmadeusContact"];
type AmadeusDiscount = Schemas["AmadeusDiscount"];
type AmadeusPhone = Schemas["AmadeusPhone"];
type AmadeusAddress = Schemas["AmadeusAddress"];

/** At most this many field errors are answered (the validation interceptor's bound); the request is refused either way. */
export const MAX_FIELD_ERRORS = 50;

/** The most contacts Amadeus takes (CheckoutContactRequirements.maxContacts). */
export const MAX_CONTACTS = 3;

/**
 * The Schengen area's countries (ISO 3166-1 alpha-2): the EU members of the area, with Bulgaria and Romania from
 * 1 January 2025, and Iceland, Liechtenstein, Norway and Switzerland. Cyprus and Ireland are not in it.
 */
export const SCHENGEN_COUNTRIES: ReadonlySet<string> = new Set([
  "AT",
  "BE",
  "BG",
  "CH",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IS",
  "IT",
  "LI",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);

/** The identity documents among Amadeus document types: those `documentTypes` accepts or refuses. */
export const IDENTITY_DOCUMENTS: ReadonlySet<DocumentType> = new Set(["PASSPORT", "IDENTITY_CARD"]);

/** `requiredFields` in the document's order. */
const FIELD_ORDER: readonly RequiredField[] = [
  "name",
  "dateOfBirth",
  "gender",
  "documents",
  "documentIssuanceCity",
  "redress",
  "residence",
  "airFranceDiscount",
  "spanishResidentDiscount",
];

// ---- Dates --------------------------------------------------------------------------------------------------------

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The parts of a `YYYY-MM-DD` date; throws for anything else (the callers pass validated dates). */
function dateParts(date: string): { year: number; month: number; day: number } {
  const match = DATE.exec(date);
  if (match === null) {
    throw new RangeError("not a YYYY-MM-DD date");
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

/** `date` plus `years` years; the 29th of February becomes the 28th in a year without it. */
export function addYears(date: string, years: number): string {
  const { year, month, day } = dateParts(date);
  const target = year + years;
  const lastDay = new Date(Date.UTC(target, month, 0)).getUTCDate();
  return `${pad(target, 4)}-${pad(month, 2)}-${pad(Math.min(day, lastDay), 2)}`;
}

/** `date` plus `days` days. */
export function addDays(date: string, days: number): string {
  const { year, month, day } = dateParts(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The UTC date of an instant. */
export function utcDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

// ---- The trip and the travellers of a priced offer ----------------------------------------------------------------

/** The flights of a priced offer as the requirements need them. */
export interface Trip {
  /** Local date of the first departure. */
  readonly firstDate: string;
  /** Local date of the last arrival: the end of the trip. */
  readonly lastDate: string;
  /** The country of every airport, `null` when unknown. */
  readonly countries: readonly (string | null)[];
}

/** A traveller of the priced offer (Amadeus `travelerPricings`). */
export interface OfferTraveler {
  readonly travelerId: string;
  readonly travelerType: TravelerType;
  readonly associatedAdultId: string | null;
}

/** The trip of a priced offer: the earliest departure and the latest arrival over its offers, and every country. */
export function tripOf(pricedOffer: Pick<PricedOffer, "offers">): Trip {
  const departures: string[] = [];
  const arrivals: string[] = [];
  const countries: (string | null)[] = [];
  for (const offer of pricedOffer.offers) {
    for (const itinerary of offer.itineraries) {
      for (const segment of itinerary.segments) {
        departures.push(segment.departure.at.slice(0, 10));
        arrivals.push(segment.arrival.at.slice(0, 10));
        countries.push(segment.departure.countryCode ?? null, segment.arrival.countryCode ?? null);
      }
    }
  }
  departures.sort();
  arrivals.sort();
  const firstDate = departures[0];
  const lastDate = arrivals.at(-1);
  if (firstDate === undefined || lastDate === undefined) {
    // A stored priced offer always has segments (parseOffer refused anything else at insert).
    throw new Error("a priced offer without flights");
  }
  return { firstDate, lastDate, countries };
}

/** The travellers of a priced offer, each once, in the order the offers list them. */
export function offerTravelersOf(pricedOffer: Pick<PricedOffer, "offers">): OfferTraveler[] {
  const found = new Map<string, OfferTraveler>();
  for (const offer of pricedOffer.offers) {
    for (const pricing of offer.travelerPricings ?? []) {
      if (!found.has(pricing.travelerId)) {
        found.set(pricing.travelerId, {
          travelerId: pricing.travelerId,
          travelerType: pricing.travelerType,
          associatedAdultId: pricing.associatedAdultId ?? null,
        });
      }
    }
  }
  return [...found.values()];
}

/** The identity documents a trip accepts: both inside one country or the Schengen area, else only a passport. */
export function acceptedDocumentTypes(trip: Trip): DocumentType[] {
  const known = trip.countries.every((country): country is string => country !== null);
  const domestic = known && new Set(trip.countries).size === 1;
  const schengen = known && trip.countries.every((country) => SCHENGEN_COUNTRIES.has(country as string));
  return domestic || schengen ? ["PASSPORT", "IDENTITY_CARD"] : ["PASSPORT"];
}

/** The valid dates of birth of a traveller type over a trip (inclusive bounds; `null` = unbounded). */
export function dateOfBirthRange(
  type: TravelerType,
  trip: Pick<Trip, "firstDate" | "lastDate">,
): { readonly min: string | null; readonly max: string | null } {
  switch (type) {
    case "CHILD":
      // Two or older at the first flight, still under 12 at the last one.
      return { min: addDays(addYears(trip.lastDate, -12), 1), max: addYears(trip.firstDate, -2) };
    case "HELD_INFANT":
    case "SEATED_INFANT":
      // Born by the first flight, still under 2 at the last one.
      return { min: addDays(addYears(trip.lastDate, -2), 1), max: trip.firstDate };
    case "SENIOR":
      return { min: null, max: addYears(trip.firstDate, -60) };
    case "ADULT":
    case "YOUNG":
    case "STUDENT":
      // 12 or older; the airline checks a fare's own upper age (youth, student) at booking.
      return { min: null, max: addYears(trip.firstDate, -12) };
  }
}

/** The input of `requirementsOf`: what the priced offer says. */
export interface RequirementsInput {
  readonly bookingRequirements: BookingRequirements;
  readonly travelers: readonly OfferTraveler[];
  readonly trip: Trip;
  readonly paymentCardRequired: boolean;
}

/** The checkout's requirements (CheckoutRequirements), see the file header. */
export function requirementsOf(input: RequirementsInput): CheckoutRequirements {
  const source = input.bookingRequirements;
  const documentTypes = acceptedDocumentTypes(input.trip);
  const travelers = input.travelers.map((traveler): CheckoutTravelerRequirement => {
    const flags = source.travelerRequirements.find((entry) => entry.travelerId === traveler.travelerId);
    const fields = new Set<RequiredField>(["name"]);
    if (flags?.dateOfBirthRequired === true || traveler.travelerType !== "ADULT") {
      fields.add("dateOfBirth");
    }
    if (flags?.genderRequired === true) {
      fields.add("gender");
    }
    if (flags?.documentRequired === true) {
      fields.add("documents");
    }
    if (flags?.documentIssuanceCityRequired === true) {
      fields.add("documents");
      fields.add("documentIssuanceCity");
    }
    if (flags?.redressRequiredIfAny === true) {
      fields.add("redress");
    }
    if (flags?.residenceRequired === true) {
      fields.add("residence");
    }
    if (flags?.airFranceDiscountRequired === true) {
      fields.add("airFranceDiscount");
    }
    if (flags?.spanishResidentDiscountRequired === true) {
      fields.add("spanishResidentDiscount");
    }
    const range = dateOfBirthRange(traveler.travelerType, input.trip);
    return {
      travelerId: traveler.travelerId,
      travelerType: traveler.travelerType,
      associatedAdultId: traveler.travelerType === "HELD_INFANT" ? traveler.associatedAdultId : null,
      dateOfBirthMin: range.min,
      dateOfBirthMax: range.max,
      requiredFields: FIELD_ORDER.filter((field) => fields.has(field)),
      documentTypes: [...documentTypes],
    };
  });
  return {
    contact: {
      emailRequired: true,
      mobilePhoneRequired: source.mobilePhoneNumberRequired,
      phoneRequired: source.phoneNumberRequired ?? false,
      phoneCountryCodeRequired: source.phoneCountryCodeRequired ?? false,
      invoiceAddressRequired: source.invoiceAddressRequired ?? false,
      mailingAddressRequired: source.mailingAddressRequired ?? false,
      postalCodeRequired: source.postalCodeRequired ?? false,
      maxContacts: MAX_CONTACTS,
    },
    travelers,
    threeDomainSecureRequired: (source.threeDomainSecureRequirements ?? []).some(
      (entry) => entry.is3dsAuthenticationRequired,
    ),
    paymentCardRequired: input.paymentCardRequired,
    source,
  };
}

/** The requirements of a checkout buying `pricedOffer` (customer scope is enough: no amount is read). */
export function requirementsForPricedOffer(
  pricedOffer: Pick<PricedOffer, "offers" | "bookingRequirements" | "paymentCardRequired">,
): CheckoutRequirements {
  return requirementsOf({
    bookingRequirements: pricedOffer.bookingRequirements,
    travelers: offerTravelersOf(pricedOffer),
    trip: tripOf(pricedOffer),
    paymentCardRequired: pricedOffer.paymentCardRequired === true,
  });
}

// ---- Formats ------------------------------------------------------------------------------------------------------

/** One part of a name: Latin letters, spaces, hyphens and apostrophes, starting with a letter (Amadeus). */
const NAME_PART = /^[A-Za-z][A-Za-z '-]*$/;
/** firstName + middleName + lastName at most (Amadeus). */
export const MAX_NAME_LENGTH = 57;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_NUMBER = /^[0-9]{1,15}$/;
const CALLING_CODE = /^\+?[0-9]{1,4}$/;
const COUNTRY = /^[A-Z]{2}$/;
/** Amadeus resident card and certificate numbers, anchored (the document's pattern is not): masked values fail it. */
export const DISCOUNT_NUMBER = /^[0-9A-Z][0-9]{0,12}[A-Z]$/;
const AIRLINE = /^[A-Z0-9]{2}$/;
const LOYALTY_ID = /^[A-Za-z0-9]{1,30}$/;
const EMERGENCY_NAME = /^[A-Za-z][A-Za-z -]*$/;

const filled = (value: string | null | undefined): value is string =>
  typeof value === "string" && value.trim() !== "";

const error = (path: string, code: FieldCode | "enum", message: string): FieldError => ({
  path,
  code,
  message,
});

// ---- Travellers ---------------------------------------------------------------------------------------------------

/** A traveller of the checkout as the cross-traveller checks compare it. */
export interface TravelerFacts {
  readonly travelerId: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly dateOfBirth: string | null;
}

/** What the traveller checks compare a request with. */
export interface TravelerCheckContext {
  readonly requirements: CheckoutRequirements;
  readonly trip: Pick<Trip, "lastDate">;
  /** Today's date (UTC): a document that expired before it is `DOCUMENT_EXPIRED`, a date of birth after it refused. */
  readonly today: string;
  /** Every traveller of the checkout as stored, for duplicates and a held infant's adult. */
  readonly stored: readonly TravelerFacts[];
}

const factsOf = (input: TravelerInput): TravelerFacts => ({
  travelerId: input.travelerId,
  firstName: input.name?.firstName ?? null,
  lastName: input.name?.lastName ?? null,
  dateOfBirth: input.dateOfBirth ?? null,
});

function nameErrors(name: AmadeusName | undefined, base: string): FieldError[] {
  if (name === undefined) {
    return [];
  }
  const errors: FieldError[] = [];
  for (const part of ["firstName", "middleName", "lastName", "secondLastName"] as const) {
    const value = name[part];
    if (value !== undefined && !NAME_PART.test(value)) {
      errors.push(
        error(
          `${base}/name/${part}`,
          "INVALID_CHARACTERS",
          "Use Latin letters, spaces, hyphens and apostrophes only, as on the travel document.",
        ),
      );
    }
  }
  const length =
    (name.firstName ?? "").length + (name.middleName ?? "").length + (name.lastName ?? "").length;
  if (length > MAX_NAME_LENGTH) {
    errors.push(
      error(
        `${base}/name`,
        "NAME_TOO_LONG",
        `First, middle and last names together may have at most ${MAX_NAME_LENGTH} characters.`,
      ),
    );
  }
  return errors;
}

function phoneErrors(phones: readonly AmadeusPhone[] | undefined, base: string): FieldError[] {
  return (phones ?? []).flatMap((phone, index) => {
    const errors: FieldError[] = [];
    if (phone.number !== undefined && !PHONE_NUMBER.test(phone.number)) {
      errors.push(
        error(`${base}/${index}/number`, "PHONE_INVALID", "Enter the phone number with digits only."),
      );
    }
    if (phone.countryCallingCode !== undefined && !CALLING_CODE.test(phone.countryCallingCode)) {
      errors.push(
        error(
          `${base}/${index}/countryCallingCode`,
          "PHONE_INVALID",
          "Enter the country calling code with one to four digits.",
        ),
      );
    }
    return errors;
  });
}

function addressErrors(address: AmadeusAddress | undefined, base: string): FieldError[] {
  return address?.countryCode !== undefined && !COUNTRY.test(address.countryCode)
    ? [error(`${base}/countryCode`, "INVALID_FORMAT", "Use the two-letter ISO country code in capitals.")]
    : [];
}

function travelerContactErrors(contact: AmadeusContact | undefined, base: string): FieldError[] {
  if (contact === undefined) {
    return [];
  }
  const errors: FieldError[] = [];
  if (contact.emailAddress !== undefined && !EMAIL.test(contact.emailAddress)) {
    errors.push(error(`${base}/emailAddress`, "EMAIL_INVALID", "Enter a valid e-mail address."));
  }
  errors.push(...phoneErrors(contact.phones, `${base}/phones`));
  errors.push(...addressErrors(contact.address, `${base}/address`));
  return errors;
}

function documentErrors(
  input: TravelerInput,
  requirement: CheckoutTravelerRequirement,
  context: TravelerCheckContext,
  base: string,
): FieldError[] {
  return (input.documents ?? []).flatMap((document, index) => {
    const path = `${base}/documents/${index}`;
    const errors: FieldError[] = [];
    if (
      IDENTITY_DOCUMENTS.has(document.documentType) &&
      !requirement.documentTypes.includes(document.documentType)
    ) {
      errors.push(
        error(
          `${path}/documentType`,
          "DOCUMENT_TYPE_NOT_ACCEPTED",
          "This document type is not accepted for this trip: use a passport.",
        ),
      );
    }
    if (document.expiryDate !== undefined) {
      if (document.expiryDate < context.today) {
        errors.push(error(`${path}/expiryDate`, "DOCUMENT_EXPIRED", "The document has expired."));
      } else if (document.expiryDate < context.trip.lastDate) {
        errors.push(
          error(
            `${path}/expiryDate`,
            "DOCUMENT_EXPIRES_BEFORE_RETURN",
            "The document expires before the last flight.",
          ),
        );
      }
    }
    if (document.issuanceDate !== undefined && document.issuanceDate > context.today) {
      errors.push(error(`${path}/issuanceDate`, "INVALID_FORMAT", "The issue date cannot be in the future."));
    }
    for (const field of ["issuanceCountry", "nationality", "validityCountry", "birthCountry"] as const) {
      const value = document[field];
      if (value !== undefined && !COUNTRY.test(value)) {
        errors.push(
          error(`${path}/${field}`, "INVALID_FORMAT", "Use the two-letter ISO country code in capitals."),
        );
      }
    }
    return errors;
  });
}

function discountErrors(discounts: readonly AmadeusDiscount[] | undefined, base: string): FieldError[] {
  return (discounts ?? []).flatMap((discount, index) => {
    const path = `${base}/discountEligibility/${index}`;
    const errors: FieldError[] = [];
    if (discount.subType === undefined) {
      errors.push(error(`${path}/subType`, "DISCOUNT_DATA_REQUIRED", "Choose the discount."));
    }
    for (const field of ["cardNumber", "certificateNumber"] as const) {
      const value = discount[field];
      if (value !== undefined && !DISCOUNT_NUMBER.test(value)) {
        errors.push(
          error(
            `${path}/${field}`,
            "INVALID_FORMAT",
            "Enter the full number as printed (digits and letters).",
          ),
        );
      }
    }
    if (discount.subType === "SPANISH_RESIDENT") {
      if (!filled(discount.cityName)) {
        errors.push(error(`${path}/cityName`, "DISCOUNT_DATA_REQUIRED", "Enter the city of residence."));
      }
      if (discount.cardNumber === undefined && discount.certificateNumber === undefined) {
        errors.push(
          error(
            `${path}/cardNumber`,
            "DISCOUNT_DATA_REQUIRED",
            "Enter the resident card or certificate number.",
          ),
        );
      }
    }
    return errors;
  });
}

function otherErrors(input: TravelerInput, base: string): FieldError[] {
  const errors: FieldError[] = [];
  (input.loyaltyPrograms ?? []).forEach((program, index) => {
    if (program.programOwner !== undefined && !AIRLINE.test(program.programOwner)) {
      errors.push(
        error(
          `${base}/loyaltyPrograms/${index}/programOwner`,
          "INVALID_FORMAT",
          "Use the airline's two-character code.",
        ),
      );
    }
    if (program.id !== undefined && !LOYALTY_ID.test(program.id)) {
      errors.push(
        error(`${base}/loyaltyPrograms/${index}/id`, "INVALID_FORMAT", "Enter the membership number."),
      );
    }
  });
  const emergency = input.emergencyContact;
  if (emergency !== undefined) {
    if (emergency.addresseeName !== undefined && !EMERGENCY_NAME.test(emergency.addresseeName)) {
      errors.push(
        error(
          `${base}/emergencyContact/addresseeName`,
          "INVALID_CHARACTERS",
          "Use Latin letters, spaces and hyphens only.",
        ),
      );
    }
    if (emergency.countryCode !== undefined && !COUNTRY.test(emergency.countryCode)) {
      errors.push(
        error(
          `${base}/emergencyContact/countryCode`,
          "INVALID_FORMAT",
          "Use the two-letter ISO country code in capitals.",
        ),
      );
    }
    if (emergency.number !== undefined && !PHONE_NUMBER.test(emergency.number)) {
      errors.push(
        error(`${base}/emergencyContact/number`, "PHONE_INVALID", "Enter the phone number with digits only."),
      );
    }
  }
  return errors;
}

/** The key of the duplicate check: the name in capitals and the date of birth, or `undefined` when one is missing. */
function identityKey(facts: TravelerFacts): string | undefined {
  return filled(facts.firstName) && filled(facts.lastName) && facts.dateOfBirth !== null
    ? `${facts.firstName.trim().toUpperCase()}|${facts.lastName.trim().toUpperCase()}|${facts.dateOfBirth}`
    : undefined;
}

/**
 * The problems of the travellers a setTravelers request sends (TRAVELER_DATA_INVALID `fieldErrors`), in request order;
 * empty when every listed traveller may be stored. See the file header for what is checked and what is left to
 * `progress.missing`.
 */
export function travelerErrors(
  inputs: readonly TravelerInput[],
  context: TravelerCheckContext,
): FieldError[] {
  const requirements = new Map(context.requirements.travelers.map((entry) => [entry.travelerId, entry]));
  const seen = new Set<string>();
  // The travellers after the request applies: the request's data replaces the stored data of the same traveller.
  const after = new Map(context.stored.map((facts) => [facts.travelerId, facts]));
  for (const input of inputs) {
    if (requirements.has(input.travelerId)) {
      after.set(input.travelerId, factsOf(input));
    }
  }
  const errors: FieldError[] = [];
  inputs.forEach((input, index) => {
    const base = `/travelers/${index}`;
    const requirement = requirements.get(input.travelerId);
    if (requirement === undefined) {
      errors.push(
        error(`${base}/travelerId`, "UNKNOWN_TRAVELER_ID", "This traveller is not part of the priced offer."),
      );
      return;
    }
    if (seen.has(input.travelerId)) {
      errors.push(error(`${base}/travelerId`, "DUPLICATE_TRAVELER", "This traveller is listed twice."));
      return;
    }
    seen.add(input.travelerId);
    if (input.savedTravelerId !== undefined) {
      errors.push(
        error(`${base}/savedTravelerId`, "SAVED_TRAVELER_NOT_FOUND", "No saved traveller with this id."),
      );
    }
    errors.push(...nameErrors(input.name, base));
    if (input.dateOfBirth !== undefined) {
      const min = requirement.dateOfBirthMin ?? null;
      const max = requirement.dateOfBirthMax ?? null;
      if (input.dateOfBirth > context.today) {
        // An infant's range reaches the first flight's day, but nobody can be booked before being born.
        errors.push(
          error(
            `${base}/dateOfBirth`,
            "AGE_MISMATCH_TRAVELER_TYPE",
            "The date of birth cannot be in the future.",
          ),
        );
      } else if ((min !== null && input.dateOfBirth < min) || (max !== null && input.dateOfBirth > max)) {
        errors.push(
          error(
            `${base}/dateOfBirth`,
            "AGE_MISMATCH_TRAVELER_TYPE",
            "The date of birth does not match the traveller type at the travel dates.",
          ),
        );
      } else {
        errors.push(...infantErrors(input, requirement, context.requirements, after, base));
      }
    }
    errors.push(...documentErrors(input, requirement, context, base));
    errors.push(...discountErrors(input.discountEligibility, base));
    errors.push(...travelerContactErrors(input.contact, `${base}/contact`));
    errors.push(...otherErrors(input, base));
    const key = identityKey(factsOf(input));
    const twin =
      key === undefined
        ? undefined
        : [...after.values()].find(
            (facts) => facts.travelerId !== input.travelerId && identityKey(facts) === key,
          );
    if (twin !== undefined) {
      errors.push(
        error(`${base}/name`, "DUPLICATE_TRAVELER", "Another traveller has the same name and date of birth."),
      );
    }
  });
  return errors.slice(0, MAX_FIELD_ERRORS);
}

/** A held infant must be younger than its adult: checked on the infant, and on an adult sent with a stored infant. */
function infantErrors(
  input: TravelerInput,
  requirement: CheckoutTravelerRequirement,
  requirements: CheckoutRequirements,
  after: ReadonlyMap<string, TravelerFacts>,
  base: string,
): FieldError[] {
  const birth = input.dateOfBirth;
  if (birth === undefined) {
    return [];
  }
  const pairs =
    requirement.travelerType === "HELD_INFANT"
      ? [{ infant: birth, adult: after.get(requirement.associatedAdultId ?? "")?.dateOfBirth ?? null }]
      : requirements.travelers
          .filter(
            (entry) => entry.travelerType === "HELD_INFANT" && entry.associatedAdultId === input.travelerId,
          )
          .map((entry) => ({ infant: after.get(entry.travelerId)?.dateOfBirth ?? null, adult: birth }));
  return pairs.some((pair) => pair.infant !== null && pair.adult !== null && pair.infant <= pair.adult)
    ? [
        error(
          `${base}/dateOfBirth`,
          "INFANT_OLDER_THAN_ADULT",
          "A lap infant must be younger than the adult who carries it.",
        ),
      ]
    : [];
}

/** A stored traveller as the completeness checks read it (decrypted documents included). */
export interface TravelerData {
  readonly name: AmadeusName | null;
  readonly dateOfBirth: string | null;
  readonly gender: string | null;
  readonly contact: AmadeusContact | null;
  readonly documents: ReadonlyArray<{
    readonly documentType: DocumentType;
    readonly issuanceLocation?: string;
  }>;
  readonly discountEligibility: readonly AmadeusDiscount[];
}

/** The index of the traveller's accepted identity document, or -1. */
function identityDocumentIndex(data: TravelerData, requirement: CheckoutTravelerRequirement): number {
  return data.documents.findIndex((document) => requirement.documentTypes.includes(document.documentType));
}

/** Whether `field` is still missing (a redress number is required only if the traveller has one: never missing). */
function isMissing(
  field: RequiredField,
  data: TravelerData,
  requirement: CheckoutTravelerRequirement,
): boolean {
  switch (field) {
    case "name":
      return !filled(data.name?.firstName) || !filled(data.name?.lastName);
    case "dateOfBirth":
      return data.dateOfBirth === null;
    case "gender":
      return data.gender === null;
    case "documents":
      return identityDocumentIndex(data, requirement) < 0;
    case "documentIssuanceCity": {
      const document = data.documents[identityDocumentIndex(data, requirement)];
      return !filled(document?.issuanceLocation);
    }
    case "redress":
      return false;
    case "residence":
      return !filled(data.contact?.address?.countryCode);
    case "airFranceDiscount":
      return !data.discountEligibility.some(
        (discount) => discount.subType?.startsWith("AIR_FRANCE_") === true,
      );
    case "spanishResidentDiscount":
      return !data.discountEligibility.some(
        (discount) =>
          discount.subType === "SPANISH_RESIDENT" &&
          filled(discount.cityName) &&
          (discount.cardNumber !== undefined || discount.certificateNumber !== undefined),
      );
  }
}

/** The required fields a stored traveller still lacks (Traveler.missingFields). */
export function missingFieldsOf(
  data: TravelerData,
  requirement: CheckoutTravelerRequirement,
): RequiredField[] {
  return requirement.requiredFields.filter((field) => isMissing(field, data, requirement));
}

const MISSING_MESSAGES: Readonly<Record<RequiredField, string>> = {
  name: "Enter the first and last name as on the travel document.",
  dateOfBirth: "Enter the date of birth.",
  gender: "Choose the gender.",
  documents: "An identity document is required for this trip.",
  documentIssuanceCity: "Enter the place of issue of the identity document.",
  redress: "Enter the redress number.",
  residence: "Enter the country of residence.",
  airFranceDiscount: "Enter the Air France discount card.",
  spanishResidentDiscount: "Enter the Spanish resident discount details.",
};

/** What a stored traveller (the `index`th of the checkout) still lacks, as `progress.missing` entries. */
export function missingErrorsOf(
  index: number,
  data: TravelerData,
  requirement: CheckoutTravelerRequirement,
): FieldError[] {
  const base = `/travelers/${index}`;
  return missingFieldsOf(data, requirement).map((field) => {
    const message = MISSING_MESSAGES[field];
    switch (field) {
      case "documentIssuanceCity": {
        const document = identityDocumentIndex(data, requirement);
        return error(
          document < 0 ? `${base}/documents` : `${base}/documents/${document}/issuanceLocation`,
          "REQUIRED",
          message,
        );
      }
      case "residence":
        return error(`${base}/contact/address`, "REQUIRED", message);
      case "airFranceDiscount":
      case "spanishResidentDiscount":
        return error(`${base}/discountEligibility`, "DISCOUNT_DATA_REQUIRED", message);
      case "name":
      case "dateOfBirth":
      case "gender":
      case "documents":
      case "redress":
        return error(`${base}/${field}`, "REQUIRED", message);
    }
  });
}

// ---- Contacts -----------------------------------------------------------------------------------------------------

/** A contact as the contact checks read it: a request's ContactInput, or a stored contact. */
export type ContactData = Pick<ContactInput, "purpose" | "isPrimary" | "emailAddress" | "phones" | "address">;

/**
 * The index of the primary contact: the one marked `isPrimary`, else the first; `-1` for an empty list, `-2` when
 * several are marked.
 */
export function primaryIndexOf(contacts: readonly ContactData[]): number {
  const marked = contacts.flatMap((contact, index) => (contact.isPrimary === true ? [index] : []));
  if (marked.length > 1) {
    return -2;
  }
  return marked[0] ?? (contacts.length > 0 ? 0 : -1);
}

/**
 * The problems of a list of contacts against the requirements (CONTACT_DATA_INVALID `fieldErrors` for a request, or
 * `progress.missing` for a stored list), with paths `/contacts/...`.
 */
export function contactErrors(
  contacts: readonly ContactData[],
  requirement: CheckoutContactRequirements,
): FieldError[] {
  const errors: FieldError[] = [];
  if (contacts.length > requirement.maxContacts) {
    errors.push(
      error("/contacts", "TOO_MANY_CONTACTS", `At most ${requirement.maxContacts} contacts can be given.`),
    );
  }
  contacts.forEach((contact, index) => {
    const base = `/contacts/${index}`;
    if (contact.emailAddress !== undefined && !EMAIL.test(contact.emailAddress)) {
      errors.push(error(`${base}/emailAddress`, "EMAIL_INVALID", "Enter a valid e-mail address."));
    }
    errors.push(...phoneErrors(contact.phones, `${base}/phones`));
    errors.push(...addressErrors(contact.address, `${base}/address`));
    if (requirement.phoneCountryCodeRequired) {
      (contact.phones ?? []).forEach((phone, phoneIndex) => {
        if (!filled(phone.countryCallingCode)) {
          errors.push(
            error(
              `${base}/phones/${phoneIndex}/countryCallingCode`,
              "COUNTRY_CALLING_CODE_REQUIRED",
              "Add the country calling code.",
            ),
          );
        }
      });
    }
    if (
      requirement.postalCodeRequired &&
      contact.address !== undefined &&
      !filled(contact.address.postalCode)
    ) {
      errors.push(error(`${base}/address/postalCode`, "POSTAL_CODE_REQUIRED", "Add the postal code."));
    }
  });
  const primary = primaryIndexOf(contacts);
  if (primary === -1) {
    errors.push(
      error("/contacts", "PRIMARY_CONTACT_REQUIRED", "Add a primary contact with an e-mail address."),
    );
    return errors.slice(0, MAX_FIELD_ERRORS);
  }
  if (primary === -2) {
    errors.push(
      error("/contacts", "PRIMARY_CONTACT_REQUIRED", "Mark exactly one contact as the primary contact."),
    );
    return errors.slice(0, MAX_FIELD_ERRORS);
  }
  const lead = contacts[primary] as ContactData;
  const base = `/contacts/${primary}`;
  if ((lead.purpose ?? "STANDARD") !== "STANDARD") {
    errors.push(
      error(`${base}/purpose`, "PRIMARY_CONTACT_REQUIRED", "The primary contact must be a standard contact."),
    );
  }
  if (!filled(lead.emailAddress)) {
    errors.push(
      error(
        `${base}/emailAddress`,
        "PRIMARY_CONTACT_REQUIRED",
        "The primary contact needs an e-mail address.",
      ),
    );
  }
  const phones = lead.phones ?? [];
  if (
    requirement.mobilePhoneRequired &&
    !phones.some((phone) => phone.deviceType === "MOBILE" && filled(phone.number))
  ) {
    errors.push(error(`${base}/phones`, "MOBILE_PHONE_REQUIRED", "Add a mobile phone number."));
  } else if (requirement.phoneRequired && !phones.some((phone) => filled(phone.number))) {
    errors.push(error(`${base}/phones`, "REQUIRED", "Add a phone number."));
  }
  if (requirement.mailingAddressRequired && !filled(lead.address?.countryCode)) {
    errors.push(error(`${base}/address`, "REQUIRED", "Add the postal address."));
  }
  if (
    requirement.invoiceAddressRequired &&
    !contacts.some((contact) => contact.purpose === "INVOICE" && filled(contact.address?.countryCode))
  ) {
    errors.push(error("/contacts", "INVOICE_ADDRESS_REQUIRED", "Add an invoice contact with its address."));
  }
  return errors.slice(0, MAX_FIELD_ERRORS);
}

// ---- Remarks ------------------------------------------------------------------------------------------------------

/** The traveller ids of remarks that are not travellers of the checkout (`400 VALIDATION_FAILED` field errors). */
export function remarkErrors(
  remarks: readonly RemarkInput[],
  travelerIds: ReadonlySet<string>,
): FieldError[] {
  return remarks
    .flatMap((remark, index) =>
      (remark.travelerIds ?? []).flatMap((travelerId, position) =>
        travelerIds.has(travelerId)
          ? []
          : [
              error(
                `/remarks/${index}/travelerIds/${position}`,
                "enum",
                "This traveller is not part of the checkout.",
              ),
            ],
      ),
    )
    .slice(0, MAX_FIELD_ERRORS);
}
