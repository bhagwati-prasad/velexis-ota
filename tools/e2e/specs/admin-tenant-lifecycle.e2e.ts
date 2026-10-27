// Suspending and resuming an OTA from the platform admin, and what its owner sees (PAD-010 step 2;
// flows/platform-admin-operations.md §B and §C, PADR-0014; PF-81, PF-82, PF-83, PF-84): an OTA created through the
// portal API by its owner (`createTenant`) and set up by the OTA worker, so the journey needs `E2E_WITH_OTA=1` (the
// e2e workflow sets it).
//
//   the admin finds the OTA by its owner's e-mail address → suspends it with a reason → the suspension job dispatches
//   `tenant.suspend` to the OTA worker → the owner sees the suspended banner in the portal and gets an e-mail → the
//   admin resumes it → the banner is gone → both actions, with their reasons, are in the OTA's audit tab → the OTA's
//   jobs, filtered in the URL, and the queues of both backends → the OTA queue's failed attempt of the suspension, with
//   its reason and no retry
//
// The OTA worker of M1 does not handle `tenant.suspend` and `tenant.resume` (ota/backend/src/provisioning/
// tenant-ops.processor.ts; the consumer comes with OBE-074 in M4): it fails each dispatch attempt at once as
// unrecoverable, and the platform job stays `running` until the reconciler counts the attempt as lost. So the journey
// checks the dispatch and, for PF-84, that failed attempt in `ota-tenant-ops`. The storefront following a suspension
// is PAD-011's journey, the OTA API's `TENANT_SUSPENDED` PBE-036's cross-backend test. Once OBE-074 answers the
// messages, the last step changes to the jobs' success.
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

let owner: PortalAccount;
let admin: MfaAccount;
let ota: Ota;
/** The suspension's provisioning job (`job_…`), from the outcome's link. */
let suspensionJobId: string;
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

test("the suspension job sends tenant.suspend to the OTA worker [PAD-010 AC1]", async () => {
  const outcome = adminPage.getByRole("status").filter({ hasText: "The OTA is suspended." });
  await outcome.getByRole("link").click();
  await adminPage.waitForURL(/\/provisioning-jobs\/job_[0-9A-HJKMNP-TV-Z]{26}$/);
  const jobId = new URL(adminPage.url()).pathname.split("/").pop() ?? "";
  suspensionJobId = jobId;
  await expect(adminPage.getByRole("heading", { level: 1 })).toBeVisible();
  // PF-82 and PF-83: the job dispatches `tenant.suspend` to `ota-tenant-ops` (its BullMQ job `<job id>-<attempt>`).
  // The page is a snapshot, so it is reloaded until it shows the dispatch, which happens right after the commit. The
  // OTA worker of M1 does not handle the message yet (M4–M5), so the job is retried and ends failed later, while the
  // OTA stays suspended (flows/platform-admin-operations.md "Failure handling"): its status is not part of the check.
  await expect
    .poll(
      async () => {
        await adminPage.reload();
        return await adminPage.locator("dl").first().innerText();
      },
      { timeout: 10_000 },
    )
    .toMatch(new RegExp(`BullMQ job\\s+${jobId}-\\d+ on ota-tenant-ops`));
  await expect(adminPage.locator("dl").first()).toContainText("Suspension");
  await expect(adminPage.locator("dl").first()).toContainText(ota.key);
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
  // PF-83: the set-up (done), the suspension and the resumption (dispatched; see the suspension step above).
  const rows = adminPage.getByRole("row").filter({ hasText: ota.key });
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "Set-up" })).toContainText("Done");
  for (const kind of ["Suspension", "Resumption"]) {
    await expect(rows.filter({ hasText: kind })).toHaveCount(1);
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

test("the OTA queue lists the suspension's failed attempt with its reason, view only [PAD-010 AC1]", async () => {
  await adminPage
    .getByRole("region", { name: "OTA queues" })
    .getByRole("link", { name: "ota-tenant-ops", exact: true })
    .click();
  await adminPage.waitForURL("/queues/ota-tenant-ops");
  await expect(adminPage.getByRole("heading", { level: 1, name: "ota-tenant-ops" })).toBeVisible();
  await expect(adminPage.getByText("OTA queue, view only")).toBeVisible();
  // PF-84: a failed job shows its reason. The OTA worker of M1 refuses `tenant.suspend` as soon as it takes the
  // attempt (see the file header); the page is a snapshot, so it is reloaded until the attempt is listed.
  const attempt = adminPage.getByRole("row").filter({ hasText: `${suspensionJobId}-` });
  await expect
    .poll(
      async () => {
        await adminPage.reload();
        return await attempt.count();
      },
      { timeout: 10_000 },
    )
    .toBe(1);
  await expect(attempt).toContainText("tenant.suspend");
  await expect(attempt).toContainText("tenant.suspend is not handled by this release of the OTA worker");
  // A dispatch attempt links to its provisioning job, where a tenant job is retried (PF-83).
  await expect(attempt.getByRole("link", { name: "Provisioning job" })).toHaveAttribute(
    "href",
    `/provisioning-jobs/${suspensionJobId}`,
  );
  // PF-84: retry for platform queues only; an OTA queue offers none.
  await expect(adminPage.getByRole("button", { name: /^Retry/ })).toHaveCount(0);
  await expectAccessible(adminPage, "Queues");
});
