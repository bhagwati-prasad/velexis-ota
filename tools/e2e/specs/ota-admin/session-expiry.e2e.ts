// The OTA admin's staff session as it ends (OAD-019 step 2; ota/admin/README.md §3, §4 and §10, OADR-0011 points 2
// and 3, OADR-0018 point 3, PADR-0007 §5 and §6): against the built OTA admin, portal, platform API and OTA API, so the
// journey needs `E2E_WITH_OTA=1` (the e2e workflow sets it).
//
//   the owner works in the console → the access cookie expires (the browser drops it after its 15 minutes) → the next
//   navigation renews the session once, also when two tabs ask at the same moment → a member of the OTA works in the
//   console → the owner removes the member in the portal → within 60 seconds the console sends the member back to the
//   portal, and the session cannot be renewed → the owner opens the console on a second device too → "Sign out
//   everywhere" in the portal → both console sessions end, and neither can be renewed
//
// How a renewal is counted. A staff refresh token is `srt_` and the ULID of its family (`asn_…`) and 256 random bits;
// the OTA backend keeps the family in Redis (`staffsess:<asn_…>`: the SHA-256 of the current token and of those it
// replaced, ota/backend/src/identity/staff/staff-sessions.ts), and every refresh moves the current hash to the rotated
// ones. So "refreshes once" is read where the API keeps it: one more rotated hash, and the current hash that of the new
// cookie. A second refresh with the same token would revoke the whole family (reuse), so the session going on after two
// tabs asked at once also shows that the OTA admin's de-duplication (lib/refresh-dedup.ts) made one call: the journey
// holds each tab's request until both are on their way (`context.route`) and checks that both carried the same refresh
// token and no access token. Only hashes are compared; no token is ever printed.
//
// How long. A removed member's console requests are refused as soon as the platform's `membership` invalidation drops
// the cached membership (about a second, console-token.xb.test.ts), and at the latest after that cache's 60 s (PF-21
// AC3). The step waits for the state the console shows with `expect.poll`, never a sleep, within the step's default
// 30 s (a test's budget is never raised), and checks the time since the owner confirmed against 60 s. "Sign out
// everywhere" writes the account's cut-off `staffdeny:acct:<accountId>` before it answers, which the OTA backend checks
// on every console request and refresh, so that state comes at once; it is polled the same way.
//
// Every page the journey visits passes axe once its title is in place, and on every page of the OTA admin JavaScript
// reads no cookie. The steps are tests in order (`mode: "serial"`) on browser contexts made in `beforeAll` (the owner's
// and the member's) and in the step that opens the owner's second device.
import { performance } from "node:perf_hooks";
import { type Browser, type BrowserContext, type Page, type Route } from "@playwright/test";
import type { components } from "@velexis/api-types/platform";
import { sha256Hex } from "@velexis/crypto";
import Redis from "ioredis";
import { expectNoSeriousA11yViolations } from "../../support/a11y";
import {
  addSessionCookies,
  callPlatformApi,
  createVerifiedAccount,
  expect,
  newAccountContext,
  signInWithApi,
  test,
  type PortalAccount,
  type SessionTokens,
} from "../../support/fixtures";
import { waitForLink } from "../../support/mailpit";
import {
  newOwnerWithActiveOta,
  openConsoleFromPortal,
  scriptReadableCookieNames,
  STAFF_COOKIES,
  type OwnedOta,
} from "../../support/ota";
import { buildAccount, stack } from "../../support/seed";
import { OTA_ADMIN_URL, PORTAL_URL } from "../../support/stack";

test.describe.configure({ mode: "serial" });

type Schemas = components["schemas"];

/** The staff session's cookies (ota/admin/README.md §4). */
const ACCESS_COOKIE = "__Host-vx_staff_at";
const REFRESH_COOKIE = "__Host-vx_staff_rt";
const TENANT_COOKIE = "__Host-vx_tenant";

