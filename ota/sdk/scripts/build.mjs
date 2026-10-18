#!/usr/bin/env node
// build.mjs: builds @velexis/ota-sdk for its consumers (OADR-0016 point 7, ota/sdk/docs/types-and-builds.md §6,
// SDK-007): two bundles of src/index.js made by esbuild, then the declarations emitted by tsc.
//
// Usage (from ota/sdk; `pnpm --filter @velexis/ota-sdk build` runs it, then scripts/check-size.mjs):
//   node scripts/build.mjs                    # writes dist/
//   node scripts/build.mjs --outdir <dir>     # writes the same files into another folder (test/unit/bundle.test.js)
//
// It writes into the output folder:
//   velexis-sdk.mjs + .map       ESM: what the storefront (through Vite), the OTA admin and npm consumers import
//   velexis-sdk.iife.js + .map   IIFE that defines `window.Velexis`, for a plain <script> tag
//   types/*.d.ts + .d.ts.map     `tsc -p tsconfig.build.json`, one declaration per source module
//
// Both bundles are ES2022, minified, platform-neutral (the SDK runs in browsers, Node 22 and edge runtimes) and
// self-contained: the SDK has no runtime dependencies, and `@velexis/api-types` is used in JSDoc types only. Each
// has an external source map file, linked from its last line (`//# sourceMappingURL=`), so devtools find it.
// Minifying renames classes and functions; what callers read stays the same, because every error class sets its
// `name` field explicitly (`error.name === "ValidationError"`, also in `toJSON()`). An esbuild warning fails the
// build, as an error does, and a bundle is written only when esbuild reported neither.
// The previous outputs are removed first, so a deleted source module leaves no stale declaration behind; nothing
// else in the folder is touched.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { build as esbuild } from "esbuild";

const SDK_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The public entry: everything a consumer can import from `@velexis/ota-sdk`. */
export const ENTRY = path.join(SDK_DIR, "src", "index.js");
/** The tsc project of the declarations (rootDir src/, emitDeclarationOnly, declarationMap). */
export const DECLARATION_CONFIG = path.join(SDK_DIR, "tsconfig.build.json");
/** The default output folder; package.json `exports` points into it. */
export const DEFAULT_OUTDIR = path.join(SDK_DIR, "dist");

/** File names of the outputs inside the output folder. */
export const OUTPUTS = Object.freeze({
  esm: "velexis-sdk.mjs",
  iife: "velexis-sdk.iife.js",
  types: "types",
});
/** The global the IIFE defines (`window.Velexis.createVelexisClient(…)`). */
export const GLOBAL_NAME = "Velexis";

export class BuildError extends Error {}

/**
 * The esbuild options of one bundle. esbuild returns the files (`write: false`); buildBundles writes them once the
 * bundle has no warning.
 * @param {"esm" | "iife"} format
 * @param {string} outdir
 * @param {string} [entry] the module to bundle; src/index.js except in the tests of the build's strictness
 * @returns {import("esbuild").BuildOptions}
 */
export function bundleOptions(format, outdir, entry = ENTRY) {
  return {
    entryPoints: [entry],
    outfile: path.join(outdir, OUTPUTS[format]),
    bundle: true,
    format,
    ...(format === "iife" ? { globalName: GLOBAL_NAME } : {}),
    platform: "neutral",
    target: "es2022",
    minify: true,
    sourcemap: "linked",
    logLevel: "silent",
    write: false,
  };
}

const kb = (/** @type {number} */ bytes) => `${(bytes / 1024).toFixed(1)} KB`;

/**
 * Builds the ESM and IIFE bundles into `outdir`. A bundle with an esbuild error or warning throws a BuildError and
 * writes nothing.
 * @param {string} outdir
 * @param {string} [entry] the module to bundle (src/index.js)
 * @returns {Promise<Array<{ file: string, bytes: number }>>} the bundles written, with their minified sizes
 */
