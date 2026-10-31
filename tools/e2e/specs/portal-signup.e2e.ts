// The portal's sign-up journey (PFE-015 step 1; flow platform/docs/flows/signup-and-create-ota.md, "Tests that prove
// it"; PF-01 to PF-04, PF-10, PF-11, PF-12): one new person, in one browser, from the sign-up form to an active OTA.
//
//   sign up → open the verification link from Mailpit → sign in → turn on MFA (secret read from the page) → sign out
//   → sign in with a TOTP code → create an OTA in the wizard → see it become active within a minute → reveal the
//   test keys once → see the onboarding checklist and get the welcome e-mail
//
// Provisioning runs on the OTA worker and the Amadeus stub, so the journey needs `E2E_WITH_OTA=1` (the e2e workflow
// sets it). Each step is a test of its own, in order, on one page (`mode: "serial"`): a failed step stops the rest.
// The password, the TOTP secret, the codes and the keys stay in variables; nothing of them is logged.
import { randomBytes } from "node:crypto";
import { type BrowserContext, type Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../support/a11y";
import { expect, newAccountContext, test, uniqueTestIp, type PortalAccount } from "../support/fixtures";
import { uniqueEmail, waitForEmail, waitForLink } from "../support/mailpit";
import { buildAccount, stack } from "../support/seed";
import { PORTAL_URL } from "../support/stack";
import { Authenticator } from "../support/totp";

test.describe.configure({ mode: "serial" });

/**
 * Waits until `target` has the title of its page (Next.js streams a page's metadata after its content, so a page can
 * be on screen a moment before its `<title>`), then fails on any serious or critical axe violation (PFE-015 AC2).
 */
async function expectAccessible(target: Page, title: string | RegExp): Promise<void> {
  await expect(target).toHaveTitle(typeof title === "string" ? `${title} · Velexis` : title);
  await expectNoSeriousA11yViolations(target);
}

/**
 * PF-11 AC1: the set-up page becomes "live" when the tenant is active, normally within one minute. The step waits for
 * it at most 25 s of its default 30-second budget (a set-up takes about 2 s on a developer machine), so a pass proves
 * the minute with room to spare.
 */
const READY_WAIT_MS = 25_000;

/** A key no other OTA of this run has: `e2e` and 10 random hex digits (PF-10 AC1: `^[a-z][a-z0-9]{2,29}$`). */
function uniqueOtaKey(): string {
  return `e2e${randomBytes(5).toString("hex")}`;
}

const account: PortalAccount = {
  ...buildAccount({ email: uniqueEmail("signup"), fullName: "Sam Signup" }),
  endUserIp: uniqueTestIp(),
};
const otaKey = uniqueOtaKey();
const otaName = `Signup Travel ${otaKey.slice(3)}`;

let context: BrowserContext;
let page: Page;
let authenticator: Authenticator;
let setupUrl: string;

test.beforeAll(async ({ browser }) => {
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "portal-signup.e2e.ts provisions an OTA: run it with E2E_WITH_OTA=1 (the Amadeus stub and the OTA worker)",
    );
  }
  // The person's own browser: its own cookies, and its own end-user IP (5 sign-ups per IP and hour, PF-01 AC3).
  context = await newAccountContext(browser, account, PORTAL_URL);
  page = await context.newPage();
});

