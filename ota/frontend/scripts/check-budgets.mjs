#!/usr/bin/env node
// check-budgets: gzip size budgets of the storefront build (ota/frontend/README.md §9, OADR-0015 point 12).
//
// Usage:  node scripts/check-budgets.mjs [--dir <dist folder>]     (default: dist/ next to this script's package)
//
// For every HTML page of the build it measures, gzip-compressed:
//   - HTML: the page itself, at most 20 KB;
//   - JS: every first-party script the page can load: its <script src>, its <link rel="modulepreload">, and the
//     chunks those import, statically or dynamically; at most 60 KB, 30 KB on checkout/pay-airline.html
//     (OADR-0017). Third-party scripts (Stripe.js on the card page) are not part of the budget;
//   - CSS: every stylesheet the page links, at most 20 KB.
// It prints one table row per page and kind, and exits 1 when a budget is exceeded (naming the page and its
// files), when a page references a file that is not in the build, or when the folder has no HTML page at all.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

export const KB = 1024;
/** Budgets in bytes (gzip). */
export const BUDGETS = Object.freeze({ html: 20 * KB, js: 60 * KB, css: 20 * KB });
/** Stricter JS budgets per page (dist-relative path). */
export const PAGE_JS_BUDGETS = Object.freeze({ "checkout/pay-airline.html": 30 * KB });

const toPosix = (/** @type {string} */ path) => path.split(sep).join("/");

/** @param {string} dir */
function htmlPages(dir) {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map(toPosix)
    .filter((file) => file.endsWith(".html") && statSync(join(dir, file)).isFile())
    .sort();
}

