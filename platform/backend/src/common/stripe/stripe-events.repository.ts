// The repository of `platform.stripe_events`, the Stripe webhook inbox (PBE-043; migration 0002, PADR-0002 item 4,
// subscription-billing flow §C and §D). CommonModule's layer owns the table (platform/docs/architecture.md §2.1): the
// billing receiver (BillingSyncModule) and the Connect account receiver (PaymentConnectionsModule, PBE-056) insert
// into it, the one `platform-stripe-events` processor moves a row through its states, and the admin reads it. A row
// holds ids, the type and the state, never the payload: the worker re-fetches the object from Stripe.
//
//   received ──claim──▶ processing ──finish──▶ processed | ignored                   (processed_at set)
//      ▲                    │
//      │                    ├──fail (more attempts due)──▶ failed, processed_at NULL  (BullMQ tries again: "retryable")
//      │                    └──fail (final)──────────────▶ failed, processed_at set   (the admin reprocesses it)
//      └── adminReprocessStripeEvent (PBE-048) puts a failed or ignored row back to received
//
// A `failed` row is retryable while its `processed_at` is NULL: an attempt failed and BullMQ holds (or should hold)
// the next one. `claim` takes such a row, a `received` one, and a `processing` one (its worker stopped during the
// attempt and BullMQ gave the job to a worker again), and always clears `processed_at`, so only a final failure leaves
// `failed` with a `processed_at`. The sweep (stripe-events-sweep.scheduler.ts) looks for `received` and retryable
// `failed` rows, and for `processing` rows left behind by an attempt that could not record its end (the worker
// stopped, or the database failed during the last attempt), as the e-mail outbox's sweep does with `sending` rows.
// Every time comes from the caller's Clock, never from the database's `now()`, so tests move time with the FakeClock.
//
// The platform admin's reads and the reprocessing (PBE-048): `listAdmin` (adminListStripeEvents) lists `failed` and
// `ignored` rows first, each group newest first, then the others, with an opaque keyset of the last row's id; `reopen`
// (adminReprocessStripeEvent) puts a `failed` or `ignored` row, locked by `lockForReprocess`, back to `received` with
// its attempts and last error kept and no `processed_at`, so the processor's `claim` takes it again.
import { Injectable } from "@nestjs/common";
import {
  sql,
  type Kysely,
  type PlatformDatabase,
  type ReferenceDatabase,
  type Selectable,
  type Transaction,
} from "@velexis/db";

type PlatformSchemas = PlatformDatabase & ReferenceDatabase;

/** Where the repository runs its statements: the process's `platformDb` or a transaction. */
export type StripeEventsExecutor = Kysely<PlatformSchemas> | Transaction<PlatformSchemas>;

/** The two receivers (the CHECK of `stripe_events.endpoint`). */
export const STRIPE_ENDPOINTS = Object.freeze(["billing", "connect_accounts"] as const);
export type StripeEndpoint = (typeof STRIPE_ENDPOINTS)[number];

/** The states of a row (the CHECK of `stripe_events.status`). */
export type StripeEventStatus = "received" | "processing" | "processed" | "ignored" | "failed";

/** A row of `platform.stripe_events`. */
export type StripeEventRecord = Selectable<PlatformDatabase["platform.stripe_events"]>;

/** The longest `last_error` the inbox keeps (the admin answers at most 1 000 characters). */
export const LAST_ERROR_MAX_LENGTH = 1000;

/** A received event: the columns of the receivers' insert (PADR-0002 item 4). */
export interface StripeEventInsert {
  readonly id: string;
  readonly endpoint: StripeEndpoint;
  readonly type: string;
  readonly livemode: boolean;
  /** The connected account of a Connect event; `null` for the Velexis account's own events. */
  readonly account: string | null;
  /** `data.object.object` (`checkout.session`, `subscription`, `invoice`, `account`, …). */
  readonly objectType: string | null;
  /** `data.object.id`, which the worker re-fetches. */
  readonly objectId: string | null;
  readonly apiVersion: string | null;
  /** The event's `created`. */
  readonly stripeCreatedAt: Date;
  /** `received_at` and `updated_at`. */
  readonly receivedAt: Date;
}

