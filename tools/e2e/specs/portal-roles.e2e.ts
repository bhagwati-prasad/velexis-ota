// What each membership role sees in the portal (PFE-028 step 3; platform/docs/scope.md §1.2, platform/frontend/README.md
// §2 "Signed in" and §4 "Navigation"), project `portal`:
//
//   a viewer, a finance member, an agent and an admin of one OTA, each in a browser of their own → the OTA's navigation
//   is exactly the entries of their role → every page of the OTA either shows itself with exactly the actions of their
//   role, or the not-allowed page that names their role
//
// The roles' rights are the matrix of scope §1.2, written out below as this journey's own oracle (`MATRIX`), not read
// from the portal's lib/roles.ts: a change of either one fails here until both agree. The stack turns the switches of
// the settlements, the custom domains and the go-live on (tools/e2e/README.md, the stack), so the navigation has every
// entry a role may get; Stripe Billing, own Amadeus credentials and own Stripe stay off, so no page offers their forms
// to anyone. What each page offers to whom:
//   overview        everyone: the OTA, its storefront and "Open console"; owners and admins also "Edit the OTA profile"
//   settings        owners and admins: the profile form; the others the not-allowed page
//   API keys        owners and admins: the create form; the others the not-allowed page
//   domains         everyone: the Velexis address; owners and admins also "Add a custom domain"
//   Amadeus         owners, admins and finance: the connections; the settings form for owners and admins, a note for
//                   finance; the others the not-allowed page
//   payments        the same rows: the card statement suffix form for owners and admins, a note for finance
//   payout account  owners and finance: the account; finance with the note that only owners change it
//   settlements     owners and finance
//   team            everyone: the members; owners and admins invite (admins agents, finance members and viewers only)
//                   and change or remove the members they may manage; every other row offers nothing but "Leave this
//                   OTA" on one's own
//   billing         owners and finance (finance read-only)
//   go-live         owners only
//
// Arranged in `beforeAll` through the platform API (PADR-0017 item 5): the owner's active OTA, set up by the OTA worker
// (`newOwnerWithActiveOta`, with MFA, so the journey needs `E2E_WITH_OTA=1` and fails at once without it), and the four
// members, verified accounts without MFA that the owner invites (createInvitation) and that accept with the token of
// their invitation e-mail (acceptInvitation); each gets a browser context with its portal session (`signIn`). The OTA
// stays in test mode, so no member meets the MFA enrolment gate (PFE-030). The five accounts fill the early access
// plan's five seats. The steps are tests in order (`mode: "serial"`), two per role.
import type { BrowserContext, Locator, Page } from "@playwright/test";
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
import { newOwnerWithActiveOta, type OwnedOta } from "../support/ota";
import { buildAccount, stack } from "../support/seed";
import { PORTAL_URL } from "../support/stack";

test.describe.configure({ mode: "serial" });

type Schemas = components["schemas"];
type Role = Schemas["TenantRole"];
/** The four roles this journey signs in as. */
type MemberRole = Exclude<Role, "owner">;

/**
 * The budget of the one-time arrangement in `beforeAll` (a hook, not a step of the journey): five accounts through the
 * platform API and Mailpit (up to 15 s each for the verification and the invitation e-mails), the OTA's set-up on the
 * OTA worker (about 2 s, at most 45 s per OTA, and up to three OTAs while admin-amadeus-pool.e2e.ts holds the test
 * pool), and the four invitations.
 */
const ARRANGE_BUDGET_MS = 240_000;

/** The owner's name: the inviter in the invitation e-mails' subject. */
const OWNER_NAME = "Rosa Roles";

/** The rows of scope §1.2 and the roles that may do each: the journey's oracle. */
const MATRIX = Object.freeze({
  viewOta: ["owner", "admin", "agent", "finance", "viewer"],
  openConsole: ["owner", "admin", "agent", "finance", "viewer"],
  editProfile: ["owner", "admin"],
  manageApiKeys: ["owner", "admin"],
  manageDomains: ["owner", "admin"],
  viewConnections: ["owner", "admin", "finance"],
  manageConnections: ["owner", "admin"],
  manageTeam: ["owner", "admin"],
  manageOwnersAndAdmins: ["owner"],
  viewBilling: ["owner", "finance"],
  manageBilling: ["owner"],
  viewSettlements: ["owner", "finance"],
  setPayoutAccount: ["owner"],
  goLive: ["owner"],
} as const satisfies Record<string, readonly Role[]>);
type Right = keyof typeof MATRIX;

