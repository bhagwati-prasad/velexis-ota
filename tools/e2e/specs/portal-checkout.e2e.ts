// The portal's Stripe Checkout and Customer Portal journey (PFE-027 step 1; platform/docs/flows/subscription-billing.md
// §B, §D and §F, scope PF-71 AC1 and PF-72 AC1), nightly only: its tests carry `@stripe`, so they run in the
// `portal-stripe` project alone (PADR-0017 item 4), which exists only with E2E_STRIPE=1, and drive Stripe's hosted
// Checkout and Customer Portal in Stripe's test mode, over the network:
//
//   a new owner creates an OTA with a paid plan in the wizard → Stripe Checkout opens → the owner pays with the test
//   card 4242 4242 4242 4242 → back on the portal, the OTA becomes active once Stripe's webhook (not the redirect)
//   confirmed the subscription → the billing page shows the Stripe subscription and opens the Stripe Customer Portal
//
// What the run needs, and checks first in `beforeAll` (each missing piece fails at once with its name, never a pass):
// E2E_STRIPE=1 with the Stripe test values of the harness (STRIPE_SECRET_KEY, STRIPE_BILLING_WEBHOOK_SECRET),
// E2E_WITH_OTA=1 (the OTA worker sets the OTA up after the payment), Stripe Billing on in the stack's platform processes
// (`getMe.features.stripeBilling`), and Stripe's billing events forwarded to the platform API's
// `/webhooks/stripe/billing` and signed with STRIPE_BILLING_WEBHOOK_SECRET (`stripe listen`); the Customer Portal also
// needs its test-mode configuration saved once in the Stripe dashboard (a human step). tools/e2e/README.md ("Tests of
// PFE-027") says which of these the stack and the nightly workflow provide today.
//
// Arranged in `beforeAll`: a Stripe product with a monthly price in the test account (Stripe's API, the test key), and
// a public plan `e2epaid_<random>` linked to them, as velexis_migrator fixtures (a platform admin links a plan's prices
// with `adminUpdatePlan`, PAD-012; the journey is the portal's). The plan has no free trial, so Checkout charges the
// card at once. The owner is a verified account signed in through the platform API.
//
// Card data is Stripe's documented test number only (STRIPE_TEST_CARDS of support/stripe.ts), typed into Stripe's own
// page as an owner would. Every page of the portal the journey visits passes axe once its title is in place; Stripe's
// hosted pages are Stripe's, not checked. The steps are tests in order on one browser context made in `beforeAll`.
import { randomBytes } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";
import type { components } from "@velexis/api-types/platform";
import { expectNoSeriousA11yViolations } from "../support/a11y";
import {
  addSessionCookies,
  callPlatformApi,
  createVerifiedAccount,
  expect,
  newAccountContext,
  PROJECT_TAGS,
  signInWithApi,
  test,
  type PortalAccount,
  type SessionTokens,
} from "../support/fixtures";
import { buildAccount, stack, withDatabase } from "../support/seed";
import { PORTAL_URL } from "../support/stack";
import { STRIPE_API_URL, STRIPE_TEST_CARDS, testCardExpiry } from "../support/stripe";
import { waitForOtaStatus, type Ota } from "../support/tenants";

type Schemas = components["schemas"];

/**
 * The budget of the one-time arrangement in `beforeAll` (a hook, not a step of the journey): an account through the
 * platform API and Mailpit (at most 15 s), and two calls to Stripe's API.
 */
const ARRANGE_BUDGET_MS = 90_000;

/**
 * How long a step waits for Stripe: its hosted pages to load and answer, its webhook to reach the platform, and the
 * OTA's set-up after it (about 2 s locally). Inside the step's default 30 s.
 */
const STRIPE_WAIT_MS = 25_000;

/** The monthly price of the journey's plan, in EUR: the Stripe price and the plan row say the same. */
const MONTHLY_PRICE = { amount: "19.00", minorUnits: 1900 } as const;

/** The portal's title of a page (`%s · Velexis`). */
const portalTitle = (title: string): string => `${title} · Velexis`;

/** Waits until `target` has the title of its page, then fails on any serious or critical axe violation. */
async function expectAccessible(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(portalTitle(title));
  await expectNoSeriousA11yViolations(target);
}

/** The Stripe test-mode secret key of the harness: required with E2E_STRIPE=1 (support/stack.ts checks its mode). */
function stripeSecretKey(): string {
  const key = stack().settings.STRIPE_SECRET_KEY;
  if (key === undefined || !/^sk_test_[A-Za-z0-9_]+$/.test(key)) {
    throw new Error(
      "portal-checkout.e2e.ts needs STRIPE_SECRET_KEY, a test-mode key (sk_test_…), with E2E_STRIPE=1",
    );
  }
  return key;
}

/**
 * POSTs `fields` (form-encoded, as Stripe's API takes them) to `path` of Stripe's API with the test key, and answers the
 * `id` of what Stripe created. A refusal throws with the status alone, never the key or the body.
 */
