// Accessibility of every route of the platform admin (PAD-016 step 1; platform/admin/README.md §2 and §4, ADR-0014:
// WCAG 2.2 A and AA, checked with axe), project `platform-admin`:
//
//   the admin signs in through the browser (the password step and the code step) → every page route of the built
//   console, one by one, with the journey's own data on it: the dashboard, the OTAs and every tab of one OTA, its
//   provisioning job, the queues and one queue, the plans and one plan, the subscriptions and the OTA's subscription,
//   the invoices and the Stripe events, the Amadeus accounts and the office pool, the settlements and the OTA's draft
//   statement, the domains, the accounts and the owner's account, the platform admins, the audit log of the OTA → a page
//   that does not exist → the route handlers, which answer files and no page (the audit export and the statement's
//   lines as CSV, the health routes as JSON) → "Sign out" and the signed-out sign-in page
//
// "Every route" is the route list of the build the stack runs: `platform/admin/.next/app-path-routes-manifest.json`
// (`next build` writes it). The first step compares it with this journey's own list (ROUTES), and the last step checks
// that each was visited, so a route a later task adds fails here until the journey covers it. Every page passes
// `expectNoSeriousA11yViolations` (no serious or critical violation) once its title and the content the journey came
// for are in place, and answers `200` without a redirect; admin-headers.e2e.ts checks the headers of the same routes
// and admin-step-up.e2e.ts the dialogs of the actions.
//
// Arrangements in `beforeAll` (PADR-0017 item 5: the public APIs where an operation exists, support/seed.ts for the
// rest):
//   - through the platform API: the admin (an account with MFA that `admin:grant` makes a platform admin; it signs in
//     through the browser in the first step, its API session from `adminSignIn` and `adminVerifyMfa` arranges the
//     rest), the owner's active OTA (`newOwnerWithActiveOta` with MFA, set up by the OTA worker, so the journey needs
//     `E2E_WITH_OTA=1` and fails at once without it) and its verified payout account (the owner's `setPayoutAccount`
//     and the admin's `adminReviewPayoutAccount`), so the connections tab shows a payout account;
//   - support/seed.ts (`insertDraftSettlement`, as the platform API's own role): a draft statement of last month with
//     two lines, as the monthly run builds it from Stripe's balance transactions, which the stack cannot have.
//
// The steps are tests in order (`mode: "serial"`) on one browser context made in `beforeAll`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import type { components } from "@velexis/api-types/platform";
import { expectNoSeriousA11yViolations } from "../support/a11y";
import {
  callPlatformApi,
  createVerifiedAccount,
  enableMfa,
  expect,
  newAccountContext,
  signInToAdminWithApi,
  test,
  type MfaAccount,
} from "../support/fixtures";
import { newOwnerWithActiveOta, newTenantId, type OwnedOta } from "../support/ota";
import {
  buildAccount,
  grantPlatformAdmin,
  insertDraftSettlement,
  stack,
  type AdminApiSession,
} from "../support/seed";
import { PLATFORM_ADMIN_URL, REPO_ROOT } from "../support/stack";
import { TOTP_PERIOD_SECONDS, totpStep } from "../support/totp";

test.describe.configure({ mode: "serial" });

type Schemas = components["schemas"];

/** The route list of the platform admin build the stack runs (`next build` writes it). */
const ROUTES_MANIFEST = resolve(REPO_ROOT, "platform/admin/.next/app-path-routes-manifest.json");

/**
 * Every route of the platform admin, as the build's route list names it, and the step of this journey that visits it.
 * A route the build has and this list lacks (or the other way round) fails the first step.
 */
