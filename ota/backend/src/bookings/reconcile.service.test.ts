// The decisions of the timeout reconciliation (OBE-043, reconcile.service.ts, and the same-key replay helpers of
// booking-orchestrator.service.ts) that do not need a service: which Queue List entries are worth reading, which
// order is accepted (only one with the `VELEXIS <reference>` BACKOFFICE remark, never a name alone), when an attempt
// may claim a booking, what it decides after its search, its jobs, and how a stored `504` is linked to its booking and
// replayed. The answers are the Amadeus stub's synthetic fixtures (test/builders/bookings.ts); the flow itself, with
// PostgreSQL, Redis, the stub, the fake Stripe API, the API and the worker, is test/integration/bookings/reconcile.
import { AppError, toErrorEnvelope } from "@velexis/errors";
import { describe, expect, it } from "vitest";
import { buildCreatedOrderBody } from "../../test/builders/bookings";
import type { IdempotencyResponse } from "../common/http/idempotency.service";
import {
  pendingBookingOf,
  RECONCILE_WINDOW_MS as ORCHESTRATOR_WINDOW_MS,
  reconciledFailure,
  replayedTimeout,
} from "./booking-orchestrator.service";
import {
  carriesVelexisRemark,
  comparableName,
  orderOfBooking,
  parseReconcileJobData,
  queueCandidates,
  queueCreationOf,
  queueRecordLocatorOf,
  RECONCILE_CLAIM_GAP_MS,
  RECONCILE_FIRST_DELAY_MS,
  RECONCILE_JOB,
  RECONCILE_MAX_READS,
  RECONCILE_WINDOW_MS,
  reconcileClaimSkip,
  reconcileDecision,
  reconcileJob,
  reconcileJobId,
  type ReconcileBookingRow,
} from "./reconcile.service";

const MINUTE = 60_000;
/** When the booking's Flight Create Orders was sent: 10:00:30 UTC on a day of the past (no calendar date matters). */
const STARTED = new Date(Date.UTC(2026, 0, 15, 10, 0, 30));
const REFERENCE = "VXK7M2Q9";
const OTHER_REFERENCE = "VXR4T8W2";
/** A booking id as newId makes them (a ULID: no I, L, O or U). */
const BOOKING_ID = "bkg_01JA4CH3G1K4N7R0V3X6A9D2F5";

/** `2026-01-15T10:01` for an offset in minutes from STARTED's minute, as Queue List writes `creation.dateTime`. */
const minuteText = (offsetMinutes: number): string =>
  new Date(Date.UTC(2026, 0, 15, 10, 0) + offsetMinutes * MINUTE).toISOString().slice(0, 16);

/** A Queue List entry (`pnr`) of the stub's form. */
function pnr(recordLocator: string, created: string, lastNames: readonly string[]): Record<string, unknown> {
  return {
    type: "pnrList",
    id: `${recordLocator}-2026-01-15`,
    creation: { dateTime: created },
    travelers: lastNames.map((lastName) => ({ names: [{ firstName: "TESTA", lastName }] })),
    products: [],
  };
}

const queueReply = (...entries: Array<Record<string, unknown>>) => ({
  meta: { count: entries.length },
  data: entries,
});

/** A Get Flight Order by Record Locator answer: the fixture's order with these general remarks. */
function byReference(remarks: ReadonlyArray<Record<string, unknown>> | undefined): Record<string, unknown> {
  const body = buildCreatedOrderBody();
  const data = body["data"] as Record<string, unknown>;
  if (remarks !== undefined) {
    data["remarks"] = { general: remarks };
  }
  return { data: [data], dictionaries: body["dictionaries"] };
}

/** A pending booking as the claim reads it, sent at STARTED and reconciled until 15 minutes later. */
function bookingRow(changes: Partial<ReconcileBookingRow> = {}): ReconcileBookingRow {
  return {
    id: BOOKING_ID,
    environment: "test",
    reference: REFERENCE,
    status: "pending",
    customerId: null,
    checkoutId: "chk_01JA4CH2F0J3M6Q9T2W5Z8C1E4",
    pricedOfferId: "prc_01JA4CH2F0J3M6Q9T2W5Z8C1E4",
    queuingOfficeId: "NCE1A0955",
    issueRequested: false,
    contactEmail: "contact-1@example.com",
    leadLastName: "SAMPLE",
    currency: "EUR",
    totalAmount: "115.00",
    createOrderStartedAt: STARTED,
    reconcileUntil: new Date(STARTED.getTime() + RECONCILE_WINDOW_MS),
    reconcileAttempts: 0,
    reconcileOutcome: null,
    updatedAt: STARTED,
    ...changes,
  };
}

