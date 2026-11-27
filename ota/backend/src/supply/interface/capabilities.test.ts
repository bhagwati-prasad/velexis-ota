// The capability declaration has the rows and values of the capability table of the multi-supplier plan §4.2
// (OBE-110). The table below is the plan's, copied cell for cell, with the code of each value beside it; the first
// test reads the plan itself, so a change on either side fails here until both agree.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { APP_DIR } from "../../config";
import {
  CAPABILITY_ROWS,
  EXTRAS,
  FIND_ORDER_MODES,
  SERVICE_MODES,
  SERVICE_OPERATIONS,
  TICKET_ISSUANCE,
  TICKET_PAYMENT,
  WHEN_CAPABILITY_MISSING,
  type CapabilityRow,
  type SupplierCapabilities,
} from "./index";

const PLAN = join(APP_DIR, "..", "..", "docs", "mvp", "plans", "multi-supplier-plan.md");

/** The plan's capability table, cell for cell, and the row of the declaration each line maps to. */
const PLAN_CAPABILITIES: ReadonlyArray<{
  label: string;
  values: string;
  whenMissing: string;
  row: CapabilityRow;
  missing: (typeof WHEN_CAPABILITY_MISSING)[CapabilityRow];
}> = [
  {
    label: "Search limits",
    values: "journeys, travellers, currencies",
    whenMissing: "the source is skipped for that query",
    row: "searchLimits",
    missing: "skip_source",
  },
  {
    label: "Extras",
    values: "bags, seats, after booking",
    whenMissing: "the step is skipped for that booking (owner)",
    row: "extras",
    missing: "skip_step",
  },
  {
    label: "Find order",
    values: "by queue and remark, by our reference, none",
    whenMissing: "a lost answer goes to staff (4.10)",
    row: "findOrder",
    missing: "to_staff",
  },
  {
    label: "Ticketing",
    values: "now or later; paid by the agency or from a supplier balance; ticket numbers may be absent",
    whenMissing: "required",
    row: "ticketing",
    missing: "required",
  },
  {
    label: "Cancel, void, refund, change",
    values: "by API, by request, none",
    whenMissing: 'today\'s "request only" path',
    row: "servicing",
    missing: "request_only",
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

/** A declaration with a value in every row: it compiles only while the type has exactly these members. */
const DECLARATION = {
  searchLimits: { maxJourneys: 2, maxTravellers: 9, currencies: ["EUR", "USD"] },
  extras: { bags: true, seats: false, afterBooking: false },
  findOrder: "none",
  ticketing: { issuance: "later", payment: "supplier_balance", ticketNumbersMayBeAbsent: true },
  servicing: { cancel: "api", void: "request", refund: "request", change: "none" },
} as const satisfies SupplierCapabilities;

describe("the capability declaration (plan §4.2)", () => {
  it("the plan's capability table is the one this test copies", () => {
    expect(planTable("### 4.2 The supplier interface and the adapters")).toEqual(
      PLAN_CAPABILITIES.map(({ label, values, whenMissing }) => [label, values, whenMissing]),
    );
  });

  it("has one row per line of the table, in its order, each with the flow's answer when missing", () => {
    expect(CAPABILITY_ROWS).toEqual(PLAN_CAPABILITIES.map(({ row }) => row));
    expect(Object.keys(DECLARATION)).toEqual([...CAPABILITY_ROWS]);
    expect(WHEN_CAPABILITY_MISSING).toEqual(
      Object.fromEntries(PLAN_CAPABILITIES.map(({ row, missing }) => [row, missing])),
    );
    expectTypeOf<keyof SupplierCapabilities>().toEqualTypeOf<CapabilityRow>();
  });

  it("search limits: journeys, travellers, currencies", () => {
    expect(Object.keys(DECLARATION.searchLimits)).toEqual(["maxJourneys", "maxTravellers", "currencies"]);
    expectTypeOf<SupplierCapabilities["searchLimits"]>().toEqualTypeOf<{
      readonly maxJourneys: number;
      readonly maxTravellers: number;
      readonly currencies: "any" | readonly string[];
    }>();
  });

  it("extras: bags, seats, after booking", () => {
    expect(EXTRAS).toEqual(["bags", "seats", "afterBooking"]);
    expectTypeOf<SupplierCapabilities["extras"]>().toEqualTypeOf<{
      readonly bags: boolean;
      readonly seats: boolean;
      readonly afterBooking: boolean;
    }>();
  });

  it("find order: by queue and remark, by our reference, none", () => {
    expect(FIND_ORDER_MODES).toEqual(["queue_and_remark", "our_reference", "none"]);
    expectTypeOf<SupplierCapabilities["findOrder"]>().toEqualTypeOf<
      "queue_and_remark" | "our_reference" | "none"
    >();
  });

  it("ticketing: now or later; paid by the agency or from a supplier balance; ticket numbers may be absent", () => {
    expect(TICKET_ISSUANCE).toEqual(["now", "later"]);
    expect(TICKET_PAYMENT).toEqual(["agency", "supplier_balance"]);
    expect(Object.keys(DECLARATION.ticketing)).toEqual(["issuance", "payment", "ticketNumbersMayBeAbsent"]);
    expectTypeOf<SupplierCapabilities["ticketing"]>().toEqualTypeOf<{
      readonly issuance: "now" | "later";
      readonly payment: "agency" | "supplier_balance";
      readonly ticketNumbersMayBeAbsent: boolean;
    }>();
  });

  it("cancel, void, refund, change: by API, by request, none", () => {
    expect(SERVICE_OPERATIONS).toEqual(["cancel", "void", "refund", "change"]);
    expect(SERVICE_MODES).toEqual(["api", "request", "none"]);
    expectTypeOf<SupplierCapabilities["servicing"]>().toEqualTypeOf<{
      readonly cancel: "api" | "request" | "none";
      readonly void: "api" | "request" | "none";
      readonly refund: "api" | "request" | "none";
      readonly change: "api" | "request" | "none";
    }>();
  });

  it("freezes every list", () => {
    for (const list of [
      CAPABILITY_ROWS,
      WHEN_CAPABILITY_MISSING,
      EXTRAS,
      FIND_ORDER_MODES,
      TICKET_ISSUANCE,
      TICKET_PAYMENT,
      SERVICE_OPERATIONS,
      SERVICE_MODES,
    ]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });
});
