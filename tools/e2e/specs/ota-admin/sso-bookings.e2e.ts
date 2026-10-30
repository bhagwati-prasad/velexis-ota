// The OTA admin's single sign-on and bookings journey (OAD-016; ota/admin/README.md §3, §7 and §12, routes.md §3,
// PADR-0007 §4, scope OF-09): an OTA that its owner created through the portal API (`createTenant`) and the OTA worker
// set up, so the journey needs `E2E_WITH_OTA=1` (the e2e workflow sets it).
//
//   the owner signs in to the portal → "Open console" on the OTA's page → the hand-off form posts the one-time portal
//   token to the OTA admin's /sso → /bookings of that OTA, the session in httpOnly cookies only → a booking the airline
//   left without tickets (manual review) is issued with a reason → ticketed → another, ticketed today, is cancelled:
//   Amadeus voids its tickets, which reverses the airline's whole charge → cancelled → the captured hand-off form posted
//   again is refused, and no session comes of it
//
// The two bookings are airline-card bookings, made in `beforeAll` through the OTA API as the OTA's storefront edge
// (`EdgeApi` of support/ota.ts: no preview serves this OTA's host, and the airline card needs no Stripe), with the
// airline card switched on for its test storefront first, and never in the 3 minutes before the OTA's midnight (below).
// The first one's completion carries the Amadeus stub's
// `ticketing-failed` scenario: the airline creates the order but issues no ticket, the card cannot be used again, and
// the booking waits in `manual_review` for the staff, who issue it with the OTA's own settlement (ACCOUNT), never a card
// (OADR-0018 point 8); the airline charged nothing, so the API counts it as unpaid and the owner issues it with
// `allowUnpaid` (console-operations.md §2 step 8). The second one is ticketed at its completion, so its tickets are of
// today and Amadeus voids them.
//
// The OTA's midnight (lead decision (2g) of 2026-10-30, FIX-W34-OTA). The cancel step runs a minute or two after the
// bookings and expects the void of tickets issued today: booked just before midnight, it would run on the next day and
// find tickets of yesterday (a request to the airline, no void). So when `beforeAll` reaches the bookings within 3
// minutes before midnight in a time zone that decides "today" (the OTA's, which the cancel dialog reads, and its
// storefront settings', which the API's cancellation reads: `bookingDayTimeZones` reads both from the stack, the OTA's
// is Europe/Oslo), it waits until 00:00:05 of the new day by polling the clock (`waitPastMidnight`), within the hook's
// budget. The assertions stay as they are.
//
// "Cancel with a full refund" for an airline-card booking. The airline charged the traveller's card, so no money goes
// back through Velexis: the cancel dialog offers "No refund from the console" alone (`refund_via_airline`; a `full`
// refund is refused by the API) and says that the void reverses the airline's charge. The journey checks that whole
// refund where it is recorded: the payment's `airline.void_expected` event, and no refund row.
//
// Every page the journey visits passes axe once its title is in place (the portal's hand-off page submits itself while
// it loads, before a check could run, so its captured markup is shown again without that script and checked), and on
// every page of the OTA admin JavaScript reads no cookie at all (`document.cookie` is empty; the staff session is
// httpOnly, README §10). Each issue and cancellation is also checked where the API records it: the staff action with
// the dialog's reason, and the booking's state.
//
// The steps are tests in order (`mode: "serial"`) on one browser context of the owner, made in `beforeAll`.
import { type BrowserContext, type Page, type Route } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../../support/a11y";
import { addSessionCookies, expect, newAccountContext, test, uniqueTestIp } from "../../support/fixtures";
import { uniqueEmail } from "../../support/mailpit";
import {
  bookAirlineCardTrip,
  bookingDayTimeZones,
  EdgeApi,
  MIDNIGHT_WAIT_BUDGET_MS,
  newOwnerWithActiveOta,
  openConsoleFromPortal,
  portalOtaPath,
  scriptReadableCookieNames,
  STAFF_COOKIES,
  switchAirlineCardOn,
  withTenantTx,
  waitPastMidnight,
  type OwnedOta,
  type SeededBooking,
} from "../../support/ota";
import { stack } from "../../support/seed";
import { OTA_ADMIN_URL, PORTAL_URL } from "../../support/stack";

test.describe.configure({ mode: "serial" });

const ISSUE_REASON = "The airline confirmed the order; issue it on the OTA's account (OAD-016 journey).";
const CANCEL_REASON = "The traveller cancelled on the phone the day of booking (OAD-016 journey).";

/** The OTA admin's title of a page (`%s · Velexis OTA admin`, src/app/layout.tsx). */
const adminTitle = (title: string): string => `${title} · Velexis OTA admin`;

/** The portal's launch route of the OTA's "Open console" form (platform/frontend/README.md §2). */
const launchPathOf = (tenantId: string): string => `/otas/${encodeURIComponent(tenantId)}/console/launch`;

