#!/usr/bin/env node
// check-budgets: size budgets of the storefront build (ota/frontend/README.md §9, OADR-0015 point 12).
//
// Usage:  node scripts/check-budgets.mjs [--dir <dist folder>]     (default: dist/ next to this script's package)
//
// For every HTML page of the build it measures, gzip-compressed:
//   - HTML: the page itself, at most 20 KB;
//   - JS: every first-party script the page can load: its <script src>, its <link rel="modulepreload">, and the
//     chunks those import, statically or dynamically; at most 60 KB, 30 KB on checkout/pay-airline.html
//     (OADR-0017). Third-party scripts (Stripe.js on the card page) are not part of the budget;
//   - CSS: every stylesheet the page links, at most 20 KB;
// and its fonts (OFE-024): at most 2 families and 120 KB of woff2 files per page, counted as served (woff2 is
// compressed already, and Caddy does not compress it again). A page's text has two font slots, the body text
// (`--vx-font-body`) and the headings (`--vx-font-heading`), which lib/theme.js sets at runtime to one bundled family
// each (README §6); a bundled family that a stylesheet names itself counts as one more. The size is the worst case of
// the OTA's choice: of every pair of the families the page's stylesheets declare (`@font-face`), the faces a browser
// picks (CSS Fonts 4 §5.2) for the weights of the body text (every `font-weight` of the stylesheets) and of the
// headings (the weight classes of the page's h1 to h3 and `font-heading` elements, 400 without one, and 600 for the
// headings the modules create), plus any font the page preloads (`<link rel="preload" as="font">`). A face that is
// not woff2 fails too.
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
/** Fonts per page (README §9): at most 2 families and 120 KB of woff2 files, counted as served. */
export const FONT_BUDGET = Object.freeze({ families: 2, bytes: 120 * KB });
/**
 * The custom properties lib/theme.js sets from `storefront.get` (`branding.fonts.body` and `.heading`) to the font
 * stack of one bundled family each: the page's two font slots, by the name the report gives them.
 */
export const RUNTIME_FONT_PROPERTIES = Object.freeze({
  "--vx-font-body": "body",
  "--vx-font-heading": "headings",
});
/** The weight of the headings the page modules create (`font-semibold`: lib/forms.js, lib/blocks.js). */
const SCRIPTED_HEADING_WEIGHT = 600;
/** The weight of text without one of its own: `font-weight: normal`, the stylesheet's default. */
const NORMAL_WEIGHT = 400;
/** Tailwind's font-weight utilities (`font-semibold`, also behind a variant such as `sm:font-bold`). */
const WEIGHT_CLASSES = Object.freeze({
  thin: 100,
  extralight: 200,
  light: 300,
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
});
/** The elements the stylesheet sets in the heading font: h1 to h3 (`@layer base` of main.css), and `font-heading`. */
const HEADING_TAGS = Object.freeze(["h1", "h2", "h3"]);

const toPosix = (/** @type {string} */ path) => path.split(sep).join("/");

/** @param {string} dir */
function htmlPages(dir) {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map(toPosix)
    .filter((file) => file.endsWith(".html") && statSync(join(dir, file)).isFile())
    .sort();
}

