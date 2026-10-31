// The Velexis Amadeus accounts and the office pool from the platform admin, and what an OTA owner sees (PAD-010 step
// 3; flows/amadeus-connection.md §A to §C, PADR-0012; PF-90, PF-50): an OTA created through the portal API whose set-up
// found no available test office, so its Velexis test connection waits for one (`pending_verification`). The set-up
// runs on the OTA worker, so the journey needs `E2E_WITH_OTA=1` (the e2e workflow sets it).
//
//   the admin's OTA page and the owner's Amadeus page show the waiting connection → the admin enters the credentials of
//   the Velexis live account, which are verified against Amadeus (the stub), and its empty pool is a warning → adds
//   offices to the test pool in bulk (a repeated id skipped) → assigns one to the waiting OTA by its key → the OTA's
//   connection is active with the office, on the admin's page and on the owner's Amadeus page → retires another
//   office with a reason → three live offices end the live pool's warning, on the accounts page and the dashboard
//
// Arrangements (PADR-0017 item 5): the platform's `dev:seed` makes sure the Velexis test account exists and is active
// (idempotent: it changes nothing where it ran already); without that account a set-up creates no test connection at
// all. The waiting connection needs a set-up that finds no available office; the pool is shared by every journey of the
// run, so instead of emptying it the journey holds its available offices' row locks while its OTA is set up
// (`withAvailableOfficesHeld`, support/tenants.ts): the set-up step passes over locked offices, as it does when another
// set-up is taking them. The live environment is this journey's alone (no other journey and no seed uses it), so its
// pool levels are exact.
//
// The steps are tests in order (`mode: "serial"`): a failed step stops the rest. Every page the journey visits passes
// `expectNoSeriousA11yViolations` once its title is in place. The live account's client secret is random, typed into
// its field and never logged.
import { randomBytes } from "node:crypto";
import { type BrowserContext, type Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../support/a11y";
import {
  addSessionCookies,
  createVerifiedAccount,
  enableMfa,
  expect,
  newAccountContext,
  signInToAdminWithApi,
  signInWithApi,
  test,
  type MfaAccount,
} from "../support/fixtures";
import { buildAccount, grantPlatformAdmin, runPlatformCli, stack } from "../support/seed";
import { AMADEUS_STUB_URL, PLATFORM_ADMIN_URL, PORTAL_URL } from "../support/stack";
import { createOtaWithApi, waitForOtaStatus, withAvailableOfficesHeld, type Ota } from "../support/tenants";

test.describe.configure({ mode: "serial" });

/** Waits until `target` shows the page `title` of the admin or the portal, then runs axe. */
async function expectAccessible(
  target: Page,
  title: string,
  app: "admin" | "portal" = "admin",
): Promise<void> {
  await expect(target).toHaveTitle(`${title} · ${app === "admin" ? "Velexis admin" : "Velexis"}`);
  await expectNoSeriousA11yViolations(target);
}

/** An Amadeus office id (9 letters or digits) no other journey uses: `E2E` and 6 random hex digits. */
function uniqueOfficeId(): string {
  return `E2E${randomBytes(3).toString("hex").toUpperCase()}`;
}

/** The offices this journey adds to the test pool: one to assign, one to retire, one that stays available. */
const testOffices = { assign: uniqueOfficeId(), retire: uniqueOfficeId(), spare: uniqueOfficeId() };
const liveOffices = [uniqueOfficeId(), uniqueOfficeId(), uniqueOfficeId()];

let admin: MfaAccount;
let ota: Ota;
let adminContext: BrowserContext;
let adminPage: Page;
let ownerContext: BrowserContext;
let ownerPage: Page;

test.beforeAll(async ({ browser }) => {
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "admin-amadeus-pool.e2e.ts sets up an OTA: run it with E2E_WITH_OTA=1 (the Amadeus stub and the OTA worker)",
    );
  }
  // Budget: the platform's dev:seed (a Node process, a token request to the stub), two sign-ups with their
  // verification e-mails (up to 15 s each, in parallel), an MFA set-up, `admin:grant` and the OTA's set-up on the OTA
  // worker (about 2 s locally; PF-11 allows a minute).
  test.setTimeout(120_000);
  // Its stdout (the development admin's password and TOTP set-up URI, on a first run) is dropped unread.
  await runPlatformCli(["dev:seed"]);
  const [owner, adminAccount] = await Promise.all([
    createVerifiedAccount(buildAccount({ fullName: "Pia Pool" })),
    createVerifiedAccount(buildAccount({ fullName: "Ada Admin" })).then(enableMfa),
  ]);
  admin = adminAccount;
  const ownerSession = await signInWithApi(owner);
  const signedInOwner = { account: owner, accessToken: ownerSession.accessToken };
  const { result } = await withAvailableOfficesHeld("test", async () => {
    const created = await createOtaWithApi(signedInOwner, { name: "Pool Travel" });
    // `activate` is the set-up's last step, after `assign_amadeus_office`.
    return await waitForOtaStatus(signedInOwner, created.id, "active");
  });
  ota = result;
  await grantPlatformAdmin(admin.email);

  ownerContext = await newAccountContext(browser, owner, PORTAL_URL);
  await addSessionCookies(ownerContext, "portal", ownerSession);
  ownerPage = await ownerContext.newPage();
  adminContext = await newAccountContext(browser, admin, PLATFORM_ADMIN_URL);
  await addSessionCookies(adminContext, "admin", await signInToAdminWithApi(admin));
  adminPage = await adminContext.newPage();
});

