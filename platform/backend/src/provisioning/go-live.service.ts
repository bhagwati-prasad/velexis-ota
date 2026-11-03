// Go-live (PBE-061; platform/docs/api-inventory.md §7 `goLive`, scope PF-14, flows/stripe-payments-account.md §A
// item 2, ADR-0018 "Environment", PADR-0008 "Sensitive actions"): the owner switches the OTA's hosted storefront to
// live. Who may call it is decided before it runs: TenantRoleGuard (owners only), FeatureGuard (`x-feature:
// live_switch`, `403 FEATURE_DISABLED`) and then RecentMfaGuard (`x-mfa-step-up`: `403 MFA_REQUIRED` without MFA, `401
// REAUTH_REQUIRED` without a TOTP step-up in the last 15 minutes); the switch answers before the step-up
// (FIX-W38-PLATFORM, lead decision (2i) of 2026-10-31). The body only confirms (`{confirm: true}`, checked by the
// request validation).
//
// `goLive`, in one transaction (`runInTransaction`), with nothing outside the platform database asked:
//
// 1. The tenant's row `FOR NO KEY UPDATE` (gone or not visible to members: `404 NOT_FOUND`; not `active`: `409
//    TENANT_NOT_ACTIVE` with `details.status`, PADR-0014 item 5). The writes of a tenant's payment connection that
//    take this row first (`FOR SHARE`: the Connect callback, the verification of own Stripe keys, the return to Velexis
//    payments, the descriptor update; `FOR UPDATE`: a suspension, billing sync) wait for go-live, and so does a second
//    go-live. The writers that lock their own row first (the admin's review and the owner's save of the payout account,
//    the admin's switch of a connection's status, the Connect account events) are waited for by the locks of step 2,
//    and go-live then decides on what they committed; their audit row's foreign key takes only a `KEY SHARE` lock of
//    the tenant's row, which `FOR NO KEY UPDATE` leaves free (`FOR UPDATE` would make each wait for the other until
//    PostgreSQL aborts one). An OTA that is live already is answered as it is, `200`, with no write, audit row or
//    invalidation (the document's "unchanged").
// 2. The preconditions of PF-14 AC1, every one checked, the missing ones in `details.missing` of `422
//    LIVE_PRECONDITIONS_UNMET` in the inventory's order (`missingPreconditions`):
//    - `amadeus_live`: the live Amadeus connection is `active` (any credential source, GoLiveRepository);
//    - `payments_live`: a live payment mode that can charge (`livePaymentPlan`). The test and live payment connections
//      are locked (`FOR UPDATE`, test first, as the Connect callback locks them). The live connection decides when the
//      OTA has one, in any of the three modes (verified live API keys submitted before going live, PBE-057, included);
//      otherwise the test connection that go-live copies: `velexis` (the Velexis Stripe account) or `connect_standard`
//      (the OTA's connected account; one OAuth serves both environments, PADR-0011 item 2). Test API keys cannot take
//      live payments. The connection that decides must be `active`: `pending` (a connected account whose charges are
//      not enabled yet) and `disabled` (by a platform admin, or by a Stripe deauthorisation) cannot charge;
//    - `payout_account`: when that mode is `velexis`, the payout account is `verified` (read `FOR SHARE`, so a change
//      of the account waits for go-live), because Velexis then collects the OTA's money and settles it (PADR-0003);
//    - `plan_live_mode`: the plan's `limits.liveMode` is `true` (planAllowsLiveMode, as requestLiveAmadeus reads it);
//    - `subscription`: a Stripe subscription that is `trialing` or `active`, or a manual subscription
//      (`billing_provider = 'manual'`, set by a platform admin) that is `active` (FIX-W40-PLATFORM, lead decision (2c)
//      of 2026-11-03; `subscriptionAllowsGoLive`); a manual trial (`trialing` on a manual row) still counts as missing;
//    - `mfa`: the owner's account still has MFA on, read again in the transaction (RecentMfaGuard read it on the pool
//      before the handler ran).
// 3. All met: `storefront_environment = 'live'`, `live_enabled_at`, `live_enabled_by_account_id` and `version + 1`
//    (TenantsRepository.switchToLive); without a live payment connection, the live one is created from the test one:
//    a `velexis` test connection gives a live `velexis` one, a `connect_standard` one is copied with its account,
//    capabilities, status and `connected_at` (one OAuth serves both rows, so a deauthorisation that reaches the platform
//    after go-live but is older than that OAuth disables the copy too instead of passing for stale); both keep the
//    statement descriptor suffix. One audit row `tenant.went_live` (the environment before and after, the live payment
//    mode and connection, whether go-live created it; never a secret), and after the commit `{type: "tenant", id}` and
//    `{type: "connection", tenantId}`, so the OTA backend drops its cached tenant (the storefront serves live within 60
//    seconds, PF-14 AC2) and any cached "no live connection".
//
// The answer is the tenant as getTenant maps it (`toTenant`); the controller sets its `ETag`. Live API keys can be
// created from then on (ApiKeysService: live keys need the live switch and a live OTA, and a live secret key a
// step-up). "Now" is the injected Clock's time.
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import { MEMBER_VISIBLE_TENANT_STATUSES, type TenantMembership } from "../common/auth/tenant-role.guard";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { IdGenerator } from "../common/ids";
import { InvalidationPublisher, runInTransaction } from "../common/redis/invalidation.publisher";
import type { PlatformBackendConfig } from "../config";
import {
  PaymentConnectionsRepository,
  type ConnectCapabilities,
  type PaymentConnectionView,
} from "../payment-connections/payment-connections.repository";
import { planAllowsLiveMode } from "../supplier-connections/live-office.service";
import { TenantsRepository } from "../tenants/tenants.repository";
import { toTenant, type Tenant } from "../tenants/tenants.service";
import { GoLiveRepository, type LiveCandidateSubscription } from "./go-live.repository";

