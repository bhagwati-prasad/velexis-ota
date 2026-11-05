// The friction of the platform admin's sensitive actions (PAD-016 step 3; platform/admin/README.md §2 "step-up" and
// "reason", §4 "Reason and step-up", PADR-0006 Access items 4 and 5), project `platform-admin`:
//
//   every **step-up** action of README §2 asks for a TOTP code when the admin's last step-up is older than 15 minutes,
//   and runs nothing before it: entering and rotating the shared Amadeus credentials (create, a new client id, a new
//   secret; each step-up cancelled, so nothing changes), revealing a payout account, approving a statement and marking
//   it paid, granting and revoking admin rights, resetting an account's two-factor authentication (each completed with
//   a code, and then done) → every **reason** action refuses an empty reason (and one of spaces) at its field and sends
//   nothing: suspend and resume, disable and enable a connection, cancel a queued job, edit a manual subscription,
//   retire and release an office, add an adjustment and void a draft, reveal a payout account, remove a domain, disable
//   and enable an account, reset two-factor authentication, grant admin rights
//
// The 15 minutes. Each admin signs in through the platform API with a TOTP code, which counts for 15 minutes
// (PADR-0008). Before each step-up action, `ageAdminMfa` of support/seed.ts moves the last TOTP verification of the
// admin's sessions (`account_sessions.mfa_verified_at`) 20 minutes back, and the browser loses its access cookie, as on
// its expiry: the admin's middleware refreshes the session with the refresh cookie, and the step checks that the new
// access token carries the old `mfa_at` before the action. The API answers the action `401 REAUTH_REQUIRED`, and the
// page asks for a code in its step-up dialog (README §4); the step checks through the platform API that nothing was
// done yet. A completed step-up makes the session's verification new again, so the next step-up action ages it again.
//
// The codes. The platform accepts each TOTP step of an account once, and an authenticator has two usable steps at a
// time (support/totp.ts `Authenticator`). Three admins share the six completed step-ups, two each (finance: approve
// and mark paid; people: grant and revoke; support: reveal and reset two-factor), and `beforeAll` waits until each has
// its current and next step unused, so no step waits for the clock. The cancelled step-ups use no code.
//
// "Nothing is sent". The reason dialogs (`ReasonDialog`, the release dialog, the adjustment form) check the reason in
// the browser (5 to 500 characters after trimming) and call no server action with an empty one: each refusal step
// counts the server actions the page posts (`Next-Action`) while it submits the empty reason, and expects none.
//
// Arrangements in `beforeAll` (PADR-0017 item 5: the public APIs where an operation exists, support/seed.ts and the
// stack's database for the rest):
//   - through the platform API: the three admins (accounts with MFA that `admin:grant` makes platform admins, signed in
//     through `adminSignIn` and `adminVerifyMfa`); the owner's active OTA (`newOwnerWithActiveOta` with MFA, set up by
//     the OTA worker, so the journey needs `E2E_WITH_OTA=1` and fails at once without it); its verified payout account
//     (the owner's `setPayoutAccount`, the admin's `adminReviewPayoutAccount`); a plan with one custom domain as its
//     plan (`moveOtaToNewPlan`) and a pending custom domain (the owner's `addDomain`); the target account with MFA
//     whose rights and two-factor authentication the admins change;
//   - support/seed.ts (`insertDraftSettlement`, `ageAdminMfa`, as the platform API's own role): last month's draft
//     statement of the OTA with a positive net, and the aged verifications;
//   - the stack's database, as the platform API's own role: a queued `migrate` job of the OTA due tomorrow, as the
//     failure handler leaves a job whose attempt was lost (back to `queued` with its backoff). No operation leaves a job
//     queued for longer than the moment before its dispatch, and "Cancel job" is offered on a queued job only; the
//     journey's own cancel ends it.
//
// The steps are tests in order (`mode: "serial"`) on browser contexts made in `beforeAll`. Every dialog the journey
// opens passes axe. Tokens, codes and the client secret stay in variables and are never logged.
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
  type PlatformApiError,
  signInToAdminWithApi,
  test,
  type MfaAccount,
} from "../support/fixtures";
import { newOwnerWithActiveOta, newTenantId, type OwnedOta } from "../support/ota";
import {
  ageAdminMfa,
  buildAccount,
  grantPlatformAdmin,
  insertDraftSettlement,
  moveOtaToNewPlan,
  stack,
  withDatabase,
  type AdminApiSession,
} from "../support/seed";
import { AMADEUS_STUB_URL, PLATFORM_ADMIN_URL } from "../support/stack";
import { TOTP_PERIOD_SECONDS, totpStep } from "../support/totp";

test.describe.configure({ mode: "serial" });

type Schemas = components["schemas"];

