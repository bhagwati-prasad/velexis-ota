// The `bookings.reconcile_scan` handler (OBE-043, reconcile.processor.ts) with doubles of its transaction, repository,
// recorder and queue: since FIX-W24-BOOKINGS (lead decision of 2026-10-21) it first adopts the stale claims (pending
// bookings without `reconcile_until` claimed more than 2 minutes ago), with one `booking.reconcile_adopted` event each,
// in the transaction that then lists the bookings to decide, and enqueues those after the commit. The SQL itself
// (which claims are stale, the row locks that make two scans adopt a claim once) runs against PostgreSQL in
// test/integration/bookings/reconcile.int.test.ts. Since FIX-W28-CANCEL the scan also adds again the first
// `booking.cancellation_check` of each undecided cancellation flag (a lost enqueue), under the flag's own job id, and
// the chain's last check of a flag still undecided well after its deadline (a later check that was lost); its SQL and
// BullMQ's de-duplication run in test/integration/bookings/cancel.int.test.ts.
import { FakeClock } from "@velexis/testing";
import type { Job, Queue } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import type { Clock } from "../common/clock";
import { minuteBucket, tenantJob } from "../jobs/fan-out";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import type { TenantTransaction, TenantTx } from "../tenancy/tenant-tx";
import {
  CANCELLATION_CHECK_MAX_RUNS,
  cancellationCheckJob,
  type CancellationRepository,
} from "./cancellation.service";
import type { UndecidedFlagRow } from "./cancellation-state";
import type { OrderRecorder } from "./order-recorder";
import {
  CANCELLATION_SWEEP_AFTER_MS,
  CANCELLATION_SWEEP_FINAL_AFTER_MS,
  CANCELLATION_SWEEP_WINDOW_MS,
  RECONCILE_SCAN_BATCH,
  RECONCILE_SCAN_JOB,
  ReconcileScan,
  sweptCheckRunOf,
} from "./reconcile.processor";
import {
  adoptedReconcileUntil,
  RECONCILE_ADOPTED_EVENT,
  reconcileJob,
  type AdoptedClaim,
  type ReconcileRepository,
} from "./reconcile.service";
import { jobRequestId } from "./ticketing.processor";

const TENANT = { id: "ten_01JBRECONCILE00000000000000" } as PlatformTenant;
/** The scan's minute: 10:02:31 UTC on a day of the past (no calendar date matters). */
const NOW = new Date(Date.UTC(2026, 0, 15, 10, 2, 31));
const STALE_ID = "bkg_01JA4CH3G1K4N7R0V3X6A9D2F5";
const DUE_ID = "bkg_01JA4CH3G1K4N7R0V3X6A9D2F6";

/** The scan with doubles; the transaction double is one object, so the calls can be checked to share it. */
function scan(options: {
  readonly adopted: readonly AdoptedClaim[];
  readonly due: readonly string[];
  readonly flags?: readonly UndecidedFlagRow[];
}) {
  const trx = {} as TenantTransaction;
  const repository = {
    adoptStaleClaims: vi.fn(() => Promise.resolve([...options.adopted])),
    dueBookingIds: vi.fn(() => Promise.resolve([...options.due])),
  };
  const cancellations = { undecidedFlags: vi.fn(() => Promise.resolve([...(options.flags ?? [])])) };
  const recorder = { event: vi.fn(() => Promise.resolve()) };
  const queue = { addBulk: vi.fn(() => Promise.resolve([])) };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const instance = new ReconcileScan(
    {
      run: <T>(fn: (transaction: TenantTransaction) => Promise<T>): Promise<T> => fn(trx),
    } as unknown as TenantTx,
    repository as unknown as ReconcileRepository,
    recorder as unknown as OrderRecorder,
    cancellations as unknown as CancellationRepository,
    new FakeClock(NOW) as unknown as Clock,
    queue as unknown as Queue,
    logger as unknown as PinoLogger,
  );
  const spec = tenantJob(RECONCILE_SCAN_JOB, TENANT.id, minuteBucket(NOW));
  const job = { id: spec.opts.jobId, name: spec.name, data: spec.data, opts: spec.opts } as unknown as Job;
  return { instance, job, trx, repository, cancellations, recorder, queue, logger };
}

const staleClaim: AdoptedClaim = {
  id: STALE_ID,
  reference: "VXK7M2Q9",
  createOrderStartedAt: new Date(NOW.getTime() - 3 * 60_000),
  reconcileUntil: adoptedReconcileUntil(NOW),
};

