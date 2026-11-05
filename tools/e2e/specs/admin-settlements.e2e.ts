// The settlement review from the platform admin, and what the OTA's owner sees of it (PAD-015 step 1;
// platform/docs/flows/platform-admin-operations.md "Sequence: settlement review and payout", flows/stripe-payments-
// account.md §F items 4 and 5, PADR-0003 items 5 to 11; scope PF-63 AC2 and AC3, PF-91), project `platform-admin`:
//
//   the dashboard counts the draft and links the drafts → the statement: its totals, its lines and the OTA's verified
//   payout account → the admin adds an adjustment with a reason, and the totals are computed again from the lines →
//   "Approve" asks for a step-up (the admin's last code is older than 15 minutes) and approves with the code → "Mark
//   paid" asks for a step-up too and records the transfer → the owner gets the e-mail, follows its link into the portal,
//   sees the statement paid and downloads its lines as CSV
//
// Arrangements in `beforeAll` (PADR-0017 item 5: the public APIs where an operation exists, support/seed.ts for the
// rest):
//   - through the platform API: the admin (an account with MFA that `admin:grant` makes a platform admin, signed in
//     through `adminSignIn` and `adminVerifyMfa`), the owner's active OTA (`newOwnerWithActiveOta` with MFA, set up by
//     the OTA worker, so the journey needs `E2E_WITH_OTA=1` and fails at once without it), and the OTA's verified payout
//     account: the owner's `setPayoutAccount` (the step-up of the owner's TOTP sign-in) and the admin's
//     `adminReviewPayoutAccount` (`verified`, `If-Match`);
//   - support/seed.ts (`insertDraftSettlement`, as the platform API's own role): the draft statement of last month with
//     three lines, as the monthly run builds it from the Velexis Stripe account's balance transactions, which the stack
//     cannot have: two payments and a refund in EUR, a Velexis fee of 1.50 %, the totals of the platform's formula.
//
// The step-ups are real. The admin signed in with a TOTP code minutes ago, which counts for 15 minutes (PADR-0008), so
// before each step-up operation `ageAdminMfa` of support/seed.ts moves the last TOTP verification of the admin's
// session 20 minutes back, and the browser loses its access cookie, as on its expiry: the admin's middleware refreshes
// the session with the refresh cookie, its new access token carries the old verification, the API answers
// `401 REAUTH_REQUIRED` and the page asks for a code in its step-up dialog, as for an admin whose last code is older
// than 15 minutes. The platform accepts each TOTP step once; `beforeAll` waits until the admin's authenticator has two
// steps it has not used, so neither step-up waits for the clock within its step.
//
// Every page the journey visits passes axe once its title is in place, the dialogs included. The steps are tests in
// order (`mode: "serial"`) on browser contexts made in `beforeAll`.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import type { components } from "@velexis/api-types/platform";
import { expectNoSeriousA11yViolations } from "../support/a11y";
import {
  addSessionCookies,
  callPlatformApi,
  createVerifiedAccount,
  enableMfa,
  expect,
  newAccountContext,
  signInToAdminWithApi,
  test,
  type MfaAccount,
} from "../support/fixtures";
import { waitForEmail, waitForLink } from "../support/mailpit";
import { newOwnerWithActiveOta, newTenantId, type OwnedOta } from "../support/ota";
import {
  ageAdminMfa,
  buildAccount,
  grantPlatformAdmin,
  insertDraftSettlement,
  stack,
  type AdminApiSession,
  type DraftSettlementInput,
} from "../support/seed";
import { PLATFORM_ADMIN_URL, PORTAL_URL } from "../support/stack";
import { TOTP_PERIOD_SECONDS, totpStep } from "../support/totp";

test.describe.configure({ mode: "serial" });

type Schemas = components["schemas"];

/**
 * The budget of the one-time arrangement in `beforeAll` (a hook, not a step of the journey): two accounts through the
 * platform API and Mailpit (at most 15 s each), the admin's MFA, `admin:grant` and sign-in, the OTA's set-up on the
 * OTA worker (about 2 s, at most 45 s per OTA, and up to three OTAs while admin-amadeus-pool.e2e.ts holds the test
 * pool), the payout account's two calls, the statement, and the wait for two unused TOTP steps (at most 60 s).
 */
const ARRANGE_BUDGET_MS = 240_000;

/** The admin's title of a page (`%s · Velexis admin`) and the portal's (`%s · Velexis`). */
const adminTitle = (title: string): string => `${title} · Velexis admin`;
const portalTitle = (title: string): string => `${title} · Velexis`;

