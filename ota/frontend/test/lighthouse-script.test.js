// @vitest-environment node
// The pinned Lighthouse script (scripts/lighthouse.mjs, README §9, OFE-027): its options, the results page's address,
// the figures it takes from Lighthouse's flow result, the medians and the targets of README §9. The measurement itself
// needs a browser and a running storefront, so it is run by hand (ota/docs/storefront-accessibility.md §3).
import { describe, expect, it } from "vitest";

import {
  DEFAULT_BASE_URL,
  DEFAULT_CHROME,
  TARGETS,
  figuresOf,
  formatReport,
  median,
  missedTargets,
  parseOptions,
  resultsPath,
} from "../scripts/lighthouse.mjs";

/**
 * A flow result as Lighthouse's user-flow API gives it, with the audits the script reads.
 * @param {{ cls?: number, inp?: number | null, shifts?: Array<{ score: number, selector?: string }> }} [options]
 */
function flowResult({ cls = 0.012, inp = 42, shifts = [{ score: 0.012, selector: "body > footer" }] } = {}) {
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
