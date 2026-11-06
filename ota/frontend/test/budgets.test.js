// @vitest-environment node
// The size budgets of scripts/check-budgets.mjs (ota/frontend/README.md §9, OADR-0015 point 12): the gzip budgets of
// HTML, JS and CSS, and the font budget of OFE-024, on fixture build folders written to a scratch directory.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  BUDGETS,
  FONT_BUDGET,
  KB,
  checkBudgets,
  formatReport,
  matchFace,
  passes,
} from "../scripts/check-budgets.mjs";
import { STOREFRONT_ROOT, removeScratch, scratchDir } from "./helpers/storefront.js";

const SCRIPT = join(STOREFRONT_ROOT, "scripts", "check-budgets.mjs");

/**
 * Text that gzip cannot shrink much: base64 of a fixed xorshift sequence, so fixtures are deterministic.
 * @param {number} gzipBytes the gzip size to exceed
 */
function incompressible(gzipBytes) {
  let state = 0x9e3779b9;
  const bytes = Buffer.alloc(Math.ceil(gzipBytes * 1.05));
  for (let i = 0; i < bytes.length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 0xff;
  }
  const text = bytes.toString("base64");
  expect(gzipSync(text).length).toBeGreaterThan(gzipBytes);
  return text;
}

const page = (/** @type {string} */ head, body = "<h1>Fixture</h1>") =>
  `<!doctype html><html lang="en"><head><title>Fixture</title>${head}</head><body>${body}</body></html>`;
const script = (/** @type {string} */ src) => `<script type="module" crossorigin src="${src}"></script>`;
const stylesheet = (/** @type {string} */ href) => `<link rel="stylesheet" crossorigin href="${href}">`;

/** @type {string[]} */
const scratch = [];
afterEach(() => {
  scratch.splice(0).forEach(removeScratch);
});

/** Writes a fixture build folder: `{ "index.html": "…", "assets/index-abcdefgh.js": "…" }`. */
function fixture(/** @type {Record<string, string | Buffer>} */ files) {
  const dir = scratchDir("budgets");
  scratch.push(dir);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  return dir;
}

const runScript = (/** @type {string} */ dir) =>
  spawnSync(process.execPath, [SCRIPT, "--dir", dir], { encoding: "utf8" });

/** A font file of exactly `bytes` bytes with the woff2 signature (fonts are counted as served, not gzipped). */
const woff2 = (/** @type {number} */ bytes) =>
  Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(bytes - 4, 1)]);

/**
 * A stylesheet as Tailwind writes the storefront's (minified): one `@font-face` per `[family, weight, url, format]`,
 * the runtime font properties of main.css, the body text in `--vx-font-body` at 400 and `font-semibold` (600), the
 * headings in `--vx-font-heading`, and `extra` rules.
 * @param {Array<[string, number, string, string?]>} faces
 * @param {string} [extra]
 */
const fontCss = (faces, extra = "") =>
  faces
    .map(
      ([family, weight, url, format = "woff2"]) =>
        `@font-face{font-family:${family};font-style:normal;font-weight:${weight};font-display:swap;` +
        `src:url(${url})format("${format}")}`,
    )
    .join("") +
  ':root{--vx-font-body:"Small Sans",system-ui,sans-serif;--vx-font-heading:var(--vx-font-body);' +
  "--font-body:var(--vx-font-body);--font-weight-semibold:600}" +
  "html{font-family:var(--font-body,ui-sans-serif);font-weight:400}h1,h2,h3{font-family:var(--vx-font-heading)}" +
  `.font-heading{font-family:var(--vx-font-heading)}.font-semibold{font-weight:var(--font-weight-semibold)}${extra}`;

/** A page that links `/assets/main-abcdefgh.css` with `body` in its body. */
const fontPage = (/** @type {string} */ body, extraHead = "") =>
  page(stylesheet("/assets/main-abcdefgh.css") + extraHead, body);

/** Two families of two faces each: "Small Sans" (10 KB a face) and "Large Serif" (30 KB a face). */
const twoFamilies = () => ({
  "fonts/small-400.woff2": woff2(10 * KB),
  "fonts/small-600.woff2": woff2(10 * KB),
  "fonts/large-400.woff2": woff2(30 * KB),
  "fonts/large-600.woff2": woff2(30 * KB),
});
/** @type {Array<[string, number, string]>} */
const TWO_FAMILY_FACES = [
  ['"Small Sans"', 400, "/fonts/small-400.woff2"],
  ['"Small Sans"', 600, "/fonts/small-600.woff2"],
  ["Large Serif", 400, "/fonts/large-400.woff2"],
  ["Large Serif", 600, "/fonts/large-600.woff2"],
];

