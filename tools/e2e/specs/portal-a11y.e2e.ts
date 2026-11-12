// Accessibility of every route of the portal (PFE-028 step 1; platform/frontend/README.md §2, ADR-0014: WCAG 2.2 A and
// AA, checked with axe), project `portal`, as an owner:
//
//   signed out: the public pages, a page that does not exist, the sign-up form (also with its error summary) and its
//   check-your-e-mail page, the password reset request (also its confirmation), and the pages of e-mail links opened
//   without their link (verify, reset, invitation), with the unverified account's own state of the verification page →
//   the owner signs in through the browser (the password step, the code step and its recovery code form) → the reset
//   link and an invitation sent to another address → the dashboard, the create-OTA wizard (also with its error summary),
//   the console picker, the profile and the security page → every page of the owner's OTA with the journey's own data
//   on it (the set-up page with the test keys revealed once, a new API key shown once, the domains, the team, Amadeus,
//   payments with Stripe Connect's outcome, the payout account, an approved statement and its lines, billing, settings)
//   → the go-live page before the switch, its confirmation and the live view, the API keys' live tab → the hand-off page
//   of "Open console" → a co-owner of the now live OTA without MFA on the MFA enrolment page (PFE-030) in each of its
//   states → "Sign out" and the signed-out sign-in page
//
// "Every route" is the route list of the build the stack runs: `platform/frontend/.next/app-path-routes-manifest.json`
// (`next build` writes it). The first step compares it with this journey's own list (ROUTES), and the last step checks
// that each was visited, so a route a later task adds fails here until the journey covers it. Every page passes
// `expectNoSeriousA11yViolations` (no serious or critical violation) once its title and the content the journey came
// for are in place; the dialogs and the states the journey opens on the way pass it too. The route handlers answer
// redirects, files and JSON, no page for axe to judge, except the hand-off page of "Open console", whose form the
// journey keeps from leaving: its navigation to the OTA admin's `/sso` is cancelled in this browser context only
// (`ERR_ABORTED`), so the browser stays on the hand-off page and its portal token is never redeemed (console-sso.e2e.ts
// follows the real hand-off). portal-headers.e2e.ts checks the headers of the same routes.
//
// Arrangements in `beforeAll` (PADR-0017 item 5: the public APIs where an operation exists, support/seed.ts and
// support/ota.ts for the rest):
//   - through the platform API: the owner's active OTA (`newOwnerWithActiveOta` with MFA, set up by the OTA worker, so
//     the journey needs `E2E_WITH_OTA=1` and fails at once without it); its payout account (the owner's
//     `setPayoutAccount`, the step-up of the owner's TOTP sign-in), which a platform admin of the journey's own
//     (`newHarnessAdmin` of support/ota.ts: MFA, `admin:grant`) verifies (`adminReviewPayoutAccount`) before approving
//     the statement below
//     (`adminApproveSettlement`, with the step-up of its TOTP sign-in), since an OTA's members never see a draft and a
//     statement is approved only for a verified payout account; a co-owner, a verified account without MFA that the
//     owner invites as owner and that accepts with the token of its invitation e-mail; a pending invitation to an address
//     of the journey's own; and an unverified account (`signUp`, `signIn`) for the verification page's own state;
//   - support/seed.ts (`insertDraftSettlement`, as the platform API's own role): last month's draft statement with two
//     lines, as the monthly run builds it from Stripe's balance transactions, which the stack cannot have;
//   - support/ota.ts (`meetLivePreconditions`, as OFE-022's, PFE-027's and PFE-030's journeys): what going live needs
//     and the stack cannot reach for real: a plan with live mode and the OTA's manual subscription made `active`,
//     through the platform admin API as the same platform admin; the OTA's own live Amadeus connection and the Stripe
//     Connect payment connection, which no API reaches, as velexis_migrator fixtures. The switch itself is the owner's,
//     in the browser.
// The owner has MFA; the co-owner meets the enrolment gate on purpose, as the page's subject, and enrols there.
//
// The steps are tests in order (`mode: "serial"`) on one browser context for the owner made in `beforeAll`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import type { components } from "@velexis/api-types/platform";
import { expectNoSeriousA11yViolations } from "../support/a11y";
import {
  addSessionCookies,
  callPlatformApi,
  createVerifiedAccount,
  E2E_TERMS_VERSION,
  expect,
  newAccountContext,
  signInWithApi,
  test,
  uniqueTestIp,
  type PortalAccount,
} from "../support/fixtures";
import { uniqueEmail, waitForLink } from "../support/mailpit";
import {
  meetLivePreconditions,
  newHarnessAdmin,
  newOwnerWithActiveOta,
  newTenantId,
  uniqueLiveOfficeId,
  type OwnedOta,
} from "../support/ota";
import { buildAccount, insertDraftSettlement, stack, type AdminApiSession } from "../support/seed";
import { OTA_ADMIN_URL, PORTAL_URL, REPO_ROOT } from "../support/stack";
import { Authenticator, TOTP_PERIOD_SECONDS, totpStep } from "../support/totp";

