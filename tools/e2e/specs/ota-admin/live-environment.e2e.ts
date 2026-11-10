// The live environment of the OTA admin (OAD-018; ota/admin/README.md §4 "Environment switch" and §9, OADR-0018
// point 6, OADR-0011 point 5, routes.md §1), against the built OTA admin and OTA API, so the journey needs
// `E2E_WITH_OTA=1` (the e2e workflow sets it).
//
//   after go-live an agent opens the console in TEST (the test booking only) → switches to LIVE: the dashboard of the
//   live environment, the warning colour and strip, the live booking only, the test booking's page "not found" → a
//   destructive dialog of the live booking repeats LIVE (badge, warning, "… in LIVE") and is left unsent → back to TEST:
//   the test booking only again → a viewer of the same live OTA sees no switch and the test data only → the platform's
//   billing notice shows in the shell for every role, with the link to the portal's billing page for finance only of
//   the three (owner and finance, the portal's viewBilling rule: lead decision (2o) of 2026-11-02, FIX-W39-OTA), and
//   goes again
//
// Arranged in `beforeAll` through the platform API and the OTA API (PADR-0017 item 5), as roles.e2e.ts does:
//   - the owner's OTA with its Amadeus test office from the Velexis test pool (`newOwnerWithActiveOta`: one of the
//     forty offices of the platform's dev:seed, which every OTA journey of a run shares), its airline card switched on
//     for its test storefront and two bookings made through the OTA API as its storefront edge (`EdgeApi`): one that the
//     airline ticketed (it stays a test booking) and one that the airline left without tickets (the stub's
//     `ticketing-failed` scenario), so it waits in manual review: a booking whose page offers an agent Issue and Cancel;
//   - three verified accounts with MFA (a live OTA's console needs it, PADR-0008), which the owner invites as `viewer`,
//     `agent` and `finance` (createInvitation) and which accept with the token of the invitation e-mail
//     (acceptInvitation);
//   - then the OTA goes live, as roles.e2e.ts makes it: no operation makes an OTA live before the platform's go-live
//     (PBE-061), so its platform row is set `storefront_environment = live` as the platform API's own role and the
//     platform's `tenant` invalidation published, as the platform does after its commit;
//   - and the go-live's first live booking is seeded: the stack has no live Amadeus account (dev:seed seeds the test
//     account and its forty test offices only; a live connection's secret is sealed by the platform), so no live
//     storefront search can reach Amadeus, and no operation moves a booking between environments. The manual-review
//     booking's rows that the console reads (the booking and its payment, with the checkout they came from) are moved
//     into the live environment by `moveBookingIntoLive` of support/ota.ts (`tenantTx` as velexis_ota_app; FIX-W46-OTA,
//     lead decision (11l) of 2026-11-06). The console reads every row of one environment only (OBE-081), so that
//     booking is the live environment's one booking, and the ticketed one the test environment's.
//
// No step sends a live action: the dialogs are opened and closed, so nothing reaches the live Amadeus connection the
// stack does not have. The billing notice is the platform's `tenants.billing_notice`, which its billing sync writes;
// the journey writes it as the platform API's own role and publishes the `tenant` invalidation, as the sync does, and
// reloads the page until the OTA API's next `console.auth.me` answers it (its cached tenant row is dropped by the
// invalidation).
//
// Every page the journey visits passes axe once its title is in place (in live mode too, with its warning colours, and
// with each billing notice), and on every page of the OTA admin JavaScript reads no cookie. The steps are tests in
// order (`mode: "serial"`) on a browser context per member, which the member's first step opens.
import { type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import type { components } from "@velexis/api-types/platform";
import { expectNoSeriousA11yViolations } from "../../support/a11y";
import {
  addSessionCookies,
  callPlatformApi,
  createVerifiedAccount,
  enableMfa,
  expect,
  newAccountContext,
  signInWithApi,
  test,
  uniqueTestIp,
  type MfaAccount,
  type SessionTokens,
} from "../../support/fixtures";
import { uniqueEmail, waitForLink } from "../../support/mailpit";
import {
  bookAirlineCardTrip,
  EdgeApi,
  moveBookingIntoLive,
  newOwnerWithActiveOta,
  openConsoleFromPortal,
  publishTenantInvalidation,
  scriptReadableCookieNames,
  switchAirlineCardOn,
  withTenantTx,
  type OwnedOta,
  type SeededBooking,
} from "../../support/ota";
import { buildAccount, setTenantBillingNotice, setTenantLive, stack } from "../../support/seed";
import { OTA_ADMIN_URL, PORTAL_URL } from "../../support/stack";

test.describe.configure({ mode: "serial" });

type Schemas = components["schemas"];
type MemberRole = "agent" | "viewer" | "finance";

/** The owner's name: the inviter in the invitation e-mails' subject. */
const OWNER_NAME = "Lena Live";

/** The OTA admin's title of a page (`%s · Velexis OTA admin`, src/app/layout.tsx). */
const adminTitle = (title: string): string => `${title} · Velexis OTA admin`;

/** The shell's strip in live mode and the dialogs' live warning (components/env-banner.tsx, confirm-dialog.tsx). */
const LIVE_STRIP = "LIVE environment: bookings, tickets and payments here are real.";
const LIVE_DIALOG_WARNING = "LIVE: this changes real bookings, tickets and payments.";

/** The environment cookie of the staff session (README §4): `test` or `live`, no secret. */
const ENVIRONMENT_COOKIE = "__Host-vx_env";

/** The billing banner's link (components/billing-banner.tsx), for owner and finance only. */
const BILLING_LINK = "Go to billing in the portal";
/** What the billing banner says instead of the link to the roles the portal's billing page refuses. */
const BILLING_ROLES_NOTE = "The OTA's owners and finance staff manage billing in the portal.";

/** A member of the OTA: the account (with MFA) and the portal session its browser holds. */
interface Member {
  readonly account: MfaAccount;
  readonly session: SessionTokens;
}

/** A member's browser on the OTA admin: its context and its page. */
interface ConsoleSession {
  readonly context: BrowserContext;
  readonly page: Page;
}

let owned: OwnedOta;
/** Ticketed by the airline; stays in the test environment. */
let testBooking: SeededBooking;
/** Left in manual review, then moved into the live environment: the live environment's one booking. */
let liveBooking: SeededBooking;
const members: Partial<Record<MemberRole, Member>> = {};
const consoles: Partial<Record<MemberRole, ConsoleSession>> = {};

/** Waits until `target` shows the OTA admin's page `title`, then runs axe and checks that no cookie is readable. */
async function expectAdminPage(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(adminTitle(title));
  await expectNoSeriousA11yViolations(target);
  expect(await scriptReadableCookieNames(target)).toEqual([]);
}

/**
 * A verified account with MFA that the owner invites as `role` and that accepts with the token of the invitation
 * e-mail; its portal session (the TOTP step of `signInWithApi`) is the one its browser holds afterwards. As
 * roles.e2e.ts adds its members.
 */
async function addMember(role: MemberRole, fullName: string): Promise<Member> {
  const account = await enableMfa(await createVerifiedAccount(buildAccount({ fullName })));
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
  const session = await signInWithApi(account);
  const accept: Schemas["InvitationTokenRequest"] = { token };
  await callPlatformApi<Schemas["InvitationAccepted"]>({
    operation: "acceptInvitation",
    method: "POST",
    path: "/v1/invitations/accept",
    endUserIp: account.endUserIp,
    accessToken: session.accessToken,
    body: accept,
  });
  return { account, session };
}

/**
 * Makes the OTA live (`storefront_environment = live`), as the platform's go-live of M5 will (see roles.e2e.ts): its
 * platform row as the platform API's own role (`setTenantLive` of support/seed.ts), then the platform's `tenant`
 * invalidation, as the platform publishes after its commit (the OTA API reads the row again at once instead of after
 * its 60 s cache).
 */
async function goLive(tenantId: string): Promise<void> {
  await setTenantLive(tenantId);
  await publishTenantInvalidation(tenantId);
}

/**
 * Sets the OTA's billing notice (`past_due`, `trial_ending`, `null`) as the platform's billing sync does
 * (`setTenantBillingNotice` of support/seed.ts, as the platform API's own role), then the platform's `tenant`
 * invalidation.
 */
async function setBillingNotice(tenantId: string, notice: "past_due" | "trial_ending" | null): Promise<void> {
  await setTenantBillingNotice(tenantId, notice);
  await publishTenantInvalidation(tenantId);
}

/** The member's browser on the OTA admin, with their portal session, in the console of the OTA (on /bookings). */
async function openConsoleAs(browser: Browser, role: MemberRole): Promise<ConsoleSession> {
  const member = members[role];
  if (member === undefined) {
    throw new Error(`the arrangement made no ${role}`);
  }
  const context = await newAccountContext(browser, member.account, OTA_ADMIN_URL);
  await addSessionCookies(context, "portal", member.session);
  const page = await context.newPage();
  consoles[role] = { context, page };
  await openConsoleFromPortal(page, owned.ota.id);
  await expectAdminPage(page, "Bookings");
  await expect(page.getByText(owned.ota.name, { exact: true })).toBeVisible();
  return { context, page };
}

/** The page of the member's console that the member's first step opened. */
function consolePageOf(role: MemberRole): Page {
  const session = consoles[role];
  if (session === undefined) {
    throw new Error(`the ${role}'s console was not opened by the step before`);
  }
  return session.page;
}

/** The value of the environment cookie in the member's browser (`test` or `live`). */
async function environmentCookieOf(role: MemberRole): Promise<string | undefined> {
  const session = consoles[role];
  const cookies = (await session?.context.cookies(OTA_ADMIN_URL)) ?? [];
  return cookies.find((cookie) => cookie.name === ENVIRONMENT_COOKIE)?.value;
}

/** The shell's environment as the page shows it: the outermost `data-environment` of the shell. */
const shellEnvironment = (page: Page) => page.locator("div[data-environment]").first();

/** `/bookings` lists `shown` and not `hidden`. */
async function expectBookingsList(page: Page, shown: SeededBooking, hidden: SeededBooking): Promise<void> {
  await page.goto("/bookings");
  await expectAdminPage(page, "Bookings");
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: shown.reference, exact: true })).toBeVisible();
  await expect(main.getByRole("link", { name: hidden.reference, exact: true })).toHaveCount(0);
}

