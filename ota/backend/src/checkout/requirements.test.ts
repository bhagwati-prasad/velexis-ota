// Unit tests of the checkout requirements and the traveller, contact and remark checks (OBE-036): pure functions, so
// every case is a value in and a value out. Dates are fixed strings here on purpose: the functions take the trip and
// `today` as arguments and never read the clock, so a test date never "passes".
import type { components } from "@velexis/api-types";
import { describe, expect, it } from "vitest";
import {
  acceptedDocumentTypes,
  addDays,
  addYears,
  contactErrors,
  dateOfBirthRange,
  MAX_NAME_LENGTH,
  missingErrorsOf,
  missingFieldsOf,
  offerTravelersOf,
  primaryIndexOf,
  remarkErrors,
  requirementsForPricedOffer,
  requirementsOf,
  travelerErrors,
  tripOf,
  type CheckoutRequirements,
  type ContactInput,
  type TravelerCheckContext,
  type TravelerData,
  type TravelerInput,
} from "./requirements";

type Schemas = components["schemas"];
type PricedOffer = Schemas["PricedOffer"];
type BookingRequirements = Schemas["PricingBookingRequirements"];

/** A segment endpoint of a priced offer's FlightOffer. */
const endpoint = (iataCode: string, at: string, countryCode: string | null) => ({
  iataCode,
  at,
  countryCode,
});

/**
 * A priced offer with what the requirements read: the itineraries (segment dates and countries), the travellers and
 * the booking requirements. The document's CheckoutExample trip: Paris CDG – New York JFK and back.
 */
function pricedOffer(options: {
  readonly segments?: ReadonlyArray<readonly [ReturnType<typeof endpoint>, ReturnType<typeof endpoint>]>;
  readonly travelers?: ReadonlyArray<{
    travelerId: string;
    travelerType: string;
    associatedAdultId?: string;
  }>;
  readonly bookingRequirements?: BookingRequirements;
  readonly paymentCardRequired?: boolean;
}): Pick<PricedOffer, "offers" | "bookingRequirements" | "paymentCardRequired"> {
  const segments = options.segments ?? [
    [endpoint("CDG", "2026-11-20T10:25:00", "FR"), endpoint("JFK", "2026-11-20T12:45:00", "US")],
    [endpoint("JFK", "2026-11-27T18:30:00", "US"), endpoint("CDG", "2026-11-28T07:55:00", "FR")],
  ];
  const travelers = options.travelers ?? [
    { travelerId: "1", travelerType: "ADULT" },
    { travelerId: "2", travelerType: "CHILD" },
  ];
  return {
    offers: [
      {
        itineraries: segments.map(([departure, arrival], index) => ({
          index,
          segments: [{ id: String(index + 1), departure, arrival }],
        })),
        travelerPricings: travelers.map((traveler) => ({
          ...traveler,
          fareOption: "STANDARD",
          segments: [],
        })),
      },
    ],
    bookingRequirements: options.bookingRequirements ?? {
      emailAddressRequired: true,
      mobilePhoneNumberRequired: true,
      phoneCountryCodeRequired: true,
      travelerRequirements: travelers.map((traveler) => ({
        travelerId: traveler.travelerId,
        genderRequired: true,
        documentRequired: true,
        dateOfBirthRequired: true,
        redressRequiredIfAny: true,
      })),
      threeDomainSecureRequirements: [
        { offerIds: ["off_01JA4CA1Q8T1W4Z7C0F3J6M9P2"], is3dsAuthenticationRequired: true },
      ],
    },
    paymentCardRequired: options.paymentCardRequired ?? false,
  } as unknown as Pick<PricedOffer, "offers" | "bookingRequirements" | "paymentCardRequired">;
}

/** The Madrid – Paris Orly trip of the Amadeus stub: both airports in the Schengen area. */
const SCHENGEN_TRIP = [
  [endpoint("MAD", "2027-01-15T07:15:00", "ES"), endpoint("ORY", "2027-01-15T09:20:00", "FR")],
] as const;

const TODAY = "2026-10-19";

/** The context of the traveller checks for `requirements`, the trip ending on 2026-11-28. */
function context(
  requirements: CheckoutRequirements,
  stored: TravelerCheckContext["stored"] = [],
): TravelerCheckContext {
  return { requirements, trip: { lastDate: "2026-11-28" }, today: TODAY, stored };
}

