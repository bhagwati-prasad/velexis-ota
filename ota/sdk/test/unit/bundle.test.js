// The SDK bundles (OADR-0016 point 7, ota/sdk/docs/types-and-builds.md §6 and §7, task SDK-007): scripts/build.mjs
// writes the ESM bundle, the IIFE (`window.Velexis`) and the declarations, scripts/check-size.mjs holds the ESM bundle
// to 25 KB min+gzip, and package.json exports them. These tests run both scripts the way `pnpm --filter
// @velexis/ota-sdk build` runs them, into a scratch copy of the package: they need no earlier build and never read a
// stale dist/ (CI runs `pnpm test` before `pnpm build`). Since SDK-013 they also prove that the bundle the size check
// measures holds every method of the route table, the console namespace included.
//
// - Node imports the ESM bundle natively, by the package name, in a child process: a fresh global environment whose
//   globals, built-in prototypes, `fetch` and timers are compared before and after the import.
// - The IIFE runs as a classic script in a happy-dom page, whose window, document, `fetch`, XHR, timers and event
//   listeners are compared before and after it loads.
// - Each check also runs on a module made to misbehave, so a check that reports nothing proves something.
import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { gzipSync } from "node:zlib";

import { Window } from "happy-dom";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GLOBAL_NAME, OUTPUTS, bundleOptions } from "../../scripts/build.mjs";
import { BUDGET_BYTES, KB, measure } from "../../scripts/check-size.mjs";
import * as source from "../../src/index.js";
import { op } from "../../src/internal/operations.js";

const SDK_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUILD = join(SDK_ROOT, "scripts", "build.mjs");
const CHECK_SIZE = join(SDK_ROOT, "scripts", "check-size.mjs");
const pkg = JSON.parse(readFileSync(join(SDK_ROOT, "package.json"), "utf8"));

/** `GET /v1/storefront` (getStorefront, 200), validated against the OpenAPI document by the namespace tests. */
const STOREFRONT = JSON.parse(readFileSync(join(SDK_ROOT, "test", "fixtures", "storefront.json"), "utf8"));
/** A fake key with the right shape; it works nowhere. */
const PK = "pk_test_sdk007_fake";
/** The page the IIFE is loaded into. */
const PAGE_URL = "https://www.acmetravel.example/";

/**
 * The build emits the declarations with tsc (a program over src/ and the generated schema types) and runs esbuild
 * twice, each in a child process; alone that takes a second or two, much longer while Turborepo runs every package's
 * tests at once on a CI runner. The hooks that run it get this budget instead of Vitest's default; the tests
 * themselves only read what the hooks wrote.
 */
const BUILD_TIMEOUT_MS = 180_000;
/** The build process itself is killed a little earlier, so a hanging build fails with its own output. */
const BUILD_CHILD_TIMEOUT_MS = 150_000;
/** Every other child process (the size check, an import probe) starts Node once; one that hangs is killed. */
const CHILD_TIMEOUT_MS = 60_000;
/** The probes and the size checks of one hook run in parallel; together they get this budget. */
const PROBES_TIMEOUT_MS = 120_000;

/**
 * Runs Node with `args` in a child process without blocking this worker; resolves with its exit status and output.
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
const node = (args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      {
        cwd: options.cwd ?? SDK_ROOT,
        encoding: "utf8",
        timeout: options.timeoutMs ?? CHILD_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
      },
    );
  });

const scratch = mkdtempSync(join(tmpdir(), "sdk-007-bundle-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * The package as a consumer installs it: package.json and src/ copied, dist/ written by the build, and a consumer
 * folder whose node_modules links `@velexis/ota-sdk` to it, so Node resolves the name through `exports`.
 */
const PACKAGE_DIR = join(scratch, "package");
const DIST = join(PACKAGE_DIR, "dist");
const CONSUMER_DIR = join(scratch, "consumer");

/** The files under `dir`, relative to it with `/` separators, sorted. */
const listFiles = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();

/**
 * What an earlier build left in the output folder: a declaration of a module that no longer exists, which the build
 * must remove, and a file the build does not write, which it must leave alone.
 */
const STALE_DECLARATION = `${OUTPUTS.types}/removed-module.d.ts`;
const UNRELATED_FILE = "notes.txt";

/** @type {{ status: number, stdout: string, stderr: string }} */
let build;

