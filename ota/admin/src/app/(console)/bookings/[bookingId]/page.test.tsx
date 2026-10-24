// A booking's detail page as Next.js renders it on the server (OAD-007): the real page, `getConsoleRequest` and the SDK
// against the fake OTA API (the SDK's `fetch`), rendered to HTML and queried in a detached happy-dom document (a
// server-mode SDK client refuses to run in a browser-like test environment, rightly). The bookings are the OTA
// document's examples (dummy data): a ticketed storefront booking and an airline-card booking whose tickets did not
// all come back, which the staff must settle (`ticketing.status = manual_review`).
import type {
  ConsoleBooking,
  ConsoleFlightOrderRetrieval,
  ConsolePayment,
  ConsoleStaffProfile,
} from "@velexis/ota-sdk";
import { within } from "@testing-library/dom";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CookieJar,
  TENANT_ID,
  TEST_CONFIG,
  TEST_PORTAL_URL,
  apiError,
  fakeOtaApi,
  redirectOf,
  staffAccessToken,
  staffProfile,
  type FakeOtaApi,
} from "@/test/fake-ota-api";

// ---- Mocks: the request scope and navigation of Next.js and the configuration ------------------------------------

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));
vi.mock("next/headers", () => nextHeaders);
vi.mock("next/navigation", async () => {
  const { fakeRedirect } = await import("@/test/fake-ota-api");
  return {
    usePathname: () => "/bookings",
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
    redirect: fakeRedirect,
  };
});

