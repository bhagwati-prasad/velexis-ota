// The OTA worker's housekeeping for `tenant.suspend` and `tenant.resume` (OBE-074; PADR-0014 items 3, 4 and 7,
// OADR-0007 point 8, tenant provisioning flow §3 and §6). The platform has already switched `platform.tenants.status`,
// which stops the OTA's traffic within 60 s (the tenant cache, OADR-0009); these messages only clean up. Both handlers
// act on the current state, never on the message: they re-read the tenant past the cache (`PlatformReadRepository`),
// and a message that no longer matches it (a suspension of a tenant that is active again, a resume of one that is
// suspended again, a tenant that is gone) is a no-op that the processor still answers, so the platform marks the job
// done.
//
// `suspend`, for a tenant still `suspended`:
//
//   1. writes the staff cut-off `staffdeny:tenant:<tenantId>` = the job's now in epoch ms, for 30 days
//      (`redisKeys.staffDenyTenant`): every staff session (refresh family) created at or before it is refused by the
//      staff guard and by console.auth.refresh (identity/staff/staff-sessions.ts), even while the API's cached tenant
//      row is still `active`; new sign-ins are refused by the sign-in's own read of the tenant (`TENANT_SUSPENDED`);
//   2. expires the tenant's `open` and `payment_pending` checkouts, whatever their `expires_at`, with the rule of
//      `checkouts.expire` (OBE-056, checkout/checkout-expiry.processor.ts): batches of 50 in id order, one tenant
//      transaction each (velexis_ota_app through `TenantTx`), locked `FOR UPDATE` (`lockOpenCheckouts`, the lock the
//      claim of checkout.complete takes, waited for). A checkout held by a booking is skipped: `pending` means
//      checkout.complete claimed it (the order is being created, or may exist after a `504 SUPPLIER_TIMEOUT`), so it
//      keeps its status and its authorisation, which only the reconciliation (OBE-043) voids or captures (OADR-0003
//      point 10). The bookings are read again after the lock (`expireLockedCheckouts`, as
//      `CheckoutService.refuseWhileCompleting` does), so a claim that commits while the suspension waits for the
//      checkout's lock is never expired;
//   3. after each batch's commit, queues `payment.void {tenantId, id}` on `ota-payments` (job id
//      `payment-void-<pay_id>`, `paymentJob`) for the voidable Stripe payments of the checkouts that batch expired
//      (`voidablePaymentsOfCheckouts`, the rule of `checkouts.expire`). An add lost after a commit (Redis, a stop) is
//      queued by the next `checkouts.expire` run, which runs for suspended tenants too and re-reads the checkouts
//      expired in the last 24 hours; BullMQ holds one job per payment under that id, so no void runs twice;
//   4. reads the tenant again: a resume that committed meanwhile (the worker runs two `ota-tenant-ops` jobs at once, so
//      its message may have deleted the cut-off before step 1 wrote it) removes the cut-off again.
//
// `resume`, for a tenant `active` again: deletes the cut-off, then reads the tenant again and writes it again (now) if
// the tenant was suspended once more meanwhile, so the cut-off always follows the latest status a handler saw.
// Schedulers need nothing: each fan-out reads the tenants' statuses when it runs (jobs/schedulers.ts), so the queue
// poller, the only schedule that skips suspended tenants (OADR-0014 point 4), picks the tenant up on its next run, and
// ticketing, sync, reconciliation, refunds, checkout expiry and the transactional e-mails never stopped.
//
// Neither handler catches: a failure (PostgreSQL, Redis) fails the job and BullMQ tries it again (the platform
// dispatches with `attempts: 3`); a repeated suspension finds the expired checkouts gone from its selection and writes
// the cut-off again. Log lines carry counts and the tenant, never an id of a checkout, payment or staff member.
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import {
  expireLockedCheckouts,
  lockOpenCheckouts,
  voidablePaymentsOfCheckouts,
} from "../checkout/checkout-expiry.processor";
import { Clock } from "../common/clock";
import { OTA_QUEUE } from "../common/queues/queue-names";
import { redisKeys } from "../common/redis/redis.keys";
import { REDIS_CLIENT } from "../common/redis/redis.module";
import { jobTenant } from "../jobs/fan-out";
import { JOB_BATCH_LIMITS } from "../jobs/limits";
import { PAYMENT_JOB, paymentJob } from "../payments/payments.processor";
import { PlatformReadRepository } from "../tenancy/platform-read.repository";
import type { PlatformTenant, TenantStatus } from "../tenancy/platform-read.types";
import { TenantContext } from "../tenancy/tenant-context";
import { TenantTx } from "../tenancy/tenant-tx";

/** The checkouts one suspension transaction locks and expires at most: the batch of `checkouts.expire`. */
export const SUSPENSION_EXPIRY_BATCH = JOB_BATCH_LIMITS.checkoutExpiry;

/** One housekeeping message: its tenant and the id its log lines and tenant context carry (the BullMQ job id). */
export interface HousekeepingRequest {
  readonly tenantId: string;
  readonly requestId: string;
}

