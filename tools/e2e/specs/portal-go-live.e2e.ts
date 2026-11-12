// The portal's go-live journey (PFE-027 step 4; scope PF-14 AC1 and AC2, platform/frontend/README.md §2
// `/otas/[tenantId]/go-live`, the platform document's `goLive`), project `portal`:
//
//   the owner of an active OTA in test mode opens the go-live page: the six preconditions, each with its state in words
//   and a link to the page that completes it (no live Amadeus connection yet: missing; two-factor sign-in: done) →
//   "Go live", confirmed, asks for a step-up; with the code the switch is tried and refused: the page names exactly what
//   is missing (a live Amadeus connection, a verified payout account, a plan with live mode, a current subscription),
//   and the OTA stays in test mode → the preconditions the stack cannot reach are met as fixtures → "Go live" again:
//   the OTA is live, the page shows the live storefront and that the switch takes effect within 60 seconds → the
//   hosted storefront's configuration follows (live) within those 60 seconds → the API keys page has its live tab
//
// Arranged in `beforeAll` through the platform API: the owner's active OTA (`newOwnerWithActiveOta`, set up by the OTA
// worker, so the journey needs `E2E_WITH_OTA=1` and fails at once without it). The owner signs in before turning MFA on
// (`enableMfa`, with a sign-in of its own), so the browser's session carries no TOTP verification and `goLive`
// (`x-mfa-step-up`) answers `401 REAUTH_REQUIRED`: the page asks for the code in its step-up dialog (PADR-0008). The
// stack turns FEATURE_LIVE_SWITCH on for the platform processes (support/stack.ts `PLATFORM_SWITCHES_ON`, OFE-022).
//
// Between the refusal and the switch, `meetLivePreconditions` of support/ota.ts (OFE-022) meets what the stack cannot
// reach for real: a plan with live mode and the OTA's manual subscription made `active` through the platform admin API
// (`adminCreatePlan`, `adminUpdateManualSubscription`) as a platform admin of the journey's own (`newHarnessAdmin`,
// made in `beforeAll`), and, as velexis_migrator fixtures because no API reaches them, the OTA's own live Amadeus
// connection on the stack's stub (its client secret sealed with the stack's KEK) and the test payment connection as
// Stripe Connect leaves it (so no payout account is needed). goLive, MFA and the step-up are real.
//
// Every page and dialog the journey visits passes axe once its title is in place. The steps are tests in order on one
// browser context made in `beforeAll` (`mode: "serial"`).
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../support/a11y";
import {
  addSessionCookies,
  enableMfa,
  expect,
  newAccountContext,
  test,
  uniqueTestIp,
  type MfaAccount,
} from "../support/fixtures";
import {
  EdgeApi,
  FIXTURE_PRECONDITIONS,
  meetLivePreconditions,
  newHarnessAdmin,
  newOwnerWithActiveOta,
  storefrontHostsOf,
  uniqueLiveOfficeId,
  type OwnedOta,
} from "../support/ota";
import { stack, type AdminApiSession } from "../support/seed";
import { PORTAL_URL } from "../support/stack";
import { getOtaWithApi } from "../support/tenants";

test.describe.configure({ mode: "serial" });

/**
 * The budget of the one-time arrangement in `beforeAll` (a hook, not a step of the journey): two accounts through the
 * platform API and Mailpit (at most 15 s each; the second is the platform admin of `newHarnessAdmin`, with MFA and
 * `admin:grant`), the OTA's set-up on the OTA worker (about 2 s, at most 45 s per OTA, and up to three OTAs while
 * admin-amadeus-pool.e2e.ts holds the test pool), and MFA turned on.
 */
const ARRANGE_BUDGET_MS = 180_000;

/**
 * How long the step waits for the hosted storefront's configuration to follow the switch: inside the step's default
 * 30 s, and so inside PF-14 AC2's 60 s. The platform's `tenant` invalidation makes it about a second.
 */
const FOLLOW_TIMEOUT_MS = 20_000;

/** The portal's title of a page (`%s · Velexis`). */
const portalTitle = (title: string): string => `${title} · Velexis`;

/** Waits until `target` has the title of its page, then fails on any serious or critical axe violation. */
async function expectAccessible(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(portalTitle(title));
  await expectNoSeriousA11yViolations(target);
}

/** A precondition of goLive, as `details.missing` and the page's `data-precondition` name it. */
type Precondition =
  "amadeus_live" | "payments_live" | "payout_account" | "plan_live_mode" | "subscription" | "mfa";

/** What the go-live page shows for each precondition: its title, and the link to the page that completes it. */
const PRECONDITIONS: Readonly<
  Record<Precondition, { readonly title: string; readonly link: string; readonly path: string }>
