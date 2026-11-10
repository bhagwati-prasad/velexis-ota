#!/usr/bin/env node
// lighthouse: Lighthouse's mobile figures of the storefront's home and results pages (ota/frontend/README.md §9), with
// the method of ota/docs/storefront-accessibility.md §3.1, so that the LCP, CLS and INP figures can be repeated
// (OFE-027, lead decision 11n of 2026-11-06).
//
// Usage:  pnpm --filter @velexis/ota-frontend lighthouse [--base-url <url>] [--page home|results]... [--runs <n>]
//                                                        [--days-ahead <n>] [--chrome <path>] [--json <file>]
//
//   --base-url    the storefront to measure (default http://127.0.0.1:4173: the end-to-end harness's preview of the
//                 demo OTA, the production build proxied to the built OTA API on the Amadeus stub)
//   --page        home or results, repeatable (default both)
//   --runs        runs per page (default 3), each in a new browser with an empty profile
//   --days-ahead  the results page's departure date, days after today in UTC (default 69)
//   --chrome      the Chromium to run (default the CHROME_PATH variable, else /opt/pw-browsers/chromium)
//   --json        also write the figures as JSON to this file
//
// Lighthouse and puppeteer-core are this package's exact devDependencies; Lighthouse's user-flow API with its default
// configuration (mobile: Moto G Power emulation, simulated slow 4G and 4x CPU slowdown). Each run is a navigation
// (performance score, FCP, LCP, CLS, TBT, bytes, fonts and the layout shifts with the element each moved most) and
// then a timespan with what a traveller does first, for INP:
//   home     "Madrid" typed into From, the first suggestion chosen with ArrowDown and Enter, One way, then Return;
//   results  /search.html?trip=oneway&from=MAD&to=PAR&depart=<date>&adults=1&children=0&infants=0&cabin=ECONOMY (the
//            page runs the search); on a narrow screen the "Filters" disclosure opened (OFE-027), "Direct" ticked and
//            unticked, then "Cheapest first".
// It prints the Markdown table of storefront-accessibility.md §3 with the median of each page and the layout shifts
// of every run, and exits 1 when a run misses a target (LCP ≤ 2.5 s, CLS ≤ 0.1, INP ≤ 200 ms), 2 when it cannot run.
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
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** How long a search, a filter change or a suggestion may take on the stack (the stub answers in milliseconds). */
const WAIT_MS = 60_000;

/** @typedef {(typeof PAGES)[number]} PageName */
/**
 * @typedef {object} Options
 * @property {string} baseUrl
 * @property {PageName[]} pages
 * @property {number} runs
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
 * @property {number | null} score
 * @property {number | null} fcp
 * @property {number | null} lcp
 * @property {number | null} cls
 * @property {number | null} tbt
 * @property {number | null} inp
 * @property {number | null} bytes
 * @property {number | null} fontBytes
 * @property {Shift[]} shifts
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

/**
 * The report: the table of storefront-accessibility.md §3 (with a median row per page), then bytes, fonts and the
 * layout shifts of every run.
 * @param {RunFigures[]} runs
 * @param {{ lighthouse: string, browser: string, baseUrl: string, date: string }} meta
 */
export function formatReport(runs, meta) {
  const lines = [
    `Lighthouse ${meta.lighthouse} (user flow, default mobile configuration), ${meta.browser}, ${meta.baseUrl}, ${meta.date}`,
    "",
    "| Page | Run | Performance score | FCP | LCP (≤ 2.5 s) | CLS (≤ 0.1) | TBT | INP (≤ 200 ms) |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const page of PAGES) {
    const own = runs.filter((figures) => figures.page === page);
    if (own.length === 0) {
      continue;
    }
    for (const figures of own) {
      lines.push(
        `| ${PAGE_TITLES[page]} | ${figures.run} | ${score(figures.score)} | ${seconds(figures.fcp)} | ` +
          `${seconds(figures.lcp)} | ${shift(figures.cls)} | ${millis(figures.tbt)} | ${millis(figures.inp)} |`,
      );
    }
    const middle = (/** @type {keyof RunFigures} */ key) =>
      median(own.map((figures) => /** @type {number | null} */ (figures[key])));
    lines.push(
      `| **${PAGE_TITLES[page]}, median** | | ${score(middle("score"))} | ${seconds(middle("fcp"))} | ` +
        `**${seconds(middle("lcp"))}** | **${shift(middle("cls"))}** | ${millis(middle("tbt"))} | ` +
        `**${millis(middle("inp"))}** |`,
    );
  }
  lines.push("");
  for (const figures of runs) {
    const shifts =
      figures.shifts.length === 0
        ? "no layout shift"
        : figures.shifts.map((entry) => `${shift(entry.score)} ${entry.element}`).join("; ");
    lines.push(
      `- ${PAGE_TITLES[figures.page]} ${figures.run}: ${kilobytes(figures.bytes)} transferred, fonts ` +
        `${kilobytes(figures.fontBytes)}; layout shifts: ${shifts}`,
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
 * One run of one page in a new browser.
 * @param {Options} options
 * @param {PageName} name
 * @param {number} run
 * @returns {Promise<{ figures: RunFigures, browser: string, lighthouse: string }>}
 */
async function measure(options, name, run) {
  const [{ startFlow }, puppeteer] = await Promise.all([import("lighthouse"), import("puppeteer-core")]);
  const browser = await puppeteer.default.launch({
    executablePath: options.chrome,
    headless: true,
    // Chromium refuses to start as root with its sandbox (the agents' containers); a normal user keeps it.
    args: process.getuid?.() === 0 ? ["--no-sandbox"] : [],
  });
  try {
    const page = await browser.newPage();
    const flow = await startFlow(page, { name: `${PAGE_TITLES[name]} ${run}` });
    const path = name === "home" ? "/" : resultsPath(new Date(), options.daysAhead);
    await flow.navigate(new URL(path, options.baseUrl).href, { name: `${PAGE_TITLES[name]}: navigation` });
    await flow.startTimespan({ name: `${PAGE_TITLES[name]}: first interactions` });
    await INTERACTIONS[name](page);
    await flow.endTimespan();
    const result = await flow.createFlowResult();
    const lighthouse = String(result.steps[0]?.lhr?.lighthouseVersion ?? "unknown");
    return { figures: figuresOf(result, name, run), browser: await browser.version(), lighthouse };
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
  for (const name of options.pages) {
    for (let run = 1; run <= options.runs; run += 1) {
      const measured = await measure(options, name, run);
      runs.push(measured.figures);
      ({ browser, lighthouse } = measured);
      console.error(`lighthouse: ${name} ${run}/${options.runs} done`);
    }
  }
  const meta = { lighthouse, browser, baseUrl: options.baseUrl, date: new Date().toISOString() };
  process.stdout.write(formatReport(runs, meta));
  if (options.json) {
    writeFileSync(resolve(options.json), `${JSON.stringify({ meta, targets: TARGETS, runs }, null, 2)}\n`);
  }
  const missed = runs.flatMap((figures) =>
    missedTargets(figures).map((text) => `${PAGE_TITLES[figures.page]} ${figures.run}: ${text}`),
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
