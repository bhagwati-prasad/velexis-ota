// The guest Stripe checkout journey of the hosted storefront (OFE-017; ota/frontend/README.md §13 journey 2,
// ota/docs/flows/checkout-stripe.md §6, docs/pages.md §6 to §11; OF-04 AC1, AC2), nightly in the `storefront-stripe`
// project: the production build in `vite preview` for the demo OTA, proxied to the OTA API and the Amadeus stub, with
// Stripe.js, the Payment Element and 3-D Secure in Stripe's test mode over the network, and the Stripe CLI forwarder
// of the stack (support/stripe.ts) delivering the payment events to the OTA API.
//
//   search → offer → price → guest checkout (travellers, contacts, one bag) → card page with the 3-D Secure test card
//   → challenge → complete → confirmation with the reference → the confirmation e-mail with the itinerary in Mailpit
//   → the booking page through the guest cookie
//
// A second journey: the Amadeus stub's `sold-out` scenario at completion (the browser's `X-Stub-Scenario` header on
// `checkout.complete`, which the preview passes to the OTA API and the API to the stub outside production) shows that
// nothing was charged, and the authorisation is voided: the payment `canceled` and its PaymentIntent `canceled` at
// Stripe.
//
// Each journey is a file of steps in order on one browser context (`mode: "serial"`, made in `beforeAll`), each step
// within Playwright's default 30 s; the storefront guards of OFE-008 watch that context from before its first
// navigation and fail the step that broke a rule (`StorefrontGuards`, checked after every step). Every test carries the
// tag `@stripe`, so only `storefront-stripe` runs it (E2E_STRIPE=1 with E2E_WITH_OTA=1, playwright.config.ts). Without
// the OTA's Stripe test keys the steps fail at once with that message; nothing is ever skipped.
import { type Browser, type BrowserContext, type Page, type Response } from "@playwright/test";
import { PROJECT_TAGS } from "../../support/fixtures";
import { extractLinks, uniqueEmail, waitForEmail } from "../../support/mailpit";
import { DEMO_TENANT_SCHEMA, withTenantTx } from "../../support/ota";
import { stack } from "../../support/seed";
import { otaStripeKeys, STOREFRONT_URL, type OtaStripeKeys } from "../../support/stack";
import { expect, StorefrontGuards, test } from "../../support/storefront-guards";
import {
  completeThreeDSecure,
  fillCardForm,
  PAYMENT_ELEMENT_FRAME,
  retrievePaymentIntent,
  STRIPE_TEST_CARDS,
} from "../../support/stripe";

/** The demo OTA's name, as its e-mails say it (ota/backend `dev:seed`). */
const DEMO_OTA_NAME = "Demo Travel";
/** A booking reference: `VX` and 6 characters without look-alikes (ota/backend booking-reference.ts). */
const BOOKING_REFERENCE = /^VX[A-HJ-NP-Z2-9]{6}$/;
/** A booking id as the API writes it. */
const BOOKING_ID = /^bkg_[0-9A-HJKMNP-TV-Z]{26}$/;
/** The guest cookie that `checkout.complete` sets for a guest's booking (OBE-047, OADR-0006). */
const GUEST_COOKIE = "__Host-vx_bt";
/**
 * How long the confirmation e-mail may take: the outbox and the worker, and the itinerary it waits for (rendered after
 * the booking's commit, usually within seconds; OADR-0013 item 8). Within the step's 30 s.
 */
const CONFIRMATION_EMAIL_WAIT_MS = 25_000;
/** How long the void may take to show: synchronous in `checkout.complete`, else queued on the OTA worker. */
const VOID_WAIT_MS = 20_000;

/** The departure of each journey: a date of its own, days from today, never a fixed calendar date. */
const JOURNEY_DAYS_AHEAD = 52;
const SOLD_OUT_DAYS_AHEAD = 53;

/** The traveller of both journeys: synthetic, as a test needs. */
const TRAVELLER = Object.freeze({
  firstName: "Ada",
  lastName: "Stripetest",
  dateOfBirth: "1985-04-12",
});

/** One journey's browser: its context, its page and the storefront guards on that context. */
interface Journey {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly guards: StorefrontGuards;
}