> = {
  amadeus_live: { title: "An active live Amadeus connection", link: "Go to Amadeus", path: "/amadeus" },
  payments_live: { title: "Live payments", link: "Go to payments", path: "/payments" },
  payout_account: {
    title: "A verified payout account",
    link: "Go to the payout account",
    path: "/payments/payout-account",
  },
  plan_live_mode: { title: "A plan with live mode", link: "Go to billing", path: "/billing" },
  subscription: { title: "A current subscription", link: "Go to billing", path: "/billing" },
  mfa: { title: "Two-factor sign-in", link: "Go to security", path: "/account/security" },
};

/** The preconditions in the platform document's order (and the page's). */
const ORDER = Object.keys(PRECONDITIONS) as Precondition[];

/** The state of a precondition in words ("Done", "Missing", "Checked when you go live"). */
type StateWords = "Done" | "Missing" | "Checked when you go live";

let owned: OwnedOta;
/** The platform admin of the journey's own that gives the OTA its plan with live mode (`meetLivePreconditions`). */
let admin: AdminApiSession;
/** The owner with MFA on: the authenticator answers the step-up. */
let owner: MfaAccount;
let context: BrowserContext;
let page: Page;
/** `/otas/<tenantId>/go-live`. */
let goLivePath: string;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(ARRANGE_BUDGET_MS);
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "portal-go-live.e2e.ts needs an active OTA: run it with E2E_WITH_OTA=1 (the Amadeus stub and the OTA worker)",
    );
  }
  // The owner signs in (the browser's session, without a TOTP verification), then turns MFA on in a sign-in of its own.
  owned = await newOwnerWithActiveOta("Gina Golive", "golive");
  owner = await enableMfa(owned.owner.account);
  goLivePath = `/otas/${owned.ota.id}/go-live`;
  admin = await newHarnessAdmin("Gustav Golive Admin");

  context = await newAccountContext(browser, owner, PORTAL_URL);
  await addSessionCookies(context, "portal", owned.session);
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

/** The checklist "What going live needs". */
function checklist(): Locator {
  return page.getByRole("region", { name: "What going live needs" });
}

/**
 * Checks every precondition of the checklist: in the document's order, with its title, its state in words as
 * `states` says, and its link to the page that completes it (PF-14 AC1).
 */
async function expectChecklist(states: Readonly<Record<Precondition, StateWords>>): Promise<void> {
  const items = checklist().getByRole("listitem");
  await expect(items).toHaveCount(ORDER.length);
  for (const [index, precondition] of ORDER.entries()) {
    const { title, link, path } = PRECONDITIONS[precondition];
    const item = items.nth(index);
    await expect(item).toHaveAttribute("data-precondition", precondition);
    await expect(item.getByText(title, { exact: true })).toBeVisible();
    await expect(item.locator("[data-state-label]")).toHaveText(states[precondition]);
    const href = path.startsWith("/account") ? path : `/otas/${owned.ota.id}${path}`;
    await expect(item.getByRole("link", { name: link })).toHaveAttribute("href", href);
  }
}

/** Opens "Go live" and confirms it in its dialog (axe on the dialog). */
async function pressGoLive(): Promise<void> {
  await page.getByRole("button", { name: "Go live", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: "Switch your storefront to live?" });
  await expect(confirm).toBeVisible();
  await expectAccessible(page, "Go live");
  await confirm.getByRole("button", { name: "Go live", exact: true }).click();
  await expect(confirm).toBeHidden();
}

test("the go-live page lists the preconditions with links to the pages that complete them [PFE-027 AC1]", async () => {
  await page.goto(goLivePath);
  await expect(page.getByRole("heading", { level: 1, name: "Go live" })).toBeVisible();
  // Before the first try the page knows for sure only what the account and the onboarding checklist say: no live
  // Amadeus connection exists, and the owner has two-factor sign-in on. The API checks the rest when the owner tries.
  await expectChecklist({
    amadeus_live: "Missing",
    payments_live: "Checked when you go live",
    payout_account: "Checked when you go live",
    plan_live_mode: "Checked when you go live",
    subscription: "Checked when you go live",
    mfa: "Done",
  });
  await expect(page.getByRole("button", { name: "Go live", exact: true })).toBeEnabled();
  await expectAccessible(page, "Go live");
});

