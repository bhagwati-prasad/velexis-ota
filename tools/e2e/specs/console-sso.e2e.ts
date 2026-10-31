// "Open console": the single sign-on from the portal into the OTA admin, for a member of an OTA, and its end when the
// member is removed (PFE-019; platform/docs/flows/team-and-ota-admin-sso.md §C and "Tests that prove it", PADR-0007,
// scope PF-21 AC3 and PF-22 AC1, AC2). The OTA is created by its owner through the portal API (`createTenant`) and set up
// by the OTA worker, and the console is the built OTA admin on the OTA API, so the journey needs `E2E_WITH_OTA=1` (the
// e2e workflow sets it); without it, it fails at once with that message.
//
//   a member (agent) signs in to the portal → "Open console" on My OTAs → the hand-off page posts the one-time portal
//   token to the OTA admin's /sso → /bookings of that OTA, the staff session in httpOnly cookies → the captured hand-off
//   form posted again is refused, and no session comes of it → the owner removes the member in the portal → within 60
//   seconds the OTA admin sends the member back to the portal, and their session cannot be renewed
//
// Arranged in `beforeAll` through the platform API (PADR-0017 item 5): the owner's active OTA with its Amadeus test
// office (`newOwnerWithActiveOta`), and the member, a verified account that the owner invites as `agent`
// (createInvitation) and that accepts with the token of the invitation e-mail (acceptInvitation); portal-team.e2e.ts
// drives those pages. The member signs in to the portal in the browser.
//
// How fast. The OTA staff guard re-checks the member's cached membership on every console call, and the platform's
// `membership` invalidation drops that entry right after removeMember commits (console-token.xb.test.ts proves about a
// second on the API); without the invalidation the cache's 60 s are the bound of PF-21 AC3. The wait is for the state
// the OTA admin shows, polled, never a sleep, within the step's default 30 s (a test's own budget is never raised,
// tools/e2e/README.md), and so within the 60 s; the step also checks the time since the owner confirmed.
//
// Every page the journey visits passes axe once its title is in place (the portal's hand-off page submits itself while
// it loads, before a check could run, so its captured markup is shown again without that script and checked), and on
// every page of the OTA admin JavaScript reads no cookie (`document.cookie` is empty). Tokens and passwords stay in
// variables and in the browser's cookies; the hand-off page's copy holds the used token only in its form.
//
// The steps are tests in order (`mode: "serial"`) on the member's and the owner's browser contexts, made in `beforeAll`.
import { performance } from "node:perf_hooks";
import { type BrowserContext, type Page, type Route } from "@playwright/test";
import type { components } from "@velexis/api-types/platform";
import { expectNoSeriousA11yViolations } from "../support/a11y";
import {
  addSessionCookies,
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
  newOwnerWithActiveOta,
  scriptReadableCookieNames,
  STAFF_COOKIES,
  withTenantTx,
  type OwnedOta,
} from "../support/ota";
import { buildAccount, stack } from "../support/seed";
import { OTA_ADMIN_URL, PORTAL_URL } from "../support/stack";

test.describe.configure({ mode: "serial" });

type Schemas = components["schemas"];

/** PF-21 AC3: a removed member loses OTA admin access within 60 seconds. */
const PF21_BOUND_MS = 60_000;
/**
 * How long the step waits for the OTA admin to end the removed member's session: inside the step's default 30 s, and
 * so inside PF21_BOUND_MS. The platform's invalidation makes it about a second (see the file header).
 */
const FOLLOW_TIMEOUT_MS = 20_000;
/** How long one look at /bookings waits for the redirect to the portal before the next look. */
const REDIRECT_WAIT_MS = 2_000;

/** The member's name, as the owner's team page and its dialog name them. */
const MEMBER_NAME = "Mona Member";
/** The owner's name: the inviter in the invitation e-mail's subject. */
const OWNER_NAME = "Owen Owner";

/** The OTA admin's title of a page (`%s · Velexis OTA admin`, src/app/layout.tsx). */
const adminTitle = (title: string): string => `${title} · Velexis OTA admin`;
/** The portal's title of a page (`%s · Velexis`). */
const portalTitle = (title: string): string => `${title} · Velexis`;