/** PF-21 AC3: a removed member loses OTA admin access within 60 seconds. */
const PF21_BOUND_MS = 60_000;
/**
 * How long a step polls for the end of a console session: inside the step's default 30 s, so inside PF21_BOUND_MS.
 * The platform's invalidation (removal) and the account's cut-off (sign out everywhere) make it about a second.
 */
const SESSION_END_POLL_MS = 20_000;
/** The intervals of those polls: each look is a navigation of its own. */
const POLL_INTERVALS = [250, 500, 1_000];

/** The owner's and the member's names: the inviter in the invitation e-mail's subject, and the team page's buttons. */
const OWNER_NAME = "Selma Session";
const MEMBER_NAME = "Milo Member";

/** The OTA admin's title of a page (`%s · Velexis OTA admin`, src/app/layout.tsx). */
const adminTitle = (title: string): string => `${title} · Velexis OTA admin`;
/** The portal's title of a page (`%s · Velexis`). */
const portalTitle = (title: string): string => `${title} · Velexis`;

/** The portal's console page that the OTA admin sends people to without a session (PADR-0007 point 5). */
const portalConsoleUrlOf = (tenantId: string): string =>
  `${PORTAL_URL}/console?${new URLSearchParams({ tenant: tenantId }).toString()}`;

let owned: OwnedOta;
let member: PortalAccount;
/** The owner's browser (the console and, in a tab of its own, the portal) and the member's. */
let ownerContext: BrowserContext;
let ownerConsole: Page;
let memberContext: BrowserContext;
let memberConsole: Page;
/** The owner's second device, opened by the step before "sign out everywhere". */
let secondDevice: BrowserContext | undefined;
/** `performance.now()` just before the owner confirmed the member's removal. */
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

/** The value of the OTA admin's cookie `name` in `context`, if it holds one. */
async function adminCookie(context: BrowserContext, name: string): Promise<string | undefined> {
  return (await context.cookies(OTA_ADMIN_URL)).find((cookie) => cookie.name === name)?.value;
}

