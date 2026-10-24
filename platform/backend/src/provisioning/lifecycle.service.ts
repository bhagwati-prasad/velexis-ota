// The tenant lifecycle use cases (platform/docs/architecture.md §2.1: ProvisioningModule, layer 2; PADR-0001). PBE-018
// brings `createTenant` (platform/docs/flows/signup-and-create-ota.md steps 5 to 7, scope PF-10 and PF-40): the checks,
// then one transaction that writes the six rows of a new OTA; PBE-019 dispatches its job after the commit. PBE-023
// brings the setup progress, the owner's retry and the one-time reveal of the initial test keys (below); suspend,
// resume, migrate and go-live (later tasks) follow.
//
// createTenant, in order:
//
// 1. The plan. Before M5 (`FEATURE_STRIPE_BILLING` off) it is always `early_access`, whatever the request says
//    (ADR-0013 point 4). With the switch on (PBE-044) it is the request's `planCode` (required, `400`) with its
//    `billingInterval` (`month` when absent): a public, active plan with a Stripe Price for the interval (`422
//    PLAN_NOT_AVAILABLE`, CheckoutService.planFor).
// 2. The country, currency and time zone must be values of the reference data (`400 VALIDATION_FAILED`, field errors
//    that never echo the value), as `updateTenant` checks them; the key's pattern was checked by the schema.
// 3. One transaction (`runInTransaction`):
//    - the account's row is locked (`FOR UPDATE`): it must be verified and `active` (`403 EMAIL_NOT_VERIFIED`), and two
//      creations of one account run one after the other, so the tenant limit below holds under concurrency;
//    - the key must be neither reserved nor used by any tenant row in any status (`409 TENANT_KEY_UNAVAILABLE`);
//    - the account must own fewer than `MAX_TENANTS_PER_ACCOUNT` OTAs that are not `failed` (`422 UNPROCESSABLE`,
//      `details.reason = "tenant_limit"`);
//    - then the tenant (`provisioning`, storefront `test`, `created_by_account_id`, the plan of step 1), the owner
//      membership, the subscription, the verified primary sub-domain `<key>.<STOREFRONT_BASE_DOMAIN>`, the `provision`
//      job (`queued`, 5 attempts) and the audit row `tenant.created`. The subscription is the manual trial before M5
//      (`trialing`, `manual`, `trial_ends_at = now + plans.trial_days`) and from M5 the `incomplete` Stripe row
//      (`billing_provider = 'stripe'`, the plan and interval, no trial end).
//    Any error rolls all of it back. A key taken by a concurrent creation between the check and the insert fails on
//    the unique index, which also answers `409 TENANT_KEY_UNAVAILABLE`.
// 4. After the commit, before M5, the job is dispatched (dispatcher.ts, PBE-019): the gate is open, so it becomes
//    `running` (attempt 1) and `tenant.provision` goes to the OTA worker. The OTA exists once the transaction has
//    committed, so a failed dispatch never fails the call: it is logged (`provisioning.dispatch_failed`) and the job
//    stays `queued` for the reconciler (PBE-023). An error answer here would make the portal retry, and the retry
//    would find the key taken by this very OTA.
//    From M5 nothing is dispatched: the gate stays closed while the subscription is `incomplete`, and the
//    `checkout.session.completed` webhook dispatches the job (PBE-045), so the OTA stays `provisioning` until then.
//    The Checkout starts instead (CheckoutService.start: the Stripe Customer, the Checkout Session with Stripe's
//    idempotency key `checkout:<tenantId>:<Idempotency-Key>`, its id stored on the `incomplete` row). It never fails
//    the call either: when Stripe (or anything after the commit) fails, it is logged (`billing.checkout_failed`), the
//    OTA and its job stay as committed, and the answer carries `checkoutUrl: null` and `checkoutError` (`code`
//    `PROVIDER_ERROR` for Stripe, `INTERNAL_ERROR` otherwise); the setup page continues with createCheckoutSession.
// 5. The answer is `202 {tenant, provisioningJob {id, status}, checkoutUrl}`, with the job's status after the dispatch:
//    `running`, or `queued` when it did not go out (always `queued` from M5); `checkoutUrl` is `null` before M5.
//
// The operation is idempotent through the global IdempotencyInterceptor (`x-idempotent: true`, PBE-009): a retry with
// the same `Idempotency-Key` and body gets the stored `202` without running this again, and while Redis is down the
// interceptor answers `503` before this service runs.
//
// The setup page (PBE-023; flows/provisioning.md §4 and "Failure handling", scope PF-11). TenantRoleGuard has checked
// the caller's membership and role before each of these runs (`404` for non-members):
//
// - `getProvisioning` (any member): the tenant's status and its latest `provision` job (the active one, else the
//   newest): status, current step, the step log of the OTA worker and the post-steps, attempts, the last error, and
//   `initialKeysAvailable`, true while the keys of a succeeded job wait for their reveal (`revealState`). It writes
//   nothing.
// - `retryProvisioning` (owners): one transaction locks the tenant's row; only a `failed` tenant may be retried (`409
//   PROVISIONING_NOT_RETRYABLE`, also when a `provision` job is active already, the partial unique index). The tenant
//   goes back to `provisioning` (`version + 1`), a **new** `provision` job is queued (the failed ones stay as history)
//   and `provisioning_job.retried` is audited. After the commit the job is dispatched as createTenant's is (never
//   failing the call; the reconciler takes a job left `queued`), and the answer is `202 {job, checkoutUrl: null}`
//   with the job as it is then.
//   From M5 (PBE-044) a tenant failed by an abandoned Checkout (no current subscription, the newest one a Stripe row
//   `incomplete_expired`, billing flow §H) gets a new `incomplete` Stripe row with the same plan and interval in the
//   same transaction, and a pending `incomplete` row is reused. Its job is not dispatched (the gate is closed until the
//   webhook); a new Checkout starts instead (Stripe idempotency key `checkout:<tenantId>:<new job id>`) and the answer
//   carries its `checkoutUrl`. A plan that is no longer available or a Stripe failure is logged
//   (`billing.checkout_failed`) and answers `checkoutUrl: null`: the owner continues with createCheckoutSession.
// - `revealInitialKeys` (owners): one transaction locks the latest `provision` job. Its keys are revealed only once its
//   setup succeeded and within REVEAL_WINDOW_MS (24 hours) after it finished: the ciphertext is decrypted (associated
//   data of `revealPlace`) and, in the same update, `revealed_at` and `revealed_by_account_id` are set and the
//   ciphertext and its KEK id erased; `tenant.initial_keys_revealed` is audited with the key ids and prefixes, never
//   the keys. The keys are returned after the commit only. Afterwards, or once the window has passed (purged or not),
//   the answer is `410 KEYS_ALREADY_REVEALED`; before the setup has issued its keys there is nothing to reveal (`404
//   NOT_FOUND`). The controller sends the answer with `Cache-Control: no-store`; nothing logs it.
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { components } from "@velexis/api-types/platform";
import { AppError, type FieldError } from "@velexis/errors";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { PlatformTransaction } from "../audit/audit.repository";
import { AuditService } from "../audit/audit.service";
import { AccountsRepository } from "../auth/accounts.repository";
import {
  CheckoutService,
  pendingCheckoutRowOf,
  type BillingInterval,
  type CheckoutPlan,
} from "../billing/checkout.service";
import { SubscriptionsRepository } from "../billing/subscriptions.repository";
import type { TenantMembership, TenantStatus } from "../common/auth/tenant-role.guard";
import { Clock } from "../common/clock";
import { EnvelopeService } from "../common/crypto.provider";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { FeatureSwitches } from "../common/features";
import { IdGenerator } from "../common/ids";
import { runInTransaction } from "../common/redis/invalidation.publisher";
import type { PlatformBackendConfig } from "../config";
import { DomainsRepository, HOSTNAME_UNIQUE_INDEX } from "../domains/domains.repository";
import { MembershipsRepository } from "../memberships/memberships.repository";
import { isReservedTenantKey, storefrontHost } from "../tenants/tenant-key";
import { TENANT_KEY_CONSTRAINTS, TenantsRepository } from "../tenants/tenants.repository";
import { toTenant } from "../tenants/tenants.service";
import { ProvisioningDispatcher } from "./dispatcher";
import { revealPlace, type InitialKeys } from "./post-steps/issue-api-keys.step";
import { stepLog } from "./post-steps/post-steps.runner";
import {
  MAX_JOB_ERROR_LENGTH,
  ProvisioningJobsRepository,
  type ProgressJobRow,
  type ProvisioningJobStatus,
  type RevealJobRow,
} from "./provisioning-jobs.repository";
import { REVEAL_WINDOW_MS } from "./purge-reveals.scheduler";

