// The portal's team journey (PFE-015 step 4; flow platform/docs/flows/team-and-ota-admin-sso.md §A and §B, PF-20,
// PF-21): the owner of an active OTA invites a second person (the link offers no "Accept" to an account with another
// address), who opens the invitation in a browser of their own, signs up with the invited address, verifies it,
// accepts, gets a new role from the owner and is removed.
//
// The owner is arranged through the platform API (`createVerifiedAccount`, `signInWithApi`); the OTA is created in
// the wizard and set up by the OTA worker, so the journey needs `E2E_WITH_OTA=1` (the e2e workflow sets it): an OTA
// takes invitations only while it is active (PADR-0014 item 5). The invited person does everything in the browser.
// Each step is a test of its own, in order (`mode: "serial"`). Tokens and passwords stay in variables.
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
  uniqueTestIp,
  type PortalAccount,
} from "../support/fixtures";
import { uniqueEmail, waitForLink } from "../support/mailpit";
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

const otaKey = `e2et${randomBytes(5).toString("hex")}`;
const otaName = `Team Travel ${otaKey.slice(4)}`;
/** The invited person: an address of their own, typed into the portal's forms by them. */
const invitee: PortalAccount = {
  ...buildAccount({ email: uniqueEmail("invitee"), fullName: "Ines Invited" }),
  endUserIp: uniqueTestIp(),
};

let ownerContext: BrowserContext;
let owner: Page;
let inviteeContext: BrowserContext;
let invited: Page;
let otaPath: string;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(ARRANGE_BUDGET_MS);
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "portal-team.e2e.ts needs an active OTA: run it with E2E_WITH_OTA=1 (the Amadeus stub and the OTA worker)",
    );
  }
  const ownerAccount = await createVerifiedAccount(
    buildAccount({ email: uniqueEmail("teamowner"), fullName: "Olga Owner" }),
  );
  ownerContext = await newAccountContext(browser, ownerAccount, PORTAL_URL);
  await addSessionCookies(ownerContext, "portal", await signInWithApi(ownerAccount));
  owner = await ownerContext.newPage();
  // The invited person's own browser (second browser context), with an end-user IP of their own.
  inviteeContext = await newAccountContext(browser, invitee, PORTAL_URL);
  invited = await inviteeContext.newPage();

  // An OTA of the owner, created in the wizard and set up.
  await owner.goto("/otas/new");
  await expectAccessible(owner, "Create an OTA");
  await owner.getByLabel("OTA name").fill(otaName);
  await owner.getByLabel("OTA key").fill(otaKey);
  await expect(owner.getByRole("status").filter({ hasText: "This key is available." })).toBeVisible();
  await owner.getByLabel("Country").selectOption("NL");
  await owner.getByLabel("Default currency").selectOption("EUR");
  await owner.getByRole("button", { name: "Continue" }).click();
  await expect(owner.getByRole("heading", { level: 2, name: "Plan" })).toBeVisible();
  await owner.getByRole("button", { name: "Continue" }).click();
  await expect(owner.getByRole("heading", { level: 2, name: "Review" })).toBeVisible();
  await owner.getByRole("button", { name: "Create OTA" }).click();
  await owner.waitForURL(/\/otas\/ten_[0-9A-HJKMNP-TV-Z]{26}\/setup$/);
  await expect(owner.getByRole("heading", { name: "Your OTA is ready" })).toBeVisible({
    timeout: PROVISIONING_BUDGET_MS,
  });
  await expectAccessible(owner, "OTA set-up");
  otaPath = new URL(owner.url()).pathname.replace(/\/setup$/, "");
});

test.afterAll(async () => {
  await inviteeContext?.close();
  await ownerContext?.close();
});

/** The link of the invitation e-mail to the invited person. */
async function invitationLink(): Promise<URL> {
  return await waitForLink({
    to: invitee.email,
    subject: `Olga Owner invited you to ${otaName} on Velexis`,
    path: "/invitations/accept",
    origin: PORTAL_URL,
  });
}

/** The value next to "Your role" on the OTA dashboard. */
function roleOnDashboard(page: Page) {
  return page.locator("dt", { hasText: /^Your role$/ }).locator("xpath=following-sibling::dd[1]");
}

/** The invited person's row in the members table. */
function memberRow() {
  return owner
    .getByRole("table", { name: "Members of this OTA" })
    .getByRole("row")
    .filter({ hasText: invitee.email });
}

