// The dashboard `/` as Next.js renders it on the server (OAD-005): the real page, `getConsoleRequest` and the SDK
// against the fake OTA API (the SDK's `fetch`), rendered to HTML and queried in a detached happy-dom document (a
// server-mode SDK client refuses to run in a browser-like test environment, rightly). It checks which tiles each role
// gets and which reads it sends (none for a tile it cannot read), that every count links the bookings list with the
// filters it counted (the list page itself sends the same filters for that link), what the tiles show, a read that
// fails in its tile's place, and the session's codes handled on the server.
import type { ConsoleBookingSummary, ConsolePayment, QueueSnapshot, StaffRole } from "@velexis/ota-sdk";
import { within } from "@testing-library/dom";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
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
const navigation = vi.hoisted(() => ({ pathname: "/", searchParams: new URLSearchParams() }));
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

import BookingsPage from "./bookings/page";
import DashboardPage from "./page";
import PaymentsPage from "./payments/page";

const ME = "GET /v1/console/auth/me";
const BOOKINGS = "GET /v1/console/bookings";
const PAYMENTS = "GET /v1/console/payments";
const SNAPSHOTS = "GET /v1/console/queue-snapshots";
const HOUR = 3_600_000;
const TIME_ZONE = "Europe/Oslo";
const OFFICE = "OSLN12345";
const BOOKING_ID = "bkg_01JA4D9X2Z5C8F1H4K7N0Q3T6W";
const PAYMENT_ID = "pay_01JA4CF7K0N3Q6S9V2X5Z8B1D4";
const OTHER_PAYMENT_ID = "pay_01JA4CF7K0N3Q6S9V2X5Z8B1D5";

/** The links of the three counts: the saved views of the bookings list (bookings/views.ts). */
const TICKETING_HREF = "/bookings?ticketingStatus=failed&ticketingStatus=manual_review";
const DEADLINE_HREF =
  "/bookings?status=confirmed&status=partially_ticketed&sort=ticketingDeadline&deadlineWithin=24h";
const RECONCILING_HREF = "/bookings?status=pending";

let api: FakeOtaApi;
let sequence = 0;

