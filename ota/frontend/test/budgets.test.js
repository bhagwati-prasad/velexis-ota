// @vitest-environment node
// The gzip size budgets of scripts/check-budgets.mjs (ota/frontend/README.md §9, OADR-0015 point 12), on fixture
// build folders written to a scratch directory.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { BUDGETS, KB, checkBudgets, formatReport, passes } from "../scripts/check-budgets.mjs";
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
function fixture(/** @type {Record<string, string>} */ files) {
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

const withinBudget = () => ({
  "index.html": page(script("/assets/index-abcdefgh.js") + stylesheet("/assets/main-abcdefgh.css")),
  "404.html": page(stylesheet("/assets/main-abcdefgh.css")),
  "assets/index-abcdefgh.js": 'import"./shared-abcdefgh.js";document.title="ok";',
  "assets/shared-abcdefgh.js": "export const shared = 1;",
  "assets/main-abcdefgh.css": "body{margin:0}",
});

describe("check-budgets", () => {
  it("[OFE-001 AC3] a JS budget breach on the fixture folder exits 1 and names the file", () => {
    const dir = fixture({
      ...withinBudget(),
      "search.html": page(script("/assets/search-abcdefgh.js")),
      "assets/search-abcdefgh.js": `export const blob = "${incompressible(BUDGETS.js)}";`,
    });

    const run = runScript(dir);

    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/OVER BUDGET: search\.html JS .* > 60\.0 KB: assets\/search-abcdefgh\.js/);
    expect(run.stdout).toMatch(/^search\.html\s+JS\s+\S+ KB\s+60\.0 KB\s+OVER$/m);
    expect(run.stdout).toMatch(/^index\.html\s+JS\s+\S+ KB\s+60\.0 KB\s+ok$/m);
  });

  it("[OFE-001 AC3] exits 0 with the table when every page is within budget", () => {
    const run = runScript(fixture(withinBudget()));

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

    const empty = runScript(fixture({ "assets/a-abcdefgh.js": "" }));
    expect(empty.status).toBe(1);
    expect(empty.stdout).toContain("NO PAGES");
  });
});
