// The onboarding checklist without a database (PBE-024; PADR-0018, scope PF-12): the rule of every item, its link, the
// order, the M5 items behind their switches (PADR-0015), and OnboardingService's read through OnboardingRepository: one
// statement in one read-only transaction, mapped to the facts.
//
// `onboardingChecklist` is pure, so most tests change one fact of an OTA where nothing is done yet and look at which
// items are done. OnboardingService and its repository run on Kysely over a stand-in `pg` pool that records every
// statement and answers the facts' row, so the test sees exactly what the service sends to PostgreSQL.
// test/integration/provisioning/onboarding.int.test.ts runs the same rules through HTTP and PostgreSQL rows.
import type { ConfigService } from "@nestjs/config";
import { createPlatformDb } from "@velexis/db";
import { isAppError } from "@velexis/errors";
import { describe, expect, it } from "vitest";
import type { TenantMembership } from "../common/auth/tenant-role.guard";
import { FEATURES, type Feature, type FeatureSwitches } from "../common/features";
import type { PlatformBackendConfig } from "../config";
import { OnboardingRepository } from "./onboarding.repository";
import {
  ONBOARDING_ITEMS,
  onboardingChecklist,
  OnboardingService,
  type OnboardingFacts,
  type OnboardingItemId,
} from "./onboarding.service";

const TENANT = "ten_01JA2ZA1C5E9G3J7K2M6P00001";
const ACCOUNT = "acc_01JA2ZA1C5E9G3J7K2M6P00001";
const BASE_DOMAIN = "ota.example.com";

/** The seven M1 items, then the four M5 items, as PADR-0018 orders them. */
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

/** An OTA being set up, whose only member has done nothing yet. */
const NOTHING_DONE: OnboardingFacts = Object.freeze({
  emailVerified: false,
  mfaEnabled: false,
  tenantStatus: "provisioning",
  storefrontEnvironment: "test",
  primaryHost: "acme.ota.example.com",
  initialKeysRevealed: false,
  apiKeyCreatedByAccount: false,
  amadeusTestActive: false,
  invitationNotRevoked: false,
  activeMembers: 1,
  stripeSubscriptionCurrent: false,
  customDomainVerified: false,
  testPaymentConnection: null,
  payoutAccountVerified: false,
  amadeusLiveExists: false,
});

const allOn = (): boolean => true;
const allOff = (): boolean => false;
const only =
  (...on: Feature[]) =>
  (feature: Feature): boolean =>
    on.includes(feature);

/** The ids of the items that are done for `facts`, with every switch on. */
function doneIds(facts: Partial<OnboardingFacts>): OnboardingItemId[] {
  return onboardingChecklist(TENANT, { ...NOTHING_DONE, ...facts }, allOn)
    .items.filter((item) => item.done)
    .map((item) => item.id);
}

/** One item's rule: the changes that make it done (with the other items they also make done) and some that do not. */
interface ItemCase {
  readonly id: OnboardingItemId;
  readonly becomesDone: ReadonlyArray<{
    readonly change: Partial<OnboardingFacts>;
    readonly alsoDone?: readonly OnboardingItemId[];
  }>;
  readonly staysOpen: ReadonlyArray<Partial<OnboardingFacts>>;
}