/** The cookies of a signed-in staff member. */
function signedIn(): void {
  sequence += 1;
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`dashboard-${sequence}`, Date.now(), 900),
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-dashboard-${sequence}`,
      [ENVIRONMENT_COOKIE]: "test",
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
}

/** `console.auth.me` of a staff member with `role`. */
function signedInAs(role: StaffRole): void {
  api.on(ME, () => Response.json(staffProfile({ role })));
}

/** A row of `console.bookings.list` (dummy data). */
function summary(overrides: Partial<ConsoleBookingSummary> = {}): ConsoleBookingSummary {
  return {
    id: BOOKING_ID,
    reference: "VX3L8R",
    status: "confirmed",
    channel: "storefront",
    environment: "test",
    recordLocator: "T5N2KD",
    amadeusOrderId: "eJzTd9cPNfX09DUFAAsGAkU",
    customer: null,
    isGuest: true,
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
    tags: [],
    createdByStaffId: null,
    createdAt: "2026-10-09T18:02:13Z",
    cancelledAt: null,
    ...overrides,
  };
}

const eur = (amount: string) => ({ amount, currency: "EUR" });

/** An authorised Stripe payment of `console.payments.list` (dummy data), of booking VX3L8R by default. */
function payment(overrides: Partial<ConsolePayment> = {}): ConsolePayment {
  return {
    id: PAYMENT_ID,
    checkoutId: "chk_01JA4CE5H8K1M4P7R0T3V6Y9B2",
    bookingId: BOOKING_ID,
    purpose: "booking",
    provider: "stripe",
    method: "card",
    status: "authorized",
    captureMethod: "manual",
    amount: eur("1414.06"),
    cardFee: null,
    amountAuthorized: eur("1414.06"),
    amountCaptured: eur("0.00"),
    amountRefunded: eur("0.00"),
    clientSecret: null,
    providerPublicKey: null,
    providerPaymentId: "pi_3Q9xK2LkdIwHu7ix1aBcDeFg",
    redirectUrl: null,
    nextAction: null,
    card: { brand: "VISA", last4: "4242", bin: "424242" },
    threeDSecure: { required: true, status: "authenticated", version: "2.2.0" },
    failure: null,
    createdAt: "2026-10-10T09:17:40Z",
    updatedAt: "2026-10-10T09:18:21Z",
    authorizedAt: "2026-10-10T09:18:21Z",
    capturedAt: null,
    cancelledAt: null,
    environment: "test",
    version: 2,
    events: [],
    refunds: [],
    booking: { id: BOOKING_ID, reference: "VX3L8R", status: "confirmed" },
    providerConnection: { accountMode: "velexis" },
    ...overrides,
  };
}

/** A stored read of queue 50 by the scheduled poller (dummy data). */
function snapshot(overrides: Partial<QueueSnapshot> = {}): QueueSnapshot {
  return {
    id: "qsn_01JA4E9X2A5D8G1J4M7P0S3V6Y",
    environment: "test",
    officeId: OFFICE,
    queueId: 50,
    category: 0,
    maxRequested: null,
    itemCount: 7,
    fetchedAt: "2026-10-10T09:45:00Z",
    fetchedBy: null,
    supplierRequestId: "sreq_01JA4E9X1Z4C7F0H3K6N9Q2T5W",
    warnings: [],
    ...overrides,
  };
}

/** A page answer of the fake API, with extra top-level fields (`totalCount`). */
function pageOf(
  data: unknown[],
  nextCursor: string | null = null,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json(
    { data, page: { nextCursor, limit: Math.max(data.length, 1) }, ...extra },
    { headers: { "X-Request-Id": "req_dashboard" } },
  );
}

/** Which count a `console.bookings.list` request is, by its filters; `undefined` for the latest bookings. */
function countOf(request: SentRequest): "ticketing" | "deadline" | "reconciling" | undefined {
  const query = request.url.searchParams;
  if (query.get("limit") !== "1") {
    return undefined;
  }
  if (query.has("ticketingStatus")) {
    return "ticketing";
  }
  return query.has("ticketingDeadlineBefore") ? "deadline" : "reconciling";
}

/** What each count answers: its `totalCount` (`null` above 10 000, `undefined`: none), or a response of its own. */
type CountAnswer = number | null | undefined | (() => Response);

/** `console.bookings.list` answers the counts and the latest bookings. */
function bookingsAnswer(
  counts: Readonly<Record<"ticketing" | "deadline" | "reconciling", CountAnswer>>,
  latest: ConsoleBookingSummary[] = [summary()],
): void {
  api.on(BOOKINGS, (request) => {
    const count = countOf(request);
    if (count === undefined) {
      return pageOf(latest);
    }
    const answer = counts[count];
    if (typeof answer === "function") {
      return answer();
    }
    return answer === undefined
      ? pageOf([summary()], "cursor_more")
      : pageOf(answer === 0 ? [] : [summary()], answer === 0 ? null : "cursor_more", { totalCount: answer });
  });
}

/** Every read answers something: three counts, two authorised payments (more wait), the poller's last read. */
function everythingAnswers(): void {
  bookingsAnswer({ ticketing: 3, deadline: 1, reconciling: 0 });
  api.on(PAYMENTS, () =>
    pageOf(
      [
        payment(),
        payment({ id: OTHER_PAYMENT_ID, bookingId: null, booking: null, amountAuthorized: eur("99.90") }),
      ],
      "cursor_payments",
    ),
  );
  api.on(SNAPSHOTS, () => pageOf([snapshot()]));
}

/** The payments and the queue answer; the bookings are the test's own. */
function everythingAnswersButBookings(): void {
  api.on(PAYMENTS, () => pageOf([payment()]));
  api.on(SNAPSHOTS, () => pageOf([snapshot()]));
}

/** Renders `element` to HTML on the "server" and parses it into a document. */
function toDocument(element: ReactElement): HTMLElement {
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(element);
  return document.body as unknown as HTMLElement;
}

async function renderDashboard(): Promise<HTMLElement> {
  navigation.pathname = "/";
  navigation.searchParams = new URLSearchParams();
  return toDocument(await DashboardPage());
}

/** The search parameters of `href` as Next.js hands them to a page, after pointing the navigation mock at it. */
function navigateTo(href: string): Promise<Record<string, string | string[]>> {
  const url = new URL(href, "http://localhost:3002");
  navigation.pathname = url.pathname;
  navigation.searchParams = url.searchParams;
  const params: Record<string, string | string[]> = {};
  for (const name of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(name);
    params[name] = values.length === 1 ? (values[0] ?? "") : values;
  }
  return Promise.resolve(params);
}

/** The bookings list for a link of the dashboard. */
async function renderBookingsList(href: string): Promise<HTMLElement> {
  return toDocument(await BookingsPage({ searchParams: navigateTo(href) }));
}

/** The payments list for a link of the dashboard. */
async function renderPaymentsList(href: string): Promise<HTMLElement> {
  return toDocument(await PaymentsPage({ searchParams: navigateTo(href) }));
}

/** The query of a request, as name → value. */
function queryOf(request: SentRequest | undefined): Record<string, string> {
  if (request === undefined) {
    throw new Error("no such request");
  }
  return Object.fromEntries(request.url.searchParams);
}

/** The request of one count. */
function countRequest(count: "ticketing" | "deadline" | "reconciling"): SentRequest | undefined {
  return api.sent(BOOKINGS).find((request) => countOf(request) === count);
}

/** The card of a count. */
function countCard(page: HTMLElement, id: string): HTMLElement {
  const card = page.querySelector<HTMLElement>(`[data-count="${id}"]`);
  if (card === null) {
    throw new Error(`no count card ${id}`);
  }
  return card;
}

/** The tile named `name`, or `null`. */
function tile(page: HTMLElement, name: string): HTMLElement | null {
  return within(page).queryByRole("region", { name });
}

/** The tile named `name`. */
function getTile(page: HTMLElement, name: string): HTMLElement {
  return within(page).getByRole("region", { name });
}

// Once per file: the first server render of the dashboard and of the bookings and payments lists (React DOM server,
// the tables, next/link, the filters) and the SDK's first calls are the slowest in a fresh worker; on a busy CI runner
// they would otherwise land in the first test's own five seconds.
beforeAll(async () => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers());
  signedIn();
  everythingAnswers();
  await renderDashboard();
  await renderBookingsList(DEADLINE_HREF);
  await renderPaymentsList("/payments?status=authorized");
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

describe("/ (dashboard)", () => {
  it("[OAD-005 AC1] a finance user sees the payments but not the queues, and every count links its filters", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    signedInAs("finance");
    everythingAnswers();

    const page = await renderDashboard();

    // The tiles of finance's permissions; no queue tile and no queue request.
    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe("Dashboard");
    expect(tile(page, "Authorised, not captured")).not.toBeNull();
    expect(tile(page, "Last queue read")).toBeNull();
    expect(within(page).queryByRole("link", { name: "All queues" })).toBeNull();
    expect(api.sent(SNAPSHOTS)).toHaveLength(0);
    expect(api.sent(PAYMENTS).map(queryOf)).toEqual([{ status: "authorized", limit: "5" }]);

    // Each count asks the API for its filters with limit 1, and its card links the list with the same filters.
    expect(queryOf(countRequest("ticketing"))).toEqual({
      ticketingStatus: "failed,manual_review",
      limit: "1",
    });
    expect(queryOf(countRequest("deadline"))).toEqual({
      status: "confirmed,partially_ticketed",
      ticketingDeadlineBefore: new Date(Date.now() + 24 * HOUR).toISOString(),
      limit: "1",
    });
    expect(queryOf(countRequest("reconciling"))).toEqual({ status: "pending", limit: "1" });
    const attention = getTile(page, "Needs attention");
    const ticketing = countCard(attention, "ticketing-problems");
    expect(ticketing.tagName).toBe("A");
    expect(ticketing.getAttribute("href")).toBe(TICKETING_HREF);
    expect(ticketing.textContent).toContain("Ticketing failed or in manual review3bookings");
    expect(ticketing.getAttribute("data-attention")).toBe("true");
    const deadline = countCard(attention, "deadline-24h");
    expect(deadline.getAttribute("href")).toBe(DEADLINE_HREF);
    expect(deadline.textContent).toContain("Ticketing deadline within 24 h1booking");
    const reconciling = countCard(attention, "reconciling");
    expect(reconciling.getAttribute("href")).toBe(RECONCILING_HREF);
    expect(reconciling.textContent).toContain("Outcome unknown (reconciling)0bookings");
    expect(reconciling.getAttribute("data-attention")).toBe("false");
    expect(
      within(getTile(page, "Authorised, not captured"))
        .getByRole("link", { name: "All authorised payments" })
        .getAttribute("href"),
    ).toBe("/payments?status=authorized");
  });

  it("[OAD-005 AC1] the list a count links sends the very filters the count sent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    signedInAs("finance");
    everythingAnswers();
    const page = await renderDashboard();

    const counts = [
      {
        href: countCard(page, "ticketing-problems").getAttribute("href"),
        counted: countRequest("ticketing"),
      },
      { href: countCard(page, "deadline-24h").getAttribute("href"), counted: countRequest("deadline") },
      { href: countCard(page, "reconciling").getAttribute("href"), counted: countRequest("reconciling") },
    ].map(({ href, counted }) => ({ href: href ?? "", counted: queryOf(counted) }));
    for (const { href, counted } of counts) {
      api.requests.length = 0;
      await renderBookingsList(href);
      // The list pages and sorts its rows; the filters are the count's.
      const { limit: _listLimit, sort: _sort, ...listed } = queryOf(api.sent(BOOKINGS).at(-1));
      const { limit: _countLimit, ...filters } = counted;
      expect(listed, href).toEqual(filters);
    }
  });

  it("[OAD-005 AC1] reads and renders each tile only with its permission, for every role", async () => {
    const expected: Record<StaffRole, boolean> = {
      owner: true,
      admin: true,
      agent: true,
      finance: false,
      viewer: false,
    };
    for (const [role, queues] of Object.entries(expected) as [StaffRole, boolean][]) {
      api.requests.length = 0;
      signedInAs(role);
      everythingAnswers();

      const page = await renderDashboard();

      expect(tile(page, "Needs attention"), role).not.toBeNull();
      expect(tile(page, "Latest bookings"), role).not.toBeNull();
      expect(tile(page, "Authorised, not captured"), role).not.toBeNull();
      expect(tile(page, "Last queue read") !== null, role).toBe(queues);
      expect(api.sent(SNAPSHOTS).length, role).toBe(queues ? 1 : 0);
      expect(api.sent(BOOKINGS).length, role).toBe(4);
      expect(api.sent(PAYMENTS).length, role).toBe(1);
    }
  });

  it("sends no read for a permission the API did not grant, and says so when no tile is left", async () => {
    const profile = staffProfile({ role: "agent" });
    api.on(ME, () =>
      Response.json({
        ...profile,
        permissions: profile.permissions.filter((permission) => permission !== "bookings:read"),
      }),
    );
    everythingAnswers();

    let page = await renderDashboard();

    expect(tile(page, "Needs attention")).toBeNull();
    expect(tile(page, "Latest bookings")).toBeNull();
    expect(api.sent(BOOKINGS)).toHaveLength(0);
    expect(tile(page, "Authorised, not captured")).not.toBeNull();
    expect(tile(page, "Last queue read")).not.toBeNull();

    api.on(ME, () => Response.json({ ...profile, permissions: [] }));
    api.requests.length = 0;
    page = await renderDashboard();
    expect(page.textContent).toContain("Your role has no tile on this dashboard.");
    expect(api.requests.filter((request) => request.url.pathname !== "/v1/console/auth/me")).toEqual([]);
  });

  it("shows the queue's last read, the authorised payments and the latest bookings with their links", async () => {
    signedInAs("agent");
    everythingAnswers();

    const page = await renderDashboard();

    expect(api.sent(SNAPSHOTS).map(queryOf)).toEqual([{ limit: "1" }]);
    const queue = getTile(page, "Last queue read");
    expect([...queue.querySelectorAll("dd")].map((cell) => cell.textContent)).toEqual([
      "Queue 50",
      OFFICE,
      "0",
      formatInstant("2026-10-10T09:45:00Z", TIME_ZONE),
      "Scheduled poller",
      "7",
    ]);
    expect(within(queue).getByRole("link", { name: "Open queue 50" }).getAttribute("href")).toBe(
      `/queues/50?officeId=${OFFICE}&category=0`,
    );
    expect(within(queue).getByRole("link", { name: "All queues" }).getAttribute("href")).toBe("/queues");

    const payments = getTile(page, "Authorised, not captured");
    const rows = [...payments.querySelectorAll("tbody tr")];
    expect(rows.map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent))).toEqual([
      [PAYMENT_ID, "VX3L8R", "€1,414.06", formatInstant("2026-10-10T09:17:40Z", TIME_ZONE)],
      [OTHER_PAYMENT_ID, "No booking yet", "€99.90", formatInstant("2026-10-10T09:17:40Z", TIME_ZONE)],
    ]);
    expect(within(payments).getByRole("link", { name: PAYMENT_ID }).getAttribute("href")).toBe(
      `/payments/${PAYMENT_ID}`,
    );
    expect(within(payments).getByRole("link", { name: "VX3L8R" }).getAttribute("href")).toBe(
      `/bookings/${BOOKING_ID}`,
    );
    expect(payments.textContent).toContain("More authorised payments wait than are shown here.");

    const latestRequest = api.sent(BOOKINGS).find((request) => countOf(request) === undefined);
    expect(queryOf(latestRequest)).toEqual({ sort: "-created", limit: "10" });
    const latest = getTile(page, "Latest bookings");
    const booking = latest.querySelector<HTMLElement>(`tr[data-booking="${BOOKING_ID}"]`);
    expect(booking?.textContent).toContain("Guest booking");
    expect(booking?.textContent).toContain("ConfirmedIssuing failed");
    expect(booking?.textContent).toContain("ANNA BERG+1 more");
    expect(booking?.textContent).toContain("CDG → JFK");
    expect(booking?.textContent).toContain("€1,414.06");
    expect(within(latest).getByRole("link", { name: "VX3L8R" }).getAttribute("href")).toBe(
      `/bookings/${BOOKING_ID}`,
    );
    expect(within(latest).getByRole("link", { name: "All bookings" }).getAttribute("href")).toBe("/bookings");

    // The payments list the payments tile links asks the API for the status the tile read.
    const allAuthorized = within(payments).getByRole("link", { name: "All authorised payments" });
    api.requests.length = 0;
    await renderPaymentsList(allAuthorized.getAttribute("href") ?? "");
    expect(api.sent(PAYMENTS).map(queryOf)).toEqual([{ status: "authorized", limit: "25" }]);
  });

  it("counts above 10 000 as 10,000+, and without a totalCount from the rows read", async () => {
    bookingsAnswer({ ticketing: null, deadline: undefined, reconciling: 1 });
    everythingAnswersButBookings();

    const page = await renderDashboard();

    expect(countCard(page, "ticketing-problems").textContent).toContain("10,000+bookings");
    expect(countCard(page, "deadline-24h").textContent).toContain("1+bookings");
    expect(countCard(page, "reconciling").textContent).toContain("1booking");
    expect(countCard(page, "reconciling").getAttribute("data-attention")).toBe("true");
  });

  it("says when nothing waits: no queue read, no authorised payment, no booking", async () => {
    bookingsAnswer({ ticketing: 0, deadline: 0, reconciling: 0 }, []);
    api.on(PAYMENTS, () => pageOf([]));
    api.on(SNAPSHOTS, () => pageOf([]));

    const page = await renderDashboard();

    const queue = getTile(page, "Last queue read");
    expect(queue.textContent).toContain("No queue has been read in this environment yet.");
    expect(within(queue).queryByRole("link", { name: /Open queue/ })).toBeNull();
    expect(getTile(page, "Authorised, not captured").textContent).toContain("No payment waits for capture.");
    expect(getTile(page, "Authorised, not captured").textContent).not.toContain("More authorised payments");
    expect(getTile(page, "Latest bookings").textContent).toContain("No bookings yet in this environment.");
  });

  it("shows a read that fails in its tile's place, with the request id, and keeps the other tiles", async () => {
    bookingsAnswer({ ticketing: 3, deadline: 1, reconciling: () => apiError("INTERNAL_ERROR", 500) });
    api.on(PAYMENTS, () => rateLimited());
    api.on(SNAPSHOTS, () => pageOf([snapshot()]));

    const page = await renderDashboard();

    const payments = getTile(page, "Authorised, not captured");
    const alert = within(payments).getByRole("alert");
    expect(alert.textContent).toContain("Too many requests, retry in 60 s.");
    expect(alert.textContent).toContain("req_fake_1");
    expect(within(alert).getByRole("link", { name: "Try again" }).getAttribute("href")).toBe("/");
    expect(within(payments).getByRole("link", { name: "All authorised payments" })).toBeTruthy();

    const reconciling = countCard(page, "reconciling");
    expect(reconciling.tagName).not.toBe("A");
    expect(reconciling.textContent).toContain("Not counted");
    expect(within(reconciling).getByRole("alert").textContent).toContain("req_fake_1");
    expect(within(reconciling).getByRole("link", { name: "Open the list" }).getAttribute("href")).toBe(
      RECONCILING_HREF,
    );
    // The other tiles stay.
    expect(countCard(page, "ticketing-problems").textContent).toContain("3bookings");
    expect(getTile(page, "Last queue read").textContent).toContain("Queue 50");
    expect(getTile(page, "Latest bookings").textContent).toContain("VX3L8R");
  });

  it("redirects an expired session to /auth/refresh?next=/ and an ended one to the portal, whichever read meets it", async () => {
    everythingAnswers();
    api.on(SNAPSHOTS, () => apiError("TOKEN_EXPIRED", 401));
    expect(await redirectOf(() => renderDashboard())).toBe(
      `/auth/refresh?${new URLSearchParams({ next: "/" }).toString()}`,
    );

    everythingAnswers();
    api.on(PAYMENTS, () => apiError("STAFF_MEMBERSHIP_INACTIVE", 403));
    expect(await redirectOf(() => renderDashboard())).toBe(`${TEST_PORTAL_URL}/console?tenant=${TENANT_ID}`);
  });
});
