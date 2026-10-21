// The `bookings.reconcile_scan` handler (OBE-043, reconcile.processor.ts) with doubles of its transaction, repository,
// recorder and queue: since FIX-W24-BOOKINGS (lead decision of 2026-10-21) it first adopts the stale claims (pending
// bookings without `reconcile_until` claimed more than 2 minutes ago), with one `booking.reconcile_adopted` event each,
// in the transaction that then lists the bookings to decide, and enqueues those after the commit. The SQL itself
// (which claims are stale, the row locks that make two scans adopt a claim once) runs against PostgreSQL in
// test/integration/bookings/reconcile.int.test.ts.
import { FakeClock } from "@velexis/testing";
import type { Job, Queue } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import type { Clock } from "../common/clock";
import { minuteBucket, tenantJob } from "../jobs/fan-out";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import type { TenantTransaction, TenantTx } from "../tenancy/tenant-tx";
import type { OrderRecorder } from "./order-recorder";
import { RECONCILE_SCAN_BATCH, RECONCILE_SCAN_JOB, ReconcileScan } from "./reconcile.processor";
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
function scan(options: { readonly adopted: readonly AdoptedClaim[]; readonly due: readonly string[] }) {
  const trx = {} as TenantTransaction;
  const repository = {
    adoptStaleClaims: vi.fn(() => Promise.resolve([...options.adopted])),
    dueBookingIds: vi.fn(() => Promise.resolve([...options.due])),
  };
  const recorder = { event: vi.fn(() => Promise.resolve()) };
  const queue = { addBulk: vi.fn(() => Promise.resolve([])) };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const instance = new ReconcileScan(
    {
      run: <T>(fn: (transaction: TenantTransaction) => Promise<T>): Promise<T> => fn(trx),
    } as unknown as TenantTx,
    repository as unknown as ReconcileRepository,
    recorder as unknown as OrderRecorder,
    new FakeClock(NOW) as unknown as Clock,
    queue as unknown as Queue,
    logger as unknown as PinoLogger,
  );
  const spec = tenantJob(RECONCILE_SCAN_JOB, TENANT.id, minuteBucket(NOW));
  const job = { id: spec.opts.jobId, name: spec.name, data: spec.data, opts: spec.opts } as unknown as Job;
  return { instance, job, trx, repository, recorder, queue, logger };
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

    expect(await instance.run(TENANT, job)).toEqual({ more: false, counts: { adopted: 1, due: 2 } });
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

    expect(await instance.run(TENANT, job)).toEqual({ more: false, counts: { adopted: 0, due: 0 } });
    expect(recorder.event).not.toHaveBeenCalled();
    expect(queue.addBulk).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
