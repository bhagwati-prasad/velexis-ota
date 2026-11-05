// MFA mandatory for the owners and admins of live OTAs (PBE-071; PADR-0008, revision of 2026-11-05, lead decision (5b);
// scope PF-04 AC4; platform/docs/security-review.md §9) through the HTTP pipeline (createTestApp) on this file's
// database clone: an admin without MFA of an OTA that went live through `goLive` is told so by `getMe` and `updateMe`
// (`mfaEnrolmentRequired`) and answers `403 MFA_REQUIRED` (`details.reason = enrolment_required`) on every `portal`
// operation, reads included and its other (test) OTA's too, until it enrols with `startMfaSetup` and `enableMfa`
// (`portal_unverified`, still open); then it answers as an admin with MFA of the same OTA does. `disableMfa` refuses it
// with `409 CONFLICT` (`mfa_mandatory`) once its step-up has passed and writes nothing; after a support MFA reset
// (`adminResetAccountMfa`) it meets the guard again. An agent, a finance member and a viewer of the live OTA, an owner
// of a test-only OTA and an account whose admin membership of the live OTA was removed are never refused. Last, the
// live OTA's owner, who went live with MFA, meets the guard after a support MFA reset too (the owner role of the
// membership query). Every answer is checked against the platform document.
//
// The OTA meets every precondition of go-live (written with the builders, as go-live.int.test.ts writes them) and goes
// live through the API with its owner's MFA and a step-up. Tokens come from the application's TokenService at the
// FakeClock's time; the TOTP codes of the enrolment are computed at that time, as an authenticator app would. The
// milestone switches are a stand-in for FeatureSwitches with all six on, so no `FEATURE_DISABLED` hides an answer.
// Every group's calls happen in its `beforeAll` hook, in order, with a budget of their own; the tests read the answers.
import type { PlatformOperationId } from "@velexis/api-types/operations";
import { expectResponseToMatch } from "@velexis/testing";
import type { Response } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpCode } from "../../../src/accounts/mfa.service";
import { TokenService, type AccessTokenInput } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import {
  FEATURES,
  FEATURE_VARIABLES,
  featuresFor,
  FeatureSwitches,
  type Feature,
  type FeatureConfig,
} from "../../../src/common/features";
import {
  insertAccount,
  insertPaymentConnection,
  insertPlan,
  insertRow,
  insertSupplierConnection,
  PLACEHOLDER_CIPHERTEXT,
  PLACEHOLDER_KEK_ID,
  testId,
  type PlatformRow,
} from "../../builders/platform-rows";
import { insertMember, insertMembership, insertOta } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

/** The database clone, the Nest module graph and the Ajv validators of the document take seconds on a loaded runner. */
const SETUP_TIMEOUT_MS = 60_000;
/** A group's calls: a few dozen requests through the pipeline, well under a second locally; bounded for CI. */
const GROUP_SETUP_TIMEOUT_MS = 60_000;
const FAMILY = testId("asn", 71);
/** How old the last step-up of a stale token is: past the 15 minutes of PADR-0008. */
const STALE_STEP_UP_SECONDS = 20 * 60;
/** The reason of the support reset (5–500 characters, PADR-0006). */
const RESET_REASON = "Lost phone; identity checked on a video call";

/** Every milestone switch on: the rule must show whatever the switches say. */
class AllSwitchesOn {
  isEnabled(_feature: Feature): boolean {
    return true;
  }

  features(): ReturnType<FeatureSwitches["features"]> {
    return featuresFor(
      Object.fromEntries(FEATURES.map((feature) => [FEATURE_VARIABLES[feature], true])) as FeatureConfig,
    );
  }
}

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;

let ipCounter = 0;
/** A documentation IP (RFC 5737) of its own for each request, so no per-IP limit is ever reached. */
function nextIp(): string {
  ipCounter += 1;
  return `192.0.2.${(ipCounter % 250) + 1}`;
}

const nowSeconds = (): number => Math.floor(t.clock.now().getTime() / 1000);

/** `Authorization: Bearer` with a fresh portal token of `accountId` (verified e-mail, no step-up unless asked). */
async function portal(
  accountId: string,
  input: Partial<AccessTokenInput> = {},
): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: accountId,
    sid: FAMILY,
    ev: true,
    amr: ["pwd"],
    ...input,
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(nextIp()) };
}

