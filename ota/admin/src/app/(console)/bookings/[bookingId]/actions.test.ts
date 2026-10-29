// The server actions of a booking's page (OAD-008) against the fake OTA API (OADR-0018 point 10): the real actions,
// `requireStaff` and the SDK, with the SDK's `fetch` answered by src/test/fake-ota-api.ts, so each test checks the exact
// request an action sends (method, path, `If-Match`, `Idempotency-Key`, `X-Velexis-Environment`, body) and the state it
// answers, without a running backend. Next.js's request scope (`cookies()`, `headers()`), `redirect()` and
// `revalidatePath()` are mocked. Every token, id and name here is a dummy.
import { randomUUID } from "node:crypto";

import type { StaffRole } from "@velexis/ota-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CookieJar,
  TENANT_ID,
  TEST_CONFIG,
  TEST_PORTAL_URL,
  apiError,
  fakeOtaApi,
  fakeRedirect,
  rateLimited,
  redirectOf,
  staffAccessToken,
  staffProfile,
  type FakeOtaApi,
  type SentRequest,
} from "@/test/fake-ota-api";

const nextHeaders = vi.hoisted(() => ({ cookies: vi.fn(), headers: vi.fn() }));
const nextCache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("@/config", () => ({ getConfig: () => TEST_CONFIG }));
vi.mock("next/headers", () => nextHeaders);
vi.mock("next/cache", () => nextCache);
vi.mock("next/navigation", () => ({ redirect: vi.fn(fakeRedirect) }));

