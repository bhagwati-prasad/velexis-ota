// Who gets into the platform admin, from the browser (PAD-010 step 1; flows/platform-admin-operations.md §A and §H,
// PADR-0006; PF-80, PF-86, PF-87): one platform admin, whose rights `admin:grant` of the platform CLI gave
// (support/seed.ts `grantPlatformAdmin`), and one portal user with two-factor authentication but without admin rights.
//
//   the portal user is refused at the password step → the admin signs in with password and TOTP code (a wrong code
//   first) → the admins page offers no way to revoke oneself → the admin grants the portal user admin rights, who then
//   signs in with their own code → the admin revokes them: their session ends and their next sign-in is refused →
//   account support on the same person: unlock after five wrong passwords, disable and enable, reset two-factor
//   (each with the reason and step-up its operation asks for) → the admin signs out, and signing in again asks for the
//   second step again (a recovery code this time)
//
// The steps are tests in order on the admin's page (`mode: "serial"`): a failed step stops the rest. Every page the
// journey visits passes `expectNoSeriousA11yViolations` once its title is in place. The step-up of the sensitive
// actions (granting, revoking, resetting two-factor) is satisfied by the TOTP sign-in of this journey, which counts
// for 15 minutes; StepUpDialog itself is covered by the unit tests of the admin. Passwords, TOTP secrets, codes and
// recovery codes stay in variables and are never logged.
import { type BrowserContext, type Page } from "@playwright/test";
import type { components } from "@velexis/api-types/platform";
import { expectNoSeriousA11yViolations } from "../support/a11y";
import {
  callPlatformApi,
  createVerifiedAccount,
  enableMfa,
  expect,
  newAccountContext,
  PlatformApiError,
  test,
  uniqueTestIp,
  type MfaAccount,
  type PortalAccount,
} from "../support/fixtures";
import { waitForEmail } from "../support/mailpit";
import { buildAccount, grantPlatformAdmin } from "../support/seed";
import { PLATFORM_ADMIN_URL } from "../support/stack";
import { totpCode } from "../support/totp";

test.describe.configure({ mode: "serial" });

/** The admin's message for `INVALID_CREDENTIALS` (platform/admin/src/lib/strings.ts). */
const NOT_AN_ADMIN =
  "The e-mail address or password is not correct, or the account is not an active platform admin.";

/** Waits until `target` shows the page `title` (Next.js streams the title after the content), then runs axe. */
async function expectAccessible(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(`${title} · Velexis admin`);
  await expectNoSeriousA11yViolations(target);
}

/** Fills in and sends the password step of `/sign-in`. */
async function submitPassword(target: Page, account: PortalAccount): Promise<void> {
  await target.getByLabel("E-mail address").fill(account.email);
  await target.getByLabel("Password").fill(account.password);
  await target.getByRole("button", { name: "Continue" }).click();
}

/** The session cookies of the admin in `context`, by name. */
async function adminCookies(
  context: BrowserContext,
): Promise<Map<string, { httpOnly: boolean; secure: boolean }>> {
  const cookies = await context.cookies(PLATFORM_ADMIN_URL);
  return new Map(
    cookies
      .filter((cookie) => cookie.name.startsWith("__Host-vxa_"))
      .map((cookie) => [cookie.name, { httpOnly: cookie.httpOnly, secure: cookie.secure }]),
  );
}

/**
 * The password step of the portal's own sign-in (`signIn`) for `account`, from a new end-user IP each time (10
 * sign-ins per IP and minute): `mfa_challenge` when the password was accepted and a code is asked next, `session` when
 * the account has no two-factor authentication, else the error code. It never completes a TOTP step, so the account's
 * codes stay for the browser.
 */
async function portalPasswordStep(account: PortalAccount, password = account.password): Promise<string> {
  try {
    const result = await callPlatformApi<components["schemas"]["SignInResult"]>({
      operation: "signIn",
      method: "POST",
      path: "/v1/auth/sign-in",
      endUserIp: uniqueTestIp(),
      body: { email: account.email, password },
    });
    return "mfaRequired" in result ? "mfa_challenge" : "session";
  } catch (error) {
    if (error instanceof PlatformApiError) {
      return error.code ?? `HTTP ${error.status}`;
    }
    throw error;
  }
}

