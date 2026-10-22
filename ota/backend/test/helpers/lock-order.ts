// Test support: proves the lock order of the money path (lead decision of 2026-10-21, OADR-0003 point 11: the checkout,
// then the booking, then the payment, then the refund, a foreign-key lock counting as a lock of the parent) with two
// concurrent transactions and a barrier.
//
//   const probe = probeRowLockOrder(tenantDb, "tenant_alpha", {
//     held: { table: "checkouts", id: checkoutId },     // a row that comes earlier in the order
//     probed: { table: "bookings", id: bookingId },     // a row that comes later
//   });
//   await probe.locked;            // the probe holds the held row FOR UPDATE
//   …start the code under test…    // its transaction waits for the held row
//   expect(await probe.result).toEqual({ waiterSeen: true, probedFree: true });
//
// The probe's transaction locks the held row, then waits (the barrier) until another backend waits for one of its
// locks (an ungranted lock in `pg_locks` whose `pg_blocking_pids` names the probe), at most `waitMs`. Then it tries the
// probed row with `FOR UPDATE NOWAIT` under a savepoint and commits, which lets the waiting transaction go on. A
// transaction that takes the held row first waits holding nothing of the probed row, so the probed row is free; one
// that locked the probed row first (by a lock of its own, or by the FOR KEY SHARE of a foreign key) and then waits for
// the held row holds it, so the probe's NOWAIT fails (the circle two such transactions deadlock in). Ids only; no row
// data is read. `probeLockOrder` is the booking-then-payment probe of FIX-W24-BOOKINGS.
//
// `holdKeyShare` (FIX-W26-BOOKINGS, lead decision (1) of 2026-10-22, OADR-0014 point 6) plays a concurrent insert of a
// row that references a booking (a booking event or a booking document): its transaction inserts the row and keeps it
// uncommitted, so it holds the booking's `FOR KEY SHARE` (the foreign key's lock) until the test releases it; then the
// row is rolled back. A claim made meanwhile (`FOR NO KEY UPDATE SKIP LOCKED`) must claim the booking.
//
//   const hold = holdKeyShare(tenantDb, "tenant_alpha", { bookingId, by: "booking_documents" });
//   await hold.held;               // the row is inserted, the booking's FOR KEY SHARE held
//   …claim the booking…
//   hold.release();
//   await hold.done;               // rolled back
import { randomBytes } from "node:crypto";
import { sql, tenantTx, type TenantDb } from "@velexis/db";

/** The tables of the money path's lock order, in that order. */
export type LockOrderTable = "checkouts" | "bookings" | "payments" | "refunds";

/** A row of one of those tables. */
export interface LockOrderRow {
  readonly table: LockOrderTable;
  readonly id: string;
}

/** What the probe saw while it held its row. */
export interface RowLockOrderObservation {
  /** Another backend waited for the probe's lock before `waitMs` passed. */
  readonly waiterSeen: boolean;
  /** The probed row could be locked (`FOR UPDATE NOWAIT`) while that backend waited: it had not locked it first. */
  readonly probedFree: boolean;
}

/** What the booking-then-payment probe saw while it held the booking. */
export interface LockOrderObservation {
  /** Another backend waited for the probe's booking lock before `waitMs` passed. */
  readonly waiterSeen: boolean;
  /** The payment could be locked (`FOR UPDATE NOWAIT`) while that backend waited: it had not locked it first. */
  readonly paymentFree: boolean;
}

export interface Probe<T> {
  /** Resolves once the probe holds its row `FOR UPDATE` (rejects when its transaction failed first). */
  readonly locked: Promise<void>;
  /** What the probe saw, once it committed and so released its row. */
  readonly result: Promise<T>;
}

export type RowLockOrderProbe = Probe<RowLockOrderObservation>;
export type LockOrderProbe = Probe<LockOrderObservation>;

export interface ProbeOptions {
  readonly waitMs?: number;
  readonly pollMs?: number;
}

/** PostgreSQL's `lock_not_available` (55P03): a NOWAIT lock that another transaction holds. */
function isLockNotAvailable(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "55P03";
}

/**
 * Holds `rows.held` in `schema` until another backend waits for it, then probes `rows.probed` (see the file header).
 */
