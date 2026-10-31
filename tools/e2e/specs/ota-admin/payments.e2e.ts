// The OTA admin's payments journey (OAD-017; ota/admin/README.md §12, routes.md §7, flows/console-operations.md §2 step
// 5, OADR-0010 points 3 and 6), nightly in the `storefront-stripe` project: Stripe's test mode over the network, the
// Payment Element on the storefront's card page, and the Stripe CLI forwarder of the stack (support/stripe.ts), which
// brings Stripe's events to the OTA API's webhook.
//
//   the owner sets the OTA's ticketing policy to "Manual review" in the console → a traveller books on the OTA's
//   storefront and pays with Stripe's test card: the booking waits for staff, its payment authorised and not captured
//   → the owner captures it from the payment's page → and refunds part of it: the refund is asked for at once, sent to
//   Stripe by the payments queue, and completed by Stripe's webhook (the refund `succeeded`, the payment
//   `partially_refunded`)
//
// The OTA is the journey's own (`newOwnerWithActiveOta`: a new owner, an office of the test pool, its Stripe
// connection in `velexis` mode on the stack's test keys), not the demo OTA, which no one may change: its console is
// opened from the portal as its owner, and its storefront is the preview's pages with their `/api/*` requests sent to
// the OTA API as that OTA's storefront edge (`serveStorefrontOf` of support/ota.ts), under the storefront guards of a
// Stripe journey (Stripe.js and its two cookies allowed from the card page on, OADR-0006 point 10). "Manual review" is
// the policy under which a booking's Stripe payment stays authorised for the staff to capture (console-operations.md
// §2 step 5); the plan's "manual_review Stripe payment" is that payment.
//
// Every test carries the tag `@stripe`, so only `storefront-stripe` runs it (E2E_STRIPE=1 with E2E_WITH_OTA=1 and the
// OTA's Stripe test keys, playwright.config.ts); the `ota-admin` project, which runs on every labelled pull request and
// locally, leaves it out. Without the keys the journey fails at once with that message; nothing is ever skipped. Card
// data is Stripe's documented test card only, typed into Stripe's iframe as a traveller would.
//
// Every page the journey visits passes axe once its title is in place, and on every page of the OTA admin JavaScript
// reads no cookie. The steps are tests in order (`mode: "serial"`) on the owner's console context and the traveller's
// storefront context, both made in `beforeAll`.
import { type BrowserContext, type Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../../support/a11y";
import {
  addSessionCookies,
  expect,
  newAccountContext,
  PROJECT_TAGS,
  test,
  uniqueTestIp,
} from "../../support/fixtures";
import { uniqueEmail } from "../../support/mailpit";
import {
  departureDate,
  newOwnerWithActiveOta,
  openConsoleFromPortal,
  scriptReadableCookieNames,
  serveStorefrontOf,
  withTenantTx,
  type OwnedOta,
} from "../../support/ota";
import { stack } from "../../support/seed";
import { OTA_ADMIN_URL, otaStripeKeys, STOREFRONT_URL, type OtaStripeKeys } from "../../support/stack";
import { StorefrontGuards } from "../../support/storefront-guards";
import {
  fillCardForm,
  PAYMENT_ELEMENT_FRAME,
  retrievePaymentIntent,
  STRIPE_TEST_CARDS,
} from "../../support/stripe";

/** The departure of the journey's search: a date of its own, days from today. */
const DAYS_AHEAD = 57;
/** The traveller: synthetic, as a test needs. */
const TRAVELLER = Object.freeze({ firstName: "Pia", lastName: "Capture", dateOfBirth: "1988-03-09" });
/** The part of the captured payment the owner refunds, in EUR (the OTA's currency). */
const REFUND_AMOUNT = "10.00";
const CAPTURE_REASON = "The airline confirmed the order; capture the authorisation (OAD-017 journey).";
const REFUND_REASON = "A goodwill refund of part of the fare (OAD-017 journey).";
/**
 * How long Stripe's events may take to complete the refund: the payments queue sends it to Stripe at once, and Stripe
 * sends `charge.refund.updated` through the CLI forwarder within seconds. Within the step's 30 s.
 */
const REFUND_WEBHOOK_WAIT_MS = 25_000;

/** The OTA admin's title of a page (`%s · Velexis OTA admin`, src/app/layout.tsx). */
const adminTitle = (title: string): string => `${title} · Velexis OTA admin`;

let keys: OtaStripeKeys;
let owned: OwnedOta;
let admin: BrowserContext;
let consolePage: Page;
let storefront: BrowserContext;
let shop: Page;
let guards: StorefrontGuards;
let paymentId = "";
let bookingId = "";

/** The OTA's Stripe test keys of the stack, or the message that says how to run this journey. */
function requireStripe(): OtaStripeKeys {
  const found = otaStripeKeys(stack().settings);
  if (found === undefined) {
    throw new Error(
      "payments.e2e.ts captures and refunds in Stripe's test mode: run it with E2E_WITH_OTA=1, E2E_STRIPE=1, " +
        "STRIPE_SECRET_KEY_TEST and STRIPE_PUBLISHABLE_KEY_TEST and the Stripe CLI (the nightly storefront-stripe step " +
        "of e2e.yml)",
    );
  }
  return found;
}

/** Waits until `target` shows the OTA admin's page `title`, then runs axe and checks that no cookie is readable. */
async function expectAdminPage(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(adminTitle(title));
  await expectNoSeriousA11yViolations(target);
  expect(await scriptReadableCookieNames(target)).toEqual([]);
}

/** The results page address of a one-way search from Madrid to Paris (docs/pages.md §3). */
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

/** The journey's payment and its booking as the OTA recorded them (read through `tenantTx`). */
async function recorded() {
  return await withTenantTx(owned.schema, async (trx) => ({
    payment: await trx
      .selectFrom("payments")
      .select(["status", "amount", "amount_captured", "amount_refunded", "provider_payment_id"])
      .where("id", "=", paymentId)
      .executeTakeFirstOrThrow(),
    booking: await trx
      .selectFrom("bookings")
      .select(["status", "ticketing_status"])
      .where("id", "=", bookingId)
      .executeTakeFirstOrThrow(),
    refunds: await trx
      .selectFrom("refunds")
      .select(["status", "amount", "reason", "requested_by_type"])
      .where("payment_id", "=", paymentId)
      .execute(),
  }));
}

/** The PaymentIntent of the journey's payment as Stripe has it. */
async function paymentIntent(): Promise<string> {
  const { payment } = await recorded();
  if (payment.provider_payment_id === null) {
    throw new Error(`the payment ${paymentId} has no PaymentIntent`);
  }
  return (await retrievePaymentIntent(keys.secretKey, payment.provider_payment_id)).status;
}

/** Opens the journey's payment in the console. */
async function openPayment(): Promise<void> {
  await consolePage.goto(`/payments/${paymentId}`);
  await expect(consolePage.getByRole("heading", { level: 1 })).toContainText(paymentId);
  await expectAdminPage(consolePage, "Payment");
}

test.describe("the OTA admin's payments journey", { tag: PROJECT_TAGS.stripe }, () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    keys = requireStripe();
    // Budget: a sign-up with its verification e-mail (up to 15 s) and the OTA's set-up on the OTA worker (about 2 s
    // locally; PF-11 allows a minute).
    test.setTimeout(120_000);
    owned = await newOwnerWithActiveOta("Paula Payments", "pay");

    admin = await newAccountContext(browser, owned.owner.account, OTA_ADMIN_URL);
    await addSessionCookies(admin, "portal", owned.session);
    consolePage = await admin.newPage();

    // The traveller's browser on the OTA's storefront: an end-user IP of its own, the guards of a Stripe journey.
    storefront = await browser.newContext({
      baseURL: STOREFRONT_URL,
      extraHTTPHeaders: { "X-Forwarded-For": uniqueTestIp() },
    });
    guards = await StorefrontGuards.install(storefront, { stripeJourney: true });
    await serveStorefrontOf(storefront, owned.storefrontHost);
    shop = await storefront.newPage();
  });

  test.afterEach(async () => {
    // The storefront guards of every step: CSP, third-party requests, readable cookies, axe on the page it ended on.
    await guards?.finish(shop);
  });

  test.afterAll(async () => {
    await admin?.close();
    await storefront?.close();
  });

  test("the owner sets the ticketing policy to manual review in the console [OAD-017 step 1]", async () => {
    await openConsoleFromPortal(consolePage, owned.ota.id);
    await expectAdminPage(consolePage, "Bookings");
    await consolePage.goto("/settings/storefront?tab=policies");
    await expectAdminPage(consolePage, "Storefront settings");
    const policies = consolePage.getByRole("form", { name: "Policies" });
    await policies.getByRole("radio", { name: /^Manual review/ }).check();
    await policies.getByRole("button", { name: "Save policies" }).click();
    await expect(
      policies
        .getByRole("status")
        .filter({ hasText: "Saved. The storefront shows the change within 5 minutes." }),
    ).toBeVisible();
    await expectAdminPage(consolePage, "Storefront settings");
    const settings = await withTenantTx(owned.schema, async (trx) =>
      trx.selectFrom("storefront_settings").select("ticketing_policy").executeTakeFirstOrThrow(),
    );
    expect(settings.ticketing_policy).toBe("manual_review");
  });

  test("a traveller searches, prices and checks out on the OTA's storefront [OAD-017 step 1]", async () => {
    await shop.goto(searchAddress(DAYS_AHEAD));
    await shop.waitForURL(/[?&]search=srch_/);
    const select = shop.getByRole("link", { name: /^Select this flight for / });
    await expect(select.first()).toBeVisible();
    await guards.checkA11y(shop);
    await select.first().click();
    await shop.waitForURL(/\/offer\.html\?offer=off_/);
    const keepFare = shop.getByRole("button", { name: "Continue with this fare" });
    await expect(keepFare).toBeVisible();
    await guards.checkA11y(shop);
    await keepFare.click();
    await shop.waitForURL(/\/price\.html\?priced=prc_/);
    await expect(shop.getByRole("heading", { level: 1, name: "Your price" })).toBeVisible();
    await guards.checkA11y(shop);

    await shop.getByRole("button", { name: "Continue to checkout" }).click();
    await shop.waitForURL(/\/checkout\.html\?id=chk_/);
    const travellers = shop.getByRole("region", { name: "Travellers" });
    const traveller = travellers.getByRole("group", { name: "Traveller 1: Adult" });
    await expect(traveller).toBeVisible();
    await guards.checkA11y(shop);
    await traveller.getByRole("textbox", { name: "First and middle names" }).fill(TRAVELLER.firstName);
    await traveller.getByRole("textbox", { name: "Last name" }).fill(TRAVELLER.lastName);
    await traveller.getByRole("textbox", { name: "Date of birth" }).fill(TRAVELLER.dateOfBirth);
    await traveller
      .getByRole("combobox", { name: "Gender, as in the travel document" })
      .selectOption("FEMALE");
    await travellers.getByRole("button", { name: "Continue", exact: true }).click();

    const contacts = shop.getByRole("region", { name: "Contact details" });
    await expect(contacts.getByRole("textbox", { name: "First name" })).toHaveValue(TRAVELLER.firstName);
    await guards.checkA11y(shop);
    await contacts.getByRole("textbox", { name: "E-mail address" }).fill(uniqueEmail("oad017-payments"));
    await contacts.getByRole("textbox", { name: "Country calling code" }).fill("34");
    await contacts.getByRole("textbox", { name: "Mobile phone number" }).fill("600000000");
    await contacts.getByRole("button", { name: "Continue", exact: true }).click();

    const extras = shop.getByRole("region", { name: "Extras and special requests" });
    await expect(extras.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
    await guards.checkA11y(shop);
    await extras.getByRole("button", { name: "Continue", exact: true }).click();

    const payment = shop.getByRole("region", { name: "Payment", exact: true });
    await expect(payment.getByRole("heading", { level: 2, name: "Payment" })).toBeVisible();
    await expect(payment.getByRole("radio", { name: /^Card Accepted: / })).toBeVisible();
    await guards.checkA11y(shop);
  });

  test("pays with Stripe's test card: the booking waits for staff, its payment authorised [OAD-017 step 1]", async () => {
    const payment = shop.getByRole("region", { name: "Payment", exact: true });
    await payment.getByRole("radio", { name: /^Card Accepted: / }).check();
    await payment.getByRole("checkbox", { name: /^I accept the terms and conditions/ }).check();
    await payment.getByRole("button", { name: "Continue to payment" }).click();
    await shop.waitForURL(/\/checkout\/pay-card\.html\?id=chk_[^&]+&payment=pay_/);
    await expect(shop.getByRole("heading", { level: 1, name: "Pay by card" })).toBeVisible();
    await expect(shop.locator(PAYMENT_ELEMENT_FRAME).first()).toBeVisible();
    await expect(shop.getByRole("button", { name: "Review total" })).toBeVisible();
    await guards.checkA11y(shop);
    paymentId = new URL(shop.url()).searchParams.get("payment") ?? "";
    expect(paymentId).toMatch(/^pay_[0-9A-HJKMNP-TV-Z]{26}$/);

    await fillCardForm(shop, STRIPE_TEST_CARDS.visa);
    await shop.getByRole("button", { name: "Review total" }).click();
    await expect(shop.getByRole("heading", { level: 2, name: "Your final total" })).toBeVisible();
    await guards.checkA11y(shop);
    await shop.getByRole("button", { name: /^Pay €/ }).click();

    // The complete page turns the authorised payment into the booking, then opens its confirmation.
    await shop.waitForURL(/\/confirmation\.html\?booking=bkg_/);
    await expect(shop.getByRole("heading", { level: 1, name: "Booking confirmed" })).toBeVisible();
    bookingId = new URL(shop.url()).searchParams.get("booking") ?? "";
    await guards.checkA11y(shop);

    // Manual review: the order exists, no ticket yet, and the payment only authorised, at Stripe too.
    const state = await recorded();
    expect(state.booking).toEqual({ status: "confirmed", ticketing_status: "manual_review" });
    expect(state.payment).toMatchObject({ status: "authorized", amount_captured: "0.00" });
    expect(await paymentIntent()).toBe("requires_capture");
  });

  test("the owner captures the authorised payment from its page [OAD-017 step 1]", async () => {
    await openPayment();
    const main = consolePage.getByRole("main");
    await main.getByRole("button", { name: "Capture", exact: true }).click();
    const dialog = consolePage.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: `Capture payment ${paymentId}?` })).toBeVisible();
    // The whole authorisation: the amount is left empty.
    await dialog.getByRole("textbox", { name: "Reason" }).fill(CAPTURE_REASON);
    await expectNoSeriousA11yViolations(consolePage);
    await dialog.getByRole("button", { name: "Capture", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expectAdminPage(consolePage, "Payment");
    await expect(main.getByRole("button", { name: "Capture", exact: true })).toHaveCount(0);
    await expect(main.getByRole("button", { name: "Refund", exact: true })).toBeVisible();

    const state = await recorded();
    expect(state.payment.status).toBe("captured");
    expect(state.payment.amount_captured).toBe(state.payment.amount);
    expect(await paymentIntent()).toBe("succeeded");
    const actions = await withTenantTx(owned.schema, async (trx) =>
      trx
        .selectFrom("staff_actions")
        .select(["outcome", "reason", "staff_role"])
        .where("action", "=", "payment.capture")
        .execute(),
    );
    expect(actions).toEqual([{ outcome: "succeeded", reason: CAPTURE_REASON, staff_role: "owner" }]);
  });

  test("the owner refunds part of the captured payment, and Stripe's webhook completes it [OAD-017 step 1]", async () => {
    await openPayment();
    const main = consolePage.getByRole("main");
    await main.getByRole("button", { name: "Refund", exact: true }).click();
    const dialog = consolePage.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: `Refund payment ${paymentId}?` })).toBeVisible();
    await dialog.getByRole("textbox", { name: "Amount to refund (EUR)" }).fill(REFUND_AMOUNT);
    await dialog.getByRole("combobox", { name: "Reason category" }).selectOption("goodwill");
    await dialog.getByRole("textbox", { name: "Reason" }).fill(REFUND_REASON);
    await expectNoSeriousA11yViolations(consolePage);
    await dialog.getByRole("button", { name: "Refund", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expectAdminPage(consolePage, "Payment");

    // Asked for at once by the staff member; sent to Stripe by the payments queue; completed by Stripe's webhook.
    await expect
      .poll(async () => (await recorded()).refunds, {
        message: "the refund is completed by Stripe's webhook",
        timeout: REFUND_WEBHOOK_WAIT_MS,
      })
      .toEqual([
        { status: "succeeded", amount: REFUND_AMOUNT, reason: "goodwill", requested_by_type: "staff" },
      ]);
    const state = await recorded();
    expect(state.payment).toMatchObject({ status: "partially_refunded", amount_refunded: REFUND_AMOUNT });

    // The payment's page shows what is left to refund now.
    await openPayment();
    await expect(main.getByRole("button", { name: "Refund", exact: true })).toBeVisible();
  });
});