export type CreateTenantRequest = components["schemas"]["CreateTenantRequest"];
export type TenantCreated = components["schemas"]["TenantCreated"];
export type ProvisioningStatus = components["schemas"]["ProvisioningStatus"];
export type ProvisioningRetried = components["schemas"]["ProvisioningRetried"];
export type ProvisioningJob = components["schemas"]["ProvisioningJob"];
export type CheckoutError = components["schemas"]["CheckoutError"];
export type { InitialKeys };

/** The plan of every OTA created before M5 (ADR-0013 point 4; seeded by migration 0002). */
export const PRE_M5_PLAN_CODE = "early_access";

/** The billing interval of an OTA created from M5 whose request names none. */
export const DEFAULT_BILLING_INTERVAL: BillingInterval = "month";

/** The message of `checkoutError`: safe to show, and it says how to go on. */
export const CHECKOUT_ERROR_MESSAGE =
  "The payment page could not be opened; continue to payment from the setup page.";

/**
 * The `checkoutError` of createTenant for an error thrown after the commit (step 4 of the file header): the code of an
 * AppError (`PROVIDER_ERROR` for Stripe), else `INTERNAL_ERROR`; never the error's own message.
 */
export function checkoutErrorOf(error: unknown): CheckoutError {
  return { code: error instanceof AppError ? error.code : "INTERNAL_ERROR", message: CHECKOUT_ERROR_MESSAGE };
}

