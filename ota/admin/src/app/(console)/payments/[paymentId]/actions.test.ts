// The server actions of a payment's page (OAD-011) against the fake OTA API (OADR-0018 point 10): the real actions (and
// the booking page's actions they run), `requireStaff` and the SDK, with the SDK's `fetch` answered by
// src/test/fake-ota-api.ts, so each test checks the exact request an action sends (method, path, `If-Match`,
// `Idempotency-Key`, `X-Velexis-Environment`, body), the state it answers and the pages it revalidates, without a
// running backend. Next.js's request scope (`cookies()`, `headers()`), `redirect()` and `revalidatePath()` are mocked.
// Every token, id and name here is a dummy.
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

import { INITIAL_ACTION_STATE, type ActionState } from "@/lib/action-state";
import {
  ENVIRONMENT_COOKIE,
  STAFF_ACCESS_TOKEN_COOKIE,
  STAFF_REFRESH_TOKEN_COOKIE,
  TENANT_COOKIE,
} from "@/lib/session";

import { capturePayment, refundPayment } from "./actions";

const PAYMENT_ID = "pay_01JA4CF2R7V0Y3B6D9G2K5N8Q1";
const BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2";
const PAYMENT_VERSION = "2";
const REASON = "Traveller confirmed the trip by phone";

const ME = "GET /v1/console/auth/me";
const CAPTURE = `POST /v1/console/payments/${PAYMENT_ID}/capture`;
const REFUND = `POST /v1/console/payments/${PAYMENT_ID}/refunds`;

/** The words of the payment's dialogs for the API's refusals (bookings/[bookingId]/actions.ts). */
const MESSAGES = Object.freeze({
  amountExceedsCaptured: "The amount is above what can still be refunded. Reload the page to see it.",
  refundViaAirline:
    "The airline charged this card: it is refunded by the airline, not from the console. Refund nothing here.",
  authorisationExpired: "The authorisation has expired; contact the traveller.",
  providerError: "Stripe did not answer. Send the same form again: the payment is captured once.",
  stale: "This form is out of date. Reload the page and try again.",
  reload: "This record changed; reload to see the latest version.",
});

let api: FakeOtaApi;
let sequence = 0;

