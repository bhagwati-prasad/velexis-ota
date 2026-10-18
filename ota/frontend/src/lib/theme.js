// The OTA's branding on the storefront (ota/frontend/README.md §6, OADR-0012 point 4, OADR-0015 point 2): the colours,
// corner radius and fonts of `storefront.get` become the `--vx-*` CSS custom properties that src/styles/main.css
// declares and the Tailwind utilities read (`bg-primary`, `text-ink`, `rounded-ui`, `font-heading`, …). They are set
// one by one with `style.setProperty` on `<html>`, which the strict `style-src 'self'` CSP allows; no CSS text is ever
// injected (no <style>, no `cssText`, no `style` attribute string, no `insertRule`), and custom CSS is not offered.
//
// - Colours must be `#RRGGBB`. `--vx-on-primary` and `--vx-on-secondary` are computed (white or black, whichever
//   contrasts more, which always reaches 4.5:1), like the API's own `onPrimary`.
// - Contrast: every text colour (text, muted text, links in the primary colour, accent, success, warning, error) must
//   reach 4.5:1 on the page background and on panels (WCAG 2.2 AA, 1.4.3). One invalid colour or one pair below its
//   minimum and the whole neutral palette is used instead, because mixing neutral and brand colours could create new
//   low-contrast pairs. The OTA admin warns when an OTA picks such colours; `CONTRAST_RULES` is the list it checks.
// - Fonts come from the families bundled with the build (the `StorefrontFontFamily` enum; files in public/fonts/);
//   an unknown family keeps the default. Fonts are never loaded from `StorefrontFont.cssUrl` (`font-src 'self'`).
// - The favicon is the `<link rel="icon">` of the page, and only a same-origin path or a `data:` image is accepted
//   (`img-src 'self' data:`); anything else keeps the page's default.

import { hasUnsafeUrlCharacter, safeUrl } from "./url.js";

/** @typedef {import("@velexis/ota-sdk").Schemas["StorefrontBranding"]} StorefrontBranding */
/** @typedef {keyof StorefrontBranding["colors"]} ColorName */
/** @typedef {Exclude<ColorName, "onPrimary">} BrandColorName */
/** @typedef {Record<BrandColorName, string> & { onPrimary: string, onSecondary: string }} Palette */

/**
 * The neutral palette of src/styles/main.css (`:root`), used until `storefront.get` answers and whenever the OTA's
 * colours fail a contrast rule. Every pair of CONTRAST_RULES passes with it (test/theme.test.js compares both files).
 * @type {Readonly<Palette>}
 */
export const NEUTRAL_PALETTE = Object.freeze({
  primary: "#1d4ed8",
  onPrimary: "#ffffff",
  secondary: "#0f172a",
  onSecondary: "#ffffff",
  accent: "#0e7490",
  background: "#ffffff",
  surface: "#f8fafc",
  text: "#0f172a",
  mutedText: "#475569",
  success: "#15803d",
  warning: "#b45309",
  error: "#b91c1c",
});

/** The custom property of each palette colour (src/styles/main.css, header comment). */
export const COLOR_PROPERTIES = Object.freeze({
  primary: "--vx-primary",
  onPrimary: "--vx-on-primary",
  secondary: "--vx-secondary",
  onSecondary: "--vx-on-secondary",
  accent: "--vx-accent",
  background: "--vx-bg",
  surface: "--vx-panel",
  text: "--vx-text",
  mutedText: "--vx-muted",
  success: "--vx-success",
  warning: "--vx-warning",
  error: "--vx-error",
});

/** The colours an OTA chooses (`onPrimary` and `onSecondary` are computed). */
const BRAND_COLORS = /** @type {const} */ ([
  "primary",
  "secondary",
  "accent",
  "background",
  "surface",
  "text",
  "mutedText",
  "success",
  "warning",
  "error",
]);

/** WCAG 2.2 AA minimum contrast of normal text (1.4.3). */
export const MIN_TEXT_CONTRAST = 4.5;

/** The colours used as text (`text-ink`, `text-muted`, links, `text-accent`, status and error messages). */
const TEXT_COLORS = /** @type {const} */ ([
  "text",
  "mutedText",
  "primary",
  "accent",
  "success",
  "warning",
  "error",
]);