/** A Checkout that a retry starts after its commit: the `incomplete` row and the plan it is for. */
interface RetryCheckout {
  readonly subscriptionId: string;
  readonly planCode: string;
  readonly interval: BillingInterval;
}

/** What createTenant's transaction gives back: the answer before the dispatch, and the subscription it wrote. */
interface CreatedOta {
  readonly created: TenantCreated;
  readonly subscriptionId: string;
}

/** PostgreSQL's SQLSTATE of a unique violation. */
const UNIQUE_VIOLATION = "23505";

/** The unique constraints a new OTA's key can break: the key, the schema name and the sub-domain derived from it. */
const KEY_CONFLICT_CONSTRAINTS: ReadonlySet<string> = new Set([
  ...TENANT_KEY_CONSTRAINTS,
  HOSTNAME_UNIQUE_INDEX,
]);

/**
 * True when `error` is the unique violation of a key that a concurrent creation took between the check and the insert
 * (the `pg` error that Kysely passes through, with the name of the constraint).
 */
function isKeyConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return (
    code === UNIQUE_VIOLATION && typeof constraint === "string" && KEY_CONFLICT_CONSTRAINTS.has(constraint)
  );
}

/** The unique index that allows one active job of each kind per tenant (migration 0001). */
const ACTIVE_JOB_UNIQUE_INDEX = "provisioning_jobs_active_uq";

/** True when `error` is the unique violation of a second active `provision` job of the tenant. */
function isActiveJobConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && constraint === ACTIVE_JOB_UNIQUE_INDEX;
}

/** Where the initial keys of a `provision` job stand at `now` (see the file header). */
export type RevealState = "available" | "gone" | "not_ready";

/**
 * `available` while a succeeded job holds its unrevealed ciphertext and fewer than REVEAL_WINDOW_MS have passed since it
 * finished; `gone` once revealed, purged or past the window; `not_ready` before the setup has issued its keys (the job
 * is not `succeeded`, or never kept any).
 */
export function revealState(
  job: Pick<RevealJobRow, "status" | "finished_at" | "revealed_at"> & { readonly hasCiphertext: boolean },
  now: Date,
): RevealState {
  if (job.revealed_at !== null) {
    return "gone";
  }
  if (job.status !== "succeeded" || job.finished_at === null) {
    return "not_ready";
  }
  if (!job.hasCiphertext || now.getTime() >= job.finished_at.getTime() + REVEAL_WINDOW_MS) {
    return "gone";
  }
  return "available";
}

/** The `ProvisioningJob` of the API for a job row: the step log in the schema's shape, the error at most 1,000 long. */
export function toProvisioningJob(row: ProgressJobRow): ProvisioningJob {
  return {
    id: row.id,
    kind: row.kind as ProvisioningJob["kind"],
    status: row.status,
    step: row.step,
    steps: stepLog(row.steps).map((entry) => ({
      step: entry.step,
      status: entry.status,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      ...(entry.error === undefined
        ? {}
        : { error: { code: entry.error.code, message: entry.error.message } }),
    })),
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    error: row.error === null ? null : row.error.slice(0, MAX_JOB_ERROR_LENGTH),
  };
}