/** The names of the staff session's cookies that `context` holds for the OTA admin, sorted. */
async function staffCookieNames(context: BrowserContext): Promise<string[]> {
  return (await context.cookies(OTA_ADMIN_URL))
    .map((cookie) => cookie.name)
    .filter((name) => (STAFF_COOKIES as readonly string[]).includes(name))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * The access cookie runs out: the browser drops a cookie whose Max-Age (the token's 15 minutes) has passed, and the
 * journey drops it now instead of waiting. The refresh cookie stays, as it does in the browser.
 */
async function expireAccessCookie(context: BrowserContext): Promise<void> {
  expect(await adminCookie(context, ACCESS_COOKIE)).toBeDefined();
  await context.clearCookies({ name: ACCESS_COOKIE });
  expect(await adminCookie(context, ACCESS_COOKIE)).toBeUndefined();
  expect(await adminCookie(context, REFRESH_COOKIE)).toBeDefined();
}

/** A staff refresh token: `srt_`, its family's ULID, then 43 base64url characters (staff-sessions.ts). */
const STAFF_REFRESH_TOKEN = /^srt_([0-9A-HJKMNP-TV-Z]{26})[A-Za-z0-9_-]{43}$/;

/** What the OTA backend keeps of a staff refresh family, compared by hash only. */
interface StaffFamily {
  /** The SHA-256 of the family's current refresh token. */
  readonly current: string;
  /** How many tokens of the family were replaced so far (the rotated hashes it remembers, at most 100). */
  readonly rotations: number;
}

/**
 * The family of the staff refresh token `token` as the OTA backend keeps it in the stack's Redis (`staffsess:asn_…`),
 * or `undefined` when it is gone. Read only; the token itself never leaves this process.
 */
async function staffFamilyOf(token: string): Promise<StaffFamily | undefined> {
  const match = STAFF_REFRESH_TOKEN.exec(token);
  if (match === null) {
    throw new Error("the refresh cookie holds no staff refresh token");
  }
  const redis = new Redis(stack().redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    const raw = await redis.get(`staffsess:asn_${match[1] ?? ""}`);
    if (raw === null) {
      return undefined;
    }
    const family = JSON.parse(raw) as { current?: unknown; rotated?: unknown };
    if (typeof family.current !== "string") {
      throw new Error("the staff family in Redis has no current token hash");
    }
    // Redis's cjson writes an empty list as `{}`: no rotation yet.
    return { current: family.current, rotations: Array.isArray(family.rotated) ? family.rotated.length : 0 };
  } finally {
    redis.disconnect();
  }
}

/** A staff session as the journey compares it: by hashes only, so a failed comparison never prints a token. */
interface StaffSession {
  /** The SHA-256 of the refresh token in the browser's refresh cookie. */
  readonly tokenHash: string;
  /** Its family as the OTA backend keeps it. */
  readonly family: StaffFamily;
}

/** The refresh token in `context`'s refresh cookie (by its hash) and its family. */
async function sessionOf(context: BrowserContext): Promise<StaffSession> {
  const token = await adminCookie(context, REFRESH_COOKIE);
  if (token === undefined) {
    throw new Error(`the browser holds no ${REFRESH_COOKIE} cookie`);
  }
  const family = await staffFamilyOf(token);
  if (family === undefined) {
    throw new Error("the staff session's family is not in Redis");
  }
  return { tokenHash: sha256Hex(token), family };
}

/** The cookies a request carried (its `Cookie` header), by name; the values stay in this process. */
function cookiesSent(headers: Record<string, string>): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of (headers["cookie"] ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at > 0) {
      cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  }
  return cookies;
}

/**
 * Whether `address` is where the portal takes a person the OTA admin sent back for the OTA `tenantId`: its console
 * page, or, without a portal session, its sign-in page on the way back there. The portal's middleware writes the
 * loopback host of its own redirect as `localhost` (tools/e2e/README.md, "Writing a journey"), so only the port, the
 * path and the query are compared.
 */
function isPortalWayBack(address: string, tenantId: string): boolean {
  const url = new URL(address);
  const portal = new URL(PORTAL_URL);
  if (url.port !== portal.port) {
    return false;
  }
  const consolePath = `/console?${new URLSearchParams({ tenant: tenantId }).toString()}`;
  return (
    url.pathname + url.search === consolePath ||
    (url.pathname === "/sign-in" && url.searchParams.get("next") === consolePath)
  );
}

/**
 * Looks at `/bookings` in `target` until the OTA admin sends it to the portal (polled, each look a navigation of its
 * own) and resolves to where it ended up.
 */
async function waitUntilSentToPortal(target: Page): Promise<string> {
  await expect
    .poll(
      async () => {
        await target.goto(`${OTA_ADMIN_URL}/bookings`);
        return isPortalWayBack(target.url(), owned.ota.id);
      },
      {
        timeout: SESSION_END_POLL_MS,
        intervals: POLL_INTERVALS,
        message: "the OTA admin sends the browser back to the portal",
      },
    )
    .toBe(true);
  return target.url();
}

/**
 * The ended session cannot be renewed: once the access cookie is gone too, the next page makes the OTA admin's
 * middleware present the refresh token, which the OTA API refuses for good, so the middleware deletes the access,
 * refresh and environment cookies (the tenant cookie stays for the way back) and answers `303` to the portal's console
 * page of the OTA.
 */
async function expectNoRenewal(context: BrowserContext, target: Page): Promise<void> {
  // The page's redirect to the portal left the cookies as they were (a server component cannot write them), so the
  // refresh really goes to the OTA API: its refusal, not a missing cookie, ends the session here.
  expect(await adminCookie(context, REFRESH_COOKIE)).toBeDefined();
  if ((await adminCookie(context, ACCESS_COOKIE)) !== undefined) {
    await expireAccessCookie(context);
  }
  const answer = target.waitForResponse(
    (response) => response.url() === `${OTA_ADMIN_URL}/bookings` && response.request().method() === "GET",
  );
  await target.goto(`${OTA_ADMIN_URL}/bookings`);
  const refused = await answer;
  expect(refused.status()).toBe(303);
  expect(await refused.headerValue("location")).toBe(portalConsoleUrlOf(owned.ota.id));
  expect(isPortalWayBack(target.url(), owned.ota.id)).toBe(true);
  expect(await staffCookieNames(context)).toEqual([TENANT_COOKIE]);
}

/** A browser of `account` on the OTA admin with the portal session `session`, its console open on /bookings. */
async function openConsole(
  browser: Browser,
  account: PortalAccount,
  session: SessionTokens,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await newAccountContext(browser, account, OTA_ADMIN_URL);
  await addSessionCookies(context, "portal", session);
  const page = await context.newPage();
  await openConsoleFromPortal(page, owned.ota.id);
  await expectAdminPage(page, "Bookings");
  await expect(page.getByText(owned.ota.name, { exact: true })).toBeVisible();
  return { context, page };
}

test.beforeAll(async ({ browser }) => {
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "session-expiry.e2e.ts needs the OTA backend and the OTA admin: run it with E2E_WITH_OTA=1 (the Amadeus stub, " +
        "the OTA worker, API and admin)",
    );
  }
  // Budget: two sign-ups with their verification e-mails (up to 15 s each), the OTA's set-up on the OTA worker (about
  // 2 s locally; PF-11 allows a minute), the invitation e-mail (up to 15 s), a few platform API calls and the two
  // single sign-ons into the console (a few seconds each, axe on the portal's page included): 150 s.
  test.setTimeout(150_000);
  owned = await newOwnerWithActiveOta(OWNER_NAME, "sexp");
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
  const memberSession = await signInWithApi(member);
  const accept: Schemas["InvitationTokenRequest"] = { token };
  await callPlatformApi<Schemas["InvitationAccepted"]>({
    operation: "acceptInvitation",
    method: "POST",
    path: "/v1/invitations/accept",
    endUserIp: member.endUserIp,
    accessToken: memberSession.accessToken,
    body: accept,
  });

  ({ context: ownerContext, page: ownerConsole } = await openConsole(
    browser,
    owned.owner.account,
    owned.session,
  ));
  ({ context: memberContext, page: memberConsole } = await openConsole(browser, member, memberSession));
});

