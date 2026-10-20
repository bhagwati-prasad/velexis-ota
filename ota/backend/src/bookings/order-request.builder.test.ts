// The Amadeus requests of the booking orchestration (OBE-042, order-request.builder.ts): Flight Create Orders for the
// OTA-merchant model with the VELEXIS remark, the booking queue and the issue flag of each ticketing policy, Flight
// Order Issue, and the travellers of a re-price; plus the booking reference the remark carries. Pure functions, built
// from the Amadeus stub's synthetic fixtures and test/builders/bookings.ts; no service is called.
import { describe, expect, it } from "vitest";
import {
  buildOrderContact,
  buildOrderRemark,
  buildOrderRequestInput,
  buildOrderTraveler,
  buildStoredPassport,
  pricedFlightOffer,
} from "../../test/builders/bookings";
import {
  BOOKING_REFERENCE_ALPHABET,
  BOOKING_REFERENCE_PATTERN,
  isBookingReference,
  newBookingReference,
  velexisRemarkText,
} from "./booking-reference";
import {
  amadeusOfferIdsOf,
  amadeusTravelerOf,
  buildCreateOrderRequest,
  buildIssueRequest,
  generalRemarksOf,
  issueAtCreate,
  ORDER_FORM_OF_PAYMENT,
  pricingTravelersOf,
  requiresInstantTicketing,
  type TicketingPolicy,
} from "./order-request.builder";

describe("the booking reference", () => {
  it("is VX and six characters of an alphabet without 0, O, 1 and I", () => {
    const references = Array.from({ length: 200 }, () => newBookingReference());
    for (const reference of references) {
      expect(reference).toMatch(BOOKING_REFERENCE_PATTERN);
      expect(isBookingReference(reference)).toBe(true);
    }
    expect(BOOKING_REFERENCE_ALPHABET).not.toMatch(/[01OI]/);
    expect(new Set(references).size).toBeGreaterThan(190);
  });

  it("takes its characters from the random source it is given", () => {
    const sequence = [0, 1, 2, 31, 30, 29];
    let index = 0;
    const random = (max: number): number => {
      expect(max).toBe(BOOKING_REFERENCE_ALPHABET.length);
      return sequence[index++] ?? 0;
    };
    expect(newBookingReference(random)).toBe("VXABC987");
  });

  it("writes the VELEXIS remark of a reference, and refuses anything else", () => {
    expect(velexisRemarkText("VXK7M2Q9")).toBe("VELEXIS VXK7M2Q9");
    expect(isBookingReference("VXK7M2Q0")).toBe(false);
    expect(isBookingReference("vxk7m2q9")).toBe(false);
    expect(() => velexisRemarkText("ABC123")).toThrow(TypeError);
  });
});

