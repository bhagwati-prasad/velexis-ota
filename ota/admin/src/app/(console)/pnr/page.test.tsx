// The PNR lookup `/pnr` as Next.js renders it on the server (OAD-009): the real page, `getConsoleRequest` and the SDK
// against the fake OTA API (the SDK's `fetch`), rendered to HTML and queried in a detached happy-dom document (a
// server-mode SDK client refuses to run in a browser-like test environment, rightly). It checks the lookup a URL sends,
// what each match shows (an existing booking as a link, an importable order with the import dialog and the props the
// page gives it), and the answers of OBE-064 handled on the server: no match, `403 OFFICE_NOT_ALLOWED` explained, the
// session's codes as redirects.
import type { PnrLookupResult, PnrMatch, StaffRole } from "@velexis/ota-sdk";
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
  redirectOf,
  staffAccessToken,
  staffProfile,
  type FakeOtaApi,
  type SentRequest,
} from "@/test/fake-ota-api";

import type * as AdvancedPanelModule from "./advanced-panel";
import type * as ImportDialogModule from "./import-dialog";

// ---- Mocks: the request scope and navigation of Next.js and the configuration ------------------------------------

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));
vi.mock("next/headers", () => nextHeaders);
vi.mock("next/navigation", async () => {
  const { fakeRedirect } = await import("@/test/fake-ota-api");
  return {
    usePathname: () => "/pnr",
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
    redirect: fakeRedirect,
  };
});
// The real dialog, watched: the page must hand it the match's values and a key per render.
vi.mock("./import-dialog", async (importOriginal) => {
  const real = await importOriginal<typeof ImportDialogModule>();
  return { ...real, ImportDialog: vi.fn(real.ImportDialog) };
});
// The real Advanced panel (OAD-010), watched: the page must hand it the record locator and the matches' orders.
vi.mock("./advanced-panel", async (importOriginal) => {
  const real = await importOriginal<typeof AdvancedPanelModule>();
  return { ...real, AdvancedPanel: vi.fn(real.AdvancedPanel) };
});