/** A portal token of `accountId` with a TOTP step-up now. */
const steppedUp = (accountId: string) => portal(accountId, { amr: ["pwd", "otp"], mfa_at: nowSeconds() });

/** `<status>` of a success, or `<status> <code>` of an error answer. */
function outcomeOf(res: Response): string {
  if (res.status < 300) {
    return String(res.status);
  }
  return `${res.status} ${(res.body as { error: { code: string } }).error.code}`;
}

function detailsOf(res: Response): Record<string, unknown> | undefined {
  return (res.body as { error?: { details?: Record<string, unknown> } }).error?.details;
}

/** One call of the portal, checked against the platform document. */
interface Call {
  readonly operationId: PlatformOperationId;
  readonly method: "get" | "post" | "patch";
  readonly path: string;
  readonly body?: object;
  readonly ifMatch?: string;
}

async function send(call: Call, headers: Record<string, string>): Promise<Response> {
  let request = t.http[call.method](call.path).set(headers);
  if (call.ifMatch !== undefined) {
    request = request.set("If-Match", call.ifMatch);
  }
  const res = await (call.body === undefined ? request : request.send(call.body));
  expectResponseToMatch(call.operationId, res, { document: "platform" });
  return res;
}

/** The four `portal` operations of the step: a read, a list, a key and the Stripe Customer Portal of `tenantId`. */
function portalCalls(tenantId: string): Call[] {
  return [
    { operationId: "getTenant", method: "get", path: `/v1/tenants/${tenantId}` },
    { operationId: "listApiKeys", method: "get", path: `/v1/tenants/${tenantId}/api-keys` },
    {
      operationId: "createApiKey",
      method: "post",
      path: `/v1/tenants/${tenantId}/api-keys`,
      body: { name: "Back office", kind: "secret", environment: "test" },
    },
    {
      operationId: "createCustomerPortalSession",
      method: "post",
      path: `/v1/tenants/${tenantId}/billing/portal-session`,
    },
  ];
}

/** `operationId → <status> [code]` of `calls` for `accountId`. */
async function answersOf(accountId: string, calls: readonly Call[]): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};
  for (const call of calls) {
    answers[call.operationId] = outcomeOf(await send(call, await portal(accountId)));
  }
  return answers;
}

const getMe: Call = { operationId: "getMe", method: "get", path: "/v1/me" };

/** `mfaEnrolmentRequired` of `getMe` for `accountId`. */
async function enrolmentRequired(accountId: string): Promise<unknown> {
  const res = await send(getMe, await portal(accountId));
  expect(res.status).toBe(200);
  return (res.body as { mfaEnrolmentRequired?: unknown }).mfaEnrolmentRequired;
}

async function accountRow(accountId: string): Promise<PlatformRow<"accounts">> {
  const { rows } = await pool.query("SELECT * FROM platform.accounts WHERE id = $1", [accountId]);
  return rows[0] as PlatformRow<"accounts">;
}

async function countOf(sql: string, params: readonly unknown[]): Promise<number> {
  const { rows } = await pool.query(sql, [...params]);
  return Number((rows[0] as { n: string }).n);
}

/** A support MFA reset of `accountId` (a lost device) by `platformAdminId`, with a step-up of now; its outcome. */
async function supportReset(platformAdminId: string, accountId: string): Promise<string> {
  const { token } = await tokens.sign({
    aud: "platform_admin",
    sub: platformAdminId,
    sid: FAMILY,
    ev: true,
    amr: ["pwd", "otp"],
    mfa_at: nowSeconds(),
  });
  return outcomeOf(
    await send(
      {
        operationId: "adminResetAccountMfa",
        method: "post",
        path: `/v1/admin/accounts/${accountId}/reset-mfa`,
        body: { reason: RESET_REASON },
      },
      { Authorization: `Bearer ${token}`, ...t.bffHeaders(nextIp()) },
    ),
  );
}

