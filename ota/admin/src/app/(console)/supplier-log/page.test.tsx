// The supplier log as Next.js renders it on the server (OAD-012): the real page, `getConsoleRequest` and the SDK
// against the fake OTA API (the SDK's `fetch`), rendered to HTML and queried in a detached happy-dom document. It checks
// what the page sends for a URL (the filters, the bodies only on demand, the cursor and the page size), what it shows
// (the redacted bodies exactly as the API returns them, in the JSON view) and the API's codes handled on the server.
import type { ConsoleSupplierRequest } from "@velexis/ota-sdk";
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

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));
vi.mock("next/headers", () => nextHeaders);
vi.mock("next/navigation", async () => {
  const { fakeRedirect } = await import("@/test/fake-ota-api");
  return {
    usePathname: () => "/supplier-log",
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
    redirect: fakeRedirect,
  };
});

import { formatInstant } from "@/app/(console)/bookings/views";
import { formatJson } from "@/components/json-view";
import {
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from "@/lib/session";

import SupplierLogPage from "./page";

const LIST = "GET /v1/console/supplier-requests";
const TIME_ZONE = "Europe/Oslo";
const CALL_ID = "sreq_01JA4CH4T9X2A5D8G1J4M7Q0U3";
const SEARCH_CALL_ID = "sreq_01JA4BZ8M1P4S7V0Y3B6E9H2K5";
const BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2";
const REQUEST_ID = "req_01JA4CH4T9X2A5D8G1J4M7Q0U4";

let api: FakeOtaApi;
let sequence = 0;

/** The cookies of a signed-in staff member. */
function signedIn(): void {
  sequence += 1;
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`supplier-log-${sequence}`, Date.now(), 900),
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-supplier-log-${sequence}`,
      [ENVIRONMENT_COOKIE]: "test",
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
}

/** The bodies of the issuance call as the API stored them: already redacted (dummy data). */
const REQUEST_BODY = {
  data: {
    type: "flight-order",
    formOfPayments: [{ creditCard: { brand: "VISA", number: "************4242" } }],
    contacts: [{ emailAddress: "a***@example.com", phones: [{ number: "*****4567" }] }],
  },
};
const RESPONSE_BODY = {
  errors: [{ status: 400, code: 9112, title: "INVALID FORM OF PAYMENT", detail: "<b>not</b> markup" }],
};

/** A logged call of `console.supplierRequests.list` (dummy data): a refused issuance of booking VX7K2Q by default. */
function call(overrides: Partial<ConsoleSupplierRequest> = {}): ConsoleSupplierRequest {
  return {
    id: CALL_ID,
    environment: "test",
    operation: "console.bookings.issue",
    amadeusApi: "FlightOrderIssue",
    amadeusOperationId: "issueFlightOrder",
    httpMethod: "POST",
    path: "/v1/booking/flight-orders/eJzTd9cPNfX09DUFAAsGAkQ/issuance",
    officeId: "OSLN12345",
    httpStatus: 400,
    outcome: "client_error",
    errorCodes: [9112],
    durationMs: 1840,
    correlationId: "0001A2B3C4D5",
    requestId: REQUEST_ID,
    bookingId: BOOKING_ID,
    searchId: null,
    staffId: "stf_01JBT6V2B3K8Q4M9N5P7R1T0VX",
    redacted: true,
    truncated: false,
    createdAt: "2026-10-10T09:21:03Z",
    ...overrides,
  };
}

/** A storefront search that timed out, without a booking, an office or a response. */
function searchCall(overrides: Partial<ConsoleSupplierRequest> = {}): ConsoleSupplierRequest {
  return call({
    id: SEARCH_CALL_ID,
    operation: "flights.search",
    amadeusApi: "FlightOffersSearch",
    amadeusOperationId: "searchFlightOffers",
    httpMethod: "POST",
    path: "/v2/shopping/flight-offers",
    officeId: null,
    httpStatus: null,
    outcome: "timeout",
    errorCodes: [],
    durationMs: null,
    correlationId: null,
    requestId: null,
    bookingId: null,
    staffId: null,
    createdAt: "2026-10-10T08:00:00Z",
    ...overrides,
  });
}

/** `console.supplierRequests.list` answers one page. */
function listAnswers(data: ConsoleSupplierRequest[], nextCursor: string | null = null): void {
  api.on(LIST, () =>
    Response.json({ data, page: { nextCursor, limit: 25 } }, { headers: { "X-Request-Id": "req_log" } }),
  );
}

/** The log for `?<search>`, rendered to HTML on the "server" and parsed into a document. */
async function renderPage(search = ""): Promise<HTMLElement> {
  const query = new URLSearchParams(search);
  const searchParams: Record<string, string | string[]> = {};
  for (const name of new Set(query.keys())) {
    const values = query.getAll(name);
    searchParams[name] = values.length === 1 ? (values[0] ?? "") : values;
  }
  const element = await SupplierLogPage({ searchParams: Promise.resolve(searchParams) });
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(element);
  return document.body as unknown as HTMLElement;
}

/** The one list request. */
function listRequest(): SentRequest {
  const sent = api.sent(LIST);
  expect(sent).toHaveLength(1);
  return sent[0] as SentRequest;
}

/** The query of a request as a plain object. */
function queryObject(request: SentRequest): Record<string, string> {
  return Object.fromEntries(request.url.searchParams);
}

/** The texts of the cells of the table's body rows. */
function rowsOf(page: HTMLElement): string[][] {
  const table = within(page).getByRole("table", { name: "Amadeus calls" });
  return [...table.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? ""),
  );
}

/** The `href` of the link named `name`. */
function hrefOf(scope: HTMLElement, name: string): string | null {
  return within(scope).getByRole("link", { name }).getAttribute("href");
}

// Once per file: the first server render of the page and the SDK's first calls are the slowest in a fresh worker; on
// a busy CI runner they would otherwise land in the first test's own five seconds.
beforeAll(async () => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers());
  signedIn();
  listAnswers([call(), searchCall()]);
  await renderPage("includeBodies=true");
  vi.unstubAllGlobals();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers({ "User-Agent": "Mozilla/5.0 Test" }));
  signedIn();
});

describe("/supplier-log", () => {
  it("[OAD-012] lists the environment's Amadeus calls newest first: time, API and operation, request, result, duration, related", async () => {
    listAnswers([call(), searchCall()]);

    const page = await renderPage();

    // No bodies unless asked for.
    expect(queryObject(listRequest())).toEqual({ limit: "25" });
    expect(listRequest().headers.get("X-Velexis-Environment")).toBe("test");
    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe("Supplier log");
    expect(page.textContent).toContain("Every Amadeus call made for this OTA in the test environment");
    const headers = [...page.querySelectorAll("thead th")].map((cell) => cell.textContent);
    expect(headers).toEqual(["Time", "Call", "Request", "Result", "Duration", "Related"]);
    expect(rowsOf(page)).toEqual([
      [
        formatInstant("2026-10-10T09:21:03Z", TIME_ZONE),
        "Flight Order IssueissueFlightOrderconsole.bookings.issue",
        "POST /v1/booking/flight-orders/eJzTd9cPNfX09DUFAAsGAkQ/issuanceOffice OSLN12345",
        "Refused by AmadeusHTTP 400Amadeus errors 9112",
        "1,840 ms",
        `Booking ${BOOKING_ID}Request id ${REQUEST_ID}Amadeus request id 0001A2B3C4D5`,
      ],
      [
        formatInstant("2026-10-10T08:00:00Z", TIME_ZONE),
        "Flight Offers SearchsearchFlightOffersflights.search",
        "POST /v2/shopping/flight-offers",
        "Timed outNo response",
        "None",
        "",
      ],
    ]);
    expect(hrefOf(page, BOOKING_ID)).toBe(`/bookings/${BOOKING_ID}`);
    expect(page.querySelector("pre")).toBeNull();
    expect(hrefOf(page, "Show the redacted bodies")).toBe("/supplier-log?includeBodies=true");
    expect(within(page).queryByRole("navigation", { name: "Pages" })).toBeNull();
  });

  it("[OAD-012] sends the URL's filters: APIs and outcomes OR-ed, status, error code, booking, request id and the days in the OTA's time zone", async () => {
    listAnswers([call()]);

    const page = await renderPage(
      `amadeusApi=FlightOrderIssue,FlightCreateOrders&outcome=client_error&outcome=server_error&httpStatus=400&errorCode=9112&bookingId=${BOOKING_ID}&requestId=${REQUEST_ID}&createdFrom=2026-10-01&createdTo=2026-10-31&limit=50`,
    );

    expect(queryObject(listRequest())).toEqual({
      // In the order of the document's enums, whatever the URL's order.
      amadeusApi: "FlightCreateOrders,FlightOrderIssue",
      outcome: "client_error,server_error",
      httpStatus: "400",
      errorCode: "9112",
      bookingId: BOOKING_ID,
      requestId: REQUEST_ID,
      // Oslo: the first of October starts at 22:00 UTC the day before (CEST); `createdTo` up to the end of its day
      // (CET from 25 October).
      createdFrom: "2026-09-30T22:00:00.000Z",
      createdTo: "2026-10-31T23:00:00.000Z",
      limit: "50",
    });

    const form = within(page).getByRole("search", { name: "Supplier log filters" }) as HTMLFormElement;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/supplier-log");
    const checked = [...form.querySelectorAll<HTMLInputElement>("input[type=checkbox]")]
      .filter((input) => input.hasAttribute("checked"))
      .map((input) => `${input.name}=${input.value}`);
    expect(checked).toEqual([
      "amadeusApi=FlightCreateOrders",
      "amadeusApi=FlightOrderIssue",
      "outcome=client_error",
      "outcome=server_error",
    ]);
    const value = (name: string) => form.querySelector(`input[name="${name}"]`)?.getAttribute("value");
    expect(value("httpStatus")).toBe("400");
    expect(value("errorCode")).toBe("9112");
    expect(value("bookingId")).toBe(BOOKING_ID);
    expect(value("requestId")).toBe(REQUEST_ID);
    expect(value("createdTo")).toBe("2026-10-31");
    expect(value("limit")).toBe("50");
    expect(hrefOf(form, "Clear filters")).toBe("/supplier-log?limit=50");
  });

  it("[OAD-012] shows the redacted bodies only on demand, exactly as the API returns them, in collapsed JSON views", async () => {
    listAnswers([
      call({ requestBody: REQUEST_BODY, responseBody: RESPONSE_BODY }),
      searchCall({ requestBody: null, responseBody: null, truncated: true }),
    ]);

    const page = await renderPage("outcome=client_error&includeBodies=true");

    // With bodies the API serves 20 calls a page.
    expect(queryObject(listRequest())).toEqual({
      outcome: "client_error",
      includeBodies: "true",
      limit: "20",
    });
    expect(page.textContent).toContain(
      "Bodies are shown as the API returns them: card numbers, security codes, document numbers, e-mail addresses and phone numbers were masked before storage.",
    );
    const request = within(page).getByRole("region", { name: `Request body of ${CALL_ID}` });
    const response = within(page).getByRole("region", { name: `Response body of ${CALL_ID}` });
    // The stored, redacted bodies as they came: nothing added, nothing removed, and text never markup.
    expect(request.textContent).toBe(formatJson(REQUEST_BODY));
    expect(response.textContent).toBe(formatJson(RESPONSE_BODY));
    expect(response.querySelector("b")).toBeNull();
    for (const details of page.querySelectorAll("details")) {
      if (details.querySelector("pre") !== null) {
        expect(details.hasAttribute("open")).toBe(false);
      }
    }
    const bodies = within(page).getByRole("group", {
      name: `Bodies of the Flight Order Issue call at ${formatInstant("2026-10-10T09:21:03Z", TIME_ZONE)}`,
    });
    expect(bodies.textContent).toContain("Redacted before storage.");
    // A call without bodies says so; a truncated one says it was cut.
    const searchBodies = within(page).getByRole("group", {
      name: `Bodies of the Flight Offers Search call at ${formatInstant("2026-10-10T08:00:00Z", TIME_ZONE)}`,
    });
    expect(searchBodies.textContent).toContain(
      "Truncated: a body above 64 KB is stored cut, with its size and its first part.",
    );
    expect(searchBodies.textContent).toContain("Nothing to show.");
    // The form's checkbox is on; hiding them keeps the filters.
    expect(page.querySelector('input[name="includeBodies"][value="true"]')?.hasAttribute("checked")).toBe(
      true,
    );
    expect(hrefOf(page, "Hide the bodies")).toBe("/supplier-log?outcome=client_error");
  });

  it("[OAD-012] refuses a page size above 20 with the bodies before any call, and drops it when the bodies are asked for", async () => {
    let page = await renderPage("includeBodies=true&limit=50");
    expect(api.sent(LIST)).toHaveLength(0);
    const alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("Not valid: Page size (at most 20 with the bodies).");

    listAnswers([call()]);
    page = await renderPage("outcome=timeout&limit=50");
    expect(queryObject(listRequest())).toEqual({ outcome: "timeout", limit: "50" });
    expect(hrefOf(page, "Show the redacted bodies")).toBe("/supplier-log?outcome=timeout&includeBodies=true");
  });

  it("[OAD-012] pages with the API's cursor, keeping the filters and the bodies, and back to the first page", async () => {
    listAnswers([call()], "cur_page2");
    let page = await renderPage("outcome=client_error&includeBodies=true");
    let pages = within(page).getByRole("navigation", { name: "Pages" });
    expect(within(pages).queryByRole("link", { name: "First page" })).toBeNull();
    expect(hrefOf(pages, "Next page")).toBe(
      "/supplier-log?outcome=client_error&includeBodies=true&cursor=cur_page2",
    );

    api = fakeOtaApi();
    vi.stubGlobal("fetch", api.fetch);
    listAnswers([searchCall()], null);
    page = await renderPage("outcome=client_error&includeBodies=true&cursor=cur_page2");
    expect(queryObject(listRequest())).toEqual({
      outcome: "client_error",
      includeBodies: "true",
      cursor: "cur_page2",
      limit: "20",
    });
    pages = within(page).getByRole("navigation", { name: "Pages" });
    expect(hrefOf(pages, "First page")).toBe("/supplier-log?outcome=client_error&includeBodies=true");
    expect(within(pages).queryByRole("link", { name: "Next page" })).toBeNull();
    // Hiding the bodies keeps the position.
    expect(hrefOf(page, "Hide the bodies")).toBe("/supplier-log?outcome=client_error&cursor=cur_page2");
  });

  it("[OAD-012] names the parameters of a link the API would refuse, without a request", async () => {
    const page = await renderPage(
      "amadeusApi=Payments&outcome=timeout&httpStatus=99&errorCode=-1&bookingId=VX7K2Q&requestId=a%20b&createdFrom=2026-13-01&includeBodies=yes&cursor=a&cursor=b",
    );

    expect(api.sent(LIST)).toHaveLength(0);
    const alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("This link has filters the log cannot use");
    expect(alert.textContent).toContain(
      "Not valid: Amadeus API, HTTP status, Amadeus error code, Booking id, Request id, From, Bodies, Page. Change them above, or clear the filters.",
    );
    expect(hrefOf(alert, "Clear filters")).toBe("/supplier-log");
    const form = within(page).getByRole("search", { name: "Supplier log filters" });
    expect(form.querySelector('input[name="outcome"][value="timeout"]')?.hasAttribute("checked")).toBe(true);
  });

  it("[OAD-012] says when the environment has no calls, or none match the filters", async () => {
    listAnswers([]);
    let page = await renderPage();
    expect(rowsOf(page)).toEqual([["No Amadeus calls in this environment in the last 90 days."]]);

    page = await renderPage("outcome=network_error");
    expect(rowsOf(page)).toEqual([["No Amadeus call matches these filters."]]);
  });

  it("redirects an expired session to /auth/refresh back to this log, and an ended one to the portal", async () => {
    api.on(LIST, () => apiError("TOKEN_EXPIRED", 401));
    const next = new URLSearchParams({ next: "/supplier-log?includeBodies=true" }).toString();
    expect(await redirectOf(() => renderPage("includeBodies=true"))).toBe(`/auth/refresh?${next}`);

    api.on(LIST, () => apiError("UNAUTHENTICATED", 401));
    expect(await redirectOf(() => renderPage())).toBe(`${TEST_PORTAL_URL}/console?tenant=${TENANT_ID}`);
  });

  it("renders the API's refusals on the server, under the filters, with the request id", async () => {
    api.on(LIST, () =>
      apiError("VALIDATION_FAILED", 400, {
        fieldErrors: [{ path: "/query/cursor", code: "cursor_mismatch", message: "Not this list's cursor." }],
      }),
    );
    let page = await renderPage("outcome=timeout&cursor=stale");
    let alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("The supplier log could not be loaded");
    expect(alert.textContent).toContain("req_fake_1");
    expect(hrefOf(alert, "Try again")).toBe("/supplier-log?outcome=timeout&cursor=stale");
    expect(hrefOf(alert, "Clear filters")).toBe("/supplier-log");

    api.on(LIST, () => rateLimited());
    page = await renderPage();
    alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("Too many requests, retry in 60 s.");
    expect(within(alert).queryByRole("link", { name: "Clear filters" })).toBeNull();
    expect(page.textContent).not.toContain("The API refused the request");
  });

  it("renders a viewer, who has no supplier_requests:read, as a state without a request", async () => {
    api.on("GET /v1/console/auth/me", () => Response.json(staffProfile({ role: "viewer" })));
    const page = await renderPage();
    expect(within(page).getByRole("alert").textContent).toContain(
      "You do not have permission to do this (supplier_requests:read).",
    );
    expect(api.sent(LIST)).toHaveLength(0);
  });
});
