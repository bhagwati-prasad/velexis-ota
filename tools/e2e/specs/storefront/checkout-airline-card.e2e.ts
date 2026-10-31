// The airline-card checkout journey of the hosted storefront (OFE-018; ota/frontend/README.md §13 journey 3,
// ota/docs/flows/checkout-airline-card.md §4 and §7, docs/pages.md §9, OADR-0017; OF-05 AC1, AC2), in the `storefront`
// project: the production build in `vite preview` for the demo OTA, proxied to the OTA API and the Amadeus stub. The
// airline charges the card through Amadeus, so no Stripe is involved.
//
//   price → guest checkout → "Card, charged by the airline" → the airline-card page with the airline's notice and price
//   → the test card 4111 1111 1111 1111 → the airline's card fee and total → pay → the confirmation with the tickets
//
// Three journeys, each a file of steps in order on one browser context made in `beforeAll` (`mode: "serial"`), each
// step within Playwright's default 30 s:
//
//   1. the success above, with three more paths on the way: a page on /checkout/pay-card.html that opens the card
//      page with `window.open` gets a closed handle (COOP `same-origin`, OADR-0017 point 3), a validation error (a
//      number that fails the Luhn check) sends nothing and repeats no value, and a card typed and left behind (the page
//      left, then Back) is gone from the inputs;
//   2. the stub's declined test card 4000 0000 0000 0002 three times: declined, declined, then "Too many attempts"
//      (the API's 403 PAYMENT_ATTEMPTS_EXCEEDED at the checkout's third decline);
//   3. the airline's answer lost: the stub answers Flight Create Orders with a 5xx (`server-error`), which the OTA
//      cannot tell from a timeout (the order may exist): 504 SUPPLIER_TIMEOUT with the booking, and the page opens the
//      confirmation in pending mode without sending the card again.
//
// After every path (success, validation error, decline, attempt limit, lost answer, leaving the page; OADR-0017 point
// 8) the card leak checks (support/card-leak-guards.ts) look for the card number, its last 12 digits, the security
// code and the holder's name in localStorage, sessionStorage, IndexedDB, cookies, every address and `history.state`,
// every request but the completion's body, and the OTA API's answers; the card inputs are empty after the page was
// left; the airline-card page made no request to another origin. The storefront guards of OFE-008 (CSP, third-party
// hosts, readable cookies, axe) watch each journey's context from before its first navigation and are checked after
// every step.
//
// The demo OTA offers the airline card only with AIRLINE_CARD_ENABLED (true in ota/backend/.env.example, which the
// stack's OTA processes get) and its storefront setting for the test environment, which `beforeAll` turns on with
// support/ota.ts `enableAirlineCard`, as OFE-019's journeys do (and leaves on: no other journey depends on it being
// off). Each journey's browser sends an end-user IP of its own (X-Forwarded-For through the preview, as Caddy's would
// be), so its completions count against a per-IP limit of their own (5 a minute, architecture §8) whatever other
// journeys run meanwhile.
import { randomUUID } from "node:crypto";
import { type Browser, type BrowserContext, type Page, type Response } from "@playwright/test";
import { sql } from "@velexis/db";
import {
  CardLeakGuards,
  cardValuesIn,
  expectOpenerCutOff,
  type TypedCard,
} from "../../support/card-leak-guards";
import { uniqueTestIp } from "../../support/fixtures";
import { uniqueEmail } from "../../support/mailpit";
import { DEMO_TENANT_SCHEMA, enableAirlineCard, withTenantTx } from "../../support/ota";
import { OTA_API_URL, STOREFRONT_URL } from "../../support/stack";
import { expect, StorefrontGuards, test } from "../../support/storefront-guards";

