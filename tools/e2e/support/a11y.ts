// Accessibility checks of end-to-end journeys (PFE-014; ADR-0014 and ADR-0015: WCAG 2.2 AA, checked with axe).
//
//   await page.goto("/dashboard");
//   await expectNoSeriousA11yViolations(page);
//
// Call it on every page a journey visits, once the page shows what the journey came for. It fails on any violation
// of impact `serious` or `critical` of the WCAG 2.0, 2.1 and 2.2 A and AA rules, and names each rule, its help URL
// and the elements (CSS selectors) that break it. Minor and moderate findings are not failures. Axe runs once the
// page's CSS transitions and animations have ended (waitForSettledStyles), so it judges the colours the page shows,
// not a frame of a fade between two of them.
import AxeBuilder from "@axe-core/playwright";
import { errors, expect, type Page } from "@playwright/test";

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

/**
 * How long axe waits for running transitions and animations to end. The apps' transitions last 150 to 200 ms (the
 * shadcn components' `transition-all`, the dialogs' fade-out); 2 s covers a busy CI runner.
 */
export const SETTLE_BUDGET_MS = 2_000;

/**
 * In the browser: whether no finite CSS transition or animation of the document is running. A transition between
 * two colours that both keep 4.5:1 can pass through colours that do not: in e2e run 41015776555 axe measured the
 * platform admin's "Resume" button while `transition-all` faded it into the destructive "Suspend" one. Animations
 * that never end (a spinner) are not waited for. Playwright sends this function's source to the page, so it uses
 * nothing from its module.
 */
export function stylesSettled(): boolean {
  return document
    .getAnimations()
    .every(
      (animation) =>
        animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity,
    );
}

/**
 * Waits for `stylesSettled` up to SETTLE_BUDGET_MS. A longer animation is not a reason to fail the journey: axe then
 * runs on what the page shows, as it would without the wait.
 */
export async function waitForSettledStyles(page: Pick<Page, "waitForFunction">): Promise<void> {
  try {
    await page.waitForFunction(stylesSettled, undefined, { timeout: SETTLE_BUDGET_MS });
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) {
      throw error;
    }
  }
}

/** Runs axe on `page` with the WCAG 2.2 AA rules and fails on any serious or critical violation. */
export async function expectNoSeriousA11yViolations(page: Page, options: A11yOptions = {}): Promise<void> {
  await waitForSettledStyles(page);
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