/**
 * The budget of the one-time arrangement in `beforeAll` (a hook, not a step of the journey): five accounts through the
 * platform API and Mailpit, in parallel (at most 15 s each), their MFA, three `admin:grant` and three API sign-ins, the
 * OTA's set-up on the OTA worker (about 2 s, at most 45 s per OTA, and up to three OTAs while admin-amadeus-pool.e2e.ts
 * holds the test pool), the payout account, the plan and the domain (a few calls), the statement and the job, and the
 * wait for two unused TOTP steps of every admin (at most 60 s).
 */
const ARRANGE_BUDGET_MS = 240_000;

/** The step-up of README §4: 15 minutes, in seconds. */
const STEP_UP_WINDOW_SECONDS = 15 * 60;

/** The admin's title of a page (`%s · Velexis admin`). */
const adminTitle = (title: string): string => `${title} · Velexis admin`;

/** The step-up dialog's title (`STEP_UP_STRINGS`). */
const STEP_UP_DIALOG = "Confirm with your authenticator app";

/** The message of an empty reason (`REASON_STRINGS.required`). */
const REASON_REQUIRED = "Enter a reason.";

/** A reason the admin types: stored in the audit log. */
const reason = (what: string): string => `${what} (PAD-016 step-up journey).`;

/** An id as the platform writes them: `<prefix>_` and a ULID. */
const platformId = (prefix: "stl" | "sln" | "job"): string =>
  `${prefix}_${newTenantId().slice("ten_".length)}`;

/** The first instant of the calendar month (UTC) `offset` months from the one of `now`. */
function monthStart(now: Date, offset: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
}

/** The month of a statement as the admin writes it ("October 2026"). */
const MONTH = new Intl.DateTimeFormat("en", { year: "numeric", month: "long", timeZone: "UTC" });

/** One admin of the journey in its own browser context. */
interface AdminSide {
  readonly account: MfaAccount;
  readonly api: AdminApiSession;
  readonly context: BrowserContext;
  readonly page: Page;
  /** The TOTP step of its API sign-in. */
  readonly signInStep: number;
}

let finance: AdminSide;
let people: AdminSide;
let support: AdminSide;
let owned: OwnedOta;
let target: MfaAccount;
let targetAccountId: string;
let domainHost: string;
const settlementId = platformId("stl");
const queuedJobId = platformId("job");
let month: string;

/** Waits in the one-time arrangement until the TOTP step `step` has begun (see the file header, "The codes"). */
async function waitForTotpStep(step: number): Promise<void> {
  const wait = step * TOTP_PERIOD_SECONDS * 1000 - Date.now();
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait + 50));
  }
}

/** A new platform admin (MFA, `admin:grant`, an API sign-in) with its session in a browser context of its own. */
async function newAdmin(
  browser: Parameters<typeof newAccountContext>[0],
  fullName: string,
): Promise<AdminSide> {
  const account = await enableMfa(await createVerifiedAccount(buildAccount({ fullName })));
  await grantPlatformAdmin(account.email);
  const session = await signInToAdminWithApi(account);
  const signInStep = totpStep(Date.now());
  const context = await newAccountContext(browser, account, PLATFORM_ADMIN_URL);
  await addSessionCookies(context, "admin", session);
  return {
    account,
    api: { endUserIp: account.endUserIp, accessToken: session.accessToken },
    context,
    page: await context.newPage(),
    signInStep,
  };
}

/** The `mfa_at` claim (epoch seconds) of an access token; the token itself is never shown. */
function mfaAtOf(token: string): number {
  const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
    readonly mfa_at?: unknown;
  };
  if (typeof payload.mfa_at !== "number") {
    throw new Error("the admin's access token carries no mfa_at claim");
  }
  return payload.mfa_at;
}

/** The admin's access token as the browser holds it now (the httpOnly cookie, read by the test process only). */
async function accessTokenOf(side: AdminSide): Promise<string> {
  const cookie = (await side.context.cookies(PLATFORM_ADMIN_URL)).find((c) => c.name === "__Host-vxa_at");
  if (cookie === undefined) {
    throw new Error(`${side.account.email} has no access cookie`);
  }
  return cookie.value;
}

/**
 * Makes the admin's last step-up 20 minutes old (see the file header): `ageAdminMfa`, then the browser loses its
 * access cookie and opens `path`, whose middleware refreshes the session. Checks that the refreshed access token
 * carries the old `mfa_at`, older than the step-up's 15 minutes.
 */
async function lastStepUpTwentyMinutesAgo(side: AdminSide, path: string, title: string): Promise<void> {
  await ageAdminMfa(side.account.email);
  await side.context.clearCookies({ name: "__Host-vxa_at" });
  await side.page.goto(path);
  await expect(side.page).toHaveTitle(adminTitle(title));
  const mfaAt = mfaAtOf(await accessTokenOf(side));
  expect(Math.floor(Date.now() / 1000) - mfaAt).toBeGreaterThan(STEP_UP_WINDOW_SECONDS);
}

/** The step-up dialog of `side`'s page. */
const stepUpDialog = (side: AdminSide): Locator => side.page.getByRole("dialog", { name: STEP_UP_DIALOG });

