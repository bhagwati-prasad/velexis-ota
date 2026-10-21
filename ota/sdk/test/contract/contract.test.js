// The SDK contract test inside `pnpm --filter @velexis/ota-sdk test` (OADR-0016 point 4, ota/sdk/docs/types-and-builds.md
// §4, task SDK-006). The contract project (test/contract/tsconfig.json: client.contract.ts, methods.generated.ts,
// deviations.ts) is compiled the way tsc compiles it, against declarations emitted from src/ the way
// `tsc -p tsconfig.build.json` emits them, into a scratch folder: the test needs no earlier build and never reads a
// stale dist/. Then the same project is compiled against declarations emitted from src/ with one parameter narrowed,
// and again with one result widened, to prove that the assertions catch both at the method that changed; once with
// the result of a `console` method widened, to prove that the contract methods of the still pending `console`
// namespace are checked one by one (SDK-011); and once with an empty `console` namespace, to prove that a pending
// namespace the client has must hold every contract method. The tests also check that methods.generated.ts is what a
// fresh generator run writes.
// `pnpm --filter @velexis/ota-sdk test:contract` runs the same project with the tsc command line over dist/types/.
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";

const SDK_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REPO_ROOT = join(SDK_ROOT, "..", "..");
const CONTRACT_DIR = join(SDK_ROOT, "test", "contract");
const CONTRACT_CONFIG = join(CONTRACT_DIR, "tsconfig.json");
const BUILD_CONFIG = join(SDK_ROOT, "tsconfig.build.json");
const METHODS = join(CONTRACT_DIR, "methods.generated.ts");
const CLIENT_CONTRACT = join(CONTRACT_DIR, "client.contract.ts");
const FLIGHTS_SOURCE = join(SDK_ROOT, "src", "namespaces", "flights.js");
const CONSOLE_SOURCE = join(SDK_ROOT, "src", "namespaces", "console.js");
const GENERATOR = join(SDK_ROOT, "scripts", "generate-operations.mjs");
const CONTRACT_INDEX = join(REPO_ROOT, "docs", "velexis-sdk", "sdk", "src", "index.d.ts");

/**
 * Emitting the declarations and building a program over the contract, the SDK's declarations and the generated
 * schema types (about 1 MB of declarations) take a few seconds each alone, and much longer while Turborepo runs every
 * package's tests at once on a CI runner, so the hooks that do it get this budget instead of Vitest's 10 s default.
 * Each step is synchronous, so the hooks give the event loop a turn between steps (`nextTurn`): a worker that blocks
 * for a minute misses Vitest's RPC deadline even when every test passes.
 */
const PROGRAM_TIMEOUT_MS = 180_000;

/** A generator run parses both OpenAPI documents in a child process; a run that hangs is killed. */
const GENERATOR_TIMEOUT_MS = 60_000;

/**
 * Runs the generator in a child process without blocking this worker; resolves with its exit status and output.
 * @param {...string} args
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
const generate = (...args) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [GENERATOR, ...args],
      { encoding: "utf8", timeout: GENERATOR_TIMEOUT_MS },
      (error, stdout, stderr) => {
        resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
      },
    );
  });

/** Lets the event loop run (Vitest's worker RPC among others) between two synchronous compiler steps. */
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

