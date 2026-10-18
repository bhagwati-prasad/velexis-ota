// getOnboarding (PBE-024; PADR-0018, scope PF-12, api-inventory §7) through the HTTP pipeline (createTestApp) on this
// file's database clone: every item of the checklist flips to done when the rows of its rule say so, with its link,
// and only the OTA's own rows that the rule names count; the M5 items appear with their switches only; the account
// items are the caller's; any member reads it, and the read is one read-only transaction that writes nothing. OTAs, accounts and the other rows are written with the builders
// (or `insertRow` for tables without one); tokens come from the application's TokenService. Every answer is checked
// against the platform document.
//
// The milestone switches are a stand-in this file turns on and off (as plans.int.test.ts does), so one application
// shows both milestones.
import { expectResponseToMatch } from "@velexis/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TokenService } from "../../../src/auth/token.service";
import { PLATFORM_POOL, type PlatformPool } from "../../../src/common/database";
import {
  FEATURE_VARIABLES,
  FeatureSwitches,
  FEATURES,
  featuresFor,
  type Feature,
  type FeatureConfig,
} from "../../../src/common/features";
import type {
  OnboardingChecklist,
  OnboardingItem,
  OnboardingItemId,
} from "../../../src/provisioning/onboarding.service";
import {
  insertAccount,
  insertPaymentConnection,
  insertRow,
  insertSubscription,
  insertSupplierConnection,
  insertTenantDomain,
  PLACEHOLDER_CIPHERTEXT,
  PLACEHOLDER_KEK_ID,
  testId,
} from "../../builders/platform-rows";
import { insertMember, insertMembership, insertOta, TEST_BASE_DOMAIN } from "../../builders/tenants";
import { createTestApp, type TestApp } from "../../support/app";

// Documentation addresses (RFC 5737) only.
const PERSON_IP = "203.0.113.7";
const DAY_MS = 24 * 60 * 60 * 1000;

const M1_ITEMS: readonly OnboardingItemId[] = [
  "email_verified",
  "mfa_enabled",
  "ota_active",
  "api_key",
  "storefront_open",
  "amadeus_test",
  "team_invited",
];
const M5_ITEMS: readonly OnboardingItemId[] = [
  "plan_chosen",
  "custom_domain",
  "payments_ready",
  "live_requested",
];

/** The milestone switches of this application: all off, as FEATURE_* default, until a test turns one on. */
class TestSwitches {
  readonly on = new Set<Feature>();

  isEnabled(feature: Feature): boolean {
    return this.on.has(feature);
  }

  features(): ReturnType<FeatureSwitches["features"]> {
    return featuresFor(
      Object.fromEntries(
        FEATURES.map((feature) => [FEATURE_VARIABLES[feature], this.on.has(feature)]),
      ) as FeatureConfig,
    );
  }
}

let t: TestApp;
let pool: PlatformPool;
let tokens: TokenService;
const switches = new TestSwitches();

/** Sequence numbers of the rows written with `insertRow` (tables without a builder). */
let rowNumber = 0;
const nextRow = (): number => {
  rowNumber += 1;
  return rowNumber;
};

beforeAll(async () => {
  // Expensive set-up, once per file: the database clone, the Nest module graph and the Ajv validators of the
  // document. 60 s covers a slow CI runner.
  t = await createTestApp({ overrides: [{ provide: FeatureSwitches, useValue: switches }] });
  pool = t.app.get<PlatformPool>(PLATFORM_POOL);
  tokens = t.app.get(TokenService);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

afterEach(() => {
  switches.on.clear();
});

/** `Authorization: Bearer` with a fresh portal token of `accountId` (e-mail verified), at the FakeClock's time. */
async function bearer(accountId: string): Promise<Record<string, string>> {
  const { token } = await tokens.sign({
    aud: "portal",
    sub: accountId,
    sid: testId("asn", 1),
    ev: true,
    amr: ["pwd"],
  });
  return { Authorization: `Bearer ${token}`, ...t.bffHeaders(PERSON_IP) };
}

const onboardingUrl = (tenantId: string): string => `/v1/tenants/${tenantId}/onboarding`;

/** The checklist `accountId` gets for `tenantId`: `200`, checked against the document. */
async function checklist(accountId: string, tenantId: string): Promise<OnboardingItem[]> {
  const res = await t.http.get(onboardingUrl(tenantId)).set(await bearer(accountId));
  expect(res.status).toBe(200);
  expectResponseToMatch("getOnboarding", res, { document: "platform" });
  return (res.body as OnboardingChecklist).items;
}

/** One item of the checklist `accountId` gets for `tenantId`. */
async function item(accountId: string, tenantId: string, id: OnboardingItemId): Promise<OnboardingItem> {
  const found = (await checklist(accountId, tenantId)).find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`the checklist has no item ${id}`);
  }
  return found;
}

