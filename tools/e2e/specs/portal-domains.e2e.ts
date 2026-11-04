// The portal's custom domain journey (PFE-027 step 2 and its Note of 2026-11-04; platform/docs/flows/custom-domains.md
// steps 1 and 2, scope PF-41 AC1, platform/frontend/README.md §2 `/otas/[tenantId]/domains`), project `portal`:
//
//   the owner of an active OTA whose plan has custom domains opens the domains page (the Velexis address, verified and
//   primary; no custom domain yet) → adds a custom domain → sees the pending view: the domain `Pending`, the TXT
//   `_velexis` record and the routing records (CNAME to the OTA's Velexis address, A and AAAA to the storefront's
//   addresses), the verification deadline, the last check and "Check now" → copies a DNS record's value with its button
//   (the clipboard holds exactly the value) → after a reload the domain is still pending with the same records
//
// Arranged in `beforeAll`, all through the platform API (PADR-0017 item 5: the public APIs where possible): the owner's
// active OTA (`newOwnerWithActiveOta`, set up by the OTA worker, so the journey needs `E2E_WITH_OTA=1` and fails at once
// without it), and a plan with one custom domain as its current plan. No public plan has custom domains (early access
// has none) and an owner's plan change runs through Stripe Billing, which is off in the stack, so a platform admin of
// the journey's own (an account with MFA, `admin:grant`) does what Velexis staff do for a pilot: `adminCreatePlan`
// creates the plan `e2edom_<key>` (not public), and `adminUpdateManualSubscription` moves the OTA's manual trial to it,
// which sets the OTA's plan and publishes the platform's `tenant` invalidation. The stack turns FEATURE_CUSTOM_DOMAINS
// on for the platform processes (support/stack.ts `PLATFORM_SWITCHES_ON`).
//
// No step depends on DNS: the custom domain is under the `.example` top-level domain (RFC 2606), which never resolves,
// the journey never presses "Check now", and the stack's DNS checks ask a loopback port (`STACK_DNS_RESOLVERS`). The
// worker's 5-minute run may check the pending domain while the journey runs; the steps accept the last check either way
// (not checked yet, or the DNS servers not answering, `dns_timeout`, which is what the loopback port gives), and the
// domain stays `pending` for its 72 hours.
//
// Every page the journey visits passes axe once its title is in place, the domains page with the custom domain pending
// among them. The steps are tests in order on one browser context made in `beforeAll` (`mode: "serial"`).
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
import { newOwnerWithActiveOta, type OwnedOta } from "../support/ota";
import { buildAccount, grantPlatformAdmin, stack } from "../support/seed";
import { PORTAL_URL, serviceEnv } from "../support/stack";
import { getOtaWithApi } from "../support/tenants";

test.describe.configure({ mode: "serial" });

type Schemas = components["schemas"];

/**
 * The budget of the one-time arrangement in `beforeAll` (a hook, not a step of the journey): two accounts through the
 * platform API and Mailpit (at most 15 s each), the OTA's set-up on the OTA worker (about 2 s, at most 45 s per OTA, and
 * up to three OTAs while admin-amadeus-pool.e2e.ts holds the test pool), the platform CLI's `admin:grant`, the admin's
 * sign-in and the four calls that move the OTA to its plan.
 */
const ARRANGE_BUDGET_MS = 180_000;

/** The portal's title of a page (`%s · Velexis`). */
const portalTitle = (title: string): string => `${title} · Velexis`;

/** Waits until `target` has the title of its page, then fails on any serious or critical axe violation. */
async function expectAccessible(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(portalTitle(title));
  await expectNoSeriousA11yViolations(target);
}

/** The records a custom domain needs, in the API's order (domains.service.ts `dnsRecordsOf`). */
interface ExpectedRecord {
  readonly type: "TXT" | "CNAME" | "A" | "AAAA";
  readonly name: string;
  /** The value, or a pattern for the TXT record's verification value (new for every domain). */
  readonly value: string | RegExp;
}

let owned: OwnedOta;
let context: BrowserContext;
let page: Page;
/** `/otas/<tenantId>/domains`. */
let domainsPath: string;
/** The journey's custom domain: `travel.<key>-portal.example`. */
let hostname: string;
/** The records the pending view lists, as the API computes them for this OTA and the stack's storefront addresses. */
let expectedRecords: readonly ExpectedRecord[];
/** The TXT record's verification value, as the page showed it after the add. */
let verificationValue: string;