beforeAll(async () => {
  mkdirSync(PACKAGE_DIR, { recursive: true });
  cpSync(join(SDK_ROOT, "package.json"), join(PACKAGE_DIR, "package.json"));
  cpSync(join(SDK_ROOT, "src"), join(PACKAGE_DIR, "src"), { recursive: true });
  mkdirSync(join(CONSUMER_DIR, "node_modules", "@velexis"), { recursive: true });
  symlinkSync(PACKAGE_DIR, join(CONSUMER_DIR, "node_modules", "@velexis", "ota-sdk"), "dir");
  mkdirSync(join(DIST, OUTPUTS.types), { recursive: true });
  writeFileSync(join(DIST, STALE_DECLARATION), "export declare const removed: true;\n");
  writeFileSync(join(DIST, UNRELATED_FILE), "not written by the build\n");
  build = await node([BUILD, "--outdir", DIST], { timeoutMs: BUILD_CHILD_TIMEOUT_MS });
}, BUILD_TIMEOUT_MS);

// ---- Node import probe -------------------------------------------------------------------------------------------

/** Timer and task functions a module could schedule work with at import time. */
const NODE_TIMERS = ["setTimeout", "setInterval", "setImmediate", "queueMicrotask"];

/**
 * ES module code for `node --input-type=module -e`. Arguments: the specifier to import, then the JSON body that the
 * client's fetch answers with. It replaces `fetch` and the timer functions with counting wrappers, takes a snapshot of
 * the property descriptors of `globalThis` and the built-ins, imports the module natively, lets deferred work (a
 * microtask, an immediate, a timer) run, and compares. Then, for the SDK, it checks the error names after minifying
 * and makes one call through a client whose fetch answers locally. It prints one JSON report.
 */
const NODE_PROBE = `
const [specifier, answer] = process.argv.slice(1);
const calls = {};
const count = (name) => { calls[name] = (calls[name] ?? 0) + 1; };
const original = { setTimeout: globalThis.setTimeout, setImmediate: globalThis.setImmediate };
globalThis.fetch = () => { count("fetch"); return new Promise(() => {}); };
for (const name of ${JSON.stringify(NODE_TIMERS)}) {
  const fn = globalThis[name];
  globalThis[name] = function (...args) { count(name); return fn.apply(this, args); };
}
const TARGETS = {
  globalThis, Object, "Object.prototype": Object.prototype, "Function.prototype": Function.prototype,
  "Array.prototype": Array.prototype, "String.prototype": String.prototype, "Number.prototype": Number.prototype,
  Promise, "Promise.prototype": Promise.prototype, Error, "Error.prototype": Error.prototype, Symbol, JSON, Reflect,
  Math, "Headers.prototype": Headers.prototype, "Request.prototype": Request.prototype,
  "Response.prototype": Response.prototype, URL, "URL.prototype": URL.prototype,
  "URLSearchParams.prototype": URLSearchParams.prototype, "AbortController.prototype": AbortController.prototype,
  AbortSignal, "AbortSignal.prototype": AbortSignal.prototype,
};
const FIELDS = ["value", "get", "set", "writable", "enumerable", "configurable"];
const snapshot = () => Object.entries(TARGETS).map(([name, target]) => [
  name, new Map(Reflect.ownKeys(target).map((key) => [key, Object.getOwnPropertyDescriptor(target, key)])),
]);
const before = snapshot();
const ns = await import(specifier);
await new Promise((resolve) => original.setImmediate(resolve));
await new Promise((resolve) => original.setTimeout(resolve, 20));
const callsAtImport = { ...calls };
const after = new Map(snapshot());
const changed = [];
for (const [name, descriptors] of before) {
  const now = after.get(name);
  for (const key of new Set([...descriptors.keys(), ...now.keys()])) {
    const a = descriptors.get(key);
    const b = now.get(key);
    if (!a || !b || !FIELDS.every((field) => Object.is(a[field], b[field]))) {
      changed.push(name + "." + String(key));
    }
  }
}
const report = { calls: callsAtImport, changed, exports: Object.keys(ns).sort() };
if (typeof ns.createVelexisClient === "function") {
  report.resolved = import.meta.resolve(specifier);
  report.iife = import.meta.resolve(specifier + "/iife");
  // ESM only: CommonJS code loads the same module with Node 22's require() of an ES module.
  const { createRequire } = await import("node:module");
  const require = createRequire(process.cwd() + "/consumer.cjs");
  try {
    report.required = {
      resolved: require.resolve(specifier),
      same: require(specifier).createVelexisClient === ns.createVelexisClient,
    };
  } catch (error) {
    report.required = { error: error.code ?? error.message };
  }
  report.version = ns.VERSION;
  report.errorNames = Object.fromEntries(
    Object.entries(ns)
      .filter(([, value]) => typeof value === "function" && value.prototype instanceof Error)
      .map(([key, ErrorClass]) => [key, new ErrorClass({ code: "INTERNAL_ERROR", message: "probe", status: 500 }).name]),
  );
  const requests = [];
  const client = ns.createVelexisClient({
    publishableKey: ${JSON.stringify(PK)},
    fetch: async (url, init) => {
      requests.push({ url: String(url), method: init?.method ?? "GET", credentials: init?.credentials });
      return new Response(answer, { headers: { "content-type": "application/json" } });
    },
  });
  report.result = await client.storefront.get();
  report.requests = requests;
  // The dotted path of every method of the client's namespaces, as the parity test names them (SDK-013).
  const methodsOf = (object, prefix) =>
    Object.entries(object).flatMap(([name, value]) =>
      typeof value === "function"
        ? [prefix + name]
        : value !== null && typeof value === "object"
          ? methodsOf(value, prefix + name + ".")
          : [],
    );
  report.methods = Object.entries(client)
    .filter(([, value]) => value !== null && typeof value === "object")
    .flatMap(([name, value]) => methodsOf(value, name + "."))
    .sort();
}
process.stdout.write(JSON.stringify(report));
`;