const ITEM_CASES: readonly ItemCase[] = [
  {
    id: "email_verified",
    becomesDone: [{ change: { emailVerified: true } }],
    staysOpen: [{ mfaEnabled: true }],
  },
  {
    id: "mfa_enabled",
    becomesDone: [{ change: { mfaEnabled: true } }],
    staysOpen: [{ emailVerified: true }],
  },
  {
    id: "ota_active",
    becomesDone: [{ change: { tenantStatus: "active" }, alsoDone: ["storefront_open"] }],
    staysOpen: [{ tenantStatus: "provisioning" }, { tenantStatus: "suspended" }, { tenantStatus: "failed" }],
  },
  {
    id: "api_key",
    becomesDone: [{ change: { initialKeysRevealed: true } }, { change: { apiKeyCreatedByAccount: true } }],
    staysOpen: [{ tenantStatus: "active" }],
  },
  {
    id: "storefront_open",
    becomesDone: [{ change: { tenantStatus: "active" }, alsoDone: ["ota_active"] }],
    staysOpen: [{ tenantStatus: "suspended" }, { storefrontEnvironment: "live", amadeusLiveExists: false }],
  },
  {
    id: "amadeus_test",
    becomesDone: [{ change: { amadeusTestActive: true } }],
    staysOpen: [{ amadeusLiveExists: true }],
  },
  {
    id: "team_invited",
    becomesDone: [
      { change: { invitationNotRevoked: true } },
      { change: { activeMembers: 2 } },
      { change: { activeMembers: 5, invitationNotRevoked: true } },
    ],
    staysOpen: [{ activeMembers: 1 }, { activeMembers: 0 }],
  },
  {
    id: "plan_chosen",
    becomesDone: [{ change: { stripeSubscriptionCurrent: true } }],
    staysOpen: [{ tenantStatus: "active" }],
  },
  {
    id: "custom_domain",
    becomesDone: [{ change: { customDomainVerified: true } }],
    staysOpen: [{ primaryHost: "travel.acme.example" }],
  },
  {
    id: "payments_ready",
    becomesDone: [
      { change: { testPaymentConnection: { accountMode: "connect_standard", status: "active" } } },
      { change: { testPaymentConnection: { accountMode: "api_keys", status: "active" } } },
      {
        change: {
          testPaymentConnection: { accountMode: "velexis", status: "active" },
          payoutAccountVerified: true,
        },
      },
    ],
    staysOpen: [
      { testPaymentConnection: { accountMode: "velexis", status: "active" } },
      { testPaymentConnection: { accountMode: "connect_standard", status: "pending" } },
      { testPaymentConnection: { accountMode: "api_keys", status: "error" } },
      {
        testPaymentConnection: { accountMode: "connect_standard", status: "disabled" },
        payoutAccountVerified: true,
      },
      { testPaymentConnection: null, payoutAccountVerified: true },
    ],
  },
  {
    id: "live_requested",
    becomesDone: [{ change: { amadeusLiveExists: true } }, { change: { storefrontEnvironment: "live" } }],
    staysOpen: [{ amadeusTestActive: true }],
  },
];