describe("the PNRs of the booking queue worth reading", () => {
  it("are those created from a minute before to 5 minutes after the order, with the lead's last name", () => {
    const reply = queueReply(
      pnr("AAA111", minuteText(0), ["SAMPLE"]),
      // The minute that starts 90 s before the order was sent: a PNR created up to a minute before it.
      pnr("BBB222", minuteText(-1), ["SAMPLE"]),
      pnr("CCC333", minuteText(-2), ["SAMPLE"]),
      pnr("DDD444", minuteText(5), ["SAMPLE"]),
      pnr("EEE555", minuteText(6), ["SAMPLE"]),
      // The right time, another traveller.
      pnr("FFF666", minuteText(0), ["OTHER"]),
    );

    const candidates = queueCandidates(reply, { startedAt: STARTED, leadLastName: "SAMPLE" });

    expect(candidates.map((candidate) => candidate.recordLocator)).toEqual(["AAA111", "BBB222", "DDD444"]);
  });

  it("read at most three, the closest to the order first, each record locator once", () => {
    const reply = queueReply(
      pnr("ZZZ999", minuteText(4), ["SAMPLE"]),
      pnr("YYY888", minuteText(2), ["SAMPLE"]),
      pnr("XXX777", minuteText(1), ["SAMPLE"]),
      pnr("XXX777", minuteText(1), ["SAMPLE"]),
      pnr("WWW666", minuteText(0), ["TESTER", "SAMPLE"]),
    );

    const candidates = queueCandidates(reply, { startedAt: STARTED, leadLastName: "SAMPLE" });

    expect(candidates).toHaveLength(RECONCILE_MAX_READS);
    expect(candidates.map((candidate) => candidate.recordLocator)).toEqual(["WWW666", "XXX777", "YYY888"]);
  });

  it("compare last names without accents, case or punctuation, and skip entries they cannot read", () => {
    expect(comparableName("Müller-Lüdenscheidt")).toBe("MULLERLUDENSCHEIDT");
    expect(comparableName(undefined)).toBe("");
    const reply = queueReply(
      pnr("AAA111", minuteText(0), ["MULLER LUDENSCHEIDT"]),
      { ...pnr("BBB222", minuteText(0), ["MULLER LUDENSCHEIDT"]), creation: { dateTime: "yesterday" } },
      { ...pnr("CCC333", minuteText(0), ["MULLER LUDENSCHEIDT"]), id: "not a locator" },
    );

    const candidates = queueCandidates(reply, { startedAt: STARTED, leadLastName: "Müller-Lüdenscheidt" });

    expect(candidates.map((candidate) => candidate.recordLocator)).toEqual(["AAA111"]);
    expect(queueCandidates({ data: "none" }, { startedAt: STARTED, leadLastName: "SAMPLE" })).toEqual([]);
    expect(queueCandidates(reply, { startedAt: STARTED, leadLastName: "" })).toEqual([]);
  });

  it("read Queue List's creation minute in UTC unless it names its offset, and the locator before the day", () => {
    expect(queueCreationOf({ creation: { dateTime: "2026-01-15T10:01" } })?.toISOString()).toBe(
      "2026-01-15T10:01:00.000Z",
    );
    expect(queueCreationOf({ creation: { dateTime: "2026-01-15T11:01:30+01:00" } })?.toISOString()).toBe(
      "2026-01-15T10:01:30.000Z",
    );
    expect(queueCreationOf({ creation: {} })).toBeUndefined();
    expect(queueRecordLocatorOf({ id: "abc123-2026-01-15" })).toBe("ABC123");
    expect(queueRecordLocatorOf({ id: "ABC123" })).toBe("ABC123");
    expect(queueRecordLocatorOf({ id: 42 })).toBeUndefined();
  });
});