/** Waits until `target` has the title of its page, then fails on any serious or critical axe violation. */
async function expectAccessible(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(title);
  await expectNoSeriousA11yViolations(target);
}

/** `text` as a regular expression that matches it literally. */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** An id as the platform writes them: `<prefix>_` and a ULID. */
const platformId = (prefix: "stl" | "sln"): string => `${prefix}_${newTenantId().slice("ten_".length)}`;

/** A Stripe-shaped reference of this journey: `<prefix>_e2e` and 16 random hex digits. */
const stripeRef = (prefix: "txn" | "pi"): string => `${prefix}_e2e${randomBytes(8).toString("hex")}`;

/** The first instant of the calendar month (UTC) `offset` months from the one of `now`. */
function monthStart(now: Date, offset: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
}

/** The month of a statement as the admin and the portal write it ("October 2026"). */
const MONTH = new Intl.DateTimeFormat("en", { year: "numeric", month: "long", timeZone: "UTC" });

/** Today's date in UTC (`yyyy-mm-dd`), as the transfer date field and the API read it. */
const utcDay = (): string => new Date().toISOString().slice(0, 10);

/** The columns of the portal's CSV of a statement's lines (`downloadSettlementLines`, settlement-csv.ts). */
const PORTAL_CSV_HEADER =
  "type,occurredAt,amount,stripeFee,paymentIntentId,velexisPaymentId,checkoutId,description";

/**
 * The statement of last month: two payments and a refund in EUR, and the totals of the platform's formula
 * (settlement-formula.ts): payments 250.00 + 180.00 = 430.00; refunds 40.00; Stripe fees 3.88 + 2.77 + 0.00 = 6.65;
 * the Velexis fee 1.50 % of (430.00 − 40.00) = 5.85; net 430.00 − 40.00 − 6.65 − 5.85 = 377.50. The adjustment of the
 * journey (+12.50) makes the net 390.00.
 */
function lastMonthsStatement(tenantId: string, now: Date): DraftSettlementInput {
  const periodStart = monthStart(now, -1);
  const day = (n: number, hour: number): Date =>
    new Date(periodStart.getTime() + ((n - 1) * 24 + hour) * 3_600_000);
  return {
    id: platformId("stl"),
    tenantId,
    currency: "EUR",
    periodStart,
    periodEnd: monthStart(now, 0),
    feeBps: 150,
    totals: {
      gross: "430.00",
      refunds: "40.00",
      disputes: "0.00",
      stripeFees: "6.65",
      velexisFees: "5.85",
      adjustments: "0.00",
      net: "377.50",
    },
    lines: [
      {
        id: platformId("sln"),
        lineType: "charge",
        amount: "250.00",
        stripeFee: "3.88",
        balanceTransactionId: stripeRef("txn"),
        paymentIntentId: stripeRef("pi"),
        description: "Booking payment (Oslo to Paris)",
        occurredAt: day(4, 10),
      },
      {
        id: platformId("sln"),
        lineType: "charge",
        amount: "180.00",
        stripeFee: "2.77",
        balanceTransactionId: stripeRef("txn"),
        paymentIntentId: stripeRef("pi"),
        description: "Booking payment (Oslo to Madrid)",
        occurredAt: day(11, 15),
      },
      {
        id: platformId("sln"),
        lineType: "refund",
        amount: "-40.00",
        stripeFee: "0.00",
        balanceTransactionId: stripeRef("txn"),
        paymentIntentId: stripeRef("pi"),
        description: "Refund of a cancelled seat",
        occurredAt: day(18, 9),
      },
    ],
  };
}

/** The journey's adjustment: what the admin types. */
const ADJUSTMENT = {
  amount: "12.50",
  description: "Goodwill credit for the delayed October transfer",
  reason: "The OTA's transfer of last month arrived late; Velexis credits the bank fee (PAD-015 journey).",
} as const;

let admin: MfaAccount;
let adminApi: AdminApiSession;
let owned: OwnedOta;
let statement: DraftSettlementInput;
let month: string;
let payoutReference: string;
let adminContext: BrowserContext;
let adminPage: Page;
let ownerContext: BrowserContext;
let ownerPage: Page;

/** The statement as the admin API answers it now. */
async function adminStatement(): Promise<Schemas["AdminSettlement"]> {
  return await callPlatformApi<Schemas["AdminSettlement"]>({
    operation: "adminGetSettlement",
    method: "GET",
    path: `/v1/admin/settlements/${encodeURIComponent(statement.id)}`,
    ...adminApi,
  });
}