test.afterAll(async () => {
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

/** Signs in on /sign-in with the account's e-mail address and password. */
async function submitSignIn(): Promise<void> {
  await page.getByLabel("E-mail address").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("signs up in the browser and gets the verification e-mail [PFE-015 AC1, AC2, PFE-005 AC3]", async () => {
  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { level: 1, name: "Create your Velexis account" })).toBeVisible();
  await expectAccessible(page, "Sign up");

  await page.getByLabel("Full name").fill(account.fullName);
  await page.getByLabel("E-mail address").fill(account.email);
  await page.getByLabel("Password").fill("too-short");
  await page.getByLabel(/I accept the terms of service/).check();
  await page.getByRole("button", { name: "Create account" }).click();
  // PF-01 AC2: a password under 10 characters is refused at its field; the name and the address stay.
  const password = page.getByLabel("Password");
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Use at least 10 characters.").first()).toBeVisible();
  await expect(page.getByLabel("E-mail address")).toHaveValue(account.email);
  await expectAccessible(page, "Sign up");

  await password.fill(account.password);
  await page.getByLabel(/I accept the terms of service/).check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("/sign-up/check-email");
  await expect(page.getByRole("heading", { level: 1, name: "Check your e-mail" })).toBeVisible();
  await expectAccessible(page, "Check your e-mail");

  // PF-01 AC1: the account waits for its verification e-mail, with a link to the portal's /verify-email.
  const link = await waitForLink({
    to: account.email,
    subject: "Confirm your e-mail address for Velexis",
    path: "/verify-email",
    origin: PORTAL_URL,
  });
  expect(link.searchParams.get("token")).toMatch(/\S{20,}/);
});

test("a second sign-up with the address reads the same and e-mails the owner instead [PFE-015 AC1, AC2]", async () => {
  await page.goto("/sign-up");
  await page.getByLabel("Full name").fill("Someone Else");
  await page.getByLabel("E-mail address").fill(account.email);
  await page.getByLabel("Password").fill(buildAccount().password);
  await page.getByLabel(/I accept the terms of service/).check();
  await page.getByRole("button", { name: "Create account" }).click();
  // PF-01 AC1: the same answer whether or not the address has an account; its owner gets an "account exists" e-mail.
  await page.waitForURL("/sign-up/check-email");
  await expect(page.getByRole("heading", { level: 1, name: "Check your e-mail" })).toBeVisible();
  await expectAccessible(page, "Check your e-mail");
  await waitForEmail({ to: account.email, subject: "You already have a Velexis account" });
});

test("the link from Mailpit verifies the address once, then the person signs in [PFE-015 AC1, AC2, PFE-005 AC3]", async () => {
  const link = await waitForLink({
    to: account.email,
    subject: "Confirm your e-mail address for Velexis",
    path: "/verify-email",
    origin: PORTAL_URL,
  });
  // PF-02 AC1: the link activates the account and lands on a URL without the token.
  await page.goto(link.href);
  await page.waitForURL("/sign-in?verified=1");
  await expect(page.getByText("Your e-mail address is verified. Sign in to continue.")).toBeVisible();
  await expectAccessible(page, "Sign in");

  // A second use of the same link is refused.
  await page.goto(link.href);
  await page.waitForURL("/verify-pending?error=token");
  await expect(
    page.getByText("This verification link has expired or was already used. Ask for a new link below."),
  ).toBeVisible();
  await expectAccessible(page, "Verify your e-mail");

  // PF-03 AC1: the session lands in the portal's httpOnly cookies.
  await page.goto("/sign-in");
  await submitSignIn();
  await page.waitForURL("/dashboard");
  await expect(page.getByRole("heading", { level: 1, name: "My OTAs" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "You have no OTA yet" })).toBeVisible();
  await expectAccessible(page, "My OTAs");
  const cookies = await context.cookies(PORTAL_URL);
  for (const name of ["__Host-vxp_at", "__Host-vxp_rt"]) {
    expect(cookies.find((cookie) => cookie.name === name)).toMatchObject({ httpOnly: true, secure: true });
  }
});

test("turns on two-factor authentication with the secret shown on the page [PFE-015 AC1, AC2]", async () => {
  await page.goto("/account/security");
  await expect(page.getByRole("heading", { level: 1, name: "Security" })).toBeVisible();
  await expectAccessible(page, "Security");

  // PF-04 AC1: the set-up shows a QR code and the base32 secret, the way an authenticator app would read it.
  await page.getByRole("button", { name: "Set up two-factor authentication" }).click();
  await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  const secret = await page.getByLabel("Or enter this key in the app").inputValue();
  authenticator = new Authenticator(secret);
  await expectAccessible(page, "Security");

  await page.getByLabel("Authentication code").fill(await authenticator.nextCode());
  await page.getByRole("button", { name: "Turn on two-factor authentication" }).click();
  // Ten recovery codes, shown once.
  await expect(page.getByRole("heading", { name: "Your recovery codes" })).toBeVisible();
  for (let position = 1; position <= 10; position += 1) {
    await expect(page.getByLabel(`Recovery code ${position}`, { exact: true })).not.toHaveValue("");
  }
  await expect(page.getByLabel("Recovery code 11", { exact: true })).toHaveCount(0);
  await expectAccessible(page, "Security");

  await page.reload();
  await expect(page.getByText(/^Two-factor authentication is on\./)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your recovery codes" })).toHaveCount(0);
  await expect(page.getByLabel("Or enter this key in the app")).toHaveCount(0);
  await expectAccessible(page, "Security");
});

test("signs out, then signs in again with a code from the authenticator [PFE-015 AC1, AC2]", async () => {
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL("/sign-in?signedOut=1");
  await expect(page.getByText("You are signed out.")).toBeVisible();
  await expectAccessible(page, "Sign in");
  // Signed out for real: the signed-in area sends the browser back to sign-in.
  await page.goto("/dashboard");
  await waitForRedirect(page, "/sign-in?next=%2Fdashboard");
  await expect(page.getByRole("heading", { level: 1, name: "Sign in to Velexis" })).toBeVisible();

  // PF-04 AC2: with MFA on, the password alone is not enough.
  await page.goto("/sign-in");
  await submitSignIn();
  await page.waitForURL("/sign-in/mfa");
  await expect(page.getByRole("heading", { level: 1, name: "Two-factor authentication" })).toBeVisible();
  await expectAccessible(page, "Two-factor authentication");
  await page.getByLabel("Authentication code").fill(await authenticator.nextCode());
  await page.getByRole("button", { name: "Verify and sign in" }).click();
  await page.waitForURL("/dashboard");
  await expect(page.getByRole("heading", { level: 1, name: "My OTAs" })).toBeVisible();
  await expectAccessible(page, "My OTAs");
});

test("creates an OTA in the wizard [PFE-015 AC1, AC2]", async () => {
  await page.getByRole("link", { name: "Create an OTA" }).first().click();
  await page.waitForURL("/otas/new");
  await expect(page.getByRole("heading", { level: 1, name: "Create an OTA" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "OTA details" })).toBeVisible();
  await expectAccessible(page, "Create an OTA");

  // PF-10 AC1: the key is checked as it is typed and shown as the storefront's address.
  await page.getByLabel("OTA name").fill(otaName);
  await page.getByLabel("OTA key").fill(otaKey);
  await expect(page.getByText(`Storefront address: ${otaKey}.`)).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "This key is available." })).toBeVisible();
  await page.getByLabel("Country").selectOption("DE");
  await page.getByLabel("Default currency").selectOption("EUR");
  await expect(page.getByLabel("Time zone")).not.toHaveValue("");
  await expectAccessible(page, "Create an OTA");
  await page.getByRole("button", { name: "Continue" }).click();

  // PF-10 AC3: before M5 every OTA starts on the early access plan.
  await expect(page.getByRole("heading", { level: 2, name: "Plan" })).toBeVisible();
  await expect(page.getByText(/every new OTA starts on the early access plan/)).toBeVisible();
  await expectAccessible(page, "Create an OTA");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { level: 2, name: "Review" })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: otaName })).toBeVisible();
  await expectAccessible(page, "Create an OTA");
  await page.getByRole("button", { name: "Create OTA" }).click();

  // PF-10 AC2: the OTA is created and its set-up starts at once.
  await page.waitForURL(/\/otas\/ten_[0-9A-HJKMNP-TV-Z]{26}\/setup$/);
  setupUrl = page.url();
  await expect(page.getByRole("heading", { level: 1, name: otaName })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Set-up steps" })).toBeVisible();
  await expectAccessible(page, "OTA set-up");
});