/** A message that does not match the tenant's current state: nothing was done (PADR-0014 item 7). */
export interface HousekeepingSkipped {
  readonly status: "skipped";
  /** The tenant's current status, or `null` when no tenant has the message's id. */
  readonly tenantStatus: TenantStatus | null;
}

/** What `suspend` did: ids never, counts only. */
export type SuspendOutcome =
  | {
      readonly status: "applied";
      /** Checkouts that became `expired`. */
      readonly expired: number;
      /** Checkouts locked but held by a booking a claim committed while the suspension waited: left as they were. */
      readonly held: number;
      /** `payment.void` jobs asked for. */
      readonly voids: number;
      /** The staff cut-off is in place at the end: false when the tenant was resumed meanwhile (step 4). */
      readonly staffDenied: boolean;
    }
  | HousekeepingSkipped;

/** What `resume` did. */
export type ResumeOutcome =
  | {
      readonly status: "applied";
      /** The staff cut-off is in place at the end: true only when the tenant was suspended again meanwhile. */
      readonly staffDenied: boolean;
    }
  | HousekeepingSkipped;

/** What the suspension's expiry did over all its batches. */
interface ExpiryCounts {
  readonly expired: number;
  readonly held: number;
  readonly voids: number;
}

@Injectable()
export class HousekeepingService {
  constructor(
    private readonly platform: PlatformReadRepository,
    private readonly tenants: TenantContext,
    private readonly tx: TenantTx,
    private readonly clock: Clock,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(OTA_QUEUE.payments) private readonly payments: Queue,
  ) {}

  /** `tenant.suspend` (see the file header): a no-op unless the tenant is `suspended` now. */
  async suspend(request: HousekeepingRequest): Promise<SuspendOutcome> {
    const tenant = await this.platform.tenantById(request.tenantId);
    if (tenant === null || tenant.status !== "suspended") {
      return skipped(tenant);
    }
    const now = this.clock.now();
    await this.denyStaff(tenant.id, now);
    const counts = await this.tenants.run(
      jobTenant(tenant, { id: request.requestId, name: "tenant.suspend" }),
      () => this.expireCheckouts(tenant, now),
    );
    const current = await this.platform.tenantById(tenant.id);
    const staffDenied = current?.status === "suspended";
    if (!staffDenied) {
      await this.allowStaff(tenant.id);
    }
    return { status: "applied", ...counts, staffDenied };
  }

  /** `tenant.resume` (see the file header): a no-op unless the tenant is `active` now. */
  async resume(request: HousekeepingRequest): Promise<ResumeOutcome> {
    const tenant = await this.platform.tenantById(request.tenantId);
    if (tenant === null || tenant.status !== "active") {
      return skipped(tenant);
    }
    await this.allowStaff(tenant.id);
    const current = await this.platform.tenantById(tenant.id);
    const staffDenied = current?.status === "suspended";
    if (staffDenied) {
      await this.denyStaff(tenant.id, this.clock.now());
    }
    return { status: "applied", staffDenied };
  }

  /** Steps 2 and 3, in the tenant's context: every batch, then its voids after its commit. */
  private async expireCheckouts(tenant: PlatformTenant, now: Date): Promise<ExpiryCounts> {
    let after: string | undefined;
    let expired = 0;
    let held = 0;
    let voids = 0;
    for (;;) {
      const batch = await this.tx.run(async (trx) => {
        const locked = await lockOpenCheckouts(trx, after, SUSPENSION_EXPIRY_BATCH);
        const result = await expireLockedCheckouts(trx, locked, now);
        return { locked, ...result, voidable: await voidablePaymentsOfCheckouts(trx, result.expired) };
      });
      if (batch.voidable.length > 0) {
        // The producers' job and job id: BullMQ adds nothing for a payment whose void it holds already.
        await this.payments.addBulk(batch.voidable.map((id) => paymentJob(PAYMENT_JOB.void, tenant.id, id)));
      }
      expired += batch.expired.length;
      held += batch.held.length;
      voids += batch.voidable.length;
      const last = batch.locked.at(-1);
      if (batch.locked.length < SUSPENSION_EXPIRY_BATCH || last === undefined) {
        return { expired, held, voids };
      }
      after = last;
    }
  }

  /** Writes the staff cut-off of the tenant: `now` in epoch ms, for 30 days. */
  private async denyStaff(tenantId: string, now: Date): Promise<void> {
    const cutOff = redisKeys.staffDenyTenant(tenantId);
    await this.redis.set(cutOff.key, String(now.getTime()), "EX", cutOff.ttlSeconds);
  }

  /** Deletes the staff cut-off of the tenant. */
  private async allowStaff(tenantId: string): Promise<void> {
    const cutOff = redisKeys.staffDenyTenant(tenantId);
    await this.redis.del(cutOff.key);
  }
}

function skipped(tenant: PlatformTenant | null): HousekeepingSkipped {
  return { status: "skipped", tenantStatus: tenant === null ? null : tenant.status };
}