/** The OTA's Stripe test keys of the stack, or the message that says how to run these journeys. */
function requireStripe(): OtaStripeKeys {
  const keys = otaStripeKeys(stack().settings);
  if (keys === undefined) {
    throw new Error(
      "checkout-stripe.e2e.ts pays in Stripe's test mode: run it with E2E_WITH_OTA=1, E2E_STRIPE=1, " +
        "STRIPE_SECRET_KEY_TEST and STRIPE_PUBLISHABLE_KEY_TEST and the Stripe CLI (the nightly step of e2e.yml)",
    );
  }
  return keys;
}

/**
 * A new browser context for a journey, with the storefront guards installed before its first navigation: a
 * storefront-stripe journey's, which allow the Stripe.js cookies from the card page on (OADR-0006, revision of
 * 2026-10-28).
 */
async function openJourney(browser: Browser): Promise<Journey> {
  requireStripe();
  const context = await browser.newContext({ baseURL: STOREFRONT_URL });
  const guards = await StorefrontGuards.install(context, { stripeJourney: true });
  const page = await context.newPage();
  return { context, page, guards };
}

/** A departure `daysAhead` days from today. */
function departureDate(daysAhead: number): string {
  return new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
}

/** The results page address the search form sends for a one-way trip from Madrid to Paris (docs/pages.md §3). */
function searchAddress(daysAhead: number): string {
  const query = new URLSearchParams({
    trip: "oneway",
    from: "MAD",
    to: "PAR",
    depart: departureDate(daysAhead),
    adults: "1",
    children: "0",
    infants: "0",
    cabin: "ECONOMY",
  });
  return `/search.html?${query.toString()}`;
}