describe("bookings.reconcile_scan", () => {
  it("[FIX-W24-BOOKINGS AC1] adopts the stale claims first, with their event, then enqueues the due bookings, adopted ones included", async () => {
    const { instance, job, trx, repository, recorder, queue, logger } = scan({
      adopted: [staleClaim],
      due: [STALE_ID, DUE_ID],
    });

    expect(await instance.run(TENANT, job)).toEqual({
      more: false,
      counts: { adopted: 1, due: 2, cancellationChecks: 0 },
    });
    expect(repository.adoptStaleClaims).toHaveBeenCalledExactlyOnceWith(trx, {
      now: NOW,
      limit: RECONCILE_SCAN_BATCH,
    });
    // The adoption and its event are in the transaction that then lists the due bookings (the adopted included).
    expect(repository.dueBookingIds).toHaveBeenCalledExactlyOnceWith(trx, {
      now: NOW,
      limit: RECONCILE_SCAN_BATCH,
    });
    expect(repository.adoptStaleClaims.mock.invocationCallOrder[0]).toBeLessThan(
      repository.dueBookingIds.mock.invocationCallOrder[0] ?? 0,
    );
    expect(recorder.event).toHaveBeenCalledExactlyOnceWith(trx, STALE_ID, {
      type: RECONCILE_ADOPTED_EVENT,
      actor: { type: "system", id: null },
      statusFrom: "pending",
      statusTo: "pending",
      summary: expect.stringContaining("VXK7M2Q9") as unknown,
      data: {
        reason: "stale_claim",
        createOrderStartedAt: staleClaim.createOrderStartedAt.toISOString(),
        reconcileUntil: staleClaim.reconcileUntil.toISOString(),
      },
      visibleToCustomer: false,
      // The scan job names the event, as the request id of its other writes (ticketing.processor.ts).
      requestId: jobRequestId(job),
      now: NOW,
    });
    expect(queue.addBulk).toHaveBeenCalledExactlyOnceWith([
      reconcileJob(TENANT.id, STALE_ID, minuteBucket(NOW)),
      reconcileJob(TENANT.id, DUE_ID, minuteBucket(NOW)),
    ]);
    // Ids and the claim's time only.
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { tenantId: TENANT.id, bookingId: STALE_ID, startedAt: staleClaim.createOrderStartedAt.toISOString() },
      "bookings.reconcile_adopted",
    );
  });

  it("[FIX-W24-BOOKINGS AC3] writes nothing and enqueues nothing when no claim is stale and nothing is due", async () => {
    const { instance, job, recorder, queue, logger } = scan({ adopted: [], due: [] });

    expect(await instance.run(TENANT, job)).toEqual({
      more: false,
      counts: { adopted: 0, due: 0, cancellationChecks: 0 },
    });
    expect(recorder.event).not.toHaveBeenCalled();
    expect(queue.addBulk).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("[FIX-W28-CANCEL AC4] adds the first check of each undecided cancellation flag again, at once, under the flag's own job id", async () => {
    const until = new Date(NOW.getTime() + 10 * 60_000);
    const { instance, job, trx, cancellations, queue } = scan({
      adopted: [],
      due: [],
      flags: [{ bookingId: DUE_ID, until }],
    });

    expect(await instance.run(TENANT, job)).toEqual({
      more: false,
      counts: { adopted: 0, due: 0, cancellationChecks: 1 },
    });
    // Flags a minute old or more, of the bookings changed in the last day, in the scan's transaction.
    expect(cancellations.undecidedFlags).toHaveBeenCalledExactlyOnceWith(trx, {
      changedSince: new Date(NOW.getTime() - CANCELLATION_SWEEP_WINDOW_MS),
      flaggedBefore: new Date(NOW.getTime() - CANCELLATION_SWEEP_AFTER_MS),
      limit: RECONCILE_SCAN_BATCH,
    });
    // The producer's first check: the same name, payload and job id (BullMQ keeps it single), without its delay.
    const first = cancellationCheckJob(TENANT.id, DUE_ID, until.getTime(), 1);
    expect(queue.addBulk).toHaveBeenCalledExactlyOnceWith([
      { name: first.name, data: first.data, opts: { jobId: first.opts.jobId } },
    ]);
  });

  it("[FIX-W28-CANCEL AC4] adds the chain's last check of a flag still undecided well after its deadline (a later check was lost)", async () => {
    // Its deadline passed CANCELLATION_SWEEP_FINAL_AFTER_MS ago: the chain's checks after it would have decided it.
    const lost = new Date(NOW.getTime() - CANCELLATION_SWEEP_FINAL_AFTER_MS);
    // Its deadline passed a moment ago: the chain's next check may still be on its way, so only the first is added.
    const recent = new Date(NOW.getTime() - CANCELLATION_SWEEP_FINAL_AFTER_MS + 1_000);
    const { instance, job, queue } = scan({
      adopted: [],
      due: [],
      flags: [
        { bookingId: STALE_ID, until: lost },
        { bookingId: DUE_ID, until: recent },
      ],
    });

    expect(await instance.run(TENANT, job)).toEqual({
      more: false,
      counts: { adopted: 0, due: 0, cancellationChecks: 2 },
    });
    const last = cancellationCheckJob(TENANT.id, STALE_ID, lost.getTime(), CANCELLATION_CHECK_MAX_RUNS);
    const first = cancellationCheckJob(TENANT.id, DUE_ID, recent.getTime(), 1);
    expect(last.opts.jobId).toBe(
      `booking.cancellation_check:${STALE_ID}:${lost.getTime()}-${CANCELLATION_CHECK_MAX_RUNS}`,
    );
    expect(queue.addBulk).toHaveBeenCalledExactlyOnceWith([
      { name: last.name, data: last.data, opts: { jobId: last.opts.jobId } },
      { name: first.name, data: first.data, opts: { jobId: first.opts.jobId } },
    ]);
    expect(sweptCheckRunOf(new Date(NOW.getTime() + 60_000), NOW)).toBe(1);
  });
});