test.afterAll(async () => {
  await adminContext.close();
  await ownerContext.close();
});

test("the OTA's test connection waits for an office, on the admin's OTA page and the owner's Amadeus page [PAD-010 AC1]", async () => {
  await adminPage.goto(`/tenants/${ota.id}?tab=connections`);
  const card = adminPage.getByRole("region", { name: "Amadeus, Test" });
  await expect(card).toContainText("Pending");
  await expect(card.getByRole("heading", { name: "Assign an office" })).toBeVisible();
  await expectAccessible(adminPage, "Tenant");

  // PF-50: the owner reads that Velexis assigns an office soon.
  await ownerPage.goto(`/otas/${ota.id}/amadeus`);
  const testCard = ownerPage.getByRole("region", { name: "Test environment" });
  await expect(testCard).toContainText("Velexis test account, no office yet, pending");
  await expect(testCard).toContainText("Velexis assigns an Amadeus office to your OTA soon.");
  await expectAccessible(ownerPage, "Amadeus", "portal");
});

test("enters the credentials of the Velexis live account, which are verified against Amadeus [PAD-010 AC1]", async () => {
  await adminPage.goto("/amadeus/accounts");
  const live = adminPage.getByRole("region", { name: "Live environment" });
  await expect(live).toContainText("There is no Velexis Amadeus account for Live yet.");
  await expectAccessible(adminPage, "Amadeus accounts");

  await live.getByRole("button", { name: "Set up the Live account" }).click();
  const form = live.getByRole("form", { name: "New Live account" });
  const clientId = `e2e-live-${randomBytes(6).toString("hex")}`;
  const secret = randomBytes(24).toString("base64url");
  await form.getByLabel("Name").fill("Velexis live (PAD-010 journey)");
  // The stack's Amadeus stub stands in for the live host; outside production an http loopback host is accepted.
  await form.getByLabel("Amadeus host").fill(AMADEUS_STUB_URL);
  await form.getByLabel("Client id").fill(clientId);
  await form.getByLabel("Client secret").fill(secret);
  await expectNoSeriousA11yViolations(adminPage);
  // PF-90: saving credentials is a step-up operation; this admin's TOTP sign-in counts for 15 minutes.
  await form.getByRole("button", { name: "Save and verify" }).click();
  await expect(live.getByText("The Live account is saved.")).toBeVisible();
  // The verification job asks the host for a token; the page asks again every 5 seconds until the result is in.
  await expect(live.getByText("Active", { exact: true })).toBeVisible({ timeout: 20_000 });
  // The client id shows its last four characters only, and the secret is nowhere on the page.
  await expect(live).toContainText("Stored encrypted, never shown");
  const html = await adminPage.content();
  expect(html).not.toContain(clientId);
  expect(html).not.toContain(secret);
  // PADR-0012 item 6: an empty pool is a warning in words.
  await expect(live.getByText("Only 0 offices are available in Live.")).toBeVisible();
  await expectAccessible(adminPage, "Amadeus accounts");
});

/** Adds `officeIds` (one per line, as typed) to the pool of the account of `environment`, from the pool page. */
async function addOffices(environment: "test" | "live", lines: readonly string[]): Promise<void> {
  await adminPage.goto(`/amadeus/offices?environment=${environment}`);
  const form = adminPage.getByRole("region", { name: "Add offices" });
  // The account of the page's environment filter is chosen first.
  await expect(form.getByLabel("Account")).toHaveValue(/^ama_/);
  await expect(form.getByLabel("Account").locator("option:checked")).toContainText(
    environment === "test" ? "(Test)" : "(Live)",
  );
  await form.getByLabel("Office ids").fill(lines.join("\n"));
  await form.getByLabel("Notes (optional)").fill("Ordered for the PAD-010 journey");
  await expectNoSeriousA11yViolations(adminPage);
  await form.getByRole("button", { name: "Add offices" }).click();
}