describe("the order of a booking", () => {
  it("[OBE-043 AC3] is never accepted for a PNR with the right name but no VELEXIS remark", () => {
    // The right traveller and time, no remark at all, or only the traveller's special request.
    expect(orderOfBooking(byReference(undefined), REFERENCE)).toBeUndefined();
    expect(
      orderOfBooking(
        byReference([{ subType: "GENERAL_MISCELLANEOUS", text: "VEGETARIAN MEAL PLEASE" }]),
        REFERENCE,
      ),
    ).toBeUndefined();
    // Another booking's remark, the right text under another sub-type, a remark that only starts the same.
    expect(
      orderOfBooking(byReference([{ subType: "BACKOFFICE", text: `VELEXIS ${OTHER_REFERENCE}` }]), REFERENCE),
    ).toBeUndefined();
    expect(
      orderOfBooking(
        byReference([{ subType: "GENERAL_MISCELLANEOUS", text: `VELEXIS ${REFERENCE}` }]),
        REFERENCE,
      ),
    ).toBeUndefined();
    expect(
      orderOfBooking(byReference([{ subType: "BACKOFFICE", text: `VELEXIS ${REFERENCE}X` }]), REFERENCE),
    ).toBeUndefined();
    expect(carriesVelexisRemark({ remarks: { general: "VELEXIS" } }, REFERENCE)).toBe(false);
  });

  it("is the order that carries the BACKOFFICE remark VELEXIS <reference>, read as Flight Create Orders answers", () => {
    const reply = byReference([
      { subType: "GENERAL_MISCELLANEOUS", text: "WINDOW SEAT IF POSSIBLE" },
      // Amadeus may answer it in lower case or with other spacing: the same remark.
      { subType: "backoffice", text: ` velexis  ${REFERENCE.toLowerCase()} ` },
    ]);

    const order = orderOfBooking(reply, REFERENCE);

    expect(order).toBeDefined();
    expect(order?.records[0]?.reference).toMatch(/^[A-Z0-9]{6}$/);
    expect(order?.offers).toHaveLength(1);
  });

  it("is null when the order with the remark cannot be read: it exists, so the booking is never failed for it", () => {
    const reply = {
      data: [
        {
          id: "eJzTd9f3NjIJdgMADeQCtg",
          remarks: { general: [{ subType: "BACKOFFICE", text: `VELEXIS ${REFERENCE}` }] },
        },
      ],
    };

    expect(orderOfBooking(reply, REFERENCE)).toBeNull();
    expect(orderOfBooking({ data: [] }, REFERENCE)).toBeUndefined();
  });
});

describe("an attempt", () => {
  it("claims a pending booking with reconcile_until, 30 s after its order was sent, at most every 45 s", () => {
    const at = (ms: number) => new Date(STARTED.getTime() + ms);

    expect(reconcileClaimSkip(bookingRow(), at(RECONCILE_FIRST_DELAY_MS))).toBeUndefined();
    expect(reconcileClaimSkip(bookingRow(), at(RECONCILE_FIRST_DELAY_MS - 1))).toBe("not_due");
    const attempted = bookingRow({ reconcileAttempts: 1, updatedAt: at(MINUTE) });
    expect(reconcileClaimSkip(attempted, at(MINUTE + RECONCILE_CLAIM_GAP_MS - 1))).toBe("not_due");
    expect(reconcileClaimSkip(attempted, at(MINUTE + RECONCILE_CLAIM_GAP_MS))).toBeUndefined();
    expect(reconcileClaimSkip(bookingRow({ status: "confirmed" }), at(MINUTE))).toBe("not_pending");
    expect(reconcileClaimSkip(bookingRow({ reconcileUntil: null }), at(MINUTE))).toBe("not_reconciling");
    expect(reconcileClaimSkip(bookingRow({ reconcileOutcome: "manual_review" }), at(MINUTE))).toBe("decided");
  });

  it("records a found order, fails the booking only after a complete search past reconcile_until, else waits", () => {
    expect(reconcileDecision("found", false)).toBe("record");
    expect(reconcileDecision("found", true)).toBe("record");
    expect(reconcileDecision("absent", false)).toBe("wait");
    expect(reconcileDecision("absent", true)).toBe("fail");
    expect(reconcileDecision("no_queue", false)).toBe("wait");
    expect(reconcileDecision("no_queue", true)).toBe("fail");
    // The order may be in what could not be read: nothing is voided for it.
    expect(reconcileDecision("incomplete", true)).toBe("wait");
  });

  it("decides within the 15 minutes of OADR-0003, the orchestration's own window", () => {
    expect(RECONCILE_WINDOW_MS).toBe(15 * MINUTE);
    expect(ORCHESTRATOR_WINDOW_MS).toBe(RECONCILE_WINDOW_MS);
    expect(RECONCILE_FIRST_DELAY_MS).toBe(30_000);
    expect(RECONCILE_CLAIM_GAP_MS).toBeLessThan(MINUTE);
  });
});

