// The portal's payout account journey (PFE-027 step 3; platform/docs/flows/stripe-payments-account.md §B, scope PF-64
// AC1, platform/frontend/README.md §2 `/otas/[tenantId]/payments/payout-account`), project `portal`:
//
//   the owner of an active OTA opens the payout account page (no account yet, the owners' form) → enters the holder,
//   the bank's country and currency and a valid test IBAN with its BIC → saving asks for a step-up: the owner types a
//   code of their authenticator app → the account is saved, shown masked (the last 4 characters only) and pending review
//   → after a reload it is still masked and pending, and the platform keeps the bank identifiers only encrypted
//
// Arranged in `beforeAll` through the platform API: the owner's active OTA (`newOwnerWithActiveOta`, set up by the OTA
// worker, so the journey needs `E2E_WITH_OTA=1` and fails at once without it). The owner signs in before turning MFA on
// (`enableMfa`, with a sign-in of its own), so the browser's session carries no TOTP verification: `setPayoutAccount`
// (`x-mfa-step-up`) answers `401 REAUTH_REQUIRED`, and the page asks for the code in its step-up dialog, as it does for
// an owner whose last code is older than 15 minutes (PADR-0008). The stack turns FEATURE_SETTLEMENTS on for the
// platform processes (support/stack.ts `PLATFORM_SWITCHES_ON`); the payout account needs no Stripe call.
//
// The IBAN is the IBAN registry's example for Norway (`NO93 8601 1117 947`, with its BIC `DNBANOKK`), the one the
// platform document's `setPayoutAccount` example uses: a valid checksum, no real customer's account. It stays in
// variables and in the form while it is typed; the checks are booleans, so a failure never prints it.
//
// Every page and dialog the journey visits passes axe once its title is in place. The steps are tests in order on one
// browser context made in `beforeAll` (`mode: "serial"`).
import type { BrowserContext, Locator, Page } from "@playwright/test";
import type { components } from "@velexis/api-types/platform";
import { expectNoSeriousA11yViolations } from "../support/a11y";
import {
  addSessionCookies,
  callPlatformApi,
  enableMfa,
  expect,
  newAccountContext,
  test,
  type MfaAccount,
} from "../support/fixtures";
import { newOwnerWithActiveOta, type OwnedOta } from "../support/ota";
import { stack, withDatabase } from "../support/seed";
import { PORTAL_URL } from "../support/stack";

test.describe.configure({ mode: "serial" });

type Schemas = components["schemas"];

/**
 * The budget of the one-time arrangement in `beforeAll` (a hook, not a step of the journey): an account through the
 * platform API and Mailpit (at most 15 s), the OTA's set-up on the OTA worker (about 2 s, at most 45 s per OTA, and up
 * to three OTAs while admin-amadeus-pool.e2e.ts holds the test pool), and MFA turned on.
 */
const ARRANGE_BUDGET_MS = 180_000;

/** The portal's title of a page (`%s · Velexis`). */
const portalTitle = (title: string): string => `${title} · Velexis`;

/** Waits until `target` has the title of its page, then fails on any serious or critical axe violation. */
async function expectAccessible(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(portalTitle(title));
  await expectNoSeriousA11yViolations(target);
}

/** The account the owner enters (synthetic holder; the IBAN registry's example IBAN and BIC for Norway). */
const PAYOUT = {
  holder: "Paula Payouts Travel AS",
  iban: "NO93 8601 1117 947",
  bic: "DNBANOKK",
} as const;
/** The IBAN as the platform normalises it (no spaces, upper case), and the 4 characters the page may show. */
const IBAN_NORMALISED = PAYOUT.iban.replace(/\s/g, "");
const LAST4 = IBAN_NORMALISED.slice(-4);
/**
 * Every form of the bank identifiers that must never be shown, answered or stored in clear: the IBAN as typed and
 * normalised, its account part without the country and check digits, and the BIC.
 */
const BANK_IDENTIFIERS = Object.freeze([PAYOUT.iban, IBAN_NORMALISED, IBAN_NORMALISED.slice(4), PAYOUT.bic]);

