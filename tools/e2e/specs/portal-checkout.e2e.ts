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
// E2E_STRIPE_BILLING=1 (lead decision 5(l) of 2026-11-05, FIX-W43-SHARED: support/stack.ts turns Stripe Billing on in
// the stack's platform processes and forwards Stripe's billing events to the platform API's `/webhooks/stripe/billing`
// with `stripe listen`, whose signing secret the API verifies them with; the API's `getMe.features.stripeBilling` proves
// the first), and E2E_WITH_OTA=1 (the OTA worker sets the OTA up after the payment). The Customer Portal also needs its
// test-mode configuration saved once in the Stripe dashboard (a human step). The nightly `portal-stripe` step of
// .github/workflows/e2e.yml gives all of it but that configuration (tools/e2e/README.md, "Tests of PFE-027").
//
// Arranged in `beforeAll` through the public APIs (PADR-0017 item 5), as Velexis staff link a plan to Stripe
// (platform/docs/flows/subscription-billing.md §A): a Stripe product with a monthly price in the test account (Stripe's
// API with the test key, support/stripe.ts), then a platform admin of the journey's own (MFA, `admin:grant`) creates the
// public plan `e2epaid_<random>` with `adminCreatePlan` and links it to that product and price with `adminUpdatePlan`
// (`If-Match`; the API compares the price with the plan at Stripe and finds no difference). The plan has no free trial,
// so Checkout charges the card at once. The owner is a verified account signed in through the platform API. No
// velexis_migrator fixture. `afterAll` removes from Stripe's test account what the run made there, also after a failed
// step or arrangement, and nothing else (lead decision 7(c) of 2026-11-05, FIX-W44-PLATFORM): first what the owner's
// Checkout made, the subscription to the journey's price (cancelled) and the OTA's Stripe Customer (deleted), found by
// the price, the owner's e-mail address (new in the run) and the `metadata.velexis_tenant_id` of the owner's OTAs
// (`findCheckoutTestObjects`, `removeCheckoutTestObjects`), then the price and the product (archived,
// `archiveStripeTestObjects`). The stack's database, with the plan, goes with the stack.
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
  enableMfa,
  expect,
  newAccountContext,
  PROJECT_TAGS,
  signInToAdminWithApi,
  signInWithApi,
  test,
  type PortalAccount,
  type SessionTokens,
} from "../support/fixtures";
import { buildAccount, grantPlatformAdmin, stack } from "../support/seed";
import { PORTAL_URL } from "../support/stack";
import {
  archiveStripeTestObjects,
  createMonthlyTestPrice,
  createTestProduct,
  findCheckoutTestObjects,
  removeCheckoutTestObjects,
  STRIPE_TEST_CARDS,
  testCardExpiry,
} from "../support/stripe";
import { waitForOtaStatus, type Ota } from "../support/tenants";

type Schemas = components["schemas"];

/**
 * The budget of the one-time arrangement in `beforeAll` (a hook, not a step of the journey): two accounts through the
 * platform API and Mailpit (at most 15 s each), the platform CLI's `admin:grant`, the admin's sign-in, two calls to
 * Stripe's API, and `adminCreatePlan` and `adminUpdatePlan` (which reads the price from Stripe).
 */
const ARRANGE_BUDGET_MS = 120_000;

/**
 * The budget of `afterAll` (a hook): the owner's OTAs from the platform API, then six calls to Stripe's API for a run's
 * one subscription and one Customer (at most 15 s each): the subscriptions of the price, the owner's Customers,
 * cancelling the subscription, deleting the Customer, and archiving the price and the product.
 */
const CLEAN_UP_BUDGET_MS = 120_000;

/**
 * How long a step waits for Stripe: its hosted pages to load and answer, its webhook to reach the platform, and the
 * OTA's set-up after it (about 2 s locally). Inside the step's default 30 s.
 */
const STRIPE_WAIT_MS = 25_000;

/** The monthly price of the journey's plan, in EUR: the Stripe price and the plan say the same. */
const MONTHLY_PRICE = { amount: "19.00", minorUnits: 1900 } as const;

/** The `metadata[velexis_e2e]` of what the journey makes in Stripe's test account. */
const STRIPE_LABEL = "portal-checkout";

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
 * What the journey made in Stripe's test account, as soon as Stripe answered each, and the owner whose Checkout makes a
 * subscription and a Customer there once the OTA exists: `afterAll` removes all of it.
 */
const madeInStripe: {
  productId?: string;
  priceId?: string;
  checkoutBy?: { readonly account: PortalAccount; readonly accessToken: string };
} = {};

/**
 * The ids of the OTAs of the Checkout's owner, an account new in the run (`listTenants`): the OTA the wizard created,
 * also when a step failed before it knew the id.
 */
async function otaIdsOf(owner: {
  readonly account: PortalAccount;
  readonly accessToken: string;
}): Promise<string[]> {
  const memberships = await callPlatformApi<Schemas["TenantList"]>({
    operation: "listTenants",
    method: "GET",
    path: "/v1/tenants",
    endUserIp: owner.account.endUserIp,
    accessToken: owner.accessToken,
  });
  return memberships.data.map((membership) => membership.id);
}

/**
 * Removes from Stripe's test account what the run made there (see the file header): the Checkout's subscription and
 * Customer first, then the price and the product. Each part is tried even when the other fails; then one error names
 * every failure (the helpers name requests and Stripe's statuses only).
 */