test("the set-up page shows the OTA active within a minute [PFE-015 AC1, AC2]", async () => {
  // The page polls the set-up every 2 seconds on its own; the journey only watches it.
  await expect(page.getByRole("heading", { name: "Your OTA is ready" })).toBeVisible({
    timeout: READY_WAIT_MS,
  });
  await expect(page.locator("#setup-summary")).toHaveText("Your OTA is ready.");
  await expect(page.locator('li[data-step="activate"]')).toContainText("Done");
  await expectAccessible(page, "OTA set-up");
});

test("reveals the test keys once [PFE-015 AC1, AC2]", async () => {
  // PF-11 AC3: the two test keys of the set-up, shown once.
  await page.getByRole("button", { name: "Reveal the test keys" }).click();
  await expect(page.getByRole("heading", { name: "Your test API keys" })).toBeVisible();
  await expect(page.getByLabel("Publishable test key", { exact: true })).toHaveValue(
    /^pk_test_[A-Za-z0-9]{40}$/,
  );
  await expect(page.getByLabel("Secret test key", { exact: true })).toHaveValue(/^sk_test_[A-Za-z0-9]{40}$/);
  await expect(page.getByRole("button", { name: "Reveal the test keys" })).toHaveCount(0);
  await expectAccessible(page, "OTA set-up");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Your OTA is ready" })).toBeVisible();
  await expect(page.getByText(/The initial keys were already shown/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Reveal the test keys" })).toHaveCount(0);
  await expect(page.getByLabel("Secret test key", { exact: true })).toHaveCount(0);
  await expectAccessible(page, "OTA set-up");
});

test("the OTA dashboard shows the onboarding checklist [PFE-015 AC1, AC2]", async () => {
  await page.goto(setupUrl);
  await page.getByRole("link", { name: "Go to the OTA dashboard" }).click();
  await page.waitForURL(setupUrl.replace(/\/setup$/, ""));
  await expect(page.getByRole("heading", { level: 1, name: otaName })).toBeVisible();
  const checklist = page.getByRole("region", { name: "Get your OTA ready" });
  await expect(checklist).toBeVisible();
  // PF-12: computed from what the journey did, each item with its state in words.
  for (const [item, state] of [
    ["Verify your e-mail", "Done"],
    ["Turn on two-factor sign-in", "Done"],
    ["OTA set up", "Done"],
    ["Get your API keys", "Done"],
    ["Open your storefront", "Done"],
    ["Invite your team", "To do"],
  ] as const) {
    await expect(checklist.getByRole("listitem").filter({ hasText: item })).toContainText(state);
  }
  await expect(checklist.getByRole("link", { name: "Invite your team" })).toHaveAttribute(
    "href",
    new URL(setupUrl).pathname.replace(/\/setup$/, "/team"),
  );
  await expectAccessible(page, "Overview");
});

test("the owner gets the welcome e-mail of the new OTA [PFE-015 AC1]", async () => {
  await waitForEmail({ to: account.email, subject: `${otaName} is ready on Velexis` });
});