describe("the booking.reconcile jobs", () => {
  it("carry the tenant and the booking only, with deterministic ids of three parts", () => {
    const tenantId = "ten_01JALPHA0000000000000000AA";
    expect(reconcileJob(tenantId, BOOKING_ID, "first")).toEqual({
      name: RECONCILE_JOB,
      data: { tenantId, bookingId: BOOKING_ID },
      opts: { jobId: `booking.reconcile:${BOOKING_ID}:first`, delay: RECONCILE_FIRST_DELAY_MS },
    });
    expect(reconcileJob(tenantId, BOOKING_ID, 29_478_960)).toEqual({
      name: RECONCILE_JOB,
      data: { tenantId, bookingId: BOOKING_ID },
      opts: { jobId: reconcileJobId(BOOKING_ID, 29_478_960) },
    });
    expect(reconcileJobId(BOOKING_ID, 1).split(":")).toHaveLength(3);
    expect(parseReconcileJobData({ tenantId, bookingId: BOOKING_ID })).toEqual({
      tenantId,
      bookingId: BOOKING_ID,
    });
    expect(parseReconcileJobData({ tenantId, bookingId: BOOKING_ID, extra: 1 })).toBeUndefined();
    expect(parseReconcileJobData({ tenantId, bookingId: "chk_01JA4CH2F0J3M6Q9T2W5Z8C1E4" })).toBeUndefined();
    expect(parseReconcileJobData(null)).toBeUndefined();
  });
});

describe("a same-key retry of checkout.complete after 504 SUPPLIER_TIMEOUT", () => {
  const timeout = (details: Record<string, unknown>): IdempotencyResponse => ({
    status: 504,
    headers: { "cache-control": "no-store" },
    setCookie: [],
    body: toErrorEnvelope(
      new AppError("SUPPLIER_TIMEOUT", {
        message: "We are confirming your booking with the airline. Do not book again.",
        details,
      }),
      "req_01JA2Z9W5K7Q3M8N4P6R2T0V1X",
      { exposeSupplier: false },
    ).body,
  });

  it("is linked to the pending booking the stored 504 names, and to nothing else", () => {
    const stored = timeout({
      bookingId: BOOKING_ID,
      bookingToken: null,
      bookingTokenExpiresAt: null,
      replayed: false,
    });

    expect(pendingBookingOf(stored)).toEqual({ type: "booking", id: BOOKING_ID });
    expect(pendingBookingOf({ ...stored, status: 502 })).toBeUndefined();
    expect(pendingBookingOf(timeout({ bookingId: "not a booking" }))).toBeUndefined();
    expect(
      pendingBookingOf({ status: 201, headers: {}, setCookie: [], body: { booking: { id: BOOKING_ID } } }),
    ).toBe(undefined);
  });

  it("replays the same 504 with replayed: true while undecided, then the final error once the order is proven absent", () => {
    const stored = timeout({
      bookingId: BOOKING_ID,
      bookingToken: null,
      bookingTokenExpiresAt: null,
      replayed: false,
    });

    const replayed = replayedTimeout(stored);

    expect(replayed.status).toBe(504);
    expect(replayed.body).toEqual({
      error: expect.objectContaining({
        code: "SUPPLIER_TIMEOUT",
        details: { bookingId: BOOKING_ID, bookingToken: null, bookingTokenExpiresAt: null, replayed: true },
      }) as unknown,
    });
    // The stored answer itself is not changed.
    expect((stored.body as { error: { details: { replayed: boolean } } }).error.details.replayed).toBe(false);
    const failure = reconciledFailure(BOOKING_ID);
    expect(failure.code).toBe("SUPPLIER_ERROR");
    expect(failure.details).toEqual({ bookingId: BOOKING_ID, bookingStatus: "failed" });
  });
});
