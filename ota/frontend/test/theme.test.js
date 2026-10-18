// lib/theme.js (ota/frontend/README.md §6, OADR-0012 point 4): the OTA's colours, corner radius, fonts and favicon
// become `--vx-*` custom properties set with style.setProperty (never CSS text), the text colour on primary and
// secondary is computed for 4.5:1, and a palette with an invalid colour or a pair below WCAG contrast falls back to
// the neutral palette of src/styles/main.css.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COLOR_PROPERTIES,
  CONTRAST_RULES,
  FONT_STACKS,
  NEUTRAL_PALETTE,
  RADIUS_VALUES,
  applyFavicon,
  applyTheme,
  contrastFailures,
  contrastRatio,
  fontStack,
  resolvePalette,
  safeImageUrl,
  textColorOn,
} from "../src/lib/theme.js";
import { REPO_ROOT, STOREFRONT_ROOT } from "./helpers/storefront.js";

/** A brand palette on a dark page that passes every contrast rule (light text, light links, black on primary). */
const DARK_BRAND = Object.freeze({
  primary: "#93C5FD",
  onPrimary: "#ffffff",
  secondary: "#000000",
  accent: "#5eead4",
  background: "#111827",
  surface: "#1f2937",
  text: "#f9fafb",
  mutedText: "#d1d5db",
  success: "#86efac",
  warning: "#fcd34d",
  error: "#fca5a5",
});

/** The neutral colours with a yellow primary: links in it are unreadable on the white page (about 1.2:1). */
const LOW_CONTRAST_PRIMARY = Object.freeze({
  ...NEUTRAL_PALETTE,
  primary: "#ffeb3b",
  onPrimary: "#000000",
  secondary: "#7c2d12",
});

/** A `storefront.get` branding object around `colors`. */
const branding = (/** @type {Record<string, string>} */ colors, extra = {}) => ({
  logoUrl: "/api/v1/assets/demo/ast_logo.png",
  faviconUrl: "/api/v1/assets/demo/ast_favicon.png",
  colors,
  fonts: {
    heading: {
      family: "Playfair Display",
      cssUrl: "https://fonts.googleapis.com/css2?family=x",
      weights: [400],
    },
    body: { family: "Lato", cssUrl: "https://fonts.googleapis.com/css2?family=y", weights: [400] },
  },
  cornerRadius: "large",
  customCssUrl: null,
  ...extra,
});

const root = () => document.documentElement;
/** The `--vx-*` colour properties set on <html>, by palette name. */
const appliedColors = () =>
  Object.fromEntries(
    Object.entries(COLOR_PROPERTIES).map(([name, property]) => [
      name,
      root().style.getPropertyValue(property),
    ]),
  );

/** The source of every storefront module (src/**\/*.js), comments removed. */
let sources = /** @type {Array<[string, string]>} */ ([]);
/** The `:root` custom properties of src/styles/main.css. */
let mainCssRoot = /** @type {Record<string, string>} */ ({});
/** The `StorefrontFontFamily` enum of the generated OTA API types. */
let fontFamilies = /** @type {string[]} */ ([]);

/** Removes `//` and `/* *\/` comments, keeping string literals (which may hold `//`) intact. */
const withoutComments = (/** @type {string} */ code) =>
  code.replace(
    /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (match, literal) => literal ?? "",
  );

beforeAll(() => {
  // Reads a dozen small source files, main.css and the generated API types once (file system only).
  const src = join(STOREFRONT_ROOT, "src");
  sources = readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".js"))
    .map((file) => [file, withoutComments(readFileSync(join(src, file), "utf8"))]);

  const css = readFileSync(join(src, "styles", "main.css"), "utf8");
  const block = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  mainCssRoot = Object.fromEntries(
    [...block.matchAll(/(--vx-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1] ?? "", (m[2] ?? "").trim()]),
  );

  const types = readFileSync(join(REPO_ROOT, "packages", "api-types", "src", "generated", "ota.ts"), "utf8");
  const union = /StorefrontFontFamily:\s*([^;]+);/.exec(types)?.[1] ?? "";
  fontFamilies = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
}, 10_000); // file reads only; generous for a cold CI disk

beforeEach(() => {
  root().removeAttribute("style");
  for (const link of document.head.querySelectorAll("link")) {
    link.remove();
  }
});

afterEach(() => {
  root().removeAttribute("style");
  vi.restoreAllMocks();
});

