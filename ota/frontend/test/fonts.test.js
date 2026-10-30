// @vitest-environment node
// The bundled storefront fonts (OADR-0015 point 8, ota/frontend/README.md §6 and §9, public/fonts/README.md):
// src/styles/fonts.css declares exactly the font families of the OTA API's `StorefrontFontFamily` enum (the enum of
// `StorefrontSettings.branding.fonts`, which the OTA admin offers and the API validates), each with its woff2 files
// from public/fonts/ under an open licence, served from the storefront's own origin (`font-src 'self'`), and any two
// families together fit the page budget of 120 KB.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { FONT_STACKS } from "../src/lib/theme.js";
import { REPO_ROOT, STOREFRONT_ROOT } from "./helpers/storefront.js";

const FONTS_CSS = join(STOREFRONT_ROOT, "src", "styles", "fonts.css");
const PUBLIC_DIR = join(STOREFRONT_ROOT, "public");
const OPENAPI = join(REPO_ROOT, "ota", "backend", "openapi", "velexis-ota-booking-api.openapi.yaml");
const GENERATED_TYPES = join(REPO_ROOT, "packages", "api-types", "src", "generated", "ota.ts");
/** README §9: at most 2 families and 120 KB of fonts per page. */
const PAGE_FONT_BUDGET = 120 * 1024;
/** The weights the pages use: 400 (body text, `font-medium`) and 600 (`font-semibold`, the headings). */
const REGULAR = 400;
const SEMIBOLD = 600;

/**
 * One `@font-face` rule of fonts.css.
 * @typedef {{ family: string, style: string, weight: number, display: string, src: string, file: string }} FontFace
 */

/** @type {FontFace[]} */
let faces = [];
/** The enum values of `StorefrontFontFamily` in the OpenAPI document. */
let openApiFamilies = /** @type {string[]} */ ([]);
/** The same enum in the generated types of @velexis/api-types. */
let generatedFamilies = /** @type {string[]} */ ([]);

