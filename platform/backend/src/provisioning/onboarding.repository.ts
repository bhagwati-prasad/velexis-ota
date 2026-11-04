// The read of the onboarding checklist (PBE-024; PADR-0018, platform/docs/api-inventory.md §7 `getOnboarding`): the
// facts of one OTA and one caller, in one statement on the caller's transaction (OnboardingService opens it read only,
// conventions §2: repositories never open transactions). Kysely, schema-qualified tables (ADR-0005).
//
// The facts come from `tenants`, `accounts`, `tenant_domains`, `provisioning_jobs`, `api_keys`, `supplier_connections`,
// `tenant_invitations`, `tenant_memberships`, `subscriptions`, `payment_provider_connections` and
// `tenant_payout_accounts` (the `x-platform-tables` of the operation). They are only read, and read here in one
// statement rather than through each owner's repository: the checklist must be one consistent read, and the owner of
// the payout accounts (SettlementsModule, M5) does not exist yet. Every sub-query is bound to the OTA, so another OTA's
// rows never count.
import { Injectable } from "@nestjs/common";
import type { PlatformTransaction } from "../audit/audit.repository";

/**
 * The subscription statuses `plan_chosen` looks at: a Stripe subscription that is `trialing` or `active`, or a manual
 * one that is `active` (PADR-0018 and its note of 2026-11-04). Both are statuses of the `subscriptions_current_uq`
 * index, so an OTA has at most one row in them.
 */
export const CHOSEN_PLAN_SUBSCRIPTION_STATUSES = Object.freeze(["trialing", "active"] as const);

/** The OTA's subscription in a status of CHOSEN_PLAN_SUBSCRIPTION_STATUSES, as `plan_chosen` judges it. */
export interface OnboardingSubscription {
  /** `billing_provider`: `stripe`, or `manual` (set by a platform admin). */
  readonly billingProvider: string;
  /** `status`: `trialing` or `active`. */
  readonly status: string;
}

/** What the rules of PADR-0018 look at, for one OTA and one caller, as the tables hold it. */
export interface OnboardingRecord {
  /** `tenants.key`: the storefront sub-domain `<key>.<base domain>` when the OTA has no primary storefront domain. */
  readonly tenantKey: string;
  /** The hostname of the primary storefront domain (`purpose = 'storefront'`, `is_primary`); `null` when none. */
  readonly primaryDomain: string | null;
  /** The caller's `accounts.email_verified_at` is set. */
  readonly emailVerified: boolean;
  /** The caller's `accounts.mfa_enabled`. */
  readonly mfaEnabled: boolean;
  /** `tenants.status`. */
  readonly tenantStatus: string;
  /** `tenants.storefront_environment`: `test` until the OTA goes live. */
  readonly storefrontEnvironment: string;
  /** A `provisioning_jobs` row of the OTA has `revealed_at`: the initial keys were revealed. */
  readonly initialKeysRevealed: boolean;
  /** An `api_keys` row of the OTA (in any state) has `created_by_account_id`: a person created or rolled a key. */
  readonly apiKeyCreatedByAccount: boolean;
  /** The `test` supplier connection is `active`. */
  readonly amadeusTestActive: boolean;
  /** The OTA has a `tenant_invitations` row that is not `revoked` (pending, accepted or expired). */
  readonly invitationNotRevoked: boolean;
  /** The number of `active` memberships of the OTA. */
  readonly activeMembers: number;
  /**
   * The OTA's subscription that is `trialing` or `active` (at most one: `subscriptions_current_uq`), whoever bills it;
   * `null` without one. `planChosen` (onboarding.service.ts) decides whether it makes `plan_chosen` done.
   */
  readonly currentSubscription: OnboardingSubscription | null;
  /** A custom storefront domain of the OTA is `verified`. */
  readonly customDomainVerified: boolean;
  /** The `test` Stripe payment connection's `account_mode` and `status`; `null` when the OTA has none. */
  readonly testPaymentConnection: { readonly accountMode: string; readonly status: string } | null;
  /** The OTA's `tenant_payout_accounts` row is `verified`. */
  readonly payoutAccountVerified: boolean;
  /** The OTA has a `live` supplier connection, in any status. */
  readonly amadeusLiveExists: boolean;
}