const ROUTES = Object.freeze({
  "/sign-in": "sign-in",
  "/sign-in/mfa": "sign-in",
  "/": "overview and OTAs",
  "/tenants": "overview and OTAs",
  "/tenants/[tenantId]": "overview and OTAs",
  "/provisioning-jobs": "jobs and queues",
  "/provisioning-jobs/[jobId]": "jobs and queues",
  "/queues": "jobs and queues",
  "/queues/[queue]": "jobs and queues",
  "/plans": "plans and billing",
  "/plans/[planCode]": "plans and billing",
  "/subscriptions": "plans and billing",
  "/subscriptions/[subscriptionId]": "plans and billing",
  "/invoices": "plans and billing",
  "/stripe-events": "plans and billing",
  "/amadeus/accounts": "Amadeus",
  "/amadeus/offices": "Amadeus",
  "/settlements": "payments",
  "/settlements/[settlementId]": "payments",
  "/domains": "payments",
  "/accounts": "people and audit",
  "/accounts/[accountId]": "people and audit",
  "/admins": "people and audit",
  "/audit": "people and audit",
  "/_not-found": "not found and files",
  "/audit/export.csv": "not found and files",
  "/settlements/[settlementId]/lines.csv": "not found and files",
  "/health/live": "not found and files",
  "/health/ready": "not found and files",
  "/sign-out": "sign-out",
} as const);
type AdminRoute = keyof typeof ROUTES;

/** The tabs of an OTA's page (`TENANT_TAB_LABELS`), each opened by its `?tab=` (none for the overview). */
const TENANT_TABS = Object.freeze([
  ["overview", "Overview"],
  ["members", "Members and invitations"],
  ["subscription", "Subscription and invoices"],
  ["connections", "Connections"],
  ["domains", "Domains"],
  ["jobs", "Provisioning jobs"],
  ["audit", "Audit"],
] as const);

/**
 * The budget of the one-time arrangement in `beforeAll` (a hook, not a step of the journey): two accounts through the
 * platform API and Mailpit (at most 15 s each), the admin's MFA, `admin:grant` and API sign-in, the OTA's set-up on
 * the OTA worker (about 2 s, at most 45 s per OTA, and up to three OTAs while admin-amadeus-pool.e2e.ts holds the test
 * pool), the payout account's two calls, the statement, and the wait for two unused TOTP steps (at most 60 s).
 */
const ARRANGE_BUDGET_MS = 240_000;

/** The admin's title of a page (`%s · Velexis admin`, src/app/layout.tsx). */
const adminTitle = (title: string): string => `${title} · Velexis admin`;

/** The first instant of the calendar month (UTC) `offset` months from the one of `now`. */
function monthStart(now: Date, offset: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
}

/** An id as the platform writes them: `<prefix>_` and a ULID. */
const platformId = (prefix: "stl" | "sln"): string => `${prefix}_${newTenantId().slice("ten_".length)}`;

/** A day in UTC (`yyyy-mm-dd`) `offset` days from today. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

let admin: MfaAccount;
let adminApi: AdminApiSession;
let owned: OwnedOta;
let ownerAccountId: string;
let subscriptionId: string;
let provisionJobId: string;
const settlementId = platformId("stl");
let context: BrowserContext;
let page: Page;
/** The routes the journey visited. */
const visited = new Set<AdminRoute>();

/**
 * Waits in the one-time arrangement until the TOTP step `step` has begun, so the admin's authenticator has the current
 * step and the next one unused (support/totp.ts `Authenticator`) and the browser's sign-in does not wait for the clock.
 */
async function waitForTotpStep(step: number): Promise<void> {
  const wait = step * TOTP_PERIOD_SECONDS * 1000 - Date.now();
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait + 50));
  }
}

/** Waits until `target` shows the admin's page `title`, then fails on any serious or critical axe violation. */
async function expectAccessible(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(adminTitle(title));
  await expectNoSeriousA11yViolations(target);
}

/**
 * Opens `path` (a page of `route`) as a new document: `200` without a redirect, its title, then `ready` (what the
 * journey came for) and axe.
 */
