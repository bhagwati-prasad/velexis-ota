// The portal with the keyboard only (PFE-028 step 2; platform/frontend/README.md §2 and §4 "Forms", WCAG 2.2 AA 2.1.1,
// 2.4.3, 2.4.7, 2.4.11, 3.3.1), project `portal`:
//
//   the skip link → sign up: the form sent empty, whose error summary takes the focus and leads to its first field, then
//   filled → the verification link from Mailpit → sign in: the form sent empty (its error summary takes the focus), then
//   filled → "Create an OTA": the wizard's first step sent empty (its error summary takes the focus), then each step,
//   whose heading takes the focus → the set-up page until the OTA is ready → the OTA's overview → its team page: the
//   invitation form sent empty (its error summary takes the focus), then an invitation as a finance member → the
//   invitation is pending and its e-mail goes out
//
// Nothing is clicked, filled or selected through the DOM: every move is Tab or Shift+Tab, every choice the arrow keys,
// Space, Enter or typing, as a person without a mouse works. Opening the verification link is the one navigation by
// address: the person opens it from their mail program. Every focus stop of a control on the way shows a focus
// indicator (`:focus-visible` with an outline or a ring) that nothing on the page covers (2.4.7, 2.4.11; the probe of
// the storefront's keyboard journey, OFE-019), and every page the journey visits passes axe. The OTA is set up by the
// OTA worker, so the journey needs `E2E_WITH_OTA=1` and fails at once without it.
//
// The person is new: their account, their OTA and the invited address are the journey's own, typed into the portal's
// forms. The browser sends an end-user IP of its own (5 sign-ups per IP and hour, PF-01 AC3). The steps are tests in
// order (`mode: "serial"`) on one browser context made in `beforeAll`; the password stays in a variable.
import { randomBytes } from "node:crypto";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "../support/a11y";
import { expect, newAccountContext, test, uniqueTestIp, type PortalAccount } from "../support/fixtures";
import { uniqueEmail, waitForEmail, waitForLink } from "../support/mailpit";
import { buildAccount, stack } from "../support/seed";
import { PORTAL_URL } from "../support/stack";

test.describe.configure({ mode: "serial" });

/** How many key presses a move to one control may take before the journey says it cannot reach it. */
const MAX_TAB_PRESSES = 60;
/**
 * PF-11 AC1: the set-up page shows the OTA ready normally within one minute; the step waits for it at most 25 s of its
 * default 30-second budget (a set-up takes about 2 s on a developer machine).
 */
const READY_WAIT_MS = 25_000;

/** The person: an address of their own, typed into the forms by them. */
const person: PortalAccount = {
  ...buildAccount({ email: uniqueEmail("pfe028-keyboard"), fullName: "Kai Keyboard" }),
  endUserIp: uniqueTestIp(),
};
const otaKey = `e2ekb${randomBytes(5).toString("hex")}`;
const otaName = `Keyboard Travel ${otaKey.slice(5)}`;
/** The address the person invites. */
const invitee = uniqueEmail("pfe028-keyboard-invitee");

let context: BrowserContext;
let page: Page;
/** `/otas/<tenantId>`, once the wizard created the OTA. */
let otaPath: string;

/** Waits until `target` has the title of its page, then fails on any serious or critical axe violation. */
async function expectAccessible(target: Page, title: string): Promise<void> {
  await expect(target).toHaveTitle(`${title} · Velexis`);
  await expectNoSeriousA11yViolations(target);
}

/** What the page's focus is on: the element, whether it is a control, and how it shows the focus. */
interface FocusState {
  /** The focused element, for messages: its tag, its id, and its text. */
  readonly element: string;
  /** Whether it is a control a keyboard user operates (a link, button, field, …) rather than a focused heading. */
  readonly control: boolean;
  /** `:focus-visible` matches it. */
  readonly focusVisible: boolean;
  /** It (or its label, for a visually hidden field) draws an outline or a ring. */
  readonly indicator: boolean;
  /** Its centre is in the viewport and not covered by another element (2.4.11). */
  readonly unobscured: boolean;
}

