// The `payments.authorisation_watch` handler (OBE-040, authorisation-watch.processor.ts) with doubles of its
// transaction, repository and alerts. Since FIX-W24-BOOKINGS (lead decision of 2026-10-21, OADR-0003 point 11) the
// candidates are read first and their bookings locked (`FOR KEY SHARE`) before the payments (`FOR UPDATE SKIP LOCKED`),
// so a candidate another job holds leaves the batch: a full batch of candidates still asks the runner for more, unless
// no payment was left to alert. The SQL and the locks themselves run against PostgreSQL in
// test/integration/payments/payments-queue.int.test.ts.
import { FakeClock } from "@velexis/testing";
import type { Job } from "bullmq";
import type { PinoLogger } from "nestjs-pino";
import { describe, expect, it, vi } from "vitest";
import type { Clock } from "../common/clock";
import type { IdGenerator } from "../common/ids";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import type { TenantTransaction, TenantTx } from "../tenancy/tenant-tx";
import {
  AUTHORISATION_WATCH_AGE_MS,
  AUTHORISATION_WATCH_BATCH,
  AuthorisationWatchProcessor,
  type DueAuthorisation,
} from "./authorisation-watch.processor";
import type { PaymentAlerts } from "./payments.processor";
import type { PaymentsRepository } from "./payments.repository";

const TENANT = { id: "ten_01JBWATCH0000000000000000" } as PlatformTenant;
/** The watch's run: 06:15 UTC on a day of the past (no calendar date matters). */
const NOW = new Date(Date.UTC(2026, 0, 15, 6, 15));

/** The `n`-th payment's id and its booking's (zero-padded, so the ids sort as the numbers do). */
const paymentId = (n: number): string => `pay_01JBWATCH${String(n).padStart(17, "0")}`;
const bookingId = (n: number): string => `bkg_01JBWATCH${String(n).padStart(17, "0")}`;

/** The rows of the candidates' read: the first `count` payments, each with its booking. */
function candidates(count: number): Array<{ id: string; bookingId: string }> {
  return Array.from({ length: count }, (_, n) => ({ id: paymentId(n), bookingId: bookingId(n) }));
}

/** The rows of the locked read: the payments `numbers`, authorised 6 days before the run. */
function locked(numbers: readonly number[]): DueAuthorisation[] {
  return numbers.map((n) => ({
    id: paymentId(n),
    environment: "test",
    bookingId: bookingId(n),
    currency: "EUR",
    amountAuthorized: "452.10",
    authorizedAt: new Date(NOW.getTime() - AUTHORISATION_WATCH_AGE_MS - 24 * 60 * 60_000),
  }));
}

/**
 * The handler with doubles. The transaction double answers its reads (`…execute()`) with `reads`, in order, and
 * records them in `steps` with the repository's `lockBookings`, so the order of the reads and the lock can be checked.
 */
function watch(reads: ReadonlyArray<readonly unknown[]>) {
  const steps: string[] = [];
  let next = 0;
  const builder: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_target, property) =>
        property === "execute"
          ? () => {
              steps.push("read");
              return Promise.resolve(reads[next++] ?? []);
            }
          : property === "then"
            ? undefined
            : () => builder,
    },
  );
  const trx = builder as unknown as TenantTransaction;
  const payments = {
    lockBookings: vi.fn(() => {
      steps.push("lock bookings");
      return Promise.resolve([]);
    }),
    insertEvent: vi.fn(() => Promise.resolve()),
  };
  const alerts = { send: vi.fn(() => Promise.resolve(true)) };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const instance = new AuthorisationWatchProcessor(
    {
      run: <T>(fn: (transaction: TenantTransaction) => Promise<T>): Promise<T> => fn(trx),
    } as unknown as TenantTx,
    payments as unknown as PaymentsRepository,
    alerts as unknown as PaymentAlerts,
    new FakeClock(NOW) as unknown as Clock,
    { newId: (prefix: string) => `${prefix}_01JBWATCHEVENT000000000000` } as unknown as IdGenerator,
    logger as unknown as PinoLogger,
  );
  const job = {
    id: "payments.authorisation_watch:test",
    name: "payments.authorisation_watch",
  } as unknown as Job;
  return { instance, job, steps, payments, alerts };
}

describe("payments.authorisation_watch", () => {
  it("[FIX-W24-BOOKINGS AC6] locks the candidates' bookings before their payments, and asks for more after a full batch even when another job held one", async () => {
    const all = Array.from({ length: AUTHORISATION_WATCH_BATCH }, (_, n) => n);
    // Another job holds the first candidate's payment (SKIP LOCKED): 99 of the 100 are alerted.
    const { instance, job, steps, payments, alerts } = watch([
      candidates(AUTHORISATION_WATCH_BATCH),
      locked(all.slice(1)),
    ]);

    expect(await instance.run(TENANT, job)).toEqual({
      more: true,
      counts: { payments: AUTHORISATION_WATCH_BATCH - 1, alerts: AUTHORISATION_WATCH_BATCH - 1 },
    });
    expect(steps).toEqual(["read", "lock bookings", "read"]);
    expect(payments.lockBookings).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      all.map((n) => bookingId(n)),
      "key share",
    );
    expect(payments.insertEvent).toHaveBeenCalledTimes(AUTHORISATION_WATCH_BATCH - 1);
    expect(alerts.send).toHaveBeenCalledTimes(AUTHORISATION_WATCH_BATCH - 1);
  });

  it("asks for no more when another job held every candidate: a continuation would only find them again", async () => {
    const { instance, job, payments, alerts } = watch([candidates(AUTHORISATION_WATCH_BATCH), []]);

    expect(await instance.run(TENANT, job)).toEqual({ more: false, counts: { payments: 0, alerts: 0 } });
    expect(payments.insertEvent).not.toHaveBeenCalled();
    expect(alerts.send).not.toHaveBeenCalled();
  });

  it("asks for no more after a batch the candidates did not fill, and locks nothing without a candidate", async () => {
    const partial = watch([candidates(3), locked([0, 1, 2])]);
    expect(await partial.instance.run(TENANT, partial.job)).toEqual({
      more: false,
      counts: { payments: 3, alerts: 3 },
    });

    const none = watch([[]]);
    expect(await none.instance.run(TENANT, none.job)).toEqual({
      more: false,
      counts: { payments: 0, alerts: 0 },
    });
    expect(none.steps).toEqual(["read"]);
    expect(none.payments.lockBookings).not.toHaveBeenCalled();
  });
});
