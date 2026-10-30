// The roles of the OTA admin (OAD-017; ota/admin/README.md §8 and §12, scope §1.3, OF-09 AC2): what a viewer and an
// agent of a live OTA see and may open, against the built OTA admin and OTA API, so the journey needs `E2E_WITH_OTA=1`
// (the e2e workflow sets it).
//
//   a viewer opens the console from the portal → the TEST badge and no TEST / LIVE switch, no action on a booking that
//   waits for staff, the settings read only → an agent of the same OTA → the switch with LIVE, the booking's Issue and
//   Cancel, but no settings write: no "New …" link, the forms read only, and the pages that create settings refused
//
// The scope's matrix (§1.3) for the two roles: a viewer reads everything and opens the test environment only; an agent
// works bookings (issue, cancel), opens the live environment of a live OTA and reads the settings without
// `settings:write`. The admin hides what a role cannot do (README §8); the API decides, which OBE-075's permission
// matrix test proves operation by operation, so this journey checks what each person is shown and what the admin's
// pages refuse.
//
// Arranged in `beforeAll` through the platform API and the OTA API (PADR-0017 item 5), as console-sso.e2e.ts does:
//   - the owner's OTA with its Amadeus test office (`newOwnerWithActiveOta`), its airline card switched on for its test
//     storefront and one booking made through the OTA API as its storefront edge (`EdgeApi`) that the airline left
//     without tickets (the stub's `ticketing-failed` scenario), so it waits in manual review: a booking an agent may
//     issue or cancel;
//   - two verified accounts with MFA, which the owner invites as `viewer` and `agent` (createInvitation) and which
//     accept with the token of the invitation e-mail (acceptInvitation);
//   - then the OTA goes live: no operation makes an OTA live before the platform's go-live of M5, so its platform row
//     is set `storefront_environment = live` as velexis_migrator (as `withSuspendedTenant` of support/ota.ts writes a
//     platform row) and the platform's `tenant` invalidation published, as the platform does after its commit. A live
//     OTA is what gives the switch a meaning (OADR-0011 point 5: `live` for a live OTA and a role other than viewer),
//     and its console needs accounts with MFA (PADR-0008), which is why both members have it. The booking was made
//     before, in the test environment, which the console opens first.
//
// Every page the journey visits passes axe once its title is in place, and on every page of the OTA admin JavaScript
// reads no cookie. The steps are tests in order (`mode: "serial"`), three per member on a browser context of the
// member's own, which the member's first step opens.
import { type Browser, type BrowserContext, type Page } from "@playwright/test";
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
  newOwnerWithActiveOta,
  openConsoleFromPortal,
  publishTenantInvalidation,
  scriptReadableCookieNames,
  switchAirlineCardOn,
  withTenantTx,
  type OwnedOta,
  type SeededBooking,
} from "../../support/ota";
import { buildAccount, stack, withDatabase } from "../../support/seed";
import { OTA_ADMIN_URL, PORTAL_URL } from "../../support/stack";

test.describe.configure({ mode: "serial" });

type Schemas = components["schemas"];
type MemberRole = "agent" | "viewer";

/** The owner's name: the inviter in the invitation e-mails' subject. */
const OWNER_NAME = "Rita Roles";

/** The OTA admin's title of a page (`%s · Velexis OTA admin`, src/app/layout.tsx). */
const adminTitle = (title: string): string => `${title} · Velexis OTA admin`;

/** The words the permission gate gives a missing permission (components/permission-gate.tsx). */
const NEEDS_SETTINGS_WRITE = "Needs the permission settings:write";

/** A member of the OTA: the account (with MFA) and the portal session its browser holds. */
interface Member {
  readonly account: MfaAccount;
  readonly session: SessionTokens;
}

let owned: OwnedOta;
let booking: SeededBooking;
const members: Partial<Record<MemberRole, Member>> = {};

/** Waits until `target` shows the OTA admin's page `title`, then runs axe and checks that no cookie is readable. */
async function expectAdminPage(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(adminTitle(title));
  await expectNoSeriousA11yViolations(target);
  expect(await scriptReadableCookieNames(target)).toEqual([]);
}

/**
 * A verified account with MFA that the owner invites as `role` and that accepts with the token of the invitation
 * e-mail; its portal session (the TOTP step of `signInWithApi`) is the one its browser holds afterwards.
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
 * Makes the OTA `tenantId` live (`storefront_environment = live`), as the platform's go-live of M5 will: its platform
 * row as velexis_migrator, then the platform's `tenant` invalidation, so the OTA API reads it at once.
 */
async function goLive(tenantId: string): Promise<void> {
  await withDatabase("migrator", async (client) => {
    const { rowCount } = await client.query(
      `UPDATE platform.tenants
          SET storefront_environment = 'live', live_enabled_at = now(), version = version + 1, updated_at = now()
        WHERE id = $1 AND status = 'active' AND storefront_environment = 'test'`,
      [tenantId],
    );
    if (rowCount !== 1) {
      throw new Error(`the OTA ${tenantId} is not an active test OTA`);
    }
  });
  await publishTenantInvalidation(tenantId);
}

