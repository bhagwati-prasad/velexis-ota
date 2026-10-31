// The guest lookup page (ota/frontend/docs/pages-account.md §1 and §4, flow ota/docs/flows/my-bookings-and-guest-lookup.md
// §2): lookup.html with its partials expanded by the build's include plugin, run by src/pages/lookup.js against a fake
// SDK in cookie mode. It covers `bookings.lookup` with a new idempotency key per submit and the booking page opened on
// success, one message for every mismatch that never says which field was wrong, `429` with the button disabled until
// `retryAfterSeconds` has passed (fake timers), the format checks and the API's field errors, the other failures, and
// the links below the form.
import { NotFoundError, RateLimitError, ServerError, ValidationError } from "@velexis/ota-sdk";
import { Browser } from "happy-dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { includePartials } from "../scripts/vite-plugins.js";
import { formatErrors, normaliseReference, start, waitMessage } from "../src/pages/lookup.js";
import { STOREFRONT_ROOT } from "./helpers/storefront.js";

/** The mocked boot() of the page module never resolves here (the static import above). */
vi.mock("../src/boot.js", async (importOriginal) => {
  const actual = /** @type {Record<string, unknown>} */ (await importOriginal());
  return { ...actual, boot: () => new Promise(() => {}) };
});

const PAGE = "lookup.html";
const CONFIG = Object.freeze({
  name: "Demo Travel",
  defaultLocale: "en-GB",
  timeZone: "Europe/London",
  support: { email: "help@demo-travel.example", phone: null, hours: null, helpCenterUrl: null },
  features: { customerAccounts: true, guestCheckout: true },
});
const SESSION = Object.freeze({ customer: { id: "cus_01JLOOKUPPAGECUSTOMER", firstName: "Ada" } });

/** The one booking of the fake API: its reference, its airline record locator and its travellers' last names. */
const BOOKING = Object.freeze({
  id: "bkg_01JLOOKUPPAGEBOOKING00001",
  reference: "VX9M4T",
  recordLocator: "RT4K7P",
  lastNames: ["ROSSI", "BIANCHI"],
});
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** @param {Function} ErrorClass @param {string} code @param {number} status @param {Record<string, unknown>} [body] */
const apiError = (ErrorClass, code, status, body = {}) =>
  new ErrorClass({ code, message: `${code} from the fake API`, status, requestId: "req_lookup", ...body });

/**
 * The API's `404` for a lookup that matches nothing: the same body for every mismatch apart from its request id.
 * @param {number} n
 */
const notFound = (n) =>
  new NotFoundError({
    code: "NOT_FOUND",
    message: "No booking matches this reference and last name.",
    status: 404,
    requestId: `req_lookup_${n}`,
  });

/** A `BookingLookupResult` as the SDK resolves it in cookie mode (the token is in the httpOnly cookie). */
const found = () => ({
  bookingId: BOOKING.id,
  bookingToken: null,
  expiresAt: "2026-10-28T10:30:00Z",
  booking: { id: BOOKING.id, reference: BOOKING.reference, status: "ticketed" },
});

/**
 * A fake `bookings.lookup` that matches like the API (the reference or the record locator, case-insensitive, and the
 * last name of any traveller), unless `answers` gives what each call does in turn (an Error is thrown).
 * @param {unknown[]} [answers]
 */
function fakeClient(answers = []) {
  let calls = 0;
  const lookup = vi.fn(async (/** @type {{ bookingReference: string, lastName: string }} */ params) => {
    calls += 1;
    const answer = answers[calls - 1];
    if (answer instanceof Error) {
      throw answer;
    }
    if (answer !== undefined) {
      return answer;
    }
    const reference = params.bookingReference.toUpperCase();
    const matches =
      (reference === BOOKING.reference || reference === BOOKING.recordLocator) &&
      BOOKING.lastNames.includes(params.lastName.toUpperCase());
    if (!matches) {
      throw notFound(calls);
    }
    return found();
  });
  return { bookings: { lookup } };
}

/** @type {Browser | undefined} */
let browser;
/** @type {Document | undefined} */
let pageDocument;
const original = { address: "", title: "" };
const views = /** @type {Array<{ destroy: () => void }>} */ ([]);