/** The focus of the page, and where an element the journey moves to stands relative to it. */
interface FocusProbe {
  /** `null` when nothing but the document has the focus. */
  readonly state: FocusState | null;
  /** The element has the focus. */
  readonly reached: boolean;
  /** The element comes before the focus in the document: Shift+Tab moves towards it. */
  readonly backwards: boolean;
}

/**
 * Runs in the page (self-contained, as Playwright sends its source): the focus state, and where `target` stands. One
 * round trip per key press. The storefront's keyboard journey (OFE-019) probes the focus the same way.
 */
function probeFocus(target: Element | null): FocusProbe {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement) || element === document.body) {
    return { state: null, reached: false, backwards: false };
  }
  const text = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40);
  const control = element.matches(
    "a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex='-1'])",
  );
  const draws = (candidate: Element) => {
    const style = getComputedStyle(candidate);
    return (
      (style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0) ||
      style.boxShadow !== "none"
    );
  };
  const labels = element instanceof HTMLInputElement ? Array.from(element.labels ?? []) : [];
  const rect = element.getBoundingClientRect();
  const hidden = rect.width <= 1 || rect.height <= 1;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hit = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight ? document.elementFromPoint(x, y) : null;
  return {
    state: {
      element: `${element.tagName.toLowerCase()}${element.id === "" ? "" : `#${element.id}`} "${text}"`,
      control,
      focusVisible: element.matches(":focus-visible"),
      indicator: draws(element) || (hidden && labels.some(draws)),
      unobscured:
        hit !== null &&
        (hit === element ||
          element.contains(hit) ||
          labels.some((label) => label === hit || label.contains(hit))),
    },
    reached: target === element,
    backwards:
      target !== null && (target.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  };
}

/** A focused control shows a focus indicator and nothing covers it (WCAG 2.4.7, 2.4.11). */
function expectVisible(state: FocusState | null): void {
  if (state === null || !state.control) {
    // The document, or a heading, region or summary the page focused for screen readers (tabindex="-1").
    return;
  }
  expect(state, `the focus indicator of ${state.element}`).toMatchObject({
    focusVisible: true,
    indicator: true,
    unobscured: true,
  });
}

/**
 * Moves the focus to `target` with Tab, or Shift+Tab when it comes before the focus in the document, checking every
 * focus stop on the way (`expectVisible`); fails when MAX_TAB_PRESSES presses do not reach it.
 */
async function tabTo(target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  for (let presses = 0; ; presses += 1) {
    const probe = await target.evaluate(probeFocus);
    expectVisible(probe.state);
    if (probe.reached) {
      return;
    }
    if (presses === MAX_TAB_PRESSES) {
      throw new Error(`the keyboard did not reach ${String(target)} in ${MAX_TAB_PRESSES} presses`);
    }
    await page.keyboard.press(probe.backwards ? "Shift+Tab" : "Tab");
  }
}

/** Moves to `field` and types `text` into it with the keyboard, replacing what it holds. */
async function typeInto(field: Locator, text: string): Promise<void> {
  await tabTo(field);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await page.keyboard.type(text);
  await expect(field).toHaveValue(text);
}

/** Moves to the select `field` and chooses the option whose name starts with `typed` by typing it, as people do. */
async function chooseByTyping(field: Locator, typed: string, value: string): Promise<void> {
  await tabTo(field);
  await page.keyboard.type(typed);
  await expect(field).toHaveValue(value);
  await expect(field).toBeFocused();
}

/** Moves to `control` and presses Enter on it. */
async function press(control: Locator, key: "Enter" | "Space" = "Enter"): Promise<void> {
  await tabTo(control);
  await page.keyboard.press(key === "Space" ? " " : key);
}

/**
 * The form's error summary (`FormErrorSummary`) has the focus after a refused submission, names `firstProblem` first,
 * and its first link moves the focus to `field`.
 */
