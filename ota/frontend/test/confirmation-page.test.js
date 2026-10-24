// The confirmation page (ota/frontend/docs/pages.md §11, flow ota/docs/flows/checkout-stripe.md §3, SDK guide B3 §2.8,
// OADR-0003): confirmation.html with its partials expanded by the build's include plugin, run by
// src/pages/confirmation.js against a fake SDK. It covers `bookings.get` and `bookings.getTicketingStatus({ refresh:
// true })` polled after `pollAfterSeconds` (fake timers), the states of §11 (ticketed, tickets being issued, pending
// after a timeout polled every 10 s until the booking is decided, failed, guests with the lookup link and "Create an
// account", `401` with the lookup link), `pending=1` from the complete and airline-card pages, and failed polls.
import {
  AuthenticationError,
  ConnectionError,
  NotFoundError,
  RateLimitError,
  ServerError,
  SupplierError,
} from "@velexis/ota-sdk";
import { Browser } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { includePartials } from "../scripts/vite-plugins.js";
import { formatMoney } from "../src/lib/format.js";
import { PENDING_POLL_LIMIT_MS, bookingHref, confirmationState, start } from "../src/pages/confirmation.js";
import { STOREFRONT_ROOT } from "./helpers/storefront.js";

/** The mocked boot() of the page module never resolves here (the static import above). */
vi.mock("../src/boot.js", async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  return { ...actual, boot: () => new Promise(() => {}) };
});

const BOOKING_ID = "bkg_01JCONFIRMBOOKING001";
const PAGE = "confirmation.html";
const EMAIL = "ada.lovelace@example.test";

/** @param {string} amount */
const eur = (amount) => ({ amount, currency: "EUR" });

const CONFIG = Object.freeze({
  name: "Demo Travel",
  defaultLocale: "en-GB",
  timeZone: "Europe/London",
  support: { email: "help@demo-travel.example", phone: null, hours: null, helpCenterUrl: null },
  features: { ancillaries: true, guestCheckout: true, customerAccounts: true },
});
const NO_ACCOUNTS_CONFIG = Object.freeze({
  ...CONFIG,
  features: { ...CONFIG.features, customerAccounts: false },
});
/** A signed-in customer. */
const SESSION = Object.freeze({ customer: { id: "cus_01JCONFIRMCUSTOMER1", firstName: "Ada" } });

/** The e-tickets of the two travellers. */
const TICKETS = Object.freeze([
  {
    id: "tkt_01JCONFIRMTICKET0001",
    documentType: "ETICKET",
    documentNumber: "057-2412345678",
    status: "ISSUED",
    travelerId: "1",
    travelerName: null,
    segmentIds: ["1"],
    issuedAt: "2026-10-23T10:00:00Z",
  },
  {
    id: "tkt_01JCONFIRMTICKET0002",
    documentType: "ETICKET",
    documentNumber: "057-2412345679",
    status: "ISSUED",
    travelerId: "2",
    travelerName: "TURING/ALAN MR",
    segmentIds: ["1"],
    issuedAt: "2026-10-23T10:00:00Z",
  },
  {
    id: "tkt_01JCONFIRMTICKET0003",
    documentType: "EMD",
    documentNumber: "057-2412345680",
    status: "ISSUED",
    travelerId: "1",
    travelerName: null,
    segmentIds: ["1"],
    issuedAt: "2026-10-23T10:00:00Z",
  },
]);

/**
 * A guest's booking of a one-way Paris–New York flight, ticketed.
 * @param {Record<string, unknown>} [overrides]
 */