export type GoLiveRequest = components["schemas"]["GoLiveRequest"];

/** The preconditions of go-live (api-inventory §7, PF-14 AC1), in the order `details.missing` lists them. */
export const LIVE_PRECONDITIONS = Object.freeze([
  "amadeus_live",
  "payments_live",
  "payout_account",
  "plan_live_mode",
  "subscription",
  "mfa",
] as const);

/** A precondition of go-live: a value of `details.missing` in `422 LIVE_PRECONDITIONS_UNMET`. */
export type LivePrecondition = (typeof LIVE_PRECONDITIONS)[number];

/** The parts of a payment connection that decide the live payment mode. */
export type PaymentConnectionState = Pick<PaymentConnectionView, "account_mode" | "status">;

/** What go-live writes for the live payment connection. */
export type LivePaymentWrite = "none" | "insert_velexis" | "copy_connect_standard";

/** The live payment mode of an OTA about to go live, decided from its test and live payment connections. */
export interface LivePaymentPlan {
  /** The mode the live payments use (`velexis`, `connect_standard`, `api_keys`); `null` without any connection. */
  readonly mode: string | null;
  /** True when that mode can charge: the connection that decides is `active`. */
  readonly usable: boolean;
  /** What go-live writes: nothing (a live connection exists, or none can be made), or the live copy of the test one. */
  readonly write: LivePaymentWrite;
}

/**
 * The live payment mode (step 2 of the file header): the live connection's when the OTA has one, in any mode;
 * otherwise the test connection's that go-live copies (`velexis` or `connect_standard`). Test API keys cannot take
 * live payments, so a test connection in `api_keys` mode without a live connection gives no usable mode. The
 * connection that decides must be `active`.
 */
export function livePaymentPlan(
  test: PaymentConnectionState | undefined,
  live: PaymentConnectionState | undefined,
): LivePaymentPlan {
  if (live !== undefined) {
    return { mode: live.account_mode, usable: live.status === "active", write: "none" };
  }
  if (test === undefined) {
    return { mode: null, usable: false, write: "none" };
  }
  const usable = test.status === "active";
  switch (test.account_mode) {
    case "velexis":
      return { mode: "velexis", usable, write: usable ? "insert_velexis" : "none" };
    case "connect_standard":
      return { mode: "connect_standard", usable, write: usable ? "copy_connect_standard" : "none" };
    default:
      return { mode: test.account_mode, usable: false, write: "none" };
  }
}

