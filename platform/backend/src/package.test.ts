// The package itself (PBE-001): the build emits the three entry points the systemd units and the CLI run, the lint
// rules that keep console.* and process.env out of the code are on and hold, and reference data is not this
// package's business (ADR-0024).
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setImmediate } from "node:timers/promises";
import { ESLint } from "eslint";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_DIR } from "./config";

const REPO_ROOT = join(APP_DIR, "..", "..");

interface PackageJson {
  name: string;
  type: string;
  main: string;
  files: string[];
  scripts: Record<string, string>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Every file below `dir`, as paths relative to the package. */
function filesBelow(dir: string): string[] {
  return readdirSync(join(APP_DIR, dir), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(APP_DIR, join(entry.parentPath, entry.name)));
}

const manifest = readJson<PackageJson>(join(APP_DIR, "package.json"));

describe("the build", () => {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(APP_DIR, "tsconfig.build.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (parsed === undefined) {
    throw new Error("tsconfig.build.json cannot be read");
  }

  it("[PBE-001 AC1] compiles src/main.ts, src/worker.ts and src/cli.ts to dist/main.js, dist/worker.js and dist/cli.js", () => {
    const emitted = ["main", "worker", "cli"].map((entry) =>
      ts
        .getOutputFileNames(parsed, join(APP_DIR, "src", `${entry}.ts`), false)
        .filter((file) => file.endsWith(".js"))
        .map((file) => relative(APP_DIR, file)),
    );

    expect(emitted).toEqual([["dist/main.js"], ["dist/worker.js"], ["dist/cli.js"]]);
    expect(parsed.options.module).toBe(ts.ModuleKind.NodeNext);
    expect(manifest.main).toBe("./dist/main.js");
  });

  it("[PBE-001 AC1] fails when an entry point is missing after the compile, and ships dist without tests", () => {
    expect(manifest.scripts["build"]).toMatch(/^rm -rf dist && tsc -b tsconfig\.build\.json && node -e /);
    expect(manifest.scripts["build"]).toContain("for (const entry of ['main', 'worker', 'cli'])");
    // openapi/ since PBE-008: the API validates requests against the document it ships (pnpm deploy copies `files`).
    expect(manifest.files).toEqual(["dist", "!dist/**/*.test.*", "!dist/**/*.tsbuildinfo", "openapi"]);
    expect(existsSync(join(APP_DIR, "openapi", "velexis-platform-api.openapi.yaml"))).toBe(true);
    expect(
      parsed.fileNames.map((file) => relative(APP_DIR, file)).filter((file) => file.endsWith(".test.ts")),
    ).toEqual([]);
  });

  /** The build script's `node -e` entry-point check, and its exit status without dist/cli.js and with it. */
  const check = /&& node -e "([^"]+)"$/.exec(manifest.scripts["build"] ?? "")?.[1];
  let withoutCli: number | null;
  let withCli: number | null;

  // Two Node processes: a fraction of a second each idle, more on a loaded runner, so they run here and not in the
  // test's 5 s.
  beforeAll(() => {
    if (check === undefined) {
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "velexis-platform-backend-build-"));
    try {
      mkdirSync(join(dir, "dist"));
      const runCheck = (): number | null => spawnSync(process.execPath, ["-e", check], { cwd: dir }).status;
      for (const entry of ["main", "worker"]) {
        writeFileSync(join(dir, "dist", `${entry}.js`), "");
      }
      withoutCli = runCheck();
      writeFileSync(join(dir, "dist", "cli.js"), "");
      withCli = runCheck();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("[PBE-001 AC1] the build script's entry-point check fails while one of the three files is missing", () => {
    if (check === undefined) {
      throw new Error("the build script has no `node -e` entry-point check");
    }

    expect(withoutCli).not.toBe(0);
    expect(withCli).toBe(0);
  });

  it("emits CommonJS with decorator metadata, which NestJS's dependency injection needs", () => {
    expect(manifest.type).toBe("commonjs");
    expect(parsed.options.experimentalDecorators).toBe(true);
    expect(parsed.options.emitDecoratorMetadata).toBe(true);
  });
});

/**
 * ESLint computes the configuration of every source and test file of the package and lints the files in which the
 * two rules can report something (see `needsLinting`). Until wave 27 it parsed every file (281 files then): 6 s for
 * this test file on an idle 4-CPU machine and from 13 s to 23 s under the full parallel `pnpm test` there, growing
 * with every task, almost all of it typescript-estree's parse. Now TypeScript's parser (syntax only, well under 1 s
 * idle) finds the files in which the two rules can report something, and ESLint lints those (17 in wave 27): 2.0 s
 * to 2.5 s idle and from 9 s to 21 s under the full parallel `pnpm test`. Both passes run once, in the setup hook with
 * this budget, which only stops a run that hangs; the tests below compare their results. The hook gives the event
 * loop back between files, so vitest's worker keeps answering its RPC calls.
 */
const LINT_SETUP_TIMEOUT_MS = 60_000;

/** The identifiers the two rules report: `console` of `console.*` and `process` of `process.env`. */
const RULE_IDENTIFIERS: ReadonlySet<string> = new Set(["console", "process"]);

/**
 * True when ESLint must parse the file to know what the two rules report in it. Both report an identifier only:
 * `no-console` a reference to `console`, `n/no-process-env` a member expression on `process`. TypeScript's parser
 * (syntax only, no program) finds every identifier with that name, written with `\u` escapes too, and the file goes
 * to ESLint when it has one. So does a file with a comment that names ESLint (a directive, which ESLint can report
 * as unused) and a file TypeScript cannot parse, which ESLint's TypeScript parser reports as a fatal problem. In
 * every other file neither rule can report anything, as TypeScript's syntax tree of it is complete. (ESLint's parser
 * also refuses a few constructs that TypeScript parses and leaves to its type checker, such as a modifier where none
 * is allowed: this scan reports such a file only when it has one of the two identifiers, and `pnpm typecheck` and
 * `pnpm lint` refuse it either way.)
 */
function needsLinting(file: string): boolean {
  const text = readFileSync(file, "utf8");
  if (text.includes("eslint")) {
    return true;
  }
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  // The syntax errors typescript-estree turns into ESLint's fatal "Parsing error" (it reads the same field).
  if (
    (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length > 0
  ) {
    return true;
  }
  const visit = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && RULE_IDENTIFIERS.has(node.text)) || ts.forEachChild(node, visit) === true;
  return ts.forEachChild(source, visit) === true;
}

describe("lint rules", () => {
  const RULES = ["no-console", "n/no-process-env"] as const;
  // Only the two rules run, and neither needs type information: parsing without the TypeScript project keeps it fast.
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    ruleFilter: ({ ruleId }) => RULES.some((rule) => rule === ruleId),
    overrideConfig: { languageOptions: { parserOptions: { projectService: false, project: null } } },
  });
  const files = [...filesBelow("src"), ...filesBelow("test")].filter((file) => file.endsWith(".ts"));