beforeAll(async () => {
  // Expands the page with the build's include plugin and parses it once in a happy-dom browser; each test imports a
  // fresh copy of its body into the test document.
  const plugin = includePartials({ root: STOREFRONT_ROOT });
  const transform = /** @type {{ handler: (html: string, ctx: { path: string }) => string }} */ (
    plugin.transformIndexHtml
  );
  const html = await transform.handler(readFileSync(join(STOREFRONT_ROOT, PAGE), "utf8"), {
    path: `/${PAGE}`,
  });
  browser = new Browser({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
  const page = browser.newPage();
  page.url = `${location.origin}/${PAGE}`;
  page.content = html;
  pageDocument = /** @type {Document} */ (/** @type {unknown} */ (page.mainFrame.document));
}, 15_000); // a file read, the include plugin and one happy-dom browser page; generous for a cold CI machine

afterAll(async () => {
  await browser?.close();
});

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  vi.useRealTimers();
  document.body.replaceChildren();
  if (original.title !== "") {
    document.title = original.title;
  }
  if (original.address !== "") {
    history.replaceState(null, "", original.address);
  }
});

/** Puts a fresh copy of the page's body into the test document at `/lookup.html`. */
function showPage() {
  original.address ||= `${location.pathname}${location.search}`;
  original.title ||= document.title;
  const source = /** @type {Document} */ (pageDocument);
  document.body.replaceChildren(
    ...Array.from(source.body.childNodes, (node) => document.importNode(node, true)),
  );
  document.title = source.title;
  history.replaceState(null, "", "/lookup.html");
}

/** Waits until queued promise callbacks have run (the fake SDK answers at once). */
const settle = async () => {
  for (let i = 0; i < 60; i += 1) {
    await Promise.resolve();
  }
};

const text = (/** @type {Element | null | undefined} */ element) =>
  element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const $ = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (document.querySelector(selector));
const field = (/** @type {string} */ name) =>
  /** @type {HTMLInputElement} */ (document.querySelector(`main [name="${name}"]`));
const lookupForm = () => /** @type {HTMLFormElement} */ ($("form[data-lookup-form]"));
const submitButton = () =>
  /** @type {HTMLButtonElement} */ ($('form[data-lookup-form] button[type="submit"]'));
const stateTitle = () => text($('[data-lookup-state] [data-field="title"]'));
const stateHint = () => text($('[data-lookup-state] [data-field="hint"]'));
/** The error summary's heading and entries. */
const summaryLines = () =>
  Array.from(document.querySelectorAll("[data-error-summary] h2, [data-error-summary] li"), (line) =>
    text(line),
  );

/**
 * Opens the lookup page with a fake SDK.
 * @param {{ client?: ReturnType<typeof fakeClient>, config?: object, session?: object | null, newKey?: (() => string) | null }} [options]
 *   `newKey: null` keeps the page's own keys
 */
function openLookup({ client = fakeClient(), config = CONFIG, session = null, newKey } = {}) {
  showPage();
  const navigate = vi.fn();
  let counter = 0;
  const keys =
    newKey === null
      ? {}
      : { newKey: newKey ?? (() => `lookup-key-${String((counter += 1)).padStart(4, "0")}-fixture`) };
  const view = start(
    {
      config: /** @type {never} */ (config),
      client: /** @type {never} */ (client),
      session: /** @type {never} */ (session),
    },
    { navigate, ...keys },
  );
  if (!view) {
    throw new Error("the lookup page did not start");
  }
  views.push(view);
  return { client, navigate, view };
}

/**
 * Types into the form and submits it the way its button does.
 * @param {string} bookingReference
 * @param {string} lastName
 */
async function lookUp(bookingReference, lastName) {
  field("bookingReference").value = bookingReference;
  field("lastName").value = lastName;
  lookupForm().requestSubmit(submitButton());
  await settle();
}

/**
 * Everything the page shows about a failed lookup: the state's markup, the fields' error marks and descriptions, the
 * error summary, the focus, the title and what the live region says.
 */
