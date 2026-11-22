import { describe, expect, it } from "vitest";

import { NEW_OTA_PATH, newOtaPath, planCodeOf } from "./plan-code";

describe("the plan chosen on /pricing (FIX-W69-SIGNUP, KI-009)", () => {
  it("[FIX-W69-SIGNUP AC3] accepts only a plan code the platform document allows", () => {
    for (const code of ["early_access", "growth", "s1", `p${"x".repeat(39)}`]) {
      expect(planCodeOf(code)).toBe(code);
    }
    for (const value of [
      undefined,
      null,
      "",
      "g",
      "Growth",
      "1growth",
      "_growth",
      "growth-plan",
      "growth plan",
      "growth&next=//evil.example",
      "../admin",
      `p${"x".repeat(40)}`,
      ["growth", "scale"],
    ]) {
      expect(planCodeOf(value)).toBeUndefined();
    }
  });

  it("[FIX-W69-SIGNUP AC3] builds the wizard's path with the plan, or without a well-formed one", () => {
    expect(newOtaPath("growth")).toBe("/otas/new?plan=growth");
    expect(newOtaPath(undefined)).toBe(NEW_OTA_PATH);
    expect(newOtaPath("Growth!")).toBe("/otas/new");
  });
});