/**
 * Waits in the one-time arrangement until the TOTP step `step` has begun. The admin's authenticator used at most the
 * step after the one of its sign-in, so from the second step after it on, the current step and the next one are both
 * unused: the two step-ups of the journey take them without waiting for the clock (support/totp.ts `Authenticator`).
 */
async function waitForTotpStep(step: number): Promise<void> {
  const wait = step * TOTP_PERIOD_SECONDS * 1000 - Date.now();
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait + 50));
  }
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(ARRANGE_BUDGET_MS);
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "admin-settlements.e2e.ts needs an active OTA: run it with E2E_WITH_OTA=1 (the Amadeus stub and the OTA worker)",
    );
  }
  // The admin first: its two TOTP codes (MFA set-up, sign-in) are the oldest the journey's step-ups follow.
  admin = await enableMfa(await createVerifiedAccount(buildAccount({ fullName: "Sara Settlements Admin" })));
  await grantPlatformAdmin(admin.email);
  const adminSession = await signInToAdminWithApi(admin);
  const signInStep = totpStep(Date.now());
  adminApi = { endUserIp: admin.endUserIp, accessToken: adminSession.accessToken };

  owned = await newOwnerWithActiveOta("Stina Settlements", "stl", { mfa: true });
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
      accountHolderName: "Stina Settlements AS",
      countryCode: "NO",
      currency: "EUR",
      scheme: "iban",
      iban: "NO93 8601 1117 947",
      bic: "DNBANOKK",
    } satisfies Schemas["SetPayoutAccountRequest"],
  });
  const reviewed = await callPlatformApi<Schemas["PayoutAccount"]>({
    operation: "adminReviewPayoutAccount",
    method: "POST",
    path: `/v1/admin/tenants/${tenantPath}/payout-account/review`,
    ...adminApi,
    headers: { "If-Match": `"${String(payout.version)}"` },
    body: { decision: "verified" } satisfies Schemas["ReviewPayoutAccountRequest"],
  });
  expect(reviewed.status).toBe("verified");

  const now = new Date();
  statement = lastMonthsStatement(owned.ota.id, now);
  month = MONTH.format(statement.periodStart);
  payoutReference = `E2E-${randomBytes(5).toString("hex").toUpperCase()}`;
  await insertDraftSettlement(statement);

  adminContext = await newAccountContext(browser, admin, PLATFORM_ADMIN_URL);
  await addSessionCookies(adminContext, "admin", adminSession);
  adminPage = await adminContext.newPage();
  ownerContext = await newAccountContext(browser, owned.owner.account, PORTAL_URL);
  await addSessionCookies(ownerContext, "portal", owned.session);
  ownerPage = await ownerContext.newPage();

  await waitForTotpStep(signInStep + 2);
});

test.afterAll(async () => {
  await adminContext?.close();
  await ownerContext?.close();
});

/** The panel `title` of the statement page (each is a region named by its heading). */
function panel(title: string): Locator {
  return adminPage.getByRole("region", { name: title, exact: true });
}

/** The lines of the statement page, one row per line (the header row left out). */
function lineRows(): Locator {
  return panel("Lines")
    .getByRole("row")
    .filter({ hasNot: adminPage.getByRole("columnheader") });
}

/**
 * Makes the admin's last TOTP code 20 minutes old (see the file header) and reloads the statement: the middleware,
 * without the access cookie, refreshes the session, whose new access token carries that old code.
 */
async function lastCodeTwentyMinutesAgo(): Promise<void> {
  await ageAdminMfa(admin.email);
  await adminContext.clearCookies({ name: "__Host-vxa_at" });
  await adminPage.reload();
  await expect(adminPage).toHaveTitle(adminTitle("Statement"));
  const cookies = await adminContext.cookies(PLATFORM_ADMIN_URL);
  expect(cookies.map((cookie) => cookie.name)).toContain("__Host-vxa_at");
}