/** A member's browser on the OTA admin: its context and its page. */
interface ConsoleSession {
  readonly context: BrowserContext;
  readonly page: Page;
}

/** Each member's browser, opened by the member's first step and used by the next one. */
const consoles: Partial<Record<MemberRole, ConsoleSession>> = {};

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

/** Opens the manual-review booking from the bookings list. */
async function openBooking(page: Page): Promise<void> {
  await page.goto("/bookings");
  await expectAdminPage(page, "Bookings");
  await page.getByRole("main").getByRole("link", { name: booking.reference, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(booking.reference);
  await expect(page.getByRole("main").locator('[data-kind="ticketing"]').first()).toHaveAttribute(
    "data-status",
    "manual_review",
  );
  await expectAdminPage(page, "Booking");
}

/**
 * The pricing and storefront settings (markup and fee rules, storefront settings, images): every page readable, none
 * writable (no "New …" link, no Save, no upload, the forms disabled). With `expectContentSettingsReadOnly`, every
 * settings page of the console; two steps per member, so that each stays well within Playwright's 30 s with axe on
 * every page.
 */
async function expectPricingAndStorefrontReadOnly(page: Page): Promise<void> {
  const main = page.getByRole("main");

  // Markup and fee rules: the list, "New … rule" disabled with the permission it needs, and a rule read only.
  await page.goto("/settings/markups");
  await expectAdminPage(page, "Markup rules");
  await expect(main.getByRole("link", { name: "New markup rule" })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "New markup rule" })).toBeDisabled();
  await expect(main.getByRole("button", { name: "New markup rule" })).toHaveAccessibleDescription(
    NEEDS_SETTINGS_WRITE,
  );
  await main.getByRole("link", { name: "Default", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Default");
  await expectAdminPage(page, "Markup rule");
  await expect(
    main.getByText("Read only: changing markup rules needs the permission settings:write."),
  ).toBeVisible();
  await expect(main.getByRole("form")).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Delete rule" })).toHaveCount(0);

  await page.goto("/settings/fees");
  await expectAdminPage(page, "Fee rules");
  await expect(main.getByRole("link", { name: "New fee rule" })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "New fee rule" })).toBeDisabled();

  // Storefront settings: every section's fields disabled, no Save.
  await page.goto("/settings/storefront");
  await expectAdminPage(page, "Storefront settings");
  const branding = main.getByRole("form", { name: "Branding and theme" });
  await expect(branding.getByRole("textbox", { name: "Primary", exact: true })).toBeDisabled();
  await expect(main.getByRole("button", { name: /^Save / })).toHaveCount(0);

  // Storefront images: "Upload an image" disabled with the permission it needs.
  await page.goto("/settings/assets");
  await expectAdminPage(page, "Storefront images");
  await expect(
    main.getByText("Read only: uploading and deleting images needs the permission settings:write."),
  ).toBeVisible();
  await expect(main.getByRole("button", { name: "Upload an image" })).toBeDisabled();
  await expect(main.getByRole("button", { name: "Upload an image" })).toHaveAccessibleDescription(
    NEEDS_SETTINGS_WRITE,
  );
}

/**
 * The content settings (content pages, e-mail templates) read only, and the pages that create settings (markup and
 * fee rules, content pages) refused with the permission named.
 */
async function expectContentSettingsReadOnly(page: Page): Promise<void> {
  const main = page.getByRole("main");

  // Content pages and templates: listed, nothing to create, save or reset.
  await page.goto("/settings/pages");
  await expectAdminPage(page, "Content pages");
  await expect(main.getByRole("link", { name: "New page" })).toHaveCount(0);
  await page.goto("/settings/templates");
  await expectAdminPage(page, "E-mail templates");
  const locale = await withTenantTx(
    owned.schema,
    async (trx) =>
      (await trx.selectFrom("storefront_settings").select("default_locale").executeTakeFirstOrThrow())
        .default_locale,
  );
  await page.goto(`/settings/templates/booking.confirmed/email/${encodeURIComponent(locale)}`);
  await expectAdminPage(page, "E-mail template");
  await expect(
    main.getByText(
      "Read only: changing templates needs the permission settings:write. You can still preview it.",
    ),
  ).toBeVisible();
  await expect(main.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Reset to default" })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Preview", exact: true })).toBeEnabled();

  // The pages that create settings refuse the role, naming the permission, without a form.
  for (const [path, title, refusal] of [
    ["/settings/markups/new", "New markup rule", "You cannot create markup rules"],
    ["/settings/fees/new", "New fee rule", "You cannot create fee rules"],
    ["/settings/pages/new", "Content page", "You cannot create content pages"],
  ] as const) {
    await page.goto(path);
    await expect(main.getByRole("heading", { name: refusal })).toBeVisible();
    await expect(main.getByText("settings:write", { exact: false })).toBeVisible();
    await expect(main.getByRole("form")).toHaveCount(0);
    await expectAdminPage(page, title);
  }
}