/** Waits for the step-up dialog, the code field focused, and checks it with axe. */
async function expectStepUpAsked(side: AdminSide): Promise<void> {
  const dialog = stepUpDialog(side);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Authentication code")).toBeFocused();
  await expectNoSeriousA11yViolations(side.page);
}

/** Answers the step-up dialog with the next code of the admin's authenticator app. */
async function stepUpWithCode(side: AdminSide): Promise<void> {
  const dialog = stepUpDialog(side);
  await dialog.getByLabel("Authentication code").fill(await side.account.authenticator.nextCode());
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toBeHidden();
}

/** Closes the step-up dialog without a code: the action is not run. */
async function cancelStepUp(side: AdminSide): Promise<void> {
  const dialog = stepUpDialog(side);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
}

/** Counts the server actions (`POST` with `Next-Action`) a page sends while `fn` runs. */
async function serverActionsDuring(target: Page, fn: () => Promise<void>): Promise<number> {
  let sent = 0;
  const listener = (request: { method(): string; headers(): Record<string, string> }): void => {
    if (request.method() === "POST" && request.headers()["next-action"] !== undefined) {
      sent += 1;
    }
  };
  target.on("request", listener);
  try {
    await fn();
  } finally {
    target.off("request", listener);
  }
  return sent;
}

/**
 * Submits the reason form `form` (a dialog or the adjustment form) with an empty reason, then with a reason of
 * spaces: each time "Enter a reason." shows at the field, which takes the focus, and no server action is sent. The
 * form is checked with axe while it shows the refusal.
 */
async function expectEmptyReasonRefused(page: Page, form: Locator, submit: string): Promise<void> {
  const field = form.getByLabel("Reason", { exact: true });
  const sent = await serverActionsDuring(page, async () => {
    await expect(field).toHaveValue("");
    await form.getByRole("button", { name: submit, exact: true }).click();
    await expect(form.getByText(REASON_REQUIRED, { exact: true })).toBeVisible();
    await expect(field).toBeFocused();
    await field.fill("     ");
    await form.getByRole("button", { name: submit, exact: true }).click();
    await expect(form.getByText(REASON_REQUIRED, { exact: true })).toBeVisible();
    await expect(field).toHaveAttribute("aria-invalid", "true");
  });
  expect(sent, `server actions sent with an empty reason (${submit})`).toBe(0);
  await expectNoSeriousA11yViolations(page);
}

/** The OTA as the admin API answers it now. */
async function adminTenant(side: AdminSide): Promise<Schemas["AdminTenantDetail"]> {
  return await callPlatformApi<Schemas["AdminTenantDetail"]>({
    operation: "adminGetTenant",
    method: "GET",
    path: `/v1/admin/tenants/${encodeURIComponent(owned.ota.id)}`,
    ...side.api,
  });
}

/** The statement as the admin API answers it now. */
async function adminStatement(side: AdminSide): Promise<Schemas["AdminSettlement"]> {
  return await callPlatformApi<Schemas["AdminSettlement"]>({
    operation: "adminGetSettlement",
    method: "GET",
    path: `/v1/admin/settlements/${encodeURIComponent(settlementId)}`,
    ...side.api,
  });
}

/** The target account as the admin API answers it now. */
async function targetAccount(side: AdminSide): Promise<Schemas["AdminAccount"]> {
  const detail = await callPlatformApi<Schemas["AdminAccountDetail"]>({
    operation: "adminGetAccount",
    method: "GET",
    path: `/v1/admin/accounts/${encodeURIComponent(targetAccountId)}`,
    ...side.api,
  });
  return detail.account;
}

/**
 * An Amadeus account without its office counts: what a new secret, host or client id would change (`version` with
 * them). The counts are left out because other journeys running in parallel (two workers in CI) set up OTAs on offices
 * of the same pool meanwhile.
 */
function accountFields(
  account: Schemas["AdminAmadeusAccount"] | undefined,
): Omit<Schemas["AdminAmadeusAccount"], "officeCounts"> | undefined {
  if (account === undefined) {
    return undefined;
  }
  const { id, name, environment, baseUrl, clientId, status, lastVerifiedAt, lastError, createdAt, version } =
    account;
  return { id, name, environment, baseUrl, clientId, status, lastVerifiedAt, lastError, createdAt, version };
}

