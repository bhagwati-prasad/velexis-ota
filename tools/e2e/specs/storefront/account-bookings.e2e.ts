// The account and bookings journey of the hosted storefront (OFE-019; ota/frontend/README.md §13 journey 4,
// ota/docs/flows/my-bookings-and-guest-lookup.md §7, ota/docs/flows/change-and-cancel.md §7, docs/pages-account.md §2
// to §5; OF-03 AC1, OF-07 AC1 and AC2, OF-08 AC1 and AC2), in the `storefront` project: the production build in
// `vite preview` for the demo OTA, proxied to the OTA API, the OTA worker and the Amadeus stub; e-mail in Mailpit.
//
//   sign up → verify the address through the Mailpit link → sign out and sign in → two trips booked for the customer
//   through the API with the airline card (no Stripe), one moved into the past → the upcoming, past and cancelled tabs
//   → change the contact details → cancel with the refund preview → the cancelled tab → the e-mails of the change and
//   the cancellation → the access cookie ends and the next page refreshes the session silently → an expired token in
//   the access cookie is refreshed the same way
//
// The OTA backend has neither a test clock nor a configurable token lifetime, so the 15 minutes are made on the
// cookies: the access cookie is removed from the browser, as the browser removes it when its Max-Age of 900 s ends,
// and the API answers the refresh cookie alone with `401 TOKEN_EXPIRED` (OADR-0006 point 5 as revised on 2026-10-29,
// FIX-W33-OTA). Then the session's own access token, issued 16 minutes earlier and signed again with the stack's
// development key, goes back into its httpOnly cookie (support/ota.ts `expireAccessToken`): what the API sees of a
// cookie that a browser whose clock runs behind still sends (tools/e2e/README.md, "Tests of OFE-019").
//
// Then, each in a browser of its own: a guest finds the past trip by its reference (a wrong name and a wrong reference
// first, which answer the same), and failed lookups are refused for a while.
//
// The journey is a file of steps in order on one browser context made in `beforeAll` (`mode: "serial"`), each step
// within Playwright's default 30 s; the storefront guards of OFE-008 watch that context from before its first
// navigation and are checked after every step (`StorefrontGuards.finish`): no CSP violation, no third-party request,
// no cookie JavaScript can read but `__Host-vx_csrf` in any document of the journey (OF-03 AC1), and no serious or
// critical axe violation on any page it visits. Each browser sends an end-user IP of its own (`X-Forwarded-For`
// through the preview, as Caddy's would be), so the per-IP limits (sign-up, lookups, airline-card completions) count
// this journey alone, whatever other journeys run meanwhile.
//
// The demo OTA offers the airline card and self-service cancellation only with its storefront settings on (the OTA
// admin's switches, off for a new OTA): `beforeAll` turns both on (support/ota.ts) and leaves them on.
import { type Browser, type BrowserContext, type Cookie, type Page, type Response } from "@playwright/test";
import { sql } from "@velexis/db";
import { uniqueTestIp } from "../../support/fixtures";
import { uniqueEmail, waitForEmail, waitForLink } from "../../support/mailpit";
import {
  ACCESS_COOKIE,
  bookAirlineCardTrip,
  DEMO_TENANT_SCHEMA,
  enableAirlineCard,
  enableSelfServiceCancellation,
  expireAccessToken,
  moveBookingIntoThePast,
  REFRESH_COOKIE,
  StorefrontApi,
  withTenantTx,
  type SeededBooking,
} from "../../support/ota";
import { newPassword } from "../../support/seed";
import { STOREFRONT_URL } from "../../support/stack";
import { CSRF_COOKIE, expect, StorefrontGuards, test } from "../../support/storefront-guards";

