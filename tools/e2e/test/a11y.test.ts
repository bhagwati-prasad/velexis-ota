import { describe, expect, it } from "vitest";
import { formatViolations, seriousViolations, WCAG_22_AA_TAGS, type A11yViolation } from "../support/a11y";

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