/** The portal's launch route of an OTA's "Open console" form (platform/frontend/README.md §2). */
const launchUrlOf = (tenantId: string): string =>
  `${PORTAL_URL}/otas/${encodeURIComponent(tenantId)}/console/launch`;

/** The portal's console page that the OTA admin sends people to without a session (PADR-0007 point 5). */
const portalConsoleUrlOf = (tenantId: string): string =>
  `${PORTAL_URL}/console?${new URLSearchParams({ tenant: tenantId }).toString()}`;

/** A portal token as the platform makes it (`PortalToken`): it must never appear in a URL. */
const PORTAL_TOKEN = /ptk_[0-9A-Za-z]{43}/;

/** The hand-off page the portal answered "Open console" with: the form that carries the portal token. */
interface CapturedHandOff {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

/** The script element of a page: the hand-off page has one, which submits its form while the page loads. */
const SCRIPT_ELEMENT = /<script\b[^>]*>[\s\S]*?<\/script>/g;

/**
 * The captured hand-off page without the script that submits it: the same markup, which stays on screen for axe. The
 * body's length changes, so the headers that describe it go; the rest (its CSP, `Cache-Control`) stays.
 */
function handOffWithoutScript(captured: CapturedHandOff): CapturedHandOff {
  const html = captured.body.toString("utf8");
  expect(html.match(SCRIPT_ELEMENT)).toHaveLength(1);
  const headers = Object.fromEntries(
    Object.entries(captured.headers).filter(([name]) => !/^content-(length|encoding)$/i.test(name)),
  );
  return { status: captured.status, headers, body: Buffer.from(html.replace(SCRIPT_ELEMENT, ""), "utf8") };
}

/** The directives of a `Cache-Control` value, lower case. */
function cacheDirectives(value: string | undefined): string[] {
  return (value ?? "").split(",").map((directive) => directive.trim().toLowerCase());
}

let owned: OwnedOta;
let member: PortalAccount;
/** The member's membership in the OTA (`stf_…`), as acceptInvitation answered it. */
let membershipId: string;
let memberContext: BrowserContext;
let memberPage: Page;
let ownerContext: BrowserContext;
let ownerPage: Page;
let handOff: CapturedHandOff | undefined;
/** `performance.now()` just before the owner confirmed the removal. */
let removedAt: number | undefined;

/** Waits until `target` shows the OTA admin's page `title`, then runs axe and checks that no cookie is readable. */
async function expectAdminPage(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(adminTitle(title));
  await expectNoSeriousA11yViolations(target);
  expect(await scriptReadableCookieNames(target)).toEqual([]);
}

/** Waits until `target` shows the portal's page `title` (its metadata streams after the content), then runs axe. */
async function expectPortalPage(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(portalTitle(title));
  await expectNoSeriousA11yViolations(target);
}

/** The names of the staff session's cookies that `context` holds for the OTA admin. */
async function staffCookieNames(context: BrowserContext): Promise<string[]> {
  return (await context.cookies(OTA_ADMIN_URL))
    .map((cookie) => cookie.name)
    .filter((name) => (STAFF_COOKIES as readonly string[]).includes(name))
    .sort((a, b) => a.localeCompare(b));
}

/** The `staff.sign_in` staff actions of the membership `staffId` in the OTA's schema (read through `tenantTx`). */
async function signInsOf(staffId: string): Promise<{ outcome: string; staff_role: string | null }[]> {
  return await withTenantTx(owned.schema, async (trx) =>
    trx
      .selectFrom("staff_actions")
      .select(["outcome", "staff_role"])
      .where("action", "=", "staff.sign_in")
      .where("staff_id", "=", staffId)
      .execute(),
  );
}

/** How many of those sign-ins succeeded. */
async function succeededSignInsOf(staffId: string): Promise<number> {
  return (await signInsOf(staffId)).filter((row) => row.outcome === "succeeded").length;
}

test.beforeAll(async ({ browser }) => {
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "console-sso.e2e.ts needs an active OTA and the OTA admin: run it with E2E_WITH_OTA=1 (the Amadeus stub, the " +
        "OTA worker, API and admin)",
    );
  }
  // Budget: two sign-ups with their verification e-mails (up to 15 s each), the OTA's set-up on the OTA worker (about
  // 2 s locally; PF-11 allows a minute), the invitation e-mail (up to 15 s) and a few platform API calls.
  test.setTimeout(120_000);
  owned = await newOwnerWithActiveOta(OWNER_NAME, "csso");
  member = await createVerifiedAccount(buildAccount({ fullName: MEMBER_NAME }));