/**
 * Imports `specifier` in a fresh Node process (from the consumer folder, so a package name resolves through its
 * `exports`) and returns the probe's report.
 * @param {string} specifier
 * @param {string[]} [nodeOptions] options for Node itself, such as `--conditions=development`
 */
async function probeImport(specifier, nodeOptions = []) {
  const run = await node(
    [...nodeOptions, "--input-type=module", "-e", NODE_PROBE, specifier, JSON.stringify(STOREFRONT)],
    { cwd: CONSUMER_DIR },
  );
  if (run.status !== 0) {
    throw new Error(`the import probe of ${specifier} exited ${run.status}:\n${run.stderr}`);
  }
  return JSON.parse(run.stdout);
}

// ---- IIFE page loader --------------------------------------------------------------------------------------------

/** Constructors that open a connection. */
const PAGE_NETWORK = ["XMLHttpRequest", "WebSocket", "EventSource"];
/** Ways to schedule work later. */
const PAGE_TIMERS = ["setTimeout", "setInterval", "setImmediate", "queueMicrotask", "requestAnimationFrame"];
const DESCRIPTOR_FIELDS = ["value", "get", "set", "writable", "enumerable", "configurable"];

/** @param {object} target */
const descriptorsOf = (target) =>
  new Map(Reflect.ownKeys(target).map((key) => [key, Object.getOwnPropertyDescriptor(target, key)]));

/** @type {Window[]} */
const pages = [];
afterAll(async () => {
  for (const window of pages) {
    await window.happyDOM.close();
  }
});

/**
 * Loads `code` into a new happy-dom page as a classic script and reports what loading it did.
 *
 * A browser runs a `<script>` as an ECMAScript Script, whose top-level `var` becomes a property of `window`, also in
 * a strict script (the IIFE starts with "use strict"). happy-dom runs a `<script>` element's text through an
 * indirect `eval` instead, where a strict script's `var` stays local, so the loader runs the code with
 * `vm.Script#runInContext` on the page's window, which happy-dom makes a VM context: the browser's semantics, in the
 * page's realm with its DOM, `fetch` and timers.
 *
 * The page's `fetch` answers `GET /api/v1/storefront` with the storefront fixture and records every request; the
 * connection constructors, timers and `addEventListener` (window and document) count their calls.
 * @param {string} code
 */