/** A booking id as the API writes it. */
const BOOKING_ID = /^bkg_[0-9A-HJKMNP-TV-Z]{26}$/;
/** A payment id as the API writes it. */
const PAYMENT_ID = /^pay_[0-9A-HJKMNP-TV-Z]{26}$/;
/** An e-ticket as the confirmation lists it: its number (the stub's `000-` and 10 digits), then the traveller. */
const TICKET_LINE = /^\d{3}-\d{10}: \S/;
/** The Pay button once the airline's card fee is quoted: "Pay €412.30". */
const PAY_BUTTON = /^Pay €[\d,]+\.\d{2}$/;
/** The Amadeus stub's card fee for a VISA card on one offer (tools/amadeus-stub README, `credit-card-fees`). */
const VISA_CARD_FEE = "€1.20";

/** The departure of each journey: a date of its own, days from today, never a fixed calendar date. */
const SUCCESS_DAYS_AHEAD = 46;
const DECLINE_DAYS_AHEAD = 47;
const LOST_ANSWER_DAYS_AHEAD = 48;

/** The traveller of every journey: synthetic, as a test needs. */
const TRAVELLER = Object.freeze({ firstName: "Ada", lastName: "Cardtest", dateOfBirth: "1985-04-12" });

/**
 * A card as the journey types it: the test numbers of the Amadeus stub and a number that fails the Luhn check only, an
 * expiry in the future.
 */
interface JourneyCard extends TypedCard {
  readonly expiryMonth: string;
  readonly expiryYear: string;
}

/** An expiry year three years from now, never a fixed calendar year. */
const EXPIRY_YEAR = String(new Date().getUTCFullYear() + 3);

/** The stub's card that Flight Create Orders accepts (any valid VISA number), the test PAN of OADR-0017. */
const ACCEPTED_CARD: JourneyCard = Object.freeze({
  number: "4111 1111 1111 1111",
  securityCode: "853",
  holderName: "Ada Q Holdertest",
  expiryMonth: "11",
  expiryYear: EXPIRY_YEAR,
});

/** The stub's declined test card (`DECLINED_TEST_CARD`: 400 code 1304, CREDIT CARD NOT ACCEPTED). */
const DECLINED_CARD: JourneyCard = Object.freeze({
  number: "4000 0000 0000 0002",
  securityCode: "947",
  holderName: "Ada Q Declinetest",
  expiryMonth: "10",
  expiryYear: EXPIRY_YEAR,
});

/**
 * A card the page refuses before anything is sent (docs/pages.md §9): a VISA number that fails the Luhn check. Its
 * brand and BIN get the card fee quoted, as any card's do; nothing else of it may leave the page.
 */
const INVALID_CARD: JourneyCard = Object.freeze({
  number: "4111 1111 1111 1112",
  securityCode: "586",
  holderName: "Ada Q Invalidtest",
  expiryMonth: "09",
  expiryYear: EXPIRY_YEAR,
});

/** One journey's browser: its context, its page, the storefront guards and the card leak checks on that context. */
interface Journey {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly guards: StorefrontGuards;
  readonly leaks: CardLeakGuards;
}