/** The keys of a decrypted reveal, checked for the shape the reveal answers (`InitialKeys`). */
function initialKeysOf(value: unknown): InitialKeys {
  const keys: unknown =
    typeof value === "object" && value !== null ? (value as { keys?: unknown }).keys : undefined;
  if (
    !Array.isArray(keys) ||
    keys.length === 0 ||
    !keys.every(
      (key) =>
        typeof key === "object" &&
        key !== null &&
        ["id", "kind", "environment", "prefix", "key"].every(
          (field) => typeof (key as Record<string, unknown>)[field] === "string",
        ),
    )
  ) {
    // Never the value: it holds the keys.
    throw new Error("revealInitialKeys: the decrypted reveal is not an InitialKeys value");
  }
  const checked = keys as InitialKeys["keys"];
  return {
    keys: checked.map(({ id, kind, environment, prefix, key }) => ({ id, kind, environment, prefix, key })),
  };
}

/** `409 TENANT_KEY_UNAVAILABLE`: reserved, used by a tenant row, or taken meanwhile; the answer never says which. */
function keyUnavailable(cause?: unknown): AppError {
  return new AppError("TENANT_KEY_UNAVAILABLE", cause === undefined ? {} : { cause });
}

@Injectable()
export class LifecycleService {
  private readonly baseDomain: string;
  private readonly maxTenantsPerAccount: number;

  constructor(
    private readonly accounts: AccountsRepository,
    private readonly tenants: TenantsRepository,
    private readonly memberships: MembershipsRepository,
    private readonly subscriptions: SubscriptionsRepository,
    private readonly checkout: CheckoutService,
    private readonly domains: DomainsRepository,
    private readonly jobs: ProvisioningJobsRepository,
    private readonly dispatcher: ProvisioningDispatcher,
    private readonly audit: AuditService,
    private readonly envelope: EnvelopeService,
    private readonly features: FeatureSwitches,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(LifecycleService.name) private readonly logger: PinoLogger,
    config: ConfigService<PlatformBackendConfig, true>,
  ) {
    this.baseDomain = config.get("STOREFRONT_BASE_DOMAIN", { infer: true });
    this.maxTenantsPerAccount = config.get("MAX_TENANTS_PER_ACCOUNT", { infer: true });
  }

  /**
   * createTenant for the account `accountId` (see the file header); `requestKey` is the request's `Idempotency-Key`,
   * part of Stripe's idempotency key of the Checkout (M5).
   */
  async createTenant(
    accountId: string,
    request: CreateTenantRequest,
    requestKey: string,
  ): Promise<TenantCreated> {
    const stripeBilling = this.features.isEnabled("stripe_billing");
    await this.checkReferences(request, stripeBilling);
    const plan =
      stripeBilling && request.planCode !== undefined
        ? await this.checkout.planFor(request.planCode, request.billingInterval ?? DEFAULT_BILLING_INTERVAL)
        : undefined;
    let ota: CreatedOta;
    try {
      ota = await runInTransaction(this.db, (trx) => this.create(trx, accountId, request, plan));
    } catch (error) {
      if (isKeyConflict(error)) {
        throw keyUnavailable(error);
      }
      throw error;
    }
    const { created, subscriptionId } = ota;
    if (plan === undefined) {
      const status = await this.dispatchAfterCreate(created);
      return { ...created, provisioningJob: { ...created.provisioningJob, status } };
    }
    // From M5 the gate stays closed until the Checkout webhook (PBE-045): no dispatch, the Checkout instead.
    try {
      const session = await this.checkout.start({
        tenantId: created.tenant.id,
        accountId,
        plan,
        subscriptionId,
        requestKey,
      });
      return { ...created, checkoutUrl: session.url };
    } catch (error) {
      this.logger.warn(
        { tenantId: created.tenant.id, subscriptionId, err: error },
        "billing.checkout_failed",
      );
      return { ...created, checkoutUrl: null, checkoutError: checkoutErrorOf(error) };
    }
  }