/** The booking page of `booking` says it is not in `environment` (the page's own "not found" state, OAD-007). */
async function expectBookingNotFound(page: Page, booking: SeededBooking, environment: "TEST" | "LIVE") {
  await page.goto(`/bookings/${encodeURIComponent(booking.bookingId)}`);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { name: "Booking not found" })).toBeVisible();
  await expect(
    main.getByText(`No booking with this id in the ${environment} environment.`, { exact: false }),
  ).toBeVisible();
  await expect(main.getByText(booking.reference, { exact: true })).toHaveCount(0);
  await expectAdminPage(page, "Booking");
}

/** Clicks `environment` in the shell's switch and waits for the dashboard of that environment. */
async function switchTo(page: Page, environment: "TEST" | "LIVE"): Promise<void> {
  const group = page.getByRole("group", { name: "Environment" });
  await group.getByRole("button", { name: environment, exact: true }).click();
  // switchEnvironment (env-actions.ts) sets the cookie and sends the staff member to the new environment's dashboard.
  await page.waitForURL(`${OTA_ADMIN_URL}/`);
  await expect(group.getByRole("button", { name: environment, exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await expectAdminPage(page, "Dashboard");
}

/**
 * Reloads `page` until `banner` is in the state `visible` asks for: the OTA API answers the new billing notice from the
 * next `console.auth.me` after the `tenant` invalidation reached it, which a reload asks for again.
 */
async function reloadUntil(page: Page, visible: boolean, banner: Locator): Promise<void> {
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(banner).toHaveCount(visible ? 1 : 0, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

test.beforeAll(async () => {
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "live-environment.e2e.ts needs the OTA backend and the OTA admin: run it with E2E_WITH_OTA=1 (the Amadeus " +
        "stub, the OTA worker, API and admin)",
    );
  }
  // Budget: four sign-ups with their verification e-mails (up to 15 s each, three at once), the OTA's set-up on the OTA
  // worker (about 2 s locally; PF-11 allows a minute), two bookings through the OTA API and the stub (a second or two
  // each), the three invitation e-mails (up to 15 s, at once) and each member's TOTP sign-in, which waits for a time
  // step the MFA set-up did not use (up to 30 s, at once): 180 s.
  test.setTimeout(180_000);
  owned = await newOwnerWithActiveOta(OWNER_NAME, "liv");
  await switchAirlineCardOn(owned.schema);
  const edge = new EdgeApi(owned.storefrontHost, uniqueTestIp());
  testBooking = await bookAirlineCardTrip(edge, {
    daysAhead: 57,
    traveller: { firstName: "Tove", lastName: "Testmode", dateOfBirth: "1984-03-17", gender: "FEMALE" },
    email: uniqueEmail("oad018-test"),
  });
  liveBooking = await bookAirlineCardTrip(edge, {
    daysAhead: 58,
    traveller: { firstName: "Leif", lastName: "Livemode", dateOfBirth: "1977-12-02", gender: "MALE" },
    email: uniqueEmail("oad018-live"),
    completionScenario: "ticketing-failed",
  });
  const [viewer, agent, finance] = await Promise.all([
    addMember("viewer", "Vilde Viewer"),
    addMember("agent", "Arne Agent"),
    addMember("finance", "Frida Finance"),
  ]);
  members.viewer = viewer;
  members.agent = agent;
  members.finance = finance;
  await goLive(owned.ota.id);
  await moveBookingIntoLive(owned.schema, liveBooking);
});

test.afterAll(async () => {
  for (const session of Object.values(consoles)) {
    await session?.context.close();
  }
});

test("an agent of the live OTA opens the console in TEST and sees the test booking only [OAD-018 AC2]", async ({
  browser,
}) => {
  const { page } = await openConsoleAs(browser, "agent");
  // The switch of a live OTA, for a role other than viewer (OADR-0011 point 5), in the test environment a new session
  // starts in (README §3).
  const group = page.getByRole("group", { name: "Environment" });
  await expect(group.getByRole("button", { name: "TEST", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(group.getByRole("button", { name: "LIVE", exact: true })).toBeEnabled();
  await expect(shellEnvironment(page)).toHaveAttribute("data-environment", "test");
  await expect(page.getByText(LIVE_STRIP)).toHaveCount(0);
  expect(await environmentCookieOf("agent")).toBe("test");

  await expectBookingsList(page, testBooking, liveBooking);
});

test("the agent switches to LIVE and sees the live booking only [OAD-018 AC2]", async () => {
  const page = consolePageOf("agent");
  await switchTo(page, "LIVE");

  // The whole shell in live mode: its warning colour and strip, and the cookie every SDK client of a request reads.
  await expect(shellEnvironment(page)).toHaveAttribute("data-environment", "live");
  await expect(page.getByRole("note").filter({ hasText: LIVE_STRIP })).toBeVisible();
  expect(await environmentCookieOf("agent")).toBe("live");
  // The dashboard of the live environment: its latest bookings are the live one.
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: liveBooking.reference, exact: true })).toBeVisible();
  await expect(main.getByRole("link", { name: testBooking.reference, exact: true })).toHaveCount(0);

  await expectBookingsList(page, liveBooking, testBooking);
  // The test booking does not exist in live, not even by its address.
  await expectBookingNotFound(page, testBooking, "LIVE");
  await expect(shellEnvironment(page)).toHaveAttribute("data-environment", "live");
});

test("a destructive dialog of the live booking repeats LIVE and sends nothing [OAD-018 AC2]", async () => {
  const page = consolePageOf("agent");
  await page.goto("/bookings");
  await expectAdminPage(page, "Bookings");
  await page.getByRole("main").getByRole("link", { name: liveBooking.reference, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(liveBooking.reference);
  await expectAdminPage(page, "Booking");
  const actions = page.getByRole("main").getByRole("region", { name: "Booking actions" });

  for (const [trigger, title, confirm] of [
    ["Cancel the booking", `Cancel ${liveBooking.reference}?`, "Cancel the booking in LIVE"],
    ["Issue tickets", `Issue the tickets of ${liveBooking.reference}?`, "Issue tickets in LIVE"],
  ] as const) {
    await actions.getByRole("button", { name: trigger, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: title })).toBeVisible();
    // LIVE three times: the environment badge, the warning and the confirming button.
    await expect(dialog.getByText("Environment: LIVE", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("note")).toHaveText(LIVE_DIALOG_WARNING);
    await expect(dialog.getByRole("button", { name: confirm, exact: true })).toBeVisible();
    await expectNoSeriousA11yViolations(page);
    // Left unsent: "Cancel" closes the dialog.
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
  }

  // Nothing was sent: the booking is as it was, and no staff action was written for it.
  const after = await withTenantTx(owned.schema, async (trx) => ({
    booking: await trx
      .selectFrom("bookings")
      .select(["environment", "ticketing_status"])
      .where("id", "=", liveBooking.bookingId)
      .executeTakeFirstOrThrow(),
    actions: await trx
      .selectFrom("staff_actions")
      .select("action")
      .where("booking_id", "=", liveBooking.bookingId)
      .execute(),
  }));
  expect(after).toEqual({ booking: { environment: "live", ticketing_status: "manual_review" }, actions: [] });
});

test("the agent switches back to TEST and sees the test booking only again [OAD-018 AC2]", async () => {
  const page = consolePageOf("agent");
  await switchTo(page, "TEST");

  await expect(shellEnvironment(page)).toHaveAttribute("data-environment", "test");
  await expect(page.getByText(LIVE_STRIP)).toHaveCount(0);
  expect(await environmentCookieOf("agent")).toBe("test");
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: testBooking.reference, exact: true })).toBeVisible();
  await expect(main.getByRole("link", { name: liveBooking.reference, exact: true })).toHaveCount(0);

  await expectBookingsList(page, testBooking, liveBooking);
  await expectBookingNotFound(page, liveBooking, "TEST");
});

test("a viewer of the live OTA still sees no switch and the test data only [OAD-018 AC2]", async ({
  browser,
}) => {
  const { page } = await openConsoleAs(browser, "viewer");
  // The TEST badge, no switch: a viewer opens the test environment only, even of a live OTA.
  const header = page.getByRole("banner");
  await expect(header.getByText("Environment: TEST", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Environment" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "LIVE", exact: true })).toHaveCount(0);
  await expect(shellEnvironment(page)).toHaveAttribute("data-environment", "test");
  expect(await environmentCookieOf("viewer")).toBe("test");

  await expectBookingsList(page, testBooking, liveBooking);
  await expectBookingNotFound(page, liveBooking, "TEST");
});

test("the platform's billing notice shows in the shell for every role, the portal's billing page for finance [OAD-018 AC1] [FIX-W39-OTA AC5]", async ({
  browser,
}) => {
  const page = consolePageOf("agent");
  const billingPage = `${PORTAL_URL}/otas/${encodeURIComponent(owned.ota.id)}/billing`;
  await page.goto("/bookings");
  await expectAdminPage(page, "Bookings");

  // A failed payment: an alert above every page. An agent may not open the portal's billing page (its viewBilling
  // rule: owner and finance), so it reads who manages billing instead of a link.
  await setBillingNotice(owned.ota.id, "past_due");
  const pastDue = page.locator('[data-notice="past_due"]');
  await reloadUntil(page, true, pastDue);
  await expect(pastDue).toHaveAttribute("role", "alert");
  await expect(pastDue).toContainText("Payment problem: update billing in the portal");
  await expect(pastDue).toContainText(BILLING_ROLES_NOTE);
  await expect(pastDue.getByRole("link", { name: BILLING_LINK })).toHaveCount(0);
  await expectAdminPage(page, "Bookings");
  // The viewer's shell shows it too: the notice is the OTA's, for every role; no link either.
  const viewerPage = consolePageOf("viewer");
  await viewerPage.goto("/bookings");
  const viewerNotice = viewerPage.locator('[data-notice="past_due"]');
  await reloadUntil(viewerPage, true, viewerNotice);
  await expect(viewerNotice.getByRole("link", { name: BILLING_LINK })).toHaveCount(0);
  await expectAdminPage(viewerPage, "Bookings");
  // Finance staff get the link to the portal's billing page of the OTA.
  const { page: financePage } = await openConsoleAs(browser, "finance");
  const financeNotice = financePage.locator('[data-notice="past_due"]');
  await reloadUntil(financePage, true, financeNotice);
  await expect(financeNotice.getByRole("link", { name: BILLING_LINK })).toHaveAttribute("href", billingPage);
  await expect(financeNotice).not.toContainText(BILLING_ROLES_NOTE);
  await expectAdminPage(financePage, "Bookings");

  // An ending trial: a status message, with the same link for finance and the same note for the agent. Its words hold
  // before and after the trial's end (lead decision (2k) of 2026-11-04, FIX-W41-OTA).
  await setBillingNotice(owned.ota.id, "trial_ending");
  const trialEnding = page.locator('[data-notice="trial_ending"]');
  await reloadUntil(page, true, trialEnding);
  await expect(trialEnding).toHaveAttribute("role", "status");
  await expect(trialEnding).toContainText("Your trial is ending: choose a plan in the portal");
  await expect(trialEnding).toContainText(BILLING_ROLES_NOTE);
  await expect(trialEnding.getByRole("link", { name: BILLING_LINK })).toHaveCount(0);
  await expect(pastDue).toHaveCount(0);
  await expectAdminPage(page, "Bookings");
  const financeTrial = financePage.locator('[data-notice="trial_ending"]');
  await reloadUntil(financePage, true, financeTrial);
  await expect(financeTrial.getByRole("link", { name: BILLING_LINK })).toHaveAttribute("href", billingPage);
  await expectAdminPage(financePage, "Bookings");

  // No notice: no banner.
  await setBillingNotice(owned.ota.id, null);
  await reloadUntil(page, false, page.locator("[data-notice]"));
  await expect(page.getByRole("link", { name: BILLING_LINK })).toHaveCount(0);
  await expectAdminPage(page, "Bookings");
  await reloadUntil(financePage, false, financePage.locator("[data-notice]"));
  await expect(financePage.getByRole("link", { name: BILLING_LINK })).toHaveCount(0);
});
