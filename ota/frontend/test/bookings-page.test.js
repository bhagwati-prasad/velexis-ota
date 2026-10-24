// My bookings (ota/frontend/docs/pages-account.md §1–§2, flow ota/docs/flows/my-bookings-and-guest-lookup.md §3 step
// 4): bookings.html with its partials expanded by the build's include plugin, run by src/pages/bookings.js against a
// fake SDK. It covers the tabs (`bookings.list` with the tab's timeframe, 20 per page and the tab's order), the cards,
// "Load more" with `page.next()`, the empty states, visitors sent to sign-in (or to the lookup without customer
// accounts), `401` and a failed list with Retry.
import { AuthenticationError, ServerError } from "@velexis/ota-sdk";
import { Browser } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { includePartials } from "../scripts/vite-plugins.js";
import { formatLocalDate, formatMoney } from "../src/lib/format.js";
import { PAGE_SIZE, bookingRow, start, tabOf } from "../src/pages/bookings.js";
import { STOREFRONT_ROOT } from "./helpers/storefront.js";

/** The mocked boot() of the page module never resolves here (the static import above). */
vi.mock("../src/boot.js", async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  return { ...actual, boot: () => new Promise(() => {}) };
});

const PAGE = "bookings.html";

/** @param {string} amount */
const eur = (amount) => ({ amount, currency: "EUR" });
/** A card's date as the page formats it (the runtime's own Intl data). */
const cardDate = (/** @type {string} */ at) =>
  formatLocalDate(at, "en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

const CONFIG = Object.freeze({
  name: "Demo Travel",
  defaultLocale: "en-GB",
  timeZone: "Europe/London",
  support: { email: "help@demo-travel.example", phone: null, hours: null, helpCenterUrl: null },
  features: { ancillaries: true, guestCheckout: true, customerAccounts: true },
});
/** A signed-in customer. */
const SESSION = Object.freeze({ customer: { id: "cus_01JBOOKINGSCUSTOMER", firstName: "Ada" } });

/**
 * A booking card of the API.
 * @param {number} n
 * @param {Record<string, unknown>} [overrides]
 */
function summary(n, overrides = {}) {
  return {
    id: `bkg_01JBOOKINGSLIST${String(n).padStart(5, "0")}`,
    reference: `VX${String(n).padStart(4, "0")}`,
    status: "ticketed",
    timeframe: "upcoming",
    recordLocator: "ABC123",
    tripType: "round_trip",
    originCode: "CDG",
    destinationCode: "JFK",
    destinationCityName: "New York",
    departureAt: "2026-12-01T10:00:00",
    returnAt: "2026-12-08T18:30:00",
    legs: [],
    travelersCount: 2,
    leadTravelerName: "ADA LOVELACE",
    total: eur("1414.06"),
    ticketingStatus: "issued",
    hasScheduleChange: false,
    createdAt: "2026-10-10T09:20:41Z",
    cancelledAt: null,
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
    page: { nextCursor: last ? null : `cur_${index + 1}`, limit: PAGE_SIZE },
    next: vi.fn(async () => (last ? null : pageOf(pages, index + 1))),
  };
}

/** @param {Function} ErrorClass @param {string} code @param {number} status */
const apiError = (ErrorClass, code, status) =>
  new ErrorClass({ code, message: `${code} from the fake API`, status, requestId: "req_bookings" });

/**
 * A fake API whose `bookings.list` answers its list in turn (the last one again; an Error is thrown).
 * @param {unknown[]} answers
 */
function fakeApi(answers) {
  let calls = 0;
  const list = vi.fn(async () => {
    const answer = answers[Math.min(calls, answers.length - 1)];
    calls += 1;
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  });
  return { client: { bookings: { list } } };
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

const text = (/** @type {Element | null | undefined} */ element) =>
  element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const $ = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (document.querySelector(selector));
const cards = () => Array.from(document.querySelectorAll("[data-booking-row]"));
const stateTitle = () => text($('[data-bookings-state] [data-field="title"]'));

/**
 * Opens My bookings at `/bookings.html?<query>` with a fake SDK and lets the first load settle.
 * @param {{ query?: string, fake?: ReturnType<typeof fakeApi>, config?: object, session?: object | null }} [options]
 */
async function openBookings({
  query = "tab=upcoming",
  fake = fakeApi([pageOf([[summary(1)]])]),
  config = CONFIG,
  session = SESSION,
} = {}) {
  showPage(`/bookings.html?${query}`);
  const replace = vi.fn();
  const view = start(
    {
      config: /** @type {never} */ (config),
      client: /** @type {never} */ (fake.client),
      session: /** @type {never} */ (session),
    },
    { replace },
  );
  if (!view) {
    throw new Error("My bookings did not start");
  }
  views.push(view);
  await view.done;
  return { view, replace, ...fake };
}

describe("my bookings: tabs and cards", () => {
  it("[OFE-015] lists the upcoming trips 20 at a time by departure, with the tab marked current", async () => {
    const { client } = await openBookings();

    expect(client.bookings.list).toHaveBeenCalledTimes(1);
    expect(client.bookings.list).toHaveBeenCalledWith(
      { timeframe: "upcoming", limit: 20, sort: "departure" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(document.title).toBe("Upcoming trips – My bookings");
    expect($('a[data-tab="upcoming"]').getAttribute("aria-current")).toBe("page");
    expect($('a[data-tab="past"]').hasAttribute("aria-current")).toBe(false);
    expect($('a[data-tab="past"]').getAttribute("href")).toBe("/bookings.html?tab=past");
    expect($('a[data-tab="cancelled"]').getAttribute("href")).toBe("/bookings.html?tab=cancelled");

    const [card] = cards();
    expect(card?.querySelector("a")?.getAttribute("href")).toBe("/booking.html?id=bkg_01JBOOKINGSLIST00001");
    expect(text(card?.querySelector('[data-field="route"]'))).toBe("CDG → New York (JFK)");
    expect(text(card?.querySelector('[data-field="dates"]'))).toBe(
      `${cardDate("2026-12-01T10:00:00")} – ${cardDate("2026-12-08T18:30:00")}`,
    );
    expect(text(card?.querySelector('[data-field="travellers"]'))).toBe(
      "2 travellers: ADA LOVELACE and others",
    );
    expect(text(card?.querySelector('[data-field="reference"]'))).toBe("VX0001");
    expect(text(card?.querySelector('[data-field="total"]'))).toBe(formatMoney(eur("1414.06"), "en-GB"));
    const badge = /** @type {HTMLElement} */ (card?.querySelector("[data-booking-status]"));
    expect(text(badge)).toBe("Ticketed");
    expect(badge.dataset["status"]).toBe("ticketed");
    expect($("[data-bookings-empty]").hidden).toBe(true);
    expect($("[data-load-more]").hidden).toBe(true);
  });

  it("[OFE-015] past and cancelled trips come newest first; an unknown tab is upcoming", async () => {
    for (const [tab, sort] of /** @type {const} */ ([
      ["past", "-departure"],
      ["cancelled", "-departure"],
    ])) {
      const { client, view } = await openBookings({ query: `tab=${tab}` });
      expect(client.bookings.list).toHaveBeenCalledWith(
        { timeframe: tab, limit: 20, sort },
        expect.anything(),
      );
      expect($(`a[data-tab="${tab}"]`).getAttribute("aria-current")).toBe("page");
      view.destroy();
    }
    expect(tabOf("all")).toBe("upcoming");
    expect(tabOf(null)).toBe("upcoming");
  });

  it("[OFE-015] the status says confirmed, ticketed, pending or cancelled in words; schedule changes and open tickets are noted", () => {
    const row = (/** @type {Record<string, unknown>} */ overrides) =>
      bookingRow(/** @type {never} */ (summary(1, overrides)), "en-GB");
    expect(row({ status: "pending", ticketingStatus: "pending" })).toMatchObject({
      status: "Being confirmed",
      statusCode: "pending",
      notice: "Tickets are being issued",
    });
    expect(row({ status: "confirmed", ticketingStatus: "in_progress" }).status).toBe("Confirmed");
    expect(row({ status: "cancelled", ticketingStatus: "not_applicable" })).toMatchObject({
      status: "Cancelled",
      notice: null,
      noNotice: true,
    });
    expect(row({ status: "partially_ticketed" }).status).toBe("Partly ticketed");
    expect(row({ hasScheduleChange: true }).notice).toBe("The airline changed the flight times");
    expect(row({ returnAt: null, destinationCityName: null })).toMatchObject({
      dates: cardDate("2026-12-01T10:00:00"),
      route: "CDG → JFK",
    });
    expect(row({ travelersCount: 1 }).travellers).toBe("1 traveller: ADA LOVELACE");
  });
});

describe("my bookings: load more and empty tabs", () => {
  it("[OFE-015] 'Load more' appends the next page and moves the focus to its first booking", async () => {
    const first = Array.from({ length: 20 }, (_, i) => summary(i + 1));
    const second = [summary(21), summary(22)];
    const page = pageOf([first, second]);
    const { client } = await openBookings({ fake: fakeApi([page]) });

    expect(cards()).toHaveLength(20);
    expect($("[data-load-more]").hidden).toBe(false);
    $('button[data-action="load-more"]').click();
    await vi.waitFor(() => expect(cards()).toHaveLength(22), { timeout: 2000 }); // the next page's promise
    expect(page.next).toHaveBeenCalledTimes(1);
    expect(client.bookings.list).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(cards()[20]?.querySelector("a"));
    expect($("[data-load-more]").hidden).toBe(true);
  });

  it("[OFE-015] an empty upcoming tab offers the search and the guest lookup; past and cancelled say so briefly", async () => {
    const upcoming = await openBookings({ fake: fakeApi([pageOf([[]])]) });
    expect(text($("[data-bookings-empty-title]"))).toBe("No upcoming trips");
    expect($("[data-bookings-empty]").hidden).toBe(false);
    expect($("[data-bookings-empty-upcoming]").hidden).toBe(false);
    expect($("a[data-lookup-link]").getAttribute("href")).toBe("/lookup.html");
    expect(text($("[data-bookings-empty-upcoming]"))).toContain("Search flights");
    upcoming.view.destroy();

    await openBookings({ query: "tab=past", fake: fakeApi([pageOf([[]])]) });
    expect(text($("[data-bookings-empty-title]"))).toBe("No past trips");
    expect($("[data-bookings-empty-upcoming]").hidden).toBe(true);
  });
});

describe("my bookings: access and failures", () => {
  it("[OFE-015] a visitor goes to sign-in with next back to the tab; without customer accounts to the lookup", async () => {
    const visitor = await openBookings({ query: "tab=past", session: null });
    expect(visitor.client.bookings.list).not.toHaveBeenCalled();
    expect(visitor.replace).toHaveBeenCalledWith(
      `/account/sign-in.html?next=${encodeURIComponent("/bookings.html?tab=past")}`,
    );
    visitor.view.destroy();

    const noAccounts = await openBookings({
      session: null,
      config: { ...CONFIG, features: { ...CONFIG.features, customerAccounts: false } },
    });
    expect(noAccounts.replace).toHaveBeenCalledWith("/lookup.html");
    expect(noAccounts.client.bookings.list).not.toHaveBeenCalled();
  });

  it("[OFE-015] a session that ended (401 after the SDK's refresh) goes to sign-in", async () => {
    const { replace } = await openBookings({
      fake: fakeApi([apiError(AuthenticationError, "TOKEN_EXPIRED", 401)]),
    });
    expect(replace).toHaveBeenCalledWith(
      `/account/sign-in.html?next=${encodeURIComponent("/bookings.html?tab=upcoming")}`,
    );
  });

  it("[OFE-015] a failed 'Load more' keeps the list and says why; a session that ended goes to sign-in", async () => {
    const first = Array.from({ length: 20 }, (_, i) => summary(i + 1));
    const failing = {
      ...pageOf([first, [summary(21)]]),
      next: vi
        .fn()
        .mockRejectedValueOnce(apiError(ServerError, "SERVICE_UNAVAILABLE", 503))
        .mockRejectedValueOnce(apiError(AuthenticationError, "TOKEN_EXPIRED", 401)),
    };
    const { replace } = await openBookings({ fake: fakeApi([failing]) });

    $('button[data-action="load-more"]').click();
    await vi.waitFor(() => expect(text($("[data-load-more-state]"))).not.toBe(""), { timeout: 2000 }); // the failing page
    expect(text($('[data-load-more-state] [data-field="title"]'))).toBe(
      "The service is not available right now. Nothing is lost: try again in a moment.",
    );
    expect(cards()).toHaveLength(20);
    expect($("[data-load-more]").hidden).toBe(false);
    expect(replace).not.toHaveBeenCalled();

    $('button[data-action="load-more"]').click();
    await vi.waitFor(() => expect(replace).toHaveBeenCalledTimes(1), { timeout: 2000 }); // the second failing page
    expect(replace).toHaveBeenCalledWith(
      `/account/sign-in.html?next=${encodeURIComponent("/bookings.html?tab=upcoming")}`,
    );
  });

  it("[OFE-015] a list that cannot be loaded offers Retry", async () => {
    const { client } = await openBookings({
      fake: fakeApi([apiError(ServerError, "SERVICE_UNAVAILABLE", 503), pageOf([[summary(1)]])]),
    });
    expect(stateTitle()).toBe(
      "The service is not available right now. Nothing is lost: try again in a moment.",
    );
    expect($("[data-bookings-content]").hidden).toBe(true);

    $('[data-bookings-state] [data-action="retry"]').click();
    await vi.waitFor(() => expect(cards()).toHaveLength(1), { timeout: 2000 }); // the retried list's promise
    expect(client.bookings.list).toHaveBeenCalledTimes(2);
    expect($("[data-bookings-state]").children).toHaveLength(0);
  });
});