async function createInStripe(path: string, fields: Readonly<Record<string, string>>): Promise<string> {
  const response = await fetch(`${STRIPE_API_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeSecretKey()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Stripe answered ${response.status} to POST ${path}`);
  }
  const { id } = (await response.json()) as { id?: unknown };
  if (typeof id !== "string") {
    throw new Error(`Stripe's answer to POST ${path} has no id`);
  }
  return id;
}

/** The journey's plan: its code and name, and the Stripe product and monthly price it is linked to. */
interface PaidPlan {
  readonly code: string;
  readonly name: string;
  readonly productId: string;
  readonly priceId: string;
}

/**
 * A Stripe product with a monthly price of MONTHLY_PRICE in the test account, and a public plan linked to them (no free
 * trial, EUR), written as velexis_migrator (see the file header).
 */
async function createPaidPlan(): Promise<PaidPlan> {
  const suffix = randomBytes(4).toString("hex");
  const name = `E2E Paid ${suffix}`;
  const productId = await createInStripe("/v1/products", {
    name,
    "metadata[velexis_e2e]": "portal-checkout",
  });
  const priceId = await createInStripe("/v1/prices", {
    product: productId,
    currency: "eur",
    unit_amount: String(MONTHLY_PRICE.minorUnits),
    "recurring[interval]": "month",
  });
  const code = `e2epaid_${suffix}`;
  await withDatabase("migrator", async (client) => {
    await client.query(
      `INSERT INTO platform.plans (code, name, description, currency, monthly_price, per_booking_fee,
                                   included_bookings, limits, features, is_public, is_active, sort_order, trial_days,
                                   settlement_fee_bps, stripe_product_id, stripe_price_id_month)
       VALUES ($1, $2, 'A paid plan for the portal Checkout journey (PFE-027).', 'EUR', $3, 0, 0,
               '{"staffSeats":5,"apiKeys":10,"customDomains":0,"liveMode":false}'::jsonb, '{}'::jsonb, true, true,
               92, 0, 0, $4, $5)`,
      [code, name, MONTHLY_PRICE.amount, productId, priceId],
    );
  });
  return { code, name, productId, priceId };
}

/**
 * Pays on Stripe's hosted Checkout page `target` with the test card `number` (STRIPE_TEST_CARDS only): opens the card
 * option when Stripe lists several payment methods, types the card, an expiry three years ahead, the security code
 * `123` and the holder's name (the e-mail address is the customer's, which the platform gave Stripe), and subscribes.
 */
async function payOnStripeCheckout(target: Page, number: string, holder: string): Promise<void> {
  if (!(Object.values(STRIPE_TEST_CARDS) as string[]).includes(number)) {
    throw new TypeError("payOnStripeCheckout types Stripe's documented test cards only (STRIPE_TEST_CARDS)");
  }
  const cardNumber = target.locator("#cardNumber");
  const cardOption = target.getByTestId("card-accordion-item-button");
  await expect(cardNumber.or(cardOption)).toBeVisible({ timeout: STRIPE_WAIT_MS });
  if (!(await cardNumber.isVisible())) {
    await cardOption.click();
  }
  await cardNumber.pressSequentially(number);
  await target.locator("#cardExpiry").pressSequentially(testCardExpiry());
  await target.locator("#cardCvc").pressSequentially("123");
  await target.locator("#billingName").fill(holder);
  const postalCode = target.locator("#billingPostalCode");
  if (await postalCode.isVisible()) {
    await postalCode.fill("28001");
  }
  await target.getByTestId("hosted-payment-submit-button").click();
}