async function visit(
  route: AdminRoute,
  path: string,
  title: string,
  ready?: (target: Page) => Promise<void>,
): Promise<void> {
  const response = await page.goto(path);
  if (response === null) {
    throw new Error(`${path} gave no answer`);
  }
  expect(response.status(), path).toBe(200);
  expect(response.request().redirectedFrom(), path).toBeNull();
  await expect(page).toHaveTitle(adminTitle(title));
  await ready?.(page);
  await expectNoSeriousA11yViolations(page);
  visited.add(route);
}

/** The main region of the page. */
const main = (target: Page) => target.getByRole("main");

test.beforeAll(async ({ browser }) => {
  test.setTimeout(ARRANGE_BUDGET_MS);
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "admin-a11y.e2e.ts needs an active OTA: run it with E2E_WITH_OTA=1 (the Amadeus stub and the OTA worker)",
    );
  }
  admin = await enableMfa(await createVerifiedAccount(buildAccount({ fullName: "Alma Accessible Admin" })));
  await grantPlatformAdmin(admin.email);
  const adminSession = await signInToAdminWithApi(admin);
  const signInStep = totpStep(Date.now());
  adminApi = { endUserIp: admin.endUserIp, accessToken: adminSession.accessToken };

  owned = await newOwnerWithActiveOta("Aksel Accessible Owner", "aly", { mfa: true });
  const tenantPath = encodeURIComponent(owned.ota.id);
  // The owner's sign-in with a TOTP code is the step-up `setPayoutAccount` asks for (15 minutes).
  const payout = await callPlatformApi<Schemas["PayoutAccount"]>({
    operation: "setPayoutAccount",
    method: "PUT",
    path: `/v1/tenants/${tenantPath}/payout-account`,
    endUserIp: owned.owner.account.endUserIp,
    accessToken: owned.owner.accessToken,
    // The IBAN registry's example for Norway (the platform document's example), with its BIC.
    body: {
      accountHolderName: "Aksel Accessible AS",
      countryCode: "NO",
      currency: "EUR",
      scheme: "iban",
      iban: "NO93 8601 1117 947",
      bic: "DNBANOKK",
    } satisfies Schemas["SetPayoutAccountRequest"],
  });
  await callPlatformApi<Schemas["PayoutAccount"]>({
    operation: "adminReviewPayoutAccount",
    method: "POST",
    path: `/v1/admin/tenants/${tenantPath}/payout-account/review`,
    ...adminApi,
    headers: { "If-Match": `"${String(payout.version)}"` },
    body: { decision: "verified" } satisfies Schemas["ReviewPayoutAccountRequest"],
  });

  const subscription = await callPlatformApi<Schemas["Subscription"]>({
    operation: "getSubscription",
    method: "GET",
    path: `/v1/tenants/${tenantPath}/subscription`,
    endUserIp: owned.owner.account.endUserIp,
    accessToken: owned.owner.accessToken,
  });
  subscriptionId = subscription.id;
  const jobs = await callPlatformApi<Schemas["AdminProvisioningJobList"]>({
    operation: "adminListProvisioningJobs",
    method: "GET",
    path: `/v1/admin/provisioning-jobs?tenantId=${tenantPath}&kind=provision`,
    ...adminApi,
  });
  const provisionJob = jobs.data[0];
  if (provisionJob === undefined) {
    throw new Error(`adminListProvisioningJobs lists no set-up job of ${owned.ota.id}`);
  }
  provisionJobId = provisionJob.id;
  const accounts = await callPlatformApi<Schemas["AdminAccountList"]>({
    operation: "adminListAccounts",
    method: "GET",
    path: `/v1/admin/accounts?q=${encodeURIComponent(owned.owner.account.email)}`,
    ...adminApi,
  });
  const ownerAccount = accounts.data.find((account) => account.email === owned.owner.account.email);
  if (ownerAccount === undefined) {
    throw new Error("adminListAccounts does not find the owner's account by its e-mail address");
  }
  ownerAccountId = ownerAccount.id;

  // Last month's draft statement: two payments in EUR and the totals of the platform's formula
  // (settlement-formula.ts): payments 250.00 + 180.00 = 430.00; Stripe fees 3.88 + 2.77 = 6.65; the Velexis fee
  // 1.50 % of 430.00 = 6.45; net 430.00 − 6.65 − 6.45 = 416.90.
  const now = new Date();
  const periodStart = monthStart(now, -1);
  await insertDraftSettlement({
    id: settlementId,
    tenantId: owned.ota.id,
    currency: "EUR",
    periodStart,
    periodEnd: monthStart(now, 0),
    feeBps: 150,
    totals: {
      gross: "430.00",
      refunds: "0.00",
      disputes: "0.00",
      stripeFees: "6.65",
      velexisFees: "6.45",
      adjustments: "0.00",
      net: "416.90",
    },
    lines: [
      {
        id: platformId("sln"),
        lineType: "charge",
        amount: "250.00",
        stripeFee: "3.88",
        balanceTransactionId: `txn_e2e${settlementId.slice(-16).toLowerCase()}a`,
        paymentIntentId: `pi_e2e${settlementId.slice(-16).toLowerCase()}a`,
        description: "Booking payment (Oslo to Rome)",
        occurredAt: new Date(periodStart.getTime() + 3 * 86_400_000),
      },
      {
        id: platformId("sln"),
        lineType: "charge",
        amount: "180.00",
        stripeFee: "2.77",
        balanceTransactionId: `txn_e2e${settlementId.slice(-16).toLowerCase()}b`,
        paymentIntentId: `pi_e2e${settlementId.slice(-16).toLowerCase()}b`,
        description: "Booking payment (Oslo to Lisbon)",
        occurredAt: new Date(periodStart.getTime() + 9 * 86_400_000),
      },
    ],
  });

  context = await newAccountContext(browser, admin, PLATFORM_ADMIN_URL);
  page = await context.newPage();
  await waitForTotpStep(signInStep + 2);
});