test.describe.configure({ mode: "serial" });

type Schemas = components["schemas"];

/** The route list of the portal build the stack runs (`next build` writes it). */
const ROUTES_MANIFEST = resolve(REPO_ROOT, "platform/frontend/.next/app-path-routes-manifest.json");

/**
 * Every route of the portal, as the build's route list names it, and the step of this journey that visits it. A route
 * the build has and this list lacks (or the other way round) fails the first step.
 */
const ROUTES = Object.freeze({
  "/": "public pages",
  "/pricing": "public pages",
  "/legal/terms": "public pages",
  "/legal/privacy": "public pages",
  "/_not-found": "public pages",
  "/sign-up": "signed out",
  "/sign-up/check-email": "signed out",
  "/forgot-password": "signed out",
  "/verify-pending": "signed out",
  "/reset-password": "signed out",
  "/invitations/accept": "signed out",
  "/sign-in": "sign-in",
  "/sign-in/mfa": "sign-in",
  "/verify-email": "e-mail links",
  "/dashboard": "account pages",
  "/otas/new": "account pages",
  "/console": "account pages",
  "/account": "account pages",
  "/account/security": "account pages",
  "/otas/[tenantId]": "OTA pages",
  "/otas/[tenantId]/setup": "OTA pages",
  "/otas/[tenantId]/api-keys": "OTA pages",
  "/otas/[tenantId]/domains": "OTA pages",
  "/otas/[tenantId]/team": "OTA pages",
  "/otas/[tenantId]/amadeus": "OTA connections and money",
  "/otas/[tenantId]/payments": "OTA connections and money",
  "/connect/stripe/callback": "OTA connections and money",
  "/otas/[tenantId]/payments/payout-account": "OTA connections and money",
  "/otas/[tenantId]/payments/settlements": "OTA connections and money",
  "/otas/[tenantId]/payments/settlements/[settlementId]": "OTA connections and money",
  "/otas/[tenantId]/payments/settlements/[settlementId]/lines.csv": "OTA connections and money",
  "/otas/[tenantId]/billing": "OTA connections and money",
  "/otas/[tenantId]/settings": "OTA connections and money",
  "/otas/[tenantId]/go-live": "go-live",
  "/otas/[tenantId]/console/launch": "Open console",
  "/mfa-enrolment": "MFA enrolment",
  "/health/live": "health",
  "/health/ready": "health",
  "/sign-out": "sign-out",
} as const);
type PortalRoute = keyof typeof ROUTES;

/**
 * The budget of the one-time arrangement in `beforeAll` (a hook, not a step of the journey): five accounts through the
 * platform API and Mailpit (up to 15 s each for the verification and invitation e-mails), the owner's and the admin's
 * MFA, `admin:grant`, the OTA's set-up on the OTA worker (about 2 s, at most 45 s per OTA, and up to three OTAs while
 * admin-amadeus-pool.e2e.ts holds the test pool), the payout account, the statement and its approval, the go-live
 * preconditions (the admin API and the fixtures), and the wait for two unused TOTP steps of the owner (at most 60 s).
 */
const ARRANGE_BUDGET_MS = 300_000;

/** The owner's name: the inviter in the invitation e-mails' subject. */
const OWNER_NAME = "Petra Accessible";

/** The portal's title of a page (`%s · Velexis`; the landing page has the bare default). */
const portalTitle = (title: string): string => `${title} · Velexis`;

/** The first instant of the calendar month (UTC) `offset` months from the one of `now`. */
function monthStart(now: Date, offset: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
}

/** An id as the platform writes them: `<prefix>_` and a ULID. */
const platformId = (prefix: "stl" | "sln"): string => `${prefix}_${newTenantId().slice("ten_".length)}`;

let owned: OwnedOta;
let coOwner: PortalAccount;
/** The address of the pending invitation, which has no account. */
const invitedAddress = uniqueEmail("pfe028-invited");
const settlementId = platformId("stl");
let context: BrowserContext;
let page: Page;
/** The routes the journey visited. */
const visited = new Set<PortalRoute>();

