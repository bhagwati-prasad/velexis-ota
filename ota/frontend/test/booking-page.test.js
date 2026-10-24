// The booking page (ota/frontend/docs/pages-account.md §1 and §3, flows ota/docs/flows/change-and-cancel.md and
// ota/docs/flows/my-bookings-and-guest-lookup.md §3 steps 5 and 8): booking.html with its partials expanded by the
// build's include plugin, run by src/pages/booking.js against a fake SDK. It covers the booking (trip, travellers,
// tickets, contact, payment, the cancellation block), the controls of `allowedActions` exactly, documents whose
// download URL is asked on each click, the timeline, the fare rules, the contact change (`ifMatch`, `409
// VERSION_CONFLICT` reloaded with `refresh: true`, `412`, field errors), the cancellation dialog (quote, confirm with a
// stable idempotency key, `409 REFUND_AMOUNT_CHANGED` asked again, `request_only`, `not_allowed`, `504`), the ticketing
// polled while open (fake timers), "Refresh from airline", and `401` / `404`.
import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
  ServerError,
  SupplierError,
  ValidationError,
  VelexisError,
} from "@velexis/ota-sdk";
import { Browser } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { includePartials } from "../scripts/vite-plugins.js";
import { cancellationKey } from "../src/components/cancel-dialog.js";
import { formatMoney } from "../src/lib/format.js";
import { ACTION_CONTROLS, contactsUpdate, downloadTarget, start } from "../src/pages/booking.js";
import { STOREFRONT_ROOT } from "./helpers/storefront.js";

/** The mocked boot() of the page module never resolves here (the static import above). */
vi.mock("../src/boot.js", async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  return { ...actual, boot: () => new Promise(() => {}) };
});

const BOOKING_ID = "bkg_01JBOOKINGPAGE00001";
const PAGE = "booking.html";
const EMAIL = "ada.lovelace@example.test";

/** @param {string} amount */
const eur = (amount) => ({ amount, currency: "EUR" });
/** @param {string} amount */
const money = (amount) => formatMoney(eur(amount), "en-GB");

const CONFIG = Object.freeze({
  name: "Demo Travel",
  defaultLocale: "en-GB",
  timeZone: "Europe/London",
  support: { email: "help@demo-travel.example", phone: null, hours: null, helpCenterUrl: null },
  features: { ancillaries: true, guestCheckout: true, customerAccounts: true },
});
/** A signed-in customer. */
const SESSION = Object.freeze({ customer: { id: "cus_01JBOOKINGPAGECUST1", firstName: "Ada" } });

/**
 * The allowed actions of a live booking far from departure: everything the MVP offers.
 * @param {Record<string, unknown>} [overrides]
 */
function actions(overrides = {}) {
  return {
    canCancel: true,
    canModifyContacts: true,
    canModifyTravelerDocuments: false,
    canModifyLoyaltyPrograms: false,
    canAddRemarks: true,
    canDownloadDocuments: true,
    canRefresh: true,
    canAddAncillaries: false,
    reasons: {
      canModifyTravelerDocuments: "disabled_by_ota",
      canModifyLoyaltyPrograms: "disabled_by_ota",
      canAddAncillaries: "disabled_by_ota",
    },
    ...overrides,
  };
}

/**
 * A customer's ticketed booking of a one-way Paris–New York flight for two travellers.
 * @param {Record<string, unknown>} [overrides]
 */
function booking(overrides = {}) {
  return {
    id: BOOKING_ID,
    reference: "VX7K2Q",
    status: "ticketed",
    channel: "storefront",
    customerId: SESSION.customer.id,
    isGuest: false,
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
            cabin: "ECONOMY",
            status: "CONFIRMED",
            isFlown: false,
            scheduleChanged: false,
          },
        ],
      },
    ],
    travelers: [
      {
        id: "btr_01JBOOKINGPAGETRAV1",
        travelerId: "1",
        travelerType: "ADULT",
        name: { firstName: "ADA", lastName: "LOVELACE" },
      },
      {
        id: "btr_01JBOOKINGPAGETRAV2",
        travelerId: "2",
        travelerType: "ADULT",
        name: { firstName: "ALAN", lastName: "TURING" },
      },
    ],
    contacts: [
      {
        id: "bco_01JBOOKINGPAGECONT1",
        purpose: "STANDARD",
        isPrimary: true,
        addresseeName: { firstName: "ADA", lastName: "LOVELACE" },
        companyName: null,
        emailAddress: EMAIL,
        phones: [{ deviceType: "MOBILE", countryCallingCode: "44", number: "7700900123" }],
        address: null,
        language: "en",
      },
      {
        id: "bco_01JBOOKINGPAGECONT2",
        purpose: "INVOICE",
        isPrimary: false,
        addresseeName: null,
        companyName: "Analytical Engines Ltd",
        emailAddress: null,
        phones: [],
        address: { lines: ["1 Main Street"], postalCode: "N1 9GU", cityName: "London", countryCode: "GB" },
        language: null,
      },
    ],
    ancillaries: [],
    tickets: [
      {
        id: "tkt_01JBOOKINGPAGETICK1",
        documentType: "ETICKET",
        documentNumber: "057-2412345678",
        status: "ISSUED",
        travelerId: "1",
        segmentIds: ["1"],
        issuedAt: "2026-10-23T10:00:00Z",
      },
      {
        id: "tkt_01JBOOKINGPAGETICK2",
        documentType: "ETICKET",
        documentNumber: "057-2412345679",
        status: "ISSUED",
        travelerId: "2",
        segmentIds: ["1"],
        issuedAt: "2026-10-23T10:00:00Z",
      },
    ],
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
    allowedActions: actions(),
    cancellation: null,
    lastSyncedAt: "2026-10-23T10:00:00Z",
    syncStatus: "fresh",
    version: 3,
    createdAt: "2026-10-23T09:55:00Z",
    updatedAt: "2026-10-23T10:00:00Z",
    ...overrides,
  };
}

/**
 * A `Page` of the SDK: `data`, `page.nextCursor` and `next()` (the following pages in turn).
 * @param {unknown[][]} pages
 */
function pageOf(pages, index = 0) {
  const data = pages[index] ?? [];
  const last = index >= pages.length - 1;
  return {
    data,
    page: { nextCursor: last ? null : `cur_${index + 1}`, limit: 20 },
    next: vi.fn(async () => (last ? null : pageOf(pages, index + 1))),
  };
}

const DOCUMENTS = Object.freeze([
  {
    id: "doc_01JBOOKINGPAGEDOCU1",
    bookingId: BOOKING_ID,
    kind: "e_ticket_receipt",
    status: "ready",
    locale: "en",
    fileName: "e-ticket-0572412345678.pdf",
    contentType: "application/pdf",
    createdAt: "2026-10-23T10:01:00Z",
  },
  {
    id: "doc_01JBOOKINGPAGEDOCU2",
    bookingId: BOOKING_ID,
    kind: "itinerary",
    status: "pending",
    locale: "en",
    fileName: "itinerary-VX7K2Q.pdf",
    contentType: "application/pdf",
    createdAt: "2026-10-23T10:02:00Z",
  },
  {
    id: "doc_01JBOOKINGPAGEDOCU3",
    bookingId: BOOKING_ID,
    kind: "itinerary",
    status: "superseded",
    locale: "en",
    fileName: "itinerary-VX7K2Q-old.pdf",
    contentType: "application/pdf",
    createdAt: "2026-10-23T09:59:00Z",
  },
]);