/** `role` may do `right` (scope §1.2). */
const may = (role: Role, right: Right): boolean => (MATRIX[right] as readonly Role[]).includes(role);

/**
 * The OTA's navigation entries in their order (README §2 and §4), with the right each needs. Every switch an entry
 * needs (settlements, go-live) is on in the stack.
 */
const OTA_ENTRIES = Object.freeze([
  ["Overview", "viewOta"],
  ["API keys", "manageApiKeys"],
  ["Domains", "viewOta"],
  ["Amadeus", "viewConnections"],
  ["Payments", "viewConnections"],
  ["Payout account", "viewSettlements"],
  ["Settlements", "viewSettlements"],
  ["Team", "manageTeam"],
  ["Billing", "viewBilling"],
  ["Settings", "editProfile"],
  ["Go live", "goLive"],
] as const satisfies readonly (readonly [string, Right])[]);

/** The account entries every signed-in account sees. */
const ACCOUNT_ENTRIES = Object.freeze(["My OTAs", "Profile", "Security"]);

/** The roles in words (`ROLE_LABELS`). */
const ROLE_LABELS: Readonly<Record<Role, string>> = Object.freeze({
  owner: "Owner",
  admin: "Admin",
  agent: "Agent",
  finance: "Finance",
  viewer: "Viewer",
});

/** The members of the journey, in the order of its steps. */
const MEMBER_ROLES = Object.freeze(["viewer", "finance", "agent", "admin"] as const satisfies MemberRole[]);

/** The portal's title of a page (`%s · Velexis`). */
const portalTitle = (title: string): string => `${title} · Velexis`;

/** One member of the journey: the account and its own browser. */
interface Member {
  readonly role: MemberRole;
  readonly account: PortalAccount;
  readonly context: BrowserContext;
  readonly page: Page;
}

let owned: OwnedOta;
const members = new Map<MemberRole, Member>();

function member(role: MemberRole): Member {
  const found = members.get(role);
  if (found === undefined) {
    throw new Error(`the ${role} of the journey was not arranged`);
  }
  return found;
}

/** `/otas/<tenantId><path>`. */
const otaPath = (path = ""): string => `/otas/${owned.ota.id}${path}`;

/** A verified account (no MFA) that the owner invites as `role` and that accepts with its invitation e-mail's token. */
async function invitedMember(role: MemberRole, fullName: string): Promise<PortalAccount> {
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

/**
 * Opens `path` of the OTA in `page` as a new document: `200`, the page's title, then axe on what it shows. A page the
 * role may not open still answers `200`: the not-allowed page is a page of the OTA, with the page's own title.
 */
async function open(page: Page, path: string, title: string): Promise<void> {
  const response = await page.goto(otaPath(path));
  expect(response?.status(), path).toBe(200);
  await expect(page).toHaveTitle(portalTitle(title));
  await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
}

/** The main region of a page. */
const main = (page: Page): Locator => page.getByRole("main");

/** The not-allowed page of `role` (`NotAllowed`): its heading, the role named, and nothing of the page it replaces. */
async function expectNotAllowed(page: Page, role: MemberRole): Promise<void> {
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveText("You cannot open this page");
  await expect(
    main(page).getByText(`Your role in this OTA is ${ROLE_LABELS[role]}, and this page is not part of it.`),
  ).toBeVisible();
  await expect(main(page).getByRole("link", { name: "Back to the OTA overview" })).toHaveAttribute(
    "href",
    otaPath(),
  );
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(main(page).getByRole("button")).toHaveCount(0);
  await expect(main(page).locator("form")).toHaveCount(0);
}

/** Expects `locator` once when `shown`, else nowhere. */
async function expectShownWhen(locator: Locator, shown: boolean): Promise<void> {
  await expect(locator).toHaveCount(shown ? 1 : 0);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(ARRANGE_BUDGET_MS);
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "portal-roles.e2e.ts needs an active OTA: run it with E2E_WITH_OTA=1 (the Amadeus stub and the OTA worker)",
    );
  }
  owned = await newOwnerWithActiveOta(OWNER_NAME, "roles", { mfa: true });
  const names: Readonly<Record<MemberRole, string>> = {
    viewer: "Vera Viewer",
    finance: "Fynn Finance",
    agent: "Agnes Agent",
    admin: "Adam Admin",
  };
  for (const role of MEMBER_ROLES) {
    const account = await invitedMember(role, names[role]);
    const context = await newAccountContext(browser, account, PORTAL_URL);
    await addSessionCookies(context, "portal", await signInWithApi(account));
    members.set(role, { role, account, context, page: await context.newPage() });
  }
});

