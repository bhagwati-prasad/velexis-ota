// The portal's MFA enrolment gate (PFE-030 step 4; scope PF-04 AC4, PADR-0008 revision of 2026-11-05,
// platform/frontend/README.md §2 `/mfa-enrolment`), project `portal`:
//
//   an admin invited to an OTA that then goes live signs in without MFA → the portal shows only the enrolment page,
//   with the page asked for as `next` → an OTA page typed into the address bar sends the browser back to it → the
//   admin sets up two-factor authentication with a TOTP code, sees the ten recovery codes and continues to the OTA page
//   it asked for, which now renders; the enrolment page then leads straight on → an agent of the same live OTA signs in
//   without MFA and is never asked
//
// Arranged in `beforeAll` through the platform API (PADR-0017 item 5): the owner's active OTA, set up by the OTA worker
// (`newOwnerWithActiveOta` with MFA, so the journey needs `E2E_WITH_OTA=1` and fails at once without it); the admin and
// the agent, verified accounts without MFA that the owner invites (createInvitation) and that accept with the token of
// their invitation e-mail (acceptInvitation) while the OTA is still in test mode; then the OTA goes live as OFE-022's
// helpers of support/ota.ts take it there: `meetLivePreconditions` gives it a plan with live mode and makes its manual
// subscription `active` through the platform admin API as a platform admin of the journey's own (`newHarnessAdmin`),
// meets what no API reaches (its own live Amadeus connection, Stripe Connect) as velexis_migrator fixtures, and the
// owner's real goLive switches it, with MFA and a step-up.
// From then on the admin is an active admin of a live OTA without MFA: PBE-071's rule, which the portal only reads.
//
// Every page the journey visits passes axe once its title is in place. The TOTP secret and the recovery codes stay in
// variables, never logged. The steps are tests in order on one browser context per person (`mode: "serial"`).
import type { BrowserContext, Page } from "@playwright/test";
import type { components } from "@velexis/api-types/platform";
import { expectNoSeriousA11yViolations } from "../support/a11y";
import {
  callPlatformApi,
  createVerifiedAccount,
  expect,
  newAccountContext,
  signInWithApi,
  test,
  type PortalAccount,
} from "../support/fixtures";
import { waitForLink } from "../support/mailpit";
import {
  goLiveAttempt,
  meetLivePreconditions,
  newHarnessAdmin,
  newOwnerWithActiveOta,
  stepUpWithApi,
  uniqueLiveOfficeId,
  type OwnedOta,
} from "../support/ota";
import { buildAccount, stack } from "../support/seed";
import { PORTAL_URL } from "../support/stack";
import { Authenticator } from "../support/totp";

test.describe.configure({ mode: "serial" });

type Schemas = components["schemas"];

/**
 * The budget of the one-time arrangement in `beforeAll` (a hook, not a step of the journey): four accounts through the
 * platform API and Mailpit (up to 15 s each for the verification and the invitation e-mails; the fourth is the platform
 * admin of `newHarnessAdmin`, with MFA and `admin:grant`), the OTA's set-up on the OTA worker (about 2 s, at most 45 s
 * per OTA, and up to three OTAs while admin-amadeus-pool.e2e.ts holds the test pool), the go-live preconditions and
 * goLive.
 */
const ARRANGE_BUDGET_MS = 180_000;

/** The owner's name: the inviter in the invitation e-mails' subject. */
const OWNER_NAME = "Gwen Gatekeeper";

/** The portal's title of a page (`%s · Velexis`). */
const portalTitle = (title: string): string => `${title} · Velexis`;

/** Waits until `target` has the title of its page, then fails on any serious or critical axe violation. */
async function expectAccessible(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(portalTitle(title));
  await expectNoSeriousA11yViolations(target);
}

/** The path and query of `target`'s address, which a redirect of the portal leaves on the stack's host. */
function pathAndQuery(target: Page): string {
  const url = new URL(target.url());
  return `${url.pathname}${url.search}`;
}

/** `/mfa-enrolment?next=<path>`, as the portal writes it. */
function enrolmentPath(next: string): string {
  return `/mfa-enrolment?${new URLSearchParams({ next }).toString()}`;
}