  /** getProvisioning for the caller's membership (see the file header). */
  async getProvisioning(membership: TenantMembership): Promise<ProvisioningStatus> {
    const [tenant, job] = await Promise.all([
      this.tenants.findWithHost(membership.tenantId),
      this.jobs.latestProvisionJob(membership.tenantId),
    ]);
    if (tenant === undefined || job === undefined) {
      throw new AppError("NOT_FOUND");
    }
    const keys = revealState({ ...job, hasCiphertext: job.reveal_pending }, this.clock.now());
    return {
      tenantStatus: tenant.status as TenantStatus,
      job: toProvisioningJob(job),
      initialKeysAvailable: keys === "available",
    };
  }

  /** retryProvisioning by an owner (see the file header). */
  async retryProvisioning(membership: TenantMembership): Promise<ProvisioningRetried> {
    const { tenantId, accountId } = membership;
    const stripeBilling = this.features.isEnabled("stripe_billing");
    let retried: { readonly jobId: string; readonly checkout: RetryCheckout | null };
    try {
      retried = await runInTransaction(this.db, async (trx) => {
        const tenant = await this.tenants.lockForUpdate(trx, tenantId);
        if (tenant === undefined) {
          throw new AppError("NOT_FOUND");
        }
        const previous = await this.jobs.latestProvisionJob(tenantId, trx);
        const now = this.clock.now();
        if (tenant.status !== "failed" || !(await this.tenants.reopenFailed(trx, tenantId, now))) {
          throw new AppError("PROVISIONING_NOT_RETRYABLE", { details: { status: tenant.status } });
        }
        const checkout = stripeBilling ? await this.reopenCheckout(trx, tenantId, now) : null;
        const job = await this.jobs.insertQueued(trx, {
          id: this.ids.new("job"),
          tenantId,
          kind: "provision",
          requestedByAccountId: accountId,
          now,
        });
        await this.audit.record(trx, {
          actorType: "account",
          actorAccountId: accountId,
          action: "provisioning_job.retried",
          targetType: "provisioning_job",
          targetId: job.id,
          tenantId,
          tenantKey: tenant.key,
          before: { tenantStatus: "failed" },
          after: { tenantStatus: "provisioning" },
          details: {
            kind: "provision",
            ...(previous === undefined ? {} : { previousJobId: previous.id, previousError: previous.error }),
            ...(checkout === null ? {} : { awaitingCheckout: true, subscriptionId: checkout.subscriptionId }),
          },
        });
        return { jobId: job.id, checkout };
      });
    } catch (error) {
      if (isActiveJobConflict(error)) {
        throw new AppError("PROVISIONING_NOT_RETRYABLE", { cause: error, details: { reason: "job_active" } });
      }
      throw error;
    }
    const { jobId, checkout } = retried;
    let checkoutUrl: string | null = null;
    if (checkout === null) {
      await this.dispatchQuietly(jobId, tenantId);
    } else {
      checkoutUrl = await this.checkoutAfterRetry(membership, jobId, checkout);
    }
    const job = await this.jobs.findProgress(jobId);
    if (job === undefined) {
      throw new Error("retryProvisioning: the job written in this request cannot be read back");
    }
    return { job: toProvisioningJob(job), checkoutUrl };
  }

  /** revealInitialKeys by an owner (see the file header); the keys leave this method only after the commit. */
  async revealInitialKeys(membership: TenantMembership): Promise<InitialKeys> {
    const { tenantId, accountId } = membership;
    return runInTransaction(this.db, async (trx) => {
      const now = this.clock.now();
      const job = await this.jobs.lockForReveal(trx, tenantId);
      if (job === undefined) {
        throw new AppError("NOT_FOUND");
      }
      const state = revealState({ ...job, hasCiphertext: job.reveal_ciphertext !== null }, now);
      if (state === "not_ready") {
        throw new AppError("NOT_FOUND");
      }
      if (state === "gone" || job.reveal_ciphertext === null) {
        throw new AppError("KEYS_ALREADY_REVEALED");
      }
      const keys = initialKeysOf(await this.envelope.decryptJson(job.reveal_ciphertext, revealPlace(job.id)));
      if (!(await this.jobs.markRevealed(trx, { jobId: job.id, accountId, now }))) {
        throw new AppError("KEYS_ALREADY_REVEALED");
      }
      await this.audit.record(trx, {
        actorType: "account",
        actorAccountId: accountId,
        action: "tenant.initial_keys_revealed",
        targetType: "tenant",
        targetId: tenantId,
        tenantId,
        details: {
          jobId: job.id,
          keys: keys.keys.map(({ id, kind, environment, prefix }) => ({ id, kind, environment, prefix })),
        },
      });
      return keys;
    });
  }

