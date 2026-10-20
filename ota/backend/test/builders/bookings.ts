// Builders of the booking orchestration's values (OBE-042): the checkout travellers, contacts and special requests as
// the order request builder reads them, Amadeus answers of Flight Create Orders and Flight Order Issue built from the
// Amadeus stub's synthetic fixtures (tools/amadeus-stub/fixtures, no real person), and the change a Stripe
// confirmation in the browser leaves on a PaymentIntent of the fake Stripe API (test/helpers/fake-stripe.ts). Document
// numbers are random, generated at run time (test/builders/checkouts.ts), so a test can search a whole answer or table
// for "its" number. Builders only build values; sending or inserting them is the test's job (conventions §10).
//
//   const request = buildCreateOrderRequest({ ...buildOrderRequestInput(), travelers: [buildOrderTraveler()] });
//   const answer = buildCreatedOrderBody({ tickets: "full" });
//   stripe.update(payment.providerPaymentId, buildStripeConfirmation(9847));
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineBuilder, type Builder } from "@velexis/testing";
import type {
  OrderContact,
  OrderRemark,
  OrderRequestInput,
  OrderTraveler,
} from "../../src/bookings/order-request.builder";
import type { StoredDocument } from "../../src/checkout/traveler-documents";
import { APP_DIR } from "../../src/config";
import { dateFromToday, lettersOf, newDocumentNumber } from "./checkouts";

type JsonObject = Record<string, unknown>;

/** The Amadeus stub's fixtures (synthetic data, tools/amadeus-stub/fixtures/README.md). */
const FIXTURES_DIR = join(APP_DIR, "../../tools/amadeus-stub/fixtures");

/** The fixture operations these builders read. */
export type AmadeusFixtureOperation = "flight-offers-price" | "flight-create-orders" | "flight-order-issue";

const fixtureCache = new Map<AmadeusFixtureOperation, JsonObject>();

/** The `body` of the stub's `success` fixture of `operation`, a fresh copy on every call. */
export function amadeusFixtureBody(operation: AmadeusFixtureOperation): JsonObject {
  let body = fixtureCache.get(operation);
  if (body === undefined) {
    const file = JSON.parse(readFileSync(join(FIXTURES_DIR, operation, "success.json"), "utf8")) as {
      readonly body: JsonObject;
    };
    body = file.body;
    fixtureCache.set(operation, body);
  }
  return structuredClone(body);
}

/** The priced Amadeus offer 2 of flight-offers-price/success.json (Madrid–Paris Orly, one adult), verbatim. */
export function pricedFlightOffer(): JsonObject {
  const data = amadeusFixtureBody("flight-offers-price")["data"] as { flightOffers: JsonObject[] };
  const offer = data.flightOffers.find((entry) => entry["id"] === "2") ?? data.flightOffers[0];
  if (offer === undefined) {
    throw new Error("flight-offers-price/success.json has no flight offer");
  }
  return offer;
}

/** A passport as the checkout keeps it sealed (StoredDocument), with a fresh number. */
export const buildStoredPassport: Builder<StoredDocument> = defineBuilder<StoredDocument>(() => ({
  documentType: "PASSPORT",
  number: newDocumentNumber(),
  issuanceDate: dateFromToday(-365),
  expiryDate: dateFromToday(5 * 365),
  issuanceCountry: "SE",
  issuanceLocation: "STOCKHOLM",
  nationality: "SE",
  birthPlace: "UPPSALA",
  holder: true,
}));

/** An adult of a checkout as the order request builder reads it (decrypted lists included). */
export const buildOrderTraveler: Builder<OrderTraveler> = defineBuilder<OrderTraveler>((n) => ({
  travelerId: String(n),
  firstName: `TESTA${lettersOf(n)}`,
  middleName: null,
  lastName: "SAMPLE",
  secondLastName: null,
  dateOfBirth: "1988-04-12",
  gender: "FEMALE",
  contact: {
    emailAddress: `traveller-${n}@example.com`,
    phones: [{ deviceType: "MOBILE", countryCallingCode: "46", number: "701234567" }],
  },
  documents: [buildStoredPassport()],
  discounts: [],
  loyaltyPrograms: [{ programOwner: "IB", id: "2084471234" }],
  emergencyContact: null,
}));

/** The primary contact of a checkout as the order request builder reads it. */
export const buildOrderContact: Builder<OrderContact> = defineBuilder<OrderContact>((n) => ({
  purpose: "STANDARD",
  firstName: `TESTA${lettersOf(n)}`,
  lastName: "SAMPLE",
  companyName: null,
  email: `contact-${n}@example.com`,
  phones: [{ deviceType: "MOBILE", countryCallingCode: "46", number: "701234567" }],
  address: null,
  language: "en",
}));