function loadInPage(code) {
  const window = new Window({ url: PAGE_URL });
  pages.push(window);
  const calls = {};
  const count = (name) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  /** @type {Array<{ url: string, method: string, credentials: unknown, mode: unknown }>} */
  const requests = [];
  window.fetch = async (url, init) => {
    count("fetch");
    requests.push({
      url: String(url),
      method: init?.method ?? "GET",
      credentials: init?.credentials,
      mode: init?.mode,
    });
    return new window.Response(JSON.stringify(STOREFRONT), {
      headers: { "content-type": "application/json" },
    });
  };
  for (const name of PAGE_NETWORK.filter((key) => typeof window[key] === "function")) {
    window[name] = function Connection() {
      count(name);
    };
  }
  for (const name of PAGE_TIMERS.filter((key) => typeof window[key] === "function")) {
    const fn = window[name];
    window[name] = (...args) => {
      count(name);
      return fn.apply(window, args);
    };
  }
  for (const [name, target] of [
    ["window.addEventListener", window],
    ["document.addEventListener", window.document],
  ]) {
    const fn = target.addEventListener;
    target.addEventListener = (...args) => {
      count(name);
      return fn.apply(target, args);
    };
  }

  const before = descriptorsOf(window);
  const html = window.document.documentElement.outerHTML;
  const cookie = window.document.cookie;
  new vm.Script(code, { filename: `${PAGE_URL}vendor/${OUTPUTS.iife}` }).runInContext(window);
  const callsAtLoad = { ...calls };
  const after = descriptorsOf(window);

  const changed = [...before.keys()].filter(
    (key) =>
      after.has(key) &&
      !DESCRIPTOR_FIELDS.every((field) => Object.is(before.get(key)?.[field], after.get(key)?.[field])),
  );
  return {
    window,
    requests,
    calls: callsAtLoad,
    added: [...after.keys()].filter((key) => !before.has(key)).map(String),
    removed: [...before.keys()].filter((key) => !after.has(key)).map(String),
    changed: changed.map(String),
    domChanged: window.document.documentElement.outerHTML !== html || window.document.cookie !== cookie,
  };
}

/**
 * Runs `code` as a script of the page (the page's own JavaScript, in its realm) and returns its completion value.
 * @param {Window} window
 * @param {string} code
 */
const runInPage = (window, code) =>
  new vm.Script(code, { filename: `${PAGE_URL}page.js` }).runInContext(window);

// ---- Tests -------------------------------------------------------------------------------------------------------

describe("package.json", () => {
  it("builds with build.mjs, then checks the size with check-size.mjs [SDK-007 AC1]", () => {
    expect(pkg.scripts.build).toBe("node scripts/build.mjs && node scripts/check-size.mjs");
  });

  it("exports the declarations, the source for development and the ESM bundle on '.' [SDK-007 AC1]", () => {
    expect(pkg.exports["."]).toEqual({
      types: `./dist/${OUTPUTS.types}/index.d.ts`,
      development: "./src/index.js",
      import: `./dist/${OUTPUTS.esm}`,
      default: `./dist/${OUTPUTS.esm}`,
    });
    // Conditions match in object order: `types` first for TypeScript, `development` before `import` for Vite's dev
    // server, and `default` last, for require() (Node 22 loads the ES module; there is no CommonJS build).
    expect(Object.keys(pkg.exports["."])).toEqual(["types", "development", "import", "default"]);
  });

  it("exports the IIFE on './iife' and nothing but package.json besides [SDK-007 AC1]", () => {
    expect(pkg.exports["./iife"]).toBe(`./dist/${OUTPUTS.iife}`);
    expect(Object.keys(pkg.exports)).toEqual([".", "./iife", "./package.json"]);
  });

  it("publishes only dist, src, README.md and CHANGELOG.md, and has no side effects [SDK-007 AC1]", () => {
    expect(pkg.files).toEqual(["dist", "src", "README.md", "CHANGELOG.md"]);
    expect(pkg.sideEffects).toBe(false);
  });
});

