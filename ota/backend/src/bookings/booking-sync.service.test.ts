// BookingSyncService without PostgreSQL:
//   - the wording of the staff alert of an airline cancellation of a paid booking (FIX-W28-NOTIFY, lead decision (6) of
//     2026-10-23; FIX-W27-SYNC, lead decision (3)): a Stripe payment is released or refunded from the console, an
//     airline-card payment is refunded through the airline;
//   - the sync's read as a background call (OBE-102; OADR-0001 point 6, revision of 2026-11-12), with fakes of its
//     collaborators: the background sync marks its Amadeus call `background` and waits for the buckets when they refuse
//     it, within BOOKING_SYNC_RATE_LIMIT_BUDGET_MS per job (every read of it together), before it records
//     `RATE_LIMITED`; a refresh stays interactive and never waits.
// The sync runs against PostgreSQL, Redis and the Amadeus stub in test/integration/bookings/sync.int.test.ts.
import type { ConfigService } from "@nestjs/config";
import { AppError } from "@velexis/errors";
import { FakeClock } from "@velexis/testing";
import type { PinoLogger } from "nestjs-pino";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { buildCreatedOrderBody } from "../../test/builders/bookings";
import type { AmadeusClient } from "../amadeus/amadeus.client";
import type { AmadeusCallContext } from "../amadeus/call-context";
import { AmadeusRateLimitedError } from "../amadeus/rate-limiter";
import type { Clock } from "../common/clock";
import { newId, type IdGenerator } from "../common/ids";
import type { SharedConfig } from "../config";
import type { OutboxService } from "../notifications/outbox.service";
import { AIRLINE_PROVIDER } from "../payments/airline-card/airline-card.gateway";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import type { TenantTx } from "../tenancy/tenant-tx";
import {
  airlineCancellationReason,
  BOOKING_SYNC_MIN_RATE_LIMIT_WAIT_MS,
  BOOKING_SYNC_OPERATION,
  BOOKING_SYNC_RATE_LIMIT_BUDGET_MS,
  BookingSyncService,
  bucketWaitMs,
  type BookingSyncRepository,
  type HeldPaymentRow,
  type SyncClaimRow,
} from "./booking-sync.service";
import type { BookingsRepository } from "./bookings.repository";
import type { OrderRecorder } from "./order-recorder";
import type { StaffAlerts } from "./staff-alerts";

const payment = (values: Partial<HeldPaymentRow>): HeldPaymentRow => ({
  id: "pay_01JA4CG3S8W1Z4C7F0H3L6P9T2",
  provider: "stripe",
  status: "captured",
  currency: "EUR",
  amountAuthorized: "115.00",
  amountCaptured: "115.00",
  amountRefunded: "0",
  ...values,
});

describe("airlineCancellationReason", () => {
  it("[FIX-W28-NOTIFY AC4] keeps the console wording for a Stripe payment, captured or only authorised", () => {
    expect(airlineCancellationReason("VXK7M2Q9", [payment({})])).toBe(
      "The airline cancelled every flight of booking VXK7M2Q9, and its payment still holds the traveller's money " +
        "(pay_01JA4CG3S8W1Z4C7F0H3L6P9T2 captured 115.00 EUR). Release the authorisation or refund the payment " +
        "from the console.",
    );
    expect(
      airlineCancellationReason("VXK7M2Q9", [
        payment({ status: "authorized", amountCaptured: "0" }),
        payment({ id: "pay_2", status: "partially_refunded", amountRefunded: "15.00" }),
      ]),
    ).toContain(
      "(pay_01JA4CG3S8W1Z4C7F0H3L6P9T2 authorised 115.00 EUR; pay_2 captured 100.00 EUR). Release the " +
        "authorisation or refund the payment from the console.",
    );
  });

  it("[FIX-W28-NOTIFY AC4] says that an airline-card payment is refunded through the airline, not from the console", () => {
    const reason = airlineCancellationReason("VXK7M2Q9", [payment({ provider: AIRLINE_PROVIDER })]);

    expect(reason).toBe(
      "The airline cancelled every flight of booking VXK7M2Q9, and the traveller paid with a card the airline " +
        "charged (pay_01JA4CG3S8W1Z4C7F0H3L6P9T2 charged by the airline 115.00 EUR). The refund goes through the " +
        "airline (its refund rules, in Amadeus or with the airline), not the console, which can neither release nor " +
        "refund an airline-card payment.",
    );
    expect(reason).not.toContain("Release the authorisation or refund the payment from the console");
  });

  it("[FIX-W28-NOTIFY AC4] names both ways when a booking holds a Stripe and an airline-card payment", () => {
    const reason = airlineCancellationReason("VXK7M2Q9", [
      payment({}),
      payment({ id: "pay_airline", provider: AIRLINE_PROVIDER, amountCaptured: "20.00" }),
    ]);

    expect(reason).toContain("Release the authorisation or refund the payment from the console.");
    expect(reason).toContain(
      "The traveller also paid with a card the airline charged (pay_airline charged by the airline 20.00 EUR): " +
        "that refund goes through the airline, not the console",
    );
  });
});