/**
 * A timeline event.
 * @param {number} n
 * @param {string} summary
 */
const event = (n, summary) => ({
  id: `evt_01JBOOKINGPAGEEVNT${n}`,
  bookingId: BOOKING_ID,
  type: "booking.ticketed",
  actorType: "system",
  summary,
  createdAt: `2026-10-23T10:0${n}:00Z`,
});

/**
 * A cancellation quote.
 * @param {Record<string, unknown>} [overrides]
 */
function quote(overrides = {}) {
  return {
    bookingId: BOOKING_ID,
    cancellable: true,
    mode: "release",
    notAllowedReason: null,
    currency: "EUR",
    amountPaid: eur("420.55"),
    estimatedRefund: eur("400.00"),
    penalty: eur("0.00"),
    otaFee: eur("20.55"),
    voidDeadlineAt: null,
    lines: [
      {
        travelerId: "1",
        travelerName: "ADA LOVELACE",
        paid: eur("210.28"),
        refund: eur("200.00"),
        penalty: eur("0.00"),
      },
      {
        travelerId: "2",
        travelerName: "ALAN TURING",
        paid: eur("210.27"),
        refund: eur("200.00"),
        penalty: eur("0.00"),
      },
    ],
    expiresAt: "2026-10-24T10:10:00Z",
    source: "policy",
    ...overrides,
  };
}

/**
 * A booking cancelled by its customer, with the refund of its captured payment made.
 * @param {Record<string, unknown>} [cancellation]
 */
function cancelledBooking(cancellation = {}) {
  return booking({
    status: "cancelled",
    version: 4,
    cancelledAt: "2026-10-24T09:00:00Z",
    allowedActions: actions({
      canCancel: false,
      canModifyContacts: false,
      canAddRemarks: false,
      canRefresh: false,
      reasons: { canCancel: "cancelled", canModifyContacts: "cancelled", canRefresh: "cancelled" },
    }),
    cancellation: {
      bookingId: BOOKING_ID,
      status: "cancelled",
      requestedAt: "2026-10-24T09:00:00Z",
      cancelledAt: "2026-10-24T09:00:00Z",
      cancelledBy: "customer",
      reasonCode: "change_of_plans",
      comment: null,
      ticketsVoided: false,
      estimatedRefund: eur("400.00"),
      refund: {
        id: "rfd_01JBOOKINGPAGEREFUN",
        paymentId: "pay_01JBOOKINGPAGEPAYMT",
        bookingId: BOOKING_ID,
        amount: eur("400.00"),
        reason: "customer_request",
        status: "pending",
        createdAt: "2026-10-24T09:00:00Z",
      },
      refundStatus: "pending",
      ...cancellation,
    },
  });
}

/**
 * A ticketing status.
 * @param {Record<string, unknown>} [overrides]
 */
const ticketing = (overrides = {}) => ({
  bookingId: BOOKING_ID,
  bookingStatus: "ticketed",
  status: "issued",
  policy: "issue_at_booking",
  deadlineAt: null,
  attempts: 1,
  tickets: [],
  pollAfterSeconds: null,
  ...overrides,
});

/** @param {Function} ErrorClass @param {string} code @param {number} status @param {Record<string, unknown>} [body] */
const apiError = (ErrorClass, code, status, body = {}) =>
  new ErrorClass({ code, message: `${code} from the fake API`, status, requestId: "req_booking", ...body });

/**
 * A fake API: each method answers its list in turn (the last one again and again; an Error is thrown).
 * @param {Partial<Record<"get" | "listDocuments" | "listEvents" | "getTicketingStatus" | "getFareRules" | "quoteCancellation" | "cancel" | "update" | "getDocumentDownloadUrl", unknown[]>>} [answers]
 */
function fakeApi(answers = {}) {
  /** @param {unknown[]} list */
  const inTurn = (list) => {
    let calls = 0;
    return vi.fn(async () => {
      const answer = list[Math.min(calls, list.length - 1)];
      calls += 1;
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    });
  };
  const defaults = {
    get: [booking()],
    listDocuments: [pageOf([DOCUMENTS])],
    listEvents: [
      pageOf([[event(2, "Tickets issued"), event(1, "Booking confirmed")], [event(0, "Booking created")]]),
    ],
    getTicketingStatus: [ticketing()],
    getFareRules: [
      {
        bookingId: BOOKING_ID,
        currency: "EUR",
        available: true,
        types: ["rebooks", "refunds"],
        summary: {
          refundable: true,
          changeable: false,
          refundPenalty: eur("50.00"),
          changePenalty: null,
          source: "fare_rules",
        },
        rules: [
          {
            flightOfferId: "1",
            category: "REFUND",
            applicable: true,
            chargeable: true,
            maxPenalty: eur("50.00"),
            texts: [],
          },
        ],
        loadedAt: "2026-10-24T09:00:00Z",
      },
    ],
    quoteCancellation: [quote()],
    cancel: [{ cancellation: cancelledBooking().cancellation, booking: cancelledBooking() }],
    update: [booking({ version: 4 })],
    getDocumentDownloadUrl: [
      {
        documentId: "doc_01JBOOKINGPAGEDOCU1",
        url: "/api/v1/files/doc_01JBOOKINGPAGEDOCU1?exp=1&sig=abc",
        expiresAt: "2026-10-24T10:05:00Z",
        fileName: "e-ticket-0572412345678.pdf",
        contentType: "application/pdf",
      },
    ],
  };
  const bookings = Object.fromEntries(
    Object.entries({ ...defaults, ...answers }).map(([name, list]) => [
      name,
      inTurn(/** @type {unknown[]} */ (list)),
    ]),
  );
  return { client: { bookings } };
}

/** @type {Browser | undefined} */
let browser;
/** @type {Document | undefined} */
let pageDocument;
const original = { address: "", title: "" };
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

/** @param {string} path */
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

/** Waits until queued promise callbacks have run (the fake SDK answers at once). */
const settle = async () => {
  for (let i = 0; i < 200; i += 1) {
    await Promise.resolve();
  }
};

const text = (/** @type {Element | null | undefined} */ element) =>
  element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const $ = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (document.querySelector(selector));
const items = (/** @type {string} */ selector) =>
  Array.from(document.querySelectorAll(`${selector} > li`), (item) => text(item));
const action = (/** @type {string} */ name) =>
  /** @type {HTMLButtonElement} */ ($(`[data-booking-page] button[data-action="${name}"]`));
