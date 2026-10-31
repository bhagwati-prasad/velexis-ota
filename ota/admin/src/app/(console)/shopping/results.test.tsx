// @vitest-environment happy-dom
// The console of shopping on behalf (OAD-010: results.tsx) in a DOM, with its server actions mocked (README §12): what
// each form sends its action (the values as typed), the offers with their net totals, the field errors and Amadeus's
// issues of a refusal, an offer's branded fares and confirmed price (the offer posted back as the search answered it,
// with the search's reason), the seats per booking class, and that no input asks for a card. Every offer and price
// here is a dummy.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  searchOffers: vi.fn(),
  searchAvailability: vi.fn(),
  upsellOffer: vi.fn(),
  quoteOffer: vi.fn(),
}));
vi.mock("./actions", () => actions);

import type { AvailabilityState, OffersState, QuoteState, UpsellState } from "./actions";
import { SHOPPING_STRINGS, ShoppingConsole } from "./results";

/** How long a step that runs a (fake) server action through React's transition may take before a wait gives up. */
const UI_WAIT = { timeout: 3_000 } as const;

/** Words of a card form: none of the admin's inputs may be named, labelled or autofilled like one. */
const CARD_FIELD = /card|cvc|cvv|csc|security.?code|holder|expir|cc-(?:name|number|exp|csc|type)|\bpan\b/i;

const CALL = {
  supplierRequestId: "sreq_01JA4H1A3C5E7G9J1L3N5Q7S9U",
  environment: "test",
  officeId: "OSLN12345",
  amadeusApi: "FlightOffersSearch",
  amadeusOperationId: "searchFlightOffers",
  httpMethod: "POST",
  path: "/v2/shopping/flight-offers",
  httpStatus: 200,
  durationMs: 1240,
  correlationId: "0005K2D7QX1JZT",
  staffActionId: "sact_01JA4H1A4D6F8H0K2M4P6R8T0W",
} as const;

/** An offer of a search (dummy): Iberia Madrid to Orly, one adult, economy BASIC, net 98.47 EUR. */
function offer(id: string, grandTotal: string, brand = "BASIC", cls = "A") {
  return {
    type: "flight-offer",
    id,
    source: "GDS" as const,
    lastTicketingDate: "2027-01-15",
    numberOfBookableSeats: 9,
    itineraries: [
      {
        duration: "PT2H5M",
        segments: [
          {
            departure: { iataCode: "MAD", at: "2027-01-15T07:15:00" },
            arrival: { iataCode: "ORY", at: "2027-01-15T09:20:00" },
            carrierCode: "IB",
            number: "3436",
            operating: { carrierCode: "IB" },
            id: "3",
          },
        ],
      },
    ],
    price: { currency: "EUR", total: grandTotal, base: "56.00", grandTotal },
    validatingAirlineCodes: ["IB"],
    travelerPricings: [
      {
        travelerId: "1",
        fareOption: "STANDARD" as const,
        travelerType: "ADULT" as const,
        fareDetailsBySegment: [
          {
            segmentId: "3",
            cabin: "ECONOMY" as const,
            brandedFare: brand,
            brandedFareLabel: brand,
            class: cls,
            includedCheckedBags: { quantity: brand === "BASIC" ? 0 : 1 },
          },
        ],
      },
    ],
  };
}

const SEARCHED = offer("2", "98.47");
const CLASSIC = offer("1", "126.47", "CLASSIC", "O");

const OFFERS: OffersState = {
  ok: true,
  result: {
    call: CALL,
    amadeus: { meta: { count: 1 }, data: [SEARCHED], warnings: [{ code: 4926, title: "LIMITED CONTENT" }] },
  },
};

const UPSELL: UpsellState = {
  ok: true,
  result: {
    call: { ...CALL, amadeusApi: "BrandedFaresUpsell", amadeusOperationId: "upsellAirOffers" },
    amadeus: { data: [SEARCHED, CLASSIC] },
  },
};

const QUOTE_CHANGED: QuoteState = {
  ok: true,
  result: {
    call: { ...CALL, amadeusApi: "FlightOffersPrice", amadeusOperationId: "quoteAirOffers" },
    amadeus: {
      data: {
        type: "flight-offers-pricing",
        flightOffers: [offer("1", "131.20", "CLASSIC", "O")],
        bookingRequirements: {
          emailAddressRequired: true,
          mobilePhoneNumberRequired: true,
          travelerRequirements: [{ travelerId: "1", dateOfBirthRequired: true, documentRequired: true }],
        },
      },
      included: {
        bags: { "1": { name: "CHECKED_BAG", quantity: 1, price: { amount: "35.00", currencyCode: "EUR" } } },
      },
    },
  },
};