/** How an attempt ended without an error. */
export interface StripeEventFinish {
  readonly status: "processed" | "ignored";
  /** Why it was ignored; `null` for a processed event. No secret. */
  readonly lastError: string | null;
  /** The tenant the handler resolved the event to; `null` keeps what the row has. */
  readonly tenantId: string | null;
}

/** How an attempt ended with an error. */
export interface StripeEventFailureRecord {
  /** A short message without secrets (`<CODE>: …`). */
  readonly error: string;
  /** True after the last attempt (or for an error no retry can mend): `processed_at` is set. */
  readonly final: boolean;
  readonly tenantId: string | null;
}

/** What the sweep looks for. */
export interface StripeEventSweepCriteria {
  /** `received` and retryable `failed` rows last changed before this time. */
  readonly before: Date;
  /** `processing` rows last changed before this time: the attempt that claimed them never recorded its end. */
  readonly processingBefore: Date;
  readonly limit: number;
}

/** The statuses an admin may reprocess (adminReprocessStripeEvent): an event that is done without success. */
export const REPROCESSABLE_STATUSES: ReadonlySet<string> = new Set(["failed", "ignored"]);

/** The filters of the admin's list of the inbox. */
export interface StripeEventAdminFilter {
  readonly status?: string | undefined;
  readonly type?: string | undefined;
  readonly tenantId?: string | undefined;
}

/** `text` cut to LAST_ERROR_MAX_LENGTH characters. */
export function lastErrorOf(text: string): string {
  return text.length <= LAST_ERROR_MAX_LENGTH ? text : `${text.slice(0, LAST_ERROR_MAX_LENGTH - 1)}…`;
}

@Injectable()
export class StripeEventsRepository {
  /**
   * Inserts a `received` row, unless the event id is stored already (`ON CONFLICT DO NOTHING`): `true` when this call
   * inserted it. A concurrent delivery of the same event waits for this one on the primary key, so it is stored once.
   */
  async insertIfAbsent(executor: StripeEventsExecutor, row: StripeEventInsert): Promise<boolean> {
    const inserted = await executor
      .insertInto("platform.stripe_events")
      .values({
        id: row.id,
        endpoint: row.endpoint,
        type: row.type,
        livemode: row.livemode,
        account: row.account,
        object_type: row.objectType,
        object_id: row.objectId,
        api_version: row.apiVersion,
        stripe_created_at: row.stripeCreatedAt,
        status: "received",
        received_at: row.receivedAt,
        updated_at: row.receivedAt,
      })
      .onConflict((conflict) => conflict.column("id").doNothing())
      .returning("id")
      .executeTakeFirst();
    return inserted !== undefined;
  }