/** The guest booking cookie that a lookup sets (OADR-0006 point 6). */
const GUEST_COOKIE = "__Host-vx_bt";
/** The departures the seed searches: dates of their own, days from today (the stub answers its fixture's flights). */
const UPCOMING_DAYS_AHEAD = 57;
const PAST_DAYS_AHEAD = 58;
/** A booking reference: `VX` and 6 characters without look-alikes (ota/backend booking-reference.ts). */
const BOOKING_REFERENCE = /^VX[A-HJ-NP-Z2-9]{6}$/;
/** A money amount as the storefront shows the demo OTA's (EUR): "€121.20". */
const EURO = /€[\d,]+\.\d{2}/;
/** The demo OTA's name, as its e-mails say it (ota/backend `dev:seed`). */
const DEMO_OTA_NAME = "Demo Travel";
/**
 * How long the e-mails of the contact change and the cancellation may take to reach Mailpit: the outbox, the worker
 * and the itinerary they attach (OADR-0013 point 4). They are awaited together, within the step's 30 s.
 */
const BOOKING_EMAIL_WAIT_MS = 25_000;
/** How long the API's arrangements of `beforeAll` may take: two settings rows and the storefront.get cache. */
const ARRANGE_TIMEOUT_MS = 20_000;

/** The customer of the journey: synthetic, with a password made for this run. */
const CUSTOMER = Object.freeze({ firstName: "Ada", lastName: "Accounttest" });

/** One browser of the journey: its context, its page, the storefront guards on that context and its end-user IP. */
interface Journey {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly guards: StorefrontGuards;
  readonly ip: string;
}

/** A new browser context with an end-user IP of its own and the storefront guards installed before its first page. */
async function openJourney(browser: Browser): Promise<Journey> {
  const ip = uniqueTestIp();
  const context = await browser.newContext({
    baseURL: STOREFRONT_URL,
    extraHTTPHeaders: { "X-Forwarded-For": ip },
  });
  const guards = await StorefrontGuards.install(context);
  const page = await context.newPage();
  return { context, page, guards, ip };
}

/** The storefront cookies of `context`, by name. */
async function storefrontCookies(context: BrowserContext) {
  const cookies = await context.cookies(STOREFRONT_URL);
  return new Map(cookies.map((cookie) => [cookie.name, cookie]));
}

/** A cookie's attributes without its value, which a failed assertion would print: the tokens stay out of reports. */
function attributesOf(cookie: Cookie | undefined) {
  return cookie === undefined
    ? undefined
    : { httpOnly: cookie.httpOnly, secure: cookie.secure, path: cookie.path, sameSite: cookie.sameSite };
}

/** The attributes of the session and guest cookies (OADR-0006 point 2). */
const SESSION_COOKIE_ATTRIBUTES = Object.freeze({
  httpOnly: true,
  secure: true,
  path: "/",
  sameSite: "Lax",
});

/** The names of the cookies the storefront's JavaScript can read on `page` now: only the CSRF token (OF-03 AC1). */
async function expectOnlyCsrfReadable(page: Page): Promise<void> {
  const names = await page.evaluate(() =>
    document.cookie
      .split(";")
      .map((cookie) => cookie.split("=")[0]?.trim() ?? "")
      .filter((name) => name !== ""),
  );
  expect(names).toEqual([CSRF_COOKIE]);
}