/** Attributes of every `<tag …>` in `html`, lower-cased names. */
function tags(/** @type {string} */ html, /** @type {string} */ name) {
  const out = [];
  for (const [tag] of html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))) {
    /** @type {Record<string, string>} */
    const attrs = {};
    for (const m of tag.matchAll(/([^\s=<>"'/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      const key = (m[1] ?? "").toLowerCase();
      if (key !== name.toLowerCase()) {
        attrs[key] = m[2] ?? m[3] ?? m[4] ?? "";
      }
    }
    out.push(attrs);
  }
  return out;
}

/**
 * A dist-relative path for a URL found in `from` (a dist-relative file), or null for a third-party URL.
 * @param {string} url
 * @param {string} from
 */
function localPath(url, from) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) {
    return null;
  }
  const path = url.split(/[?#]/)[0] ?? "";
  return posix.normalize(path.startsWith("/") ? path.slice(1) : posix.join(posix.dirname(from), path));
}

/** Module specifiers a built JS file imports (`import"./x.js"`, `from"./x.js"`, `import("./x.js")`). */
function jsImports(/** @type {string} */ code) {
  return [...code.matchAll(/(?:\bimport\s*\(?|\bfrom)\s*["'`]([^"'`]+\.m?js)["'`]/g)].map((m) => m[1] ?? "");
}

/**
 * Measures every page of a build folder against the budgets.
 * @param {string} dir the build folder (dist/)
 * @returns {{ rows: Array<{ page: string, kind: "html" | "js" | "css", bytes: number, limit: number, files: Array<{ file: string, bytes: number }>, ok: boolean }>, missing: Array<{ page: string, file: string }>, pages: number }}
 */
export function checkBudgets(dir) {
  const root = resolve(dir);
  /** @type {Map<string, number>} */
  const sizes = new Map();
  const gz = (/** @type {string} */ file) => {
    if (!sizes.has(file)) {
      sizes.set(file, gzipSync(readFileSync(join(root, file))).length);
    }
    return sizes.get(file) ?? 0;
  };
  const exists = (/** @type {string} */ file) =>
    !file.startsWith("../") && existsSync(join(root, file)) && statSync(join(root, file)).isFile();

  const rows = [];
  /** @type {Array<{ page: string, file: string }>} */
  const missing = [];
  const pages = existsSync(root) ? htmlPages(root) : [];
  for (const page of pages) {
    const html = readFileSync(join(root, page), "utf8");
    const scripts = [
      ...tags(html, "script").map((a) => a.src),
      ...tags(html, "link")
        .filter((a) => /\bmodulepreload\b/i.test(a.rel ?? ""))
        .map((a) => a.href),
    ];
    const styles = tags(html, "link")
      .filter((a) => /\bstylesheet\b/i.test(a.rel ?? ""))
      .map((a) => a.href);

    /** @type {Set<string>} */
    const js = new Set();
    const queue = scripts.flatMap((url) => (url ? [localPath(url, page)] : [])).filter((f) => f !== null);
    while (queue.length > 0) {
      const file = /** @type {string} */ (queue.shift());
      if (js.has(file)) {
        continue;
      }
      if (!exists(file)) {
        missing.push({ page, file });
        continue;
      }
      js.add(file);
      for (const spec of jsImports(readFileSync(join(root, file), "utf8"))) {
        const next = localPath(spec, file);
        if (next !== null) {
          queue.push(next);
        }
      }
    }
    /** @type {Set<string>} */
    const css = new Set();
    for (const url of styles) {
      const file = url ? localPath(url, page) : null;
      if (file === null) {
        continue;
      }
      if (exists(file)) {
        css.add(file);
      } else {
        missing.push({ page, file });
      }
    }

    const row = (/** @type {"html" | "js" | "css"} */ kind, /** @type {Iterable<string>} */ files, limit) => {
      const list = [...files].map((file) => ({ file, bytes: gz(file) })).sort((a, b) => b.bytes - a.bytes);
      const bytes = list.reduce((sum, f) => sum + f.bytes, 0);
      rows.push({ page, kind, bytes, limit, files: list, ok: bytes <= limit });
    };
    row("html", [page], BUDGETS.html);
    row("js", js, PAGE_JS_BUDGETS[/** @type {keyof typeof PAGE_JS_BUDGETS} */ (page)] ?? BUDGETS.js);
    row("css", css, BUDGETS.css);
  }
  return { rows, missing, pages: pages.length };
}

const kb = (/** @type {number} */ bytes) => `${(bytes / KB).toFixed(1)} KB`;

/**
 * The report: a table of every page and kind, then one line per breach naming its files.
 * @param {ReturnType<typeof checkBudgets>} result
 */
export function formatReport({ rows, missing, pages }) {
  const header = ["Page", "Kind", "Size (gzip)", "Budget", "Status"];
  const body = rows.map((r) => [
    r.page,
    r.kind.toUpperCase(),
    kb(r.bytes),
    kb(r.limit),
    r.ok ? "ok" : "OVER",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((cells) => (cells[i] ?? "").length)));
  const line = (/** @type {string[]} */ cells) =>
    cells
      .map((c, i) => (i >= 2 && i <= 3 ? c.padStart(widths[i] ?? 0) : c.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  const out = [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)];
  for (const r of rows.filter((x) => !x.ok)) {
    const files = r.files.map((f) => `${f.file} (${kb(f.bytes)})`).join(", ");
    out.push(`OVER BUDGET: ${r.page} ${r.kind.toUpperCase()} ${kb(r.bytes)} > ${kb(r.limit)}: ${files}`);
  }
  for (const m of missing) {
    out.push(`MISSING: ${m.page} references ${m.file}, which is not in the build`);
  }
  if (pages === 0) {
    out.push("NO PAGES: the folder has no HTML page; run `vite build` first");
  }
  return out.join("\n");
}

/** True when the build passes: at least one page, no missing file, every budget kept. */
export const passes = (/** @type {ReturnType<typeof checkBudgets>} */ result) =>
  result.pages > 0 && result.missing.length === 0 && result.rows.every((r) => r.ok);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { dir: { type: "string" } } });
  const dir = resolve(values.dir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "dist"));
  const result = checkBudgets(dir);
  console.log(`check-budgets: ${toPosix(relative(process.cwd(), dir)) || "."}\n${formatReport(result)}`);
  process.exitCode = passes(result) ? 0 : 1;
}