/**
 * Gives the journey's OTA a plan with one custom domain as its current plan, through the platform admin API as Velexis
 * staff would (see the file header): a platform admin of the journey's own creates the plan `e2edom_<key>` (not public,
 * EUR, `limits.customDomains = 1`) with `adminCreatePlan`, reads the OTA's current subscription (the owner's
 * `getSubscription`, then `adminGetSubscription` for its version) and moves that manual trial to the plan with
 * `adminUpdateManualSubscription` (`If-Match` and a reason), which also sets the OTA's plan and publishes the `tenant`
 * invalidation. Resolves to the plan's code.
 */
async function giveCustomDomainPlan(ota: OwnedOta): Promise<string> {
  const admin = await enableMfa(
    await createVerifiedAccount(buildAccount({ fullName: "Dina Domains Admin" })),
  );
  await grantPlatformAdmin(admin.email);
  const { accessToken } = await signInToAdminWithApi(admin);
  const asAdmin = { endUserIp: admin.endUserIp, accessToken } as const;

  const planCode = `e2edom_${ota.ota.key}`;
  const plan: Schemas["CreatePlanRequest"] = {
    code: planCode,
    name: "E2E domains",
    description: "A plan with one custom domain for the portal domains journey (PFE-027).",
    currency: "EUR",
    monthlyPrice: { amount: "29.00", currency: "EUR" },
    limits: { staffSeats: 5, apiKeys: 10, customDomains: 1, liveMode: false },
    features: {},
    isPublic: false,
    trialDays: 0,
    settlementFeeBps: 0,
    sortOrder: 91,
  };
  const created = await callPlatformApi<Schemas["AdminPlan"]>({
    operation: "adminCreatePlan",
    method: "POST",
    path: "/v1/admin/plans",
    ...asAdmin,
    body: plan,
  });
  expect(created).toMatchObject({ code: planCode, isPublic: false, limits: { customDomains: 1 } });

  const current = await callPlatformApi<Schemas["Subscription"]>({
    operation: "getSubscription",
    method: "GET",
    path: `/v1/tenants/${encodeURIComponent(ota.ota.id)}/subscription`,
    endUserIp: ota.owner.account.endUserIp,
    accessToken: ota.owner.accessToken,
  });
  const { subscription } = await callPlatformApi<Schemas["AdminSubscriptionDetail"]>({
    operation: "adminGetSubscription",
    method: "GET",
    path: `/v1/admin/subscriptions/${encodeURIComponent(current.id)}`,
    ...asAdmin,
  });
  // A new OTA starts on a manual trial while Stripe Billing is off: the only kind this admin operation changes.
  expect(subscription).toMatchObject({ tenantId: ota.ota.id, billingProvider: "manual", status: "trialing" });
  const change: Schemas["UpdateManualSubscriptionRequest"] = {
    planCode,
    reason: "The portal domains journey's OTA needs a plan with one custom domain (PFE-027).",
  };
  const updated = await callPlatformApi<Schemas["AdminSubscription"]>({
    operation: "adminUpdateManualSubscription",
    method: "PATCH",
    path: `/v1/admin/subscriptions/${encodeURIComponent(subscription.id)}`,
    ...asAdmin,
    headers: { "If-Match": `"${String(subscription.version)}"` },
    body: change,
  });
  expect(updated).toMatchObject({ id: subscription.id, planCode, status: "trialing" });
  return planCode;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(ARRANGE_BUDGET_MS);
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "portal-domains.e2e.ts needs an active OTA: run it with E2E_WITH_OTA=1 (the Amadeus stub and the OTA worker)",
    );
  }
  owned = await newOwnerWithActiveOta("Dora Domains", "dom");
  const planCode = await giveCustomDomainPlan(owned);
  // The OTA's plan as its owner reads it: the platform's `tenant` invalidation has reached the API's own reads.
  expect((await getOtaWithApi(owned.owner, owned.ota.id)).planCode).toBe(planCode);
  hostname = `travel.${owned.ota.key}-portal.example`;
  domainsPath = `/otas/${owned.ota.id}/domains`;

  // What the API lists for a custom domain of this OTA: the ownership record and both routing options, with the
  // storefront addresses of the platform's configuration (STOREFRONT_IPV4 and STOREFRONT_IPV6 of .env.example).
  const platform = serviceEnv("platform-api", stack());
  const ipv4 = platform["STOREFRONT_IPV4"];
  const ipv6 = platform["STOREFRONT_IPV6"];
  if (ipv4 === undefined || ipv4 === "") {
    throw new Error("the stack's platform API has no STOREFRONT_IPV4, which custom domains need");
  }
  expectedRecords = [
    { type: "TXT", name: `_velexis.${hostname}`, value: /^\S{16,}$/ },
    { type: "CNAME", name: hostname, value: owned.storefrontHost },
    { type: "A", name: hostname, value: ipv4 },
    ...(ipv6 === undefined || ipv6 === ""
      ? []
      : [{ type: "AAAA" as const, name: hostname, value: ipv6.toLowerCase() }]),
  ];

  context = await newAccountContext(browser, owned.owner.account, PORTAL_URL);
  // The copy buttons write to the clipboard and the journey reads it back: Chromium asks for both permissions.
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: PORTAL_URL });
  await addSessionCookies(context, "portal", owned.session);
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

