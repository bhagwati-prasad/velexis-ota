// @vitest-environment node
// The storefront never writes data as HTML (conventions §4, ota/frontend/README.md §5.2 and §10): the root ESLint
// config runs `no-unsanitized` on every JavaScript file of ota/frontend, so `el.innerHTML = data` (and the other HTML
// sinks) fails lint in pages, components, lib modules and tests alike, while textContent and constant markup pass.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

import { REPO_ROOT, STOREFRONT_ROOT } from "./helpers/storefront.js";

const RULES = ["no-unsanitized/property", "no-unsanitized/method"];
/**
 * A directive comment that turns the plugin off: a disable comment for every rule or naming the plugin, or a rule
 * configuration comment naming it. Built from parts, so this file does not match itself.
 */
const DISABLE_COMMENT = new RegExp(
  String.raw`(?://|/\*)\s*${"eslint"}(?:-disable(?:-next-line|-line)?(?:\s*(?:\*/|$)|\s[^\n]*no-unsanitized)|\s[^\n]*no-unsanitized)`,
  "m",
);
/** Folders of ota/frontend that hold no storefront code of its own. */
const SKIPPED_FOLDERS = new Set(["node_modules", "dist", "coverage"]);

/** A storefront test file that writes text from the address bar as HTML. */
const TEST_FILE_WITH_DATA = [
  'import { it } from "vitest";',
  "",
  'it("renders the text from the address bar", () => {',
  '  const el = document.createElement("div");',
  "  const data = decodeURIComponent(location.hash.slice(1));",
  "  el.innerHTML = data;",
  "});",
  "",
].join("\n");
/** The same file with a constant string: the plugin traces variables, and a constant is not data. */
const TEST_FILE_WITH_CONSTANT = TEST_FILE_WITH_DATA.replace(
  "decodeURIComponent(location.hash.slice(1))",
  '"<p>Loading</p>"',
);
/** Each HTML sink with data, and the rule that reports it. */
const SINKS = [
  ["el.innerHTML = data;", "no-unsanitized/property"],
  ["el.innerHTML += data;", "no-unsanitized/property"],
  ["el.outerHTML = `<p>${data}</p>`;", "no-unsanitized/property"],
  ["frame.srcdoc = data;", "no-unsanitized/property"],
  ['el.insertAdjacentHTML("beforeend", data);', "no-unsanitized/method"],
  ["document.write(data);", "no-unsanitized/method"],
  ["range.createContextualFragment(data);", "no-unsanitized/method"],
  ["el.setHTMLUnsafe(data);", "no-unsanitized/method"],
  ["Document.parseHTMLUnsafe(data);", "no-unsanitized/method"],
  ['new DOMParser().parseFromString(data, "text/html");', "no-unsanitized/method"],
];
const SINK_FILES = ["src/pages/probe.js", "src/components/probe.js", "src/lib/probe.js"];
/** Text, attributes and constant markup. */
const SAFE_CODE = [
  "export function render(el, data) {",
  "  el.textContent = data;",
  '  el.setAttribute("title", data);',
  '  el.innerHTML = "";',
  "  el.innerHTML = `<p>Loading</p>`;",
  "}",
  "",
].join("\n");

/** Every .js file below `dir`. */
const jsFiles = (/** @type {string} */ dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => join(entry.parentPath, entry.name));

/** Every .js file of ota/frontend: sources, tests, scripts and configuration, without dependencies or build output. */
const storefrontJsFiles = () =>
  readdirSync(STOREFRONT_ROOT, { withFileTypes: true }).flatMap((entry) => {
    const path = join(STOREFRONT_ROOT, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_FOLDERS.has(entry.name) ? [] : jsFiles(path);
    }
    return entry.isFile() && entry.name.endsWith(".js") ? [path] : [];
  });

const eslint = new ESLint({ cwd: REPO_ROOT });

/**
 * The no-unsanitized errors ESLint reports for `code` linted as the storefront file `file`.
 * @param {string} code
 * @param {string} file path relative to ota/frontend
 */
async function unsanitizedErrors(code, file) {
  const [result] = await eslint.lintText(code, { filePath: join(STOREFRONT_ROOT, file) });
  return (result?.messages ?? [])
    .filter((message) => message.severity === 2 && RULES.includes(message.ruleId ?? ""))
    .map((message) => message.ruleId);
}