let admin: MfaAccount;
let member: MfaAccount;
let adminContext: BrowserContext;
let adminPage: Page;
let memberContext: BrowserContext;
let memberPage: Page;

test.beforeAll(async ({ browser }) => {
  // Budget: two sign-ups whose verification e-mails go through the outbox, the worker and SMTP (Mailpit waits up to
  // 15 s each, in parallel), two MFA set-ups and `admin:grant` through the platform CLI (a Node process of its own):
  // about 6 s locally, more on a busy CI runner.
  test.setTimeout(60_000);
  [admin, member] = await Promise.all([
    createVerifiedAccount(buildAccount({ fullName: "Ada Admin" })).then(enableMfa),
    createVerifiedAccount(buildAccount({ fullName: "Max Member" })).then(enableMfa),
  ]);
  await grantPlatformAdmin(admin.email);
  // Each person in a browser of their own, with their own end-user IP (per-IP sign-in limits).
  adminContext = await newAccountContext(browser, admin, PLATFORM_ADMIN_URL);
  adminPage = await adminContext.newPage();
  memberContext = await newAccountContext(browser, member, PLATFORM_ADMIN_URL);
  memberPage = await memberContext.newPage();
});

test.afterAll(async () => {
  await adminContext.close();
  await memberContext.close();
});

