#!/usr/bin/env node
// lighthouse: Lighthouse's mobile figures of the storefront's home and results pages (ota/frontend/README.md §9), with
// the method of ota/docs/storefront-accessibility.md §3.1, so that the LCP, CLS and INP figures can be repeated
// (OFE-027, lead decision 11n of 2026-11-06).
//
// Usage:  pnpm --filter @velexis/ota-frontend lighthouse [--base-url <url>] [--page home|results]... [--runs <n>]
//                                                        [--width 412|360]... [--signed-in] [--days-ahead <n>]
//                                                        [--chrome <path>] [--json <file>]
//
//   --base-url    the storefront to measure (default http://127.0.0.1:4173: the end-to-end harness's preview of the
//                 demo OTA, the production build proxied to the built OTA API on the Amadeus stub)
//   --page        home or results, repeatable (default both)
//   --runs        runs per page (default 3), each in a new browser with an empty profile
//   --width       the phone's width in CSS pixels, repeatable (default 412): 412 is Lighthouse's own phone (Moto G
//                 Power, 412 x 823), 360 a narrower phone (360 x 800, OFE-030); the same device pixel ratio, user agent
//                 and throttling for both. Each page is measured at each width.
//   --signed-in   measure as a signed-in customer (OFE-031): in each run's new browser, before the measured
//                 navigation, the customer signs in through the storefront's own pages: a new customer of this
//                 invocation (a unique address on the reserved example.com domain, a random password), signed up
//                 through the sign-up page in the first run (the demo OTA opens the session at sign-up) and signed in
//                 through the sign-in page in every later run (the API allows 5 sign-ups per hour per address, and 10
//                 sign-ins per minute). It stops when the storefront does not sign the customer in (an OTA that wants
//                 the e-mail address verified first). The session's cookies stay for the navigation (Lighthouse's
//                 storage reset keeps cookies), and the page's sessionStorage is emptied before it, so storefront.get is
//                 asked again as in a visitor's run; the header's account menu fills in when auth.getSession answers.
//                 Default: a visitor, with an empty profile.
//   --days-ahead  the results page's departure date, days after today in UTC (default 69)
//   --chrome      the Chromium to run (default the CHROME_PATH variable, else /opt/pw-browsers/chromium)
//   --json        also write the figures as JSON to this file
//
// Lighthouse and puppeteer-core are this package's exact devDependencies; Lighthouse's user-flow API with its default
// configuration (mobile: Moto G Power emulation, simulated slow 4G and 4x CPU slowdown; at 360 px only the screen's
// width and height differ, `screenEmulation` of the flow's flags). Each run is a navigation
// (performance score, FCP, LCP, CLS, TBT, bytes, fonts and the layout shifts with the element each moved most) and
// then a timespan with what a traveller does first, for INP:
//   home     "Madrid" typed into From, the first suggestion chosen with ArrowDown and Enter, One way, then Return;
//   results  /search.html?trip=oneway&from=MAD&to=PAR&depart=<date>&adults=1&children=0&infants=0&cabin=ECONOMY (the
//            page runs the search); on a narrow screen the "Filters" disclosure opened (OFE-027), "Direct" ticked and
//            unticked, then "Cheapest first".
// It prints the Markdown table of storefront-accessibility.md §3 with the median of each page and the layout shifts
// of every run, and exits 1 when a run misses a target (LCP ≤ 2.5 s, CLS ≤ 0.1, INP ≤ 200 ms), 2 when it cannot run.
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** The targets of README §9. */
export const TARGETS = Object.freeze({ lcpMs: 2500, cls: 0.1, inpMs: 200 });
export const DEFAULT_BASE_URL = "http://127.0.0.1:4173";
/** Playwright's Chromium on the agents' machine (tools/e2e/README.md, `E2E_CHROMIUM_EXECUTABLE`). */
export const DEFAULT_CHROME = "/opt/pw-browsers/chromium";
export const PAGES = Object.freeze(/** @type {const} */ (["home", "results"]));
const PAGE_TITLES = Object.freeze({ home: "Home", results: "Results" });
/** Lighthouse's own phone width (Moto G Power), the default. */
export const DEFAULT_WIDTH = 412;
/**
 * The phone screens the script emulates, by width in CSS pixels: Lighthouse's default mobile screen (412 x 823 at a
 * device pixel ratio of 1.75) and a 360 x 800 phone with the same ratio (OFE-030). The throttling is the same for both.
 */