const stateTitle = () => text($('[data-booking-state] [data-field="title"]'));
const stateLinks = () =>
  Array.from(document.querySelectorAll("[data-booking-state] a[data-state-link]"), (link) => [
    text(link),
    link.getAttribute("href"),
  ]);
const contactsDialog = () => /** @type {HTMLDialogElement} */ ($("dialog[data-contacts-dialog]"));
const cancelDialog = () => /** @type {HTMLDialogElement} */ ($("dialog[data-cancel-dialog]"));
const field = (/** @type {string} */ name) => /** @type {HTMLInputElement} */ ($(`[name="${name}"]`));

/**
 * Opens the booking page at `/booking.html?<query>` with a fake SDK and lets the first load settle.
 * @param {{ query?: string, fake?: ReturnType<typeof fakeApi>, config?: object, session?: object | null, now?: () => number }} [options]
 */
async function openBooking({
  query = `id=${BOOKING_ID}`,
  fake = fakeApi(),
  config = CONFIG,
  session = SESSION,
  now,
} = {}) {
  showPage(`/booking.html?${query}`);
  const navigate = vi.fn();
  const view = start(
    {
      config: /** @type {never} */ (config),
      client: /** @type {never} */ (fake.client),
      session: /** @type {never} */ (session),
    },
    { navigate, ...(now ? { now } : {}) },
  );
  if (!view) {
    throw new Error("the booking page did not start");
  }
  views.push(view);
  await view.done;
  await settle();
  return { view, navigate, ...fake };
}

/** Opens the cancellation dialog and lets the quote arrive. */
async function openCancel() {
  action("cancel").click();
  await settle();
}

/** Chooses a reason and confirms the cancellation. */
async function confirmCancel(reason = "change_of_plans", comment = "") {
  const form = /** @type {HTMLFormElement} */ ($("form[data-cancel-form]"));
  /** @type {HTMLSelectElement} */ (form.querySelector('select[name="reasonCode"]')).value = reason;
  /** @type {HTMLTextAreaElement} */ (form.querySelector('textarea[name="comment"]')).value = comment;
  form.requestSubmit(/** @type {HTMLButtonElement} */ (form.querySelector('button[type="submit"]')));
  await settle();
}

/** Submits the contacts dialog. */
async function saveContacts() {
  const form = /** @type {HTMLFormElement} */ ($("form[data-contacts-form]"));
  form.requestSubmit(/** @type {HTMLButtonElement} */ (form.querySelector('button[type="submit"]')));
  await settle();
}

