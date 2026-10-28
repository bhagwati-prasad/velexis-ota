// The payments list as Next.js renders it on the server (OAD-011): the real page, `getConsoleRequest` and the SDK
// against the fake OTA API (the SDK's `fetch`), rendered to HTML and queried in a detached happy-dom document (a
// server-mode SDK client refuses to run in a browser-like test environment, rightly). It checks what the page sends
// for a URL, what it shows, its filter form (a plain GET form) and the API's codes handled on the server.
import type { ConsolePayment } from "@velexis/ota-sdk";
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
vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));
vi.mock("next/headers", () => nextHeaders);
vi.mock("next/navigation", async () => {
  const { fakeRedirect } = await import("@/test/fake-ota-api");
  return {
    usePathname: () => "/payments",
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

import PaymentsPage from "./page";

const LIST = "GET /v1/console/payments";
const TIME_ZONE = "Europe/Oslo";
const PAYMENT_ID = "pay_01JA4CF2R7V0Y3B6D9G2K5N8Q1";
const AIRLINE_PAYMENT_ID = "pay_01JA5AC7H0K2M4P6R8T0V2X4Z6";
const PENDING_PAYMENT_ID = "pay_01JA7D2F4H6K8M0P2R4T6V8X0Z";
const BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2";

let api: FakeOtaApi;
let sequence = 0;

/** The cookies of a signed-in staff member. */
function signedIn(environment: "test" | "live" = "test"): void {
  sequence += 1;
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`payments-${sequence}`, Date.now(), 900),
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-payments-${sequence}`,
      [ENVIRONMENT_COOKIE]: environment,
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
}

const eur = (amount: string) => ({ amount, currency: "EUR" });

/** A payment of `console.payments.list` (dummy data): a captured Stripe payment of booking VX7K2Q by default. */
function payment(overrides: Partial<ConsolePayment> = {}): ConsolePayment {
  return {
    id: PAYMENT_ID,
    checkoutId: "chk_01JA4CE5H8K1M4P7R0T3V6Y9B2",
    bookingId: BOOKING_ID,
    purpose: "booking",
    provider: "stripe",
    method: "card",
    status: "captured",
    captureMethod: "manual",
    amount: eur("1414.06"),
    cardFee: eur("12.50"),
    amountAuthorized: eur("1414.06"),
    amountCaptured: eur("1414.06"),
    amountRefunded: eur("100.00"),
    clientSecret: null,
    providerPublicKey: null,
    providerPaymentId: "pi_3Q9xK2LkdIwHu7ix1aBcDeFg",
    redirectUrl: null,
    nextAction: null,
    card: { brand: "VISA", last4: "4242", bin: "424242", expMonth: 7, expYear: 2031 },
    threeDSecure: { required: true, status: "authenticated", version: "2.2.0" },
    failure: null,
    createdAt: "2026-10-10T09:17:40Z",
    updatedAt: "2026-10-10T09:20:47Z",
    authorizedAt: "2026-10-10T09:18:21Z",
    capturedAt: "2026-10-10T09:20:47Z",
    cancelledAt: null,
    environment: "test",
    version: 4,
    events: [],
    refunds: [],
    booking: { id: BOOKING_ID, reference: "VX7K2Q", status: "ticketed" },
    providerConnection: { accountMode: "velexis" },
    ...overrides,
  };
}

/** The airline-card payment of booking VX4M9T, and an authorisation whose checkout has no booking yet. */
function otherPayments(): ConsolePayment[] {
  return [
    payment({
      id: AIRLINE_PAYMENT_ID,
      bookingId: "bkg_01JA5AC9K2M4P6R8T0V2X4Z6B8",
      provider: "airline",
      method: "airline_card",
      captureMethod: "automatic",
      amount: eur("1401.56"),
      amountAuthorized: eur("1401.56"),
      amountCaptured: eur("1401.56"),
      amountRefunded: eur("0.00"),
      providerPaymentId: null,
      card: { brand: "MASTERCARD", last4: "1111", bin: "511111" },
      booking: { id: "bkg_01JA5AC9K2M4P6R8T0V2X4Z6B8", reference: "VX4M9T", status: "confirmed" },
      providerConnection: null,
      createdAt: "2026-10-09T07:00:00Z",
    }),
    payment({
      id: PENDING_PAYMENT_ID,
      bookingId: null,
      status: "authorized",
      amountCaptured: eur("0.00"),
      amountRefunded: eur("0.00"),
      card: null,
      booking: null,
      createdAt: "2026-10-08T07:00:00Z",
    }),
  ];
}

/** `console.payments.list` answers one page. */
function listAnswers(data: ConsolePayment[], nextCursor: string | null = null): void {
  api.on(LIST, () =>
    Response.json({ data, page: { nextCursor, limit: 25 } }, { headers: { "X-Request-Id": "req_list" } }),
  );
}

/** The list for `?<search>`, rendered to HTML on the "server" and parsed into a document. */
async function renderPage(search = ""): Promise<HTMLElement> {
  const query = new URLSearchParams(search);
  const searchParams: Record<string, string | string[]> = {};
  for (const name of new Set(query.keys())) {
    const values = query.getAll(name);
    searchParams[name] = values.length === 1 ? (values[0] ?? "") : values;
  }
  const element = await PaymentsPage({ searchParams: Promise.resolve(searchParams) });
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
  const table = within(page).getByRole("table");
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
  listAnswers([payment(), ...otherPayments()]);
  await renderPage();
  vi.unstubAllGlobals();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers({ "User-Agent": "Mozilla/5.0 Test" }));
  signedIn();
});

describe("/payments", () => {
  it("[OAD-011] lists the environment's payments newest first: payment, booking, means, status and amounts", async () => {
    listAnswers([payment(), ...otherPayments()]);

    const page = await renderPage();

    expect(queryObject(listRequest())).toEqual({ limit: "25" });
    expect(listRequest().headers.get("X-Velexis-Environment")).toBe("test");
    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe("Payments");
    expect(page.textContent).toContain("Every payment of this OTA in the test environment");
    const headers = [...page.querySelectorAll("thead th")].map((cell) => cell.textContent);
    expect(headers).toEqual(["Payment", "Created", "Booking", "Provider and method", "Status", "Amount"]);
    expect(rowsOf(page)).toEqual([
      [
        PAYMENT_ID,
        formatInstant("2026-10-10T09:17:40Z", TIME_ZONE),
        "VX7K2QTicketed",
        "Stripe · CardVISA •••• 4242",
        "Captured",
        "€1,414.06Captured €1,414.06Refunded €100.00",
      ],
      [
        AIRLINE_PAYMENT_ID,
        formatInstant("2026-10-09T07:00:00Z", TIME_ZONE),
        "VX4M9TConfirmed",
        "Airline · Airline cardMASTERCARD •••• 1111",
        "Captured",
        "€1,401.56Captured €1,401.56Refunded €0.00",
      ],
      [
        PENDING_PAYMENT_ID,
        formatInstant("2026-10-08T07:00:00Z", TIME_ZONE),
        "No booking yet",
        "Stripe · Card",
        "Authorised",
        "€1,414.06Captured €0.00Refunded €0.00",
      ],
    ]);
    expect(hrefOf(page, PAYMENT_ID)).toBe(`/payments/${PAYMENT_ID}`);
    expect(hrefOf(page, "VX7K2Q")).toBe(`/bookings/${BOOKING_ID}?tab=payments`);
    // Brand and last 4 only: never the expiry the provider reports.
    expect(page.innerHTML).not.toContain("2031");
    // One page only: no paging links.
    expect(within(page).queryByRole("navigation", { name: "Pages" })).toBeNull();
  });

  it("[OAD-011] sends the URL's filters: statuses, providers and methods OR-ed, the booking and the created days in the OTA's time zone", async () => {
    listAnswers([payment()]);

    const page = await renderPage(
      "status=captured&status=authorized&provider=stripe,airline&method=card&bookingId=bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2&createdFrom=2026-10-01&createdTo=2026-10-31&limit=50",
    );

    expect(queryObject(listRequest())).toEqual({
      // In the order of the document's enums, whatever the URL's order.
      status: "authorized,captured",
      provider: "stripe,airline",
      method: "card",
      bookingId: BOOKING_ID,
      // Oslo: the first of October starts at 22:00 UTC the day before (CEST); `createdTo` up to the end of its day
      // (CET from 25 October).
      createdFrom: "2026-09-30T22:00:00.000Z",
      createdTo: "2026-10-31T23:00:00.000Z",
      limit: "50",
    });

    // The filter form shows them: a GET form to this page, the page size kept.
    const form = within(page).getByRole("search", { name: "Payment filters" }) as HTMLFormElement;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/payments");
    const checked = [...form.querySelectorAll<HTMLInputElement>("input[type=checkbox]")]
      .filter((input) => input.hasAttribute("checked"))
      .map((input) => `${input.name}=${input.value}`);
    expect(checked).toEqual([
      "status=authorized",
      "status=captured",
      "provider=stripe",
      "provider=airline",
      "method=card",
    ]);
    expect(form.querySelector<HTMLInputElement>('input[name="bookingId"]')?.getAttribute("value")).toBe(
      BOOKING_ID,
    );
    expect(form.querySelector<HTMLInputElement>('input[name="createdFrom"]')?.getAttribute("value")).toBe(
      "2026-10-01",
    );
    expect(form.querySelector<HTMLInputElement>('input[name="limit"]')?.getAttribute("value")).toBe("50");
    expect(within(form).getByText("Authorised, Captured")).toBeTruthy();
    expect(hrefOf(form, "Clear filters")).toBe("/payments?limit=50");
  });

  it("[OAD-011] pages with the API's cursor, keeping the filters, and back to the first page", async () => {
    listAnswers([payment()], "cur_page2");
    let page = await renderPage("status=captured");
    const pages = within(page).getByRole("navigation", { name: "Pages" });
    expect(within(pages).queryByRole("link", { name: "First page" })).toBeNull();
    expect(hrefOf(pages, "Next page")).toBe("/payments?status=captured&cursor=cur_page2");

    api = fakeOtaApi();
    vi.stubGlobal("fetch", api.fetch);
    listAnswers([payment({ id: PENDING_PAYMENT_ID })], null);
    page = await renderPage("status=captured&cursor=cur_page2");
    expect(queryObject(listRequest())).toEqual({ status: "captured", cursor: "cur_page2", limit: "25" });
    const second = within(page).getByRole("navigation", { name: "Pages" });
    expect(hrefOf(second, "First page")).toBe("/payments?status=captured");
    expect(within(second).queryByRole("link", { name: "Next page" })).toBeNull();
  });

  it("[OAD-011] names the parameters of a link the API would refuse, without a request", async () => {
    const page = await renderPage(
      "status=paid&provider=stripe&bookingId=VX7K2Q&createdFrom=2026-13-01&limit=500&cursor=a&cursor=b",
    );

    expect(api.sent(LIST)).toHaveLength(0);
    const alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("This link has filters the list cannot use");
    expect(alert.textContent).toContain(
      "Not valid: Status, Booking id, Created from, Page, Page size. Change them above, or clear the filters.",
    );
    // "Clear filters" drops the filters, the cursor and the bad page size.
    expect(hrefOf(alert, "Clear filters")).toBe("/payments");
    // The valid filters stay in the form; the refused page size does not, so the form's next list can be sent.
    const form = within(page).getByRole("search", { name: "Payment filters" });
    expect(form.querySelector('input[name="provider"][value="stripe"]')?.hasAttribute("checked")).toBe(true);
    expect(form.querySelector('input[name="limit"]')).toBeNull();
    expect(hrefOf(form, "Clear filters")).toBe("/payments");
  });

  it("[OAD-011] says when the environment has no payments, or none match the filters", async () => {
    listAnswers([]);
    let page = await renderPage();
    expect(rowsOf(page)).toEqual([["No payments yet in this environment."]]);

    page = await renderPage("method=cash");
    expect(rowsOf(page)).toEqual([["No payment matches these filters."]]);
  });

  it("redirects an expired session to /auth/refresh back to this list, and an ended one to the portal", async () => {
    api.on(LIST, () => apiError("TOKEN_EXPIRED", 401));
    const next = new URLSearchParams({ next: "/payments?status=authorized" }).toString();
    expect(await redirectOf(() => renderPage("status=authorized"))).toBe(`/auth/refresh?${next}`);

    api.on(LIST, () => apiError("UNAUTHENTICATED", 401));
    expect(await redirectOf(() => renderPage())).toBe(`${TEST_PORTAL_URL}/console?tenant=${TENANT_ID}`);
  });

  it("renders the API's refusals on the server, under the filters, with the request id", async () => {
    api.on(LIST, () =>
      apiError("VALIDATION_FAILED", 400, {
        fieldErrors: [{ path: "/query/cursor", code: "cursor_mismatch", message: "Not this list's cursor." }],
      }),
    );
    let page = await renderPage("status=captured&cursor=stale");
    let alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("The payments could not be loaded");
    expect(alert.textContent).toContain("req_fake_1");
    expect(hrefOf(alert, "Try again")).toBe("/payments?status=captured&cursor=stale");
    expect(hrefOf(alert, "Clear filters")).toBe("/payments");
    expect(within(page).getByRole("search", { name: "Payment filters" })).toBeTruthy();

    api.on(LIST, () => rateLimited());
    page = await renderPage();
    alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("Too many requests, retry in 60 s.");
    expect(within(alert).queryByRole("link", { name: "Clear filters" })).toBeNull();
    expect(page.textContent).not.toContain("The API refused the request");
  });

  it("renders a failed staff profile and a role without payments:read as states, without listing", async () => {
    api.on("GET /v1/console/auth/me", () =>
      apiError("SERVICE_UNAVAILABLE", 503, {}, { "Retry-After": "60" }),
    );
    let page = await renderPage();
    expect(within(page).getByRole("alert").textContent).toContain(
      "The OTA API is unavailable right now. Try again in a moment.",
    );

    api.on("GET /v1/console/auth/me", () =>
      Response.json({ ...staffProfile({ role: "viewer" }), permissions: ["bookings:read"] }),
    );
    page = await renderPage();
    expect(within(page).getByRole("alert").textContent).toContain(
      "You do not have permission to do this (payments:read).",
    );
    expect(api.sent(LIST)).toHaveLength(0);
  });
});
