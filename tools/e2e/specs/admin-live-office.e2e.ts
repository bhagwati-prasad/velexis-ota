// A live office from the request to its release (PAD-015 step 2; platform/docs/flows/amadeus-connection.md §C and
// §D item 5, PADR-0012 items 5 and 8; scope PF-51, PF-90), project `platform-admin`:
//
//   the owner requests live access on the portal's Amadeus page → the admin's dashboard lists the request and links the
//   OTA's live connection → the admin assigns a live office: the connection is active and the request leaves the
//   dashboard → the owner gets the e-mail and sees the live connection active → the OTA's own live credentials are
//   applied (support/seed.ts), so the Velexis office is `releasing` in the pool → "Release" asks for the confirmation
//   that no booking with future travel remains and for a reason, and the office is available again
//
// Arrangements in `beforeAll` (PADR-0017 item 5: the public APIs where an operation exists, support/seed.ts for the
// rest):
//   - through the platform API: the admin (an account with MFA that `admin:grant` makes a platform admin, signed in
//     through `adminSignIn` and `adminVerifyMfa`, whose TOTP sign-in is the step-up `adminCreateAmadeusAccount` asks
//     for), the owner's active OTA (`newOwnerWithActiveOta`, set up by the OTA worker, so the journey needs
//     `E2E_WITH_OTA=1` and fails at once without it), a plan with live mode as the OTA's plan (`moveOtaToNewPlan`: no
//     public plan has live mode, and a plan change runs through Stripe Billing, which is off in the stack), the
//     Velexis live account when the run has none yet (`adminCreateAmadeusAccount` on the stack's Amadeus stub, verified
//     by the platform worker) and the journey's live office in its pool (`adminAddAmadeusOffices`);
//   - support/seed.ts (as the platform API's own role): the own-credentials apply of step 5 (`applyOwnLiveCredentials`,
//     the client secret sealed with the stack's KEK by support/ota.ts's `sealedClientSecret`, then the `connection`
//     and `amadeus_account` invalidations), which submitting own credentials cannot reach in the stack:
//     FEATURE_OWN_AMADEUS stays off (its portal and admin pages change what admin-amadeus-pool.e2e.ts reads).
//
// The Velexis live pool. There is one Velexis Amadeus account per environment, and admin-amadeus-pool.e2e.ts (PAD-010)
// creates the live one in the browser and counts its offices exactly. So both journeys hold the live pool for their
// whole run (`holdVelexisLivePool`, a PostgreSQL advisory lock), whichever of them a worker starts first, and this one
// leaves the pool as it found it (`restoreVelexisLivePool` in `afterAll`): its office, and the live account if it
// created one, are deleted again. The release itself is the admin's, in the browser (PF-90).
//
// Every page the journey visits passes axe once its title is in place, the dialogs included. The steps are tests in
// order (`mode: "serial"`) on browser contexts made in `beforeAll`.
import { randomBytes } from "node:crypto";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import type { components } from "@velexis/api-types/platform";
import { expectNoSeriousA11yViolations } from "../support/a11y";
import {
  addSessionCookies,
  callPlatformApi,
  createVerifiedAccount,
  enableMfa,
  expect,
  newAccountContext,
  signInToAdminWithApi,
  test,
} from "../support/fixtures";
import { waitForLink } from "../support/mailpit";
import {
  amadeusConnectionOf,
  newOwnerWithActiveOta,
  publishInvalidations,
  sealedClientSecret,
  stackKeyProvider,
  uniqueLiveOfficeId,
  type OwnedOta,
} from "../support/ota";
import {
  applyOwnLiveCredentials,
  buildAccount,
  grantPlatformAdmin,
  holdVelexisLivePool,
  LIVE_POOL_WAIT_MS,
  moveOtaToNewPlan,
  restoreVelexisLivePool,
  stack,
  type AdminApiSession,
  type LivePoolHold,
} from "../support/seed";
import { AMADEUS_STUB_URL, PLATFORM_ADMIN_URL, PORTAL_URL } from "../support/stack";