/** A live OTA's people and a test-only OTA of its admin, for every group of this file. */
interface Arrangement {
  readonly live: PlatformRow<"tenants">;
  /** A test-only OTA the live OTA's admin owns: the rule holds on its routes too. */
  readonly adminsTestOta: PlatformRow<"tenants">;
  readonly owner: PlatformRow<"accounts">;
  /** The admin without MFA whom the rule is about. */
  readonly admin: PlatformRow<"accounts">;
  /** An admin of the same OTA with MFA from the start: the answers "as before". */
  readonly adminWithMfa: PlatformRow<"accounts">;
  readonly agent: PlatformRow<"accounts">;
  readonly finance: PlatformRow<"accounts">;
  readonly viewer: PlatformRow<"accounts">;
  /** An account whose admin membership of the live OTA was removed. */
  readonly removedAdmin: PlatformRow<"accounts">;
  /** The owner, without MFA, of an OTA that never went live. */
  readonly testOnlyOwner: PlatformRow<"accounts">;
  readonly testOnly: PlatformRow<"tenants">;
  readonly platformAdmin: PlatformRow<"accounts">;
}

let arrangement: Arrangement;
/** The answer of goLive. */
let wentLive: Response;

/**
 * An active OTA that meets every precondition of go-live (go-live.int.test.ts): a plan with live mode, a Stripe
 * subscription in trial, an active live Amadeus connection, test payments in `velexis` mode and a verified payout
 * account; then it goes live through the API with its owner's MFA and a step-up.
 */
async function arrange(): Promise<Arrangement> {
  const plan = await insertPlan(pool, {
    limits: { staffSeats: 10, apiKeys: 10, customDomains: 1, liveMode: true },
  });
  const withMfa = { mfa_enabled: true, mfa_enabled_at: new Date("2026-01-02T09:00:00.000Z") };
  const owner = await insertAccount(pool, { full_name: "Olga Owner", ...withMfa });
  const admin = await insertAccount(pool, { full_name: "Ada Admin" });
  const adminWithMfa = await insertAccount(pool, { full_name: "Amund Admin", ...withMfa });
  const agent = await insertAccount(pool, { full_name: "Agnes Agent" });
  const finance = await insertAccount(pool, { full_name: "Finn Finance" });
  const viewer = await insertAccount(pool, { full_name: "Vera Viewer" });
  const removedAdmin = await insertAccount(pool, { full_name: "Rolf Removed" });
  const { tenant: live } = await insertOta(pool, {
    tenant: { plan_code: plan.code },
    subscription: {
      plan_code: plan.code,
      status: "trialing",
      billing_provider: "stripe",
      provider_subscription_id: "sub_pbe071live",
    },
    members: [
      [owner, "owner"],
      [admin, "admin"],
      [adminWithMfa, "admin"],
      [agent, "agent"],
      [finance, "finance"],
      [viewer, "viewer"],
    ],
  });
  await insertMembership(pool, live, removedAdmin, { role: "admin", status: "removed" });
  await insertSupplierConnection(pool, live, {
    environment: "live",
    base_url: "https://travel.api.amadeus.com",
    status: "active",
  });
  await insertPaymentConnection(pool, live, { environment: "test" });
  await insertRow(pool, "tenant_payout_accounts", {
    tenant_id: live.id,
    account_holder_name: "Acme Travel AS",
    country_code: "NO",
    currency: "EUR",
    scheme: "iban",
    bank_details_ciphertext: Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8"),
    encryption_key_id: PLACEHOLDER_KEK_ID,
    last4: "0189",
    status: "verified",
  });
  const { tenant: adminsTestOta } = await insertOta(pool, { members: [[admin, "owner"]] });
  const testOnlyOwner = await insertAccount(pool, { full_name: "Tor Test" });
  const { tenant: testOnly } = await insertOta(pool, { members: [[testOnlyOwner, "owner"]] });
  // The test-only OTA's owner is an agent of the live OTA too: agents of live OTAs keep MFA optional.
  await insertMember(pool, live, testOnlyOwner, "agent");
  const platformAdmin = await insertAccount(pool, { is_platform_admin: true, ...withMfa });

  wentLive = await send(
    {
      operationId: "goLive",
      method: "post",
      path: `/v1/tenants/${live.id}/go-live`,
      body: { confirm: true },
    },
    await steppedUp(owner.id),
  );
  return {
    live,
    adminsTestOta,
    owner,
    admin,
    adminWithMfa,
    agent,
    finance,
    viewer,
    removedAdmin,
    testOnlyOwner,
    testOnly,
    platformAdmin,
  };
}

