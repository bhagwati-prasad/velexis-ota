// The custom domains of every OTA from the platform admin (PAD-015 step 3; platform/docs/flows/custom-domains.md,
// PADR-0004; scope PF-92), project `platform-admin`:
//
//   the dashboard counts the custom domains that wait for their DNS records and opens them on /domains → the pending
//   custom domain of the journey's OTA is listed with its OTA, its DNS verification and its TLS state → "Re-check"
//   (confirmed) queues its checks, and the DNS check runs at once → "Remove" asks for a reason, removes the domain and
//   e-mails the owners, without the reason → the owner follows the e-mail to the portal's domains page, which no longer
//   lists it
//
// Arranged in `beforeAll`, all through the platform API (PADR-0017 item 5: the public APIs where an operation exists):
// the admin (an account with MFA that `admin:grant` makes a platform admin, signed in through `adminSignIn` and
// `adminVerifyMfa`), the owner's active OTA (`newOwnerWithActiveOta`, set up by the OTA worker, so the journey needs
// `E2E_WITH_OTA=1` and fails at once without it), a plan with one custom domain as the OTA's plan (`moveOtaToNewPlan`
// of support/seed.ts: `adminCreatePlan` and `adminUpdateManualSubscription`, as portal-domains.e2e.ts does: no public
// plan has custom domains), and the pending custom domain itself, which the owner adds (`addDomain`). The stack turns
// FEATURE_CUSTOM_DOMAINS on for the platform processes (support/stack.ts `PLATFORM_SWITCHES_ON`).
//
// No step depends on DNS: the domain is under the `.example` top-level domain (RFC 2606), and the stack's DNS checks
// ask a loopback port where no DNS server answers (`STACK_DNS_RESOLVERS`), so a check ends at once as `dns_timeout`
// and the domain stays `pending` for its 72 hours. The worker's 5-minute run may have checked the domain before the
// admin's "Re-check"; the journey compares the domain's last check before and after it.
//
// Every page the journey visits passes axe once its title is in place, the dialogs included. The steps are tests in
// order (`mode: "serial"`) on browser contexts made in `beforeAll`.
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
import { waitForEmail, waitForLink } from "../support/mailpit";
import { newOwnerWithActiveOta, type OwnedOta } from "../support/ota";
import {
  buildAccount,
  grantPlatformAdmin,
  moveOtaToNewPlan,
  stack,
  type AdminApiSession,
} from "../support/seed";
import { PLATFORM_ADMIN_URL, PORTAL_URL } from "../support/stack";

test.describe.configure({ mode: "serial" });

type Schemas = components["schemas"];

/**
 * The budget of the one-time arrangement in `beforeAll` (a hook, not a step of the journey): two accounts through the
 * platform API and Mailpit (at most 15 s each), the admin's MFA, `admin:grant` and sign-in, the OTA's set-up on the
 * OTA worker (about 2 s, at most 45 s per OTA, and up to three OTAs while admin-amadeus-pool.e2e.ts holds the test
 * pool), the four calls of the plan and the custom domain.
 */
const ARRANGE_BUDGET_MS = 180_000;

/** How long the journey waits for the DNS check that "Re-check" queues: the platform worker runs it at once. */
const RECHECK_WAIT_MS = 15_000;

/** The admin's title of a page (`%s · Velexis admin`) and the portal's (`%s · Velexis`). */
const adminTitle = (title: string): string => `${title} · Velexis admin`;
const portalTitle = (title: string): string => `${title} · Velexis`;

/** Waits until `target` has the title of its page, then fails on any serious or critical axe violation. */
async function expectAccessible(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(title);
  await expectNoSeriousA11yViolations(target);
}

/** The reason the admin gives for the removal: stored in the audit log, never sent to the owners. */
const REMOVAL_REASON =
  "The domain imitates a bank's sign-in page: phishing reported by the registrar (PAD-015 journey).";

let adminApi: AdminApiSession;
let owned: OwnedOta;
/** The OTA's pending custom domain: `shop.<key>-admin.example`. */
let domain: Schemas["Domain"];
let adminContext: BrowserContext;
let adminPage: Page;
let ownerContext: BrowserContext;
let ownerPage: Page;