/** The Velexis Amadeus accounts as the admin API answers them now. */
async function amadeusAccounts(side: AdminSide): Promise<readonly Schemas["AdminAmadeusAccount"][]> {
  return (
    await callPlatformApi<Schemas["AdminAmadeusAccountList"]>({
      operation: "adminListAmadeusAccounts",
      method: "GET",
      path: "/v1/admin/amadeus-accounts",
      ...side.api,
    })
  ).data;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(ARRANGE_BUDGET_MS);
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "admin-step-up.e2e.ts needs an active OTA: run it with E2E_WITH_OTA=1 (the Amadeus stub and the OTA worker)",
    );
  }
  [finance, people, support, owned, target] = await Promise.all([
    newAdmin(browser, "Frida Finance Admin"),
    newAdmin(browser, "Petter People Admin"),
    newAdmin(browser, "Siri Support Admin"),
    newOwnerWithActiveOta("Stian Step-up Owner", "stp", { mfa: true }),
    createVerifiedAccount(buildAccount({ fullName: "Tora Target" })).then(enableMfa),
  ]);
  const tenantPath = encodeURIComponent(owned.ota.id);

  // The verified payout account: the owner's sign-in with a TOTP code is the step-up `setPayoutAccount` asks for.
  const payout = await callPlatformApi<Schemas["PayoutAccount"]>({
    operation: "setPayoutAccount",
    method: "PUT",
    path: `/v1/tenants/${tenantPath}/payout-account`,
    endUserIp: owned.owner.account.endUserIp,
    accessToken: owned.owner.accessToken,
    // The IBAN registry's example for Norway (the platform document's example), with its BIC.
    body: {
      accountHolderName: "Stian Step-up AS",
      countryCode: "NO",
      currency: "EUR",
      scheme: "iban",
      iban: "NO93 8601 1117 947",
      bic: "DNBANOKK",
    } satisfies Schemas["SetPayoutAccountRequest"],
  });
  await callPlatformApi<Schemas["PayoutAccount"]>({
    operation: "adminReviewPayoutAccount",
    method: "POST",
    path: `/v1/admin/tenants/${tenantPath}/payout-account/review`,
    ...finance.api,
    headers: { "If-Match": `"${String(payout.version)}"` },
    body: { decision: "verified" } satisfies Schemas["ReviewPayoutAccountRequest"],
  });

  // A plan with one custom domain, and the owner's pending custom domain.
  await moveOtaToNewPlan(callPlatformApi, {
    admin: support.api,
    owner: owned.owner,
    tenantId: owned.ota.id,
    plan: {
      code: `e2estp_${owned.ota.key}`,
      name: "E2E admin step-up",
      description: "A plan with one custom domain for the platform admin's step-up journey (PAD-016).",
      currency: "EUR",
      monthlyPrice: { amount: "29.00", currency: "EUR" },
      limits: { staffSeats: 5, apiKeys: 10, customDomains: 1, liveMode: false },
      features: {},
      isPublic: false,
      trialDays: 0,
      settlementFeeBps: 0,
      sortOrder: 93,
    },
    reason: reason("The step-up journey needs an OTA with one custom domain"),
  });
  domainHost = `shop.${owned.ota.key}-stepup.example`;
  await callPlatformApi<Schemas["Domain"]>({
    operation: "addDomain",
    method: "POST",
    path: `/v1/tenants/${tenantPath}/domains`,
    endUserIp: owned.owner.account.endUserIp,
    accessToken: owned.owner.accessToken,
    body: { hostname: domainHost } satisfies Schemas["AddDomainRequest"],
  });

  const accounts = await callPlatformApi<Schemas["AdminAccountList"]>({
    operation: "adminListAccounts",
    method: "GET",
    path: `/v1/admin/accounts?q=${encodeURIComponent(target.email)}`,
    ...people.api,
  });
  const found = accounts.data.find((account) => account.email === target.email);
  if (found === undefined) {
    throw new Error("adminListAccounts does not find the target account by its e-mail address");
  }
  targetAccountId = found.id;

  // Last month's draft statement: one payment of 300.00 EUR, a Stripe fee of 4.65 and the Velexis fee of 1.50 %
  // (4.50), so a net of 290.85 owed to the OTA (settlement-formula.ts).
  const now = new Date();
  const periodStart = monthStart(now, -1);
  month = MONTH.format(periodStart);
  const suffix = randomBytes(8).toString("hex");
  await insertDraftSettlement({
    id: settlementId,
    tenantId: owned.ota.id,
    currency: "EUR",
    periodStart,
    periodEnd: monthStart(now, 0),
    feeBps: 150,
    totals: {
      gross: "300.00",
      refunds: "0.00",
      disputes: "0.00",
      stripeFees: "4.65",
      velexisFees: "4.50",
      adjustments: "0.00",
      net: "290.85",
    },
    lines: [
      {
        id: platformId("sln"),
        lineType: "charge",
        amount: "300.00",
        stripeFee: "4.65",
        balanceTransactionId: `txn_e2e${suffix}`,
        paymentIntentId: `pi_e2e${suffix}`,
        description: "Booking payment (Oslo to Bergen)",
        occurredAt: new Date(periodStart.getTime() + 5 * 86_400_000),
      },
    ],
  });

  // The queued `migrate` job, back in the queue after a lost attempt and due tomorrow (see the file header).
  await withDatabase("platform", async (client) => {
    await client.query(
      `INSERT INTO platform.provisioning_jobs (id, tenant_id, kind, status, step, payload, attempt, scheduled_at,
                                               started_at, error)
       VALUES ($1, $2, 'migrate', 'queued', 'dispatch', '{}'::jsonb, 1, now() + interval '1 day', now(), $3)`,
      [queuedJobId, owned.ota.id, "ATTEMPT_LOST: the attempt's message was lost (PAD-016 journey)"],
    );
  });

  await waitForTotpStep(Math.max(finance.signInStep, people.signInStep, support.signInStep) + 2);
});