/** The custom domain's entry in the list of custom domains (not the add form's panel, which shows the records too). */
function domainItem(): Locator {
  return page
    .getByRole("region", { name: "Custom domains" })
    .getByRole("listitem")
    .filter({ has: page.locator(`[data-dns-records="${hostname}"]`) });
}

/**
 * Checks the pending view of the custom domain in `item`: its name and `Pending`, the records of `expectedRecords` in
 * their order (type, name, value), the verification deadline, the last check (not yet, or `dns_timeout`), and
 * the actions of a pending domain: "Check now" and "Remove", no "Make primary". Resolves to the TXT record's value.
 */
async function expectPendingView(item: Locator): Promise<string> {
  await expect(item).toContainText(hostname);
  await expect(item.getByText("Pending", { exact: true })).toBeVisible();
  // A pending domain is no link to the storefront yet.
  await expect(item.getByRole("link", { name: hostname })).toHaveCount(0);

  const table = item.getByRole("table", { name: `DNS records for ${hostname}` });
  await expect(table).toBeVisible();
  const rows = table.locator("tbody").getByRole("row");
  await expect(rows).toHaveCount(expectedRecords.length);
  let txtValue = "";
  for (const [index, record] of expectedRecords.entries()) {
    const cells = rows.nth(index).getByRole("cell");
    await expect(cells.nth(0)).toHaveText(record.type);
    await expect(cells.nth(1).locator("code")).toHaveText(record.name);
    await expect(cells.nth(2).locator("code")).toHaveText(record.value);
    // Each name and value has its copy button, named after its record.
    await expect(
      cells.nth(1).getByRole("button", { name: `Copy the name of the ${record.type} record` }),
    ).toBeVisible();
    await expect(
      cells.nth(2).getByRole("button", { name: `Copy the value of the ${record.type} record` }),
    ).toBeVisible();
    if (record.type === "TXT") {
      txtValue = (await cells.nth(2).locator("code").textContent()) ?? "";
    }
  }
  await expect(item.getByText("The TXT record proves that you own the domain.")).toBeVisible();
  await expect(item.getByText(/^For the routing, create either the CNAME record/)).toBeVisible();

  // The verification window and the last check of a pending domain.
  await expect(item.locator('[data-detail="verificationDeadlineAt"]')).toContainText("Verify by");
  await expect(item.locator('[data-detail="lastCheck"]')).toContainText(
    /Last check\s*(?:Not checked yet\.|.+: The DNS servers of the domain did not answer in time\.)/,
  );

  // "Check now" and "Remove" for a pending domain, named with the domain; no "Make primary" before it is verified.
  await expect(item.getByRole("button", { name: `Check now (${hostname})` })).toBeEnabled();
  await expect(item.getByRole("button", { name: `Remove (${hostname})` })).toBeEnabled();
  await expect(item.getByRole("button", { name: /^Make primary/ })).toHaveCount(0);
  expect(txtValue, "the TXT record's value").toMatch(/^\S{16,}$/);
  return txtValue;
}

