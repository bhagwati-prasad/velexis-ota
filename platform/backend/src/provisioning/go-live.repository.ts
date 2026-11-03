// The reads of go-live's preconditions (PBE-061; platform/docs/api-inventory.md §7 `goLive`, scope PF-14 AC1): the
// facts of one OTA and its owner that no lock needs to hold, in one statement on the caller's transaction
// (GoLiveService opens it after it locked the tenant's row; conventions §2: repositories never open transactions).
// Kysely, schema-qualified tables (ADR-0005).
//
// The facts come from `plans`, `accounts`, `subscriptions` and `supplier_connections` (the `x-platform-tables` of the
// operation), only read, and read here in one statement rather than through each owner's repository, as the
// onboarding checklist does (onboarding.repository.ts): the preconditions are one consistent read. The payment
// connections and the payout account, which go-live locks (the connections it may copy, the account it relies on),
// are read through PaymentConnectionsRepository. Every sub-query is bound to the OTA or its owner, so another OTA's
// rows never count. Nothing secret is selected: no ciphertext, no TOTP secret. The subscription is read as it is
// (provider, status, whether Stripe has it) and judged by GoLiveService's `subscriptionAllowsGoLive`, so the rule of
// the `subscription` precondition is tested without a database (FIX-W40-PLATFORM, lead decision (2c) of 2026-11-03).
import { Injectable } from "@nestjs/common";
import type { PlatformTransaction } from "../audit/audit.repository";

/**
 * The subscription statuses go-live looks at: a Stripe subscription that is `trialing` or `active` lets an OTA go live
 * (PF-14), and so does a manual one that is `active` (`subscriptionAllowsGoLive`). Both are statuses of the
 * `subscriptions_current_uq` index, so an OTA has at most one row in them.
 */
export const LIVE_SUBSCRIPTION_STATUSES = Object.freeze(["trialing", "active"] as const);

/** The OTA's subscription in a status of LIVE_SUBSCRIPTION_STATUSES, as go-live judges it. */
export interface LiveCandidateSubscription {
  /** `billing_provider`: `stripe`, or `manual` (set by a platform admin). */
  readonly billingProvider: string;
  /** `status`: `trialing` or `active`. */
  readonly status: string;
  /** The row has a `provider_subscription_id`: the subscription exists at Stripe. */
  readonly linked: boolean;
}

/** What the preconditions of go-live look at, besides the payment connections and the payout account. */
export interface GoLiveFacts {
  /** The `limits` of the tenant's plan (`plans.limits`); `null` when the plan row is gone. */
  readonly planLimits: unknown;
  /** The owner's `accounts.mfa_enabled`, read again in the transaction; `false` when the account is gone. */
  readonly mfaEnabled: boolean;
  /**
   * The OTA's subscription that is `trialing` or `active` (at most one: `subscriptions_current_uq`), whoever bills it;
   * `null` without one. `subscriptionAllowsGoLive` decides whether it lets the OTA go live.
   */
  readonly subscription: LiveCandidateSubscription | null;
  /** The OTA's `live` Amadeus connection is `active` (any credential source). */
  readonly amadeusLiveActive: boolean;
}

@Injectable()
export class GoLiveRepository {
  /** The facts of `tenantId` on its plan `planCode` and of its owner `accountId`, in one statement on `trx`. */
  async facts(
    trx: PlatformTransaction,
    tenantId: string,
    planCode: string,
    accountId: string,
  ): Promise<GoLiveFacts> {
    const row = await trx
      .selectNoFrom((eb) => [
        eb
          .selectFrom("platform.plans as p")
          .select("p.limits")
          .where("p.code", "=", planCode)
          .as("plan_limits"),
        eb
          .selectFrom("platform.accounts as a")
          .select("a.mfa_enabled")
          .where("a.id", "=", accountId)
          .as("mfa_enabled"),
        eb
          .selectFrom("platform.subscriptions as s")
          .select("s.billing_provider")
          .where("s.tenant_id", "=", tenantId)
          .where("s.status", "in", LIVE_SUBSCRIPTION_STATUSES)
          .orderBy("s.id")
          .limit(1)
          .as("subscription_provider"),
        eb
          .selectFrom("platform.subscriptions as s")
          .select("s.status")
          .where("s.tenant_id", "=", tenantId)
          .where("s.status", "in", LIVE_SUBSCRIPTION_STATUSES)
          .orderBy("s.id")
          .limit(1)
          .as("subscription_status"),
        eb
          .selectFrom("platform.subscriptions as s")
          .select((inner) => inner("s.provider_subscription_id", "is not", null).as("linked"))
          .where("s.tenant_id", "=", tenantId)
          .where("s.status", "in", LIVE_SUBSCRIPTION_STATUSES)
          .orderBy("s.id")
          .limit(1)
          .as("subscription_linked"),
        eb
          .exists(
            eb
              .selectFrom("platform.supplier_connections as c")
              .select("c.id")
              .where("c.tenant_id", "=", tenantId)
              .where("c.provider", "=", "amadeus")
              .where("c.environment", "=", "live")
              .where("c.status", "=", "active"),
          )
          .as("amadeus_live_active"),
      ])
      .executeTakeFirstOrThrow();
    return {
      planLimits: row.plan_limits ?? null,
      mfaEnabled: row.mfa_enabled === true,
      subscription:
        row.subscription_provider === null || row.subscription_status === null
          ? null
          : {
              billingProvider: row.subscription_provider,
              status: row.subscription_status,
              linked: row.subscription_linked === true,
            },
      amadeusLiveActive: Boolean(row.amadeus_live_active),
    };
  }
}