let owned: OwnedOta;
/** The owner with MFA on: the authenticator answers the step-up. */
let owner: MfaAccount;
let context: BrowserContext;
let page: Page;
/** `/otas/<tenantId>/payments/payout-account`. */
let payoutPath: string;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(ARRANGE_BUDGET_MS);
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "portal-payments.e2e.ts needs an active OTA: run it with E2E_WITH_OTA=1 (the Amadeus stub and the OTA worker)",
    );
  }
  // The owner signs in (the browser's session, without a TOTP verification), then turns MFA on in a sign-in of its own.
  owned = await newOwnerWithActiveOta("Paula Payouts", "pay");
  owner = await enableMfa(owned.owner.account);
  payoutPath = `/otas/${owned.ota.id}/payments/payout-account`;

  context = await newAccountContext(browser, owner, PORTAL_URL);
  await addSessionCookies(context, "portal", owned.session);
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

/** The section that shows the OTA's payout account. */
function currentAccount(): Locator {
  return page.getByRole("region", { name: "Your payout account" });
}

/** The page holds none of the bank identifiers the owner typed: a boolean, so a failure never prints them. */
async function expectNoBankIdentifiers(): Promise<void> {
  const html = await page.content();
  const found = BANK_IDENTIFIERS.some((value) => html.includes(value));
  expect(found, "a bank identifier the owner typed is in the page").toBe(false);
}

/**
 * The saved account, masked and pending review (PF-64 AC1): the holder, Norway, EUR, an IBAN shown as dots and its
 * last 4 characters only (read as "Ending in …"), the status "Pending review" and what it means.
 */
async function expectMaskedPendingAccount(): Promise<void> {
  const account = currentAccount();
  await expect(account.getByText(PAYOUT.holder, { exact: true })).toBeVisible();
  await expect(account.getByText("Norway", { exact: true })).toBeVisible();
  await expect(account.getByText(owned.ota.defaultCurrency, { exact: true })).toBeVisible();
  await expect(account.getByText("IBAN", { exact: true })).toBeVisible();
  const masked = account.locator("[data-masked-number]");
  await expect(masked).toHaveText(`Ending in •••• ${LAST4}`);
  await expect(masked.getByText("•••• ", { exact: true })).toHaveAttribute("aria-hidden", "true");
  await expect(account.getByText("Pending review", { exact: true })).toBeVisible();
  await expect(
    account.getByText(
      "Velexis checks this account before it pays a settlement to it. The owners get an e-mail with the outcome.",
    ),
  ).toBeVisible();
  await expectNoBankIdentifiers();
}

test("the payout account page has no account yet and offers the owners' form [PFE-027 AC1]", async () => {
  await page.goto(payoutPath);
  await expect(page.getByRole("heading", { level: 1, name: "Payout account" })).toBeVisible();
  await expect(currentAccount().getByText(/^This OTA has no payout account yet\./)).toBeVisible();

  const form = page.getByRole("form", { name: "Add a payout account" });
  await expect(form).toBeVisible();
  // The form says before the save that it asks for a code and sends the account to review.
  await expect(page.getByText(/^Saving asks for a code from your authenticator app\./)).toBeVisible();
  // A first account starts with the OTA's country and default currency, and an IBAN.
  await expect(form.getByLabel("Bank country")).toHaveValue(owned.ota.countryCode ?? "");
  await expect(form.getByLabel("Currency")).toHaveValue(owned.ota.defaultCurrency);
  await expect(form.getByLabel("An IBAN")).toBeChecked();
  await expectAccessible(page, "Payout account");
});

test("saving a valid test IBAN asks for a step-up first [PFE-027 AC1]", async () => {
  const form = page.getByRole("form", { name: "Add a payout account" });
  await form.getByLabel("Account holder").fill(PAYOUT.holder);
  await form.getByLabel("IBAN", { exact: true }).fill(PAYOUT.iban);
  await form.getByLabel("BIC (optional)").fill(PAYOUT.bic);
  await form.getByRole("button", { name: "Save the payout account" }).click();

  // `setPayoutAccount` answered REAUTH_REQUIRED: the step-up dialog asks for a code, and nothing is saved yet.
  const stepUp = page.getByRole("dialog", { name: "Confirm it is you" });
  await expect(stepUp).toBeVisible();
  await expect(stepUp.getByLabel("Authentication code")).toBeFocused();
  // The modal dialog hides the page behind it from the accessibility tree, so the page's note is found by its marker.
  await expect(page.locator("[data-payout-account-none]")).toHaveText(
    /^This OTA has no payout account yet\./,
  );
  // The platform agrees: without the code nothing was stored, so the OTA still has no payout account (404).
  await expect(
    callPlatformApi({
      operation: "getPayoutAccount",
      method: "GET",
      path: `/v1/tenants/${encodeURIComponent(owned.ota.id)}/payout-account`,
      endUserIp: owner.endUserIp,
      accessToken: owned.owner.accessToken,
    }),
  ).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  await expectAccessible(page, "Payout account");

  await stepUp.getByLabel("Authentication code").fill(await owner.authenticator.nextCode());
  await stepUp.getByRole("button", { name: "Confirm" }).click();
  await expect(stepUp).toBeHidden();
});