function failureView() {
  const fields = ["bookingReference", "lastName"].map((name) => ({
    name,
    invalid: field(name).getAttribute("aria-invalid"),
    describedBy: field(name).getAttribute("aria-describedby"),
  }));
  return {
    state: $("[data-lookup-state]").innerHTML,
    fields,
    fieldMessages: document.querySelectorAll("main [data-field-error]").length,
    summaryHidden: $("[data-error-summary]").hidden,
    summary: text($("[data-error-summary]")),
    focusOnTitle: document.activeElement === $('[data-lookup-state] [data-field="title"]'),
    title: document.title,
    live: text($("[data-live-region]")),
  };
}

describe("lookup page: the lookup", () => {
  it("[OFE-016] sends the reference and the last name with a new idempotency key per submit, and opens the booking", async () => {
    const { client, navigate } = openLookup();

    await lookUp(" vx9m 4t ", "  Verdi ");
    expect(client.bookings.lookup).toHaveBeenNthCalledWith(
      1,
      { bookingReference: "VX9M4T", lastName: "Verdi" },
      { idempotencyKey: "lookup-key-0001-fixture" },
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(stateTitle()).toBe("We could not find a booking with these details");

    await lookUp("vx9m4t", "Rossi");
    expect(client.bookings.lookup).toHaveBeenNthCalledWith(
      2,
      { bookingReference: "VX9M4T", lastName: "Rossi" },
      { idempotencyKey: "lookup-key-0002-fixture" },
    );
    expect(navigate).toHaveBeenCalledTimes(1);
    // The guest token went into the httpOnly cookie: the booking page gets the id alone.
    expect(navigate).toHaveBeenCalledWith("/booking.html?id=bkg_01JLOOKUPPAGEBOOKING00001");
    expect($("[data-lookup-state]").children).toHaveLength(0);
  });

  it("[OFE-016] the airline's record locator works too, and the page's own keys are new UUIDs for every submit", async () => {
    const { client, navigate } = openLookup({ newKey: null });

    await lookUp("RT4K7P", "Bianchi");
    await lookUp("RT4K7P", "Bianchi");
    expect(navigate).toHaveBeenCalledTimes(2);
    const keys = client.bookings.lookup.mock.calls.map(
      ([, options]) => /** @type {{ idempotencyKey: string }} */ (options).idempotencyKey,
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(UUID_V4);
    expect(keys[1]).toMatch(UUID_V4);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("[OFE-016] a second submit while the first runs sends nothing", async () => {
    /** @type {(value: unknown) => void} */
    let answer = () => {};
    const client = fakeClient();
    client.bookings.lookup.mockImplementationOnce(
      () => /** @type {never} */ (new Promise((resolve) => (answer = resolve))),
    );
    const { navigate } = openLookup({ client });

    await lookUp("VX9M4T", "Rossi");
    expect(lookupForm().getAttribute("aria-busy")).toBe("true");
    expect(text(submitButton())).toBe("Finding your booking…");
    lookupForm().requestSubmit(submitButton());
    await settle();
    expect(client.bookings.lookup).toHaveBeenCalledTimes(1);

    answer(found());
    await settle();
    expect(navigate).toHaveBeenCalledWith("/booking.html?id=bkg_01JLOOKUPPAGEBOOKING00001");
    expect(lookupForm().hasAttribute("aria-busy")).toBe(false);
  });

  it("[OFE-016] an answer without a well-formed booking id opens nothing", async () => {
    const { navigate } = openLookup({
      client: fakeClient([{ ...found(), bookingId: "//evil.example/booking" }]),
    });

    await lookUp("VX9M4T", "Rossi");
    expect(navigate).not.toHaveBeenCalled();
    expect(stateTitle()).toBe("Something went wrong. Please try again.");
  });
});

describe("lookup page: one message for every mismatch", () => {
  it("[OFE-016 AC1] a wrong reference, a wrong name and both show the same message and mark neither field", async () => {
    const { client } = openLookup();

    await lookUp("VX0000", "Rossi"); // a reference of the right shape that matches no booking
    const wrongReference = failureView();
    await lookUp("VX9M4T", "Neri"); // the right reference with a name of nobody on the booking
    const wrongName = failureView();
    await lookUp("ZZ1234", "Neri");
    const both = failureView();

    expect(client.bookings.lookup).toHaveBeenCalledTimes(3);
    expect(wrongName).toEqual(wrongReference);
    expect(both).toEqual(wrongReference);
    expect(wrongReference).toMatchObject({
      fields: [
        { name: "bookingReference", invalid: null, describedBy: "lookup-reference-hint" },
        { name: "lastName", invalid: null, describedBy: "lookup-last-name-hint" },
      ],
      fieldMessages: 0,
      summaryHidden: true,
      summary: "",
      focusOnTitle: true,
      title: "Find your booking",
    });
    expect(stateTitle()).toBe("We could not find a booking with these details");
    expect(stateHint()).toBe(
      "Check the booking reference in your confirmation e-mail and the last name of a traveller, then try again.",
    );
    // The request ids differ between the answers, so none is shown; the typed values stay for a correction.
    expect(text($("[data-lookup-state]"))).not.toContain("req_lookup");
    expect(field("bookingReference").value).toBe("ZZ1234");
    expect(field("lastName").value).toBe("Neri");
  });

  it("[OFE-016 AC1] a 404 that says more than that still marks no field and shows none of it", async () => {
    const chatty = new NotFoundError({
      code: "NOT_FOUND",
      message: "lastName does not match the booking VX9M4T",
      status: 404,
      requestId: "req_lookup_chatty",
      details: { mismatch: "lastName" },
      fieldErrors: [{ path: "/lastName", code: "mismatch", message: "lastName does not match" }],
    });
    openLookup({ client: fakeClient([notFound(1), chatty]) });

    await lookUp("VX9M4T", "Neri");
    const plain = failureView();
    await lookUp("VX9M4T", "Neri");

    expect(failureView()).toEqual(plain);
    expect(field("lastName").hasAttribute("aria-invalid")).toBe(false);
    const shown = text($("main"));
    expect(shown).not.toContain("does not match");
    expect(shown).not.toContain("mismatch");
    expect(shown).not.toContain("req_lookup_chatty");
  });
});

describe("lookup page: too many attempts", () => {
  it("[OFE-016 AC2] 429 disables the button until retryAfterSeconds has passed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const client = fakeClient([
      new RateLimitError(
        { code: "RATE_LIMITED", message: "Too many lookups.", status: 429, requestId: "req_lookup_429" },
        { retryAfterSeconds: 900 },
      ),
    ]);
    const { navigate } = openLookup({ client });

    await lookUp("VX9M4T", "Rossi");
    expect(stateTitle()).toBe("Too many attempts, try again in 15 minutes");
    expect(stateHint()).toBe("To keep bookings safe, a booking can be looked up only a few times in a row.");
    expect(document.activeElement).toBe($('[data-lookup-state] [data-field="title"]'));
    expect(submitButton().disabled).toBe(true);
    expect(text(submitButton())).toBe("Find my booking");

    vi.advanceTimersByTime(900_000 - 1);
    expect(submitButton().disabled).toBe(true);
    // Neither the Enter key nor a script submits during the wait.
    lookupForm().requestSubmit();
    await settle();
    expect(client.bookings.lookup).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(submitButton().disabled).toBe(false);
    expect($("[data-lookup-state]").children).toHaveLength(0);
    vi.advanceTimersByTime(150); // the live region's announcement delay
    expect(text($("[data-live-region]"))).toBe("You can try again now");

    await lookUp("VX9M4T", "Rossi");
    expect(client.bookings.lookup).toHaveBeenCalledTimes(2);
    expect(client.bookings.lookup).toHaveBeenLastCalledWith(
      { bookingReference: "VX9M4T", lastName: "Rossi" },
      { idempotencyKey: "lookup-key-0002-fixture" },
    );
    expect(navigate).toHaveBeenCalledWith("/booking.html?id=bkg_01JLOOKUPPAGEBOOKING00001");
  });

  it("[OFE-016 AC2] a wait under a minute is said in seconds; without retryAfterSeconds the button stays on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const client = fakeClient([
      apiError(RateLimitError, "RATE_LIMITED", 429, { details: { retryAfterSeconds: 45 } }),
      apiError(RateLimitError, "RATE_LIMITED", 429),
    ]);
    openLookup({ client });

    await lookUp("VX9M4T", "Neri");
    expect(stateTitle()).toBe("Too many attempts, try again in 45 seconds");
    expect(submitButton().disabled).toBe(true);
    vi.advanceTimersByTime(45_000 - 1);
    expect(submitButton().disabled).toBe(true);
    vi.advanceTimersByTime(1);
    expect(submitButton().disabled).toBe(false);

    await lookUp("VX9M4T", "Neri");
    expect(stateTitle()).toBe("Too many attempts, try again later");
    expect(submitButton().disabled).toBe(false);
    expect(client.bookings.lookup).toHaveBeenCalledTimes(2);
  });

  it("[OFE-016 AC2] the wait's text rounds up to whole minutes from a minute on", () => {
    expect(waitMessage(1)).toBe("Too many attempts, try again in 1 second");
    expect(waitMessage(58.2)).toBe("Too many attempts, try again in 59 seconds");
    expect(waitMessage(59.2)).toBe("Too many attempts, try again in 1 minute");
    expect(waitMessage(60)).toBe("Too many attempts, try again in 1 minute");
    expect(waitMessage(61)).toBe("Too many attempts, try again in 2 minutes");
    expect(waitMessage(0)).toBe("Too many attempts, try again later");
    expect(waitMessage(undefined)).toBe("Too many attempts, try again later");
  });

  it("[OFE-016 AC2] a wait longer than a timer holds keeps the button disabled instead of ending at once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const maxTimerMs = 2 ** 31 - 1;
    openLookup({
      client: fakeClient([
        apiError(RateLimitError, "RATE_LIMITED", 429, { details: { retryAfterSeconds: 30 * 24 * 3600 } }),
      ]),
    });

    await lookUp("VX9M4T", "Neri");
    // A delay above 2^31 - 1 ms would overflow and fire at once (the fake timers do the same as browsers).
    vi.advanceTimersByTime(1);
    expect(submitButton().disabled).toBe(true);
    vi.advanceTimersByTime(maxTimerMs - 2);
    expect(submitButton().disabled).toBe(true);
    vi.advanceTimersByTime(1);
    expect(submitButton().disabled).toBe(false);
  });

  it("[OFE-016 AC2] leaving the page stops the wait's timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { view } = openLookup({
      client: fakeClient([
        apiError(RateLimitError, "RATE_LIMITED", 429, { details: { retryAfterSeconds: 30 } }),
      ]),
    });

    await lookUp("VX9M4T", "Neri");
    expect(vi.getTimerCount()).toBe(1);
    view.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("lookup page: field checks and other failures", () => {
  it("[OFE-016] the format checks run before any request and mark only the field they are about", async () => {
    const { client } = openLookup();

    await lookUp("   ", " ");
    expect(client.bookings.lookup).not.toHaveBeenCalled();
    expect(field("bookingReference").getAttribute("aria-invalid")).toBe("true");
    expect(field("lastName").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe($("[data-error-summary]"));
    expect(summaryLines()).toEqual(["There are 2 problems", "Fill in this field", "Fill in this field"]);

    await lookUp("VX9", "Rossi");
    expect(client.bookings.lookup).not.toHaveBeenCalled();
    expect(field("bookingReference").getAttribute("aria-invalid")).toBe("true");
    expect(field("bookingReference").getAttribute("aria-describedby")).toMatch(/^lookup-reference-hint \S+$/);
    expect(field("lastName").hasAttribute("aria-invalid")).toBe(false);
    expect(summaryLines()).toEqual([
      "There is 1 problem",
      "Enter the reference as in your confirmation e-mail: 5 to 10 letters and digits",
    ]);

    expect(formatErrors("VX9M4T-1", "Rossi")).toEqual([
      { path: "/bookingReference", code: "BOOKING_REFERENCE_FORMAT", message: "" },
    ]);
    expect(formatErrors("VX9M4T", "R".repeat(61))).toEqual([
      { path: "/lastName", code: "maxLength", message: "" },
    ]);
    expect(formatErrors("RT4K7P", "R".repeat(60))).toEqual([]);
    expect(normaliseReference(" rt4k 7p\t")).toBe("RT4K7P");
  });

  it("[OFE-016] the API's 400 marks the fields it names", async () => {
    openLookup({
      client: fakeClient([
        apiError(ValidationError, "VALIDATION_FAILED", 400, {
          fieldErrors: [
            { path: "/lastName", code: "maxLength", message: "must NOT have more than 60 characters" },
          ],
        }),
      ]),
    });

    await lookUp("VX9M4T", "Rossi");
    expect(field("lastName").getAttribute("aria-invalid")).toBe("true");
    expect(field("bookingReference").hasAttribute("aria-invalid")).toBe(false);
    expect(summaryLines()).toEqual(["There is 1 problem", "This is too long"]);
    expect($("[data-lookup-state]").children).toHaveLength(0);
  });

  it("[OFE-016] other failures show the shared states, with the request id and the support address when unexpected", async () => {
    openLookup({
      client: fakeClient([
        apiError(ServerError, "INTERNAL_ERROR", 500, { requestId: "req_lookup_500" }),
        apiError(ServerError, "SERVICE_UNAVAILABLE", 503),
      ]),
    });

    await lookUp("VX9M4T", "Rossi");
    expect(stateTitle()).toBe("Something went wrong. Please try again.");
    expect(text($('[data-lookup-state] [data-field="requestId"]'))).toBe("req_lookup_500");
    expect($('[data-lookup-state] [data-field="supportEmail"]').getAttribute("href")).toBe(
      "mailto:help@demo-travel.example",
    );
    expect(submitButton().disabled).toBe(false);

    await lookUp("VX9M4T", "Rossi");
    expect(stateTitle()).toBe(
      "The service is not available right now. Nothing is lost: try again in a moment.",
    );
    expect($('[data-lookup-state] [data-field="requestId"]').closest("p")?.hidden).toBe(true);
  });
});

describe("lookup page: the page", () => {
  it("[OFE-016] a form without an action whose fields keep paste and autofill", () => {
    openLookup();
    const form = lookupForm();
    expect(form.getAttribute("method")).toBe("post");
    expect(form.hasAttribute("action")).toBe(false);
    expect(document.querySelectorAll("main h1")).toHaveLength(1);
    expect(text($("main h1"))).toBe("Find your booking");
    expect(field("bookingReference").getAttribute("autocomplete")).toBe("off");
    expect(field("lastName").getAttribute("autocomplete")).toBe("family-name");
    expect(field("lastName").getAttribute("maxlength")).toBe("60");
    for (const name of ["bookingReference", "lastName"]) {
      expect(field(name).hasAttribute("required")).toBe(true);
      expect(field(name).closest("label")).not.toBeNull();
      expect(field(name).hasAttribute("onpaste")).toBe(false);
    }
  });

  it("[OFE-016] a visitor is offered sign-in to My bookings, a customer My bookings, nobody without customer accounts", () => {
    openLookup();
    expect($("[data-lookup-sign-in]").hidden).toBe(false);
    expect($("[data-lookup-sign-in] a").getAttribute("href")).toBe(
      "/account/sign-in.html?next=%2Fbookings.html",
    );
    expect($("[data-lookup-my-bookings]").hidden).toBe(true);

    openLookup({ session: SESSION });
    expect($("[data-lookup-sign-in]").hidden).toBe(true);
    expect($("[data-lookup-my-bookings]").hidden).toBe(false);
    expect($("[data-lookup-my-bookings] a").getAttribute("href")).toBe("/bookings.html");

    openLookup({ config: { ...CONFIG, features: { ...CONFIG.features, customerAccounts: false } } });
    expect($("[data-lookup-sign-in]").hidden).toBe(true);
    expect($("[data-lookup-my-bookings]").hidden).toBe(true);
  });

  it("[OFE-016] start() does nothing on a page without the lookup area", () => {
    document.body.replaceChildren();
    expect(
      start({
        config: /** @type {never} */ (CONFIG),
        client: /** @type {never} */ (fakeClient()),
        session: null,
      }),
    ).toBeNull();
  });
});