async function expectSummaryLeadsTo(scope: Locator, firstProblem: string, field: Locator): Promise<void> {
  const summary = scope.getByRole("alert").filter({ hasText: "There is a problem" });
  await expect(summary).toBeVisible();
  await expect(summary).toBeFocused();
  const first = summary.getByRole("link").first();
  await expect(first).toHaveText(firstProblem);
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await press(first);
  await expect(field).toBeFocused();
}

test.beforeAll(async ({ browser }) => {
  if (!stack().settings.E2E_WITH_OTA) {
    throw new Error(
      "portal-keyboard.e2e.ts sets up an OTA: run it with E2E_WITH_OTA=1 (the Amadeus stub and the OTA worker)",
    );
  }
  context = await newAccountContext(browser, person, PORTAL_URL);
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
});

test("the skip link, then the sign-up form sent empty: its error summary takes the focus and leads to the field; the person signs up [PFE-028 AC1]", async () => {
  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { level: 1, name: "Create your Velexis account" })).toBeVisible();
  await expectAccessible(page, "Sign up");

  // The first Tab reaches the skip link, which moves the focus to the main content.
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  expectVisible((await skip.evaluate(probeFocus)).state);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();

  const main = page.getByRole("main");
  await press(main.getByRole("button", { name: "Create account" }));
  await expectSummaryLeadsTo(main, "Enter your full name.", main.getByLabel("Full name"));
  await expectAccessible(page, "Sign up");

  await typeInto(main.getByLabel("Full name"), person.fullName);
  await typeInto(main.getByLabel("E-mail address"), person.email);
  await typeInto(main.getByLabel("Password"), person.password);
  const terms = main.getByLabel(/I accept the terms of service/);
  await tabTo(terms);
  await page.keyboard.press(" ");
  await expect(terms).toBeChecked();
  await press(main.getByRole("button", { name: "Create account" }));
  await page.waitForURL((url) => url.pathname === "/sign-up/check-email");
  await expect(page.getByRole("heading", { level: 1, name: "Check your e-mail" })).toBeVisible();
  await expectAccessible(page, "Check your e-mail");
});

test("the verification link verifies the address, and the person signs in with the keyboard after the empty form's error summary [PFE-028 AC1]", async () => {
  const link = await waitForLink({
    to: person.email,
    subject: "Confirm your e-mail address for Velexis",
    path: "/verify-email",
    origin: PORTAL_URL,
  });
  // Opened from the mail program: the one navigation by address.
  await page.goto(link.href);
  await page.waitForURL((url) => url.pathname === "/sign-in" && url.searchParams.get("verified") === "1");
  const main = page.getByRole("main");
  await expect(main.getByText("Your e-mail address is verified. Sign in to continue.")).toBeVisible();
  await expectAccessible(page, "Sign in");

  await press(main.getByRole("button", { name: "Sign in" }));
  await expectSummaryLeadsTo(main, "Enter your e-mail address.", main.getByLabel("E-mail address"));
  await expectAccessible(page, "Sign in");

  await typeInto(main.getByLabel("E-mail address"), person.email);
  await typeInto(main.getByLabel("Password", { exact: true }), person.password);
  await press(main.getByRole("button", { name: "Sign in" }));
  await page.waitForURL((url) => url.pathname === "/dashboard");
  await expect(page.getByRole("heading", { level: 1, name: "My OTAs" })).toBeVisible();
  await expectAccessible(page, "My OTAs");
});

