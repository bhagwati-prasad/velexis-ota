// The platform admin's view of the Stripe webhook inbox (PBE-048; platform/docs/api-inventory-admin.md §4,
// subscription-billing flow §C and "Failure handling", PADR-0002 item 4, scope PF-89): `adminListStripeEvents` and
// `adminReprocessStripeEvent`, over `platform.stripe_events` (CommonModule's inbox, stripe-events.repository.ts) and
// the `platform-stripe-events` queue. Who may call them is AdminAuthGuard's (`platform_admin`).
//
// - The list holds the events of both receivers: `failed` and `ignored` first, each group newest first (`receivedAt`),
//   then the others, with the filters `status`, `type` (exact) and `tenantId` and an opaque cursor of the last event's
//   id (`400 VALIDATION_FAILED`, `/query/cursor`, for any other value). `lastError` is the inbox's short message without
//   secrets; the payload is never stored. A read of ids and states: no audit row (the audit rule of 2026-10-21).
// - The reprocessing takes a `failed` or `ignored` event (any other status answers `409 CONFLICT` with the status in
//   `details.reason`: `processing`, `received` or `processed`) back to `received` with its attempts and last error
//   kept, and writes one `stripe_event.reprocessed` audit row (actor `platform_admin`; the status before and after, the
//   endpoint, type and attempts), in one transaction that locks the inbox row. After the commit it queues
//   `stripe.event` again (job id = the event id): BullMQ keeps the event's earlier job once it failed or completed and
//   ignores a new job with an id it still holds, so that job is removed first; a retryable failure's delayed job is
//   replaced the same way, so the event runs now. A job a worker holds (`active`) cannot be removed and is left to claim
//   the `received` row. When the removal or the enqueue fails (Redis down or slower than REQUEUE_TIMEOUT_MS) the answer
//   is still `202`: the `stripe_events.sweep` scheduler queues a `received` event within minutes, a finished job of it
//   counting as missing (stripe-events-sweep.scheduler.ts). Log lines carry ids only.
//
// The event's handler re-fetches its object from Stripe, so a price linked to a plan after an `UNKNOWN_PRICE` failure,
// or a subscription row written since an invoice event failed, is seen by the new attempt.
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { components } from "@velexis/api-types/platform";
import { AppError } from "@velexis/errors";
import type { Queue } from "bullmq";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { AuditService } from "../audit/audit.service";
import type { AccessTokenClaims } from "../auth/token.service";
import {
  DEFAULT_SUBSCRIPTION_PAGE_LIMIT,
  decodeIdCursor,
  encodeIdCursor,
  invalidCursor,
  toAdminStripeEvent,
} from "../billing/subscriptions.service";
import { Clock } from "../common/clock";
import { PLATFORM_DB, type PlatformDb } from "../common/database";
import { PLATFORM_QUEUE } from "../common/queues/queue-names";
import { runInTransaction } from "../common/redis/invalidation.publisher";
import {
  REPROCESSABLE_STATUSES,
  StripeEventsRepository,
  type StripeEventRecord,
} from "../common/stripe/stripe-events.repository";
import { addStripeEventJob, STRIPE_EVENT_ID } from "../common/stripe/stripe-inbox.service";

export type AdminStripeEventList = components["schemas"]["AdminStripeEventList"];
type AdminStripeEvent = components["schemas"]["AdminStripeEvent"];

/** The query of `adminListStripeEvents`, as the validation interceptor coerced it (`limit` defaults to 50). */
export interface ListStripeEventsQuery {
  readonly status?: AdminStripeEvent["status"] | undefined;
  readonly type?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** How long the request waits for Redis to replace the event's job before it answers anyway (file header). */
export const REQUEUE_TIMEOUT_MS = 3000;

/** The id of a cursor of the admin's inbox list, or `undefined` when it is not one. */
export function decodeStripeEventCursor(cursor: string): string | undefined {
  return decodeIdCursor(cursor, STRIPE_EVENT_ID);
}

@Injectable()
export class AdminStripeEventsService {
  constructor(
    private readonly events: StripeEventsRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @InjectQueue(PLATFORM_QUEUE.stripeEvents) private readonly queue: Queue,
    @Inject(PLATFORM_DB) private readonly db: PlatformDb,
    @InjectPinoLogger(AdminStripeEventsService.name) private readonly logger: PinoLogger,
  ) {}