function booking(overrides = {}) {
  return {
    id: BOOKING_ID,
    reference: "VX7K2Q",
    status: "ticketed",
    channel: "storefront",
    customerId: null,
    isGuest: true,
    recordLocator: "ABC123",
    recordLocators: [
      { reference: "ABC123", originSystemCode: "1A", primary: true },
      { reference: "XYZ789", originSystemCode: "AF", primary: false },
    ],
    tripType: "one_way",
    itineraries: [
      {
        index: 0,
        originCode: "CDG",
        destinationCode: "JFK",
        departureAt: "2026-12-01T10:00:00",
        arrivalAt: "2026-12-01T12:20:00",
        durationMinutes: 500,
        stops: 0,
        segments: [
          {
            id: "1",
            flightOfferId: "1",
            departure: { iataCode: "CDG", at: "2026-12-01T10:00:00" },
            arrival: { iataCode: "JFK", at: "2026-12-01T12:20:00" },
            carrierCode: "AF",
            carrierName: "Air France",
            number: "6",
            flightNumber: "AF6",
            status: "CONFIRMED",
            isFlown: false,
          },
        ],
      },
    ],
    travelers: [
      {
        id: "btr_01JCONFIRMTRAVELER01",
        travelerId: "1",
        travelerType: "ADULT",
        name: { firstName: "ADA", lastName: "LOVELACE" },
      },
      {
        id: "btr_01JCONFIRMTRAVELER02",
        travelerId: "2",
        travelerType: "ADULT",
        name: { firstName: "ALAN", lastName: "TURING" },
      },
    ],
    contacts: [{ id: "bco_01JCONFIRMCONTACT001", purpose: "STANDARD", isPrimary: true, emailAddress: EMAIL }],
    ancillaries: [],
    tickets: TICKETS,
    payments: [],
    refunds: [],
    remarks: [],
    totals: {
      currency: "EUR",
      base: eur("300.00"),
      taxes: eur("100.00"),
      fees: eur("12.30"),
      ancillaries: eur("0.00"),
      cardFee: eur("8.25"),
      total: eur("420.55"),
      paid: eur("420.55"),
      refunded: eur("0.00"),
    },
    ticketing: { status: "issued", policy: "issue_at_booking", deadlineAt: null },
    allowedActions: {},
    cancellation: null,
    lastSyncedAt: null,
    syncStatus: "fresh",
    version: 1,
    createdAt: "2026-10-23T10:00:00Z",
    updatedAt: "2026-10-23T10:00:00Z",
    ...overrides,
  };
}

/** A booking whose create-order outcome is not known yet (after `504 SUPPLIER_TIMEOUT`). */
const pendingBooking = () =>
  booking({
    status: "pending",
    recordLocator: null,
    recordLocators: [],
    tickets: [],
    ticketing: { status: "pending", policy: "issue_at_booking", deadlineAt: null },
  });

/**
 * A ticketing status of the booking.
 * @param {Record<string, unknown>} [overrides]
 */
function ticketing(overrides = {}) {
  return {
    bookingId: BOOKING_ID,
    bookingStatus: "ticketed",
    status: "issued",
    policy: "issue_at_booking",
    deadlineAt: null,
    attempts: 1,
    failureCode: null,
    message: null,
    tickets: TICKETS,
    pollAfterSeconds: null,
    ...overrides,
  };
}

/** While the outcome is unknown: polled every 10 s. */
const pendingStatus = () =>
  ticketing({ bookingStatus: "pending", status: "pending", tickets: [], pollAfterSeconds: 10, attempts: 0 });

/** @param {Function} ErrorClass @param {string} code @param {number} status @param {Record<string, unknown>} [body] */
const apiError = (ErrorClass, code, status, body = {}) =>
  new ErrorClass({ code, message: `${code} from the fake API`, status, requestId: "req_confirm", ...body });

/**
 * A fake API: `bookings.get` and `bookings.getTicketingStatus` answer their lists in turn (the last one again and
 * again; an Error is thrown).
 * @param {{ bookings?: unknown[], statuses?: unknown[] }} [options]
 */
function fakeApi({ bookings = [booking()], statuses = [ticketing()] } = {}) {
  /** @param {unknown[]} answers */
  const inTurn = (answers) => {
    let calls = 0;
    return vi.fn(async () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    });
  };
  return { client: { bookings: { get: inTurn(bookings), getTicketingStatus: inTurn(statuses) } } };
}