/** `/otas/<tenantId><path>`. */
const otaPath = (path = ""): string => `/otas/${owned.ota.id}${path}`;

/** The main region of the page. */
const main = (target: Page) => target.getByRole("main");

/** Waits until `target` shows the portal's page `title`, then fails on any serious or critical axe violation. */
async function expectAccessible(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(title === "" ? "Velexis" : portalTitle(title));
  await expectNoSeriousA11yViolations(target);
}

/**
 * Opens `path` (a page of `route`) as a new document: `status` (200) without a redirect, its title, then `ready` (what
 * the journey came for) and axe.
 */
async function visit(
  route: PortalRoute,
  path: string,
  title: string,
  ready?: (target: Page) => Promise<void>,
  status = 200,
): Promise<void> {
  const response = await page.goto(path);
  if (response === null) {
    throw new Error(`${path} gave no answer`);
  }
  expect(response.status(), path).toBe(status);
  expect(response.request().redirectedFrom(), path).toBeNull();
  await expect(page).toHaveTitle(title === "" ? "Velexis" : portalTitle(title));
  await ready?.(page);
  await expectNoSeriousA11yViolations(page);
  visited.add(route);
}

/** Expects the level-1 heading `name` in the page's main region. */
async function expectHeading(target: Page, name: string): Promise<void> {
  await expect(main(target).getByRole("heading", { level: 1, name })).toBeVisible();
}

/** The error summary of a refused form (`FormErrorSummary`): it takes the focus. */
async function expectErrorSummary(target: Page): Promise<void> {
  const summary = main(target).getByRole("alert").filter({ hasText: "There is a problem" });
  await expect(summary).toBeVisible();
  await expect(summary).toBeFocused();
}

/** Waits in the one-time arrangement until the TOTP step `step` has begun (see admin-a11y.e2e.ts). */
async function waitForTotpStep(step: number): Promise<void> {
  const wait = step * TOTP_PERIOD_SECONDS * 1000 - Date.now();
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait + 50));
  }
}

/** A verified account (no MFA) that the owner invites as `role` and that accepts with its invitation e-mail's token. */
async function invitedMember(role: Schemas["TenantRole"], fullName: string): Promise<PortalAccount> {
  const account = await createVerifiedAccount(buildAccount({ fullName }));
  await callPlatformApi<Schemas["Invitation"]>({
    operation: "createInvitation",
    method: "POST",
    path: `/v1/tenants/${encodeURIComponent(owned.ota.id)}/invitations`,
    endUserIp: owned.owner.account.endUserIp,
    accessToken: owned.owner.accessToken,
    body: { email: account.email, role } satisfies Schemas["CreateInvitationRequest"],
  });
  const link = await waitForLink({
    to: account.email,
    subject: `${OWNER_NAME} invited you to ${owned.ota.name} on Velexis`,
    path: "/invitations/accept",
    origin: PORTAL_URL,
  });
  const token = link.searchParams.get("token");
  if (token === null) {
    throw new Error(`the invitation e-mail to ${account.email} has a link without a token`);
  }
  await callPlatformApi<Schemas["InvitationAccepted"]>({
    operation: "acceptInvitation",
    method: "POST",
    path: "/v1/invitations/accept",
    endUserIp: account.endUserIp,
    accessToken: (await signInWithApi(account)).accessToken,
    body: { token } satisfies Schemas["InvitationTokenRequest"],
  });
  return account;
}

/**
 * Last month's draft statement of the OTA with two lines, approved by `adminApi`, a platform admin of the journey's own,
 * who first verifies the OTA's payout account (version `payoutVersion`): a statement is approved only for a verified
 * one.
 */