test.beforeAll(async () => {
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "roles.e2e.ts needs the OTA backend and the OTA admin: run it with E2E_WITH_OTA=1 (the Amadeus stub, the OTA " +
        "worker, API and admin)",
    );
  }
  // Budget: three sign-ups with their verification e-mails (up to 15 s each, two at once), the OTA's set-up on the OTA
  // worker (about 2 s locally; PF-11 allows a minute), a booking through the OTA API and the stub (a second or two),
  // the two invitation e-mails (up to 15 s, at once) and each member's TOTP sign-in, which waits for a time step the
  // MFA set-up did not use (up to 30 s, at once): 180 s.
  test.setTimeout(180_000);
  owned = await newOwnerWithActiveOta(OWNER_NAME, "role");
  await switchAirlineCardOn(owned.schema);
  booking = await bookAirlineCardTrip(new EdgeApi(owned.storefrontHost, uniqueTestIp()), {
    daysAhead: 55,
    traveller: { firstName: "Rune", lastName: "Waiting", dateOfBirth: "1981-06-30", gender: "MALE" },
    email: uniqueEmail("oad017-roles"),
    completionScenario: "ticketing-failed",
  });
  const [viewer, agent] = await Promise.all([
    addMember("viewer", "Vera Viewer"),
    addMember("agent", "Agnes Agent"),
  ]);
  members.viewer = viewer;
  members.agent = agent;
  await goLive(owned.ota.id);
});

test.afterAll(async () => {
  for (const session of Object.values(consoles)) {
    await session?.context.close();
  }
});

test("a viewer sees no action and no LIVE switch [OAD-017 AC2] [OF-09 AC2]", async ({ browser }) => {
  const { page } = await openConsoleAs(browser, "viewer");
  // The shell: the TEST badge, no switch (a viewer opens the test environment only, even of a live OTA).
  const header = page.getByRole("banner");
  await expect(header.getByText("Environment: TEST", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Environment" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "LIVE", exact: true })).toHaveCount(0);

  // A booking that waits for staff: no action at all.
  await openBooking(page);
  const main = page.getByRole("main");
  await expect(main.getByRole("region", { name: "Booking actions" })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Issue tickets" })).toHaveCount(0);
  await expect(main.getByRole("button", { name: "Cancel the booking" })).toHaveCount(0);

  // The viewer's console session was opened for the viewer role.
  const signIns = await withTenantTx(owned.schema, async (trx) =>
    trx
      .selectFrom("staff_actions")
      .select(["outcome", "staff_role"])
      .where("action", "=", "staff.sign_in")
      .where("staff_role", "=", "viewer")
      .execute(),
  );
  expect(signIns).toEqual([{ outcome: "succeeded", staff_role: "viewer" }]);
});

test("a viewer reads the pricing and storefront settings and can change none [OAD-017 AC2] [OF-09 AC2]", async () => {
  await expectPricingAndStorefrontReadOnly(consolePageOf("viewer"));
});

test("a viewer reads the content settings and cannot open settings writes [OAD-017 AC2] [OF-09 AC2]", async () => {
  await expectContentSettingsReadOnly(consolePageOf("viewer"));
});

test("an agent works the booking and sees the LIVE switch [OAD-017 AC2] [OF-09 AC2]", async ({ browser }) => {
  const { page } = await openConsoleAs(browser, "agent");
  // The shell: the switch of a live OTA, in the test environment.
  const environment = page.getByRole("group", { name: "Environment" });
  await expect(environment.getByRole("button", { name: "TEST", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(environment.getByRole("button", { name: "LIVE", exact: true })).toBeEnabled();

  // The same booking: the agent may issue and cancel it.
  await openBooking(page);
  const actions = page.getByRole("main").getByRole("region", { name: "Booking actions" });
  await expect(actions.getByRole("button", { name: "Issue tickets" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Cancel the booking" })).toBeVisible();
});

test("an agent reads the pricing and storefront settings and can change none [OAD-017 AC2] [OF-09 AC2]", async () => {
  await expectPricingAndStorefrontReadOnly(consolePageOf("agent"));
});

test("an agent cannot open settings writes [OAD-017 AC2] [OF-09 AC2]", async () => {
  await expectContentSettingsReadOnly(consolePageOf("agent"));

  // Nothing either member saw changed a setting: no settings change in the OTA's audit.
  const changes = await withTenantTx(owned.schema, async (trx) =>
    trx
      .selectFrom("staff_actions")
      .select("action")
      .where("action", "like", "settings.%")
      .where("outcome", "=", "succeeded")
      .execute(),
  );
  expect(changes).toEqual([]);
});