/** Parses the attributes of one start tag (`<a href="…" hidden>`), lower-cased names, the tag name left out. */
function attributesOf(/** @type {string} */ tag, /** @type {string} */ name) {
  /** @type {Record<string, string>} */
  const attrs = {};
  for (const m of tag.matchAll(/([^\s=<>"'/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const key = (m[1] ?? "").toLowerCase();
    if (key !== name.toLowerCase()) {
      attrs[key] = m[2] ?? m[3] ?? m[4] ?? "";
    }
  }
  return attrs;
}

/** Attributes of every `<tag …>` in `html`, lower-cased names. */
function tags(/** @type {string} */ html, /** @type {string} */ name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map(([tag]) => attributesOf(tag, name));
}

/** Every start tag of `html` with its lower-cased name and attributes. */
function allTags(/** @type {string} */ html) {
  return [...html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*>/gi)].map(([tag, name = ""]) => ({
    name: name.toLowerCase(),
    attrs: attributesOf(tag, name),
  }));
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
 * One `@font-face` rule of a stylesheet.
 * @typedef {{ family: string, style: string, weight: [number, number], url: string, format: string, file: string | null }} FontFace
 */

/** A family name without its quotes (`"Source Sans 3"` → `Source Sans 3`). */
const unquote = (/** @type {string} */ name) => name.trim().replace(/^(["'])(.*)\1$/, "$2");

/** The parts of `value` separated by commas outside parentheses and quotes. */
function splitTopLevel(/** @type {string} */ value) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote !== "") {
      quote = char === quote ? "" : quote;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/** The name and fallback of `var(--name[, fallback])`, or null when `value` is not one `var()`. */
function varReference(/** @type {string} */ value) {
  const match = /^var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)$/.exec(value.trim());
  return match ? { name: match[1] ?? "", fallback: match[2]?.trim() ?? "" } : null;
}

/** The value of one declaration of a rule body (`font-weight: 400` → "400"), or "". */
const declarationOf = (/** @type {string} */ body, /** @type {string} */ name) =>
  new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;}]+)`, "i").exec(body)?.[1]?.trim() ?? "";

/** The weights of a face (`400`, `bold`, the range `100 900`). */
function faceWeights(/** @type {string} */ value) {
  const numbers = value
    .split(/\s+/)
    .filter((part) => part !== "")
    .map((part) => (part === "bold" ? 700 : part === "normal" || part === "" ? 400 : Number(part)));
  const [low = NORMAL_WEIGHT, high = low] = numbers.every(Number.isFinite) ? numbers : [NORMAL_WEIGHT];
  return /** @type {[number, number]} */ ([Math.min(low, high), Math.max(low, high)]);
}

/**
 * What a stylesheet says about fonts: its `@font-face` rules, its custom properties, and the values of its
 * `font-family` and `font-weight` declarations outside them.
 * @param {string} css
 * @param {string} from the stylesheet's dist-relative path (for relative font URLs)
 */
function cssFonts(css, from) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  /** @type {FontFace[]} */
  const faces = [];
  const rest = text.replace(/@font-face\s*\{([^}]*)\}/gi, (_rule, /** @type {string} */ body) => {
    const src = declarationOf(body, "src");
    const first =
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)\s*(?:format\(\s*["']?([^"')]+)["']?\s*\))?/i.exec(src);
    const url = first?.[1] ?? first?.[2] ?? first?.[3] ?? "";
    faces.push({
      family: unquote(declarationOf(body, "font-family")),
      style: declarationOf(body, "font-style") || "normal",
      weight: faceWeights(declarationOf(body, "font-weight")),
      url,
      format: (first?.[4] ?? "").trim().toLowerCase(),
      file: url === "" ? null : localPath(url, from),
    });
    return "";
  });
  /** @type {Map<string, string[]>} */
  const properties = new Map();
  for (const m of rest.matchAll(/(--[\w-]+)\s*:\s*([^;}]*)/g)) {
    const name = m[1] ?? "";
    properties.set(name, [...(properties.get(name) ?? []), (m[2] ?? "").trim()]);
  }
  const values = (/** @type {string} */ property) =>
    [...rest.matchAll(new RegExp(`(?<![\\w-])${property}\\s*:\\s*([^;}]*)`, "g"))].map((m) =>
      (m[1] ?? "").trim(),
    );
  return { faces, properties, families: values("font-family"), weights: values("font-weight") };
}

/**
 * The font slots a `font-family` value can resolve to: the runtime slots of RUNTIME_FONT_PROPERTIES it reaches through
 * `var()`, and the bundled families it names itself.
 * @param {string} value
 * @param {Map<string, string[]>} properties the stylesheets' custom properties
 * @param {Set<string>} bundled the families the stylesheets declare
 * @param {Set<string>} [seen] custom properties already followed (a cycle resolves to nothing)
 * @returns {{ runtime: Set<string>, literal: Set<string> }}
 */
function fontSlots(value, properties, bundled, seen = new Set()) {
  /** @type {{ runtime: Set<string>, literal: Set<string> }} */
  const slots = { runtime: new Set(), literal: new Set() };
  const merge = (/** @type {{ runtime: Set<string>, literal: Set<string> }} */ other) => {
    other.runtime.forEach((slot) => slots.runtime.add(slot));
    other.literal.forEach((family) => slots.literal.add(family));
  };
  for (const item of splitTopLevel(value)) {
    const reference = varReference(item);
    if (reference === null) {
      const family = unquote(item);
      if (bundled.has(family)) {
        slots.literal.add(family);
      }
    } else if (Object.hasOwn(RUNTIME_FONT_PROPERTIES, reference.name)) {
      slots.runtime.add(reference.name);
    } else if (properties.has(reference.name) && !seen.has(reference.name)) {
      for (const declared of properties.get(reference.name) ?? []) {
        merge(fontSlots(declared, properties, bundled, new Set([...seen, reference.name])));
      }
    } else if (reference.fallback !== "") {
      merge(fontSlots(reference.fallback, properties, bundled, seen));
    }
  }
  return slots;
}

/**
 * The numeric weights a `font-weight` value can give text (`bolder` from 400 is 700, from 600 or 700 900; `lighter`
 * from 400 is 100), following `var()` through the custom properties.
 * @param {string} value
 * @param {Map<string, string[]>} properties
 * @param {Set<string>} [seen]
 * @returns {number[]}
 */
function weightsOf(value, properties, seen = new Set()) {
  const reference = varReference(value);
  if (reference !== null) {
    if (properties.has(reference.name) && !seen.has(reference.name)) {
      return (properties.get(reference.name) ?? []).flatMap((declared) =>
        weightsOf(declared, properties, new Set([...seen, reference.name])),
      );
    }
    return reference.fallback === "" ? [] : weightsOf(reference.fallback, properties, seen);
  }
  const keyword = value.trim().toLowerCase();
  const keywords = /** @type {Record<string, number[]>} */ ({
    normal: [400],
    bold: [700],
    bolder: [700, 900],
    lighter: [100],
    initial: [400],
  });
  if (Object.hasOwn(keywords, keyword)) {
    return keywords[keyword] ?? [];
  }
  const number = Number(keyword);
  return Number.isFinite(number) && keyword !== "" ? [number] : [];
}

/** The weight classes of a `class` attribute (`font-heading font-semibold sm:font-bold` → 600, 700). */
function classWeights(/** @type {string} */ classes) {
  return classes
    .split(/\s+/)
    .map((token) => /(?:^|:)font-([a-z]+)$/.exec(token)?.[1] ?? "")
    .filter((name) => Object.hasOwn(WEIGHT_CLASSES, name))
    .map((name) => WEIGHT_CLASSES[/** @type {keyof typeof WEIGHT_CLASSES} */ (name)]);
}

/**
 * The face a browser uses for `weight` among a family's normal faces (CSS Fonts 4 §5.2, font-weight matching), or
 * undefined when the family has none.
 * @param {FontFace[]} familyFaces
 * @param {number} weight
 */
export function matchFace(familyFaces, weight) {
  const faces = familyFaces.filter((face) => face.style === "normal");
  const exact = faces.find((face) => face.weight[0] <= weight && weight <= face.weight[1]);
  if (exact) {
    return exact;
  }
  const lighter = faces.filter((face) => face.weight[1] < weight).sort((a, b) => b.weight[1] - a.weight[1]);
  const heavier = faces.filter((face) => face.weight[0] > weight).sort((a, b) => a.weight[0] - b.weight[0]);
  if (weight > 500) {
    return heavier[0] ?? lighter[0];
  }
  if (weight < 400) {
    return lighter[0] ?? heavier[0];
  }
  const upTo500 = heavier.filter((face) => face.weight[0] <= 500);
  return upTo500[0] ?? lighter[0] ?? heavier[0];
}

/**
 * The faces of `family` that text in `weights` can use: the matched normal faces, and every face of another style
 * (an italic face is the one `font-style: italic` takes).
 * @param {FontFace[]} faces
 * @param {string} family
 * @param {Iterable<number>} weights
 */
function facesFor(faces, family, weights) {
  const familyFaces = faces.filter((face) => face.family === family);
  const used = new Set(familyFaces.filter((face) => face.style !== "normal"));
  for (const weight of weights) {
    const face = matchFace(familyFaces, weight);
    if (face) {
      used.add(face);
    }
  }
  return [...used];
}

/**
 * Measures every page of a build folder against the budgets.
 * @param {string} dir the build folder (dist/)
 * @returns {{ rows: Array<{ page: string, kind: "html" | "js" | "css" | "font", bytes: number, limit: number, files: Array<{ file: string, bytes: number }>, ok: boolean, families?: string[], notWoff2?: string[], worstCase?: string }>, missing: Array<{ page: string, file: string }>, pages: number }}
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
  /** Bytes as served, for fonts (compressed already). */
  const raw = (/** @type {string} */ file) => statSync(join(root, file)).size;
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
    rows.push(fontRow(page, html, css));
  }
  return { rows, missing, pages: pages.length };

  /**
   * The font row of `page`: the worst choice of a body and a heading family among those its stylesheets declare.
   * @param {string} page
   * @param {string} html
   * @param {Set<string>} css the page's stylesheets (dist-relative, in the build)
   */
  function fontRow(page, html, css) {
    const sheets = [...css].map((file) => cssFonts(readFileSync(join(root, file), "utf8"), file));
    const faces = sheets.flatMap((sheet) => sheet.faces);
    /** @type {Map<string, string[]>} */
    const properties = new Map();
    for (const sheet of sheets) {
      for (const [name, values] of sheet.properties) {
        properties.set(name, [...(properties.get(name) ?? []), ...values]);
      }
    }
    const bundled = new Set(faces.map((face) => face.family));
    for (const face of faces) {
      if (face.file !== null && !exists(face.file)) {
        missing.push({ page, file: face.file });
      }
    }

    // The slots the page's text can be set in, and the weights the body text and the headings use.
    /** @type {Set<string>} */
    const runtime = new Set();
    /** @type {Set<string>} */
    const literal = new Set();
    for (const value of sheets.flatMap((sheet) => sheet.families)) {
      const slots = fontSlots(value, properties, bundled);
      slots.runtime.forEach((slot) => runtime.add(slot));
      slots.literal.forEach((family) => literal.add(family));
    }
    const bodyWeights = new Set([
      NORMAL_WEIGHT,
      ...sheets.flatMap((sheet) => sheet.weights.flatMap((value) => weightsOf(value, properties))),
    ]);
    const headingWeights = new Set([SCRIPTED_HEADING_WEIGHT]);
    for (const { name, attrs } of allTags(html)) {
      const classes = attrs["class"] ?? "";
      if (HEADING_TAGS.includes(name) || classes.split(/\s+/).includes("font-heading")) {
        const weights = classWeights(classes);
        (weights.length > 0 ? weights : [NORMAL_WEIGHT]).forEach((weight) => headingWeights.add(weight));
      }
    }

    // Fonts the page preloads are downloaded whatever the text uses.
    /** @type {Set<string>} */
    const preloaded = new Set();
    for (const link of tags(html, "link")) {
      const file =
        /\bpreload\b/i.test(link.rel ?? "") && link.as === "font" && link.href
          ? localPath(link.href, page)
          : null;
      if (file !== null) {
        if (exists(file)) {
          preloaded.add(file);
        } else {
          missing.push({ page, file });
        }
      }
    }

    const choices = (/** @type {string} */ property) =>
      runtime.has(property) && bundled.size > 0 ? [...bundled] : [null];
    /** @type {{ bytes: number, files: Array<{ file: string, bytes: number }>, label: string }} */
    let worst = { bytes: -1, files: [], label: "" };
    for (const body of choices("--vx-font-body")) {
      for (const heading of choices("--vx-font-heading")) {
        const used = [
          ...(body === null ? [] : facesFor(faces, body, bodyWeights)),
          ...(heading === null ? [] : facesFor(faces, heading, headingWeights)),
          ...[...literal].flatMap((family) => faces.filter((face) => face.family === family)),
        ];
        const files = new Set([
          ...used.flatMap((face) => (face.file !== null && exists(face.file) ? [face.file] : [])),
          ...preloaded,
        ]);
        const list = [...files].map((file) => ({ file, bytes: raw(file) })).sort((a, b) => b.bytes - a.bytes);
        const bytes = list.reduce((sum, f) => sum + f.bytes, 0);
        if (bytes > worst.bytes) {
          const named = [body === null ? "" : `body ${body}`, heading === null ? "" : `headings ${heading}`];
          worst = { bytes, files: list, label: named.filter((part) => part !== "").join(", ") };
        }
      }
    }
    const families = [
      ...(bundled.size > 0
        ? [...runtime].map(
            (property) =>
              RUNTIME_FONT_PROPERTIES[/** @type {keyof typeof RUNTIME_FONT_PROPERTIES} */ (property)],
          )
        : []),
      ...literal,
    ];
    const notWoff2 = faces
      .filter((face) => face.format !== "woff2" || !/\.woff2$/i.test(face.url.split(/[?#]/)[0] ?? ""))
      .map((face) => face.file ?? face.url);
    return {
      page,
      kind: /** @type {const} */ ("font"),
      bytes: worst.bytes,
      limit: FONT_BUDGET.bytes,
      files: worst.files,
      ok:
        worst.bytes <= FONT_BUDGET.bytes && families.length <= FONT_BUDGET.families && notWoff2.length === 0,
      families,
      notWoff2,
      worstCase: worst.label,
    };
  }
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
  if (rows.some((r) => r.kind === "font")) {
    out.push(
      "FONT: the woff2 files as served (not gzipped), for the body and heading families of the largest pair the page can show",
    );
  }
  for (const r of rows.filter((x) => !x.ok)) {
    const files = r.files.map((f) => `${f.file} (${kb(f.bytes)})`).join(", ");
    if (r.bytes > r.limit) {
      const choice = r.worstCase ? ` (${r.worstCase})` : "";
      out.push(
        `OVER BUDGET: ${r.page} ${r.kind.toUpperCase()} ${kb(r.bytes)} > ${kb(r.limit)}${choice}: ${files}`,
      );
    }
    if (r.families !== undefined && r.families.length > FONT_BUDGET.families) {
      out.push(
        `TOO MANY FONT FAMILIES: ${r.page} can show ${r.families.length} font families at once ` +
          `(at most ${FONT_BUDGET.families}): ${r.families.join(", ")}`,
      );
    }
    if (r.notWoff2 !== undefined && r.notWoff2.length > 0) {
      out.push(`NOT WOFF2: ${r.page} declares fonts that are not woff2: ${r.notWoff2.join(", ")}`);
    }
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