  // The owner invites the member as an agent; the member accepts with the token of the invitation e-mail.
  const invite: Schemas["CreateInvitationRequest"] = { email: member.email, role: "agent" };
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
    to: member.email,
    subject: `${OWNER_NAME} invited you to ${owned.ota.name} on Velexis`,
    path: "/invitations/accept",
    origin: PORTAL_URL,
  });
  const token = link.searchParams.get("token");
  if (token === null) {
    throw new Error(`the invitation e-mail to ${member.email} has a link without a token`);
  }
  const accept: Schemas["InvitationTokenRequest"] = { token };
  const accepted = await callPlatformApi<Schemas["InvitationAccepted"]>({
    operation: "acceptInvitation",
    method: "POST",
    path: "/v1/invitations/accept",
    endUserIp: member.endUserIp,
    accessToken: (await signInWithApi(member)).accessToken,
    body: accept,
  });
  membershipId = accepted.membership.id;

  // The member's browser, signed out; the owner's, with the owner's portal session.
  memberContext = await newAccountContext(browser, member, PORTAL_URL);
  memberPage = await memberContext.newPage();
  ownerContext = await newAccountContext(browser, owned.owner.account, PORTAL_URL);
  await addSessionCookies(ownerContext, "portal", owned.session);
  ownerPage = await ownerContext.newPage();
});

test.afterAll(async () => {
  await memberContext?.close();
  await ownerContext?.close();
});

test("the member signs in to the portal, opens the console and lands on /bookings of that OTA [PFE-019 AC1] [PF-22 AC1, AC2]", async () => {
  await memberPage.goto("/sign-in");
  await expectPortalPage(memberPage, "Sign in");
  await memberPage.getByLabel("E-mail address").fill(member.email);
  await memberPage.getByLabel("Password", { exact: true }).fill(member.password);
  await memberPage.getByRole("button", { name: "Sign in" }).click();
  await memberPage.waitForURL("/dashboard");
  // My OTAs lists the OTA with the member's role, and its "Open console".
  const card = memberPage.getByRole("article", { name: owned.ota.name });
  await expect(card).toContainText("Agent");
  await expectPortalPage(memberPage, "My OTAs");

  // The hand-off page passes through unchanged; the journey keeps a copy, to post its form again in the next step.
  // Every address the browser asks for meanwhile is kept too: the token must be in none (PF-22 AC2).
  await memberPage.route(launchUrlOf(owned.ota.id), async (route: Route) => {
    const response = await route.fetch();
    const body = await response.body();
    handOff = { status: response.status(), headers: response.headers(), body };
    await route.fulfill({ response, body });
  });
  const addresses: string[] = [];
  const keep = (request: { url(): string }): void => {
    addresses.push(request.url());
  };
  memberContext.on("request", keep);
  await card.getByRole("button", { name: `Open console for ${owned.ota.name}` }).click();
  await memberPage.waitForURL(`${OTA_ADMIN_URL}/bookings`);
  memberContext.off("request", keep);
  await memberPage.unrouteAll();

  // /bookings of this OTA, signed in as the member.
  await expect(memberPage.getByRole("heading", { level: 1, name: "Bookings" })).toBeVisible();
  await expect(memberPage.getByText(owned.ota.name, { exact: true })).toBeVisible();
  await expectAdminPage(memberPage, "Bookings");

  // The hand-off: a POST answer that is never cached, whose token went in a form body and in no address.
  expect(handOff?.status).toBe(200);
  expect(cacheDirectives(handOff?.headers["cache-control"])).toContain("no-store");
  expect(handOff?.headers["referrer-policy"]).toBe("strict-origin");
  expect(addresses).toContain(launchUrlOf(owned.ota.id));
  expect(addresses).toContain(`${OTA_ADMIN_URL}/sso`);
  expect(addresses.filter((address) => PORTAL_TOKEN.test(address))).toEqual([]);

  // The staff session: the four `__Host-` cookies of ota/admin/README.md §4, all httpOnly, Secure and SameSite=Lax
  // (compared without their values, which are tokens), for this OTA (the tenant cookie holds its id, no secret).
  const cookies = await memberContext.cookies(OTA_ADMIN_URL);
  expect(
    cookies
      .filter((cookie) => (STAFF_COOKIES as readonly string[]).includes(cookie.name))
      .map(({ name, httpOnly, secure, sameSite, path }) => ({ name, httpOnly, secure, sameSite, path }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ).toEqual(
    [...STAFF_COOKIES]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ name, httpOnly: true, secure: true, sameSite: "Lax", path: "/" })),
  );
  expect(cookies.find((cookie) => cookie.name === "__Host-vx_tenant")?.value).toBe(owned.ota.id);
  expect(cookies.filter((cookie) => !cookie.httpOnly).map((cookie) => cookie.name)).toEqual([]);

  // The OTA backend signed the member in to this OTA: one `staff.sign_in` of their membership in its staff actions.
  expect(await signInsOf(membershipId)).toEqual([{ outcome: "succeeded", staff_role: "agent" }]);

  // The portal's hand-off page passes axe too. It submits itself while it loads, so the journey shows its markup again
  // without that script, in a page of its own (served from the copy: the portal mints nothing for it).
  if (handOff === undefined) {
    throw new Error("the hand-off page was not captured");
  }
  const still = handOffWithoutScript(handOff);
  const handOffPage = await memberContext.newPage();
  try {
    await handOffPage.route(launchUrlOf(owned.ota.id), (route: Route) =>
      route.fulfill({ status: still.status, headers: still.headers, body: still.body }),
    );
    await handOffPage.goto(launchUrlOf(owned.ota.id));
    await expect(handOffPage).toHaveTitle("Opening the OTA admin");
    await expect(
      handOffPage.getByRole("heading", { level: 1, name: "Opening the OTA admin…" }),
    ).toBeVisible();
    await expect(handOffPage.getByRole("button", { name: "Continue" })).toBeVisible();
    await expectNoSeriousA11yViolations(handOffPage);
  } finally {
    await handOffPage.close();
  }
});