test.afterAll(async () => {
  await finance?.context.close();
  await people?.context.close();
  await support?.context.close();
});

test("suspending and resuming the OTA each refuse an empty reason, then run with one [PAD-016 step 3]", async () => {
  const { page } = support;
  await page.goto(`/tenants/${owned.ota.id}`);
  await expect(page).toHaveTitle(adminTitle("Tenant"));
  const suspension = page.getByRole("region", { name: "Suspension" });

  await suspension.getByRole("button", { name: "Suspend", exact: true }).click();
  const suspend = page.getByRole("dialog", { name: `Suspend ${owned.ota.name}?` });
  await expectEmptyReasonRefused(page, suspend, "Suspend OTA");
  expect((await adminTenant(support)).tenant.status).toBe("active");
  await suspend.getByLabel("Reason", { exact: true }).fill(reason("Suspended to check the reason dialog"));
  await suspend.getByRole("button", { name: "Suspend OTA" }).click();
  await expect(page.getByText("The OTA is suspended.")).toBeVisible();

  await suspension.getByRole("button", { name: "Resume", exact: true }).click();
  const resume = page.getByRole("dialog", { name: `Resume ${owned.ota.name}?` });
  await expectEmptyReasonRefused(page, resume, "Resume OTA");
  expect((await adminTenant(support)).tenant.status).toBe("suspended");
  await resume.getByLabel("Reason", { exact: true }).fill(reason("Resumed after the reason dialog's check"));
  await resume.getByRole("button", { name: "Resume OTA" }).click();
  await expect(page.getByText("The OTA is active again.")).toBeVisible();
});

test("disabling and enabling the OTA's Amadeus connection each refuse an empty reason, then run with one [PAD-016 step 3]", async () => {
  const { page } = support;
  await page.goto(`/tenants/${owned.ota.id}?tab=connections`);
  const card = page.getByRole("region", { name: "Amadeus, Test" });
  await expect(card).toContainText("Active");

  await card.getByRole("button", { name: /^Disable connection/ }).click();
  const disable = page.getByRole("dialog", { name: /^Disable the connection/ });
  await expectEmptyReasonRefused(page, disable, "Disable connection");
  await disable.getByLabel("Reason", { exact: true }).fill(reason("Disabled to check the reason dialog"));
  await disable.getByRole("button", { name: "Disable connection" }).click();
  await expect(card.getByRole("button", { name: /^Enable connection/ })).toBeVisible();

  await card.getByRole("button", { name: /^Enable connection/ }).click();
  const enable = page.getByRole("dialog", { name: /^Enable the connection/ });
  await expectEmptyReasonRefused(page, enable, "Enable connection");
  await enable.getByLabel("Reason", { exact: true }).fill(reason("Enabled again after the check"));
  await enable.getByRole("button", { name: "Enable connection" }).click();
  await expect(card.getByRole("button", { name: /^Disable connection/ })).toBeVisible();
  const amadeus = (await adminTenant(support)).amadeusConnections.find((c) => c.environment === "test");
  expect(amadeus?.status).toBe("active");
});

test("revealing the payout account refuses an empty reason, then asks for a code when the last step-up is older than 15 minutes [PAD-016 step 3]", async () => {
  await lastStepUpTwentyMinutesAgo(support, `/tenants/${owned.ota.id}?tab=connections`, "Tenant");
  const { page } = support;
  await page.getByRole("button", { name: "Reveal bank details" }).click();
  const dialog = page.getByRole("dialog", { name: `Reveal the bank details of ${owned.ota.name}?` });
  await expectEmptyReasonRefused(page, dialog, "Reveal");
  await dialog
    .getByLabel("Reason", { exact: true })
    .fill(reason("Checking the IBAN before the first payout"));
  await dialog.getByRole("button", { name: "Reveal", exact: true }).click();

  // `adminRevealPayoutAccount` answered REAUTH_REQUIRED: the page asks for a code and shows no bank details yet.
  await expectStepUpAsked(support);
  const revealed = page.getByRole("region", { name: `Bank details of ${owned.ota.name}` });
  await expect(revealed).toHaveCount(0);
  await stepUpWithCode(support);
  await expect(revealed).toContainText("NO93 8601 1117 947");
  await expect(revealed).toContainText("DNBANOKK");
});

test("cancelling the queued job refuses an empty reason, then cancels it with one [PAD-016 step 3]", async () => {
  const { page } = support;
  await page.goto(`/provisioning-jobs/${queuedJobId}`);
  await expect(page).toHaveTitle(adminTitle("Provisioning job"));
  await page.getByRole("button", { name: "Cancel job" }).click();
  const dialog = page.getByRole("dialog", { name: "Cancel this queued job?" });
  await expectEmptyReasonRefused(page, dialog, "Cancel job");
  await dialog
    .getByLabel("Reason", { exact: true })
    .fill(reason("The lost migration is not needed any more"));
  await dialog.getByRole("button", { name: "Cancel job" }).click();
  await expect(page.getByText("The job is canceled.")).toBeVisible();
});

