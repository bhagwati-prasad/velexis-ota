import { describe, expect, it } from "vitest";
import { defineBuilder } from "./builders.js";

// Tests of task X-015 step 4: defineBuilder<T>(defaults).

interface PlanRow {
  code: string;
  name: string;
  monthly_price: string;
  features: string[];
  limits: { searches: number };
}

describe("defineBuilder", () => {
  it("builds from a defaults function with a sequence number, and applies shallow overrides", () => {
    const buildPlan = defineBuilder<PlanRow>((n) => ({
      code: `plan_${n}`,
      name: `Plan ${n}`,
      monthly_price: "10.00",
      features: ["search"],
      limits: { searches: 100 },
    }));
    expect(buildPlan()).toEqual({
      code: "plan_1",
      name: "Plan 1",
      monthly_price: "10.00",
      features: ["search"],
      limits: { searches: 100 },
    });
    expect(buildPlan({ name: "Starter", limits: { searches: 5 } })).toEqual({
      code: "plan_2",
      name: "Starter",
      monthly_price: "10.00",
      features: ["search"],
      limits: { searches: 5 },
    });
    expect(buildPlan((n) => ({ monthly_price: `${n}.00` })).monthly_price).toBe("3.00");
    expect(buildPlan.next).toBe(4);
  });

  it("copies object defaults on every build, so changing one value never changes the next", () => {
    const build = defineBuilder<PlanRow>({
      code: "starter",
      name: "Starter",
      monthly_price: "0.00",
      features: ["search"],
      limits: { searches: 10 },
    });
    const first = build();
    first.features.push("book");
    first.limits.searches = 0;
    expect(build()).toEqual({
      code: "starter",
      name: "Starter",
      monthly_price: "0.00",
      features: ["search"],
      limits: { searches: 10 },
    });
    expect(build()).not.toBe(build());
  });

  it("many(count) builds distinct values; reset() starts the sequence again", () => {
    const build = defineBuilder<{ id: string; email: string }>((n) => ({
      id: `cus_${n}`,
      email: `c${n}@example.com`,
    }));
    expect(build.many(3).map((row) => row.id)).toEqual(["cus_1", "cus_2", "cus_3"]);
    expect(build.many(2, (n) => ({ email: `vip${n}@example.com` }))).toEqual([
      { id: "cus_4", email: "vip4@example.com" },
      { id: "cus_5", email: "vip5@example.com" },
    ]);
    expect(build.many(0)).toEqual([]);
    expect(() => build.many(-1)).toThrow(new RangeError("Builder.many: count must be an integer, 0 or more"));
    expect(() => build.many(1.5)).toThrow(RangeError);
    build.reset();
    expect(build.next).toBe(1);
    expect(build().id).toBe("cus_1");
  });

  it("keeps separate sequences per builder", () => {
    const a = defineBuilder<{ n: number }>((n) => ({ n }));
    const b = defineBuilder<{ n: number }>((n) => ({ n }));
    a();
    a();
    expect(b().n).toBe(1);
    expect(a().n).toBe(3);
  });
});