/** Searches, opens the first offer, keeps its fare and prices it: ends on the price page (docs/pages.md §4 to §6). */
async function searchAndPrice({ page, guards }: Journey, daysAhead: number): Promise<void> {
  await page.goto(searchAddress(daysAhead));
  await page.waitForURL(/[?&]search=srch_/);
  const select = page.getByRole("link", { name: /^Select this flight for / });
  await expect(select.first()).toBeVisible();
  await guards.checkA11y(page);

  await select.first().click();
  await page.waitForURL(/\/offer\.html\?offer=off_/);
  const keepFare = page.getByRole("button", { name: "Continue with this fare" });
  await expect(keepFare).toBeVisible();
  await guards.checkA11y(page);

  await keepFare.click();
  await page.waitForURL(/\/price\.html\?priced=prc_/);
  await expect(page.getByRole("heading", { level: 1, name: "Your price" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to checkout" })).toBeEnabled();
  await guards.checkA11y(page);
}

/**
 * From the price page through the guest checkout (docs/pages.md §7): the traveller, the contact `email`, one extra
 * checked bag when `bag` (the airline's new total confirmed), and ends on the payment step.
 */
async function fillGuestCheckout(
  { page, guards }: Journey,
  options: { readonly email: string; readonly bag: boolean },
): Promise<void> {
  await page.getByRole("button", { name: "Continue to checkout" }).click();
  await page.waitForURL(/\/checkout\.html\?id=chk_/);

  // Travellers: the names, the date of birth and the gender the stub's priced offer asks for.
  const travellers = page.getByRole("region", { name: "Travellers" });
  const traveller = travellers.getByRole("group", { name: "Traveller 1: Adult" });
  await expect(traveller).toBeVisible();
  await guards.checkA11y(page);
  await traveller.getByRole("textbox", { name: "First and middle names" }).fill(TRAVELLER.firstName);
  await traveller.getByRole("textbox", { name: "Last name" }).fill(TRAVELLER.lastName);
  await traveller.getByRole("textbox", { name: "Date of birth" }).fill(TRAVELLER.dateOfBirth);
  await traveller.getByRole("combobox", { name: "Gender, as in the travel document" }).selectOption("FEMALE");
  await travellers.getByRole("button", { name: "Continue", exact: true }).click();

  // Contacts: the name comes from the traveller; the journey's own e-mail address and a mobile phone.
  const contacts = page.getByRole("region", { name: "Contact details" });
  await expect(contacts.getByRole("textbox", { name: "First name" })).toHaveValue(TRAVELLER.firstName);
  await guards.checkA11y(page);
  await contacts.getByRole("textbox", { name: "E-mail address" }).fill(options.email);
  await contacts.getByRole("textbox", { name: "Country calling code" }).fill("34");
  await contacts.getByRole("textbox", { name: "Mobile phone number" }).fill("600000000");
  await contacts.getByRole("button", { name: "Continue", exact: true }).click();

  // Extras: one extra checked bag, priced again by the airline: its new total is shown and confirmed.
  const extras = page.getByRole("region", { name: "Extras and special requests" });
  const oneBag = extras.getByRole("radio", { name: /^1 extra checked bag / });
  await expect(oneBag).toBeVisible();
  await guards.checkA11y(page);
  if (options.bag) {
    await oneBag.check();
    await extras.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(extras.getByRole("region", { name: "Your new total" })).toBeVisible();
    await extras.getByRole("button", { name: /^Confirm the new total, €[\d,]+\.\d{2}$/ }).click();
  } else {
    await extras.getByRole("button", { name: "Continue", exact: true }).click();
  }

  const payment = page.getByRole("region", { name: "Payment", exact: true });
  await expect(payment.getByRole("heading", { level: 2, name: "Payment" })).toBeVisible();
  if (options.bag) {
    // The trip's summary now lists the bag's price under Extras.
    const summary = page.getByRole("complementary", { name: "Your trip" });
    await expect(summary.getByRole("term").filter({ hasText: /^Extras$/ })).toBeVisible();
  }
  await guards.checkA11y(page);
}

/**
 * On the payment step: pays by card (Stripe), accepts the terms and opens the card page with the Payment Element
 * (docs/pages.md §7 step 5 and §8). Returns the `pay_…` id of its address.
 */
async function openCardPage({ page, guards }: Journey): Promise<string> {
  const payment = page.getByRole("region", { name: "Payment", exact: true });
  await payment.getByRole("radio", { name: /^Card Accepted: / }).check();
  await payment.getByRole("checkbox", { name: /^I accept the terms and conditions/ }).check();
  await payment.getByRole("button", { name: "Continue to payment" }).click();

  await page.waitForURL(/\/checkout\/pay-card\.html\?id=chk_[^&]+&payment=pay_/);
  await expect(page.getByRole("heading", { level: 1, name: "Pay by card" })).toBeVisible();
  // The Payment Element is mounted (Stripe's iframe), and Review appears once it is ready.
  await expect(page.locator(PAYMENT_ELEMENT_FRAME).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Review total" })).toBeVisible();
  await guards.checkA11y(page);
  const paymentId = new URL(page.url()).searchParams.get("payment");
  expect(paymentId).toMatch(/^pay_[0-9A-HJKMNP-TV-Z]{26}$/);
  return paymentId ?? "";
}

/** Types the test card `number` into the Payment Element and reviews the final total (docs/pages.md §8 step 3). */
async function reviewCard({ page, guards }: Journey, number: string): Promise<void> {
  await fillCardForm(page, number);
  await page.getByRole("button", { name: "Review total" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Your final total" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Pay €[\d,]+\.\d{2}$/ })).toBeVisible();
  await guards.checkA11y(page);
}

test.describe("the guest Stripe checkout journey", { tag: PROJECT_TAGS.stripe }, () => {
  test.describe.configure({ mode: "serial" });

  const email = uniqueEmail("ofe017-stripe");
  let journey: Journey;
  let bookingId = "";
  let reference = "";

  test.beforeAll(async ({ browser }) => {
    journey = await openJourney(browser);
  });

  test.afterEach(async () => {
    // The guards of the journey's context: CSP, third-party requests, readable cookies, axe on the page it is on.
    await journey?.guards.finish(journey.page);
  });

  test.afterAll(async () => {
    await journey?.context.close();
  });

  test("searches, opens an offer and prices it [OFE-017 AC1] [OF-04 AC1]", async () => {
    await searchAndPrice(journey, JOURNEY_DAYS_AHEAD);
  });

  test("checks out as a guest with a traveller, a contact and one extra bag [OFE-017 AC1] [OF-04 AC1]", async () => {
    await fillGuestCheckout(journey, { email, bag: true });
  });

  test("opens the card page and reviews the total with the 3-D Secure test card [OFE-017 AC1] [OF-04 AC1]", async () => {
    await openCardPage(journey);
    await reviewCard(journey, STRIPE_TEST_CARDS.threeDSecure);
  });

  test("pays, passes the 3-D Secure challenge and shows the confirmation with the reference [OFE-017 AC1] [OF-04 AC1]", async () => {
    const { page, guards } = journey;
    await page.getByRole("button", { name: /^Pay €/ }).click();
    await completeThreeDSecure(page);
    // The complete page (Stripe's return URL) turns the authorised payment into the booking and then opens its
    // confirmation (docs/pages.md §10 and §11); it may be gone before a wait for it starts, so only the confirmation
    // is waited for.
    await page.waitForURL(/\/confirmation\.html\?booking=bkg_/);
    await expect(
      page.getByRole("heading", { level: 1, name: /^(Your tickets are issued|Booking confirmed)$/ }),
    ).toBeVisible();
    const referenceText = page
      .getByRole("region", { name: "Booking reference" })
      .getByRole("paragraph")
      .first();
    await expect(referenceText).toHaveText(BOOKING_REFERENCE);
    reference = (await referenceText.textContent())?.trim() ?? "";
    bookingId = new URL(page.url()).searchParams.get("booking") ?? "";
    expect(bookingId).toMatch(BOOKING_ID);
    // A guest's confirmation: save the reference to find the booking later.
    await expect(page.getByRole("region", { name: "Save your reference" })).toBeVisible();
    await guards.checkA11y(page);
  });

  test("sends the confirmation e-mail with the itinerary [OFE-017 AC1] [OF-04 AC1]", async () => {
    const message = await waitForEmail({
      to: email,
      subject: `Your booking ${reference} with ${DEMO_OTA_NAME} is confirmed`,
      timeoutMs: CONFIRMATION_EMAIL_WAIT_MS,
    });
    expect(message.Text).toContain(`Booking reference: ${reference}`);
    expect(message.Text).toMatch(
      /Flights \(local times\):\r?\n- [A-Z0-9]{2} \d{1,4}, MAD to [A-Z]{3}: departs /,
    );
    expect(message.Text).toContain(`- ${TRAVELLER.firstName} ${TRAVELLER.lastName}`);
    expect(message.Text).toContain("Your itinerary is attached to this e-mail as a PDF.");
    expect(message.Attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ FileName: `${reference}-itinerary.pdf`, ContentType: "application/pdf" }),
      ]),
    );
    // Its link opens this booking (on the OTA's storefront host, which the preview stands in for).
    const bookingLinks = extractLinks(message)
      .map((href) => new URL(href))
      .filter((url) => url.pathname === "/booking.html");
    expect(bookingLinks.map((url) => url.searchParams.get("id"))).toContain(bookingId);
  });

  test("opens the booking page through the guest cookie [OFE-017 AC1] [OF-04 AC1]", async ({
    page: other,
    guards: otherGuards,
  }) => {
    const { context, page, guards } = journey;
    // The guest cookie of the completion: httpOnly, so no script of the storefront can read it (OADR-0006).
    const cookie = (await context.cookies(STOREFRONT_URL)).find(
      (candidate) => candidate.name === GUEST_COOKIE,
    );
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, path: "/" });

    await page.getByRole("link", { name: "View your booking" }).click();
    await page.waitForURL(new RegExp(`/booking\\.html\\?id=${bookingId}$`));
    await expect(page.getByRole("heading", { level: 1, name: `Booking ${reference}` })).toBeVisible();
    await expect(page.getByRole("region", { name: "Travellers" })).toContainText(
      `${TRAVELLER.firstName} ${TRAVELLER.lastName}`,
    );
    await expect(page.getByRole("region", { name: "Contact details" })).toContainText(email);
    await guards.checkA11y(page);

    // The same address in a browser without that cookie (this test's own, guarded context) finds no access: the
    // booking page opened through the guest cookie, not through its address.
    await other.goto(`/booking.html?id=${bookingId}`);
    await expect(other.getByText("Find your booking with its reference", { exact: true })).toBeVisible();
    await expect(other.getByRole("link", { name: "Find your booking", exact: true })).toHaveAttribute(
      "href",
      "/lookup.html",
    );
    await expect(other.getByRole("heading", { level: 1, name: `Booking ${reference}` })).toHaveCount(0);
    await otherGuards.checkA11y(other);
  });
});