test.afterAll(async () => {
  for (const { context } of members.values()) {
    await context.close();
  }
});

/** The OTA's navigation entries `role` must see, in order. */
function expectedEntries(role: MemberRole): string[] {
  return OTA_ENTRIES.filter(([, right]) => may(role, right)).map(([label]) => label);
}

/**
 * The navigation, the overview and the team page of one member: the OTA's entries exactly as scope §1.2 gives them,
 * the overview's actions, and what the team page lets the role do.
 */
async function navigationOverviewAndTeam(role: MemberRole): Promise<void> {
  const { page, account } = member(role);
  await open(page, "", "Overview");
  const navigation = page.getByRole("navigation", { name: "Portal" });
  const otaSection = navigation.getByRole("region", { name: `This OTA: ${owned.ota.name}` });
  await expect(otaSection.getByText(ROLE_LABELS[role], { exact: true })).toBeVisible();
  // Exactly the entries of the role, in the README's order, each a link into the OTA; the account entries as for anyone.
  await expect(otaSection.getByRole("link")).toHaveText(expectedEntries(role));
  const accountSection = navigation.getByRole("region", { name: "Your account" });
  await expect(accountSection.getByRole("link")).toHaveText([...ACCOUNT_ENTRIES]);
  await expect(otaSection.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");

  // The overview: everyone sees the OTA, its storefront and "Open console"; owners and admins edit the profile.
  await expect(main(page).getByRole("heading", { level: 1, name: owned.ota.name })).toBeVisible();
  await expect(
    main(page)
      .locator("dt", { hasText: /^Your role$/ })
      .locator("xpath=following-sibling::dd[1]"),
  ).toHaveText(ROLE_LABELS[role]);
  await expect(main(page).getByRole("link", { name: owned.storefrontHost })).toBeVisible();
  await expect(main(page).getByRole("region", { name: "Get your OTA ready" })).toBeVisible();
  await expectShownWhen(main(page).getByRole("button", { name: /^Open console/ }), may(role, "openConsole"));
  await expectShownWhen(
    main(page).getByRole("link", { name: "Edit the OTA profile" }),
    may(role, "editProfile"),
  );

  // The team page: every member sees the members; only owners and admins invite and manage.
  await open(page, "/team", "Team");
  const table = main(page).getByRole("table", { name: "Members of this OTA" });
  await expect(table.getByRole("row")).toHaveCount(1 + 1 + MEMBER_ROLES.length);
  const manager = may(role, "manageTeam");
  await expectShownWhen(main(page).locator('[data-notice="read-only"]'), !manager);
  await expectShownWhen(main(page).getByRole("heading", { level: 2, name: "Invite someone" }), manager);
  await expectShownWhen(main(page).getByRole("heading", { level: 2, name: "Pending invitations" }), manager);
  // One's own row offers "Leave this OTA" and nothing else.
  const ownRow = table.getByRole("row").filter({ hasText: account.email });
  await expect(ownRow.getByRole("button")).toHaveText(["Leave this OTA"]);
  await expect(ownRow.getByRole("combobox")).toHaveCount(0);
  // Every other row: role changes and removal only of the roles this member may manage (scope §1.2: owners manage every
  // role, admins agents, finance members and viewers, the others nobody).
  const rows: readonly (readonly [Role, string])[] = [
    ["owner", owned.owner.account.email],
    ...MEMBER_ROLES.filter((other) => other !== role).map(
      (other) => [other, member(other).account.email] as const,
    ),
  ];
  for (const [other, email] of rows) {
    const row = table.getByRole("row").filter({ hasText: email });
    const manageable = may(
      role,
      other === "owner" || other === "admin" ? "manageOwnersAndAdmins" : "manageTeam",
    );
    await expect(row, `${role} on the ${other}'s row`).toContainText(ROLE_LABELS[other]);
    await expectShownWhen(row.getByRole("combobox"), manageable);
    await expectShownWhen(row.getByRole("button", { name: /^Change role/ }), manageable);
    await expectShownWhen(row.getByRole("button", { name: /^Remove/ }), manageable);
  }
  if (manager) {
    // An admin invites agents, finance members and viewers only; only owners invite owners and admins.
    const roles = main(page).locator('[data-form="invite"]').getByLabel("Role", { exact: true });
    const offered = (await roles.locator("option").allTextContents()).filter((text) => text.trim() !== "");
    expect(offered).toEqual(
      (["owner", "admin", "agent", "finance", "viewer"] as const)
        .filter((target) =>
          may(role, target === "owner" || target === "admin" ? "manageOwnersAndAdmins" : "manageTeam"),
        )
        .map((target) => ROLE_LABELS[target]),
    );
  }
}

/** Every other page of the OTA: shown with the role's actions, or the not-allowed page. */
async function everyOtherPage(role: MemberRole): Promise<void> {
  const { page } = member(role);

  await open(page, "/settings", "OTA settings");
  if (may(role, "editProfile")) {
    await expect(main(page).getByRole("button", { name: "Save changes" })).toBeVisible();
  } else {
    await expectNotAllowed(page, role);
  }

  await open(page, "/api-keys", "API keys");
  if (may(role, "manageApiKeys")) {
    await expect(main(page).getByRole("tab", { name: "Test keys" })).toBeVisible();
    await expect(main(page).getByRole("button", { name: "Create the key" })).toBeVisible();
  } else {
    await expectNotAllowed(page, role);
  }

  // Every member sees the OTA's addresses; only owners and admins add custom domains.
  await open(page, "/domains", "Domains");
  await expect(main(page).getByRole("heading", { level: 2, name: "Velexis address" })).toBeVisible();
  await expect(main(page).getByRole("link", { name: owned.storefrontHost })).toBeVisible();
  await expectShownWhen(
    main(page).getByRole("heading", { level: 3, name: "Add a custom domain" }),
    may(role, "manageDomains"),
  );

  // The connections, masked, for owners, admins and finance; their forms for owners and admins.
  await open(page, "/amadeus", "Amadeus");
  if (may(role, "viewConnections")) {
    await expect(main(page).getByRole("heading", { level: 1, name: "Amadeus" })).toBeVisible();
    await expectShownWhen(
      main(page).getByRole("button", { name: "Save the settings" }),
      may(role, "manageConnections"),
    );
    await expectShownWhen(
      main(page).getByText("Only owners and admins can change these settings."),
      !may(role, "manageConnections"),
    );
  } else {
    await expectNotAllowed(page, role);
  }

  await open(page, "/payments", "Payments");
  if (may(role, "viewConnections")) {
    await expect(main(page).getByRole("heading", { level: 1, name: "Payments" })).toBeVisible();
    await expectShownWhen(
      main(page).getByRole("button", { name: "Save the suffix" }),
      may(role, "manageConnections"),
    );
    await expectShownWhen(
      main(page).getByText("Only owners and admins can change the card statement suffix."),
      !may(role, "manageConnections"),
    );
  } else {
    await expectNotAllowed(page, role);
  }

  // The payout account and the settlements for owners and finance; only owners set the account.
  await open(page, "/payments/payout-account", "Payout account");
  if (may(role, "viewSettlements")) {
    await expect(main(page).getByRole("heading", { level: 2, name: "Your payout account" })).toBeVisible();
    await expectShownWhen(
      main(page).getByRole("button", { name: "Save the payout account" }),
      may(role, "setPayoutAccount"),
    );
    await expectShownWhen(
      main(page).getByText("Only owners can change the payout account."),
      !may(role, "setPayoutAccount"),
    );
  } else {
    await expectNotAllowed(page, role);
  }

  await open(page, "/payments/settlements", "Settlements");
  if (may(role, "viewSettlements")) {
    await expect(main(page).getByRole("heading", { level: 1, name: "Settlements" })).toBeVisible();
  } else {
    await expectNotAllowed(page, role);
  }

  // The subscription for owners and finance; choosing a plan and Stripe's Customer Portal for owners only.
  await open(page, "/billing", "Billing");
  if (may(role, "viewBilling")) {
    await expect(main(page).getByRole("heading", { level: 2, name: "Subscription" })).toBeVisible();
    await expect(main(page).getByRole("button", { name: /Choose|Manage in Stripe/ })).toHaveCount(0);
    expect(may(role, "manageBilling")).toBe(false);
  } else {
    await expectNotAllowed(page, role);
  }

  // Going live is the owner's alone.
  await open(page, "/go-live", "Go live");
  expect(may(role, "goLive")).toBe(false);
  await expectNotAllowed(page, role);
}

for (const role of MEMBER_ROLES) {
  test(`the ${role} sees exactly the navigation of the role, the overview's actions and the team page's [PFE-028 AC1]`, async () => {
    await navigationOverviewAndTeam(role);
  });

  test(`the ${role} sees every other page of the OTA with exactly the actions of the role, or the not-allowed page [PFE-028 AC1]`, async () => {
    await everyOtherPage(role);
  });
}
