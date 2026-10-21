// Test support: proves the lock order of a transaction that locks a booking and its payment (lead decision of
// 2026-10-21, OADR-0003 point 11: the booking first, then the payment) with two concurrent transactions and a barrier.
//
//   const probe = probeLockOrder(tenantDb, "tenant_alpha", { bookingId, paymentId });
//   await probe.locked;            // the probe holds the booking FOR UPDATE
//   …start the code under test…    // its transaction waits for the booking
//   expect(await probe.result).toEqual({ waiterSeen: true, paymentFree: true });
//
// The probe's transaction locks the booking, then waits (the barrier) until another backend waits for one of its locks
// (an ungranted lock in `pg_locks` whose `pg_blocking_pids` names the probe), at most `waitMs`. Then it tries the
// payment with `FOR UPDATE NOWAIT` under a savepoint and commits, which lets the waiting transaction go on. A transaction that takes the booking first waits holding nothing
// of the payment, so the payment is free; one that locked the payment first and then waits for the booking holds it,
// so the probe's NOWAIT fails (the circle two such transactions deadlock in). Ids only; no row data is read.
import { sql, tenantTx, type TenantDb } from "@velexis/db";

/** What the probe saw while it held the booking. */
export interface LockOrderObservation {
  /** Another backend waited for the probe's booking lock before `waitMs` passed. */
  readonly waiterSeen: boolean;
  /** The payment could be locked (`FOR UPDATE NOWAIT`) while that backend waited: it had not locked it first. */
  readonly paymentFree: boolean;
}

export interface LockOrderProbe {
  /** Resolves once the probe holds the booking `FOR UPDATE` (rejects when its transaction failed first). */
  readonly locked: Promise<void>;
  /** What the probe saw, once it committed and so released the booking. */
  readonly result: Promise<LockOrderObservation>;
}

/** PostgreSQL's `lock_not_available` (55P03): a NOWAIT lock that another transaction holds. */
function isLockNotAvailable(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "55P03";
}

/** Holds the booking `bookingId` in `schema` until another backend waits for it, then probes the payment (see above). */
export function probeLockOrder(
  db: TenantDb,
  schema: string,
  ids: { readonly bookingId: string; readonly paymentId: string },
  options: { readonly waitMs?: number; readonly pollMs?: number } = {},
): LockOrderProbe {
  const waitMs = options.waitMs ?? 10_000;
  const pollMs = options.pollMs ?? 20;
  let markLocked: () => void = () => undefined;
  let failLocked: (error: unknown) => void = () => undefined;
  const locked = new Promise<void>((resolve, reject) => {
    markLocked = resolve;
    failLocked = reject;
  });
  const result = tenantTx(db, schema, async (trx): Promise<LockOrderObservation> => {
    await trx
      .selectFrom("bookings")
      .select("id")
      .where("id", "=", ids.bookingId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    markLocked();
    const deadline = Date.now() + waitMs;
    let waiterSeen = false;
    for (;;) {
      // pg_locks is read live; pg_stat_activity would be a snapshot taken once per transaction, without the backends
      // that connected after it.
      const { rows } = await sql<{ waiting: number }>`
        SELECT count(*)::int AS waiting FROM pg_locks
        WHERE NOT granted AND pg_backend_pid() = ANY (pg_blocking_pids(pid))
      `.execute(trx);
      waiterSeen = (rows[0]?.waiting ?? 0) > 0;
      if (waiterSeen || Date.now() > deadline) {
        break;
      }
      await new Promise((done) => setTimeout(done, pollMs));
    }
    await sql`SAVEPOINT lock_order_probe`.execute(trx);
    let paymentFree = true;
    try {
      await trx
        .selectFrom("payments")
        .select("id")
        .where("id", "=", ids.paymentId)
        .forUpdate()
        .noWait()
        .execute();
    } catch (error) {
      if (!isLockNotAvailable(error)) {
        throw error;
      }
      paymentFree = false;
      await sql`ROLLBACK TO SAVEPOINT lock_order_probe`.execute(trx);
    }
    return { waiterSeen, paymentFree };
  });
  result.catch(failLocked);
  return { locked, result };
}
