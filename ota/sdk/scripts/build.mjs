#!/usr/bin/env node
// build.mjs: builds @velexis/ota-sdk for its consumers (OADR-0016 point 7, ota/sdk/docs/types-and-builds.md §6,
// SDK-007): two bundles of src/index.js made by esbuild, then the declarations emitted by tsc, made self-contained.
//
// Usage (from ota/sdk; `pnpm --filter @velexis/ota-sdk build` runs it, then scripts/check-size.mjs):
//   node scripts/build.mjs                    # writes dist/
//   node scripts/build.mjs --outdir <dir>     # writes the same files into another folder (test/unit/bundle.test.js)
//
// It writes into the output folder:
//   velexis-sdk.mjs + .map       ESM: what the storefront (through Vite), the OTA admin and npm consumers import
//   velexis-sdk.iife.js + .map   IIFE that defines `window.Velexis`, for a plain <script> tag
//   types/*.d.ts + .d.ts.map     `tsc -p tsconfig.build.json`, one declaration per source module
//   types/api-types.d.ts         the OTA part of `@velexis/api-types`, copied (below)
//
// Both bundles are ES2022, minified, platform-neutral (the SDK runs in browsers, the supported Node versions (README)
// and edge runtimes) and self-contained: the SDK has no runtime dependencies, and `@velexis/api-types` is used in
// JSDoc types only. Each has an external source map file, linked from its last line (`//# sourceMappingURL=`), so
// devtools find it.
// The declarations are self-contained too (OADR-0016 point 7, SDK-015): the build copies the OTA part of
// `@velexis/api-types` (the one declaration file that the package's types entry re-exports) into
// types/api-types.d.ts and rewrites every `"@velexis/api-types"` module specifier of the emitted declarations to the
// copy's relative path (`"./api-types.js"`, `"../api-types.js"` one folder down), moving the columns of their
// declaration maps by as much. So the package that `npm pack` makes needs no dependency, not even for its types
// (test/unit/pack.test.js). Monorepo consumers get the same copy; its types are the generated package's, so they stay
// compatible with code that imports `@velexis/api-types` itself.
// Minifying renames classes and functions; what callers read stays the same, because every error class sets its
// `name` field explicitly (`error.name === "ValidationError"`, also in `toJSON()`). An esbuild warning fails the
// build, as an error does, and a bundle is written only when esbuild reported neither.
// The previous outputs are removed first, so a deleted source module leaves no stale declaration behind; nothing
// else in the folder is touched.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** The workspace package of the generated OTA API types that the SDK's JSDoc types import (OADR-0016 point 3). */
export const API_TYPES_PACKAGE = "@velexis/api-types";
/** The copy of its OTA part in the types folder, which the declarations import instead of the package. */
export const API_TYPES_FILE = "api-types.d.ts";

export class BuildError extends Error {}

const requireFromSdk = createRequire(import.meta.url);

/**
 * The TypeScript compiler API, loaded on first use: scripts/check-size.mjs imports this module and needs none of it.
 * @returns {typeof import("typescript")}
 */
const typescript = () => requireFromSdk("typescript");

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
  const tsc = requireFromSdk.resolve("typescript/bin/tsc");
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
  return declarationFiles(typesDir).length;
}

/**
 * The declaration files under `typesDir`, relative to it with `/` separators.
 * @param {string} typesDir
 */
const declarationFiles = (typesDir) =>
  readdirSync(typesDir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".d.ts"))
    .map((file) => file.split(path.sep).join("/"));

// ---- The OTA part of @velexis/api-types ------------------------------------------------------------------------

/**
 * Reads the OTA part of `@velexis/api-types` as its types entry (`exports["."].types`) gives it: the entry must
 * re-export names (`export type { … } from "./…js"`) of one declaration file, and only that; that file must import
 * and reference nothing (so a copy of it stands alone) and declare every name the entry exports. Anything else
 * throws: a copy that lost a name, or that still needed another file, would build here and break for consumers.
 * @returns {{ file: string, packageDir: string, names: string[], text: string }} the file, the package's folder, the
 *   names the entry exports and the file's text without its source map link (the map is not copied)
 */