/** @type {Browser | undefined} */
let browser;
/** The parsed page. @type {Document | undefined} */
let pageDocument;
/** The test window's address and title before each test. */
const original = { address: "", title: "" };
/** Views started by the current test, destroyed after it. */
const views = /** @type {Array<{ destroy: () => void }>} */ ([]);

beforeAll(async () => {
  // Expands the page with the build's include plugin and parses it once in a happy-dom browser; each test imports a
  // fresh copy of its body into the test document.
  const plugin = includePartials({ root: STOREFRONT_ROOT });
  const transform = /** @type {{ handler: (html: string, ctx: { path: string }) => string }} */ (
    plugin.transformIndexHtml
  );
  const html = await transform.handler(readFileSync(join(STOREFRONT_ROOT, PAGE), "utf8"), {
    path: `/${PAGE}`,
  });
  browser = new Browser({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
  const page = browser.newPage();
  page.url = `${location.origin}/${PAGE}`;
  page.content = html;
  pageDocument = /** @type {Document} */ (/** @type {unknown} */ (page.mainFrame.document));
}, 15_000); // a file read, the include plugin and one happy-dom browser page; generous for a cold CI machine

afterAll(async () => {
  await browser?.close();
});

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  vi.useRealTimers();
  document.body.replaceChildren();
  if (original.title !== "") {
    document.title = original.title;
  }
  if (original.address !== "") {
    history.replaceState(null, "", original.address);
  }
});

/**
 * Puts a fresh copy of the page's body into the test document at `path`.
 * @param {string} path
 */
function showPage(path) {
  original.address ||= `${location.pathname}${location.search}`;
  original.title ||= document.title;
  const source = /** @type {Document} */ (pageDocument);
  document.body.replaceChildren(
    ...Array.from(source.body.childNodes, (node) => document.importNode(node, true)),
  );
  document.title = source.title;
  history.replaceState(null, "", path);
}

const text = (/** @type {Element | null | undefined} */ element) =>
  element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const $ = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (document.querySelector(selector));
const title = () => text($("[data-confirmation-title]"));
const items = (/** @type {string} */ selector) =>
  Array.from(document.querySelectorAll(`${selector} > li`), (item) => text(item));
const stateTitle = () => text($('[data-confirmation-state] [data-field="title"]'));
const stateLinks = () =>
  Array.from(document.querySelectorAll("[data-confirmation-state] a[data-state-link]"), (link) => [
    text(link),
    link.getAttribute("href"),
  ]);
const address = () => `${location.pathname}${location.search}`;

/**
 * Starts the confirmation page at `/confirmation.html?<query>` with a fake SDK, under fake timers, and lets the first
 * load settle.
 * @param {{ query?: string, fake?: ReturnType<typeof fakeApi>, config?: object, session?: object | null }} [options]
 */
async function openConfirmation({
  query = `booking=${BOOKING_ID}`,
  fake = fakeApi(),
  config = CONFIG,
  session = null,
} = {}) {
  vi.useFakeTimers();
  showPage(`/confirmation.html?${query}`);
  const view = start({
    config: /** @type {never} */ (config),
    client: /** @type {never} */ (fake.client),
    session: /** @type {never} */ (session),
  });
  if (!view) {
    throw new Error("the confirmation page did not start");
  }
  views.push(view);
  await vi.advanceTimersByTimeAsync(0);
  return { view, ...fake };
}