import {
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from "@/lib/session";

import { AdvancedPanel } from "./advanced-panel";
import { ImportDialog, type ImportDialogProps } from "./import-dialog";
import PnrPage from "./page";

const ME = "GET /v1/console/auth/me";
const LOOKUP = "GET /v1/console/bookings/by-record-locator";
const FLIGHT_ORDER_ID = "eJzTd9cPNfX09DUFAAsGAkT";
const IMPORTED_ORDER_ID = "eJzTd9cPNfX09DUFAAsGAkU";
const BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2";

let api: FakeOtaApi;
let sequence = 0;

/** The cookies of a signed-in staff member. */
function signedIn(): void {
  sequence += 1;
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`pnr-${sequence}`, Date.now(), 900),
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-pnr-${sequence}`,
      [ENVIRONMENT_COOKIE]: "test",
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
}

/** `console.auth.me` answers a staff member of `role`. */
function staffOf(role: StaffRole): void {
  api.on(ME, () => Response.json(staffProfile({ role })));
}

/** A match of the lookup (dummy data): the terminal order L2P9XC of the contract's example, not imported yet. */
function match(overrides: Partial<PnrMatch> = {}): PnrMatch {
  return {
    flightOrderId: FLIGHT_ORDER_ID,
    bookingId: null,
    bookingReference: null,
    bookingStatus: null,
    importable: true,
    summary: {
      recordLocators: [
        {
          reference: "L2P9XC",
          originSystemCode: "GDS",
          flightOfferId: "1",
          creationDate: null,
          primary: true,
        },
        {
          reference: "8HJK2Q",
          originSystemCode: "AF",
          flightOfferId: "1",
          creationDate: null,
          primary: false,
        },
      ],
      travelers: [{ travelerId: "1", firstName: "CLAIRE", lastName: "MOREAU" }],
      segments: [
        {
          segmentId: "1",
          carrierCode: "AF",
          number: "6200",
          originCode: "ORY",
          destinationCode: "NCE",
          departureAt: "2026-12-03T07:10:00",
          bookingStatus: "CONFIRMED",
        },
      ],
      ticketNumbers: [],
      lastTicketingDate: "2026-10-12",
      queuingOfficeId: "OSLN12345",
      grandTotal: { amount: "142.30", currency: "EUR" },
    },
    amadeus: { type: "flight-order", id: FLIGHT_ORDER_ID, queuingOfficeId: "OSLN12345" },
    ...overrides,
  } as PnrMatch;
}

/** The lookup's answer with `matches`. */
function lookupAnswers(matches: PnrMatch[]): void {
  const result = {
    reference: "L2P9XC",
    originSystemCode: "GDS",
    retrievedAt: "2026-10-10T10:25:41Z",
    matches,
    included: null,
    dictionaries: null,
    warnings: [],
    call: {
      supplierRequestId: "sreq_01JA4H9Z1B3D5F7H9K1M3P5R7T",
      environment: "test",
      officeId: "OSLN12345",
      amadeusApi: "GetFlightOrderByRecordLocator",
      amadeusOperationId: "getFlightOrder",
      httpMethod: "GET",
      path: "/v1/booking/flight-orders/by-reference?reference=L2P9XC&originSystemCode=GDS",
      httpStatus: 200,
      durationMs: 1510,
      correlationId: null,
    },
  } as unknown as PnrLookupResult;
  api.on(LOOKUP, () => Response.json(result, { headers: { "X-Request-Id": "req_lookup" } }));
}

/** `/pnr?<search>`, rendered to HTML on the "server" and parsed into a document. */
async function renderPage(search = ""): Promise<HTMLElement> {
  const query = new URLSearchParams(search);
  const searchParams: Record<string, string | string[]> = {};
  for (const name of new Set(query.keys())) {
    const values = query.getAll(name);
    searchParams[name] = values.length === 1 ? (values[0] ?? "") : values;
  }
  const element = await PnrPage({ searchParams: Promise.resolve(searchParams) });
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(element);
  return document.body as unknown as HTMLElement;
}

/** The one lookup request. */
function lookupRequest(): SentRequest {
  const sent = api.sent(LOOKUP);
  expect(sent).toHaveLength(1);
  return sent[0] as SentRequest;
}

/** The props the page gave the import dialogs of its last render. */
function dialogProps(): ImportDialogProps[] {
  return vi.mocked(ImportDialog).mock.calls.map(([props]) => props);
}

// Once per file: the first server render of the page and the SDK's first calls are the slowest in a fresh worker; on
// a busy CI runner they would otherwise land in the first test's own five seconds.
beforeAll(async () => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers());
  signedIn();
  lookupAnswers([match()]);
  await renderPage("recordLocator=L2P9XC");
  vi.unstubAllGlobals();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers({ "User-Agent": "Mozilla/5.0 Test" }));
  signedIn();
  vi.mocked(ImportDialog).mockClear();
  vi.mocked(AdvancedPanel).mockClear();
});

describe("/pnr", () => {
  it("shows the lookup form, a plain GET form to this page, and looks nothing up without a record locator", async () => {
    const page = await renderPage();

    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe("PNR lookup");
    const form = within(page).getByRole("search", { name: "Look up a record locator" }) as HTMLFormElement;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/pnr");
    const input = within(form).getByLabelText("Record locator") as HTMLInputElement;
    expect(input.getAttribute("name")).toBe("recordLocator");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(api.sent(LOOKUP)).toHaveLength(0);
  });

  it("[OAD-009 AC1] looks the record locator up in the API's spelling and offers the import of an order that is not a booking", async () => {
    lookupAnswers([match()]);

    const page = await renderPage("recordLocator=%20l2p9xc%20");

    expect(Object.fromEntries(lookupRequest().url.searchParams)).toEqual({
      reference: "L2P9XC",
      originSystemCode: "GDS",
    });
    expect(lookupRequest().headers.get("X-Velexis-Environment")).toBe("test");
    const results = within(page).getByRole("region", { name: "1 order with record locator L2P9XC" });
    expect(results.textContent).toContain("L2P9XC (GDS, primary)");
    expect(results.textContent).toContain("8HJK2Q (AF)");
    expect(results.textContent).toContain("MOREAU/CLAIRE");
    expect(results.textContent).toContain("€142.30");
    const flights = within(results).getByRole("table");
    expect([...flights.querySelectorAll("tbody td")].map((cell) => cell.textContent)).toEqual([
      "AF 6200",
      "ORY",
      "NCE",
      "Dec 3, 2026, 07:10",
      "CONFIRMED",
    ]);
    expect(within(results).getByRole("button", { name: "Import as a booking" })).toBeTruthy();
    // The page hands the dialog the match's order, its currency and net total, and a key of this render.
    const [props] = dialogProps();
    expect(props).toMatchObject({
      reference: "L2P9XC",
      flightOrderId: FLIGHT_ORDER_ID,
      currency: "EUR",
      net: { amount: "142.30", currency: "EUR" },
      environment: "test",
      canSearchCustomers: true,
    });
    expect(props?.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // The next render (after a reload, or a failed attempt's new render) brings a new key.
    vi.mocked(ImportDialog).mockClear();
    await renderPage("recordLocator=L2P9XC");
    expect(dialogProps()[0]?.idempotencyKey).not.toBe(props?.idempotencyKey);
  });

  it("[OAD-009 AC1] links an order that is already a booking to that booking instead of importing it again", async () => {
    lookupAnswers([
      match({
        flightOrderId: IMPORTED_ORDER_ID,
        bookingId: BOOKING_ID,
        bookingReference: "VX7K2Q",
        bookingStatus: "confirmed",
        importable: false,
      }),
      match(),
    ]);

    const page = await renderPage("recordLocator=L2P9XC");

    const link = within(page).getByRole("link", { name: "VX7K2Q" });
    expect(link.getAttribute("href")).toBe(`/bookings/${BOOKING_ID}`);
    expect(link.closest("p")?.textContent).toBe("Already a booking of this OTA:VX7K2QConfirmed");
    // One import button: the other order's.
    expect(within(page).getAllByRole("button", { name: "Import as a booking" })).toHaveLength(1);
    expect(dialogProps().map((props) => props.flightOrderId)).toEqual([FLIGHT_ORDER_ID]);
  });

  it("explains 403 OFFICE_NOT_ALLOWED: the order belongs to an office outside this OTA, whose offices it names", async () => {
    api.on(LOOKUP, () => apiError("OFFICE_NOT_ALLOWED", 403));

    const page = await renderPage("recordLocator=L2P9XC");

    const alert = within(page).getByRole("alert");
    expect(within(alert).getByRole("heading").textContent).toBe(
      "This order belongs to an office outside this OTA",
    );
    expect(alert.textContent).toContain(
      "its owner office (or its queuing office, when it has no owner office) is not one of this OTA's Amadeus offices",
    );
    expect(alert.textContent).toContain("This OTA's offices: OSLN12345.");
    expect(alert.textContent).toContain("req_fake_1");
    // The form stays, with the record locator, for the next lookup.
    expect((within(page).getByLabelText("Record locator") as HTMLInputElement).getAttribute("value")).toBe(
      "L2P9XC",
    );
  });

  it("says when no order has the record locator in the OTA's offices", async () => {
    api.on(LOOKUP, () => apiError("NOT_FOUND", 404));

    const page = await renderPage("reference=ZZ9ZZZ");

    expect(lookupRequest().url.searchParams.get("reference")).toBe("ZZ9ZZZ");
    expect(within(page).getByRole("status").textContent).toContain(
      "No order with this record locator in your offices.",
    );
  });

  it("names a record locator the API would refuse, without a request", async () => {
    const page = await renderPage("recordLocator=L2-P9");

    expect(api.sent(LOOKUP)).toHaveLength(0);
    const input = within(page).getByLabelText("Record locator") as HTMLInputElement;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(page.textContent).toContain("Enter 5 to 8 letters and digits, like L2P9XC.");
  });

  it("shows a viewer the lookup without an import, and the verbatim order only to amadeus:read", async () => {
    staffOf("viewer");
    lookupAnswers([match()]);
    let page = await renderPage("recordLocator=L2P9XC");
    expect(within(page).queryByRole("button", { name: "Import as a booking" })).toBeNull();
    expect(page.textContent).toContain("Importing an order needs the permission bookings:write.");
    expect(page.textContent).not.toContain("Amadeus order (verbatim");

    staffOf("agent");
    page = await renderPage("recordLocator=L2P9XC");
    expect(page.textContent).toContain("Amadeus order (verbatim, redacted by the API)");
  });

  it("renders the API's other refusals with the request id and a retry, and redirects an expired session back here", async () => {
    api.on(LOOKUP, () => apiError("SUPPLIER_NOT_CONFIGURED", 424));
    const page = await renderPage("recordLocator=L2P9XC");
    const alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("No Amadeus connection is active for this environment.");
    expect(within(alert).getByRole("link", { name: "Try again" }).getAttribute("href")).toBe(
      "/pnr?recordLocator=L2P9XC",
    );

    api.on(LOOKUP, () => apiError("TOKEN_EXPIRED", 401));
    const next = new URLSearchParams({ next: "/pnr?recordLocator=L2P9XC" }).toString();
    expect(await redirectOf(() => renderPage("recordLocator=L2P9XC"))).toBe(`/auth/refresh?${next}`);

    api.on(LOOKUP, () => apiError("STAFF_MEMBERSHIP_INACTIVE", 403));
    expect(await redirectOf(() => renderPage("recordLocator=L2P9XC"))).toBe(
      `${TEST_PORTAL_URL}/console?tenant=${TENANT_ID}`,
    );
  });
  it("offers amadeus:read the Advanced panel's raw reads of the record locator and its orders, and reads nothing raw itself", async () => {
    lookupAnswers([match()]);

    const page = await renderPage("recordLocator=L2P9XC");

    expect(vi.mocked(AdvancedPanel).mock.calls.map(([props]) => props)).toEqual([
      { reference: "L2P9XC", flightOrderIds: [FLIGHT_ORDER_ID] },
    ]);
    const panel = within(page).getByRole("region", { name: "Advanced: raw Amadeus answers" });
    expect(panel.textContent).toContain(
      "Their prices are Amadeus net prices, before this OTA's markup and fees.",
    );
    expect(within(panel).getByRole("button", { name: "Read the orders of L2P9XC" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: `Read order ${FLIGHT_ORDER_ID}` })).toBeTruthy();
    // The raw reads run from their buttons only: the render is the lookup and nothing raw, nothing customer-scope.
    expect(api.requests.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([ME, LOOKUP]);

    // Also when the lookup found nothing: support may need Amadeus's own answer most then.
    vi.mocked(AdvancedPanel).mockClear();
    api.on(LOOKUP, () => apiError("NOT_FOUND", 404));
    await renderPage("recordLocator=L2P9XC");
    expect(vi.mocked(AdvancedPanel).mock.calls.map(([props]) => props)).toEqual([
      { reference: "L2P9XC", flightOrderIds: [] },
    ]);
  });

  it("shows no Advanced panel without amadeus:read, nor without a valid record locator", async () => {
    staffOf("finance");
    lookupAnswers([match()]);
    const page = await renderPage("recordLocator=L2P9XC");
    expect(within(page).queryByRole("region", { name: "Advanced: raw Amadeus answers" })).toBeNull();

    staffOf("agent");
    await renderPage("recordLocator=L2-P9");
    await renderPage();
    expect(AdvancedPanel).not.toHaveBeenCalled();
  });
});