test("posting the captured hand-off form a second time is refused, and no session comes of it [PFE-019 AC1] [PF-22 AC2]", async ({
  browser,
}) => {
  const captured = handOff;
  if (captured === undefined) {
    throw new Error("the first step captured no hand-off page");
  }
  // A browser of the member's without any session: the launch address answers the captured page, whose script posts
  // the portal token that the first sign-on used to the OTA admin's /sso, from the portal's origin, as before.
  const replay = await newAccountContext(browser, member, PORTAL_URL);
  try {
    const again = await replay.newPage();
    await again.route(launchUrlOf(owned.ota.id), (route: Route) =>
      route.fulfill({ status: captured.status, headers: captured.headers, body: captured.body }),
    );
    const sso = again.waitForResponse(
      (response) => response.url() === `${OTA_ADMIN_URL}/sso` && response.request().method() === "POST",
    );
    await again.goto(launchUrlOf(owned.ota.id));
    // The token is single use: the OTA API answers 401 PORTAL_TOKEN_INVALID, and /sso its error page.
    expect((await sso).status()).toBe(401);
    await again.waitForURL(`${OTA_ADMIN_URL}/sso`);
    await expect(
      again.getByRole("heading", { level: 1, name: "The console could not be opened" }),
    ).toBeVisible();
    await expect(
      again.getByText("This console link expired or was already used.", { exact: false }),
    ).toBeVisible();
    await expect(again.getByRole("link", { name: "Back to the portal" })).toBeVisible();
    await expectAdminPage(again, "The console could not be opened");
    // No staff session was started: none of its cookies is in this browser, and the OTA's staff actions still hold the
    // one sign-in of the first step.
    expect(await staffCookieNames(replay)).toEqual([]);
    expect(await succeededSignInsOf(membershipId)).toBe(1);
  } finally {
    await replay.close();
  }
  // The member's own session is untouched by the refused replay.
  await memberPage.reload();
  await expect(memberPage.getByRole("heading", { level: 1, name: "Bookings" })).toBeVisible();
  await expectAdminPage(memberPage, "Bookings");
});