test("the manual subscription's edit refuses an empty reason and saves nothing [PAD-016 step 3]", async () => {
  const { page } = support;
  const subscription = await callPlatformApi<Schemas["Subscription"]>({
    operation: "getSubscription",
    method: "GET",
    path: `/v1/tenants/${encodeURIComponent(owned.ota.id)}/subscription`,
    endUserIp: owned.owner.account.endUserIp,
    accessToken: owned.owner.accessToken,
  });
  await page.goto(`/subscriptions/${subscription.id}`);
  await expect(page).toHaveTitle(adminTitle("Subscription"));
  const trialEnd = page.getByLabel("Trial ends on");
  const day = await trialEnd.inputValue();
  const nextDay = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  await trialEnd.fill(nextDay);
  await page.getByRole("button", { name: "Save changes…" }).click();
  const dialog = page.getByRole("dialog", { name: "Save the changes to this subscription?" });
  await expectEmptyReasonRefused(page, dialog, "Save changes");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  const { subscription: after } = await callPlatformApi<Schemas["AdminSubscriptionDetail"]>({
    operation: "adminGetSubscription",
    method: "GET",
    path: `/v1/admin/subscriptions/${encodeURIComponent(subscription.id)}`,
    ...support.api,
  });
  expect(after.trialEndsAt).toBe(subscription.trialEndsAt);
});

test("retiring an available office and releasing the OTA's office each refuse an empty reason [PAD-016 step 3]", async () => {
  const { page } = support;
  await page.goto("/amadeus/offices?environment=test&status=available");
  await expect(page).toHaveTitle(adminTitle("Office pool"));
  const retire = page.getByRole("button", { name: /^Retire office / }).first();
  const officeId = ((await retire.textContent()) ?? "").replace(/^Retire\s*office\s*/, "").trim();
  await retire.click();
  const retireDialog = page.getByRole("dialog", { name: /^Retire office / });
  await expectEmptyReasonRefused(page, retireDialog, "Retire office");
  await retireDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(retireDialog).toBeHidden();
  expect(officeId).not.toBe("");

  await page.goto("/amadeus/offices?environment=test&status=assigned");
  const row = page.getByRole("row").filter({ hasText: owned.connection.officeId });
  await row.getByRole("button", { name: `Release office ${owned.connection.officeId}` }).click();
  const release = page.getByRole("dialog", { name: `Release office ${owned.connection.officeId}?` });
  await release
    .getByLabel(
      `${owned.ota.key} confirmed that no booking with future travel remains on office ${owned.connection.officeId}.`,
    )
    .check();
  await expectEmptyReasonRefused(page, release, "Release office");
  await release.getByRole("button", { name: "Cancel" }).click();
  await expect(release).toBeHidden();
  await expect(row).toContainText("Assigned");
});

test("removing the OTA's custom domain refuses an empty reason [PAD-016 step 3]", async () => {
  const { page } = support;
  await page.goto("/domains?kind=custom&verificationStatus=pending");
  await expect(page).toHaveTitle(adminTitle("Domains"));
  await page.getByRole("button", { name: `Remove ${domainHost}` }).click();
  const dialog = page.getByRole("dialog", { name: `Remove ${domainHost}?` });
  await expectEmptyReasonRefused(page, dialog, "Remove domain");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("row").filter({ hasText: domainHost })).toBeVisible();
});

test("the statement's adjustment and void each refuse an empty reason [PAD-016 step 3]", async () => {
  const { page } = finance;
  await page.goto(`/settlements/${settlementId}`);
  await expect(page).toHaveTitle(adminTitle("Statement"));
  const form = page.getByRole("form", { name: "Add an adjustment" });
  await form.getByLabel("Amount (EUR)").fill("10.00");
  await form.getByLabel("Description").fill("Goodwill credit");
  await expectEmptyReasonRefused(page, form, "Add adjustment");

  await page.getByRole("button", { name: "Void draft" }).click();
  const dialog = page.getByRole("dialog", { name: `Void the draft of ${owned.ota.name} for ${month}?` });
  await expectEmptyReasonRefused(page, dialog, "Void draft");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await adminStatement(finance)).toMatchObject({ status: "draft", lineCount: 1 });
});

test("approving the statement asks for a code when the last step-up is older than 15 minutes, then approves [PAD-016 step 3]", async () => {
  await lastStepUpTwentyMinutesAgo(finance, `/settlements/${settlementId}`, "Statement");
  const { page } = finance;
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  const confirm = page.getByRole("alertdialog", {
    name: `Approve the statement of ${owned.ota.name} for ${month}?`,
  });
  await expect(confirm).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await confirm.getByRole("button", { name: "Approve statement" }).click();
  await expectStepUpAsked(finance);
  expect((await adminStatement(finance)).status).toBe("draft");
  await stepUpWithCode(finance);
  await expect(
    page.getByRole("status").filter({ hasText: "The statement is approved, to be paid by bank transfer." }),
  ).toBeVisible();
  expect((await adminStatement(finance)).status).toBe("approved");
});