/** The journey's custom domain as `adminListDomains` answers it (the pending custom domains, newest first). */
async function listedDomain(): Promise<Schemas["AdminDomain"] | undefined> {
  const list = await callPlatformApi<Schemas["AdminDomainList"]>({
    operation: "adminListDomains",
    method: "GET",
    path: "/v1/admin/domains?kind=custom&verificationStatus=pending&limit=200",
    ...adminApi,
  });
  return list.data.find((item) => item.id === domain.id);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(ARRANGE_BUDGET_MS);
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "admin-domains.e2e.ts needs an active OTA: run it with E2E_WITH_OTA=1 (the Amadeus stub and the OTA worker)",
    );
  }
  const admin = await enableMfa(await createVerifiedAccount(buildAccount({ fullName: "Dag Domains Admin" })));
  await grantPlatformAdmin(admin.email);
  const adminSession = await signInToAdminWithApi(admin);
  adminApi = { endUserIp: admin.endUserIp, accessToken: adminSession.accessToken };

  owned = await newOwnerWithActiveOta("Dina Domains Owner", "admdom");
  await moveOtaToNewPlan(callPlatformApi, {
    admin: adminApi,
    owner: owned.owner,
    tenantId: owned.ota.id,
    plan: {
      code: `e2eadom_${owned.ota.key}`,
      name: "E2E admin domains",
      description: "A plan with one custom domain for the platform admin's domains journey (PAD-015).",
      currency: "EUR",
      monthlyPrice: { amount: "29.00", currency: "EUR" },
      limits: { staffSeats: 5, apiKeys: 10, customDomains: 1, liveMode: false },
      features: {},
      isPublic: false,
      trialDays: 0,
      settlementFeeBps: 0,
      sortOrder: 92,
    },
    reason: "The platform admin's domains journey needs an OTA with one custom domain (PAD-015).",
  });
  domain = await callPlatformApi<Schemas["Domain"]>({
    operation: "addDomain",
    method: "POST",
    path: `/v1/tenants/${encodeURIComponent(owned.ota.id)}/domains`,
    endUserIp: owned.owner.account.endUserIp,
    accessToken: owned.owner.accessToken,
    body: { hostname: `shop.${owned.ota.key}-admin.example` } satisfies Schemas["AddDomainRequest"],
  });
  expect(domain).toMatchObject({ kind: "custom", verificationStatus: "pending" });

  adminContext = await newAccountContext(browser, admin, PLATFORM_ADMIN_URL);
  await addSessionCookies(adminContext, "admin", adminSession);
  adminPage = await adminContext.newPage();
  ownerContext = await newAccountContext(browser, owned.owner.account, PORTAL_URL);
  await addSessionCookies(ownerContext, "portal", owned.session);
  ownerPage = await ownerContext.newPage();
});

test.afterAll(async () => {
  await adminContext?.close();
  await ownerContext?.close();
});

/** The journey's domain in the list of /domains. */
function domainRow(): Locator {
  return adminPage.getByRole("row").filter({ hasText: domain.hostname });
}

test("the dashboard counts the pending custom domains, and /domains lists this one with its states [PAD-015 AC1]", async () => {
  await adminPage.goto("/");
  // The count is the run's (other journeys add custom domains too): the link opens the pending ones of every OTA.
  const toReview = adminPage.getByRole("region", { name: "To review" });
  const pending = toReview.getByRole("link", {
    name: /^[\d,]+ custom domains? waits? for (its|their) DNS records$/,
  });
  await expect(pending).toBeVisible();
  await expectAccessible(adminPage, adminTitle("Dashboard"));

  await pending.click();
  await adminPage.waitForURL(
    (url) => url.pathname === "/domains" && url.search === "?kind=custom&verificationStatus=pending",
  );
  const row = domainRow();
  await expect(row.getByRole("link", { name: owned.ota.key })).toBeVisible();
  await expect(row).toContainText("Custom domain");
  await expect(row).toContainText("Pending");
  // Its 72-hour verification window, and no certificate yet.
  await expect(row).toContainText("Window ends");
  await expect(row).toContainText("No certificate yet");
  await expect(row.getByRole("button", { name: `Re-check ${domain.hostname}` })).toBeVisible();
  await expect(row.getByRole("button", { name: `Remove ${domain.hostname}` })).toBeVisible();
  await expectAccessible(adminPage, adminTitle("Domains"));
});