/** The hand-off page the portal answered the first "Open console" with: the form that carries the portal token. */
interface CapturedHandOff {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

/** The script element of a page: the hand-off page has one, which submits its form while the page loads. */
const SCRIPT_ELEMENT = /<script\b[^>]*>[\s\S]*?<\/script>/g;

/**
 * The captured hand-off page without the script that submits it: the same markup, which stays on screen for axe. The
 * body's length changes, so the headers that describe it go; the rest (its CSP, `Cache-Control`) stays.
 */
function handOffWithoutScript(captured: CapturedHandOff): CapturedHandOff {
  const html = captured.body.toString("utf8");
  expect(html.match(SCRIPT_ELEMENT)).toHaveLength(1);
  const headers = Object.fromEntries(
    Object.entries(captured.headers).filter(([name]) => !/^content-(length|encoding)$/i.test(name)),
  );
  return { status: captured.status, headers, body: Buffer.from(html.replace(SCRIPT_ELEMENT, ""), "utf8") };
}

let owned: OwnedOta;
let manualReview: SeededBooking;
let ticketed: SeededBooking;
let context: BrowserContext;
let page: Page;
let handOff: CapturedHandOff | undefined;

/** Waits until `target` shows the OTA admin's page `title`, then runs axe and checks that no cookie is readable. */
async function expectAdminPage(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(adminTitle(title));
  await expectNoSeriousA11yViolations(target);
  expect(await scriptReadableCookieNames(target)).toEqual([]);
}

/** The status badge of `kind` in the booking page's header (components/status-badge.tsx). */
const badge = (target: Page, kind: "booking" | "ticketing") =>
  target.getByRole("main").locator(`[data-kind="${kind}"]`).first();

/** Opens the booking `reference` from the bookings list. */
async function openFromList(reference: string): Promise<void> {
  await page.goto("/bookings");
  await expectAdminPage(page, "Bookings");
  await page.getByRole("main").getByRole("link", { name: reference, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(reference);
  await expectAdminPage(page, "Booking");
}

test.beforeAll(async ({ browser }) => {
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "sso-bookings.e2e.ts needs the OTA backend and the OTA admin: run it with E2E_WITH_OTA=1 (the Amadeus stub, the " +
        "OTA worker, API and admin)",
    );
  }
  // Budget: a sign-up with its verification e-mail (up to 15 s), the OTA's set-up on the OTA worker (about 2 s locally;
  // PF-11 allows a minute) and two bookings through the OTA API and the stub (a second or two each): 120 s; plus, when
  // the bookings would fall in the 3 minutes before the OTA's midnight, the wait until 00:00:05 of the new day
  // (MIDNIGHT_WAIT_BUDGET_MS: the 3 minutes, the 5 seconds and a few seconds of polling, about 190 s).
  test.setTimeout(120_000 + MIDNIGHT_WAIT_BUDGET_MS);
  owned = await newOwnerWithActiveOta("Olga Console", "sso");
  await switchAirlineCardOn(owned.schema);
  // Never book in the 3 minutes before midnight where "today" is decided: the cancel step voids today's tickets.
  await waitPastMidnight(await bookingDayTimeZones(owned));
  const edge = new EdgeApi(owned.storefrontHost, uniqueTestIp());
  manualReview = await bookAirlineCardTrip(edge, {
    daysAhead: 52,
    traveller: { firstName: "Mara", lastName: "Review", dateOfBirth: "1986-02-11", gender: "FEMALE" },
    email: uniqueEmail("oad016-review"),
    completionScenario: "ticketing-failed",
  });
  ticketed = await bookAirlineCardTrip(edge, {
    daysAhead: 53,
    traveller: { firstName: "Carl", lastName: "Voidable", dateOfBirth: "1979-09-23", gender: "MALE" },
    email: uniqueEmail("oad016-void"),
  });

  context = await newAccountContext(browser, owned.owner.account, OTA_ADMIN_URL);
  await addSessionCookies(context, "portal", owned.session);
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

test("the owner opens the console from the portal and lands on /bookings of the OTA [OAD-016 AC1]", async () => {
  // The hand-off page passes through unchanged; the journey keeps a copy to post its form again in the last step.
  await page.route(`${PORTAL_URL}${launchPathOf(owned.ota.id)}`, async (route: Route) => {
    const response = await route.fetch();
    const body = await response.body();
    handOff = { status: response.status(), headers: response.headers(), body };
    await route.fulfill({ response, body });
  });
  await openConsoleFromPortal(page, owned.ota.id);
  await page.unrouteAll();
  expect(handOff?.status).toBe(200);

  // /bookings of this OTA: its name in the shell, its two bookings in the list.
  expect(page.url()).toBe(`${OTA_ADMIN_URL}/bookings`);
  await expect(page.getByRole("heading", { level: 1, name: "Bookings" })).toBeVisible();
  await expect(page.getByText(owned.ota.name, { exact: true })).toBeVisible();
  const list = page.getByRole("main");
  await expect(list.getByRole("link", { name: manualReview.reference, exact: true })).toBeVisible();
  await expect(list.getByRole("link", { name: ticketed.reference, exact: true })).toBeVisible();
  await expectAdminPage(page, "Bookings");

  // The staff session is in the four `__Host-` cookies of README §4, all httpOnly, Secure and SameSite=Lax: compared
  // without their values, which are tokens.
  const staffCookies = (await context.cookies(OTA_ADMIN_URL))
    .filter((cookie) => (STAFF_COOKIES as readonly string[]).includes(cookie.name))
    .map(({ name, httpOnly, secure, sameSite, path }) => ({ name, httpOnly, secure, sameSite, path }))
    .sort((a, b) => a.name.localeCompare(b.name));
  expect(staffCookies).toEqual(
    [...STAFF_COOKIES]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, httpOnly: true, secure: true, sameSite: "Lax", path: "/" })),
  );
  // No cookie of the context (portal or admin) is readable by JavaScript on 127.0.0.1.
  expect((await context.cookies()).filter((cookie) => !cookie.httpOnly).map((cookie) => cookie.name)).toEqual(
    [],
  );

  // The portal's hand-off page passes axe too. It submits itself while it loads, so the journey shows its markup again
  // without that script, in a page of its own (served from the copy: the portal mints nothing for it).
  if (handOff === undefined) {
    throw new Error("the hand-off page was not captured");
  }
  const still = handOffWithoutScript(handOff);
  const handOffPage = await context.newPage();
  try {
    await handOffPage.route(`${PORTAL_URL}${launchPathOf(owned.ota.id)}`, (route: Route) =>
      route.fulfill({ status: still.status, headers: still.headers, body: still.body }),
    );
    await handOffPage.goto(`${PORTAL_URL}${launchPathOf(owned.ota.id)}`);
    await expect(handOffPage).toHaveTitle("Opening the OTA admin");
    await expect(
      handOffPage.getByRole("heading", { level: 1, name: "Opening the OTA admin…" }),
    ).toBeVisible();
    await expect(handOffPage.getByRole("button", { name: "Continue" })).toBeVisible();
    await expectNoSeriousA11yViolations(handOffPage);
  } finally {
    await handOffPage.close();
  }
});

