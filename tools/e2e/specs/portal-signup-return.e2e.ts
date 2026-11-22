// The way back through sign-up and e-mail verification (FIX-W69-SIGNUP, KI-008 and KI-009; flows
// platform/docs/flows/signup-and-create-ota.md steps 1–4 and team-and-ota-admin-sso.md §A step 3): a sign-up keeps its
// return path in the portal's own short-lived cookie (`__Host-vxp_verify_next`), and the verification link in the same
// browser continues there.
//
//   (a) the plan chosen on /pricing: "Start" → sign up → open the verification link from Mailpit → sign in → the
//       create-OTA wizard at /otas/new?plan=<code> with that plan chosen
//   (b) an invitation opened in a fresh browser: "Create an account" → sign up → verify → sign in → back on
//       /invitations/accept → accept, and the OTA's dashboard shows the invited role
//
// The links of the e-mails are opened the way a person opens them from web mail: a page of another site
// (webmail.example.com, answered by the browser context itself, never over the network) with the link, which the
// journey clicks. That navigation is cross-site, as from a mail client, so the cookie that carries the return path must
// be `SameSite=Lax` to reach `/verify-email`, and the invitation's `SameSite=Strict` cookie reaches the accept page only
// through the navigations the portal itself starts (`page.goto` of the link would count as typed in the address bar).
//
// The portal project runs without FEATURE_STRIPE_BILLING, so its plan step offers early access only: (a) chooses
// "Early access" on /pricing and proves that the plan travels to the wizard's URL and is the chosen plan there; which
// plan the wizard preselects among several is a unit test (checkout.test.tsx). The invitation needs an active OTA, so
// the file needs `E2E_WITH_OTA=1` (the e2e workflow sets it); the owner and the OTA are arranged through the platform
// API (PADR-0017 item 5), the invitee does everything in the browser. Each journey's steps are tests of their own, in
// order (`mode: "serial"` per journey). Tokens and passwords stay in variables and are never logged.
import { type BrowserContext, type Cookie, type Page } from "@playwright/test";
import type { components } from "@velexis/api-types/platform";
import { expectNoSeriousA11yViolations } from "../support/a11y";
import {
  callPlatformApi,
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
import { createOtaWithApi, uniqueOtaKey, waitForOtaStatus, type Ota } from "../support/tenants";

type Schemas = components["schemas"];

/** The portal's cookie with the sign-up's return path (platform/frontend/README.md §6). */
const RETURN_COOKIE = "__Host-vxp_verify_next";
/** The invitation token moved out of the link (platform/frontend/README.md §6). */
const INVITATION_COOKIE = "__Host-vxp_invite";
/** The return path's lifetime: the verification link's 24 hours. */
const RETURN_MAX_AGE_S = 24 * 3600;
/** The invitation cookie's own lifetime, which a sign-up from the invitation extends. */
const INVITATION_COOKIE_MAX_AGE_S = 15 * 60;
/** A page of another site, as web mail would show the e-mail's link; the browser context answers it. */
const WEBMAIL = "https://webmail.example.com/message";

/**
 * Waits until `target` has the title of its page (Next.js streams a page's metadata after its content, so a page can
 * be on screen a moment before its `<title>`), then fails on any serious or critical axe violation.
 */
async function expectAccessible(target: Page, title: string | RegExp): Promise<void> {
  await expect(target).toHaveTitle(typeof title === "string" ? `${title} · Velexis` : title);
  await expectNoSeriousA11yViolations(target);
}

/** Opens `link` the way a person does from web mail: by clicking it on a page of another site (cross-site). */
async function openFromWebmail(context: BrowserContext, page: Page, link: URL): Promise<void> {
  await context.unroute(WEBMAIL);
  await context.route(WEBMAIL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html lang="en"><title>Web mail</title><main><a id="link" href="${link.href.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">Open the link</a></main></html>`,
    }),
  );
  await page.goto(WEBMAIL);
  await page.locator("#link").click();
}

/** The portal cookie `name` of `context`, or `undefined`. */
async function portalCookie(context: BrowserContext, name: string): Promise<Cookie | undefined> {
  return (await context.cookies(PORTAL_URL)).find((cookie) => cookie.name === name);
}

/** Seconds from now until `cookie` expires (a session cookie counts as -1). */
function secondsLeft(cookie: Cookie | undefined): number {
  return cookie === undefined || cookie.expires < 0 ? -1 : cookie.expires - Date.now() / 1000;
}

/** Fills and sends the sign-up form; `email` only when the page did not prefill it. */
async function submitSignUp(page: Page, account: PortalAccount, email?: string): Promise<void> {
  await page.getByLabel("Full name").fill(account.fullName);
  if (email !== undefined) {
    await page.getByLabel("E-mail address").fill(email);
  }
  await page.getByLabel("Password").fill(account.password);
  await page.getByLabel(/I accept the terms of service/).check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("/sign-up/check-email");
}

/** Signs in on the page it is on (/sign-in) with the account's address and password. */
async function submitSignIn(page: Page, account: PortalAccount): Promise<void> {
  await page.getByLabel("E-mail address").fill(account.email);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** The verification link of the e-mail to `email`. */
async function verificationLink(email: string): Promise<URL> {
  return await waitForLink({
    to: email,
    subject: "Confirm your e-mail address for Velexis",
    path: "/verify-email",
    origin: PORTAL_URL,
  });
}

// ---- (a) The plan chosen on /pricing (KI-009) -------------------------------------------------------------------

test.describe("the plan chosen on /pricing survives sign-up and verification", () => {
  test.describe.configure({ mode: "serial" });
  const visitor: PortalAccount = {
    ...buildAccount({ email: uniqueEmail("pricingplan"), fullName: "Pia Pricing" }),
    endUserIp: uniqueTestIp(),
  };
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    context = await newAccountContext(browser, visitor, PORTAL_URL);
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("[FIX-W69-SIGNUP AC1, AC3] Start on /pricing signs up with the plan, kept in an httpOnly Lax cookie for 24 hours", async () => {
    await page.goto("/pricing");
    await expectAccessible(page, "Pricing");
    await page.getByRole("link", { name: "Start with Early access" }).click();
    await page.waitForURL("/sign-up?plan=early_access");
    await expect(page.locator('form input[type="hidden"][name="next"]')).toHaveValue(
      "/otas/new?plan=early_access",
    );
    await expectAccessible(page, "Sign up");

    await submitSignUp(page, visitor, visitor.email);
    const kept = await portalCookie(context, RETURN_COOKIE);
    expect(kept).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
    expect(decodeURIComponent(kept?.value ?? "")).toBe("/otas/new?plan=early_access");
    expect(secondsLeft(kept)).toBeGreaterThan(RETURN_MAX_AGE_S - 120);
    expect(secondsLeft(kept)).toBeLessThanOrEqual(RETURN_MAX_AGE_S);
  });

  test("[FIX-W69-SIGNUP AC1, AC3] the verification link from web mail continues to sign-in with the wizard as next", async () => {
    await openFromWebmail(context, page, await verificationLink(visitor.email));
    await page.waitForURL("/sign-in?verified=1&next=%2Fotas%2Fnew%3Fplan%3Dearly_access");
    await expect(page.getByText("Your e-mail address is verified. Sign in to continue.")).toBeVisible();
    await expectAccessible(page, "Sign in");
    // One verification uses the return path up.
    expect(await portalCookie(context, RETURN_COOKIE)).toBeUndefined();
  });

  test("[FIX-W69-SIGNUP AC3] signing in lands on the wizard with the plan chosen on /pricing", async () => {
    await submitSignIn(page, visitor);
    await page.waitForURL("/otas/new?plan=early_access");
    await expect(page.getByRole("heading", { level: 1, name: "Create an OTA" })).toBeVisible();
    await expectAccessible(page, "Create an OTA");
    await expect(page.locator('input[name="planCode"]:checked')).toHaveValue("early_access");
  });
});

// ---- (b) The invitation (KI-008) --------------------------------------------------------------------------------

/** PF-11 AC1: an OTA is set up normally within one minute (about 2 s on a developer machine). */
const PROVISIONING_BUDGET_MS = 60_000;
/** The budget of the arrangement in `beforeAll`: an owner and an invitee through the API and Mailpit, an active OTA. */
const ARRANGE_BUDGET_MS = PROVISIONING_BUDGET_MS + 30_000;

test.describe("an invitee who signs up comes back to the invitation and accepts", () => {
  test.describe.configure({ mode: "serial" });
  const ownerName = "Otto Owner";
  const invitee: PortalAccount = {
    ...buildAccount({ email: uniqueEmail("returninvitee"), fullName: "Ivo Invitee" }),
    endUserIp: uniqueTestIp(),
  };
  let ota: Ota;
  let invitation: URL;
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(ARRANGE_BUDGET_MS);
    if (!stack().settings.E2E_WITH_OTA) {
      throw new Error(
        "portal-signup-return.e2e.ts needs an active OTA: run it with E2E_WITH_OTA=1 (the Amadeus stub and the OTA worker)",
      );
    }
    const ownerAccount = await createVerifiedAccount(
      buildAccount({ email: uniqueEmail("returnowner"), fullName: ownerName }),
    );
    const owner = { account: ownerAccount, accessToken: (await signInWithApi(ownerAccount)).accessToken };
    const created = await createOtaWithApi(owner, { key: uniqueOtaKey("ret") });
    ota = await waitForOtaStatus(owner, created.id, "active", { timeoutMs: PROVISIONING_BUDGET_MS });
    const invite: Schemas["CreateInvitationRequest"] = { email: invitee.email, role: "agent" };
    await callPlatformApi<Schemas["Invitation"]>({
      operation: "createInvitation",
      method: "POST",
      path: `/v1/tenants/${encodeURIComponent(ota.id)}/invitations`,
      endUserIp: ownerAccount.endUserIp,
      accessToken: owner.accessToken,
      body: invite,
    });
    invitation = await waitForLink({
      to: invitee.email,
      subject: `${ownerName} invited you to ${ota.name} on Velexis`,
      path: "/invitations/accept",
      origin: PORTAL_URL,
    });
    // The invitee's own, fresh browser.
    context = await newAccountContext(browser, invitee, PORTAL_URL);
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("[FIX-W69-SIGNUP AC2] the invitation from web mail offers Create an account, which keeps the way back", async () => {
    await openFromWebmail(context, page, invitation);
    await page.waitForURL("/invitations/accept");
    await expect(page.getByRole("heading", { level: 1, name: `Join ${ota.name}` })).toBeVisible();
    await expect(
      page.getByText(
        /^New to Velexis\? Create an account with the invited address\. After you verify it in this browser/,
      ),
    ).toBeVisible();
    await expectAccessible(page, "Your invitation");

    await page.getByRole("link", { name: "Create an account" }).click();
    await page.waitForURL(/\/sign-up\?/);
    await expect(page.getByLabel("E-mail address")).toHaveValue(invitee.email);
    await expect(page.locator('form input[type="hidden"][name="next"]')).toHaveValue("/invitations/accept");
    await expectAccessible(page, "Sign up");
  });

  test("[FIX-W69-SIGNUP AC2] the sign-up keeps the return path and the invitation cookie beyond its 15 minutes", async () => {
    await submitSignUp(page, invitee);
    await expectAccessible(page, "Check your e-mail");

    const kept = await portalCookie(context, RETURN_COOKIE);
    expect(kept).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax" });
    expect(decodeURIComponent(kept?.value ?? "")).toBe("/invitations/accept");
    // The invitation's own cookie: still httpOnly and Strict, now until the invitation expires (at most 24 hours).
    const invite = await portalCookie(context, INVITATION_COOKIE);
    expect(invite).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
    expect(secondsLeft(invite)).toBeGreaterThan(INVITATION_COOKIE_MAX_AGE_S + 60);
    expect(secondsLeft(invite)).toBeLessThanOrEqual(RETURN_MAX_AGE_S);
  });

  test("[FIX-W69-SIGNUP AC2] verifying from web mail and signing in comes back to the invitation", async () => {
    await openFromWebmail(context, page, await verificationLink(invitee.email));
    await page.waitForURL("/sign-in?verified=1&next=%2Finvitations%2Faccept");
    await expectAccessible(page, "Sign in");

    await submitSignIn(page, invitee);
    await page.waitForURL("/invitations/accept");
    await expect(page.getByText(`You are signed in as ${invitee.email}.`)).toBeVisible();
    await expectAccessible(page, "Your invitation");
  });

  test("[FIX-W69-SIGNUP AC2] the invitee accepts and joins the OTA with the invited role", async () => {
    await page.getByRole("button", { name: "Accept the invitation" }).click();
    await page.waitForURL(`/otas/${ota.id}`);
    await expect(page.getByRole("heading", { level: 1, name: ota.name })).toBeVisible();
    await expect(
      page.locator("dt", { hasText: /^Your role$/ }).locator("xpath=following-sibling::dd[1]"),
    ).toHaveText("Agent");
    await expectAccessible(page, "Overview");
    // The accepted invitation's token is gone from the browser.
    expect(await portalCookie(context, INVITATION_COOKIE)).toBeUndefined();
  });
});
