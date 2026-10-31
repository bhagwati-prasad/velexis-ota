// The theme editor's contrast check (OAD-014, README §9 "Theme editor"): the WCAG ratios, the pairs the hosted
// storefront requires, the warning a low-contrast colour pair gives, and the same verdict as the storefront's own
// theme module (ota/frontend/src/lib/theme.js), which decides whether the OTA's colours or the neutral ones are shown.
import { fileURLToPath, pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  BRAND_COLOR_NAMES,
  CONTRAST_RULES,
  MIN_TEXT_CONTRAST,
  STOREFRONT_NEUTRAL_PALETTE,
  checkBrandColors,
  contrastFailures,
  contrastRatio,
  describeFailure,
  formatRatio,
  isHexColor,
  relativeLuminance,
  storefrontPalette,
  textColorOn,
  type BrandColorName,
} from "./contrast";

/** The storefront's colours of its neutral palette that staff choose (main.css `:root`). */
const NEUTRAL_BRAND: Readonly<Record<BrandColorName, string>> = Object.freeze({
  primary: STOREFRONT_NEUTRAL_PALETTE.primary,
  secondary: STOREFRONT_NEUTRAL_PALETTE.secondary,
  accent: STOREFRONT_NEUTRAL_PALETTE.accent,
  background: STOREFRONT_NEUTRAL_PALETTE.background,
  text: STOREFRONT_NEUTRAL_PALETTE.text,
});

describe("contrast ratios", () => {
  it("measures WCAG relative luminance and contrast", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 10);
    // The order of the two colours does not matter.
    expect(contrastRatio("#ffffff", "#777777")).toBe(contrastRatio("#777777", "#ffffff"));
    // #767676 is the lightest grey that passes 4.5:1 on white; #777777 just fails it.
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(MIN_TEXT_CONTRAST);
  });

  it("puts black or white text on a colour, whichever contrasts more, always at 4.5:1 or more", () => {
    expect(textColorOn("#ffeb3b")).toBe("#000000");
    expect(textColorOn("#0f172a")).toBe("#ffffff");
    for (const color of ["#777777", "#808080", "#1d4ed8", "#ff0000", "#00ff00", "#ffeb3b", "#0e7490"]) {
      expect(contrastRatio(textColorOn(color), color), color).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
  });

  it("formats a ratio rounded down, so a failing pair never shows its minimum", () => {
    expect(formatRatio(21)).toBe("21.00:1");
    expect(formatRatio(4.499_9)).toBe("4.49:1");
    expect(formatRatio(contrastRatio("#777777", "#ffffff"))).toBe("4.47:1");
  });

  it("accepts #RRGGBB colours only", () => {
    expect(isHexColor("#0B5FFF")).toBe(true);
    expect(isHexColor("#0b5fff")).toBe(true);
    for (const value of ["0b5fff", "#0b5ff", "#0b5fffa", "#0g5fff", "blue", "", null, undefined, 255]) {
      expect(isHexColor(value), String(value)).toBe(false);
    }
  });
});

describe("checkBrandColors", () => {
  it("[OAD-014 AC1] warns about a low-contrast colour pair: the storefront would use its neutral colours", () => {
    const check = checkBrandColors({ ...NEUTRAL_BRAND, text: "#999999" });

    expect(check.fallsBack).toBe(true);
    expect(check.invalid).toEqual([]);
    expect(check.palette).toBe(STOREFRONT_NEUTRAL_PALETTE);
    expect(check.failures.map(({ foreground, background }) => [foreground, background])).toEqual([
      ["text", "background"],
      ["text", "surface"],
    ]);
    expect(check.failures.map(describeFailure)).toEqual([
      "The body text on the page background is 2.84:1; it needs 4.5:1.",
      "The body text on panels is 2.72:1; it needs 4.5:1.",
    ]);
  });

  it("[OAD-014 AC1] warns about light links on a white page and dark text on a dark page", () => {
    expect(
      checkBrandColors({ ...NEUTRAL_BRAND, primary: "#38bdf8" }).failures.map((failure) => [
        failure.foreground,
        failure.background,
        formatRatio(failure.ratio),
      ]),
    ).toEqual([
      ["primary", "background", "2.14:1"],
      ["primary", "surface", "2.04:1"],
    ]);
    // A dark page: the body text, the muted text, the links, the accent and the status colours all fail on it.
    const dark = checkBrandColors({ ...NEUTRAL_BRAND, background: "#111827" });
    expect(dark.fallsBack).toBe(true);
    expect(dark.failures.every((failure) => failure.background === "background")).toBe(true);
    expect(dark.failures.map((failure) => failure.foreground)).toEqual([
      "text",
      "mutedText",
      "primary",
      "accent",
      "success",
      "warning",
      "error",
    ]);
  });

  it("keeps the OTA's colours when every pair passes, with the computed text on primary and secondary", () => {
    const check = checkBrandColors({
      primary: "#0B5FFF",
      secondary: "#FFEB3B",
      accent: "#B45309",
      background: "#FFFFFF",
      text: "#111827",
    });

    expect(check).toMatchObject({ fallsBack: false, invalid: [], failures: [] });
    expect(check.palette).toMatchObject({
      primary: "#0b5fff",
      onPrimary: "#ffffff",
      secondary: "#ffeb3b",
      onSecondary: "#000000",
      background: "#ffffff",
      text: "#111827",
      // The colours the console does not edit stay the storefront's neutral ones.
      surface: STOREFRONT_NEUTRAL_PALETTE.surface,
      mutedText: STOREFRONT_NEUTRAL_PALETTE.mutedText,
    });
  });

  it("falls back for a colour that is not #RRGGBB, without measuring", () => {
    expect(checkBrandColors({ ...NEUTRAL_BRAND, accent: "teal", text: undefined })).toEqual({
      invalid: ["accent", "text"],
      failures: [],
      fallsBack: true,
      palette: STOREFRONT_NEUTRAL_PALETTE,
    });
  });

  it("passes every rule with the neutral palette", () => {
    expect(contrastFailures(STOREFRONT_NEUTRAL_PALETTE)).toEqual([]);
    expect(checkBrandColors(NEUTRAL_BRAND).fallsBack).toBe(false);
  });
});

