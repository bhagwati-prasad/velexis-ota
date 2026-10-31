// Suspending and resuming an OTA from the platform admin, and what its owner sees (PAD-010 step 2;
// flows/platform-admin-operations.md §B and §C, PADR-0014; PF-81, PF-82, PF-83, PF-84): an OTA created through the
// portal API by its owner (`createTenant`) and set up by the OTA worker, so the journey needs `E2E_WITH_OTA=1` (the
// e2e workflow sets it).
//
//   the admin finds the OTA by its owner's e-mail address → suspends it with a reason → the suspension job dispatches
//   `tenant.suspend` to the OTA worker, which answers `tenant.suspended`, and the job is done → the owner sees the
//   suspended banner in the portal and gets an e-mail → the admin resumes it → the banner is gone → both actions, with
//   their reasons, are in the OTA's audit tab → the OTA's jobs, done and filtered in the URL, and the queues of both
//   backends → a migration to a version the OTA worker's release does not have fails, and its job shows the reason →
//   the OTA queue's failed attempt of that migration, with its reason and no retry
//
// Since OBE-074 the OTA worker handles `tenant.suspend` and `tenant.resume` (ota/backend/src/provisioning/
// housekeeping.service.ts: the staff cut-off, the expiry of open checkouts and their voids, PADR-0014 item 3) and
// answers both, so the suspension's and the resumption's jobs end `succeeded`. PF-84's failed job with its reason comes
// from a `migrate` job whose target version no tenant migration of the release has: the OTA worker answers
// `tenant.migration_failed` (`UNKNOWN_TARGET_VERSION`, not retryable) and fails the dispatch attempt at once as
// unrecoverable, so the attempt is listed in `ota-tenant-ops` with its reason and the job ends `failed` with it, while
// the OTA's status does not change (PADR-0001 item 7). The storefront following a suspension is PAD-011's journey, the
// OTA API's `TENANT_SUSPENDED` PBE-036's cross-backend test.
//
// The steps are tests in order (`mode: "serial"`) on the admin's page and the owner's page: a failed step stops the
// rest. Every page the journey visits passes `expectNoSeriousA11yViolations` once its title is in place.
import { type BrowserContext, type Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../support/a11y";
import {
  addSessionCookies,
  createVerifiedAccount,
  enableMfa,
  expect,
  newAccountContext,
  signInToAdminWithApi,
  signInWithApi,
  test,
  type MfaAccount,
  type PortalAccount,
} from "../support/fixtures";
import { waitForEmail } from "../support/mailpit";
import { buildAccount, grantPlatformAdmin, stack } from "../support/seed";
import { PLATFORM_ADMIN_URL, PORTAL_URL } from "../support/stack";
import { createOtaWithApi, waitForOtaStatus, type Ota } from "../support/tenants";

test.describe.configure({ mode: "serial" });

/** Waits until `target` shows the page `title` of the admin or the portal, then runs axe. */
async function expectAccessible(
  target: Page,
  title: string,
  app: "admin" | "portal" = "admin",
): Promise<void> {
  await expect(target).toHaveTitle(`${title} · ${app === "admin" ? "Velexis admin" : "Velexis"}`);
  await expectNoSeriousA11yViolations(target);
}

const SUSPEND_REASON = "Card testing reported by the acquirer (PAD-010 journey).";
const RESUME_REASON = "The OTA closed the abused search form (PAD-010 journey).";
/** A tenant migration version of the right shape that no release has: the OTA worker refuses it, not retryable. */
const UNKNOWN_TARGET_VERSION = "9999_not_in_this_release";

/**
 * Reloads `target` (a server-rendered snapshot) until the job summary's first description list matches `pattern`;
 * the OTA worker answers within milliseconds, and the platform worker applies the answer right after.
 */
async function expectJobSummary(target: Page, pattern: RegExp): Promise<void> {
  await expect
    .poll(
      async () => {
        await target.reload();
        return await target.locator("dl").first().innerText();
      },
      { timeout: 15_000 },
    )
    .toMatch(pattern);
}

let owner: PortalAccount;
let admin: MfaAccount;
let ota: Ota;
/** The suspension's provisioning job (`job_…`), from the outcome's link. */
let suspensionJobId: string;
/** The migration's provisioning job (`job_…`), from the outcome's link. */
let migrationJobId: string;
let adminContext: BrowserContext;
let adminPage: Page;
let ownerContext: BrowserContext;
let ownerPage: Page;

test.beforeAll(async ({ browser }) => {
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "admin-tenant-lifecycle.e2e.ts needs an active OTA: run it with E2E_WITH_OTA=1 (the Amadeus stub and the OTA worker)",
    );
  }
  // Budget: two sign-ups with their verification e-mails (up to 15 s each, in parallel), an MFA set-up, `admin:grant`
  // through the platform CLI and the OTA's set-up on the OTA worker (about 2 s locally; PF-11 allows a minute).
  test.setTimeout(90_000);
  const [ownerAccount, adminAccount] = await Promise.all([
    createVerifiedAccount(buildAccount({ fullName: "Olga Owner" })),
    createVerifiedAccount(buildAccount({ fullName: "Ada Admin" })).then(enableMfa),
  ]);
  owner = ownerAccount;
  admin = adminAccount;
  const ownerSession = await signInWithApi(owner);
  const signedInOwner = { account: owner, accessToken: ownerSession.accessToken };
  const created = await createOtaWithApi(signedInOwner, { name: "Lifecycle Travel" });
  await grantPlatformAdmin(admin.email);
  ota = await waitForOtaStatus(signedInOwner, created.id, "active");

  ownerContext = await newAccountContext(browser, owner, PORTAL_URL);
  await addSessionCookies(ownerContext, "portal", ownerSession);
  ownerPage = await ownerContext.newPage();
  adminContext = await newAccountContext(browser, admin, PLATFORM_ADMIN_URL);
  await addSessionCookies(adminContext, "admin", await signInToAdminWithApi(admin));
  adminPage = await adminContext.newPage();
});