beforeAll(async () => {
  // The database clone, the Nest module graph and the Ajv validators of the document are the expensive part;
  // SETUP_TIMEOUT_MS covers a loaded 4-CPU CI runner.
  t = await createTestApp({ overrides: [{ provide: FeatureSwitches, useValue: new AllSwitchesOn() }] });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
  arrangement = await arrange();
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await t?.close();
}, SETUP_TIMEOUT_MS);

describe("an admin without MFA of an OTA that went live through goLive", () => {
  /** What the admin and the admin with MFA were answered, at each stage, in order. */
  const seen = {
    goLive: "",
    liveEnvironment: "",
    beforeEnrolment: {} as Record<string, string>,
    beforeEnrolmentDetails: [] as Array<Record<string, unknown> | undefined>,
    otherOtaBeforeEnrolment: {} as Record<string, string>,
    getMeBefore: undefined as unknown,
    updateMeBefore: "",
    updateMeFlagBefore: undefined as unknown,
    setup: "",
    enable: "",
    recoveryCodes: 0,
    afterEnrolment: {} as Record<string, string>,
    otherOtaAfterEnrolment: {} as Record<string, string>,
    adminWithMfa: {} as Record<string, string>,
    getMeAfter: undefined as unknown,
    disableWithoutStepUp: "",
    disableWithStepUp: "",
    disableDetails: undefined as Record<string, unknown> | undefined,
    mfaAfterRefusedDisable: false,
    recoveryCodesAfterRefusedDisable: 0,
    disabledAuditRows: 0,
    reset: "",
    getMeAfterReset: undefined as unknown,
    afterReset: {} as Record<string, string>,
    afterResetDetails: undefined as Record<string, unknown> | undefined,
  };

  beforeAll(async () => {
    const { live, adminsTestOta, admin, adminWithMfa, platformAdmin } = arrangement;
    seen.goLive = outcomeOf(wentLive);
    seen.liveEnvironment = (wentLive.body as { storefrontEnvironment?: string }).storefrontEnvironment ?? "";

    // Before the enrolment: getMe and updateMe stay open and say so; every portal operation answers the enrolment.
    seen.getMeBefore = await enrolmentRequired(admin.id);
    const updated = await send(
      {
        operationId: "updateMe",
        method: "patch",
        path: "/v1/me",
        body: { fullName: "Ada Admin" },
        ifMatch: '"1"',
      },
      await portal(admin.id),
    );
    seen.updateMeBefore = outcomeOf(updated);
    seen.updateMeFlagBefore = (updated.body as { mfaEnrolmentRequired?: unknown }).mfaEnrolmentRequired;
    for (const call of portalCalls(live.id)) {
      const res = await send(call, await portal(admin.id));
      seen.beforeEnrolment[call.operationId] = outcomeOf(res);
      seen.beforeEnrolmentDetails.push(detailsOf(res));
    }
    seen.otherOtaBeforeEnrolment = await answersOf(admin.id, portalCalls(adminsTestOta.id).slice(0, 2));

    // The enrolment through the two portal_unverified operations.
    const setup = await send(
      { operationId: "startMfaSetup", method: "post", path: "/v1/me/mfa/setup" },
      await portal(admin.id),
    );
    seen.setup = outcomeOf(setup);
    const { secret } = setup.body as { secret: string };
    const enabled = await send(
      {
        operationId: "enableMfa",
        method: "post",
        path: "/v1/me/mfa/enable",
        body: { code: totpCode(secret, t.clock.now()) },
      },
      await portal(admin.id),
    );
    seen.enable = outcomeOf(enabled);
    seen.recoveryCodes = ((enabled.body as { recoveryCodes?: unknown[] }).recoveryCodes ?? []).length;

    // After it: the same answers as an admin with MFA of the same OTA.
    seen.getMeAfter = await enrolmentRequired(admin.id);
    seen.afterEnrolment = await answersOf(admin.id, portalCalls(live.id));
    seen.otherOtaAfterEnrolment = await answersOf(admin.id, portalCalls(adminsTestOta.id).slice(0, 2));
    seen.adminWithMfa = await answersOf(adminWithMfa.id, portalCalls(live.id));

    // disableMfa: the step-up first, as for anyone; then the rule, and nothing is written.
    const disable: Call = { operationId: "disableMfa", method: "post", path: "/v1/me/mfa/disable" };
    seen.disableWithoutStepUp = outcomeOf(
      await send(
        disable,
        await portal(admin.id, { amr: ["pwd", "otp"], mfa_at: nowSeconds() - STALE_STEP_UP_SECONDS }),
      ),
    );
    const refused = await send(disable, await steppedUp(admin.id));
    seen.disableWithStepUp = outcomeOf(refused);
    seen.disableDetails = detailsOf(refused);
    seen.mfaAfterRefusedDisable = (await accountRow(admin.id)).mfa_enabled;
    seen.recoveryCodesAfterRefusedDisable = await countOf(
      "SELECT count(*) AS n FROM platform.account_recovery_codes WHERE account_id = $1 AND used_at IS NULL",
      [admin.id],
    );
    seen.disabledAuditRows = await countOf(
      "SELECT count(*) AS n FROM platform.platform_audit_log WHERE action = 'account.mfa_disabled' AND target_id = $1",
      [admin.id],
    );

    // A support reset (a lost device) sends the account back to the enrolment.
    seen.reset = await supportReset(platformAdmin.id, admin.id);
    seen.getMeAfterReset = await enrolmentRequired(admin.id);
    seen.afterReset = await answersOf(admin.id, portalCalls(live.id));
    seen.afterResetDetails = detailsOf(await send(portalCalls(live.id)[0] as Call, await portal(admin.id)));
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-071 AC1] goes live through goLive with its owner's MFA and step-up", () => {
    expect([seen.goLive, seen.liveEnvironment]).toEqual(["200", "live"]);
  });

  it("[PBE-071 AC1] gets mfaEnrolmentRequired: true from getMe and updateMe, which stay open [PF-04 AC4]", () => {
    expect(seen.getMeBefore).toBe(true);
    expect([seen.updateMeBefore, seen.updateMeFlagBefore]).toEqual(["200", true]);
  });

  it("[PBE-071 AC1] answers 403 MFA_REQUIRED (enrolment_required) on getTenant, listApiKeys, createApiKey and createCustomerPortalSession, and on its own test OTA [PF-04 AC4]", () => {
    expect(seen.beforeEnrolment).toEqual({
      getTenant: "403 MFA_REQUIRED",
      listApiKeys: "403 MFA_REQUIRED",
      createApiKey: "403 MFA_REQUIRED",
      createCustomerPortalSession: "403 MFA_REQUIRED",
    });
    expect(seen.beforeEnrolmentDetails).toEqual(Array(4).fill({ reason: "enrolment_required" }));
    expect(seen.otherOtaBeforeEnrolment).toEqual({
      getTenant: "403 MFA_REQUIRED",
      listApiKeys: "403 MFA_REQUIRED",
    });
  });

  it("[PBE-071 AC1] enrols with startMfaSetup and enableMfa, and then answers as an admin with MFA does [PF-04 AC4]", () => {
    expect([seen.setup, seen.enable, seen.recoveryCodes]).toEqual(["200", "200", 10]);
    expect(seen.getMeAfter).toBe(false);
    // An admin's answers: the OTA and its keys, a new key, and the Customer Portal only for owners.
    expect(seen.adminWithMfa).toEqual({
      getTenant: "200",
      listApiKeys: "200",
      createApiKey: "201",
      createCustomerPortalSession: "403 FORBIDDEN",
    });
    expect(seen.afterEnrolment).toEqual(seen.adminWithMfa);
    expect(seen.otherOtaAfterEnrolment).toEqual({ getTenant: "200", listApiKeys: "200" });
  });

  it("[PBE-071 AC2] refuses disableMfa with 409 CONFLICT (mfa_mandatory) once the step-up has passed, and changes nothing", () => {
    expect(seen.disableWithoutStepUp).toBe("401 REAUTH_REQUIRED");
    expect([seen.disableWithStepUp, seen.disableDetails]).toEqual([
      "409 CONFLICT",
      { reason: "mfa_mandatory" },
    ]);
    expect([
      seen.mfaAfterRefusedDisable,
      seen.recoveryCodesAfterRefusedDisable,
      seen.disabledAuditRows,
    ]).toEqual([true, 10, 0]);
  });

  it("[PBE-071 AC2] meets the guard again after a support MFA reset", () => {
    expect(seen.reset).toBe("200");
    expect(seen.getMeAfterReset).toBe(true);
    expect(seen.afterReset).toEqual({
      getTenant: "403 MFA_REQUIRED",
      listApiKeys: "403 MFA_REQUIRED",
      createApiKey: "403 MFA_REQUIRED",
      createCustomerPortalSession: "403 MFA_REQUIRED",
    });
    expect(seen.afterResetDetails).toEqual({ reason: "enrolment_required" });
  });
});