@Injectable()
export class OnboardingRepository {
  /**
   * The facts of `tenantId` and `accountId`, in one statement on `trx`: the tenant with its primary storefront domain,
   * the caller's account and the OTA's `test` Stripe payment connection (at most one: `payment_provider_connections_uq`
   * and the mode CHECK, which makes every row a Stripe row), and one sub-query per other fact. `undefined` when the
   * tenant does not exist.
   */
  async facts(
    trx: PlatformTransaction,
    tenantId: string,
    accountId: string,
  ): Promise<OnboardingRecord | undefined> {
    const row = await trx
      .selectFrom("platform.tenants as t")
      .leftJoin("platform.tenant_domains as d", (join) =>
        join
          .onRef("d.tenant_id", "=", "t.id")
          .on("d.purpose", "=", "storefront")
          .on("d.is_primary", "=", true),
      )
      .leftJoin("platform.accounts as a", (join) => join.on("a.id", "=", accountId))
      .leftJoin("platform.payment_provider_connections as p", (join) =>
        join
          .onRef("p.tenant_id", "=", "t.id")
          .on("p.provider", "=", "stripe")
          .on("p.environment", "=", "test"),
      )
      .select((eb) => [
        "t.key",
        "t.status",
        "t.storefront_environment",
        "d.hostname as primary_host",
        "a.email_verified_at",
        "a.mfa_enabled",
        "p.account_mode as test_payment_mode",
        "p.status as test_payment_status",
        eb
          .exists(
            eb
              .selectFrom("platform.provisioning_jobs as j")
              .select("j.id")
              .where("j.tenant_id", "=", tenantId)
              .where("j.revealed_at", "is not", null),
          )
          .as("initial_keys_revealed"),
        eb
          .exists(
            eb
              .selectFrom("platform.api_keys as k")
              .select("k.id")
              .where("k.tenant_id", "=", tenantId)
              .where("k.created_by_account_id", "is not", null),
          )
          .as("api_key_created_by_account"),
        eb
          .exists(
            eb
              .selectFrom("platform.supplier_connections as s")
              .select("s.id")
              .where("s.tenant_id", "=", tenantId)
              .where("s.environment", "=", "test")
              .where("s.status", "=", "active"),
          )
          .as("amadeus_test_active"),
        eb
          .exists(
            eb
              .selectFrom("platform.supplier_connections as s")
              .select("s.id")
              .where("s.tenant_id", "=", tenantId)
              .where("s.environment", "=", "live"),
          )
          .as("amadeus_live_exists"),
        eb
          .exists(
            eb
              .selectFrom("platform.tenant_invitations as i")
              .select("i.id")
              .where("i.tenant_id", "=", tenantId)
              .where("i.status", "<>", "revoked"),
          )
          .as("invitation_not_revoked"),
        eb
          .selectFrom("platform.tenant_memberships as m")
          .select((inner) => inner.fn.countAll<string>().as("n"))
          .where("m.tenant_id", "=", tenantId)
          .where("m.status", "=", "active")
          .as("active_members"),
        eb
          .selectFrom("platform.subscriptions as b")
          .select("b.billing_provider")
          .where("b.tenant_id", "=", tenantId)
          .where("b.status", "in", CHOSEN_PLAN_SUBSCRIPTION_STATUSES)
          .orderBy("b.id")
          .limit(1)
          .as("subscription_provider"),
        eb
          .selectFrom("platform.subscriptions as b")
          .select("b.status")
          .where("b.tenant_id", "=", tenantId)
          .where("b.status", "in", CHOSEN_PLAN_SUBSCRIPTION_STATUSES)
          .orderBy("b.id")
          .limit(1)
          .as("subscription_status"),
        eb
          .exists(
            eb
              .selectFrom("platform.tenant_domains as c")
              .select("c.id")
              .where("c.tenant_id", "=", tenantId)
              .where("c.kind", "=", "custom")
              .where("c.purpose", "=", "storefront")
              .where("c.verification_status", "=", "verified"),
          )
          .as("custom_domain_verified"),
        eb
          .exists(
            eb
              .selectFrom("platform.tenant_payout_accounts as o")
              .select("o.tenant_id")
              .where("o.tenant_id", "=", tenantId)
              .where("o.status", "=", "verified"),
          )
          .as("payout_account_verified"),
      ])
      .where("t.id", "=", tenantId)
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    return {
      tenantKey: row.key,
      primaryDomain: row.primary_host,
      emailVerified: row.email_verified_at !== null,
      mfaEnabled: row.mfa_enabled === true,
      tenantStatus: row.status,
      storefrontEnvironment: row.storefront_environment,
      initialKeysRevealed: Boolean(row.initial_keys_revealed),
      apiKeyCreatedByAccount: Boolean(row.api_key_created_by_account),
      amadeusTestActive: Boolean(row.amadeus_test_active),
      invitationNotRevoked: Boolean(row.invitation_not_revoked),
      activeMembers: Number(row.active_members ?? 0),
      currentSubscription:
        row.subscription_provider === null || row.subscription_status === null
          ? null
          : { billingProvider: row.subscription_provider, status: row.subscription_status },
      customDomainVerified: Boolean(row.custom_domain_verified),
      testPaymentConnection:
        row.test_payment_mode === null || row.test_payment_status === null
          ? null
          : { accountMode: row.test_payment_mode, status: row.test_payment_status },
      payoutAccountVerified: Boolean(row.payout_account_verified),
      amadeusLiveExists: Boolean(row.amadeus_live_exists),
    };
  }
}