/** Whether the item is done, for `accountId` in `tenantId`. */
async function done(accountId: string, tenantId: string, id: OnboardingItemId): Promise<boolean> {
  return (await item(accountId, tenantId, id)).done;
}

/** An OTA of the test and its owner. */
interface TestOta {
  readonly tenantId: string;
  readonly key: string;
  /** The owner's account: e-mail verified, no MFA. */
  readonly owner: string;
}

/** A new OTA in set-up (`provisioning`, its verified sub-domain) with its owner (verified, no MFA). */
async function otaInSetup(): Promise<TestOta> {
  const owner = await insertAccount(pool);
  const ota = await insertOta(pool, {
    tenant: { status: "provisioning", activated_at: null },
    members: [[owner, "owner"]],
  });
  return { tenantId: ota.tenant.id, key: ota.tenant.key, owner: owner.id };
}

/** A new `active` OTA (its verified sub-domain) with its owner (verified, no MFA). */
async function activeOta(): Promise<TestOta> {
  const owner = await insertAccount(pool);
  const ota = await insertOta(pool, {
    tenant: { status: "active", activated_at: t.clock.now() },
    members: [[owner, "owner"]],
  });
  return { tenantId: ota.tenant.id, key: ota.tenant.key, owner: owner.id };
}

/** Turns every milestone switch on. */
function allSwitchesOn(): void {
  for (const feature of FEATURES) {
    switches.on.add(feature);
  }
}

async function update(text: string, values: unknown[]): Promise<void> {
  const { rowCount } = await pool.query(text, values);
  expect(rowCount).toBe(1);
}