export function readApiTypes() {
  const ts = typescript();
  let manifestFile;
  try {
    manifestFile = requireFromSdk.resolve(`${API_TYPES_PACKAGE}/package.json`);
  } catch (err) {
    throw new BuildError(`${API_TYPES_PACKAGE} cannot be resolved: ${/** @type {Error} */ (err).message}`);
  }
  const packageDir = path.dirname(manifestFile);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const entryTypes = manifest.exports?.["."]?.types;
  if (typeof entryTypes !== "string") {
    throw new BuildError(`${API_TYPES_PACKAGE}'s package.json names no exports["."].types`);
  }
  const entry = path.join(packageDir, entryTypes);
  if (!existsSync(entry)) {
    throw new BuildError(
      `${entry} does not exist: build ${API_TYPES_PACKAGE} first (pnpm --filter ${API_TYPES_PACKAGE} build)`,
    );
  }
  const index = ts.createSourceFile(entry, readFileSync(entry, "utf8"), ts.ScriptTarget.Latest);
  const specifiers = new Set();
  const names = [];
  for (const statement of index.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      throw new BuildError(
        `${entry}: expected only \`export type { … } from "./….js"\`, found: ${statement.getText(index).slice(0, 80)}`,
      );
    }
    specifiers.add(statement.moduleSpecifier.text);
    names.push(...statement.exportClause.elements.map((element) => element.name.text));
  }
  const [specifier] = specifiers;
  if (specifiers.size !== 1 || !/^\.\.?\/.+\.js$/.test(specifier)) {
    throw new BuildError(
      `${entry}: expected the names of one relative module, found ${JSON.stringify([...specifiers])}`,
    );
  }
  const file = path.join(path.dirname(entry), specifier.replace(/\.js$/, ".d.ts"));
  const text = readFileSync(file, "utf8");
  const references = ts.preProcessFile(text, true, true);
  const needed = [
    ...references.importedFiles,
    ...references.referencedFiles,
    ...references.typeReferenceDirectives,
    ...references.libReferenceDirectives,
  ].map((reference) => reference.fileName);
  if (needed.length > 0) {
    throw new BuildError(
      `${file} imports or references ${JSON.stringify(needed)}; its copy would not stand alone`,
    );
  }
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
  const declared = new Set(
    source.statements
      .filter((statement) => ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
      .filter((statement) => statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword))
      .map((statement) => statement.name.text),
  );
  const missing = names.filter((name) => !declared.has(name));
  if (missing.length > 0) {
    throw new BuildError(`${file} does not declare ${missing.join(", ")}, which ${entry} exports`);
  }
  return { file, packageDir, names, text: text.replace(/\n\/\/# sourceMappingURL=\S*\s*$/, "\n") };
}

/**
 * The module specifiers of a declaration file that name `specifier`, each with the position of its string literal,
 * quotes included: `import("…")` types, import and export declarations and `import x = require("…")`. A
 * `declare module "…"` of it would augment the copy once rewritten, so it throws.
 * @param {import("typescript").SourceFile} sourceFile
 * @param {string} specifier
 * @returns {Array<{ start: number, end: number }>} in the order of the text
 */
export function specifierSpans(sourceFile, specifier) {
  const ts = typescript();
  /** @type {Array<{ start: number, end: number }>} */
  const spans = [];
  /** @param {import("typescript").Node | undefined} literal */
  const consider = (literal) => {
    if (literal && ts.isStringLiteral(literal) && literal.text === specifier) {
      spans.push({ start: literal.getStart(sourceFile), end: literal.end });
    }
  };
  /** @param {import("typescript").Node} node */
  const visit = (node) => {
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      consider(node.argument.literal);
    } else if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      consider(node.moduleSpecifier);
    } else if (ts.isExternalModuleReference(node)) {
      consider(node.expression);
    } else if (
      ts.isModuleDeclaration(node) &&
      ts.isStringLiteral(node.name) &&
      node.name.text === specifier
    ) {
      throw new BuildError(
        `${sourceFile.fileName} declares module "${specifier}", which cannot be rewritten`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return spans.sort((a, b) => a.start - b.start);
}

// ---- Declaration maps ------------------------------------------------------------------------------------------

/** The digits of a source map's base64 VLQs. */
const VLQ_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Decodes a source map's `mappings` into lines of segments with absolute values: the generated column, then (when
 * the segment has them) the source index, the source line, the source column and the name index.
 * @param {string} mappings
 * @returns {number[][][]}
 */
export function decodeMappings(mappings) {
  const state = [0, 0, 0, 0, 0];
  return mappings.split(";").map((line) => {
    state[0] = 0; // the generated column restarts on every line; the other fields run on
    return line === ""
      ? []
      : line.split(",").map((segment) => {
          const fields = [];
          let value = 0;
          let shift = 0;
          for (const char of segment) {
            const digit = VLQ_DIGITS.indexOf(char);
            if (digit < 0) {
              throw new BuildError(`not a source map segment: ${segment}`);
            }
            value += (digit & 31) * 2 ** shift;
            if (digit & 32) {
              shift += 5;
            } else {
              const index = fields.length;
              state[index] =
                /** @type {number} */ (state[index]) + (value % 2 ? -(value - 1) / 2 : value / 2);
              fields.push(/** @type {number} */ (state[index]));
              value = 0;
              shift = 0;
            }
          }
          return fields;
        });
  });
}

/**
 * Encodes lines of absolute segments (decodeMappings' output) as a source map's `mappings`.
 * @param {number[][][]} lines
 */
export function encodeMappings(lines) {
  const state = [0, 0, 0, 0, 0];
  /** @param {number} value */
  const vlq = (value) => {
    let rest = value < 0 ? -value * 2 + 1 : value * 2;
    let out = "";
    do {
      const digit = rest % 32;
      rest = Math.floor(rest / 32);
      out += VLQ_DIGITS[rest > 0 ? digit + 32 : digit];
    } while (rest > 0);
    return out;
  };
  return lines
    .map((segments) => {
      state[0] = 0;
      return segments
        .map((fields) =>
          fields
            .map((value, index) => {
              const delta = value - /** @type {number} */ (state[index]);
              state[index] = value;
              return vlq(delta);
            })
            .join(""),
        )
        .join(",");
    })
    .join(";");
}

/**
 * Moves the generated columns of a declaration map after text replacements on single lines. A segment at or after a
 * replaced literal moves by the change of length, one inside it goes to its start, one before it stays.
 * @param {string} mappings
 * @param {Array<{ line: number, start: number, end: number, delta: number }>} edits columns of the text before the
 *   edits; on one line they never overlap
 * @returns {string}
 */
export function shiftMappings(mappings, edits) {
  const lines = decodeMappings(mappings);
  for (const [index, segments] of lines.entries()) {
    const onLine = edits.filter(({ line }) => line === index).sort((a, b) => a.start - b.start);
    for (const fields of onLine.length > 0 ? segments : []) {
      const column = /** @type {number} */ (fields[0]);
      let moved = column;
      for (const { start, end, delta } of onLine) {
        if (column >= end) {
          moved += delta;
        } else {
          if (column > start) {
            moved = start + (moved - column);
          }
          break;
        }
      }
      fields[0] = moved;
    }
  }
  return encodeMappings(lines);
}

// ---- Self-contained declarations -------------------------------------------------------------------------------

/**
 * Replaces every `"@velexis/api-types"` module specifier of one declaration by `replacement`.
 * @param {string} text the declaration
 * @param {string} fileName for messages
 * @param {string} replacement the relative specifier of the copy (`./api-types.js`)
 * @returns {{ text: string, edits: Array<{ line: number, start: number, end: number, delta: number }> }} the new
 *   text and, per replaced literal, its line and columns in the old text and its change of length
 */
export function rewriteApiTypesSpecifiers(text, fileName, replacement) {
  const ts = typescript();
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const spans = specifierSpans(sourceFile, API_TYPES_PACKAGE);
  const edits = [];
  let rewritten = "";
  let from = 0;
  for (const { start, end } of spans) {
    const quote = text[start];
    const literal = `${quote}${replacement}${quote}`;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
    edits.push({
      line,
      start: character,
      end: character + (end - start),
      delta: literal.length - (end - start),
    });
    rewritten += text.slice(from, start) + literal;
    from = end;
  }
  return { text: rewritten + text.slice(from), edits };
}

/**
 * Makes the declarations in `typesDir` self-contained: writes the copy of the OTA part of `@velexis/api-types` next
 * to them, rewrites their specifiers of the package to the copy and moves their declaration maps' columns. Throws
 * when a source module would be overwritten by the copy, or when a declaration still names the package afterwards
 * (a `/// <reference types>` or a construct the rewrite does not know).
 * @param {string} typesDir
 * @returns {{ file: string, bytes: number, rewritten: string[] }} the copy, its size and the declarations rewritten
 *   (relative to `typesDir`)
 */
export function includeApiTypes(typesDir) {
  const ts = typescript();
  const copy = path.join(typesDir, API_TYPES_FILE);
  if (existsSync(copy)) {
    throw new BuildError(
      `${copy} was emitted from a source module; the copy of ${API_TYPES_PACKAGE} needs its name`,
    );
  }
  const apiTypes = readApiTypes();
  const origin = path.relative(apiTypes.packageDir, apiTypes.file).split(path.sep).join("/");
  writeFileSync(
    copy,
    `// The OTA booking API's types for the declarations of @velexis/ota-sdk: a copy of ${origin} of ${API_TYPES_PACKAGE}\n` +
      "// (generated from the OTA OpenAPI document), written by the SDK's scripts/build.mjs so that the package needs no\n" +
      "// dependency, not even for its types (OADR-0016 point 7). Rebuilt with the SDK; never edited.\n" +
      apiTypes.text,
  );
  const rewritten = [];
  for (const name of declarationFiles(typesDir).filter((file) => file !== API_TYPES_FILE)) {
    const file = path.join(typesDir, name);
    const target = path
      .relative(path.dirname(file), path.join(typesDir, "api-types.js"))
      .split(path.sep)
      .join("/");
    const { text, edits } = rewriteApiTypesSpecifiers(
      readFileSync(file, "utf8"),
      file,
      target.startsWith(".") ? target : `./${target}`,
    );
    if (edits.length > 0) {
      writeFileSync(file, text);
      const mapFile = `${file}.map`;
      if (existsSync(mapFile)) {
        const map = JSON.parse(readFileSync(mapFile, "utf8"));
        map.mappings = shiftMappings(map.mappings, edits);
        writeFileSync(mapFile, JSON.stringify(map));
      }
      rewritten.push(name);
    }
    const left = ts.preProcessFile(text, true, true);
    if (
      [...left.importedFiles, ...left.typeReferenceDirectives].some(
        ({ fileName }) => fileName === API_TYPES_PACKAGE || fileName.startsWith(`${API_TYPES_PACKAGE}/`),
      )
    ) {
      throw new BuildError(`${file} still names ${API_TYPES_PACKAGE} after the rewrite`);
    }
  }
  return { file: copy, bytes: statSync(copy).size, rewritten };
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
 * The whole build: bundles, then declarations, then the copy of the OTA API types they import.
 * @param {string} [outdir]
 */
export async function build(outdir = DEFAULT_OUTDIR) {
  const dir = path.resolve(outdir);
  removeOutputs(dir);
  mkdirSync(dir, { recursive: true });
  const bundles = await buildBundles(dir);
  const declarations = emitDeclarations(dir);
  const apiTypes = includeApiTypes(path.join(dir, OUTPUTS.types));
  return { outdir: dir, bundles, declarations, apiTypes };
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
  console.log(
    `ota-sdk build: wrote ${shown(result.apiTypes.file)} (${kb(result.apiTypes.bytes)}, the OTA types of ` +
      `${API_TYPES_PACKAGE}) and pointed ${result.apiTypes.rewritten.join(", ") || "no declaration"} at it`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`ota-sdk build: ${err instanceof BuildError ? err.message : (err?.stack ?? err)}`);
    process.exitCode = 1;
  });
}