test.describe.configure({ mode: "serial" });

type Schemas = components["schemas"];

/**
 * The budget of the one-time arrangement in `beforeAll` (a hook, not a step of the journey): two accounts through the
 * platform API and Mailpit (at most 15 s each), the admin's MFA, `admin:grant` and sign-in, the OTA's set-up on the
 * OTA worker (about 2 s, at most 45 s per OTA, and up to three OTAs while admin-amadeus-pool.e2e.ts holds the test
 * pool), the plan's four calls, the wait for the Velexis live pool (at most LIVE_POOL_WAIT_MS, while
 * admin-amadeus-pool.e2e.ts runs) and the live account's verification on the platform worker (at most 20 s).
 */
const ARRANGE_BUDGET_MS = 180_000 + LIVE_POOL_WAIT_MS;

/** How long the arrangement waits for the platform worker to verify a new Velexis live account against the stub. */
const ACCOUNT_VERIFY_WAIT_MS = 20_000;

/** The admin's title of a page (`%s · Velexis admin`) and the portal's (`%s · Velexis`). */
const adminTitle = (title: string): string => `${title} · Velexis admin`;
const portalTitle = (title: string): string => `${title} · Velexis`;

/** Waits until `target` has the title of its page, then fails on any serious or critical axe violation. */
async function expectAccessible(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(title);
  await expectNoSeriousA11yViolations(target);
}

/** The reason of the release: stored in the audit log. */
const RELEASE_REASON =
  "The OTA moved to its own Amadeus office and confirmed no future travel (PAD-015 journey).";

let adminApi: AdminApiSession;
let owned: OwnedOta;
/** The Velexis live office the journey adds and assigns: `E2L` and 6 random hex digits. */
const liveOfficeId = uniqueLiveOfficeId();
/** The office of the OTA's own live credentials (step 5). */
const ownOfficeId = uniqueLiveOfficeId();
let livePool: LivePoolHold | undefined;
let liveAccountId: string | undefined;
let createdLiveAccount = false;
let officeRowId: string | undefined;
let adminContext: BrowserContext;
let adminPage: Page;
let ownerContext: BrowserContext;
let ownerPage: Page;

/** The Velexis Amadeus accounts as `adminListAmadeusAccounts` answers them. */
async function velexisAccounts(): Promise<readonly Schemas["AdminAmadeusAccount"][]> {
  const list = await callPlatformApi<Schemas["AdminAmadeusAccountList"]>({
    operation: "adminListAmadeusAccounts",
    method: "GET",
    path: "/v1/admin/amadeus-accounts",
    ...adminApi,
  });
  return list.data;
}