const AVAILABILITY: AvailabilityState = {
  ok: true,
  result: {
    call: {
      ...CALL,
      amadeusApi: "FlightAvailabilitiesSearch",
      amadeusOperationId: "searchFlightAvailabilities",
    },
    amadeus: {
      data: [
        {
          type: "flight-availability",
          id: "1",
          source: "GDS",
          segments: [
            {
              departure: { iataCode: "MAD", at: "2027-01-15T06:00:00" },
              arrival: { iataCode: "LIS", at: "2027-01-15T06:25:00" },
              carrierCode: "TP",
              number: "1017",
              aircraft: { code: "319" },
              operating: { carrierCode: "NI" },
              id: "1",
              availabilityClasses: [
                { class: "J", numberOfBookableSeats: 2 },
                { class: "Y", numberOfBookableSeats: 9 },
                { class: "B", closedStatus: "WAITLIST_OPEN" },
              ],
            },
          ],
        },
      ],
    },
  },
};

/** The form of a tab, by its name. */
function form(name: string): HTMLFormElement {
  return screen.getByRole("form", { name }) as HTMLFormElement;
}

/** Types `value` into the field labelled `label` of `root`. */
function type(root: HTMLElement, label: string, value: string): void {
  fireEvent.change(within(root).getByLabelText(label), { target: { value } });
}

/** Fills the offer search form with a one-way trip and submits it. */
async function searchFlights(): Promise<HTMLElement> {
  const offers = form(SHOPPING_STRINGS.offersForm);
  type(offers, SHOPPING_STRINGS.origin, "mad");
  type(offers, SHOPPING_STRINGS.destination, "par");
  type(offers, SHOPPING_STRINGS.departureDate, "2027-01-15");
  type(offers, SHOPPING_STRINGS.reason, "Caller compares fares");
  fireEvent.submit(offers);
  await waitFor(() => expect(actions.searchOffers).toHaveBeenCalledTimes(1), UI_WAIT);
  return offers;
}

/**
 * Clicks the button `name` of `root` once it is enabled: the buttons of the offers wait while a call runs, and React
 * shows a call's answer a moment before it ends the transition that made it (the state set after its `await`).
 */
async function clickWhenEnabled(root: HTMLElement, name: string): Promise<void> {
  const button = within(root).getByRole("button", { name }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false), UI_WAIT);
  fireEvent.click(button);
}

/** Every control of `root` as text: its name, autocomplete, type and label. */
function controlsOf(root: ParentNode): string[] {
  return [...root.querySelectorAll<HTMLInputElement>("input, select, textarea")].map((control) => {
    const labels = [...(control.labels ?? [])].map((label) => label.textContent ?? "");
    return [
      control.getAttribute("name") ?? "",
      control.getAttribute("autocomplete") ?? "",
      control.getAttribute("type") ?? control.tagName.toLowerCase(),
      control.getAttribute("placeholder") ?? "",
      ...labels,
    ].join(" | ");
  });
}