const scratch = mkdtempSync(join(tmpdir(), "sdk-006-contract-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The options and root files of a tsconfig file, `extends` resolved, as tsc reads them. */
function readConfig(file) {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    file,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (!parsed) {
    throw new Error(`${file} could not be read`);
  }
  expect(parsed.errors).toEqual([]);
  return parsed;
}

const FORMAT_HOST = {
  getCanonicalFileName: (file) => file,
  getCurrentDirectory: () => SDK_ROOT,
  getNewLine: () => "\n",
};

/** Diagnostics as tsc prints them, for readable failures. */
const format = (diagnostics) => ts.formatDiagnostics(diagnostics, FORMAT_HOST);

/**
 * Parsed source files shared by every program of this file, by path and parse settings: the lib files, the generated
 * schema types and the contract are parsed once, as a language service shares them between projects.
 */
const sourceFiles = new Map();

/**
 * A compiler host that reuses parsed files and replaces the text of some source files (absolute path to text), for
 * the mutations.
 */
function createHost(options, sources = {}) {
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (file) => sources[file] ?? readFile(file);
  host.getSourceFile = (file, settings, ...rest) => {
    if (sources[file] !== undefined) {
      return ts.createSourceFile(file, sources[file], settings);
    }
    const key =
      typeof settings === "object"
        ? `${file}|${settings.languageVersion}|${settings.impliedNodeFormat}`
        : `${file}|${settings}`;
    if (!sourceFiles.has(key)) {
      sourceFiles.set(key, getSourceFile(file, settings, ...rest));
    }
    return sourceFiles.get(key);
  };
  return host;
}

/**
 * Emits the declarations of src/ with the options of tsconfig.build.json into `outDir`, the way the build does. The
 * folder gets `"type": "module"`, as ota/sdk/package.json gives dist/types/. A replaced source file must still
 * type-check (a mutation is a narrower type, not broken code); the rest of src/ is `pnpm typecheck`'s job.
 */
function emitDeclarations(outDir, sources = {}) {
  const { options, fileNames } = readConfig(BUILD_CONFIG);
  const emitOptions = { ...options, outDir, declarationMap: false };
  const program = ts.createProgram({
    rootNames: fileNames,
    options: emitOptions,
    host: createHost(emitOptions, sources),
  });
  const replaced = Object.keys(sources).flatMap((file) => [
    ...program.getSyntacticDiagnostics(program.getSourceFile(file)),
    ...program.getSemanticDiagnostics(program.getSourceFile(file)),
  ]);
  const result = program.emit(undefined, undefined, undefined, true);
  expect(format([...replaced, ...result.diagnostics])).toBe("");
  expect(result.emitSkipped).toBe(false);
  writeFileSync(join(outDir, "package.json"), JSON.stringify({ type: "module" }));
  return outDir;
}

/**
 * Compiles the contract project of test/contract/tsconfig.json with `@velexis/ota-sdk` mapped to the declarations in
 * `typesDir` instead of dist/types/. Returns the program and every diagnostic tsc would print.
 */
function compileContract(typesDir) {
  const { options, fileNames } = readConfig(CONTRACT_CONFIG);
  const contractOptions = {
    ...options,
    paths: { ...options.paths, "@velexis/ota-sdk": [join(typesDir, "index.d.ts")] },
  };
  const program = ts.createProgram({
    rootNames: fileNames,
    options: contractOptions,
    host: createHost(contractOptions),
  });
  return { program, diagnostics: ts.getPreEmitDiagnostics(program) };
}

/** The 1-based line of `file` that contains `text`, which must occur exactly once. */
function lineOf(file, text) {
  const lines = readFileSync(file, "utf8").split("\n");
  const found = lines.flatMap((line, index) => (line.includes(text) ? [index + 1] : []));
  expect(found, text).toHaveLength(1);
  return found[0];
}

/** The 1-based line of methods.generated.ts that contains `text`. */
const methodsLine = (text) => lineOf(METHODS, text);

/** `file:line` of each diagnostic, relative to ota/sdk. */
const locations = (diagnostics) =>
  diagnostics.map((diagnostic) => {
    const file = diagnostic.file?.fileName ?? "(global)";
    const line = diagnostic.file
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1
      : 0;
    return `${file.startsWith(SDK_ROOT) ? file.slice(SDK_ROOT.length) : file}:${line}`;
  });

/** Replaces `from` with `to` in `text`, where `from` occurs exactly once. */
function replaceOnce(text, from, to) {
  expect(text.split(from), from).toHaveLength(2);
  return text.replace(from, to);
}

describe("the contract project", () => {
  it("maps velexis-contract, @velexis/ota-sdk and @velexis/api-types for both sides, with lib checks on", () => {
    const { options, fileNames } = readConfig(CONTRACT_CONFIG);
    const mapped = (name) => options.paths[name].map((entry) => join(CONTRACT_DIR, entry));
    expect(mapped("velexis-contract")).toEqual([CONTRACT_INDEX]);
    expect(mapped("@velexis/ota-sdk")).toEqual([join(SDK_ROOT, "dist", "types", "index.d.ts")]);
    expect(mapped("@velexis/api-types")).toEqual([
      join(SDK_ROOT, "node_modules", "@velexis", "api-types", "dist", "index.d.ts"),
    ]);
    // A contract type that no longer resolves against the working document must fail, not become `any`.
    expect(options).toMatchObject({
      skipLibCheck: false,
      strict: true,
      exactOptionalPropertyTypes: true,
      noEmit: true,
    });
    expect(fileNames.map((file) => file.slice(CONTRACT_DIR.length + 1)).sort()).toEqual([
      "client.contract.ts",
      "deviations.ts",
      "methods.generated.ts",
      "pending-namespaces.js",
    ]);
  });
});

describe("the SDK against the frozen contract", () => {
  /** @type {{ program: import("typescript").Program, diagnostics: readonly import("typescript").Diagnostic[] }} */
  let baseline;
  /** @type {readonly import("typescript").Diagnostic[]} */
  let narrowed;
  /** @type {readonly import("typescript").Diagnostic[]} */
  let widened;
  /** @type {readonly import("typescript").Diagnostic[]} */
  let consoleWidened;
  /** @type {readonly import("typescript").Diagnostic[]} */
  let pendingNamespaceWritten;

  // Four declaration emits and five contract programs, with a turn of the event loop between them: see the budget.
  beforeAll(async () => {
    const typesDir = emitDeclarations(join(scratch, "types"));
    await nextTurn();
    baseline = compileContract(typesDir);
    await nextTurn();
    const flights = readFileSync(FLIGHTS_SOURCE, "utf8");
    // flights.search accepts only the simple form of the contract's parameters.
    const narrowedSource = replaceOnce(
      flights,
      "@param {FlightSearchParams} params",
      '@param {import("../flights.js").FlightSearchSimpleParams} params',
    );
    const narrowedDir = emitDeclarations(join(scratch, "narrowed"), { [FLIGHTS_SOURCE]: narrowedSource });
    await nextTurn();
    narrowed = compileContract(narrowedDir).diagnostics;
    await nextTurn();
    // flights.getOffer resolves with `unknown` instead of a flight offer.
    const widenedSource = replaceOnce(
      flights,
      "@returns {Promise<FlightOffer>}",
      "@returns {Promise<unknown>}",
    );
    const widenedDir = emitDeclarations(join(scratch, "widened"), { [FLIGHTS_SOURCE]: widenedSource });
    await nextTurn();
    widened = compileContract(widenedDir).diagnostics;
    await nextTurn();
    // console.bookings.get (pending namespace, written by SDK-011) resolves with `unknown` instead of a booking.
    const getBooking = [
      "     * @param {ConsoleGetBookingParams} params",
      "     * @param {RequestOptions} [options]",
      "     * @returns {Promise<ConsoleBooking>}",
    ].join("\n");
    const consoleWidenedSource = replaceOnce(
      readFileSync(CONSOLE_SOURCE, "utf8"),
      getBooking,
      getBooking.replace("{Promise<ConsoleBooking>}", "{Promise<unknown>}"),
    );
    const consoleWidenedDir = emitDeclarations(join(scratch, "console-widened"), {
      [CONSOLE_SOURCE]: consoleWidenedSource,
    });
    await nextTurn();
    consoleWidened = compileContract(consoleWidenedDir).diagnostics;
    await nextTurn();
    // The client has its `console` namespace (still pending for console.settings and console.payments, SDK-012)
    // without any method in it.
    const consoleDir = join(scratch, "console-namespace");
    cpSync(typesDir, consoleDir, { recursive: true });
    const index = join(consoleDir, "index.d.ts");
    const consoleMember = '    console: import("./console.js").ConsoleApi;\n';
    writeFileSync(index, replaceOnce(readFileSync(index, "utf8"), consoleMember, "    console: {};\n"));
    pendingNamespaceWritten = compileContract(consoleDir).diagnostics;
  }, PROGRAM_TIMEOUT_MS);

  it("compiles for the M2 namespaces with the declarations emitted from src/ [SDK-006 AC1]", () => {
    expect(format(baseline.diagnostics)).toBe("");
    // The project really holds the assertions: the M2 methods, the pending ones and the additions.
    const files = baseline.program.getRootFileNames().map((file) => file.slice(CONTRACT_DIR.length + 1));
    expect(files).toEqual(
      expect.arrayContaining(["client.contract.ts", "methods.generated.ts", "deviations.ts"]),
    );
    const methods = readFileSync(METHODS, "utf8");
    for (const method of ["flights.search", "storefront.get", "reference.locations.search", "auth.signIn"]) {
      expect(methods).toContain(`ContractParams<"${method}">`);
    }
    expect(methods).toContain('SdkMember<"checkout.completeWithAirlineCard">');
  });

  it("fails when a parameter type of flights.search is narrowed, at its assertion only [SDK-006 AC1]", () => {
    const line = methodsLine('ContractParams<"flights.search">');
    expect(locations(narrowed), format(narrowed)).toEqual([`test/contract/methods.generated.ts:${line}`]);
    expect(narrowed[0].code).toBe(2344);
    expect(ts.flattenDiagnosticMessageText(narrowed[0].messageText, "\n")).toContain("originLocationCode");
    // The structural check of the whole client in client.contract.ts does not see it: TypeScript compares the methods
    // of two interfaces bivariantly. That is why every method has its own explicit assertion.
  });

  it("fails when the result of flights.getOffer is widened, at its assertion and the client's", () => {
    expect(locations(widened).sort(), format(widened)).toEqual(
      [
        `test/contract/methods.generated.ts:${methodsLine('SdkResult<"flights.getOffer">')}`,
        `test/contract/client.contract.ts:${lineOf(CLIENT_CONTRACT, 'Assignable<ContractClientSoFar, Omit<SdkClient, "withOptions">>')}`,
      ].sort(),
    );
  });

  it("checks the 32 contract methods of the pending console namespace one by one [SDK-011 AC1]", () => {
    // The baseline holds every console assertion; a console result widened to unknown fails at its assertion only:
    // the client-wide check leaves the pending namespace out, so only the per-method assertions can catch it.
    expect(format(baseline.diagnostics)).toBe("");
    const methods = readFileSync(METHODS, "utf8");
    expect(methods.match(/= Conforms<\n {2}SdkParams<"console\./g)).toHaveLength(32);
    expect(locations(consoleWidened), format(consoleWidened)).toEqual([
      `test/contract/methods.generated.ts:${methodsLine('SdkResult<"console.bookings.get">')}`,
    ]);
    expect(consoleWidened[0]?.code).toBe(2344);
  });

  it("checks every contract method of a pending namespace once the client has the namespace, and no addition", () => {
    // pending-namespaces.js still lists `console`, but a namespace that an SDK task has written must hold every
    // method of the contract (SDK-011); only its additions (console.settings.*, console.payments.*) stand in.
    const lines = readFileSync(METHODS, "utf8").split("\n");
    const contractConsoleMethods = lines.flatMap((line, index) =>
      line.includes('ContractParams<"console.') ? [`test/contract/methods.generated.ts:${index + 1}`] : [],
    );
    expect(contractConsoleMethods).toHaveLength(32);
    expect(locations(pendingNamespaceWritten).sort(), format(pendingNamespaceWritten)).toEqual(
      contractConsoleMethods.sort(),
    );
    expect(ts.flattenDiagnosticMessageText(pendingNamespaceWritten[0].messageText, "\n")).toContain(
      "a method of the contract missing from a namespace that the SDK client already has",
    );
  });
});

describe("methods.generated.ts", () => {
  /** @type {{ status: number, stdout: string, stderr: string }} */
  let fresh;
  /** @type {{ status: number, stdout: string, stderr: string }} */
  let partial;
  /** @type {{ status: number, stdout: string, stderr: string }} */
  let tableOnly;

  // Three generator runs, each parsing the OpenAPI documents in a child process (asynchronously, so this worker stays
  // responsive): see the budget.
  beforeAll(async () => {
    fresh = await generate(
      "--out",
      join(scratch, "fresh", "operations.js"),
      "--methods-out",
      join(scratch, "fresh", "methods.ts"),
    );
    // A contract document with two of the methods: everything else becomes an addition.
    const partialContract = join(scratch, "partial-contract.yaml");
    writeFileSync(
      partialContract,
      stringify({
        openapi: "3.1.0",
        paths: {
          "/v1/storefront": { get: { "x-sdk-method": "storefront.get" } },
          "/v1/flight-searches": { post: { "x-sdk-method": "flights.search" } },
        },
      }),
    );
    partial = await generate(
      "--out",
      join(scratch, "partial", "operations.js"),
      "--contract-document",
      partialContract,
      "--methods-out",
      join(scratch, "partial", "methods.ts"),
    );
    tableOnly = await generate("--out", join(scratch, "table-only", "operations.js"));
  }, PROGRAM_TIMEOUT_MS);

  it("is what a fresh run of the generator writes", () => {
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(readFileSync(join(scratch, "fresh", "methods.ts"), "utf8")).toBe(readFileSync(METHODS, "utf8"));
  });

  it("starts with the generated, do-not-edit header and names its sources without absolute paths", () => {
    const text = readFileSync(METHODS, "utf8");
    expect(text.split("\n")[0]).toBe("// Generated by scripts/generate-operations.mjs — do not edit.");
    expect(text).toContain("ota/backend/openapi/velexis-ota-booking-api.openapi.yaml");
    expect(text).toContain("docs/velexis-sdk/openapi/velexis-ota-booking-api.openapi.yaml");
    expect(text).not.toContain(REPO_ROOT);
  });

  it("checks the methods of the contract with Conforms and the additions with Addition", () => {
    expect(partial.status, partial.stderr).toBe(0);
    const text = readFileSync(join(scratch, "partial", "methods.ts"), "utf8");
    expect(text).toContain(
      [
        "export type flights_search = Conforms<",
        '  SdkParams<"flights.search">,',
        '  ContractParams<"flights.search">,',
        '  ContractResult<"flights.search">,',
        '  SdkResult<"flights.search">',
        ">;",
      ].join("\n"),
    );
    // An addition fits on one line when the name is short, as Prettier prints it.
    expect(text).toContain(
      'export type flights_getOffer = Addition<SdkMember<"flights.getOffer">, ContractMember<"flights.getOffer">>;',
    );
    expect(text).toContain(
      [
        "export type reference_locations_search = Addition<",
        '  SdkMember<"reference.locations.search">,',
        '  ContractMember<"reference.locations.search">',
        ">;",
      ].join("\n"),
    );
    expect(text).toContain('export type ContractMethodOfTheDocument = "flights.search" | "storefront.get";');
    expect(text.match(/= Conforms</g)).toHaveLength(2);
  });

  it("is written only to an explicit --methods-out when --out is given", () => {
    expect(tableOnly.status, tableOnly.stderr).toBe(0);
    expect(tableOnly.stdout).not.toContain("contract assertions");
    expect(fresh.stdout).toContain("contract assertions");
  });
});

describe("the package scripts", () => {
  it("run the contract project and the parity test in `test`, and tsc over dist/types in `test:contract` [SDK-006 AC3]", () => {
    const pkg = JSON.parse(readFileSync(join(SDK_ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts["test:contract"]).toBe(
      "tsc -p tsconfig.build.json && tsc -p test/contract/tsconfig.json",
    );
    // Vitest collects this file and parity.test.js (read as text: importing the config would load Vite).
    expect(readFileSync(join(SDK_ROOT, "vitest.config.js"), "utf8")).toContain(
      '"test/contract/**/*.test.js"',
    );
  });
});