test.afterAll(async () => {
  await secondDevice?.close();
  await memberContext?.close();
  await ownerContext?.close();
});

test("the access cookie expires mid-session and the next navigation refreshes the session once [OAD-019 step 2]", async () => {
  const before = await sessionOf(ownerContext);
  expect(before.family.current).toBe(before.tokenHash);

  await expireAccessCookie(ownerContext);
  // The next navigation: a link of the console's navigation, as staff move on.
  await ownerConsole
    .getByRole("navigation", { name: "Console" })
    .getByRole("link", { name: "Payments", exact: true })
    .click();
  await expect(ownerConsole.getByRole("heading", { level: 1, name: "Payments" })).toBeVisible();
  await expectAdminPage(ownerConsole, "Payments");

  // Renewed once: a new access cookie and a new refresh token, and the API rotated the family exactly once, to the new
  // token (the old one is now a rotated one, which would end the family if it were presented again).
  const after = await sessionOf(ownerContext);
  expect(after.tokenHash).not.toBe(before.tokenHash);
  expect(after.family).toEqual({ current: after.tokenHash, rotations: before.family.rotations + 1 });
  const renewed = (await ownerContext.cookies(OTA_ADMIN_URL))
    .filter((cookie) => cookie.name === ACCESS_COOKIE || cookie.name === REFRESH_COOKIE)
    .map(({ name, httpOnly, secure, sameSite, path }) => ({ name, httpOnly, secure, sameSite, path }))
    .sort((a, b) => a.name.localeCompare(b.name));
  expect(renewed).toEqual(
    [ACCESS_COOKIE, REFRESH_COOKIE].map((name) => ({
      name,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
    })),
  );

  // The renewed session goes on without another refresh.
  await ownerConsole.goto("/bookings");
  await expectAdminPage(ownerConsole, "Bookings");
  expect(await sessionOf(ownerContext)).toEqual(after);
});

