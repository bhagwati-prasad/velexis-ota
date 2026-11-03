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
// rows never count. Nothing secret is selected: no ciphertext, no TOTP secret.
import { Injectable } from "@nestjs/common";
import type { PlatformTransaction } from "../audit/audit.repository";

/** The subscription statuses that let an OTA go live: a Stripe subscription that is `trialing` or `active` (PF-14). */
export const LIVE_SUBSCRIPTION_STATUSES = Object.freeze(["trialing", "active"] as const);

/** What the preconditions of go-live look at, besides the payment connections and the payout account. */
export interface GoLiveFacts {
  /** The `limits` of the tenant's plan (`plans.limits`); `null` when the plan row is gone. */
  readonly planLimits: unknown;
  /** The owner's `accounts.mfa_enabled`, read again in the transaction; `false` when the account is gone. */
  readonly mfaEnabled: boolean;
  /**
   * The OTA has a Stripe subscription (`billing_provider = 'stripe'` with a `provider_subscription_id`) that is
   * `trialing` or `active`.
   */
  readonly stripeSubscriptionCurrent: boolean;
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
          .exists(
            eb
              .selectFrom("platform.subscriptions as s")
              .select("s.id")
              .where("s.tenant_id", "=", tenantId)
              .where("s.billing_provider", "=", "stripe")
              .where("s.provider_subscription_id", "is not", null)
              .where("s.status", "in", LIVE_SUBSCRIPTION_STATUSES),
          )
          .as("stripe_subscription_current"),
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
      stripeSubscriptionCurrent: Boolean(row.stripe_subscription_current),
      amadeusLiveActive: Boolean(row.amadeus_live_active),
    };
  }
}
