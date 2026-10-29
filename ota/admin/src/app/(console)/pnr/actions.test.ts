// The server actions of the PNR lookup (OAD-009) against the fake OTA API (OADR-0018 point 10): the real actions,
// `requireStaff` and the SDK, with the SDK's `fetch` answered by src/test/fake-ota-api.ts, so each test checks the exact
// request an action sends (method, path, `Idempotency-Key`, `X-Velexis-Environment`, body), the state it answers and
// that it revalidates no page (Next.js would render `/pnr` again, an Amadeus lookup and an audited `pnr.lookup`), without
// a running backend. Next.js's request scope (`cookies()`, `headers()`),
// `redirect()` and `revalidatePath()` are mocked. Every token, id and name here is a dummy.
import { randomUUID } from "node:crypto";

import type { StaffRole } from "@velexis/ota-sdk";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CookieJar,
  TENANT_ID,
  TEST_CONFIG,
  apiError,
  fakeOtaApi,
  fakeRedirect,
  rateLimited,
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

import { importBooking, searchCustomers } from "./actions";
import { importedBookingOf, type ImportState } from "./import-rules";

const ME = "GET /v1/console/auth/me";
const IMPORT = "POST /v1/console/bookings/imports";
const CUSTOMERS = "GET /v1/console/customers";

const REFERENCE = "L2P9XC";
const FLIGHT_ORDER_ID = "eJzTd9cPNfX09DUFAAsGAkT";
const NEW_BOOKING_ID = "bkg_01JA4H9Z1B3D5F7H9K1M3P5R7V";
const EXISTING_BOOKING_ID = "bkg_01JA4CG3S8W1Z4C7F0H3L6P9T2";
const CUSTOMER_ID = "cus_01JA2Z9W5K7Q3M8N4P6R2T0V1X";
const REASON = "Terminal booking made by phone";

let api: FakeOtaApi;
let sequence = 0;

/** The cookies of a signed-in staff member of `role` whose switch says `environment`. */
function signedIn(role: StaffRole = "agent", environment: "test" | "live" = "test"): void {
  sequence += 1;
  nextHeaders.cookies.mockResolvedValue(
    new CookieJar({
      [STAFF_ACCESS_TOKEN_COOKIE]: staffAccessToken(`pnr-actions-${sequence}`, Date.now(), 900),
      [STAFF_REFRESH_TOKEN_COOKIE]: `staff-refresh-token-pnr-actions-${sequence}`,
      [ENVIRONMENT_COOKIE]: environment,
      [TENANT_COOKIE]: TENANT_ID,
    }),
  );
  api.on(ME, () => Response.json(staffProfile({ role }), { headers: { "X-Request-Id": "req_me" } }));
}

/** The import dialog's form: the match's hidden fields, the page's key, the reason and `extra`. */
function importForm(key: string, extra: Readonly<Record<string, string>> = {}): FormData {
  const form = new FormData();
  const fields: Record<string, string> = {
    reference: REFERENCE,
    flightOrderId: FLIGHT_ORDER_ID,
    currency: "EUR",
    actionKey: key,
    reason: REASON,
    pricingMode: "markup_rules",
    customerId: "",
    contactEmail: "",
    tags: "",
    note: "",
    ...extra,
  };
  for (const [name, value] of Object.entries(fields)) {
    form.set(name, value);
  }
  return form;
}