  /**
   * The Checkout a retry of `tenantId` waits for, in the retry's transaction (see `retryProvisioning` in the file
   * header): a pending `incomplete` Stripe row is reused; without a current subscription, a newest Stripe row
   * `incomplete_expired` (an abandoned Checkout) gets a new `incomplete` row with its plan and interval. `null` when the
   * retry needs no Checkout (a manual trial, a paid Stripe subscription, or nothing to restart from).
   */
  private async reopenCheckout(
    trx: PlatformTransaction,
    tenantId: string,
    now: Date,
  ): Promise<RetryCheckout | null> {
    const current = await this.subscriptions.findCurrentForCheckout(tenantId, trx);
    if (current !== undefined) {
      const pending = pendingCheckoutRowOf(current);
      return pending === null
        ? null
        : {
            subscriptionId: pending,
            planCode: current.plan_code,
            interval: current.billing_interval as BillingInterval,
          };
    }
    const latest = await this.subscriptions.findShownForTenant(tenantId, trx);
    if (
      latest === undefined ||
      latest.billing_provider !== "stripe" ||
      latest.status !== "incomplete_expired"
    ) {
      return null;
    }
    const row = await this.subscriptions.insertIncomplete(trx, {
      id: this.ids.new("sub"),
      tenantId,
      planCode: latest.plan_code,
      billingInterval: latest.billing_interval,
      now,
    });
    return {
      subscriptionId: row.id,
      planCode: row.plan_code,
      interval: row.billing_interval as BillingInterval,
    };
  }

  /**
   * Starts the Checkout of a retry after its commit and returns its URL; `null` when the plan is no longer available
   * or Stripe fails (logged as `billing.checkout_failed`). Never rejects: the retry is committed.
   */
  private async checkoutAfterRetry(
    membership: TenantMembership,
    jobId: string,
    checkout: RetryCheckout,
  ): Promise<string | null> {
    const { tenantId, accountId } = membership;
    try {
      const plan = await this.checkout.planFor(checkout.planCode, checkout.interval);
      const session = await this.checkout.start({
        tenantId,
        accountId,
        plan,
        subscriptionId: checkout.subscriptionId,
        requestKey: jobId,
      });
      return session.url;
    } catch (error) {
      this.logger.warn(
        { tenantId, jobId, subscriptionId: checkout.subscriptionId, err: error },
        "billing.checkout_failed",
      );
      return null;
    }
  }

  /**
   * Dispatches the job of an OTA that has just been created (step 4 of the file header) and returns the job's status
   * afterwards. Never rejects: the OTA is committed, and the reconciler dispatches a job left `queued`.
   */
  private async dispatchAfterCreate(created: TenantCreated): Promise<ProvisioningJobStatus> {
    const { id: jobId, status } = created.provisioningJob;
    return (await this.dispatchQuietly(jobId, created.tenant.id)) ?? status;
  }

  /**
   * Dispatches a job queued by this request after its commit; returns its status afterwards, or `undefined` when the
   * dispatch failed (logged as `provisioning.dispatch_failed`; the reconciler dispatches a job left `queued`). Never
   * rejects.
   */
  private async dispatchQuietly(jobId: string, tenantId: string): Promise<ProvisioningJobStatus | undefined> {
    try {
      const result = await this.dispatcher.dispatch(jobId);
      return result.dispatched ? "running" : (result.status ?? undefined);
    } catch (error) {
      this.logger.warn({ jobId, tenantId, err: error }, "provisioning.dispatch_failed");
      return undefined;
    }
  }