describe("confirmation page: states of a booking", () => {
  it("[OFE-013] a ticketed booking: tickets, reference, trip, the booking page and its documents; no polling", async () => {
    const { client } = await openConfirmation();

    expect(client.bookings.get).toHaveBeenCalledWith(
      { bookingId: BOOKING_ID },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledWith(
      { bookingId: BOOKING_ID, refresh: true },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(title()).toBe("Your tickets are issued");
    expect(document.title).toBe("Your tickets are issued");
    expect(text($("[data-status-text]"))).toBe(`Your e-tickets are ready. We have sent them to ${EMAIL}.`);
    // The flight tickets with their travellers (the EMD of an extra is not one of them).
    expect(items("[data-tickets]")).toEqual([
      "057-2412345678: ADA LOVELACE",
      "057-2412345679: TURING/ALAN MR",
    ]);
    expect($("[data-booking-links]").hidden).toBe(false);
    expect($("a[data-booking-link]").getAttribute("href")).toBe(bookingHref(BOOKING_ID));
    expect($("a[data-booking-link]").getAttribute("href")).toBe(`/booking.html?id=${BOOKING_ID}`);
    expect($("a[data-documents-link]").getAttribute("href")).toBe(`/booking.html?id=${BOOKING_ID}#documents`);
    expect($("a[data-documents-link]").hidden).toBe(false);
    expect($("[data-search-link]").hidden).toBe(true);
    expect(text($("[data-reference]"))).toBe("VX7K2Q");
    expect(text($("[data-airline-references]"))).toBe("Airline reference for online check-in: AF XYZ789");
    expect(items("[data-travellers]")).toEqual(["ADA LOVELACE", "ALAN TURING"]);
    expect(text($("[data-total]"))).toBe(formatMoney(eur("420.55"), "en-GB"));
    expect($("[data-itineraries] [data-itinerary]")).not.toBeNull();
    expect(text($("[data-itineraries]"))).toContain("Air France (AF)");
    expect($("[data-status-progress]").hidden).toBe(true);
    expect($("[data-status-panel]").dataset["status"]).toBe("ticketed");

    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(1);
  });

  it("[OFE-013] a confirmed booking says the tickets are being issued, polls them and shows them once issued", async () => {
    const confirmed = booking({
      status: "confirmed",
      tickets: [],
      ticketing: { status: "in_progress", policy: "issue_after_payment", deadlineAt: null },
    });
    const { client } = await openConfirmation({
      fake: fakeApi({
        bookings: [confirmed],
        statuses: [
          ticketing({ bookingStatus: "confirmed", status: "in_progress", tickets: [], pollAfterSeconds: 5 }),
          ticketing(),
        ],
      }),
    });

    expect(title()).toBe("Booking confirmed");
    expect(text($("[data-status-text]"))).toBe(
      `Your tickets are being issued. We will e-mail them to ${EMAIL} when they are ready.`,
    );
    expect($("[data-tickets-block]").hidden).toBe(true);
    expect($("[data-booking-links]").hidden).toBe(false);
    expect($("a[data-documents-link]").hidden).toBe(true);

    await vi.advanceTimersByTimeAsync(4999);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(2);
    expect(client.bookings.getTicketingStatus).toHaveBeenLastCalledWith(
      { bookingId: BOOKING_ID, refresh: true },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(title()).toBe("Your tickets are issued");
    expect(items("[data-tickets]")).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(2);
  });

  it("[OFE-013] ticketing that failed or waits for staff still reads 'Booking confirmed; tickets are being issued'", async () => {
    for (const status of ["failed", "manual_review", "partially_issued"]) {
      const { view } = await openConfirmation({
        fake: fakeApi({
          bookings: [booking({ status: "confirmed", tickets: [] })],
          statuses: [ticketing({ bookingStatus: "confirmed", status, tickets: [], pollAfterSeconds: null })],
        }),
      });
      expect(title(), status).toBe("Booking confirmed");
      expect(text($("[data-status-text]")), status).toContain("Your tickets are being issued");
      view.destroy();
    }
    expect(confirmationState("partially_ticketed", "partially_issued")).toBe("confirmed");
    expect(confirmationState("confirmed", "issued")).toBe("ticketed");
  });

  it("[OFE-013 AC2] the pending state polls every 10 s until the booking is decided, then shows the final state", async () => {
    const decided = booking({
      status: "confirmed",
      tickets: [],
      ticketing: { status: "in_progress", policy: "issue_at_booking", deadlineAt: null },
    });
    const { client } = await openConfirmation({
      query: `booking=${BOOKING_ID}&pending=1`,
      fake: fakeApi({
        bookings: [pendingBooking(), decided],
        statuses: [
          pendingStatus(),
          pendingStatus(),
          ticketing({ bookingStatus: "confirmed", status: "in_progress", tickets: [], pollAfterSeconds: 5 }),
          ticketing(),
        ],
      }),
    });

    expect(title()).toBe("We are confirming your booking with the airline");
    expect(text($("[data-status-text]"))).toBe(
      `This can take a few minutes. Please do not book again: this page updates by itself, and we will e-mail ${EMAIL}.`,
    );
    expect($("[data-status-progress]").hidden).toBe(false);
    expect($("[data-booking-links]").hidden).toBe(true);
    expect(text($("[data-reference]"))).toBe("VX7K2Q");
    expect(address()).toBe(`/confirmation.html?booking=${BOOKING_ID}&pending=1`);

    await vi.advanceTimersByTimeAsync(9999);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(2);
    expect(title()).toBe("We are confirming your booking with the airline");

    await vi.advanceTimersByTimeAsync(10_000);
    // Decided: the booking is read again, `pending=1` leaves the address, and the tickets are polled.
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(3);
    expect(client.bookings.get).toHaveBeenCalledTimes(2);
    expect(title()).toBe("Booking confirmed");
    expect($("[data-status-progress]").hidden).toBe(true);
    expect(address()).toBe(`/confirmation.html?booking=${BOOKING_ID}`);

    await vi.advanceTimersByTimeAsync(5000);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(4);
    expect(title()).toBe("Your tickets are issued");
    expect(items("[data-tickets]")).toEqual([
      "057-2412345678: ADA LOVELACE",
      "057-2412345679: TURING/ALAN MR",
    ]);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(4);
    expect(client.bookings.get).toHaveBeenCalledTimes(2);
  });

  it("[OFE-013 AC2] a pending booking that fails: 'did not go through, you have not been charged', polling ends", async () => {
    const failed = booking({ status: "failed", recordLocator: null, recordLocators: [], tickets: [] });
    const { client } = await openConfirmation({
      query: `booking=${BOOKING_ID}&pending=1`,
      fake: fakeApi({
        bookings: [pendingBooking(), failed],
        statuses: [
          pendingStatus(),
          ticketing({
            bookingStatus: "failed",
            status: "not_applicable",
            tickets: [],
            failureCode: "SUPPLIER_ERROR",
            pollAfterSeconds: null,
          }),
        ],
      }),
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(title()).toBe("Your booking did not go through");
    expect(text($("[data-status-text]"))).toBe("You have not been charged.");
    expect($("[data-search-link]").hidden).toBe(false);
    expect($("[data-trip-block]").hidden).toBe(true);
    expect($("[data-guest-block]").hidden).toBe(true);
    expect($("[data-reference-block]").hidden).toBe(true);
    expect($("[data-booking-links]").hidden).toBe(true);
    expect(address()).toBe(`/confirmation.html?booking=${BOOKING_ID}`);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(2);
  });

  it("[OFE-013] pending=1 for a booking decided already shows its state and leaves the address", async () => {
    const { client } = await openConfirmation({ query: `booking=${BOOKING_ID}&pending=1` });
    expect(title()).toBe("Your tickets are issued");
    expect(address()).toBe(`/confirmation.html?booking=${BOOKING_ID}`);
    expect(client.bookings.get).toHaveBeenCalledTimes(1);
  });

  it("[OFE-013] a booking decided between its two first answers is read again", async () => {
    const { client } = await openConfirmation({
      query: `booking=${BOOKING_ID}&pending=1`,
      fake: fakeApi({ bookings: [pendingBooking(), booking()], statuses: [ticketing()] }),
    });
    expect(client.bookings.get).toHaveBeenCalledTimes(2);
    expect(title()).toBe("Your tickets are issued");
    expect(text($("[data-airline-references]"))).toBe("Airline reference for online check-in: AF XYZ789");
    expect(address()).toBe(`/confirmation.html?booking=${BOOKING_ID}`);
  });

  it("[OFE-013] a pending booking is polled for 30 minutes, then the page offers 'Check again'", async () => {
    const { client } = await openConfirmation({
      fake: fakeApi({ bookings: [pendingBooking()], statuses: [pendingStatus()] }),
    });
    expect(title()).toBe("We are confirming your booking with the airline");

    await vi.advanceTimersByTimeAsync(PENDING_POLL_LIMIT_MS);
    // The first read, then one every 10 s for 30 minutes.
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(181);
    expect($("[data-status-still-pending]").hidden).toBe(false);
    expect($("[data-status-progress]").hidden).toBe(true);
    expect(text($("[data-status-still-pending-text]"))).toBe(
      "We are still confirming your booking. We will e-mail you as soon as it is decided, or check again now.",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(181);

    client.bookings.getTicketingStatus.mockResolvedValue(
      ticketing({ bookingStatus: "confirmed", status: "issued", pollAfterSeconds: null }),
    );
    $("button[data-check-again]").click();
    expect(document.activeElement).toBe($("[data-confirmation-title]"));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(182);
    expect(title()).toBe("Your tickets are issued");
    expect($("[data-status-still-pending]").hidden).toBe(true);
  });
});

describe("confirmation page: guests and access", () => {
  it("[OFE-013] a guest booking: 'Save your reference' with the lookup link and 'Create an account'", async () => {
    await openConfirmation();

    expect($("[data-guest-block]").hidden).toBe(false);
    expect(text($("[data-guest-block] h2"))).toBe("Save your reference");
    expect($("a[data-lookup-link]").getAttribute("href")).toBe("/lookup.html");
    expect($("[data-create-account]").hidden).toBe(false);
    expect($("a[data-create-account-link]").getAttribute("href")).toBe("/account/sign-up.html");
  });

  it("[OFE-013] no 'Create an account' for a signed-in customer or without customer accounts; no guest block for a customer", async () => {
    const signedIn = await openConfirmation({ session: SESSION });
    expect($("[data-guest-block]").hidden).toBe(false);
    expect($("[data-create-account]").hidden).toBe(true);
    signedIn.view.destroy();

    const noAccounts = await openConfirmation({ config: NO_ACCOUNTS_CONFIG });
    expect($("[data-create-account]").hidden).toBe(true);
    noAccounts.view.destroy();

    await openConfirmation({
      fake: fakeApi({ bookings: [booking({ isGuest: false, customerId: "cus_01JCONFIRMCUSTOMER1" })] }),
      session: SESSION,
    });
    expect($("[data-guest-block]").hidden).toBe(true);
  });

  it("[OFE-013] 401 (no session and no guest cookie) links to the lookup page", async () => {
    const { client } = await openConfirmation({
      fake: fakeApi({
        bookings: [apiError(AuthenticationError, "UNAUTHENTICATED", 401)],
        statuses: [apiError(AuthenticationError, "UNAUTHENTICATED", 401)],
      }),
    });

    expect(stateTitle()).toBe("Find your booking with its reference");
    expect(stateLinks()).toEqual([
      ["Find your booking", "/lookup.html"],
      [
        "Sign in",
        `/account/sign-in.html?next=${encodeURIComponent(`/confirmation.html?booking=${BOOKING_ID}`)}`,
      ],
    ]);
    expect($("[data-confirmation-content]").hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(1);
  });

  it("[OFE-013] without customer accounts, 401 offers the lookup page only", async () => {
    await openConfirmation({
      config: NO_ACCOUNTS_CONFIG,
      fake: fakeApi({ bookings: [apiError(AuthenticationError, "UNAUTHENTICATED", 401)] }),
    });
    expect(stateLinks()).toEqual([["Find your booking", "/lookup.html"]]);
  });

  it("[OFE-013] an unknown booking or an address without a valid id is not found", async () => {
    const bad = await openConfirmation({ query: "booking=bkg_bad" });
    expect(stateTitle()).toBe("We could not find this booking");
    expect(stateLinks()).toEqual([["Find your booking", "/lookup.html"]]);
    expect(bad.client.bookings.get).not.toHaveBeenCalled();
    bad.view.destroy();

    await openConfirmation({ fake: fakeApi({ bookings: [apiError(NotFoundError, "NOT_FOUND", 404)] }) });
    expect(stateTitle()).toBe("We could not find this booking");
  });
});

describe("confirmation page: failures", () => {
  it("[OFE-013] a booking that cannot be loaded offers Retry", async () => {
    const { client } = await openConfirmation({
      fake: fakeApi({ bookings: [apiError(ServerError, "SERVICE_UNAVAILABLE", 503), booking()] }),
    });

    expect(stateTitle()).toBe(
      "The service is not available right now. Nothing is lost: try again in a moment.",
    );
    /** @type {HTMLButtonElement} */ ($('[data-confirmation-state] [data-action="retry"]')).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.bookings.get).toHaveBeenCalledTimes(2);
    expect(title()).toBe("Your tickets are issued");
    expect($("[data-confirmation-state]").children).toHaveLength(0);
  });

  it("[OFE-013] a failed poll keeps the state and tries again; after an airline error without a refresh once", async () => {
    const { client } = await openConfirmation({
      fake: fakeApi({
        bookings: [pendingBooking()],
        statuses: [
          pendingStatus(),
          apiError(ConnectionError, "NETWORK_ERROR", 0),
          apiError(SupplierError, "SUPPLIER_UNAVAILABLE", 503),
          pendingStatus(),
          apiError(RateLimitError, "RATE_LIMITED", 429, { details: { retryAfterSeconds: 30 } }),
          ticketing(),
        ],
      }),
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(2);
    expect(title()).toBe("We are confirming your booking with the airline");
    expect($("[data-confirmation-state]").children).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(4);
    const refreshes = client.bookings.getTicketingStatus.mock.calls.map(
      (call) => /** @type {{ refresh: boolean }} */ (call[0]).refresh,
    );
    expect(refreshes).toEqual([true, true, true, false]);

    // 429: the next poll waits for Retry-After.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(6);
    expect(client.bookings.getTicketingStatus).toHaveBeenLastCalledWith(
      { bookingId: BOOKING_ID, refresh: true },
      expect.anything(),
    );
    expect(title()).toBe("Your tickets are issued");
  });

  it("[OFE-013] a first ticketing call that fails shows the booking's own state and polls again", async () => {
    const { client } = await openConfirmation({
      query: `booking=${BOOKING_ID}&pending=1`,
      fake: fakeApi({
        bookings: [pendingBooking(), booking()],
        statuses: [apiError(ServerError, "SERVICE_UNAVAILABLE", 503), ticketing()],
      }),
    });

    expect(title()).toBe("We are confirming your booking with the airline");
    expect($("[data-status-progress]").hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(2);
    expect(title()).toBe("Your tickets are issued");
    expect(address()).toBe(`/confirmation.html?booking=${BOOKING_ID}`);
  });

  it("[OFE-013] a poll the API refuses for good stops polling and keeps the booking on the screen", async () => {
    const { client } = await openConfirmation({
      fake: fakeApi({
        bookings: [pendingBooking()],
        statuses: [pendingStatus(), apiError(AuthenticationError, "UNAUTHENTICATED", 401)],
      }),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(2);
    expect(title()).toBe("We are confirming your booking with the airline");
    expect($("[data-status-progress]").hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(2);
  });
});
