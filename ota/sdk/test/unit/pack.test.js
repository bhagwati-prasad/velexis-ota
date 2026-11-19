// The npm package of the SDK (OADR-0016 point 7, ota/sdk/docs/types-and-builds.md §3 and §6, task SDK-015 AC1): what
// `npm pack` makes of a fresh build compiles in an empty project outside the workspace that has no
// `@velexis/api-types` installed, because scripts/build.mjs copies the OTA part of that package into
// dist/types/api-types.d.ts and points the declarations at the copy.
// The set-up hook builds into a scratch copy of the package (the entries of package.json `files`, with dist/ written
// by `build.mjs --outdir`), packs it with the npm of the Node that runs the test (`npm pack --ignore-scripts`),
// unpacks the tarball into node_modules/@velexis/ota-sdk of an empty project in the system's temporary folder, and
// compiles a consumer file there with the repository's tsc (strict, no skipLibCheck), once with Node's module
// resolution and once with a bundler's. The tests only read what the hook wrote. It runs on every Node the SDK
// supports (CI's build-test and sdk-node22 jobs) and needs `tar` on PATH, as every CI runner and Unix system has.
import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  API_TYPES_FILE,
  API_TYPES_PACKAGE,
  BuildError,
  OUTPUTS,
  decodeMappings,
  encodeMappings,
  includeApiTypes,
  shiftMappings,
} from "../../scripts/build.mjs";

const SDK_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REPO_ROOT = join(SDK_ROOT, "..", "..");
const BUILD = join(SDK_ROOT, "scripts", "build.mjs");
const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const pkg = JSON.parse(readFileSync(join(SDK_ROOT, "package.json"), "utf8"));

/**
 * The hook builds the SDK (tsc over src/ and the generated schema types, esbuild twice), packs and unpacks it, then
 * compiles the consumer twice at once against about 2 MB of declarations without skipLibCheck, each step in a child
 * process. Alone that takes about 7 s; while Turborepo runs every package's tests at once on a CI runner, much
 * longer. So the hook gets this budget instead of Vitest's default, more than the sum of its steps' own limits below
 * (360 s), so that a step that hangs is killed and fails with its own output before the hook's budget runs out.
 */
const SETUP_TIMEOUT_MS = 400_000;
/** The build, as in bundle.test.js. */
const BUILD_CHILD_TIMEOUT_MS = 150_000;
/** `npm pack` and `tar` each start one process. */
const CHILD_TIMEOUT_MS = 45_000;
/** One tsc run over the consumer, the package's declarations and the DOM library. */
const TSC_TIMEOUT_MS = 120_000;

/**
 * Runs `command` in a child process without blocking this worker; resolves with its exit status and output.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv }} options
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
const run = (command, args, { cwd, timeoutMs, env }) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, env: env ?? process.env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
      },
    );
  });

/** Details of a failed step for the assertion message. */
const output = ({ status, stdout, stderr }) => `exit ${status}\n${stdout}\n${stderr}`;

/**
 * The npm of the Node that runs the test, as the official Node.js archives and actions/setup-node lay it out
 * (`<prefix>/lib/node_modules/npm`, `<folder>\node_modules\npm` on Windows), so the package is made by the npm that
 * would publish it with this Node; else the `npm` on PATH.
 * @returns {{ command: string, args: string[] }}
 */
