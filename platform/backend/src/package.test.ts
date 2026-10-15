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

  it("[PBE-001 AC1] the build script's entry-point check fails while one of the three files is missing", () => {
    const check = /&& node -e "([^"]+)"$/.exec(manifest.scripts["build"] ?? "")?.[1];
    if (check === undefined) {
      throw new Error("the build script has no `node -e` entry-point check");
    }
    const dir = mkdtempSync(join(tmpdir(), "velexis-platform-backend-build-"));
    try {
      mkdirSync(join(dir, "dist"));
      const runCheck = (): number | null => spawnSync(process.execPath, ["-e", check], { cwd: dir }).status;
      for (const entry of ["main", "worker"]) {
        writeFileSync(join(dir, "dist", `${entry}.js`), "");
      }

      expect(runCheck()).not.toBe(0);
      writeFileSync(join(dir, "dist", "cli.js"), "");
      expect(runCheck()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits CommonJS with decorator metadata, which NestJS's dependency injection needs", () => {
    expect(manifest.type).toBe("commonjs");
    expect(parsed.options.experimentalDecorators).toBe(true);
    expect(parsed.options.emitDecoratorMetadata).toBe(true);
  });
});

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

  beforeAll(async () => {
    severities = [];
    for (const file of files) {
      const config = (await eslint.calculateConfigForFile(join(APP_DIR, file))) as {
        rules: Record<string, unknown>;
      };
      for (const rule of RULES) {
        const setting = config.rules[rule];
        severities.push({ file, rule, severity: Array.isArray(setting) ? setting[0] : setting });
      }
    }
  });

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

  it("[PBE-001 AC4] finds no console.* and no process.env in src/ and test/", async () => {
    const results = await eslint.lintFiles(files.map((file) => join(APP_DIR, file)));

    expect(
      results.flatMap((result) =>
        result.messages.map(
          (message) => `${relative(APP_DIR, result.filePath)}:${message.line} ${message.ruleId}`,
        ),
      ),
    ).toEqual([]);
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