export const PHONE_SCREENS = Object.freeze({
  412: Object.freeze({ mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false }),
  360: Object.freeze({ mobile: true, width: 360, height: 800, deviceScaleFactor: 1.75, disabled: false }),
});
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** How long a search, a filter change or a suggestion may take on the stack (the stub answers in milliseconds). */
const WAIT_MS = 60_000;
/** The storefront's sign-up and sign-in pages, and the account page they lead to once signed in (no `next`). */
const SIGN_UP_PATH = "/account/sign-up.html";
const SIGN_IN_PATH = "/account/sign-in.html";
const ACCOUNT_PATH = "/account/";

/** @typedef {(typeof PAGES)[number]} PageName */
/** @typedef {keyof typeof PHONE_SCREENS} PhoneWidth */
/**
 * @typedef {object} Options
 * @property {string} baseUrl
 * @property {PageName[]} pages
 * @property {number} runs
 * @property {PhoneWidth[]} widths
 * @property {boolean} signedIn measure as a signed-in customer
 * @property {number} daysAhead
 * @property {string} chrome
 * @property {string | null} json
 */
/**
 * One layout shift of a navigation: its score and the element it moved most.
 * @typedef {{ score: number, element: string }} Shift
 */
/**
 * The figures of one run (times in milliseconds, bytes as transferred; `null` when Lighthouse has none).
 * @typedef {object} RunFigures
 * @property {PageName} page
 * @property {number} run
 * @property {PhoneWidth} [width] the phone's width (DEFAULT_WIDTH when absent)
 * @property {boolean} [signedIn] measured as a signed-in customer (a visitor when absent)
 * @property {number | null} score
 * @property {number | null} fcp
 * @property {number | null} lcp
 * @property {number | null} cls
 * @property {number | null} tbt
 * @property {number | null} inp
 * @property {number | null} bytes
 * @property {number | null} fontBytes
 * @property {Shift[]} shifts
 * @property {number} [session] the HTTP status of the navigation's auth.getSession request (`/v1/auth/session`): 200
 *   for a signed-in customer, 401 for a visitor; absent when the page made none
 */

/**
 * Reads the command line.
 * @param {string[]} argv the arguments after the script
 * @param {Record<string, string | undefined>} env
 * @returns {Options}
 */