/** A verified account (no MFA) that the owner invites as `role` and that accepts with its invitation e-mail's token. */
async function invitedMember(
  owned: OwnedOta,
  role: "admin" | "agent",
  fullName: string,
): Promise<PortalAccount> {
  const account = await createVerifiedAccount(buildAccount({ fullName }));
  const invite: Schemas["CreateInvitationRequest"] = { email: account.email, role };
  await callPlatformApi<Schemas["Invitation"]>({
    operation: "createInvitation",
    method: "POST",
    path: `/v1/tenants/${encodeURIComponent(owned.ota.id)}/invitations`,
    endUserIp: owned.owner.account.endUserIp,
    accessToken: owned.owner.accessToken,
    body: invite,
  });
  // The invitation, not the verification e-mail that went to the same address before it.
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
  const accept: Schemas["InvitationTokenRequest"] = { token };
  await callPlatformApi<Schemas["InvitationAccepted"]>({
    operation: "acceptInvitation",
    method: "POST",
    path: "/v1/invitations/accept",
    endUserIp: account.endUserIp,
    accessToken: (await signInWithApi(account)).accessToken,
    body: accept,
  });
  return account;
}

/** Signs `account` in on `/sign-in?next=<next>` in `target`'s browser (the address and the password). */
async function signIn(target: Page, account: PortalAccount, next: string): Promise<void> {
  await target.goto(`/sign-in?${new URLSearchParams({ next }).toString()}`);
  await expect(target.getByRole("heading", { level: 1, name: "Sign in to Velexis" })).toBeVisible();
  await expectAccessible(target, "Sign in");
  await target.getByLabel("E-mail address").fill(account.email);
  await target.getByLabel("Password", { exact: true }).fill(account.password);
  await target.getByRole("button", { name: "Sign in" }).click();
}

let owned: OwnedOta;
let admin: PortalAccount;
let agent: PortalAccount;
let adminContext: BrowserContext;
let adminPage: Page;
let agentContext: BrowserContext;
let agentPage: Page;
/** `/otas/<tenantId>` and its team page. */
let overviewPath: string;
let teamPath: string;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(ARRANGE_BUDGET_MS);
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "portal-mfa-enrolment.e2e.ts needs an active OTA: run it with E2E_WITH_OTA=1 (the Amadeus stub and the OTA worker)",
    );
  }
  owned = await newOwnerWithActiveOta(OWNER_NAME, "mfagate", { mfa: true });
  overviewPath = `/otas/${owned.ota.id}`;
  teamPath = `${overviewPath}/team`;
  admin = await invitedMember(owned, "admin", "Ada Enrolling");
  agent = await invitedMember(owned, "agent", "Arne Agent");

  // The OTA goes live: its plan and subscription through the admin API and the fixtures of what no API reaches, then
  // the owner's goLive with a step-up.
  await meetLivePreconditions(owned, uniqueLiveOfficeId(), await newHarnessAdmin("Mats Enrolment Admin"));
  const wentLive = await goLiveAttempt(await stepUpWithApi(owned.owner), owned.ota.id);
  expect(wentLive).toEqual({ status: 200, storefrontEnvironment: "live" });

  adminContext = await newAccountContext(browser, admin, PORTAL_URL);
  adminPage = await adminContext.newPage();
  agentContext = await newAccountContext(browser, agent, PORTAL_URL);
  agentPage = await agentContext.newPage();
});

test.afterAll(async () => {
  await adminContext?.close();
  await agentContext?.close();
});

test("the admin of the live OTA signs in without MFA and sees only the enrolment page [PFE-030 AC1] [PF-04 AC4]", async () => {
  await signIn(adminPage, admin, overviewPath);

  // The sign-in continues to the OTA, and the signed-in layout sends the admin on to the enrolment, with the OTA as next.
  await adminPage.waitForURL((url) => `${url.pathname}${url.search}` === enrolmentPath(overviewPath));
  await expect(
    adminPage.getByRole("heading", { level: 1, name: "Set up two-factor authentication" }),
  ).toBeVisible();
  await expect(adminPage.getByText(/^You are an owner or an admin of an OTA that is live/)).toBeVisible();
  await expect(adminPage.getByRole("button", { name: "Set up two-factor authentication" })).toBeVisible();
  await expect(adminPage.getByRole("button", { name: "Sign out" })).toBeVisible();
  // No page of the signed-in area rendered: no shell, no OTA switcher, nothing of the OTA's pages.
  await expect(adminPage.getByRole("navigation")).toHaveCount(0);
  await expect(adminPage.getByRole("button", { name: /^Switch OTA/ })).toHaveCount(0);
  await expectAccessible(adminPage, "Set up two-factor authentication");
});

