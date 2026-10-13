// The SDK's version and package metadata (OADR-0016 points 7 and 8, ADR-0019): `VERSION` is the version of
// package.json, and the package has no runtime dependencies, so it installs alone and runs as-is in browsers.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { VERSION as PUBLIC_VERSION } from "../../src/index.js";
import { VERSION } from "../../src/version.js";

const SDK_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(SDK_ROOT, "package.json"), "utf8"));

/** Every JavaScript file under src/, relative to the SDK folder. */
const sourceFiles = () =>
  readdirSync(join(SDK_ROOT, "src"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => join(entry.parentPath, entry.name).slice(SDK_ROOT.length))
    .sort();

describe("VERSION", () => {
  it("equals the version in package.json [SDK-001 AC2]", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("is the version that the public entry exports [SDK-001 AC2]", () => {
    expect(PUBLIC_VERSION).toBe(pkg.version);
  });

  it("is a semantic version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});

describe("package.json", () => {
  it("has no dependencies field [SDK-001 AC3]", () => {
    expect(Object.keys(pkg)).not.toContain("dependencies");
  });

  it("has no peer, optional or bundled dependencies either [SDK-001 AC3]", () => {
    for (const field of [
      "peerDependencies",
      "optionalDependencies",
      "bundleDependencies",
      "bundledDependencies",
    ]) {
      expect(Object.keys(pkg), field).not.toContain(field);
    }
  });

  it("uses @velexis/api-types as a workspace devDependency, for JSDoc types only [SDK-001 AC3]", () => {
    expect(pkg.devDependencies).toMatchObject({ "@velexis/api-types": "workspace:*" });
  });

  it("is an ES module package without side effects", () => {
    expect(pkg).toMatchObject({ name: "@velexis/ota-sdk", type: "module", sideEffects: false });
  });
});

describe("src/", () => {
  it("imports nothing but its own relative modules at runtime [SDK-001 AC3]", () => {
    const files = sourceFiles();
    expect(files).toEqual(expect.arrayContaining(["src/index.js", "src/types.js", "src/version.js"]));
    for (const file of files) {
      const source = readFileSync(join(SDK_ROOT, file), "utf8");
      // The TypeScript scanner skips comments, so JSDoc `import("@velexis/api-types")` types are not imports.
      const imports = ts.preProcessFile(source, true, true).importedFiles.map((ref) => ref.fileName);
      expect(
        imports.filter((specifier) => !specifier.startsWith("./") && !specifier.startsWith("../")),
        file,
      ).toEqual([]);
    }
  });
});