describe("scripts/build.mjs", () => {
  /** A run with an option the script does not know. */
  let refused;
  /** buildBundles on an entry that esbuild warns about, and on one it cannot bundle; each into an empty folder. */
  let strict;

  /**
   * ES module code for `node --input-type=module -e`. Arguments: the URL of build.mjs, an output folder and an entry
   * module. It runs buildBundles on that entry and prints whether it built, and the BuildError's message.
   */
  const BUNDLE_PROBE = `
const [buildModule, outdir, entry] = process.argv.slice(1);
const { buildBundles, BuildError } = await import(buildModule);
try {
  await buildBundles(outdir, entry);
  process.stdout.write(JSON.stringify({ built: true }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({ built: false, buildError: error instanceof BuildError, message: String(error.message) }),
  );
}
`;

  /** Runs BUNDLE_PROBE on a one-file entry `code` and returns its report and the folder it was given. */
  const bundleProbe = async (name, code) => {
    const entry = join(scratch, "entries", `${name}.js`);
    const outdir = join(scratch, `out-${name}`);
    mkdirSync(join(scratch, "entries"), { recursive: true });
    mkdirSync(outdir, { recursive: true });
    writeFileSync(entry, code);
    const run = await node([
      "--input-type=module",
      "-e",
      BUNDLE_PROBE,
      pathToFileURL(BUILD).href,
      outdir,
      entry,
    ]);
    if (run.status !== 0) {
      throw new Error(`the bundle probe of ${name} exited ${run.status}:\n${run.stderr}`);
    }
    return { ...JSON.parse(run.stdout), outdir };
  };

  beforeAll(async () => {
    const [unknownOption, warned, broken] = await Promise.all([
      node([BUILD, "--out", join(scratch, "elsewhere")]),
      bundleProbe("warned", "export const duplicate = { key: 1, key: 2 };\n"),
      bundleProbe("broken", 'import { missing } from "./does-not-exist.js";\nexport default missing;\n'),
    ]);
    refused = unknownOption;
    strict = { warned, broken };
  }, PROBES_TIMEOUT_MS);

  it("bundles ES2022, minified, platform-neutral, with linked external source maps [SDK-007 AC1]", () => {
    for (const format of /** @type {const} */ (["esm", "iife"])) {
      expect(bundleOptions(format, DIST), format).toMatchObject({
        entryPoints: [join(SDK_ROOT, "src", "index.js")],
        outfile: join(DIST, OUTPUTS[format]),
        bundle: true,
        format,
        platform: "neutral",
        target: "es2022",
        minify: true,
        sourcemap: "linked",
      });
    }
    expect(bundleOptions("iife", DIST).globalName).toBe(GLOBAL_NAME);
    expect(GLOBAL_NAME).toBe("Velexis");
    expect(bundleOptions("esm", DIST)).not.toHaveProperty("globalName");
  });

  it("writes both bundles with their source maps and the declarations [SDK-007 AC1]", () => {
    expect(build.stderr).toBe("");
    expect(build.status).toBe(0);
    const files = listFiles(DIST);
    // Nothing else beside the bundles and their maps: the declarations stay in types/.
    expect(files.filter((file) => !file.startsWith(`${OUTPUTS.types}/`) && file !== UNRELATED_FILE)).toEqual(
      [OUTPUTS.esm, `${OUTPUTS.esm}.map`, OUTPUTS.iife, `${OUTPUTS.iife}.map`].sort(),
    );
    expect(build.stdout).toContain(`wrote ${DIST}/${OUTPUTS.esm}`);
    expect(build.stdout).toContain(`wrote ${DIST}/${OUTPUTS.iife}`);
  });

  it("removes the outputs of an earlier build first and leaves every other file alone [SDK-007 AC1]", () => {
    expect(existsSync(join(DIST, STALE_DECLARATION))).toBe(false);
    expect(readFileSync(join(DIST, UNRELATED_FILE), "utf8")).toBe("not written by the build\n");
  });

  it("emits one declaration and its map per source module, index.d.ts being the types entry [SDK-007 AC1]", () => {
    const declarations = listFiles(join(DIST, OUTPUTS.types));
    const modules = listFiles(join(SDK_ROOT, "src")).filter((file) => file.endsWith(".js"));
    expect(declarations.filter((file) => file.endsWith(".d.ts"))).toEqual(
      modules.map((file) => file.replace(/\.js$/, ".d.ts")),
    );
    expect(declarations.filter((file) => file.endsWith(".d.ts.map"))).toEqual(
      modules.map((file) => file.replace(/\.js$/, ".d.ts.map")),
    );
    expect(readFileSync(join(DIST, OUTPUTS.types, "index.d.ts"), "utf8")).toMatch(
      /export function createVelexisClient\(options: VelexisClientOptions\): VelexisClient;/,
    );
  });

  it("minifies each bundle and links its source map from the last line [SDK-007 AC1]", () => {
    for (const name of [OUTPUTS.esm, OUTPUTS.iife]) {
      const code = readFileSync(join(DIST, name), "utf8");
      // No JSDoc, no comments: what is left is code and the source map link.
      expect(code, name).not.toContain("/**");
      expect(code, name).not.toContain("@param");
      expect(code.trimEnd().split("\n").at(-1), name).toBe(`//# sourceMappingURL=${name}.map`);
      const map = JSON.parse(readFileSync(join(DIST, `${name}.map`), "utf8"));
      expect(map.version, name).toBe(3);
      expect(map.sourcesContent, name).toHaveLength(map.sources.length);
    }
    expect(readFileSync(join(DIST, OUTPUTS.iife), "utf8")).toMatch(/^"use strict";var Velexis=\(\(\)=>\{/);
  });

  it("bundles only the SDK's own modules: no import, no require, every source in src/ [SDK-007 AC1]", () => {
    for (const name of [OUTPUTS.esm, OUTPUTS.iife]) {
      // The TypeScript scanner finds import and export-from declarations, import() and require() calls, and skips
      // strings and comments.
      const code = readFileSync(join(DIST, name), "utf8");
      expect(ts.preProcessFile(code, true, true).importedFiles, name).toEqual([]);
      const { sources } = JSON.parse(readFileSync(join(DIST, `${name}.map`), "utf8"));
      const files = sources.map((file) => relative(SDK_ROOT, join(DIST, file)).split(sep).join("/"));
      expect(files, name).toContain("src/index.js");
      expect(
        files.filter((file) => !/^src\/[\w/-]+\.js$/.test(file)),
        name,
      ).toEqual([]);
    }
  });

  it("refuses an unknown option without building [SDK-007 AC1]", () => {
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("usage: node scripts/build.mjs [--outdir <dir>]");
    expect(existsSync(join(scratch, "elsewhere"))).toBe(false);
  });

  it("fails on an esbuild warning as on an error, and then writes no bundle [SDK-007 AC1]", () => {
    expect(strict.warned).toMatchObject({ built: false, buildError: true });
    expect(strict.warned.message).toContain("esbuild warned on the esm bundle (a warning fails the build):");
    expect(strict.warned.message).toContain('Duplicate key "key" in object literal');
    expect(listFiles(strict.warned.outdir)).toEqual([]);

    expect(strict.broken).toMatchObject({ built: false, buildError: true });
    expect(strict.broken.message).toContain("esbuild failed on the esm bundle:");
    expect(strict.broken.message).toContain('Could not resolve "./does-not-exist.js"');
    expect(listFiles(strict.broken.outdir)).toEqual([]);
  });
});

describe("scripts/check-size.mjs", () => {
  /**
   * A deterministic, incompressible text of printable characters (xorshift32): gzip cannot shrink it below about
   * 4/5 of its length, so 40 KB of it is well above the budget.
   */
  const noise = (length) => {
    let state = 0x9e3779b9;
    let text = "";
    while (text.length < length) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      text += String.fromCharCode(33 + (state % 94));
    }
    return text;
  };

  /** Size checks of the build, of an oversized bundle and of a folder without bundles. */
  let checks;

  beforeAll(async () => {
    const oversized = join(scratch, "oversized");
    mkdirSync(oversized, { recursive: true });
    writeFileSync(join(oversized, OUTPUTS.esm), noise(40 * KB));
    writeFileSync(join(oversized, OUTPUTS.iife), "var Velexis={};");
    const [built, over, missing] = await Promise.all([
      node([CHECK_SIZE, "--dir", DIST]),
      node([CHECK_SIZE, "--dir", oversized]),
      node([CHECK_SIZE, "--dir", join(scratch, "no-build")]),
    ]);
    checks = { built, over, missing, oversized };
  }, PROBES_TIMEOUT_MS);

  it("has a budget of 25 KB min+gzip [SDK-007 AC1]", () => {
    expect(BUDGET_BYTES).toBe(25 * 1024);
  });

  it("passes the build and prints the ESM bundle's size, min+gzip [SDK-007 AC1]", () => {
    const esm = readFileSync(join(DIST, OUTPUTS.esm));
    const gzip = gzipSync(esm, { level: 9 }).length;
    expect(gzip).toBeLessThanOrEqual(BUDGET_BYTES);
    expect(checks.built.status).toBe(0);
    expect(checks.built.stdout).toContain(
      `check-size: ESM ${join(DIST, OUTPUTS.esm)}: ${(esm.length / 1024).toFixed(1)} KB minified, ` +
        `${(gzip / 1024).toFixed(1)} KB (${gzip} B) min+gzip, budget 25.0 KB (25600 B): ok`,
    );
    expect(checks.built.stdout).toMatch(
      new RegExp(`check-size: IIFE .*${OUTPUTS.iife}: .* min\\+gzip, no budget`),
    );
  });

  it("fails when the ESM bundle exceeds 25 KB min+gzip, printing its size [SDK-007 AC1]", () => {
    const gzip = gzipSync(readFileSync(join(checks.oversized, OUTPUTS.esm)), { level: 9 }).length;
    expect(gzip).toBeGreaterThan(BUDGET_BYTES);
    expect(checks.over.status).toBe(1);
    expect(checks.over.stderr).toContain(`(${gzip} B) min+gzip, budget 25.0 KB (25600 B): OVER`);
    expect(checks.over.stderr).toContain(
      `OVER BUDGET: ${join(checks.oversized, OUTPUTS.esm)} is ${(gzip / 1024).toFixed(1)} KB (${gzip} B) min+gzip`,
    );
  });

  it("fails when there is no bundle to measure [SDK-007 AC1]", () => {
    expect(checks.missing.status).toBe(1);
    expect(checks.missing.stderr).toContain(
      `MISSING: ${join(scratch, "no-build", OUTPUTS.esm)} does not exist`,
    );
    expect(checks.missing.stderr).toContain(
      `MISSING: ${join(scratch, "no-build", OUTPUTS.iife)} does not exist`,
    );
  });
});

describe("the ESM bundle in Node", () => {
  /** Reports of the import probe: the package by name, its development condition, and a module with side effects. */
  let probes;

  beforeAll(async () => {
    const noisy = join(scratch, "noisy.mjs");
    writeFileSync(
      noisy,
      [
        "globalThis.leaked = true;",
        "Array.prototype.leakedToo = true;",
        'fetch("https://api.ota.example.com/v1/storefront");',
        "setTimeout(() => {}, 0);",
        "export const ready = true;",
      ].join("\n"),
    );
    const [bundle, development, misbehaving] = await Promise.all([
      probeImport("@velexis/ota-sdk"),
      probeImport("@velexis/ota-sdk", ["--conditions=development"]),
      probeImport(pathToFileURL(noisy).href),
    ]);
    probes = { bundle, development, misbehaving };
  }, PROBES_TIMEOUT_MS);

  it("is what Node imports for @velexis/ota-sdk, and the source is what the development condition gives [SDK-007 AC1]", () => {
    // Node resolves the package's real path, as it does for a workspace link.
    const installed = realpathSync(PACKAGE_DIR);
    expect(fileURLToPath(probes.bundle.resolved)).toBe(join(installed, "dist", OUTPUTS.esm));
    expect(fileURLToPath(probes.development.resolved)).toBe(join(installed, "src", "index.js"));
    expect(fileURLToPath(probes.bundle.iife)).toBe(join(installed, "dist", OUTPUTS.iife));
  });

  it("is also what require() loads, the same module, as there is no CommonJS build [SDK-007 AC1]", () => {
    const installed = realpathSync(PACKAGE_DIR);
    expect(probes.bundle.required).toEqual({ resolved: join(installed, "dist", OUTPUTS.esm), same: true });
    expect(probes.development.required).toEqual({ resolved: join(installed, "src", "index.js"), same: true });
  });

  it("exports exactly what src/index.js exports, with the package's VERSION [SDK-007 AC1]", () => {
    expect(probes.bundle.exports).toEqual(Object.keys(source).sort());
    expect(probes.bundle.version).toBe(pkg.version);
  });

  it("performs no fetch and schedules no work when imported [SDK-007 AC2]", () => {
    expect(probes.bundle.calls).toEqual({});
    expect(probes.development.calls).toEqual({});
  });

  it("touches no global and no built-in prototype when imported [SDK-007 AC2]", () => {
    expect(probes.bundle.changed).toEqual([]);
    expect(probes.development.changed).toEqual([]);
  });

  it("is checked by a probe that catches a module that fetches, schedules or writes a global [SDK-007 AC2]", () => {
    expect(probes.misbehaving.calls).toEqual({ fetch: 1, setTimeout: 1 });
    expect(probes.misbehaving.changed).toEqual(["globalThis.leaked", "Array.prototype.leakedToo"]);
  });

  it("keeps every error's name after minifying [SDK-007 AC1]", () => {
    const names = Object.fromEntries(
      Object.entries(source)
        .filter(([, value]) => typeof value === "function" && value.prototype instanceof Error)
        .map(([key, ErrorClass]) => [
          key,
          new ErrorClass({ code: "INTERNAL_ERROR", message: "probe", status: 500 }).name,
        ]),
    );
    expect(Object.keys(names)).toContain("PriceChangedError");
    expect(probes.bundle.errorNames).toEqual(names);
  });

  it("makes a working client: one storefront.get through the given fetch [SDK-007 AC1]", () => {
    expect(probes.bundle.result).toEqual(STOREFRONT);
    expect(probes.bundle.requests).toEqual([
      { url: "https://api.ota.example.com/v1/storefront", method: "GET", credentials: "omit" },
    ]);
  });

  it("holds every method of the route table, console included, within the 25 KB budget [SDK-013 AC2]", () => {
    // The ESM bundle that check-size.mjs measures is the whole client at the M4 exit: one method per entry of the
    // route table, which has one per `x-sdk-method` of the document (parity.test.js proves the client has the same
    // 128), so the console namespace stays in the one entry and there is no `@velexis/ota-sdk/console` (OADR-0016
    // Follow-ups). The route table's keys are the method names with dots replaced by underscores.
    const routes = Object.keys(op)
      .map((key) => key.replaceAll("_", "."))
      .sort();
    expect(routes).toEqual(
      expect.arrayContaining(["flights.search", "console.settings.assets.upload", "console.payments.refund"]),
    );
    expect(probes.bundle.methods).toEqual(routes);
    expect(probes.development.methods).toEqual(routes);
    const [esm] = measure(DIST);
    expect(esm).toMatchObject({ kind: "ESM", missing: false, limit: BUDGET_BYTES, ok: true });
    expect(esm.gzip).toBeLessThanOrEqual(BUDGET_BYTES);
  });
});

describe("the IIFE in a happy-dom page", () => {
  /** The real IIFE and one made to misbehave, each loaded into its own page. */
  let iife;
  let misbehaving;

  // Each page is a new happy-dom window (a VM context with the whole DOM API); the hook gets the probes' budget.
  beforeAll(() => {
    iife = loadInPage(readFileSync(join(DIST, OUTPUTS.iife), "utf8"));
    misbehaving = loadInPage(
      [
        '"use strict";',
        "var Velexis = {};",
        "window.leaked = true;",
        'fetch("/api/v1/storefront");',
        "setTimeout(function () {}, 0);",
        "new XMLHttpRequest();",
        'addEventListener("load", function () {});',
        'document.title = "changed";',
      ].join("\n"),
    );
  }, PROBES_TIMEOUT_MS);

  it("defines window.Velexis.createVelexisClient [SDK-007 AC1]", () => {
    const { window } = iife;
    expect(typeof window.Velexis.createVelexisClient).toBe("function");
    expect(Object.keys(window.Velexis).sort()).toEqual(Object.keys(source).sort());
    expect(window.Velexis.VERSION).toBe(pkg.version);
  });

  it("adds window.Velexis and changes nothing else on the page [SDK-007 AC2]", () => {
    expect(iife.added).toEqual(["Velexis"]);
    expect(iife.removed).toEqual([]);
    expect(iife.changed).toEqual([]);
    expect(iife.domChanged).toBe(false);
  });

  it("performs no fetch, opens no connection, schedules nothing and listens to nothing while it loads [SDK-007 AC2]", () => {
    expect(iife.calls).toEqual({});
    expect(iife.requests).toEqual([]);
  });

  it("is checked by a loader that catches a script that fetches, connects, schedules, listens or writes [SDK-007 AC2]", () => {
    expect(misbehaving.added.sort()).toEqual(["Velexis", "leaked"]);
    expect(misbehaving.calls).toEqual({
      fetch: 1,
      setTimeout: 1,
      XMLHttpRequest: 1,
      "window.addEventListener": 1,
    });
    expect(misbehaving.domChanged).toBe(true);
  });

  it("works in the page: a cookie-mode client calls the page's fetch, same-origin [SDK-007 AC1]", async () => {
    const { window, requests } = iife;
    const result = await runInPage(
      window,
      'Velexis.createVelexisClient({ session: "cookie" }).storefront.get()',
    );
    expect(result).toEqual(STOREFRONT);
    expect(requests).toEqual([
      { url: "/api/v1/storefront", method: "GET", credentials: "same-origin", mode: "same-origin" },
    ]);
  });
});