test("the saved account shows masked and pending review [PFE-027 AC1]", async () => {
  // The form was sent again with the new session: saved, pending review, and the bank fields emptied.
  await expect(page.locator('[data-saved="pending_review"]')).toHaveText(
    "The payout account is saved and pending review. Velexis checks it before the next payout and e-mails the owners the outcome.",
  );
  await expectMaskedPendingAccount();
  const form = page.getByRole("form", { name: /payout account$/ });
  await expect(form.getByLabel("IBAN", { exact: true })).toHaveValue("");
  await expect(form.getByLabel("BIC (optional)")).toHaveValue("");
  await expectAccessible(page, "Payout account");
});

test("after a reload the account is still masked and pending, its identifiers stored encrypted only [PFE-027 AC1]", async () => {
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Payout account" })).toBeVisible();
  await expectMaskedPendingAccount();
  // The form now changes the account, and never shows the stored number again.
  const form = page.getByRole("form", { name: "Change the payout account" });
  await expect(form.getByLabel("IBAN", { exact: true })).toHaveValue("");
  await expectAccessible(page, "Payout account");

  // The platform answers the account masked too: `last4` is the only part of the number it ever answers.
  const answered = await callPlatformApi<Schemas["PayoutAccount"]>({
    operation: "getPayoutAccount",
    method: "GET",
    path: `/v1/tenants/${encodeURIComponent(owned.ota.id)}/payout-account`,
    endUserIp: owner.endUserIp,
    accessToken: owned.owner.accessToken,
  });
  expect(answered).toMatchObject({
    accountHolderName: PAYOUT.holder,
    countryCode: "NO",
    currency: owned.ota.defaultCurrency,
    scheme: "iban",
    last4: LAST4,
    status: "pending_review",
  });
  // Exactly the masked fields of `PayoutAccount`: no identifier, and no ciphertext of one, under any other name.
  expect(Object.keys(answered).sort()).toEqual([
    "accountHolderName",
    "countryCode",
    "currency",
    "last4",
    "reviewNote",
    "scheme",
    "status",
    "updatedAt",
    "version",
  ]);
  const answer = JSON.stringify(answered);
  expect(
    BANK_IDENTIFIERS.some((value) => answer.includes(value)),
    "the API's answer holds a bank identifier",
  ).toBe(false);

  // Stored encrypted (PF-64 AC1): the row keeps the last 4 characters in clear, and no form of the IBAN or the BIC is
  // in its ciphertext or any other column. Read as the platform API's own role.
  const stored = await withDatabase("platform", async (client) => {
    const { rows } = await client.query<{
      status: string;
      last4: string;
      clear_columns: string;
      identifier_in_ciphertext: boolean;
    }>(
      `SELECT status, last4,
              concat_ws(' ', account_holder_name, country_code, currency, scheme, encryption_key_id, review_note)
                AS clear_columns,
              EXISTS (SELECT 1 FROM unnest($2::text[]) AS identifier
                       WHERE position(convert_to(identifier, 'UTF8') IN bank_details_ciphertext) > 0)
                AS identifier_in_ciphertext
         FROM platform.tenant_payout_accounts
        WHERE tenant_id = $1`,
      [owned.ota.id, [...BANK_IDENTIFIERS]],
    );
    return rows[0];
  });
  expect(stored?.status).toBe("pending_review");
  expect(stored?.last4).toBe(LAST4);
  expect(stored?.identifier_in_ciphertext, "a bank identifier is in the ciphertext in clear").toBe(false);
  expect(
    BANK_IDENTIFIERS.some((value) => (stored?.clear_columns ?? "").includes(value)),
    "a bank identifier is stored in clear",
  ).toBe(false);
});