test("issues the manual-review booking with a reason, and it is ticketed [OAD-016 AC1]", async () => {
  await openFromList(manualReview.reference);
  await expect(badge(page, "ticketing")).toHaveAttribute("data-status", "manual_review");
  await expect(badge(page, "booking")).toHaveText("Confirmed");

  await page.getByRole("button", { name: "Issue tickets" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: `Issue the tickets of ${manualReview.reference}?` }),
  ).toBeVisible();
  // An airline-card booking: the OTA's own settlement with the airline, never a card. The airline issued no ticket, so
  // it charged nothing: the API counts the booking as unpaid, which an owner may issue anyway (allowUnpaid).
  await expect(dialog.getByText("The airline card cannot be charged again.", { exact: false })).toBeVisible();
  await expect(dialog.getByText("The airline has not charged the card", { exact: false })).toBeVisible();
  await dialog.getByRole("radio", { name: /^ACCOUNT/ }).check();
  await dialog.getByRole("checkbox", { name: "Issue although the payment is not captured" }).check();
  await dialog.getByRole("textbox", { name: "Reason" }).fill(ISSUE_REASON);
  await expectNoSeriousA11yViolations(page);
  await dialog.getByRole("button", { name: "Issue tickets" }).click();

  await expect(badge(page, "booking")).toHaveText("Ticketed");
  await expect(badge(page, "ticketing")).toHaveText("Issued");
  await expectAdminPage(page, "Booking");

  // The issuance as the API audited it: the owner's `booking.issue` with the dialog's reason, issued unpaid.
  const issued = await withTenantTx(owned.schema, async (trx) => ({
    actions: await trx
      .selectFrom("staff_actions")
      .select(["outcome", "reason", "staff_role", "after"])
      .where("booking_id", "=", manualReview.bookingId)
      .where("action", "=", "booking.issue")
      .execute(),
    booking: await trx
      .selectFrom("bookings")
      .select(["status", "ticketing_status"])
      .where("id", "=", manualReview.bookingId)
      .executeTakeFirstOrThrow(),
  }));
  expect(issued.actions).toEqual([
    {
      outcome: "succeeded",
      reason: ISSUE_REASON,
      staff_role: "owner",
      after: expect.objectContaining({ allowUnpaid: true }) as unknown,
    },
  ]);
  expect(issued.booking).toEqual({ status: "ticketed", ticketing_status: "issued" });
});