  /**
   * The transaction of createTenant: the checks that need the database, then the six rows; the subscription is the
   * manual trial without `plan` (before M5) and the `incomplete` Stripe row of `plan` with it (M5).
   */
  private async create(
    trx: PlatformTransaction,
    accountId: string,
    request: CreateTenantRequest,
    plan: CheckoutPlan | undefined,
  ): Promise<CreatedOta> {
    const account = await this.accounts.lockForUpdate(trx, accountId);
    if (account === undefined || account.status !== "active" || account.email_verified_at === null) {
      throw new AppError("EMAIL_NOT_VERIFIED");
    }
    const { key } = request;
    if (isReservedTenantKey(key) || (await this.tenants.keyExists(key, trx))) {
      throw keyUnavailable();
    }
    const owned = await this.memberships.countOwnedTenants(trx, accountId);
    if (owned >= this.maxTenantsPerAccount) {
      throw new AppError("UNPROCESSABLE", {
        details: { reason: "tenant_limit", limit: this.maxTenantsPerAccount },
      });
    }

    const now = this.clock.now();
    const tenantId = this.ids.new("ten");
    const planCode = plan?.code ?? PRE_M5_PLAN_CODE;
    const hostname = storefrontHost(key, this.baseDomain);
    await this.tenants.insert(trx, {
      id: tenantId,
      key,
      name: request.name,
      planCode,
      countryCode: request.countryCode,
      defaultCurrency: request.defaultCurrency,
      timeZone: request.timeZone,
      createdByAccountId: accountId,
      now,
    });
    await this.memberships.insertOwner(trx, { id: this.ids.new("stf"), tenantId, accountId, now });
    const subscriptionId = this.ids.new("sub");
    const subscription =
      plan === undefined
        ? await this.subscriptions.insertManualTrial(trx, { id: subscriptionId, tenantId, planCode, now })
        : await this.subscriptions.insertIncomplete(trx, {
            id: subscriptionId,
            tenantId,
            planCode,
            billingInterval: plan.interval,
            now,
          });
    await this.domains.insertSubdomain(trx, { id: this.ids.new("dom"), tenantId, hostname, now });
    const job = await this.jobs.insertQueued(trx, {
      id: this.ids.new("job"),
      tenantId,
      kind: "provision",
      requestedByAccountId: accountId,
      now,
    });
    await this.audit.record(trx, {
      actorType: "account",
      actorAccountId: accountId,
      action: "tenant.created",
      targetType: "tenant",
      targetId: tenantId,
      tenantId,
      tenantKey: key,
      after: {
        key,
        name: request.name,
        status: "provisioning",
        planCode,
        countryCode: request.countryCode,
        defaultCurrency: request.defaultCurrency,
        timeZone: request.timeZone,
        storefrontEnvironment: "test",
        primaryHost: hostname,
      },
      details: {
        provisioningJobId: job.id,
        subscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
        billingProvider: subscription.billing_provider,
        ...(plan === undefined ? {} : { billingInterval: plan.interval }),
      },
    });

    const row = await this.tenants.findWithHost(tenantId, trx);
    if (row === undefined) {
      throw new Error("createTenant: the tenant row written in this transaction cannot be read back");
    }
    return {
      created: {
        tenant: toTenant(row, "owner", this.baseDomain),
        provisioningJob: { id: job.id, status: job.status },
        checkoutUrl: null,
      },
      subscriptionId: subscription.id,
    };
  }

  /**
   * The checks of the request that the schema cannot make: the country, the currency and the time zone must be values
   * of `reference.countries`, `reference.currencies` and `reference.time_zones`, by value and stored as sent (the OTA
   * worker copies them into the tenant's settings, which are checked against the same tables), and from M5
   * (`stripeBilling`) the request must name its plan. Problems answer `400 VALIDATION_FAILED` with field errors that
   * never echo the value.
   */
  private async checkReferences(request: CreateTenantRequest, stripeBilling: boolean): Promise<void> {
    const [country, currency, timeZone] = await Promise.all([
      this.tenants.countryExists(request.countryCode),
      this.tenants.currencyExists(request.defaultCurrency),
      this.tenants.timeZoneExists(request.timeZone),
    ]);
    const fieldErrors: FieldError[] = [];
    if (!country) {
      fieldErrors.push({
        path: "/countryCode",
        code: "unknown",
        message: "Must be a known ISO 3166-1 alpha-2 country code.",
      });
    }
    if (!currency) {
      fieldErrors.push({
        path: "/defaultCurrency",
        code: "unknown",
        message: "Must be a known ISO 4217 currency code.",
      });
    }
    if (!timeZone) {
      fieldErrors.push({
        path: "/timeZone",
        code: "unknown",
        message: "Must be an IANA time zone of the reference data.",
      });
    }
    if (stripeBilling && request.planCode === undefined) {
      fieldErrors.push({
        path: "/planCode",
        code: "required",
        message: "Choose the plan to subscribe to.",
      });
    }
    if (fieldErrors.length > 0) {
      throw new AppError("VALIDATION_FAILED", { fieldErrors });
    }
  }
}