describe("Flight Create Orders", () => {
  it("[OBE-042 AC1] carries the priced offers verbatim, the offices, the travellers, the contacts and a paid ticketing agreement", () => {
    const offer = pricedFlightOffer();
    const traveler = buildOrderTraveler({ travelerId: "1" });
    const contact = buildOrderContact();
    const input = buildOrderRequestInput({
      flightOffers: [offer],
      travelers: [traveler],
      contacts: [contact],
    });

    const request = buildCreateOrderRequest(input);

    expect(request.query).toEqual({ issue: false });
    const data = request.body.data;
    expect(data["type"]).toBe("flight-order");
    expect(data["queuingOfficeId"]).toBe("NCE1A0955");
    expect(data["ownerOfficeId"]).toBe("NCE1A0955");
    expect(data["flightOffers"]).toEqual([offer]);
    expect(data["ticketingAgreement"]).toEqual({ option: "CONFIRM" });
    expect(data["travelers"]).toEqual([
      {
        id: "1",
        dateOfBirth: "1988-04-12",
        gender: "FEMALE",
        name: { firstName: traveler.firstName, lastName: "SAMPLE" },
        documents: [
          {
            documentType: "PASSPORT",
            number: traveler.documents[0]?.number,
            issuanceDate: traveler.documents[0]?.issuanceDate,
            expiryDate: traveler.documents[0]?.expiryDate,
            issuanceCountry: "SE",
            issuanceLocation: "STOCKHOLM",
            nationality: "SE",
            birthPlace: "UPPSALA",
            holder: true,
          },
        ],
        loyaltyPrograms: [{ programOwner: "IB", id: "2084471234" }],
        contact: traveler.contact,
      },
    ]);
    expect(data["contacts"]).toEqual([
      {
        addresseeName: { firstName: contact.firstName, lastName: "SAMPLE" },
        language: "en",
        purpose: "STANDARD",
        phones: [{ deviceType: "MOBILE", countryCallingCode: "46", number: "701234567" }],
        emailAddress: contact.email,
      },
    ]);
  });

  it("[OBE-042 AC1] pays with the OTA's account (other.method) for every offer and never sends a card", () => {
    const second = { ...pricedFlightOffer(), id: "5" };
    const request = buildCreateOrderRequest(
      buildOrderRequestInput({ flightOffers: [pricedFlightOffer(), second] }),
    );

    expect(ORDER_FORM_OF_PAYMENT).toBe("ACCOUNT");
    expect(request.body.data["formOfPayments"]).toEqual([
      { other: { method: "ACCOUNT", flightOfferIds: ["2", "5"] } },
    ]);
    expect(JSON.stringify(request.body)).not.toContain("creditCard");
  });

  it("puts the special requests in upper case first and the VELEXIS remark of the reference last", () => {
    const remark = buildOrderRemark({ text: "Window seat, please", travelerIds: ["1"] });
    const request = buildCreateOrderRequest(
      buildOrderRequestInput({
        remarks: [remark, { text: "Vegan meal", travelerIds: [] }],
        reference: "VXK7M2Q9",
      }),
    );

    expect(request.body.data["remarks"]).toEqual({
      general: [
        { subType: "GENERAL_MISCELLANEOUS", text: "WINDOW SEAT, PLEASE", travelerIds: ["1"] },
        { subType: "GENERAL_MISCELLANEOUS", text: "VEGAN MEAL" },
        { subType: "BACKOFFICE", text: "VELEXIS VXK7M2Q9" },
      ],
    });
    expect(generalRemarksOf([], "VXK7M2Q9")).toEqual([{ subType: "BACKOFFICE", text: "VELEXIS VXK7M2Q9" }]);
  });

  it("queues the order on the tenant's booking queue in the queuing office, and on none without a queue", () => {
    const queued = buildCreateOrderRequest(buildOrderRequestInput({ queue: { number: 50, category: 3 } }));
    const unqueued = buildCreateOrderRequest(buildOrderRequestInput({ queue: null }));

    expect(queued.body.data["automatedProcess"]).toEqual([
      { code: "IMMEDIATE", queue: { number: "50", category: "3" }, officeId: "NCE1A0955" },
    ]);
    expect(unqueued.body.data).not.toHaveProperty("automatedProcess");
  });

  it("[OBE-042 AC1] asks Amadeus to issue at once for issue_at_booking and for an offer that must be ticketed at once", () => {
    const table: Array<[TicketingPolicy, boolean, boolean]> = [
      ["issue_at_booking", false, true],
      ["issue_at_booking", true, true],
      ["issue_after_payment", false, false],
      ["issue_after_payment", true, true],
      ["manual_review", false, false],
      ["manual_review", true, true],
    ];
    for (const [policy, instant, issue] of table) {
      expect([policy, instant, issueAtCreate(policy, instant)]).toEqual([policy, instant, issue]);
    }
    const instantOffer = { ...pricedFlightOffer(), instantTicketingRequired: true };
    expect(requiresInstantTicketing([pricedFlightOffer()])).toBe(false);
    expect(requiresInstantTicketing([pricedFlightOffer(), instantOffer])).toBe(true);
    expect(buildCreateOrderRequest(buildOrderRequestInput({ issue: true })).query).toEqual({ issue: true });
  });

  it("sends only the traveller fields of the specification: no OTA-only field, no empty list", () => {
    const traveler = buildOrderTraveler({
      middleName: "MARIA",
      documents: [],
      loyaltyPrograms: [],
      contact: { emailAddress: "a@example.com", unknown: "x", phones: [] },
      emergencyContact: { addresseeName: "PAT SAMPLE", countryCode: "SE", number: "701234567" },
      discounts: [{ subType: "SPANISH_RESIDENT", cityName: "MADRID", travelerType: "SPANISH_CITIZEN" }],
    });

    expect(amadeusTravelerOf(traveler)).toEqual({
      id: traveler.travelerId,
      dateOfBirth: "1988-04-12",
      gender: "FEMALE",
      name: { firstName: traveler.firstName, middleName: "MARIA", lastName: "SAMPLE" },
      emergencyContact: { addresseeName: "PAT SAMPLE", countryCode: "SE", number: "701234567" },
      discountEligibility: [
        { subType: "SPANISH_RESIDENT", cityName: "MADRID", travelerType: "SPANISH_CITIZEN" },
      ],
      contact: { emailAddress: "a@example.com" },
    });
  });

  it("refuses a request without an offer or with a reference that is not one", () => {
    expect(() => buildCreateOrderRequest(buildOrderRequestInput({ flightOffers: [] }))).toThrow(TypeError);
    expect(() => buildCreateOrderRequest(buildOrderRequestInput({ reference: "nope" }))).toThrow(TypeError);
  });
});

describe("Flight Order Issue and the re-price", () => {
  it("issues with the same OTA-merchant form of payment for the order's offers", () => {
    expect(buildIssueRequest(["2"])).toEqual({
      data: { formOfPayments: [{ other: { method: "ACCOUNT", flightOfferIds: ["2"] } }] },
    });
    expect(buildIssueRequest(["1", "2"], "CASH").data.formOfPayments).toEqual([
      { other: { method: "CASH", flightOfferIds: ["1", "2"] } },
    ]);
    expect(amadeusOfferIdsOf([pricedFlightOffer(), { id: 3 }, "x"])).toEqual(["2"]);
  });

  it("prices again with each traveller's id, date of birth and discounts only", () => {
    const plain = buildOrderTraveler({ travelerId: "1", documents: [buildStoredPassport()] });
    const resident = buildOrderTraveler({
      travelerId: "2",
      discounts: [{ subType: "SPANISH_RESIDENT", cityName: "MADRID", travelerType: "SPANISH_CITIZEN" }],
    });

    expect(pricingTravelersOf([plain, resident])).toEqual([
      { id: "1", dateOfBirth: "1988-04-12" },
      {
        id: "2",
        dateOfBirth: "1988-04-12",
        discountEligibility: [
          { subType: "SPANISH_RESIDENT", cityName: "MADRID", travelerType: "SPANISH_CITIZEN" },
        ],
      },
    ]);
  });
});