async function approvedStatement(payoutVersion: number, adminApi: AdminApiSession): Promise<void> {
  // Two payments in EUR and the totals of the platform's formula (settlement-formula.ts): payments 250.00 + 180.00 =
  // 430.00; Stripe fees 3.88 + 2.77 = 6.65; the Velexis fee 1.50 % of 430.00 = 6.45; net 430.00 − 6.65 − 6.45 = 416.90.
  const now = new Date();
  const periodStart = monthStart(now, -1);
  const suffix = settlementId.slice(-16).toLowerCase();
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
        balanceTransactionId: `txn_e2e${suffix}a`,
        paymentIntentId: `pi_e2e${suffix}a`,
        description: "Booking payment (Oslo to Rome)",
        occurredAt: new Date(periodStart.getTime() + 3 * 86_400_000),
      },
      {
        id: platformId("sln"),
        lineType: "charge",
        amount: "180.00",
        stripeFee: "2.77",
        balanceTransactionId: `txn_e2e${suffix}b`,
        paymentIntentId: `pi_e2e${suffix}b`,
        description: "Booking payment (Oslo to Lisbon)",
        occurredAt: new Date(periodStart.getTime() + 9 * 86_400_000),
      },
    ],
  });
  // The admin's sign-in with a TOTP code (`newHarnessAdmin`) is the step-up `adminApproveSettlement` asks for (15
  // minutes).
  await callPlatformApi<Schemas["PayoutAccount"]>({
    operation: "adminReviewPayoutAccount",
    method: "POST",
    path: `/v1/admin/tenants/${encodeURIComponent(owned.ota.id)}/payout-account/review`,
    ...adminApi,
    headers: { "If-Match": `"${String(payoutVersion)}"` },
    body: { decision: "verified" } satisfies Schemas["ReviewPayoutAccountRequest"],
  });
  const path = `/v1/admin/settlements/${encodeURIComponent(settlementId)}`;
  const draft = await callPlatformApi<{ readonly version: number }>({
    operation: "adminGetSettlement",
    method: "GET",
    path,
    ...adminApi,
  });
  await callPlatformApi({
    operation: "adminApproveSettlement",
    method: "POST",
    path: `${path}/approve`,
    ...adminApi,
    headers: { "If-Match": `"${String(draft.version)}"` },
  });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(ARRANGE_BUDGET_MS);
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "portal-a11y.e2e.ts needs an active OTA: run it with E2E_WITH_OTA=1 (the Amadeus stub and the OTA worker)",
    );
  }
  owned = await newOwnerWithActiveOta(OWNER_NAME, "pfeaxe", { mfa: true });
  const lastCodeStep = totpStep(Date.now());
  const tenantPath = encodeURIComponent(owned.ota.id);
  // The owner's sign-in with a TOTP code is the step-up `setPayoutAccount` and an owner's invitation ask for.
  const payout = await callPlatformApi<Schemas["PayoutAccount"]>({
    operation: "setPayoutAccount",
    method: "PUT",
    path: `/v1/tenants/${tenantPath}/payout-account`,
    endUserIp: owned.owner.account.endUserIp,
    accessToken: owned.owner.accessToken,
    // The IBAN registry's example for Norway (the platform document's example), with its BIC.
    body: {
      accountHolderName: "Petra Accessible AS",
      countryCode: "NO",
      currency: "EUR",
      scheme: "iban",
      iban: "NO93 8601 1117 947",
      bic: "DNBANOKK",
    } satisfies Schemas["SetPayoutAccountRequest"],
  });
  coOwner = await invitedMember("owner", "Otto Co-owner");
  // An invitation waiting for an address that has no account yet: the owner opens its link in a later step.
  await callPlatformApi<Schemas["Invitation"]>({
    operation: "createInvitation",
    method: "POST",
    path: `/v1/tenants/${tenantPath}/invitations`,
    endUserIp: owned.owner.account.endUserIp,
    accessToken: owned.owner.accessToken,
    body: { email: invitedAddress, role: "viewer" } satisfies Schemas["CreateInvitationRequest"],
  });
  const admin = await newHarnessAdmin("Ada Approving Admin");
  await approvedStatement(payout.version, admin);
  // What going live needs and the stack cannot reach (the plan and the subscription through the admin API, the rest as
  // fixtures); the switch is the owner's, in the browser.
  await meetLivePreconditions(owned, uniqueLiveOfficeId(), admin);

  context = await newAccountContext(browser, owned.owner.account, PORTAL_URL);
  page = await context.newPage();
  await waitForTotpStep(lastCodeStep + 2);
});

test.afterAll(async () => {
  await context?.close();
});

test("the journey's route list is the built portal's [PFE-028 AC1, AC2]", () => {
  const manifest = JSON.parse(readFileSync(ROUTES_MANIFEST, "utf8")) as Record<string, string>;
  const built = [...new Set(Object.values(manifest))].sort((a, b) => a.localeCompare(b));
  expect(built).toEqual(Object.keys(ROUTES).sort((a, b) => a.localeCompare(b)));
});