test("Go live asks for a step-up, then names exactly the missing preconditions, and nothing changes [PFE-027 AC1]", async () => {
  await pressGoLive();

  // goLive answered REAUTH_REQUIRED: the step-up dialog asks for a code of the authenticator app.
  const stepUp = page.getByRole("dialog", { name: "Confirm it is you" });
  await expect(stepUp).toBeVisible();
  await expect(stepUp.getByLabel("Authentication code")).toBeFocused();
  await expectAccessible(page, "Go live");
  await stepUp.getByLabel("Authentication code").fill(await owner.authenticator.nextCode());
  await stepUp.getByRole("button", { name: "Confirm" }).click();
  await expect(stepUp).toBeHidden();

  // The switch ran again with the new session and was refused (422 LIVE_PRECONDITIONS_UNMET): the summary says how many
  // are missing, and every precondition is decided, the missing ones exactly those the stack cannot reach (PF-14 AC1).
  const summary = page.locator("[data-go-live-unmet]");
  await expect(summary).toContainText("Your OTA cannot go live yet");
  await expect(summary).toContainText(
    `${FIXTURE_PRECONDITIONS.length} requirements are missing, so nothing has changed.`,
  );
  await expect(summary).toBeFocused();
  await expectChecklist({
    amadeus_live: "Missing",
    payments_live: "Done",
    payout_account: "Missing",
    plan_live_mode: "Missing",
    subscription: "Missing",
    mfa: "Done",
  });
  const missing = await checklist()
    .locator('[data-state="missing"]')
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-precondition")));
  expect(missing).toEqual([...FIXTURE_PRECONDITIONS]);
  // Nothing changed: the OTA is still in test mode.
  expect((await getOtaWithApi(owned.owner, owned.ota.id)).storefrontEnvironment).toBe("test");
  await expectAccessible(page, "Go live");
});

test("once the preconditions are met, Go live switches the OTA to live and shows its live storefront [PFE-027 AC1]", async () => {
  // What the stack cannot reach for real, as OFE-022's journey meets it (see the file header).
  await meetLivePreconditions(owned, uniqueLiveOfficeId(), admin);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Go live" })).toBeVisible();
  // The live Amadeus connection exists now, so the page no longer marks it missing before the try.
  await expect(checklist().locator('[data-precondition="amadeus_live"] [data-state-label]')).toHaveText(
    "Checked when you go live",
  );
  await expectAccessible(page, "Go live");

  // The step-up of the last step is recent (15 minutes, PADR-0008): no code is asked this time.
  await pressGoLive();
  await expect(page.getByRole("dialog", { name: "Confirm it is you" })).toHaveCount(0);

  // PF-14 AC2: the live view with the live storefront's address and the 60-second note.
  const live = page.getByRole("region", { name: "Your storefront is live" });
  await expect(live).toBeVisible();
  await expect(live.getByRole("status")).toHaveText(
    "The switch takes effect within 60 seconds: until then your storefront can still show test mode.",
  );
  const storefrontUrl = `https://${owned.storefrontHost}/`;
  await expect(live.getByRole("link", { name: storefrontUrl })).toHaveAttribute("href", storefrontUrl);
  await expect(page.getByRole("region", { name: "What going live needs" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Go live", exact: true })).toHaveCount(0);
  await expectAccessible(page, "Go live");

  // The platform has switched the OTA (storefront_environment = live).
  const ota = await getOtaWithApi(owned.owner, owned.ota.id);
  expect(ota.storefrontEnvironment).toBe("live");
});

test("the hosted storefront follows the switch to live within 60 seconds [PFE-027 AC1]", async () => {
  // storefront.get as the storefront edge of the OTA's host answers it (Caddy in front of the OTA API), polled until
  // the platform's invalidations reached the OTA API: about a second, within the step's 30 s and PF-14 AC2's 60 s.
  const edge = new EdgeApi(owned.storefrontHost, uniqueTestIp());
  await expect
    .poll(
      async () => storefrontHostsOf(await edge.call("getStorefront", "GET", "/v1/storefront"))?.environment,
      {
        timeout: FOLLOW_TIMEOUT_MS,
        message: "the OTA's storefront configuration is live",
      },
    )
    .toBe("live");
});

test("the live view leads to the API keys page, which has its live tab now [PFE-027 AC1]", async () => {
  await page
    .getByRole("region", { name: "Your storefront is live" })
    .getByRole("link", { name: "Create live API keys" })
    .click();
  await page.waitForURL(`${PORTAL_URL}/otas/${owned.ota.id}/api-keys`);
  await expect(page.getByRole("heading", { level: 1, name: "API keys" })).toBeVisible();
  const environments = page.getByRole("tablist", { name: "Environment" });
  await expect(environments.getByRole("tab", { name: "Test keys" })).toBeVisible();
  await expect(environments.getByRole("tab", { name: "Live keys" })).toBeVisible();
  await expectAccessible(page, "API keys");
});
