// The decisions of the timeout reconciliation (OBE-043, reconcile.service.ts, and the same-key replay helpers of
// booking-orchestrator.service.ts) that do not need a service: which Queue List entries are worth reading, which
// order is accepted (only one with the `VELEXIS <reference>` BACKOFFICE remark, never a name alone), when an attempt
// may claim a booking, what it decides after its search, its jobs, and how a stored `504` is linked to its booking and
// replayed. The answers are the Amadeus stub's synthetic fixtures (test/builders/bookings.ts); the flow itself, with
// PostgreSQL, Redis, the stub, the fake Stripe API, the API and the worker, is test/integration/bookings/reconcile.
import { AppError, toErrorEnvelope } from "@velexis/errors";
import { describe, expect, it } from "vitest";
import { buildCreatedOrderBody } from "../../test/builders/bookings";
import { mapAmadeusError, type AmadeusCallError } from "../amadeus/error-mapper";
import type { IdempotencyResponse } from "../common/http/idempotency.service";
import {
  pendingBookingOf,
  RECONCILE_WINDOW_MS as ORCHESTRATOR_WINDOW_MS,
  reconciledFailure,
  replayedTimeout,
} from "./booking-orchestrator.service";
import {
  adoptedReconcileUntil,
  carriesVelexisRemark,
  comparableName,
  listedGap,
  orderOfBooking,
  parseReconcileJobData,
  queueCandidates,
  queueCreationOf,
  queueRecordLocatorOf,
  RECONCILE_ADOPT_AFTER_MS,
  RECONCILE_CLAIM_GAP_MS,
  RECONCILE_DEADLINE_RETRIES,
  RECONCILE_FIRST_DELAY_MS,
  RECONCILE_JOB,
  RECONCILE_MAX_READS,
  RECONCILE_QUEUE_LIST_MAX,
  RECONCILE_WINDOW_MS,
  reconcileClaimSkip,
  reconcileDecision,
  reconcileJob,
  reconcileJobId,
  readSlice,
  staleClaimBefore,
  transientFailure,
  type ReconcileBookingRow,
  type SearchGap,
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

const queueReply = (...entries: unknown[]) => ({
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

    const listed = queueCandidates(reply, { startedAt: STARTED, leadLastName: "SAMPLE" });

    expect(listed?.candidates.map((candidate) => candidate.recordLocator)).toEqual([
      "AAA111",
      "BBB222",
      "DDD444",
    ]);
    expect(listed).toMatchObject({ unreadable: 0, truncated: false });
  });

  it("[FIX-W25-BOOKINGS AC1] are every one of them, the closest to the order first, each record locator once", () => {
    // Five PNRs of the lead's name in the order's minute, and three more later: none is left out (three were read
    // before the lead decision of 2026-10-21, so the fourth of a minute could be the order and stay unread).
    const reply = queueReply(
      pnr("ZZZ999", minuteText(4), ["SAMPLE"]),
      pnr("YYY888", minuteText(2), ["SAMPLE"]),
      pnr("XXX777", minuteText(1), ["SAMPLE"]),
      pnr("XXX777", minuteText(1), ["SAMPLE"]),
      ...["VVV555", "UUU444", "TTT333", "SSS222"].map((locator) => pnr(locator, minuteText(0), ["SAMPLE"])),
      pnr("WWW666", minuteText(0), ["TESTER", "SAMPLE"]),
    );

    const listed = queueCandidates(reply, { startedAt: STARTED, leadLastName: "SAMPLE" });

    expect(listed?.candidates.map((candidate) => candidate.recordLocator)).toEqual([
      "SSS222",
      "TTT333",
      "UUU444",
      "VVV555",
      "WWW666",
      "XXX777",
      "YYY888",
      "ZZZ999",
    ]);
    expect(RECONCILE_MAX_READS).toBeGreaterThanOrEqual(50);
    // Read in one attempt: there are fewer than the cap.
    expect(readSlice(listed?.candidates ?? [], 1)).toHaveLength(8);
  });

  it("compare last names without accents, case or punctuation, and count the entries they cannot read", () => {
    expect(comparableName("Müller-Lüdenscheidt")).toBe("MULLERLUDENSCHEIDT");
    expect(comparableName(undefined)).toBe("");
    const reply = queueReply(
      pnr("AAA111", minuteText(0), ["MULLER LUDENSCHEIDT"]),
      // A creation time that cannot be read: read all the same, after those of a known time.
      { ...pnr("BBB222", minuteText(0), ["MULLER LUDENSCHEIDT"]), creation: { dateTime: "yesterday" } },
      // No record locator, or no names: they may be the order and cannot be read, so the search is incomplete.
      { ...pnr("CCC333", minuteText(0), ["MULLER LUDENSCHEIDT"]), id: "not a locator" },
      { ...pnr("DDD444", minuteText(0), []), travelers: [{ names: [{ firstName: "TESTA" }] }] },
      "not an entry",
      // Another traveller, or outside the window: not the order.
      pnr("EEE555", minuteText(0), ["SAMPLE"]),
      { ...pnr("FFF666", minuteText(9), []), travelers: [] },
    );

    const listed = queueCandidates(reply, { startedAt: STARTED, leadLastName: "Müller-Lüdenscheidt" });

    expect(listed?.candidates).toEqual([
      { recordLocator: "AAA111", createdAt: new Date(Date.UTC(2026, 0, 15, 10, 0)) },
      { recordLocator: "BBB222", createdAt: null },
    ]);
    expect(listed).toMatchObject({ unreadable: 3, truncated: false });
    // An answer that is not a list of PNRs, or a booking without a lead last name: nothing can be searched.
    expect(queueCandidates({ data: "none" }, { startedAt: STARTED, leadLastName: "SAMPLE" })).toBeUndefined();
    expect(queueCandidates(reply, { startedAt: STARTED, leadLastName: "" })).toBeUndefined();
  });

  it("[FIX-W25-BOOKINGS AC1] tell when Queue List may have left PNRs out: it holds max of them, or meta.count says more", () => {
    const booking = { startedAt: STARTED, leadLastName: "SAMPLE" };
    const entries = [pnr("AAA111", minuteText(0), ["SAMPLE"]), pnr("BBB222", minuteText(0), ["OTHER"])];

    expect(queueCandidates({ meta: { count: 2 }, data: entries }, booking)?.truncated).toBe(false);
    expect(queueCandidates({ data: entries }, booking)?.truncated).toBe(false);
    expect(queueCandidates({ meta: { count: 3 }, data: entries }, booking)?.truncated).toBe(true);
    // The specification's example writes the count as a string.
    expect(queueCandidates({ meta: { count: "7" }, data: entries }, booking)?.truncated).toBe(true);
    expect(queueCandidates({ meta: { count: 2 }, data: entries }, booking, 2)?.truncated).toBe(true);
    expect(RECONCILE_QUEUE_LIST_MAX).toBeGreaterThan(RECONCILE_MAX_READS);
  });

  it("[FIX-W25-BOOKINGS AC1] are read at most RECONCILE_MAX_READS per attempt, the next attempt going on from there", () => {
    const candidates = Array.from({ length: 7 }, (_, index) => `C${index}`);

    expect(readSlice(candidates, 1, 3)).toEqual(["C0", "C1", "C2"]);
    expect(readSlice(candidates, 2, 3)).toEqual(["C3", "C4", "C5"]);
    // Round again: every candidate is read in turn.
    expect(readSlice(candidates, 3, 3)).toEqual(["C6", "C0", "C1"]);
    expect(readSlice(candidates, 1, 7)).toEqual(candidates);
    expect(readSlice(candidates, 4, 10)).toEqual(candidates);
  });

  it("[FIX-W25-BOOKINGS AC1] leave the search incomplete when the cap is hit, the answer may be truncated or an entry cannot be read", () => {
    const booking = { startedAt: STARTED, leadLastName: "SAMPLE" };
    const locators = (count: number): string[] =>
      Array.from({ length: count }, (_, index) => `C${String(index).padStart(5, "0")}`);
    /** The gap of an answer whose attempt `attempt` reads its `readSlice`. */
    const gapOf = (reply: unknown, attempt = 1): SearchGap | "unlisted" | undefined => {
      const listed = queueCandidates(reply, booking);
      return listed === undefined
        ? "unlisted"
        : listedGap(listed, readSlice(listed.candidates, attempt).length);
    };
    const named = (count: number) =>
      queueReply(...locators(count).map((locator) => pnr(locator, minuteText(0), ["SAMPLE"])));

    // RECONCILE_MAX_READS candidates are read in one attempt: the search is complete.
    expect(queueCandidates(named(RECONCILE_MAX_READS), booking)?.candidates).toHaveLength(
      RECONCILE_MAX_READS,
    );
    expect(gapOf(named(RECONCILE_MAX_READS))).toBeUndefined();
    // One more: each attempt reads the cap, never all of them, so none proves the order absent.
    expect(queueCandidates(named(RECONCILE_MAX_READS + 1), booking)?.candidates).toHaveLength(
      RECONCILE_MAX_READS + 1,
    );
    expect(gapOf(named(RECONCILE_MAX_READS + 1), 1)).toBe("read_cap");
    expect(gapOf(named(RECONCILE_MAX_READS + 1), 2)).toBe("read_cap");
    // An answer that holds RECONCILE_QUEUE_LIST_MAX PNRs may have left the order out, whatever it lists.
    const full = queueReply(
      ...locators(RECONCILE_QUEUE_LIST_MAX).map((locator) => pnr(locator, minuteText(30), ["OTHER"])),
    );
    expect(queueCandidates(full, booking)).toMatchObject({ candidates: [], truncated: true });
    expect(gapOf(full)).toBe("queue_truncated");
    // An entry of the window with the lead's name but no record locator.
    expect(gapOf(queueReply({ ...pnr("AAA111", minuteText(0), ["SAMPLE"]), id: "not a locator" }))).toBe(
      "candidate_unreadable",
    );
    // Nothing that may be the order in a complete answer: its search proves absence once its reads find nothing.
    expect(gapOf(queueReply(pnr("BBB222", minuteText(0), ["OTHER"])))).toBeUndefined();
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
    expect(reconcileDecision("incomplete", false)).toBe("wait");
  });

  it("[FIX-W25-BOOKINGS AC1] never fails the booking on an incomplete search: past reconcile_until the staff review it", () => {
    // Lead decision of 2026-10-21 (third batch): before the deadline the next attempt looks again; at it, the manual
    // review of OADR-0003 point 5 (the authorisation kept), never the void of a proven absence.
    expect(reconcileDecision("incomplete", false)).toBe("wait");
    expect(reconcileDecision("incomplete", true)).toBe("review");
    expect(reconcileDecision("incomplete", true)).not.toBe("fail");
  });

  it("[FIX-W24-BOOKINGS AC3] counts a claim without reconcile_until as stale only once its attempt started more than 2 minutes ago", () => {
    const now = new Date(STARTED.getTime() + 2 * MINUTE);

    expect(RECONCILE_ADOPT_AFTER_MS).toBe(2 * MINUTE);
    // The adoption takes claims started strictly before this instant: exactly 2 minutes ago is still fresh.
    expect(staleClaimBefore(now).getTime()).toBe(STARTED.getTime());
    expect(staleClaimBefore(new Date(now.getTime() + 1)).getTime()).toBeGreaterThan(STARTED.getTime());
    // Until it is adopted, an attempt does not touch it: its request may still be in flight.
    expect(reconcileClaimSkip(bookingRow({ reconcileUntil: null }), now)).toBe("not_reconciling");
  });

  it("[FIX-W24-BOOKINGS AC1] gives an adopted claim the normal window from its adoption, and claims it at once", () => {
    const adoptedAt = new Date(STARTED.getTime() + 2 * MINUTE + 1000);
    const until = adoptedReconcileUntil(adoptedAt);

    expect(until.getTime()).toBe(adoptedAt.getTime() + RECONCILE_WINDOW_MS);
    // Adopted: reconciled like any unknown outcome, the first attempt in the scan's own minute.
    expect(reconcileClaimSkip(bookingRow({ reconcileUntil: until }), adoptedAt)).toBeUndefined();
    // Not proven absent before the deadline of the adoption, whatever the claim's age.
    expect(reconcileDecision("absent", adoptedAt.getTime() >= until.getTime())).toBe("wait");
    expect(reconcileDecision("absent", true)).toBe("fail");
  });

  it("decides within the 15 minutes of OADR-0003, the orchestration's own window", () => {
    expect(RECONCILE_WINDOW_MS).toBe(15 * MINUTE);
    expect(ORCHESTRATOR_WINDOW_MS).toBe(RECONCILE_WINDOW_MS);
    expect(RECONCILE_FIRST_DELAY_MS).toBe(30_000);
    expect(RECONCILE_CLAIM_GAP_MS).toBeLessThan(MINUTE);
  });

  it("[FIX-W26-BOOKINGS AC2] tries a search that failed only transiently at reconcile_until again, up to 3 more attempts, then the staff review it", () => {
    // Lead decision (3) of 2026-10-22: one more attempt per reconcile run while fewer than 3 were given.
    expect(RECONCILE_DEADLINE_RETRIES).toBe(3);
    for (const used of [0, 1, 2]) {
      expect(reconcileDecision("incomplete", true, { transient: true, used })).toBe("retry");
    }
    expect(reconcileDecision("incomplete", true, { transient: true, used: 3 })).toBe("review");
    // Before the deadline nothing changes; past it, any other incomplete search is reviewed at once.
    expect(reconcileDecision("incomplete", false, { transient: true, used: 0 })).toBe("wait");
    expect(reconcileDecision("incomplete", true, { transient: false, used: 0 })).toBe("review");
    // A complete search, or an order found, decides as before, whatever the grace used.
    expect(reconcileDecision("absent", true, { transient: true, used: 1 })).toBe("fail");
    expect(reconcileDecision("no_queue", true, { transient: true, used: 1 })).toBe("fail");
    expect(reconcileDecision("found", true, { transient: true, used: 2 })).toBe("record");
  });

  it("[FIX-W26-BOOKINGS AC2] counts a rate limit, a timeout, a 5xx and a network error as transient, a refusal or a bug not", () => {
    const amadeus = (failure: ConstructorParameters<typeof AmadeusCallError>[1]): AppError =>
      mapAmadeusError("listQueue", failure);
    // Our buckets (no request sent), Amadeus's 429 and 502/503, a gateway's 504, no answer in time, a reset or a
    // connection never made, a 500 with 141 SYSTEM ERROR and any other 5xx.
    for (const error of [
      new AppError("RATE_LIMITED"),
      new AppError("SERVICE_UNAVAILABLE"),
      amadeus({ kind: "http", status: 429, issues: [] }),
      amadeus({ kind: "http", status: 502, issues: [] }),
      amadeus({ kind: "http", status: 503, issues: [] }),
      amadeus({ kind: "http", status: 504, issues: [] }),
      amadeus({
        kind: "http",
        status: 500,
        issues: [{ status: 500, code: 141, title: "SYSTEM ERROR HAS OCCURRED" }],
      }),
      amadeus({ kind: "http", status: 599, issues: [] }),
      amadeus({ kind: "timeout" }),
      amadeus({ kind: "network", code: "ECONNRESET" }),
      amadeus({ kind: "network", code: "ECONNREFUSED" }),
    ]) {
      expect(transientFailure(error), `${error.code}: ${String(error.cause)}`).toBe(true);
    }
    // A refusal, an office Amadeus refuses, credentials it refuses, an answer that cannot be read, a bug.
    for (const error of [
      amadeus({ kind: "http", status: 400, issues: [{ status: 400, code: 477, title: "INVALID FORMAT" }] }),
      amadeus({ kind: "http", status: 403, issues: [] }),
      amadeus({ kind: "http", status: 401, issues: [] }),
      amadeus({ kind: "http", status: 200, issues: [] }),
      new AppError("SUPPLIER_ERROR"),
      new AppError("SUPPLIER_NOT_CONFIGURED"),
      new Error("a bug"),
      undefined,
    ]) {
      expect(transientFailure(error), String(error)).toBe(false);
    }
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