/** The journey's live office as `adminListAmadeusOffices` answers it. */
async function liveOffice(): Promise<Schemas["AdminAmadeusOffice"] | undefined> {
  const list = await callPlatformApi<Schemas["AdminAmadeusOfficeList"]>({
    operation: "adminListAmadeusOffices",
    method: "GET",
    path: "/v1/admin/amadeus-offices?environment=live&limit=200",
    ...adminApi,
  });
  return list.data.find((office) => office.id === officeRowId);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(ARRANGE_BUDGET_MS);
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "admin-live-office.e2e.ts needs an active OTA: run it with E2E_WITH_OTA=1 (the Amadeus stub and the OTA worker)",
    );
  }
  const admin = await enableMfa(
    await createVerifiedAccount(buildAccount({ fullName: "Liv Live Office Admin" })),
  );
  await grantPlatformAdmin(admin.email);
  const adminSession = await signInToAdminWithApi(admin);
  adminApi = { endUserIp: admin.endUserIp, accessToken: adminSession.accessToken };

  owned = await newOwnerWithActiveOta("Leif Live Owner", "livoff");
  await moveOtaToNewPlan(callPlatformApi, {
    admin: adminApi,
    owner: owned.owner,
    tenantId: owned.ota.id,
    plan: {
      code: `e2elivoff_${owned.ota.key}`,
      name: "E2E live office",
      description: "A plan with live mode for the platform admin's live office journey (PAD-015).",
      currency: "EUR",
      monthlyPrice: { amount: "49.00", currency: "EUR" },
      limits: { staffSeats: 5, apiKeys: 10, customDomains: 0, liveMode: true },
      features: {},
      isPublic: false,
      trialDays: 0,
      settlementFeeBps: 0,
      sortOrder: 93,
    },
    reason: "The platform admin's live office journey needs an OTA whose plan has live mode (PAD-015).",
  });

  // The Velexis live pool to this journey alone (see the file header), then its account and the journey's office.
  livePool = await holdVelexisLivePool();
  let account = (await velexisAccounts()).find((candidate) => candidate.environment === "live");
  if (account === undefined) {
    account = await callPlatformApi<Schemas["AdminAmadeusAccount"]>({
      operation: "adminCreateAmadeusAccount",
      method: "POST",
      path: "/v1/admin/amadeus-accounts",
      ...adminApi,
      body: {
        name: "Velexis live (PAD-015 journey)",
        environment: "live",
        // The stack's Amadeus stub stands in for the live host, which hands any client a token.
        baseUrl: AMADEUS_STUB_URL,
        clientId: `e2e-live-${randomBytes(6).toString("hex")}`,
        clientSecret: randomBytes(24).toString("base64url"),
      } satisfies Schemas["CreateAmadeusAccountRequest"],
    });
    // Known to `afterAll` before the wait, so a failed verification still deletes the account again.
    createdLiveAccount = true;
    liveAccountId = account.id;
    const created = account.id;
    await expect
      .poll(async () => (await velexisAccounts()).find((candidate) => candidate.id === created)?.status, {
        timeout: ACCOUNT_VERIFY_WAIT_MS,
        message: "the new Velexis live account is verified against the stack's Amadeus stub",
      })
      .toBe("active");
  }
  liveAccountId = account.id;
  const added = await callPlatformApi<Schemas["AmadeusOfficesAdded"]>({
    operation: "adminAddAmadeusOffices",
    method: "POST",
    path: "/v1/admin/amadeus-offices",
    ...adminApi,
    body: {
      amadeusAccountId: account.id,
      officeIds: [liveOfficeId],
      notes: "Contract and ticketing agreement signed (PAD-015 journey).",
    } satisfies Schemas["AddAmadeusOfficesRequest"],
  });
  officeRowId = added.created[0]?.id;
  expect(added.created.map((office) => office.officeId)).toEqual([liveOfficeId]);

  adminContext = await newAccountContext(browser, admin, PLATFORM_ADMIN_URL);
  await addSessionCookies(adminContext, "admin", adminSession);
  adminPage = await adminContext.newPage();
  ownerContext = await newAccountContext(browser, owned.owner.account, PORTAL_URL);
  await addSessionCookies(ownerContext, "portal", owned.session);
  ownerPage = await ownerContext.newPage();
});

test.afterAll(async () => {
  try {
    if (livePool !== undefined && liveAccountId !== undefined && owned !== undefined) {
      // The live pool as the journey found it, before another journey takes it.
      await restoreVelexisLivePool({
        accountId: liveAccountId,
        createdAccount: createdLiveAccount,
        officeRowIds: officeRowId === undefined ? [] : [officeRowId],
        tenantId: owned.ota.id,
      });
      await publishInvalidations(
        { v: 1, type: "amadeus_account", id: liveAccountId },
        { v: 1, type: "connection", tenantId: owned.ota.id },
      );
    }
  } finally {
    await livePool?.release();
    await adminContext?.close();
    await ownerContext?.close();
  }
});

/** A connection card of the owner's Amadeus page, by its environment ("Live environment"). */
function ownerCard(name: "Live environment"): Locator {
  return ownerPage.getByRole("region", { name, exact: true });
}

/** The journey's office in the office pool's list. */
function officeRow(): Locator {
  return adminPage.getByRole("row").filter({ hasText: liveOfficeId });
}