/** A complete adult as setTravelers takes it (synthetic data, no real person). */
const adult = (overrides: Partial<TravelerInput> = {}): TravelerInput => ({
  travelerId: "1",
  name: { firstName: "TESTA", lastName: "SAMPLE" },
  dateOfBirth: "1988-04-12",
  gender: "FEMALE",
  documents: [
    {
      documentType: "PASSPORT",
      number: "X1234567",
      expiryDate: "2031-05-14",
      issuanceCountry: "SE",
      nationality: "SE",
      holder: true,
    },
  ],
  ...overrides,
});

const codes = (errors: ReadonlyArray<{ path: string; code: string }>) =>
  errors.map((error) => [error.path, error.code]);

describe("requirementsOf", () => {
  it("derives the document's example requirements for a round trip with an adult and a child [OBE-036 AC1]", () => {
    const requirements = requirementsForPricedOffer(pricedOffer({}));

    expect(requirements.contact).toEqual({
      emailRequired: true,
      mobilePhoneRequired: true,
      phoneRequired: false,
      phoneCountryCodeRequired: true,
      invoiceAddressRequired: false,
      mailingAddressRequired: false,
      postalCodeRequired: false,
      maxContacts: 3,
    });
    expect(requirements.travelers).toEqual([
      {
        travelerId: "1",
        travelerType: "ADULT",
        associatedAdultId: null,
        dateOfBirthMin: null,
        dateOfBirthMax: "2014-11-20",
        requiredFields: ["name", "dateOfBirth", "gender", "documents", "redress"],
        documentTypes: ["PASSPORT"],
      },
      {
        travelerId: "2",
        travelerType: "CHILD",
        associatedAdultId: null,
        dateOfBirthMin: "2014-11-29",
        dateOfBirthMax: "2024-11-20",
        requiredFields: ["name", "dateOfBirth", "gender", "documents", "redress"],
        documentTypes: ["PASSPORT"],
      },
    ]);
    expect(requirements.threeDomainSecureRequired).toBe(true);
    expect(requirements.paymentCardRequired).toBe(false);
    expect(requirements.source).toMatchObject({ emailAddressRequired: true });
  });

  it("requires only the name of an adult without flags, and the date of birth of every other type", () => {
    const requirements = requirementsOf({
      bookingRequirements: {
        emailAddressRequired: false,
        mobilePhoneNumberRequired: false,
        travelerRequirements: [],
      },
      travelers: [
        { travelerId: "1", travelerType: "ADULT", associatedAdultId: null },
        { travelerId: "2", travelerType: "HELD_INFANT", associatedAdultId: "1" },
        { travelerId: "3", travelerType: "SENIOR", associatedAdultId: null },
      ],
      trip: { firstDate: "2026-11-20", lastDate: "2026-11-28", countries: ["FR", "FR"] },
      paymentCardRequired: true,
    });

    expect(requirements.contact.emailRequired).toBe(true);
    expect(requirements.travelers.map((entry) => [entry.travelerId, entry.requiredFields])).toEqual([
      ["1", ["name"]],
      ["2", ["name", "dateOfBirth"]],
      ["3", ["name", "dateOfBirth"]],
    ]);
    expect(requirements.travelers[1]).toMatchObject({
      associatedAdultId: "1",
      dateOfBirthMin: "2024-11-29",
      dateOfBirthMax: "2026-11-20",
    });
    expect(requirements.travelers[2]).toMatchObject({ dateOfBirthMin: null, dateOfBirthMax: "1966-11-20" });
    expect(requirements.threeDomainSecureRequired).toBe(false);
    expect(requirements.paymentCardRequired).toBe(true);
  });

  it("adds the issuance city, residence and discount fields their flags name", () => {
    const requirements = requirementsOf({
      bookingRequirements: {
        emailAddressRequired: true,
        mobilePhoneNumberRequired: false,
        travelerRequirements: [
          {
            travelerId: "1",
            documentIssuanceCityRequired: true,
            residenceRequired: true,
            airFranceDiscountRequired: true,
            spanishResidentDiscountRequired: true,
          },
        ],
      },
      travelers: [{ travelerId: "1", travelerType: "ADULT", associatedAdultId: "9" }],
      trip: { firstDate: "2026-11-20", lastDate: "2026-11-28", countries: ["ES", "ES"] },
      paymentCardRequired: false,
    });

    expect(requirements.travelers[0]).toMatchObject({
      associatedAdultId: null,
      requiredFields: [
        "name",
        "documents",
        "documentIssuanceCity",
        "residence",
        "airFranceDiscount",
        "spanishResidentDiscount",
      ],
    });
  });

  it("accepts identity cards inside one country or the Schengen area only", () => {
    const trip = (countries: (string | null)[]) => ({
      firstDate: "2026-11-20",
      lastDate: "2026-11-28",
      countries,
    });
    expect(acceptedDocumentTypes(trip(["ES", "FR"]))).toEqual(["PASSPORT", "IDENTITY_CARD"]);
    expect(acceptedDocumentTypes(trip(["NO", "CH", "BG", "RO"]))).toEqual(["PASSPORT", "IDENTITY_CARD"]);
    expect(acceptedDocumentTypes(trip(["GB", "GB"]))).toEqual(["PASSPORT", "IDENTITY_CARD"]);
    expect(acceptedDocumentTypes(trip(["FR", "GB"]))).toEqual(["PASSPORT"]);
    expect(acceptedDocumentTypes(trip(["FR", "IE"]))).toEqual(["PASSPORT"]);
    expect(acceptedDocumentTypes(trip(["ES", null]))).toEqual(["PASSPORT"]);
    expect(
      requirementsForPricedOffer(pricedOffer({ segments: SCHENGEN_TRIP })).travelers[0]?.documentTypes,
    ).toEqual(["PASSPORT", "IDENTITY_CARD"]);
  });
});