import { INITIAL_ACTION_STATE, actionKeyAfter, type ActionState } from "@/lib/action-state";
import {
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from "@/lib/session";

import { keptContactOf, keptFieldOf } from "./action-rules";
import {
  addNote,
  cancelBooking,
  capturePayment,
  issueTickets,
  patchBooking,
  refundPayment,
  resyncBooking,
} from "./actions";

const BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2";
const PAYMENT_ID = "pay_01JA4CF2R7V0Y3B6D9G2K5N8Q1";
const VERSION = "3";
const PAYMENT_VERSION = "2";
const REASON = "Payment confirmed by phone";

const ME = "GET /v1/console/auth/me";
const ISSUE = `POST /v1/console/bookings/${BOOKING_ID}/issuance`;
const CANCEL = `POST /v1/console/bookings/${BOOKING_ID}/cancellation`;
const PATCH = `PATCH /v1/console/bookings/${BOOKING_ID}`;
const RESYNC = `POST /v1/console/bookings/${BOOKING_ID}/resync`;
const NOTES = `POST /v1/console/bookings/${BOOKING_ID}/notes`;
const CAPTURE = `POST /v1/console/payments/${PAYMENT_ID}/capture`;
const REFUND = `POST /v1/console/payments/${PAYMENT_ID}/refunds`;

/** Every route an action of this file may send, besides `console.auth.me`. */
const ACTION_ROUTES = [ISSUE, CANCEL, PATCH, RESYNC, NOTES, CAPTURE, REFUND];

let api: FakeOtaApi;
let sequence = 0;

/** The cookies of a signed-in staff member of `role` whose switch says `environment`. */
function signedIn(role: StaffRole = "agent", environment: "test" | "live" = "test"): string {
  sequence += 1;
  const accessToken = staffAccessToken(`actions-${sequence}`, Date.now(), 900);
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: accessToken,
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-actions-${sequence}`,
      [ENVIRONMENT_COOKIE]: environment,
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
  api.on(ME, () => Response.json(staffProfile({ role }), { headers: { "X-Request-Id": "req_me" } }));
  return accessToken;
}

/** The form a dialog posts. */
function formOf(fields: Readonly<Record<string, string>>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    form.set(name, value);
  }
  return form;
}

/** The booking an action is answered with: what the actions read of a ConsoleBooking. */
function bookingAnswer(overrides: Record<string, unknown> = {}): Response {
  return Response.json(
    {
      id: BOOKING_ID,
      reference: "VX7K2Q",
      status: "ticketed",
      version: 4,
      ticketing: { status: "issued" },
      warnings: [],
      ...overrides,
    },
    { headers: { ETag: '"4"', "X-Request-Id": "req_action" } },
  );
}

/** A payment as console.payments.capture answers it (the fields the action reads). */
function paymentAnswer(overrides: Record<string, unknown> = {}): Response {
  return Response.json(
    {
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      provider: "stripe",
      method: "card",
      status: "captured",
      amountAuthorized: { amount: "1414.06", currency: "EUR" },
      amountCaptured: { amount: "1414.06", currency: "EUR" },
      amountRefunded: { amount: "0.00", currency: "EUR" },
      version: 3,
      ...overrides,
    },
    { headers: { "X-Request-Id": "req_payment" } },
  );
}

/** The one request of `route`, failing the test when there is not exactly one. */
function only(route: string): SentRequest {
  const sent = api.sent(route);
  expect(sent, route).toHaveLength(1);
  return sent[0] as SentRequest;
}

/** The requests besides `console.auth.me`. */
function actionRequests(): SentRequest[] {
  return api.requests.filter((request) => `${request.method} ${request.url.pathname}` !== ME);
}

/** The JSON text of a request's body, for "never contains" checks. */
function bodyText(request: SentRequest): string {
  return JSON.stringify(request.body ?? null);
}

beforeEach(() => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(
    new Headers({ "User-Agent": "Mozilla/5.0 Test", "X-Forwarded-For": "203.0.113.7" }),
  );
  nextCache.revalidatePath.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- issueTickets -----------------------------------------------------------------------------------------------------

describe("issueTickets", () => {
  /** The issue dialog's form of a booking paid by Stripe. */
  function issueForm(key: string, extra: Record<string, string> = {}): FormData {
    return formOf({
      bookingId: BOOKING_ID,
      version: VERSION,
      actionKey: key,
      reason: REASON,
      notifyCustomer: "true",
      ...extra,
    });
  }

  it("[OAD-008 AC1] sends POST /issuance with If-Match of the displayed version, the dialog's key and the environment", async () => {
    const accessToken = signedIn("agent", "test");
    api.on(ISSUE, () => bookingAnswer());
    const key = randomUUID();

    const state = await issueTickets(INITIAL_ACTION_STATE, issueForm(key));

    expect(state).toEqual({ ok: true, message: "Tickets issued." });
    const request = only(ISSUE);
    expect(request.method).toBe("POST");
    expect(request.url.pathname).toBe(`/v1/console/bookings/${BOOKING_ID}/issuance`);
    expect(request.headers.get("If-Match")).toBe(`"${VERSION}"`);
    expect(request.headers.get("Idempotency-Key")).toBe(key);
    expect(request.headers.get("X-Velexis-Environment")).toBe("test");
    expect(request.headers.get("X-Api-Key")).toBe(TEST_CONFIG.OTA_ADMIN_SERVICE_KEY);
    expect(request.headers.get("Authorization")).toBe(`Bearer ${accessToken}`);
    expect(request.body).toEqual({ reason: REASON, capturePayment: true, notifyCustomer: true });
    // requireStaff asked console.auth.me first, in the same environment.
    expect(api.requests.map((sent) => `${sent.method} ${sent.url.pathname}`)).toEqual([ME, ISSUE]);
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(`/bookings/${BOOKING_ID}`);
  });

  it("[OAD-008 AC1] a double submit sends the same Idempotency-Key; the next render's dialog sends a new one", async () => {
    signedIn();
    api.on(ISSUE, () => bookingAnswer());
    const key = randomUUID();

    // Two submissions of one dialog (a double click, or a resubmission after an error): one key.
    const [first, second] = await Promise.all([
      issueTickets(INITIAL_ACTION_STATE, issueForm(key)),
      issueTickets(INITIAL_ACTION_STATE, issueForm(key)),
    ]);
    // The page after the success renders a new key for its next dialog.
    const fresh = randomUUID();
    await issueTickets(INITIAL_ACTION_STATE, issueForm(fresh));

    expect(first.ok && second.ok).toBe(true);
    expect(api.sent(ISSUE).map((request) => request.headers.get("Idempotency-Key"))).toEqual([
      key,
      key,
      fresh,
    ]);
    expect(api.sent(ISSUE).map((request) => request.headers.get("If-Match"))).toEqual([
      `"${VERSION}"`,
      `"${VERSION}"`,
      `"${VERSION}"`,
    ]);
  });

  it("sends allowUnpaid for an owner, and refuses it for an agent before any issuance", async () => {
    signedIn("owner");
    api.on(ISSUE, () => bookingAnswer());

    expect(
      await issueTickets(INITIAL_ACTION_STATE, issueForm(randomUUID(), { allowUnpaid: "true" })),
    ).toMatchObject({ ok: true });
    expect(only(ISSUE).body).toMatchObject({ allowUnpaid: true, capturePayment: true });

    api = fakeOtaApi();
    vi.stubGlobal("fetch", api.fetch);
    signedIn("agent");
    const refused = await issueTickets(
      INITIAL_ACTION_STATE,
      issueForm(randomUUID(), { allowUnpaid: "true" }),
    );

    expect(refused).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
      message: "Only an owner or an admin may issue a booking that is not paid.",
      fieldErrors: { allowUnpaid: "Only an owner or an admin may issue a booking that is not paid." },
    });
    expect(actionRequests()).toEqual([]);
  });

  it("issues an airline-card booking with the OTA's CASH or ACCOUNT settlement only, never a card", async () => {
    signedIn();
    api.on(ISSUE, () => bookingAnswer());
    // Whatever else a forged form posts, the action reads its own fields only.
    const forged = {
      settlement: "ACCOUNT",
      flightOfferIds: "1,2",
      cardNumber: "4242424242424242",
      securityCode: "123",
      holderName: "ANNA BERG",
      expiryDate: "2029-08",
    };

    expect(await issueTickets(INITIAL_ACTION_STATE, issueForm(randomUUID(), forged))).toMatchObject({
      ok: true,
    });

    const request = only(ISSUE);
    expect(request.body).toEqual({
      reason: REASON,
      capturePayment: true,
      notifyCustomer: true,
      formOfPayments: [{ other: { method: "ACCOUNT", flightOfferIds: ["1", "2"] } }],
    });
    expect(bodyText(request)).not.toMatch(/creditCard|4242424242424242|securityCode|holder|expiry/i);
  });

  it("refuses any other settlement, and an airline-card dialog without one, before the call", async () => {
    signedIn();

    for (const settlement of ["CHECK", "creditCard", ""]) {
      const state = await issueTickets(
        INITIAL_ACTION_STATE,
        issueForm(randomUUID(), { settlement, flightOfferIds: "1" }),
      );
      expect(state, settlement).toMatchObject({
        ok: false,
        code: "VALIDATION_FAILED",
        fieldErrors: { settlement: "Choose CASH or ACCOUNT." },
      });
    }
    expect(actionRequests()).toEqual([]);
  });

  it("answers the API's known codes as the dialog's state, never as an error thrown to error.tsx", async () => {
    signedIn();
    const cases: [Response, Partial<ActionState>][] = [
      [
        apiError("PRECONDITION_FAILED", 412, { details: { currentVersion: 4 } }),
        { code: "PRECONDITION_FAILED", message: "This record changed; reload to see the latest version." },
      ],
      [
        apiError("PAYMENT_DECLINED", 402),
        { code: "PAYMENT_DECLINED", message: "The authorisation has expired; contact the traveller." },
      ],
      [
        apiError("SUPPLIER_TIMEOUT", 504, {}, { "Retry-After": "60" }),
        { code: "SUPPLIER_TIMEOUT", message: "Amadeus did not answer. Resync before retrying." },
      ],
      [
        apiError("ALREADY_ISSUED", 409, { details: { status: "ticketed" } }),
        {
          code: "ALREADY_ISSUED",
          message: "The tickets of this booking are already issued. Reload the page to see them.",
        },
      ],
      [
        apiError("BOOKING_NOT_MODIFIABLE", 409, { details: { reason: "ticketing_in_progress" } }),
        {
          code: "BOOKING_NOT_MODIFIABLE",
          message: "Tickets are being issued for this booking right now. Reload the page in a moment.",
        },
      ],
      [
        apiError("VALIDATION_FAILED", 400, {
          fieldErrors: [
            { path: "/formOfPayments/0", code: "airline_card_settlement", message: "Use CASH or ACCOUNT." },
          ],
        }),
        { code: "VALIDATION_FAILED", fieldErrors: { settlement: "Use CASH or ACCOUNT." } },
      ],
    ];
    for (const [answer, expected] of cases) {
      api.on(ISSUE, () => answer.clone());
      const state = await issueTickets(INITIAL_ACTION_STATE, issueForm(randomUUID()));
      expect(state, expected.code).toMatchObject({ ok: false, requestId: "req_fake_1", ...expected });
    }
    expect(nextCache.revalidatePath).not.toHaveBeenCalled();
  });
});

// ---- cancelBooking ----------------------------------------------------------------------------------------------------

describe("cancelBooking", () => {
  function cancelForm(key: string, extra: Record<string, string> = {}): FormData {
    return formOf({
      bookingId: BOOKING_ID,
      version: VERSION,
      actionKey: key,
      reason: "Duplicate of VX7K2R",
      reasonCode: "duplicate",
      refundMode: "full",
      currency: "EUR",
      ...extra,
    });
  }

  it("[OAD-008 AC1] sends POST /cancellation with If-Match, the dialog's key twice on a double submit, and the refund", async () => {
    signedIn();
    api.on(CANCEL, () => bookingAnswer({ status: "cancelled" }));
    const key = randomUUID();
    const form = cancelForm(key, { refundMode: "amount", amount: "120.50" });

    const first = await cancelBooking(INITIAL_ACTION_STATE, form);
    const second = await cancelBooking(INITIAL_ACTION_STATE, form);

    expect(first).toEqual({ ok: true, message: "Booking cancelled." });
    expect(second.ok).toBe(true);
    const sent = api.sent(CANCEL);
    expect(sent.map((request) => request.headers.get("Idempotency-Key"))).toEqual([key, key]);
    for (const request of sent) {
      expect(request.method).toBe("POST");
      expect(request.headers.get("If-Match")).toBe(`"${VERSION}"`);
      expect(request.headers.get("X-Velexis-Environment")).toBe("test");
      expect(request.body).toEqual({
        reasonCode: "duplicate",
        reason: "Duplicate of VX7K2R",
        refund: { mode: "amount", amount: { amount: "120.50", currency: "EUR" } },
        // An unticked checkbox posts nothing: the traveller is not told.
        notifyCustomer: false,
      });
    }
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(`/bookings/${BOOKING_ID}`);
  });

  it("sends modes none and full without an amount, even when one was typed before the mode changed", async () => {
    signedIn();
    api.on(CANCEL, () => bookingAnswer({ status: "cancelled" }));

    for (const refundMode of ["none", "full"]) {
      await cancelBooking(
        INITIAL_ACTION_STATE,
        cancelForm(randomUUID(), { refundMode, amount: "50.00", notifyCustomer: "true" }),
      );
    }

    expect(api.sent(CANCEL).map((request) => request.body)).toEqual([
      expect.objectContaining({ refund: { mode: "none" }, notifyCustomer: true }),
      expect.objectContaining({ refund: { mode: "full" }, notifyCustomer: true }),
    ]);
  });

  it("refuses a mode amount without a valid amount, and a reason code it does not know, before the call", async () => {
    signedIn();

    expect(
      await cancelBooking(INITIAL_ACTION_STATE, cancelForm(randomUUID(), { refundMode: "amount" })),
    ).toMatchObject({ ok: false, fieldErrors: { amount: "Enter an amount." } });
    expect(
      await cancelBooking(
        INITIAL_ACTION_STATE,
        cancelForm(randomUUID(), { refundMode: "amount", amount: "12,5" }),
      ),
    ).toMatchObject({ ok: false, fieldErrors: { amount: "Enter an amount like 120.50." } });
    expect(
      await cancelBooking(
        INITIAL_ACTION_STATE,
        cancelForm(randomUUID(), { refundMode: "amount", amount: "0" }),
      ),
    ).toMatchObject({ ok: false, fieldErrors: { amount: "Enter an amount above zero." } });
    expect(
      await cancelBooking(INITIAL_ACTION_STATE, cancelForm(randomUUID(), { reasonCode: "bored" })),
    ).toMatchObject({ ok: false, fieldErrors: { reasonCode: "Choose a reason." } });
    expect(actionRequests()).toEqual([]);
  });

  it("maps the API's refusals of the money to the dialog's fields", async () => {
    signedIn();
    api.on(CANCEL, () => apiError("UNPROCESSABLE", 422, { details: { reason: "refund_via_airline" } }));
    expect(await cancelBooking(INITIAL_ACTION_STATE, cancelForm(randomUUID()))).toMatchObject({
      ok: false,
      code: "UNPROCESSABLE",
      fieldErrors: {
        refundMode:
          "The airline charged this card: it is refunded by the airline, not from the console. Refund nothing here.",
      },
    });

    api.on(CANCEL, () =>
      apiError("UNPROCESSABLE", 422, {
        details: { reason: "amount_exceeds_captured", refundable: { amount: "100.00", currency: "EUR" } },
      }),
    );
    expect(
      await cancelBooking(
        INITIAL_ACTION_STATE,
        cancelForm(randomUUID(), { refundMode: "amount", amount: "120.50" }),
      ),
    ).toMatchObject({
      ok: false,
      // The API's figure, as the refund dialog says it (FIX-W33-OTA; the reload message before it).
      fieldErrors: { amount: "The amount is above what can still be refunded: at most €100.00." },
    });

    api.on(CANCEL, () => apiError("BOOKING_ALREADY_CANCELLED", 409));
    expect(await cancelBooking(INITIAL_ACTION_STATE, cancelForm(randomUUID()))).toMatchObject({
      ok: false,
      code: "BOOKING_ALREADY_CANCELLED",
      message: "This booking is already cancelled. Reload the page to see its current state.",
    });
  });

  it("[FIX-W33-OTA] [OAD-008] says how much can still be refunded when the cancellation's amount is above it (the API's details.refundable), through the refund dialog's helper", async () => {
    signedIn();
    api.on(CANCEL, () =>
      apiError("UNPROCESSABLE", 422, {
        details: { reason: "amount_exceeds_captured", refundable: { amount: "36.50", currency: "EUR" } },
      }),
    );

    const state = await cancelBooking(
      INITIAL_ACTION_STATE,
      cancelForm(randomUUID(), { refundMode: "amount", amount: "120.50" }),
    );

    const message = "The amount is above what can still be refunded: at most €36.50.";
    expect(state).toMatchObject({
      ok: false,
      code: "UNPROCESSABLE",
      message,
      fieldErrors: { amount: message },
    });
    // A final refusal the API keeps under the key: the corrected amount goes with a new one (FIX-W31-OTA).
    expect(state.nextActionKey).toMatch(/^[0-9a-f-]{36}$/);

    // Without a readable figure, the reload message, as for a refund.
    for (const details of [
      { reason: "amount_exceeds_captured" },
      { reason: "amount_exceeds_captured", refundable: { amount: 36.5, currency: "EUR" } },
    ]) {
      api.on(CANCEL, () => apiError("UNPROCESSABLE", 422, { details }));
      expect(
        await cancelBooking(
          INITIAL_ACTION_STATE,
          cancelForm(randomUUID(), { refundMode: "amount", amount: "120.50" }),
        ),
      ).toMatchObject({
        ok: false,
        fieldErrors: { amount: "The amount is above what can still be refunded. Reload the page to see it." },
      });
    }
  });
});

// ---- patchBooking -----------------------------------------------------------------------------------------------------

describe("patchBooking", () => {
  function patchForm(element: string, fields: Record<string, string>): FormData {
    return formOf({
      bookingId: BOOKING_ID,
      version: VERSION,
      // The dialog posts its key too; a patch sends none (the contract has no Idempotency-Key for PATCH).
      actionKey: randomUUID(),
      element,
      reason: "Name corrected from the passport",
      ...fields,
    });
  }

  it("[OAD-008 AC1] sends PATCH with If-Match of the displayed version and one traveller merged by the API", async () => {
    signedIn("agent", "test");
    api.on(PATCH, () => bookingAnswer());

    const state = await patchBooking(
      INITIAL_ACTION_STATE,
      patchForm("traveler", {
        travelerId: "1",
        firstName: " Anna ",
        lastName: "Berg-Lund",
        dateOfBirth: "1988-04-12",
        gender: "FEMALE",
        email: "anna.berg@example.com",
        phoneCountryCode: "1",
        phoneNumber: "2025550143",
        notifyCustomer: "true",
      }),
    );

    expect(state).toEqual({ ok: true, message: "Saved to the Amadeus order." });
    const request = only(PATCH);
    expect(request.method).toBe("PATCH");
    expect(request.url.pathname).toBe(`/v1/console/bookings/${BOOKING_ID}`);
    expect(request.headers.get("If-Match")).toBe(`"${VERSION}"`);
    expect(request.headers.get("Idempotency-Key")).toBeNull();
    expect(request.headers.get("X-Velexis-Environment")).toBe("test");
    expect(request.body).toEqual({
      reason: "Name corrected from the passport",
      notifyCustomer: true,
      travelers: [
        {
          id: "1",
          name: { firstName: "Anna", lastName: "Berg-Lund" },
          dateOfBirth: "1988-04-12",
          gender: "FEMALE",
          contact: {
            emailAddress: "anna.berg@example.com",
            // The calling code as staff typed it (lead decision (1) of 2026-10-26: `1` is North America's).
            phones: [{ deviceType: "MOBILE", countryCallingCode: "1", number: "2025550143" }],
          },
        },
      ],
    });
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(`/bookings/${BOOKING_ID}`);
  });

  it("sends a contact whole, a new remark and the ticketing agreement as their own elements", async () => {
    signedIn();
    api.on(PATCH, () => bookingAnswer());

    await patchBooking(
      INITIAL_ACTION_STATE,
      patchForm("contact", {
        purpose: "STANDARD",
        language: "en",
        firstName: "ANNA",
        lastName: "BERG",
        email: "anna.berg@example.com",
        phoneCountryCode: "+46",
        phoneNumber: "701234567",
        addressLine1: "Storgatan 1",
        addressLine2: "",
        postalCode: "11122",
        cityName: "Stockholm",
        countryCode: "se",
      }),
    );
    await patchBooking(
      INITIAL_ACTION_STATE,
      patchForm("remark", { remarkType: "GENERAL_MISCELLANEOUS", remarkText: "CALLED THE TRAVELLER" }),
    );
    await patchBooking(
      INITIAL_ACTION_STATE,
      patchForm("ticketingAgreement", { agreementOption: "DELAY_TO_QUEUE", agreementDelay: "2d" }),
    );
    await patchBooking(
      INITIAL_ACTION_STATE,
      patchForm("ticketingAgreement", { agreementOption: "CONFIRM", agreementDelay: "2D" }),
    );

    const bodies = api.sent(PATCH).map((request) => request.body as Record<string, unknown>);
    expect(bodies[0]?.["contacts"]).toEqual([
      {
        purpose: "STANDARD",
        addresseeName: { firstName: "ANNA", lastName: "BERG" },
        emailAddress: "anna.berg@example.com",
        phones: [{ deviceType: "MOBILE", countryCallingCode: "+46", number: "701234567" }],
        address: { lines: ["Storgatan 1"], postalCode: "11122", cityName: "Stockholm", countryCode: "SE" },
        language: "en",
      },
    ]);
    expect(bodies[1]?.["remarks"]).toEqual({
      general: [{ subType: "GENERAL_MISCELLANEOUS", text: "CALLED THE TRAVELLER" }],
    });
    expect(bodies[2]?.["ticketingAgreement"]).toEqual({ option: "DELAY_TO_QUEUE", delay: "2D" });
    expect(bodies[3]?.["ticketingAgreement"]).toEqual({ option: "CONFIRM" });
    for (const body of bodies) {
      expect(Object.keys(body).sort()).toEqual(expect.arrayContaining(["notifyCustomer", "reason"]));
    }
  });

  it("sends back what the dialog does not show of a traveller's contact and of an order contact, the edits over it", async () => {
    signedIn();
    api.on(PATCH, () => bookingAnswer());
    // The stored contacts as the page reads them from console.bookings.get, and posts them (`kept`) with the dialog.
    const travellerContact = {
      emailAddress: "anna.old@example.com",
      phones: [
        { deviceType: "LANDLINE", countryCallingCode: "46", number: "81234567" },
        { deviceType: "MOBILE", countryCallingCode: "46", number: "701234567" },
      ],
      address: { countryCode: "SE" },
      language: "sv",
    };
    const invoiceContact = {
      id: "bco_01JA4CG4W1Z4C7F0J3M6Q9T2X6",
      purpose: "INVOICE",
      isPrimary: false,
      addresseeName: { firstName: "ANNA", middleName: "MARIA", lastName: "BERG" },
      companyName: "BERG AB",
      emailAddress: "invoice@example.com",
      phones: [
        { deviceType: "MOBILE", countryCallingCode: "46", number: "701234567" },
        { deviceType: "FAX", countryCallingCode: "46", number: "81234500" },
      ],
      address: {
        lines: ["Storgatan 1", "Floor 3", "Door 2"],
        postalCode: "11122",
        cityName: "Stockholm",
        countryCode: "SE",
        stateName: "Stockholms lan",
        postalBox: "BOX 220",
      },
      language: "sv",
    };

    await patchBooking(
      INITIAL_ACTION_STATE,
      patchForm("traveler", {
        travelerId: "1",
        firstName: "ANNA",
        lastName: "BERG",
        email: "anna.berg@example.com",
        phoneCountryCode: "46",
        phoneNumber: "87654321",
        kept: keptFieldOf(keptContactOf(travellerContact)) ?? "",
      }),
    );
    await patchBooking(
      INITIAL_ACTION_STATE,
      patchForm("contact", {
        purpose: "INVOICE",
        language: "sv",
        firstName: "ANNA",
        lastName: "BERG-LUND",
        companyName: "BERG OCH LUND AB",
        email: "invoice@example.com",
        phoneCountryCode: "46",
        phoneNumber: "701234567",
        addressLine1: "Storgatan 1",
        addressLine2: "Floor 4",
        postalCode: "11122",
        cityName: "Stockholm",
        countryCode: "SE",
        kept: keptFieldOf(keptContactOf(invoiceContact)) ?? "",
      }),
    );

    const [traveller, contact] = api.sent(PATCH).map((request) => request.body as Record<string, unknown>);
    expect(traveller?.["travelers"]).toEqual([
      {
        id: "1",
        name: { firstName: "ANNA", lastName: "BERG" },
        contact: {
          // The dialog's e-mail and phone, the first phone keeping its device type; the rest as stored.
          emailAddress: "anna.berg@example.com",
          phones: [
            { deviceType: "LANDLINE", countryCallingCode: "46", number: "87654321" },
            { deviceType: "MOBILE", countryCallingCode: "46", number: "701234567" },
          ],
          address: { countryCode: "SE" },
          language: "sv",
        },
      },
    ]);
    expect(contact?.["contacts"]).toEqual([
      {
        purpose: "INVOICE",
        addresseeName: { firstName: "ANNA", middleName: "MARIA", lastName: "BERG-LUND" },
        companyName: "BERG OCH LUND AB",
        emailAddress: "invoice@example.com",
        phones: [
          { deviceType: "MOBILE", countryCallingCode: "46", number: "701234567" },
          { deviceType: "FAX", countryCallingCode: "46", number: "81234500" },
        ],
        address: {
          lines: ["Storgatan 1", "Floor 4", "Door 2"],
          postalCode: "11122",
          cityName: "Stockholm",
          countryCode: "SE",
          stateName: "Stockholms lan",
          postalBox: "BOX 220",
        },
        language: "sv",
      },
    ]);
  });

  it("refuses a stored contact that is not one the page wrote, before the call", async () => {
    signedIn();
    const traveller = {
      travelerId: "1",
      firstName: "ANNA",
      lastName: "BERG",
      email: "anna.berg@example.com",
    };

    for (const kept of [
      "{not json",
      JSON.stringify({ creditCard: { number: "4242424242424242" } }),
      JSON.stringify({ phones: [{ deviceType: "PAGER", number: "1" }] }),
      JSON.stringify({ companyName: "X".repeat(9000) }),
    ]) {
      expect(
        await patchBooking(INITIAL_ACTION_STATE, patchForm("traveler", { ...traveller, kept })),
      ).toMatchObject({
        ok: false,
        code: "VALIDATION_FAILED",
        message: "This form is out of date. Reload the page and try again.",
      });
    }
    expect(actionRequests()).toEqual([]);
  });

  it("[OAD-008 AC1] a stale version answers 412 as 'reload', and the API's field errors land on the dialog's fields", async () => {
    signedIn();
    api.on(PATCH, () => apiError("PRECONDITION_FAILED", 412, { details: { currentVersion: 5 } }));

    expect(
      await patchBooking(
        INITIAL_ACTION_STATE,
        patchForm("remark", { remarkType: "ITINERARY", remarkText: "X" }),
      ),
    ).toEqual({
      ok: false,
      code: "PRECONDITION_FAILED",
      message: "This record changed; reload to see the latest version.",
      requestId: "req_fake_1",
    });

    api.on(PATCH, () =>
      apiError("VALIDATION_FAILED", 400, {
        fieldErrors: [
          { path: "/travelers/0/name/lastName", code: "pattern" },
          {
            path: "/travelers/0/contact/phones/0/countryCallingCode",
            code: "pattern",
            message: "1 to 3 digits.",
          },
          { path: "/header/If-Match", code: "format" },
        ],
      }),
    );
    expect(
      await patchBooking(
        INITIAL_ACTION_STATE,
        patchForm("traveler", {
          travelerId: "1",
          firstName: "ANNA",
          lastName: "B3RG",
          phoneCountryCode: "46",
          phoneNumber: "1",
        }),
      ),
    ).toMatchObject({
      ok: false,
      code: "VALIDATION_FAILED",
      fieldErrors: {
        lastName: "Not in the expected format.",
        phoneCountryCode: "1 to 3 digits.",
        ifMatch: "Not in the expected format.",
      },
    });
  });

  it("refuses a phone in one part, a delay without days, and a tampered version before the call", async () => {
    signedIn();

    expect(
      await patchBooking(
        INITIAL_ACTION_STATE,
        patchForm("traveler", {
          travelerId: "1",
          firstName: "ANNA",
          lastName: "BERG",
          phoneNumber: "701234567",
        }),
      ),
    ).toMatchObject({
      ok: false,
      fieldErrors: { phoneCountryCode: "Required with the other part of the phone number." },
    });
    expect(
      await patchBooking(
        INITIAL_ACTION_STATE,
        patchForm("ticketingAgreement", { agreementOption: "DELAY_TO_CANCEL" }),
      ),
    ).toMatchObject({ ok: false, fieldErrors: { agreementDelay: "Required for this option." } });
    expect(
      await patchBooking(
        INITIAL_ACTION_STATE,
        formOf({
          ...Object.fromEntries(patchForm("remark", { remarkType: "ITINERARY", remarkText: "X" })),
          version: "3; DROP",
        }),
      ),
    ).toMatchObject({ ok: false, message: "This form is out of date. Reload the page and try again." });
    expect(
      await patchBooking(
        INITIAL_ACTION_STATE,
        patchForm("formOfPayments", { creditCard: "4242424242424242" }),
      ),
    ).toMatchObject({ ok: false, message: "This form is out of date. Reload the page and try again." });
    expect(actionRequests()).toEqual([]);
  });
});

// ---- resyncBooking ----------------------------------------------------------------------------------------------------

describe("resyncBooking", () => {
  it("[OAD-008 AC1] sends POST /resync in the switch's environment and answers the changes it applied", async () => {
    signedIn("agent", "live");
    api.on(RESYNC, () =>
      Response.json({
        booking: { id: BOOKING_ID, status: "ticketed", version: 5, warnings: [] },
        changes: [
          {
            path: "/itineraries/0/segments/0/departure/at",
            label: "Departure of AF6",
            before: "2026-11-20T10:25:00",
            after: "2026-11-20T11:05:00",
          },
          { path: "/ticketing/status", label: "Ticketing status", before: null, after: { status: "issued" } },
        ],
        statusChanged: false,
        previousStatus: "ticketed",
      }),
    );

    const state = await resyncBooking(INITIAL_ACTION_STATE, formOf({ bookingId: BOOKING_ID }));

    expect(state).toEqual({
      ok: true,
      message: "Synchronised with Amadeus: 2 changes.",
      changes: [
        {
          path: "/itineraries/0/segments/0/departure/at",
          label: "Departure of AF6",
          before: "2026-11-20T10:25:00",
          after: "2026-11-20T11:05:00",
        },
        {
          path: "/ticketing/status",
          label: "Ticketing status",
          before: "none",
          after: '{"status":"issued"}',
        },
      ],
    });
    const request = only(RESYNC);
    expect(request.method).toBe("POST");
    expect(request.headers.get("If-Match")).toBeNull();
    expect(request.headers.get("X-Velexis-Environment")).toBe("live");
  });

  it("answers the API's throttle with its wait", async () => {
    signedIn();
    api.on(RESYNC, () => rateLimited());

    expect(await resyncBooking(INITIAL_ACTION_STATE, formOf({ bookingId: BOOKING_ID }))).toMatchObject({
      ok: false,
      code: "RATE_LIMITED",
      message: "Too many requests, retry in 60 s.",
    });
  });
});

// ---- addNote ----------------------------------------------------------------------------------------------------------

describe("addNote", () => {
  it("[OAD-008 AC1] sends POST /notes with the form's key, the same on a double submit, internal unless ticked", async () => {
    signedIn();
    api.on(NOTES, () =>
      Response.json(
        { id: "evt_01JA4F7H2K5N8Q1T4W7Z0C3F6K", text: "x", visibleToCustomer: false },
        { status: 201 },
      ),
    );
    const key = randomUUID();
    const form = formOf({ bookingId: BOOKING_ID, actionKey: key, text: "  Called the traveller.  " });

    await addNote(INITIAL_ACTION_STATE, form);
    const second = await addNote(INITIAL_ACTION_STATE, form);
    await addNote(
      INITIAL_ACTION_STATE,
      formOf({
        bookingId: BOOKING_ID,
        actionKey: randomUUID(),
        text: "Seat request passed on.",
        visibleToCustomer: "true",
      }),
    );

    expect(second).toEqual({ ok: true, message: "Note added." });
    const sent = api.sent(NOTES);
    expect(sent.map((request) => request.headers.get("Idempotency-Key")).slice(0, 2)).toEqual([key, key]);
    expect(sent[2]?.headers.get("Idempotency-Key")).not.toBe(key);
    expect(sent.map((request) => request.body)).toEqual([
      { text: "Called the traveller.", visibleToCustomer: false },
      { text: "Called the traveller.", visibleToCustomer: false },
      { text: "Seat request passed on.", visibleToCustomer: true },
    ]);
    expect(sent.every((request) => request.headers.get("X-Velexis-Environment") === "test")).toBe(true);
  });

  it("refuses an empty note before the call", async () => {
    signedIn();

    expect(
      await addNote(
        INITIAL_ACTION_STATE,
        formOf({ bookingId: BOOKING_ID, actionKey: randomUUID(), text: "   " }),
      ),
    ).toMatchObject({ ok: false, fieldErrors: { text: "Enter the note." } });
    expect(actionRequests()).toEqual([]);
  });
});

// ---- capturePayment and refundPayment ---------------------------------------------------------------------------------

describe("capturePayment", () => {
  function captureForm(key: string, extra: Record<string, string> = {}): FormData {
    return formOf({
      paymentId: PAYMENT_ID,
      bookingId: BOOKING_ID,
      version: PAYMENT_VERSION,
      actionKey: key,
      reason: "Traveller confirmed the trip",
      currency: "EUR",
      ...extra,
    });
  }

  it("[OAD-008 AC1] sends POST /capture with If-Match of the payment's version and the dialog's key twice on a double submit", async () => {
    signedIn("finance");
    api.on(CAPTURE, () => paymentAnswer({ amountCaptured: { amount: "1000.00", currency: "EUR" } }));
    const key = randomUUID();
    const form = captureForm(key, { amount: "1000.00" });

    const first = await capturePayment(INITIAL_ACTION_STATE, form);
    await capturePayment(INITIAL_ACTION_STATE, form);
    await capturePayment(INITIAL_ACTION_STATE, captureForm(randomUUID()));

    expect(first).toEqual({ ok: true, message: "Captured €1,000.00." });
    const sent = api.sent(CAPTURE);
    expect(sent.map((request) => request.headers.get("Idempotency-Key")).slice(0, 2)).toEqual([key, key]);
    expect(sent[2]?.headers.get("Idempotency-Key")).not.toBe(key);
    expect(sent.map((request) => request.headers.get("If-Match"))).toEqual([
      `"${PAYMENT_VERSION}"`,
      `"${PAYMENT_VERSION}"`,
      `"${PAYMENT_VERSION}"`,
    ]);
    expect(sent.map((request) => request.body)).toEqual([
      { reason: "Traveller confirmed the trip", amount: { amount: "1000.00", currency: "EUR" } },
      { reason: "Traveller confirmed the trip", amount: { amount: "1000.00", currency: "EUR" } },
      // An empty amount captures the whole authorisation.
      { reason: "Traveller confirmed the trip" },
    ]);
    expect(sent.every((request) => request.headers.get("X-Velexis-Environment") === "test")).toBe(true);
    expect(nextCache.revalidatePath).toHaveBeenCalledWith(`/bookings/${BOOKING_ID}`);
  });

  it("answers an expired authorisation and a payment that is no longer capturable in the page's words", async () => {
    signedIn();
    api.on(CAPTURE, () => apiError("PAYMENT_DECLINED", 402));
    expect(await capturePayment(INITIAL_ACTION_STATE, captureForm(randomUUID()))).toMatchObject({
      ok: false,
      code: "PAYMENT_DECLINED",
      message: "The authorisation has expired; contact the traveller.",
    });

    api.on(CAPTURE, () => apiError("CONFLICT", 409, { details: { reason: "payment_not_capturable" } }));
    expect(await capturePayment(INITIAL_ACTION_STATE, captureForm(randomUUID()))).toMatchObject({
      ok: false,
      code: "CONFLICT",
      message: "This payment can no longer be captured in its current state. Reload the page.",
    });
  });
});

describe("refundPayment", () => {
  function refundForm(key: string, extra: Record<string, string> = {}): FormData {
    return formOf({
      paymentId: PAYMENT_ID,
      bookingId: BOOKING_ID,
      actionKey: key,
      reason: "Goodwill after the schedule change",
      refundReason: "goodwill",
      amount: "50.00",
      currency: "EUR",
      ...extra,
    });
  }

  it("[OAD-008 AC1] sends POST /refunds with the dialog's key twice on a double submit, the category and the note", async () => {
    signedIn("finance");
    api.on(REFUND, () => Response.json({ payment: {}, refund: { status: "pending" } }, { status: 201 }));
    const key = randomUUID();

    const state = await refundPayment(INITIAL_ACTION_STATE, refundForm(key));
    await refundPayment(INITIAL_ACTION_STATE, refundForm(key));

    expect(state).toEqual({ ok: true, message: "Refund of €50.00 requested: Stripe completes it." });
    const sent = api.sent(REFUND);
    expect(sent.map((request) => request.headers.get("Idempotency-Key"))).toEqual([key, key]);
    for (const request of sent) {
      expect(request.method).toBe("POST");
      expect(request.headers.get("If-Match")).toBeNull();
      expect(request.headers.get("X-Velexis-Environment")).toBe("test");
      expect(request.body).toEqual({
        amount: { amount: "50.00", currency: "EUR" },
        reason: "goodwill",
        reasonNote: "Goodwill after the schedule change",
      });
    }
  });

  it("[FIX-W32-OTA AC7] says how much can still be refunded when the amount is above it (the API's details.refundable), on the amount", async () => {
    signedIn("owner");
    api.on(REFUND, () =>
      apiError("UNPROCESSABLE", 422, {
        details: { reason: "amount_exceeds_captured", refundable: { amount: "36.50", currency: "EUR" } },
      }),
    );

    const state = await refundPayment(INITIAL_ACTION_STATE, refundForm(randomUUID()));

    const message = "The amount is above what can still be refunded: at most €36.50.";
    expect(state).toMatchObject({
      ok: false,
      code: "UNPROCESSABLE",
      message,
      fieldErrors: { amount: message },
    });
    // A final refusal the API keeps under the key: the corrected amount goes with a new one (FIX-W31-OTA).
    expect(state.nextActionKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("[FIX-W32-OTA AC7] falls back to the reload message when the refusal carries no readable refundable amount", async () => {
    signedIn("owner");
    for (const details of [
      { reason: "amount_exceeds_captured" },
      { reason: "amount_exceeds_captured", refundable: { amount: 36.5, currency: "EUR" } },
      { reason: "amount_exceeds_captured", refundable: { amount: "36.50", currency: "euro" } },
    ]) {
      api.on(REFUND, () => apiError("UNPROCESSABLE", 422, { details }));
      expect(await refundPayment(INITIAL_ACTION_STATE, refundForm(randomUUID()))).toMatchObject({
        ok: false,
        message: "The amount is above what can still be refunded. Reload the page to see it.",
      });
    }
  });

  it("answers an airline-card payment's refusal: the airline refunds it", async () => {
    signedIn("owner");
    api.on(REFUND, () => apiError("UNPROCESSABLE", 422, { details: { reason: "refund_via_airline" } }));

    expect(await refundPayment(INITIAL_ACTION_STATE, refundForm(randomUUID()))).toMatchObject({
      ok: false,
      code: "UNPROCESSABLE",
      message:
        "The airline charged this card: it is refunded by the airline, not from the console. Refund nothing here.",
    });
  });
});

// ---- Every action -----------------------------------------------------------------------------------------------------

/** One valid submission of each action, and the route it sends. */
const SUBMISSIONS: readonly {
  readonly name: string;
  readonly permission: string;
  readonly route: string;
  readonly run: () => Promise<ActionState>;
  readonly answer: () => Response;
}[] = [
  {
    name: "issueTickets",
    permission: "bookings:issue",
    route: ISSUE,
    run: () =>
      issueTickets(
        INITIAL_ACTION_STATE,
        formOf({ bookingId: BOOKING_ID, version: VERSION, actionKey: randomUUID(), reason: REASON }),
      ),
    answer: () => bookingAnswer(),
  },
  {
    name: "cancelBooking",
    permission: "bookings:cancel",
    route: CANCEL,
    run: () =>
      cancelBooking(
        INITIAL_ACTION_STATE,
        formOf({
          bookingId: BOOKING_ID,
          version: VERSION,
          actionKey: randomUUID(),
          reason: REASON,
          reasonCode: "other",
          refundMode: "none",
          currency: "EUR",
        }),
      ),
    answer: () => bookingAnswer({ status: "cancelled" }),
  },
  {
    name: "patchBooking",
    permission: "bookings:write",
    route: PATCH,
    run: () =>
      patchBooking(
        INITIAL_ACTION_STATE,
        formOf({
          bookingId: BOOKING_ID,
          version: VERSION,
          actionKey: randomUUID(),
          reason: REASON,
          element: "remark",
          remarkType: "ITINERARY",
          remarkText: "OK",
        }),
      ),
    answer: () => bookingAnswer(),
  },
  {
    name: "resyncBooking",
    permission: "bookings:write",
    route: RESYNC,
    run: () => resyncBooking(INITIAL_ACTION_STATE, formOf({ bookingId: BOOKING_ID })),
    answer: () =>
      Response.json({ booking: {}, changes: [], statusChanged: false, previousStatus: "ticketed" }),
  },
  {
    name: "addNote",
    permission: "bookings:write",
    route: NOTES,
    run: () =>
      addNote(INITIAL_ACTION_STATE, formOf({ bookingId: BOOKING_ID, actionKey: randomUUID(), text: "Note" })),
    answer: () => Response.json({ id: "evt_1" }, { status: 201 }),
  },
  {
    name: "capturePayment",
    permission: "payments:capture",
    route: CAPTURE,
    run: () =>
      capturePayment(
        INITIAL_ACTION_STATE,
        formOf({
          paymentId: PAYMENT_ID,
          version: PAYMENT_VERSION,
          actionKey: randomUUID(),
          reason: REASON,
          currency: "EUR",
        }),
      ),
    answer: () => paymentAnswer(),
  },
  {
    name: "refundPayment",
    permission: "payments:refund",
    route: REFUND,
    run: () =>
      refundPayment(
        INITIAL_ACTION_STATE,
        formOf({
          paymentId: PAYMENT_ID,
          actionKey: randomUUID(),
          reason: REASON,
          refundReason: "other",
          amount: "1.00",
          currency: "EUR",
        }),
      ),
    answer: () => Response.json({ payment: {}, refund: {} }, { status: 201 }),
  },
];

describe("every action", () => {
  it("[OAD-008 AC1] sends X-Velexis-Environment of the switch (live here) on its call", async () => {
    signedIn("owner", "live");
    for (const submission of SUBMISSIONS) {
      api.on(submission.route, submission.answer);
      expect(await submission.run(), submission.name).toMatchObject({ ok: true });
    }

    for (const route of ACTION_ROUTES) {
      expect(only(route).headers.get("X-Velexis-Environment"), route).toBe("live");
    }
    expect(api.sent(ME).every((request) => request.headers.get("X-Velexis-Environment") === "live")).toBe(
      true,
    );
  });

  it("starts with requireStaff(permission): a viewer is refused with the permission named, before any call", async () => {
    signedIn("viewer");
    for (const submission of SUBMISSIONS) {
      expect(await submission.run(), submission.name).toEqual({
        ok: false,
        code: "FORBIDDEN",
        message: `You do not have permission to do this (${submission.permission}).`,
      });
    }
    // Even a form the schema would refuse gets the permission's answer first.
    expect(await issueTickets(INITIAL_ACTION_STATE, new FormData())).toMatchObject({ code: "FORBIDDEN" });

    expect(actionRequests()).toEqual([]);
    expect(api.sent(ME)).toHaveLength(SUBMISSIONS.length + 1);
  });

  it("sends a staff member whose session ended to the portal", async () => {
    signedIn();
    api.on(ME, () => apiError("UNAUTHENTICATED", 401));

    for (const submission of SUBMISSIONS) {
      expect(await redirectOf(submission.run), submission.name).toBe(
        `${TEST_PORTAL_URL}/console?tenant=${TENANT_ID}`,
      );
    }
    expect(actionRequests()).toEqual([]);
  });
});

// ---- The idempotency key after a refusal (FIX-W31-OTA) ----------------------------------------------------------------

describe("the idempotency key after a refusal (OADR-0018 point 5, revision of 2026-10-27)", () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  /** The cancel dialog's form with mode `amount`: what staff typed, and the key the dialog holds. */
  function cancelAmountForm(key: string, amount: string): FormData {
    return formOf({
      bookingId: BOOKING_ID,
      version: VERSION,
      actionKey: key,
      reason: "Change fee kept, the rest refunded",
      reasonCode: "customer_request",
      refundMode: "amount",
      amount,
      currency: "EUR",
    });
  }

  /**
   * `route` as the OTA API answers it with idempotency keys (idempotency.service.ts): a first request is answered by
   * `answer`, and a 2xx or a final 4xx (not `429`) is kept under its key; the same key with the same body replays the
   * kept answer, with another body it is `409 IDEMPOTENCY_KEY_REUSED`. Transient answers (`429`, `5xx`) are not kept.
   */
  function keyedRoute(route: string, answer: (body: unknown) => Response): void {
    const kept = new Map<string, { readonly body: string; readonly response: Response }>();
    api.on(route, (request) => {
      const key = request.headers.get("Idempotency-Key") ?? "";
      const body = JSON.stringify(request.body ?? null);
      const known = kept.get(key);
      if (known !== undefined) {
        return known.body === body ? known.response.clone() : apiError("IDEMPOTENCY_KEY_REUSED", 409);
      }
      const response = answer(request.body);
      if (response.status < 500 && response.status !== 429) {
        kept.set(key, { body, response: response.clone() });
      }
      return response;
    });
  }

  /** The `Idempotency-Key` of every request of `route`, in order. */
  const keysSent = (route: string) =>
    api.sent(route).map((request) => request.headers.get("Idempotency-Key"));

  it("[FIX-W31-OTA AC2] a 422 then a corrected resubmit sends a new key and succeeds", async () => {
    signedIn();
    keyedRoute(CANCEL, (body) =>
      Number((body as { refund?: { amount?: { amount?: string } } }).refund?.amount?.amount) > 100
        ? apiError("UNPROCESSABLE", 422, {
            details: { reason: "amount_exceeds_captured", refundable: { amount: "100.00", currency: "EUR" } },
          })
        : bookingAnswer({ status: "cancelled" }),
    );
    const rendered = randomUUID();

    const refused = await cancelBooking(INITIAL_ACTION_STATE, cancelAmountForm(rendered, "120.50"));

    expect(refused).toMatchObject({
      ok: false,
      code: "UNPROCESSABLE",
      // The API's figure since FIX-W33-OTA, as the refund dialog says it.
      fieldErrors: { amount: "The amount is above what can still be refunded: at most €100.00." },
    });
    expect(refused.nextActionKey).toMatch(UUID);
    expect(refused.nextActionKey).not.toBe(rendered);
    // The dialog's next submission sends the new key (ConfirmDialog's useActionKey: actionKeyAfter).
    const next = actionKeyAfter(rendered, refused);
    expect(next).toBe(refused.nextActionKey);

    const corrected = await cancelBooking(refused, cancelAmountForm(next, "90.00"));

    expect(corrected).toEqual({ ok: true, message: "Booking cancelled." });
    expect(keysSent(CANCEL)).toEqual([rendered, next]);
    expect(api.sent(CANCEL).map((request) => request.body)).toMatchObject([
      { refund: { mode: "amount", amount: { amount: "120.50", currency: "EUR" } } },
      { refund: { mode: "amount", amount: { amount: "90.00", currency: "EUR" } } },
    ]);
    // The rendered key is used up: the corrected form under it would only get 409 IDEMPOTENCY_KEY_REUSED, which since
    // the revision of 2026-10-28 brings no new key but a reload (the next test, FIX-W32-OTA AC3).
    const reused = await cancelBooking(refused, cancelAmountForm(rendered, "90.00"));
    expect(reused).toMatchObject({ ok: false, code: "IDEMPOTENCY_KEY_REUSED" });
    expect(reused.nextActionKey).toBeUndefined();
  });

  it("[FIX-W32-OTA AC3] hands no new key after 409 IDEMPOTENCY_KEY_REUSED and asks for a reload: the earlier request under the key may still be running", async () => {
    signedIn("owner");
    let calls = 0;
    keyedRoute(REFUND, () => {
      calls += 1;
      // The first answer is a 504 (never kept under the key); the retry with the same values makes the refund (201,
      // kept under the key).
      return calls === 1
        ? apiError("SUPPLIER_TIMEOUT", 504, {}, { "Retry-After": "60" })
        : Response.json({ payment: {}, refund: { status: "pending" } }, { status: 201 });
    });
    const rendered = randomUUID();
    const refundForm = (key: string, amount: string) =>
      formOf({
        paymentId: PAYMENT_ID,
        bookingId: BOOKING_ID,
        actionKey: key,
        reason: "Goodwill after the schedule change",
        refundReason: "goodwill",
        amount,
        currency: "EUR",
      });

    const timedOut = await refundPayment(INITIAL_ACTION_STATE, refundForm(rendered, "50.00"));
    expect(timedOut).toMatchObject({ ok: false, code: "SUPPLIER_TIMEOUT" });
    expect(timedOut.nextActionKey).toBeUndefined();
    const kept = await refundPayment(timedOut, refundForm(rendered, "50.00"));
    expect(kept).toEqual({ ok: true, message: "Refund of €50.00 requested: Stripe completes it." });
    // Another tab of the same render, which saw only the 504, sends the key with another amount: the API refuses the
    // key, which holds the refund made under it.
    const reused = await refundPayment(timedOut, refundForm(rendered, "40.00"));

    expect(reused).toMatchObject({
      ok: false,
      code: "IDEMPOTENCY_KEY_REUSED",
      message:
        "This form was already sent with other values, and that request may still be running. Reload the page to see what it did before you send it again.",
    });
    // No new key: a new one would send a second refund next to the one the key already made.
    expect(reused.nextActionKey).toBeUndefined();
    const again = actionKeyAfter(rendered, reused);
    expect(again).toBe(rendered);
    expect(await refundPayment(reused, refundForm(again, "40.00"))).toMatchObject({
      ok: false,
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    expect(keysSent(REFUND)).toEqual([rendered, rendered, rendered, rendered]);
    // One refund was made: the second request replayed the first one's kept answer.
    expect(calls).toBe(2);
  });

  it("[FIX-W32-OTA AC3] hands no new key to any keyed action after 409 IDEMPOTENCY_KEY_REUSED, and still one after another stored 4xx", async () => {
    signedIn("owner");
    const keyed = new Set(["issueTickets", "cancelBooking", "addNote", "capturePayment", "refundPayment"]);
    for (const submission of SUBMISSIONS.filter((entry) => keyed.has(entry.name))) {
      api.on(submission.route, () => apiError("IDEMPOTENCY_KEY_REUSED", 409));
      const state = await submission.run();
      expect(state, submission.name).toMatchObject({ ok: false, code: "IDEMPOTENCY_KEY_REUSED" });
      expect(state.message, submission.name).toMatch(/Reload the page/);
      expect(state.nextActionKey, submission.name).toBeUndefined();
    }
  });

  it("[FIX-W31-OTA AC2] a 503 then a resubmit sends the same key, which runs the request once", async () => {
    signedIn();
    let calls = 0;
    keyedRoute(CANCEL, () => {
      calls += 1;
      // `Retry-After` above 30 s ends the SDK's call at once instead of its own retries.
      return calls === 1
        ? apiError("SERVICE_UNAVAILABLE", 503, {}, { "Retry-After": "60" })
        : bookingAnswer({ status: "cancelled" });
    });
    const rendered = randomUUID();
    const form = cancelAmountForm(rendered, "90.00");

    const busy = await cancelBooking(INITIAL_ACTION_STATE, form);

    expect(busy).toMatchObject({ ok: false, code: "SERVICE_UNAVAILABLE" });
    expect(busy.nextActionKey).toBeUndefined();
    const again = actionKeyAfter(rendered, busy);
    expect(again).toBe(rendered);
    expect(await cancelBooking(busy, cancelAmountForm(again, "90.00"))).toEqual({
      ok: true,
      message: "Booking cancelled.",
    });
    expect(keysSent(CANCEL)).toEqual([rendered, rendered]);
  });

  it("[FIX-W31-OTA AC2] a 412 keeps the key, and so do a 504, a 429 and a request still running under the key", async () => {
    signedIn();
    const cases: [Response, string][] = [
      [apiError("PRECONDITION_FAILED", 412, { details: { currentVersion: 4 } }), "PRECONDITION_FAILED"],
      [apiError("SUPPLIER_TIMEOUT", 504, {}, { "Retry-After": "60" }), "SUPPLIER_TIMEOUT"],
      [rateLimited(), "RATE_LIMITED"],
      [apiError("CONFLICT", 409, { details: { reason: "idempotency_key_in_use" } }), "CONFLICT"],
    ];
    for (const [answer, code] of cases) {
      api.on(ISSUE, () => answer.clone());
      const rendered = randomUUID();
      const state = await issueTickets(
        INITIAL_ACTION_STATE,
        formOf({
          bookingId: BOOKING_ID,
          version: VERSION,
          actionKey: rendered,
          reason: REASON,
          notifyCustomer: "true",
        }),
      );
      expect(state, code).toMatchObject({ ok: false, code });
      expect(state.nextActionKey, code).toBeUndefined();
      expect(actionKeyAfter(rendered, state), code).toBe(rendered);
    }
  });

  it("[FIX-W31-OTA AC2] gives every keyed action a new key after a final 4xx, and none to a patch or a resync, which send none", async () => {
    signedIn("owner");
    const keyed = new Set(["issueTickets", "cancelBooking", "addNote", "capturePayment", "refundPayment"]);
    for (const submission of SUBMISSIONS) {
      api.on(submission.route, () =>
        apiError("BOOKING_NOT_MODIFIABLE", 409, { details: { reason: "pending" } }),
      );
      const state = await submission.run();
      expect(state, submission.name).toMatchObject({ ok: false, code: "BOOKING_NOT_MODIFIABLE" });
      if (keyed.has(submission.name)) {
        expect(state.nextActionKey, submission.name).toMatch(UUID);
      } else {
        expect(state.nextActionKey, submission.name).toBeUndefined();
      }
    }
    expect(SUBMISSIONS.map((submission) => submission.name).filter((name) => keyed.has(name))).toHaveLength(
      keyed.size,
    );
    // A refusal before the call used no key: it keeps the one the dialog holds.
    const beforeTheCall = await issueTickets(INITIAL_ACTION_STATE, formOf({ bookingId: BOOKING_ID }));
    expect(beforeTheCall).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    expect(beforeTheCall.nextActionKey).toBeUndefined();
  });
});