/** Opens My bookings on `tab` and waits until the tab's bookings (or its empty message) are shown. */
async function openTab(page: Page, tab: "Upcoming" | "Past" | "Cancelled"): Promise<void> {
  const tabs = page.getByRole("navigation", { name: "Trips" });
  await tabs.getByRole("link", { name: tab, exact: true }).click();
  await page.waitForURL(new RegExp(`/bookings\\.html\\?tab=${tab.toLowerCase()}$`));
  await expect(tabs.getByRole("link", { name: tab, exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveTitle(new RegExp(`^${tab} trips – My bookings`));
}

/** The booking references the open tab of My bookings lists, in order. */
async function listedReferences(page: Page): Promise<string[]> {
  const main = page.getByRole("main");
  const rows = main.getByRole("listitem").filter({ hasText: "Booking reference" });
  return (await rows.allTextContents()).map((text) => /VX[A-HJ-NP-Z2-9]{6}/.exec(text)?.[0] ?? text);
}

/** What the demo OTA recorded of the booking `bookingId`: its status and contact, its Amadeus calls and money events. */
async function bookingRecord(bookingId: string) {
  return await withTenantTx(DEMO_TENANT_SCHEMA, async (trx) => {
    const booking = await trx
      .selectFrom("bookings")
      .select(["status", "contact_email", "cancelled_by"])
      .where("id", "=", bookingId)
      .executeTakeFirstOrThrow();
    const calls = await trx
      .selectFrom("supplier_requests")
      .select(["http_method", "http_status"])
      .where("booking_id", "=", bookingId)
      .where("amadeus_api", "=", "FlightOrderManagement")
      .where("http_method", "in", ["PATCH", "DELETE"])
      .orderBy("created_at")
      .execute();
    const voids = await trx
      .selectFrom("payment_events")
      .innerJoin("payments", "payments.id", "payment_events.payment_id")
      .select(sql<string>`count(*)`.as("count"))
      .where("payments.booking_id", "=", bookingId)
      .where("payment_events.type", "=", "airline.void_expected")
      .executeTakeFirstOrThrow();
    const refunds = await trx
      .selectFrom("refunds")
      .select(sql<string>`count(*)`.as("count"))
      .where("booking_id", "=", bookingId)
      .executeTakeFirstOrThrow();
    return {
      status: booking.status,
      contactEmail: booking.contact_email,
      cancelledBy: booking.cancelled_by,
      amadeus: calls.map((call) => `${call.http_method} ${call.http_status ?? "-"}`),
      airlineVoids: Number(voids.count),
      refunds: Number(refunds.count),
    };
  });
}

/** An OTA API answer the page received through the preview: its operation path, status and error code. */
interface SeenAnswer {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly code: string | undefined;
}

/**
 * The body of an answer, kept in this process for `expectNoTokenIn` only: never printed, never compared but as a
 * boolean (`undefined` when the browser had none to give).
 */
type SeenBody = string | undefined;

/**
 * A token field with a value, as a token-mode answer has it (AuthSessionResult, BookingLookupResult); an edge-mode
 * answer leaves them out or sends `null` (OADR-0006 point 4).
 */
const TOKEN_FIELD = /"(accessToken|refreshToken|bookingToken)"\s*:\s*"/;

/**
 * Records the OTA API answers `page` receives (`/api/v1/…`), with the error code of each error and the body of each
 * (for `expectNoTokenIn`). Only for a page that stays where it is meanwhile: a navigation can take a body with it.
 */
function recordApiAnswers(page: Page): {
  answers: Promise<SeenAnswer & { readonly body: SeenBody }>[];
  stop: () => void;
} {
  const answers: Promise<SeenAnswer & { readonly body: SeenBody }>[] = [];
  const listener = (response: Response) => {
    const { pathname } = new URL(response.url());
    if (!pathname.startsWith("/api/v1/")) {
      return;
    }
    const base = { method: response.request().method(), path: pathname.slice(4), status: response.status() };
    answers.push(
      response.text().then(
        (body) => {
          let code: string | undefined;
          if (response.status() >= 400) {
            try {
              code = (JSON.parse(body) as { error?: { code?: string } }).error?.code;
            } catch {
              code = undefined;
            }
          }
          return { ...base, code, body };
        },
        () => ({ ...base, code: undefined, body: undefined }),
      ),
    );
  };
  page.on("response", listener);
  return { answers, stop: () => page.off("response", listener) };
}

/**
 * OF-03 AC1: `body`, an answer's body, holds no token: no token field with a value, and none of `values` (the httpOnly
 * cookies' values as the browser holds them). Booleans only, so a failure never prints a token.
 */
function expectNoTokenIn(body: SeenBody, what: string, values: readonly (string | undefined)[]): void {
  expect(body !== undefined, `the body of ${what}`).toBe(true);
  expect(TOKEN_FIELD.test(body ?? ""), `a token field in the body of ${what}`).toBe(false);
  for (const value of values) {
    expect(value !== undefined && value.length > 0, `a session cookie after ${what}`).toBe(true);
    expect((body ?? "").includes(value ?? ""), `a session cookie's value in the body of ${what}`).toBe(false);
  }
}

test.describe("the account and bookings journey", () => {
  test.describe.configure({ mode: "serial" });

  const email = uniqueEmail("ofe019-account");
  const newContactEmail = uniqueEmail("ofe019-contact");
  const password = newPassword();
  let journey: Journey;
  let upcoming: SeededBooking;
  let past: SeededBooking;

  test.beforeAll(async ({ browser }) => {
    // Two settings rows of the demo OTA and the wait for storefront.get to offer the airline card (support/ota.ts).
    test.setTimeout(ARRANGE_TIMEOUT_MS);
    await enableAirlineCard();
    await enableSelfServiceCancellation();
    journey = await openJourney(browser);
  });

  test.afterEach(async () => {
    // The guards of the journey's context: CSP, third-party requests, readable cookies, axe on the page it is on.
    await journey?.guards.finish(journey.page);
  });

  test.afterAll(async () => {
    await journey?.context.close();
  });

  test("signs up, and the session lives in httpOnly cookies only [OFE-019 AC1] [OFE-019 AC2] [OF-03 AC1]", async () => {
    const { context, page, guards } = journey;
    await page.goto("/account/sign-up.html");
    await expect(page.getByRole("heading", { level: 1, name: "Create an account" })).toBeVisible();
    await guards.checkA11y(page);

    const form = page.getByRole("main").locator("form");
    await form.getByRole("textbox", { name: "First name" }).fill(CUSTOMER.firstName);
    await form.getByRole("textbox", { name: "Last name" }).fill(CUSTOMER.lastName);
    await form.getByRole("textbox", { name: "E-mail address" }).fill(email);
    await form.getByLabel("Password", { exact: true }).fill(password);
    await form.getByRole("checkbox", { name: /^I accept the terms and conditions/ }).check();
    await form.getByRole("button", { name: "Create account" }).click();

    // The demo OTA opens a session at sign-up (its e-mail verification is not required before sign-in).
    await page.waitForURL(/\/account\/$/);
    await expect(page.getByRole("navigation", { name: "Main" })).toContainText(`Hi, ${CUSTOMER.firstName}`);
    await guards.checkA11y(page);
    const cookies = await storefrontCookies(context);
    for (const name of [ACCESS_COOKIE, REFRESH_COOKIE]) {
      expect(attributesOf(cookies.get(name)), name).toEqual(SESSION_COOKIE_ATTRIBUTES);
    }
    expect(attributesOf(cookies.get(CSRF_COOKIE))).toEqual({ ...SESSION_COOKIE_ATTRIBUTES, httpOnly: false });
    await expectOnlyCsrfReadable(page);
  });

  test("verifies the e-mail address through the link from Mailpit [OFE-019 AC1] [OFE-019 AC2]", async () => {
    const { page, guards } = journey;
    // The link names the OTA's storefront host, which the preview stands in for: its path and query open here.
    const link = await waitForLink({ to: email, path: "/account/verify.html" });
    await page.goto(`${link.pathname}${link.search}`);
    await expect(page.getByRole("heading", { level: 1, name: "Confirm your e-mail address" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: `${email} is confirmed` })).toBeVisible();
    // The token left the address bar before the page's requests (docs/pages-account.md §5).
    expect(new URL(page.url()).searchParams.has("token")).toBe(false);
    await guards.checkA11y(page);
  });

  test("signs out, and signs in again from My bookings [OFE-019 AC1] [OFE-019 AC2] [OF-03 AC1]", async () => {
    const { context, page, guards } = journey;
    const nav = page.getByRole("navigation", { name: "Main" });
    await nav.getByRole("button", { name: "Sign out" }).click();
    // Signed out, the menu offers sign-in and the page goes home (docs/pages-account.md §5, "Account menu").
    await page.waitForURL((url) => url.pathname === "/");
    await expect(page.getByRole("heading", { level: 1, name: "Search flights" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Sign in" })).toBeVisible();
    await guards.checkA11y(page);
    const signedOut = await storefrontCookies(context);
    expect(signedOut.has(ACCESS_COOKIE)).toBe(false);
    expect(signedOut.has(REFRESH_COOKIE)).toBe(false);

    // My bookings sends a visitor to sign-in, and back once signed in.
    await page.goto("/bookings.html");
    await page.waitForURL(/\/account\/sign-in\.html\?next=%2Fbookings\.html/);
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    await guards.checkA11y(page);
    const form = page.getByRole("main").locator("form");
    await form.getByRole("textbox", { name: "E-mail address" }).fill(email);
    await form.getByLabel("Password", { exact: true }).fill(password);
    await form.getByRole("button", { name: "Sign in" }).click();

    await page.waitForURL(/\/bookings\.html$/);
    await expect(page.getByRole("heading", { level: 1, name: "My bookings" })).toBeVisible();
    // Texts are looked for in `main`: the page's live region, outside it, repeats a message 150 ms later
    // (components/live-region.js), and two matches would fail the locator.
    await expect(page.getByRole("main").getByText("No upcoming trips", { exact: true })).toBeVisible();
    await guards.checkA11y(page);
    await expectOnlyCsrfReadable(page);
  });

  test("two trips are booked for the customer through the API, paid with the airline card [OFE-019 AC1]", async () => {
    const { context, ip } = journey;
    // The OTA API as the storefront's SDK calls it, with this browser's cookies: the customer's bookings.
    const api = new StorefrontApi(context, ip);
    const traveller = { ...CUSTOMER, dateOfBirth: "1985-04-12", gender: "FEMALE" as const };
    upcoming = await bookAirlineCardTrip(api, { daysAhead: UPCOMING_DAYS_AHEAD, traveller, email });
    past = await bookAirlineCardTrip(api, { daysAhead: PAST_DAYS_AHEAD, traveller, email });
    expect(upcoming.reference).toMatch(BOOKING_REFERENCE);
    expect(past.reference).toMatch(BOOKING_REFERENCE);
    // The API books no flight in the past: the second trip's flight is moved 30 days back.
    await moveBookingIntoThePast(past.bookingId);
  });

  test("lists the upcoming, past and cancelled trips in their tabs [OFE-019 AC1] [OF-07 AC1]", async () => {
    const { page, guards } = journey;
    await page.goto("/bookings.html");
    await expect.poll(() => listedReferences(page)).toEqual([upcoming.reference]);
    await guards.checkA11y(page);

    await openTab(page, "Past");
    await expect.poll(() => listedReferences(page)).toEqual([past.reference]);
    await guards.checkA11y(page);

    await openTab(page, "Cancelled");
    await expect(page.getByRole("main").getByText("No cancelled trips", { exact: true })).toBeVisible();
    expect(await listedReferences(page)).toEqual([]);
    await guards.checkA11y(page);
  });

  test("changes the contact details at the airline and in the booking [OFE-019 AC1] [OF-08 AC1]", async () => {
    const { page, guards } = journey;
    await openTab(page, "Upcoming");
    await page.getByRole("link", { name: new RegExp(upcoming.reference) }).click();
    await page.waitForURL(new RegExp(`/booking\\.html\\?id=${upcoming.bookingId}$`));
    await expect(
      page.getByRole("heading", { level: 1, name: `Booking ${upcoming.reference}` }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Contact details" })).toContainText(email);
    await guards.checkA11y(page);

    await page.getByRole("button", { name: "Change contact details" }).click();
    const dialog = page.getByRole("dialog", { name: "Change contact details" });
    await expect(dialog).toBeVisible();
    await guards.checkA11y(page);
    await dialog.getByRole("textbox", { name: "E-mail address" }).fill(newContactEmail);
    await dialog.getByRole("textbox", { name: "Country calling code" }).fill("+34");
    await dialog.getByRole("textbox", { name: "Mobile phone number" }).fill("611222333");
    await dialog.getByRole("button", { name: "Save" }).click();

    await expect(
      page.getByRole("main").getByText(`We have sent a confirmation to ${newContactEmail}.`),
    ).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("region", { name: "Contact details" })).toContainText(newContactEmail);
    await guards.checkA11y(page);

    // At the airline (one Flight Order Management PATCH) and in the booking.
    const record = await bookingRecord(upcoming.bookingId);
    expect(record.amadeus).toEqual(["PATCH 200"]);
    expect(record.contactEmail).toBe(newContactEmail);
  });

  test("cancels with the refund preview, and the trip moves to the cancelled tab [OFE-019 AC1] [OF-08 AC2] [OF-07 AC1]", async () => {
    const { page, guards } = journey;
    await page.getByRole("button", { name: "Cancel booking" }).click();
    const dialog = page.getByRole("dialog", { name: "Cancel your booking" });
    await expect(dialog).toBeVisible();
    // The refund preview of bookings.quoteCancellation: the tickets issued today can be voided, and what comes back.
    await expect(dialog.getByText(/^Your tickets can still be voided until /)).toBeVisible();
    const refund = dialog.getByText(/^If you cancel now, you get back /);
    const preview = new RegExp(
      `^If you cancel now, you get back (${EURO.source}) of the (${EURO.source}) you paid\\.$`,
    );
    await expect(refund).toHaveText(preview);
    // An airline card: the void reverses the airline's whole charge, so all of it comes back (change-and-cancel.md §8).
    const [, back, paid] =
      preview.exec(((await refund.textContent()) ?? "").replace(/\s+/g, " ").trim()) ?? [];
    expect(back).toMatch(EURO);
    expect(back).toBe(paid);
    await guards.checkA11y(page);

    await dialog.getByRole("combobox", { name: "Why do you cancel?" }).selectOption("change_of_plans");
    await dialog.getByRole("button", { name: `Cancel and get ${back} back`, exact: true }).click();
    await expect(dialog.getByText("Your booking is cancelled", { exact: true })).toBeVisible();
    await guards.checkA11y(page);
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "This booking is cancelled" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel booking" })).toBeHidden();
    await guards.checkA11y(page);

    // The order cancelled once at the airline (Flight Order Management DELETE), and the money once: an airline-card
    // booking has no PSP payment to void, the airline reverses its own charge (one `airline.void_expected`, no refund).
    const record = await bookingRecord(upcoming.bookingId);
    expect(record).toMatchObject({
      status: "cancelled",
      cancelledBy: "customer",
      airlineVoids: 1,
      refunds: 0,
    });
    expect(record.amadeus).toEqual(["PATCH 200", "DELETE 204"]);

    await page.getByRole("link", { name: "My bookings" }).first().click();
    await page.waitForURL(/\/bookings\.html/);
    await openTab(page, "Cancelled");
    await expect.poll(() => listedReferences(page)).toEqual([upcoming.reference]);
    await guards.checkA11y(page);
    // The cancelled trip is in its tab alone: neither upcoming nor past (OF-07 AC1).
    await openTab(page, "Upcoming");
    await expect(page.getByRole("main").getByText("No upcoming trips", { exact: true })).toBeVisible();
    await guards.checkA11y(page);
    await openTab(page, "Past");
    await expect.poll(() => listedReferences(page)).toEqual([past.reference]);
    await guards.checkA11y(page);
  });

  test("e-mails the changed booking to the new contact, a notice to the previous one, and the cancellation [OFE-019 AC1] [OF-08 AC1] [OF-08 AC2]", async () => {
    // The new address gets the booking as it is now, the previous one a short notice (OADR-0013 point 4, 2026-10-23),
    // and the cancellation goes to the booking's contact.
    const [updated, notice, cancelled] = await Promise.all([
      waitForEmail({
        to: newContactEmail,
        subject: `Your booking ${upcoming.reference} with ${DEMO_OTA_NAME} has been updated`,
        timeoutMs: BOOKING_EMAIL_WAIT_MS,
      }),
      waitForEmail({
        to: email,
        subject: `The contact details of booking ${upcoming.reference} with ${DEMO_OTA_NAME} were changed`,
        timeoutMs: BOOKING_EMAIL_WAIT_MS,
      }),
      waitForEmail({
        to: newContactEmail,
        subject: `Your booking ${upcoming.reference} is cancelled`,
        timeoutMs: BOOKING_EMAIL_WAIT_MS,
      }),
    ]);
    expect(updated.Text).toContain(upcoming.reference);
    // The previous address learns of the change and the booking's reference, nothing more: not the new address, no
    // traveller, no link to the booking and no attachment (change-and-cancel.md §3 step 2).
    expect(notice.Text).toContain(upcoming.reference);
    expect(notice.Text).not.toContain(newContactEmail);
    expect(notice.Text).not.toContain(CUSTOMER.lastName);
    expect(notice.Text).not.toContain(upcoming.bookingId);
    expect(notice.Attachments).toEqual([]);
    expect(cancelled.Text).toContain(upcoming.reference);
  });

  /**
   * Opens My bookings' cancelled tab after `expire` took the session's access away, and checks that the API refused it
   * with `401 TOKEN_EXPIRED`, that the SDK refreshed once through the refresh cookie and sent the calls again, that the
   * customer is still signed in, and that both session cookies rotated without a token in any answer of the page.
   */
  async function expectSilentRefresh(expire: (context: BrowserContext) => Promise<void>): Promise<void> {
    const { context, page, guards } = journey;
    const before = await storefrontCookies(context);
    await expire(context);
    const seen = recordApiAnswers(page);
    await page.goto("/bookings.html?tab=cancelled");
    await expect.poll(() => listedReferences(page)).toEqual([upcoming.reference]);
    seen.stop();
    const seenAnswers = await Promise.all(seen.answers);
    // What a failure may print: the bodies stay out (they are checked for tokens below).
    const answers: SeenAnswer[] = seenAnswers.map(({ method, path, status, code }) => ({
      method,
      path,
      status,
      code,
    }));

    // The API refused the session's access, the SDK refreshed once through the refresh cookie and sent the call again.
    expect(answers.filter((answer) => answer.code === "TOKEN_EXPIRED").length).toBeGreaterThan(0);
    expect(answers.filter((answer) => answer.path === "/v1/auth/refresh")).toEqual([
      { method: "POST", path: "/v1/auth/refresh", status: 200, code: undefined },
    ]);
    expect(answers.filter((answer) => answer.status === 401 && answer.code !== "TOKEN_EXPIRED")).toEqual([]);
    await expect(page.getByRole("navigation", { name: "Main" })).toContainText(`Hi, ${CUSTOMER.firstName}`);

    // Both session cookies rotated, still httpOnly; JavaScript reads the CSRF token alone.
    const after = await storefrontCookies(context);
    const access = after.get(ACCESS_COOKIE)?.value;
    const refresh = after.get(REFRESH_COOKIE)?.value;
    expect(access === undefined, `${ACCESS_COOKIE} set again`).toBe(false);
    expect(access === before.get(ACCESS_COOKIE)?.value, `${ACCESS_COOKIE} rotated`).toBe(false);
    expect(refresh === before.get(REFRESH_COOKIE)?.value, `${REFRESH_COOKIE} rotated`).toBe(false);
    expect(attributesOf(after.get(ACCESS_COOKIE))).toEqual(SESSION_COOKIE_ATTRIBUTES);
    expect(attributesOf(after.get(REFRESH_COOKIE))).toEqual(SESSION_COOKIE_ATTRIBUTES);
    await expectOnlyCsrfReadable(page);
    // No token in the body of the refresh that set the new cookies, nor in any other answer of the page (OF-03 AC1).
    for (const answer of seenAnswers) {
      expectNoTokenIn(answer.body, `${answer.method} ${answer.path} (${answer.status})`, [access, refresh]);
    }
    await guards.checkA11y(page);
  }

  test("the access cookie ends after its 15 minutes, and the next page refreshes the session silently [OFE-019 AC1] [OFE-019 AC2] [OF-03 AC1] [FIX-W33-OTA]", async () => {
    // What the browser does when the access cookie's Max-Age of 900 s ends: it drops the cookie and keeps sending the
    // refresh cookie, which the API answers with 401 TOKEN_EXPIRED (OADR-0006 point 5 as revised on 2026-10-29).
    await expectSilentRefresh(async (context) => {
      await context.clearCookies({ name: ACCESS_COOKIE });
    });
  });

  test("an expired token in the access cookie is refreshed the same way [OFE-019 AC1] [OFE-019 AC2] [OF-03 AC1]", async () => {
    // The token in the access cookie as the API sees it 16 minutes later (support/ota.ts `expireAccessToken`): a
    // browser whose clock runs behind the API's still sends it.
    await expectSilentRefresh(expireAccessToken);
  });

  test("a guest finds the past trip by its reference after a wrong name and a wrong reference [OFE-019 AC1] [OF-07 AC2]", async ({
    page: guest,
    guards: guestGuards,
  }) => {
    // Another browser: no session, no guest cookie, an end-user IP of its own.
    await guest.setExtraHTTPHeaders({ "X-Forwarded-For": uniqueTestIp() });
    await guest.goto("/lookup.html");
    await expect(guest.getByRole("heading", { level: 1, name: "Find your booking" })).toBeVisible();
    await guestGuards.checkA11y(guest);

    const form = guest.getByRole("main").locator("form");
    const reference = form.getByRole("textbox", { name: /^Booking reference/ });
    const lastName = form.getByRole("textbox", { name: /^Last name/ });
    const submit = form.getByRole("button", { name: "Find my booking" });
    const lookup = (response: Response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/bookings/lookup";
    /** One lookup: its answer's status and body, byte for byte, with its request id (which differs) blanked. */
    const tryLookup = async (bookingReference: string, name: string) => {
      await reference.fill(bookingReference);
      await lastName.fill(name);
      const answer = guest.waitForResponse(lookup);
      await submit.click();
      const response = await answer;
      const body = await response.text();
      const requestId = (JSON.parse(body) as { error?: { requestId?: unknown } }).error?.requestId;
      expect(typeof requestId, "the request id of the lookup's error").toBe("string");
      return { status: response.status(), body: body.split(String(requestId)).join("<requestId>") };
    };
    const notFound = guest
      .getByRole("main")
      .getByText("We could not find a booking with these details", { exact: true });
    /** The page says the same for every mismatch, and marks neither field (docs/pages-account.md §4). */
    const expectSameRefusal = async () => {
      await expect(notFound).toBeVisible();
      await expect(reference).not.toHaveAttribute("aria-invalid", "true");
      await expect(lastName).not.toHaveAttribute("aria-invalid", "true");
    };

    const wrongName = await tryLookup(past.reference, "Wrongname");
    await expectSameRefusal();
    await guestGuards.checkA11y(guest);
    // A reference that does not exist with the right name: the same answer, byte for byte but its request id.
    const wrongReference = await tryLookup("VX2Z2Z2Z", CUSTOMER.lastName);
    expect(wrongName.status).toBe(404);
    expect(wrongReference).toEqual(wrongName);
    await expectSameRefusal();

    await reference.fill(past.reference.toLowerCase());
    await lastName.fill(CUSTOMER.lastName);
    await submit.click();
    await guest.waitForURL(new RegExp(`/booking\\.html\\?id=${past.bookingId}$`));
    await expect(guest.getByRole("heading", { level: 1, name: `Booking ${past.reference}` })).toBeVisible();
    await guestGuards.checkA11y(guest);
    // The lookup's access lives in the httpOnly guest cookie, never in the page.
    const cookie = (await guest.context().cookies(STOREFRONT_URL)).find(
      (candidate) => candidate.name === GUEST_COOKIE,
    );
    expect(attributesOf(cookie)).toEqual(SESSION_COOKIE_ATTRIBUTES);
  });

  test("failed lookups are refused for a while after the fifth [OFE-019 AC1] [OF-07 AC2]", async ({
    page: guest,
    guards: guestGuards,
  }) => {
    await guest.setExtraHTTPHeaders({ "X-Forwarded-For": uniqueTestIp() });
    await guest.goto("/lookup.html");
    const form = guest.getByRole("main").locator("form");
    const submit = form.getByRole("button", { name: "Find my booking" });
    await form.getByRole("textbox", { name: /^Last name/ }).fill(CUSTOMER.lastName);
    const lookup = (response: Response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/bookings/lookup";
    // Five references that no booking has, from this browser's IP: five failures, the limit of 15 minutes.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await form.getByRole("textbox", { name: /^Booking reference/ }).fill(`QZ${attempt}NOPE${attempt}`);
      const answer = guest.waitForResponse(lookup);
      await submit.click();
      statuses.push((await answer).status());
      // The button is back (it says "Finding your booking…" while a lookup runs) before the next submit.
      if (attempt < 5) {
        await expect(submit).toBeEnabled();
      }
    }
    expect(statuses).toEqual([404, 404, 404, 404, 404, 429]);
    await expect(
      guest.getByRole("main").getByText(/^Too many attempts, try again in \d+ minutes?$/),
    ).toBeVisible();
    await expect(submit).toBeDisabled();
    await guestGuards.checkA11y(guest);
  });
});
