// The keyboard-only checkout journey of the hosted storefront (OFE-019; ota/frontend/README.md §8 "Keyboard" and
// §13 journey 5, WCAG 2.2 AA 2.1.1, 2.4.7, 2.4.11, 3.3.1), in the `storefront` project: the production build in
// `vite preview` for the demo OTA, proxied to the OTA API and the Amadeus stub. The airline charges the card through
// Amadeus, so no Stripe is involved.
//
//   home: the search form sent empty (its error summary takes the focus), then filled → results: direct flights only →
//   offer: another fare → price → checkout: traveller, contact, no extras, the airline card and the terms → the
//   airline-card form: a card number that fails its check digit (its error summary takes the focus, its link leads to
//   the field), then the test card → pay → the confirmation with the tickets
//
// Nothing is clicked, filled or selected through the DOM: every step moves with Tab and Shift+Tab, chooses with the
// arrow keys, Space and Enter, and types with the keyboard, as a traveller without a mouse does. Every focus stop of an
// interactive element on the way must show a focus indicator (`:focus-visible` with an outline or a ring) and must not
// be covered by anything else on the page (2.4.11). The journey is a file of steps in order on one browser context made
// in `beforeAll` (`mode: "serial"`), each step within Playwright's default 30 s; the storefront guards of OFE-008 watch
// that context from before its first navigation and are checked after every step: no CSP violation, no third-party
// request (none at all on the airline-card page), no cookie JavaScript can read but `__Host-vx_csrf` (OF-03 AC1), and no
// serious or critical axe violation on any page it visits. The browser sends an end-user IP of its own.
//
// The demo OTA offers the airline card only with its storefront setting for the test environment, which `beforeAll`
// turns on (support/ota.ts `enableAirlineCard`) and leaves on.
import { type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { uniqueTestIp } from "../../support/fixtures";
import { uniqueEmail } from "../../support/mailpit";
import { departureDate, enableAirlineCard } from "../../support/ota";
import { STOREFRONT_URL } from "../../support/stack";
import { expect, StorefrontGuards, test } from "../../support/storefront-guards";

/** The departure the journey searches: a date of its own, days from today. */
const DAYS_AHEAD = 59;
/** How many key presses a move to one control may take before the journey says it cannot reach it. */
const MAX_TAB_PRESSES = 80;
/** How long `enableAirlineCard` may take: a settings row and the wait for storefront.get (support/ota.ts). */
const ARRANGE_TIMEOUT_MS = 20_000;
/** A booking id as the API writes it. */
const BOOKING_ID = /^bkg_[0-9A-HJKMNP-TV-Z]{26}$/;

/** The traveller: synthetic, as a test needs. */
const TRAVELLER = Object.freeze({ firstName: "Ada", lastName: "Keyboardtest", dateOfBirth: "1985-04-12" });

/** The card the Amadeus stub accepts (Visa's documented test number), and one whose check digit is wrong. */
const TEST_CARD = Object.freeze({
  holderName: "Ada Keyboardtest",
  number: "4111 1111 1111 1111",
  wrongNumber: "4111 1111 1111 1112",
  expiryMonth: "11",
  expiryYear: String(new Date().getUTCFullYear() + 3),
  securityCode: "853",
});

/** The journey's browser: its context, its page and the storefront guards on that context. */
interface Journey {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly guards: StorefrontGuards;
}

/**
 * A new browser context for the journey, with the storefront guards installed before its first navigation. The locale
 * is fixed to `en-US`, so a native date input takes its digits as month, day, year (`typeDate`).
 */
async function openJourney(browser: Browser): Promise<Journey> {
  const context = await browser.newContext({
    baseURL: STOREFRONT_URL,
    locale: "en-US",
    extraHTTPHeaders: { "X-Forwarded-For": uniqueTestIp() },
  });
  const guards = await StorefrontGuards.install(context);
  const page = await context.newPage();
  return { context, page, guards };
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
 * round trip per key press.
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
  // A native date or time field has focus stops of its own inside the browser's shadow tree (the month, day and
  // year, then the calendar button): on the last one the field itself no longer matches `:focus-visible`, and the
  // browser draws the ring on its button, out of reach of the page. The browser's own control counts as showing it.
  const browserDrawn =
    element instanceof HTMLInputElement &&
    ["date", "time", "datetime-local", "month", "week"].includes(element.type);
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
      focusVisible: browserDrawn || element.matches(":focus-visible"),
      indicator: browserDrawn || draws(element) || (hidden && labels.some(draws)),
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
    // The document, or a heading or region the page focused for screen readers (tabindex="-1"): not a control.
    return;
  }
  expect(state, `the focus indicator of ${state.element}`).toMatchObject({
    focusVisible: true,
    indicator: true,
    unobscured: true,
  });
}