test("Re-check, once confirmed, checks the pending domain's DNS records at once [PAD-015 AC1]", async () => {
  const before = (await listedDomain())?.lastCheckedAt ?? null;
  await domainRow()
    .getByRole("button", { name: `Re-check ${domain.hostname}` })
    .click();
  const confirm = adminPage.getByRole("alertdialog", { name: `Check ${domain.hostname} now?` });
  await expect(confirm).toContainText(
    "The DNS records of this pending custom domain are checked now, as in its verification window",
  );
  await expectNoSeriousA11yViolations(adminPage);
  await confirm.getByRole("button", { name: "Check now" }).click();
  await expect(
    adminPage.getByRole("status").filter({
      hasText: `The checks of ${domain.hostname} are queued. Reload the page in a minute to see their result.`,
    }),
  ).toBeVisible();

  // The platform worker runs the DNS check at once: the stack's DNS servers do not answer (`dns_timeout`), and a
  // pending domain stays pending through its window.
  await expect
    .poll(async () => (await listedDomain())?.lastCheckedAt ?? null, { timeout: RECHECK_WAIT_MS })
    .not.toBe(before);
  expect(await listedDomain()).toMatchObject({
    verificationStatus: "pending",
    lastCheckError: "dns_timeout",
  });
  await adminPage.reload();
  await expect(domainRow()).toContainText("A DNS lookup did not complete; the next check asks again");
  await expect(domainRow()).toContainText("Pending");
  await expectAccessible(adminPage, adminTitle("Domains"));
});

test("Remove asks for a reason, removes the domain and e-mails the owners without the reason [PAD-015 AC1]", async () => {
  await domainRow()
    .getByRole("button", { name: `Remove ${domain.hostname}` })
    .click();
  const dialog = adminPage.getByRole("dialog", { name: `Remove ${domain.hostname}?` });
  await expect(dialog).toContainText(`The custom domain is deleted from ${owned.ota.key} at once`);
  // Without a reason nothing is sent: the dialog says so at the field.
  await dialog.getByRole("button", { name: "Remove domain" }).click();
  await expect(dialog.getByText("Enter a reason.")).toBeVisible();
  await expect(dialog.getByLabel("Reason")).toBeFocused();
  await expectNoSeriousA11yViolations(adminPage);
  expect(await listedDomain()).toBeDefined();

  await dialog.getByLabel("Reason").fill(REMOVAL_REASON);
  await dialog.getByRole("button", { name: "Remove domain" }).click();
  await expect(
    adminPage
      .getByRole("status")
      .filter({ hasText: `${domain.hostname} is removed. The owners get an e-mail.` }),
  ).toBeVisible();
  await expect(domainRow()).toHaveCount(0);
  expect(await listedDomain()).toBeUndefined();
  // The OTA's own list no longer has it either.
  const ownList = await callPlatformApi<Schemas["DomainList"]>({
    operation: "listDomains",
    method: "GET",
    path: `/v1/tenants/${encodeURIComponent(owned.ota.id)}/domains`,
    endUserIp: owned.owner.account.endUserIp,
    accessToken: owned.owner.accessToken,
  });
  expect(ownList.data.map((item) => item.hostname)).not.toContain(domain.hostname);
  await expectAccessible(adminPage, adminTitle("Domains"));

  const email = await waitForEmail({
    to: owned.owner.account.email,
    subject: `${domain.hostname} was removed from ${owned.ota.name}`,
  });
  expect(email.Text).toContain(`Velexis staff removed the custom domain ${domain.hostname}`);
  expect(email.Text).not.toContain(REMOVAL_REASON);
  expect(email.HTML).not.toContain("phishing");
});

test("the owner follows the e-mail to the portal's domains page, which no longer lists the domain [PAD-015 AC1]", async () => {
  const link = await waitForLink({
    to: owned.owner.account.email,
    subject: `${domain.hostname} was removed from ${owned.ota.name}`,
    path: `/otas/${owned.ota.id}/domains`,
    origin: PORTAL_URL,
  });
  await ownerPage.goto(link.href);
  await expect(ownerPage.getByRole("heading", { level: 1, name: "Domains" })).toBeVisible();
  await expect(ownerPage.getByRole("region", { name: "Velexis address" })).toContainText(
    owned.storefrontHost,
  );
  // No custom domain any more, and the plan's one custom domain can be added again.
  const custom = ownerPage.getByRole("region", { name: "Custom domains" });
  await expect(custom.getByText("This OTA has no custom domain.")).toBeVisible();
  await expect(ownerPage.getByRole("main")).not.toContainText(domain.hostname);
  await expect(
    ownerPage
      .getByRole("region", { name: "Add a custom domain" })
      .getByRole("button", { name: "Add domain" }),
  ).toBeEnabled();
  await expectAccessible(ownerPage, portalTitle("Domains"));
});