/** What the preconditions of go-live are checked against. */
export interface GoLiveState {
  /** The live Amadeus connection is `active`. */
  readonly amadeusLiveActive: boolean;
  readonly payment: Pick<LivePaymentPlan, "mode" | "usable">;
  /** The payout account's review status (`pending_review`, `verified`, `rejected`); `undefined` without one. */
  readonly payoutAccountStatus: string | undefined;
  /** The `limits` of the tenant's plan. */
  readonly planLimits: unknown;
  /** The OTA's subscription that is `trialing` or `active`; `null` without one (GoLiveFacts). */
  readonly subscription: LiveCandidateSubscription | null;
  /** The owner's account has MFA on. */
  readonly mfaEnabled: boolean;
}

/**
 * True when `subscription` meets the `subscription` precondition (PF-14 AC1): a Stripe subscription
 * (`billing_provider = 'stripe'` with a `provider_subscription_id`) that is `trialing` or `active`, or a manual one
 * (`billing_provider = 'manual'`) that is `active` (FIX-W40-PLATFORM, lead decision (2c) of 2026-11-03). A manual trial
 * is no subscription for go-live: nobody pays for it yet.
 */
export function subscriptionAllowsGoLive(subscription: LiveCandidateSubscription | null): boolean {
  if (subscription === null) {
    return false;
  }
  switch (subscription.billingProvider) {
    case "stripe":
      return subscription.linked && (subscription.status === "trialing" || subscription.status === "active");
    case "manual":
      return subscription.status === "active";
    default:
      return false;
  }
}

/** The preconditions `state` leaves unmet, in the order of LIVE_PRECONDITIONS; empty when the OTA can go live. */
export function missingPreconditions(state: GoLiveState): LivePrecondition[] {
  const unmet: Record<LivePrecondition, boolean> = {
    amadeus_live: !state.amadeusLiveActive,
    payments_live: !state.payment.usable,
    payout_account: state.payment.mode === "velexis" && state.payoutAccountStatus !== "verified",
    plan_live_mode: !planAllowsLiveMode(state.planLimits),
    subscription: !subscriptionAllowsGoLive(state.subscription),
    mfa: !state.mfaEnabled,
  };
  return LIVE_PRECONDITIONS.filter((precondition) => unmet[precondition]);
}

/**
 * The capabilities a `connect_standard` connection stores (jsonb `{chargesEnabled, payoutsEnabled,
 * detailsSubmitted}`), each `false` where the stored value is not `true`.
 */
export function storedConnectCapabilities(stored: unknown): ConnectCapabilities {
  const record =
    stored !== null && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  return {
    chargesEnabled: record["chargesEnabled"] === true,
    payoutsEnabled: record["payoutsEnabled"] === true,
    detailsSubmitted: record["detailsSubmitted"] === true,
  };
}

/** The live payment connection after go-live, as the audit row records it. */
interface LiveConnectionOutcome {
  readonly id: string | null;
  readonly accountMode: string | null;
  readonly created: boolean;
}

const VISIBLE_STATUSES: ReadonlySet<string> = new Set(MEMBER_VISIBLE_TENANT_STATUSES);

@Injectable()
export class GoLiveService {
  private readonly baseDomain: string;

  constructor(
    private readonly tenants: TenantsRepository,
    private readonly facts: GoLiveRepository,
    private readonly connections: PaymentConnectionsRepository,
    private readonly audit: AuditService,
    private readonly invalidations: InvalidationPublisher,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
  }

