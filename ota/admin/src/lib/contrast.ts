// WCAG contrast of an OTA's storefront colours, as the OTA admin's theme editor warns about it (OAD-014; README §9
// "Theme editor", ota/frontend/README.md §6, OADR-0012 point 4). The hosted storefront applies the colours of
// `StorefrontSettingsBranding.colors` only when every text colour reaches 4.5:1 on the page background and on panels
// and the computed text on the primary and secondary colours does too (WCAG 2.2 AA, 1.4.3); one invalid colour or one
// pair below its minimum and it uses its whole neutral palette instead (`resolvePalette` of
// ota/frontend/src/lib/theme.js). This module repeats that rule, so the admin can say before saving that the
// storefront would fall back: the same pairs (`CONTRAST_RULES`), the same neutral palette, the same luminance and the
// same black-or-white text on primary and secondary. contrast.test.ts compares both modules, so they cannot drift.
//
// The console edits five colours (primary, secondary, accent, background, text). The storefront's other colours
// (panels, muted text, success, warning, error) are not in the console's settings; the storefront uses its neutral
// values for them, and so does this check.
//
// No server-only import and no SDK import: the theme editor (a client component) and its tests use it.

/** WCAG 2.2 AA minimum contrast of normal text (1.4.3), the storefront's `MIN_TEXT_CONTRAST`. */
export const MIN_TEXT_CONTRAST = 4.5;

/** The colours staff choose in the console (`StorefrontSettingsBranding.colors`). */
export const BRAND_COLOR_NAMES = Object.freeze([
  "primary",
  "secondary",
  "accent",
  "background",
  "text",
] as const);

/** A colour staff choose. */
export type BrandColorName = (typeof BRAND_COLOR_NAMES)[number];

/** Every colour of the storefront's palette: the chosen ones, the neutral ones and the two computed text colours. */
export type PaletteColorName =
  BrandColorName | "surface" | "mutedText" | "success" | "warning" | "error" | "onPrimary" | "onSecondary";

/** A whole palette, every colour `#rrggbb`. */
export type Palette = Readonly<Record<PaletteColorName, string>>;

/**
 * The storefront's neutral palette (`NEUTRAL_PALETTE` of ota/frontend/src/lib/theme.js, the `:root` of its main.css):
 * what it shows before `storefront.get` answers and whenever the OTA's colours fail a rule. Every rule passes with it.
 */