/** The demo OTA's payment `paymentId`: its status, its PaymentIntent and when it was voided. */
async function paymentRow(
  paymentId: string,
): Promise<{ status: string; providerPaymentId: string | null; canceledAt: Date | null } | undefined> {
  return await withTenantTx(DEMO_TENANT_SCHEMA, async (trx) => {
    const row = await trx
      .selectFrom("payments")
      .select(["status", "provider_payment_id", "canceled_at"])
      .where("id", "=", paymentId)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : { status: row.status, providerPaymentId: row.provider_payment_id, canceledAt: row.canceled_at };
  });
}

/** Whether `response` is the answer to `checkout.complete` (`POST /v1/checkouts/{id}/complete`, via `/api`). */
function isCompletion(response: Response): boolean {
  return (
    response.request().method() === "POST" &&
    /^\/api\/v1\/checkouts\/chk_[^/]+\/complete$/.test(new URL(response.url()).pathname)
  );
}

test.describe("the airline sells out at completion", { tag: PROJECT_TAGS.stripe }, () => {
  test.describe.configure({ mode: "serial" });

  const email = uniqueEmail("ofe017-sold-out");
  let journey: Journey;
  let paymentId = "";

  test.beforeAll(async ({ browser }) => {
    journey = await openJourney(browser);
  });

  test.afterEach(async () => {
    await journey?.guards.finish(journey.page);
  });

  test.afterAll(async () => {
    await journey?.context.close();
  });

  test("searches, opens an offer and prices it [OFE-017 AC2] [OF-04 AC2]", async () => {
    await searchAndPrice(journey, SOLD_OUT_DAYS_AHEAD);
  });

  test("checks out as a guest without extras [OFE-017 AC2] [OF-04 AC2]", async () => {
    await fillGuestCheckout(journey, { email, bag: false });
  });

  test("opens the card page and reviews the total [OFE-017 AC2] [OF-04 AC2]", async () => {
    paymentId = await openCardPage(journey);
    await reviewCard(journey, STRIPE_TEST_CARDS.visa);
  });

  test("pays, and the airline's sold-out at completion says that nothing was charged [OFE-017 AC2] [OF-04 AC2]", async () => {
    const { page, guards } = journey;
    // The Amadeus stub's `sold-out` scenario for this completion only: the OTA API forwards the request's
    // X-Stub-Scenario to its Amadeus calls outside production (Flight Offers Price and Flight Create Orders answer
    // 34651 SEGMENT SELL FAILURE). Every other request of the journey goes unchanged.
    await page.route("**/api/v1/checkouts/*/complete", async (route) => {
      await route.continue({
        headers: { ...(await route.request().allHeaders()), "x-stub-scenario": "sold-out" },
      });
    });
    const completion = page.waitForResponse(isCompletion);
    await page.getByRole("button", { name: /^Pay €/ }).click();
    await page.waitForURL(/\/checkout\/complete\.html\?/);
    const answer = await completion;
    expect(answer.status()).toBe(409);
    expect(await answer.json()).toMatchObject({ error: { code: "SOLD_OUT" } });

    // docs/pages.md §10: "This flight sold out, you have not been charged", back to the search.
    const main = page.getByRole("main");
    await expect(main.getByText("This flight just sold out", { exact: true })).toBeVisible();
    await expect(main.getByText(/you have not been charged/)).toBeVisible();
    await expect(main.getByRole("link", { name: "Search flights" })).toBeVisible();
    await guards.checkA11y(page);
  });

  test("the authorisation is voided: the payment and its PaymentIntent are canceled [OFE-017 AC2] [OF-04 AC2]", async () => {
    const keys = requireStripe();
    await expect
      .poll(async () => (await paymentRow(paymentId))?.status, { timeout: VOID_WAIT_MS })
      .toBe("canceled");
    const row = await paymentRow(paymentId);
    expect(row?.canceledAt).toBeInstanceOf(Date);
    expect(row?.providerPaymentId).toMatch(/^pi_[A-Za-z0-9]+$/);
    // Stripe's own record: the PaymentIntent of manual capture was canceled, so the authorisation is released.
    const intentId = row?.providerPaymentId ?? "";
    await expect
      .poll(async () => (await retrievePaymentIntent(keys.secretKey, intentId)).status, {
        timeout: VOID_WAIT_MS,
      })
      .toBe("canceled");
    expect((await retrievePaymentIntent(keys.secretKey, intentId)).captureMethod).toBe("manual");
  });
});