/** A new browser context for a journey: its own end-user IP, the storefront guards and the card leak checks. */
async function openJourney(browser: Browser): Promise<Journey> {
  const context = await browser.newContext({
    baseURL: STOREFRONT_URL,
    extraHTTPHeaders: { "X-Forwarded-For": uniqueTestIp() },
  });
  const guards = await StorefrontGuards.install(context);
  const leaks = await CardLeakGuards.install(context);
  const page = await context.newPage();
  return { context, page, guards, leaks };
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
 * From the price page through the guest checkout (docs/pages.md §7): the traveller, the contact `email`, no extras,
 * then the payment step with the card the airline charges, the terms accepted, and on to the airline-card page
 * (docs/pages.md §9). Returns the `pay_…` id of its address.
 */
async function checkOutWithAirlineCard({ page, guards }: Journey, email: string): Promise<string> {
  await page.getByRole("button", { name: "Continue to checkout" }).click();
  await page.waitForURL(/\/checkout\.html\?id=chk_/);

  const travellers = page.getByRole("region", { name: "Travellers" });
  const traveller = travellers.getByRole("group", { name: "Traveller 1: Adult" });
  await expect(traveller).toBeVisible();
  await guards.checkA11y(page);
  await traveller.getByRole("textbox", { name: "First and middle names" }).fill(TRAVELLER.firstName);
  await traveller.getByRole("textbox", { name: "Last name" }).fill(TRAVELLER.lastName);
  await traveller.getByRole("textbox", { name: "Date of birth" }).fill(TRAVELLER.dateOfBirth);
  await traveller.getByRole("combobox", { name: "Gender, as in the travel document" }).selectOption("FEMALE");
  await travellers.getByRole("button", { name: "Continue", exact: true }).click();

  const contacts = page.getByRole("region", { name: "Contact details" });
  await expect(contacts.getByRole("textbox", { name: "First name" })).toHaveValue(TRAVELLER.firstName);
  await guards.checkA11y(page);
  await contacts.getByRole("textbox", { name: "E-mail address" }).fill(email);
  await contacts.getByRole("textbox", { name: "Country calling code" }).fill("34");
  await contacts.getByRole("textbox", { name: "Mobile phone number" }).fill("600000000");
  await contacts.getByRole("button", { name: "Continue", exact: true }).click();

  const extras = page.getByRole("region", { name: "Extras and special requests" });
  await expect(extras.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
  await guards.checkA11y(page);
  await extras.getByRole("button", { name: "Continue", exact: true }).click();

  // The payment step offers the card the airline charges, with the airline's notice (storefront.get, edge only).
  const payment = page.getByRole("region", { name: "Payment", exact: true });
  await expect(payment.getByRole("heading", { level: 2, name: "Payment" })).toBeVisible();
  const airlineCard = payment.getByRole("radio", { name: /^Card, charged by the airline/ });
  await expect(airlineCard).toBeVisible();
  await airlineCard.check();
  await expect(
    payment.getByText("The airline charges your card at its own price, shown on the next page."),
  ).toBeVisible();
  await guards.checkA11y(page);
  await payment.getByRole("checkbox", { name: /^I accept the terms and conditions/ }).check();
  await payment.getByRole("button", { name: "Continue to payment" }).click();

  await page.waitForURL(/\/checkout\/pay-airline\.html\?id=chk_[^&]+&payment=pay_/);
  await expectCardForm(page);
  await guards.checkA11y(page);
  const paymentId = new URL(page.url()).searchParams.get("payment") ?? "";
  expect(paymentId).toMatch(PAYMENT_ID);
  return paymentId;
}

/** The airline-card page shows its form: the airline's notice, the empty card inputs and the airline's total. */
async function expectCardForm(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: "Pay with your card" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Your card", exact: true })).toBeVisible();
  // The notice of storefront.get (`payment.airlineCard.notice`): the airline charges the card, at its own price.
  const notice = page.getByRole("region", { name: "The airline charges your card" });
  await expect(notice).toContainText("The airline charges your card. The price is the airline's price.");
  // The airline's price: the checkout's total in net pricing, before any card fee.
  const trip = page.getByRole("complementary", { name: "Your trip" });
  await expect(trip.getByRole("definition").last()).toHaveText(/^€[\d,]+\.\d{2}$/);
  for (const input of cardInputs(page)) {
    await expect(input).toHaveValue("");
  }
}

/** The five card inputs of the airline-card page, by their labels. */
function cardInputs(page: Page) {
  const form = page.getByRole("form", { name: "Your card", exact: true });
  return [
    form.getByRole("textbox", { name: "Name on the card" }),
    form.getByRole("textbox", { name: "Card number" }),
    form.getByRole("textbox", { name: "Month (MM)" }),
    form.getByRole("textbox", { name: "Year (YYYY)" }),
    form.getByRole("textbox", { name: "Security code" }),
  ] as const;
}

/** Types `card` into the airline-card page, after the leak checks were told to look for its values. */
async function typeCard({ page, leaks }: Journey, card: JourneyCard): Promise<void> {
  leaks.remember(card);
  const [holder, number, month, year, securityCode] = cardInputs(page);
  await holder.fill(card.holderName);
  await number.fill(card.number);
  await month.fill(card.expiryMonth);
  await year.fill(card.expiryYear);
  await securityCode.fill(card.securityCode);
}

/**
 * Waits for the airline's card fee of the typed card (`checkout.updatePayment` with the brand and the first six digits,
 * sent once six digits were typed): the review shows the VISA fee of the stub and the total the airline charges, and
 * the button pays that total. Returns the Pay button.
 */
async function expectReviewedTotal({ page, guards }: Journey) {
  const pay = page.getByRole("button", { name: PAY_BUTTON });
  await expect(pay).toBeVisible();
  const review = page.getByRole("region", { name: "Your final total" });
  await expect(review).toBeVisible();
  await expect(review.getByRole("definition").nth(0)).toHaveText("Visa");
  await expect(review.getByRole("definition").nth(1)).toHaveText(VISA_CARD_FEE);
  const total = (await review.getByRole("definition").nth(2).textContent())?.trim() ?? "";
  expect(total).toMatch(/^€[\d,]+\.\d{2}$/);
  await expect(pay).toHaveText(`Pay ${total}`);
  // The trip summary follows: the card fee row and the same total.
  const trip = page.getByRole("complementary", { name: "Your trip" });
  await expect(trip.getByRole("definition").last()).toHaveText(total);
  await guards.checkA11y(page);
  return pay;
}

/** Whether `response` is the answer to the airline-card completion (`POST …/airline-card-completion`, via `/api`). */
function isCompletion(response: Response): boolean {
  return (
    response.request().method() === "POST" &&
    /^\/api\/v1\/checkouts\/chk_[^/]+\/airline-card-completion$/.test(new URL(response.url()).pathname)
  );
}

/** The demo OTA's payment `paymentId` as the airline-card path leaves it, and its booking's pricing. */
async function airlinePayment(paymentId: string) {
  return await withTenantTx(DEMO_TENANT_SCHEMA, async (trx) => {
    const payment = await trx
      .selectFrom("payments")
      .select([
        "provider",
        "method",
        "status",
        "card_brand",
        "card_bin",
        "card_last4",
        "card_exp_month",
        "card_exp_year",
        "booking_id",
      ])
      .where("id", "=", paymentId)
      .executeTakeFirstOrThrow();
    const booking =
      payment.booking_id === null
        ? undefined
        : await trx
            .selectFrom("bookings")
            .select(["pricing_mode", "markup_amount"])
            .where("id", "=", payment.booking_id)
            .executeTakeFirst();
    return { ...payment, pricingMode: booking?.pricing_mode, markupAmount: booking?.markup_amount };
  });
}

/**
 * The booking of a lost answer as the OTA left it: its status, whether it is reconciling, its payment's status and
 * booking, and how many Flight Create Orders requests the OTA sent for it (`supplier_requests`, written before the
 * answer).
 */
async function lostAnswerState(bookingId: string, paymentId: string) {
  return await withTenantTx(DEMO_TENANT_SCHEMA, async (trx) => {
    const booking = await trx
      .selectFrom("bookings")
      .select(["status", "reconcile_until"])
      .where("id", "=", bookingId)
      .executeTakeFirstOrThrow();
    const payment = await trx
      .selectFrom("payments")
      .select(["status", "booking_id"])
      .where("id", "=", paymentId)
      .executeTakeFirstOrThrow();
    const orders = await trx
      .selectFrom("supplier_requests")
      .select(sql<string>`count(*)`.as("count"))
      .where("booking_id", "=", bookingId)
      .where("amadeus_api", "=", "FlightCreateOrders")
      .executeTakeFirstOrThrow();
    return {
      status: booking.status,
      reconciling: booking.reconcile_until !== null,
      paymentStatus: payment.status,
      paymentBookingId: payment.booking_id,
      createOrders: Number(orders.count),
    };
  });
}

test.beforeAll(async () => {
  // The demo OTA's test storefront offers the airline card (the OTA admin's switch); AIRLINE_CARD_ENABLED is on.
  await enableAirlineCard();
});

test.describe("the airline-card checkout journey", () => {
  test.describe.configure({ mode: "serial" });

  const email = uniqueEmail("ofe018-airline-card");
  let journey: Journey;
  let paymentId = "";
  let cardPageAddress = "";

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

  test("searches, opens an offer and prices it [OFE-018 AC1] [OF-05 AC1]", async () => {
    await searchAndPrice(journey, SUCCESS_DAYS_AHEAD);
  });

  test("checks out as a guest and opens the airline-card page with the airline's notice and price [OFE-018 AC1] [OF-05 AC2]", async () => {
    paymentId = await checkOutWithAirlineCard(journey, email);
    cardPageAddress = journey.page.url();
  });

  test("the completion is the storefront edge's alone: the OTA API refuses it from any other caller [OFE-018 AC1] [OF-05 AC2]", async () => {
    // The same operation straight to the OTA API, without the edge credential the storefront's proxy adds (Caddy in
    // production): refused before anything is read. No card is sent; key callers' 403 is the backend's test (OBE-051).
    const checkoutId = new URL(cardPageAddress).searchParams.get("id") ?? "";
    const answer = await fetch(`${OTA_API_URL}/v1/checkouts/${checkoutId}/airline-card-completion`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
      body: JSON.stringify({ paymentId }),
    });
    expect(answer.status).toBe(401);
    expect(await answer.json()).toMatchObject({ error: { code: "INVALID_API_KEY" } });
  });

  test("a page that opens the card page with window.open gets a closed handle and no access to it [OFE-018 AC1] [OF-05 AC1]", async () => {
    const { context, guards } = journey;
    await expectOpenerCutOff(context, cardPageAddress, (page) => guards.checkA11y(page));
  });

  test("a card the page refuses is never sent, and its errors repeat none of its values [OFE-018 AC1] [OF-05 AC1]", async () => {
    const { page, guards, leaks } = journey;
    await typeCard(journey, INVALID_CARD);
    const pay = await expectReviewedTotal(journey);
    await pay.click();

    // The page's own checks refuse the number before anything is sent (docs/pages.md §9): the summary of the problems
    // takes the focus, the field is marked, and the values stay in the inputs for the traveller to correct. No
    // message repeats a value (OADR-0017 point 6).
    const form = page.getByRole("form", { name: "Your card", exact: true });
    const summary = form.getByText("Check the card details", { exact: true }).locator("xpath=..");
    await expect(summary).toBeFocused();
    await expect(summary.getByRole("link", { name: "Check the card number" })).toBeVisible();
    await expect(form.getByRole("textbox", { name: "Card number" })).toHaveAttribute("aria-invalid", "true");
    await guards.checkA11y(page);
    expect(leaks.completions).toHaveLength(0);
    expect(cardValuesIn(await page.locator("body").innerText(), [INVALID_CARD])).toEqual([]);

    // The validation error path (OADR-0017 point 8): no card value anywhere the browser keeps state, in a request or
    // in an answer. The one finding is the typed inputs themselves, which shows that the input check reads the real
    // inputs of the airline-card page; the next step leaves the page and finds them empty.
    expect(await leaks.findLeaks(page)).toEqual([
      {
        where: `the card inputs holder, number, month, year, csc of ${STOREFRONT_URL}/checkout/pay-airline.html, which are not empty`,
        kinds: [],
      },
    ]);
  });

  test("a card typed and left behind is gone from the inputs and from everywhere the browser keeps state [OFE-018 AC1] [OF-05 AC1]", async () => {
    const { page, guards, leaks } = journey;
    await typeCard(journey, ACCEPTED_CARD);
    await expectReviewedTotal(journey);
    // Leave the page (back to the payment step), then come back with Back: the inputs are empty again.
    await page.getByRole("link", { name: "Change the payment method" }).click();
    await page.waitForURL(/\/checkout\.html\?id=chk_[^&]+&step=payment$/);
    await expect(page.getByRole("heading", { level: 2, name: "Payment" })).toBeVisible();
    await guards.checkA11y(page);
    await page.goBack();
    await page.waitForURL(cardPageAddress);
    await expectCardForm(page);
    await leaks.expectNoLeak(page);
  });

  test("pays with the test card and shows the confirmation with the tickets [OFE-018 AC1] [OF-05 AC1]", async () => {
    const { page, guards, leaks } = journey;
    await typeCard(journey, ACCEPTED_CARD);
    const pay = await expectReviewedTotal(journey);
    const completion = page.waitForResponse(isCompletion);
    await pay.click();
    expect((await completion).status()).toBe(201);

    await page.waitForURL(/\/confirmation\.html\?booking=bkg_[^&]+$/);
    expect(new URL(page.url()).searchParams.get("booking")).toMatch(BOOKING_ID);
    await expect(page.getByRole("heading", { level: 1, name: "Your tickets are issued" })).toBeVisible();
    const tickets = page
      .getByRole("heading", { level: 3, name: "Ticket numbers" })
      .locator("xpath=..")
      .getByRole("listitem");
    await expect(tickets).toHaveCount(1);
    await expect(tickets.first()).toHaveText(TICKET_LINE);
    await guards.checkA11y(page);

    // One completion, and the card left the page in its body only (the leak checks read every other request).
    expect(leaks.completions).toHaveLength(1);
    await leaks.expectNoLeak(page);
  });

  test("the airline charged the card: the payment keeps the brand, the BIN and the last 4 only [OFE-018 AC1] [OF-05 AC1]", async () => {
    const payment = await airlinePayment(paymentId);
    expect(payment).toMatchObject({
      provider: "airline",
      method: "airline_card",
      status: "captured",
      card_brand: "VISA",
      card_bin: "411111",
      card_last4: "1111",
      card_exp_month: null,
      card_exp_year: null,
      pricingMode: "net",
    });
    // No markup on the airline's price (decimal text from PostgreSQL, compared as text).
    expect(String(payment.markupAmount)).toMatch(/^0(?:\.0+)?$/);
  });
});

test.describe("the airline declines the card three times", () => {
  test.describe.configure({ mode: "serial" });

  const email = uniqueEmail("ofe018-declined");
  let journey: Journey;

  test.beforeAll(async ({ browser }) => {
    journey = await openJourney(browser);
  });

  test.afterEach(async () => {
    await journey?.guards.finish(journey.page);
  });

  test.afterAll(async () => {
    await journey?.context.close();
  });

  test("searches, opens an offer and prices it [OFE-018 AC1] [OF-05 AC1]", async () => {
    await searchAndPrice(journey, DECLINE_DAYS_AHEAD);
  });

  test("checks out as a guest and opens the airline-card page [OFE-018 AC1] [OF-05 AC1]", async () => {
    await checkOutWithAirlineCard(journey, email);
  });

  for (const attempt of [1, 2]) {
    test(`a declined card says so and empties the inputs (attempt ${attempt}) [OFE-018 AC1] [OF-05 AC1]`, async () => {
      const { page, guards, leaks } = journey;
      await typeCard(journey, DECLINED_CARD);
      const pay = await expectReviewedTotal(journey);
      const completion = page.waitForResponse(isCompletion);
      await pay.click();
      const answer = await completion;
      expect(answer.status()).toBe(402);
      expect(await answer.json()).toMatchObject({ error: { code: "PAYMENT_DECLINED" } });

      const main = page.getByRole("main");
      await expect(main.getByText("The airline declined the card", { exact: true })).toBeVisible();
      await expect(main.getByText(/a booking takes at most three attempts/)).toBeVisible();
      for (const input of cardInputs(page)) {
        await expect(input).toHaveValue("");
      }
      await guards.checkA11y(page);
      expect(leaks.completions).toHaveLength(attempt);
      await leaks.expectNoLeak(page);
    });
  }

  test("the third decline is the attempt limit: Too many attempts [OFE-018 AC1] [OF-05 AC1]", async () => {
    const { page, guards, leaks } = journey;
    await typeCard(journey, DECLINED_CARD);
    const pay = await expectReviewedTotal(journey);
    const completion = page.waitForResponse(isCompletion);
    await pay.click();
    const answer = await completion;
    expect(answer.status()).toBe(403);
    expect(await answer.json()).toMatchObject({ error: { code: "PAYMENT_ATTEMPTS_EXCEEDED" } });

    const main = page.getByRole("main");
    await expect(main.getByText("Too many attempts", { exact: true })).toBeVisible();
    await expect(main.getByRole("link", { name: "Pay by card" })).toBeVisible();
    await expect(main.getByRole("link", { name: "Search flights" })).toBeVisible();
    // The form is gone: no card input is left on the page.
    await expect(page.getByRole("form", { name: "Your card", exact: true })).toBeHidden();
    await guards.checkA11y(page);

    // Three submits, three completions, each with an idempotency key of its own (one attempt per submit).
    const keys = leaks.completions.map((completionRequest) => completionRequest.idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    await leaks.expectNoLeak(page);
  });
});

test.describe("the airline's answer is lost", () => {
  test.describe.configure({ mode: "serial" });

  const email = uniqueEmail("ofe018-lost-answer");
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

  test("searches, opens an offer and prices it [OFE-018 AC1] [OF-05 AC1]", async () => {
    await searchAndPrice(journey, LOST_ANSWER_DAYS_AHEAD);
  });

  test("checks out as a guest and opens the airline-card page [OFE-018 AC1] [OF-05 AC1]", async () => {
    paymentId = await checkOutWithAirlineCard(journey, email);
  });

  test("goes to the pending confirmation and never sends the card again [OFE-018 AC1] [OF-05 AC1]", async () => {
    const { page, guards, leaks } = journey;
    // The Amadeus stub's `server-error` for this completion only: the OTA API forwards the request's X-Stub-Scenario
    // to its Amadeus calls outside production, and Flight Create Orders answers 500. The order may exist, so the OTA
    // keeps the booking pending for its reconciliation and answers 504 SUPPLIER_TIMEOUT with the booking's id, as for
    // an answer that never came (OADR-0003 point 2). Every other request of the journey goes unchanged.
    await page.route("**/api/v1/checkouts/*/airline-card-completion", async (route) => {
      await route.continue({
        headers: { ...(await route.request().allHeaders()), "x-stub-scenario": "server-error" },
      });
    });
    await typeCard(journey, ACCEPTED_CARD);
    const pay = await expectReviewedTotal(journey);
    const completion = page.waitForResponse(isCompletion);
    await pay.click();
    // The answer's body is the page's to read: it leaves for the confirmation at once, which takes the browser's copy.
    expect((await completion).status()).toBe(504);

    // docs/pages.md §9: the confirmation of the 504's booking (`details.bookingId`) in pending mode.
    await page.waitForURL(/\/confirmation\.html\?booking=bkg_[^&]+&pending=1$/);
    const bookingId = new URL(page.url()).searchParams.get("booking") ?? "";
    expect(bookingId).toMatch(BOOKING_ID);
    await expect(
      page.getByRole("heading", { level: 1, name: "We are confirming your booking with the airline" }),
    ).toBeVisible();
    await expect(page.getByText(/Please do not book again: this page updates by itself/)).toBeVisible();
    await guards.checkA11y(page);

    // The card went out once: one completion from the browser, one Flight Create Orders from the OTA, which keeps the
    // booking pending for its reconciliation with the card's payment taken (flows/checkout-airline-card.md §4).
    expect(leaks.completions).toHaveLength(1);
    expect(await lostAnswerState(bookingId, paymentId)).toEqual({
      status: "pending",
      reconciling: true,
      paymentStatus: "processing",
      paymentBookingId: bookingId,
      createOrders: 1,
    });
    await leaks.expectNoLeak(page);
  });
});

/** The path of the leak checks' own probe request, answered by `page.route` (no such operation exists). */
const PROBE_PATH = "/api/v1/vx-e2e-probe";

test.describe("the card leak checks", () => {
  test("find a card value wherever a page could keep it, so a green check means something [OFE-018 AC1]", async ({
    context,
    page,
    guards,
  }) => {
    // The checks of this test's own context (the storefront guards of the fixture watch it too); its storage, its
    // IndexedDB and its cookies go with it when the test ends.
    const leaks = await CardLeakGuards.install(context);
    leaks.remember(ACCEPTED_CARD);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Search flights" })).toBeVisible();
    expect(await leaks.findLeaks(page)).toEqual([]);

    // An answer of the OTA API that holds the holder's name: a `page.route` answer to a path of the probe's own, so
    // nothing reaches the API.
    await page.route(
      (url) => url.pathname === PROBE_PATH,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ holderName: ACCEPTED_CARD.holderName }),
        }),
    );

    // A script of the page keeps the card everywhere the checks look and sends it in a request's address, header and
    // body; a cookie the server could set holds the name.
    await page.evaluate(
      async ([number, securityCode, holderName, probePath]) => {
        const digits = number.replace(/\D/g, "");
        localStorage.setItem("vx.e2e.probe", digits);
        sessionStorage.setItem("vx.e2e.probe", JSON.stringify({ securityCode }));
        window.name = number;
        history.pushState({ securityCode }, "", `?probe=${digits}`);
        await new Promise<void>((resolve, reject) => {
          const open = indexedDB.open("vx-e2e-probe", 1);
          open.onupgradeneeded = () => open.result.createObjectStore("cards");
          open.onerror = () => reject(open.error ?? new Error("IndexedDB open failed"));
          open.onsuccess = () => {
            const tx = open.result.transaction("cards", "readwrite");
            tx.objectStore("cards").put({ last12: digits.slice(-12) }, "card");
            tx.oncomplete = () => {
              open.result.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
          };
        });
        await fetch(`/api/v1/storefront?probe=${digits}`);
        const probe = await fetch(probePath, {
          method: "POST",
          headers: { "content-type": "application/json", "x-vx-e2e-probe": number },
          body: JSON.stringify({ securityCode, holderName }),
        });
        await probe.text();
      },
      [ACCEPTED_CARD.number, ACCEPTED_CARD.securityCode, ACCEPTED_CARD.holderName, PROBE_PATH] as const,
    );
    await context.addCookies([
      {
        name: "vx_e2e_probe",
        value: ACCEPTED_CARD.holderName,
        url: STOREFRONT_URL,
        httpOnly: true,
        secure: true,
      },
    ]);

    const home = `${STOREFRONT_URL}/`;
    expect(await leaks.findLeaks(page)).toEqual(
      expect.arrayContaining([
        { where: 'localStorage "vx.e2e.probe"', kinds: ["card number", "last 12 digits"] },
        { where: 'sessionStorage "vx.e2e.probe"', kinds: ["security code"] },
        { where: "IndexedDB vx-e2e-probe/cards", kinds: ["last 12 digits"] },
        { where: `window.name of ${home}`, kinds: ["card number", "last 12 digits"] },
        { where: `the address of ${home}`, kinds: ["card number", "last 12 digits"] },
        { where: `history.state of ${home}`, kinds: ["security code"] },
        { where: `an address given to history (${home})`, kinds: ["card number", "last 12 digits"] },
        { where: `a state given to history on ${home}`, kinds: ["security code"] },
        {
          where: `the address of the request GET ${STOREFRONT_URL}/api/v1/storefront`,
          kinds: ["card number", "last 12 digits"],
        },
        {
          where: `the header x-vx-e2e-probe of the request POST ${STOREFRONT_URL}${PROBE_PATH}`,
          kinds: ["card number", "last 12 digits"],
        },
        {
          where: `the body of the request POST ${STOREFRONT_URL}${PROBE_PATH}`,
          kinds: ["security code", "holder name"],
        },
        { where: `the answer of ${STOREFRONT_URL}${PROBE_PATH}`, kinds: ["holder name"] },
        { where: "the cookie vx_e2e_probe", kinds: ["holder name"] },
      ]),
    );
    await expect(leaks.expectNoLeak(page)).rejects.toThrow(/card values found where the browser keeps them/);
    await guards.checkA11y(page);
  });
});
