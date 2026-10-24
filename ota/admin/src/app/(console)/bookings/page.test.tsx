// The bookings list as Next.js renders it on the server (OAD-006): the real page, `getConsoleRequest` and the SDK
// against the fake OTA API (the SDK's `fetch`), rendered to HTML and queried in a detached happy-dom document (a
// server-mode SDK client refuses to run in a browser-like test environment, rightly). What the filters write to the
// URL in the browser is tested in filters.test.tsx; this file checks what the page sends for a URL and what it shows.
import type { ConsoleBookingSummary, ConsoleStaffProfile } from "@velexis/ota-sdk";
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
  rateLimited,
  redirectOf,
  staffAccessToken,
  staffProfile,
  type FakeOtaApi,
  type SentRequest,
} from "@/test/fake-ota-api";

// ---- Mocks: the request scope and navigation of Next.js and the configuration ------------------------------------

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
const navigation = vi.hoisted(() => ({ searchParams: new URLSearchParams() }));
vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));
vi.mock("next/headers", () => nextHeaders);
vi.mock("next/navigation", async () => {
  const { fakeRedirect } = await import("@/test/fake-ota-api");
  return {
    usePathname: () => "/bookings",
    useSearchParams: () => navigation.searchParams,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
    redirect: fakeRedirect,
  };
});