  /** adminListStripeEvents: one page of the inbox, failed and ignored events first (file header). */
  async list(query: ListStripeEventsQuery): Promise<AdminStripeEventList> {
    const limit = query.limit ?? DEFAULT_SUBSCRIPTION_PAGE_LIMIT;
    let afterId: string | undefined;
    if (query.cursor !== undefined) {
      afterId = decodeStripeEventCursor(query.cursor);
      if (afterId === undefined || (await this.events.find(this.db, afterId)) === undefined) {
        throw invalidCursor();
      }
    }
    const rows = await this.events.listAdmin(
      this.db,
      { status: query.status, type: query.type, tenantId: query.tenantId },
      afterId,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(toAdminStripeEvent),
      page: { nextCursor: rows.length > limit && last !== undefined ? encodeIdCursor(last.id) : null, limit },
    };
  }

  /**
   * adminReprocessStripeEvent: the `failed` or `ignored` event `eventId` back to `received`, audited, then queued again
   * (file header). `404` for an event the inbox lacks, `409` for one in another status.
   */
  async reprocess(claims: Pick<AccessTokenClaims, "sub">, eventId: string): Promise<void> {
    const now = this.clock.now();
    const before = await runInTransaction(this.db, async (trx): Promise<StripeEventRecord> => {
      const row = await this.events.lockForReprocess(trx, eventId);
      if (row === undefined) {
        throw new AppError("NOT_FOUND");
      }
      if (!REPROCESSABLE_STATUSES.has(row.status) || !(await this.events.reopen(trx, eventId, now))) {
        throw new AppError("CONFLICT", { details: { reason: row.status } });
      }
      await this.audit.record(trx, {
        actorType: "platform_admin",
        actorAccountId: claims.sub,
        action: "stripe_event.reprocessed",
        targetType: "stripe_event",
        targetId: eventId,
        ...(row.tenant_id === null ? {} : { tenantId: row.tenant_id }),
        before: { status: row.status },
        after: { status: "received" },
        details: { endpoint: row.endpoint, type: row.type, attempts: row.attempts },
      });
      return row;
    });
    this.logger.info(
      { eventId, eventType: before.type, endpoint: before.endpoint, statusBefore: before.status },
      "stripe.event_reprocess_requested",
    );
    await this.requeue(eventId);
  }

  /** Replaces the event's BullMQ job by a new one (file header); never throws. */
  private async requeue(eventId: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout("timeout"), REQUEUE_TIMEOUT_MS);
    });
    const replaced = this.replaceJob(eventId).catch((error: unknown) => {
      this.logger.warn({ eventId, err: error }, "stripe.event_reprocess_enqueue_failed");
      return "failed" as const;
    });
    try {
      if ((await Promise.race([replaced, timedOut])) === "timeout") {
        this.logger.warn({ eventId, timeoutMs: REQUEUE_TIMEOUT_MS }, "stripe.event_reprocess_enqueue_failed");
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Removes the event's earlier job, unless a worker holds it, and queues a new one. */
  private async replaceJob(eventId: string): Promise<"queued" | "held"> {
    const existing = await this.queue.getJob(eventId);
    if (existing !== undefined) {
      try {
        await existing.remove();
      } catch (error) {
        // A worker holds it (active): that attempt claims the `received` row; the sweep looks again later.
        this.logger.info({ eventId, err: error }, "stripe.event_reprocess_job_held");
        return "held";
      }
    }
    await addStripeEventJob(this.queue, eventId);
    return "queued";
  }
}