// ---- The sync's read as a background call (OBE-102) ----------------------------------------------------------------

const NOW = new Date("2026-11-12T10:00:00.000Z");
const ORDER_ID = "eJzTd9f3NjIJdgMADeQCtg";
const OFFICE = "NCE1A0955";
const REQUEST_ID = "req-0000-0001";

let tenant: PlatformTenant;
let bookingId: string;
let clock: FakeClock;
let claimRow: SyncClaimRow;
let getFlightOrder: Mock<(context: AmadeusCallContext, request: unknown) => Promise<unknown>>;
let updateSynced: Mock<(trx: unknown, id: string, values: unknown, bump: boolean) => Promise<void>>;
let lockForRefresh: Mock<() => Promise<unknown>>;
/** The record step's lock of the booking (BookingSyncRepository.lock): the booking a read is recorded against. */
let lockForRecord: Mock<() => Promise<unknown>>;

/** The service with fakes: a claim that succeeds, the Amadeus read `getFlightOrder`, the failure write `updateSynced`. */
function service(): BookingSyncService {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return new BookingSyncService(
    { run: (fn: (trx: unknown) => Promise<unknown>) => fn({}) } as unknown as TenantTx,
    {
      claim: vi.fn(() => Promise.resolve(claimRow)),
      lock: lockForRecord,
    } as unknown as BookingSyncRepository,
    {
      markSyncClaimed: vi.fn(() => Promise.resolve()),
      updateSynced,
      lockForRefresh,
    } as unknown as BookingsRepository,
    {} as OrderRecorder,
    { getFlightOrder } as unknown as AmadeusClient,
    {} as OutboxService,
    {} as StaffAlerts,
    {} as IdGenerator,
    clock as unknown as Clock,
    { get: () => "ota.example.com" } as unknown as ConfigService<SharedConfig, true>,
    logger as unknown as PinoLogger,
  );
}

/** The rate limiter's refusal of a call of `priority`, `waitMs` before both buckets have what it needs. */
const refusal = (waitMs: number, priority: "background" | "interactive" = "background"): AppError =>
  new AppError("RATE_LIMITED", {
    details: { retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) },
    cause: new AmadeusRateLimitedError("tenant", waitMs, priority),
  });

/** An answer the sync cannot read as an order: it records `SUPPLIER_ERROR` without the record step. */
const unreadable = () =>
  Promise.resolve({
    body: {},
    call: {
      supplierRequestId: null,
      officeId: OFFICE,
      status: 200,
      durationMs: 300,
      correlationId: null,
      attempts: 1,
    },
  });

/** The contexts of the Amadeus reads, in order. */
const contexts = (): AmadeusCallContext[] =>
  getFlightOrder.mock.calls.map(([context]) => context as AmadeusCallContext);

/** The `sync_error` values written, in order. */
const syncErrors = (): unknown[] =>
  updateSynced.mock.calls.map(([, , values]) => (values as { sync_error: unknown }).sync_error);

