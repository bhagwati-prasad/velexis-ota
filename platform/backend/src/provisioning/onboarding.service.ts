// The onboarding checklist of the portal (PBE-024; PADR-0018, scope PF-12, platform/docs/api-inventory.md §7
// `getOnboarding`): computed on every call from tables the platform owns, never stored. ProvisioningModule owns it
// (architecture §2.1) because it spans the tables of most layer-1 modules.
//
// - ONBOARDING_ITEMS is the table of PADR-0018, row for row and in its order: the id, the label, the milestone, the
//   switches that show an M5 item (PADR-0015; any one of them), the rule that makes it done and its link.
// - `onboardingChecklist(tenantId, facts, isEnabled)` applies the table to the facts of one OTA and one caller. It is
//   pure, so the rules are tested without a database (onboarding.service.test.ts).
// - OnboardingService.get opens one `START TRANSACTION READ ONLY` transaction, in which OnboardingRepository reads the
//   facts in one statement, so the read sees one snapshot and PostgreSQL itself refuses any write; nothing is written,
//   cached or audited. The account items (`email_verified`, `mfa_enabled`) are the caller's: the account of the
//   membership that TenantRoleGuard read. The facts of the M5 items are read whatever the switches say (a few indexed
//   lookups); the switches only decide which items the answer lists.
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import type { TenantMembership } from "../common/auth/tenant-role.guard";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { FeatureSwitches, type Feature } from "../common/features";
import type { PlatformBackendConfig } from "../config";
import { storefrontHost } from "../tenants/tenant-key";
import { OnboardingRepository, type OnboardingRecord } from "./onboarding.repository";

export type OnboardingChecklist = components["schemas"]["OnboardingChecklist"];
export type OnboardingItem = components["schemas"]["OnboardingItem"];
export type OnboardingItemId = OnboardingItem["id"];
export type OnboardingMilestone = OnboardingItem["milestone"];

/** What the rules of PADR-0018 look at, for one OTA and one caller (OnboardingRecord, with the storefront's host). */
export interface OnboardingFacts extends Omit<OnboardingRecord, "tenantKey" | "primaryDomain"> {
  /** The primary storefront host: the primary storefront domain, else the sub-domain `<key>.<base domain>`. */
  readonly primaryHost: string;
}

/** One row of the table of PADR-0018. */
export interface OnboardingItemRule {
  readonly id: OnboardingItemId;
  readonly label: string;
  readonly milestone: OnboardingMilestone;
  /** The switches that show an M5 item, any one of them (PADR-0015); empty for an M1 item, which always shows. */
  readonly switches: readonly Feature[];
  /** The "Done when" column. */
  readonly done: (facts: OnboardingFacts) => boolean;
  /** The "Link" column: a portal path, or the storefront URL. */
  readonly href: (tenantId: string, facts: OnboardingFacts) => string;
}

/** A path of the portal under the OTA's pages: `/otas/<tenantId>/<page>`. */
const otaPage =
  (page: string) =>
  (tenantId: string): string =>
    `/otas/${tenantId}/${page}`;

/** The payment modes in which the OTA charges on a Stripe account of its own (PADR-0011). */
const OWN_STRIPE_MODES: ReadonlySet<string> = new Set(["connect_standard", "api_keys"]);

const rule = (item: OnboardingItemRule): OnboardingItemRule =>
  Object.freeze({ ...item, switches: Object.freeze([...item.switches]) });