describe("getOnboarding: one rule per item", () => {
  it("[PBE-024 AC1] email_verified flips to done when the caller's accounts.email_verified_at is set", async () => {
    // The route needs a token with `ev = true`, so a real caller sees this item done; the rule reads the column, which
    // this account has not set although its token says so.
    const { tenantId } = await otaInSetup();
    const unverified = await insertAccount(pool, { email_verified_at: null });
    await insertMember(pool, { id: tenantId }, unverified, "admin");

    const before = await item(unverified.id, tenantId, "email_verified");
    await update("UPDATE platform.accounts SET email_verified_at = $2 WHERE id = $1", [
      unverified.id,
      t.clock.now(),
    ]);
    const after = await item(unverified.id, tenantId, "email_verified");

    expect(before).toEqual({
      id: "email_verified",
      label: "Verify your e-mail",
      done: false,
      href: "/verify-pending",
      milestone: "M1",
    });
    expect(after).toEqual({ ...before, done: true });
  });

  it("[PBE-024 AC1] mfa_enabled flips to done when the caller's accounts.mfa_enabled is true", async () => {
    const { tenantId, owner } = await otaInSetup();

    const before = await item(owner, tenantId, "mfa_enabled");
    await update("UPDATE platform.accounts SET mfa_enabled = true, mfa_enabled_at = $2 WHERE id = $1", [
      owner,
      t.clock.now(),
    ]);
    const after = await item(owner, tenantId, "mfa_enabled");

    expect(before).toEqual({
      id: "mfa_enabled",
      label: "Turn on two-factor sign-in",
      done: false,
      href: "/account/security",
      milestone: "M1",
    });
    expect(after.done).toBe(true);
  });

  it("[PBE-024 AC1] ota_active flips to done when the tenant becomes active, and only while it is", async () => {
    const { tenantId, owner } = await otaInSetup();

    const before = await item(owner, tenantId, "ota_active");
    await update("UPDATE platform.tenants SET status = 'active', activated_at = $2 WHERE id = $1", [
      tenantId,
      t.clock.now(),
    ]);
    const active = await done(owner, tenantId, "ota_active");
    await update(
      "UPDATE platform.tenants SET status = 'suspended', suspension_reason = 'admin', suspended_at = $2 WHERE id = $1",
      [tenantId, t.clock.now()],
    );
    const suspended = await done(owner, tenantId, "ota_active");

    expect(before).toEqual({
      id: "ota_active",
      label: "OTA set up",
      done: false,
      href: `/otas/${tenantId}/setup`,
      milestone: "M1",
    });
    expect([active, suspended]).toEqual([true, false]);
  });

  it("[PBE-024 AC1] api_key flips to done when the initial keys are revealed", async () => {
    const { tenantId, owner } = await activeOta();
    // What provisioning leaves: the two initial keys without a creator, and the job holding them for one reveal.
    for (const kind of ["publishable", "secret"] as const) {
      const n = nextRow();
      await insertRow(pool, "api_keys", {
        id: testId("key", n),
        tenant_id: tenantId,
        name: `Initial test key (${kind})`,
        kind,
        environment: "test",
        prefix: `${kind === "publishable" ? "pk" : "sk"}_test_${String(n).padStart(6, "0")}`,
        key_hash: n.toString(16).padStart(64, "0"),
        last4: "Ab12",
        scopes: kind === "secret" ? ["storefront"] : [],
      });
    }
    const jobId = testId("job", nextRow());
    await insertRow(pool, "provisioning_jobs", {
      id: jobId,
      tenant_id: tenantId,
      kind: "provision",
      status: "succeeded",
      attempt: 1,
      finished_at: t.clock.now(),
      reveal_ciphertext: Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8"),
      reveal_encryption_key_id: PLACEHOLDER_KEK_ID,
    });

    const before = await item(owner, tenantId, "api_key");
    await update(
      "UPDATE platform.provisioning_jobs SET revealed_at = $2, revealed_by_account_id = $3, " +
        "reveal_ciphertext = NULL, reveal_encryption_key_id = NULL WHERE id = $1",
      [jobId, t.clock.now(), owner],
    );
    const after = await done(owner, tenantId, "api_key");

    expect(before).toEqual({
      id: "api_key",
      label: "Get your API keys",
      done: false,
      href: `/otas/${tenantId}/api-keys`,
      milestone: "M1",
    });
    expect(after).toBe(true);
  });

  it("[PBE-024 AC1] api_key flips to done when a member creates a key", async () => {
    const { tenantId, owner } = await activeOta();

    const before = await done(owner, tenantId, "api_key");
    const n = nextRow();
    await insertRow(pool, "api_keys", {
      id: testId("key", n),
      tenant_id: tenantId,
      name: "Storefront",
      kind: "publishable",
      environment: "test",
      prefix: `pk_test_${String(n).padStart(6, "0")}`,
      key_hash: n.toString(16).padStart(64, "0"),
      last4: "Cd34",
      created_by_account_id: owner,
    });
    const after = await done(owner, tenantId, "api_key");

    expect([before, after]).toEqual([false, true]);
  });

  it("[PBE-024 AC1] storefront_open flips to done when the tenant becomes active, linking the primary host", async () => {
    const { tenantId, key, owner } = await otaInSetup();

    const before = await item(owner, tenantId, "storefront_open");
    await update("UPDATE platform.tenants SET status = 'active', activated_at = $2 WHERE id = $1", [
      tenantId,
      t.clock.now(),
    ]);
    const after = await item(owner, tenantId, "storefront_open");
    // A verified custom domain made primary moves the link.
    await update(
      "UPDATE platform.tenant_domains SET is_primary = false WHERE tenant_id = $1 AND kind = 'subdomain'",
      [tenantId],
    );
    await insertTenantDomain(
      pool,
      { id: tenantId },
      {
        hostname: `travel.${key}.example`,
        kind: "custom",
        verification_token: `velexis-verify-${key}`,
        is_primary: true,
      },
    );
    const custom = await item(owner, tenantId, "storefront_open");

    expect(before).toEqual({
      id: "storefront_open",
      label: "Open your storefront",
      done: false,
      href: `https://${key}.${TEST_BASE_DOMAIN}/`,
      milestone: "M1",
    });
    expect(after).toEqual({ ...before, done: true });
    expect(custom).toEqual({ ...after, href: `https://travel.${key}.example/` });
  });

  it("[PBE-024 AC1] amadeus_test flips to done when the test supplier connection becomes active", async () => {
    const { tenantId, owner } = await activeOta();
    const connection = await insertSupplierConnection(pool, { id: tenantId });
    // A live connection, even an active one, is not the test office.
    await insertSupplierConnection(pool, { id: tenantId }, { environment: "live", status: "active" });

    const before = await item(owner, tenantId, "amadeus_test");
    await update("UPDATE platform.supplier_connections SET status = 'active' WHERE id = $1", [connection.id]);
    const after = await done(owner, tenantId, "amadeus_test");

    expect(connection.status).toBe("pending_verification");
    expect(before).toEqual({
      id: "amadeus_test",
      label: "Amadeus test office active",
      done: false,
      href: `/otas/${tenantId}/amadeus`,
      milestone: "M1",
    });
    expect(after).toBe(true);
  });

  /** An invitation of `tenantId` in `status`. */
  async function invite(tenantId: string, status: string): Promise<string> {
    const n = nextRow();
    const row = await insertRow(pool, "tenant_invitations", {
      id: testId("ivt", n),
      tenant_id: tenantId,
      email: `invitee${n}@example.com`,
      role: "agent",
      token_hash: n.toString(16).padStart(64, "0"),
      status,
      expires_at: new Date(t.clock.now().getTime() + 7 * DAY_MS),
      ...(status === "revoked" ? { revoked_at: t.clock.now() } : {}),
    });
    return row.id;
  }

  it("[PBE-024 AC1] team_invited flips to done with an invitation that is not revoked", async () => {
    const { tenantId, owner } = await activeOta();
    await invite(tenantId, "revoked");
    await insertMembership(pool, { id: tenantId }, await insertAccount(pool), {
      role: "agent",
      status: "removed",
    });

    const before = await item(owner, tenantId, "team_invited");
    await invite(tenantId, "pending");
    const after = await done(owner, tenantId, "team_invited");

    expect(before).toEqual({
      id: "team_invited",
      label: "Invite your team",
      done: false,
      href: `/otas/${tenantId}/team`,
      milestone: "M1",
    });
    expect(after).toBe(true);

    // Accepted and expired invitations count as well.
    for (const status of ["accepted", "expired"]) {
      const other = await activeOta();
      await invite(other.tenantId, status);
      expect(await done(other.owner, other.tenantId, "team_invited"), status).toBe(true);
    }
  });

  it("[PBE-024 AC1] team_invited flips to done with a second active member", async () => {
    const { tenantId, owner } = await activeOta();

    const before = await done(owner, tenantId, "team_invited");
    await insertMember(pool, { id: tenantId }, await insertAccount(pool), "finance");
    const after = await done(owner, tenantId, "team_invited");

    expect([before, after]).toEqual([false, true]);
  });

  it("[PBE-024 AC1] plan_chosen flips to done when the current subscription is a trialing or active Stripe one", async () => {
    switches.on.add("stripe_billing");
    const { tenantId, owner } = await activeOta();
    const subscription = await insertSubscription(pool, { id: tenantId });

    const manual = await item(owner, tenantId, "plan_chosen");
    await update(
      "UPDATE platform.subscriptions SET billing_provider = 'stripe', status = 'incomplete' WHERE id = $1",
      [subscription.id],
    );
    const incomplete = await done(owner, tenantId, "plan_chosen");
    await update("UPDATE platform.subscriptions SET status = 'trialing' WHERE id = $1", [subscription.id]);
    const trialing = await done(owner, tenantId, "plan_chosen");
    await update("UPDATE platform.subscriptions SET status = 'active' WHERE id = $1", [subscription.id]);
    const active = await done(owner, tenantId, "plan_chosen");

    expect(subscription.billing_provider).toBe("manual");
    expect(manual).toEqual({
      id: "plan_chosen",
      label: "Choose a plan",
      done: false,
      href: `/otas/${tenantId}/billing`,
      milestone: "M5",
    });
    expect([incomplete, trialing, active]).toEqual([false, true, true]);
  });

  it("[PBE-024 AC1] custom_domain flips to done when a custom storefront domain is verified", async () => {
    switches.on.add("custom_domains");
    const { tenantId, key, owner } = await activeOta();
    const domain = await insertTenantDomain(
      pool,
      { id: tenantId },
      {
        hostname: `shop.${key}.example`,
        kind: "custom",
        verification_status: "pending",
        verified_at: null,
        verification_token: `velexis-verify-${key}`,
      },
    );

    // The verified sub-domain alone is no custom domain.
    const before = await item(owner, tenantId, "custom_domain");
    await update(
      "UPDATE platform.tenant_domains SET verification_status = 'verified', verified_at = $2 WHERE id = $1",
      [domain.id, t.clock.now()],
    );
    const after = await done(owner, tenantId, "custom_domain");

    expect(before).toEqual({
      id: "custom_domain",
      label: "Connect your domain",
      done: false,
      href: `/otas/${tenantId}/domains`,
      milestone: "M5",
    });
    expect(after).toBe(true);
  });

  it("[PBE-024 AC1] payments_ready flips to done when the payout account of the velexis mode is verified", async () => {
    switches.on.add("settlements");
    const { tenantId, owner } = await activeOta();
    await insertPaymentConnection(pool, { id: tenantId });

    const noPayout = await item(owner, tenantId, "payments_ready");
    await insertRow(pool, "tenant_payout_accounts", {
      tenant_id: tenantId,
      account_holder_name: "Acme Travel SARL",
      country_code: "FR",
      currency: "EUR",
      scheme: "iban",
      bank_details_ciphertext: Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8"),
      encryption_key_id: PLACEHOLDER_KEK_ID,
      last4: "0189",
    });
    const pendingReview = await done(owner, tenantId, "payments_ready");
    await update(
      "UPDATE platform.tenant_payout_accounts SET status = 'verified', reviewed_at = $2 WHERE tenant_id = $1",
      [tenantId, t.clock.now()],
    );
    const verified = await done(owner, tenantId, "payments_ready");

    expect(noPayout).toEqual({
      id: "payments_ready",
      label: "Set up payouts or your own Stripe",
      done: false,
      href: `/otas/${tenantId}/payments`,
      milestone: "M5",
    });
    expect([pendingReview, verified]).toEqual([false, true]);
  });

  it("[PBE-024 AC1] payments_ready flips to done when the OTA's own Stripe connection becomes active", async () => {
    switches.on.add("own_stripe");
    const { tenantId, owner } = await activeOta();
    const connection = await insertPaymentConnection(
      pool,
      { id: tenantId },
      {
        account_mode: "connect_standard",
        account_reference: "acct_1TestOnboarding",
        status: "pending",
        statement_descriptor_suffix: null,
      },
    );

    const before = await done(owner, tenantId, "payments_ready");
    await update("UPDATE platform.payment_provider_connections SET status = 'active' WHERE id = $1", [
      connection.id,
    ]);
    const after = await done(owner, tenantId, "payments_ready");

    expect([before, after]).toEqual([false, true]);
  });

  it("[PBE-024 AC1] live_requested flips to done when a live supplier connection exists", async () => {
    switches.on.add("live_switch");
    const { tenantId, owner } = await activeOta();

    const before = await item(owner, tenantId, "live_requested");
    // Any status: requesting live credentials is the step, not their verification.
    await insertSupplierConnection(pool, { id: tenantId }, { environment: "live" });
    const after = await done(owner, tenantId, "live_requested");

    expect(before).toEqual({
      id: "live_requested",
      label: "Go live",
      done: false,
      href: `/otas/${tenantId}/go-live`,
      milestone: "M5",
    });
    expect(after).toBe(true);
  });

  it("[PBE-024 AC1] live_requested flips to done when the storefront is switched to live", async () => {
    switches.on.add("live_switch");
    const { tenantId, owner } = await activeOta();

    const before = await done(owner, tenantId, "live_requested");
    await update(
      "UPDATE platform.tenants SET storefront_environment = 'live', live_enabled_at = $2, " +
        "live_enabled_by_account_id = $3 WHERE id = $1",
      [tenantId, t.clock.now(), owner],
    );
    const after = await done(owner, tenantId, "live_requested");

    expect([before, after]).toEqual([false, true]);
  });

  it("[PBE-024 AC1] gives every item a link, in the order of PADR-0018", async () => {
    allSwitchesOn();
    const { tenantId, owner } = await otaInSetup();

    const items = await checklist(owner, tenantId);

    expect(items.map((entry) => entry.id)).toEqual([...M1_ITEMS, ...M5_ITEMS]);
    for (const entry of items) {
      expect(entry.href, entry.id).toMatch(/^(\/|https:\/\/)\S+$/);
    }
  });

  it("[PBE-024 AC1] counts only the OTA's own rows, and of each rule only the rows it names", async () => {
    allSwitchesOn();
    // A neighbour OTA whose rows make every item done.
    const neighbour = await activeOta();
    const neighbourRef = { id: neighbour.tenantId };
    await update("UPDATE platform.accounts SET mfa_enabled = true, mfa_enabled_at = $2 WHERE id = $1", [
      neighbour.owner,
      t.clock.now(),
    ]);
    const keyRow = nextRow();
    await insertRow(pool, "api_keys", {
      id: testId("key", keyRow),
      tenant_id: neighbour.tenantId,
      name: "Storefront",
      kind: "publishable",
      environment: "test",
      prefix: `pk_test_${String(keyRow).padStart(6, "0")}`,
      key_hash: keyRow.toString(16).padStart(64, "0"),
      last4: "Ef56",
      created_by_account_id: neighbour.owner,
    });
    await insertRow(pool, "provisioning_jobs", {
      id: testId("job", nextRow()),
      tenant_id: neighbour.tenantId,
      kind: "provision",
      status: "succeeded",
      attempt: 1,
      finished_at: t.clock.now(),
      revealed_at: t.clock.now(),
      revealed_by_account_id: neighbour.owner,
    });
    await insertSupplierConnection(pool, neighbourRef, { status: "active" });
    await insertSupplierConnection(pool, neighbourRef, { environment: "live" });
    await invite(neighbour.tenantId, "pending");
    await insertMember(pool, neighbourRef, await insertAccount(pool), "agent");
    await insertSubscription(pool, neighbourRef, { billing_provider: "stripe", status: "active" });
    await insertTenantDomain(pool, neighbourRef, {
      hostname: `shop.${neighbour.key}.example`,
      kind: "custom",
      verification_token: `velexis-verify-${neighbour.key}`,
    });
    await insertPaymentConnection(pool, neighbourRef);
    await insertRow(pool, "tenant_payout_accounts", {
      tenant_id: neighbour.tenantId,
      account_holder_name: "Neighbour Travel SARL",
      country_code: "FR",
      currency: "EUR",
      scheme: "iban",
      bank_details_ciphertext: Buffer.from(PLACEHOLDER_CIPHERTEXT, "utf8"),
      encryption_key_id: PLACEHOLDER_KEK_ID,
      last4: "4321",
      status: "verified",
      reviewed_at: t.clock.now(),
    });

    // An OTA in set-up whose rows each miss a rule by one column: a `test` supplier connection that is not active (and
    // is no live one), a revoked invitation and a removed member, a manual subscription, a verified custom domain for
    // the API (not the storefront), and an active Connect Standard payment connection in `live` (not `test`).
    const subject = await otaInSetup();
    const subjectRef = { id: subject.tenantId };
    await insertSupplierConnection(pool, subjectRef);
    await invite(subject.tenantId, "revoked");
    await insertMembership(pool, subjectRef, await insertAccount(pool), { role: "agent", status: "removed" });
    await insertSubscription(pool, subjectRef);
    await insertTenantDomain(pool, subjectRef, {
      hostname: `api.${subject.key}.example`,
      kind: "custom",
      purpose: "api",
      verification_token: `velexis-verify-${subject.key}`,
    });
    await insertPaymentConnection(pool, subjectRef, {
      environment: "live",
      account_mode: "connect_standard",
      account_reference: "acct_1OnboardingLiveOnly",
      status: "active",
      statement_descriptor_suffix: null,
    });
    // An OTA in the velexis mode without a payout account of its own.
    const velexisMode = await activeOta();
    await insertPaymentConnection(pool, { id: velexisMode.tenantId });

    const neighbourItems = await checklist(neighbour.owner, neighbour.tenantId);
    const subjectItems = await checklist(subject.owner, subject.tenantId);
    const velexisModeItems = await checklist(velexisMode.owner, velexisMode.tenantId);

    expect(neighbourItems.filter((entry) => !entry.done).map((entry) => entry.id)).toEqual([]);
    expect(subjectItems.filter((entry) => entry.done).map((entry) => entry.id)).toEqual(["email_verified"]);
    expect(subjectItems.find((entry) => entry.id === "storefront_open")?.href).toBe(
      `https://${subject.key}.${TEST_BASE_DOMAIN}/`,
    );
    expect(velexisModeItems.find((entry) => entry.id === "payments_ready")?.done).toBe(false);
  });
});