test("two tabs that navigate at the same moment after the access cookie expired refresh the session once [OAD-019 step 2]", async () => {
  const before = await sessionOf(ownerContext);
  await expireAccessCookie(ownerContext);

  // Two pages of the same browser ask at once, both with the same refresh token and no access token. "At once" is
  // made sure of: each document request is held until the other is held too, and then both go on together, so
  // neither leaves after the other's answer brought the new cookies (which would need no refresh at all).
  const held = [`${OTA_ADMIN_URL}/customers`, `${OTA_ADMIN_URL}/supplier-log`];
  let waiting = held.length;
  let letGo: () => void = () => undefined;
  const together = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  const holdUntilBoth = async (route: Route): Promise<void> => {
    waiting -= 1;
    if (waiting === 0) {
      letGo();
    }
    await together;
    await route.continue();
  };
  for (const url of held) {
    await ownerContext.route(url, holdUntilBoth);
  }
  const otherTab = await ownerContext.newPage();
  try {
    const [first, second] = await Promise.all([
      ownerConsole.goto("/customers"),
      otherTab.goto("/supplier-log"),
    ]);
    if (first === null || second === null) {
      throw new Error("a tab's navigation gave no answer");
    }
    // Both document requests were held and let go together.
    expect(waiting).toBe(0);
    for (const url of held) {
      await ownerContext.unroute(url, holdUntilBoth);
    }
    expect(first.status()).toBe(200);
    expect(second.status()).toBe(200);
    // Both requests carried the old refresh token and no access token: two refreshes of one token asked at once.
    for (const answer of [first, second]) {
      const sent = cookiesSent(await answer.request().allHeaders());
      expect(sent.has(ACCESS_COOKIE)).toBe(false);
      expect(sha256Hex(sent.get(REFRESH_COOKIE) ?? "")).toBe(before.tokenHash);
    }
    await expectAdminPage(ownerConsole, "Customers");
    await expectAdminPage(otherTab, "Supplier log");

    // One refresh for both: the family rotated once, and it is still there (two refreshes with the one token would
    // have revoked it as a reuse), so the OTA admin's de-duplication made one call for the two.
    const after = await sessionOf(ownerContext);
    expect(after.tokenHash).not.toBe(before.tokenHash);
    expect(after.family).toEqual({ current: after.tokenHash, rotations: before.family.rotations + 1 });
    await otherTab.reload();
    await expectAdminPage(otherTab, "Supplier log");
    expect(await sessionOf(ownerContext)).toEqual(after);
  } finally {
    for (const url of held) {
      await ownerContext.unroute(url, holdUntilBoth);
    }
    await otherTab.close();
  }
});

test("the owner removes the member in the portal [OAD-019 step 2] [PF-21 AC3]", async () => {
  // The member is at work in the console.
  await memberConsole.goto("/bookings");
  await expectAdminPage(memberConsole, "Bookings");

  const portal = await ownerContext.newPage();
  try {
    await portal.goto(`${PORTAL_URL}/otas/${encodeURIComponent(owned.ota.id)}/team`);
    await expectPortalPage(portal, "Team");
    const row = portal
      .getByRole("table", { name: "Members of this OTA" })
      .getByRole("row")
      .filter({ hasText: member.email });
    await expect(row).toContainText("Agent");
    await row.getByRole("button", { name: `Remove ${MEMBER_NAME}` }).click();
    const dialog = portal.getByRole("alertdialog", { name: `Remove ${MEMBER_NAME} from the team?` });
    await expect(dialog).toBeVisible();
    await expectPortalPage(portal, "Team");
    // Counted from the confirmation on, which is sent before the platform commits: the bound is measured on the safe
    // side.
    removedAt = performance.now();
    await dialog.getByRole("button", { name: "Remove member" }).click();
    await expect(
      portal.getByRole("status").filter({ hasText: "The member was removed from the team." }),
    ).toBeVisible();
    await expect(row).toHaveCount(0);
    await expectPortalPage(portal, "Team");
  } finally {
    await portal.close();
  }
});