function npmCommand() {
  const folder = dirname(process.execPath);
  const cli = [
    join(folder, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(folder, "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((file) => existsSync(file));
  return cli ? { command: process.execPath, args: [cli] } : { command: "npm", args: [] };
}

const scratch = mkdtempSync(join(tmpdir(), "sdk-015-pack-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The package as npm packs it from the repository: the `files` entries of package.json, and dist/ from the build. */
const PACKAGE_DIR = join(scratch, "package");
const BUILT_TYPES = join(PACKAGE_DIR, "dist", OUTPUTS.types);
/** Where `npm pack` writes the tarball. */
const TARBALLS = join(scratch, "tarballs");
/** The empty project outside the workspace: a package.json, two tsconfigs, the consumer and the unpacked package. */
const PROJECT = join(scratch, "consumer");
const INSTALLED = join(PROJECT, "node_modules", "@velexis", "ota-sdk");
const INSTALLED_TYPES = join(INSTALLED, "dist", OUTPUTS.types);
const CONSUMER = join(PROJECT, "consumer.ts");

/**
 * The consumer: the package's public functions, classes and types, among them schema types of the OTA API that the
 * declarations get from the copy. `IsAny` and the `@ts-expect-error` line fail the compilation if a schema type were
 * `any` (an import that did not resolve, with errors silenced), so a passing compilation proves real types.
 */
const CONSUMER_SOURCE = `import { createVelexisClient, isVelexisError, Page, ValidationError, VERSION } from "@velexis/ota-sdk";
import type { FlightOffer, Money, Schemas, VelexisClient, VelexisClientOptions } from "@velexis/ota-sdk";

type IsAny<T> = 0 extends 1 & T ? true : false;
export const moneyIsTyped: IsAny<Money> = false;
export const offerIsTyped: IsAny<FlightOffer> = false;
export const storefrontIsTyped: IsAny<Schemas["StorefrontConfig"]> = false;

export const price: Money = { amount: "123.45", currency: "EUR" };
// @ts-expect-error Money's amount is a decimal string, never a number.
export const wrongPrice: Money = { amount: 123.45, currency: "EUR" };

const options: VelexisClientOptions = { publishableKey: "pk_test_consumer", baseUrl: "https://api.ota.example.com" };
export const client: VelexisClient = createVelexisClient(options);
export const version: string = VERSION;

export async function otaName(api: VelexisClient): Promise<string> {
  const config: Schemas["StorefrontConfig"] = await api.storefront.get();
  return config.name;
}

export function describeError(error: unknown): string {
  if (error instanceof ValidationError) {
    return error.code;
  }
  return isVelexisError(error) ? error.message : String(error);
}

export type Pages = Page<FlightOffer>;
`;

/** The compiler options of the two compilations: strict, declarations checked (no skipLibCheck), no @types. */
const BASE_OPTIONS = {
  strict: true,
  skipLibCheck: false,
  noEmit: true,
  target: "ES2022",
  lib: ["ES2022", "DOM", "DOM.Iterable"],
  types: [],
};
const PROJECTS = {
  node: { file: "tsconfig.node.json", module: "NodeNext", moduleResolution: "NodeNext" },
  bundler: { file: "tsconfig.bundler.json", module: "ESNext", moduleResolution: "Bundler" },
};

/** @type {Record<string, { status: number, stdout: string, stderr: string }>} */
const steps = {};
/** @type {{ filename: string, name: string, version: string, files: Array<{ path: string }> } | undefined} */
let packed;
/** @type {Record<string, { status: number, stdout: string, stderr: string }>} */
const compiled = {};
/**
 * The declarations of the unpacked package (relative to its types folder) with their text and what each imports,
 * scanned once by the hook: the copy of the OTA types alone is about 2 MB.
 * @type {Array<{ name: string, text: string, references: string[] }>}
 */
let declarations = [];

/** The set-up of "npm pack of the SDK": build, pack, unpack, compile. A failed step leaves the later ones undone. */
async function packAndCompile() {
  mkdirSync(PACKAGE_DIR, { recursive: true });
  for (const entry of pkg.files.filter((entry) => entry !== "dist")) {
    cpSync(join(SDK_ROOT, entry), join(PACKAGE_DIR, entry), { recursive: true });
  }
  cpSync(join(SDK_ROOT, "package.json"), join(PACKAGE_DIR, "package.json"));
  steps.build = await run(process.execPath, [BUILD, "--outdir", join(PACKAGE_DIR, "dist")], {
    cwd: SDK_ROOT,
    timeoutMs: BUILD_CHILD_TIMEOUT_MS,
  });
  if (steps.build.status !== 0) {
    return;
  }

  // npm without the npm_* settings of the pnpm or npm that started the test run, its own cache and an empty user
  // configuration: the pack reads nothing but the package folder.
  mkdirSync(TARBALLS, { recursive: true });
  writeFileSync(join(scratch, "npmrc"), "");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/i.test(name)));
  Object.assign(env, {
    npm_config_cache: join(scratch, "npm-cache"),
    npm_config_userconfig: join(scratch, "npmrc"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  });
  const npm = npmCommand();
  steps.pack = await run(
    npm.command,
    [...npm.args, "pack", "--json", "--ignore-scripts", "--pack-destination", TARBALLS],
    { cwd: PACKAGE_DIR, timeoutMs: CHILD_TIMEOUT_MS, env },
  );
  if (steps.pack.status !== 0) {
    return;
  }
  [packed] = JSON.parse(steps.pack.stdout);

  // The empty project: nothing in node_modules but the unpacked package (npm's tarballs hold it under package/).
  mkdirSync(INSTALLED, { recursive: true });
  steps.unpack = await run(
    "tar",
    ["-xzf", join(TARBALLS, packed?.filename ?? ""), "-C", INSTALLED, "--strip-components=1"],
    { cwd: PROJECT, timeoutMs: CHILD_TIMEOUT_MS },
  );
  if (steps.unpack.status !== 0) {
    return;
  }
  declarations = installedDeclarations().map(({ name, text }) => ({
    name,
    text,
    references: referencesOf(text),
  }));
  writeFileSync(
    join(PROJECT, "package.json"),
    `${JSON.stringify({ name: "sdk-consumer", private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(CONSUMER, CONSUMER_SOURCE);
  for (const { file, ...resolution } of Object.values(PROJECTS)) {
    writeFileSync(
      join(PROJECT, file),
      `${JSON.stringify({ compilerOptions: { ...BASE_OPTIONS, ...resolution }, files: ["consumer.ts"] }, null, 2)}\n`,
    );
  }
  const runs = await Promise.all(
    Object.values(PROJECTS).map(({ file }) =>
      run(process.execPath, [TSC, "-p", file, "--pretty", "false"], {
        cwd: PROJECT,
        timeoutMs: TSC_TIMEOUT_MS,
      }),
    ),
  );
  for (const [index, name] of Object.keys(PROJECTS).entries()) {
    compiled[name] = /** @type {{ status: number, stdout: string, stderr: string }} */ (runs[index]);
  }
}

/** The files under `dir`, relative to it with `/` separators, sorted. */
const listFiles = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();

/** The declarations of the unpacked package, relative to its types folder, with their text. */
const installedDeclarations = () =>
  listFiles(INSTALLED_TYPES)
    .filter((file) => file.endsWith(".d.ts"))
    .map((name) => ({ name, text: readFileSync(join(INSTALLED_TYPES, name), "utf8") }));

/** Every module a declaration imports or references, as TypeScript's scanner finds them (comments skipped). */
const referencesOf = (text) => {
  const info = ts.preProcessFile(text, true, true);
  return [...info.importedFiles, ...info.referencedFiles, ...info.typeReferenceDirectives].map(
    ({ fileName }) => fileName,
  );
};

/** The identifier that starts at `column` of `line`, or "" (a punctuator, a string literal, a space). */
const identifierAt = (line, column) => /^[A-Za-z_$][\w$]*/.exec(line.slice(column))?.[0] ?? "";

/** A relative specifier of the copy (`"./api-types.js"`, `"../api-types.js"`), quotes included. */
const COPY_SPECIFIER = /["'](?:\.\.?\/)+api-types\.js["']/;

describe("npm pack of the SDK", () => {
  // See SETUP_TIMEOUT_MS for the budget.
  beforeAll(packAndCompile, SETUP_TIMEOUT_MS);

  it("packs a fresh build: the bundles, the declarations with the copy of the OTA API types, src/ and the docs [SDK-015 AC1]", () => {
    expect(steps.build?.status, steps.build && output(steps.build)).toBe(0);
    expect(steps.pack?.status, steps.pack && output(steps.pack)).toBe(0);
    expect(steps.unpack?.status, steps.unpack && output(steps.unpack)).toBe(0);
    expect(packed).toMatchObject({ name: pkg.name, version: pkg.version });
    const files = (packed?.files ?? []).map(({ path }) => path);
    expect(files).toEqual(
      expect.arrayContaining([
        "package.json",
        "README.md",
        "CHANGELOG.md",
        "src/index.js",
        `dist/${OUTPUTS.esm}`,
        `dist/${OUTPUTS.iife}`,
        `dist/${OUTPUTS.types}/index.d.ts`,
        `dist/${OUTPUTS.types}/${API_TYPES_FILE}`,
      ]),
    );
    // Nothing outside the `files` entries (and package.json, which npm always adds).
    expect(
      files.filter(
        (file) =>
          !["package.json", "README.md", "CHANGELOG.md"].includes(file) &&
          !file.startsWith("dist/") &&
          !file.startsWith("src/"),
      ),
    ).toEqual([]);
    // The unpacked package is the tarball's content.
    expect(listFiles(INSTALLED)).toEqual([...files].sort());
  });

  it("declares no dependency and imports nothing but its own files from its declarations [SDK-015 AC1]", () => {
    const manifest = JSON.parse(readFileSync(join(INSTALLED, "package.json"), "utf8"));
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies", "bundleDependencies"]) {
      expect(Object.keys(manifest), field).not.toContain(field);
    }
    expect(declarations.map(({ name }) => name)).toContain(API_TYPES_FILE);
    for (const { name, references } of declarations) {
      expect(
        references.filter(
          (specifier) => specifier === API_TYPES_PACKAGE || specifier.startsWith(`${API_TYPES_PACKAGE}/`),
        ),
        name,
      ).toEqual([]);
      // Relative imports only: no other package is needed for the types either.
      expect(
        references.filter((specifier) => !specifier.startsWith("./") && !specifier.startsWith("../")),
        name,
      ).toEqual([]);
      // And each names a declaration of the package's own types folder, not a path out of it (into a workspace).
      expect(
        references.filter((specifier) => {
          const target = join(dirname(join(INSTALLED_TYPES, name)), specifier.replace(/\.js$/, ".d.ts"));
          const inside = relative(INSTALLED_TYPES, target);
          return inside.startsWith("..") || isAbsolute(inside) || !existsSync(target);
        }),
        name,
      ).toEqual([]);
    }
    // The declarations use the copy (so the checks above are about the rewritten files), and the copy stands alone.
    const users = declarations.filter(({ references }) =>
      references.some((specifier) => COPY_SPECIFIER.test(`"${specifier}"`)),
    );
    expect(users.map(({ name }) => name)).toContain("types.d.ts");
    expect(declarations.find(({ name }) => name === API_TYPES_FILE)?.references).toEqual([]);
  });

  it.each(Object.keys(PROJECTS))(
    "compiles in an empty project without @velexis/api-types, strict and without skipLibCheck (%s resolution) [SDK-015 AC1]",
    (name) => {
      const { file, ...resolution } = PROJECTS[/** @type {keyof typeof PROJECTS} */ (name)];
      // The project is outside the workspace, and only the SDK is installed in it.
      const outside = relative(REPO_ROOT, PROJECT);
      expect(outside.startsWith("..") || isAbsolute(outside), outside).toBe(true);
      expect(readdirSync(join(PROJECT, "node_modules"))).toEqual(["@velexis"]);
      expect(readdirSync(join(PROJECT, "node_modules", "@velexis"))).toEqual(["ota-sdk"]);
      const { options } = ts.convertCompilerOptionsFromJson({ ...BASE_OPTIONS, ...resolution }, PROJECT);
      expect(
        ts.resolveModuleName(API_TYPES_PACKAGE, CONSUMER, options, ts.sys).resolvedModule,
      ).toBeUndefined();
      expect(ts.resolveModuleName(pkg.name, CONSUMER, options, ts.sys).resolvedModule?.resolvedFileName).toBe(
        join(INSTALLED_TYPES, "index.d.ts"),
      );
      expect(readFileSync(join(PROJECT, file), "utf8")).toContain('"skipLibCheck": false');
      // tsc prints its diagnostics on stdout.
      const result = compiled[name];
      expect(result && output(result)).toBe(output({ status: 0, stdout: "", stderr: "" }));
    },
  );

  it("keeps the declaration maps of the rewritten lines pointing at the same source tokens [SDK-015 AC1]", () => {
    let checked = 0;
    for (const { name, text } of declarations.filter(({ text }) => COPY_SPECIFIER.test(text))) {
      // The packed map is the build's; its sources are relative to the folder the build wrote it to.
      const map = readFileSync(join(INSTALLED_TYPES, `${name}.map`), "utf8");
      expect(map, name).toBe(readFileSync(join(BUILT_TYPES, `${name}.map`), "utf8"));
      const { mappings, sources, sourceRoot } = JSON.parse(map);
      const sourceLines = sources.map((source) =>
        readFileSync(join(dirname(join(BUILT_TYPES, name)), sourceRoot ?? "", source), "utf8").split("\n"),
      );
      const lines = text.split("\n");
      for (const [index, segments] of decodeMappings(mappings).entries()) {
        const at = lines[index]?.search(COPY_SPECIFIER) ?? -1;
        for (const [column, source, sourceLine, sourceColumn] of at < 0 ? [] : segments) {
          // Every identifier after the rewritten specifier maps to the same identifier in the source.
          const word = identifierAt(/** @type {string} */ (lines[index]), /** @type {number} */ (column));
          if (/** @type {number} */ (column) > at && word !== "" && source !== undefined) {
            expect(
              identifierAt(
                sourceLines[source]?.[/** @type {number} */ (sourceLine)] ?? "",
                sourceColumn ?? 0,
              ),
              `${name}:${index + 1}:${/** @type {number} */ (column) + 1}`,
            ).toBe(word);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("build.mjs: the copy of the OTA API types and the rewritten specifiers", () => {
  /** Hand-written declaration folders, each given to includeApiTypes once by the hook. */
  const FOLDERS = {
    rewritten: {
      "index.d.ts":
        "export type A = import(\"@velexis/api-types\").components; export type B = import('@velexis/api-types').paths;\n" +
        'import type { operations } from "@velexis/api-types";\n' +
        "export type C = operations;\n" +
        'export type { webhooks } from "@velexis/api-types";\n',
      "internal/deep.d.ts": 'export type D = import("@velexis/api-types").components["schemas"];\n',
      "other.d.ts": '// import("@velexis/api-types") in a comment is no import.\nexport type E = string;\n',
    },
    referenceTypes: { "index.d.ts": '/// <reference types="@velexis/api-types" />\nexport type X = 1;\n' },
    augmentation: {
      "index.d.ts": 'declare module "@velexis/api-types" {\n  export type Y = 1;\n}\nexport {};\n',
    },
    subpath: { "index.d.ts": 'export type Z = import("@velexis/api-types/platform").paths;\n' },
    nameTaken: { "index.d.ts": "export {};\n", [API_TYPES_FILE]: "export type FromASourceModule = 1;\n" },
  };
  /** @type {Record<string, { result?: ReturnType<typeof includeApiTypes>, error?: unknown, dir: string }>} */
  const outcomes = {};

  // includeApiTypes reads and parses the generated OTA types (about 2 MB of declarations) on every call: a few hundred
  // milliseconds each alone, several seconds while Turborepo runs every package's tests at once on a CI runner, so
  // the hook makes the five calls under this budget and the tests only read their outcomes.
  beforeAll(() => {
    for (const [name, files] of Object.entries(FOLDERS)) {
      const dir = join(scratch, "folders", name);
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), text);
      }
      try {
        outcomes[name] = { dir, result: includeApiTypes(dir) };
      } catch (error) {
        outcomes[name] = { dir, error };
      }
    }
  }, 60_000);

  const read = (name, file) => readFileSync(join(outcomes[name]?.dir ?? "", file), "utf8");

  it("rewrites every specifier of the package to the copy, relative to each declaration's folder [SDK-015 AC1]", () => {
    expect(outcomes.rewritten?.error).toBeUndefined();
    expect(outcomes.rewritten?.result?.rewritten).toEqual(["index.d.ts", "internal/deep.d.ts"]);
    expect(read("rewritten", "index.d.ts")).toBe(
      "export type A = import(\"./api-types.js\").components; export type B = import('./api-types.js').paths;\n" +
        'import type { operations } from "./api-types.js";\n' +
        "export type C = operations;\n" +
        'export type { webhooks } from "./api-types.js";\n',
    );
    expect(read("rewritten", "internal/deep.d.ts")).toBe(
      'export type D = import("../api-types.js").components["schemas"];\n',
    );
    expect(read("rewritten", "other.d.ts")).toBe(FOLDERS.rewritten["other.d.ts"]);
    // The copy: a header, then the generated declarations without their source map link.
    const copy = read("rewritten", API_TYPES_FILE);
    expect(copy).toMatch(
      /^\/\/ The OTA booking API's types for the declarations of @velexis\/ota-sdk: a copy of /,
    );
    expect(copy).toMatch(/\nexport interface components \{\n/);
    expect(copy).not.toContain("sourceMappingURL");
    expect(ts.preProcessFile(copy, true, true).importedFiles).toEqual([]);
  });

  it.each([
    ["referenceTypes", /still names @velexis\/api-types after the rewrite/],
    ["augmentation", /declares module "@velexis\/api-types", which cannot be rewritten/],
    ["subpath", /still names @velexis\/api-types after the rewrite/],
    ["nameTaken", /was emitted from a source module/],
  ])(
    "fails the build when the declarations would still need the package: %s [SDK-015 AC1]",
    (name, message) => {
      const { error } = outcomes[name] ?? {};
      expect(error).toBeInstanceOf(BuildError);
      expect(/** @type {Error} */ (error).message).toMatch(message);
    },
  );

  it("moves the map columns after each replaced literal, sends those inside it to its start and keeps the rest [SDK-015 AC1]", () => {
    // Line 0 holds two literals of 20 characters, at columns 10 to 30 and 40 to 60, each replaced by 16 characters.
    const before = [
      [
        [0, 0, 0, 0],
        [10, 0, 0, 5],
        [12, 0, 0, 6],
        [30, 0, 0, 7],
        [40, 0, 0, 8],
        [45, 0, 0, 9],
        [60, 0, 1, 0],
        [70, 0, 1, 4],
      ],
      [[40, 0, 2, 0]],
      [],
    ];
    const edits = [
      { line: 0, start: 40, end: 60, delta: -4 },
      { line: 0, start: 10, end: 30, delta: -4 },
    ];
    const after = decodeMappings(shiftMappings(encodeMappings(before), edits));
    expect(after[0]?.map(([column]) => column)).toEqual([0, 10, 10, 26, 36, 36, 52, 62]);
    // Only generated columns move; the source positions and every other line stay.
    expect(after[0]?.map(([, ...rest]) => rest)).toEqual(before[0]?.map(([, ...rest]) => rest));
    expect(after.slice(1)).toEqual(before.slice(1));
    expect(shiftMappings(encodeMappings(before), [])).toBe(encodeMappings(before));
  });
});