describe("booking page: the booking", () => {
  it("[OFE-015] shows the trip, travellers with their tickets, contact, payment, documents and history", async () => {
    const { client } = await openBooking();

    expect(client.bookings.get).toHaveBeenCalledWith(
      { bookingId: BOOKING_ID },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(text($("[data-booking-title]"))).toBe("Booking VX7K2Q");
    expect(document.title).toBe("Booking VX7K2Q");
    expect(text($("[data-booking-status]"))).toBe("Ticketed");
    expect($("[data-booking-status]").dataset["status"]).toBe("ticketed");
    expect(text($("[data-booking-reference]"))).toBe("VX7K2Q");
    expect(text($("[data-airline-references]"))).toBe("Airline reference for online check-in: AF XYZ789");
    expect($("[data-back-link]").hidden).toBe(false);
    expect($("[data-booking-banner]").hidden).toBe(true);
    expect($("[data-cancellation-block]").hidden).toBe(true);

    expect(text($("[data-itineraries]"))).toContain("Air France (AF) · AF6");
    expect(text($("[data-itineraries] [data-booking-segment]"))).toContain("CDG");
    expect(items("[data-travellers]")).toEqual([
      "ADA LOVELACE, Adult E-ticket 057-2412345678",
      "ALAN TURING, Adult E-ticket 057-2412345679",
    ]);
    expect(items("[data-contact]")).toEqual(["ADA LOVELACE", EMAIL, "+44 7700900123"]);
    expect(text($("[data-total]"))).toBe(money("420.55"));
    expect(text($("[data-paid]"))).toBe(money("420.55"));
    expect(text($("[data-card-fee]"))).toBe(money("8.25"));
    expect($("[data-refunded-line]").hidden).toBe(true);

    expect(client.bookings.listDocuments).toHaveBeenCalledWith(
      { bookingId: BOOKING_ID, limit: 20 },
      expect.anything(),
    );
    const rows = Array.from(document.querySelectorAll("[data-document-row]"));
    // The ready e-ticket receipt and the itinerary being prepared; a superseded one is not shown.
    expect(rows).toHaveLength(2);
    expect(text(rows[0]?.querySelector('[data-field="kind"]'))).toBe("E-ticket receipt");
    const downloadHidden = (/** @type {Element | undefined} */ row) =>
      row?.querySelector('[data-action="download"]')?.hasAttribute("hidden");
    expect(downloadHidden(rows[0])).toBe(false);
    expect(downloadHidden(rows[1])).toBe(true);
    expect(text(rows[1]?.querySelector('[data-field="status"]'))).toBe("Being prepared");

    expect(client.bookings.listEvents).toHaveBeenCalledWith(
      { bookingId: BOOKING_ID, limit: 20 },
      expect.anything(),
    );
    expect(Array.from(document.querySelectorAll("[data-timeline-event] [data-field=summary]"), text)).toEqual(
      ["Tickets issued", "Booking confirmed"],
    );
    expect(client.bookings.getTicketingStatus).not.toHaveBeenCalled();
    expect(client.bookings.getFareRules).not.toHaveBeenCalled();
  });

  it("[OFE-015] the timeline shows earlier events on request and the fare rules load when first opened", async () => {
    const { client } = await openBooking();

    /** @type {HTMLButtonElement} */ ($("button[data-timeline-more]")).click();
    await settle();
    expect(Array.from(document.querySelectorAll("[data-timeline-event] [data-field=summary]"), text)).toEqual(
      ["Tickets issued", "Booking confirmed", "Booking created"],
    );
    expect($("button[data-timeline-more]").hidden).toBe(true);

    const rules = /** @type {HTMLDetailsElement} */ ($("details[data-fare-rules]"));
    rules.open = true;
    rules.dispatchEvent(new Event("toggle"));
    await settle();
    rules.open = false;
    rules.dispatchEvent(new Event("toggle"));
    rules.open = true;
    rules.dispatchEvent(new Event("toggle"));
    await settle();
    expect(client.bookings.getFareRules).toHaveBeenCalledTimes(1);
    expect(items("[data-rules-summary]")).toEqual([
      `Refund: Allowed for a fee of up to ${money("50.00")} per traveller`,
      "Change: Not allowed",
    ]);
    expect(items("[data-rules-categories]")).toEqual([
      `Refund: Allowed for a fee of up to ${money("50.00")}`,
    ]);
  });

  it("[OFE-015] a cancelled booking shows its cancellation and refund; a requested one says so in its status", async () => {
    const cancelled = await openBooking({ fake: fakeApi({ get: [cancelledBooking()] }) });
    expect(text($("[data-booking-status]"))).toBe("Cancelled");
    expect($("[data-cancellation-block]").hidden).toBe(false);
    expect(text($("[data-cancellation-title]"))).toBe("This booking is cancelled");
    expect(text($("[data-cancellation-refund]"))).toBe(`Your refund of ${money("400.00")} is on its way.`);
    expect($("[data-actions]").hidden).toBe(true);
    cancelled.view.destroy();

    const voided = await openBooking({
      fake: fakeApi({ get: [cancelledBooking({ refund: null, refundStatus: "authorization_voided" })] }),
    });
    expect(text($("[data-cancellation-refund]"))).toBe("The amount reserved on your card is released.");
    voided.view.destroy();

    await openBooking({
      fake: fakeApi({
        get: [
          booking({
            allowedActions: actions({ canCancel: false, reasons: { canCancel: "pending" } }),
            cancellation: {
              ...cancelledBooking().cancellation,
              status: "pending",
              cancelledAt: null,
              refund: null,
              refundStatus: "manual_review",
            },
          }),
        ],
      }),
    });
    expect(text($("[data-booking-status]"))).toBe("Cancellation requested");
    expect(text($("[data-cancellation-title]"))).toBe("Cancellation requested");
    expect(text($("[data-cancellation-refund]"))).toBe(`Estimated refund: ${money("400.00")}.`);
    expect(action("cancel").hidden).toBe(true);
    expect($("[data-cancel-unavailable]").hidden).toBe(true);
  });
});

describe("booking page: allowed actions", () => {
  it("[OFE-015 AC1] every control follows allowedActions exactly", async () => {
    const flags = /** @type {const} */ ([
      "canModifyContacts",
      "canCancel",
      "canRefresh",
      "canDownloadDocuments",
    ]);
    // Every combination of the four actions the page offers, with the ones the MVP does not offer switched on too.
    for (let mask = 0; mask < 1 << flags.length; mask += 1) {
      const allowed = Object.fromEntries(flags.map((flag, bit) => [flag, (mask & (1 << bit)) !== 0]));
      const fake = fakeApi({
        get: [
          booking({
            allowedActions: actions({
              ...allowed,
              canAddRemarks: true,
              canModifyTravelerDocuments: true,
              canModifyLoyaltyPrograms: true,
              canAddAncillaries: true,
              reasons: allowed["canDownloadDocuments"] ? {} : { canDownloadDocuments: "pending" },
            }),
          }),
        ],
      });
      const { view, client } = await openBooking({ fake });
      const shown = {
        canModifyContacts: !action(ACTION_CONTROLS.canModifyContacts).hidden,
        canCancel: !action(ACTION_CONTROLS.canCancel).hidden,
        canRefresh: !action(ACTION_CONTROLS.canRefresh).hidden,
        canDownloadDocuments: document.querySelectorAll('[data-action="download"]:not([hidden])').length > 0,
      };
      expect(shown, JSON.stringify(allowed)).toEqual(allowed);
      expect(client.bookings.listDocuments).toHaveBeenCalledTimes(allowed["canDownloadDocuments"] ? 1 : 0);
      // No control for the actions the MVP does not offer, whatever they say.
      const controls = Array.from(
        document.querySelectorAll("[data-booking-content] button[data-action]"),
        (control) => control.getAttribute("data-action"),
      );
      expect(new Set(controls)).toEqual(
        new Set([
          "refresh",
          "change-contacts",
          "cancel",
          ...(allowed["canDownloadDocuments"] ? ["download"] : []),
        ]),
      );
      view.destroy();
    }
  });

  it("[OFE-015] without documents yet, the page says why; a booking that can no longer be cancelled online names the support", async () => {
    await openBooking({
      fake: fakeApi({
        get: [
          booking({
            status: "confirmed",
            tickets: [],
            ticketing: { status: "failed", policy: "issue_at_booking", deadlineAt: null },
            allowedActions: actions({
              canCancel: false,
              canDownloadDocuments: false,
              reasons: { canCancel: "too_close_to_departure", canDownloadDocuments: "not_ticketed" },
            }),
          }),
        ],
      }),
    });
    expect(text($("[data-documents-note]"))).toBe("Your documents appear here once your tickets are issued.");
    expect($("[data-cancel-unavailable]").hidden).toBe(false);
    expect(text($("[data-cancel-unavailable]"))).toBe(
      "This booking can no longer be cancelled online. If you need to cancel it, please contact us at help@demo-travel.example.",
    );
    expect($("a[data-support-link]").getAttribute("href")).toBe("mailto:help@demo-travel.example");
    // Ticketing failed and is retried: the banner says the tickets follow.
    expect(text($("[data-booking-banner]"))).toBe("Tickets are being issued; we will e-mail you");
  });
});

describe("booking page: documents", () => {
  it("[OFE-015 AC3] a download URL is asked on each click, never before, and the browser goes there", async () => {
    const { client, navigate } = await openBooking();
    expect(client.bookings.getDocumentDownloadUrl).not.toHaveBeenCalled();
    expect(document.querySelector('[data-document-row] a[href*="/files/"]')).toBeNull();

    const download = /** @type {HTMLButtonElement} */ ($('[data-document-row] [data-action="download"]'));
    expect(download.getAttribute("aria-label")).toBe("Download E-ticket receipt, e-ticket-0572412345678.pdf");
    download.click();
    await settle();
    download.click();
    await settle();
    expect(client.bookings.getDocumentDownloadUrl).toHaveBeenCalledTimes(2);
    expect(client.bookings.getDocumentDownloadUrl).toHaveBeenCalledWith(
      { bookingId: BOOKING_ID, documentId: "doc_01JBOOKINGPAGEDOCU1" },
      expect.anything(),
    );
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenLastCalledWith("/api/v1/files/doc_01JBOOKINGPAGEDOCU1?exp=1&sig=abc");
  });

  it("[OFE-015] the confirmation page's documents link (#documents) focuses the section once it is loaded", async () => {
    await openBooking({ query: `id=${BOOKING_ID}#documents` });
    expect(document.activeElement).toBe($("#documents"));
    expect(document.querySelectorAll("[data-document-row]")).toHaveLength(2);
  });

  it("[OFE-015] 409 DOCUMENT_NOT_READY says to try again in a minute; a URL off the storefront is never followed", async () => {
    const { navigate } = await openBooking({
      fake: fakeApi({
        getDocumentDownloadUrl: [
          apiError(ConflictError, "DOCUMENT_NOT_READY", 409, { details: { retryAfterSeconds: 30 } }),
          {
            documentId: "doc_01JBOOKINGPAGEDOCU1",
            url: "https://evil.example/file.pdf",
            expiresAt: "",
            fileName: "",
            contentType: "",
          },
        ],
      }),
    });
    const download = /** @type {HTMLButtonElement} */ ($('[data-document-row] [data-action="download"]'));
    download.click();
    await settle();
    const message = /** @type {HTMLElement} */ ($("[data-document-row] [data-document-message]"));
    expect(message.hidden).toBe(false);
    expect(text(message)).toBe("The document is being prepared, try again in a minute");

    const reported = vi.fn();
    vi.stubGlobal("reportError", reported);
    try {
      download.click();
      await settle();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(navigate).not.toHaveBeenCalled();
    expect(text(message)).toBe("Something went wrong. Please try again.");
    expect(reported).toHaveBeenCalledTimes(1);

    expect(downloadTarget("/api/v1/files/doc_x?sig=1", location)).toBe("/api/v1/files/doc_x?sig=1");
    expect(downloadTarget(`${location.origin}/api/v1/files/doc_x?sig=1`, location)).toBe(
      "/api/v1/files/doc_x?sig=1",
    );
    expect(downloadTarget("//evil.example/x", location)).toBeNull();
    expect(downloadTarget("javascript:alert(1)", location)).toBeNull();
  });
});

describe("booking page: contact details", () => {
  it("[OFE-015] the dialog sends the whole contacts list with ifMatch, then shows the new booking", async () => {
    const { client } = await openBooking();
    action("change-contacts").click();
    expect(contactsDialog().open).toBe(true);
    expect(field("contacts.0.emailAddress").value).toBe(EMAIL);
    expect(field("contacts.0.phones.0.countryCallingCode").value).toBe("44");

    field("contacts.0.emailAddress").value = "ada@new.example";
    field("contacts.0.phones.0.number").value = "07700 900 999";
    await saveContacts();

    expect(client.bookings.update).toHaveBeenCalledTimes(1);
    expect(client.bookings.update).toHaveBeenCalledWith(
      {
        bookingId: BOOKING_ID,
        ifMatch: 3,
        contacts: [
          {
            purpose: "STANDARD",
            isPrimary: true,
            addresseeName: { firstName: "ADA", lastName: "LOVELACE" },
            emailAddress: "ada@new.example",
            phones: [{ deviceType: "MOBILE", countryCallingCode: "44", number: "07700900999" }],
            language: "en",
          },
          {
            purpose: "INVOICE",
            isPrimary: false,
            companyName: "Analytical Engines Ltd",
            phones: [],
            address: {
              lines: ["1 Main Street"],
              postalCode: "N1 9GU",
              cityName: "London",
              countryCode: "GB",
            },
          },
        ],
      },
      expect.anything(),
    );
    expect(contactsDialog().open).toBe(false);
    expect(text($('[data-booking-notice] [data-notice="success"]'))).toBe(
      `Your contact details are updated. We have sent a confirmation to ${EMAIL}.`,
    );

    // The next change uses the new version.
    action("change-contacts").click();
    await saveContacts();
    expect(client.bookings.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ ifMatch: 4 }),
      expect.anything(),
    );
  });

  it("[OFE-015] 409 VERSION_CONFLICT reloads the booking from the airline and keeps what was typed; 412 reloads it", async () => {
    const { client } = await openBooking({
      fake: fakeApi({
        get: [booking(), booking({ version: 5 }), booking({ version: 6 })],
        update: [
          apiError(ConflictError, "VERSION_CONFLICT", 409),
          apiError(VelexisError, "PRECONDITION_FAILED", 412),
          booking({ version: 7 }),
        ],
      }),
    });
    action("change-contacts").click();
    field("contacts.0.emailAddress").value = "ada@new.example";
    await saveContacts();

    expect(client.bookings.get).toHaveBeenLastCalledWith(
      { bookingId: BOOKING_ID, refresh: true },
      expect.anything(),
    );
    expect(contactsDialog().open).toBe(true);
    expect(field("contacts.0.emailAddress").value).toBe("ada@new.example");
    expect(text($('[data-contacts-state] [data-field="title"]'))).toBe(
      "This booking changed meanwhile. We loaded the latest version: check your changes and save again.",
    );

    await saveContacts();
    expect(client.bookings.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ ifMatch: 5 }),
      expect.anything(),
    );
    expect(client.bookings.get).toHaveBeenLastCalledWith({ bookingId: BOOKING_ID }, expect.anything());
    expect(contactsDialog().open).toBe(true);

    await saveContacts();
    expect(client.bookings.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ ifMatch: 6 }),
      expect.anything(),
    );
    expect(contactsDialog().open).toBe(false);
  });

  it("[OFE-015] 422 CONTACT_DATA_INVALID marks the field and focuses the summary", async () => {
    await openBooking({
      fake: fakeApi({
        update: [
          apiError(ValidationError, "CONTACT_DATA_INVALID", 422, {
            fieldErrors: [{ path: "/contacts/0/emailAddress", code: "EMAIL_INVALID", message: "invalid" }],
          }),
        ],
      }),
    });
    action("change-contacts").click();
    await saveContacts();
    expect(field("contacts.0.emailAddress").getAttribute("aria-invalid")).toBe("true");
    const summary = $("dialog[data-contacts-dialog] [data-error-summary]");
    expect(document.activeElement).toBe(summary);
    expect(text(summary)).toContain("Enter a valid e-mail address");
  });

  it("[OFE-015] 409 BOOKING_NOT_MODIFIABLE closes the dialog, reloads the booking and hides the change", async () => {
    const { client } = await openBooking({
      fake: fakeApi({
        get: [
          booking(),
          booking({
            version: 4,
            allowedActions: actions({ canModifyContacts: false, reasons: { canModifyContacts: "flown" } }),
          }),
        ],
        update: [apiError(ConflictError, "BOOKING_NOT_MODIFIABLE", 409, { details: { reason: "flown" } })],
      }),
    });
    action("change-contacts").click();
    await saveContacts();

    expect(contactsDialog().open).toBe(false);
    expect(client.bookings.get).toHaveBeenCalledTimes(2);
    expect(client.bookings.get).toHaveBeenLastCalledWith({ bookingId: BOOKING_ID }, expect.anything());
    expect(text($('[data-booking-notice] [data-field="title"]'))).toBe(
      "This booking can no longer be changed online",
    );
    expect($('[data-booking-notice] [data-action="retry"]')).toBeNull();
    expect(action("change-contacts").hidden).toBe(true);
  });

  it("[OFE-015] 504 SUPPLIER_TIMEOUT of a contact change shows the booking as recorded and says the airline has not confirmed", async () => {
    const { client } = await openBooking({
      fake: fakeApi({
        get: [booking(), booking({ version: 4 })],
        update: [apiError(SupplierError, "SUPPLIER_TIMEOUT", 504)],
      }),
    });
    action("change-contacts").click();
    await saveContacts();

    expect(client.bookings.update).toHaveBeenCalledTimes(1);
    expect(contactsDialog().open).toBe(false);
    expect(client.bookings.get).toHaveBeenCalledTimes(2);
    expect(text($('[data-booking-notice] [data-field="title"]'))).toBe(
      "The airline has not confirmed the change yet. The contact details on this page are what we know now; check again in a few minutes.",
    );
  });

  it("[OFE-015] the contacts update keeps the other contacts and drops a cleared phone", () => {
    const [primary, invoice] = contactsUpdate(/** @type {never} */ (booking().contacts), {
      firstName: "Ada",
      lastName: "Lovelace",
      email: " ada@new.example ",
      callingCode: "+44",
      number: "",
    });
    expect(primary).toEqual({
      purpose: "STANDARD",
      isPrimary: true,
      addresseeName: { firstName: "Ada", lastName: "Lovelace" },
      emailAddress: "ada@new.example",
      language: "en",
    });
    expect(invoice).toMatchObject({
      purpose: "INVOICE",
      isPrimary: false,
      companyName: "Analytical Engines Ltd",
    });
  });
});