describe("no-unsanitized in the storefront", () => {
  const lint = {
    /** @type {Array<string | null>} */ withData: [],
    /** @type {Array<string | null>} */ withConstant: [],
    /** @type {Map<string, Array<string | null>>} */ sinks: new Map(),
    /** @type {Array<string | null>} */ safe: [],
    /** @type {string[]} the storefront's .js files, relative to ota/frontend */ files: [],
    /** @type {Array<[string, unknown]>} each file and rule with the rule's level */ levels: [],
    /** @type {string[]} files with a comment that turns the plugin off */ offenders: [],
  };

  // Every ESLint run and the scan of the storefront's files happen here, once, with their own timeout: loading the
  // root config with every plugin and parser takes about 1 s alone (several times that under a full parallel
  // `pnpm test`), and about 40 lint and config runs follow. The tests below only compare the results.
  beforeAll(async () => {
    lint.withData = await unsanitizedErrors(TEST_FILE_WITH_DATA, "test/probe.test.js");
    lint.withConstant = await unsanitizedErrors(TEST_FILE_WITH_CONSTANT, "test/probe.test.js");
    for (const file of SINK_FILES) {
      for (const [statement] of SINKS) {
        const code = `export function render(el, frame, range, data) {\n  ${statement}\n}\n`;
        lint.sinks.set(`${file}: ${statement}`, await unsanitizedErrors(code, /** @type {string} */ (file)));
      }
    }
    lint.safe = await unsanitizedErrors(SAFE_CODE, "src/lib/probe.js");
    const files = storefrontJsFiles();
    lint.files = files.map((file) => relative(STOREFRONT_ROOT, file));
    for (const file of files) {
      const config = /** @type {{ rules: Record<string, unknown> }} */ (
        await eslint.calculateConfigForFile(file)
      );
      for (const rule of RULES) {
        const setting = config.rules[rule];
        lint.levels.push([
          `${relative(STOREFRONT_ROOT, file)}: ${rule}`,
          Array.isArray(setting) ? setting[0] : setting,
        ]);
      }
    }
    lint.offenders = files
      .filter((file) => DISABLE_COMMENT.test(readFileSync(file, "utf8")))
      .map((file) => relative(STOREFRONT_ROOT, file));
  }, 60_000);

  it("[OFE-002 AC2] a test file using el.innerHTML = data fails lint", () => {
    expect(lint.withData).toEqual(["no-unsanitized/property"]);
    expect(lint.withConstant).toEqual([]);
  });

  it("[OFE-002 AC2] fails pages, components and lib modules that write data as HTML", () => {
    for (const file of SINK_FILES) {
      for (const [statement, rule] of SINKS) {
        const key = `${file}: ${statement}`;
        expect(lint.sinks.get(key), key).toEqual([rule]);
      }
    }
  });

  it("[OFE-002 AC2] lets text and constant markup through", () => {
    expect(lint.safe).toEqual([]);
  });

  it("[OFE-002 AC2] has both rules on at error level for the storefront's files, and no file turns them off", () => {
    expect(lint.files).toEqual(
      expect.arrayContaining(["src/lib/dom.js", "src/lib/forms.js", "test/lint.test.js", "vite.config.js"]),
    );
    expect(lint.levels).toHaveLength(lint.files.length * RULES.length);
    for (const [where, level] of lint.levels) {
      expect([2, "error"], where).toContain(level);
    }
    expect(lint.offenders).toEqual([]);
    // The scan recognises every way of turning the plugin off, and nothing else.
    for (const comment of [
      `// ${"eslint"}-disable-next-line no-unsanitized/property`,
      `el.innerHTML = data; // ${"eslint"}-disable-line no-unsanitized/property`,
      `/* ${"eslint"}-disable no-console, no-unsanitized/method */`,
      `/* ${"eslint"}-disable */`,
      `// ${"eslint"}-disable-next-line`,
      `/* ${"eslint"} no-unsanitized/property: "off" */`,
    ]) {
      expect(DISABLE_COMMENT.test(comment), comment).toBe(true);
    }
    for (const comment of [
      `// ${"eslint"}-disable-next-line no-console`,
      `/* ${"eslint"}-env browser */`,
      "// The root ESLint config runs no-unsanitized on every file.",
    ]) {
      expect(DISABLE_COMMENT.test(comment), comment).toBe(false);
    }
  });
});