  /** The severity of each rule for each file, as ESLint computes the configuration (loaded once, in the hook). */
  let severities: Array<{ file: string; rule: string; severity: unknown }>;
  /** What the two rules report in every source and test file, as `file:line rule` (linted once, in the hook). */
  let findings: string[];

  beforeAll(async () => {
    severities = [];
    const candidates: string[] = [];
    for (const file of files) {
      const config = (await eslint.calculateConfigForFile(join(APP_DIR, file))) as {
        rules: Record<string, unknown>;
      };
      for (const rule of RULES) {
        const setting = config.rules[rule];
        severities.push({ file, rule, severity: Array.isArray(setting) ? setting[0] : setting });
      }
      if (needsLinting(join(APP_DIR, file))) {
        candidates.push(join(APP_DIR, file));
      }
      await setImmediate();
    }
    // (ESLint would lint its cwd, the whole repository, for an empty list.)
    const results = candidates.length === 0 ? [] : await eslint.lintFiles(candidates);
    findings = results.flatMap((result) =>
      result.messages.map(
        (message) => `${relative(APP_DIR, result.filePath)}:${message.line} ${message.ruleId}`,
      ),
    );
  }, LINT_SETUP_TIMEOUT_MS);

  it("[PBE-001 AC4] has no-console and n/no-process-env on at error level for every source and test file", () => {
    expect(files).toEqual(
      expect.arrayContaining(["src/main.ts", "src/worker.ts", "src/cli.ts", "src/config.ts"]),
    );
    expect(severities).toHaveLength(files.length * RULES.length);
    expect(severities.filter((entry) => entry.severity !== 2)).toEqual([]);
  });

  it("[PBE-001 AC4] reports console.* and process.env in this package's code", async () => {
    const [result] = await eslint.lintText(
      'console.log("x");\nexport const url = process.env["DATABASE_URL"];\n',
      {
        filePath: join(APP_DIR, "lint-probe.ts"),
      },
    );

    expect(result?.messages.map((message) => message.ruleId).sort()).toEqual([
      "n/no-process-env",
      "no-console",
    ]);
  });

  it("[PBE-001 AC4] finds no console.* and no process.env in src/ and test/", () => {
    expect(findings).toEqual([]);
  });
});

describe("reference data", () => {
  it("[PBE-001 AC5] has no reference loader in src/ and no reference-data/ folder in the package", () => {
    expect(existsSync(join(APP_DIR, "src", "reference"))).toBe(false);
    expect(existsSync(join(APP_DIR, "reference-data"))).toBe(false);
    expect(filesBelow("src").filter((file) => /reference|loader/i.test(file))).toEqual([]);
  });

  it("[PBE-001 AC5] ref:load only calls the root db:seed:reference, which runs the tools/reference-data loader", () => {
    const root = readJson<PackageJson>(join(REPO_ROOT, "package.json"));
    const loader = readJson<PackageJson>(join(REPO_ROOT, "tools", "reference-data", "package.json"));

    expect(manifest.scripts["ref:load"]).toBe("pnpm --dir ../.. db:seed:reference");
    expect(root.scripts["db:seed:reference"]).toBe(`pnpm --filter ${loader.name} run load`);
    expect(loader.name).toBe("@velexis/reference-data");
  });
});