export function probeRowLockOrder(
  db: TenantDb,
  schema: string,
  rows: { readonly held: LockOrderRow; readonly probed: LockOrderRow },
  options: ProbeOptions = {},
): RowLockOrderProbe {
  const waitMs = options.waitMs ?? 10_000;
  const pollMs = options.pollMs ?? 20;
  let markLocked: () => void = () => undefined;
  let failLocked: (error: unknown) => void = () => undefined;
  const locked = new Promise<void>((resolve, reject) => {
    markLocked = resolve;
    failLocked = reject;
  });
  const result = tenantTx(db, schema, async (trx): Promise<RowLockOrderObservation> => {
    await trx
      .selectFrom(rows.held.table)
      .select("id")
      .where("id", "=", rows.held.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    markLocked();
    const deadline = Date.now() + waitMs;
    let waiterSeen = false;
    for (;;) {
      // pg_locks is read live; pg_stat_activity would be a snapshot taken once per transaction, without the backends
      // that connected after it.
      const { rows: waiting } = await sql<{ waiting: number }>`
        SELECT count(*)::int AS waiting FROM pg_locks
        WHERE NOT granted AND pg_backend_pid() = ANY (pg_blocking_pids(pid))
      `.execute(trx);
      waiterSeen = (waiting[0]?.waiting ?? 0) > 0;
      if (waiterSeen || Date.now() > deadline) {
        break;
      }
      await new Promise((done) => setTimeout(done, pollMs));
    }
    await sql`SAVEPOINT lock_order_probe`.execute(trx);
    let probedFree = true;
    try {
      await trx
        .selectFrom(rows.probed.table)
        .select("id")
        .where("id", "=", rows.probed.id)
        .forUpdate()
        .noWait()
        .execute();
    } catch (error) {
      if (!isLockNotAvailable(error)) {
        throw error;
      }
      probedFree = false;
      await sql`ROLLBACK TO SAVEPOINT lock_order_probe`.execute(trx);
    }
    return { waiterSeen, probedFree };
  });
  result.catch(failLocked);
  return { locked, result };
}

/** Holds the booking `bookingId` in `schema` until another backend waits for it, then probes the payment (see above). */
export function probeLockOrder(
  db: TenantDb,
  schema: string,
  ids: { readonly bookingId: string; readonly paymentId: string },
  options: ProbeOptions = {},
): LockOrderProbe {
  const probe = probeRowLockOrder(
    db,
    schema,
    { held: { table: "bookings", id: ids.bookingId }, probed: { table: "payments", id: ids.paymentId } },
    options,
  );
  return {
    locked: probe.locked,
    result: probe.result.then(({ waiterSeen, probedFree }) => ({ waiterSeen, paymentFree: probedFree })),
  };
}

/** The rows whose insert takes a booking's `FOR KEY SHARE` that `holdKeyShare` plays. */
export type KeyShareHolder = "booking_events" | "booking_documents";

/** A transaction that holds a booking's `FOR KEY SHARE` until `release()` (see the file header). */
export interface KeyShareHold {
  /** Resolves once the row is inserted and the booking's key share held (rejects when the transaction failed first). */
  readonly held: Promise<void>;
  /** Lets the transaction end: it rolls the row back. */
  release(): void;
  /** Resolves once the transaction has ended and so released the booking. */
  readonly done: Promise<void>;
}

/** Thrown inside the hold's transaction to roll its row back. */
const ROLLBACK = new Error("the key share hold rolls back");

/** Holds the booking `bookingId` of `schema` `FOR KEY SHARE` by an uncommitted insert of `by` (see the file header). */
export function holdKeyShare(
  db: TenantDb,
  schema: string,
  hold: { readonly bookingId: string; readonly by: KeyShareHolder },
): KeyShareHold {
  let markHeld: () => void = () => undefined;
  let failHeld: (error: unknown) => void = () => undefined;
  const held = new Promise<void>((resolve, reject) => {
    markHeld = resolve;
    failHeld = reject;
  });
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const suffix = randomBytes(13).toString("hex").toUpperCase();
  const done = tenantTx(db, schema, async (trx) => {
    if (hold.by === "booking_events") {
      await trx
        .insertInto("booking_events")
        .values({
          id: `evt_${suffix}`,
          booking_id: hold.bookingId,
          type: "test.key_share",
          actor_type: "system",
          summary: "A concurrent insert of the test.",
          visible_to_customer: false,
        })
        .execute();
    } else {
      await trx
        .insertInto("booking_documents")
        .values({
          id: `doc_${suffix}`,
          booking_id: hold.bookingId,
          kind: "itinerary",
          status: "ready",
          file_name: "key-share-test.pdf",
          storage_key: `${schema}/documents/${hold.bookingId}/doc_${suffix}.pdf`,
          content_hash: "0".repeat(64),
        })
        .execute();
    }
    markHeld();
    await released;
    throw ROLLBACK;
  }).then(
    () => undefined,
    (error: unknown) => {
      if (error !== ROLLBACK) {
        failHeld(error);
        throw error;
      }
    },
  );
  // A failure before the row is held rejects `held` too: a caller that never awaits `done` sees it there.
  void done.catch(() => undefined);
  return { held, release, done };
}
