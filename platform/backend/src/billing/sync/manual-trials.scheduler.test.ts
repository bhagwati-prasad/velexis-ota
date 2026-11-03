// The steps of a manual trial (PBE-047; subscription-billing flow §G, PADR-0002 item 9, scope PF-75 AC1), as a table:
// what `billing.manual_trials` does on each UTC day around a trial's end, whatever the time of day of the run or of the
// end. The run itself (locks, e-mails, audit, suspension) is proven by test/integration/billing/billing-schedules.int.test.ts.
import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  manualTrialStep,
  timeLeftText,
  TRIAL_ENDING_NOTICE,
  utcDate,
  utcDay,
  type ManualTrialState,
} from "./manual-trials.scheduler";

/** A trial that ends on 2027-03-20 at 15:00 UTC, as an admin may have set it. */
const END = new Date("2027-03-20T15:00:00.000Z");

/** The daily run at 08:10 UTC, `offset` days after the end day (negative before). */
const runOn = (offset: number): Date => new Date(Date.UTC(2027, 2, 20 + offset, 8, 10));

function trialing(billingNotice: string | null = null): ManualTrialState {
  return {
    status: "trialing",
    trialEndsAt: END,
    updatedAt: new Date("2026-12-20T15:00:00.000Z"),
    billingNotice,
  };
}

/** A trial that became `past_due` on the day `pastDueOn` (days after the end day), at the run's time. */
function pastDue(pastDueOn = 0): ManualTrialState {
  return {
    status: "past_due",
    trialEndsAt: END,
    updatedAt: runOn(pastDueOn),
    billingNotice: TRIAL_ENDING_NOTICE,
  };
}

describe("manualTrialStep", () => {
  it.each([
    [-30, null, null],
    [-15, null, null],
    [-14, 14, null],
    [-10, 14, null],
    [-4, 14, null],
    [-3, 3, null],
    [-1, 3, null],
    [0, null, "past_due"],
    [5, null, "past_due"],
  ] as const)(
    "[PBE-047 AC2] a trialing row, %i days from its end day: notice %s, transition %s",
    (offset, notice, transition) => {
      const step = manualTrialStep(trialing(), runOn(offset));

      expect(step).toEqual({
        notice,
        billingNotice: offset >= -14 ? TRIAL_ENDING_NOTICE : null,
        transition,
      });
    },
  );

  it("[PBE-047 AC2] counts UTC days: a run at 00:00 and one at 23:59 of the same day do the same step", () => {
    const early = manualTrialStep(trialing(), new Date("2027-03-06T00:00:00.000Z"));
    const late = manualTrialStep(trialing(), new Date("2027-03-06T23:59:59.999Z"));
    const dayBefore = manualTrialStep(trialing(), new Date("2027-03-05T23:59:59.999Z"));

    expect(early).toEqual(late);
    expect(early.notice).toBe(14);
    expect(dayBefore.notice).toBeNull();
    // On the end day the row is past due even before the trial's own time of day.
    expect(manualTrialStep(trialing(), new Date("2027-03-20T00:00:00.000Z")).transition).toBe("past_due");
  });

  it.each([
    [13, 0, null],
    [14, 0, "canceled"],
    [20, 0, "canceled"],
    // A trial that ended before the first run: past due from day 30, suspended only 14 days after that.
    [43, 30, null],
    [44, 30, "canceled"],
  ] as const)(
    "[PBE-047 AC2] a past_due row on day %i after the end, past due since day %i: transition %s",
    (offset, since, transition) => {
      expect(manualTrialStep(pastDue(since), runOn(offset))).toEqual({
        notice: null,
        billingNotice: TRIAL_ENDING_NOTICE,
        transition,
      });
    },
  );

  it("clears the trial's banner of a trial an admin moved out of the notice window, and keeps any other banner", () => {
    expect(manualTrialStep(trialing(TRIAL_ENDING_NOTICE), runOn(-20))).toEqual({
      notice: null,
      billingNotice: null,
      transition: null,
    });
    expect(manualTrialStep(trialing("past_due"), runOn(-20)).billingNotice).toBe("past_due");
  });

  it("clears the trial's banner of a manual subscription an admin set active (paid outside Stripe), and keeps any other banner", () => {
    const paid: ManualTrialState = { ...trialing(TRIAL_ENDING_NOTICE), status: "active" };

    for (const offset of [-10, 0, 30]) {
      expect(manualTrialStep(paid, runOn(offset))).toEqual({
        notice: null,
        billingNotice: null,
        transition: null,
      });
    }
    expect(manualTrialStep({ ...paid, trialEndsAt: null }, runOn(0)).billingNotice).toBeNull();
    expect(manualTrialStep({ ...paid, billingNotice: "past_due" }, runOn(0)).billingNotice).toBe("past_due");
  });

  it("does nothing for a row in another status, or for a trial without an end", () => {
    const canceled: ManualTrialState = { ...trialing(TRIAL_ENDING_NOTICE), status: "canceled" };
    const noEnd: ManualTrialState = { ...trialing(TRIAL_ENDING_NOTICE), trialEndsAt: null };

    for (const state of [canceled, noEnd, { ...pastDue(), trialEndsAt: null }]) {
      expect(manualTrialStep(state, runOn(30))).toEqual({
        notice: null,
        billingNotice: TRIAL_ENDING_NOTICE,
        transition: null,
      });
    }
  });
});

describe("days and dates", () => {
  it("utcDay and utcDate count whole UTC days", () => {
    const day = utcDay(END);

    expect(utcDate(day)).toBe("2027-03-20");
    expect(utcDay(new Date(day * DAY_MS))).toBe(day);
    expect(utcDay(new Date((day + 1) * DAY_MS - 1))).toBe(day);
    expect(utcDate(day + 14)).toBe("2027-04-03");
  });

  it("timeLeftText says tomorrow for one day and counts days otherwise", () => {
    expect(timeLeftText(1)).toBe("tomorrow");
    expect(timeLeftText(3)).toBe("in 3 days");
    expect(timeLeftText(14)).toBe("in 14 days");
  });
});