/** The value of one declaration of a rule body (`font-weight: 400;` → "400"), or "". */
const declaration = (/** @type {string} */ body, /** @type {string} */ name) =>
  new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;]+);`).exec(body)?.[1]?.trim() ?? "";

/** The file of a `src` that is exactly one same-origin woff2 URL, or "". */
const woff2File = (/** @type {string} */ src) =>
  /^url\("(\/fonts\/[a-z0-9-]+\/[a-z0-9-]+\.woff2)"\)\s+format\("woff2"\)$/.exec(src)?.[1] ?? "";

/** The face a browser uses for `weight` among a family's faces (CSS Fonts 4 §5.2 font matching, normal style). */
function matchFace(/** @type {FontFace[]} */ familyFaces, /** @type {number} */ weight) {
  const sorted = [...familyFaces].sort((a, b) => a.weight - b.weight);
  const exact = sorted.find((face) => face.weight === weight);
  if (exact) {
    return exact;
  }
  const lighter = sorted.filter((face) => face.weight < weight).reverse();
  const heavier = sorted.filter((face) => face.weight > weight);
  if (weight > 500) {
    return heavier[0] ?? lighter[0];
  }
  const upTo500 = heavier.filter((face) => face.weight <= 500);
  return upTo500[0] ?? lighter[0] ?? heavier[0];
}

const fileOf = (/** @type {FontFace} */ face) => join(PUBLIC_DIR, ...face.file.split("/"));
const sizeOf = (/** @type {FontFace} */ face) => statSync(fileOf(face)).size;
const facesOf = (/** @type {string} */ family) => faces.filter((face) => face.family === family);

beforeAll(() => {
  // Reads fonts.css, the OpenAPI document (about 50 000 lines) and the generated types once: file system only.
  const css = readFileSync(FONTS_CSS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body = ""]) => {
    const src = declaration(body, "src");
    return {
      family: declaration(body, "font-family").replace(/^"(.*)"$/, "$1"),
      style: declaration(body, "font-style"),
      weight: Number(declaration(body, "font-weight")),
      display: declaration(body, "font-display"),
      src,
      file: woff2File(src),
    };
  });

  const yaml = readFileSync(OPENAPI, "utf8");
  const block =
    /\n {4}StorefrontFontFamily:\n {6}type: string\n {6}enum:\n((?: {8}- .+\n)+)/.exec(yaml)?.[1] ?? "";
  openApiFamilies = [...block.matchAll(/^ {8}- (.+)$/gm)].map((m) => (m[1] ?? "").replace(/^'(.*)'$/, "$1"));

  const types = readFileSync(GENERATED_TYPES, "utf8");
  const union = /StorefrontFontFamily:\s*([^;]+);/.exec(types)?.[1] ?? "";
  generatedFamilies = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
}, 10_000); // three file reads; generous for a cold CI disk

describe("fonts.css and the OTA API's StorefrontFontFamily enum", () => {
  it("[OFE-020] declares every font family of the enum, and no other", () => {
    expect(openApiFamilies.length).toBeGreaterThan(0);
    expect(generatedFamilies).toEqual(openApiFamilies);
    const declared = [...new Set(faces.map((face) => face.family))];
    expect([...declared].sort()).toEqual([...openApiFamilies].sort());
    // lib/theme.js maps the same names to their font stacks.
    expect(Object.keys(FONT_STACKS).sort()).toEqual([...declared].sort());
  });

  it("[OFE-020] gives every family a regular face and a face for font-semibold, normal style, font-display swap", () => {
    for (const family of openApiFamilies) {
      const familyFaces = facesOf(family);
      expect(
        familyFaces.map((face) => face.weight),
        family,
      ).toContain(REGULAR);
      expect(
        familyFaces.some((face) => face.weight >= SEMIBOLD),
        family,
      ).toBe(true);
      for (const face of familyFaces) {
        expect(face.style, `${family} ${face.weight}`).toBe("normal");
        expect(face.display, `${family} ${face.weight}`).toBe("swap");
      }
      expect(new Set(familyFaces.map((face) => face.weight)).size, family).toBe(familyFaces.length);
    }
  });
});

describe("the bundled files (public/fonts/)", () => {
  it("[OFE-020] loads every face from one same-origin woff2 file that exists, with its open licence next to it", () => {
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      const label = `${face.family} ${face.weight}`;
      expect(face.file, `${label}: src ${face.src}`).not.toBe("");
      const file = fileOf(face);
      expect(existsSync(file), `${label}: ${face.file}`).toBe(true);
      expect(readFileSync(file).subarray(0, 4).toString("latin1"), `${label}: woff2 signature`).toBe("wOF2");
      const licence = join(dirname(file), "OFL.txt");
      expect(existsSync(licence), `${label}: ${posix.dirname(face.file)}/OFL.txt`).toBe(true);
      expect(readFileSync(licence, "utf8"), `${label}: licence`).toContain(
        "SIL Open Font License, Version 1.1",
      );
    }
  });

  it("[OFE-020] bundles no font file that fonts.css does not declare", () => {
    const fontsDir = join(PUBLIC_DIR, "fonts");
    const bundled = readdirSync(fontsDir, { recursive: true, encoding: "utf8" })
      .map((file) => `/fonts/${file.split(/[\\/]/).join("/")}`)
      .filter(
        (file) =>
          !file.endsWith(".md") && !file.endsWith("/OFL.txt") && statSync(join(PUBLIC_DIR, file)).isFile(),
      );
    expect(bundled.sort()).toEqual(faces.map((face) => face.file).sort());
  });

  it("[OFE-020] keeps any heading and body family together within the 120 KB page budget", () => {
    for (const heading of openApiFamilies) {
      for (const body of openApiFamilies) {
        const used = new Set([
          matchFace(facesOf(heading), SEMIBOLD),
          matchFace(facesOf(body), REGULAR),
          matchFace(facesOf(body), SEMIBOLD),
        ]);
        const bytes = [...used].reduce((sum, face) => sum + (face ? sizeOf(face) : 0), 0);
        expect(bytes, `${heading} headings on ${body} text`).toBeLessThanOrEqual(PAGE_FONT_BUDGET);
      }
    }
  });

  it("[OFE-020] picks the regular face for font-medium and the 600 (or 700) face for font-semibold", () => {
    const lato = facesOf("Lato");
    expect(matchFace(lato, 500)?.weight).toBe(400);
    expect(matchFace(lato, SEMIBOLD)?.weight).toBe(700);
    expect(matchFace(facesOf("Inter"), SEMIBOLD)?.weight).toBe(600);
  });
});