describe("contrast", () => {
  it("[OFE-003 AC1] computes WCAG contrast ratios and the text colour on a background", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#1d4ed8", "#1d4ed8")).toBe(1);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    expect(contrastRatio("#ffffff", "#767676")).toBe(contrastRatio("#767676", "#ffffff"));

    expect(textColorOn("#1d4ed8")).toBe("#ffffff");
    expect(textColorOn("#ffeb3b")).toBe("#000000");
    // White or black always reaches 4.5:1, whatever the colour (the worst case is about 4.58:1).
    for (const color of ["#757575", "#777777", "#008a00", "#d0021b", "#1d4ed8", "#ffeb3b", "#7c3aed"]) {
      expect(contrastRatio(textColorOn(color), color), color).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("[OFE-003 AC1] the neutral palette equals main.css and passes every contrast rule", () => {
    expect(contrastFailures(NEUTRAL_PALETTE)).toEqual([]);
    for (const [name, property] of Object.entries(COLOR_PROPERTIES)) {
      expect(mainCssRoot[property], `${property} in main.css`).toBe(
        NEUTRAL_PALETTE[/** @type {keyof typeof NEUTRAL_PALETTE} */ (name)],
      );
    }
    expect(mainCssRoot["--vx-radius"]).toBe(RADIUS_VALUES.medium);
    expect(mainCssRoot["--vx-font-body"]).toBe(FONT_STACKS["Inter"]);
    // Text colours on the page and on panels, and the computed text on primary and secondary.
    expect(CONTRAST_RULES).toEqual(
      expect.arrayContaining([
        ["primary", "background", 4.5],
        ["text", "surface", 4.5],
        ["error", "surface", 4.5],
        ["onPrimary", "primary", 4.5],
        ["onSecondary", "secondary", 4.5],
      ]),
    );
  });
});

describe("applyTheme", () => {
  it("[OFE-003 AC1] falls back to the neutral palette when the primary colour has too little contrast", () => {
    const result = applyTheme(branding(LOW_CONTRAST_PRIMARY));

    expect(result.neutral).toBe(true);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ foreground: "primary", background: "background", minimum: 4.5 }),
      ]),
    );
    expect(result.failures.every((failure) => failure.ratio < failure.minimum)).toBe(true);
    // Every colour is the neutral one, not only primary: secondary (#7c2d12 passes on its own) is reset too.
    expect(appliedColors()).toEqual({ ...NEUTRAL_PALETTE });
    // Radius and fonts still apply: only the colours fall back.
    expect(root().style.getPropertyValue("--vx-radius")).toBe("1rem");
    expect(root().style.getPropertyValue("--vx-font-body")).toBe(FONT_STACKS["Lato"]);
  });

  it("[OFE-003 AC1] applies a palette that passes, with the text colour on primary and secondary computed", () => {
    const result = applyTheme(branding(DARK_BRAND));

    expect(result).toMatchObject({ neutral: false, invalid: [], failures: [] });
    expect(appliedColors()).toEqual({
      primary: "#93c5fd",
      onPrimary: "#000000",
      secondary: "#000000",
      onSecondary: "#ffffff",
      accent: "#5eead4",
      background: "#111827",
      surface: "#1f2937",
      text: "#f9fafb",
      mutedText: "#d1d5db",
      success: "#86efac",
      warning: "#fcd34d",
      error: "#fca5a5",
    });
  });

  it("[OFE-003] falls back to the neutral palette for colours that are not #RRGGBB, without setting them", () => {
    for (const bad of [
      "red",
      "#fff",
      "var(--vx-bg)",
      "url(https://evil.example/x.png)",
      "#0000ff; color: red",
      "",
    ]) {
      root().removeAttribute("style");
      const result = resolvePalette({ ...DARK_BRAND, background: bad });
      expect(result, bad).toMatchObject({ neutral: true, invalid: ["background"] });

      applyTheme(branding({ ...DARK_BRAND, background: bad }));
      expect(appliedColors(), bad).toEqual({ ...NEUTRAL_PALETTE });
      expect(root().getAttribute("style") ?? "", bad).not.toMatch(/url\(|var\(|red|evil/);
    }
    expect(resolvePalette(undefined)).toMatchObject({ neutral: true });
  });

  it("[OFE-003] maps the corner radius and the bundled fonts, and keeps the defaults for unknown values", () => {
    applyTheme(branding(DARK_BRAND, { cornerRadius: "none" }));
    expect(root().style.getPropertyValue("--vx-radius")).toBe("0");
    expect(root().style.getPropertyValue("--vx-font-heading")).toBe('"Playfair Display", Georgia, serif');
    expect(root().style.getPropertyValue("--vx-font-body")).toBe('"Lato", system-ui, sans-serif');

    root().removeAttribute("style");
    applyTheme(
      branding(DARK_BRAND, {
        cornerRadius: "huge",
        fonts: { heading: { family: "Comic Sans MS" }, body: { family: 'x"; } body { color: red' } },
      }),
    );
    expect(root().style.getPropertyValue("--vx-radius")).toBe("");
    expect(root().style.getPropertyValue("--vx-font-heading")).toBe("");
    expect(root().style.getPropertyValue("--vx-font-body")).toBe("");

    expect(fontStack("Inter")).toBe('"Inter", system-ui, sans-serif');
    expect(fontStack({ family: "toString" })).toBeNull();
    expect(fontStack(null)).toBeNull();
  });

  it("[OFE-003] bundles exactly the font families of the OTA API's StorefrontFontFamily enum", () => {
    expect(fontFamilies.length).toBeGreaterThan(0);
    expect(Object.keys(FONT_STACKS).sort()).toEqual([...fontFamilies].sort());
  });

  it("[OFE-003] sets the favicon from a same-origin path or a data: image only", () => {
    expect(applyFavicon("/api/v1/assets/demo/ast_1.png")).toBe(true);
    const link = /** @type {HTMLLinkElement} */ (document.head.querySelector('link[rel="icon"]'));
    expect(link.getAttribute("href")).toBe("/api/v1/assets/demo/ast_1.png");

    // The API's placeholder badge: an SVG with `<`, `>`, `#` and white space percent-encoded.
    const badge = "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E";
    expect(applyFavicon(badge)).toBe(true);
    expect(link.getAttribute("href")).toBe(badge);
    expect(document.head.querySelectorAll("link").length).toBe(1);

    for (const unsafe of [
      "https://evil.example/favicon.ico",
      "//evil.example/favicon.ico",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "/\tjavascript:alert(1)",
      "",
      null,
    ]) {
      expect(applyFavicon(unsafe), String(unsafe)).toBe(false);
      expect(safeImageUrl(unsafe), String(unsafe)).toBeNull();
    }
    expect(link.getAttribute("href")).toBe(badge);
  });
});

