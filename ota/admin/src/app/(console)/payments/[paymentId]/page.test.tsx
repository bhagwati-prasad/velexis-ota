// A payment's page as Next.js renders it on the server (OAD-011): the real page, `getConsoleRequest` and the SDK against
// the fake OTA API (the SDK's `fetch`), rendered to HTML and queried in a detached happy-dom document (a server-mode SDK
// client refuses to run in a browser-like test environment, rightly). The payments are the OTA document's examples
// (dummy data): a captured Stripe payment with a finished and a pending refund, an authorisation, an airline-card
// payment and a payment whose checkout has no booking yet. What the dialogs do in a browser is in dialogs.test.tsx.
import type { ConsolePayment, ConsoleStaffProfile, StaffRole } from "@velexis/ota-sdk";
import { within } from "@testing-library/dom";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type * as PaymentDialogsModule from "@/app/(console)/bookings/[bookingId]/payment-dialogs";
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
// The real dialogs, watched: the page must hand them this page's actions and the payment's values.
vi.mock("@/app/(console)/bookings/[bookingId]/payment-dialogs", async (importOriginal) => {
  const real = await importOriginal<typeof PaymentDialogsModule>();
  return { ...real, CaptureDialog: vi.fn(real.CaptureDialog), RefundDialog: vi.fn(real.RefundDialog) };
});