export async function buildBundles(outdir, entry = ENTRY) {
  const written = [];
  for (const format of /** @type {const} */ (["esm", "iife"])) {
    const options = bundleOptions(format, outdir, entry);
    let result;
    try {
      result = await esbuild(options);
    } catch (err) {
      // esbuild rejects with the failure's messages; it has already printed nothing (logLevel "silent").
      const errors = /** @type {{ errors?: import("esbuild").Message[] }} */ (err).errors ?? [];
      throw new BuildError(
        `esbuild failed on the ${format} bundle:\n${errors.map(formatMessage).join("\n") || String(err)}`,
      );
    }
    if (result.warnings.length > 0) {
      throw new BuildError(
        `esbuild warned on the ${format} bundle (a warning fails the build):\n` +
          result.warnings.map(formatMessage).join("\n"),
      );
    }
    // The bundle and its source map (the bundle's last line links the map by its file name).
    for (const output of result.outputFiles ?? []) {
      mkdirSync(path.dirname(output.path), { recursive: true });
      writeFileSync(output.path, output.contents);
    }
    const file = /** @type {string} */ (options.outfile);
    written.push({ file, bytes: statSync(file).size });
  }
  return written;
}

/** @param {import("esbuild").Message} message */
function formatMessage({ text, location }) {
  return location ? `  ${location.file}:${location.line}:${location.column}: ${text}` : `  ${text}`;
}

/**
 * Emits the declarations of src/ into `<outdir>/types` with `tsc -p tsconfig.build.json`.
 * @param {string} outdir
 * @returns {number} how many declaration files tsc wrote
 */
export function emitDeclarations(outdir) {
  const typesDir = path.join(outdir, OUTPUTS.types);
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const run = spawnSync(process.execPath, [tsc, "-p", DECLARATION_CONFIG, "--outDir", typesDir], {
    cwd: SDK_DIR,
    stdio: "inherit",
  });
  if (run.error) {
    throw new BuildError(`tsc could not run: ${run.error.message}`);
  }
  if (run.status !== 0) {
    throw new BuildError(`tsc -p tsconfig.build.json failed (exit ${run.status ?? run.signal})`);
  }
  return readdirSync(typesDir, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".d.ts"))
    .length;
}

/**
 * Removes the outputs of an earlier build from `outdir` (only the files this script writes).
 * @param {string} outdir
 */
function removeOutputs(outdir) {
  for (const name of [OUTPUTS.esm, OUTPUTS.iife]) {
    rmSync(path.join(outdir, name), { force: true });
    rmSync(path.join(outdir, `${name}.map`), { force: true });
  }
  rmSync(path.join(outdir, OUTPUTS.types), { recursive: true, force: true });
}

/**
 * The whole build: bundles, then declarations.
 * @param {string} [outdir]
 */
export async function build(outdir = DEFAULT_OUTDIR) {
  const dir = path.resolve(outdir);
  removeOutputs(dir);
  mkdirSync(dir, { recursive: true });
  const bundles = await buildBundles(dir);
  const declarations = emitDeclarations(dir);
  return { outdir: dir, bundles, declarations };
}

/** A path for messages: relative to the working folder when inside it. */
const shown = (/** @type {string} */ file) => {
  const relative = path.relative(process.cwd(), file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
};

const USAGE = "usage: node scripts/build.mjs [--outdir <dir>]";

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: { outdir: { type: "string" } }, strict: true }));
  } catch (err) {
    throw new BuildError(`${/** @type {Error} */ (err).message}\n${USAGE}`);
  }
  const result = await build(values.outdir ?? DEFAULT_OUTDIR);
  for (const { file, bytes } of result.bundles) {
    console.log(`ota-sdk build: wrote ${shown(file)} (${kb(bytes)} minified) and its source map`);
  }
  console.log(
    `ota-sdk build: wrote ${shown(path.join(result.outdir, OUTPUTS.types))}/ (${result.declarations} declarations)`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`ota-sdk build: ${err instanceof BuildError ? err.message : (err?.stack ?? err)}`);
    process.exitCode = 1;
  });
}