describe("onboardingChecklist", () => {
  it("covers every item of PADR-0018 with one case", () => {
    expect(ITEM_CASES.map((item) => item.id)).toEqual([...M1_ITEMS, ...M5_ITEMS]);
    expect(doneIds({})).toEqual([]);
  });

  it.each(ITEM_CASES)(
    "[PBE-024 AC1] $id flips to done when its rule becomes true, and only then",
    ({ id, becomesDone, staysOpen }) => {
      expect(doneIds({})).not.toContain(id);
      for (const facts of staysOpen) {
        expect(doneIds(facts), JSON.stringify(facts)).not.toContain(id);
      }
      for (const { change, alsoDone = [] } of becomesDone) {
        expect(doneIds(change), JSON.stringify(change)).toEqual(
          [...M1_ITEMS, ...M5_ITEMS].filter((item) => item === id || alsoDone.includes(item)),
        );
      }
    },
  );

  it("[PBE-024 AC1] gives every item the link of PADR-0018, the storefront's on its primary host", () => {
    const { items } = onboardingChecklist(TENANT, NOTHING_DONE, allOn);
    expect(items.map(({ id, href }) => [id, href])).toEqual([
      ["email_verified", "/verify-pending"],
      ["mfa_enabled", "/account/security"],
      ["ota_active", `/otas/${TENANT}/setup`],
      ["api_key", `/otas/${TENANT}/api-keys`],
      ["storefront_open", "https://acme.ota.example.com/"],
      ["amadeus_test", `/otas/${TENANT}/amadeus`],
      ["team_invited", `/otas/${TENANT}/team`],
      ["plan_chosen", `/otas/${TENANT}/billing`],
      ["custom_domain", `/otas/${TENANT}/domains`],
      ["payments_ready", `/otas/${TENANT}/payments`],
      ["live_requested", `/otas/${TENANT}/go-live`],
    ]);
    for (const item of items) {
      expect(item.href.length, item.id).toBeGreaterThan(0);
    }
    const custom = onboardingChecklist(
      TENANT,
      { ...NOTHING_DONE, primaryHost: "travel.acme.example" },
      allOn,
    );
    expect(custom.items.find((item) => item.id === "storefront_open")?.href).toBe(
      "https://travel.acme.example/",
    );
  });

  it("labels the items as PADR-0018 does, with their milestones", () => {
    const { items } = onboardingChecklist(TENANT, NOTHING_DONE, allOn);
    expect(items.map(({ id, label, milestone }) => [id, label, milestone])).toEqual([
      ["email_verified", "Verify your e-mail", "M1"],
      ["mfa_enabled", "Turn on two-factor sign-in", "M1"],
      ["ota_active", "OTA set up", "M1"],
      ["api_key", "Get your API keys", "M1"],
      ["storefront_open", "Open your storefront", "M1"],
      ["amadeus_test", "Amadeus test office active", "M1"],
      ["team_invited", "Invite your team", "M1"],
      ["plan_chosen", "Choose a plan", "M5"],
      ["custom_domain", "Connect your domain", "M5"],
      ["payments_ready", "Set up payouts or your own Stripe", "M5"],
      ["live_requested", "Go live", "M5"],
    ]);
  });

  it("[PBE-024 AC2] lists only the seven M1 items with every switch off, and all eleven with every switch on", () => {
    const off = onboardingChecklist(TENANT, NOTHING_DONE, allOff).items;
    const on = onboardingChecklist(TENANT, NOTHING_DONE, allOn).items;

    expect(off.map((item) => item.id)).toEqual(M1_ITEMS);
    expect(off.every((item) => item.milestone === "M1")).toBe(true);
    expect(on.map((item) => item.id)).toEqual([...M1_ITEMS, ...M5_ITEMS]);
    expect(on.slice(7).every((item) => item.milestone === "M5")).toBe(true);
  });

  it("[PBE-024 AC2] shows each M5 item with its own switch: payments with either own Stripe or settlements", () => {
    const shown = (isEnabled: (feature: Feature) => boolean): OnboardingItemId[] =>
      onboardingChecklist(TENANT, NOTHING_DONE, isEnabled)
        .items.map((item) => item.id)
        .filter((id) => M5_ITEMS.includes(id));

    expect(shown(only("stripe_billing"))).toEqual(["plan_chosen"]);
    expect(shown(only("custom_domains"))).toEqual(["custom_domain"]);
    expect(shown(only("own_stripe"))).toEqual(["payments_ready"]);
    expect(shown(only("settlements"))).toEqual(["payments_ready"]);
    expect(shown(only("live_switch"))).toEqual(["live_requested"]);
    expect(shown(only("own_amadeus"))).toEqual([]);
    // Every switch of PADR-0015 is accounted for: own Amadeus credentials have no item of their own.
    expect(new Set(ONBOARDING_ITEMS.flatMap((item) => item.switches))).toEqual(
      new Set(FEATURES.filter((feature) => feature !== "own_amadeus")),
    );
  });
});

// ---- OnboardingService ----------------------------------------------------------------------------------------

/** The row the facts statement answers, as the Velexis pool reads it (bigint counts as strings). */
type FactsRow = Record<string, unknown>;

const FACTS_ROW: FactsRow = {
  key: "acme",
  status: "active",
  storefront_environment: "test",
  primary_host: null,
  email_verified_at: new Date("2026-10-01T09:00:00Z"),
  mfa_enabled: false,
  test_payment_mode: "velexis",
  test_payment_status: "active",
  initial_keys_revealed: false,
  api_key_created_by_account: true,
  amadeus_test_active: true,
  amadeus_live_exists: false,
  invitation_not_revoked: false,
  active_members: "3",
  stripe_subscription_current: false,
  custom_domain_verified: false,
  payout_account_verified: true,
};

/**
 * A stand-in `pg` pool for Kysely: every statement is recorded; the SELECT answers `rows`, transaction control and
 * anything else answers nothing.
 */
function recordingPool(rows: readonly FactsRow[]): { pool: unknown; statements: string[] } {
  const statements: string[] = [];
  const client = {
    query: (text: string): Promise<{ command: string; rowCount: number; rows: readonly FactsRow[] }> => {
      statements.push(text);
      const select = /^select\b/i.test(text);
      return Promise.resolve({
        command: select ? "SELECT" : (text.split(" ", 1)[0]?.toUpperCase() ?? ""),
        rowCount: select ? rows.length : 0,
        rows: select ? rows : [],
      });
    },
    release: (): void => undefined,
  };
  return { pool: { connect: () => Promise.resolve(client) }, statements };
}