import {
  CaptureDialog,
  RefundDialog,
  type CaptureDialogProps,
  type RefundDialogProps,
} from "@/app/(console)/bookings/[bookingId]/payment-dialogs";
import {
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from "@/lib/session";

import { capturePayment, refundPayment } from "./actions";
import PaymentPage from "./page";

const PAYMENT_ID = "pay_01JA4CF2R7V0Y3B6D9G2K5N8Q1";
const AIRLINE_PAYMENT_ID = "pay_01JA5AC7H0K2M4P6R8T0V2X4Z6";
const BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2";
const AIRLINE_BOOKING_ID = "bkg_01JA5AC9K2M4P6R8T0V2X4Z6B8";
/** The expiry year the provider reports for the card: the page never shows it (dummy). */
const CARD_EXPIRY_YEAR = 2031;

const ME = "GET /v1/console/auth/me";
const GET = (id: string) => `GET /v1/console/payments/${id}`;

let api: FakeOtaApi;
let sequence = 0;

/** The cookies of a signed-in staff member. */
function signedIn(): void {
  sequence += 1;
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`payment-${sequence}`, Date.now(), 900),
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-payment-${sequence}`,
      [ENVIRONMENT_COOKIE]: "test",
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
}

/** `console.auth.me` answers a staff member of `role`. */
function staffOf(role: StaffRole): void {
  api.on(ME, () => Response.json(staffProfile({ role })));
}

const eur = (amount: string) => ({ amount, currency: "EUR" });

// ---- Fixtures: the OTA document's examples ---------------------------------------------------------------------------

/**
 * `ConsolePaymentExample`: a captured Stripe payment of booking VX7K2Q with a refund Stripe finished (€100) and one the
 * payments queue has not sent yet (€50): €1,264.06 is still refundable.
 */
function capturedPayment(overrides: Partial<ConsolePayment> = {}): ConsolePayment {
  return {
    id: PAYMENT_ID,
    checkoutId: "chk_01JA4CE5H8K1M4P7R0T3V6Y9B2",
    bookingId: BOOKING_ID,
    purpose: "booking",
    provider: "stripe",
    method: "card",
    status: "partially_refunded",
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
    card: { brand: "VISA", last4: "4242", bin: "424242", expMonth: 7, expYear: CARD_EXPIRY_YEAR },
    threeDSecure: { required: true, status: "authenticated", version: "2.2.0" },
    failure: null,
    createdAt: "2026-10-10T09:17:40Z",
    updatedAt: "2026-10-12T08:00:05Z",
    authorizedAt: "2026-10-10T09:18:21Z",
    capturedAt: "2026-10-10T09:20:47Z",
    cancelledAt: null,
    environment: "test",
    version: 6,
    events: [
      {
        id: "pev_01JA4CF2S1V4Y7B0D3G6K9N2Q5",
        type: "payment.created",
        source: "api",
        statusFrom: null,
        statusTo: "requires_payment_method",
        amount: null,
        providerEventId: null,
        payload: { checkoutId: "chk_01JA4CE5H8K1M4P7R0T3V6Y9B2", cardBrand: "VISA" },
        createdAt: "2026-10-10T09:17:40Z",
      },
      {
        id: "pev_01JA4CFB1Y4A7D0F3H6K9N2Q5T",
        type: "payment.captured",
        source: "system",
        statusFrom: "authorized",
        statusTo: "captured",
        amount: eur("1414.06"),
        providerEventId: null,
        payload: {},
        createdAt: "2026-10-10T09:20:47Z",
      },
      {
        id: "pev_01JA6B2C4D6E8F0G2H4J6K8M0P",
        type: "refund.requested",
        source: "staff",
        statusFrom: null,
        statusTo: "pending",
        amount: eur("50.00"),
        providerEventId: null,
        payload: { refundId: "rfd_01JA6B9X2Z4C6E8G0J2L4N6Q8S" },
        createdAt: "2026-10-14T10:00:00Z",
      },
    ],
    refunds: [
      {
        id: "rfd_01JA6B2C4D6E8F0G2H4J6K8M0N",
        paymentId: PAYMENT_ID,
        bookingId: BOOKING_ID,
        amount: eur("100.00"),
        penalty: null,
        reason: "goodwill",
        status: "succeeded",
        createdAt: "2026-10-12T08:00:00Z",
        processedAt: "2026-10-12T08:00:05Z",
        reasonNote: "Delayed baggage on the outbound flight",
        requestedBy: { type: "staff", id: "stf_01JA2X7Q9M3K5N8P1R4T6V0W2Y" },
        providerRefundId: "re_3Q9xK2LkdIwHu7ix0Refund1",
        failureReason: null,
        updatedAt: "2026-10-12T08:00:05Z",
      },
      {
        id: "rfd_01JA6B9X2Z4C6E8G0J2L4N6Q8S",
        paymentId: PAYMENT_ID,
        bookingId: BOOKING_ID,
        amount: eur("50.00"),
        penalty: null,
        reason: "customer_request",
        status: "pending",
        createdAt: "2026-10-14T10:00:00Z",
        processedAt: null,
        reasonNote: "Seat not as booked",
        requestedBy: { type: "staff", id: "stf_01JA2X7Q9M3K5N8P1R4T6V0W2Y" },
        providerRefundId: null,
        failureReason: null,
        updatedAt: "2026-10-14T10:00:00Z",
      },
    ],
    booking: { id: BOOKING_ID, reference: "VX7K2Q", status: "ticketed" },
    providerConnection: { accountMode: "velexis" },
    ...overrides,
  };
}

/** The same payment authorised and not captured yet (the `manual_review` ticketing policy). */
function authorizedPayment(): ConsolePayment {
  return capturedPayment({
    status: "authorized",
    amountCaptured: eur("0.00"),
    amountRefunded: eur("0.00"),
    capturedAt: null,
    version: 2,
    events: [],
    refunds: [],
    booking: { id: BOOKING_ID, reference: "VX7K2Q", status: "confirmed" },
  });
}

/** An airline-card payment: the airline charged the card through Amadeus; no provider, no connection. */
function airlinePayment(): ConsolePayment {
  return capturedPayment({
    id: AIRLINE_PAYMENT_ID,
    checkoutId: "chk_01JA5AC6G9J1L3N5Q7S9U1W3Y5",
    bookingId: AIRLINE_BOOKING_ID,
    provider: "airline",
    method: "airline_card",
    status: "captured",
    captureMethod: "automatic",
    amount: eur("1401.56"),
    cardFee: null,
    amountAuthorized: eur("1401.56"),
    amountCaptured: eur("1401.56"),
    amountRefunded: eur("0.00"),
    providerPaymentId: null,
    card: { brand: "VISA", last4: "1111", bin: "411111" },
    threeDSecure: { required: false, status: "not_required" },
    version: 2,
    events: [],
    refunds: [],
    booking: { id: AIRLINE_BOOKING_ID, reference: "VX4M9T", status: "confirmed" },
    providerConnection: null,
  });
}

// ---- Rendering --------------------------------------------------------------------------------------------------

/** The fake API answers `console.payments.get` for `payment` (every query). */
function paymentAnswers(payment: ConsolePayment): void {
  api.on(GET(payment.id), () =>
    Response.json(payment, { headers: { ETag: `"${payment.version}"`, "X-Request-Id": "req_get" } }),
  );
}

/** The page of `paymentId` for `?<search>`, rendered to HTML on the "server" and parsed into a document. */
async function renderPage(paymentId: string, search = ""): Promise<HTMLElement> {
  const query = new URLSearchParams(search);
  const element = await PaymentPage({
    params: Promise.resolve({ paymentId }),
    searchParams: Promise.resolve(Object.fromEntries(query)),
  });
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(element);
  return document.body as unknown as HTMLElement;
}

/** The value of the fact `label` in `scope` (its `<dd>`), as text. */
function fact(scope: HTMLElement, label: string): string {
  const term = [...scope.querySelectorAll("dt")].find((candidate) => candidate.textContent === label);
  if (term === undefined) {
    throw new Error(`no fact "${label}"`);
  }
  return term.nextElementSibling?.textContent ?? "";
}

/** The texts of the cells of a table's body rows. */
function rowsOf(table: HTMLElement): string[][] {
  return [...table.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td")].map((cell) => cell.textContent ?? ""),
  );
}

/** The actions region of the page, or `null` when it offers none. */
function actionsOf(page: HTMLElement): HTMLElement | null {
  return within(page).queryByRole("region", { name: "Payment actions" });
}

/** The props the page gave the last `CaptureDialog` or `RefundDialog` it rendered. */
function lastProps<Props>(dialog: (props: Props) => unknown): Props {
  const props = vi.mocked(dialog).mock.calls.at(-1)?.[0];
  if (props === undefined) {
    throw new Error("the page rendered no such dialog");
  }
  return props;
}

/** An idempotency key as the page renders it (`crypto.randomUUID()`). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The names of the buttons in `scope`. */
function buttonsOf(scope: HTMLElement | null): string[] {
  return scope === null
    ? []
    : within(scope)
        .queryAllByRole("button")
        .map((button) => button.textContent ?? "");
}

// Once per file: the first server render of the page (React DOM server, the payment's sections, next/link) and the
// SDK's first calls are the slowest in a fresh worker; on a busy CI runner they would otherwise land in the first
// test's own five seconds.
beforeAll(async () => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers());
  signedIn();
  staffOf("owner");
  paymentAnswers(capturedPayment());
  await renderPage(PAYMENT_ID);
  vi.unstubAllGlobals();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

beforeEach(() => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers({ "User-Agent": "Mozilla/5.0 Test" }));
  signedIn();
});

describe("/payments/[paymentId]", () => {
  it("[OAD-011 AC1] offers owners and finance the refund of a captured Stripe payment, and an agent no refund button", async () => {
    paymentAnswers(capturedPayment());

    for (const role of ["owner", "admin", "finance"] as const) {
      staffOf(role);
      const page = await renderPage(PAYMENT_ID);
      expect(buttonsOf(actionsOf(page)), role).toEqual(["Refresh from Stripe", "Refund"]);
    }

    for (const role of ["agent", "viewer"] as const) {
      staffOf(role);
      const page = await renderPage(PAYMENT_ID);
      expect(buttonsOf(actionsOf(page)), role).toEqual(["Refresh from Stripe"]);
      expect(within(page).queryByRole("button", { name: "Refund" }), role).toBeNull();
      // What is refundable is still shown: only the button is the refund permission's.
      expect(fact(page, "Still refundable"), role).toBe("€1,264.06");
    }
  });

  it("[OAD-011] offers the capture of an authorised Stripe payment with payments:capture (an agent too), never a refund", async () => {
    paymentAnswers(authorizedPayment());

    for (const role of ["agent", "finance", "owner"] as const) {
      staffOf(role);
      const page = await renderPage(PAYMENT_ID);
      expect(buttonsOf(actionsOf(page)), role).toEqual(["Refresh from Stripe", "Capture"]);
      const capture = within(page).getByRole("button", { name: "Capture" });
      expect(capture.getAttribute("aria-haspopup")).toBe("dialog");
    }

    staffOf("viewer");
    const page = await renderPage(PAYMENT_ID);
    expect(buttonsOf(actionsOf(page))).toEqual(["Refresh from Stripe"]);
    // The dialogs open in the browser: no input is rendered with the page.
    expect(page.querySelectorAll("input:not([type=hidden]), select, textarea")).toHaveLength(0);
  });

  it("[OAD-011] hands the dialogs this page's actions, the payment's version and booking, what is still refundable and a key per render", async () => {
    staffOf("owner");
    paymentAnswers(authorizedPayment());
    await renderPage(PAYMENT_ID);
    const capture = lastProps<CaptureDialogProps>(CaptureDialog);
    // This page's action, which revalidates the payments pages, never the booking page's alone.
    expect(capture.action).toBe(capturePayment);
    expect(capture).toMatchObject({
      paymentId: PAYMENT_ID,
      bookingId: BOOKING_ID,
      environment: "test",
      version: 2,
      authorized: eur("1414.06"),
    });
    expect(capture.idempotencyKey).toMatch(UUID);

    // A payment whose checkout has no booking yet: no booking for the dialog to post.
    paymentAnswers(capturedPayment({ booking: null, bookingId: null }));
    await renderPage(PAYMENT_ID);
    const refund = lastProps<RefundDialogProps>(RefundDialog);
    expect(refund.action).toBe(refundPayment);
    expect(refund).toMatchObject({ paymentId: PAYMENT_ID, environment: "test", refundable: eur("1264.06") });
    expect(refund.bookingId).toBeUndefined();
    expect(refund.idempotencyKey).toMatch(UUID);

    // The next render (after a success revalidates the page) brings a new key.
    await renderPage(PAYMENT_ID);
    expect(lastProps<RefundDialogProps>(RefundDialog).idempotencyKey).not.toBe(refund.idempotencyKey);
  });

  it("[OAD-011] shows 'Refunded by the airline' for an airline-card payment instead of a refund button, for every role", async () => {
    paymentAnswers(airlinePayment());

    for (const role of ["owner", "finance", "agent"] as const) {
      staffOf(role);
      const page = await renderPage(AIRLINE_PAYMENT_ID);
      const actions = actionsOf(page);
      expect(actions?.querySelector("[data-airline-refund]")?.textContent, role).toBe(
        "Refunded by the airline",
      );
      // No refund, no capture, and no read at Stripe: the airline holds the charge.
      expect(buttonsOf(actions), role).toEqual([]);
      expect(() => fact(page, "Still refundable")).toThrow();
      expect(page.textContent).toContain("refunds go through the airline, not the console");
    }

    // A link with `refresh=1` gets the payment as stored (it has no PaymentIntent): nothing is said of Stripe.
    const page = await renderPage(AIRLINE_PAYMENT_ID, "refresh=1");
    expect(api.sent(GET(AIRLINE_PAYMENT_ID)).at(-1)?.url.search).toBe("?refresh=true");
    expect(within(page).queryByRole("status")).toBeNull();
    expect(page.textContent).not.toContain("Stripe");
  });

  it("[OAD-011] shows the payment with its booking, what is still refundable, its events and refunds, and no card expiry", async () => {
    staffOf("finance");
    paymentAnswers(capturedPayment());

    const page = await renderPage(PAYMENT_ID);

    const request = api.sent(GET(PAYMENT_ID));
    expect(request).toHaveLength(1);
    expect(request[0]?.url.search).toBe("");
    expect(request[0]?.headers.get("X-Velexis-Environment")).toBe("test");
    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe(`Payment ${PAYMENT_ID}`);
    const header = page.querySelector("header") as HTMLElement;
    expect(header.textContent).toContain("Stripe · Card · €1,414.06");
    expect(within(header).getByRole("link", { name: "VX7K2Q" }).getAttribute("href")).toBe(
      `/bookings/${BOOKING_ID}?tab=payments`,
    );
    expect(fact(header, "Booking")).toContain("Ticketed");
    expect(fact(header, "Checkout")).toBe("chk_01JA4CE5H8K1M4P7R0T3V6Y9B2");
    expect(fact(header, "Environment")).toBe("TEST");
    // Captured less refunded less the refund still on its way to Stripe, as the API counts it.
    expect(fact(header, "Still refundable")).toBe("€1,264.06");
    expect(fact(header, "Refunds on their way to Stripe")).toBe("€50.00");
    expect(within(header).getByRole("link", { name: "All payments" }).getAttribute("href")).toBe("/payments");

    const details = within(page).getByRole("region", { name: "Details" });
    const card = within(details).getByRole("article", { name: `Payment ${PAYMENT_ID}` });
    expect(fact(card, "Card")).toBe("VISA •••• 4242");
    expect(fact(card, "Captured")).toBe("€1,414.06");
    expect(fact(card, "Refunded")).toBe("€100.00");
    expect(fact(card, "Account")).toBe("Velexis");
    expect(fact(card, "Version")).toBe("6");
    const [events, refunds] = within(card).getAllByRole("table") as [HTMLElement, HTMLElement];
    expect(rowsOf(events).map((row) => row[1])).toEqual([
      "payment.created",
      "payment.captured",
      "refund.requested",
    ]);
    expect(rowsOf(refunds).map((row) => [row[1], row[4]])).toEqual([
      ["€100.00", "Succeeded"],
      ["€50.00", "Pending"],
    ]);
    // Brand and last 4 only: never the expiry the provider reports, nor a holder.
    expect(page.innerHTML).not.toContain(String(CARD_EXPIRY_YEAR));
    expect(page.innerHTML).not.toMatch(/expMonth|expYear|holder/i);
  });

  it("[OAD-011] says a payment has no booking yet, and offers no refund of a payment with nothing left to refund", async () => {
    staffOf("owner");
    paymentAnswers(capturedPayment({ booking: null, bookingId: null }));
    let page = await renderPage(PAYMENT_ID);
    expect(fact(page, "Booking")).toBe("No booking yet: the checkout has not become a booking.");
    expect(buttonsOf(actionsOf(page))).toEqual(["Refresh from Stripe", "Refund"]);

    // Everything captured is refunded or on its way: no refund to offer.
    paymentAnswers(capturedPayment({ amountRefunded: eur("1364.06") }));
    page = await renderPage(PAYMENT_ID);
    expect(buttonsOf(actionsOf(page))).toEqual(["Refresh from Stripe"]);
    expect(() => fact(page, "Still refundable")).toThrow();
  });

  it("[OAD-011] refreshes from Stripe on request, and reads the stored payment again when Stripe fails", async () => {
    staffOf("finance");
    paymentAnswers(capturedPayment());

    let page = await renderPage(PAYMENT_ID);
    const form = within(actionsOf(page) as HTMLElement)
      .getByRole("button", { name: "Refresh from Stripe" })
      .closest("form") as HTMLFormElement;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe(`/payments/${PAYMENT_ID}`);
    expect(form.querySelector<HTMLInputElement>('input[name="refresh"]')?.value).toBe("1");
    expect(within(page).queryByRole("status")).toBeNull();

    page = await renderPage(PAYMENT_ID, "refresh=1");
    expect(
      api
        .sent(GET(PAYMENT_ID))
        .slice(1)
        .map((request) => request.url.search),
    ).toEqual(["?refresh=true"]);
    expect(within(page).getByRole("status").textContent).toBe(
      "Read from Stripe just now: this is the payment as Stripe has it.",
    );

    api.on(GET(PAYMENT_ID), (request) =>
      request.url.searchParams.get("refresh") === "true"
        ? apiError("PAYMENT_PROVIDER_ERROR", 502)
        : Response.json(capturedPayment()),
    );
    page = await renderPage(PAYMENT_ID, "refresh=1");
    expect(
      api
        .sent(GET(PAYMENT_ID))
        .slice(2)
        .map((request) => request.url.search),
    ).toEqual(["?refresh=true", ""]);
    const notice = within(page).getByRole("status");
    expect(notice.textContent).toBe(
      "Stripe could not be read, so this is the stored payment. The payment provider answered with an error. (request id req_fake_1)",
    );
    expect(within(page).getByRole("heading", { level: 1 }).textContent).toBe(`Payment ${PAYMENT_ID}`);
  });

  it("redirects an expired session to /auth/refresh back to this payment, never refreshing again, and an ended one to the portal", async () => {
    api.on(GET(PAYMENT_ID), () => apiError("TOKEN_EXPIRED", 401));
    const next = new URLSearchParams({ next: `/payments/${PAYMENT_ID}` }).toString();
    expect(await redirectOf(() => renderPage(PAYMENT_ID, "refresh=1"))).toBe(`/auth/refresh?${next}`);

    api.on(GET(PAYMENT_ID), () => apiError("STAFF_MEMBERSHIP_INACTIVE", 403));
    expect(await redirectOf(() => renderPage(PAYMENT_ID))).toBe(
      `${TEST_PORTAL_URL}/console?tenant=${TENANT_ID}`,
    );
  });

  it("renders a payment the environment does not have, an id that is not one and the API's refusals on the server", async () => {
    api.on(GET(PAYMENT_ID), () => apiError("NOT_FOUND", 404));
    let page = await renderPage(PAYMENT_ID);
    let alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("Payment not found");
    expect(alert.textContent).toContain(
      "No payment with this id in the TEST environment. It may belong to the other environment, or the link is wrong.",
    );
    expect(within(alert).getByRole("link", { name: "All payments" }).getAttribute("href")).toBe("/payments");

    page = await renderPage("not-a-payment");
    expect(within(page).getByRole("alert").textContent).toContain("Payment not found");
    expect(
      api.requests.filter((request) => request.url.pathname.startsWith("/v1/console/payments")),
    ).toHaveLength(1);

    api.on(GET(PAYMENT_ID), () => apiError("INTERNAL_ERROR", 500));
    page = await renderPage(PAYMENT_ID, "refresh=1");
    alert = within(page).getByRole("alert");
    expect(alert.textContent).toContain("The payment could not be loaded");
    expect(alert.textContent).toContain(
      "The OTA API had an unexpected problem. Try again, and quote the request id if it persists.",
    );
    expect(alert.textContent).toContain("req_fake_1");
    // "Try again" reads the payment again without a second read at Stripe.
    expect(within(alert).getByRole("link", { name: "Try again" }).getAttribute("href")).toBe(
      `/payments/${PAYMENT_ID}`,
    );
    expect(page.textContent).not.toContain("The API refused the request");
  });

  it("renders a failed staff profile and a role without payments:read as states, without reading the payment", async () => {
    api.on(ME, () => apiError("SERVICE_UNAVAILABLE", 503, {}, { "Retry-After": "60" }));
    let page = await renderPage(PAYMENT_ID);
    expect(within(page).getByRole("alert").textContent).toContain(
      "The OTA API is unavailable right now. Try again in a moment.",
    );

    const profile: ConsoleStaffProfile = {
      ...staffProfile({ role: "viewer" }),
      permissions: ["bookings:read", "customers:read"],
    };
    api.on(ME, () => Response.json(profile));
    page = await renderPage(PAYMENT_ID);
    expect(within(page).getByRole("alert").textContent).toContain(
      "You do not have permission to do this (payments:read).",
    );
    expect(api.sent(GET(PAYMENT_ID))).toHaveLength(0);
  });
});