test.afterAll(async () => {
  await adminContext.close();
  await ownerContext.close();
});

test("finds the OTA by its owner's e-mail address and opens its page [PAD-010 AC1]", async () => {
  await adminPage.goto("/tenants");
  await expect(adminPage.getByRole("heading", { level: 1, name: "Tenants" })).toBeVisible();
  // PF-81: the search is in the URL, so another admin can open the same list.
  await adminPage.getByRole("searchbox", { name: "Search" }).fill(owner.email);
  await adminPage.getByRole("button", { name: "Search" }).click();
  await adminPage.waitForURL((url) => url.searchParams.get("q") === owner.email);
  const row = adminPage.getByRole("row").filter({ hasText: owner.email });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Active");
  await expectAccessible(adminPage, "Tenants");

  await row.getByRole("link", { name: ota.name }).click();
  await adminPage.waitForURL(`/tenants/${ota.id}`);
  await expect(adminPage.getByRole("heading", { level: 1, name: ota.name })).toBeVisible();
  await expect(adminPage.getByRole("tab", { name: "Audit" })).toBeVisible();
  await expectAccessible(adminPage, "Tenant");
});

test("suspends the OTA with a reason; the outcome shows its new status and the suspension job [PAD-010 AC1]", async () => {
  await adminPage.getByRole("button", { name: "Suspend", exact: true }).click();
  const dialog = adminPage.getByRole("dialog", { name: `Suspend ${ota.name}?` });
  await dialog.getByLabel("Kind of suspension").selectOption("abuse");
  await dialog.getByLabel("Reason").fill(SUSPEND_REASON);
  await expectNoSeriousA11yViolations(adminPage);
  await dialog.getByRole("button", { name: "Suspend OTA" }).click();

  // PF-82: the outcome names the new status and the job that carries the OTA worker's part.
  const outcome = adminPage.getByRole("status").filter({ hasText: "The OTA is suspended." });
  await expect(outcome).toContainText("Suspended");
  await expect(outcome).toContainText("Suspension");
  // The revalidated page follows: the header says suspended, and only "Resume" is offered.
  await expect(adminPage.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await expect(adminPage.getByRole("button", { name: "Suspend", exact: true })).toHaveCount(0);
  await expectAccessible(adminPage, "Tenant");
});

test("the suspension job sends tenant.suspend to the OTA worker, which answers it: the job is done [OBE-074] [PAD-010 AC1]", async () => {
  const outcome = adminPage.getByRole("status").filter({ hasText: "The OTA is suspended." });
  await outcome.getByRole("link").click();
  await adminPage.waitForURL(/\/provisioning-jobs\/job_[0-9A-HJKMNP-TV-Z]{26}$/);
  const jobId = new URL(adminPage.url()).pathname.split("/").pop() ?? "";
  suspensionJobId = jobId;
  await expect(adminPage.getByRole("heading", { level: 1 })).toBeVisible();
  // PF-82 and PF-83: the job dispatches `tenant.suspend` to `ota-tenant-ops` (its BullMQ job `<job id>-<attempt>`),
  // and the OTA worker's `tenant.suspended` marks it done (OBE-074). The page is a snapshot, so it is reloaded until it
  // shows both.
  await expectJobSummary(adminPage, /Status\s+Done/);
  const summary = adminPage.locator("dl").first();
  // The text content of the description list has no spaces between its terms and values.
  await expect(summary).toContainText(new RegExp(`BullMQ job\\s*${jobId}-\\d+\\s*on\\s*ota-tenant-ops`));
  await expect(summary).toContainText("Suspension");
  await expect(summary).toContainText(ota.key);
  await expectAccessible(adminPage, "Provisioning job");
});

test("the owner sees the suspended banner in the portal and gets an e-mail [PAD-010 AC1]", async () => {
  await ownerPage.goto(`/otas/${ota.id}`);
  const notices = ownerPage.getByRole("region", { name: "OTA notices" });
  await expect(notices.getByText("This OTA is suspended")).toBeVisible();
  // PF-82: the kind the admin chose, in the owner's words.
  await expect(
    notices.getByText("Velexis suspended this OTA after a report of misuse. Contact Velexis support."),
  ).toBeVisible();
  await expectAccessible(ownerPage, "Overview", "portal");
  await waitForEmail({ to: owner.email, subject: `${ota.name} has been suspended` });
});

test("resumes the OTA with a reason, and the owner's banner is gone [PAD-010 AC1]", async () => {
  await adminPage.goto(`/tenants/${ota.id}`);
  await adminPage.getByRole("button", { name: "Resume", exact: true }).click();
  const dialog = adminPage.getByRole("dialog", { name: `Resume ${ota.name}?` });
  await dialog.getByLabel("Reason").fill(RESUME_REASON);
  await expectNoSeriousA11yViolations(adminPage);
  await dialog.getByRole("button", { name: "Resume OTA" }).click();
  const outcome = adminPage.getByRole("status").filter({ hasText: "The OTA is active again." });
  await expect(outcome).toContainText("Active");
  await expect(outcome).toContainText("Resumption");
  await expect(adminPage.getByRole("button", { name: "Suspend", exact: true })).toBeVisible();
  await expectAccessible(adminPage, "Tenant");

  await ownerPage.reload();
  await expect(ownerPage.getByRole("heading", { level: 1, name: ota.name })).toBeVisible();
  await expect(ownerPage.getByText("This OTA is suspended")).toHaveCount(0);
  await expectAccessible(ownerPage, "Overview", "portal");
  await waitForEmail({ to: owner.email, subject: `${ota.name} is active again` });
});

test("the OTA's audit tab lists both actions with the admin and the reasons [PAD-010 AC1]", async () => {
  await adminPage.getByRole("tab", { name: "Audit" }).click();
  // The open tab is part of the address, so the link opens the same tab.
  await adminPage.waitForURL(`/tenants/${ota.id}?tab=audit`);
  const panel = adminPage.getByRole("tabpanel", { name: "Audit" });
  for (const [action, reason] of [
    ["tenant.suspended", SUSPEND_REASON],
    ["tenant.resumed", RESUME_REASON],
  ] as const) {
    const row = panel.getByRole("row").filter({ hasText: action });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Platform admin");
    await expect(row).toContainText(admin.email);
    await expect(row).toContainText(reason);
  }
  await expectAccessible(adminPage, "Tenant");
});

test("the OTA's jobs are listed and filtered in the URL, next to the queues of both backends [PAD-010 AC1]", async () => {
  await adminPage.getByRole("tab", { name: "Provisioning jobs" }).click();
  await adminPage.getByRole("link", { name: "All jobs of this OTA" }).click();
  await adminPage.waitForURL(
    (url) => url.pathname === "/provisioning-jobs" && url.searchParams.get("tenantId") === ota.id,
  );
  await expect(adminPage.getByText("Only the jobs of one OTA are shown.")).toBeVisible();
  // PF-83: the set-up, the suspension and the resumption, each answered by the OTA worker and done (OBE-074). The
  // list is a snapshot, so it is reloaded until the resumption's answer has arrived too.
  const rows = adminPage.getByRole("row").filter({ hasText: ota.key });
  await expect
    .poll(
      async () => {
        await adminPage.reload();
        return await rows.filter({ hasText: "Done" }).count();
      },
      { timeout: 15_000 },
    )
    .toBe(3);
  await expect(rows).toHaveCount(3);
  for (const kind of ["Set-up", "Suspension", "Resumption"]) {
    await expect(rows.filter({ hasText: kind })).toHaveCount(1);
    await expect(rows.filter({ hasText: kind })).toContainText("Done");
  }
  await expectAccessible(adminPage, "Provisioning jobs");

  // A select filter applies at once and stays in the URL, next to the OTA.
  await adminPage.getByLabel("Kind").selectOption("suspend");
  await adminPage.waitForURL(
    (url) => url.searchParams.get("kind") === "suspend" && url.searchParams.get("tenantId") === ota.id,
  );
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Suspension");

  // PF-84: the queues of both backends, the OTA worker's ota-tenant-ops among the OTA's (view only).
  await adminPage.goto("/queues");
  const platformQueues = adminPage.getByRole("region", { name: "Platform queues" });
  const otaQueues = adminPage.getByRole("region", { name: "OTA queues" });
  await expect(platformQueues.getByRole("row").filter({ hasText: "platform-" }).first()).toBeVisible();
  await expect(otaQueues.getByRole("row").filter({ hasText: "ota-tenant-ops" })).toBeVisible();
  await expectAccessible(adminPage, "Queues");
});

test("a migration to a version the release does not have fails on the OTA worker, and its job shows why [OBE-074] [PAD-010 AC1]", async () => {
  await adminPage.goto(`/tenants/${ota.id}`);
  await expect(adminPage.getByRole("heading", { level: 1, name: ota.name })).toBeVisible();
  await adminPage.getByLabel("Target version (optional)").fill(UNKNOWN_TARGET_VERSION);
  await adminPage.getByRole("button", { name: "Migrate", exact: true }).click();
  // ConfirmDialog asks first (an alert dialog: it confirms, it takes no input).
  const dialog = adminPage.getByRole("alertdialog", { name: `Run the tenant migrations of ${ota.name}?` });
  await expect(dialog).toContainText(UNKNOWN_TARGET_VERSION);
  await expectNoSeriousA11yViolations(adminPage);
  await dialog.getByRole("button", { name: "Start migration" }).click();
  const outcome = adminPage
    .getByRole("status")
    .filter({ hasText: "The migrate job is on its way to the OTA worker." });
  await expect(outcome).toContainText("Migration");
  await expectAccessible(adminPage, "Tenant");

  await outcome.getByRole("link").click();
  await adminPage.waitForURL(/\/provisioning-jobs\/job_[0-9A-HJKMNP-TV-Z]{26}$/);
  migrationJobId = new URL(adminPage.url()).pathname.split("/").pop() ?? "";
  // PF-83 and PF-84: the OTA worker answers `tenant.migration_failed` (not retryable), so the job fails at once with
  // the OTA worker's reason; the OTA stays active (PADR-0001 item 7).
  await expectJobSummary(adminPage, /Status\s+Failed/);
  const summary = adminPage.locator("dl").first();
  await expect(summary).toContainText("Migration");
  await expect(summary).toContainText(
    `UNKNOWN_TARGET_VERSION: No tenant migration of this release has the target version ${UNKNOWN_TARGET_VERSION}`,
  );
  await expectAccessible(adminPage, "Provisioning job");
});

test("the OTA queue lists the migration's failed attempt with its reason, view only [OBE-074] [PAD-010 AC1]", async () => {
  await adminPage.goto("/queues");
  await adminPage
    .getByRole("region", { name: "OTA queues" })
    .getByRole("link", { name: "ota-tenant-ops", exact: true })
    .click();
  await adminPage.waitForURL("/queues/ota-tenant-ops");
  await expect(adminPage.getByRole("heading", { level: 1, name: "ota-tenant-ops" })).toBeVisible();
  await expect(adminPage.getByText("OTA queue, view only")).toBeVisible();
  // PF-84: a failed job shows its reason. The OTA worker refuses the migration's target as soon as it takes the
  // attempt (see the file header); the page is a snapshot, so it is reloaded until the attempt is listed.
  const attempt = adminPage.getByRole("row").filter({ hasText: `${migrationJobId}-` });
  await expect
    .poll(
      async () => {
        await adminPage.reload();
        return await attempt.count();
      },
      { timeout: 10_000 },
    )
    .toBe(1);
  await expect(attempt).toContainText("tenant.migrate");
  await expect(attempt).toContainText(
    `UNKNOWN_TARGET_VERSION: No tenant migration of this release has the target version ${UNKNOWN_TARGET_VERSION}`,
  );
  // A dispatch attempt links to its provisioning job, where a tenant job is retried (PF-83).
  await expect(attempt.getByRole("link", { name: "Provisioning job" })).toHaveAttribute(
    "href",
    `/provisioning-jobs/${migrationJobId}`,
  );
  // The suspension's attempt completed (OBE-074), so it is not among the failed jobs.
  await expect(adminPage.getByRole("row").filter({ hasText: `${suspensionJobId}-` })).toHaveCount(0);
  // PF-84: retry for platform queues only; an OTA queue offers none.
  await expect(adminPage.getByRole("button", { name: /^Retry/ })).toHaveCount(0);
  await expectAccessible(adminPage, "Queues");
});