/** The cookies of a signed-in staff member of `role` whose switch says `environment`. */
function signedIn(role: StaffRole = "finance", environment: "test" | "live" = "test"): void {
  sequence += 1;
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`payment-actions-${sequence}`, Date.now(), 900),
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-payment-actions-${sequence}`,
      [ENVIRONMENT_COOKIE]: environment,
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
  api.on(ME, () => Response.json(staffProfile({ role }), { headers: { "X-Request-Id": "req_me" } }));
}

/** The form a dialog of the payment's page posts. */
function formOf(fields: Readonly<Record<string, string>>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    form.set(name, value);
  }
  return form;
}

/** The capture dialog's form: the payment, its booking when it has one, its version and the page's key. */
function captureForm(key: string, extra: Record<string, string> = {}): FormData {
  return formOf({
    paymentId: PAYMENT_ID,
    bookingId: BOOKING_ID,
    version: PAYMENT_VERSION,
    actionKey: key,
    reason: REASON,
    currency: "EUR",
    ...extra,
  });
}

/** The refund dialog's form: the payment, its booking, the amount, the category, the reason and the page's key. */
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

/** A payment as console.payments.capture and .refund answer it (the fields the actions read). */
function paymentAnswer(overrides: Record<string, unknown> = {}, status = 200): Response {
  return Response.json(
    {
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      provider: "stripe",
      method: "card",
      status: "captured",
      amount: { amount: "1414.06", currency: "EUR" },
      amountAuthorized: { amount: "1414.06", currency: "EUR" },
      amountCaptured: { amount: "1414.06", currency: "EUR" },
      amountRefunded: { amount: "0.00", currency: "EUR" },
      version: 3,
      refunds: [],
      ...overrides,
    },
    { status, headers: { ETag: '"3"', "X-Request-Id": "req_payment" } },
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

/** The paths the action revalidated. */
function revalidated(): string[] {
  return nextCache.revalidatePath.mock.calls.map(([path]) => String(path));
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

// ---- refundPayment --------------------------------------------------------------------------------------------------

describe("refundPayment", () => {
  it("[OAD-011 AC1] a refund above what is still refundable shows the API's refusal on the amount, with the request id", async () => {
    signedIn("finance");
    api.on(REFUND, () =>
      apiError("UNPROCESSABLE", 422, {
        details: { reason: "amount_exceeds_captured", refundable: { amount: "1314.06", currency: "EUR" } },
      }),
    );

    const state = await refundPayment(INITIAL_ACTION_STATE, refundForm(randomUUID(), { amount: "2000.00" }));

    expect(state).toMatchObject({
      ok: false,
      code: "UNPROCESSABLE",
      message: MESSAGES.amountExceedsCaptured,
      requestId: "req_fake_1",
      fieldErrors: { amount: MESSAGES.amountExceedsCaptured },
    });
    // The amount went to the API, which decided: the page refuses nothing it cannot know.
    expect(only(REFUND).body).toMatchObject({ amount: { amount: "2000.00", currency: "EUR" } });
    // Nothing changed: no page is revalidated, so the dialog stays open with its message.
    expect(revalidated()).toEqual([]);
  });

  it("[OAD-011 AC1] an agent cannot refund: refused with the permission named before any call", async () => {
    signedIn("agent");

    const state = await refundPayment(INITIAL_ACTION_STATE, refundForm(randomUUID()));

    expect(state).toEqual({
      ok: false,
      code: "FORBIDDEN",
      message: "You do not have permission to do this (payments:refund).",
    });
    expect(actionRequests()).toEqual([]);
    expect(revalidated()).toEqual([]);
  });

  it("sends POST /refunds with the dialog's key twice on a double submit, the category and the note; revalidates the pages", async () => {
    signedIn("owner");
    api.on(REFUND, () => paymentAnswer({}, 201));
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
      expect(request.headers.get("X-Api-Key")).toBe(TEST_CONFIG.OTA_ADMIN_SERVICE_KEY);
      expect(request.body).toEqual({
        amount: { amount: "50.00", currency: "EUR" },
        reason: "goodwill",
        reasonNote: "Goodwill after the schedule change",
      });
    }
    // The payment's page, the list and the booking's page show the refund after the success.
    expect(new Set(revalidated())).toEqual(
      new Set([`/payments/${PAYMENT_ID}`, "/payments", `/bookings/${BOOKING_ID}`]),
    );
  });

  it("refunds a payment without a booking and revalidates the payment's pages only", async () => {
    signedIn("finance");
    api.on(REFUND, () => paymentAnswer({ bookingId: null }, 201));
    const form = refundForm(randomUUID());
    form.delete("bookingId");

    expect(await refundPayment(INITIAL_ACTION_STATE, form)).toMatchObject({ ok: true });

    expect(only(REFUND).url.pathname).toBe(`/v1/console/payments/${PAYMENT_ID}/refunds`);
    expect(new Set(revalidated())).toEqual(new Set([`/payments/${PAYMENT_ID}`, "/payments"]));
  });

  it("answers an airline-card payment's refusal in the page's words: the airline refunds it", async () => {
    signedIn("owner");
    api.on(REFUND, () => apiError("UNPROCESSABLE", 422, { details: { reason: "refund_via_airline" } }));

    expect(await refundPayment(INITIAL_ACTION_STATE, refundForm(randomUUID()))).toMatchObject({
      ok: false,
      code: "UNPROCESSABLE",
      message: MESSAGES.refundViaAirline,
      requestId: "req_fake_1",
    });
    expect(revalidated()).toEqual([]);
  });

  it("refuses an amount that is not one, and a forged payment id, before the call", async () => {
    signedIn("finance");

    expect(
      await refundPayment(INITIAL_ACTION_STATE, refundForm(randomUUID(), { amount: "12,5" })),
    ).toMatchObject({
      ok: false,
      code: "VALIDATION_FAILED",
      fieldErrors: { amount: "Enter an amount like 120.50." },
    });
    expect(
      await refundPayment(INITIAL_ACTION_STATE, refundForm(randomUUID(), { paymentId: "../../payments" })),
    ).toMatchObject({ ok: false, code: "VALIDATION_FAILED", message: MESSAGES.stale });

    expect(actionRequests()).toEqual([]);
    expect(revalidated()).toEqual([]);
  });
});

// ---- capturePayment -------------------------------------------------------------------------------------------------

describe("capturePayment", () => {
  it("sends POST /capture with If-Match of the payment's version and the dialog's key twice on a double submit", async () => {
    signedIn("agent");
    api.on(CAPTURE, () => paymentAnswer({ amountCaptured: { amount: "1000.00", currency: "EUR" } }));
    const key = randomUUID();
    const form = captureForm(key, { amount: "1000.00" });

    const first = await capturePayment(INITIAL_ACTION_STATE, form);
    await capturePayment(INITIAL_ACTION_STATE, form);
    // The page's render after the success gives the dialog a new key; an empty amount captures everything.
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
      { reason: REASON, amount: { amount: "1000.00", currency: "EUR" } },
      { reason: REASON, amount: { amount: "1000.00", currency: "EUR" } },
      { reason: REASON },
    ]);
    expect(new Set(revalidated())).toEqual(
      new Set([`/payments/${PAYMENT_ID}`, "/payments", `/bookings/${BOOKING_ID}`]),
    );
  });

  it("sends X-Velexis-Environment of the switch (live here)", async () => {
    signedIn("owner", "live");
    api.on(CAPTURE, () => paymentAnswer());

    expect(await capturePayment(INITIAL_ACTION_STATE, captureForm(randomUUID()))).toMatchObject({ ok: true });

    expect(only(CAPTURE).headers.get("X-Velexis-Environment")).toBe("live");
    expect(api.sent(ME).every((request) => request.headers.get("X-Velexis-Environment") === "live")).toBe(
      true,
    );
  });

  it("answers the API's known codes as the dialog's state, never as an error thrown to error.tsx", async () => {
    signedIn("finance");
    const cases: [Response, Partial<ActionState>][] = [
      [
        apiError("PRECONDITION_FAILED", 412, { details: { currentVersion: 3 } }),
        { code: "PRECONDITION_FAILED", message: MESSAGES.reload },
      ],
      [
        apiError("PAYMENT_DECLINED", 402),
        { code: "PAYMENT_DECLINED", message: MESSAGES.authorisationExpired },
      ],
      [
        apiError("CONFLICT", 409, { details: { reason: "payment_not_capturable", status: "captured" } }),
        {
          code: "CONFLICT",
          message: "This payment can no longer be captured in its current state. Reload the page.",
        },
      ],
      [
        apiError("UNPROCESSABLE", 422, { details: { reason: "amount_exceeds_authorized" } }),
        {
          code: "UNPROCESSABLE",
          message: "The amount is above the authorised amount.",
          fieldErrors: { amount: "The amount is above the authorised amount." },
        },
      ],
      [
        apiError("PAYMENT_PROVIDER_ERROR", 502),
        { code: "PAYMENT_PROVIDER_ERROR", message: MESSAGES.providerError },
      ],
    ];
    for (const [answer, expected] of cases) {
      api.on(CAPTURE, () => answer);
      const state = await capturePayment(
        INITIAL_ACTION_STATE,
        captureForm(randomUUID(), { amount: "10.00" }),
      );
      expect(state, expected.code).toMatchObject({ ok: false, requestId: "req_fake_1", ...expected });
    }
    expect(revalidated()).toEqual([]);
  });

  it("starts with requireStaff(payments:capture): a viewer is refused before any call", async () => {
    signedIn("viewer");

    expect(await capturePayment(INITIAL_ACTION_STATE, captureForm(randomUUID()))).toEqual({
      ok: false,
      code: "FORBIDDEN",
      message: "You do not have permission to do this (payments:capture).",
    });
    // Even a form the schema would refuse gets the permission's answer first.
    expect(await capturePayment(INITIAL_ACTION_STATE, new FormData())).toMatchObject({ code: "FORBIDDEN" });
    expect(actionRequests()).toEqual([]);
  });

  it("refuses a tampered version and a key the page did not render, before the call", async () => {
    signedIn("finance");

    for (const extra of [{ version: "two" }, { actionKey: "same-key-every-time" }]) {
      expect(await capturePayment(INITIAL_ACTION_STATE, captureForm(randomUUID(), extra))).toMatchObject({
        ok: false,
        code: "VALIDATION_FAILED",
        message: MESSAGES.stale,
      });
    }
    expect(actionRequests()).toEqual([]);
  });
});

// ---- Both -----------------------------------------------------------------------------------------------------------

describe("both actions", () => {
  it("send a staff member whose session ended to the portal, without a call", async () => {
    signedIn();
    api.on(ME, () => apiError("UNAUTHENTICATED", 401));

    for (const run of [
      () => capturePayment(INITIAL_ACTION_STATE, captureForm(randomUUID())),
      () => refundPayment(INITIAL_ACTION_STATE, refundForm(randomUUID())),
    ]) {
      expect(await redirectOf(run)).toBe(`${TEST_PORTAL_URL}/console?tenant=${TENANT_ID}`);
    }
    expect(actionRequests()).toEqual([]);
  });

  it("never send a card field a forged form adds", async () => {
    signedIn("owner");
    api.on(CAPTURE, () => paymentAnswer());
    api.on(REFUND, () => paymentAnswer({}, 201));
    const forged = {
      cardNumber: "4242424242424242",
      securityCode: "123",
      holderName: "ANNA BERG",
      expiryDate: "2029-08",
    };

    await capturePayment(INITIAL_ACTION_STATE, captureForm(randomUUID(), forged));
    await refundPayment(INITIAL_ACTION_STATE, refundForm(randomUUID(), forged));

    for (const request of actionRequests()) {
      expect(JSON.stringify(request.body ?? null)).not.toMatch(
        /4242424242424242|securityCode|holder|expiry|cardNumber/i,
      );
    }
    expect(actionRequests()).toHaveLength(2);
  });
});