test("the public pages pass axe signed out: the landing page, the pricing, the terms, the privacy notice and a page that does not exist [PFE-028 AC1, AC2]", async () => {
  await visit("/", "/", "", async (target) => {
    await expect(main(target).getByRole("heading", { level: 1 })).toBeVisible();
  });
  await visit("/pricing", "/pricing", "Pricing", async (target) => {
    await expect(
      main(target)
        .getByRole("link", { name: /^Start/ })
        .first(),
    ).toBeVisible();
  });
  await visit("/legal/terms", "/legal/terms", "Terms of service", async (target) => {
    await expect(main(target).getByRole("heading", { level: 1 })).toBeVisible();
  });
  await visit("/legal/privacy", "/legal/privacy", "Privacy notice", async (target) => {
    await expect(main(target).getByRole("heading", { level: 1 })).toBeVisible();
  });
  const missing = await page.goto("/pfe028-no-such-page");
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "This page could not be found." })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  visited.add("/_not-found");
});

test("the sign-up form with its error summary, the check-your-e-mail page and the reset request pass axe [PFE-028 AC1, AC2]", async () => {
  await visit("/sign-up", "/sign-up", "Sign up", async (target) => {
    await expectHeading(target, "Create your Velexis account");
  });
  // Sent empty: the error summary takes the focus and every field says what is missing.
  await page.getByRole("button", { name: "Create account" }).click();
  await expectErrorSummary(page);
  await expect(page.getByLabel("Full name")).toHaveAttribute("aria-invalid", "true");
  await expectAccessible(page, "Sign up");

  await visit("/sign-up/check-email", "/sign-up/check-email", "Check your e-mail", async (target) => {
    await expectHeading(target, "Check your e-mail");
  });

  // The owner asks for a reset link: the same confirmation for every address; the link is opened after sign-in.
  await visit("/forgot-password", "/forgot-password", "Reset your password", async (target) => {
    await expectHeading(target, "Reset your password");
  });
  await page.getByLabel("E-mail address").fill(owned.owner.account.email);
  await page.getByRole("button", { name: "Send the reset link" }).click();
  await expect(main(page).getByText(/^If an account uses this address, we sent it a link/)).toBeVisible();
  await expectAccessible(page, "Reset your password");
});

test("the pages of e-mail links pass axe without their link, and the verification page in an unverified account's state [PFE-028 AC1, AC2]", async ({
  browser,
}) => {
  await visit("/verify-pending", "/verify-pending", "Verify your e-mail", async (target) => {
    await expectHeading(target, "Verify your e-mail address");
    await expect(target.getByLabel("E-mail address")).toBeVisible();
  });
  // The page `/verify-email` sends an expired or used link to.
  await page.goto("/verify-pending?error=token");
  await expect(main(page).getByRole("alert").first()).toBeVisible();
  await expectAccessible(page, "Verify your e-mail");
  await visit("/reset-password", "/reset-password", "Choose a new password", async (target) => {
    await expect(main(target).getByText("Open the link from your e-mail")).toBeVisible();
  });
  await visit("/invitations/accept", "/invitations/accept", "Your invitation", async (target) => {
    await expect(main(target).getByText("Open the link from your invitation e-mail")).toBeVisible();
  });

  // A signed-in account that has not verified its address yet: the only page it gets.
  const unverified: PortalAccount = {
    ...buildAccount({ fullName: "Una Unverified" }),
    endUserIp: uniqueTestIp(),
  };
  await callPlatformApi({
    operation: "signUp",
    method: "POST",
    path: "/v1/auth/sign-up",
    endUserIp: unverified.endUserIp,
    body: {
      email: unverified.email,
      password: unverified.password,
      fullName: unverified.fullName,
      acceptTerms: true,
      termsVersion: E2E_TERMS_VERSION,
    } satisfies Schemas["SignUpRequest"],
  });
  const unverifiedContext = await newAccountContext(browser, unverified, PORTAL_URL);
  try {
    await addSessionCookies(unverifiedContext, "portal", await signInWithApi(unverified));
    const unverifiedPage = await unverifiedContext.newPage();
    await unverifiedPage.goto("/verify-pending");
    await expect(main(unverifiedPage).getByText(unverified.email)).toBeVisible();
    await expect(main(unverifiedPage).getByRole("button", { name: "Sign out" })).toBeVisible();
    await expectAccessible(unverifiedPage, "Verify your e-mail");
  } finally {
    await unverifiedContext.close();
  }
});