test("marking the statement paid asks for a code when the last step-up is older than 15 minutes, then records it [PAD-016 step 3]", async () => {
  await lastStepUpTwentyMinutesAgo(finance, `/settlements/${settlementId}`, "Statement");
  const { page } = finance;
  const reference = `E2E-${randomBytes(5).toString("hex").toUpperCase()}`;
  const form = page.getByRole("form", { name: "Record the bank transfer" });
  await form.getByLabel("Bank reference").fill(reference);
  await form.getByRole("button", { name: "Mark paid" }).click();
  await expectStepUpAsked(finance);
  expect((await adminStatement(finance)).status).toBe("approved");
  await stepUpWithCode(finance);
  await expect(
    page.getByRole("status").filter({
      hasText: "The statement is marked paid. The OTA's owners and finance members get an e-mail.",
    }),
  ).toBeVisible();
  expect(await adminStatement(finance)).toMatchObject({ status: "paid", payoutReference: reference });
});

test("granting admin rights refuses an empty reason, then asks for a code when the last step-up is older than 15 minutes [PAD-016 step 3]", async () => {
  await lastStepUpTwentyMinutesAgo(people, "/admins", "Platform admins");
  const { page } = people;
  await page.getByRole("button", { name: "Grant admin rights" }).click();
  const dialog = page.getByRole("dialog", { name: "Grant platform admin rights" });
  await dialog.getByLabel("E-mail address of the account").fill(target.email);
  await expectEmptyReasonRefused(page, dialog, "Grant admin rights");
  await dialog.getByLabel("Reason", { exact: true }).fill(reason("Tora joins the support rota"));
  await dialog.getByRole("button", { name: "Grant admin rights" }).click();
  await expectStepUpAsked(people);
  expect((await targetAccount(people)).isPlatformAdmin).toBe(false);
  await stepUpWithCode(people);
  await expect(page.getByRole("row").filter({ hasText: target.email })).toBeVisible();
  expect((await targetAccount(people)).isPlatformAdmin).toBe(true);
});

test("revoking admin rights asks for a code when the last step-up is older than 15 minutes, then revokes them [PAD-016 step 3]", async () => {
  await lastStepUpTwentyMinutesAgo(people, "/admins", "Platform admins");
  const { page } = people;
  const row = page.getByRole("row").filter({ hasText: target.email });
  await row.getByRole("button", { name: /^Revoke/ }).click();
  const confirm = page.getByRole("alertdialog", { name: /^Revoke the admin rights of / });
  await expect(confirm).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await confirm.getByRole("button", { name: "Revoke admin rights" }).click();
  await expectStepUpAsked(people);
  expect((await targetAccount(people)).isPlatformAdmin).toBe(true);
  await stepUpWithCode(people);
  await expect(row).toHaveCount(0);
  expect((await targetAccount(people)).isPlatformAdmin).toBe(false);
});

test("resetting an account's two-factor authentication refuses an empty reason, then asks for a code when the last step-up is older than 15 minutes [PAD-016 step 3]", async () => {
  await lastStepUpTwentyMinutesAgo(support, `/accounts/${targetAccountId}`, "Account");
  const { page } = support;
  await page.getByRole("button", { name: "Reset two-factor" }).click();
  const dialog = page.getByRole("dialog", { name: /^Reset the two-factor authentication of / });
  await expectEmptyReasonRefused(page, dialog, "Reset two-factor authentication");
  await dialog
    .getByLabel("Reason", { exact: true })
    .fill(reason("Identity checked by a video call; the phone with the authenticator was lost"));
  await dialog.getByRole("button", { name: "Reset two-factor authentication" }).click();
  await expectStepUpAsked(support);
  expect((await targetAccount(support)).mfaEnabled).toBe(true);
  await stepUpWithCode(support);
  await expect(
    page.getByText("Two-factor authentication is turned off for this account, and the person got an e-mail."),
  ).toBeVisible();
  expect((await targetAccount(support)).mfaEnabled).toBe(false);
});

