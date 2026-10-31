// The customers pages as Next.js renders them on the server (OAD-012): the real pages, `getConsoleRequest` and the
// SDK against the fake OTA API (the SDK's `fetch`), rendered to HTML and queried in a detached happy-dom document (a
// server-mode SDK client refuses to run in a browser-like test environment, rightly). `/customers` checks what the
// list sends for a URL and what it shows; `/customers/[customerId]` checks the account, its statistics and its
// bookings through `console.bookings.list({ customerId })` [OAD-012 AC2], and the API's codes handled on the server.
import type { ConsoleBookingSummary, ConsoleCustomer, ConsoleCustomerSummary } from "@velexis/ota-sdk";
import { within } from "@testing-library/dom";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CookieJar,
  TENANT_ID,
  TEST_CONFIG,
  TEST_PORTAL_URL,
  apiError,
  fakeOtaApi,
  rateLimited,
  redirectOf,
  staffAccessToken,
  staffProfile,
  type FakeOtaApi,
  type SentRequest,
} from "@/test/fake-ota-api";

// ---- Mocks: the request scope and navigation of Next.js and the configuration ------------------------------------

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
const navigation = vi.hoisted(() => ({ pathname: "/customers", searchParams: new URLSearchParams() }));
vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));
vi.mock("next/headers", () => nextHeaders);
vi.mock("next/navigation", async () => {
  const { fakeRedirect } = await import("@/test/fake-ota-api");
  return {
    usePathname: () => navigation.pathname,
    useSearchParams: () => navigation.searchParams,
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

import CustomerPage from "./[customerId]/page";
import CustomersPage from "./page";

const LIST = "GET /v1/console/customers";
const BOOKINGS = "GET /v1/console/bookings";
const TIME_ZONE = "Europe/Oslo";
const CUSTOMER_ID = "cus_8f3K2mQ9xT4vB7nL";
const DELETED_ID = "cus_3H7pW2kR9sV4xB6nQ1";
const GET = `GET /v1/console/customers/${CUSTOMER_ID}`;
const GET_DELETED = `GET /v1/console/customers/${DELETED_ID}`;

let api: FakeOtaApi;
let sequence = 0;

/** The cookies of a signed-in staff member. */
function signedIn(): void {
  sequence += 1;
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`customers-${sequence}`, Date.now(), 900),
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-customers-${sequence}`,
      [ENVIRONMENT_COOKIE]: "test",
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
}

const eur = (amount: string) => ({ amount, currency: "EUR" });

/** A row of `console.customers.list` (dummy data): Anna Berg by default. */
function summary(overrides: Partial<ConsoleCustomerSummary> = {}): ConsoleCustomerSummary {
  return {
    id: CUSTOMER_ID,
    email: "anna.berg@example.com",
    firstName: "Anna",
    lastName: "Berg",
    status: "active",
    emailVerified: true,
    phone: { deviceType: "MOBILE", countryCallingCode: "46", number: "701234567" },
    bookingsCount: 3,
    upcomingBookingsCount: 1,
    totalSpent: eur("2890.40"),
    lastBookingAt: "2026-10-10T09:20:41Z",
    lastSignInAt: "2026-10-10T09:12:00Z",
    createdAt: "2025-05-14T18:02:11Z",
    ...overrides,
  };
}

/** A deleted account as the API lists it: the placeholder address, no name and no phone. */
function deletedSummary(): ConsoleCustomerSummary {
  return summary({
    id: DELETED_ID,
    email: "deleted-3h7pw2kr9sv4xb6nq1@deleted.invalid",
    firstName: null,
    lastName: null,
    status: "deleted",
    emailVerified: false,
    phone: null,
    bookingsCount: 1,
    upcomingBookingsCount: 0,
    totalSpent: null,
    lastBookingAt: null,
    lastSignInAt: null,
    createdAt: "2025-03-02T08:00:00Z",
  });
}

/** `console.customers.get` of Anna Berg (dummy data). */
function customer(overrides: Partial<ConsoleCustomer["customer"]> = {}): ConsoleCustomer {
  return {
    customer: {
      id: CUSTOMER_ID,
      email: "anna.berg@example.com",
      emailVerified: true,
      emailVerifiedAt: "2025-05-14T18:05:40Z",
      pendingEmail: null,
      firstName: "Anna",
      lastName: "Berg",
      phone: { deviceType: "MOBILE", countryCallingCode: "46", number: "701234567" },
      dateOfBirth: "1988-04-12",
      status: "active",
      marketingConsent: { granted: true, updatedAt: "2025-05-14T18:02:11Z", source: "sign_up" },
      termsAcceptedVersion: "2025-03",
      lastSignInAt: "2026-10-10T09:12:00Z",
      createdAt: "2025-05-14T18:02:11Z",
      updatedAt: "2026-10-10T09:12:00Z",
      version: 4,
      ...overrides,
    },
    stats: {
      bookingsCount: 3,
      upcomingBookingsCount: 1,
      cancelledBookingsCount: 1,
      totalSpent: eur("2890.40"),
      totalRefunded: eur("310.00"),
      lastBookingAt: "2026-10-10T09:20:41Z",
    },
    recentBookings: [],
    savedTravelersCount: 2,
    activeSessionsCount: 1,
  };
}

/** A deleted account as `console.customers.get` answers it: empty names, no phone, birth date or pending address. */
function deletedCustomer(): ConsoleCustomer {
  const result = customer({
    id: DELETED_ID,
    email: "deleted-3h7pw2kr9sv4xb6nq1@deleted.invalid",
    emailVerified: false,
    emailVerifiedAt: null,
    firstName: "",
    lastName: "",
    phone: null,
    dateOfBirth: null,
    status: "deleted",
    marketingConsent: { granted: false, updatedAt: "2026-09-01T10:00:00Z", source: "account" },
    lastSignInAt: null,
    updatedAt: "2026-09-01T10:00:00Z",
  });
  return {
    ...result,
    stats: { ...result.stats, bookingsCount: 1, upcomingBookingsCount: 0, cancelledBookingsCount: 0 },
    savedTravelersCount: 0,
    activeSessionsCount: 0,
  };
}

/** A booking of the customer as `console.bookings.list` answers it (dummy data). */
function booking(overrides: Partial<ConsoleBookingSummary> = {}): ConsoleBookingSummary {
  return {
    id: "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2",
    reference: "VX7K2Q",
    status: "ticketed",
    channel: "storefront",
    environment: "test",
    recordLocator: "QX8P4L",
    amadeusOrderId: "eJzTd9cPNfX09DUFAAsGAkQ",
    customer: { id: CUSTOMER_ID, email: "anna.berg@example.com", firstName: "Anna", lastName: "Berg" },
    isGuest: false,
    leadTravelerName: "ANNA BERG",
    travelersCount: 2,
    tripType: "round_trip",
    originCode: "CDG",
    destinationCode: "JFK",
    departureAt: "2026-11-20T10:25:00",
    returnAt: "2026-11-27T18:30:00",
    validatingCarrier: "AF",
    ticketingStatus: "issued",
    ticketingDeadlineAt: null,
    paymentStatus: "paid",
    total: eur("1414.06"),
    net: eur("1265.56"),
    markup: eur("116.00"),
    syncStatus: "fresh",
    lastSyncedAt: "2026-10-10T09:20:52Z",
    hasScheduleChange: false,
    tags: [],
    createdByStaffId: null,
    createdAt: "2026-10-10T09:20:41Z",
    cancelledAt: null,
    ...overrides,
  } as ConsoleBookingSummary;
}

/** `console.customers.list` answers one page. */
function listAnswers(data: ConsoleCustomerSummary[], nextCursor: string | null = null): void {
  api.on(LIST, () =>
    Response.json({ data, page: { nextCursor, limit: 25 } }, { headers: { "X-Request-Id": "req_list" } }),
  );
}

/** `console.customers.get` and the customer's bookings answer. */
function detailAnswers(
  result: ConsoleCustomer = customer(),
  bookings: ConsoleBookingSummary[] = [booking()],
  nextCursor: string | null = null,
): void {
  api.on(`GET /v1/console/customers/${result.customer.id}`, () =>
    Response.json(result, { headers: { "X-Request-Id": "req_customer" } }),
  );
  api.on(BOOKINGS, () =>
    Response.json(
      { data: bookings, page: { nextCursor, limit: 25 } },
      { headers: { "X-Request-Id": "req_bookings" } },
    ),
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

/** Server-rendered HTML in a detached document. */
function documentOf(html: string): HTMLElement {
  const { document } = new Window();
  document.body.innerHTML = html;
  return document.body as unknown as HTMLElement;
}

/** `/customers?<search>`, rendered on the "server". */
async function renderList(search = ""): Promise<HTMLElement> {
  navigation.pathname = "/customers";
  navigation.searchParams = new URLSearchParams(search);
  const element = await CustomersPage({ searchParams: Promise.resolve(searchParamsOf(search)) });
  return documentOf(renderToStaticMarkup(element));
}

/** `/customers/<customerId>?<search>`, rendered on the "server". */
async function renderDetail(customerId = CUSTOMER_ID, search = ""): Promise<HTMLElement> {
  navigation.pathname = `/customers/${customerId}`;
  navigation.searchParams = new URLSearchParams(search);
  const element = await CustomerPage({
    params: Promise.resolve({ customerId }),
    searchParams: Promise.resolve(searchParamsOf(search)),
  });
  return documentOf(renderToStaticMarkup(element));
}

/** The one request of `route`. */
function onlyRequest(route: string): SentRequest {
  const sent = api.sent(route);
  expect(sent).toHaveLength(1);
  return sent[0] as SentRequest;
}

/** The query of a request as a plain object. */
function queryObject(request: SentRequest): Record<string, string> {
  return Object.fromEntries(request.url.searchParams);
}

/** The texts of the cells of the body rows of the table named `caption`. */
function rowsOf(scope: HTMLElement, caption: string): string[][] {
  const table = within(scope).getByRole("table", { name: caption });
  return [...table.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? ""),
  );
}

/** The `href` of the link named `name`. */
function hrefOf(scope: HTMLElement, name: string): string | null {
  return within(scope).getByRole("link", { name }).getAttribute("href");
}

/** The facts of the section named `name`: label → value. */
function factsOf(page: HTMLElement, name: string): Record<string, string> {
  const section = within(page).getByRole("region", { name });
  const facts: Record<string, string> = {};
  for (const term of section.querySelectorAll("dt")) {
    facts[term.textContent ?? ""] = term.nextElementSibling?.textContent ?? "";
  }
  return facts;
}

// Once per file: the first server render of each page and the SDK's first calls are the slowest in a fresh worker; on
// a busy CI runner they would otherwise land in the first test's own five seconds.
beforeAll(async () => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers());
  signedIn();
  listAnswers([summary(), deletedSummary()]);
  detailAnswers();
  await renderList();
  await renderDetail();
  vi.unstubAllGlobals();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers({ "User-Agent": "Mozilla/5.0 Test" }));
  signedIn();
});

describe("/customers", () => {
  it("[OAD-012] lists the accounts with their statistics: name, e-mail, status, bookings, total spent, last booking, sign-up", async () => {
    listAnswers([
      summary(),
      summary({
        id: "cus_9Q4mT7vB2xK8nL3p",
        firstName: "Ola",
        lastName: "Nordmann",
        email: "ola@example.com",
        emailVerified: false,
        status: "disabled",
        bookingsCount: 0,
        upcomingBookingsCount: 0,
        totalSpent: null,
        lastBookingAt: null,
      }),
    ]);

    const page = await renderList();

    expect(queryObject(onlyRequest(LIST))).toEqual({ limit: "25" });
    expect(onlyRequest(LIST).headers.get("X-Velexis-Environment")).toBe("test");
    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe("Customers");
    expect(page.textContent).toContain("with their bookings in the test environment");
    // Guests are found in the bookings list.
    expect(hrefOf(page, "bookings list")).toBe("/bookings");
    const headers = [...page.querySelectorAll("thead th")].map((cell) => cell.textContent);
    expect(headers).toEqual([
      "Customer",
      "E-mail",
      "Status",
      "Bookings",
      "Total spent",
      "Last booking",
      "Signed up",
    ]);
    expect(rowsOf(page, "Customers")).toEqual([
      [
        `Anna Berg${CUSTOMER_ID}`,
        "anna.berg@example.comVerified",
        "Active",
        "31 upcoming",
        "€2,890.40",
        formatInstant("2026-10-10T09:20:41Z", TIME_ZONE),
        formatInstant("2025-05-14T18:02:11Z", TIME_ZONE),
      ],
      [
        "Ola Nordmanncus_9Q4mT7vB2xK8nL3p",
        "ola@example.comNot verified",
        "Disabled",
        "00 upcoming",
        "Nothing yet",
        "Never",
        formatInstant("2025-05-14T18:02:11Z", TIME_ZONE),
      ],
    ]);
    expect(hrefOf(page, "Anna Berg")).toBe(`/customers/${CUSTOMER_ID}`);
    // The list shows no phone number.
    expect(page.textContent).not.toContain("701234567");
    expect(within(page).queryByRole("navigation", { name: "Pages" })).toBeNull();
  });

  it("[OAD-012] searches by the start of an e-mail or a name and sends the URL's filters and sort", async () => {
    listAnswers([summary()]);

    const page = await renderList(
      "q=%20ann%20&status=deleted&status=active&emailVerified=true&hasBookings=false&sort=-lastBooking&limit=50",
    );

    expect(queryObject(onlyRequest(LIST))).toEqual({
      q: "ann",
      // In the order of the document's enum, whatever the URL's order.
      status: "active,deleted",
      emailVerified: "true",
      hasBookings: "false",
      sort: "-lastBooking",
      limit: "50",
    });

    // The form shows them: a GET form to this page, the page size kept.
    const form = within(page).getByRole("search", { name: "Customer filters" }) as HTMLFormElement;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/customers");
    expect(form.querySelector<HTMLInputElement>('input[name="q"]')?.getAttribute("value")).toBe("ann");
    const checked = [...form.querySelectorAll<HTMLInputElement>("input[type=checkbox]")]
      .filter((input) => input.hasAttribute("checked"))
      .map((input) => `${input.name}=${input.value}`);
    expect(checked).toEqual(["status=active", "status=deleted"]);
    const selected = (name: string) =>
      form.querySelector(`select[name="${name}"] option[selected]`)?.getAttribute("value");
    expect(selected("emailVerified")).toBe("true");
    expect(selected("hasBookings")).toBe("false");
    expect(selected("sort")).toBe("-lastBooking");
    expect(form.querySelector<HTMLInputElement>('input[name="limit"]')?.getAttribute("value")).toBe("50");
    expect(hrefOf(form, "Clear filters")).toBe("/customers?limit=50");

    // The default sort is never sent nor written.
    api = fakeOtaApi();
    vi.stubGlobal("fetch", api.fetch);
    listAnswers([summary()]);
    await renderList("sort=-created&q=berg");
    expect(queryObject(onlyRequest(LIST))).toEqual({ q: "berg", limit: "25" });
  });

  it("[OAD-012] shows a deleted account as the API returns it: deleted, its placeholder address, no name", async () => {
    listAnswers([deletedSummary()]);

    const page = await renderList("status=deleted");

    expect(queryObject(onlyRequest(LIST))).toEqual({ status: "deleted", limit: "25" });
    expect(rowsOf(page, "Customers")).toEqual([
      [
        `Deleted account${DELETED_ID}`,
        "deleted-3h7pw2kr9sv4xb6nq1@deleted.invalidNot verified",
        "Deleted",
        "10 upcoming",
        "Nothing yet",
        "Never",
        formatInstant("2025-03-02T08:00:00Z", TIME_ZONE),
      ],
    ]);
    expect(hrefOf(page, "Deleted account")).toBe(`/customers/${DELETED_ID}`);
    // Nothing else is looked up for it.
    expect(api.requests.map((request) => request.url.pathname)).toEqual([
      "/v1/console/auth/me",
      "/v1/console/customers",
    ]);
  });

  it("[OAD-012] pages with the API's cursor, keeping the filters, and back to the first page", async () => {
    listAnswers([summary()], "cur_page2");
    let page = await renderList("q=berg");
    let pages = within(page).getByRole("navigation", { name: "Pages" });
    expect(within(pages).queryByRole("link", { name: "First page" })).toBeNull();
    expect(hrefOf(pages, "Next page")).toBe("/customers?q=berg&cursor=cur_page2");

    api = fakeOtaApi();
    vi.stubGlobal("fetch", api.fetch);
    listAnswers([summary()], null);
    page = await renderList("q=berg&cursor=cur_page2");
    expect(queryObject(onlyRequest(LIST))).toEqual({ q: "berg", cursor: "cur_page2", limit: "25" });
    pages = within(page).getByRole("navigation", { name: "Pages" });
    expect(hrefOf(pages, "First page")).toBe("/customers?q=berg");
    expect(within(pages).queryByRole("link", { name: "Next page" })).toBeNull();
  });

  it("[OAD-012] names the parameters of a link the API would refuse, without a request", async () => {
    const page = await renderList(
      "q=a&status=gone&emailVerified=maybe&hasBookings=true&sort=size&limit=0&cursor=a&cursor=b",
    );

    expect(api.sent(LIST)).toHaveLength(0);
    const alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("This link has filters the list cannot use");
    expect(alert.textContent).toContain(
      "Not valid: Search, Account status, E-mail, Sort, Page, Page size. Change them above, or clear the filters.",
    );
    expect(hrefOf(alert, "Clear filters")).toBe("/customers");
    // The valid filter stays in the form; the refused page size does not.
    const form = within(page).getByRole("search", { name: "Customer filters" });
    expect(form.querySelector('select[name="hasBookings"] option[selected]')?.getAttribute("value")).toBe(
      "true",
    );
    expect(form.querySelector('input[name="limit"]')).toBeNull();
  });

  it("[OAD-012] counts the search's length in characters, as the API does, not in UTF-16 units", async () => {
    // One character of two UTF-16 units is shorter than the API's two characters: refused without a request.
    let page = await renderList(`q=${encodeURIComponent("😀")}`);
    expect(api.sent(LIST)).toHaveLength(0);
    expect(within(page).getByRole("alert").textContent).toContain("Not valid: Search.");

    // Fifty such characters (one hundred UTF-16 units) and fifty more letters are a hundred characters: sent.
    listAnswers([]);
    const longest = `${"😀".repeat(50)}${"a".repeat(50)}`;
    page = await renderList(`q=${encodeURIComponent(longest)}`);
    expect(queryObject(onlyRequest(LIST))).toEqual({ q: longest, limit: "25" });
    expect(within(page).queryByRole("alert")).toBeNull();
  });

  it("[OAD-012] says when the OTA has no customers, or none match the filters", async () => {
    listAnswers([]);
    let page = await renderList();
    expect(rowsOf(page, "Customers")).toEqual([["No customer accounts yet."]]);

    page = await renderList("q=zz");
    expect(rowsOf(page, "Customers")).toEqual([["No customer matches these filters."]]);
  });

  it("redirects an expired session to /auth/refresh back to this list, and an ended one to the portal", async () => {
    api.on(LIST, () => apiError("TOKEN_EXPIRED", 401));
    const next = new URLSearchParams({ next: "/customers?q=berg" }).toString();
    expect(await redirectOf(() => renderList("q=berg"))).toBe(`/auth/refresh?${next}`);

    api.on(LIST, () => apiError("UNAUTHENTICATED", 401));
    expect(await redirectOf(() => renderList())).toBe(`${TEST_PORTAL_URL}/console?tenant=${TENANT_ID}`);
  });

  it("renders the API's refusals on the server, under the filters, with the request id", async () => {
    api.on(LIST, () =>
      apiError("VALIDATION_FAILED", 400, {
        fieldErrors: [{ path: "/query/cursor", code: "cursor_mismatch", message: "Not this list's cursor." }],
      }),
    );
    let page = await renderList("q=berg&cursor=stale");
    let alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("The customers could not be loaded");
    expect(alert.textContent).toContain("req_fake_1");
    expect(hrefOf(alert, "Try again")).toBe("/customers?q=berg&cursor=stale");
    expect(hrefOf(alert, "Clear filters")).toBe("/customers");
    expect(within(page).getByRole("search", { name: "Customer filters" })).toBeTruthy();

    api.on(LIST, () => rateLimited());
    page = await renderList();
    alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("Too many requests, retry in 60 s.");
    expect(within(alert).queryByRole("link", { name: "Clear filters" })).toBeNull();
    expect(page.textContent).not.toContain("The API refused the request");
  });

  it("renders a role without customers:read as a state, without listing", async () => {
    api.on("GET /v1/console/auth/me", () =>
      Response.json({ ...staffProfile({ role: "viewer" }), permissions: ["bookings:read"] }),
    );
    const page = await renderList();
    expect(within(page).getByRole("alert").textContent).toContain(
      "You do not have permission to do this (customers:read).",
    );
    expect(api.sent(LIST)).toHaveLength(0);
  });
});

describe("/customers/[customerId]", () => {
  it("[OAD-012 AC2] lists the customer's bookings through console.bookings.list({ customerId })", async () => {
    detailAnswers(customer(), [
      booking(),
      booking({
        id: "bkg_01JA5AC9K2M4P6R8T0V2X4Z6B8",
        reference: "VX4M9T",
        status: "cancelled",
        recordLocator: null,
      }),
    ]);

    const page = await renderDetail();

    // The account once, then the bookings of this customer, in the environment of the switch.
    expect(api.requests.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
      "GET /v1/console/auth/me",
      GET,
      BOOKINGS,
    ]);
    const list = onlyRequest(BOOKINGS);
    expect(queryObject(list)).toEqual({ customerId: CUSTOMER_ID, limit: "25" });
    expect(list.headers.get("X-Velexis-Environment")).toBe("test");
    expect(onlyRequest(GET).headers.get("X-Velexis-Environment")).toBe("test");

    const bookings = within(page).getByRole("region", { name: "Bookings" });
    expect(bookings.textContent).toContain(
      "Every booking of this customer in the test environment, newest first.",
    );
    const rows = rowsOf(bookings, "Bookings");
    expect(rows.map((row) => row[0])).toEqual(["VX7K2Q", "VX4M9T"]);
    expect(hrefOf(bookings, "VX7K2Q")).toBe("/bookings/bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2");
    // The bookings list filtered by this customer.
    expect(hrefOf(bookings, "Open in the bookings list")).toBe(`/bookings?customerId=${CUSTOMER_ID}`);
    // One page only: no paging links.
    expect(within(bookings).queryByRole("navigation", { name: "Pages" })).toBeNull();
  });

  it("[OAD-012 AC2] pages the customer's bookings with the API's cursor and the URL's page size", async () => {
    detailAnswers(customer(), [booking()], "cur_bookings_2");
    let page = await renderDetail(CUSTOMER_ID, "limit=10");
    expect(queryObject(onlyRequest(BOOKINGS))).toEqual({ customerId: CUSTOMER_ID, limit: "10" });
    let pages = within(page).getByRole("navigation", { name: "Pages" });
    expect(hrefOf(pages, "Next page")).toBe(`/customers/${CUSTOMER_ID}?limit=10&cursor=cur_bookings_2`);

    api = fakeOtaApi();
    vi.stubGlobal("fetch", api.fetch);
    detailAnswers(customer(), [booking({ reference: "VX2B8D" })], null);
    page = await renderDetail(CUSTOMER_ID, "limit=10&cursor=cur_bookings_2");
    expect(queryObject(onlyRequest(BOOKINGS))).toEqual({
      customerId: CUSTOMER_ID,
      cursor: "cur_bookings_2",
      limit: "10",
    });
    pages = within(page).getByRole("navigation", { name: "Pages" });
    expect(hrefOf(pages, "First page")).toBe(`/customers/${CUSTOMER_ID}?limit=10`);
  });

  it("[OAD-012] shows the account, its counts and its statistics in the environment of the switch", async () => {
    detailAnswers();

    const page = await renderDetail();

    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe("Anna Berg");
    expect(page.textContent).toContain(CUSTOMER_ID);
    expect(page.textContent).toContain(
      "Opening a customer is recorded in the staff actions (GDPR access log).",
    );
    expect(factsOf(page, "Account")).toEqual({
      "E-mail": "anna.berg@example.com",
      "E-mail verified": `Yes, ${formatInstant("2025-05-14T18:05:40Z", TIME_ZONE)}`,
      "New e-mail awaiting confirmation": "None",
      Phone: "+46 701234567 (mobile)",
      "Date of birth": "1988-04-12",
      "Marketing consent": `Given at sign-up, ${formatInstant("2025-05-14T18:02:11Z", TIME_ZONE)}`,
      "Terms accepted": "2025-03",
      "Last sign-in": formatInstant("2026-10-10T09:12:00Z", TIME_ZONE),
      "Signed up": formatInstant("2025-05-14T18:02:11Z", TIME_ZONE),
      "Last change": formatInstant("2026-10-10T09:12:00Z", TIME_ZONE),
      "Saved travellers": "2",
      "Active sessions": "1",
    });
    const statistics = within(page).getByRole("region", { name: "Statistics" });
    expect(statistics.textContent).toContain("Bookings of this customer in the test environment");
    expect(factsOf(page, "Statistics")).toEqual({
      Bookings: "3",
      "Upcoming trips": "1",
      "Cancelled bookings": "1",
      "Total spent": "€2,890.40",
      "Total refunded": "€310.00",
      "Last booking": formatInstant("2026-10-10T09:20:41Z", TIME_ZONE),
    });
    expect(hrefOf(page, "All customers")).toBe("/customers");
  });

  it("[OAD-012] shows a deleted customer as deleted with what the API returns and nothing more", async () => {
    const result = deletedCustomer();
    detailAnswers(result, [
      booking({
        customer: { id: DELETED_ID, email: result.customer.email, firstName: null, lastName: null },
      }),
    ]);

    const page = await renderDetail(DELETED_ID);

    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe("Deleted account");
    expect(page.querySelector('[data-status="deleted"]')?.textContent).toBe("Deleted");
    expect(within(page).getByRole("note").textContent).toContain("This account was deleted.");
    expect(factsOf(page, "Account")).toMatchObject({
      "E-mail": "deleted-3h7pw2kr9sv4xb6nq1@deleted.invalid",
      "E-mail verified": "No",
      "New e-mail awaiting confirmation": "None",
      Phone: "None",
      "Date of birth": "None",
      "Last sign-in": "None",
    });
    // Its bookings stay, and nothing else is read to fill the gaps.
    expect(rowsOf(within(page).getByRole("region", { name: "Bookings" }), "Bookings")).toHaveLength(1);
    expect(api.requests.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
      "GET /v1/console/auth/me",
      GET_DELETED,
      BOOKINGS,
    ]);
  });

  it("[OAD-012] renders an unknown customer and an id that is not one as not found, inside the shell", async () => {
    api.on(GET, () => apiError("NOT_FOUND", 404));
    let page = await renderDetail();
    let alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("Customer not found");
    expect(hrefOf(alert, "All customers")).toBe("/customers");
    expect(api.sent(BOOKINGS)).toHaveLength(0);

    api = fakeOtaApi();
    vi.stubGlobal("fetch", api.fetch);
    page = await renderDetail("bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2");
    alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("Customer not found");
    expect(api.requests.map((request) => request.url.pathname)).toEqual(["/v1/console/auth/me"]);
  });

  it("names a page of bookings the API would refuse in its section, and still shows the account", async () => {
    detailAnswers();
    const page = await renderDetail(CUSTOMER_ID, "limit=500&cursor=a&cursor=b");

    expect(api.sent(BOOKINGS)).toHaveLength(0);
    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe("Anna Berg");
    const bookings = within(page).getByRole("region", { name: "Bookings" });
    const alert = within(bookings).getByRole("alert");
    expect(alert.textContent).toContain("Not valid: Page, Page size.");
    expect(hrefOf(alert, "First page")).toBe(`/customers/${CUSTOMER_ID}`);
  });

  it("redirects an expired session to /auth/refresh back to this customer and page, and an ended one to the portal", async () => {
    api.on(GET, () => apiError("TOKEN_EXPIRED", 401));
    let next = new URLSearchParams({ next: `/customers/${CUSTOMER_ID}` }).toString();
    expect(await redirectOf(() => renderDetail())).toBe(`/auth/refresh?${next}`);

    detailAnswers();
    api.on(BOOKINGS, () => apiError("TOKEN_EXPIRED", 401));
    next = new URLSearchParams({ next: `/customers/${CUSTOMER_ID}?cursor=cur_2` }).toString();
    expect(await redirectOf(() => renderDetail(CUSTOMER_ID, "cursor=cur_2"))).toBe(`/auth/refresh?${next}`);

    api.on(GET, () => apiError("STAFF_MEMBERSHIP_INACTIVE", 403));
    expect(await redirectOf(() => renderDetail())).toBe(`${TEST_PORTAL_URL}/console?tenant=${TENANT_ID}`);
  });

  it("renders the API's refusals on the server with the request id: the customer's page-wide, the bookings' in their section", async () => {
    api.on(GET, () => apiError("INTERNAL_ERROR", 500));
    let page = await renderDetail();
    let alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("The customer could not be loaded");
    expect(alert.textContent).toContain("req_fake_1");
    expect(hrefOf(alert, "Try again")).toBe(`/customers/${CUSTOMER_ID}`);
    expect(api.sent(BOOKINGS)).toHaveLength(0);

    api = fakeOtaApi();
    vi.stubGlobal("fetch", api.fetch);
    detailAnswers();
    api.on(BOOKINGS, () => rateLimited());
    page = await renderDetail();
    expect(factsOf(page, "Account")["E-mail"]).toBe("anna.berg@example.com");
    alert = within(within(page).getByRole("region", { name: "Bookings" })).getByRole("alert");
    expect(alert.textContent).toContain("The bookings could not be loaded");
    expect(alert.textContent).toContain("Too many requests, retry in 60 s.");
    expect(hrefOf(alert, "Try again")).toBe(`/customers/${CUSTOMER_ID}`);
  });

  it("renders a role without customers:read as a state, and one without bookings:read without the bookings", async () => {
    api.on("GET /v1/console/auth/me", () =>
      Response.json({ ...staffProfile({ role: "viewer" }), permissions: ["bookings:read"] }),
    );
    let page = await renderDetail();
    expect(within(page).getByRole("alert").textContent).toContain(
      "You do not have permission to do this (customers:read).",
    );
    expect(api.sent(GET)).toHaveLength(0);

    api = fakeOtaApi();
    vi.stubGlobal("fetch", api.fetch);
    detailAnswers();
    api.on("GET /v1/console/auth/me", () =>
      Response.json({ ...staffProfile({ role: "viewer" }), permissions: ["customers:read"] }),
    );
    page = await renderDetail();
    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe("Anna Berg");
    expect(
      within(within(page).getByRole("region", { name: "Bookings" })).getByRole("alert").textContent,
    ).toContain("You do not have permission to do this (bookings:read).");
    expect(api.sent(BOOKINGS)).toHaveLength(0);
  });
});