async function removeFromStripe(): Promise<void> {
  const { productId, priceId, checkoutBy } = madeInStripe;
  if (productId === undefined && priceId === undefined) {
    // No price, so no Checkout either: nothing of the run is in Stripe.
    return;
  }
  const key = stripeSecretKey();
  const failures: string[] = [];
  const attempt = async (part: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      failures.push(`${part}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (priceId !== undefined && checkoutBy !== undefined) {
    await attempt("the Checkout's subscription and Customer", async () => {
      const made = await findCheckoutTestObjects(key, {
        priceId,
        email: checkoutBy.account.email,
        tenantIds: await otaIdsOf(checkoutBy),
      });
      await removeCheckoutTestObjects(key, made);
    });
  }
  await attempt("the price and the product", () =>
    archiveStripeTestObjects(key, {
      prices: priceId === undefined ? [] : [priceId],
      products: productId === undefined ? [] : [productId],
    }),
  );
  if (failures.length > 0) {
    throw new Error(`portal-checkout.e2e.ts left Stripe test objects behind:\n${failures.join("\n")}`);
  }
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
 * trial, EUR), created and linked through the platform admin API by a platform admin of the journey's own (see the file
 * header).
 */
async function createPaidPlan(): Promise<PaidPlan> {
  const key = stripeSecretKey();
  const suffix = randomBytes(4).toString("hex");
  const name = `E2E Paid ${suffix}`;
  // Prices are made in Stripe first (subscription-billing flow §A step 1).
  const productId = await createTestProduct(key, name, STRIPE_LABEL);
  madeInStripe.productId = productId;
  const priceId = await createMonthlyTestPrice(key, {
    productId,
    currency: "EUR",
    unitAmount: MONTHLY_PRICE.minorUnits,
    label: STRIPE_LABEL,
  });
  madeInStripe.priceId = priceId;

  const admin = await enableMfa(
    await createVerifiedAccount(buildAccount({ fullName: "Carla Checkout Admin" })),
  );
  await grantPlatformAdmin(admin.email);
  const { accessToken } = await signInToAdminWithApi(admin);
  const asAdmin = { endUserIp: admin.endUserIp, accessToken } as const;

  const code = `e2epaid_${suffix}`;
  const plan: Schemas["CreatePlanRequest"] = {
    code,
    name,
    description: "A paid plan for the portal Checkout journey (PFE-027).",
    currency: "EUR",
    monthlyPrice: { amount: MONTHLY_PRICE.amount, currency: "EUR" },
    limits: { staffSeats: 5, apiKeys: 10, customDomains: 0, liveMode: false },
    features: {},
    isPublic: true,
    trialDays: 0,
    settlementFeeBps: 0,
    sortOrder: 92,
  };
  const created = await callPlatformApi<Schemas["AdminPlan"]>({
    operation: "adminCreatePlan",
    method: "POST",
    path: "/v1/admin/plans",
    ...asAdmin,
    body: plan,
  });
  expect(created).toMatchObject({ code, isPublic: true, isActive: true, stripePriceIdMonth: null });

  // The admin links the plan to the product and its monthly price (PAD-012's form sends the same request).
  const link: Schemas["UpdatePlanRequest"] = { stripeProductId: productId, stripePriceIdMonth: priceId };
  const linked = await callPlatformApi<Schemas["AdminPlan"]>({
    operation: "adminUpdatePlan",
    method: "PATCH",
    path: `/v1/admin/plans/${encodeURIComponent(code)}`,
    ...asAdmin,
    headers: { "If-Match": `"${String(created.version)}"` },
    body: link,
  });
  // The API read the price from Stripe and found it as the plan says (amount, currency, interval, active); Checkout can
  // start for monthly billing, which needs Stripe Billing on in the stack's platform API.
  expect(linked).toMatchObject({
    code,
    stripeProductId: productId,
    stripePriceIdMonth: priceId,
    stripePriceIdYear: null,
    priceWarnings: [],
    checkoutAvailable: { month: true, year: false },
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
      if (!settings.E2E_STRIPE_BILLING) {
        throw new Error(
          "portal-checkout.e2e.ts needs Stripe Billing in the stack: run it with E2E_STRIPE_BILLING=1 (Stripe Billing on " +
            "and the billing forwarder to /webhooks/stripe/billing, tools/e2e/README.md, Tests of PFE-027)",
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
      madeInStripe.checkoutBy = { account: owner, accessToken: session.accessToken };
      const me = await callPlatformApi<Schemas["Account"]>({
        operation: "getMe",
        method: "GET",
        path: "/v1/me",
        endUserIp: owner.endUserIp,
        accessToken: session.accessToken,
      });
      if (!me.features.stripeBilling) {
        throw new Error(
          "portal-checkout.e2e.ts needs Stripe Billing on in the stack's platform processes (FEATURE_STRIPE_BILLING), " +
            "which E2E_STRIPE_BILLING=1 turns on (tools/e2e/README.md, Tests of PFE-027)",
        );
      }
      plan = await createPaidPlan();

      context = await newAccountContext(browser, owner, PORTAL_URL);
      await addSessionCookies(context, "portal", session);
      page = await context.newPage();
    });

    // Also after a failed step or arrangement: the Checkout's subscription and Customer, the price and the product.
    test.afterAll(async () => {
      test.setTimeout(CLEAN_UP_BUDGET_MS);
      await context?.close();
      await removeFromStripe();
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
