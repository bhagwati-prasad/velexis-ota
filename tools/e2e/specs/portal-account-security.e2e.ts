// The portal's account security journey (PFE-015 step 2; PF-03, PF-05, PF-06, PF-07): a verified account forgets its
// password, resets it through the link from Mailpit and signs in with the new one; it edits its profile, and a stale
// save from a second tab is refused; two other browsers sign in, the security page lists the three sessions and
// revokes one, and "Sign out everywhere" ends this session and the other browser's.
//
// The account is arranged through the platform API (`createVerifiedAccount`); every page of the journey is driven in
// the browser. Each step is a test of its own, in order (`mode: "serial"`). The passwords and the reset link stay in
// variables; nothing of them is logged.
import { type BrowserContext, type Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../support/a11y";
import {
  createVerifiedAccount,
  expect,
  newAccountContext,
  test,
  uniqueTestIp,
  type PortalAccount,
} from "../support/fixtures";
import { uniqueEmail, waitForLink } from "../support/mailpit";
import { buildAccount, newPassword } from "../support/seed";
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

const ACCESS_COOKIE = "__Host-vxp_at";
const REFRESH_COOKIE = "__Host-vxp_rt";

let account: PortalAccount;
const newPasswordValue = newPassword();
/** The person's own browser, and another browser (another device) signed in to the same account. */
let context: BrowserContext;
let page: Page;
let otherContext: BrowserContext;

test.beforeAll(async ({ browser }) => {
  account = await createVerifiedAccount(
    buildAccount({ email: uniqueEmail("security"), fullName: "Robin Reset" }),
  );
  context = await newAccountContext(browser, account, PORTAL_URL);
  page = await context.newPage();
});

test.afterAll(async () => {
  await otherContext?.close();
  await context?.close();
});

/**
 * Waits until `target` shows `pathAndQuery` after a redirect of the portal's middleware. Next.js writes the loopback
 * address 127.0.0.1 of a middleware redirect as `localhost` (`NextURL`), so on the stack such a redirect leaves the
 * host the journey's cookies belong to; only the path and the query are compared, and the journey comes back to
 * PORTAL_URL afterwards. On the VM the portal's own domain is kept.
 */
async function waitForRedirect(target: Page, pathAndQuery: string): Promise<void> {
  await target.waitForURL((url) => `${url.pathname}${url.search}` === pathAndQuery);
}

/** Signs `target` in on /sign-in with `password` and waits for the dashboard. */
async function signIn(target: Page, password: string): Promise<void> {
  await target.goto("/sign-in");
  await target.getByLabel("E-mail address").fill(account.email);
  await target.getByLabel("Password", { exact: true }).fill(password);
  await target.getByRole("button", { name: "Sign in" }).click();
  await target.waitForURL("/dashboard");
  await expect(target.getByRole("heading", { level: 1, name: "My OTAs" })).toBeVisible();
}

test("asks for a reset link on the forgot-password page [PFE-015 AC1, AC2]", async () => {
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to Velexis" })).toBeVisible();
  await expectAccessible(page, "Sign in");
  await page.getByRole("link", { name: "Forgot your password?" }).click();
  await page.waitForURL("/forgot-password");
  await expect(page.getByRole("heading", { level: 1, name: "Reset your password" })).toBeVisible();
  await expectAccessible(page, "Reset your password");

  // PF-05 AC1: the same confirmation for every address. First an address that has no account, then the account's.
  const confirmation = page
    .getByRole("status")
    .filter({ hasText: /^If an account uses this address, we sent/ });
  await page.getByLabel("E-mail address").fill(uniqueEmail("nobody"));
  await page.getByRole("button", { name: "Send the reset link" }).click();
  await expect(confirmation).toBeVisible();
  const unknownAddressAnswer = await confirmation.innerText();
  await expectAccessible(page, "Reset your password");

  await page.goto("/forgot-password");
  await expect(confirmation).toHaveCount(0);
  await page.getByLabel("E-mail address").fill(account.email);
  await page.getByRole("button", { name: "Send the reset link" }).click();
  await expect(confirmation).toHaveText(unknownAddressAnswer);
  await expectAccessible(page, "Reset your password");
});

test("resets the password through the link from Mailpit and signs in with the new one [PFE-015 AC1, AC2]", async () => {
  const link = await waitForLink({
    to: account.email,
    subject: "Reset your Velexis password",
    path: "/reset-password",
    origin: PORTAL_URL,
  });
  // The token moves into a cookie and the page continues on the URL without it.
  await page.goto(link.href);
  await page.waitForURL("/reset-password");
  await expect(page.getByRole("heading", { level: 1, name: "Choose a new password" })).toBeVisible();
  await expectAccessible(page, "Choose a new password");

  await page.getByLabel("New password").fill(newPasswordValue);
  await page.getByRole("button", { name: "Save the new password" }).click();
  await page.waitForURL("/sign-in?reset=1");
  await expect(
    page.getByText(/^Your password is changed and every session of your account was signed out/),
  ).toBeVisible();
  await expectAccessible(page, "Sign in");

  // The link works once.
  await page.goto(link.href);
  await page.waitForURL("/reset-password");
  await page.getByLabel("New password").fill(newPassword());
  await page.getByRole("button", { name: "Save the new password" }).click();
  // The refused token's cookie is deleted, so the page asks for the link again and offers a new one.
  await expect(page.getByRole("heading", { level: 1, name: "Open the link from your e-mail" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ask for a new link" })).toHaveAttribute(
    "href",
    "/forgot-password",
  );
  await expectAccessible(page, "Choose a new password");

  // PF-03 AC2: the old password no longer works, with the message of a wrong password.
  await page.goto("/sign-in");
  await page.getByLabel("E-mail address").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("The e-mail address or password is not correct.")).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expectAccessible(page, "Sign in");

  await signIn(page, newPasswordValue);
  await expectAccessible(page, "My OTAs");
});

test("edits the profile, and a save from a stale tab is refused [PFE-015 AC1, AC2]", async () => {
  await page.goto("/account");
  await expect(page.getByRole("heading", { level: 1, name: "Your profile" })).toBeVisible();
  await expectAccessible(page, "Your profile");
  // A second tab of the same browser, opened on the same version of the profile.
  const staleTab = await context.newPage();
  await staleTab.goto("/account");
  await expect(staleTab.getByLabel("Full name")).toHaveValue(account.fullName);

  // PF-07 AC1: the name is saved with the version the page was loaded with.
  await page.getByLabel("Full name").fill("Robin Renamed");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Your profile is saved." })).toBeVisible();
  await expectAccessible(page, "Your profile");
  await page.reload();
  await expect(page.getByLabel("Full name")).toHaveValue("Robin Renamed");

  // The other tab still holds the old version: its save is refused, and what was typed stays.
  await staleTab.getByLabel("Full name").fill("Robin Stale");
  await staleTab.getByRole("button", { name: "Save changes" }).click();
  await expect(staleTab.getByText(/^Your profile was changed in another tab or session/)).toBeVisible();
  await expect(staleTab.getByRole("link", { name: "Reload the page" })).toBeVisible();
  await expect(staleTab.getByLabel("Full name")).toHaveValue("Robin Stale");
  await expectAccessible(staleTab, "Your profile");
  await staleTab.close();
  await page.reload();
  await expect(page.getByLabel("Full name")).toHaveValue("Robin Renamed");
});

test("the security page lists the sessions and revokes one [PFE-015 AC1, AC2]", async ({ browser }) => {
  // Two other devices, each a browser context of its own with its own address, signed in through the sign-in page.
  otherContext = await newAccountContext(browser, account, PORTAL_URL);
  await signIn(await otherContext.newPage(), newPasswordValue);
  const phone = { ...account, endUserIp: uniqueTestIp() };
  const phoneContext = await newAccountContext(browser, phone, PORTAL_URL);
  const phonePage = await phoneContext.newPage();
  await signIn(phonePage, newPasswordValue);

  // PF-06 AC1: every active session with its device, address and times; this browser's is marked and has no "Revoke".
  await page.goto("/account/security");
  await expect(page.getByRole("heading", { level: 1, name: "Security" })).toBeVisible();
  const sessions = page.getByRole("table", { name: "Active sessions" });
  await expect(sessions.getByRole("row")).toHaveCount(4); // the header row and three sessions
  await expect(sessions.getByRole("row").filter({ hasText: "This browser" })).toHaveCount(1);
  await expect(sessions.getByRole("button", { name: /^Revoke/ })).toHaveCount(2);
  await expectAccessible(page, "Security");

  const phoneRow = sessions.getByRole("row").filter({ hasText: phone.endUserIp });
  await phoneRow.getByRole("button", { name: /^Revoke/ }).click();
  const dialog = page.getByRole("alertdialog", { name: "Revoke this session?" });
  await expect(dialog).toBeVisible();
  await expectAccessible(page, "Security");
  await dialog.getByRole("button", { name: "Revoke session" }).click();
  await expect(page.getByRole("status").filter({ hasText: "The session is revoked." })).toBeVisible();
  await expect(phoneRow).toHaveCount(0);
  await expect(sessions.getByRole("row")).toHaveCount(3);
  await expectAccessible(page, "Security");

  // The phone's refresh family is revoked. Its access token is a 15-minute JWT whose cookie the browser drops when it
  // expires (ADR-0008); the journey drops it now instead of waiting, so the next page has to renew the session, which
  // the platform refuses: the phone is signed out and its session cookies are deleted.
  await phoneContext.clearCookies({ name: ACCESS_COOKIE });
  await phonePage.goto("/account");
  await waitForRedirect(phonePage, "/sign-in?next=%2Faccount");
  expect((await phoneContext.cookies(PORTAL_URL)).map((cookie) => cookie.name)).not.toContain(REFRESH_COOKIE);
  await phoneContext.close();
});

test("sign out everywhere ends this session and the other browser's [PFE-015 AC1, AC2]", async () => {
  const otherPage = otherContext.pages()[0];
  if (otherPage === undefined) {
    throw new Error("the other browser has no page");
  }
  await otherPage.goto("/account");
  await expect(otherPage.getByRole("heading", { level: 1, name: "Your profile" })).toBeVisible();

  // PF-06 AC2.
  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Sign out everywhere?" });
  await expect(dialog).toBeVisible();
  await expectAccessible(page, "Security");
  await dialog.getByRole("button", { name: "Sign out everywhere" }).click();
  await page.waitForURL("/sign-in?signedOut=1");
  await expect(page.getByText("You are signed out.")).toBeVisible();
  await expectAccessible(page, "Sign in");
  await page.goto("/dashboard");
  await waitForRedirect(page, "/sign-in?next=%2Fdashboard");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to Velexis" })).toBeVisible();

  // The other browser's refresh family is revoked too: once its access token is gone (as for the phone above), the
  // next page has to renew the session, which the platform refuses, and its session cookies are deleted.
  expect((await otherContext.cookies(PORTAL_URL)).map((cookie) => cookie.name)).toContain(REFRESH_COOKIE);
  await otherContext.clearCookies({ name: ACCESS_COOKIE });
  await otherPage.goto("/account");
  await waitForRedirect(otherPage, "/sign-in?next=%2Faccount");
  await expect(otherPage.getByRole("heading", { level: 1, name: "Sign in to Velexis" })).toBeVisible();
  const left = (await otherContext.cookies(PORTAL_URL)).map((cookie) => cookie.name);
  expect(left).not.toContain(REFRESH_COOKIE);
  expect(left).not.toContain(ACCESS_COOKIE);
  await otherPage.goto("/sign-in?next=%2Faccount");
  await expectAccessible(otherPage, "Sign in");
});
