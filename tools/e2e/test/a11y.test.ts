import { errors } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatViolations,
  SETTLE_BUDGET_MS,
  seriousViolations,
  stylesSettled,
  waitForSettledStyles,
  WCAG_22_AA_TAGS,
  type A11yViolation,
} from "../support/a11y";

const violation = (id: string, impact: string | null): A11yViolation => ({
  id,
  impact,
  help: `${id} help`,
  helpUrl: `https://dequeuniversity.com/rules/axe/4.13/${id}`,
  nodes: [{ target: ["main > img"] }, { target: ["#footer", "a"] }],
});

describe("seriousViolations", () => {
  it("keeps serious and critical violations and drops minor, moderate and unrated ones", () => {
    const violations = [
      violation("image-alt", "critical"),
      violation("color-contrast", "serious"),
      violation("region", "moderate"),
      violation("meta-viewport-large", "minor"),
      violation("unknown", null),
    ];
    expect(seriousViolations(violations).map((v) => v.id)).toEqual(["image-alt", "color-contrast"]);
  });
});

describe("formatViolations", () => {
  it("names the impact, rule, help and every element, one per line", () => {
    expect(formatViolations([violation("image-alt", "critical")])).toBe(
      [
        "  critical: image-alt: image-alt help (https://dequeuniversity.com/rules/axe/4.13/image-alt)",
        "    - main > img",
        "    - #footer a",
      ].join("\n"),
    );
  });
});

describe("WCAG_22_AA_TAGS", () => {
  it("covers levels A and AA of WCAG 2.0, 2.1 and 2.2 (ADR-0014)", () => {
    expect([...WCAG_22_AA_TAGS]).toEqual(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
  });
});

/** An animation of the document as `stylesSettled` reads it. */
const animation = (playState: AnimationPlayState, iterations = 1) => ({
  playState,
  effect: { getComputedTiming: () => ({ iterations }) },
});

describe("stylesSettled", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const settledWith = (animations: readonly unknown[]): boolean => {
    vi.stubGlobal("document", { getAnimations: () => animations });
    return stylesSettled();
  };

  it("is false while a finite transition or animation runs, such as a button fading between two variants", () => {
    expect(settledWith([animation("running")])).toBe(false);
    expect(settledWith([animation("finished"), animation("running", 3)])).toBe(false);
  });

  it("is true when nothing runs, everything has finished or is paused, or only endless animations run", () => {
    expect(settledWith([])).toBe(true);
    expect(settledWith([animation("finished"), animation("paused"), animation("idle")])).toBe(true);
    expect(settledWith([animation("running", Infinity)])).toBe(true);
  });
});

describe("waitForSettledStyles", () => {
  it("waits in the page for stylesSettled with the settle budget", async () => {
    const waitForFunction = vi.fn(async () => undefined);
    await waitForSettledStyles({ waitForFunction } as never);
    expect(waitForFunction).toHaveBeenCalledWith(stylesSettled, undefined, { timeout: SETTLE_BUDGET_MS });
  });

  it("lets axe run after the budget when an animation is still running", async () => {
    const waitForFunction = vi.fn(async () => {
      throw new errors.TimeoutError("page.waitForFunction: Timeout 2000ms exceeded.");
    });
    await expect(waitForSettledStyles({ waitForFunction } as never)).resolves.toBeUndefined();
  });

  it("passes on any other error, such as a closed page", async () => {
    const closed = new Error("page.waitForFunction: Target page, context or browser has been closed");
    const waitForFunction = vi.fn(async () => {
      throw closed;
    });
    await expect(waitForSettledStyles({ waitForFunction } as never)).rejects.toBe(closed);
  });
});