import {
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from "@/lib/session";

import BookingsPage from "./page";
import { bookingsHref, filterValuesOf } from "./views";

const LIST = "GET /v1/console/bookings";
const HOUR = 3_600_000;

let api: FakeOtaApi;
let sequence = 0;

/** The cookies of a signed-in staff member. */
function signedIn(): void {
  sequence += 1;
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`bookings-${sequence}`, Date.now(), 900),
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-bookings-${sequence}`,
      [ENVIRONMENT_COOKIE]: "test",
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
}

/** A row of `console.bookings.list` (dummy data). */
function summary(overrides: Partial<ConsoleBookingSummary> = {}): ConsoleBookingSummary {
  return {
    id: "bkg_01JA4D9X2Z5C8F1H4K7N0Q3T6W",
    reference: "VX3L8R",
    status: "confirmed",
    channel: "storefront",
    environment: "test",
    recordLocator: "T5N2KD",
    amadeusOrderId: "eJzTd9cPNfX09DUFAAsGAkU",
    customer: {
      id: "cus_8f3K2mQ9xT4vB7nL",
      email: "anna.berg@example.com",
      firstName: "Anna",
      lastName: "Berg",
    },
    isGuest: false,
    leadTravelerName: "ANNA BERG",
    travelersCount: 2,
    tripType: "round_trip",
    originCode: "CDG",
    destinationCode: "JFK",
    departureAt: "2026-11-20T10:25:00",
    returnAt: "2026-11-27T18:30:00",
    validatingCarrier: "AF",
    ticketingStatus: "failed",
    ticketingDeadlineAt: "2026-10-13T21:59:00Z",
    paymentStatus: "authorized",
    total: { amount: "1414.06", currency: "EUR" },
    net: { amount: "1310.56", currency: "EUR" },
    markup: { amount: "71.00", currency: "EUR" },
    syncStatus: "fresh",
    lastSyncedAt: "2026-10-10T09:20:52Z",
    hasScheduleChange: false,
    tags: ["vip"],
    createdByStaffId: null,
    createdAt: "2026-10-09T18:02:13Z",
    cancelledAt: null,
    ...overrides,
  } as ConsoleBookingSummary;
}

/** `console.bookings.list` answers one page. */
function listAnswers(
  data: ConsoleBookingSummary[],
  page: { nextCursor: string | null; totalCount?: number | null } = { nextCursor: null },
): void {
  const { nextCursor, ...rest } = page;
  api.on(LIST, () =>
    Response.json(
      { data, page: { nextCursor, limit: 25 }, ...rest },
      { headers: { "X-Request-Id": "req_list" } },
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

/** The page for the URL `/bookings?<search>`, rendered to HTML on the "server" and parsed into a document. */
async function renderPage(search = ""): Promise<HTMLElement> {
  navigation.searchParams = new URLSearchParams(search);
  const element = await BookingsPage({ searchParams: Promise.resolve(searchParamsOf(search)) });
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(element);
  return document.body as unknown as HTMLElement;
}

/** The query `console.bookings.list` received last, as name → value. */
function lastListQuery(): Record<string, string> {
  const request: SentRequest | undefined = api.sent(LIST).at(-1);
  if (request === undefined) {
    throw new Error("console.bookings.list was not called");
  }
  return Object.fromEntries(request.url.searchParams);
}

// Once per file: the first server render of the page (React DOM server, the filters, the data table, next/link) and
// the SDK's first calls are the slowest in a fresh worker; on a busy CI runner they would otherwise land in the first
// test's own five seconds.
beforeAll(async () => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers());
  signedIn();
  listAnswers([summary()], { nextCursor: "c_warm", totalCount: 1 });
  await renderPage("status=confirmed");
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

describe("/bookings", () => {
  it("[OAD-006 AC1] sends the URL's filters, sort, cursor and page size, and a changed filter changes the request", async () => {
    listAnswers([summary()]);
    const search =
      "status=confirmed&status=partially_ticketed&ticketingStatus=failed&q=berg&sort=ticketingDeadline&cursor=c_2&limit=50";

    await renderPage(search);

    expect(lastListQuery()).toEqual({
      status: "confirmed,partially_ticketed",
      ticketingStatus: "failed",
      q: "berg",
      sort: "ticketingDeadline",
      cursor: "c_2",
      limit: "50",
    });
    const sent = api.sent(LIST)[0];
    expect(sent?.headers.get("X-Velexis-Environment")).toBe("test");
    expect(sent?.headers.get("Authorization")).toMatch(/^Bearer /);

    // The filter component writes the next URL with bookingsHref (filters.test.tsx): a payment status added, the
    // cursor gone. The page sends what that URL says.
    const query = new URLSearchParams(search);
    const next = bookingsHref(query, { ...filterValuesOf(query), paymentStatus: ["authorized"] });
    expect(next).toBe(
      "/bookings?limit=50&q=berg&status=confirmed&status=partially_ticketed&ticketingStatus=failed&paymentStatus=authorized&sort=ticketingDeadline",
    );
    await renderPage(next.split("?")[1]);

    expect(api.sent(LIST)).toHaveLength(2);
    expect(lastListQuery()).toEqual({
      status: "confirmed,partially_ticketed",
      ticketingStatus: "failed",
      paymentStatus: "authorized",
      q: "berg",
      sort: "ticketingDeadline",
      limit: "50",
    });
  });

  it("[OAD-006 AC1] sends the needs-attention filters, the deadline window from now and the created days of the OTA", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    listAnswers([]);

    await renderPage(
      "reconcileOutcome=manual_review&cancellationRequested=true&hasScheduleChange=false&deadlineWithin=24h&createdFrom=2026-10-01&createdTo=2026-10-31",
    );

    expect(lastListQuery()).toEqual({
      limit: "25",
      reconcileOutcome: "manual_review",
      cancellationRequested: "true",
      hasScheduleChange: "false",
      ticketingDeadlineBefore: new Date(Date.now() + 24 * HOUR).toISOString(),
      // Days in the OTA's time zone (Europe/Oslo): CEST on 1 October, CET on 31 October.
      createdFrom: "2026-09-30T22:00:00.000Z",
      createdTo: "2026-10-31T23:00:00.000Z",
    });
  });

  it("[OAD-006 AC2] links the next page with page.nextCursor and the filters kept, and shows totalCount", async () => {
    listAnswers([summary()], { nextCursor: "c_3", totalCount: 37 });

    const page = await renderPage("status=confirmed&limit=50");

    const pages = within(page).getByRole("navigation", { name: "Pages" });
    expect(within(pages).getByRole("link", { name: "Next page" }).getAttribute("href")).toBe(
      "/bookings?status=confirmed&limit=50&cursor=c_3",
    );
    expect(within(pages).queryByRole("link", { name: "First page" })).toBeNull();
    expect(within(page).getByText("37 in total")).toBeTruthy();
  });

  it("[OAD-006 AC2] shows 10,000+ for a null totalCount, no total without one, and the first page from a later one", async () => {
    listAnswers([summary()], { nextCursor: null, totalCount: null });
    let page = await renderPage("cursor=c_3");
    expect(within(page).getByText("10,000+ in total")).toBeTruthy();
    expect(within(page).getByRole("link", { name: "First page" }).getAttribute("href")).toBe("/bookings");
    expect(within(page).queryByRole("link", { name: "Next page" })).toBeNull();

    listAnswers([summary()], { nextCursor: "c_4" });
    page = await renderPage();
    expect(within(page).queryByText(/in total$/)).toBeNull();
    expect(within(page).getByRole("link", { name: "Next page" }).getAttribute("href")).toBe(
      "/bookings?cursor=c_4",
    );
  });

  it("[OAD-006 AC2] pages a deadline window from the time of its first page, so the API takes the next cursor", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const opened = Date.now();
    const view = "status=confirmed&status=partially_ticketed&sort=ticketingDeadline&deadlineWithin=24h";
    listAnswers([summary()], { nextCursor: "c_2", totalCount: 30 });

    let page = await renderPage(view);
    const firstRequest = lastListQuery();
    expect(firstRequest["ticketingDeadlineBefore"]).toBe(new Date(opened + 24 * HOUR).toISOString());
    const next = within(page).getByRole("link", { name: "Next page" }).getAttribute("href") ?? "";
    expect(next).toBe(
      `/bookings?${view}&asOf=${encodeURIComponent(new Date(opened).toISOString())}&cursor=c_2`,
    );

    // Staff work the first page for a while. The API binds its cursor to the filters of the first page
    // (`ticketingDeadlineBefore` included), so the next page must send exactly those, with the cursor.
    vi.setSystemTime(opened + 7 * 60_000);
    listAnswers([summary({ id: "bkg_01JA4D9X2Z5C8F1H4K7N0Q3T6X", reference: "VX9P2Q" })], {
      nextCursor: null,
    });
    page = await renderPage(next.split("?")[1]);

    expect(lastListQuery()).toEqual({ ...firstRequest, cursor: "c_2" });
    // Still the saved view; "First page" counts the window from now again.
    const views = within(page).getByRole("navigation", { name: "Saved views" });
    expect(
      within(views).getByRole("link", { name: "Deadline within 24 h" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(within(page).getByRole("link", { name: "First page" }).getAttribute("href")).toBe(
      `/bookings?${view}`,
    );

    // A pinned time later than the request's own is not taken: a link cannot widen the window.
    await renderPage(
      `${view}&asOf=${encodeURIComponent(new Date(opened + 48 * HOUR).toISOString())}&cursor=c_2`,
    );
    expect(lastListQuery()["ticketingDeadlineBefore"]).toBe(new Date(Date.now() + 24 * HOUR).toISOString());
  });

  it("renders the columns of routes.md §3.1 and sends the browser nothing else of a row", async () => {
    listAnswers([
      summary(),
      summary({
        id: "bkg_01JA4D9X2Z5C8F1H4K7N0Q3T6X",
        reference: "VX9P2Q",
        status: "pending",
        channel: "import",
        recordLocator: null,
        isGuest: true,
        customer: null,
        travelersCount: 1,
        tripType: "one_way",
        ticketingStatus: "pending",
        ticketingDeadlineAt: null,
        paymentStatus: "not_applicable",
        hasScheduleChange: true,
      }),
    ]);

    const page = await renderPage();

    const table = within(page).getByRole("table", { name: "Bookings" });
    const [header, first, second] = within(table).getAllByRole("row");
    expect(
      within(header as HTMLElement)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual([
      "Reference",
      "Record locator",
      "Travellers",
      "Route and departure",
      "Status",
      "Ticketing",
      "Payment",
      "Total",
      "Channel",
      "Created",
    ]);
    const cells = (row: HTMLElement | undefined) =>
      within(row as HTMLElement)
        .getAllByRole("cell")
        .map((cell) => cell.textContent);
    const [reference, locator, travelers, route, status, ticketing, payment, total, channel] = cells(first);
    expect(reference).toBe("VX3L8R");
    expect(
      within(first as HTMLElement)
        .getByRole("link", { name: "VX3L8R" })
        .getAttribute("href"),
    ).toBe("/bookings/bkg_01JA4D9X2Z5C8F1H4K7N0Q3T6W");
    expect(locator).toBe("T5N2KD");
    expect(travelers).toBe("ANNA BERG+1 more");
    expect(route).toContain("CDG → JFK");
    expect(route).toContain("Return");
    expect(status).toBe("Confirmed");
    expect(ticketing).toContain("Issuing failed");
    expect(ticketing).toContain("Deadline");
    expect(payment).toBe("Authorised");
    expect(total).toBe("€1,414.06Net €1,310.56Markup €71.00");
    expect(channel).toBe("Storefront");
    expect(
      within(first as HTMLElement)
        .getAllByRole("cell")[9]
        ?.querySelector("time")
        ?.getAttribute("datetime"),
    ).toBe("2026-10-09T18:02:13Z");

    const [, guestLocator, guestTravelers, , guestStatus, guestTicketing, guestPayment, , guestChannel] =
      cells(second);
    expect(cells(second)[0]).toBe("VX9P2QGuest booking");
    expect(guestLocator).toBe("None yet");
    expect(guestTravelers).toBe("ANNA BERG");
    expect(guestStatus).toBe("PendingSchedule changed");
    expect(guestTicketing).toBe("Not issued");
    expect(guestPayment).toBe("Not applicable");
    expect(guestChannel).toBe("Imported");

    // The customer's e-mail address, the order id and the tags are not shown, so they never reach the browser.
    expect(page.innerHTML).not.toContain("anna.berg@example.com");
    expect(page.innerHTML).not.toContain("eJzTd9cPNfX09DUFAAsGAkU");
  });

  it("shows the saved views and the empty message of the current one", async () => {
    listAnswers([]);

    const page = await renderPage("ticketingStatus=failed&ticketingStatus=manual_review");

    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe("Bookings");
    const views = within(page).getByRole("navigation", { name: "Saved views" });
    expect(within(views).getByRole("link", { name: "Ticketing problems" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(within(page).getByText("No booking has a ticketing problem.")).toBeTruthy();

    listAnswers([]);
    expect(within(await renderPage("q=nobody")).getByText("No booking matches these filters.")).toBeTruthy();
  });

  it("never sends a link whose parameters the API would refuse, and names them", async () => {
    listAnswers([summary()]);

    const page = await renderPage("status=lost&recordLocator=x&limit=500&cursor=c_2");

    expect(api.sent(LIST)).toHaveLength(0);
    const alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("Not valid: Status, Record locator, Page size.");
    // "Clear filters" drops the page size the API would refuse too.
    expect(within(alert).getByRole("link", { name: "Clear filters" }).getAttribute("href")).toBe("/bookings");
    // The filters stay on the page to correct the link.
    expect(within(page).getByRole("search", { name: "Booking filters" })).toBeTruthy();
  });

  it("redirects an expired session to /auth/refresh back to this list, and an ended one to the portal", async () => {
    api.on(LIST, () => apiError("TOKEN_EXPIRED", 401));
    const next = new URLSearchParams({ next: "/bookings?status=confirmed&cursor=c_2" }).toString();
    expect(await redirectOf(() => renderPage("status=confirmed&cursor=c_2"))).toBe(`/auth/refresh?${next}`);

    api.on(LIST, () => apiError("STAFF_MEMBERSHIP_INACTIVE", 403));
    expect(await redirectOf(() => renderPage())).toBe(`${TEST_PORTAL_URL}/console?tenant=${TENANT_ID}`);
  });

  it("renders the API's refusals on the server, in the console's words with the request id", async () => {
    api.on(LIST, () => apiError("FORBIDDEN", 403, { details: { requiredPermission: "bookings:read" } }));
    let page = await renderPage("status=confirmed");
    let alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("The bookings could not be loaded");
    expect(alert.textContent).toContain("You do not have permission to do this (bookings:read).");
    expect(alert.textContent).toContain("req_fake_1");
    expect(within(alert).getByRole("link", { name: "Try again" }).getAttribute("href")).toBe(
      "/bookings?status=confirmed",
    );
    expect(page.textContent).not.toContain("The API refused the request");

    api.on(LIST, () => rateLimited());
    page = await renderPage();
    expect(within(page).getByRole("alert").textContent).toContain("Too many requests, retry in 60 s.");

    api.on(LIST, () =>
      apiError("VALIDATION_FAILED", 400, { fieldErrors: [{ path: "/query/q", code: "minLength" }] }),
    );
    page = await renderPage("q=berg&limit=10");
    alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("Some values were not accepted.");
    expect(within(alert).getByRole("link", { name: "Clear filters" }).getAttribute("href")).toBe(
      "/bookings?limit=10",
    );
  });

  it("renders a failed staff profile and a role without bookings:read as states, without listing", async () => {
    api.on("GET /v1/console/auth/me", () =>
      apiError("SERVICE_UNAVAILABLE", 503, {}, { "Retry-After": "60" }),
    );
    let page = await renderPage();
    expect(within(page).getByRole("alert").textContent).toContain(
      "The OTA API is unavailable right now. Try again in a moment.",
    );

    const profile: ConsoleStaffProfile = {
      ...staffProfile({ role: "viewer" }),
      permissions: ["customers:read"],
    };
    api.on("GET /v1/console/auth/me", () => Response.json(profile));
    page = await renderPage();
    expect(within(page).getByRole("alert").textContent).toContain(
      "You do not have permission to do this (bookings:read).",
    );
    expect(api.sent(LIST)).toHaveLength(0);
  });
});