/** The items of PADR-0018, in its order. */
export const ONBOARDING_ITEMS: readonly OnboardingItemRule[] = Object.freeze([
  rule({
    id: "email_verified",
    label: "Verify your e-mail",
    milestone: "M1",
    switches: [],
    done: (facts) => facts.emailVerified,
    href: () => "/verify-pending",
  }),
  rule({
    id: "mfa_enabled",
    label: "Turn on two-factor sign-in",
    milestone: "M1",
    switches: [],
    done: (facts) => facts.mfaEnabled,
    href: () => "/account/security",
  }),
  rule({
    id: "ota_active",
    label: "OTA set up",
    milestone: "M1",
    switches: [],
    done: (facts) => facts.tenantStatus === "active",
    href: otaPage("setup"),
  }),
  rule({
    id: "api_key",
    label: "Get your API keys",
    milestone: "M1",
    switches: [],
    done: (facts) => facts.initialKeysRevealed || facts.apiKeyCreatedByAccount,
    href: otaPage("api-keys"),
  }),
  rule({
    id: "storefront_open",
    label: "Open your storefront",
    milestone: "M1",
    switches: [],
    // "You can open it", not "you opened it": the platform never sees storefront traffic (PADR-0018).
    done: (facts) => facts.tenantStatus === "active",
    href: (_tenantId, facts) => `https://${facts.primaryHost}/`,
  }),
  rule({
    id: "amadeus_test",
    label: "Amadeus test office active",
    milestone: "M1",
    switches: [],
    done: (facts) => facts.amadeusTestActive,
    href: otaPage("amadeus"),
  }),
  rule({
    id: "team_invited",
    label: "Invite your team",
    milestone: "M1",
    switches: [],
    done: (facts) => facts.invitationNotRevoked || facts.activeMembers > 1,
    href: otaPage("team"),
  }),
  rule({
    id: "plan_chosen",
    label: "Choose a plan",
    milestone: "M5",
    switches: ["stripe_billing"],
    done: (facts) => facts.stripeSubscriptionCurrent,
    href: otaPage("billing"),
  }),
  rule({
    id: "custom_domain",
    label: "Connect your domain",
    milestone: "M5",
    switches: ["custom_domains"],
    done: (facts) => facts.customDomainVerified,
    href: otaPage("domains"),
  }),
  rule({
    id: "payments_ready",
    label: "Set up payouts or your own Stripe",
    milestone: "M5",
    switches: ["own_stripe", "settlements"],
    done: ({ testPaymentConnection: connection, payoutAccountVerified }) =>
      connection !== null &&
      ((OWN_STRIPE_MODES.has(connection.accountMode) && connection.status === "active") ||
        (connection.accountMode === "velexis" && payoutAccountVerified)),
    href: otaPage("payments"),
  }),
  rule({
    id: "live_requested",
    label: "Go live",
    milestone: "M5",
    switches: ["live_switch"],
    done: (facts) => facts.amadeusLiveExists || facts.storefrontEnvironment === "live",
    href: otaPage("go-live"),
  }),
]);

/**
 * The checklist of the OTA `tenantId` for `facts`: the items of ONBOARDING_ITEMS in their order, an M5 item only when
 * one of its switches is on (`isEnabled`), each with its label, link, milestone and whether its rule holds.
 */
export function onboardingChecklist(
  tenantId: string,
  facts: OnboardingFacts,
  isEnabled: (feature: Feature) => boolean,
): OnboardingChecklist {
  return {
    items: ONBOARDING_ITEMS.filter(
      (item) => item.switches.length === 0 || item.switches.some((feature) => isEnabled(feature)),
    ).map((item) => ({
      id: item.id,
      label: item.label,
      done: item.done(facts),
      href: item.href(tenantId, facts),
      milestone: item.milestone,
    })),
  };
}

@Injectable()
export class OnboardingService {
  private readonly baseDomain: string;

  constructor(
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    private readonly onboarding: OnboardingRepository,
    private readonly features: FeatureSwitches,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
  }

  /**
   * getOnboarding: the checklist of the caller's OTA, with the account items of the caller. Reads in one read-only
   * transaction and writes nothing. A tenant gone between TenantRoleGuard's read and this one answers `404`, as an
   * unknown tenant does.
   */
  async get(membership: TenantMembership): Promise<OnboardingChecklist> {
    const record = await this.db
      .transaction()
      .setAccessMode("read only")
      .execute((trx) => this.onboarding.facts(trx, membership.tenantId, membership.accountId));
    if (record === undefined) {
      throw new AppError("NOT_FOUND");
    }
    const { tenantKey, primaryDomain, ...facts } = record;
    return onboardingChecklist(
      membership.tenantId,
      { ...facts, primaryHost: primaryDomain ?? storefrontHost(tenantKey, this.baseDomain) },
      (feature) => this.features.isEnabled(feature),
    );
  }
}