test("the owner invites a second person by e-mail with a role [PFE-015 AC1, AC2]", async () => {
  await owner.goto(`${otaPath}/team`);
  await expect(owner.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();
  await expectAccessible(owner, "Team");

  // PF-20 AC1: an owner invites by e-mail, with a role.
  await owner.getByLabel("E-mail address", { exact: true }).fill(invitee.email);
  await owner.getByLabel("Role", { exact: true }).selectOption("agent");
  await owner.getByRole("button", { name: "Send the invitation" }).click();
  await expect(
    owner.getByRole("status").filter({ hasText: /^The invitation is on its way\./ }),
  ).toBeVisible();
  const pending = owner.getByRole("table", { name: "Pending invitations" }).getByRole("row").filter({
    hasText: invitee.email,
  });
  await expect(pending).toContainText("Agent");
  await expect(pending).toContainText("Olga Owner");
  await expectAccessible(owner, "Team");
});

test("an account with another address cannot accept the invitation [PFE-015 AC1, AC2]", async () => {
  // PF-20 AC3: the link works only for an account with the invited address. The owner, signed in with their own
  // address, opens it in another tab: the page names the invited address and offers no "Accept".
  const otherTab = await ownerContext.newPage();
  await otherTab.goto((await invitationLink()).href);
  await otherTab.waitForURL("/invitations/accept");
  await expect(otherTab.getByRole("heading", { level: 1, name: `Join ${otaName}` })).toBeVisible();
  await expect(otherTab.getByText("This invitation is for another address")).toBeVisible();
  await expect(
    otherTab.getByText(
      `This invitation was sent to ${invitee.email}. Sign in with that address to accept it.`,
    ),
  ).toBeVisible();
  await expect(otherTab.getByRole("button", { name: "Accept the invitation" })).toHaveCount(0);
  await expectAccessible(otherTab, "Your invitation");
  await otherTab.close();
});

test("the invited person opens the link and signs up with the invited address [PFE-015 AC1, AC2]", async () => {
  const link = await invitationLink();
  await invited.goto(link.href);
  // The token moves into a cookie and the page shows the invitation without it (PFE-012: the accept URL loses its
  // token after the first request).
  await invited.waitForURL("/invitations/accept");
  await expect(invited.getByRole("heading", { level: 1, name: `Join ${otaName}` })).toBeVisible();
  await expect(
    invited.getByText(`Olga Owner invited you to join the team of ${otaName} on Velexis.`),
  ).toBeVisible();
  await expect(invited.getByText(invitee.email)).toBeVisible();
  await expectAccessible(invited, "Your invitation");

  await invited.getByRole("link", { name: "Create an account" }).click();
  await invited.waitForURL(/\/sign-up\?/);
  await expect(invited.getByLabel("E-mail address")).toHaveValue(invitee.email);
  await expectAccessible(invited, "Sign up");
  await invited.getByLabel("Full name").fill(invitee.fullName);
  await invited.getByLabel("Password").fill(invitee.password);
  await invited.getByLabel(/I accept the terms of service/).check();
  await invited.getByRole("button", { name: "Create account" }).click();
  await invited.waitForURL("/sign-up/check-email");
  await expectAccessible(invited, "Check your e-mail");

  const verify = await waitForLink({
    to: invitee.email,
    subject: "Confirm your e-mail address for Velexis",
    path: "/verify-email",
    origin: PORTAL_URL,
  });
  await invited.goto(verify.href);
  await invited.waitForURL("/sign-in?verified=1");
  await invited.getByLabel("E-mail address").fill(invitee.email);
  await invited.getByLabel("Password", { exact: true }).fill(invitee.password);
  await invited.getByRole("button", { name: "Sign in" }).click();
  await invited.waitForURL("/dashboard");
  await expect(invited.getByRole("heading", { name: "You have no OTA yet" })).toBeVisible();
  await expectAccessible(invited, "My OTAs");
});

test("the invited person accepts and joins the OTA with the invited role [PFE-015 AC1, AC2]", async () => {
  // As the accept page told them: open the link from the e-mail again, now signed in.
  await invited.goto((await invitationLink()).href);
  await invited.waitForURL("/invitations/accept");
  await expect(invited.getByText(`You are signed in as ${invitee.email}.`)).toBeVisible();
  await expectAccessible(invited, "Your invitation");
  await invited.getByRole("button", { name: "Accept the invitation" }).click();
  await invited.waitForURL(otaPath);
  await expect(invited.getByRole("heading", { level: 1, name: otaName })).toBeVisible();
  await expect(roleOnDashboard(invited)).toHaveText("Agent");
  await expectAccessible(invited, "Overview");

  // The owner sees the new member, and no pending invitation any more.
  await owner.reload();
  await expect(memberRow()).toContainText(invitee.fullName);
  await expect(owner.getByText("No invitation is waiting to be accepted.")).toBeVisible();
  await expectAccessible(owner, "Team");
});

test("the owner changes the member's role [PFE-015 AC1, AC2]", async () => {
  // PF-21 AC1: an owner manages every role.
  await memberRow().getByLabel(`Role of ${invitee.fullName}`).selectOption("finance");
  await memberRow()
    .getByRole("button", { name: `Change role of ${invitee.fullName}` })
    .click();
  await expect(
    owner.getByRole("status").filter({ hasText: `${invitee.fullName} is now Finance.` }),
  ).toBeVisible();
  await expectAccessible(owner, "Team");

  await invited.reload();
  await expect(roleOnDashboard(invited)).toHaveText("Finance");
  await expectAccessible(invited, "Overview");
});

test("the owner removes the member, who loses the OTA [PFE-015 AC1, AC2]", async () => {
  await memberRow()
    .getByRole("button", { name: `Remove ${invitee.fullName}` })
    .click();
  const dialog = owner.getByRole("alertdialog", { name: `Remove ${invitee.fullName} from the team?` });
  await expect(dialog).toBeVisible();
  await expectAccessible(owner, "Team");
  await dialog.getByRole("button", { name: "Remove member" }).click();
  await expect(
    owner.getByRole("status").filter({ hasText: "The member was removed from the team." }),
  ).toBeVisible();
  await expect(memberRow()).toHaveCount(0);
  await expectAccessible(owner, "Team");

  // In the portal at once: the OTA is not found for them any more, and their dashboard lists no OTA.
  const response = await invited.goto(otaPath);
  expect(response?.status()).toBe(404);
  await expect(invited.getByText("This page could not be found.")).toBeVisible();
  await expectAccessible(invited, /404/);
  await invited.goto("/dashboard");
  await expect(invited.getByRole("heading", { name: "You have no OTA yet" })).toBeVisible();
  await expectAccessible(invited, "My OTAs");
});