  /** The row, or `undefined`. */
  async find(executor: StripeEventsExecutor, id: string): Promise<StripeEventRecord | undefined> {
    return executor.selectFrom("platform.stripe_events").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /**
   * Takes a row for one processing attempt: a `received`, `processing` or retryable `failed` row becomes `processing`
   * with one more attempt and no `processed_at`. `undefined` when the row does not exist or is done (`processed`,
   * `ignored`, or `failed` for good).
   */
  async claim(executor: StripeEventsExecutor, id: string, now: Date): Promise<StripeEventRecord | undefined> {
    return executor
      .updateTable("platform.stripe_events")
      .set((eb) => ({
        status: "processing",
        attempts: eb("attempts", "+", 1),
        processed_at: null,
        updated_at: now,
      }))
      .where("id", "=", id)
      .where((eb) =>
        eb.or([
          eb("status", "in", ["received", "processing"]),
          eb.and([eb("status", "=", "failed"), eb("processed_at", "is", null)]),
        ]),
      )
      .returningAll()
      .executeTakeFirst();
  }

  /** `processing` → `processed` or `ignored`, with `processed_at`. False when the row is not `processing`. */
  async finish(
    executor: StripeEventsExecutor,
    id: string,
    finish: StripeEventFinish,
    now: Date,
  ): Promise<boolean> {
    const result = await executor
      .updateTable("platform.stripe_events")
      .set((eb) => ({
        status: finish.status,
        last_error: finish.lastError === null ? null : lastErrorOf(finish.lastError),
        tenant_id: finish.tenantId === null ? eb.ref("tenant_id") : finish.tenantId,
        processed_at: now,
        updated_at: now,
      }))
      .where("id", "=", id)
      .where("status", "=", "processing")
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * `processing` → `failed` with `last_error`: retryable (`processed_at` NULL) while BullMQ tries again, final
   * (`processed_at` set) after the last attempt. False when the row is not `processing`.
   */
  async fail(
    executor: StripeEventsExecutor,
    id: string,
    failure: StripeEventFailureRecord,
    now: Date,
  ): Promise<boolean> {
    const result = await executor
      .updateTable("platform.stripe_events")
      .set((eb) => ({
        status: "failed",
        last_error: lastErrorOf(failure.error),
        tenant_id: failure.tenantId === null ? eb.ref("tenant_id") : failure.tenantId,
        processed_at: failure.final ? now : null,
        updated_at: now,
      }))
      .where("id", "=", id)
      .where("status", "=", "processing")
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * The ids of the rows the sweep queues again, oldest first: `received` rows and retryable `failed` rows (no
   * `processed_at`) last changed before `before`, and `processing` rows last changed before `processingBefore`. The
   * inbox is small (ids and types only, processed rows purged after 90 days), so the `processing` branch needs no
   * index of its own.
   */
  async sweepCandidates(
    executor: StripeEventsExecutor,
    criteria: StripeEventSweepCriteria,
  ): Promise<string[]> {
    const rows = await executor
      .selectFrom("platform.stripe_events")
      .select("id")
      .where("status", "in", ["received", "failed", "processing"])
      .where((eb) =>
        eb.or([
          eb.and([eb("status", "=", "received"), eb("updated_at", "<", criteria.before)]),
          eb.and([
            eb("status", "=", "failed"),
            eb("processed_at", "is", null),
            eb("updated_at", "<", criteria.before),
          ]),
          eb.and([eb("status", "=", "processing"), eb("updated_at", "<", criteria.processingBefore)]),
        ]),
      )
      .orderBy("received_at")
      .orderBy("id")
      .limit(criteria.limit)
      .execute();
    return rows.map((row) => row.id);
  }

  /**
   * One page of the admin's list (adminListStripeEvents, PBE-048): `failed` and `ignored` rows first, each group newest
   * first (`received_at`, then id), then the others the same way; after the row `afterId` when given (compared with
   * its stored values), `limit` rows at most.
   */
  async listAdmin(
    executor: StripeEventsExecutor,
    filter: StripeEventAdminFilter,
    afterId: string | undefined,
    limit: number,
  ): Promise<StripeEventRecord[]> {
    const rank = sql<number>`(CASE WHEN e.status IN ('failed', 'ignored') THEN 1 ELSE 0 END)`;
    let query = executor.selectFrom("platform.stripe_events as e").selectAll("e");
    if (filter.status !== undefined) {
      query = query.where("e.status", "=", filter.status);
    }
    if (filter.type !== undefined) {
      query = query.where("e.type", "=", filter.type);
    }
    if (filter.tenantId !== undefined) {
      query = query.where("e.tenant_id", "=", filter.tenantId);
    }
    if (afterId !== undefined) {
      query = query.where(
        sql<boolean>`(${rank}, e.received_at, e.id) < (SELECT CASE WHEN c.status IN ('failed', 'ignored') THEN 1 ELSE 0 END, c.received_at, c.id FROM platform.stripe_events c WHERE c.id = ${afterId})`,
      );
    }
    return query
      .orderBy(rank, "desc")
      .orderBy("e.received_at", "desc")
      .orderBy("e.id", "desc")
      .limit(limit)
      .execute();
  }

  /** The row `id`, locked for the rest of the caller's transaction (`FOR UPDATE`); `undefined` when there is none. */
  async lockForReprocess(
    executor: Transaction<PlatformSchemas>,
    id: string,
  ): Promise<StripeEventRecord | undefined> {
    return executor
      .selectFrom("platform.stripe_events")
      .selectAll()
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * A `failed` or `ignored` row (locked by `lockForReprocess`) back to `received`, its attempts and last error kept and
   * `processed_at` cleared (PBE-048). False when the row is in another status.
   */
  async reopen(executor: StripeEventsExecutor, id: string, now: Date): Promise<boolean> {
    const result = await executor
      .updateTable("platform.stripe_events")
      .set({ status: "received", processed_at: null, updated_at: now })
      .where("id", "=", id)
      .where("status", "in", [...REPROCESSABLE_STATUSES])
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}