describe("booking page: cancellation", () => {
  it("[OFE-015] the quote, then bookings.cancel with ifMatch, the reason, the refund seen and a stable key", async () => {
    const { client } = await openBooking();
    await openCancel();

    expect(cancelDialog().open).toBe(true);
    expect(client.bookings.quoteCancellation).toHaveBeenCalledWith(
      { bookingId: BOOKING_ID },
      expect.anything(),
    );
    expect(text($("[data-cancel-mode]"))).toBe("Your tickets are not issued yet.");
    expect(text($("[data-cancel-refund]"))).toBe(
      `If you cancel now, you get back ${money("400.00")} of the ${money("420.55")} you paid.`,
    );
    expect(items("[data-cancel-kept]")).toEqual([`Fees we keep: ${money("20.55")}`]);
    expect(items("[data-cancel-lines]")).toEqual([
      `ADA LOVELACE: ${money("200.00")} back`,
      `ALAN TURING: ${money("200.00")} back`,
    ]);
    expect(text($("button[data-cancel-confirm]"))).toBe(`Cancel and get ${money("400.00")} back`);

    await confirmCancel("illness", "  Flu  ");
    const body = { reasonCode: "illness", comment: "Flu", expectedRefund: eur("400.00") };
    expect(client.bookings.cancel).toHaveBeenCalledWith(
      { bookingId: BOOKING_ID, ifMatch: 3, ...body },
      { idempotencyKey: cancellationKey(BOOKING_ID, 3, body), timeoutMs: 90_000 },
    );
    expect(text($("[data-cancel-done-title]"))).toBe("Your booking is cancelled");
    expect(text($("[data-cancel-done-text]"))).toBe(`Your refund of ${money("400.00")} is on its way.`);
    // The page behind the dialog shows the cancelled booking.
    expect(text($("[data-booking-status]"))).toBe("Cancelled");
    expect(action("cancel").hidden).toBe(true);
    expect($("[data-cancellation-block]").hidden).toBe(false);
  });

  it("[OFE-015] a Retry after 503 sends the same request with the same key", async () => {
    const { client } = await openBooking({
      fake: fakeApi({
        cancel: [
          apiError(ServerError, "SERVICE_UNAVAILABLE", 503),
          { cancellation: cancelledBooking().cancellation, booking: cancelledBooking() },
        ],
      }),
    });
    await openCancel();
    await confirmCancel();
    expect(text($('[data-cancel-notice] [data-field="title"]'))).toBe(
      "The service is not available right now. Nothing is lost: try again in a moment.",
    );
    /** @type {HTMLButtonElement} */ ($('[data-cancel-notice] [data-action="retry"]')).click();
    await settle();
    expect(client.bookings.cancel).toHaveBeenCalledTimes(2);
    const [first, second] = client.bookings.cancel.mock.calls;
    expect(second).toEqual(first);
    expect(text($("[data-cancel-done-title]"))).toBe("Your booking is cancelled");
  });

  it("[OFE-015 AC2] 409 REFUND_AMOUNT_CHANGED shows the new amount and asks again", async () => {
    const changed = quote({ estimatedRefund: eur("380.00"), otaFee: eur("40.55") });
    const { client } = await openBooking({
      fake: fakeApi({
        quoteCancellation: [quote(), changed],
        cancel: [
          apiError(ConflictError, "REFUND_AMOUNT_CHANGED", 409, {
            details: { expectedRefund: eur("400.00"), newRefund: eur("380.00") },
          }),
          { cancellation: cancelledBooking().cancellation, booking: cancelledBooking() },
        ],
      }),
    });
    await openCancel();
    await confirmCancel();

    expect(text($('[data-cancel-notice] [data-field="title"]'))).toBe(
      `The refund changed from ${money("400.00")} to ${money("380.00")}. Check the new amount, then confirm again.`,
    );
    expect(text($("[data-cancel-refund]"))).toBe(
      `If you cancel now, you get back ${money("380.00")} of the ${money("420.55")} you paid.`,
    );
    expect(text($("button[data-cancel-confirm]"))).toBe(`Cancel and get ${money("380.00")} back`);
    expect(/** @type {HTMLFormElement} */ ($("form[data-cancel-form]")).hidden).toBe(false);
    expect(client.bookings.cancel).toHaveBeenCalledTimes(1);

    await confirmCancel();
    expect(client.bookings.cancel).toHaveBeenCalledTimes(2);
    const [first, second] = client.bookings.cancel.mock.calls;
    expect(second?.[0]).toMatchObject({ expectedRefund: eur("380.00"), ifMatch: 3 });
    // Another request, another key: the API keeps the refusal of the first one for its key.
    expect(second?.[1]?.idempotencyKey).not.toBe(first?.[1]?.idempotencyKey);
    expect(text($("[data-cancel-done-title]"))).toBe("Your booking is cancelled");
  });

  it("[OFE-015] request_only says the request goes to the airline, and the answer 'Request sent'", async () => {
    const requested = booking({
      allowedActions: actions({ canCancel: false, reasons: { canCancel: "pending" } }),
      cancellation: {
        ...cancelledBooking().cancellation,
        status: "pending",
        cancelledAt: null,
        refund: null,
        refundStatus: "manual_review",
      },
    });
    await openBooking({
      fake: fakeApi({
        quoteCancellation: [quote({ mode: "request_only", estimatedRefund: eur("0.00"), lines: [] })],
        cancel: [{ cancellation: requested.cancellation, booking: requested }],
      }),
    });
    await openCancel();
    expect(text($("[data-cancel-mode]"))).toBe(
      "We will send your request to the airline; refunds follow the fare rules",
    );
    expect($("[data-cancel-refund]").hidden).toBe(true);
    expect(text($("button[data-cancel-confirm]"))).toBe("Send the cancellation request");

    await confirmCancel();
    expect(text($("[data-cancel-done-title]"))).toBe("Request sent");
    expect(text($("[data-cancel-done-text]"))).toBe(
      "We have sent your cancellation request. We will e-mail you when it is done.",
    );
    expect(text($("[data-booking-status]"))).toBe("Cancellation requested");
  });

  it("[OFE-015] a quote that does not allow it replaces the form with the reason and the support contact", async () => {
    const { client } = await openBooking({
      fake: fakeApi({
        quoteCancellation: [
          quote({ cancellable: false, mode: "not_allowed", notAllowedReason: "too_close_to_departure" }),
        ],
      }),
    });
    await openCancel();
    expect(/** @type {HTMLFormElement} */ ($("form[data-cancel-form]")).hidden).toBe(true);
    expect(text($('[data-cancel-notice] [data-field="title"]'))).toBe(
      "This booking can no longer be cancelled online",
    );
    expect(text($('[data-cancel-notice] [data-field="hint"]'))).toBe(
      "The first flight leaves in less than 3 hours. If you need to cancel it, please contact us.",
    );
    expect(text($('[data-cancel-notice] [data-field="supportEmail"]'))).toBe("help@demo-travel.example");
    expect(client.bookings.cancel).not.toHaveBeenCalled();
    /** @type {HTMLButtonElement} */ ($('[data-cancel-close] [data-action="close-dialog"]')).click();
    expect(cancelDialog().open).toBe(false);
  });

  it("[OFE-015] 504 SUPPLIER_TIMEOUT says the airline has not confirmed yet and reloads the booking; nothing is sent again", async () => {
    const { client } = await openBooking({
      fake: fakeApi({
        get: [
          booking(),
          booking({
            allowedActions: actions({ canCancel: false, reasons: { canCancel: "pending" } }),
            cancellation: {
              ...cancelledBooking().cancellation,
              status: "pending",
              cancelledAt: null,
              refund: null,
            },
          }),
        ],
        cancel: [apiError(SupplierError, "SUPPLIER_TIMEOUT", 504)],
      }),
    });
    await openCancel();
    await confirmCancel();
    expect(text($("[data-cancel-done-title]"))).toBe("The airline has not confirmed the cancellation yet");
    expect($("[data-cancel-notice] [data-action=retry]")).toBeNull();
    expect(client.bookings.get).toHaveBeenCalledTimes(2);
    expect(client.bookings.cancel).toHaveBeenCalledTimes(1);
    expect(text($("[data-booking-status]"))).toBe("Cancellation requested");
    expect(action("cancel").hidden).toBe(true);
  });

  it("[OFE-015] 412 reloads the booking and quotes again for its new version", async () => {
    const { client } = await openBooking({
      fake: fakeApi({
        get: [booking(), booking({ version: 9 })],
        cancel: [
          apiError(VelexisError, "PRECONDITION_FAILED", 412),
          { cancellation: cancelledBooking().cancellation, booking: cancelledBooking() },
        ],
      }),
    });
    await openCancel();
    await confirmCancel();
    expect(client.bookings.quoteCancellation).toHaveBeenCalledTimes(2);
    expect(text($('[data-cancel-notice] [data-field="title"]'))).toBe(
      "This booking changed meanwhile. Check the refund again, then confirm.",
    );
    await confirmCancel();
    expect(client.bookings.cancel).toHaveBeenLastCalledWith(
      expect.objectContaining({ ifMatch: 9 }),
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^cancel-bkg_01JBOOKINGPAGE00001-9-[0-9a-f]{8}$/),
      }),
    );
  });

  it("[OFE-015] 409 VERSION_CONFLICT reloads the booking from the airline and quotes again", async () => {
    const { client } = await openBooking({
      fake: fakeApi({
        get: [booking(), booking({ version: 4 })],
        cancel: [
          apiError(ConflictError, "VERSION_CONFLICT", 409),
          { cancellation: cancelledBooking().cancellation, booking: cancelledBooking() },
        ],
      }),
    });
    await openCancel();
    await confirmCancel();

    expect(client.bookings.get).toHaveBeenLastCalledWith(
      { bookingId: BOOKING_ID, refresh: true },
      expect.anything(),
    );
    expect(client.bookings.quoteCancellation).toHaveBeenCalledTimes(2);
    expect(text($('[data-cancel-notice] [data-field="title"]'))).toBe(
      "This booking changed meanwhile. Check the refund again, then confirm.",
    );
    await confirmCancel();
    expect(client.bookings.cancel).toHaveBeenLastCalledWith(
      expect.objectContaining({ ifMatch: 4 }),
      expect.anything(),
    );
    expect(text($("[data-cancel-done-title]"))).toBe("Your booking is cancelled");
  });

  it("[OFE-015] 409 BOOKING_ALREADY_CANCELLED says so, reloads the booking and hides the actions", async () => {
    const { client } = await openBooking({
      fake: fakeApi({
        get: [booking(), cancelledBooking()],
        cancel: [apiError(ConflictError, "BOOKING_ALREADY_CANCELLED", 409)],
      }),
    });
    await openCancel();
    await confirmCancel();

    expect(client.bookings.cancel).toHaveBeenCalledTimes(1);
    expect(/** @type {HTMLFormElement} */ ($("form[data-cancel-form]")).hidden).toBe(true);
    expect(text($('[data-cancel-notice] [data-field="title"]'))).toBe("This booking is cancelled");
    // Nothing is left to cancel: no "contact us to cancel it".
    expect(text($("[data-cancel-notice]"))).not.toContain("If you need to cancel it");
    expect($('[data-cancel-notice] [data-action="retry"]')).toBeNull();
    expect(client.bookings.get).toHaveBeenCalledTimes(2);
    expect(text($("[data-booking-status]"))).toBe("Cancelled");
    expect($("[data-actions]").hidden).toBe(true);
    expect(action("cancel").hidden).toBe(true);
  });

  it("[OFE-015] 409 BOOKING_NOT_MODIFIABLE names its reason and the support contact, and reloads the booking", async () => {
    const { client } = await openBooking({
      fake: fakeApi({
        get: [
          booking(),
          booking({
            version: 4,
            allowedActions: actions({ canCancel: false, reasons: { canCancel: "too_close_to_departure" } }),
          }),
        ],
        cancel: [
          apiError(ConflictError, "BOOKING_NOT_MODIFIABLE", 409, {
            details: { reason: "too_close_to_departure", action: "canCancel" },
          }),
        ],
      }),
    });
    await openCancel();
    await confirmCancel();

    expect(text($('[data-cancel-notice] [data-field="title"]'))).toBe(
      "This booking can no longer be cancelled online",
    );
    expect(text($('[data-cancel-notice] [data-field="hint"]'))).toBe(
      "The first flight leaves in less than 3 hours. If you need to cancel it, please contact us.",
    );
    expect(text($('[data-cancel-notice] [data-field="supportEmail"]'))).toBe("help@demo-travel.example");
    expect(client.bookings.get).toHaveBeenCalledTimes(2);
    expect(action("cancel").hidden).toBe(true);
    expect($("[data-cancel-unavailable]").hidden).toBe(false);
  });

  it("[OFE-015] the idempotency key is stable for the same request and changes with it", () => {
    const body = { reasonCode: "other", expectedRefund: eur("10.00") };
    const key = cancellationKey(BOOKING_ID, 3, body);
    expect(cancellationKey(BOOKING_ID, 3, { ...body })).toBe(key);
    expect(cancellationKey(BOOKING_ID, 4, body)).not.toBe(key);
    expect(cancellationKey(BOOKING_ID, 3, { ...body, expectedRefund: eur("10.01") })).not.toBe(key);
    expect(cancellationKey(BOOKING_ID, 3, { ...body, comment: "x" })).not.toBe(key);
    expect(key.length).toBeGreaterThanOrEqual(16);
    expect(key.length).toBeLessThanOrEqual(128);
  });
});

