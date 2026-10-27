// The portal's API keys journey (PFE-015 step 3; flow platform/docs/flows/api-keys.md, PF-30): the owner of an active
// OTA creates a secret test key, sees it once, reloads (the key is gone, only its prefix and last four characters
// stay), revokes it and sees it revoked.
//
// The owner is arranged through the platform API (`createVerifiedAccount`, `signInWithApi`); the OTA is created in
// the wizard and set up by the OTA worker, so the journey needs `E2E_WITH_OTA=1` (the e2e workflow sets it). Keys
// can be created only once the OTA is active (PADR-0014 item 5). Each step is a test of its own, in order
// (`mode: "serial"`). The full key stays in a variable and in the page; it is never logged.
import { randomBytes } from "node:crypto";
import { type BrowserContext, type Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../support/a11y";
import {
  addSessionCookies,
  createVerifiedAccount,
  expect,
  newAccountContext,
  signInWithApi,
  test,
} from "../support/fixtures";
import { uniqueEmail } from "../support/mailpit";
import { buildAccount, stack } from "../support/seed";
import { PORTAL_URL } from "../support/stack";

test.describe.configure({ mode: "serial" });

/**
 * Waits until `target` has the title of its page (Next.js streams a page's metadata after its content, so a page can
 * be on screen a moment before its `<title>`), then fails on any serious or critical axe violation (PFE-015 AC2).
 */
async function expectAccessible(target: Page, title: string | RegExp): Promise<void> {
  await expect(target).toHaveTitle(typeof title === "string" ? `${title} · Velexis` : title);
  await expectNoSeriousA11yViolations(target);
}

/** PF-11 AC1: an OTA is set up normally within one minute (about 2 s on a developer machine). */
const PROVISIONING_BUDGET_MS = 60_000;
/**
 * The budget of the one-time arrangement in `beforeAll` (a hook, not a step of the journey): an account through the
 * API and Mailpit, an OTA through the wizard, and its set-up (above).
 */
const ARRANGE_BUDGET_MS = PROVISIONING_BUDGET_MS + 30_000;

const KEY_NAME = "Storefront server";

let context: BrowserContext;
let page: Page;
let apiKeysPath: string;
/** The new key, as the page showed it once. */
let fullKey: string;
/** How the key shows in the list: its 14-character prefix, "…" and its last four characters (PADR-0005). */
let maskedKey: string;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(ARRANGE_BUDGET_MS);
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "portal-api-keys.e2e.ts needs an active OTA: run it with E2E_WITH_OTA=1 (the Amadeus stub and the OTA worker)",
    );
  }
  const owner = await createVerifiedAccount(
    buildAccount({ email: uniqueEmail("apikeys"), fullName: "Kim Keys" }),
  );
  context = await newAccountContext(browser, owner, PORTAL_URL);
  await addSessionCookies(context, "portal", await signInWithApi(owner));
  page = await context.newPage();

  // An OTA of the owner, created in the wizard and set up.
  const key = `e2ek${randomBytes(5).toString("hex")}`;
  await page.goto("/otas/new");
  await expectAccessible(page, "Create an OTA");
  await page.getByLabel("OTA name").fill(`Keys Travel ${key.slice(4)}`);
  await page.getByLabel("OTA key").fill(key);
  await expect(page.getByRole("status").filter({ hasText: "This key is available." })).toBeVisible();
  await page.getByLabel("Country").selectOption("FR");
  await page.getByLabel("Default currency").selectOption("EUR");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Plan" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Review" })).toBeVisible();
  await page.getByRole("button", { name: "Create OTA" }).click();
  await page.waitForURL(/\/otas\/ten_[0-9A-HJKMNP-TV-Z]{26}\/setup$/);
  await expect(page.getByRole("heading", { name: "Your OTA is ready" })).toBeVisible({
    timeout: PROVISIONING_BUDGET_MS,
  });
  await expectAccessible(page, "OTA set-up");
  apiKeysPath = new URL(page.url()).pathname.replace(/\/setup$/, "/api-keys");
});

test.afterAll(async () => {
  await context?.close();
});

/** The row of the journey's key in the test keys table. */
function keyRow() {
  return page.getByRole("table", { name: "test API keys" }).getByRole("row").filter({ hasText: KEY_NAME });
}

test("creates a secret test key and sees it once [PFE-015 AC1, AC2]", async () => {
  await page.goto(apiKeysPath);
  await expect(page.getByRole("heading", { level: 1, name: "API keys" })).toBeVisible();
  // The two test keys of the set-up are listed already.
  await expect(page.getByRole("table", { name: "test API keys" }).getByText("at set-up")).toHaveCount(2);
  await expectAccessible(page, "API keys");

  // PF-30 AC1 and AC2: a secret key (the default kind), scoped Storefront (the default use).
  await page.getByLabel("Name", { exact: true }).fill(KEY_NAME);
  await expect(page.getByLabel("Secret key", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Storefront", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "Create the key" }).click();

  const panel = page.getByRole("region", { name: "Your new secret test key" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Copy this now: it is shown only once")).toBeVisible();
  const field = panel.getByLabel(`Key “${KEY_NAME}”`, { exact: true });
  await expect(field).toHaveValue(/^sk_test_[A-Za-z0-9]{40}$/);
  fullKey = await field.inputValue();
  maskedKey = `${fullKey.slice(0, 14)}…${fullKey.slice(-4)}`;
  await expect(panel.getByText(`In the list it shows as ${maskedKey}.`)).toBeVisible();
  await expect(keyRow()).toContainText(maskedKey);
  await expect(keyRow()).toContainText("Active");
  await expectAccessible(page, "API keys");
});

test("after a reload the key is gone and only its prefix is listed [PFE-015 AC1, AC2]", async () => {
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "API keys" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Your new secret test key" })).toHaveCount(0);
  await expect(keyRow()).toContainText(maskedKey);
  await expect(keyRow()).toContainText("Never");
  // Nowhere in the page: not in the markup, not in a field. A boolean, so a failure never prints the key.
  expect((await page.content()).includes(fullKey), "the full key is still in the page").toBe(false);
  await expectAccessible(page, "API keys");
});

test("revokes the key and sees it revoked [PFE-015 AC1, AC2]", async () => {
  await keyRow()
    .getByRole("button", { name: `Revoke ${KEY_NAME} (${maskedKey})` })
    .click();
  const dialog = page.getByRole("alertdialog", { name: `Revoke “${KEY_NAME}”?` });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`Requests with ${maskedKey} stop working within a minute.`);
  await expectAccessible(page, "API keys");
  await dialog.getByRole("button", { name: "Revoke the key" }).click();
  // The list is renewed after the revocation: the key stays listed, as revoked and without actions.
  await expect(keyRow()).toContainText("Revoked");
  await expect(keyRow().getByRole("button")).toHaveCount(0);
  await expectAccessible(page, "API keys");

  await page.reload();
  await expect(keyRow()).toContainText("Revoked");
  await expect(keyRow()).toContainText(maskedKey);
  await expect(keyRow().getByRole("button")).toHaveCount(0);
  await expectAccessible(page, "API keys");
});