test("the owner requests live access on the portal's Amadeus page [PAD-015 AC1]", async () => {
  await ownerPage.goto(`/otas/${owned.ota.id}/amadeus`);
  const section = ownerPage.getByRole("region", { name: "Live access" });
  await expect(section.getByRole("button", { name: "Request live access" })).toBeVisible();
  await expectAccessible(ownerPage, portalTitle("Amadeus"));

  await section.getByLabel("Note for Velexis (optional)").fill("We want to start selling in December.");
  await section.getByRole("button", { name: "Request live access" }).click();
  await expect(section.getByRole("status")).toContainText("Velexis has your request for live access");

  // The live connection waits for an office on the Velexis live account.
  await ownerPage.reload();
  await expect(ownerCard("Live environment")).toContainText("Velexis live account, no office yet, pending");
  expect(await amadeusConnectionOf(owned.ota.id, "live")).toEqual({
    status: "pending_verification",
    credentialSource: "velexis",
    defaultOfficeId: null,
    officeIds: [],
  });
  await expectAccessible(ownerPage, portalTitle("Amadeus"));
});

test("the dashboard lists the request and links the OTA's live connection, which waits for an office [PAD-015 AC1]", async () => {
  await adminPage.goto("/");
  const requests = adminPage.getByRole("region", { name: "Live office requests" });
  const request = requests.getByRole("row").filter({ hasText: owned.ota.key });
  await expect(request).toContainText(owned.ota.name);
  await expectAccessible(adminPage, adminTitle("Dashboard"));

  await request.getByRole("link", { name: `Assign office to ${owned.ota.name}` }).click();
  await adminPage.waitForURL(
    (url) => url.pathname === `/tenants/${owned.ota.id}` && url.searchParams.get("tab") === "connections",
  );
  expect(new URL(adminPage.url()).hash).toMatch(/^#connection-sc_/);
  const card = adminPage.getByRole("region", { name: "Amadeus, Live" });
  await expect(card).toContainText("Pending");
  await expect(card.getByRole("heading", { name: "Assign an office" })).toBeVisible();
  await expect(card).toContainText("An owner requested live access.");
  await expectAccessible(adminPage, adminTitle("Tenant"));
});

test("the admin assigns the live office: the connection is active and the request leaves the dashboard [PAD-015 AC1]", async () => {
  const card = adminPage.getByRole("region", { name: "Amadeus, Live" });
  // The available live offices, oldest first: the journey's own, whatever other offices the pool holds.
  await card.getByLabel("Office", { exact: true }).selectOption({ label: liveOfficeId });
  await expectNoSeriousA11yViolations(adminPage);
  await card.getByRole("button", { name: "Assign office" }).click();

  const outcome = card
    .getByRole("status")
    .filter({ hasText: `Office ${liveOfficeId} is assigned to the OTA.` });
  await expect(outcome).toContainText("Active");
  await expect(card.getByRole("heading", { name: "Assign an office" })).toHaveCount(0);
  await expect(card).toContainText(liveOfficeId);
  expect(await liveOffice()).toMatchObject({ status: "assigned", assignedTenant: { id: owned.ota.id } });
  await expectAccessible(adminPage, adminTitle("Tenant"));

  await adminPage.goto("/");
  await expect(
    adminPage.getByRole("region", { name: "Live office requests" }).getByRole("row").filter({
      hasText: owned.ota.key,
    }),
  ).toHaveCount(0);
  await expectAccessible(adminPage, adminTitle("Dashboard"));
});

test("the owner gets the e-mail and sees the live connection active [PAD-015 AC1]", async () => {
  const link = await waitForLink({
    to: owned.owner.account.email,
    subject: `Live Amadeus access is ready for ${owned.ota.name}`,
    path: `/otas/${owned.ota.id}/amadeus`,
    origin: PORTAL_URL,
  });
  await ownerPage.goto(link.href);
  await expect(ownerCard("Live environment")).toContainText(
    `Velexis live account, office ${liveOfficeId}, active`,
  );
  // Live access is granted: the request section is gone.
  await expect(ownerPage.getByRole("region", { name: "Live access" })).toHaveCount(0);
  expect(await amadeusConnectionOf(owned.ota.id, "live")).toEqual({
    status: "active",
    credentialSource: "velexis",
    defaultOfficeId: liveOfficeId,
    officeIds: [liveOfficeId],
  });
  await expectAccessible(ownerPage, portalTitle("Amadeus"));
});

test("once the OTA's own live credentials are applied, the Velexis office is releasing in the pool [PAD-015 AC1]", async () => {
  const keys = await stackKeyProvider();
  const applied = await applyOwnLiveCredentials({
    tenantId: owned.ota.id,
    officeId: ownOfficeId,
    seal: async (connectionId) => await sealedClientSecret(connectionId, keys),
  });
  expect(applied.releasingOfficeRowIds).toEqual([officeRowId]);
  await publishInvalidations(
    { v: 1, type: "connection", tenantId: owned.ota.id },
    { v: 1, type: "amadeus_account", id: applied.accountId },
  );

  // The owner's live connection is the OTA's own now.
  await ownerPage.reload();
  await expect(ownerCard("Live environment")).toContainText(
    `Your own Amadeus credentials, office ${ownOfficeId}, active`,
  );
  await expectAccessible(ownerPage, portalTitle("Amadeus"));

  // The office pool's releasing live offices (the address the dashboard and the filters write).
  await adminPage.goto("/amadeus/offices?environment=live&status=releasing");
  const row = officeRow();
  await expect(row).toContainText("Releasing");
  await expect(row.getByRole("link", { name: owned.ota.key })).toBeVisible();
  await expect(row).toContainText("Releasing since");
  await expect(row.getByRole("button", { name: `Release office ${liveOfficeId}` })).toBeVisible();
  await expectAccessible(adminPage, adminTitle("Office pool"));
});

test("releasing the office needs the confirmation and a reason, then it is available again [PAD-015 AC1]", async () => {
  await officeRow()
    .getByRole("button", { name: `Release office ${liveOfficeId}` })
    .click();
  const dialog = adminPage.getByRole("dialog", { name: `Release office ${liveOfficeId}?` });
  await expect(dialog).toContainText(`${owned.ota.key} now uses its own Amadeus credentials`);
  const confirmation = dialog.getByLabel(
    `${owned.ota.key} confirmed that no booking with future travel remains on office ${liveOfficeId}.`,
  );
  await expectNoSeriousA11yViolations(adminPage);

  // Without the box: the dialog says so at the box and sends nothing.
  await dialog.getByRole("button", { name: "Release office" }).click();
  await expect(
    dialog.getByText("Confirm that no booking with future travel remains on the office."),
  ).toBeVisible();
  await expect(confirmation).toBeFocused();
  // With the box but a reason too short: the same at the reason.
  await confirmation.check();
  await dialog.getByLabel("Reason").fill("done");
  await dialog.getByRole("button", { name: "Release office" }).click();
  await expect(dialog.getByText("Enter a reason of at least 5 characters.")).toBeVisible();
  await expect(dialog.getByLabel("Reason")).toBeFocused();
  await expectNoSeriousA11yViolations(adminPage);
  expect(await liveOffice()).toMatchObject({ status: "releasing" });

  await dialog.getByLabel("Reason").fill(RELEASE_REASON);
  await dialog.getByRole("button", { name: "Release office" }).click();
  await expect(
    adminPage
      .getByRole("status")
      .filter({ hasText: `Office ${liveOfficeId} is released and available again.` }),
  ).toBeVisible();
  expect(await liveOffice()).toMatchObject({ status: "available", assignedTenant: null });

  await adminPage.goto("/amadeus/offices?environment=live");
  await expect(officeRow()).toContainText("Available");
  await expect(officeRow().getByRole("link", { name: owned.ota.key })).toHaveCount(0);
  await expectAccessible(adminPage, adminTitle("Office pool"));
});