test("creates an OTA in the wizard with the keyboard: the empty first step's error summary takes the focus, each next step's heading does [PFE-028 AC1]", async () => {
  const main = page.getByRole("main");
  await press(main.getByRole("link", { name: "Create an OTA" }).first());
  await page.waitForURL((url) => url.pathname === "/otas/new");
  await expect(main.getByRole("heading", { level: 2, name: "OTA details" })).toBeVisible();
  await expectAccessible(page, "Create an OTA");

  await press(main.getByRole("button", { name: "Continue" }));
  await expectSummaryLeadsTo(main, "Enter a name for your OTA.", main.getByLabel("OTA name"));
  await expectAccessible(page, "Create an OTA");

  await typeInto(main.getByLabel("OTA name"), otaName);
  await typeInto(main.getByLabel("OTA key"), otaKey);
  await expect(main.getByRole("status").filter({ hasText: "This key is available." })).toBeVisible();
  await chooseByTyping(main.getByLabel("Country"), "Germany", "DE");
  await chooseByTyping(main.getByLabel("Default currency"), "Euro", "EUR");
  await expect(main.getByLabel("Time zone")).not.toHaveValue("");
  await press(main.getByRole("button", { name: "Continue" }));

  // Each new step takes the focus on its heading.
  const plan = main.getByRole("heading", { level: 2, name: "Plan" });
  await expect(plan).toBeFocused();
  await expectAccessible(page, "Create an OTA");
  await press(main.getByRole("button", { name: "Continue" }));
  const review = main.getByRole("heading", { level: 2, name: "Review" });
  await expect(review).toBeFocused();
  await expect(main.getByRole("definition").filter({ hasText: otaName })).toBeVisible();
  await expectAccessible(page, "Create an OTA");

  await press(main.getByRole("button", { name: "Create OTA" }));
  await page.waitForURL(/\/otas\/ten_[0-9A-HJKMNP-TV-Z]{26}\/setup$/);
  otaPath = new URL(page.url()).pathname.replace(/\/setup$/, "");
  await expect(main.getByRole("heading", { level: 1, name: otaName })).toBeVisible();
  await expectAccessible(page, "OTA set-up");
});

test("the set-up page shows the OTA ready, and the keyboard leads on to the OTA and its team page [PFE-028 AC1]", async () => {
  const main = page.getByRole("main");
  // The page polls the set-up every 2 seconds on its own; the journey only watches it.
  await expect(main.getByRole("heading", { name: "Your OTA is ready" })).toBeVisible({
    timeout: READY_WAIT_MS,
  });
  await expectAccessible(page, "OTA set-up");

  await press(main.getByRole("link", { name: "Go to the OTA dashboard" }));
  await page.waitForURL((url) => url.pathname === otaPath);
  await expect(main.getByRole("heading", { level: 1, name: otaName })).toBeVisible();
  await expectAccessible(page, "Overview");

  // The side navigation of the OTA: its "Team" entry.
  await press(page.getByRole("navigation", { name: "Portal" }).getByRole("link", { name: "Team" }));
  await page.waitForURL((url) => url.pathname === `${otaPath}/team`);
  await expect(main.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();
  await expectAccessible(page, "Team");
});

test("invites a member with the keyboard: the empty form's error summary takes the focus, then the invitation goes out [PFE-028 AC1]", async () => {
  const form = page.getByRole("main").locator('[data-form="invite"]');
  await press(form.getByRole("button", { name: "Send the invitation" }));
  const address = form.getByLabel("E-mail address", { exact: true });
  await expectSummaryLeadsTo(form, "Enter the e-mail address to invite.", address);
  await expectAccessible(page, "Team");

  await typeInto(address, invitee);
  await chooseByTyping(form.getByLabel("Role", { exact: true }), "Finance", "finance");
  await press(form.getByRole("button", { name: "Send the invitation" }));
  await expect(
    page
      .getByRole("main")
      .getByRole("status")
      .filter({ hasText: /^The invitation is on its way\./ }),
  ).toBeVisible();
  const pending = page
    .getByRole("table", { name: "Pending invitations" })
    .getByRole("row")
    .filter({ hasText: invitee });
  await expect(pending).toContainText("Finance");
  await expectAccessible(page, "Team");
  await waitForEmail({ to: invitee, subject: `${person.fullName} invited you to ${otaName} on Velexis` });
});