/**
 * The colour pairs that must reach their minimum contrast: `[foreground, background, minimum]`. Text colours on the
 * page background and on panels (cards, the error summary), and the computed text colours of buttons (primary) and of
 * the header and footer (secondary).
 * @type {ReadonlyArray<readonly [keyof Palette, keyof Palette, number]>}
 */
export const CONTRAST_RULES = Object.freeze([
  ...TEXT_COLORS.flatMap((foreground) =>
    /** @type {const} */ (["background", "surface"]).map(
      (background) => /** @type {const} */ ([foreground, background, MIN_TEXT_CONTRAST]),
    ),
  ),
  /** @type {const} */ (["onPrimary", "primary", MIN_TEXT_CONTRAST]),
  /** @type {const} */ (["onSecondary", "secondary", MIN_TEXT_CONTRAST]),
]);

/** `cornerRadius` → `--vx-radius` (medium is the default of main.css). */
export const RADIUS_VALUES = Object.freeze({ none: "0", small: "0.25rem", medium: "0.5rem", large: "1rem" });

/**
 * The font families bundled with the build (`StorefrontFontFamily` of the OTA API) and their CSS font stacks. The
 * default `--vx-font-body` of main.css is the Inter stack.
 * @type {Readonly<Record<string, string>>}
 */
export const FONT_STACKS = Object.freeze({
  Inter: '"Inter", system-ui, sans-serif',
  Roboto: '"Roboto", system-ui, sans-serif',
  "Open Sans": '"Open Sans", system-ui, sans-serif',
  Lato: '"Lato", system-ui, sans-serif',
  Montserrat: '"Montserrat", system-ui, sans-serif',
  "Source Sans 3": '"Source Sans 3", system-ui, sans-serif',
  Merriweather: '"Merriweather", Georgia, serif',
  "Playfair Display": '"Playfair Display", Georgia, serif',
});

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
/** Raster images and SVG as an image (an SVG favicon or `<img>` runs no script); never `data:text/html` and the like. */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp|gif|x-icon|vnd\.microsoft\.icon|svg\+xml)[;,]/i;
const WHITE = "#ffffff";
const BLACK = "#000000";

/**
 * Whether `value` is a `#RRGGBB` colour.
 * @param {unknown} value
 * @returns {value is string}
 */
export const isHexColor = (value) => typeof value === "string" && HEX_COLOR.test(value);

/**
 * The WCAG relative luminance of a `#RRGGBB` colour (0 for black, 1 for white).
 * @param {string} hex
 */