describe("dates and trips", () => {
  it("moves dates by calendar years and days, the 29th of February to the 28th", () => {
    expect(addYears("2028-02-29", -2)).toBe("2026-02-28");
    expect(addYears("2028-02-29", -12)).toBe("2016-02-29");
    expect(addYears("2026-11-20", -12)).toBe("2014-11-20");
    expect(addDays("2014-11-28", 1)).toBe("2014-11-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
  });

  it("bounds the date of birth of each type over the trip", () => {
    const trip = { firstDate: "2026-11-20", lastDate: "2026-11-28" };
    expect(dateOfBirthRange("ADULT", trip)).toEqual({ min: null, max: "2014-11-20" });
    expect(dateOfBirthRange("STUDENT", trip)).toEqual({ min: null, max: "2014-11-20" });
    expect(dateOfBirthRange("CHILD", trip)).toEqual({ min: "2014-11-29", max: "2024-11-20" });
    expect(dateOfBirthRange("SEATED_INFANT", trip)).toEqual({ min: "2024-11-29", max: "2026-11-20" });
    expect(dateOfBirthRange("SENIOR", trip)).toEqual({ min: null, max: "1966-11-20" });
  });

  it("reads the trip and the travellers of a priced offer", () => {
    const offer = pricedOffer({
      travelers: [
        { travelerId: "1", travelerType: "ADULT" },
        { travelerId: "2", travelerType: "HELD_INFANT", associatedAdultId: "1" },
      ],
    });
    expect(tripOf(offer)).toEqual({
      firstDate: "2026-11-20",
      lastDate: "2026-11-28",
      countries: ["FR", "US", "US", "FR"],
    });
    expect(offerTravelersOf(offer)).toEqual([
      { travelerId: "1", travelerType: "ADULT", associatedAdultId: null },
      { travelerId: "2", travelerType: "HELD_INFANT", associatedAdultId: "1" },
    ]);
  });
});

describe("travelerErrors", () => {
  const requirements = requirementsForPricedOffer(pricedOffer({}));

  it("accepts a valid traveller, and one whose required data is still missing [OBE-036 AC1]", () => {
    expect(travelerErrors([adult()], context(requirements))).toEqual([]);
    expect(travelerErrors([{ travelerId: "2", name: { firstName: "LEO" } }], context(requirements))).toEqual(
      [],
    );
  });

  it("refuses unknown and repeated traveller ids, and saved travellers (deferred)", () => {
    expect(
      codes(
        travelerErrors(
          [
            adult({ travelerId: "7" }),
            adult(),
            adult(),
            { travelerId: "2", savedTravelerId: "trv_01J9ZQ4Hq9Lm2Xp7Rt5Wz1" },
          ],
          context(requirements),
        ),
      ),
    ).toEqual([
      ["/travelers/0/travelerId", "UNKNOWN_TRAVELER_ID"],
      ["/travelers/2/travelerId", "DUPLICATE_TRAVELER"],
      ["/travelers/3/savedTravelerId", "SAVED_TRAVELER_NOT_FOUND"],
    ]);
  });

  it("refuses names outside the Latin set and names over 57 characters", () => {
    const long = "A".repeat(MAX_NAME_LENGTH - 9);
    expect(
      codes(
        travelerErrors(
          [
            adult({ name: { firstName: "JOSÉ", lastName: "O'NEIL-SMITH", middleName: "1X" } }),
            { travelerId: "2", name: { firstName: long, lastName: "TENLETTERS" } },
          ],
          context(requirements),
        ),
      ),
    ).toEqual([
      ["/travelers/0/name/firstName", "INVALID_CHARACTERS"],
      ["/travelers/0/name/middleName", "INVALID_CHARACTERS"],
      ["/travelers/1/name", "NAME_TOO_LONG"],
    ]);
  });

  it("checks the date of birth against the traveller type and a held infant against its adult", () => {
    expect(codes(travelerErrors([adult({ dateOfBirth: "2015-01-01" })], context(requirements)))).toEqual([
      ["/travelers/0/dateOfBirth", "AGE_MISMATCH_TRAVELER_TYPE"],
    ]);
    // A child must still be under 12 on the last flight's day (2026-11-28) and 2 or older on the first (2026-11-20).
    expect(
      codes(travelerErrors([{ travelerId: "2", dateOfBirth: "2014-11-28" }], context(requirements))),
    ).toEqual([["/travelers/0/dateOfBirth", "AGE_MISMATCH_TRAVELER_TYPE"]]);
    expect(travelerErrors([{ travelerId: "2", dateOfBirth: "2014-11-29" }], context(requirements))).toEqual(
      [],
    );
    expect(travelerErrors([{ travelerId: "2", dateOfBirth: "2024-11-20" }], context(requirements))).toEqual(
      [],
    );
    expect(
      codes(travelerErrors([{ travelerId: "2", dateOfBirth: "2024-11-21" }], context(requirements))),
    ).toEqual([["/travelers/0/dateOfBirth", "AGE_MISMATCH_TRAVELER_TYPE"]]);

    const withInfant = requirementsForPricedOffer(
      pricedOffer({
        travelers: [
          { travelerId: "1", travelerType: "ADULT" },
          { travelerId: "2", travelerType: "HELD_INFANT", associatedAdultId: "1" },
        ],
      }),
    );
    expect(
      travelerErrors([adult(), { travelerId: "2", dateOfBirth: "2025-06-01" }], context(withInfant)),
    ).toEqual([]);
    // The ranges keep a valid adult older than a valid infant; the check also covers what is stored, whatever it is.
    const stored = [{ travelerId: "1", firstName: "TESTA", lastName: "SAMPLE", dateOfBirth: "2025-07-01" }];
    expect(
      codes(travelerErrors([{ travelerId: "2", dateOfBirth: "2025-06-01" }], context(withInfant, stored))),
    ).toEqual([["/travelers/0/dateOfBirth", "INFANT_OLDER_THAN_ADULT"]]);
    const storedInfant = [{ travelerId: "2", firstName: null, lastName: null, dateOfBirth: "2014-11-20" }];
    expect(
      codes(travelerErrors([adult({ dateOfBirth: "2014-11-20" })], context(withInfant, storedInfant))),
    ).toEqual([["/travelers/0/dateOfBirth", "INFANT_OLDER_THAN_ADULT"]]);
  });

  it("refuses a date of birth after today, even inside an infant's range up to the first flight", () => {
    const withInfant = requirementsForPricedOffer(
      pricedOffer({
        travelers: [
          { travelerId: "1", travelerType: "ADULT" },
          { travelerId: "2", travelerType: "HELD_INFANT", associatedAdultId: "1" },
        ],
      }),
    );
    // The infant's range ends on the first flight's day (2026-11-20); today is 2026-10-19.
    expect(withInfant.travelers[1]?.dateOfBirthMax).toBe("2026-11-20");
    expect(
      codes(travelerErrors([{ travelerId: "2", dateOfBirth: "2026-10-20" }], context(withInfant))),
    ).toEqual([["/travelers/0/dateOfBirth", "AGE_MISMATCH_TRAVELER_TYPE"]]);
    expect(travelerErrors([{ travelerId: "2", dateOfBirth: TODAY }], context(withInfant))).toEqual([]);
  });

  it("refuses expired documents, documents that expire before the last flight and identity cards abroad [OBE-036 AC1]", () => {
    const document = adult().documents?.[0];
    if (document === undefined) {
      throw new Error("the adult has a document");
    }
    expect(
      codes(
        travelerErrors(
          [
            adult({
              documents: [
                { ...document, expiryDate: "2026-10-18" },
                { ...document, expiryDate: "2026-11-27" },
                { ...document, documentType: "IDENTITY_CARD", expiryDate: "2026-11-28" },
                { ...document, documentType: "VISA", issuanceDate: "2026-10-20", issuanceCountry: "us" },
              ],
            }),
          ],
          context(requirements),
        ),
      ),
    ).toEqual([
      ["/travelers/0/documents/0/expiryDate", "DOCUMENT_EXPIRED"],
      ["/travelers/0/documents/1/expiryDate", "DOCUMENT_EXPIRES_BEFORE_RETURN"],
      ["/travelers/0/documents/2/documentType", "DOCUMENT_TYPE_NOT_ACCEPTED"],
      ["/travelers/0/documents/3/issuanceDate", "INVALID_FORMAT"],
      ["/travelers/0/documents/3/issuanceCountry", "INVALID_FORMAT"],
    ]);
  });

  it("refuses masked or malformed discount numbers and incomplete resident entries", () => {
    expect(
      codes(
        travelerErrors(
          [
            adult({
              discountEligibility: [
                { subType: "SPANISH_RESIDENT", cityName: "PALMA", cardNumber: "•••••678Z" },
                { subType: "SPANISH_RESIDENT" },
                { cardNumber: "12345678Z" },
              ],
            }),
          ],
          context(requirements),
        ),
      ),
    ).toEqual([
      ["/travelers/0/discountEligibility/0/cardNumber", "INVALID_FORMAT"],
      ["/travelers/0/discountEligibility/1/cityName", "DISCOUNT_DATA_REQUIRED"],
      ["/travelers/0/discountEligibility/1/cardNumber", "DISCOUNT_DATA_REQUIRED"],
      ["/travelers/0/discountEligibility/2/subType", "DISCOUNT_DATA_REQUIRED"],
    ]);
  });

  it("checks phones, e-mails, loyalty programmes and the emergency contact", () => {
    expect(
      codes(
        travelerErrors(
          [
            adult({
              contact: {
                emailAddress: "not-an-address",
                phones: [{ deviceType: "MOBILE", countryCallingCode: "+34x", number: "61 234" }],
              },
              loyaltyPrograms: [{ programOwner: "AFX", id: "2084471234" }],
              emergencyContact: { addresseeName: "JUAN P3REZ", countryCode: "es", number: "6111-11111" },
            }),
          ],
          context(requirements),
        ),
      ),
    ).toEqual([
      ["/travelers/0/contact/emailAddress", "EMAIL_INVALID"],
      ["/travelers/0/contact/phones/0/number", "PHONE_INVALID"],
      ["/travelers/0/contact/phones/0/countryCallingCode", "PHONE_INVALID"],
      ["/travelers/0/loyaltyPrograms/0/programOwner", "INVALID_FORMAT"],
      ["/travelers/0/emergencyContact/addresseeName", "INVALID_CHARACTERS"],
      ["/travelers/0/emergencyContact/countryCode", "INVALID_FORMAT"],
      ["/travelers/0/emergencyContact/number", "PHONE_INVALID"],
    ]);
  });

  it("refuses two travellers with the same name and date of birth, stored or sent", () => {
    const adults = requirementsForPricedOffer(
      pricedOffer({
        travelers: [
          { travelerId: "1", travelerType: "ADULT" },
          { travelerId: "2", travelerType: "ADULT" },
        ],
      }),
    );
    const twin = adult({ travelerId: "2", name: { firstName: "testa", lastName: "Sample" } });
    expect(codes(travelerErrors([adult(), twin], context(adults)))).toEqual([
      ["/travelers/0/name", "DUPLICATE_TRAVELER"],
      ["/travelers/1/name", "DUPLICATE_TRAVELER"],
    ]);
    const stored = [{ travelerId: "2", firstName: "TESTA", lastName: "SAMPLE", dateOfBirth: "1988-04-12" }];
    expect(codes(travelerErrors([adult()], context(adults, stored)))).toEqual([
      ["/travelers/0/name", "DUPLICATE_TRAVELER"],
    ]);
    // The request replaces the stored data of the traveller it lists.
    expect(travelerErrors([adult(), { travelerId: "2" }], context(adults, stored))).toEqual([]);
  });

  it("never puts a submitted value into a message", () => {
    const errors = travelerErrors(
      [
        adult({
          name: { firstName: "ZOË", lastName: "QUIXOTE-ÑANDÚ" },
          documents: [
            { documentType: "PASSPORT", number: "SECRET99", expiryDate: "2020-01-01", issuanceCountry: "SE" },
          ],
          discountEligibility: [{ subType: "SPANISH_RESIDENT", cityName: "PALMA", cardNumber: "•••••678Z" }],
        }),
      ],
      context(requirements),
    );
    expect(errors.length).toBeGreaterThan(0);
    for (const value of ["ZOË", "QUIXOTE", "SECRET99", "2020-01-01", "678Z", "PALMA"]) {
      expect(JSON.stringify(errors)).not.toContain(value);
    }
  });
});

describe("missing fields", () => {
  const requirements = requirementsForPricedOffer(
    pricedOffer({
      bookingRequirements: {
        emailAddressRequired: true,
        mobilePhoneNumberRequired: false,
        travelerRequirements: [
          {
            travelerId: "1",
            genderRequired: true,
            documentRequired: true,
            documentIssuanceCityRequired: true,
            residenceRequired: true,
            spanishResidentDiscountRequired: true,
            redressRequiredIfAny: true,
          },
        ],
      },
      travelers: [{ travelerId: "1", travelerType: "ADULT" }],
    }),
  );
  const requirement = requirements.travelers[0];
  if (requirement === undefined) {
    throw new Error("one traveller");
  }
  const empty: TravelerData = {
    name: null,
    dateOfBirth: null,
    gender: null,
    contact: null,
    documents: [],
    discountEligibility: [],
  };

  it("lists what an empty traveller lacks, with paths into the checkout [OBE-036 AC1]", () => {
    expect(missingFieldsOf(empty, requirement)).toEqual([
      "name",
      "gender",
      "documents",
      "documentIssuanceCity",
      "residence",
      "spanishResidentDiscount",
    ]);
    expect(codes(missingErrorsOf(2, empty, requirement))).toEqual([
      ["/travelers/2/name", "REQUIRED"],
      ["/travelers/2/gender", "REQUIRED"],
      ["/travelers/2/documents", "REQUIRED"],
      ["/travelers/2/documents", "REQUIRED"],
      ["/travelers/2/contact/address", "REQUIRED"],
      ["/travelers/2/discountEligibility", "DISCOUNT_DATA_REQUIRED"],
    ]);
  });

  it("is complete once every required field is there (a VISA is no identity document)", () => {
    const complete: TravelerData = {
      name: { firstName: "TESTA", lastName: "SAMPLE" },
      dateOfBirth: null,
      gender: "FEMALE",
      contact: { address: { countryCode: "ES" } },
      documents: [{ documentType: "VISA" }, { documentType: "PASSPORT", issuanceLocation: "MADRID" }],
      discountEligibility: [
        { subType: "SPANISH_RESIDENT", cityName: "PALMA", certificateNumber: "12345678Z" },
      ],
    };
    expect(missingFieldsOf(complete, requirement)).toEqual([]);
    expect(
      codes(
        missingErrorsOf(
          0,
          { ...complete, documents: [{ documentType: "VISA" }, { documentType: "PASSPORT" }] },
          requirement,
        ),
      ),
    ).toEqual([["/travelers/0/documents/1/issuanceLocation", "REQUIRED"]]);
  });
});

describe("contactErrors", () => {
  const requirement = requirementsForPricedOffer(pricedOffer({})).contact;
  const primary: ContactInput = {
    purpose: "STANDARD",
    isPrimary: true,
    addresseeName: { firstName: "TESTA", lastName: "SAMPLE" },
    emailAddress: "testa.sample@example.com",
    phones: [{ deviceType: "MOBILE", countryCallingCode: "46", number: "701234567" }],
  };

  it("accepts one primary contact with an e-mail and a mobile phone [OBE-036 AC1]", () => {
    expect(contactErrors([primary], requirement)).toEqual([]);
    expect(
      primaryIndexOf([{ purpose: "STANDARD", emailAddress: "a@example.com" }, { purpose: "INVOICE" }]),
    ).toBe(0);
  });

  it("asks for a primary contact when there is none, or several", () => {
    expect(codes(contactErrors([], requirement))).toEqual([["/contacts", "PRIMARY_CONTACT_REQUIRED"]]);
    expect(codes(contactErrors([primary, primary], requirement))).toEqual([
      ["/contacts", "PRIMARY_CONTACT_REQUIRED"],
    ]);
    expect(
      codes(
        contactErrors([{ purpose: "INVOICE", isPrimary: true, emailAddress: "a@example.com" }], requirement),
      ),
    ).toEqual([
      ["/contacts/0/purpose", "PRIMARY_CONTACT_REQUIRED"],
      ["/contacts/0/phones", "MOBILE_PHONE_REQUIRED"],
    ]);
  });

  it("checks the e-mail, the mobile phone, calling codes, postal codes and the invoice address", () => {
    const strict = {
      ...requirement,
      invoiceAddressRequired: true,
      postalCodeRequired: true,
      mailingAddressRequired: true,
    };
    expect(
      codes(
        contactErrors(
          [
            {
              purpose: "STANDARD",
              isPrimary: true,
              phones: [{ deviceType: "LANDLINE", number: "701234567" }],
              address: { lines: ["Main street 1"], countryCode: "SE" },
            },
          ],
          strict,
        ),
      ),
    ).toEqual([
      ["/contacts/0/phones/0/countryCallingCode", "COUNTRY_CALLING_CODE_REQUIRED"],
      ["/contacts/0/address/postalCode", "POSTAL_CODE_REQUIRED"],
      ["/contacts/0/emailAddress", "PRIMARY_CONTACT_REQUIRED"],
      ["/contacts/0/phones", "MOBILE_PHONE_REQUIRED"],
      ["/contacts", "INVOICE_ADDRESS_REQUIRED"],
    ]);
    expect(
      contactErrors(
        [
          { ...primary, address: { countryCode: "SE", postalCode: "11134" } },
          { purpose: "INVOICE", companyName: "TEST AB", address: { countryCode: "SE", postalCode: "11134" } },
        ],
        strict,
      ),
    ).toEqual([]);
  });

  it("[FIX-W30-OTA AC1] accepts the US's calling code 1, with or without +, and refuses four digits", () => {
    const withCode = (countryCallingCode: string): ContactInput => ({
      ...primary,
      phones: [{ deviceType: "MOBILE", countryCallingCode, number: "2025550143" }],
    });
    for (const code of ["1", "+1", "44", "+353"]) {
      expect([code, contactErrors([withCode(code)], requirement)]).toEqual([code, []]);
    }
    for (const code of ["1234", "+1234"]) {
      expect(codes(contactErrors([withCode(code)], requirement))).toEqual([
        ["/contacts/0/phones/0/countryCallingCode", "PHONE_INVALID"],
      ]);
    }
  });
});

describe("remarkErrors", () => {
  it("refuses traveller ids that are not in the checkout", () => {
    const ids = new Set(["1", "2"]);
    expect(
      remarkErrors(
        [{ text: "Window seat please", travelerIds: ["1", "2"] }, { text: "Vegetarian meal" }],
        ids,
      ),
    ).toEqual([]);
    expect(codes(remarkErrors([{ text: "Window seat please", travelerIds: ["2", "3"] }], ids))).toEqual([
      ["/remarks/0/travelerIds/1", "enum"],
    ]);
  });
});