describe("the members the rule leaves alone", () => {
  const seen = {
    agent: {} as Record<string, string>,
    finance: {} as Record<string, string>,
    viewer: {} as Record<string, string>,
    removedAdmin: {} as Record<string, string>,
    testOnlyOwner: {} as Record<string, string>,
    flags: {} as Record<string, unknown>,
  };

  beforeAll(async () => {
    const { live, agent, finance, viewer, removedAdmin, testOnlyOwner, testOnly } = arrangement;
    const liveCalls = portalCalls(live.id);
    seen.agent = await answersOf(agent.id, liveCalls);
    seen.finance = await answersOf(finance.id, liveCalls);
    seen.viewer = await answersOf(viewer.id, liveCalls);
    seen.removedAdmin = await answersOf(removedAdmin.id, liveCalls.slice(0, 1));
    seen.testOnlyOwner = await answersOf(testOnlyOwner.id, portalCalls(testOnly.id).slice(0, 3));
    for (const [name, account] of Object.entries({ agent, finance, viewer, removedAdmin, testOnlyOwner })) {
      seen.flags[name] = await enrolmentRequired(account.id);
    }
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-071 AC3] never refuses an agent, a finance member or a viewer of the live OTA: each answers as its role does", () => {
    expect(seen.agent).toEqual({
      getTenant: "200",
      listApiKeys: "403 FORBIDDEN",
      createApiKey: "403 FORBIDDEN",
      createCustomerPortalSession: "403 FORBIDDEN",
    });
    expect(seen.finance).toEqual(seen.agent);
    expect(seen.viewer).toEqual(seen.agent);
  });

  it("[PBE-071 AC3] never refuses the owner of a test-only OTA, nor an account whose admin membership of the live OTA was removed", () => {
    expect(seen.testOnlyOwner).toEqual({ getTenant: "200", listApiKeys: "200", createApiKey: "201" });
    // No longer a member: the OTA answers 404, not the enrolment.
    expect(seen.removedAdmin).toEqual({ getTenant: "404 NOT_FOUND" });
  });

  it("[PBE-071 AC3] answers mfaEnrolmentRequired: false for each of them", () => {
    expect(seen.flags).toEqual({
      agent: false,
      finance: false,
      viewer: false,
      removedAdmin: false,
      testOnlyOwner: false,
    });
  });
});