test("adds offices to the test pool in bulk; a repeated id is skipped [PAD-010 AC1]", async () => {
  // Lower case is upper-cased; the repeated line is skipped, not added twice.
  await addOffices("test", [
    testOffices.assign,
    testOffices.retire.toLowerCase(),
    testOffices.spare,
    testOffices.assign,
  ]);
  const outcome = adminPage.getByRole("status").filter({ hasText: "3 offices were added:" });
  await expect(outcome.getByRole("list", { name: "Added offices" }).getByRole("listitem")).toHaveText([
    testOffices.assign,
    testOffices.retire,
    testOffices.spare,
  ]);
  await expect(outcome.getByRole("list", { name: "Skipped ids" }).getByRole("listitem")).toHaveText([
    testOffices.assign,
  ]);
  // PF-90: the new offices are available at once.
  for (const officeId of Object.values(testOffices)) {
    await expect(adminPage.getByRole("row").filter({ hasText: officeId })).toContainText("Available");
  }
  await expectAccessible(adminPage, "Office pool");
});

test("assigns one of the new offices to the waiting OTA by its key [PAD-010 AC1]", async () => {
  const row = adminPage.getByRole("row").filter({ hasText: testOffices.assign });
  await row.getByRole("button", { name: `Assign office ${testOffices.assign}` }).click();
  const dialog = adminPage.getByRole("dialog", { name: `Assign office ${testOffices.assign}` });
  await dialog.getByLabel("OTA").fill(ota.key);
  await expectNoSeriousA11yViolations(adminPage);
  await dialog.getByRole("button", { name: "Assign office" }).click();

  const outcome = adminPage.getByRole("status").filter({
    hasText: `Office ${testOffices.assign} is assigned to ${ota.key}.`,
  });
  await expect(outcome).toContainText("Active");
  await expect(row).toContainText("Assigned");
  await expect(row.getByRole("link", { name: ota.key })).toBeVisible();
  await expectAccessible(adminPage, "Office pool");

  // The OTA's page follows: its test connection is active with the office, and asks for none any more.
  await adminPage.goto(`/tenants/${ota.id}?tab=connections`);
  const card = adminPage.getByRole("region", { name: "Amadeus, Test" });
  await expect(card).toContainText("Active");
  await expect(card).toContainText(testOffices.assign);
  await expect(card.getByRole("heading", { name: "Assign an office" })).toHaveCount(0);
  await expectAccessible(adminPage, "Tenant");
});

test("the owner's Amadeus page shows the office [PAD-010 AC1]", async () => {
  await ownerPage.reload();
  const testCard = ownerPage.getByRole("region", { name: "Test environment" });
  await expect(testCard).toContainText(`Velexis test account, office ${testOffices.assign}, active`);
  await expect(testCard).not.toContainText("Velexis assigns an Amadeus office to your OTA soon.");
  await expectAccessible(ownerPage, "Amadeus", "portal");
});

test("retires an available office with a reason [PAD-010 AC1]", async () => {
  await adminPage.goto("/amadeus/offices?environment=test");
  const row = adminPage.getByRole("row").filter({ hasText: testOffices.retire });
  await row.getByRole("button", { name: `Retire office ${testOffices.retire}` }).click();
  const dialog = adminPage.getByRole("dialog", { name: `Retire office ${testOffices.retire}?` });
  await dialog.getByLabel("Reason").fill("Amadeus withdrew this office id (PAD-010 journey).");
  await expectNoSeriousA11yViolations(adminPage);
  await dialog.getByRole("button", { name: "Retire office" }).click();
  await expect(adminPage.getByText(`Office ${testOffices.retire} is retired.`)).toBeVisible();
  await expect(row).toContainText("Retired");
  // A retired office is never assigned again: it offers neither action.
  await expect(row.getByRole("button", { name: /^(Assign|Retire) office/ })).toHaveCount(0);
  await expectAccessible(adminPage, "Office pool");
});

test("three live offices end the live pool's warning, on the accounts page and the dashboard [PAD-010 AC1]", async () => {
  await addOffices("live", liveOffices);
  await expect(adminPage.getByRole("status").filter({ hasText: "3 offices were added:" })).toBeVisible();

  await adminPage.goto("/amadeus/accounts");
  const live = adminPage.getByRole("region", { name: "Live environment" });
  await expect(
    live
      .getByRole("list", { name: "Offices of the Live pool by status" })
      .getByRole("link", { name: "3 Available" }),
  ).toBeVisible();
  await expect(live.getByText(/offices? (is|are) available in Live/)).toHaveCount(0);
  await expectAccessible(adminPage, "Amadeus accounts");

  await adminPage.goto("/");
  const pool = adminPage.getByRole("region", { name: "Live" });
  await expect(pool.getByRole("link", { name: /^3 available/ })).toBeVisible();
  await expect(adminPage.getByText(/offices? (is|are) available in Live/)).toHaveCount(0);
  await expectAccessible(adminPage, "Dashboard");
});
