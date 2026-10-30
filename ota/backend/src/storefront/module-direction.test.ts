// The storefront context imports nothing of the settings context (lead decision (2a) of 2026-10-30, FIX-W34-OTA;
// OADR-0012's revision of that day): the settings context edits what the storefront reads and may depend on it
// (StorefrontRepository, the mapper), never the reverse, so the public reads (getPublicAsset, OBE-072's pages) stay
// in src/storefront with their own services. A source scan of every TypeScript file under src/storefront, tests
// included: each module specifier (static and type imports, re-exports, `import()` and `require()`, as TypeScript's
// pre-processor reads them) resolved against its file must not land under src/settings.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { APP_DIR } from "../config";

const STOREFRONT_DIR = join(APP_DIR, "src", "storefront");
const SETTINGS_DIR = join(APP_DIR, "src", "settings");

/** The TypeScript files under `dir`. */
function typeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return typeScriptFiles(path);
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** The module specifiers of `source` (the file at `file`) that resolve into src/settings. */
function settingsImportsOf(file: string, source: string): string[] {
  const { importedFiles } = ts.preProcessFile(source, true, true);
  return importedFiles
    .map((imported) => imported.fileName)
    .filter((specifier) => {
      if (!specifier.startsWith(".")) {
        return false;
      }
      const target = resolve(dirname(file), specifier);
      return target === SETTINGS_DIR || target.startsWith(`${SETTINGS_DIR}${sep}`);
    });
}

describe("the module direction settings → storefront", () => {
  it("finds an import of src/settings in each form a file can write it [FIX-W34-OTA AC1]", () => {
    const file = join(STOREFRONT_DIR, "example.ts");
    const source = [
      'import { AssetsService } from "../settings/assets.service";',
      'import type { StorefrontAsset } from "../settings/assets.service";',
      'export { displayName } from "../settings/assets.service";',
      'const lazy = () => import("../settings/settings.module");',
      'const required = require("../settings");',
      'import { StorefrontRepository } from "./storefront.repository";',
      'import { TenantTx } from "../tenancy/tenant-tx";',
      'import { settings } from "../settings-elsewhere/x";',
    ].join("\n");

    expect(settingsImportsOf(file, source)).toEqual([
      "../settings/assets.service",
      "../settings/assets.service",
      "../settings/assets.service",
      "../settings/settings.module",
      "../settings",
    ]);
  });

  it("keeps every file under src/storefront off src/settings [FIX-W34-OTA AC1]", () => {
    const files = typeScriptFiles(STOREFRONT_DIR);
    // The scan reads the files it is about: the public asset read is among them.
    expect(files.map((file) => relative(STOREFRONT_DIR, file))).toEqual(
      expect.arrayContaining([
        "public-assets.controller.ts",
        "public-assets.service.ts",
        "storefront.module.ts",
      ]),
    );

    const hits = files.flatMap((file) =>
      settingsImportsOf(file, readFileSync(file, "utf8")).map(
        (specifier) => `${relative(APP_DIR, file)}: ${specifier}`,
      ),
    );
    expect(hits).toEqual([]);
  });
});