describe("the owner of the live OTA after a support MFA reset", () => {
  const seen = {
    flagBefore: undefined as unknown,
    reset: "",
    flagAfter: undefined as unknown,
    answers: {} as Record<string, string>,
    details: [] as Array<Record<string, unknown> | undefined>,
    listTenants: "",
  };

  beforeAll(async () => {
    const { live, owner, platformAdmin } = arrangement;
    seen.flagBefore = await enrolmentRequired(owner.id);
    seen.reset = await supportReset(platformAdmin.id, owner.id);
    seen.flagAfter = await enrolmentRequired(owner.id);
    for (const call of [portalCalls(live.id)[0], portalCalls(live.id)[3]] as Call[]) {
      const res = await send(call, await portal(owner.id));
      seen.answers[call.operationId] = outcomeOf(res);
      seen.details.push(detailsOf(res));
    }
    seen.listTenants = outcomeOf(
      await send({ operationId: "listTenants", method: "get", path: "/v1/tenants" }, await portal(owner.id)),
    );
  }, GROUP_SETUP_TIMEOUT_MS);

  it("[PBE-071 AC2] meets the guard on its reads and the owner's Customer Portal, and keeps listTenants, once support reset its MFA [PF-04 AC4]", () => {
    expect([seen.flagBefore, seen.reset, seen.flagAfter]).toEqual([false, "200", true]);
    expect(seen.answers).toEqual({
      getTenant: "403 MFA_REQUIRED",
      createCustomerPortalSession: "403 MFA_REQUIRED",
    });
    expect(seen.details).toEqual([{ reason: "enrolment_required" }, { reason: "enrolment_required" }]);
    expect(seen.listTenants).toBe("200");
  });
});