export function relativeLuminance(hex) {
  /** @param {number} offset */
  const channel = (offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * The WCAG contrast ratio of two `#RRGGBB` colours, from 1 to 21.
 * @param {string} first
 * @param {string} second
 */
export function contrastRatio(first, second) {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

/**
 * White or black text on `background`, whichever contrasts more (the rule of the API's `onPrimary`). Either reaches
 * at least 4.58:1 on any colour.
 * @param {string} background `#RRGGBB`
 */
export function textColorOn(background) {
  const light = relativeLuminance(background);
  return 1.05 / (light + 0.05) >= (light + 0.05) / 0.05 ? WHITE : BLACK;
}

/**
 * The pairs of `palette` below their minimum contrast.
 * @param {Readonly<Palette>} palette
 * @returns {Array<{ foreground: keyof Palette, background: keyof Palette, ratio: number, minimum: number }>}
 */
export function contrastFailures(palette) {
  return CONTRAST_RULES.flatMap(([foreground, background, minimum]) => {
    const ratio = contrastRatio(palette[foreground], palette[background]);
    return ratio >= minimum ? [] : [{ foreground, background, ratio, minimum }];
  });
}

/**
 * The palette to apply for the OTA's colours: theirs, with the computed text colours on primary and secondary, when
 * every colour is `#RRGGBB` and every pair of CONTRAST_RULES passes; else the neutral palette.
 * @param {Partial<Record<ColorName, unknown>> | null | undefined} colors `branding.colors` of `storefront.get`
 * @returns {{ palette: Readonly<Palette>, neutral: boolean, invalid: BrandColorName[], failures: ReturnType<typeof contrastFailures> }}
 */
export function resolvePalette(colors) {
  const source = colors ?? {};
  const invalid = BRAND_COLORS.filter((name) => !isHexColor(source[name]));
  if (invalid.length > 0) {
    return { palette: NEUTRAL_PALETTE, neutral: true, invalid, failures: [] };
  }
  const chosen = /** @type {Record<BrandColorName, string>} */ (
    Object.fromEntries(BRAND_COLORS.map((name) => [name, String(source[name]).toLowerCase()]))
  );
  /** @type {Palette} */
  const palette = {
    ...chosen,
    onPrimary: textColorOn(chosen.primary),
    onSecondary: textColorOn(chosen.secondary),
  };
  const failures = contrastFailures(palette);
  return failures.length > 0
    ? { palette: NEUTRAL_PALETTE, neutral: true, invalid, failures }
    : { palette: Object.freeze(palette), neutral: false, invalid, failures };
}

/**
 * The font stack of a bundled family, or `null` for any other value.
 * @param {unknown} font `StorefrontFont` (its `family` is read) or a family name
 * @returns {string | null}
 */
export function fontStack(font) {
  const family =
    font !== null && typeof font === "object" ? /** @type {{ family?: unknown }} */ (font).family : font;
  return typeof family === "string" && Object.hasOwn(FONT_STACKS, family)
    ? (FONT_STACKS[family] ?? null)
    : null;
}

/**
 * An image URL the storefront may load under its CSP (`img-src 'self' data:`): a same-origin path such as
 * `/api/v1/assets/<key>/ast_….png`, or a `data:` raster or SVG image. `null` for anything else (absolute URLs of
 * other hosts, `javascript:`, `data:text/html`, control characters).
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeImageUrl(value) {
  if (typeof value !== "string" || value === "" || hasUnsafeUrlCharacter(value)) {
    return null;
  }
  if (DATA_IMAGE.test(value)) {
    return value;
  }
  const path = safeUrl(value, []);
  return path !== null && path.startsWith("/") ? path : null;
}

/**
 * Points the page's `<link rel="icon">` (created when the page has none) at the OTA's favicon. An unsafe URL changes
 * nothing. Returns whether the favicon was set.
 * @param {unknown} url `branding.faviconUrl`
 * @param {Document} [doc]
 */
export function applyFavicon(url, doc = document) {
  const href = safeImageUrl(url);
  if (href === null) {
    return false;
  }
  let link = /** @type {HTMLLinkElement | null} */ (doc.head.querySelector('link[rel~="icon"]'));
  if (!link) {
    link = doc.createElement("link");
    link.rel = "icon";
    doc.head.append(link);
  }
  link.removeAttribute("type");
  link.href = href;
  return true;
}

/**
 * Applies the OTA's branding to the page: colours (or the neutral palette), corner radius and fonts as `--vx-*`
 * custom properties with `style.setProperty` on `<html>`, and the favicon. Unknown radius or font values keep the
 * defaults of main.css. Returns the palette used and why the neutral one was chosen, if it was.
 * @param {Partial<StorefrontBranding> | null | undefined} branding `config.branding` of `storefront.get`
 * @param {{ doc?: Document }} [options]
 * @returns {ReturnType<typeof resolvePalette>}
 */
export function applyTheme(branding, { doc = document } = {}) {
  const { style } = doc.documentElement;
  const result = resolvePalette(branding?.colors);
  for (const [name, property] of Object.entries(COLOR_PROPERTIES)) {
    style.setProperty(property, result.palette[/** @type {keyof Palette} */ (name)]);
  }
  const radius = branding?.cornerRadius;
  if (typeof radius === "string" && Object.hasOwn(RADIUS_VALUES, radius)) {
    style.setProperty("--vx-radius", RADIUS_VALUES[/** @type {keyof typeof RADIUS_VALUES} */ (radius)]);
  }
  const body = fontStack(branding?.fonts?.body);
  const heading = fontStack(branding?.fonts?.heading);
  if (body !== null) {
    style.setProperty("--vx-font-body", body);
  }
  if (heading !== null) {
    style.setProperty("--vx-font-heading", heading);
  }
  applyFavicon(branding?.faviconUrl, doc);
  return result;
}