beforeEach(() => {
  bookingId = newId("bkg");
  tenant = {
    id: newId("ten"),
    key: "alpha",
    name: "Alpha Travel",
    status: "active",
    schemaName: "tenant_alpha" as PlatformTenant["schemaName"],
    storefrontEnvironment: "test",
    defaultCurrency: "EUR",
    defaultLocale: "en",
    billingNotice: null,
  };
  clock = new FakeClock(NOW);
  claimRow = {
    id: bookingId,
    environment: "test",
    status: "confirmed",
    amadeusOrderId: ORDER_ID,
    ownerOfficeId: OFFICE,
    queuingOfficeId: null,
    lastArrivalAt: new Date(NOW.getTime() + 30 * 86_400_000),
    ticketingDeadlineAt: null,
    amountPaid: "100.00",
    version: 4,
    lastSyncedAt: null,
    syncClaimedAt: null,
  };
  getFlightOrder = vi.fn(unreadable);
  updateSynced = vi.fn(() => Promise.resolve());
  // Another writer moved the booking's version since the claim: a recorded read is superseded and the sync reads again.
  lockForRecord = vi.fn(() =>
    Promise.resolve({ status: "confirmed", amadeusOrderId: ORDER_ID, version: claimRow.version + 1 }),
  );
  lockForRefresh = vi.fn(() =>
    Promise.resolve({
      status: "confirmed",
      amadeusOrderId: ORDER_ID,
      ownerOfficeId: OFFICE,
      queuingOfficeId: null,
      version: 4,
      lastRefreshAt: null,
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the background sync's read [OBE-102 AC1]", () => {
  it("is a background call of the booking's order, with the sync's operation and office", async () => {
    const outcome = await service().attempt(tenant, bookingId, REQUEST_ID);

    expect(outcome).toEqual({ outcome: "failed", rounds: 1, code: "SUPPLIER_ERROR" });
    expect(getFlightOrder.mock.calls).toEqual([
      [
        {
          tenantId: tenant.id,
          environment: "test",
          operation: BOOKING_SYNC_OPERATION,
          requestId: REQUEST_ID,
          bookingId,
          orderOffice: OFFICE,
          priority: "background",
        },
        { flightOrderId: ORDER_ID, query: { include: ["bags"] } },
      ],
    ]);
  });

  it("waits the buckets' own wait when they refuse it and reads again, counting the waits", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    getFlightOrder
      .mockRejectedValueOnce(refusal(200))
      .mockRejectedValueOnce(refusal(3))
      .mockImplementationOnce(unreadable);
    const started = Date.now();

    const pending = service().attempt(tenant, bookingId, REQUEST_ID);
    await vi.runAllTimersAsync();
    const outcome = await pending;

    // 200 ms, then the shortest wait for a refusal of 3 ms; the third read answered.
    expect(Date.now() - started).toBe(200 + BOOKING_SYNC_MIN_RATE_LIMIT_WAIT_MS);
    expect(outcome).toEqual({
      outcome: "failed",
      rounds: 1,
      code: "SUPPLIER_ERROR",
      rateLimitWaits: 2,
      rateLimitWaitMs: 200 + BOOKING_SYNC_MIN_RATE_LIMIT_WAIT_MS,
    });
    expect(contexts().map((context) => context.priority)).toEqual(["background", "background", "background"]);
    expect(syncErrors()).toEqual(["SUPPLIER_ERROR"]);
  });

  it("records RATE_LIMITED as before, without another change, once the next wait would pass the budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    getFlightOrder.mockRejectedValue(refusal(200));

    const pending = service().attempt(tenant, bookingId, REQUEST_ID);
    await vi.runAllTimersAsync();
    const outcome = await pending;

    const waits = BOOKING_SYNC_RATE_LIMIT_BUDGET_MS / 200;
    expect(outcome).toEqual({
      outcome: "failed",
      rounds: 1,
      code: "RATE_LIMITED",
      rateLimitWaits: waits,
      rateLimitWaitMs: BOOKING_SYNC_RATE_LIMIT_BUDGET_MS,
    });
    expect(getFlightOrder).toHaveBeenCalledTimes(waits + 1);
    expect(syncErrors()).toEqual(["RATE_LIMITED"]);
  });

  it("spends one budget of waits per job, all its reads together", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    // The first read is refused 20 times (4 s of waits), then read and superseded; the second is always refused.
    for (let refused = 0; refused < 20; refused += 1) {
      getFlightOrder.mockRejectedValueOnce(refusal(200));
    }
    getFlightOrder.mockResolvedValueOnce({
      body: buildCreatedOrderBody(),
      call: { supplierRequestId: null },
    });
    getFlightOrder.mockRejectedValue(refusal(200));
    const started = Date.now();

    const pending = service().attempt(tenant, bookingId, REQUEST_ID);
    await vi.runAllTimersAsync();
    const outcome = await pending;

    // The second read had the 6 s the first left (30 more waits), not a budget of its own.
    const waits = BOOKING_SYNC_RATE_LIMIT_BUDGET_MS / 200;
    expect(outcome).toEqual({
      outcome: "failed",
      rounds: 2,
      code: "RATE_LIMITED",
      rateLimitWaits: waits,
      rateLimitWaitMs: BOOKING_SYNC_RATE_LIMIT_BUDGET_MS,
    });
    expect(Date.now() - started).toBe(BOOKING_SYNC_RATE_LIMIT_BUDGET_MS);
    expect(getFlightOrder).toHaveBeenCalledTimes(waits + 2);
    expect(lockForRecord).toHaveBeenCalledTimes(1);
    expect(syncErrors()).toEqual(["RATE_LIMITED"]);
  });

  it("does not wait after an error that is not the buckets' refusal", async () => {
    for (const error of [
      new AppError("SUPPLIER_UNAVAILABLE"),
      new AppError("RATE_LIMITED", { details: { retryAfterSeconds: 1 } }),
      new AppError("SUPPLIER_TIMEOUT", { cause: new AmadeusRateLimitedError("tenant", 200, "background") }),
    ]) {
      getFlightOrder.mockReset().mockRejectedValue(error);
      updateSynced.mockClear();

      const outcome = await service().attempt(tenant, bookingId, REQUEST_ID);

      expect(outcome).toEqual({ outcome: "failed", rounds: 1, code: error.code });
      expect(getFlightOrder).toHaveBeenCalledTimes(1);
      expect(syncErrors()).toEqual([error.code]);
    }
  });

  it("knows the buckets' refusal by its cause, and waits at least the shortest wait", () => {
    expect(bucketWaitMs(refusal(200))).toBe(200);
    expect(bucketWaitMs(refusal(1))).toBe(BOOKING_SYNC_MIN_RATE_LIMIT_WAIT_MS);
    expect(bucketWaitMs(refusal(4_000, "interactive"))).toBe(4_000);
    expect(bucketWaitMs(new AppError("RATE_LIMITED"))).toBeUndefined();
    expect(bucketWaitMs(new AppError("SUPPLIER_UNAVAILABLE", { cause: refusal(200).cause }))).toBeUndefined();
    expect(bucketWaitMs(refusal(200).cause)).toBeUndefined();
    expect(bucketWaitMs(undefined)).toBeUndefined();
  });
});

describe("a refresh's read [OBE-102 AC1]", () => {
  it("stays interactive and never waits: a refusal is answered at once", async () => {
    getFlightOrder.mockRejectedValue(refusal(200, "interactive"));

    const error: unknown = await service()
      .refresh({ id: tenant.id, key: tenant.key }, bookingId, {
        operation: "bookings.get",
        requestId: REQUEST_ID,
        environment: "test",
        query: {},
        throttleMs: 60_000,
      })
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("RATE_LIMITED");
    expect(getFlightOrder).toHaveBeenCalledTimes(1);
    expect(contexts()[0]).toMatchObject({ operation: "bookings.get", bookingId });
    expect(contexts()[0]?.priority).toBeUndefined();
    expect(syncErrors()).toEqual(["RATE_LIMITED"]);
  });
});