export const STOREFRONT_NEUTRAL_PALETTE: Palette = Object.freeze({
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

/** The colours the storefront uses as text: body text, muted text, links (primary), accent, status messages. */
const TEXT_COLORS = Object.freeze([
  "text",
  "mutedText",
  "primary",
  "accent",
  "success",
  "warning",
  "error",
] as const);

/** The backgrounds text sits on: the page and the panels (cards, the error summary). */
const TEXT_BACKGROUNDS = Object.freeze(["background", "surface"] as const);

/** One rule: `foreground` on `background` reaches `minimum`. */
export type ContrastRule = readonly [
  foreground: PaletteColorName,
  background: PaletteColorName,
  minimum: number,
];

/**
 * The pairs that must reach their minimum contrast, in the storefront's order (`CONTRAST_RULES` of theme.js): every
 * text colour on the page background and on panels, then the computed text on primary (buttons) and on secondary
 * (header and footer).
 */
export const CONTRAST_RULES: readonly ContrastRule[] = Object.freeze([
  ...TEXT_COLORS.flatMap((foreground) =>
    TEXT_BACKGROUNDS.map((background): ContrastRule => [foreground, background, MIN_TEXT_CONTRAST]),
  ),
  ["onPrimary", "primary", MIN_TEXT_CONTRAST],
  ["onSecondary", "secondary", MIN_TEXT_CONTRAST],
]);

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const WHITE = "#ffffff";
const BLACK = "#000000";

/** Whether `value` is a `#RRGGBB` colour (the pattern of the API's colour fields). */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

/** The WCAG relative luminance of a `#RRGGBB` colour: 0 for black, 1 for white. */
export function relativeLuminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** The WCAG contrast ratio of two `#RRGGBB` colours, from 1 to 21, whichever is lighter. */
export function contrastRatio(first: string, second: string): number {
  const one = relativeLuminance(first);
  const two = relativeLuminance(second);
  const [lighter, darker] = one >= two ? [one, two] : [two, one];
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * White or black text on `background`, whichever contrasts more: the storefront's `textColorOn` and the API's
 * `onPrimary`. Either reaches at least 4.58:1 on any colour.
 */
export function textColorOn(background: string): string {
  const light = relativeLuminance(background);
  return 1.05 / (light + 0.05) >= (light + 0.05) / 0.05 ? WHITE : BLACK;
}

/**
 * The palette the storefront would apply for `colors` (all five valid): the chosen colours in lower case, the
 * storefront's neutral values for the colours the console does not edit, and the computed text on primary and
 * secondary.
 */
export function storefrontPalette(colors: Readonly<Record<BrandColorName, string>>): Palette {
  const chosen = Object.fromEntries(
    BRAND_COLOR_NAMES.map((name) => [name, colors[name].toLowerCase()]),
  ) as Record<BrandColorName, string>;
  return Object.freeze({
    ...STOREFRONT_NEUTRAL_PALETTE,
    ...chosen,
    onPrimary: textColorOn(chosen.primary),
    onSecondary: textColorOn(chosen.secondary),
  });
}

/** A pair below its minimum contrast. */
export interface ContrastFailure {
  readonly foreground: PaletteColorName;
  readonly background: PaletteColorName;
  /** The pair's contrast ratio. */
  readonly ratio: number;
  readonly minimum: number;
}

/** The pairs of `palette` below their minimum contrast, in the order of `CONTRAST_RULES`. */
export function contrastFailures(palette: Palette): ContrastFailure[] {
  return CONTRAST_RULES.flatMap(([foreground, background, minimum]) => {
    const ratio = contrastRatio(palette[foreground], palette[background]);
    return ratio >= minimum ? [] : [{ foreground, background, ratio, minimum }];
  });
}

/** What the storefront would do with a set of colours. */
export interface ThemeCheck {
  /** The colours that are not `#RRGGBB` (the API refuses them too). */
  readonly invalid: readonly BrandColorName[];
  /** The pairs below their minimum; empty while a colour is invalid (nothing to measure). */
  readonly failures: readonly ContrastFailure[];
  /** The storefront would use its neutral palette instead of these colours. */
  readonly fallsBack: boolean;
  /** The palette it would apply: the OTA's, or the neutral one when it falls back. */
  readonly palette: Palette;
}

/**
 * The storefront's verdict on `colors` (`resolvePalette` of theme.js): with one colour that is not `#RRGGBB` or one
 * pair below its minimum, the whole neutral palette; otherwise the OTA's palette.
 */
export function checkBrandColors(colors: Readonly<Partial<Record<BrandColorName, unknown>>>): ThemeCheck {
  const invalid = BRAND_COLOR_NAMES.filter((name) => !isHexColor(colors[name]));
  if (invalid.length > 0) {
    return { invalid, failures: [], fallsBack: true, palette: STOREFRONT_NEUTRAL_PALETTE };
  }
  const palette = storefrontPalette(colors as Record<BrandColorName, string>);
  const failures = contrastFailures(palette);
  return failures.length > 0
    ? { invalid, failures, fallsBack: true, palette: STOREFRONT_NEUTRAL_PALETTE }
    : { invalid, failures, fallsBack: false, palette };
}

/**
 * A contrast ratio as staff read it: two decimals, rounded down, so a pair just below its minimum never shows the
 * minimum itself (4.499 is "4.49:1", not "4.50:1").
 */
export function formatRatio(ratio: number): string {
  return `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;
}

/** The colours by the names staff see in the theme editor. */
export const PALETTE_COLOR_LABELS: Readonly<Record<PaletteColorName, string>> = Object.freeze({
  primary: "the primary colour (links)",
  secondary: "the secondary colour (header and footer)",
  accent: "the accent colour",
  background: "the page background",
  text: "the body text",
  surface: "panels",
  mutedText: "muted text",
  success: "success messages",
  warning: "warnings",
  error: "error messages",
  onPrimary: "button text",
  onSecondary: "header text",
});

/** One failing pair in words: "The body text on the page background is 2.84:1; it needs 4.5:1." */
export function describeFailure(failure: ContrastFailure): string {
  const foreground = PALETTE_COLOR_LABELS[failure.foreground];
  const sentence = `${foreground.charAt(0).toUpperCase()}${foreground.slice(1)} on ${PALETTE_COLOR_LABELS[failure.background]}`;
  return `${sentence} is ${formatRatio(failure.ratio)}; it needs ${failure.minimum}:1.`;
}