/** A special request of the checkout for traveller 1. */
export const buildOrderRemark: Builder<OrderRemark> = defineBuilder<OrderRemark>((n) => ({
  text: `Window seat if possible ${lettersOf(n)}`,
  travelerIds: ["1"],
}));

/** Everything a Flight Create Orders request is built from: offer 2, one traveller, one contact, queue 50/0. */
export const buildOrderRequestInput: Builder<OrderRequestInput> = defineBuilder<OrderRequestInput>(() => ({
  flightOffers: [pricedFlightOffer()],
  travelers: [buildOrderTraveler({ travelerId: "1" })],
  contacts: [buildOrderContact()],
  remarks: [],
  reference: "VXK7M2Q9",
  queue: { number: 50, category: 0 },
  offices: { queuing: "NCE1A0955", owner: "NCE1A0955" },
  issue: false,
}));

/** A fresh record locator of the stored form (6 upper-case letters and digits). */
export function newRecordLocator(): string {
  return randomBytes(6)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .padEnd(6, "X")
    .slice(0, 6);
}

/** Options of `buildCreatedOrderBody`. */
export interface CreatedOrderOptions {
  /** E-tickets of the answer: one per traveller, the first traveller's only, or none (default). */
  readonly tickets?: "full" | "partial" | "none";
  /** The travellers of the order (`"1"` by default, the fixture's). */
  readonly travelerIds?: readonly string[];
  readonly recordLocator?: string;
  /** `ticketingAgreement.dateTime` of the answer, when the order holds a deadline of its own. */
  readonly agreementDateTime?: string;
  readonly warnings?: readonly JsonObject[];
}

/**
 * A Flight Create Orders answer (201 body) from flight-create-orders/success.json: its order of offer 2, with the
 * travellers, tickets, record locator and agreement asked for.
 */
export function buildCreatedOrderBody(options: CreatedOrderOptions = {}): JsonObject {
  const body = amadeusFixtureBody("flight-create-orders");
  const data = body["data"] as JsonObject;
  const recordLocator = options.recordLocator ?? newRecordLocator();
  const travelerIds = options.travelerIds ?? ["1"];
  const template = (data["travelers"] as JsonObject[])[0] ?? {};
  data["id"] = Buffer.from(`${recordLocator}|${dateFromToday(0)}`).toString("base64url");
  data["associatedRecords"] = [
    { ...(data["associatedRecords"] as JsonObject[])[0], reference: recordLocator },
  ];
  data["travelers"] = travelerIds.map((id) => ({ ...template, id }));
  const ticketed =
    options.tickets === "full" ? travelerIds : options.tickets === "partial" ? travelerIds.slice(0, 1) : [];
  if (ticketed.length > 0) {
    data["tickets"] = ticketed.map((travelerId, index) => ({
      documentType: "ETICKET",
      documentNumber: `000-${String(index + 1).padStart(10, "0")}`,
      documentStatus: "ISSUED",
      travelerId,
      segmentIds: ["3"],
    }));
  }
  if (options.agreementDateTime !== undefined) {
    data["ticketingAgreement"] = { option: "CONFIRM", dateTime: options.agreementDateTime };
  }
  if (options.warnings !== undefined) {
    body["warnings"] = [...options.warnings];
  }
  return body;
}

/**
 * The change a 3-D Secure confirmation in the browser leaves on a PaymentIntent with manual capture: `requires_capture`
 * for `amountMinor`, the card (test brand and last 4) and the authenticated charge. For `stripe.update(id, …)`.
 */
export function buildStripeConfirmation(
  amountMinor: number,
  card: { readonly brand?: string; readonly last4?: string } = {},
): JsonObject {
  const suffix = randomBytes(8).toString("hex");
  return {
    status: "requires_capture",
    amount_capturable: amountMinor,
    payment_method: {
      id: `pm_test_${suffix}`,
      object: "payment_method",
      type: "card",
      card: {
        brand: card.brand ?? "visa",
        last4: card.last4 ?? "4242",
        exp_month: 12,
        // A card that is still valid whenever the test runs (no fixed calendar date).
        exp_year: new Date().getUTCFullYear() + 5,
      },
    },
    latest_charge: {
      id: `ch_test_${suffix}`,
      object: "charge",
      payment_method_details: {
        type: "card",
        card: { three_d_secure: { result: "authenticated", version: "2.2.0" } },
      },
    },
  };
}