const withinBudget = () => ({
  "index.html": page(script("/assets/index-abcdefgh.js") + stylesheet("/assets/main-abcdefgh.css")),
  "404.html": page(stylesheet("/assets/main-abcdefgh.css")),
  "assets/index-abcdefgh.js": 'import"./shared-abcdefgh.js";document.title="ok";',
  "assets/shared-abcdefgh.js": "export const shared = 1;",
  "assets/main-abcdefgh.css": "body{margin:0}",
});

describe("check-budgets", () => {
  /**
   * The runs of the script on the fixtures of the tests below, made once in the setup hook.
   * @type {Record<"breach" | "within" | "empty" | "fontBreach", ReturnType<typeof runScript>>}
   */
  let runs;

  // Each run starts Node and the script in a child process: a few tenths of a second idle, seconds while every
  // package's tests run at once on a CI runner. The four runs happen here, with this budget, and not inside the
  // tests' 5 s; the tests assert on what they gave.
  beforeAll(() => {
    runs = {
      // "Huge Serif" alone is 140 KB: any page that may show it in its body text breaks the font budget.
      fontBreach: runScript(
        fixture({
          "index.html": page(stylesheet("/assets/plain-abcdefgh.css")),
          "assets/plain-abcdefgh.css": "body{margin:0}",
          "fonts.html": fontPage("<h1 class='font-semibold'>Fixture</h1>"),
          "assets/main-abcdefgh.css": fontCss([
            ["Huge Serif", 400, "/fonts/huge-400.woff2"],
            ["Huge Serif", 600, "/fonts/huge-600.woff2"],
          ]),
          "fonts/huge-400.woff2": woff2(70 * KB),
          "fonts/huge-600.woff2": woff2(70 * KB),
        }),
      ),
      breach: runScript(
        fixture({
          ...withinBudget(),
          "search.html": page(script("/assets/search-abcdefgh.js")),
          "assets/search-abcdefgh.js": `export const blob = "${incompressible(BUDGETS.js)}";`,
        }),
      ),
      within: runScript(fixture(withinBudget())),
      empty: runScript(fixture({ "assets/a-abcdefgh.js": "" })),
    };
    scratch.splice(0).forEach(removeScratch);
  }, 30_000);

  it("[OFE-001 AC3] a JS budget breach on the fixture folder exits 1 and names the file", () => {
    const run = runs.breach;

    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/OVER BUDGET: search\.html JS .* > 60\.0 KB: assets\/search-abcdefgh\.js/);
    expect(run.stdout).toMatch(/^search\.html\s+JS\s+\S+ KB\s+60\.0 KB\s+OVER$/m);
    expect(run.stdout).toMatch(/^index\.html\s+JS\s+\S+ KB\s+60\.0 KB\s+ok$/m);
  });

  it("[OFE-001 AC3] exits 0 with the table when every page is within budget", () => {
    const run = runs.within;

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^Page\s+Kind\s+Size \(gzip\)\s+Budget\s+Status$/m);
    expect(run.stdout).not.toMatch(/OVER|MISSING/);
  });

  it("[OFE-001 AC3] counts the chunks a page imports, statically and dynamically", () => {
    const dir = fixture({
      ...withinBudget(),
      "assets/shared-abcdefgh.js": 'export const shared = 1; import("./lazy-abcdefgh.js");',
      "assets/lazy-abcdefgh.js": `export const blob = "${incompressible(BUDGETS.js)}";`,
    });

    const result = checkBudgets(dir);

    expect(passes(result)).toBe(false);
    const js = result.rows.find((r) => r.page === "index.html" && r.kind === "js");
    expect(js?.ok).toBe(false);
    expect(js?.files.map((f) => f.file)).toEqual([
      "assets/lazy-abcdefgh.js",
      expect.stringMatching(/^assets\/(index|shared)-abcdefgh\.js$/),
      expect.stringMatching(/^assets\/(index|shared)-abcdefgh\.js$/),
    ]);
    expect(formatReport(result)).toContain("assets/lazy-abcdefgh.js");
  });

  it("[OFE-001 AC3] holds checkout/pay-airline.html to 30 KB of JavaScript", () => {
    const blob = `export const blob = "${incompressible(40 * KB)}";`;
    const dir = fixture({
      ...withinBudget(),
      "checkout/pay-card.html": page(script("/assets/checkout-pay-card-abcdefgh.js")),
      "assets/checkout-pay-card-abcdefgh.js": blob,
      "checkout/pay-airline.html": page(script("/assets/checkout-pay-airline-abcdefgh.js")),
      "assets/checkout-pay-airline-abcdefgh.js": blob,
    });

    const rows = checkBudgets(dir).rows.filter((r) => r.kind === "js" && r.page.startsWith("checkout/"));

    expect(rows.map((r) => [r.page, r.limit, r.ok])).toEqual([
      ["checkout/pay-airline.html", 30 * KB, false],
      ["checkout/pay-card.html", 60 * KB, true],
    ]);
  });

  it("[OFE-001 AC3] names the page or stylesheet that breaks the HTML or CSS budget", () => {
    const dir = fixture({
      ...withinBudget(),
      "big.html": page(stylesheet("/assets/big-abcdefgh.css"), `<p>${incompressible(BUDGETS.html)}</p>`),
      "assets/big-abcdefgh.css": `/* ${incompressible(BUDGETS.css)} */`,
    });

    const report = formatReport(checkBudgets(dir));

    expect(report).toMatch(/OVER BUDGET: big\.html HTML .* > 20\.0 KB: big\.html/);
    expect(report).toMatch(/OVER BUDGET: big\.html CSS .* > 20\.0 KB: assets\/big-abcdefgh\.css/);
  });

  it("[OFE-001 AC3] ignores third-party scripts but fails on a missing local file or an empty folder", () => {
    const external = checkBudgets(
      fixture({ "pay.html": page(script("https://js.stripe.com/basil/stripe.js") + script("/assets/x.js")) }),
    );
    expect(external.missing).toEqual([{ page: "pay.html", file: "assets/x.js" }]);
    expect(passes(external)).toBe(false);

    const { empty } = runs;
    expect(empty.status).toBe(1);
    expect(empty.stdout).toContain("NO PAGES");
  });

  it("[OFE-024] counts the largest body and heading pair of the families a page's stylesheet declares", () => {
    const dir = fixture({
      "fonts.html": fontPage("<h1 class='font-heading font-semibold'>Fixture</h1><p>Text</p>"),
      "assets/main-abcdefgh.css": fontCss(TWO_FAMILY_FACES),
      ...twoFamilies(),
    });

    const result = checkBudgets(dir);
    const font = result.rows.find((r) => r.page === "fonts.html" && r.kind === "font");

    // Body text in Large Serif (both faces: 400 and font-semibold) and headings in Small Sans (600 only): 70 KB.
    expect(font).toMatchObject({
      bytes: 70 * KB,
      limit: FONT_BUDGET.bytes,
      ok: true,
      families: ["body", "headings"],
      notWoff2: [],
      worstCase: "body Large Serif, headings Small Sans",
    });
    expect(font?.files.map((f) => f.file).sort()).toEqual([
      "fonts/large-400.woff2",
      "fonts/large-600.woff2",
      "fonts/small-600.woff2",
    ]);
    expect(passes(result)).toBe(true);
    expect(formatReport(result)).toMatch(/^fonts\.html\s+FONT\s+70\.0 KB\s+120\.0 KB\s+ok$/m);
  });

  it("[OFE-024] a font budget breach exits 1 and names the page, the family and the files", () => {
    const run = runs.fontBreach;

    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/^fonts\.html\s+FONT\s+140\.0 KB\s+120\.0 KB\s+OVER$/m);
    expect(run.stdout).toMatch(
      /OVER BUDGET: fonts\.html FONT 140\.0 KB > 120\.0 KB \(body Huge Serif, headings Huge Serif\): fonts\/huge-(400|600)\.woff2 \(70\.0 KB\), fonts\/huge-(400|600)\.woff2 \(70\.0 KB\)/,
    );
    // The pages without fonts keep their budgets.
    expect(run.stdout).toMatch(/^index\.html\s+FONT\s+0\.0 KB\s+120\.0 KB\s+ok$/m);
  });

  it("[OFE-024] a heading without a weight class loads the heading family's regular face too", () => {
    // 45 KB faces for the body, 20 KB faces for the headings: 110 KB when the headings use 600 alone, 130 KB when a
    // heading of the page (a visually hidden one, as on confirmation.html before OFE-024) is set at 400.
    const dir = fixture({
      "semibold.html": fontPage('<h2 class="sr-only font-semibold">Status</h2>'),
      "plain.html": fontPage('<h2 class="sr-only">Status</h2>'),
      "assets/main-abcdefgh.css": fontCss([
        ["Wide", 400, "/fonts/wide-400.woff2"],
        ["Wide", 600, "/fonts/wide-600.woff2"],
        ["Narrow", 400, "/fonts/narrow-400.woff2"],
        ["Narrow", 600, "/fonts/narrow-600.woff2"],
      ]),
      "fonts/wide-400.woff2": woff2(45 * KB),
      "fonts/wide-600.woff2": woff2(45 * KB),
      "fonts/narrow-400.woff2": woff2(20 * KB),
      "fonts/narrow-600.woff2": woff2(20 * KB),
    });

    const fonts = Object.fromEntries(
      checkBudgets(dir)
        .rows.filter((r) => r.kind === "font")
        .map((r) => [r.page, { bytes: r.bytes, ok: r.ok, worstCase: r.worstCase }]),
    );

    expect(fonts).toEqual({
      "semibold.html": { bytes: 110 * KB, ok: true, worstCase: "body Wide, headings Narrow" },
      "plain.html": { bytes: 130 * KB, ok: false, worstCase: "body Wide, headings Narrow" },
    });
  });

  it("[OFE-024] counts a family a stylesheet names itself as a third family", () => {
    const dir = fixture({
      "fonts.html": fontPage("<h1 class='font-semibold'>Fixture</h1>"),
      "assets/main-abcdefgh.css": fontCss(
        [...TWO_FAMILY_FACES, ['"Display Face"', 400, "/fonts/display-400.woff2"]],
        '.brand{font-family:"Display Face",serif}',
      ),
      ...twoFamilies(),
      "fonts/display-400.woff2": woff2(5 * KB),
    });

    const result = checkBudgets(dir);
    const font = result.rows.find((r) => r.kind === "font");

    expect(font?.families).toEqual(["body", "headings", "Display Face"]);
    expect(font?.bytes).toBe(75 * KB);
    expect(font?.ok).toBe(false);
    expect(formatReport(result)).toContain(
      "TOO MANY FONT FAMILIES: fonts.html can show 3 font families at once (at most 2): body, headings, Display Face",
    );
  });

  it("[OFE-024] fails on a face that is not woff2, a missing font file, and counts a preloaded font", () => {
    const dir = fixture({
      "fonts.html": fontPage(
        "<h1 class='font-semibold'>Fixture</h1>",
        '<link rel="preload" as="font" type="font/woff2" crossorigin href="/fonts/extra.woff2">' +
          '<link rel="preload" as="font" crossorigin href="/fonts/gone.woff2">',
      ),
      "assets/main-abcdefgh.css": fontCss([
        ['"Small Sans"', 400, "/fonts/small-400.woff2"],
        ['"Small Sans"', 600, "/fonts/small-600.ttf", "truetype"],
        ["Missing", 400, "/fonts/missing-400.woff2"],
      ]),
      "fonts/small-400.woff2": woff2(10 * KB),
      "fonts/small-600.ttf": woff2(10 * KB),
      "fonts/extra.woff2": woff2(3 * KB),
    });

    const result = checkBudgets(dir);
    const font = result.rows.find((r) => r.kind === "font");

    expect(font?.notWoff2).toEqual(["fonts/small-600.ttf"]);
    expect(font?.files.map((f) => f.file)).toContain("fonts/extra.woff2");
    expect(font?.ok).toBe(false);
    expect(result.missing).toEqual([
      { page: "fonts.html", file: "fonts/missing-400.woff2" },
      { page: "fonts.html", file: "fonts/gone.woff2" },
    ]);
    const report = formatReport(result);
    expect(report).toContain("NOT WOFF2: fonts.html declares fonts that are not woff2: fonts/small-600.ttf");
    expect(report).toContain("MISSING: fonts.html references fonts/gone.woff2, which is not in the build");
  });

  it("[OFE-024] picks the face a browser picks for a weight (CSS Fonts 4 font matching)", () => {
    /** @param {string} family @param {[number, number]} weight */
    const face = (family, weight) => ({
      family,
      style: "normal",
      weight,
      url: "",
      format: "woff2",
      file: null,
    });
    const lato = [face("Lato", [400, 400]), face("Lato", [700, 700])];
    const inter = [face("Inter", [400, 400]), face("Inter", [600, 600])];
    const variable = [face("Variable", [100, 900])];

    expect(matchFace(lato, 500)?.weight).toEqual([400, 400]);
    expect(matchFace(lato, 600)?.weight).toEqual([700, 700]);
    expect(matchFace(inter, 900)?.weight).toEqual([600, 600]);
    expect(matchFace(inter, 300)?.weight).toEqual([400, 400]);
    expect(matchFace(variable, 600)?.weight).toEqual([100, 900]);
    expect(matchFace([], 400)).toBeUndefined();
  });
});