/** The console booking console.bookings.import answers (the fields the action reads). */
function importedAnswer(overrides: Record<string, unknown> = {}): Response {
  return Response.json(
    {
      id: NEW_BOOKING_ID,
      reference: "VX8M2Q",
      status: "confirmed",
      channel: "import",
      recordLocator: REFERENCE,
      version: 1,
      warnings: [],
      ...overrides,
    },
    {
      status: 201,
      headers: {
        ETag: '"1"',
        Location: `/v1/console/bookings/${NEW_BOOKING_ID}`,
        "X-Request-Id": "req_import",
      },
    },
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

function run(form: FormData, state: ActionState = INITIAL_ACTION_STATE): Promise<ImportState> {
  return importBooking(state, form);
}

// Once per file: the first SDK call and the first Zod parse of a fresh worker are the slowest; on a busy CI runner they
// would otherwise land in the first test's own five seconds.
beforeAll(async () => {
  api = fakeOtaApi();
  vi.stubGlobal("fetch", api.fetch);
  nextHeaders.headers.mockResolvedValue(new Headers());
  signedIn();
  api.on(IMPORT, () => importedAnswer());
  await run(importForm(randomUUID()));
  vi.unstubAllGlobals();
}, 30_000); // A hook budget for the cold start above, never a test's own timeout.

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

// ---- importBooking --------------------------------------------------------------------------------------------------

describe("importBooking", () => {
  it("[OAD-009 AC1] imports with the OTA's markup rules and the dialog's idempotency key, in the switch's environment", async () => {
    signedIn("agent", "live");
    api.on(IMPORT, () => importedAnswer());
    const key = randomUUID();

    const state = await run(importForm(key));

    const sent = only(IMPORT);
    expect(sent.headers.get("Idempotency-Key")).toBe(key);
    expect(sent.headers.get("X-Velexis-Environment")).toBe("live");
    expect(sent.headers.get("X-Api-Key")).toBe(TEST_CONFIG.OTA_ADMIN_SERVICE_KEY);
    expect(sent.headers.get("X-Velexis-End-User-IP")).toBe("203.0.113.7");
    expect(sent.body).toEqual({
      reference: REFERENCE,
      flightOrderId: FLIGHT_ORDER_ID,
      pricing: { mode: "markup_rules" },
      sendConfirmation: false,
      reason: REASON,
    });
    expect(state).toEqual({
      ok: true,
      message: "Imported as booking VX8M2Q.",
      booking: { id: NEW_BOOKING_ID, reference: "VX8M2Q" },
    });
    // No path revalidated: Next.js would then render the lookup page again in the action's answer, which reads Amadeus
    // and writes a `pnr.lookup` staff action no one asked for (actions.ts header).
    expect(revalidated()).toEqual([]);
    expect(actionRequests().map((request) => `${request.method} ${request.url.pathname}`)).toEqual([IMPORT]);
  });

  it("[OAD-009 AC1] sends the net mode, and an override with its selling total in the order's currency", async () => {
    signedIn("owner");
    api.on(IMPORT, () => importedAnswer());

    await run(importForm(randomUUID(), { pricingMode: "net", sellingTotal: "999.00" }));
    await run(importForm(randomUUID(), { pricingMode: "override", sellingTotal: " 1450.5 " }));

    const [net, override] = api.sent(IMPORT);
    // A selling total typed before switching to `net` is not sent: the API refuses it with any mode but `override`.
    expect(net?.body).toMatchObject({ pricing: { mode: "net" } });
    expect((net?.body as { pricing: object }).pricing).toEqual({ mode: "net" });
    expect(override?.body).toMatchObject({
      pricing: { mode: "override", sellingTotal: { amount: "1450.5", currency: "EUR" } },
    });
  });

  it("[OAD-009 AC1] sends the same key on a double submit, so the API imports the order once", async () => {
    signedIn("agent");
    api.on(IMPORT, () => importedAnswer());
    const key = randomUUID();

    await Promise.all([run(importForm(key)), run(importForm(key))]);

    expect(api.sent(IMPORT).map((request) => request.headers.get("Idempotency-Key"))).toEqual([key, key]);
  });

  it("[OAD-009 AC1] a second import of the order answers ORDER_ALREADY_IMPORTED with the existing booking to link", async () => {
    signedIn("agent");
    api.on(IMPORT, () =>
      apiError("ORDER_ALREADY_IMPORTED", 409, {
        details: { bookingId: EXISTING_BOOKING_ID, reference: "VX7K2Q" },
      }),
    );

    const state = await run(importForm(randomUUID()));

    expect(state).toMatchObject({
      ok: false,
      code: "ORDER_ALREADY_IMPORTED",
      message: "This order is already booking VX7K2Q.",
      requestId: "req_fake_1",
      booking: { id: EXISTING_BOOKING_ID, reference: "VX7K2Q" },
    });
    expect(importedBookingOf(state)).toEqual({ id: EXISTING_BOOKING_ID, reference: "VX7K2Q" });
    // A final 4xx the API stored under the key: the dialog's next submission gets a new one (lib/action-state.ts).
    expect(state.nextActionKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(revalidated()).toEqual([]);
  });

  it("sends the customer, the contact e-mail, the confirmation, the tags and the note the dialog gives", async () => {
    signedIn("admin");
    api.on(IMPORT, () => importedAnswer());
    const form = importForm(randomUUID(), {
      customerId: CUSTOMER_ID,
      contactEmail: " claire.moreau@example.com ",
      tags: "vip, phone,, vip ,group",
      note: "  Booked by phone on the 9th.  ",
    });
    form.set("sendConfirmation", "true");

    expect(await run(form)).toMatchObject({ ok: true });

    expect(only(IMPORT).body).toEqual({
      reference: REFERENCE,
      flightOrderId: FLIGHT_ORDER_ID,
      pricing: { mode: "markup_rules" },
      customerId: CUSTOMER_ID,
      contactEmail: "claire.moreau@example.com",
      sendConfirmation: true,
      tags: ["vip", "phone", "group"],
      note: "Booked by phone on the 9th.",
      reason: REASON,
    });
  });

  it("answers the API's warnings with the new booking, so the dialog stays to show them", async () => {
    signedIn("agent");
    api.on(IMPORT, () =>
      importedAnswer({
        warnings: [
          {
            code: "CUSTOMER NOT NOTIFIED",
            title: "CUSTOMER NOT NOTIFIED",
            detail:
              "The booking confirmation could not be queued for the booking's contact address: tell the traveller yourself.",
          },
        ],
      }),
    );
    const form = importForm(randomUUID());
    form.set("sendConfirmation", "true");

    const state = await run(form);

    expect(state).toMatchObject({
      ok: true,
      booking: { id: NEW_BOOKING_ID, reference: "VX8M2Q" },
      warnings: [
        "The booking confirmation could not be queued for the booking's contact address: tell the traveller yourself.",
      ],
    });
    expect(state.message).toBe(
      "Imported as booking VX8M2Q. The booking confirmation could not be queued for the booking's contact address: tell the traveller yourself.",
    );
    // A revalidation would render the page again without the dialog that shows these warnings.
    expect(revalidated()).toEqual([]);
  });

  it("refuses a role without bookings:write before any call, naming the permission", async () => {
    signedIn("finance");

    const state = await run(importForm(randomUUID()));

    expect(state).toEqual({
      ok: false,
      code: "FORBIDDEN",
      message: "You do not have permission to do this (bookings:write).",
    });
    expect(actionRequests()).toEqual([]);
  });

  it("checks the form first: an override without a selling total, a bad e-mail, too many tags; no request, the key kept", async () => {
    signedIn("agent");

    const state = await run(
      importForm(randomUUID(), {
        pricingMode: "override",
        sellingTotal: "",
        contactEmail: "not-an-address",
        tags: "a,b,c,d,e,f,g,h,i,j,k",
      }),
    );

    expect(state).toMatchObject({
      ok: false,
      code: "VALIDATION_FAILED",
      fieldErrors: {
        sellingTotal: "Enter the selling total.",
        contactEmail: "Enter an e-mail address.",
        tags: "Use at most 10 tags.",
      },
    });
    expect(state.nextActionKey).toBeUndefined();
    expect(actionRequests()).toEqual([]);
  });

  it("asks for a reload when a hidden field is not the page's (an unknown record locator, no key)", async () => {
    signedIn("agent");

    for (const extra of [{ reference: "l2p9xc!" }, { actionKey: "not-a-key" }, { flightOrderId: "" }]) {
      expect(await run(importForm(randomUUID(), extra))).toMatchObject({
        ok: false,
        message: "This form is out of date. Reload the page and look the record locator up again.",
      });
    }
    expect(actionRequests()).toEqual([]);
  });

  it("explains 403 OFFICE_NOT_ALLOWED: the order belongs to an office outside this OTA", async () => {
    signedIn("agent");
    api.on(IMPORT, () => apiError("OFFICE_NOT_ALLOWED", 403));

    expect(await run(importForm(randomUUID()))).toMatchObject({
      ok: false,
      code: "OFFICE_NOT_ALLOWED",
      message:
        "This order belongs to an Amadeus office outside this OTA: only orders of the OTA's own offices can be imported.",
    });
  });

  it("puts 409 CONFLICT for a deleted or disabled customer on the customer, with a new key", async () => {
    signedIn("agent");
    for (const [reason, message] of [
      [
        "customer_deleted",
        "This customer deleted their account: choose another customer, or import the order as a guest booking.",
      ],
      [
        "customer_disabled",
        "This customer's account is disabled: choose another customer, or import the order as a guest booking.",
      ],
    ] as const) {
      api.on(IMPORT, () => apiError("CONFLICT", 409, { details: { reason } }));

      const state = await run(importForm(randomUUID(), { customerId: CUSTOMER_ID }));

      expect(state).toMatchObject({
        ok: false,
        code: "CONFLICT",
        message,
        fieldErrors: { customerId: message },
      });
      expect(state.nextActionKey).toBeDefined();
    }
  });

  it("puts the selling total's refusals on it: below the net price (named), another currency", async () => {
    signedIn("agent");
    api.on(IMPORT, () =>
      apiError("UNPROCESSABLE", 422, {
        details: { reason: "selling_below_net", net: { amount: "142.30", currency: "EUR" } },
      }),
    );

    expect(
      await run(importForm(randomUUID(), { pricingMode: "override", sellingTotal: "100.00" })),
    ).toMatchObject({
      fieldErrors: { sellingTotal: "The selling total cannot be below the order's net price (€142.30)." },
    });

    api.on(IMPORT, () =>
      apiError("UNPROCESSABLE", 422, { details: { reason: "currency_mismatch", currency: "NOK" } }),
    );
    expect(
      await run(importForm(randomUUID(), { pricingMode: "override", sellingTotal: "1500.00" })),
    ).toMatchObject({
      fieldErrors: { sellingTotal: "The selling total must be in the order's currency (NOK)." },
    });
  });

  it("asks for the contact e-mail when the order has none, and maps the API's field errors to the dialog's fields", async () => {
    signedIn("agent");
    api.on(IMPORT, () => apiError("UNPROCESSABLE", 422, { details: { reason: "contact_email_required" } }));

    expect(await run(importForm(randomUUID()))).toMatchObject({
      fieldErrors: { contactEmail: "The order has no e-mail address: enter the booking's contact e-mail." },
    });

    api.on(IMPORT, () =>
      apiError("VALIDATION_FAILED", 400, {
        fieldErrors: [
          {
            path: "/pricing/sellingTotal/amount",
            code: "precision",
            message: "The currency has 0 decimal places.",
          },
          { path: "/tags/2", code: "maxLength" },
        ],
      }),
    );
    expect(
      await run(importForm(randomUUID(), { pricingMode: "override", sellingTotal: "1450.50" })),
    ).toMatchObject({
      code: "VALIDATION_FAILED",
      fieldErrors: { sellingTotal: "The currency has 0 decimal places.", tags: "Too long." },
    });
  });

  it("tells a customer the OTA does not have from an order Amadeus no longer has", async () => {
    signedIn("agent");
    api.on(IMPORT, () => apiError("NOT_FOUND", 404));
    expect(await run(importForm(randomUUID(), { customerId: CUSTOMER_ID }))).toMatchObject({
      fieldErrors: {
        customerId: "This customer was not found. Search again, or import the order as a guest booking.",
      },
    });

    api.on(IMPORT, () =>
      apiError("NOT_FOUND", 404, { supplier: { status: 404, code: "1797", title: "NOT FOUND" } }),
    );
    expect(await run(importForm(randomUUID(), { customerId: CUSTOMER_ID }))).toMatchObject({
      message: "Amadeus no longer has an order with this record locator. Look it up again.",
    });
  });

  it("keeps the key after a timeout or a rate limit, so the same import is replayed instead of made twice", async () => {
    signedIn("agent");
    const key = randomUUID();
    // `Retry-After: 60` ends the SDK's own retries at once (a wait above 30 s), as an exhausted retry would.
    api.on(IMPORT, () => apiError("SUPPLIER_TIMEOUT", 504, {}, { "Retry-After": "60" }));

    const timedOut = await run(importForm(key));
    expect(timedOut).toMatchObject({
      ok: false,
      code: "SUPPLIER_TIMEOUT",
      message:
        "Amadeus did not answer in time. Send the same form again: the order is imported once, whatever happened.",
    });
    expect(timedOut.nextActionKey).toBeUndefined();

    api.on(IMPORT, () => rateLimited());
    expect((await run(importForm(key))).nextActionKey).toBeUndefined();
  });
});

// ---- searchCustomers ------------------------------------------------------------------------------------------------

describe("searchCustomers", () => {
  it("lists the active customers whose e-mail or name starts with the search, at most 8", async () => {
    signedIn("agent");
    api.on(CUSTOMERS, () =>
      Response.json(
        {
          data: [
            { id: CUSTOMER_ID, email: "claire.moreau@example.com", firstName: "Claire", lastName: "Moreau" },
            {
              id: "cus_01JA2Z9W5K7Q3M8N4P6R2T0V1Y",
              email: "c.m@example.com",
              firstName: null,
              lastName: null,
            },
          ],
          page: { nextCursor: null, limit: 8 },
        },
        { headers: { "X-Request-Id": "req_customers" } },
      ),
    );

    const found = await searchCustomers("  claire ");

    expect(Object.fromEntries(only(CUSTOMERS).url.searchParams)).toEqual({
      q: "claire",
      status: "active",
      limit: "8",
    });
    expect(found).toEqual({
      ok: true,
      customers: [
        { id: CUSTOMER_ID, email: "claire.moreau@example.com", name: "Claire Moreau" },
        { id: "cus_01JA2Z9W5K7Q3M8N4P6R2T0V1Y", email: "c.m@example.com", name: null },
      ],
    });
  });

  it("checks the search before any call, and refuses a role without customers:read", async () => {
    signedIn("agent");
    expect(await searchCustomers("c")).toEqual({
      ok: false,
      message: "Enter at least 2 characters of the e-mail address or the name.",
    });
    expect(await searchCustomers(42)).toMatchObject({ ok: false });
    expect(actionRequests()).toEqual([]);

    api = fakeOtaApi();
    vi.stubGlobal("fetch", api.fetch);
    signedIn("viewer");
    api.on(ME, () => Response.json({ ...staffProfile({ role: "viewer" }), permissions: ["bookings:read"] }));
    expect(await searchCustomers("claire")).toEqual({
      ok: false,
      message: "You do not have permission to do this (customers:read).",
    });
    expect(actionRequests()).toEqual([]);
  });

  it("answers the API's refusal with its request id", async () => {
    signedIn("agent");
    api.on(CUSTOMERS, () => apiError("SERVICE_UNAVAILABLE", 503, {}, { "Retry-After": "60" }));

    expect(await searchCustomers("claire")).toEqual({
      ok: false,
      message: "The OTA API is unavailable right now. Try again in a moment.",
      requestId: "req_fake_1",
    });
  });
});
