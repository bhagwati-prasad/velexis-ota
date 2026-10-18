#!/usr/bin/env node
// check-size.mjs: the size budget of the SDK bundles (OADR-0016 point 7, ota/sdk/docs/types-and-builds.md §7,
// SDK-007).
//
// Usage (from ota/sdk; `pnpm --filter @velexis/ota-sdk build` runs it after scripts/build.mjs, so CI checks it in
// the Build step):
//   node scripts/check-size.mjs                # measures dist/
//   node scripts/check-size.mjs --dir <dir>    # measures another build folder (test/unit/bundle.test.js)
//
// It gzips each bundle (already minified by the build) at level 9 and prints its size, minified and min+gzip. The
// ESM bundle, the one the storefront and every npm consumer load, may be at most 25 KB (25 × 1024 bytes) min+gzip;
// above that the script exits 1. The IIFE is the same code in another wrapper: it is printed, not budgeted. A
// missing bundle also exits 1, so the check never passes by measuring nothing. When the budget is exceeded, the
// console namespace moves to its own entry point, `@velexis/ota-sdk/console` (the ADR-0019 follow-up, OADR-0016
// Follow-ups); the budget is never raised to make a build pass.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

import { DEFAULT_OUTDIR, OUTPUTS } from "./build.mjs";

export const KB = 1024;
/** The budget of the ESM bundle in bytes, min+gzip (OADR-0016 point 7). */
export const BUDGET_BYTES = 25 * KB;

/**
 * The size of `content` gzipped at level 9.
 * @param {Uint8Array} content
 */
export const gzipSize = (content) => gzipSync(content, { level: 9 }).length;

/**
 * @typedef {object} Measurement
 * @property {"ESM" | "IIFE"} kind
 * @property {string} file the bundle's path
 * @property {boolean} missing whether the file does not exist
 * @property {number | null} minified its size in bytes, as the build wrote it
 * @property {number | null} gzip its size in bytes, gzipped at level 9
 * @property {number | null} limit the budget in bytes (min+gzip), `null` for none
 * @property {boolean} ok whether it exists and keeps its budget
 */

/**
 * Measures the bundles of a build folder.
 * @param {string} dir the build folder (dist/)
 * @returns {Measurement[]}
 */
export function measure(dir) {
  /** @type {Array<{ kind: "ESM" | "IIFE", name: string, limit: number | null }>} */
  const bundles = [
    { kind: "ESM", name: OUTPUTS.esm, limit: BUDGET_BYTES },
    { kind: "IIFE", name: OUTPUTS.iife, limit: null },
  ];
  return bundles.map(({ kind, name, limit }) => {
    const file = path.join(dir, name);
    if (!existsSync(file)) {
      return { kind, file, missing: true, minified: null, gzip: null, limit, ok: false };
    }
    const content = readFileSync(file);
    const gzip = gzipSize(content);
    return {
      kind,
      file,
      missing: false,
      minified: content.length,
      gzip,
      limit,
      ok: limit === null || gzip <= limit,
    };
  });
}

/** True when every bundle exists and keeps its budget. */
export const passes = (/** @type {Measurement[]} */ measurements) => measurements.every((m) => m.ok);

const kb = (/** @type {number} */ bytes) => `${(bytes / KB).toFixed(1)} KB`;

/** A path for messages: relative to the working folder when inside it. */
const shown = (/** @type {string} */ file) => {
  const relative = path.relative(process.cwd(), file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
};

/**
 * The report: one line per bundle with its sizes, then one line per breach.
 * @param {Measurement[]} measurements
 */
export function formatReport(measurements) {
  const lines = measurements.map((m) => {
    if (m.missing || m.minified === null || m.gzip === null) {
      return `check-size: ${m.kind} ${shown(m.file)}: missing`;
    }
    const budget =
      m.limit === null ? "no budget" : `budget ${kb(m.limit)} (${m.limit} B): ${m.ok ? "ok" : "OVER"}`;
    return (
      `check-size: ${m.kind} ${shown(m.file)}: ${kb(m.minified)} minified, ` +
      `${kb(m.gzip)} (${m.gzip} B) min+gzip, ${budget}`
    );
  });
  for (const m of measurements) {
    if (m.missing) {
      lines.push(`MISSING: ${shown(m.file)} does not exist; run scripts/build.mjs first`);
    } else if (!m.ok && m.gzip !== null && m.limit !== null) {
      lines.push(
        `OVER BUDGET: ${shown(m.file)} is ${kb(m.gzip)} (${m.gzip} B) min+gzip, more than ${kb(m.limit)} ` +
          `(${m.limit} B); move the console namespace to its own entry, @velexis/ota-sdk/console (OADR-0016)`,
      );
    }
  }
  return lines.join("\n");
}

const USAGE = "usage: node scripts/check-size.mjs [--dir <build folder>]";

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let values;
  try {
    ({ values } = parseArgs({ options: { dir: { type: "string" } }, strict: true }));
  } catch (err) {
    console.error(`check-size: ${/** @type {Error} */ (err).message}\n${USAGE}`);
    process.exit(1);
  }
  const measurements = measure(path.resolve(values.dir ?? DEFAULT_OUTDIR));
  const report = formatReport(measurements);
  if (passes(measurements)) {
    console.log(report);
  } else {
    console.error(report);
    process.exitCode = 1;
  }
}