test("the owner removes the member in the portal [PFE-019 AC1] [PF-21 AC3]", async () => {
  await ownerPage.goto(`/otas/${encodeURIComponent(owned.ota.id)}/team`);
  await expectPortalPage(ownerPage, "Team");
  const row = ownerPage
    .getByRole("table", { name: "Members of this OTA" })
    .getByRole("row")
    .filter({ hasText: member.email });
  await expect(row).toContainText("Agent");
  await row.getByRole("button", { name: `Remove ${MEMBER_NAME}` }).click();
  const dialog = ownerPage.getByRole("alertdialog", { name: `Remove ${MEMBER_NAME} from the team?` });
  await expect(dialog).toBeVisible();
  await expectPortalPage(ownerPage, "Team");
  // Counted from the confirmation on, which is sent before the platform commits: the bound is measured on the safe side.
  removedAt = performance.now();
  await dialog.getByRole("button", { name: "Remove member" }).click();
  await expect(
    ownerPage.getByRole("status").filter({ hasText: "The member was removed from the team." }),
  ).toBeVisible();
  await expect(row).toHaveCount(0);
  await expectPortalPage(ownerPage, "Team");
});

test("within 60 seconds the OTA admin ends the removed member's session and sends them to the portal [PFE-019 AC1] [PF-21 AC3]", async () => {
  if (removedAt === undefined) {
    throw new Error("the previous step removed no member");
  }
  // The member goes on working in the console: each look at /bookings asks the OTA API, whose staff guard refuses the
  // removed member (403 STAFF_MEMBERSHIP_INACTIVE), and the OTA admin then sends them to the portal's console page.
  const portalConsole = portalConsoleUrlOf(owned.ota.id);
  await expect(async () => {
    await memberPage.goto(`${OTA_ADMIN_URL}/bookings`);
    await expect(memberPage).toHaveURL(portalConsole, { timeout: REDIRECT_WAIT_MS });
  }).toPass({ timeout: FOLLOW_TIMEOUT_MS, intervals: [250, 500, 1_000] });
  const endedAfterMs = performance.now() - removedAt;
  test
    .info()
    .annotations.push({ type: "session ended after", description: `${Math.round(endedAfterMs)} ms` });
  expect(endedAfterMs).toBeLessThan(PF21_BOUND_MS);

  // The portal says why: the member is no longer a member of the OTA the OTA admin asked for, nor of any other.
  await expect(memberPage.getByRole("heading", { level: 1, name: "Open the OTA admin" })).toBeVisible();
  await expect(memberPage.getByRole("status").filter({ hasText: "or no longer are" })).toBeVisible();
  await expect(memberPage.getByRole("heading", { name: "You are not a member of any OTA" })).toBeVisible();
  await expectPortalPage(memberPage, "Open the OTA admin");

  // The session is over, not only its access token: a refresh is refused too, which deletes the session's cookies
  // (the tenant cookie stays for the way back) and sends the member to the portal again. The OTA admin's page sent the
  // member away without touching the cookies (a server component cannot write them), so the refresh token is still
  // there and the refresh really goes to the OTA API: its refusal, not a missing cookie, ends the session here.
  expect(await staffCookieNames(memberContext)).toEqual(
    [...STAFF_COOKIES].sort((a, b) => a.localeCompare(b)),
  );
  const refreshAnswer = memberPage.waitForResponse(
    (response) =>
      response.url().startsWith(`${OTA_ADMIN_URL}/auth/refresh`) && response.request().method() === "GET",
  );
  await memberPage.goto(`${OTA_ADMIN_URL}/auth/refresh?next=%2Fbookings`);
  const refreshed = await refreshAnswer;
  // Straight to the portal, never back to /bookings with a renewed session.
  expect(refreshed.status()).toBe(303);
  expect(await refreshed.headerValue("location")).toBe(portalConsole);
  await expect(memberPage).toHaveURL(portalConsole);
  expect(await staffCookieNames(memberContext)).toEqual(["__Host-vx_tenant"]);
  await expectPortalPage(memberPage, "Open the OTA admin");
});