describe("booking page: ticketing, refresh and access", () => {
  it("[OFE-015] tickets being issued: the banner, polling after pollAfterSeconds, then the booking again", async () => {
    vi.useFakeTimers();
    const issuing = booking({
      status: "confirmed",
      tickets: [],
      ticketing: { status: "in_progress", policy: "issue_after_payment", deadlineAt: null },
      allowedActions: actions({ canDownloadDocuments: false, reasons: { canDownloadDocuments: "pending" } }),
    });
    const { client } = await openBooking({
      fake: fakeApi({
        get: [issuing, booking()],
        getTicketingStatus: [
          ticketing({ bookingStatus: "confirmed", status: "in_progress", pollAfterSeconds: 5 }),
          ticketing(),
        ],
      }),
    });
    expect(text($("[data-booking-banner]"))).toBe("Tickets are being issued; we will e-mail you");
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(1);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledWith(
      { bookingId: BOOKING_ID },
      expect.anything(),
    );

    await vi.advanceTimersByTimeAsync(4999);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(2);
    expect(client.bookings.get).toHaveBeenCalledTimes(2);
    expect($("[data-booking-banner]").hidden).toBe(true);
    expect(text($("[data-booking-status]"))).toBe("Ticketed");
    expect(client.bookings.listDocuments).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(2);
  });

  it("[OFE-015] a booking being confirmed is polled every 10 s without pollAfterSeconds until it is decided", async () => {
    vi.useFakeTimers();
    const pending = booking({
      status: "pending",
      recordLocator: null,
      recordLocators: [],
      tickets: [],
      ticketing: { status: "pending", policy: "issue_at_booking", deadlineAt: null },
      allowedActions: actions({
        canCancel: false,
        canModifyContacts: false,
        canDownloadDocuments: false,
        canRefresh: false,
        reasons: { canCancel: "pending", canDownloadDocuments: "pending" },
      }),
    });
    const failed = booking({
      ...pending,
      status: "failed",
      ticketing: { status: "not_applicable", policy: "issue_at_booking", deadlineAt: null },
    });
    const { client } = await openBooking({
      fake: fakeApi({
        get: [pending, failed],
        getTicketingStatus: [
          ticketing({ bookingStatus: "pending", status: "pending", pollAfterSeconds: null }),
          ticketing({ bookingStatus: "failed", status: "not_applicable", failureCode: "SOLD_OUT" }),
        ],
      }),
    });
    expect(text($("[data-booking-banner]"))).toBe(
      "We are confirming your booking with the airline. This page updates by itself, and we will e-mail you.",
    );
    expect(text($("[data-booking-status]"))).toBe("Being confirmed");
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(2);
    expect(client.bookings.get).toHaveBeenCalledTimes(2);
    expect(text($("[data-booking-banner]"))).toBe(
      "This booking did not go through. You have not been charged.",
    );
    expect(text($("[data-booking-status]"))).toBe("Not completed");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(2);
  });

  it("[OFE-015] a booking read once tickets are decided is not polled again, even when it still lags behind", async () => {
    vi.useFakeTimers();
    const issuing = booking({
      status: "confirmed",
      tickets: [],
      ticketing: { status: "in_progress", policy: "issue_after_payment", deadlineAt: null },
    });
    const { client } = await openBooking({
      fake: fakeApi({
        get: [issuing, issuing],
        getTicketingStatus: [
          ticketing({ bookingStatus: "confirmed", status: "in_progress", pollAfterSeconds: 5 }),
          ticketing(),
        ],
      }),
    });
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(2);
    expect(client.bookings.get).toHaveBeenCalledTimes(2);
    // The ticketing answer says how it ended: no banner, and no loop of polls and reads.
    expect($("[data-booking-banner]").hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(client.bookings.getTicketingStatus).toHaveBeenCalledTimes(2);
    expect(client.bookings.get).toHaveBeenCalledTimes(2);
  });

  it("[OFE-015] Refresh from airline asks with refresh: true; an airline that does not answer keeps the saved booking", async () => {
    const { client } = await openBooking({
      fake: fakeApi({
        get: [
          booking(),
          booking({
            lastSyncedAt: "2026-10-24T09:00:00Z",
            allowedActions: actions({ canRefresh: false, reasons: { canRefresh: "throttled" } }),
          }),
          apiError(SupplierError, "SUPPLIER_UNAVAILABLE", 503),
        ],
      }),
    });
    action("refresh").click();
    await settle();
    expect(client.bookings.get).toHaveBeenLastCalledWith(
      { bookingId: BOOKING_ID, refresh: true },
      expect.anything(),
    );
    expect(text($('[data-booking-notice] [data-notice="success"]'))).toBe(
      "Your booking is up to date with the airline",
    );
    expect(action("refresh").hidden).toBe(true);

    action("refresh").hidden = false;
    action("refresh").click();
    await settle();
    expect(text($('[data-booking-notice] [data-field="title"]'))).toBe(
      "The airline is not answering right now. These are the details we saved last; try again in a minute.",
    );
    expect(text($("[data-booking-title]"))).toBe("Booking VX7K2Q");
  });

  it("[OFE-015] 401 without a session or guest cookie links to the lookup and sign-in", async () => {
    const { client } = await openBooking({
      session: null,
      fake: fakeApi({ get: [apiError(AuthenticationError, "UNAUTHENTICATED", 401)] }),
    });
    expect(stateTitle()).toBe("Find your booking with its reference");
    expect(stateLinks()).toEqual([
      ["Find your booking", "/lookup.html"],
      ["Sign in", `/account/sign-in.html?next=${encodeURIComponent(`/booking.html?id=${BOOKING_ID}`)}`],
    ]);
    expect($("[data-booking-content]").hidden).toBe(true);
    expect(client.bookings.listDocuments).not.toHaveBeenCalled();
  });

  it("[OFE-015] an unknown booking or an address without a valid id is 'Booking not found'", async () => {
    const bad = await openBooking({ query: "id=bkg_bad" });
    expect(stateTitle()).toBe("Booking not found");
    expect(bad.client.bookings.get).not.toHaveBeenCalled();
    bad.view.destroy();

    await openBooking({ session: null, fake: fakeApi({ get: [apiError(NotFoundError, "NOT_FOUND", 404)] }) });
    expect(stateTitle()).toBe("Booking not found");
    expect(stateLinks()).toEqual([["Find your booking", "/lookup.html"]]);
  });
});