// Once per file: the first render, Radix's tabs and React's first transition are the slowest in a fresh worker; on a
// busy CI runner they would otherwise land in the first test's own five seconds. Nothing of it stays.
beforeAll(async () => {
  actions.searchOffers.mockResolvedValue(OFFERS);
  render(<ShoppingConsole environment="test" defaultCurrency="EUR" />);
  await searchFlights();
  await screen.findByRole("heading", { name: SHOPPING_STRINGS.offersFound(1) }, UI_WAIT);
  cleanup();
  document.body.replaceChildren();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  for (const action of Object.values(actions)) {
    action.mockReset();
  }
  actions.searchOffers.mockResolvedValue(OFFERS);
  actions.upsellOffer.mockResolvedValue(UPSELL);
  actions.quoteOffer.mockResolvedValue(QUOTE_CHANGED);
  actions.searchAvailability.mockResolvedValue(AVAILABILITY);
  render(<ShoppingConsole environment="test" defaultCurrency="EUR" />);
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe("ShoppingConsole", () => {
  it("[OAD-010 AC1] sends the offer search's values as typed and lists the offers with their net totals", async () => {
    await searchFlights();

    expect(actions.searchOffers).toHaveBeenCalledWith({
      origin: "mad",
      destination: "par",
      departureDate: "2027-01-15",
      returnDate: "",
      adults: "1",
      children: "0",
      infants: "0",
      cabin: "",
      nonStop: false,
      carriers: "",
      currency: "EUR",
      reason: "Caller compares fares",
    });
    const results = await screen.findByRole("region", { name: "1 offer (net prices)" }, UI_WAIT);
    const table = within(results).getAllByRole("table")[0] as HTMLElement;
    expect([...table.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual([
      "Offer",
      "Flights",
      "Fare",
      "Seats",
      "Last ticketing day",
      "Net total",
      "Actions",
    ]);
    const row = table.querySelector('tr[data-offer="2"]') as HTMLElement;
    expect(row.textContent).toContain("IB 3436 MAD Jan 15, 2027, 07:15 → ORY Jan 15, 2027, 09:20");
    expect(row.textContent).toContain("2 h 5 min · Non-stop");
    expect(row.textContent).toContain("Economy · BASIC · class A · No checked bag");
    expect(row.textContent).toContain("€98.47");
    expect(results.textContent).toContain(
      "Amadeus FlightOffersSearch · HTTP 200 · 1240 ms · office OSLN12345 · Amadeus request id 0005K2D7QX1JZT · call log sreq_01JA4H1A3C5E7G9J1L3N5Q7S9U",
    );
    expect(within(results).getByRole("note").textContent).toContain("4926 LIMITED CONTENT");
    expect(within(results).getByText("Amadeus answer (verbatim, net prices)")).toBeTruthy();
  });

  it("[OAD-010 AC1] asks for an offer's branded fares and confirms a fare's price with the offer and the search's reason", async () => {
    await searchFlights();
    const results = await screen.findByRole("region", { name: "1 offer (net prices)" }, UI_WAIT);

    await clickWhenEnabled(results, SHOPPING_STRINGS.brandedFares);
    await waitFor(() => expect(actions.upsellOffer).toHaveBeenCalledTimes(1), UI_WAIT);
    expect(actions.upsellOffer).toHaveBeenCalledWith({ offer: SEARCHED, reason: "Caller compares fares" });
    const working = await screen.findByRole("region", { name: "Offer 2: MAD → ORY" }, UI_WAIT);
    const fares = await within(working).findByRole("region", { name: "Branded fares (net prices)" }, UI_WAIT);
    const classic = fares.querySelector('tr[data-fare="1"]') as HTMLElement;
    expect(classic.textContent).toContain("CLASSIC");
    expect(classic.textContent).toContain("Economy · class O");
    expect(classic.textContent).toContain("1 checked bag");
    expect(classic.textContent).toContain("€126.47");

    await clickWhenEnabled(classic, SHOPPING_STRINGS.confirmPrice);
    await waitFor(() => expect(actions.quoteOffer).toHaveBeenCalledTimes(1), UI_WAIT);
    expect(actions.quoteOffer).toHaveBeenCalledWith({
      offer: CLASSIC,
      reason: "Caller compares fares",
      fareRules: false,
    });
    const quote = await within(working).findByRole(
      "region",
      { name: "Confirmed price of offer 1 (net)" },
      UI_WAIT,
    );
    // The confirmed net price differs from the fare's: the page says so, with both.
    expect(quote.querySelector('[data-price="changed"]')?.textContent).toBe(
      "The net price changed: was €126.47, now €131.20.",
    );
    expect(quote.textContent).toContain("An e-mail address");
    expect(quote.textContent).toContain("A mobile phone number");
    expect(quote.textContent).toContain("Traveller 1: date of birth, identity document");
    expect(quote.textContent).toContain("CHECKED_BAG, 1 ×: €35.00");
    // The branded fares stay beside the price.
    expect(within(working).getByRole("region", { name: "Branded fares (net prices)" })).toBeTruthy();
  });

  it("confirms the searched offer's price with the detailed fare rules when staff ask, and says when it holds", async () => {
    actions.quoteOffer.mockResolvedValue({
      ok: true,
      result: {
        call: CALL,
        amadeus: {
          data: { type: "flight-offers-pricing", flightOffers: [SEARCHED] },
          included: { "detailed-fare-rules": { "1": { fareBasis: "ADNNALB4", name: "PENALTIES" } } },
        },
      },
    } satisfies QuoteState);
    await searchFlights();
    const results = await screen.findByRole("region", { name: "1 offer (net prices)" }, UI_WAIT);

    fireEvent.click(within(results).getByLabelText(SHOPPING_STRINGS.fareRules));
    await clickWhenEnabled(results, SHOPPING_STRINGS.confirmPrice);

    await waitFor(() => expect(actions.quoteOffer).toHaveBeenCalledTimes(1), UI_WAIT);
    expect(actions.quoteOffer).toHaveBeenCalledWith({
      offer: SEARCHED,
      reason: "Caller compares fares",
      fareRules: true,
    });
    const quote = await screen.findByRole("region", { name: "Confirmed price of offer 2 (net)" }, UI_WAIT);
    expect(quote.querySelector('[data-price="confirmed"]')?.textContent).toBe(
      "Amadeus confirms the net price: €98.47.",
    );
    expect(within(quote).getByText("Detailed fare rules (verbatim)")).toBeTruthy();
    expect(actions.upsellOffer).not.toHaveBeenCalled();
  });

  it("shows the field errors on their inputs, and Amadeus's issues with the request id", async () => {
    actions.searchOffers.mockResolvedValueOnce({
      ok: false,
      code: "VALIDATION_FAILED",
      message: "Check the highlighted fields and try again.",
      fieldErrors: { origin: "Enter a three-letter airport or city code, like CDG or PAR." },
    } satisfies OffersState);
    await searchFlights();

    const alert = await screen.findByRole("alert", {}, UI_WAIT);
    expect(alert.textContent).toContain("Check the highlighted fields and try again.");
    const origin = within(form(SHOPPING_STRINGS.offersForm)).getByLabelText(SHOPPING_STRINGS.origin);
    expect(origin.getAttribute("aria-invalid")).toBe("true");
    const describedBy = origin.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(describedBy.map((id) => document.getElementById(id)?.textContent)).toContain(
      "Enter a three-letter airport or city code, like CDG or PAR.",
    );

    actions.searchOffers.mockResolvedValueOnce({
      ok: false,
      code: "SUPPLIER_REJECTED",
      message: "Amadeus refused the search.",
      requestId: "req_422",
      supplierIssues: [
        {
          code: 425,
          title: "INVALID DATE",
          detail: "Date/Time is in the past",
          source: "/originDestinations[0]",
        },
      ],
    } satisfies OffersState);
    fireEvent.submit(form(SHOPPING_STRINGS.offersForm));
    await waitFor(
      () => expect(screen.getByRole("alert").textContent).toContain("Amadeus refused the search."),
      UI_WAIT,
    );
    const refusal = screen.getByRole("alert");
    expect(refusal.textContent).toContain(
      "425 INVALID DATE: Date/Time is in the past (/originDestinations[0])",
    );
    expect(refusal.textContent).toContain("req_422");
    expect(screen.queryByRole("region", { name: "1 offer (net prices)" })).toBeNull();
  });

  it("[OAD-010 AC1] sends the availability search's values as typed and shows the seats per booking class", async () => {
    fireEvent.mouseDown(screen.getByRole("tab", { name: SHOPPING_STRINGS.availabilityTab }), { button: 0 });
    const availability = form(SHOPPING_STRINGS.availabilityForm);
    type(availability, SHOPPING_STRINGS.origin, "MAD");
    type(availability, SHOPPING_STRINGS.destination, "LIS");
    type(availability, SHOPPING_STRINGS.date, "2027-01-15");
    type(availability, SHOPPING_STRINGS.time, "06:00");
    type(availability, SHOPPING_STRINGS.bookingClass, "y");
    fireEvent.click(within(availability).getByLabelText(SHOPPING_STRINGS.includeClosed));
    fireEvent.submit(availability);

    await waitFor(() => expect(actions.searchAvailability).toHaveBeenCalledTimes(1), UI_WAIT);
    expect(actions.searchAvailability).toHaveBeenCalledWith({
      origin: "MAD",
      destination: "LIS",
      date: "2027-01-15",
      time: "06:00",
      seats: "1",
      carriers: "",
      bookingClass: "y",
      includeClosed: true,
      reason: "",
    });
    const results = await screen.findByRole("region", { name: "1 flight option" }, UI_WAIT);
    const row = results.querySelector('tr[data-option="1"]') as HTMLElement;
    expect([...row.querySelectorAll("td")].map((cell) => cell.textContent)).toEqual([
      "Option 1",
      "TP 1017 (operated by NI)",
      "MAD Jan 15, 2027, 06:00",
      "LIS Jan 15, 2027, 06:25",
      "319",
      "J2 Y9 BL",
    ]);
    expect(results.textContent).toContain(SHOPPING_STRINGS.classesLegend);
    expect(actions.searchOffers).not.toHaveBeenCalled();
  });

  it("has no input named, labelled or autofilled like a card's, and every input has autoComplete off", async () => {
    await searchFlights();
    await screen.findByRole("region", { name: "1 offer (net prices)" }, UI_WAIT);

    const controls = controlsOf(document.body);
    expect(controls.length).toBeGreaterThan(10);
    expect(controls.filter((control) => CARD_FIELD.test(control))).toEqual([]);
    const inputs = [...document.querySelectorAll<HTMLInputElement>("input, select")];
    expect(inputs.filter((control) => control.getAttribute("autocomplete") !== "off")).toEqual([]);
  });
});