test.describe(
  "the portal's Stripe Checkout and Customer Portal journey",
  { tag: PROJECT_TAGS.stripe },
  () => {
    test.describe.configure({ mode: "serial" });

    let owner: PortalAccount;
    let session: SessionTokens;
    let plan: PaidPlan;
    let context: BrowserContext;
    let page: Page;
    /** The OTA the wizard created: its id and key. */
    let ota: Pick<Ota, "id" | "key">;
    const otaName = `Checkout Travel ${randomBytes(3).toString("hex")}`;

    test.beforeAll(async ({ browser }) => {
      test.setTimeout(ARRANGE_BUDGET_MS);
      const { settings } = stack();
      if (!settings.E2E_STRIPE) {
        throw new Error(
          "portal-checkout.e2e.ts pays in Stripe's test mode: run it with E2E_STRIPE=1 (project portal-stripe)",
        );
      }
      if (!settings.E2E_WITH_OTA) {
        throw new Error(
          "portal-checkout.e2e.ts needs the OTA worker to set the paid OTA up: run it with E2E_WITH_OTA=1",
        );
      }
      stripeSecretKey();

      owner = await createVerifiedAccount(buildAccount({ fullName: "Chris Checkout" }));
      session = await signInWithApi(owner);
      const me = await callPlatformApi<Schemas["Account"]>({
        operation: "getMe",
        method: "GET",
        path: "/v1/me",
        endUserIp: owner.endUserIp,
        accessToken: session.accessToken,
      });
      if (!me.features.stripeBilling) {
        throw new Error(
          "portal-checkout.e2e.ts needs Stripe Billing on in the stack's platform processes (FEATURE_STRIPE_BILLING) and " +
            "Stripe's billing events forwarded to /webhooks/stripe/billing (tools/e2e/README.md, Tests of PFE-027)",
        );
      }
      plan = await createPaidPlan();

      context = await newAccountContext(browser, owner, PORTAL_URL);
      await addSessionCookies(context, "portal", session);
      page = await context.newPage();
    });

    test.afterAll(async () => {
      await context?.close();
    });

    test("the owner chooses the paid plan in the wizard and goes to Stripe Checkout [PFE-027 AC1]", async () => {
      const key = `e2ec${randomBytes(5).toString("hex")}`;
      await page.goto("/otas/new");
      await expectAccessible(page, "Create an OTA");
      await page.getByLabel("OTA name").fill(otaName);
      await page.getByLabel("OTA key").fill(key);
      await expect(page.getByRole("status").filter({ hasText: "This key is available." })).toBeVisible();
      await page.getByLabel("Country").selectOption("FR");
      await page.getByLabel("Default currency").selectOption("EUR");
      await page.getByRole("button", { name: "Continue" }).click();

      // The plan step from M5: monthly billing (the default), and the journey's plan, which has a monthly Stripe price.
      await expect(page.getByRole("heading", { level: 2, name: "Plan" })).toBeVisible();
      await expect(page.getByRole("switch", { name: "Annual billing" })).not.toBeChecked();
      const paid = page.getByRole("radio", { name: new RegExp(`^${plan.name}`) });
      await paid.check();
      await expectAccessible(page, "Create an OTA");
      await page.getByRole("button", { name: "Continue" }).click();

      await expect(page.getByRole("heading", { level: 2, name: "Review" })).toBeVisible();
      await expect(page.getByRole("main")).toContainText(plan.name);
      await expectAccessible(page, "Create an OTA");
      // PF-71 AC1: choosing a plan opens Stripe Checkout.
      await page.getByRole("button", { name: "Create OTA and continue to payment" }).click();
      await page.waitForURL((url) => url.hostname === "checkout.stripe.com", { timeout: STRIPE_WAIT_MS });

      // The OTA exists, in set-up until the payment is confirmed (an abandoned Checkout leaves it `provisioning`).
      const memberships = await callPlatformApi<Schemas["TenantList"]>({
        operation: "listTenants",
        method: "GET",
        path: "/v1/tenants",
        endUserIp: owner.endUserIp,
        accessToken: session.accessToken,
      });
      const created = memberships.data.find((candidate) => candidate.key === key);
      expect(created?.status).toBe("provisioning");
      ota = { id: created?.id ?? "", key };
    });

    test("the owner pays with the test card 4242 4242 4242 4242 and comes back to the portal [PFE-027 AC1]", async () => {
      await expect(page.getByText(plan.name).first()).toBeVisible({ timeout: STRIPE_WAIT_MS });
      await payOnStripeCheckout(page, STRIPE_TEST_CARDS.visa, owner.fullName);
      // Stripe's success URL is the OTA's set-up page (flows/subscription-billing.md §B step 3).
      await page.waitForURL((url) => url.origin === PORTAL_URL && url.pathname === `/otas/${ota.id}/setup`, {
        timeout: STRIPE_WAIT_MS,
      });
    });

    test("the OTA becomes active once Stripe's webhook confirmed the subscription [PFE-027 AC1]", async () => {
      // PF-71 AC1: the webhook, not the redirect, activates the subscription; the set-up then runs on the OTA worker.
      await expect(page.getByRole("heading", { name: "Your OTA is ready" })).toBeVisible({
        timeout: STRIPE_WAIT_MS,
      });
      await expectAccessible(page, "OTA set-up");
      const active = await waitForOtaStatus(
        { account: owner, accessToken: session.accessToken },
        ota.id,
        "active",
        {
          timeoutMs: 5_000,
        },
      );
      expect(active.planCode).toBe(plan.code);
      const subscription = await callPlatformApi<Schemas["Subscription"]>({
        operation: "getSubscription",
        method: "GET",
        path: `/v1/tenants/${encodeURIComponent(ota.id)}/subscription`,
        endUserIp: owner.endUserIp,
        accessToken: session.accessToken,
      });
      expect(subscription).toMatchObject({
        planCode: plan.code,
        billingProvider: "stripe",
        status: "active",
        billingInterval: "month",
      });
    });

    test("the billing page shows the Stripe subscription and opens the Customer Portal [PFE-027 AC1]", async () => {
      await page.goto(`/otas/${ota.id}/billing`);
      await expect(page.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible();
      await expect(page.getByRole("main")).toContainText(plan.name);
      await expectAccessible(page, "Billing");
      // PF-72 AC1: owners open a Stripe Customer Portal session (the portal redirects with 303 to Stripe).
      await page.getByRole("button", { name: "Manage in Stripe" }).click();
      await page.waitForURL((url) => url.hostname === "billing.stripe.com", { timeout: STRIPE_WAIT_MS });
      await expect(page.getByText(plan.name).first()).toBeVisible({ timeout: STRIPE_WAIT_MS });
    });
  },
);