test("within 60 seconds the removed member is signed out of the console, and the session cannot be renewed [OAD-019 step 2] [PF-21 AC3]", async () => {
  if (removedAt === undefined) {
    throw new Error("the previous step removed no member");
  }
  // The member goes on working: each look at /bookings asks the OTA API, whose staff guard refuses the removed member
  // (403 STAFF_MEMBERSHIP_INACTIVE) once the cached membership is gone, and the console then sends them to the portal.
  const landed = await waitUntilSentToPortal(memberConsole);
  const signedOutAfterMs = performance.now() - removedAt;
  test
    .info()
    .annotations.push({ type: "signed out after", description: `${Math.round(signedOutAfterMs)} ms` });
  expect(signedOutAfterMs).toBeLessThan(PF21_BOUND_MS);
  // The member still has a portal session: the portal's console page of the OTA says why.
  expect(landed).toBe(portalConsoleUrlOf(owned.ota.id));
  await expect(memberConsole.getByRole("heading", { level: 1, name: "Open the OTA admin" })).toBeVisible();
  await expect(memberConsole.getByRole("status").filter({ hasText: "or no longer are" })).toBeVisible();
  await expectPortalPage(memberConsole, "Open the OTA admin");

  await expectNoRenewal(memberContext, memberConsole);
  await expectPortalPage(memberConsole, "Open the OTA admin");
});

test("the owner opens the console on a second device [OAD-019 step 2]", async ({ browser }) => {
  // A second portal sign-in of the owner (a family of its own), then the single sign-on into the console.
  const opened = await openConsole(browser, owned.owner.account, await signInWithApi(owned.owner.account));
  secondDevice = opened.context;
  // The owner's first device is still at work in the console.
  await ownerConsole.goto("/bookings");
  await expectAdminPage(ownerConsole, "Bookings");
});

test('"Sign out everywhere" in the portal ends the console sessions of both devices [OAD-019 step 2] [PF-06 AC2]', async () => {
  const device = secondDevice;
  if (device === undefined) {
    throw new Error("the previous step opened no second device");
  }
  const secondConsole = device.pages()[0];
  if (secondConsole === undefined) {
    throw new Error("the second device has no page");
  }

  // The owner's first device: the portal's security page in a tab next to the console.
  const portal = await ownerContext.newPage();
  try {
    await portal.goto(`${PORTAL_URL}/account/security`);
    await expectPortalPage(portal, "Security");
    await portal.getByRole("button", { name: "Sign out everywhere" }).click();
    const dialog = portal.getByRole("alertdialog", { name: "Sign out everywhere?" });
    await expect(dialog).toBeVisible();
    await expectPortalPage(portal, "Security");
    await dialog.getByRole("button", { name: "Sign out everywhere" }).click();
    await portal.waitForURL(`${PORTAL_URL}/sign-in?signedOut=1`);
    await expect(portal.getByText("You are signed out.")).toBeVisible();
    await expectPortalPage(portal, "Sign in");
  } finally {
    await portal.close();
  }

  // Both consoles still hold their access tokens, which have not expired: the account's cut-off, not an expiry, ends
  // the sessions. The next look at the console sends each device to the portal (which asks the owner to sign in).
  for (const [context, page] of [
    [ownerContext, ownerConsole],
    [device, secondConsole],
  ] as const) {
    expect(await adminCookie(context, ACCESS_COOKIE)).toBeDefined();
    await waitUntilSentToPortal(page);
    await expectNoRenewal(context, page);
    await expect(page).toHaveTitle(/ · Velexis$/);
    await expectNoSeriousA11yViolations(page);
  }
});
