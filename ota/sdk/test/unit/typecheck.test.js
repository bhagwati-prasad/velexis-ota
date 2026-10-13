// The SDK's JSDoc type check (ADR-0019, ota/sdk/docs/types-and-builds.md §2): `pnpm --filter @velexis/ota-sdk
// typecheck` runs tsc with checkJs on src/. These tests read tsconfig.json the way tsc does and prove that its
// options really check JavaScript: a passing typecheck with checkJs, strict or `types: []` turned off would prove
// nothing. The fixtures are small JavaScript files in a scratch folder, compiled with the SDK's own options.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SDK_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The compiler options and root files of ota/sdk/tsconfig.json, `extends` resolved, as tsc reads them. */
function readSdkConfig() {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(SDK_ROOT, "tsconfig.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (!parsed) {
    throw new Error("tsconfig.json could not be read");
  }
  expect(parsed.errors).toEqual([]);
  return parsed;
}

/** @param {string[]} parts */
const lines = (...parts) => parts.join("\n");

/** JavaScript fixtures by file name; each is checked alone with the SDK's options. */
const FIXTURES = {
  // Browser and Node 22 platform APIs that the SDK uses are declared (lib DOM, DOM.Iterable, ES2022).
  "platform.js": lines(
    'export const url = new URL("/v1/storefront", "https://api.ota.example.com");',
    "export const controller = new AbortController();",
    "export const id = crypto.randomUUID();",
    "/** @param {Headers} headers */",
    "export const names = (headers) => [...headers].map(([name]) => name);",
    "export const call = () => fetch(url, { signal: controller.signal });",
    "export const last = [1, 2].at(-1);",
  ),
  "strict-null.js": lines("/** @param {string | undefined} s */", "export const length = (s) => s.length;"),
  "implicit-any.js": lines("export function identity(value) { return value; }"),
  "unchecked-index.js": lines(
    "/** @param {string[]} list */",
    "export const first = (list) => list[0].length;",
  ),
  "exact-optional.js": lines(
    "/** @type {{ locale?: string }} */",
    "export const options = { locale: undefined };",
  ),
  "node-globals.js": lines("export const env = process.env;", 'export const bytes = Buffer.from("x");'),
};

describe("tsconfig.json", () => {
  it("checks every source file as JavaScript with checkJs, strict and no emit [SDK-001 AC1]", () => {
    const { options, fileNames } = readSdkConfig();
    expect(options).toMatchObject({
      allowJs: true,
      checkJs: true,
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noEmit: true,
    });
    expect(fileNames.map((file) => file.slice(SDK_ROOT.length))).toEqual(
      expect.arrayContaining(["src/index.js", "src/types.js", "src/version.js"]),
    );
    expect(fileNames.every((file) => file.startsWith(join(SDK_ROOT, "src")) && file.endsWith(".js"))).toBe(
      true,
    );
  });

  it("declares the browser and ES2022 platform but no Node globals [SDK-001 AC1]", () => {
    const { options } = readSdkConfig();
    expect(options.types).toEqual([]);
    expect(options.lib).toEqual(
      expect.arrayContaining(["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"]),
    );
  });
});

describe("the type check of JavaScript", () => {
  /** @type {string} */
  let dir;
  /** @type {Map<string, number[]>} diagnostic codes by fixture name */
  const codes = new Map();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "velexis-sdk-checkjs-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    for (const [name, source] of Object.entries(FIXTURES)) {
      writeFileSync(join(dir, name), `${source}\n`);
    }
    const { options } = readSdkConfig();
    const roots = Object.keys(FIXTURES).map((name) => join(dir, name));
    const program = ts.createProgram(roots, options);
    expect(program.getOptionsDiagnostics()).toEqual([]);
    expect(program.getGlobalDiagnostics()).toEqual([]);
    for (const name of Object.keys(FIXTURES)) {
      const file = program.getSourceFile(join(dir, name));
      const diagnostics = [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)];
      codes.set(
        name,
        diagnostics.map((diagnostic) => diagnostic.code),
      );
    }
  });

  afterAll(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts correct code that uses fetch, URL, AbortController, crypto and Headers iteration [SDK-001 AC1]", () => {
    expect(codes.get("platform.js")).toEqual([]);
  });

  it.each([
    ["strict-null.js", "a possibly undefined value (strict)", 18048],
    ["implicit-any.js", "an implicit any parameter (strict)", 7006],
    ["unchecked-index.js", "an unchecked array element (noUncheckedIndexedAccess)", 2532],
    ["exact-optional.js", "undefined for an optional property (exactOptionalPropertyTypes)", 2375],
    ["node-globals.js", "Node globals such as process and Buffer (types: [])", 2591],
  ])("reports %s: %s [SDK-001 AC1]", (name, _what, code) => {
    expect(codes.get(name)).toContain(code);
  });
});