/** The focus of `page` is visible (`expectVisible`). */
async function expectFocusVisible(page: Page): Promise<void> {
  expectVisible((await page.evaluate(probeFocus, null)).state);
}

/**
 * Moves the focus to `target` with Tab, or Shift+Tab when it comes before the focus in the document, checking every
 * focus stop on the way (`expectVisible`); fails when MAX_TAB_PRESSES presses do not reach it.
 */
async function tabTo(page: Page, target: Locator): Promise<void> {
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
async function typeInto(page: Page, field: Locator, text: string): Promise<void> {
  await tabTo(page, field);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await page.keyboard.type(text);
}

/** Types the ISO date `iso` into the native date input `field` of an `en-US` browser: month, day, then year. */
async function typeDate(page: Page, field: Locator, iso: string): Promise<void> {
  const [year = "", month = "", day = ""] = iso.split("-");
  // Reached forwards, the field takes the typing in its month first (backwards, its calendar button would have it).
  await tabTo(page, field);
  await page.keyboard.type(`${month}${day}${year}`);
  await expect(field).toHaveValue(iso);
}

/** Moves to the radio group of `checkedOrFirst` and moves with the arrow keys until `wanted` is checked. */
async function chooseRadio(page: Page, checkedOrFirst: Locator, wanted: Locator): Promise<void> {
  await tabTo(page, checkedOrFirst);
  for (let presses = 0; presses < 10 && !(await wanted.isChecked()); presses += 1) {
    await page.keyboard.press("ArrowDown");
    await expectFocusVisible(page);
  }
  await expect(wanted).toBeChecked();
  await expect(wanted).toBeFocused();
}

/** Types `typed` into the location combobox `name` and chooses its suggestion of `code` with the arrow keys and Enter. */
async function chooseLocation(page: Page, name: string, typed: string, code: string): Promise<void> {
  const field = page.getByRole("combobox", { name });
  await typeInto(page, field, typed);
  const option = page
    .getByRole("listbox", { name })
    .getByRole("option", { name: new RegExp(`^${code} `) })
    .first();
  await expect(option).toBeVisible();
  // The ARIA 1.2 combobox: the focus stays in the field, the active option is its aria-activedescendant.
  for (let presses = 0; presses < 10; presses += 1) {
    await page.keyboard.press("ArrowDown");
    await expect(field).toHaveAttribute("aria-activedescendant", /.+/);
    const active = await field.getAttribute("aria-activedescendant");
    if (active !== null && (await option.getAttribute("id")) === active) {
      break;
    }
  }
  await page.keyboard.press("Enter");
  await expect(field).toHaveValue(new RegExp(`\\(${code}\\)$`));
  await expect(field).toBeFocused();
}

test.describe("the keyboard-only checkout journey", () => {
  test.describe.configure({ mode: "serial" });

  const email = uniqueEmail("ofe019-keyboard");
  let journey: Journey;

  test.beforeAll(async ({ browser }) => {
    // A settings row of the demo OTA and the wait for storefront.get to offer the airline card (support/ota.ts).
    test.setTimeout(ARRANGE_TIMEOUT_MS);
    await enableAirlineCard();
    journey = await openJourney(browser);
  });

  test.afterEach(async () => {
    // The guards of the journey's context: CSP, third-party requests, readable cookies, axe on the page it is on.
    await journey?.guards.finish(journey.page);
  });

  test.afterAll(async () => {
    await journey?.context.close();
  });

  test("the skip link and the search form's error summary take the focus [OFE-019 AC1] [OFE-019 AC2]", async () => {
    const { page, guards } = journey;
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Search flights" })).toBeVisible();
    await guards.checkA11y(page);

    // The first Tab reaches the skip link, which shows itself and moves the focus to the main content.
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await expectFocusVisible(page);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();

    // The form sent empty: its error summary takes the focus and links each field in error (3.3.1).
    const form = page.getByRole("form", { name: "Search flights" });
    await tabTo(page, form.getByRole("button", { name: "Search flights" }));
    await page.keyboard.press("Enter");
    const summary = form.locator("[data-error-summary]");
    await expect(summary).toBeVisible();
    await expect(summary).toBeFocused();
    const fromError = summary.getByRole("link").first();
    await expect(fromError).toBeVisible();
    await expect(form.getByRole("combobox", { name: "From" })).toHaveAttribute("aria-invalid", "true");
    await guards.checkA11y(page);
    // Its first link leads to its field.
    await tabTo(page, fromError);
    await page.keyboard.press("Enter");
    await expect(form.getByRole("combobox", { name: "From" })).toBeFocused();
  });

  test("searches one way from Madrid to Paris with the keyboard [OFE-019 AC1] [OFE-019 AC2]", async () => {
    const { page, guards } = journey;
    const form = page.getByRole("form", { name: "Search flights" });
    await chooseRadio(
      page,
      form.getByRole("radio", { name: "Return" }),
      form.getByRole("radio", { name: "One way" }),
    );
    await chooseLocation(page, "From", "Madrid", "MAD");
    await chooseLocation(page, "To", "Paris", "PAR");
    await typeDate(page, form.getByLabel("Departure"), departureDate(DAYS_AHEAD));
    await tabTo(page, form.getByRole("button", { name: "Search flights" }));
    await page.keyboard.press("Enter");

    await page.waitForURL(/\/search\.html\?.*search=srch_/);
    const results = page.getByRole("region", { name: /flights?$/ });
    await expect(results.getByRole("heading", { level: 2, name: "5 flights" })).toBeVisible();
    await guards.checkA11y(page);
  });

  test("filters the results and opens an offer with the keyboard [OFE-019 AC1] [OFE-019 AC2]", async () => {
    const { page, guards } = journey;
    const results = page.getByRole("region", { name: /flights?$/ });
    const direct = page.getByRole("form", { name: "Filters" }).getByRole("checkbox", { name: /^Direct/ });
    await tabTo(page, direct);
    await page.keyboard.press("Space");
    await expect(direct).toBeChecked();
    await expect(results.getByRole("heading", { level: 2, name: "4 flights" })).toBeVisible();
    await expect(page).toHaveURL(/[?&]stops=0(&|$)/);
    await guards.checkA11y(page);

    await tabTo(page, results.getByRole("link", { name: /^Select this flight for / }).first());
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/offer\.html\?offer=off_/);
    await expect(page.getByRole("group", { name: "Choose your fare" })).toBeVisible();
    await guards.checkA11y(page);
  });

  test("chooses another fare and prices it with the keyboard [OFE-019 AC1] [OFE-019 AC2]", async () => {
    const { page, guards } = journey;
    const fares = page.getByRole("group", { name: "Choose your fare" });
    const flexible = fares.getByRole("radio", { name: /^FLEXIBLE / });
    await expect(flexible).toBeVisible();
    const checked = fares.getByRole("radio", { checked: true });
    await chooseRadio(
      page,
      (await checked.count()) > 0 ? checked : fares.getByRole("radio").first(),
      flexible,
    );
    // In `main`: the live region, outside it, announces the same text 150 ms later (components/live-region.js).
    await expect(page.getByRole("main").getByText(/^Selected fare: FLEXIBLE, /)).toBeVisible();
    await tabTo(page, page.getByRole("button", { name: "Continue with this fare" }));
    await page.keyboard.press("Enter");

    await page.waitForURL(/\/price\.html\?priced=prc_/);
    await expect(page.getByRole("heading", { level: 1, name: "Your price" })).toBeVisible();
    await expect(page.getByRole("main").getByText("Fare: FLEXIBLE")).toBeVisible();
    await guards.checkA11y(page);
  });

  test("fills in the traveller of the guest checkout with the keyboard [OFE-019 AC1] [OFE-019 AC2]", async () => {
    const { page, guards } = journey;
    await tabTo(page, page.getByRole("button", { name: "Continue to checkout" }));
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/checkout\.html\?id=chk_/);

    const travellers = page.getByRole("region", { name: "Travellers" });
    const traveller = travellers.getByRole("group", { name: "Traveller 1: Adult" });
    await expect(traveller).toBeVisible();
    await guards.checkA11y(page);
    await typeInto(
      page,
      traveller.getByRole("textbox", { name: "First and middle names" }),
      TRAVELLER.firstName,
    );
    await typeInto(page, traveller.getByRole("textbox", { name: "Last name" }), TRAVELLER.lastName);
    await typeDate(page, traveller.getByLabel("Date of birth"), TRAVELLER.dateOfBirth);
    const gender = traveller.getByRole("combobox", { name: "Gender, as in the travel document" });
    await tabTo(page, gender);
    // A closed select takes the typed name of an option.
    await page.keyboard.type("Female");
    await expect(gender).toHaveValue("FEMALE");
    await tabTo(page, travellers.getByRole("button", { name: "Continue", exact: true }));
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("region", { name: "Contact details" }).getByRole("textbox", { name: "First name" }),
    ).toHaveValue(TRAVELLER.firstName);
    await guards.checkA11y(page);
  });

  test("fills in the contact and goes past the extras with the keyboard [OFE-019 AC1] [OFE-019 AC2]", async () => {
    const { page, guards } = journey;
    // The name comes from the traveller.
    const contacts = page.getByRole("region", { name: "Contact details" });
    await typeInto(page, contacts.getByRole("textbox", { name: "E-mail address" }), email);
    await typeInto(page, contacts.getByRole("textbox", { name: "Country calling code" }), "34");
    await typeInto(page, contacts.getByRole("textbox", { name: "Mobile phone number" }), "600000000");
    await tabTo(page, contacts.getByRole("button", { name: "Continue", exact: true }));
    await page.keyboard.press("Enter");

    const extras = page.getByRole("region", { name: "Extras and special requests" });
    const skipExtras = extras.getByRole("button", { name: "Continue", exact: true });
    await expect(skipExtras).toBeVisible();
    await guards.checkA11y(page);
    await tabTo(page, skipExtras);
    await page.keyboard.press("Enter");
    const payment = page.getByRole("region", { name: "Payment", exact: true });
    await expect(payment.getByRole("heading", { level: 2, name: "Payment" })).toBeVisible();
    await guards.checkA11y(page);
  });

  test("chooses the airline card, accepts the terms and opens the card page with the keyboard [OFE-019 AC1] [OFE-019 AC2]", async () => {
    const { page, guards } = journey;
    const payment = page.getByRole("region", { name: "Payment", exact: true });
    const airlineCard = payment.getByRole("radio", { name: /^Card, charged by the airline/ });
    const checkedMethod = payment.getByRole("radio", { checked: true });
    await chooseRadio(
      page,
      (await checkedMethod.count()) > 0 ? checkedMethod : payment.getByRole("radio").first(),
      airlineCard,
    );
    await guards.checkA11y(page);
    const terms = payment.getByRole("checkbox", { name: /^I accept the terms and conditions/ });
    await tabTo(page, terms);
    await page.keyboard.press("Space");
    await expect(terms).toBeChecked();
    await tabTo(page, payment.getByRole("button", { name: "Continue to payment" }));
    await page.keyboard.press("Enter");

    await page.waitForURL(/\/checkout\/pay-airline\.html\?id=chk_[^&]+&payment=pay_/);
    await expect(page.getByRole("heading", { level: 1, name: "Pay with your card" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Your card", exact: true })).toBeVisible();
    await guards.checkA11y(page);
  });

  test("the airline-card form's error summary takes the focus and leads to the field in error [OFE-019 AC1] [OFE-019 AC2]", async () => {
    const { page, guards } = journey;
    const form = page.getByRole("form", { name: "Your card", exact: true });
    await typeInto(page, form.getByRole("textbox", { name: "Name on the card" }), TEST_CARD.holderName);
    // A number whose check digit is wrong: the page refuses it before anything is sent.
    await typeInto(page, form.getByRole("textbox", { name: "Card number" }), TEST_CARD.wrongNumber);
    await typeInto(page, form.getByRole("textbox", { name: "Month (MM)" }), TEST_CARD.expiryMonth);
    await typeInto(page, form.getByRole("textbox", { name: "Year (YYYY)" }), TEST_CARD.expiryYear);
    await typeInto(page, form.getByRole("textbox", { name: "Security code" }), TEST_CARD.securityCode);
    await tabTo(page, form.getByRole("button", { name: /^(Review the total|Pay €[\d,]+\.\d{2})$/ }));
    await page.keyboard.press("Enter");

    const summary = form.locator("[data-card-errors]");
    await expect(summary).toBeVisible();
    await expect(summary).toBeFocused();
    await expect(summary).toContainText("Check the card details");
    const number = form.getByRole("textbox", { name: "Card number" });
    await expect(number).toHaveAttribute("aria-invalid", "true");
    await guards.checkA11y(page);
    // The summary's link leads to the card number.
    await tabTo(page, summary.getByRole("link").first());
    await page.keyboard.press("Enter");
    await expect(number).toBeFocused();
  });

  test("pays with the test card from the keyboard and shows the confirmation with the tickets [OFE-019 AC1] [OFE-019 AC2]", async () => {
    const { page, guards } = journey;
    const form = page.getByRole("form", { name: "Your card", exact: true });
    await typeInto(page, form.getByRole("textbox", { name: "Card number" }), TEST_CARD.number);
    // The airline's card fee is quoted from the brand and the first six digits; the button then pays the total.
    const pay = form.getByRole("button", { name: /^Pay €[\d,]+\.\d{2}$/ });
    await expect(pay).toBeVisible();
    await expect(page.getByRole("region", { name: "Your final total" })).toBeVisible();
    await guards.checkA11y(page);
    await tabTo(page, pay);
    await page.keyboard.press("Enter");

    await page.waitForURL(/\/confirmation\.html\?booking=bkg_[^&]+$/);
    expect(new URL(page.url()).searchParams.get("booking")).toMatch(BOOKING_ID);
    await expect(page.getByRole("heading", { level: 1, name: "Your tickets are issued" })).toBeVisible();
    await guards.checkA11y(page);
    // The confirmation's links are reachable from the keyboard too.
    await tabTo(page, page.getByRole("link", { name: "View your booking" }));
  });
});
