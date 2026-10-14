// Accessibility checks of end-to-end journeys (PFE-014; ADR-0014 and ADR-0015: WCAG 2.2 AA, checked with axe).
//
//   await page.goto("/dashboard");
//   await expectNoSeriousA11yViolations(page);
//
// Call it on every page a journey visits, once the page shows what the journey came for. It fails on any violation
// of impact `serious` or `critical` of the WCAG 2.0, 2.1 and 2.2 A and AA rules, and names each rule, its help URL
// and the elements (CSS selectors) that break it. Minor and moderate findings are not failures.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/** The axe rule sets of WCAG 2.2 level AA (which includes A and the earlier versions). */
export const WCAG_22_AA_TAGS = Object.freeze([
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
] as const);

/** The impacts that fail a journey. */
export const FAILING_IMPACTS = Object.freeze(["serious", "critical"] as const);

export interface A11yOptions {
  /** CSS selectors to leave out, for third-party content the journey does not own (a Stripe iframe). */
  readonly exclude?: readonly string[];
}

/** The part of an axe violation that the failure message shows. */
export interface A11yViolation {
  readonly id: string;
  readonly impact?: string | null;
  readonly help: string;
  readonly helpUrl: string;
  readonly nodes: readonly { readonly target: readonly unknown[] }[];
}

/** The serious and critical violations among `violations`. */
export function seriousViolations<V extends Pick<A11yViolation, "impact">>(violations: readonly V[]): V[] {
  return violations.filter((violation) =>
    (FAILING_IMPACTS as readonly string[]).includes(violation.impact ?? ""),
  );
}

/** One line per violation and one per element, without page content. */
export function formatViolations(violations: readonly A11yViolation[]): string {
  return violations
    .map((violation) => {
      const targets = violation.nodes.map((node) => `    - ${node.target.map(String).join(" ")}`);
      return [`  ${violation.impact ?? "unknown"}: ${violation.id}: ${violation.help} (${violation.helpUrl})`]
        .concat(targets)
        .join("\n");
    })
    .join("\n");
}

/** Runs axe on `page` with the WCAG 2.2 AA rules and fails on any serious or critical violation. */
export async function expectNoSeriousA11yViolations(page: Page, options: A11yOptions = {}): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags([...WCAG_22_AA_TAGS]);
  for (const selector of options.exclude ?? []) {
    builder = builder.exclude(selector);
  }
  const { violations } = await builder.analyze();
  const failing = seriousViolations(violations);
  expect(
    failing.map((violation) => `${violation.impact ?? "unknown"}: ${violation.id}`),
    `serious or critical accessibility violations on ${page.url()}:\n${formatViolations(failing)}`,
  ).toEqual([]);
}