test("cancels the booking ticketed today: the void reverses the airline's whole charge [OAD-016 AC1]", async () => {
  await openFromList(ticketed.reference);
  await expect(badge(page, "booking")).toHaveText("Ticketed");

  await page.getByRole("button", { name: "Cancel the booking" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: `Cancel ${ticketed.reference}?` })).toBeVisible();
  // Amadeus voids today's tickets; the airline's card is never refunded through Stripe, the void reverses its charge.
  await expect(dialog.locator("[data-supplier-step]")).toHaveAttribute("data-supplier-step", "void");
  await expect(dialog.getByRole("radio", { name: "No refund from the console" })).toBeChecked();
  await expect(dialog.getByText("a void reverses its charge", { exact: false })).toBeVisible();
  await dialog.getByRole("combobox", { name: "Reason category" }).selectOption("customer_request");
  await dialog.getByRole("textbox", { name: "Reason" }).fill(CANCEL_REASON);
  await expectNoSeriousA11yViolations(page);
  await dialog.getByRole("button", { name: "Cancel the booking" }).click();

  await expect(badge(page, "booking")).toHaveText("Cancelled");
  await expectAdminPage(page, "Booking");

  // The whole charge goes back by the airline's void: its expectation on the payment, and no refund through Velexis.
  const money = await withTenantTx(owned.schema, async (trx) => ({
    voids: await trx
      .selectFrom("payment_events")
      .select("type")
      .where("payment_id", "=", ticketed.paymentId)
      .where("type", "=", "airline.void_expected")
      .execute(),
    refunds: await trx
      .selectFrom("refunds")
      .select("id")
      .where("payment_id", "=", ticketed.paymentId)
      .execute(),
    booking: await trx
      .selectFrom("bookings")
      .select(["status", "cancelled_by", "cancel_reason"])
      .where("id", "=", ticketed.bookingId)
      .executeTakeFirstOrThrow(),
    actions: await trx
      .selectFrom("staff_actions")
      .select(["outcome", "reason"])
      .where("booking_id", "=", ticketed.bookingId)
      .where("action", "=", "booking.cancel")
      .execute(),
  }));
  expect(money.voids).toHaveLength(1);
  expect(money.refunds).toEqual([]);
  // Cancelled by the staff with the dialog's reason category and reason, and audited with the reason.
  expect(money.booking).toEqual({
    status: "cancelled",
    cancelled_by: "staff",
    cancel_reason: `customer_request: ${CANCEL_REASON}`,
  });
  expect(money.actions).toEqual([{ outcome: "succeeded", reason: CANCEL_REASON }]);
});

test("posting the captured hand-off form again is refused, and no session comes of it [OAD-016 AC1]", async ({
  browser,
}) => {
  const captured = handOff;
  if (captured === undefined) {
    throw new Error("the first step captured no hand-off page");
  }
  // A browser with the owner's portal session and no console session: the portal's "Open console" is answered with the
  // captured page, whose form posts the portal token that the first sign-on used, from the portal's origin.
  const replay = await newAccountContext(browser, owned.owner.account, OTA_ADMIN_URL);
  try {
    await addSessionCookies(replay, "portal", owned.session);
    const again = await replay.newPage();
    await again.route(`${PORTAL_URL}${launchPathOf(owned.ota.id)}`, (route: Route) =>
      route.fulfill({ status: captured.status, headers: captured.headers, body: captured.body }),
    );
    const sso = again.waitForResponse(
      (response) => response.url() === `${OTA_ADMIN_URL}/sso` && response.request().method() === "POST",
    );
    await again.goto(portalOtaPath(owned.ota.id));
    await expect(again).toHaveTitle("Overview · Velexis");
    await again
      .getByRole("main")
      .getByRole("button", { name: /^Open console/ })
      .click();
    // The token is single use: the API answers 401 PORTAL_TOKEN_INVALID, and /sso its error page.
    expect((await sso).status()).toBe(401);
    await again.waitForURL(`${OTA_ADMIN_URL}/sso`);
    await expect(
      again.getByRole("heading", { level: 1, name: "The console could not be opened" }),
    ).toBeVisible();
    await expect(
      again.getByText("This console link expired or was already used.", { exact: false }),
    ).toBeVisible();
    await expect(again.getByRole("link", { name: "Back to the portal" })).toBeVisible();
    await expectAdminPage(again, "The console could not be opened");
    // No staff session was started: none of its cookies is in this browser.
    const names = (await replay.cookies(OTA_ADMIN_URL)).map((cookie) => cookie.name);
    expect(names.filter((name) => (STAFF_COOKIES as readonly string[]).includes(name))).toEqual([]);
  } finally {
    await replay.close();
  }
});