test("a portal user without platform admin rights is refused at the password step [PAD-010 AC1]", async () => {
  await memberPage.goto("/sign-in");
  await expect(memberPage.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  await expectAccessible(memberPage, "Sign in");

  // PF-80: only platform admins with MFA; a correct password of anyone else reads like a wrong one.
  await submitPassword(memberPage, member);
  await expect(memberPage.getByText(NOT_AN_ADMIN)).toBeVisible();
  expect(new URL(memberPage.url()).pathname).toBe("/sign-in");
  expect([...(await adminCookies(memberContext)).keys()]).toEqual([]);
  await expectAccessible(memberPage, "Sign in");

  // Without a session every page of the console leads to the sign-in.
  await memberPage.goto("/tenants");
  await memberPage.waitForURL(
    (url) => url.pathname === "/sign-in" && url.searchParams.get("next") === "/tenants",
  );
});

test("a platform admin signs in with the password, then a code of the authenticator app [PAD-010 AC1]", async () => {
  await adminPage.goto("/sign-in");
  await submitPassword(adminPage, admin);
  await adminPage.waitForURL("/sign-in/mfa");
  await expect(adminPage.getByRole("heading", { level: 1, name: "Two-factor authentication" })).toBeVisible();
  await expectAccessible(adminPage, "Two-factor authentication");
  // The password step wrote no session, only the short-lived challenge.
  expect([...(await adminCookies(adminContext)).keys()]).toEqual(["__Host-vxa_mfa"]);

  // A code of ten minutes ago is outside the ±30 s window: refused at the field, still on the second step.
  const code = adminPage.getByLabel("Authentication code");
  await code.fill(totpCode(admin.authenticator.secret, Date.now() - 10 * 60_000));
  await adminPage.getByRole("button", { name: "Verify and sign in" }).click();
  await expect(adminPage.getByText("The code is not correct.").first()).toBeVisible();
  await expect(code).toHaveAttribute("aria-invalid", "true");
  await expectAccessible(adminPage, "Two-factor authentication");

  await code.fill(await admin.authenticator.nextCode());
  await adminPage.getByRole("button", { name: "Verify and sign in" }).click();
  await adminPage.waitForURL("/");
  await expect(adminPage.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expect(adminPage.getByText(admin.email).first()).toBeVisible();
  await expectAccessible(adminPage, "Dashboard");

  // PF-80: the session lives in httpOnly, Secure cookies of the admin only.
  const cookies = await adminCookies(adminContext);
  for (const name of ["__Host-vxa_at", "__Host-vxa_rt"]) {
    expect(cookies.get(name), name).toEqual({ httpOnly: true, secure: true });
  }
});

test("the platform admins page lists the admin as You, with no way to revoke their own rights [PAD-010 AC1]", async () => {
  await adminPage.goto("/admins");
  await expect(adminPage.getByRole("heading", { level: 1, name: "Platform admins" })).toBeVisible();
  const own = adminPage.getByRole("row").filter({ hasText: admin.email });
  await expect(own).toContainText("You");
  // PF-86: revoking oneself is not offered; the disabled button says why.
  const revoke = own.getByRole("button", { name: `Revoke the admin rights of ${admin.fullName}` });
  await expect(revoke).toBeDisabled();
  await expect(revoke).toHaveAccessibleDescription("You cannot revoke your own admin rights.");
  await expectAccessible(adminPage, "Platform admins");
});

test("grants admin rights to the portal user with a reason, who then signs in with their own code [PAD-010 AC1]", async () => {
  await adminPage.getByRole("button", { name: "Grant admin rights" }).click();
  const dialog = adminPage.getByRole("dialog", { name: "Grant platform admin rights" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("E-mail address of the account").fill(member.email);
  await dialog.getByLabel("Reason").fill("Joins the Velexis operations team (PAD-010 journey).");
  await expectNoSeriousA11yViolations(adminPage);
  await dialog.getByRole("button", { name: "Grant admin rights" }).click();
  await expect(adminPage.getByText(`${member.fullName} is now a platform admin.`)).toBeVisible();
  await expect(adminPage.getByRole("row").filter({ hasText: member.email })).toBeVisible();
  await expectAccessible(adminPage, "Platform admins");

  // PF-80 and PF-86: the new admin signs in like any admin, with their own authenticator.
  await memberPage.goto("/sign-in");
  await submitPassword(memberPage, member);
  await memberPage.waitForURL("/sign-in/mfa");
  await memberPage.getByLabel("Authentication code").fill(await member.authenticator.nextCode());
  await memberPage.getByRole("button", { name: "Verify and sign in" }).click();
  await memberPage.waitForURL("/");
  await expect(memberPage.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expectAccessible(memberPage, "Dashboard");
});

test("revoking the rights ends the other admin's session and refuses their next sign-in [PAD-010 AC1]", async () => {
  const row = adminPage.getByRole("row").filter({ hasText: member.email });
  await row.getByRole("button", { name: `Revoke the admin rights of ${member.fullName}` }).click();
  const dialog = adminPage.getByRole("alertdialog", {
    name: `Revoke the admin rights of ${member.fullName}?`,
  });
  await expect(dialog).toBeVisible();
  await expectNoSeriousA11yViolations(adminPage);
  await dialog.getByRole("button", { name: "Revoke admin rights" }).click();
  await expect(adminPage.getByText(`${member.fullName} is no longer a platform admin.`)).toBeVisible();
  await expect(adminPage.getByRole("row").filter({ hasText: member.email })).toHaveCount(0);

  // PF-86: the revoked admin's next page goes to the sign-in, which refuses them now.
  await memberPage.goto("/tenants");
  await memberPage.waitForURL((url) => url.pathname === "/sign-in");
  await memberPage.goto("/sign-in");
  await submitPassword(memberPage, member);
  await expect(memberPage.getByText(NOT_AN_ADMIN)).toBeVisible();
});

/** Opens the account page of `account` from the account search, by e-mail address. */
async function openAccount(account: PortalAccount): Promise<void> {
  await adminPage.goto("/accounts");
  await adminPage.getByRole("searchbox", { name: "Search" }).fill(account.email);
  await adminPage.getByRole("button", { name: "Search" }).click();
  await adminPage.waitForURL((url) => url.searchParams.get("q") === account.email);
  await expectAccessible(adminPage, "Accounts");
  await adminPage.getByRole("link", { name: account.fullName }).click();
  await expect(adminPage.getByRole("heading", { level: 1, name: account.fullName })).toBeVisible();
  await expectAccessible(adminPage, "Account");
}

/** Runs the reason action `button` of the account page with `reason`, through its dialog's `confirm` button. */
async function reasonAction(button: string, confirm: string, reason: string): Promise<void> {
  await adminPage.getByRole("button", { name: button, exact: true }).click();
  const dialog = adminPage.getByRole("dialog");
  await dialog.getByLabel("Reason").fill(reason);
  await expectNoSeriousA11yViolations(adminPage);
  await dialog.getByRole("button", { name: confirm }).click();
}

test("unlocks an account that five wrong passwords locked [PAD-010 AC1]", async () => {
  // Five wrong passwords in a row lock the account for 15 minutes (ADR-0008 "Lockout"): the fifth answers the lockout,
  // and then the right password is refused too.
  const wrong = `${member.password}-wrong`;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    expect(await portalPasswordStep(member, wrong)).toBe("INVALID_CREDENTIALS");
  }
  expect(await portalPasswordStep(member, wrong)).toBe("ACCOUNT_LOCKED");
  expect(await portalPasswordStep(member)).toBe("ACCOUNT_LOCKED");

  await openAccount(member);
  // "Locked until" shows the end of the lockout instead of "Not locked".
  await expect(adminPage.getByText("Locked until")).toBeVisible();
  await expect(adminPage.getByText("Not locked")).toHaveCount(0);
  // PF-87: unlocking asks for no reason and no step-up, only a confirmation.
  await adminPage.getByRole("button", { name: "Unlock", exact: true }).click();
  const dialog = adminPage.getByRole("alertdialog", { name: `Unlock ${member.fullName}?` });
  await expect(dialog.getByLabel("Reason")).toHaveCount(0);
  await expectNoSeriousA11yViolations(adminPage);
  await dialog.getByRole("button", { name: "Unlock account" }).click();
  await expect(adminPage.getByText("The account is unlocked.")).toBeVisible();
  await expect(adminPage.getByText("Not locked")).toBeVisible();
  expect(await portalPasswordStep(member)).toBe("mfa_challenge");
});

test("disables and enables the account, each with a reason [PAD-010 AC1]", async () => {
  await reasonAction("Disable", "Disable account", "Reported a stolen laptop; disabled until it is wiped.");
  await expect(adminPage.getByText("The account is disabled.")).toBeVisible();
  expect(await portalPasswordStep(member)).toBe("ACCOUNT_DISABLED");
  await expectAccessible(adminPage, "Account");

  await reasonAction("Enable", "Enable account", "The laptop is wiped; the person may sign in again.");
  await expect(adminPage.getByText("The account is enabled again.")).toBeVisible();
  expect(await portalPasswordStep(member)).toBe("mfa_challenge");
});

test("resets two-factor authentication with a reason; the person is e-mailed and signs in without a code [PAD-010 AC1]", async () => {
  await reasonAction(
    "Reset two-factor",
    "Reset two-factor authentication",
    "Lost phone; identity checked on a video call with the owner.",
  );
  await expect(
    adminPage.getByText(
      "Two-factor authentication is turned off for this account, and the person got an e-mail.",
    ),
  ).toBeVisible();
  await expectAccessible(adminPage, "Account");
  // PF-87: the person is told by e-mail, and the next sign-in asks for no code.
  await waitForEmail({ to: member.email, subject: /two-factor/i });
  expect(await portalPasswordStep(member)).toBe("session");
});

test("signing out ends the session, and the next sign-in asks for the second step again [PAD-010 AC1]", async () => {
  await adminPage.goto("/");
  await adminPage.getByRole("button", { name: "Sign out" }).click();
  await adminPage.waitForURL("/sign-in?signedOut=1");
  await expect(adminPage.getByText("You are signed out.")).toBeVisible();
  await expectAccessible(adminPage, "Sign in");
  expect([...(await adminCookies(adminContext)).keys()]).toEqual([]);

  // PF-80: a code on every sign-in, also right after the last one; here one of the recovery codes.
  await submitPassword(adminPage, admin);
  await adminPage.waitForURL("/sign-in/mfa");
  await adminPage.getByRole("button", { name: "Use a recovery code instead" }).click();
  const recoveryCode = admin.recoveryCodes[0];
  if (recoveryCode === undefined) {
    throw new Error("enableMfa showed no recovery code");
  }
  await adminPage.getByLabel("Recovery code").fill(recoveryCode);
  await expectAccessible(adminPage, "Two-factor authentication");
  await adminPage.getByRole("button", { name: "Verify and sign in" }).click();
  await adminPage.waitForURL("/");
  await expect(adminPage.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
});