test("disabling and enabling an account each refuse an empty reason, then run with one [PAD-016 step 3]", async () => {
  const { page } = support;
  await page.goto(`/accounts/${targetAccountId}`);
  await expect(page).toHaveTitle(adminTitle("Account"));
  await page.getByRole("button", { name: "Disable", exact: true }).click();
  const disable = page.getByRole("dialog", { name: /^Disable / });
  await expectEmptyReasonRefused(page, disable, "Disable account");
  await disable.getByLabel("Reason", { exact: true }).fill(reason("Disabled to check the reason dialog"));
  await disable.getByRole("button", { name: "Disable account" }).click();
  await expect(page.getByText("The account is disabled.")).toBeVisible();
  expect((await targetAccount(support)).status).toBe("disabled");

  await page.getByRole("button", { name: "Enable", exact: true }).click();
  const enable = page.getByRole("dialog", { name: /^Enable / });
  await expectEmptyReasonRefused(page, enable, "Enable account");
  await enable.getByLabel("Reason", { exact: true }).fill(reason("Enabled again after the check"));
  await enable.getByRole("button", { name: "Enable account" }).click();
  await expect(page.getByText("The account is enabled again.")).toBeVisible();
  expect((await targetAccount(support)).status).toBe("active");
});

test("entering or rotating the shared Amadeus credentials asks for a code when the last step-up is older than 15 minutes; cancelled, nothing changes [PAD-016 step 3]", async () => {
  await lastStepUpTwentyMinutesAgo(support, "/amadeus/accounts", "Amadeus accounts");
  const { page } = support;
  const before = await amadeusAccounts(support);
  const testAccount = before.find((account) => account.environment === "test");
  expect(testAccount?.status).toBe("active");
  const testRegion = page.getByRole("region", { name: "Test environment" });

  // A new secret for the test account: the step-up is asked, and cancelled.
  await testRegion.getByRole("button", { name: "Rotate secret" }).click();
  const rotate = testRegion.getByRole("form", { name: "Rotate the client secret" });
  await rotate.getByLabel("New client secret").fill(randomBytes(24).toString("base64url"));
  await rotate.getByRole("button", { name: "Save the new secret" }).click();
  await expectStepUpAsked(support);
  await cancelStepUp(support);
  await expect(rotate.getByLabel("New client secret")).toBeVisible();
  await testRegion.getByRole("button", { name: "Cancel" }).click();

  // A new client id for the test account ("Edit details"): the step-up is asked, and cancelled.
  await testRegion.getByRole("button", { name: "Edit details" }).click();
  const edit = testRegion.getByRole("form", { name: "Edit the account details" });
  await edit.getByLabel("Client id").fill(`e2e-stepup-${randomBytes(6).toString("hex")}`);
  await edit.getByRole("button", { name: "Save details" }).click();
  await expectStepUpAsked(support);
  await cancelStepUp(support);
  await testRegion.getByRole("button", { name: "Cancel" }).click();

  // The test account is as it was: no new secret, client id or version (its office counts may move meanwhile, see
  // `accountFields`).
  const after = (await amadeusAccounts(support)).find((account) => account.environment === "test");
  expect(after).toBeDefined();
  expect(accountFields(after)).toEqual(accountFields(testAccount));

  // The live account: created in the browser where none exists yet (admin-amadeus-pool.e2e.ts creates it when it runs
  // first and keeps it); the step-up is asked, and cancelled, so no account is created.
  const liveRegion = page.getByRole("region", { name: "Live environment" });
  const live = before.find((account) => account.environment === "live");
  const name = `Velexis live (PAD-016 ${randomBytes(3).toString("hex")})`;
  test.info().annotations.push({
    type: "live account",
    description: live === undefined ? "none yet: the browser's form asked for the step-up" : "exists already",
  });
  if (live === undefined) {
    await liveRegion.getByRole("button", { name: "Set up the Live account" }).click();
    const form = liveRegion.getByRole("form", { name: "New Live account" });
    await form.getByLabel("Name").fill(name);
    await form.getByLabel("Amadeus host").fill(AMADEUS_STUB_URL);
    await form.getByLabel("Client id").fill(`e2e-stepup-${randomBytes(6).toString("hex")}`);
    await form.getByLabel("Client secret").fill(randomBytes(24).toString("base64url"));
    await form.getByRole("button", { name: "Save and verify" }).click();
    await expectStepUpAsked(support);
    await cancelStepUp(support);
    await expect(form).toBeVisible();
  } else {
    // The page offers no form for an environment with an account: the operation the form calls answers
    // REAUTH_REQUIRED to this session (its refreshed access token, with the old `mfa_at`) before anything else.
    await expect(liveRegion.getByRole("button", { name: "Set up the Live account" })).toHaveCount(0);
    await expect(
      callPlatformApi({
        operation: "adminCreateAmadeusAccount",
        method: "POST",
        path: "/v1/admin/amadeus-accounts",
        endUserIp: support.account.endUserIp,
        accessToken: await accessTokenOf(support),
        body: {
          environment: "live",
          name,
          baseUrl: AMADEUS_STUB_URL,
          clientId: `e2e-stepup-${randomBytes(6).toString("hex")}`,
          clientSecret: randomBytes(24).toString("base64url"),
        } satisfies Schemas["CreateAmadeusAccountRequest"],
      }),
    ).rejects.toMatchObject({ status: 401, code: "REAUTH_REQUIRED" } satisfies Partial<PlatformApiError>);
  }
  expect((await amadeusAccounts(support)).filter((account) => account.name === name)).toEqual([]);
});