/** What this test reads of the storefront's theme module. */
interface StorefrontTheme {
  readonly NEUTRAL_PALETTE: Readonly<Record<string, string>>;
  readonly CONTRAST_RULES: readonly (readonly [string, string, number])[];
  readonly MIN_TEXT_CONTRAST: number;
  contrastRatio(first: string, second: string): number;
  textColorOn(background: string): string;
  resolvePalette(colors: Readonly<Record<string, string>>): {
    readonly neutral: boolean;
    readonly failures: readonly { readonly foreground: string; readonly background: string }[];
  };
}

describe("the storefront's own rule (ota/frontend/src/lib/theme.js)", () => {
  let theme: StorefrontTheme;

  // Once per file: loading the storefront's module (and its URL helpers) in a fresh worker.
  beforeAll(async () => {
    const file = fileURLToPath(new URL("../../../frontend/src/lib/theme.js", import.meta.url));
    theme = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as StorefrontTheme;
  }, 30_000); // A hook budget for the cold import, never a test's own timeout.

  it("checks the same pairs with the same minimum and the same neutral palette", () => {
    expect(MIN_TEXT_CONTRAST).toBe(theme.MIN_TEXT_CONTRAST);
    expect(CONTRAST_RULES.map((rule) => [...rule])).toEqual(theme.CONTRAST_RULES.map((rule) => [...rule]));
    expect({ ...STOREFRONT_NEUTRAL_PALETTE }).toEqual({ ...theme.NEUTRAL_PALETTE });
  });

  it("gives the same ratios, text colours and verdicts", () => {
    const samples: readonly Readonly<Record<BrandColorName, string>>[] = [
      NEUTRAL_BRAND,
      { ...NEUTRAL_BRAND, text: "#999999" },
      { ...NEUTRAL_BRAND, primary: "#38bdf8" },
      { ...NEUTRAL_BRAND, background: "#111827" },
      { ...NEUTRAL_BRAND, accent: "#777777", text: "#767676" },
      { primary: "#0b5fff", secondary: "#ffeb3b", accent: "#b45309", background: "#ffffff", text: "#111827" },
    ];
    for (const colors of samples) {
      const ours = checkBrandColors(colors);
      // The storefront reads its other colours from storefront.get; the console leaves them neutral.
      const theirs = theme.resolvePalette({ ...theme.NEUTRAL_PALETTE, ...colors });
      expect(ours.fallsBack, JSON.stringify(colors)).toBe(theirs.neutral);
      expect(ours.failures.map(({ foreground, background }) => ({ foreground, background }))).toEqual(
        theirs.failures.map(({ foreground, background }) => ({ foreground, background })),
      );
      for (const name of BRAND_COLOR_NAMES) {
        expect(textColorOn(colors[name])).toBe(theme.textColorOn(colors[name]));
        expect(contrastRatio(colors[name], "#ffffff")).toBe(theme.contrastRatio(colors[name], "#ffffff"));
      }
    }
    expect(storefrontPalette(NEUTRAL_BRAND)).toEqual(STOREFRONT_NEUTRAL_PALETTE);
  });
});
