// @vitest-environment node
// The pinned Lighthouse script (scripts/lighthouse.mjs, README §9, OFE-027): its options, the results page's address,
// the figures it takes from Lighthouse's flow result, the medians and the targets of README §9, the phone widths
// (OFE-030) and the signed-in customer of `--signed-in` (OFE-031). The measurement itself needs a browser and a running
// storefront, so it is run by hand (ota/docs/storefront-accessibility.md §3).
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BASE_URL,
  DEFAULT_CHROME,
  DEFAULT_WIDTH,
  PHONE_SCREENS,
  TARGETS,
  figuresOf,
  formatReport,
  median,
  missedTargets,
  newCustomer,
  parseOptions,
  resultsPath,
} from "../scripts/lighthouse.mjs";

/**
 * A flow result as Lighthouse's user-flow API gives it, with the audits the script reads.
 * @param {{ cls?: number, inp?: number | null, shifts?: Array<{ score: number, selector?: string }>, session?: number }} [options]
 *   `session`: the status of an auth.getSession request in the navigation (none without it)
 */
function flowResult({
  cls = 0.012,
  inp = 42,
  shifts = [{ score: 0.012, selector: "body > footer" }],
  session = /** @type {number | undefined} */ (undefined),
} = {}) {
  return {
    steps: [
      {
        lhr: {
          gatherMode: "navigation",
          lighthouseVersion: "13.5.0",
          categories: { performance: { score: 0.97 } },
          audits: {
            "first-contentful-paint": { numericValue: 1512.4 },
            "largest-contentful-paint": { numericValue: 1904.9 },
            "cumulative-layout-shift": { numericValue: cls },
            "total-blocking-time": { numericValue: 0 },
            "total-byte-weight": { numericValue: 165_000 },
            "network-requests": {
              details: {
                items: [
                  { resourceType: "Document", transferSize: 6_000 },
                  { resourceType: "Font", transferSize: 25_000 },
                  { resourceType: "Font", transferSize: 24_000 },
                  ...(session === undefined
                    ? []
                    : [
                        {
                          resourceType: "Fetch",
                          transferSize: 600,
                          url: "http://127.0.0.1:4173/api/v1/auth/session",
                          statusCode: session,
                        },
                      ]),
                ],
              },
            },
            "layout-shifts": {
              details: {
                items: shifts.map(({ score, selector }) => ({
                  score,
                  node: selector ? { type: "node", selector, nodeLabel: "label" } : undefined,
                })),
              },
            },
          },
        },
      },
      {
        lhr: {
          gatherMode: "timespan",
          audits: { "interaction-to-next-paint": inp === null ? {} : { numericValue: inp } },
        },
      },
    ],
  };
}