describe("getOnboarding: milestones, callers and reads", () => {
  it("[PBE-024 AC2] lists only the seven M1 items with every switch off, and eleven with every switch on", async () => {
    const { tenantId, owner } = await otaInSetup();

    const off = await checklist(owner, tenantId);
    allSwitchesOn();
    const on = await checklist(owner, tenantId);

    expect(off.map((entry) => [entry.id, entry.milestone])).toEqual(M1_ITEMS.map((id) => [id, "M1"]));
    expect(on.map((entry) => entry.id)).toEqual([...M1_ITEMS, ...M5_ITEMS]);
    expect(on.slice(M1_ITEMS.length).every((entry) => entry.milestone === "M5")).toBe(true);
  });

  it("[PBE-024 AC2] shows each M5 item with its own switch, payments with own Stripe or settlements", async () => {
    const { tenantId, owner } = await otaInSetup();
    const shown: Array<[Feature, OnboardingItemId[]]> = [];

    for (const feature of FEATURES) {
      switches.on.clear();
      switches.on.add(feature);
      const ids = (await checklist(owner, tenantId)).map((entry) => entry.id);
      expect(ids.slice(0, M1_ITEMS.length), feature).toEqual(M1_ITEMS);
      shown.push([feature, ids.slice(M1_ITEMS.length)]);
    }

    expect(shown).toEqual([
      ["stripe_billing", ["plan_chosen"]],
      ["own_stripe", ["payments_ready"]],
      ["settlements", ["payments_ready"]],
      ["own_amadeus", []],
      ["custom_domains", ["custom_domain"]],
      ["live_switch", ["live_requested"]],
    ]);
  });

  it("computes the account items for the caller", async () => {
    const { tenantId, owner } = await activeOta();
    const viewer = await insertAccount(pool, { mfa_enabled: true, mfa_enabled_at: t.clock.now() });
    await insertMember(pool, { id: tenantId }, viewer, "viewer");

    const forOwner = await checklist(owner, tenantId);
    const forViewer = await checklist(viewer.id, tenantId);

    const mfa = (items: OnboardingItem[]) => items.find((entry) => entry.id === "mfa_enabled")?.done;
    expect([mfa(forOwner), mfa(forViewer)]).toEqual([false, true]);
    // The OTA's items are the same for both.
    const ota = (items: OnboardingItem[]) => items.filter((entry) => entry.id !== "mfa_enabled");
    expect(ota(forViewer)).toEqual(ota(forOwner));
  });

  it("answers any member, 404 to strangers and removed members, and 401 without a token", async () => {
    const { tenantId } = await otaInSetup();
    const members = [];
    for (const role of ["admin", "agent", "finance", "viewer"] as const) {
      const account = await insertAccount(pool);
      await insertMember(pool, { id: tenantId }, account, role);
      members.push(account.id);
    }
    const stranger = await insertAccount(pool);
    const removed = await insertAccount(pool);
    await insertMembership(pool, { id: tenantId }, removed, { role: "owner", status: "removed" });

    for (const member of members) {
      expect((await checklist(member, tenantId)).length).toBe(M1_ITEMS.length);
    }
    for (const outsider of [stranger.id, removed.id]) {
      const res = await t.http.get(onboardingUrl(tenantId)).set(await bearer(outsider));
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: { code: "NOT_FOUND" } });
      expectResponseToMatch("getOnboarding", res, { document: "platform" });
    }
    const anonymous = await t.http.get(onboardingUrl(tenantId)).set(t.bffHeaders(PERSON_IP));
    expect(anonymous.status).toBe(401);
    expectResponseToMatch("getOnboarding", anonymous, { document: "platform" });
  });

  it("reads in one read-only transaction and writes nothing", async () => {
    allSwitchesOn();
    const { tenantId, owner } = await otaInSetup();
    // Every statement the application sends while the request runs: each client the pool hands out is wrapped once.
    const statements: string[] = [];
    let recording = false;
    const wrapped = new WeakSet<object>();
    const wrap = (client: { query: (...args: unknown[]) => unknown }): void => {
      if (wrapped.has(client)) {
        return;
      }
      wrapped.add(client);
      const query = client.query.bind(client);
      client.query = (...args: unknown[]) => {
        const [text] = args;
        if (recording) {
          statements.push(typeof text === "string" ? text : String((text as { text?: unknown }).text));
        }
        return query(...args);
      };
    };
    const onAcquire = (client: object): void => wrap(client as { query: (...args: unknown[]) => unknown });
    pool.on("acquire", onAcquire);
    const before = await pool.query(
      "SELECT version, updated_at FROM platform.tenants WHERE id = $1 UNION ALL " +
        "SELECT version, updated_at FROM platform.accounts WHERE id = $2",
      [tenantId, owner],
    );
    try {
      recording = true;
      await checklist(owner, tenantId);
    } finally {
      recording = false;
      pool.off("acquire", onAcquire);
    }
    const after = await pool.query(
      "SELECT version, updated_at FROM platform.tenants WHERE id = $1 UNION ALL " +
        "SELECT version, updated_at FROM platform.accounts WHERE id = $2",
      [tenantId, owner],
    );

    const start = statements.indexOf("start transaction read only");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(statements.slice(start + 1)).toEqual([expect.stringMatching(/^select\b/i), "commit"]);
    expect(statements.filter((text) => /^\s*(begin|start transaction)\b/i.test(text))).toEqual([
      "start transaction read only",
    ]);
    expect(statements.filter((text) => /^\s*(insert|update|delete|merge|truncate)\b/i.test(text))).toEqual(
      [],
    );
    expect(after.rows).toEqual(before.rows);
  });
});
