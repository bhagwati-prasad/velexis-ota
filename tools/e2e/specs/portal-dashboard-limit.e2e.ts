// The dashboard's storefront link and the tenant limit before the create-OTA wizard (FIX-W69-LIMIT, known issues
// KI-006 and KI-010; platform/frontend/README.md §2 `/dashboard` and `/otas/new`, scope PF-10 AC4), project `portal`:
//
//   an owner with as many OTAs as one account may own (listTenants' `tenantLimit`) → the dashboard links an active
//   OTA's storefront at the `storefrontUrl` listTenants answers, and offers "Create an OTA" as a disabled button, not a
//   link, described by the visible reason → `/otas/new` shows the same reason above its first step
//
// Arranged in `beforeAll` through the platform API (PADR-0017 item 5): a verified account (`createVerifiedAccount`)
// and its OTAs (`createOtaWithApi`) up to the limit listTenants answers, the first one set up by the OTA worker
// (`waitForOtaStatus`), so the journey needs `E2E_WITH_OTA=1` and fails at once without it. The others may still be
// setting up when the journey looks; a storefront that is not open yet is the portal's unit test
// (platform/frontend/src/app/(app)/dashboard/dashboard.test.tsx), since the OTA worker's speed decides when it opens.
// The OTAs stay in test mode, so the owner meets no MFA enrolment gate. The steps are tests in order (`mode: "serial"`).
import type { BrowserContext, Page } from "@playwright/test";
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
} from "../support/fixtures";
import { uniqueEmail } from "../support/mailpit";
import { buildAccount, stack } from "../support/seed";
import { PORTAL_URL } from "../support/stack";
import { createOtaWithApi, uniqueOtaKey, waitForOtaStatus, type SignedInOwner } from "../support/tenants";

test.describe.configure({ mode: "serial" });

type Schemas = components["schemas"];

/**
 * The budget of the one-time arrangement in `beforeAll` (a hook, not a step of the journey): an account through the
 * API and Mailpit, up to MAX_TENANTS_PER_ACCOUNT OTAs (3 by default) through createTenant, and the first one's set-up
 * on the OTA worker (about 2 s, at most 45 s).
 */
const ARRANGE_BUDGET_MS = 120_000;

let context: BrowserContext;
let page: Page;
let owner: SignedInOwner;
/** listTenants' answer once the owner is at the limit. */
let listed: Schemas["TenantList"];
/** The OTA the OTA worker has set up: its storefront is open. */
let activeOtaId: string;

/** listTenants as the owner. */
async function listTenants(): Promise<Schemas["TenantList"]> {
  return await callPlatformApi<Schemas["TenantList"]>({
    operation: "listTenants",
    method: "GET",
    path: "/v1/tenants",
    endUserIp: owner.account.endUserIp,
    accessToken: owner.accessToken,
  });
}

/**
 * Waits until `target` has the title of its page (Next.js streams a page's metadata after its content), then fails on
 * any serious or critical axe violation.
 */
async function expectAccessible(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(`${title} · Velexis`);
  await expectNoSeriousA11yViolations(target);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(ARRANGE_BUDGET_MS);
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "portal-dashboard-limit.e2e.ts needs an OTA set up by the OTA worker: run it with E2E_WITH_OTA=1",
    );
  }
  const account = await createVerifiedAccount(
    buildAccount({ email: uniqueEmail("tenantlimit"), fullName: "Lena Limit" }),
  );
  const session = await signInWithApi(account);
  owner = { account, accessToken: session.accessToken };

  const first = await createOtaWithApi(owner, { key: uniqueOtaKey("lim") });
  activeOtaId = first.id;
  await waitForOtaStatus(owner, first.id, "active");
  // Up to the limit the API answers (MAX_TENANTS_PER_ACCOUNT of the stack's platform API).
  let limit = (await listTenants()).tenantLimit;
  while (limit.owned < limit.max) {
    await createOtaWithApi(owner, { key: uniqueOtaKey("lim") });
    limit = (await listTenants()).tenantLimit;
  }
  listed = await listTenants();

  context = await newAccountContext(browser, account, PORTAL_URL);
  await addSessionCookies(context, "portal", session);
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

test("the API answers the owner's limit, the dashboard links the active OTA's storefrontUrl and shows Create an OTA disabled with its reason [FIX-W69-LIMIT AC1, AC2, AC3]", async () => {
  // AC1: every OTA of this account is its own and none failed, so all of them count.
  expect(listed.tenantLimit.owned).toBe(listed.tenantLimit.max);
  expect(listed.data).toHaveLength(listed.tenantLimit.max);
  const active = listed.data.find((tenant) => tenant.id === activeOtaId);
  if (active === undefined) {
    throw new Error("listTenants does not list the active OTA");
  }

  await page.goto("/dashboard");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1, name: "My OTAs" })).toBeVisible();

  // AC2: the active OTA's card links its storefront at listTenants' storefrontUrl (the primary host).
  const host = new URL(active.storefrontUrl).host;
  const card = main.getByRole("article").filter({ has: page.getByRole("heading", { name: active.name }) });
  await expect(card.getByRole("link", { name: host })).toHaveAttribute("href", active.storefrontUrl);

  // AC3: no working "Create an OTA" link; a disabled button named by the visible reason.
  await expect(main.getByRole("link", { name: "Create an OTA" })).toHaveCount(0);
  const create = main.getByRole("button", { name: "Create an OTA" });
  await expect(create).toBeDisabled();
  const reasonId = await create.getAttribute("aria-describedby");
  expect(reasonId).not.toBeNull();
  const reason = page.locator(`[id="${reasonId ?? ""}"]`);
  await expect(reason).toBeVisible();
  await expect(reason).toHaveText(
    new RegExp(`^You already own ${listed.tenantLimit.max} OTAs?, the most one account can have\\.`),
  );
  await expectAccessible(page, "My OTAs");
});

test("opening /otas/new at the limit shows the same reason above the first step [FIX-W69-LIMIT AC3]", async () => {
  await page.goto("/otas/new");
  const main = page.getByRole("main");
  const firstStep = main.getByRole("heading", { level: 2, name: "OTA details" });
  await expect(firstStep).toBeVisible();
  const notice = main.locator('[data-notice="tenant-limit"]');
  await expect(notice).toHaveText(
    new RegExp(`^You already own ${listed.tenantLimit.max} OTAs?, the most one account can have\\.`),
  );
  // Above the first step, in reading order and on screen.
  const [noticeBox, stepBox] = await Promise.all([notice.boundingBox(), firstStep.boundingBox()]);
  expect(noticeBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(stepBox?.y ?? 0);
  await expectAccessible(page, "Create an OTA");
});