describe("the Lighthouse script", () => {
  it("[OFE-027] reads its options, with the e2e preview, both pages, three runs and the given Chromium by default", () => {
    expect(parseOptions([], {})).toEqual({
      baseUrl: DEFAULT_BASE_URL,
      pages: ["home", "results"],
      runs: 3,
      widths: [412],
      signedIn: false,
      daysAhead: 69,
      chrome: DEFAULT_CHROME,
      json: null,
    });
    expect(DEFAULT_BASE_URL).toBe("http://127.0.0.1:4173");
    expect(DEFAULT_CHROME).toBe("/opt/pw-browsers/chromium");
    expect(parseOptions([], { CHROME_PATH: "/usr/bin/chromium" }).chrome).toBe("/usr/bin/chromium");
    // pnpm passes the `--` of `pnpm lighthouse -- …` on.
    expect(
      parseOptions(
        [
          "--",
          "--page",
          "results",
          "--runs",
          "5",
          "--chrome",
          "/opt/chrome",
          "--base-url",
          "http://localhost:4173/x",
        ],
        { CHROME_PATH: "/usr/bin/chromium" },
      ),
    ).toMatchObject({ baseUrl: "http://localhost:4173", pages: ["results"], runs: 5, chrome: "/opt/chrome" });
    expect(() => parseOptions(["--page", "offer"], {})).toThrow(/home, results/);
    expect(() => parseOptions(["--runs", "0"], {})).toThrow(/--runs/);
    expect(() => parseOptions(["--runs", "2.5"], {})).toThrow(/--runs/);
    expect(() => parseOptions(["--base-url", "file:///etc/passwd"], {})).toThrow(/http/);
    expect(() => parseOptions(["--unknown"], {})).toThrow();
  });

  it("[OFE-030 AC1] measures at Lighthouse's 412 px phone by default and at a 360 px phone on request", () => {
    expect(DEFAULT_WIDTH).toBe(412);
    // Lighthouse's own mobile screen (Moto G Power) and a narrower phone with the same pixel ratio.
    expect(PHONE_SCREENS).toEqual({
      412: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false },
      360: { mobile: true, width: 360, height: 800, deviceScaleFactor: 1.75, disabled: false },
    });
    expect(parseOptions(["--width", "360"], {}).widths).toEqual([360]);
    expect(parseOptions(["--", "--width", "360", "--width", "412", "--width", "360"], {}).widths).toEqual([
      360, 412,
    ]);
    expect(() => parseOptions(["--width", "320"], {})).toThrow(/--width must be one of 360, 412/);
    expect(() => parseOptions(["--width", "412px"], {})).toThrow(/--width/);
  });

  it("[OFE-030 AC1] names each page with its width when a report has more than Lighthouse's default one", () => {
    const at = (/** @type {360 | 412} */ width, /** @type {number} */ run, /** @type {number} */ cls) => ({
      ...figuresOf(flowResult({ cls, shifts: [] }), "home", run),
      width,
    });
    const report = formatReport([at(412, 1, 0), at(412, 2, 0.02), at(360, 1, 0.12), at(360, 2, 0)], {
      lighthouse: "13.5.0",
      browser: "HeadlessChrome/153.0.8010.12",
      baseUrl: DEFAULT_BASE_URL,
      date: "a date",
    });
    expect(report.split("\n").slice(4, 10)).toEqual([
      "| Home, 412 px | 1 | 0.97 | 1.51 s | 1.90 s | 0 | 0 ms | 42 ms |",
      "| Home, 412 px | 2 | 0.97 | 1.51 s | 1.90 s | 0.020 | 0 ms | 42 ms |",
      "| **Home, 412 px, median** | | 0.97 | 1.51 s | **1.90 s** | **0.010** | 0 ms | **42 ms** |",
      "| Home, 360 px | 1 | 0.97 | 1.51 s | 1.90 s | 0.120 | 0 ms | 42 ms |",
      "| Home, 360 px | 2 | 0.97 | 1.51 s | 1.90 s | 0 | 0 ms | 42 ms |",
      "| **Home, 360 px, median** | | 0.97 | 1.51 s | **1.90 s** | **0.060** | 0 ms | **42 ms** |",
    ]);
    expect(report).toContain(
      "- Home, 360 px 1: 161.1 KB transferred, fonts 47.9 KB; layout shifts: no layout shift",
    );
    // Every run at the default width alone: the page names of the earlier reports.
    expect(
      formatReport([at(412, 1, 0)], { lighthouse: "13.5.0", browser: "x", baseUrl: "y", date: "z" }),
    ).toContain("| **Home, median** |");
  });

  it("[OFE-031 AC1] measures as a signed-in customer on request, and says so in the report", () => {
    expect(parseOptions(["--", "--signed-in", "--width", "360"], {})).toMatchObject({
      signedIn: true,
      widths: [360],
    });
    expect(() => parseOptions(["--signed-in=yes"], {})).toThrow();
    const signedIn = (/** @type {360 | 412} */ width, /** @type {number} */ run) => ({
      ...figuresOf(flowResult({ cls: 0, shifts: [] }), "results", run),
      width,
      signedIn: true,
    });
    const report = formatReport([signedIn(412, 1), signedIn(360, 1)], {
      lighthouse: "13.5.0",
      browser: "HeadlessChrome/153.0.8010.12",
      baseUrl: DEFAULT_BASE_URL,
      date: "a date",
      signedIn: true,
    });
    const lines = report.split("\n");
    expect(lines[0]).toBe(
      "Lighthouse 13.5.0 (user flow, default mobile configuration), HeadlessChrome/153.0.8010.12, " +
        "http://127.0.0.1:4173, a date, a signed-in customer",
    );
    expect(lines.slice(4, 8)).toEqual([
      "| Results, 412 px, signed in | 1 | 0.97 | 1.51 s | 1.90 s | 0 | 0 ms | 42 ms |",
      "| **Results, 412 px, signed in, median** | | 0.97 | 1.51 s | **1.90 s** | **0** | 0 ms | **42 ms** |",
      "| Results, 360 px, signed in | 1 | 0.97 | 1.51 s | 1.90 s | 0 | 0 ms | 42 ms |",
      "| **Results, 360 px, signed in, median** | | 0.97 | 1.51 s | **1.90 s** | **0** | 0 ms | **42 ms** |",
    ]);
    expect(report).toContain("- Results, 360 px, signed in 1: 161.1 KB transferred");
    // At the default width alone: "Results, signed in".
    expect(
      formatReport([signedIn(412, 1)], { lighthouse: "x", browser: "x", baseUrl: "x", date: "x" }),
    ).toContain("| **Results, signed in, median** |");
  });

  it("[OFE-031 AC1] reads whether the navigation was signed in from its auth.getSession request, and reports it", () => {
    expect(figuresOf(flowResult({ session: 200 }), "home", 1).session).toBe(200);
    expect(figuresOf(flowResult({ session: 401 }), "home", 1).session).toBe(401);
    // No such request (an OTA without customer accounts): no status, and the report line as before.
    expect(figuresOf(flowResult(), "home", 1)).not.toHaveProperty("session");
    const report = formatReport(
      [
        { ...figuresOf(flowResult({ session: 200, shifts: [] }), "home", 1), signedIn: true },
        { ...figuresOf(flowResult({ shifts: [] }), "home", 2), signedIn: true },
      ],
      { lighthouse: "x", browser: "x", baseUrl: "x", date: "x", signedIn: true },
    );
    expect(report).toContain(
      "- Home, signed in 1: 161.1 KB transferred, fonts 47.9 KB; auth.getSession 200; layout shifts: no layout shift",
    );
    expect(report).toContain(
      "- Home, signed in 2: 161.1 KB transferred, fonts 47.9 KB; layout shifts: no layout shift",
    );
  });

  it("[OFE-031 AC1] makes a new customer per invocation: a unique example.com address and a strong random password", () => {
    const first = newCustomer();
    const second = newCustomer();
    expect(first.email).toMatch(/^lighthouse-[0-9a-f]{16}@example\.com$/);
    expect(second.email).not.toBe(first.email);
    expect(second.password).not.toBe(first.password);
    // Long, with upper and lower case letters, a digit and a symbol: no password rule of an OTA refuses it.
    expect(first.password.length).toBeGreaterThanOrEqual(30);
    for (const rule of [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z0-9]/]) {
      expect(first.password).toMatch(rule);
    }
    expect(first).toMatchObject({ firstName: "Lighthouse", lastName: "Customer" });
    // The random source decides everything that varies.
    const fixed = newCustomer((size) => Buffer.alloc(size, 7));
    expect(fixed.email).toBe("lighthouse-0707070707070707@example.com");
    expect(fixed.password).toBe(`Lh-${Buffer.alloc(24, 7).toString("base64url")}-9`);
  });

  it("[OFE-027] searches Madrid to Paris one way for one adult, the given number of days ahead", () => {
    expect(resultsPath(new Date(Date.UTC(2026, 10, 10, 23, 30)), 69)).toBe(
      "/search.html?trip=oneway&from=MAD&to=PAR&depart=2027-01-18&adults=1&children=0&infants=0&cabin=ECONOMY",
    );
  });

  it("[OFE-027] takes the navigation's figures and the timespan's INP, and the layout shifts with their elements", () => {
    expect(figuresOf(flowResult(), "results", 2)).toEqual({
      page: "results",
      run: 2,
      score: 0.97,
      fcp: 1512.4,
      lcp: 1904.9,
      cls: 0.012,
      tbt: 0,
      inp: 42,
      bytes: 165_000,
      fontBytes: 49_000,
      shifts: [{ score: 0.012, element: "body > footer" }],
    });
    // No interaction Lighthouse counts: INP unknown, which misses the target rather than passing it.
    const withoutInp = figuresOf(flowResult({ inp: null, shifts: [{ score: 0.2 }] }), "home", 1);
    expect(withoutInp.inp).toBeNull();
    expect(withoutInp.shifts).toEqual([{ score: 0.2, element: "(no element)" }]);
    expect(() => figuresOf({ steps: [] }, "home", 1)).toThrow(/navigation/);
  });

  it("[OFE-027] reports each run and the median per page, and the targets of README §9 a run misses", () => {
    expect(TARGETS).toEqual({ lcpMs: 2500, cls: 0.1, inpMs: 200 });
    expect(median([0.3, null, 0.1, 0.2])).toBe(0.2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([null])).toBeNull();

    const runs = [
      figuresOf(flowResult({ cls: 0, shifts: [] }), "results", 1),
      figuresOf(flowResult({ cls: 0.749, inp: 250 }), "results", 2),
      figuresOf(flowResult({ cls: 0.05 }), "results", 3),
    ];
    expect(missedTargets(/** @type {never} */ (runs[0]))).toEqual([]);
    expect(missedTargets(/** @type {never} */ (runs[1]))).toEqual(["CLS 0.749 > 0.1", "INP 250 ms > 200 ms"]);

    const report = formatReport(runs, {
      lighthouse: "13.5.0",
      browser: "HeadlessChrome/153.0.8010.12",
      baseUrl: DEFAULT_BASE_URL,
      date: "a date",
    });
    expect(report.split("\n").slice(2, 8)).toEqual([
      "| Page | Run | Performance score | FCP | LCP (≤ 2.5 s) | CLS (≤ 0.1) | TBT | INP (≤ 200 ms) |",
      "|---|---|---|---|---|---|---|---|",
      "| Results | 1 | 0.97 | 1.51 s | 1.90 s | 0 | 0 ms | 42 ms |",
      "| Results | 2 | 0.97 | 1.51 s | 1.90 s | 0.749 | 0 ms | 250 ms |",
      "| Results | 3 | 0.97 | 1.51 s | 1.90 s | 0.050 | 0 ms | 42 ms |",
      "| **Results, median** | | 0.97 | 1.51 s | **1.90 s** | **0.050** | 0 ms | **42 ms** |",
    ]);
    expect(report).toContain(
      "- Results 1: 161.1 KB transferred, fonts 47.9 KB; layout shifts: no layout shift",
    );
    expect(report).toContain(
      "- Results 2: 161.1 KB transferred, fonts 47.9 KB; layout shifts: 0.012 body > footer",
    );
  });
});
