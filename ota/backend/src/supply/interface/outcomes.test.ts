// The outcome sets equal the action table of the multi-supplier plan §4.1 (OBE-110): the same nine actions in the
// same order, each with exactly its outcomes. The table below is the plan's, copied cell for cell; the first test
// reads the plan itself, so a change on either side fails here until both agree.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { APP_DIR } from "../../config";
import {
  ACTION_OUTCOMES,
  SUPPLY_ACTIONS,
  type CancelOrReleaseOutcome,
  type CheckPayableOutcome,
  type CreateOrderOutcome,
  type FindOrderOutcome,
  type OutcomeOf,
  type PriceOutcome,
  type ReadOrderOutcome,
  type RequestTicketingOutcome,
  type SearchOutcome,
  type ServiceRequestOutcome,
  type SupplyAction,
} from "./index";

const PLAN = join(APP_DIR, "..", "..", "docs", "mvp", "plans", "multi-supplier-plan.md");

/** The plan's action table: the label of each row, its outcomes, and the action of the interface it maps to. */
const PLAN_ACTIONS: ReadonlyArray<{ label: string; outcomes: readonly string[]; action: SupplyAction }> = [
  { label: "Search", outcomes: ["ok", "empty", "failed", "timed_out", "skipped"], action: "search" },
  { label: "Price, extras", outcomes: ["priced", "sold_out", "refused", "unavailable"], action: "price" },
  { label: "Create order", outcomes: ["created", "rejected", "not_sent", "unknown"], action: "createOrder" },
  {
    label: "Find order, after a lost answer",
    outcomes: ["found", "absent", "incomplete"],
    action: "findOrder",
  },
  {
    label: "Check payable (new)",
    outcomes: ["payable", "refused", "higher_amount", "balance_short", "unknown"],
    action: "checkPayable",
  },
  {
    label: "Request ticketing",
    outcomes: ["issued", "accepted", "rejected", "balance_refused", "unknown"],
    action: "requestTicketing",
  },
  {
    label: "Read order (sync, polling)",
    outcomes: ["order", "not_found", "unavailable"],
    action: "readOrder",
  },
  {
    label: "Cancel or release",
    outcomes: ["cancelled", "order_not_found", "refused", "version_conflict", "not_sent", "unknown"],
    action: "cancelOrRelease",
  },
  {
    label: "Service request (void, refund, change)",
    outcomes: ["quoted", "submitted", "completed", "refused"],
    action: "serviceRequest",
  },
];

/** The rows of the first table under `heading` in the plan, as trimmed cells (header and separator left out). */
function planTable(heading: string): string[][] {
  const lines = readFileSync(PLAN, "utf8").split("\n");
  const start = lines.indexOf(heading);
  expect(start, `${heading} in ${PLAN}`).toBeGreaterThanOrEqual(0);
  const first = lines.findIndex((line, index) => index > start && line.startsWith("|"));
  const rows: string[][] = [];
  for (let index = first + 2; index < lines.length && lines[index]?.startsWith("|"); index += 1) {
    rows.push(
      (lines[index] as string)
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
  }
  return rows;
}

describe("the outcome sets (plan §4.1)", () => {
  it("the plan's action table is the one this test copies", () => {
    const rows = planTable("### 4.1 The ingestion engine").map(([label, outcomes]) => ({
      label,
      outcomes: [...(outcomes ?? "").matchAll(/`([a-z_]+)`/g)].map((match) => match[1]),
    }));
    expect(rows).toEqual(PLAN_ACTIONS.map(({ label, outcomes }) => ({ label, outcomes })));
  });

  it("has one action per row of the table, in its order", () => {
    expect(SUPPLY_ACTIONS).toEqual(PLAN_ACTIONS.map(({ action }) => action));
    expect(Object.keys(ACTION_OUTCOMES)).toEqual([...SUPPLY_ACTIONS]);
  });

  it.each(PLAN_ACTIONS)("$label has exactly the outcomes of the table", ({ action, outcomes }) => {
    expect(ACTION_OUTCOMES[action]).toEqual(outcomes);
    expect(new Set(ACTION_OUTCOMES[action]).size).toBe(outcomes.length);
  });

  it("freezes every set", () => {
    expect(Object.isFrozen(ACTION_OUTCOMES)).toBe(true);
    expect(Object.isFrozen(SUPPLY_ACTIONS)).toBe(true);
    for (const action of SUPPLY_ACTIONS) {
      expect(Object.isFrozen(ACTION_OUTCOMES[action]), action).toBe(true);
    }
  });

  it("types each outcome set as the union of its names", () => {
    expectTypeOf<SearchOutcome>().toEqualTypeOf<"ok" | "empty" | "failed" | "timed_out" | "skipped">();
    expectTypeOf<PriceOutcome>().toEqualTypeOf<"priced" | "sold_out" | "refused" | "unavailable">();
    expectTypeOf<CreateOrderOutcome>().toEqualTypeOf<"created" | "rejected" | "not_sent" | "unknown">();
    expectTypeOf<FindOrderOutcome>().toEqualTypeOf<"found" | "absent" | "incomplete">();
    expectTypeOf<CheckPayableOutcome>().toEqualTypeOf<
      "payable" | "refused" | "higher_amount" | "balance_short" | "unknown"
    >();
    expectTypeOf<RequestTicketingOutcome>().toEqualTypeOf<
      "issued" | "accepted" | "rejected" | "balance_refused" | "unknown"
    >();
    expectTypeOf<ReadOrderOutcome>().toEqualTypeOf<"order" | "not_found" | "unavailable">();
    expectTypeOf<CancelOrReleaseOutcome>().toEqualTypeOf<
      "cancelled" | "order_not_found" | "refused" | "version_conflict" | "not_sent" | "unknown"
    >();
    expectTypeOf<ServiceRequestOutcome>().toEqualTypeOf<"quoted" | "submitted" | "completed" | "refused">();
    expectTypeOf<OutcomeOf<"search">>().toEqualTypeOf<SearchOutcome>();
    expectTypeOf<OutcomeOf<"cancelOrRelease">>().toEqualTypeOf<CancelOrReleaseOutcome>();
    expectTypeOf<SupplyAction>().toEqualTypeOf<keyof typeof ACTION_OUTCOMES>();
  });
});