import { formatInstant } from "@/app/(console)/bookings/views";
import {
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from "@/lib/session";

import BookingPage from "./page";
import { BOOKING_TABS, type BookingTab } from "./sections";

const TIME_ZONE = "Europe/Oslo";
const BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2";
const AIRLINE_BOOKING_ID = "bkg_01JA5AC9K2M4P6R8T0V2X4Z6B8";
const STRIPE_PAYMENT_ID = "pay_01JA4CF2R7V0Y3B6D9G2K5N8Q1";
const AIRLINE_PAYMENT_ID = "pay_01JA5AC7H0K2M4P6R8T0V2X4Z6";

const GET = (id: string) => `GET /v1/console/bookings/${id}`;
const RETRIEVE = (id: string) => `GET /v1/console/bookings/${id}/amadeus-order`;
const PAYMENT = (id: string) => `GET /v1/console/payments/${id}`;

/** A full identity document number the console's order view shows and the travellers tab never does (dummy). */
const FULL_PASSPORT = "AA9104821";
/** A full number the API might send in a traveller document; the page cuts it to its last 4 (dummy). */
const FULL_CHILD_PASSPORT = "AB1237310";
/** A full number the API might send in a form of identification of the order; cut to its last 4 too (dummy). */
const FULL_IDENTIFICATION = "AC5553916";
/** A remark only the stored order of console.bookings.get carries: no tab renders that order (dummy). */
const STORED_ORDER_MARKER = "STORED SNAPSHOT ONLY";

let api: FakeOtaApi;
let sequence = 0;

/** The cookies of a signed-in staff member. */
function signedIn(): void {
  sequence += 1;
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`detail-${sequence}`, Date.now(), 900),
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-detail-${sequence}`,
      [ENVIRONMENT_COOKIE]: "test",
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
}

const eur = (amount: string) => ({ amount, currency: "EUR" });

// ---- Fixtures: the OTA document's examples ---------------------------------------------------------------------------

/** `ConsoleBookingExample` of the OTA document: a ticketed storefront booking paid by Stripe. */
function ticketedBooking(overrides: Partial<ConsoleBooking> = {}): ConsoleBooking {
  return {
    id: BOOKING_ID,
    reference: "VX7K2Q",
    status: "ticketed",
    channel: "storefront",
    customerId: "cus_8f3K2mQ9xT4vB7nL",
    isGuest: false,
    recordLocator: "QX8P4L",
    recordLocators: [
      { reference: "QX8P4L", originSystemCode: "GDS", flightOfferId: "1", primary: true },
      { reference: "5HTR2K", originSystemCode: "AF", flightOfferId: "1", primary: false },
    ],
    tripType: "round_trip",
    itineraries: [
      {
        index: 0,
        originCode: "CDG",
        destinationCode: "JFK",
        departureAt: "2026-11-20T10:25:00",
        arrivalAt: "2026-11-20T12:45:00",
        durationMinutes: 500,
        stops: 0,
        segments: [
          {
            id: "1",
            flightOfferId: "1",
            departure: { iataCode: "CDG", terminal: "2E", at: "2026-11-20T10:25:00" },
            arrival: { iataCode: "JFK", terminal: "1", at: "2026-11-20T12:45:00" },
            carrierCode: "AF",
            carrierName: "Air France",
            number: "6",
            flightNumber: "AF6",
            operatingCarrierCode: null,
            aircraftCode: "359",
            durationMinutes: 500,
            cabin: "ECONOMY",
            bookingClass: "V",
            fareBasis: "VS50BALA",
            brandedFare: "STANDARD",
            brandedFareLabel: "ECONOMY STANDARD",
            includedCheckedBags: { quantity: 1, weight: 23, weightUnit: "KG" },
            status: "CONFIRMED",
            isFlown: false,
            scheduleChanged: false,
          },
        ],
      },
      {
        index: 1,
        originCode: "JFK",
        destinationCode: "CDG",
        departureAt: "2026-11-27T18:30:00",
        arrivalAt: "2026-11-28T07:55:00",
        durationMinutes: 445,
        stops: 0,
        segments: [
          {
            id: "2",
            flightOfferId: "1",
            departure: { iataCode: "JFK", terminal: "1", at: "2026-11-27T18:30:00" },
            arrival: { iataCode: "CDG", terminal: "2E", at: "2026-11-28T07:55:00" },
            carrierCode: "AF",
            carrierName: "Air France",
            number: "11",
            flightNumber: "AF11",
            operatingCarrierCode: null,
            aircraftCode: "359",
            durationMinutes: 445,
            cabin: "ECONOMY",
            bookingClass: "V",
            fareBasis: "VS50BALA",
            brandedFare: "STANDARD",
            brandedFareLabel: "ECONOMY STANDARD",
            includedCheckedBags: { quantity: 1, weight: 23, weightUnit: "KG" },
            status: "CONFIRMED",
            isFlown: false,
            scheduleChanged: false,
          },
        ],
      },
    ],
    travelers: [
      {
        id: "btr_01JA4CG3T9X2A5D8G1J4M7Q0U3",
        travelerId: "1",
        travelerType: "ADULT",
        associatedAdultId: null,
        savedTravelerId: "trv_01JA4CH8V2N6R9T3W5Y7A1C4E6",
        name: { firstName: "ANNA", lastName: "BERG" },
        dateOfBirth: "1988-04-12",
        gender: "FEMALE",
        contact: {
          emailAddress: "anna.berg@example.com",
          phones: [{ deviceType: "MOBILE", countryCallingCode: "46", number: "701234567" }],
        },
        documents: [
          {
            documentType: "PASSPORT",
            numberMasked: "•••••4821",
            expiryDate: "2031-05-14",
            issuanceCountry: "SE",
            nationality: "SE",
            holder: true,
          },
        ],
        loyaltyPrograms: [{ programOwner: "AF", id: "2084471234" }],
        discountEligibility: [],
        emergencyContact: null,
        complete: true,
        ticketNumbers: ["057-2412345678"],
      },
      {
        id: "btr_01JA4CG3V0Y3B6E9H2K5N8R1W4",
        travelerId: "2",
        travelerType: "CHILD",
        associatedAdultId: null,
        savedTravelerId: null,
        name: { firstName: "LEO", lastName: "BERG" },
        dateOfBirth: "2017-06-03",
        gender: "MALE",
        contact: null,
        // Console scope may send the full number (TravelerDocument.number); the travellers tab cuts it to its last 4.
        documents: [
          {
            documentType: "PASSPORT",
            number: FULL_CHILD_PASSPORT,
            expiryDate: "2027-09-30",
            issuanceCountry: "SE",
            nationality: "SE",
            holder: true,
          },
        ],
        loyaltyPrograms: [],
        discountEligibility: [],
        emergencyContact: null,
        complete: true,
        ticketNumbers: ["057-2412345679"],
      },
    ],
    contacts: [
      {
        id: "bco_01JA4CG4W1Z4C7F0J3M6Q9T2X5",
        purpose: "STANDARD",
        isPrimary: true,
        addresseeName: { firstName: "ANNA", lastName: "BERG" },
        companyName: null,
        emailAddress: "anna.berg@example.com",
        phones: [{ deviceType: "MOBILE", countryCallingCode: "46", number: "701234567" }],
        address: null,
        language: "en",
      },
    ],
    ancillaries: [
      {
        id: "anc_01JA4CG6Y3B6E9H2L5P8S1W4Z7",
        type: "CHECKED_BAGS",
        label: "1 extra checked bag (23 kg)",
        travelerId: "1",
        segmentIds: ["1", "2"],
        quantity: 1,
        weight: 23,
        weightUnit: "KG",
        serviceName: null,
        seatNumber: null,
        price: eur("45.00"),
        status: "confirmed",
        source: "checkout",
        emdNumber: null,
      },
    ],
    tickets: [
      {
        id: "tkt_01JA4CG7Z4C7F0J3M6Q9U2X5A8",
        documentType: "ETICKET",
        documentNumber: "057-2412345678",
        status: "ISSUED",
        travelerId: "1",
        travelerName: "ANNA BERG",
        segmentIds: ["1", "2"],
        issuedAt: "2026-10-10T09:20:52Z",
        total: eur("769.28"),
      },
      {
        id: "tkt_01JA4CG7A5D8G1K4N7R0V3Y6B9",
        documentType: "ETICKET",
        documentNumber: "057-2412345679",
        status: "ISSUED",
        travelerId: "2",
        travelerName: "LEO BERG",
        segmentIds: ["1", "2"],
        issuedAt: "2026-10-10T09:20:52Z",
        total: eur("632.28"),
      },
    ],
    payments: [
      {
        id: STRIPE_PAYMENT_ID,
        checkoutId: "chk_01JA4CE5H8K1M4P7R0T3V6Y9B2",
        bookingId: BOOKING_ID,
        provider: "stripe",
        method: "card",
        status: "captured",
        captureMethod: "manual",
        amount: eur("1414.06"),
        cardFee: eur("12.50"),
        amountAuthorized: eur("1414.06"),
        amountCaptured: eur("1414.06"),
        amountRefunded: eur("0.00"),
        clientSecret: null,
        providerPublicKey: null,
        providerPaymentId: "pi_3Q9xK2LkdIwHu7ix1aBcDeFg",
        redirectUrl: null,
        nextAction: null,
        card: { brand: "VISA", last4: "4242", bin: "424242", expMonth: 8, expYear: 2029 },
        threeDSecure: { required: true, status: "authenticated", version: "2.2.0" },
        failure: null,
        createdAt: "2026-10-10T09:17:40Z",
        updatedAt: "2026-10-10T09:20:47Z",
        authorizedAt: "2026-10-10T09:18:21Z",
        capturedAt: "2026-10-10T09:20:47Z",
        cancelledAt: null,
      },
    ],
    refunds: [],
    remarks: [
      {
        id: "rmk_01JA4CG5X2A5D8G1K4N7R0V3Y6",
        kind: "general",
        subType: "GENERAL_MISCELLANEOUS",
        text: "CHILD MEAL REQUESTED FOR LEO IF POSSIBLE",
        travelerIds: ["2"],
        source: "customer",
        createdAt: "2026-10-10T09:20:41Z",
      },
      {
        id: "rmk_01JA4CG5Y3B6E9H2L5P8S1W4Z7",
        kind: "general",
        subType: "BACKOFFICE",
        text: "VELEXIS VX7K2Q",
        travelerIds: [],
        source: "system",
        createdAt: "2026-10-10T09:20:41Z",
      },
    ],
    documents: [
      {
        id: "doc_01JA4CG8B6E9H2L5P8S1W4Z7C0",
        bookingId: BOOKING_ID,
        kind: "itinerary",
        status: "ready",
        locale: "en-GB",
        fileName: "VX7K2Q-itinerary.pdf",
        contentType: "application/pdf",
        sizeBytes: 84211,
        ticketId: null,
        invoiceNumber: null,
        createdAt: "2026-10-10T09:20:58Z",
      },
      {
        id: "doc_01JA4CG8C7F0J3M6Q9T2X5A8D1",
        bookingId: BOOKING_ID,
        kind: "e_ticket_receipt",
        status: "ready",
        locale: "en-GB",
        fileName: "VX7K2Q-eticket-0572412345678.pdf",
        contentType: "application/pdf",
        sizeBytes: 61877,
        ticketId: "tkt_01JA4CG7Z4C7F0J3M6Q9U2X5A8",
        invoiceNumber: null,
        createdAt: "2026-10-10T09:21:03Z",
      },
    ],
    totals: {
      currency: "EUR",
      base: eur("858.00"),
      taxes: eur("478.56"),
      fees: eur("32.50"),
      ancillaries: eur("45.00"),
      total: eur("1414.06"),
      paid: eur("1414.06"),
      refunded: eur("0.00"),
    },
    ticketing: {
      status: "issued",
      policy: "issue_after_payment",
      deadlineAt: "2026-10-13T21:59:00Z",
      lastTicketingDate: "2026-10-13",
      issuedAt: "2026-10-10T09:20:52Z",
      message: "Your e-tickets have been issued.",
    },
    fareConditions: {
      refundable: false,
      changeable: true,
      refundPenalty: null,
      changePenalty: eur("80.00"),
      source: "fare_rules",
    },
    fareRules: null,
    allowedActions: {
      canCancel: true,
      canModifyContacts: true,
      canModifyTravelerDocuments: true,
      canModifyLoyaltyPrograms: true,
      canAddRemarks: true,
      canDownloadDocuments: true,
      canRefresh: true,
      reasons: {},
    },
    cancellation: null,
    lastSyncedAt: "2026-10-10T09:20:52Z",
    syncStatus: "fresh",
    // The stored order of console.bookings.get: never shown, the Amadeus order tab reads it anew.
    amadeus: {
      flightOrderId: "eJzTd9cPNfX09DUFAAsGAkQ",
      order: {
        type: "flight-order",
        id: "eJzTd9cPNfX09DUFAAsGAkQ",
        flightOffers: [],
        remarks: { general: [{ subType: "GENERAL_MISCELLANEOUS", text: STORED_ORDER_MARKER }] },
      },
      dictionaries: null,
    },
    metadata: { campaign: "autumn-sale" },
    warnings: [],
    version: 3,
    createdAt: "2026-10-10T09:20:41Z",
    updatedAt: "2026-10-10T09:21:03Z",
    cancelledAt: null,
    environment: "test",
    amadeusOrderId: "eJzTd9cPNfX09DUFAAsGAkQ",
    queuingOfficeId: "NCE1A0950",
    ownerOfficeId: "NCE1A0950",
    createdByStaffId: null,
    checkoutId: "chk_01JA4CE5H8K1M4P7R0T3V6Y9B2",
    pricedOfferId: "prc_01JA4CD1X4Z7C0F3H6K9M2P5S8",
    customer: {
      id: "cus_8f3K2mQ9xT4vB7nL",
      email: "anna.berg@example.com",
      firstName: "Anna",
      lastName: "Berg",
    },
    contactEmail: "anna.berg@example.com",
    pricing: {
      currency: "EUR",
      net: eur("1265.56"),
      netBase: eur("742.00"),
      netTaxes: eur("478.56"),
      netFees: eur("0.00"),
      netServices: eur("45.00"),
      markup: eur("116.00"),
      serviceFees: eur("20.00"),
      cardFees: eur("12.50"),
      selling: eur("1414.06"),
      margin: eur("148.50"),
      marginPercent: "10.50",
      pricingMode: "markup_rules",
      markupRuleId: "mkr_01J9ZA2B4C6D8E0F2G4H6J8K0M",
      markupRuleName: "Long-haul economy 8%",
    },
    paymentStatus: "paid",
    supplierSync: {
      status: "fresh",
      lastSyncedAt: "2026-10-10T09:20:52Z",
      lastAttemptAt: "2026-10-10T09:20:52Z",
      lastError: null,
      lastSupplierRequestId: "sreq_01JA4CG7Y3B6E9H2L5P8S1W4Z7",
      nextScheduledSyncAt: "2026-10-10T15:20:52Z",
      differences: [],
    },
    ticketingAgreement: { option: "CONFIRM" },
    automatedProcess: [],
    formOfPayments: [
      {
        kind: "other",
        brand: null,
        last4: null,
        holder: null,
        expiryDate: null,
        method: "ACCOUNT",
        cardFriendlyName: null,
        flightOfferIds: ["1"],
      },
    ],
    commissions: [],
    formOfIdentifications: [],
    issueRequested: false,
    notes: [
      {
        id: "evt_01JA4F7H2K5N8Q1T4W7Z0C3F6J",
        bookingId: BOOKING_ID,
        text: "Customer asked for a child meal for LEO; requested via remark.",
        visibleToCustomer: false,
        author: {
          type: "staff",
          id: "stf_01JA2X7Q9M3K5N8P1R4T6V0W2Y",
          name: "Maria Lopez",
          email: "maria.lopez@acme-travel.example",
          role: "agent",
        },
        createdAt: "2026-10-10T10:05:12Z",
      },
    ],
    events: [
      {
        id: "evt_01JA4F7H2K5N8Q1T4W7Z0C3F6J",
        type: "staff.note",
        actor: {
          type: "staff",
          id: "stf_01JA2X7Q9M3K5N8P1R4T6V0W2Y",
          name: "Maria Lopez",
          email: "maria.lopez@acme-travel.example",
          role: "agent",
        },
        summary: "Note added",
        statusFrom: null,
        statusTo: null,
        visibleToCustomer: false,
        supplierRequestId: null,
        data: {},
        createdAt: "2026-10-10T10:05:12Z",
      },
      {
        id: "evt_01JA4CG7Z5D8G1K4N7R0V3Y6B9",
        type: "booking.ticketed",
        actor: { type: "system", id: null, name: "Velexis", email: null, role: null },
        summary: "2 e-tickets issued",
        statusFrom: "confirmed",
        statusTo: "ticketed",
        visibleToCustomer: true,
        supplierRequestId: "sreq_01JA4CG7Y3B6E9H2L5P8S1W4Z7",
        data: { ticketNumbers: ["057-2412345678", "057-2412345679"] },
        createdAt: "2026-10-10T09:20:52Z",
      },
      {
        id: "evt_01JA4CG3T0X3A6D9G2J5M8Q1U4",
        type: "booking.created",
        actor: { type: "customer", id: "cus_8f3K2mQ9xT4vB7nL", name: "Anna Berg", email: null, role: null },
        summary: "Booking created from checkout",
        statusFrom: null,
        statusTo: "confirmed",
        visibleToCustomer: true,
        supplierRequestId: "sreq_01JA4CG3R8W1Z4C7F0H3L6P9T2",
        data: { recordLocator: "QX8P4L" },
        createdAt: "2026-10-10T09:20:41Z",
      },
    ],
    recentSupplierRequests: [
      {
        id: "sreq_01JA4CG7Y3B6E9H2L5P8S1W4Z7",
        environment: "test",
        operation: "checkout.complete",
        amadeusApi: "FlightOrderIssue",
        amadeusOperationId: "issueFlightOrder",
        httpMethod: "POST",
        path: "/v1/booking/flight-orders/eJzTd9cPNfX09DUFAAsGAkQ/issuance",
        officeId: "NCE1A0950",
        httpStatus: 200,
        outcome: "success",
        errorCodes: [],
        durationMs: 4210,
        correlationId: "0004P2P8S1W4Z7",
        requestId: "req_01JA4CG3R7V0Y3B6D9G2K5N8Q1",
        bookingId: BOOKING_ID,
        searchId: null,
        staffId: null,
        redacted: true,
        truncated: false,
        createdAt: "2026-10-10T09:20:48Z",
      },
    ],
    recentStaffActions: [
      {
        id: "sact_01JA4F7H3L6P9S2V5Y8B1E4H7K",
        action: "booking.note",
        targetType: "booking",
        targetId: BOOKING_ID,
        bookingId: BOOKING_ID,
        reason: null,
        outcome: "succeeded",
        actor: {
          type: "staff",
          id: "stf_01JA2X7Q9M3K5N8P1R4T6V0W2Y",
          name: null,
          email: "maria.lopez@acme-travel.example",
          role: "agent",
        },
        requestId: "req_01JA4F7H1J4M7P0S3V6Y9B2E5H",
        createdAt: "2026-10-10T10:05:12Z",
      },
    ],
    consoleActions: {
      canIssue: false,
      canPatch: true,
      canCancel: true,
      canResync: true,
      canRetrieve: true,
      canAddNote: true,
      reasons: { canIssue: "already_ticketed" },
    },
    failure: null,
    tags: ["vip"],
    ...overrides,
  };
}

/** The holder name and expiry the card of the airline-card order carried; the console never shows them (dummy). */
const CARD_HOLDER = "KARIN CARDHOLDER";
const CARD_EXPIRY = "2029-08";
const MANUAL_REVIEW_SUMMARY =
  "The airline did not issue every ticket of the order paid by airline card; staff check the order and decide.";
const DEADLINE = "2026-11-02T21:59:00Z";

/**
 * An airline-card booking whose order came back without every ticket (OBE-051's settlement): confirmed, ticketing in
 * `manual_review` with its staff event, the airline-card payment `processing`, the card's brand and last 4 on the order.
 */
function airlineCardBooking(): ConsoleBooking {
  const base = ticketedBooking();
  return ticketedBooking({
    id: AIRLINE_BOOKING_ID,
    reference: "VX4M9T",
    status: "confirmed",
    recordLocator: "L2P9XC",
    recordLocators: [{ reference: "L2P9XC", originSystemCode: "GDS", flightOfferId: "1", primary: true }],
    tickets: [],
    travelers: base.travelers.map((traveler) => ({ ...traveler, ticketNumbers: [] })),
    documents: [],
    ancillaries: [],
    payments: [
      {
        id: AIRLINE_PAYMENT_ID,
        checkoutId: "chk_01JA5AC6G9J1L3N5Q7S9U1W3Y5",
        bookingId: AIRLINE_BOOKING_ID,
        purpose: "booking",
        provider: "airline",
        method: "airline_card",
        status: "processing",
        captureMethod: "automatic",
        amount: eur("1401.56"),
        cardFee: null,
        cardHint: { brand: "VISA", bin: "411111" },
        amountAuthorized: eur("0.00"),
        amountCaptured: eur("0.00"),
        amountRefunded: eur("0.00"),
        clientSecret: null,
        providerPublicKey: null,
        providerPaymentId: null,
        redirectUrl: null,
        nextAction: null,
        card: { brand: "VISA", last4: "1111", bin: "411111" },
        threeDSecure: { required: false, status: "not_required" },
        failure: null,
        createdAt: "2026-10-20T08:00:00Z",
        updatedAt: "2026-10-20T08:01:10Z",
        authorizedAt: null,
        capturedAt: null,
        cancelledAt: null,
      },
    ],
    totals: { ...base.totals, cardFee: null, total: eur("1401.56"), paid: eur("0.00") },
    ticketing: {
      status: "manual_review",
      policy: "issue_at_booking",
      deadlineAt: DEADLINE,
      lastTicketingDate: "2026-11-02",
      issuedAt: null,
      message: null,
    },
    paymentStatus: "unpaid",
    formOfPayments: [
      {
        kind: "creditCard",
        brand: "VISA",
        last4: "1111",
        holder: CARD_HOLDER,
        expiryDate: CARD_EXPIRY,
        method: null,
        cardFriendlyName: null,
        flightOfferIds: ["1"],
      },
    ],
    notes: [],
    events: [
      {
        id: "evt_01JA5AC8J1L3N5Q7S9U1W3Y5A7",
        type: "booking.ticketing_manual_review",
        actor: { type: "customer", id: "cus_8f3K2mQ9xT4vB7nL", name: "Anna Berg", email: null, role: null },
        summary: MANUAL_REVIEW_SUMMARY,
        statusFrom: null,
        statusTo: null,
        visibleToCustomer: false,
        supplierRequestId: null,
        data: { paymentId: AIRLINE_PAYMENT_ID, coverage: "partial" },
        createdAt: "2026-10-20T08:01:10Z",
      },
      {
        id: "evt_01JA5AC8H0K2M4P6R8T0V2X4Z6",
        type: "booking.created",
        actor: { type: "customer", id: "cus_8f3K2mQ9xT4vB7nL", name: "Anna Berg", email: null, role: null },
        summary: "Booking created from checkout",
        statusFrom: null,
        statusTo: "confirmed",
        visibleToCustomer: true,
        supplierRequestId: null,
        data: {},
        createdAt: "2026-10-20T08:01:09Z",
      },
    ],
    recentStaffActions: [],
    consoleActions: {
      canIssue: true,
      canPatch: true,
      canCancel: true,
      canResync: true,
      canRetrieve: true,
      canAddNote: true,
      reasons: {},
    },
  });
}

/** `ConsolePaymentExample`, captured, with a partial refund that Stripe completed. */
function stripePayment(): ConsolePayment {
  const [summary] = ticketedBooking().payments;
  if (summary === undefined) {
    throw new Error("the fixture has a payment");
  }
  return {
    ...summary,
    amountRefunded: eur("100.00"),
    status: "partially_refunded",
    environment: "test",
    version: 6,
    events: [
      {
        id: "pev_01JA4CF2S1V4Y7B0D3G6K9N2Q5",
        type: "payment.created",
        source: "api",
        statusFrom: null,
        statusTo: "requires_payment_method",
        amount: null,
        providerEventId: null,
        payload: { checkoutId: "chk_01JA4CE5H8K1M4P7R0T3V6Y9B2", cardBrand: "VISA" },
        createdAt: "2026-10-10T09:17:40Z",
      },
      {
        id: "pev_01JA4CFB1Y4A7D0F3H6K9N2Q5T",
        type: "payment.captured",
        source: "system",
        statusFrom: "authorized",
        statusTo: "captured",
        amount: eur("1414.06"),
        providerEventId: null,
        payload: {},
        createdAt: "2026-10-10T09:20:47Z",
      },
    ],
    refunds: [
      {
        id: "rfd_01JA6B2C4D6E8F0G2H4J6K8M0N",
        paymentId: STRIPE_PAYMENT_ID,
        bookingId: BOOKING_ID,
        amount: eur("100.00"),
        penalty: null,
        reason: "goodwill",
        status: "succeeded",
        createdAt: "2026-10-12T08:00:00Z",
        processedAt: "2026-10-12T08:00:05Z",
        reasonNote: "Delayed baggage on the outbound flight",
        requestedBy: { type: "staff", id: "stf_01JA2X7Q9M3K5N8P1R4T6V0W2Y" },
        providerRefundId: "re_3Q9xK2LkdIwHu7ix0Refund1",
        failureReason: null,
        updatedAt: "2026-10-12T08:00:05Z",
      },
    ],
    booking: { id: BOOKING_ID, reference: "VX7K2Q", status: "ticketed" },
    providerConnection: { accountMode: "connect_standard" },
  };
}

/** The airline-card payment in console scope: no provider connection, no event that carries card data. */
function airlinePayment(): ConsolePayment {
  const [summary] = airlineCardBooking().payments;
  if (summary === undefined) {
    throw new Error("the fixture has a payment");
  }
  return {
    ...summary,
    environment: "test",
    version: 2,
    events: [
      {
        id: "pev_01JA5AC7J1L3N5Q7S9U1W3Y5A7",
        type: "payment.created",
        source: "api",
        statusFrom: null,
        statusTo: "requires_payment_method",
        amount: null,
        providerEventId: null,
        payload: { cardBrand: "VISA" },
        createdAt: "2026-10-20T08:00:00Z",
      },
    ],
    refunds: [],
    booking: { id: AIRLINE_BOOKING_ID, reference: "VX4M9T", status: "confirmed" },
    providerConnection: null,
  };
}

/** `ConsoleFlightOrderRetrievalExample`: the verbatim order, with the full document number and net prices. */
function retrieval(): ConsoleFlightOrderRetrieval {
  return {
    bookingId: BOOKING_ID,
    flightOrderId: "eJzTd9cPNfX09DUFAAsGAkQ",
    retrievedAt: "2026-10-10T10:40:02Z",
    include: [],
    fareRules: [],
    snapshotUpdated: true,
    call: {
      supplierRequestId: "sreq_01JA4HB02C4E6G8J0L2N4Q6S8U",
      environment: "test",
      officeId: "NCE1A0950",
      amadeusApi: "FlightOrderManagement",
      amadeusOperationId: "getFlightOrder",
      httpMethod: "GET",
      path: "/v1/booking/flight-orders/eJzTd9cPNfX09DUFAAsGAkQ",
      httpStatus: 200,
      durationMs: 1320,
      correlationId: "0005K22N4Q6S8U",
      staffActionId: "sact_01JA4HB03D5F7H9K1M3P5R7T9V",
    },
    amadeus: {
      warnings: [],
      data: {
        type: "flight-order",
        id: "eJzTd9cPNfX09DUFAAsGAkQ",
        associatedRecords: [
          {
            reference: "QX8P4L",
            creationDate: "2026-10-10T09:20:00.000",
            originSystemCode: "GDS",
            flightOfferId: "1",
          },
        ],
        flightOffers: [
          {
            type: "flight-offer",
            id: "1",
            source: "GDS",
            price: { currency: "EUR", total: "1265.56", base: "742.00", grandTotal: "1265.56" },
          },
        ],
        travelers: [
          {
            id: "1",
            dateOfBirth: "1988-04-12",
            gender: "FEMALE",
            name: { firstName: "ANNA", lastName: "BERG" },
            documents: [
              {
                documentType: "PASSPORT",
                number: FULL_PASSPORT,
                expiryDate: "2031-05-14",
                issuanceCountry: "SE",
                nationality: "SE",
                holder: true,
              },
            ],
          },
        ],
        queuingOfficeId: "NCE1A0950",
      },
      included: {},
    },
  };
}

// ---- Rendering --------------------------------------------------------------------------------------------------

/** The fake API answers `console.bookings.get` for `booking` (every query). */
function bookingAnswers(booking: ConsoleBooking): void {
  api.on(GET(booking.id), () =>
    Response.json(booking, { headers: { ETag: `"${booking.version}"`, "X-Request-Id": "req_get" } }),
  );
}

/** A server component's `searchParams` for a query string, as Next.js parses it. */
function searchParamsOf(search: string): Record<string, string | string[]> {
  const query = new URLSearchParams(search);
  const record: Record<string, string | string[]> = {};
  for (const name of new Set(query.keys())) {
    const values = query.getAll(name);
    record[name] = values.length === 1 ? (values[0] ?? "") : values;
  }
  return record;
}

/** The page of `bookingId` for `?<search>`, rendered to HTML on the "server" and parsed into a document. */
async function renderPage(bookingId: string, search = ""): Promise<HTMLElement> {
  const element = await BookingPage({
    params: Promise.resolve({ bookingId }),
    searchParams: Promise.resolve(searchParamsOf(search)),
  });
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(element);
  return document.body as unknown as HTMLElement;
}

/** The page with the tab `tab` open. */
function renderTab(bookingId: string, tab: BookingTab): Promise<HTMLElement> {
  return renderPage(bookingId, tab === "overview" ? "" : `tab=${tab}`);
}

/** The region (a `<section>` named by its heading) called `name`. */
function region(scope: HTMLElement, name: string): HTMLElement {
  return within(scope).getByRole("region", { name });
}

/** The value of the fact `label` in `scope` (its `<dd>`), as text. */
function fact(scope: HTMLElement, label: string): string {
  const term = [...scope.querySelectorAll("dt")].find((candidate) => candidate.textContent === label);
  if (term === undefined) {
    throw new Error(`no fact "${label}"`);
  }
  return term.nextElementSibling?.textContent ?? "";
}

/** The texts of the cells of a table's body rows. */
function rowsOf(table: HTMLElement): string[][] {
  return [...table.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? ""),
  );
}

/** The current tab of the page. */
function currentTab(page: HTMLElement): string | null {
  const tabs = within(page).getByRole("navigation", { name: "Booking sections" });
  return tabs.querySelector('[aria-current="page"]')?.textContent ?? null;
}

const when = (value: string) => formatInstant(value, TIME_ZONE);

/**
 * The airline-card booking's page with each of `tabs` open (the API answering its booking, payment and order). Every
 * tab shows what needs staff above it (the airline card and the ticketing review) and never the card's holder or
 * expiry; the brand and last 4 may appear.
 */
async function renderAirlineCardTabs(tabs: readonly BookingTab[]): Promise<Map<BookingTab, HTMLElement>> {
  bookingAnswers(airlineCardBooking());
  api.on(PAYMENT(AIRLINE_PAYMENT_ID), () => Response.json(airlinePayment()));
  api.on(RETRIEVE(AIRLINE_BOOKING_ID), () =>
    Response.json({ ...retrieval(), bookingId: AIRLINE_BOOKING_ID }),
  );
  const pages = new Map<BookingTab, HTMLElement>();
  for (const tab of tabs) {
    const page = await renderTab(AIRLINE_BOOKING_ID, tab);
    pages.set(tab, page);
    expect(currentTab(page)).toBe(BOOKING_TABS.find((candidate) => candidate.id === tab)?.label);
    const attention = within(page).getByRole("region", { name: "Needs attention" });
    expect(
      [...attention.querySelectorAll("[data-attention]")].map((item) => item.getAttribute("data-attention")),
    ).toEqual(["airline-card", "ticketing"]);
    expect(page.innerHTML).not.toContain(CARD_HOLDER);
    expect(page.innerHTML).not.toContain(CARD_EXPIRY);
  }
  return pages;
}

// Once per file: the first server render of the page (React DOM server, every section, next/link) and the SDK's
// first calls are the slowest in a fresh worker; on a busy CI runner they would otherwise land in the first test's
// own five seconds.
beforeAll(async () => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers());
  signedIn();
  bookingAnswers(ticketedBooking());
  api.on(PAYMENT(STRIPE_PAYMENT_ID), () => Response.json(stripePayment()));
  api.on(RETRIEVE(BOOKING_ID), () => Response.json(retrieval()));
  for (const tab of BOOKING_TABS) {
    await renderTab(BOOKING_ID, tab.id);
  }
  vi.unstubAllGlobals();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers({ "User-Agent": "Mozilla/5.0 Test" }));
  signedIn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("/bookings/[bookingId]", () => {
  it("[OAD-007 AC1] renders the overview of a ticketed booking: net and markup lines, ticketing, payment, cancellation, sync", async () => {
    bookingAnswers(ticketedBooking());

    const page = await renderTab(BOOKING_ID, "overview");

    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe("Booking VX7K2Q");
    expect(currentTab(page)).toBe("Overview");
    const sent = api.sent(GET(BOOKING_ID));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url.search).toBe("");
    expect(sent[0]?.headers.get("X-Velexis-Environment")).toBe("test");
    // Nothing of this booking needs staff.
    expect(within(page).queryByRole("region", { name: "Needs attention" })).toBeNull();

    const facts = region(page, "Booking");
    expect(fact(facts, "Record locators")).toBe("QX8P4L (GDS, main), 5HTR2K (AF)");
    expect(fact(facts, "Customer")).toBe("Anna Berg <anna.berg@example.com>");
    expect(fact(facts, "Owner office")).toBe("NCE1A0950");

    // Markup lines and net amounts, shown to staff.
    const pricing = region(page, "Pricing");
    expect(fact(pricing, "Net base fares")).toBe("€742.00");
    expect(fact(pricing, "Net taxes")).toBe("€478.56");
    expect(fact(pricing, "Net services")).toBe("€45.00");
    expect(fact(pricing, "Net cost")).toBe("€1,265.56");
    expect(fact(pricing, "Markup")).toBe("€116.00 (Long-haul economy 8%)");
    expect(fact(pricing, "Service fees")).toBe("€20.00");
    expect(fact(pricing, "Card fees")).toBe("€12.50");
    expect(fact(pricing, "Selling total")).toBe("€1,414.06");
    expect(fact(pricing, "Margin")).toBe("€148.50 (10.50 %)");
    expect(fact(pricing, "Pricing mode")).toBe("Markup rules");

    const itinerary = region(page, "Itinerary");
    expect(within(itinerary).getByText(/^Outbound: CDG → JFK/)).toBeTruthy();
    expect(within(itinerary).getByText(/^Return: JFK → CDG/)).toBeTruthy();
    expect(itinerary.textContent).toContain("AF6");
    expect(itinerary.textContent).toContain("Economy · V · VS50BALA · ECONOMY STANDARD");

    const ticketing = region(page, "Ticketing");
    expect(fact(ticketing, "Status")).toBe("Issued");
    expect(fact(ticketing, "Policy")).toBe("Issue after payment");
    expect(fact(ticketing, "Deadline")).toBe(when("2026-10-13T21:59:00Z"));
    expect(fact(ticketing, "Agreement")).toBe("Confirm");

    const payment = region(page, "Payment");
    expect(fact(payment, "Payment status")).toBe("Paid");
    expect(fact(payment, "Paid")).toBe("€1,414.06");
    expect(payment.textContent).toContain("Stripe · Card");

    const cancellation = region(page, "Cancellation");
    expect(cancellation.textContent).toContain("Not cancelled.");
    expect(fact(cancellation, "Cancel from the console")).toBe("Allowed");
    expect(fact(cancellation, "Customer self-service")).toBe("Allowed");

    const actions = region(page, "What you can do now");
    expect(fact(actions, "Issue tickets")).toBe("Not nowthe tickets are issued");
    expect(fact(actions, "Open the Amadeus order")).toBe("Allowed");

    const sync = region(page, "Supplier sync");
    expect(fact(sync, "Status")).toBe("Up to date");
    expect(fact(sync, "Next scheduled sync")).toBe(when("2026-10-10T15:20:52Z"));
    const [call] = rowsOf(within(sync).getByRole("table"));
    expect(call?.slice(1, 5)).toEqual([
      "checkout.completesreq_01JA4CG7Y3B6E9H2L5P8S1W4Z7",
      "FlightOrderIssue (issueFlightOrder)",
      "200",
      "Success",
    ]);
    expect(region(page, "Fare conditions").textContent).toContain("€80.00");
    // "Sync from Amadeus" reads the booking with refresh, never prefetched.
    expect(within(page).getByRole("link", { name: "Sync from Amadeus" }).getAttribute("href")).toBe(
      `/bookings/${BOOKING_ID}?refresh=1`,
    );
    // The stored order of console.bookings.get is not rendered: the Amadeus order tab reads the order anew.
    expect(api.sent(RETRIEVE(BOOKING_ID))).toHaveLength(0);
  });

  it("[OAD-007 AC1] renders travellers with masked documents, contacts, remarks, tickets and documents of a ticketed booking", async () => {
    bookingAnswers(
      ticketedBooking({
        formOfIdentifications: [
          {
            identificationType: "PASSPORT",
            carrierCode: "AF",
            number: FULL_IDENTIFICATION,
            travelerIds: ["1"],
          },
        ],
      }),
    );

    let page = await renderTab(BOOKING_ID, "travellers");

    expect(currentTab(page)).toBe("Travellers and contacts");
    const travellers = region(page, "Travellers");
    const anna = within(travellers).getByRole("article", { name: "ANNA BERG" });
    expect(fact(anna, "Documents")).toBe(
      "Passport · •••••4821 · issued in SE · nationality SE · expires 2031-05-14",
    );
    expect(fact(anna, "Phones")).toBe("+46 701234567 (mobile)");
    expect(fact(anna, "Loyalty programmes")).toBe("AF 2084471234");
    const leo = within(travellers).getByRole("article", { name: "LEO BERG" });
    expect(fact(leo, "Documents")).toContain("•••••7310");
    // A full number the API sent is cut to its last 4: only the Amadeus order view shows documents in full.
    expect(page.innerHTML).not.toContain(FULL_CHILD_PASSPORT);
    expect(page.innerHTML).not.toContain(FULL_PASSPORT);
    // The order's forms of identification (passport numbers too) are cut the same way.
    expect(page.innerHTML).not.toContain(FULL_IDENTIFICATION);
    expect(page.textContent).toContain('"number": "•••••3916"');
    expect(page.textContent).toContain('"identificationType": "PASSPORT"');
    expect(rowsOf(within(region(page, "Contacts")).getByRole("table"))).toEqual([
      ["ANNA BERGPrimary", "Standard", "anna.berg@example.com", "+46 701234567 (mobile)", "None", "en"],
    ]);
    const remarks = rowsOf(within(region(page, "Remarks")).getByRole("table"));
    expect(remarks.map((row) => row.slice(0, 4))).toEqual([
      ["CHILD MEAL REQUESTED FOR LEO IF POSSIBLE", "General · GENERAL_MISCELLANEOUS", "Customer", "LEO BERG"],
      ["VELEXIS VX7K2Q", "General · BACKOFFICE", "System", "All"],
    ]);
    expect(fact(region(page, "Ticketing agreement"), "Option")).toBe("Confirm");

    page = await renderTab(BOOKING_ID, "tickets");

    expect(currentTab(page)).toBe("Tickets and documents");
    expect(rowsOf(within(region(page, "Tickets")).getByRole("table"))).toEqual([
      [
        "057-2412345678",
        "ETICKET",
        "Issued",
        "ANNA BERG",
        "AF6 CDG → JFK, AF11 JFK → CDG",
        when("2026-10-10T09:20:52Z"),
        "€769.28",
      ],
      [
        "057-2412345679",
        "ETICKET",
        "Issued",
        "LEO BERG",
        "AF6 CDG → JFK, AF11 JFK → CDG",
        when("2026-10-10T09:20:52Z"),
        "€632.28",
      ],
    ]);
    const documents = rowsOf(within(region(page, "Documents")).getByRole("table"));
    expect(documents.map((row) => [row[0], row[1], row[4]])).toEqual([
      ["Itinerary", "Ready", "None"],
      ["E-ticket receipt", "Ready", "057-2412345678"],
    ]);
    expect(rowsOf(within(region(page, "Services")).getByRole("table"))[0]?.slice(0, 4)).toEqual([
      "1 extra checked bag (23 kg)",
      "ANNA BERG",
      "AF6 CDG → JFK, AF11 JFK → CDG",
      "Confirmed",
    ]);
    expect(api.sent(RETRIEVE(BOOKING_ID))).toHaveLength(0);
  });

  it("[OAD-007 AC1] renders payments from console.payments.get, the timeline with notes and the staff actions of a ticketed booking", async () => {
    bookingAnswers(ticketedBooking());
    api.on(PAYMENT(STRIPE_PAYMENT_ID), () => Response.json(stripePayment()));

    let page = await renderTab(BOOKING_ID, "payments");

    expect(currentTab(page)).toBe("Payments");
    expect(api.sent(PAYMENT(STRIPE_PAYMENT_ID))).toHaveLength(1);
    const card = within(region(page, "Payments")).getByRole("article", {
      name: `Payment ${STRIPE_PAYMENT_ID}`,
    });
    expect(card.textContent).toContain("Partially refunded");
    expect(fact(card, "Card")).toBe("VISA •••• 4242");
    expect(fact(card, "Account")).toBe("Connect standard");
    expect(fact(card, "Version")).toBe("6");
    const [events, refunds] = within(card).getAllByRole("table");
    expect(rowsOf(events as HTMLElement).map((row) => row.slice(1, 5))).toEqual([
      ["payment.created", "Api", "requires_payment_method", "None"],
      ["payment.captured", "System", "authorized → captured", "€1,414.06"],
    ]);
    expect(rowsOf(refunds as HTMLElement)).toEqual([
      [
        when("2026-10-12T08:00:00Z"),
        "€100.00",
        "None",
        "GoodwillDelayed baggage on the outbound flight",
        "Succeeded",
        "Staff stf_01JA2X7Q9M3K5N8P1R4T6V0W2Y",
        "re_3Q9xK2LkdIwHu7ix0Refund1",
        "None",
      ],
    ]);
    expect(region(page, "Forms of payment on the Amadeus order").textContent).toContain(
      "Other: ACCOUNT · flight offers 1",
    );

    page = await renderTab(BOOKING_ID, "timeline");

    expect(currentTab(page)).toBe("Timeline and notes");
    const notes = region(page, "Notes");
    expect(notes.textContent).toContain("Customer asked for a child meal for LEO; requested via remark.");
    expect(notes.textContent).toContain("Maria Lopez (agent)");
    expect(notes.textContent).toContain("Internal");
    const events2 = region(page, "Timeline");
    const ticketed = events2.querySelector('[data-event-type="booking.ticketed"]');
    expect(ticketed?.textContent).toContain("2 e-tickets issued");
    expect(ticketed?.textContent).toContain("Status confirmed → ticketed");
    expect(ticketed?.textContent).toContain("Visible to the customer");
    expect(events2.querySelector('[data-event-type="staff.note"]')?.textContent).toContain("Internal");

    page = await renderTab(BOOKING_ID, "staff-actions");

    expect(currentTab(page)).toBe("Staff actions");
    expect(rowsOf(within(region(page, "Staff actions")).getByRole("table"))).toEqual([
      [
        when("2026-10-10T10:05:12Z"),
        "booking.note",
        "Succeeded",
        "maria.lopez@acme-travel.example (agent)",
        "None",
        "req_01JA4F7H1J4M7P0S3V6Y9B2E5H",
      ],
    ]);
    expect(api.sent(RETRIEVE(BOOKING_ID))).toHaveLength(0);
  });

  it("[OAD-007 AC1] renders the overview, travellers, tickets and order of a manual-review airline-card booking, highlighted", async () => {
    const pages = await renderAirlineCardTabs(["overview", "travellers", "tickets", "amadeus-order"]);

    const overview = pages.get("overview") as HTMLElement;
    const attention = within(overview).getByRole("region", { name: "Needs attention" });
    const airline = attention.querySelector('[data-attention="airline-card"]');
    expect(airline?.textContent).toContain(
      "The airline card cannot be charged again: issue with another form of payment or cancel",
    );
    expect(airline?.getAttribute("data-tone")).toBe("danger");
    const review = attention.querySelector('[data-attention="ticketing"]');
    expect(review?.textContent).toContain("Ticketing needs staff review");
    expect(review?.textContent).toContain(MANUAL_REVIEW_SUMMARY);
    expect(review?.textContent).toContain(`Ticketing deadline ${when(DEADLINE)}.`);
    expect(fact(region(overview, "Ticketing"), "Status")).toBe("Manual review");
    expect(fact(region(overview, "What you can do now"), "Issue tickets")).toBe("Allowed");
    expect(fact(region(overview, "Payment"), "Payment status")).toBe("Unpaid");
    expect(region(overview, "Pricing").textContent).toContain("€1,265.56");

    expect(region(pages.get("travellers") as HTMLElement, "Travellers").textContent).toContain("•••••4821");
    expect(region(pages.get("tickets") as HTMLElement, "Tickets").textContent).toContain(
      "No tickets issued.",
    );
    expect(
      within(pages.get("amadeus-order") as HTMLElement).getByRole("region", { name: "Amadeus order" }),
    ).toBeTruthy();
  });

  it("[OAD-007 AC1] renders the payments, timeline and staff actions of a manual-review airline-card booking, without card data", async () => {
    const pages = await renderAirlineCardTabs(["payments", "timeline", "staff-actions"]);

    const payments = pages.get("payments") as HTMLElement;
    const card = within(region(payments, "Payments")).getByRole("article", {
      name: `Payment ${AIRLINE_PAYMENT_ID}`,
    });
    expect(card.textContent).toContain("Airline · Airline card");
    expect(card.textContent).toContain("Processing");
    expect(card.textContent).toContain(
      "Charged by the airline through Amadeus: the card cannot be charged again, and refunds go through the airline, not the console.",
    );
    expect(fact(card, "Card")).toBe("VISA •••• 1111");
    expect(fact(card, "Account")).toBe("None");
    // The payment as console.payments.get answers it: its version, events and refunds.
    expect(api.sent(PAYMENT(AIRLINE_PAYMENT_ID))).toHaveLength(1);
    expect(fact(card, "Version")).toBe("2");
    const [events, refunds] = within(card).getAllByRole("table");
    expect(rowsOf(events as HTMLElement).map((row) => row[1])).toEqual(["payment.created"]);
    expect(refunds).toBeUndefined();
    expect(card.textContent).toContain("No refunds.");
    expect(region(payments, "Forms of payment on the Amadeus order").textContent).toBe(
      "Forms of payment on the Amadeus orderCard VISA •••• 1111 · flight offers 1",
    );

    const timeline = region(pages.get("timeline") as HTMLElement, "Timeline");
    expect(
      timeline.querySelector('[data-event-type="booking.ticketing_manual_review"]')?.textContent,
    ).toContain("Internal");
    expect(region(pages.get("timeline") as HTMLElement, "Notes").textContent).toContain("No notes.");
    expect(region(pages.get("staff-actions") as HTMLElement, "Staff actions").textContent).toContain(
      "No staff actions yet.",
    );
  });

  it("[OAD-007 AC2] does not call console.bookings.retrieve until the Amadeus order view is opened", async () => {
    bookingAnswers(ticketedBooking());
    api.on(PAYMENT(STRIPE_PAYMENT_ID), () => Response.json(stripePayment()));
    api.on(RETRIEVE(BOOKING_ID), () =>
      Response.json(retrieval(), { headers: { "X-Request-Id": "req_retrieve" } }),
    );

    for (const tab of BOOKING_TABS.filter((candidate) => candidate.id !== "amadeus-order")) {
      const page = await renderTab(BOOKING_ID, tab.id);
      const link = within(page).getByRole("link", { name: "Amadeus order" });
      expect(link.getAttribute("href")).toBe(`/bookings/${BOOKING_ID}?tab=amadeus-order`);
      expect(page.innerHTML).not.toContain(FULL_PASSPORT);
      // No tab shows the stored order of console.bookings.get in its place.
      expect(page.innerHTML).not.toContain(STORED_ORDER_MARKER);
    }
    expect(api.sent(RETRIEVE(BOOKING_ID))).toHaveLength(0);
    expect(api.sent(GET(BOOKING_ID))).toHaveLength(BOOKING_TABS.length - 1);

    const page = await renderTab(BOOKING_ID, "amadeus-order");

    const [sent] = api.sent(RETRIEVE(BOOKING_ID));
    expect(api.sent(RETRIEVE(BOOKING_ID))).toHaveLength(1);
    expect(sent?.url.search).toBe("");
    expect(sent?.headers.get("X-Velexis-Environment")).toBe("test");
    expect(currentTab(page)).toBe("Amadeus order");
    const order = region(page, "Amadeus order");
    expect(fact(order, "Amadeus call")).toBe(
      "GET /v1/booking/flight-orders/eJzTd9cPNfX09DUFAAsGAkQ → 200 in 1320 ms",
    );
    expect(fact(order, "Stored order refreshed")).toBe("Yes");
    // The verbatim order in the JSON view, open: net prices and the full document numbers.
    const json = within(order).getByRole("region", { name: "Flight order" });
    expect(json.closest("details")?.hasAttribute("open")).toBe(true);
    expect(json.textContent).toContain(`"number": "${FULL_PASSPORT}"`);
    expect(json.textContent).toContain('"grandTotal": "1265.56"');
    // The order read from Amadeus now, not the stored one.
    expect(page.innerHTML).not.toContain(STORED_ORDER_MARKER);
    expect(within(order).getByRole("link", { name: "Read again" }).getAttribute("href")).toBe(
      `/bookings/${BOOKING_ID}?tab=amadeus-order`,
    );
  });

  it("[OAD-007 AC2] reads no order for a booking without one and shows a refused read in its tab", async () => {
    const pending = ticketedBooking({
      status: "pending",
      recordLocator: null,
      amadeusOrderId: null,
      consoleActions: {
        canIssue: false,
        canPatch: false,
        canCancel: false,
        canResync: false,
        canRetrieve: false,
        canAddNote: true,
        reasons: {
          canIssue: "pending",
          canPatch: "pending",
          canCancel: "pending",
          canResync: "pending",
          canRetrieve: "pending",
        },
      },
    });
    bookingAnswers(pending);

    let page = await renderTab(BOOKING_ID, "amadeus-order");

    expect(api.sent(RETRIEVE(BOOKING_ID))).toHaveLength(0);
    expect(region(page, "Amadeus order").textContent).toContain(
      "The order is not known yet: the reconciliation decides first.",
    );

    bookingAnswers(ticketedBooking());
    api.on(RETRIEVE(BOOKING_ID), () =>
      apiError("SUPPLIER_REJECTED", 422, {
        supplier: { provider: "amadeus", code: 4926, title: "INVALID DATA RECEIVED" },
      }),
    );
    page = await renderTab(BOOKING_ID, "amadeus-order");

    const alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("The Amadeus order could not be read");
    expect(alert.textContent).toContain("Amadeus refused the request.");
    expect(alert.textContent).toContain("Amadeus 4926: INVALID DATA RECEIVED");
    expect(alert.textContent).toContain("req_fake_1");
    expect(alert.textContent).not.toContain("The API refused the request");
    // The booking stays on the page above the refused order.
    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe("Booking VX7K2Q");

    api.on(RETRIEVE(BOOKING_ID), () => apiError("SUPPLIER_TIMEOUT", 504, {}, { "Retry-After": "60" }));
    page = await renderTab(BOOKING_ID, "amadeus-order");
    expect(within(page).getByRole("alert").textContent).toContain(
      "Amadeus did not answer. Resync before retrying.",
    );
  });

  it("highlights a booking whose outcome is unknown with the time the reconciliation decides by, and one handed to the staff", async () => {
    const until = "2026-10-10T10:15:00Z";
    const timeout = {
      id: "evt_01JA6C3D5F7H9K1M3P5R7T9V1X",
      type: "booking.supplier_timeout",
      actor: {
        type: "customer" as const,
        id: "cus_8f3K2mQ9xT4vB7nL",
        name: "Anna Berg",
        email: null,
        role: null,
      },
      summary: `Amadeus did not confirm booking VX7K2Q; the order is looked for until ${until}.`,
      statusFrom: "pending",
      statusTo: "pending",
      visibleToCustomer: false,
      supplierRequestId: null,
      data: { reconcileUntil: until },
      createdAt: "2026-10-10T10:00:00Z",
    };
    const pending = ticketedBooking({
      status: "pending",
      recordLocator: null,
      amadeusOrderId: null,
      tickets: [],
      ticketing: { status: "pending", policy: "issue_after_payment", deadlineAt: null },
      events: [timeout],
    });
    bookingAnswers(pending);

    let page = await renderTab(BOOKING_ID, "overview");

    let attention = within(page).getByRole("region", { name: "Needs attention" });
    expect(attention.querySelector('[data-attention="reconciling"]')?.textContent).toContain(
      `Outcome unknown, reconciling until ${when(until)}`,
    );
    expect(within(page).queryByRole("link", { name: "Sync from Amadeus" })).toBeNull();
    expect(page.textContent).toContain("Record locator None yet");

    bookingAnswers({
      ...pending,
      ticketing: { status: "manual_review", policy: "issue_after_payment", deadlineAt: null },
      events: [
        {
          ...timeout,
          id: "evt_01JA6C3D5F7H9K1M3P5R7T9V1Y",
          type: "booking.reconcile_manual_review",
          summary: "The order was not found in the booking queue by the deadline.",
          data: {},
          createdAt: "2026-10-10T10:15:30Z",
        },
        timeout,
      ],
    });
    page = await renderTab(BOOKING_ID, "overview");

    attention = within(page).getByRole("region", { name: "Needs attention" });
    expect(
      [...attention.querySelectorAll("[data-attention]")].map((item) => item.getAttribute("data-attention")),
    ).toEqual(["reconcile-review"]);
    expect(attention.textContent).toContain("Reconciliation needs staff review");
    expect(attention.textContent).toContain("The order was not found in the booking queue by the deadline.");
  });

  it("shows the cancellation block with the money's state and both canCancel reasons", async () => {
    bookingAnswers(
      ticketedBooking({
        status: "cancelled",
        cancelledAt: "2026-10-15T09:00:05Z",
        cancellation: {
          bookingId: BOOKING_ID,
          status: "cancelled",
          requestedAt: "2026-10-15T09:00:00Z",
          cancelledAt: "2026-10-15T09:00:05Z",
          cancelledBy: "staff",
          reasonCode: "customer_request",
          comment: "Traveller called to cancel",
          ticketsVoided: true,
          estimatedRefund: eur("1314.06"),
          refund: {
            id: "rfd_01JA7D4E6G8J0L2N4Q6S8U0W2Y",
            paymentId: STRIPE_PAYMENT_ID,
            bookingId: BOOKING_ID,
            amount: eur("1314.06"),
            penalty: eur("100.00"),
            reason: "booking_cancelled",
            status: "succeeded",
            createdAt: "2026-10-15T09:00:05Z",
          },
          refundStatus: "succeeded",
        },
        allowedActions: {
          ...ticketedBooking().allowedActions,
          canCancel: false,
          reasons: { canCancel: "cancelled" },
        },
        consoleActions: {
          ...ticketedBooking().consoleActions,
          canCancel: false,
          reasons: { canCancel: "cancelled" },
        },
      }),
    );

    let page = await renderTab(BOOKING_ID, "overview");

    let cancellation = region(page, "Cancellation");
    expect(fact(cancellation, "Status")).toBe("Cancelled");
    expect(fact(cancellation, "Cancelled by")).toBe("Staff");
    expect(fact(cancellation, "Reason")).toBe("Customer request");
    expect(fact(cancellation, "Comment")).toBe("Traveller called to cancel");
    expect(fact(cancellation, "Tickets voided")).toBe("Yes");
    expect(fact(cancellation, "Money back")).toBe("Succeeded");
    expect(fact(cancellation, "Refunded or released")).toBe("€1,314.06");
    expect(fact(cancellation, "Kept")).toBe("€100.00");
    expect(fact(cancellation, "Cancel from the console")).toBe("Not nowthe booking is cancelled");
    expect(fact(cancellation, "Customer self-service")).toBe("Not nowthe booking is cancelled");
    expect(within(page).queryByRole("region", { name: "Needs attention" })).toBeNull();

    // A cancellation whose capture failed: the money waits for the staff, and the customer cannot cancel again.
    bookingAnswers(
      ticketedBooking({
        cancellation: {
          bookingId: BOOKING_ID,
          status: "pending",
          requestedAt: "2026-10-15T09:00:00Z",
          cancelledAt: null,
          cancelledBy: "customer",
          reasonCode: "change_of_plans",
          ticketsVoided: false,
          refund: null,
          refundStatus: "manual_review",
        },
        allowedActions: {
          ...ticketedBooking().allowedActions,
          canCancel: false,
          reasons: { canCancel: "pending" },
        },
      }),
    );
    page = await renderTab(BOOKING_ID, "overview");

    cancellation = region(page, "Cancellation");
    expect(fact(cancellation, "Status")).toBe("Requested, not completed");
    expect(fact(cancellation, "Money back")).toBe("Needs staff review");
    expect(fact(cancellation, "Customer self-service")).toBe(
      "Not nowthe booking or an earlier cancellation waits for a decision",
    );
    const attention = within(page).getByRole("region", { name: "Needs attention" });
    expect(attention.querySelector('[data-attention="cancellation"]')?.textContent).toContain(
      "The cancellation's money needs staff",
    );
  });

  it("syncs from Amadeus on request and reads the booking again without the refresh when Amadeus fails", async () => {
    let refreshed = false;
    api.on(GET(BOOKING_ID), (request) => {
      refreshed = request.url.searchParams.get("refresh") === "true";
      return Response.json(
        ticketedBooking({
          supplierSync: { ...ticketedBooking().supplierSync, status: refreshed ? "refreshed" : "fresh" },
        }),
      );
    });

    let page = await renderPage(BOOKING_ID, "tab=tickets&refresh=1");

    expect(api.sent(GET(BOOKING_ID)).map((request) => request.url.search)).toEqual(["?refresh=true"]);
    expect(within(page).getByRole("status").textContent).toBe("Synchronised with Amadeus just now.");
    expect(currentTab(page)).toBe("Tickets and documents");
    expect(within(page).getByRole("link", { name: "Sync from Amadeus" }).getAttribute("href")).toBe(
      `/bookings/${BOOKING_ID}?tab=tickets&refresh=1`,
    );

    api.on(GET(BOOKING_ID), (request) =>
      request.url.searchParams.get("refresh") === "true"
        ? apiError("SUPPLIER_ERROR", 502)
        : Response.json(ticketedBooking()),
    );
    page = await renderPage(BOOKING_ID, "refresh=1");

    expect(
      api
        .sent(GET(BOOKING_ID))
        .slice(1)
        .map((request) => request.url.search),
    ).toEqual(["?refresh=true", ""]);
    const notice = within(page).getByRole("status");
    expect(notice.textContent).toContain(
      "The sync with Amadeus failed, so this is the stored booking. Amadeus answered with an error.",
    );
    expect(notice.textContent).toContain("req_fake_1");
    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe("Booking VX7K2Q");

    // Throttled by the API (one per 10 s), and ignored for a booking without an order to read.
    api.on(GET(BOOKING_ID), () =>
      Response.json(
        ticketedBooking({ supplierSync: { ...ticketedBooking().supplierSync, status: "throttled" } }),
      ),
    );
    page = await renderPage(BOOKING_ID, "refresh=1");
    expect(within(page).getByRole("status").textContent).toBe(
      "Synchronised with Amadeus moments ago: this is the data of that sync.",
    );
    api.on(GET(BOOKING_ID), () =>
      Response.json(
        ticketedBooking({
          status: "cancelled",
          supplierSync: { ...ticketedBooking().supplierSync, status: "stale" },
        }),
      ),
    );
    page = await renderPage(BOOKING_ID, "refresh=1");
    expect(within(page).getByRole("status").textContent).toBe(
      "Nothing was synchronised: the booking has no Amadeus order to read, or it is cancelled.",
    );
    expect(within(page).queryByRole("link", { name: "Sync from Amadeus" })).toBeNull();
  });

  it("redirects an expired session to /auth/refresh back to this tab, and an ended one to the portal", async () => {
    api.on(GET(BOOKING_ID), () => apiError("TOKEN_EXPIRED", 401));
    const next = new URLSearchParams({ next: `/bookings/${BOOKING_ID}?tab=payments` }).toString();
    // The way back never syncs again.
    expect(await redirectOf(() => renderPage(BOOKING_ID, "tab=payments&refresh=1"))).toBe(
      `/auth/refresh?${next}`,
    );

    bookingAnswers(ticketedBooking());
    api.on(PAYMENT(STRIPE_PAYMENT_ID), () => apiError("TOKEN_EXPIRED", 401));
    expect(await redirectOf(() => renderTab(BOOKING_ID, "payments"))).toBe(`/auth/refresh?${next}`);

    api.on(GET(BOOKING_ID), () => apiError("STAFF_MEMBERSHIP_INACTIVE", 403));
    expect(await redirectOf(() => renderPage(BOOKING_ID))).toBe(
      `${TEST_PORTAL_URL}/console?tenant=${TENANT_ID}`,
    );
  });

  it("renders a booking the environment does not have, an id that is not one and the API's refusals on the server", async () => {
    api.on(GET(BOOKING_ID), () => apiError("NOT_FOUND", 404));
    let page = await renderPage(BOOKING_ID);
    let alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("Booking not found");
    expect(alert.textContent).toContain(
      "No booking with this id in the TEST environment. It may belong to the other environment, or the link is wrong.",
    );
    expect(within(alert).getByRole("link", { name: "All bookings" }).getAttribute("href")).toBe("/bookings");

    page = await renderPage("not-a-booking");
    expect(within(page).getByRole("alert").textContent).toContain("Booking not found");
    expect(
      api.requests.filter((request) => request.url.pathname.startsWith("/v1/console/bookings")),
    ).toHaveLength(1);

    api.on(GET(BOOKING_ID), () =>
      apiError("FORBIDDEN", 403, { details: { requiredPermission: "bookings:read" } }),
    );
    page = await renderPage(BOOKING_ID, "tab=timeline");
    alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("The booking could not be loaded");
    expect(alert.textContent).toContain("You do not have permission to do this (bookings:read).");
    expect(alert.textContent).toContain("req_fake_1");
    expect(within(alert).getByRole("link", { name: "Try again" }).getAttribute("href")).toBe(
      `/bookings/${BOOKING_ID}?tab=timeline`,
    );
    expect(page.textContent).not.toContain("The API refused the request");

    api.on(GET(BOOKING_ID), () =>
      apiError("RATE_LIMITED", 429, { details: { retryAfterSeconds: 60 } }, { "Retry-After": "60" }),
    );
    page = await renderPage(BOOKING_ID);
    expect(within(page).getByRole("alert").textContent).toContain("Too many requests, retry in 60 s.");
  });

  it("shows a payment that could not be read in its place, and the booking's summary without payments:read", async () => {
    const booking = ticketedBooking({
      payments: [
        ...ticketedBooking().payments,
        airlineCardBooking().payments[0] as ConsoleBooking["payments"][number],
      ],
    });
    bookingAnswers(booking);
    api.on(PAYMENT(STRIPE_PAYMENT_ID), () => Response.json(stripePayment()));
    api.on(PAYMENT(AIRLINE_PAYMENT_ID), () => apiError("INTERNAL_ERROR", 500));

    let page = await renderTab(BOOKING_ID, "payments");

    const payments = region(page, "Payments");
    const failed = within(payments).getByRole("article", { name: `Payment ${AIRLINE_PAYMENT_ID}` });
    expect(within(failed).getByRole("alert").textContent).toContain("This payment could not be loaded");
    expect(within(failed).getByRole("alert").textContent).toContain(
      "The OTA API had an unexpected problem. Try again, and quote the request id if it persists.",
    );
    // The booking's own summary of that payment stays.
    expect(fact(failed, "Amount")).toBe("€1,401.56");
    const loaded = within(payments).getByRole("article", { name: `Payment ${STRIPE_PAYMENT_ID}` });
    expect(within(loaded).getAllByRole("table")).toHaveLength(2);

    const profile: ConsoleStaffProfile = {
      ...staffProfile({ role: "agent" }),
      permissions: staffProfile({ role: "agent" }).permissions.filter(
        (permission) => permission !== "payments:read",
      ),
    };
    api.on("GET /v1/console/auth/me", () => Response.json(profile));
    const before = api.requests.length;
    page = await renderTab(BOOKING_ID, "payments");

    expect(
      api.requests.slice(before).filter((request) => request.url.pathname.startsWith("/v1/console/payments")),
    ).toHaveLength(0);
    expect(region(page, "Payments").textContent).toContain(
      "Needs the permission payments:read for the payments' events and refunds.",
    );
    expect(
      fact(
        within(region(page, "Payments")).getByRole("article", { name: `Payment ${STRIPE_PAYMENT_ID}` }),
        "Card",
      ),
    ).toBe("VISA •••• 4242");
  });

  it("renders a failed staff profile and a role without bookings:read as states, without reading the booking", async () => {
    api.on("GET /v1/console/auth/me", () =>
      apiError("SERVICE_UNAVAILABLE", 503, {}, { "Retry-After": "60" }),
    );
    let page = await renderPage(BOOKING_ID);
    expect(within(page).getByRole("alert").textContent).toContain(
      "The OTA API is unavailable right now. Try again in a moment.",
    );

    const profile: ConsoleStaffProfile = {
      ...staffProfile({ role: "viewer" }),
      permissions: ["customers:read"],
    };
    api.on("GET /v1/console/auth/me", () => Response.json(profile));
    page = await renderPage(BOOKING_ID);
    expect(within(page).getByRole("alert").textContent).toContain(
      "You do not have permission to do this (bookings:read).",
    );
    expect(api.sent(GET(BOOKING_ID))).toHaveLength(0);
  });
});