function service(rows: readonly FactsRow[], on: readonly Feature[] = []) {
  const { pool, statements } = recordingPool(rows);
  const db = createPlatformDb(pool as Parameters<typeof createPlatformDb>[0]);
  const switches = { isEnabled: (feature: Feature) => on.includes(feature) } as unknown as FeatureSwitches;
  const config = {
    get: (name: string) => (name === "STOREFRONT_BASE_DOMAIN" ? BASE_DOMAIN : undefined),
  } as unknown as ConfigService<PlatformBackendConfig, true>;
  return { onboarding: new OnboardingService(db, new OnboardingRepository(), switches, config), statements };
}

const MEMBERSHIP: TenantMembership = {
  membershipId: "stf_01JA2ZA1C5E9G3J7K2M6P00001",
  tenantId: TENANT,
  accountId: ACCOUNT,
  role: "viewer",
};

describe("OnboardingService.get", () => {
  it("reads the facts with one SELECT in one read-only transaction and writes nothing", async () => {
    const { onboarding, statements } = service([FACTS_ROW]);

    await onboarding.get(MEMBERSHIP);

    expect(statements).toHaveLength(3);
    expect(statements[0]).toBe("start transaction read only");
    expect(statements[1]).toMatch(/^select\b/i);
    expect(statements[2]).toBe("commit");
    expect(statements.join("\n")).not.toMatch(/\b(insert|update|delete|merge|truncate)\b/i);
    // The facts come from the tables the operation documents, and the account read is the caller's.
    for (const table of [
      "tenants",
      "tenant_domains",
      "accounts",
      "payment_provider_connections",
      "provisioning_jobs",
      "api_keys",
      "supplier_connections",
      "tenant_invitations",
      "tenant_memberships",
      "subscriptions",
      "tenant_payout_accounts",
    ]) {
      expect(statements[1], table).toContain(`"platform"."${table}"`);
    }
  });

  it("maps the row to the checklist: the sub-domain when there is no primary domain, counts from strings", async () => {
    const { onboarding } = service([FACTS_ROW], ["settlements"]);

    const { items } = await onboarding.get(MEMBERSHIP);

    expect(items.map(({ id, done, href }) => [id, done, href])).toEqual([
      ["email_verified", true, "/verify-pending"],
      ["mfa_enabled", false, "/account/security"],
      ["ota_active", true, `/otas/${TENANT}/setup`],
      ["api_key", true, `/otas/${TENANT}/api-keys`],
      ["storefront_open", true, "https://acme.ota.example.com/"],
      ["amadeus_test", true, `/otas/${TENANT}/amadeus`],
      ["team_invited", true, `/otas/${TENANT}/team`],
      ["payments_ready", true, `/otas/${TENANT}/payments`],
    ]);
  });

  it("reads a missing account and payment connection as not done, and the primary host when there is one", async () => {
    const { onboarding } = service(
      [
        {
          ...FACTS_ROW,
          primary_host: "travel.acme.example",
          email_verified_at: null,
          mfa_enabled: null,
          test_payment_mode: null,
          test_payment_status: null,
          active_members: "1",
        },
      ],
      ["own_stripe"],
    );

    const { items } = await onboarding.get(MEMBERSHIP);
    const byId = new Map(items.map((item) => [item.id, item]));

    expect(byId.get("email_verified")?.done).toBe(false);
    expect(byId.get("mfa_enabled")?.done).toBe(false);
    expect(byId.get("team_invited")?.done).toBe(false);
    expect(byId.get("payments_ready")?.done).toBe(false);
    expect(byId.get("storefront_open")?.href).toBe("https://travel.acme.example/");
  });

  it("answers 404 NOT_FOUND for a tenant that is gone, after a read-only transaction that wrote nothing", async () => {
    const { onboarding, statements } = service([]);

    const error = await onboarding.get(MEMBERSHIP).catch((caught: unknown) => caught);

    expect(isAppError(error) && error.code).toBe("NOT_FOUND");
    expect(statements).toEqual([
      "start transaction read only",
      expect.stringMatching(/^select\b/i),
      "commit",
    ]);
  });
});