describe("no CSS text", () => {
  it("[OFE-003 AC3] applies the theme with style.setProperty only: no <style>, stylesheet, cssText or style string", () => {
    const setProperty = vi.spyOn(root().style, "setProperty");
    const cssText = vi.spyOn(Object.getPrototypeOf(root().style), "cssText", "set");
    // The added nodes are read synchronously with takeRecords(), so no timer has to deliver them.
    const observer = new MutationObserver(() => {});
    observer.observe(document, { childList: true, subtree: true });
    const sheets = document.styleSheets.length;

    applyTheme(branding(DARK_BRAND));
    applyTheme(branding(LOW_CONTRAST_PRIMARY));
    const added = observer.takeRecords().flatMap((record) => Array.from(record.addedNodes));
    observer.disconnect();

    expect(setProperty).toHaveBeenCalled();
    for (const [property, value] of setProperty.mock.calls) {
      expect(property).toMatch(/^--vx-[a-z-]+$/);
      expect(String(value)).not.toMatch(/[;{}]|url\(/);
    }
    expect(cssText).not.toHaveBeenCalled();
    expect(
      added.filter(
        (node) =>
          node.nodeName === "STYLE" ||
          (node.nodeName === "LINK" &&
            /stylesheet/i.test(String(/** @type {Element} */ (node).getAttribute("rel")))),
      ),
    ).toEqual([]);
    expect(document.styleSheets.length).toBe(sheets);
    // What <html> carries is custom properties only.
    const declarations = (root().getAttribute("style") ?? "")
      .split(";")
      .map((declaration) => declaration.trim())
      .filter((declaration) => declaration !== "");
    expect(declarations.length).toBeGreaterThanOrEqual(Object.keys(COLOR_PROPERTIES).length);
    expect(declarations.filter((declaration) => !/^--vx-[a-z-]+:/.test(declaration))).toEqual([]);
  });

  it("[OFE-003 AC3] no storefront module writes CSS text: only style.setProperty and getPropertyValue", () => {
    const forbidden = [
      /\bcssText\b/,
      /\binsertRule\s*\(/,
      /\breplaceSync\s*\(/,
      /\badoptedStyleSheets\b/,
      /\bCSSStyleSheet\b/,
      /createElement\(\s*["'`]style["'`]/,
      /setAttribute\(\s*["'`]style["'`]/,
      /\.style\s*=(?!=)/,
      /\bstyle\.(?!setProperty\b|getPropertyValue\b|removeProperty\b)[A-Za-z]+/,
      /<style\b/i,
      /\sstyle\s*=\s*\\?["']/,
    ];
    expect(sources.length).toBeGreaterThanOrEqual(10);
    for (const [file, code] of sources) {
      for (const pattern of forbidden) {
        expect(code, `${file} ${pattern}`).not.toMatch(pattern);
      }
    }
    // The theme module does use setProperty (the scan above is not passing by reading nothing).
    expect(sources.find(([file]) => file === join("lib", "theme.js"))?.[1]).toMatch(/style\.setProperty\(/);
  });
});