/** Answers the step-up dialog with the next code of the admin's authenticator app. */
async function stepUp(): Promise<void> {
  const dialog = adminPage.getByRole("dialog", { name: "Confirm with your authenticator app" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Authentication code")).toBeFocused();
  await expectNoSeriousA11yViolations(adminPage);
  await dialog.getByLabel("Authentication code").fill(await admin.authenticator.nextCode());
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toBeHidden();
}

test("the dashboard counts the draft, and the statement shows its totals, its lines and the verified payout account [PAD-015 AC1]", async () => {
  await adminPage.goto("/");
  // The count is the run's (other OTAs may have drafts): the link opens the drafts of every OTA.
  const toReview = adminPage.getByRole("region", { name: "To review" });
  await expect(toReview.getByRole("link", { name: /^[\d,]+ draft settlements? to review$/ })).toBeVisible();
  await expectAccessible(adminPage, adminTitle("Dashboard"));

  await toReview.getByRole("link", { name: /draft settlements? to review$/ }).click();
  await adminPage.waitForURL((url) => url.pathname === "/settlements" && url.search === "?status=draft");
  const row = adminPage.getByRole("row").filter({ hasText: owned.ota.key });
  await expect(row).toContainText(month);
  await expect(row).toContainText("Draft");
  await expect(row).toContainText("€377.50");
  await expectAccessible(adminPage, adminTitle("Settlements"));

  await row.getByRole("link", { name: statement.id }).click();
  await expect(
    adminPage.getByRole("heading", { level: 1, name: `${owned.ota.name}, ${month}` }),
  ).toBeVisible();
  const totals = panel("Totals");
  for (const [label, amount] of [
    ["Payments", "€430.00"],
    ["Refunds", "€40.00"],
    ["Disputes", "€0.00"],
    ["Stripe fees", "€6.65"],
    ["Velexis fee (1.50 %)", "€5.85"],
    ["Adjustments and carried balances", "€0.00"],
    ["Net amount", "€377.50"],
  ] as const) {
    await expect(totals).toContainText(new RegExp(`${escapeRegExp(label)}\\s*${escapeRegExp(amount)}`));
  }
  await expect(panel("Payout account")).toContainText("Verified");
  await expect(lineRows()).toHaveCount(3);
  for (const line of statement.lines) {
    await expect(lineRows().filter({ hasText: line.description })).toContainText(
      line.lineType === "charge" ? "Payment" : "Refund",
    );
  }
  await expectAccessible(adminPage, adminTitle("Statement"));
});

test("adds an adjustment with a reason, and the totals are computed again from the lines [PAD-015 AC1]", async () => {
  const form = adminPage.getByRole("form", { name: "Add an adjustment" });
  await form.getByLabel("Amount (EUR)").fill(ADJUSTMENT.amount);
  await form.getByLabel("Description").fill(ADJUSTMENT.description);
  await form.getByLabel("Reason").fill(ADJUSTMENT.reason);
  await expectNoSeriousA11yViolations(adminPage);
  await form.getByRole("button", { name: "Add adjustment" }).click();

  await expect(
    adminPage
      .getByRole("status")
      .filter({ hasText: "The adjustment is added. The totals and the lines show it." }),
  ).toBeVisible();
  const totals = panel("Totals");
  await expect(totals).toContainText("€12.50");
  await expect(totals).toContainText("€390.00");
  await expect(lineRows()).toHaveCount(4);
  await expect(lineRows().filter({ hasText: ADJUSTMENT.description })).toContainText("Adjustment");
  // The API computed the totals again from every line (settlement-formula.ts), with the statement's own fee.
  expect(await adminStatement()).toMatchObject({
    status: "draft",
    lineCount: 4,
    adjustmentsAmount: { amount: "12.50", currency: "EUR" },
    velexisFeesAmount: { amount: "5.85", currency: "EUR" },
    netAmount: { amount: "390.00", currency: "EUR" },
  });
  await expectAccessible(adminPage, adminTitle("Statement"));
});

test("approving asks for a step-up when the admin's last code is older than 15 minutes, then approves [PAD-015 AC1]", async () => {
  await lastCodeTwentyMinutesAgo();
  await panel("Review").getByRole("button", { name: "Approve", exact: true }).click();
  const confirm = adminPage.getByRole("alertdialog", {
    name: `Approve the statement of ${owned.ota.name} for ${month}?`,
  });
  await expect(confirm).toContainText("The net amount of €390.00 becomes approved");
  await expectNoSeriousA11yViolations(adminPage);
  await confirm.getByRole("button", { name: "Approve statement" }).click();

  // `adminApproveSettlement` answered REAUTH_REQUIRED: the page asks for a code, and nothing is approved yet.
  await expect(adminPage.getByRole("dialog", { name: "Confirm with your authenticator app" })).toBeVisible();
  expect((await adminStatement()).status).toBe("draft");
  await stepUp();

  await expect(
    adminPage
      .getByRole("status")
      .filter({ hasText: "The statement is approved, to be paid by bank transfer." }),
  ).toContainText("Approved");
  expect(await adminStatement()).toMatchObject({ status: "approved", netAmount: { amount: "390.00" } });
  await expect(adminPage.getByRole("form", { name: "Record the bank transfer" })).toBeVisible();
  await expectAccessible(adminPage, adminTitle("Statement"));
});

test("marking it paid asks for a step-up too, and the owners get the e-mail [PAD-015 AC1]", async () => {
  // The transfer date starts at the day (UTC) the page is rendered, the latest the API takes: read on both sides of
  // the reload, so a run across midnight UTC matches too.
  const dayBefore = utcDay();
  await lastCodeTwentyMinutesAgo();
  const form = adminPage.getByRole("form", { name: "Record the bank transfer" });
  const transferDate = await form.getByLabel("Date of the transfer").inputValue();
  expect([dayBefore, utcDay()]).toContain(transferDate);
  await form.getByLabel("Bank reference").fill(payoutReference);
  await expectNoSeriousA11yViolations(adminPage);
  await form.getByRole("button", { name: "Mark paid" }).click();

  await expect(adminPage.getByRole("dialog", { name: "Confirm with your authenticator app" })).toBeVisible();
  expect((await adminStatement()).status).toBe("approved");
  await stepUp();

  await expect(
    adminPage.getByRole("status").filter({
      hasText: "The statement is marked paid. The OTA's owners and finance members get an e-mail.",
    }),
  ).toContainText("Paid");
  const details = panel("Statement");
  await expect(details).toContainText(payoutReference);
  expect(await adminStatement()).toMatchObject({ status: "paid", payoutReference });
  await expectAccessible(adminPage, adminTitle("Statement"));

  // PF-63 AC2: the owner is e-mailed the transfer, with the net amount and the bank reference (once per person).
  const email = await waitForEmail({
    to: owned.owner.account.email,
    subject: `Velexis paid the ${month} settlement of ${owned.ota.name}`,
  });
  expect(email.Text).toContain("390.00 EUR");
  expect(email.Text).toContain(payoutReference);
  expect(email.Text).toContain(transferDate);
});

test("the owner follows the e-mail's link, sees the statement paid in the portal and downloads its lines [PAD-015 AC1]", async () => {
  const link = await waitForLink({
    to: owned.owner.account.email,
    subject: `Velexis paid the ${month} settlement of ${owned.ota.name}`,
    path: `/otas/${owned.ota.id}/payments/settlements/${statement.id}`,
    origin: PORTAL_URL,
  });
  await ownerPage.goto(link.href);
  await expect(
    ownerPage.getByRole("heading", { level: 1, name: `Statement for ${month}, EUR` }),
  ).toBeVisible();
  const main = ownerPage.getByRole("main");
  await expect(main).toContainText(
    "Velexis transferred the net amount of this statement to your payout account.",
  );
  await expect(main).toContainText("€390.00");
  await expect(main).toContainText(payoutReference);
  await expect(main).toContainText("4 lines");
  await expectAccessible(ownerPage, portalTitle("Settlements"));

  // PF-63 AC3: its lines download as CSV (a plain link to the portal's route handler, which answers an attachment):
  // the three lines of the month as the statement has them, and the admin's adjustment, without Velexis-only columns.
  const [download] = await Promise.all([
    ownerPage.waitForEvent("download"),
    main.getByRole("link", { name: "Download the lines as CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(
    `velexis-statement-${statement.periodStart.toISOString().slice(0, 7)}-EUR.csv`,
  );
  const [header, ...records] = (await readFile(await download.path(), "utf8"))
    .split("\r\n")
    .filter((record) => record !== "");
  expect(header).toBe(PORTAL_CSV_HEADER);
  expect(records).toHaveLength(4);
  for (const line of statement.lines) {
    expect(records).toContain(
      [
        line.lineType,
        line.occurredAt.toISOString(),
        line.amount,
        line.stripeFee,
        line.paymentIntentId,
        "",
        "",
        line.description,
      ].join(","),
    );
  }
  expect(records.filter((record) => record.startsWith("adjustment,"))).toEqual([
    expect.stringMatching(
      new RegExp(
        `^adjustment,[^,]+,${escapeRegExp(ADJUSTMENT.amount)},[^,]*,,,,${escapeRegExp(ADJUSTMENT.description)}$`,
      ),
    ),
  ]);
  // The download leaves the statement on the page.
  await expect(
    ownerPage.getByRole("heading", { level: 1, name: `Statement for ${month}, EUR` }),
  ).toBeVisible();

  // PF-63 AC3: the portal lists it among the OTA's statements.
  await main.getByRole("link", { name: "All statements" }).click();
  const row = ownerPage.getByRole("row").filter({ hasText: month });
  await expect(row).toContainText("Paid");
  await expect(row).toContainText("€390.00");
  await expectAccessible(ownerPage, portalTitle("Settlements"));
});