test.afterAll(async () => {
  await context?.close();
});

test("the journey's route list is the built platform admin's [PAD-016 step 1]", () => {
  const manifest = JSON.parse(readFileSync(ROUTES_MANIFEST, "utf8")) as Record<string, string>;
  const built = [...new Set(Object.values(manifest))].sort((a, b) => a.localeCompare(b));
  expect(built).toEqual(Object.keys(ROUTES).sort((a, b) => a.localeCompare(b)));
});

test("the sign-in pages pass axe: the password step, the code step and its recovery code form [PAD-016 step 1]", async () => {
  await visit("/sign-in", "/sign-in", "Sign in", async (target) => {
    await expect(target.getByLabel("E-mail address")).toBeVisible();
  });
  await page.getByLabel("E-mail address").fill(admin.email);
  await page.getByLabel("Password").fill(admin.password);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => url.pathname === "/sign-in/mfa");
  await expect(page.getByLabel("Authentication code")).toBeVisible();
  await expectAccessible(page, "Two-factor authentication");
  visited.add("/sign-in/mfa");

  // The recovery code form of the same step.
  await page.getByRole("button", { name: "Use a recovery code instead" }).click();
  await expect(page.getByLabel("Recovery code")).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.getByRole("button", { name: "Use your authenticator app instead" }).click();
  await page.getByLabel("Authentication code").fill(await admin.authenticator.nextCode());
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/");
  await expectAccessible(page, "Dashboard");
});

/** Opens one tab of the journey's OTA (`?tab=`, none for the overview) as a new document and checks it with axe. */
async function visitTenantTab(tab: (typeof TENANT_TABS)[number][0], label: string): Promise<void> {
  const query = tab === "overview" ? "" : `?tab=${tab}`;
  await visit("/tenants/[tenantId]", `/tenants/${owned.ota.id}${query}`, "Tenant", async (target) => {
    await expect(target.getByRole("tab", { name: label, selected: true })).toBeVisible();
    if (tab === "connections") {
      // The payout account loads when the tab is shown: masked, with its review status.
      await expect(target.getByRole("button", { name: "Reveal bank details" })).toBeVisible();
    }
  });
}