test("an OTA page asked for directly sends the admin back to the enrolment, with that page as next [PFE-030 AC1]", async () => {
  await adminPage.goto(teamPath);

  await adminPage.waitForURL((url) => `${url.pathname}${url.search}` === enrolmentPath(teamPath));
  await expect(
    adminPage.getByRole("heading", { level: 1, name: "Set up two-factor authentication" }),
  ).toBeVisible();
  await expect(adminPage.getByRole("heading", { level: 1, name: "Team" })).toHaveCount(0);
  await expectAccessible(adminPage, "Set up two-factor authentication");
});

test("the admin enrols with a TOTP code, sees the recovery codes once and continues to the OTA page [PFE-030 AC1] [PF-04 AC1, AC4]", async () => {
  await adminPage.getByRole("button", { name: "Set up two-factor authentication" }).click();
  await expect(adminPage.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  const authenticator = new Authenticator(
    await adminPage.getByLabel("Or enter this key in the app").inputValue(),
  );
  await expectAccessible(adminPage, "Set up two-factor authentication");

  await adminPage.getByLabel("Authentication code").fill(await authenticator.nextCode());
  await adminPage.getByRole("button", { name: "Turn on two-factor authentication" }).click();

  // MFA is on: the ten recovery codes, shown once, and "Continue" to the page the admin asked for.
  await expect(adminPage.getByRole("heading", { name: "Two-factor authentication is on" })).toBeVisible();
  await expect(adminPage.getByRole("heading", { name: "Your recovery codes" })).toBeVisible();
  for (let position = 1; position <= 10; position += 1) {
    await expect(adminPage.getByLabel(`Recovery code ${position}`, { exact: true })).not.toHaveValue("");
  }
  await expect(adminPage.getByLabel("Recovery code 11", { exact: true })).toHaveCount(0);
  await expect(adminPage.getByLabel("Or enter this key in the app")).toHaveCount(0);
  await expectAccessible(adminPage, "Set up two-factor authentication");

  await adminPage.getByRole("link", { name: "Continue" }).click();
  await adminPage.waitForURL((url) => url.pathname === teamPath);
  await expect(adminPage.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();
  // The API answers the admin's portal operations again: the team page lists the members.
  await expect(adminPage.getByRole("cell", { name: admin.email, exact: true })).toBeVisible();
  await expectAccessible(adminPage, "Team");

  // The enrolment is over: its page leads straight on, and the recovery codes are not shown again.
  await adminPage.goto("/mfa-enrolment");
  await adminPage.waitForURL((url) => url.pathname === "/dashboard");
  await expect(adminPage.getByRole("heading", { level: 1, name: "My OTAs" })).toBeVisible();
  await expect(adminPage.getByRole("heading", { name: "Your recovery codes" })).toHaveCount(0);
  await expectAccessible(adminPage, "My OTAs");
  expect(pathAndQuery(adminPage)).toBe("/dashboard");
});

test("an agent of the same live OTA signs in without MFA and is never asked to enrol [PFE-030 AC2]", async () => {
  await signIn(agentPage, agent, overviewPath);

  await agentPage.waitForURL((url) => url.pathname === overviewPath);
  await expect(agentPage.getByRole("heading", { level: 1, name: owned.ota.name })).toBeVisible();
  await expect(agentPage.getByRole("heading", { name: "Set up two-factor authentication" })).toHaveCount(0);
  await expectAccessible(agentPage, "Overview");

  await agentPage.goto(teamPath);
  await expect(agentPage.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();
  expect(pathAndQuery(agentPage)).toBe(teamPath);
  await expectAccessible(agentPage, "Team");
});