export function parseOptions(argv, env) {
  const { values } = parseArgs({
    // `pnpm <script> -- …` passes the `--` on.
    args: argv[0] === "--" ? argv.slice(1) : argv,
    options: {
      "base-url": { type: "string" },
      page: { type: "string", multiple: true },
      runs: { type: "string" },
      width: { type: "string", multiple: true },
      "signed-in": { type: "boolean" },
      "days-ahead": { type: "string" },
      chrome: { type: "string" },
      json: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const baseUrl = new URL(values["base-url"] ?? DEFAULT_BASE_URL);
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error(`--base-url must be an http or https address, not ${baseUrl.protocol}`);
  }
  const pages = values.page ?? [...PAGES];
  for (const page of pages) {
    if (!PAGES.includes(/** @type {PageName} */ (page))) {
      throw new Error(`--page must be one of ${PAGES.join(", ")}, not ${page}`);
    }
  }
  const widths = (values.width ?? [String(DEFAULT_WIDTH)]).map((width) => {
    if (!Object.hasOwn(PHONE_SCREENS, width)) {
      throw new Error(`--width must be one of ${Object.keys(PHONE_SCREENS).join(", ")}, not ${width}`);
    }
    return /** @type {PhoneWidth} */ (Number(width));
  });
  /**
   * @param {string} name
   * @param {string | undefined} value
   * @param {number} fallback
   * @param {number} min
   * @param {number} max
   */
  const whole = (name, value, fallback, min, max) => {
    if (value === undefined) {
      return fallback;
    }
    const number = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!(number >= min && number <= max)) {
      throw new Error(`--${name} must be a whole number from ${min} to ${max}`);
    }
    return number;
  };
  return {
    baseUrl: baseUrl.origin,
    pages: [...new Set(/** @type {PageName[]} */ (pages))],
    runs: whole("runs", values.runs, 3, 1, 20),
    widths: [...new Set(widths)],
    signedIn: values["signed-in"] === true,
    daysAhead: whole("days-ahead", values["days-ahead"], 69, 1, 330),
    chrome: values.chrome ?? (env["CHROME_PATH"] || DEFAULT_CHROME),
    json: values.json ?? null,
  };
}

/**
 * The results page's address: a one-way search from Madrid to Paris for one adult, `daysAhead` days after `now`.
 * @param {Date} now
 * @param {number} daysAhead
 */
export function resultsPath(now, daysAhead) {
  const depart = new Date(now.getTime() + daysAhead * MS_PER_DAY).toISOString().slice(0, 10);
  return `/search.html?trip=oneway&from=MAD&to=PAR&depart=${depart}&adults=1&children=0&infants=0&cabin=ECONOMY`;
}

/** @param {unknown} value */
const numberOrNull = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * The figures of one run from Lighthouse's flow result: the navigation's, and INP from the timespan.
 * @param {{ steps: Array<{ lhr: any }> }} flowResult
 * @param {PageName} page
 * @param {number} run
 * @returns {RunFigures}
 */
export function figuresOf(flowResult, page, run) {
  const navigation = flowResult.steps.find((step) => step.lhr?.gatherMode === "navigation")?.lhr;
  const timespan = flowResult.steps.find((step) => step.lhr?.gatherMode === "timespan")?.lhr;
  if (!navigation) {
    throw new Error(`run ${run} of ${page} has no navigation result`);
  }
  const audit = (/** @type {any} */ lhr, /** @type {string} */ id) =>
    numberOrNull(lhr?.audits?.[id]?.numericValue);
  const requests = navigation.audits?.["network-requests"]?.details?.items ?? [];
  const fonts = requests.filter((/** @type {any} */ item) => item.resourceType === "Font");
  const shiftItems = navigation.audits?.["layout-shifts"]?.details?.items ?? [];
  const sessionRequest = requests.find(
    (/** @type {any} */ item) => typeof item.url === "string" && /\/v1\/auth\/session(\?|$)/.test(item.url),
  );
  const session = numberOrNull(sessionRequest?.statusCode);
  return {
    page,
    run,
    score: numberOrNull(navigation.categories?.performance?.score),
    fcp: audit(navigation, "first-contentful-paint"),
    lcp: audit(navigation, "largest-contentful-paint"),
    cls: audit(navigation, "cumulative-layout-shift"),
    tbt: audit(navigation, "total-blocking-time"),
    inp: audit(timespan, "interaction-to-next-paint"),
    bytes: audit(navigation, "total-byte-weight"),
    fontBytes: fonts.reduce(
      (sum, /** @type {any} */ item) => sum + (numberOrNull(item.transferSize) ?? 0),
      0,
    ),
    shifts: shiftItems.map((/** @type {any} */ item) => ({
      score: numberOrNull(item.score) ?? 0,
      element: String(item.node?.selector ?? item.node?.nodeLabel ?? "(no element)"),
    })),
    ...(session === null ? {} : { session }),
  };
}

/**
 * The median of the numbers given (`null` values left out; the mean of the middle two for an even count).
 * @param {Array<number | null>} values
 * @returns {number | null}
 */
export function median(values) {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? /** @type {number} */ (sorted[middle])
    : /** @type {number} */ (sorted[middle - 1] + /** @type {number} */ (sorted[middle])) / 2;
}

/**
 * What a run misses of the targets, as text ("CLS 0.749 > 0.1").
 * @param {RunFigures} figures
 */
export function missedTargets(figures) {
  /** @type {string[]} */
  const missed = [];
  if (figures.lcp === null || figures.lcp > TARGETS.lcpMs) {
    missed.push(`LCP ${seconds(figures.lcp)} > ${seconds(TARGETS.lcpMs)}`);
  }
  if (figures.cls === null || figures.cls > TARGETS.cls) {
    missed.push(`CLS ${shift(figures.cls)} > ${TARGETS.cls}`);
  }
  if (figures.inp === null || figures.inp > TARGETS.inpMs) {
    missed.push(`INP ${millis(figures.inp)} > ${millis(TARGETS.inpMs)}`);
  }
  return missed;
}

/** @param {number | null} ms */
const seconds = (ms) => (ms === null ? "—" : `${(ms / 1000).toFixed(2)} s`);
/** @param {number | null} ms */
const millis = (ms) => (ms === null ? "—" : `${Math.round(ms)} ms`);
/** @param {number | null} value */
const shift = (value) => (value === null ? "—" : value === 0 ? "0" : value.toFixed(3));
/** @param {number | null} value */
const score = (value) => (value === null ? "—" : value.toFixed(2));
/** @param {number | null} bytes */
const kilobytes = (bytes) => (bytes === null ? "—" : `${(bytes / 1024).toFixed(1)} KB`);

/** @param {RunFigures} figures */
const widthOf = (figures) => figures.width ?? DEFAULT_WIDTH;

/**
 * How the report names the runs of a page at a width: "Home" when every run is at Lighthouse's default width, else
 * with the width ("Home, 360 px", "Home, 412 px"); with ", signed in" when the runs were a signed-in customer's
 * (`--signed-in`, OFE-031).
 * @param {RunFigures[]} runs
 */
function runTitles(runs) {
  const withWidths = runs.some((figures) => widthOf(figures) !== DEFAULT_WIDTH);
  const signedIn = runs.some((figures) => figures.signedIn === true) ? ", signed in" : "";
  return (/** @type {PageName} */ page, /** @type {number} */ width) =>
    `${withWidths ? `${PAGE_TITLES[page]}, ${width} px` : PAGE_TITLES[page]}${signedIn}`;
}

/**
 * The report: the table of storefront-accessibility.md §3 (with a median row per page and width), then bytes, fonts
 * and the layout shifts of every run; the first line says when the runs were a signed-in customer's.
 * @param {RunFigures[]} runs
 * @param {{ lighthouse: string, browser: string, baseUrl: string, date: string, signedIn?: boolean }} meta
 */
export function formatReport(runs, meta) {
  const title = runTitles(runs);
  const as = meta.signedIn === true ? ", a signed-in customer" : "";
  const lines = [
    `Lighthouse ${meta.lighthouse} (user flow, default mobile configuration), ${meta.browser}, ${meta.baseUrl}, ${meta.date}${as}`,
    "",
    "| Page | Run | Performance score | FCP | LCP (≤ 2.5 s) | CLS (≤ 0.1) | TBT | INP (≤ 200 ms) |",
    "|---|---|---|---|---|---|---|---|",
  ];
  const widths = [...new Set(runs.map(widthOf))];
  for (const page of PAGES) {
    for (const width of widths) {
      const own = runs.filter((figures) => figures.page === page && widthOf(figures) === width);
      if (own.length === 0) {
        continue;
      }
      for (const figures of own) {
        lines.push(
          `| ${title(page, width)} | ${figures.run} | ${score(figures.score)} | ${seconds(figures.fcp)} | ` +
            `${seconds(figures.lcp)} | ${shift(figures.cls)} | ${millis(figures.tbt)} | ${millis(figures.inp)} |`,
        );
      }
      const middle = (/** @type {keyof RunFigures} */ key) =>
        median(own.map((figures) => /** @type {number | null} */ (figures[key])));
      lines.push(
        `| **${title(page, width)}, median** | | ${score(middle("score"))} | ${seconds(middle("fcp"))} | ` +
          `**${seconds(middle("lcp"))}** | **${shift(middle("cls"))}** | ${millis(middle("tbt"))} | ` +
          `**${millis(middle("inp"))}** |`,
      );
    }
  }
  lines.push("");
  for (const figures of runs) {
    const shifts =
      figures.shifts.length === 0
        ? "no layout shift"
        : figures.shifts.map((entry) => `${shift(entry.score)} ${entry.element}`).join("; ");
    const session = figures.session === undefined ? "" : `; auth.getSession ${figures.session}`;
    lines.push(
      `- ${title(figures.page, widthOf(figures))} ${figures.run}: ${kilobytes(figures.bytes)} transferred, fonts ` +
        `${kilobytes(figures.fontBytes)}${session}; layout shifts: ${shifts}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Waits until the results page shows its count, no list is loading and the query string has the mark.
 * @param {import("puppeteer-core").Page} page
 * @param {string} [mark] a text the query string must (`stops=0`) or, after `!`, must not contain
 */
async function resultsShown(page, mark = "") {
  await page.waitForFunction(
    (/** @type {string} */ wanted) => {
      const doc = globalThis.document;
      const heading = doc.querySelector("#results-count")?.textContent?.trim() ?? "";
      const busy = doc.querySelector("[data-offers]")?.getAttribute("aria-busy");
      const search = globalThis.location.search;
      const inQuery = wanted.startsWith("!") ? !search.includes(wanted.slice(1)) : search.includes(wanted);
      return /^\d+ flights?$/.test(heading) && busy === "false" && inQuery;
    },
    { timeout: WAIT_MS },
    mark,
  );
}

/**
 * A new customer for one signed-in run: a unique address on the reserved example.com domain (RFC 2606) and a random
 * password of 34 characters with upper and lower case letters, digits and a symbol, which no password rule or list
 * of common passwords refuses. Nothing of it is printed or kept.
 * @param {(size: number) => Buffer} [random]
 */
export function newCustomer(random = randomBytes) {
  return {
    firstName: "Lighthouse",
    lastName: "Customer",
    email: `lighthouse-${random(8).toString("hex")}@example.com`,
    password: `Lh-${random(24).toString("base64url")}-9`,
  };
}

/**
 * Signs `customer` in through the storefront in `page` (`--signed-in`): with `signUp`, first through the sign-up page
 * (the demo OTA opens the session at sign-up), then, when that did not sign the customer in, through the sign-in page.
 * Ends on the account page with the page's sessionStorage emptied, so the measured navigation asks storefront.get
 * again. Throws when the storefront does not sign the customer in.
 * @param {import("puppeteer-core").Page} page
 * @param {string} baseUrl
 * @param {ReturnType<typeof newCustomer>} customer
 * @param {{ signUp?: boolean }} [options] sign the customer up first (the first run of an invocation)
 */
export async function signInThroughStorefront(page, baseUrl, customer, { signUp = false } = {}) {
  const atAccount = () => new URL(page.url()).pathname === ACCOUNT_PATH;
  /**
   * Fills the page's auth form and sends it, once its module has started (the network quiet after boot), with the
   * keyboard: a pointer's press could land on the test banner, fixed to the bottom of the window over the form.
   */
  const send = async (
    /** @type {string} */ path,
    /** @type {Record<string, string>} */ fields,
    tick = "",
  ) => {
    await page.goto(new URL(path, baseUrl).href, { waitUntil: "networkidle0", timeout: WAIT_MS });
    for (const [name, value] of Object.entries(fields)) {
      await page.type(`form[data-auth-form] input[name="${name}"]`, value);
    }
    if (tick !== "") {
      await page.focus(`form[data-auth-form] input[name="${tick}"]`);
      await page.keyboard.press("Space");
    }
    await page.focus('form[data-auth-form] button[type="submit"]');
    await page.keyboard.press("Enter");
    // Signed in (the account page), or the page's answer: a state (refused, field errors) or "Check your e-mail".
    await page
      .waitForFunction(
        (/** @type {string} */ account) =>
          globalThis.location.pathname === account ||
          globalThis.document.querySelector(
            "[data-auth-state] [data-state], [data-check-email]:not([hidden]), [data-error-summary]:not([hidden])",
          ) !== null,
        { timeout: WAIT_MS },
        ACCOUNT_PATH,
      )
      .catch(() => {
        throw new Error(`${path} did not answer its form within ${WAIT_MS / 1000} s`);
      });
  };
  if (signUp) {
    await send(
      SIGN_UP_PATH,
      {
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email,
        password: customer.password,
      },
      "termsAccepted",
    );
  }
  if (!atAccount()) {
    await send(SIGN_IN_PATH, { email: customer.email, password: customer.password });
  }
  if (!atAccount()) {
    throw new Error(
      "the storefront did not sign the customer in (an OTA that wants the e-mail address verified first, or a rate " +
        "limit: 5 sign-ups per hour and 10 sign-ins per minute per address)",
    );
  }
  await page.evaluate(() => globalThis.sessionStorage.clear());
}

/** What a traveller does first, per page (the timespan's interactions). */
const INTERACTIONS = Object.freeze({
  /** @param {import("puppeteer-core").Page} page */
  async home(page) {
    await page.waitForSelector('#search-from[role="combobox"]', { timeout: WAIT_MS });
    await page.click("#search-from");
    await page.keyboard.type("Madrid");
    await page.waitForSelector('#search-from-listbox [role="option"]', { visible: true, timeout: WAIT_MS });
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.click('input[name="trip"][value="oneway"]');
    await page.click('input[name="trip"][value="return"]');
  },
  /** @param {import("puppeteer-core").Page} page */
  async results(page) {
    await resultsShown(page, "search=srch_");
    // Narrow screens: the filters are behind the "Filters" disclosure (OFE-027); wider ones show the sidebar.
    const toggle = await page.$("button[data-filters-toggle]");
    if (toggle && (await toggle.isVisible())) {
      await toggle.click();
    }
    const direct = 'form[data-filters] input[name="stops"][value="0"]';
    await page.waitForSelector(direct, { visible: true, timeout: WAIT_MS });
    await page.click(direct);
    await resultsShown(page, "stops=0");
    await page.click(direct);
    await resultsShown(page, "!stops=");
    await page.select("#results-sort", "price");
    await resultsShown(page, "sort=price");
  },
});

/**
 * One run of one page at one phone width in a new browser.
 * @param {Options} options
 * @param {PageName} name
 * @param {PhoneWidth} width
 * @param {number} run
 * @param {{ customer: ReturnType<typeof newCustomer>, signedUp: boolean } | null} account `--signed-in`'s customer,
 *   whose `signedUp` the first run sets once the storefront has signed the customer up
 * @returns {Promise<{ figures: RunFigures, browser: string, lighthouse: string }>}
 */
async function measure(options, name, width, run, account) {
  const [{ startFlow }, puppeteer] = await Promise.all([import("lighthouse"), import("puppeteer-core")]);
  const browser = await puppeteer.default.launch({
    executablePath: options.chrome,
    headless: true,
    // Chromium refuses to start as root with its sandbox (the agents' containers); a normal user keeps it.
    args: process.getuid?.() === 0 ? ["--no-sandbox"] : [],
  });
  try {
    const page = await browser.newPage();
    if (account) {
      await signInThroughStorefront(page, options.baseUrl, account.customer, { signUp: !account.signedUp });
      account.signedUp = true;
    }
    const title = `${PAGE_TITLES[name]}, ${width} px${options.signedIn ? ", signed in" : ""}`;
    // The flow's flags apply to each of its steps: the navigation and the timespan both run on this phone's screen.
    const flow = await startFlow(page, {
      name: `${title} ${run}`,
      flags: { screenEmulation: { ...PHONE_SCREENS[width] } },
    });
    const path = name === "home" ? "/" : resultsPath(new Date(), options.daysAhead);
    await flow.navigate(new URL(path, options.baseUrl).href, { name: `${title}: navigation` });
    await flow.startTimespan({ name: `${title}: first interactions` });
    await INTERACTIONS[name](page);
    await flow.endTimespan();
    const result = await flow.createFlowResult();
    const lighthouse = String(result.steps[0]?.lhr?.lighthouseVersion ?? "unknown");
    const figures = figuresOf(result, name, run);
    if (account && figures.session !== 200) {
      // The cookies did not reach the measured navigation: its figures would be a visitor's.
      throw new Error(
        `${title} ${run}: the navigation was not signed in (auth.getSession ${figures.session ?? "not asked"})`,
      );
    }
    return {
      figures: { ...figures, width, ...(options.signedIn ? { signedIn: true } : {}) },
      browser: await browser.version(),
      lighthouse,
    };
  } finally {
    await browser.close();
  }
}

/**
 * Measures every page `runs` times, prints the report and returns the exit code.
 * @param {Options} options
 */
async function main(options) {
  if (!existsSync(options.chrome)) {
    console.error(`lighthouse: no Chromium at ${options.chrome}; pass --chrome <path> or set CHROME_PATH`);
    return 2;
  }
  /** @type {RunFigures[]} */
  const runs = [];
  let browser = "Chromium";
  let lighthouse = "unknown";
  // One customer per invocation: signed up in the first run, signed in again in each later run's new browser.
  const account = options.signedIn ? { customer: newCustomer(), signedUp: false } : null;
  for (const name of options.pages) {
    for (const width of options.widths) {
      for (let run = 1; run <= options.runs; run += 1) {
        const measured = await measure(options, name, width, run, account);
        runs.push(measured.figures);
        ({ browser, lighthouse } = measured);
        console.error(
          `lighthouse: ${name} at ${width} px${options.signedIn ? ", signed in," : ""} ${run}/${options.runs} done`,
        );
      }
    }
  }
  const meta = {
    lighthouse,
    browser,
    baseUrl: options.baseUrl,
    date: new Date().toISOString(),
    ...(options.signedIn ? { signedIn: true } : {}),
  };
  process.stdout.write(formatReport(runs, meta));
  if (options.json) {
    writeFileSync(resolve(options.json), `${JSON.stringify({ meta, targets: TARGETS, runs }, null, 2)}\n`);
  }
  const title = runTitles(runs);
  const missed = runs.flatMap((figures) =>
    missedTargets(figures).map((text) => `${title(figures.page, widthOf(figures))} ${figures.run}: ${text}`),
  );
  for (const text of missed) {
    console.error(`lighthouse: target missed: ${text}`);
  }
  return missed.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  /** @type {Options} */
  let options;
  try {
    options = parseOptions(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`lighthouse: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  main(options).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`lighthouse: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      process.exit(2);
    },
  );
}