// The OTA's seven tabs are split over two steps, so no step comes near Playwright's 30 seconds on a slower runner.
test("the dashboard, the OTAs and the OTA's overview, members and subscription tabs pass axe [PAD-016 step 1]", async () => {
  await visit("/", "/", "Dashboard", async (target) => {
    await expect(main(target).getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  });
  await visit("/tenants", `/tenants?q=${encodeURIComponent(owned.ota.key)}`, "Tenants", async (target) => {
    await expect(main(target).getByRole("link", { name: owned.ota.name })).toBeVisible();
  });
  for (const [tab, label] of TENANT_TABS.slice(0, 3)) {
    await visitTenantTab(tab, label);
  }
});

test("the OTA's connections, domains, provisioning jobs and audit tabs pass axe [PAD-016 step 1]", async () => {
  for (const [tab, label] of TENANT_TABS.slice(3)) {
    await visitTenantTab(tab, label);
  }
});

test("the provisioning jobs, one job, the queues and one queue pass axe [PAD-016 step 1]", async () => {
  await visit(
    "/provisioning-jobs",
    `/provisioning-jobs?tenantId=${encodeURIComponent(owned.ota.id)}`,
    "Provisioning jobs",
    async (target) => {
      await expect(main(target).locator(`a[href="/provisioning-jobs/${provisionJobId}"]`)).toBeVisible();
    },
  );
  await visit("/provisioning-jobs/[jobId]", `/provisioning-jobs/${provisionJobId}`, "Provisioning job");
  await visit("/queues", "/queues", "Queues", async (target) => {
    await expect(main(target).locator('a[href^="/queues/"]').first()).toBeVisible();
  });
  const queue = await main(page).locator('a[href^="/queues/"]').first().getAttribute("href");
  if (queue === null) {
    throw new Error("/queues links no queue");
  }
  await visit("/queues/[queue]", queue, "Queues");
});

test("the plans, one plan, the subscriptions, the OTA's subscription, the invoices and the Stripe events pass axe [PAD-016 step 1]", async () => {
  await visit("/plans", "/plans", "Plans", async (target) => {
    await expect(main(target).locator('a[href^="/plans/"]').first()).toBeVisible();
  });
  const plan = await main(page).locator('a[href^="/plans/"]').first().getAttribute("href");
  if (plan === null) {
    throw new Error("/plans links no plan");
  }
  await visit("/plans/[planCode]", plan, "Plan", async (target) => {
    await expect(target.getByRole("button", { name: "Save the links" })).toBeVisible();
  });
  await visit(
    "/subscriptions",
    `/subscriptions?planCode=${encodeURIComponent(owned.ota.planCode)}`,
    "Subscriptions",
  );
  await visit(
    "/subscriptions/[subscriptionId]",
    `/subscriptions/${subscriptionId}`,
    "Subscription",
    async (target) => {
      await expect(target.getByRole("button", { name: "Save changes…" })).toBeVisible();
    },
  );
  await visit("/invoices", "/invoices", "Invoices");
  await visit("/stripe-events", "/stripe-events", "Stripe events");
});

test("the Amadeus accounts and the office pool pass axe [PAD-016 step 1]", async () => {
  await visit("/amadeus/accounts", "/amadeus/accounts", "Amadeus accounts", async (target) => {
    await expect(target.getByRole("region", { name: "Test environment" })).toBeVisible();
  });
  await visit(
    "/amadeus/offices",
    `/amadeus/offices?environment=test&status=assigned`,
    "Office pool",
    async (target) => {
      await expect(
        main(target).getByRole("row").filter({ hasText: owned.connection.officeId }),
      ).toBeVisible();
    },
  );
});

test("the settlements, the OTA's draft statement and the domains pass axe [PAD-016 step 1]", async () => {
  await visit(
    "/settlements",
    `/settlements?tenantId=${encodeURIComponent(owned.ota.id)}`,
    "Settlements",
    async (target) => {
      await expect(main(target).locator(`a[href="/settlements/${settlementId}"]`)).toBeVisible();
    },
  );
  await visit("/settlements/[settlementId]", `/settlements/${settlementId}`, "Statement", async (target) => {
    await expect(target.getByRole("form", { name: "Add an adjustment" })).toBeVisible();
    await expect(target.getByRole("region", { name: "Lines", exact: true }).getByRole("row")).toHaveCount(3);
  });
  await visit("/domains", "/domains", "Domains");
});

test("the accounts, the owner's account, the platform admins and the OTA's audit log pass axe [PAD-016 step 1]", async () => {
  await visit(
    "/accounts",
    `/accounts?q=${encodeURIComponent(owned.owner.account.email)}`,
    "Accounts",
    async (target) => {
      await expect(main(target).locator(`a[href="/accounts/${ownerAccountId}"]`)).toBeVisible();
    },
  );
  await visit("/accounts/[accountId]", `/accounts/${ownerAccountId}`, "Account", async (target) => {
    await expect(target.getByRole("button", { name: "Reset two-factor" })).toBeVisible();
  });
  await visit("/admins", "/admins", "Platform admins", async (target) => {
    await expect(main(target).getByRole("row").filter({ hasText: admin.email })).toContainText("You");
  });
  await visit(
    "/audit",
    `/audit?${new URLSearchParams({ tenantId: owned.ota.id, from: utcDay(-1), to: utcDay(1) }).toString()}`,
    "Audit log",
    async (target) => {
      await expect(main(target).getByRole("link", { name: "Download CSV" })).toBeVisible();
    },
  );
});

test("a page that does not exist passes axe, and the route handlers answer files, not pages [PAD-016 step 1]", async () => {
  const missing = await page.goto("/pad016-no-such-page");
  if (missing === null) {
    throw new Error("the missing page gave no answer");
  }
  expect(missing.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "This page could not be found." })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  visited.add("/_not-found");

  // The two CSV downloads (with the admin's session) and the health routes: no page for axe to judge.
  const files: readonly (readonly [AdminRoute, string, RegExp])[] = [
    [
      "/audit/export.csv",
      `/audit/export.csv?${new URLSearchParams({ tenantId: owned.ota.id, from: utcDay(-1), to: utcDay(1) }).toString()}`,
      /^text\/csv/,
    ],
    ["/settlements/[settlementId]/lines.csv", `/settlements/${settlementId}/lines.csv`, /^text\/csv/],
    ["/health/live", "/health/live", /^application\/json/],
    ["/health/ready", "/health/ready", /^application\/json/],
  ];
  for (const [route, path, type] of files) {
    const answer = await context.request.get(path, { maxRedirects: 0 });
    expect(answer.status(), path).toBe(200);
    expect(answer.headers()["content-type"] ?? "", path).toMatch(type);
    visited.add(route);
  }
});

test("Sign out ends the session on the signed-out sign-in page, which passes axe [PAD-016 step 1]", async () => {
  await page.goto("/");
  await expectAccessible(page, "Dashboard");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("signedOut") === "1");
  await expect(page.getByText("You are signed out.")).toBeVisible();
  await expectAccessible(page, "Sign in");
  const cookies = (await context.cookies(PLATFORM_ADMIN_URL)).map((cookie) => cookie.name);
  expect(cookies.filter((name) => name.startsWith("__Host-vxa_"))).toEqual([]);
  visited.add("/sign-out");
});

test("every route of the built platform admin was visited [PAD-016 step 1]", () => {
  expect([...visited].sort((a, b) => a.localeCompare(b))).toEqual(
    Object.keys(ROUTES).sort((a, b) => a.localeCompare(b)),
  );
});