  /** goLive: the switch of the OTA of `membership` (an owner's) to live (see the file header). */
  async goLive(membership: TenantMembership): Promise<Tenant> {
    const { tenantId, accountId } = membership;
    return runInTransaction(this.db, async (trx) => {
      const tenant = await this.tenants.lockForNoKeyUpdate(trx, tenantId);
      if (tenant === undefined || tenant.deleted_at !== null || !VISIBLE_STATUSES.has(tenant.status)) {
        throw new AppError("NOT_FOUND");
      }
      if (tenant.status !== "active") {
        throw new AppError("TENANT_NOT_ACTIVE", { details: { status: tenant.status } });
      }
      if (tenant.storefront_environment === "live") {
        return this.answer(trx, membership);
      }
      const facts = await this.facts.facts(trx, tenantId, tenant.plan_code, accountId);
      const test = await this.connections.lockForTenant(trx, tenantId, "test");
      const live = await this.connections.lockForTenant(trx, tenantId, "live");
      const payment = livePaymentPlan(test, live);
      const payoutAccountStatus =
        payment.mode === "velexis"
          ? await this.connections.payoutAccountStatusForShare(trx, tenantId)
          : undefined;
      const missing = missingPreconditions({ ...facts, payment, payoutAccountStatus });
      if (missing.length > 0) {
        throw new AppError("LIVE_PRECONDITIONS_UNMET", { details: { missing } });
      }

      const now = this.clock.now();
      if (!(await this.tenants.switchToLive(trx, tenantId, accountId, now))) {
        // The row is locked, `active` and `test` (above): an update that finds nothing is a bug, never an answer.
        throw new Error("goLive: the locked tenant was not switched to live");
      }
      const connection = await this.liveConnection(trx, tenantId, accountId, payment, test, live, now);
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: accountId,
        action: "tenant.went_live",
        targetType: "tenant",
        targetId: tenantId,
        tenantId,
        before: { storefrontEnvironment: tenant.storefront_environment },
        after: { storefrontEnvironment: "live", liveEnabledAt: now.toISOString() },
        details: {
          paymentMode: connection.accountMode,
          paymentConnectionId: connection.id,
          paymentConnectionCreated: connection.created,
        },
      });
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "tenant", id: tenantId });
      this.invalidations.publishAfterCommit(trx, { v: 1, type: "connection", tenantId });
      return this.answer(trx, membership);
    });
  }

  /**
   * The live payment connection after the switch (step 3 of the file header): the one the OTA has, or the copy of the
   * test one that `payment.write` names, inserted in `trx` with the test one's statement descriptor suffix.
   */
  private async liveConnection(
    trx: PlatformTransaction,
    tenantId: string,
    accountId: string,
    payment: LivePaymentPlan,
    test: PaymentConnectionView | undefined,
    live: PaymentConnectionView | undefined,
    now: Date,
  ): Promise<LiveConnectionOutcome> {
    if (live !== undefined) {
      return { id: live.id, accountMode: live.account_mode, created: false };
    }
    if (test === undefined || payment.write === "none") {
      // Unreachable once `payments_live` is met: a usable mode without a live connection always has a write.
      throw new Error("goLive: no live payment connection to keep or create");
    }
    const id = this.ids.new("ppc");
    const statementDescriptorSuffix = test.statement_descriptor_suffix;
    if (payment.write === "insert_velexis") {
      const inserted = await this.connections.insertVelexisIfAbsent(trx, {
        id,
        tenantId,
        environment: "live",
        statementDescriptorSuffix,
        createdByAccountId: accountId,
        now,
      });
      if (inserted === undefined) {
        // Every writer of a live connection holds the tenant's row (locked here) first, so none can appear meanwhile.
        throw new Error("goLive: a live payment connection appeared while the tenant was locked");
      }
      return { id: inserted.id, accountMode: inserted.account_mode, created: true };
    }
    if (test.account_reference === null) {
      // `payment_provider_connections_mode_ck` gives every `connect_standard` connection its `acct_…`.
      throw new Error("goLive: a connect_standard test connection without its account");
    }
    const copied = await this.connections.insertConnectStandard(trx, {
      id,
      tenantId,
      environment: "live",
      statementDescriptorSuffix,
      accountReference: test.account_reference,
      capabilities: storedConnectCapabilities(test.capabilities),
      status: "active",
      connectedByAccountId: test.created_by_account_id ?? accountId,
      connectedAt: test.connected_at ?? now,
      now,
    });
    return { id: copied.id, accountMode: copied.account_mode, created: true };
  }

  /** The tenant as stored now in `trx`, as the member of `membership` sees it. */
  private async answer(trx: PlatformTransaction, membership: TenantMembership): Promise<Tenant> {
    const row = await this.tenants.findWithHost(membership.tenantId, trx);
    if (row === undefined) {
      throw new AppError("NOT_FOUND");
    }
    return toTenant(row, membership.role, this.baseDomain);
  }
}