test("the owner signs in through the browser: the sign-in page, the code page and its recovery code form pass axe [PFE-028 AC1, AC2]", async () => {
  await visit("/sign-in", "/sign-in", "Sign in", async (target) => {
    await expectHeading(target, "Sign in to Velexis");
  });
  // Sent empty: the error summary takes the focus.
  await page.getByRole("button", { name: "Sign in" }).click();
  await expectErrorSummary(page);
  await expectAccessible(page, "Sign in");
  await page.getByLabel("E-mail address").fill(owned.owner.account.email);
  await page.getByLabel("Password", { exact: true }).fill(owned.owner.account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/sign-in/mfa");
  await expect(page.getByLabel("Authentication code")).toBeVisible();
  await expectAccessible(page, "Two-factor authentication");
  visited.add("/sign-in/mfa");

  // The recovery code form of the same step.
  await page.getByRole("button", { name: "Use a recovery code instead" }).click();
  await expect(page.getByLabel("Recovery code")).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await page.getByRole("button", { name: "Use your authenticator app instead" }).click();
  const authenticator = owned.owner.account.authenticator;
  if (authenticator === undefined) {
    throw new Error("the owner has no authenticator");
  }
  await page.getByLabel("Authentication code").fill(await authenticator.nextCode());
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/dashboard");
  await expectAccessible(page, "My OTAs");
});

test("the reset link's form and an invitation sent to another address pass axe; the verification link answers a redirect [PFE-028 AC1, AC2]", async () => {
  const reset = await waitForLink({
    to: owned.owner.account.email,
    path: "/reset-password",
    origin: PORTAL_URL,
  });
  await page.goto(reset.href);
  await page.waitForURL((url) => url.pathname === "/reset-password" && url.search === "");
  await expect(page.getByLabel("New password")).toBeVisible();
  await expectAccessible(page, "Choose a new password");

  const invitation = await waitForLink({
    to: invitedAddress,
    subject: `${OWNER_NAME} invited you to ${owned.ota.name} on Velexis`,
    path: "/invitations/accept",
    origin: PORTAL_URL,
  });
  await page.goto(invitation.href);
  await page.waitForURL((url) => url.pathname === "/invitations/accept" && url.search === "");
  await expectHeading(page, `Join ${owned.ota.name}`);
  await expect(main(page).getByText("This invitation is for another address")).toBeVisible();
  await expectAccessible(page, "Your invitation");

  // `/verify-email` renders nothing: it consumes the token and answers a redirect (a token no account has here).
  const answer = await context.request.get("/verify-email?token=pfe028-not-a-token", { maxRedirects: 0 });
  expect(answer.status()).toBe(303);
  expect(new URL(answer.headers()["location"] ?? "", PORTAL_URL).pathname).toBe("/verify-pending");
  visited.add("/verify-email");
});

test("the dashboard, the create-OTA wizard with its error summary, the console picker, the profile and the security page pass axe [PFE-028 AC1, AC2]", async () => {
  await visit("/dashboard", "/dashboard", "My OTAs", async (target) => {
    await expect(main(target).getByRole("link", { name: owned.ota.name })).toBeVisible();
  });
  await visit("/otas/new", "/otas/new", "Create an OTA", async (target) => {
    await expect(main(target).getByRole("heading", { level: 2, name: "OTA details" })).toBeVisible();
  });
  await page.getByRole("button", { name: "Continue" }).click();
  await expectErrorSummary(page);
  await expectAccessible(page, "Create an OTA");
  await visit(
    "/console",
    `/console?tenant=${encodeURIComponent(owned.ota.id)}`,
    "Open the OTA admin",
    async (target) => {
      await expect(main(target).getByText(owned.ota.name).first()).toBeVisible();
    },
  );
  await visit("/account", "/account", "Your profile", async (target) => {
    await expect(target.getByLabel("Full name")).toHaveValue(owned.owner.account.fullName);
  });
  await visit("/account/security", "/account/security", "Security", async (target) => {
    await expect(main(target).getByText(/^Two-factor authentication is on\./)).toBeVisible();
  });
});

test("the OTA's overview, set-up page with the test keys revealed, API keys with a new key shown once, domains and team pass axe [PFE-028 AC1, AC2]", async () => {
  await visit("/otas/[tenantId]", otaPath(), "Overview", async (target) => {
    await expectHeading(target, owned.ota.name);
    await expect(main(target).getByRole("region", { name: "Get your OTA ready" })).toBeVisible();
  });
  await visit("/otas/[tenantId]/setup", otaPath("/setup"), "OTA set-up", async (target) => {
    await expect(main(target).getByRole("heading", { name: "Your OTA is ready" })).toBeVisible();
  });
  await page.getByRole("button", { name: "Reveal the test keys" }).click();
  await expect(main(page).getByRole("heading", { name: "Your test API keys" })).toBeVisible();
  await expectAccessible(page, "OTA set-up");

  await visit("/otas/[tenantId]/api-keys", otaPath("/api-keys"), "API keys", async (target) => {
    await expect(main(target).getByRole("tab", { name: "Test keys" })).toBeVisible();
  });
  await page.getByLabel("Name", { exact: true }).fill("Accessible server");
  await page.getByRole("button", { name: "Create the key" }).click();
  await expect(page.getByRole("region", { name: "Your new secret test key" })).toBeVisible();
  await expectAccessible(page, "API keys");

  await visit("/otas/[tenantId]/domains", otaPath("/domains"), "Domains", async (target) => {
    await expect(main(target).getByRole("link", { name: owned.storefrontHost })).toBeVisible();
  });
  await visit("/otas/[tenantId]/team", otaPath("/team"), "Team", async (target) => {
    await expect(main(target).getByRole("table", { name: "Members of this OTA" })).toContainText(
      coOwner.email,
    );
    await expect(main(target).getByRole("table", { name: "Pending invitations" })).toContainText(
      invitedAddress,
    );
  });
});

test("the OTA's Amadeus, payments (also with Stripe Connect's outcome), payout account, settlements, statement, billing and settings pass axe [PFE-028 AC1, AC2]", async () => {
  await visit("/otas/[tenantId]/amadeus", otaPath("/amadeus"), "Amadeus", async (target) => {
    await expect(main(target).getByRole("button", { name: "Save the settings" }).first()).toBeVisible();
  });
  await visit("/otas/[tenantId]/payments", otaPath("/payments"), "Payments", async (target) => {
    await expectHeading(target, "Payments");
  });
  // Stripe Connect's way back renders no page: a redirect to the payments page (here, with no state of Stripe's, to
  // the dashboard), whose outcome notice passes axe too.
  const callback = await context.request.get("/connect/stripe/callback", { maxRedirects: 0 });
  expect(callback.status()).toBe(303);
  visited.add("/connect/stripe/callback");
  await page.goto(otaPath("/payments?stripeConnect=state_invalid"));
  await expect(main(page).locator('[data-stripe-connect-outcome="state_invalid"]')).toContainText(
    "The Stripe connection did not complete",
  );
  await expectAccessible(page, "Payments");

  await visit(
    "/otas/[tenantId]/payments/payout-account",
    otaPath("/payments/payout-account"),
    "Payout account",
    async (target) => {
      await expect(main(target).getByText(/Ending in/)).toBeVisible();
    },
  );
  await visit(
    "/otas/[tenantId]/payments/settlements",
    otaPath("/payments/settlements"),
    "Settlements",
    async (target) => {
      await expect(main(target).locator(`a[href$="/payments/settlements/${settlementId}"]`)).toBeVisible();
    },
  );
  await visit(
    "/otas/[tenantId]/payments/settlements/[settlementId]",
    otaPath(`/payments/settlements/${settlementId}`),
    "Settlements",
    async (target) => {
      await expect(main(target).getByRole("link", { name: "Download the lines as CSV" })).toBeVisible();
    },
  );
  const lines = await context.request.get(otaPath(`/payments/settlements/${settlementId}/lines.csv`), {
    maxRedirects: 0,
  });
  expect(lines.status()).toBe(200);
  expect(lines.headers()["content-type"] ?? "").toMatch(/^text\/csv/);
  visited.add("/otas/[tenantId]/payments/settlements/[settlementId]/lines.csv");

  await visit("/otas/[tenantId]/billing", otaPath("/billing"), "Billing", async (target) => {
    await expect(main(target).getByRole("heading", { level: 2, name: "Subscription" })).toBeVisible();
  });
  await visit("/otas/[tenantId]/settings", otaPath("/settings"), "OTA settings", async (target) => {
    await expect(main(target).getByRole("button", { name: "Save changes" })).toBeVisible();
  });
});

test("the go-live page before the switch, its confirmation and the live view pass axe, and so does the API keys' live tab [PFE-028 AC1, AC2]", async () => {
  await visit("/otas/[tenantId]/go-live", otaPath("/go-live"), "Go live", async (target) => {
    await expect(main(target).getByRole("region", { name: "What going live needs" })).toBeVisible();
  });
  await page.getByRole("button", { name: "Go live", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Switch your storefront to live?" });
  await expect(confirm).toBeVisible();
  await expectAccessible(page, "Go live");
  // The owner's sign-in with a TOTP code is recent (15 minutes): no step-up is asked.
  await confirm.getByRole("button", { name: "Go live", exact: true }).click();
  const live = page.getByRole("region", { name: "Your storefront is live" });
  await expect(live).toBeVisible();
  await expectAccessible(page, "Go live");

  await page.goto(otaPath("/api-keys"));
  await page.getByRole("tab", { name: "Live keys" }).click();
  await expect(page.getByRole("tab", { name: "Live keys", selected: true })).toBeVisible();
  await expectAccessible(page, "API keys");
});

test("the hand-off page of Open console passes axe [PFE-028 AC1, AC2]", async () => {
  // The navigation to the OTA admin's `/sso` is cancelled in this context only (`ERR_ABORTED`): the browser stays on
  // the hand-off page, whose token is never redeemed.
  await page.route(`${OTA_ADMIN_URL}/sso`, (route) => route.abort("aborted"));
  try {
    await page.goto(otaPath());
    await expectAccessible(page, "Overview");
    const handOff = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === otaPath("/console/launch") &&
        response.request().method() === "POST",
    );
    await main(page)
      .getByRole("button", { name: /^Open console/ })
      .click();
    expect((await handOff).status()).toBe(200);
    await expect(page).toHaveTitle("Opening the OTA admin");
    await expect(page.getByRole("heading", { level: 1, name: "Opening the OTA admin…" })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    visited.add("/otas/[tenantId]/console/launch");
  } finally {
    await page.unroute(`${OTA_ADMIN_URL}/sso`);
  }
});

test("a co-owner of the live OTA without MFA gets the enrolment page, which passes axe in each of its states [PFE-028 AC1, AC2]", async ({
  browser,
}) => {
  const coOwnerContext = await newAccountContext(browser, coOwner, PORTAL_URL);
  try {
    await addSessionCookies(coOwnerContext, "portal", await signInWithApi(coOwner));
    const enrolment = await coOwnerContext.newPage();
    await enrolment.goto(otaPath());
    await enrolment.waitForURL((url) => url.pathname === "/mfa-enrolment");
    await expectHeading(enrolment, "Set up two-factor authentication");
    await expectAccessible(enrolment, "Set up two-factor authentication");
    visited.add("/mfa-enrolment");

    await enrolment.getByRole("button", { name: "Set up two-factor authentication" }).click();
    await expect(enrolment.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
    const authenticator = new Authenticator(
      await enrolment.getByLabel("Or enter this key in the app").inputValue(),
    );
    await expectAccessible(enrolment, "Set up two-factor authentication");
    await enrolment.getByLabel("Authentication code").fill(await authenticator.nextCode());
    await enrolment.getByRole("button", { name: "Turn on two-factor authentication" }).click();
    await expect(enrolment.getByRole("heading", { name: "Your recovery codes" })).toBeVisible();
    await expectAccessible(enrolment, "Set up two-factor authentication");
    await enrolment.getByRole("link", { name: "Continue" }).click();
    await enrolment.waitForURL((url) => url.pathname === otaPath());
    await expectAccessible(enrolment, "Overview");
  } finally {
    await coOwnerContext.close();
  }
});

test("the health routes answer JSON, and Sign out ends the session on the signed-out sign-in page, which passes axe [PFE-028 AC1, AC2]", async () => {
  for (const route of ["/health/live", "/health/ready"] as const) {
    const answer = await context.request.get(route, { maxRedirects: 0 });
    expect(answer.status(), route).toBe(200);
    expect(answer.headers()["content-type"] ?? "", route).toMatch(/^application\/json/);
    visited.add(route);
  }
  await page.goto("/dashboard");
  await expectAccessible(page, "My OTAs");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("signedOut") === "1");
  await expect(main(page).getByText("You are signed out.")).toBeVisible();
  await expectAccessible(page, "Sign in");
  const cookies = (await context.cookies(PORTAL_URL)).map((cookie) => cookie.name);
  expect(cookies.filter((name) => name === "__Host-vxp_at" || name === "__Host-vxp_rt")).toEqual([]);
  visited.add("/sign-out");
});

test("every route of the built portal was visited [PFE-028 AC1, AC2]", () => {
  expect([...visited].sort((a, b) => a.localeCompare(b))).toEqual(
    Object.keys(ROUTES).sort((a, b) => a.localeCompare(b)),
  );
});