test("the domains page lists the Velexis address and offers a custom domain [PFE-027 AC1]", async () => {
  await page.goto(domainsPath);
  await expect(page.getByRole("heading", { level: 1, name: "Domains" })).toBeVisible();

  // The Velexis address: verified and primary, a link to the storefront, nothing to set up.
  const velexis = page.getByRole("region", { name: "Velexis address" });
  const subdomain = velexis.getByRole("listitem").filter({ hasText: owned.storefrontHost });
  await expect(subdomain.getByRole("link", { name: owned.storefrontHost })).toHaveAttribute(
    "href",
    `https://${owned.storefrontHost}/`,
  );
  await expect(subdomain.getByText("Primary", { exact: true })).toBeVisible();
  await expect(subdomain.getByText("Verified", { exact: true })).toBeVisible();

  // The custom domains (FEATURE_CUSTOM_DOMAINS on, the plan with one): none yet, and the add form.
  const custom = page.getByRole("region", { name: "Custom domains" });
  await expect(custom.getByText("This OTA has no custom domain.")).toBeVisible();
  const add = page.getByRole("region", { name: "Add a custom domain" });
  await expect(add.getByLabel("Domain name")).toBeEditable();
  await expect(add.getByRole("button", { name: "Add domain" })).toBeEnabled();
  await expect(page.getByText("Custom domains are not in your plan")).toHaveCount(0);
  await expectAccessible(page, "Domains");
});

test("adding a custom domain shows the pending view with its DNS records and Check now [PFE-027 AC1]", async () => {
  const add = page.getByRole("region", { name: "Add a custom domain" });
  // Typed as an owner might paste it, in capitals: the platform stores the host name in lower case.
  await add.getByLabel("Domain name").fill(hostname.toUpperCase());
  await add.getByRole("button", { name: "Add domain" }).click();

  // The add form's answer: the records to create, right away.
  const added = page.getByRole("group", { name: `${hostname} was added` });
  await expect(added).toBeVisible();
  await expect(added.getByRole("table", { name: `DNS records for ${hostname}` })).toBeVisible();

  // The domain in the list, pending, with its records, its deadline, its last check and "Check now" (PF-41 AC1).
  verificationValue = await expectPendingView(domainItem());
  await expect(page.getByText("This OTA has no custom domain.")).toHaveCount(0);
  // The platform agrees: the domain is pending, with the records the page shows.
  const listed = await callPlatformApi<Schemas["DomainList"]>({
    operation: "listDomains",
    method: "GET",
    path: `/v1/tenants/${encodeURIComponent(owned.ota.id)}/domains`,
    endUserIp: owned.owner.account.endUserIp,
    accessToken: owned.owner.accessToken,
  });
  const domain = listed.data.find((candidate) => candidate.hostname === hostname);
  expect(domain).toMatchObject({ kind: "custom", verificationStatus: "pending", isPrimary: false });
  expect(domain?.dnsRecords.map((record) => record.type)).toEqual(
    expectedRecords.map((record) => record.type),
  );
  expect(domain?.dnsRecords[0]).toEqual({
    type: "TXT",
    name: `_velexis.${hostname}`,
    value: verificationValue,
  });

  // The page with the custom domain pending (the Note of 2026-11-04).
  await expectAccessible(page, "Domains");
});

test("a DNS record's copy button puts exactly its value on the clipboard [PFE-027 AC1]", async () => {
  const item = domainItem();
  await item.getByRole("button", { name: "Copy the value of the TXT record" }).click();
  // The outcome is announced in the table's live region, and the clipboard holds the value, nothing else.
  await expect(item.locator("[data-copy-status]")).toHaveText(
    "The value of the TXT record is copied to the clipboard.",
  );
  expect(await page.evaluate(async () => await navigator.clipboard.readText())).toBe(verificationValue);
  await expectAccessible(page, "Domains");
});

test("after a reload the domain is still pending with the same records [PFE-027 AC1]", async () => {
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Domains" })).toBeVisible();
  // The add form's panel is gone; the list shows the domain as before, the same verification value included.
  await expect(page.getByRole("group", { name: `${hostname} was added` })).toHaveCount(0);
  expect(await expectPendingView(domainItem())).toBe(verificationValue);
  await expectAccessible(page, "Domains");
});
