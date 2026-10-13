import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

// Tests of scripts/contracts-lint.mjs, the `contracts:lint` script of this package (task X-007). Each test runs the
// script as a child process, like `pnpm contracts:lint` does. Except for AC1, which lints the repository itself,
// the documents live in a scratch copy of the repository layout with a verbatim copy of redocly.yaml, so the
// rules under test are the repository rules and the real documents are never touched.

const PACKAGE_DIR = join(__dirname, "..");
const REPO_ROOT = join(PACKAGE_DIR, "..", "..");
const SCRIPT = join(PACKAGE_DIR, "scripts", "contracts-lint.mjs");
const CONFIG = join(PACKAGE_DIR, "redocly.yaml");
const OTA_PATH = "ota/backend/openapi/velexis-ota-booking-api.openapi.yaml";
const PLATFORM_PATH = "platform/backend/openapi/velexis-platform-api.openapi.yaml";

/** The vendor extensions of the OTA document (ota/backend/openapi/README.md §2). */
const OTA_EXTENSIONS = [
  "x-sdk-method",
  "x-scope",
  "x-amadeus",
  "x-tenant-tables",
  "x-platform-tables",
  "x-reference-tables",
  "x-error-codes",
  "x-idempotent-by-design",
  "x-error-catalogue",
  "x-tagGroups",
  "x-new-tenant-tables",
  "x-examples",
  "x-tags",
  "x-risk-personal-data-field",
] as const;

// Redocly takes seconds to start and about five more on the 40,000-line OTA document (more on a busy runner).
const SMALL_DOCUMENT_TIMEOUT_MS = 30_000;
const OTA_DOCUMENT_TIMEOUT_MS = 120_000;

/** One line of Redocly's `stylish` output: `  525:7  error  operation-operationId-unique  Every operation …`. */
const PROBLEM_LINE = /^\s+\d+:\d+\s+(error|warning)\s+(\S+)\s+(.*)$/gm;

interface LintRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Problem {
  severity: string;
  rule: string;
  message: string;
}

function runLint(args: readonly string[] = []): Promise<LintRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: PACKAGE_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      // Redocly colours its output on CI runners even when it is piped.
      resolve({ code, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) });
    });
  });
}

function problemsIn(output: string): Problem[] {
  return [...output.matchAll(PROBLEM_LINE)].map(([, severity = "", rule = "", message = ""]) => ({
    severity,
    rule,
    message,
  }));
}

/** A small OpenAPI 3.1 document with one GET operation per id; the same id twice makes it invalid. */
function smallDocument(title: string, operationIds: readonly string[]): string {
  const paths = operationIds.map((operationId, index) =>
    [
      `  /things-${index}:`,
      "    get:",
      `      operationId: ${operationId}`,
      "      summary: Read things",
      "      x-sdk-method: things.read",
      "      x-scope: customer",
      "      responses:",
      '        "200":',
      "          description: OK",
      '        "400":',
      "          description: Bad request",
    ].join("\n"),
  );
  return [
    "openapi: 3.1.0",
    "info:",
    `  title: ${title}`,
    "  version: 1.0.0",
    "  license:",
    "    name: Proprietary",
    "    identifier: LicenseRef-Proprietary",
    "servers:",
    "  - url: https://api.velexis.test",
    "security: []",
    "paths:",
    ...paths,
    "",
  ].join("\n");
}

const scratch = mkdtempSync(join(tmpdir(), "velexis-contracts-lint-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Tree {
  ota?: string;
  platform?: string;
  config?: string;
  ignoreFile?: string;
}

/**
 * Writes a scratch repository with packages/api-types/redocly.yaml (a verbatim copy unless `config` is given) and
 * the given documents at their repository paths. Returns the path of the config, for `--config`.
 */
function makeTree(name: string, tree: Tree): string {
  const root = join(scratch, name);
  const config = join(root, "packages", "api-types", "redocly.yaml");
  const files: Array<[string, string | undefined]> = [
    [OTA_PATH, tree.ota],
    [PLATFORM_PATH, tree.platform],
    ["packages/api-types/.redocly.lint-ignore.yaml", tree.ignoreFile],
  ];
  mkdirSync(dirname(config), { recursive: true });
  if (tree.config === undefined) {
    copyFileSync(CONFIG, config);
  } else {
    writeFileSync(config, tree.config);
  }
  for (const [path, content] of files) {
    if (content !== undefined) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  }
  return config;
}

describe("contracts:lint", () => {
  it(
    "lints the OTA document of the repository with zero errors and accepts its x-* extensions [X-007 AC1]",
    { timeout: OTA_DOCUMENT_TIMEOUT_MS },
    async () => {
      const document = readFileSync(join(REPO_ROOT, OTA_PATH), "utf8");
      const used = new Set([...document.matchAll(/^\s*(x-[\w-]+):/gm)].map((match) => match[1]));
      expect([...used]).toEqual(expect.arrayContaining([...OTA_EXTENSIONS]));

      const run = await runLint();

      expect(run.code).toBe(0);
      expect(run.stdout).toContain(`contracts:lint: linting "ota": ../../${OTA_PATH}`);
      expect(run.stdout).toMatch(/^contracts:lint: no errors in ota\b/m);
      const problems = problemsIn(run.stderr);
      expect(problems.filter((problem) => problem.severity === "error")).toEqual([]);
      expect(problems.filter((problem) => problem.message.includes("`x-"))).toEqual([]);
    },
  );

  it(
    "passes and says the platform document was skipped while it does not exist [X-007 AC2]",
    { timeout: SMALL_DOCUMENT_TIMEOUT_MS },
    async () => {
      const config = makeTree("platform-missing", { ota: smallDocument("OTA", ["getThings"]) });

      const run = await runLint(["--config", config]);

      expect(run.code).toBe(0);
      expect(run.stdout).toMatch(
        new RegExp(
          `^contracts:lint: skipped "platform": .*/${PLATFORM_PATH} does not exist yet; ` +
            "the platform plan creates it in M1 \\(ADR-0006\\)\\.$",
          "m",
        ),
      );
      expect(run.stdout).toMatch(/^contracts:lint: no errors in ota\.$/m);
    },
  );

  it(
    "fails on a copy of the OTA document with a duplicated operationId [X-007 AC3]",
    { timeout: OTA_DOCUMENT_TIMEOUT_MS },
    async () => {
      // Give the second operation of the document the operationId of the first one.
      const document = readFileSync(join(REPO_ROOT, OTA_PATH), "utf8");
      const [first, second] = [...document.matchAll(/^(\s+operationId:\s*)(\S+)\s*$/gm)];
      if (!first?.[2] || !second?.[1]) {
        throw new Error(`${OTA_PATH} has fewer than two operations`);
      }
      const duplicated = first[2];
      const broken = document.replace(second[0], `${second[1]}${duplicated}`);
      expect(broken.match(new RegExp(`^\\s+operationId:\\s*${duplicated}\\s*$`, "gm"))).toHaveLength(2);
      const config = makeTree("duplicated-operation-id", { ota: broken });

      const run = await runLint(["--config", config]);

      expect(run.code).toBe(1);
      const errors = problemsIn(run.stderr).filter((problem) => problem.severity === "error");
      expect(errors.map((problem) => problem.rule)).toEqual(["operation-operationId-unique"]);
      expect(run.stderr).toMatch(/^contracts:lint: failed: Redocly reported errors in ota\b/m);
    },
  );

  it("lints the platform document too once it exists", { timeout: SMALL_DOCUMENT_TIMEOUT_MS }, async () => {
    const config = makeTree("platform-valid", {
      ota: smallDocument("OTA", ["getThings"]),
      platform: smallDocument("Platform", ["getTenants"]),
    });

    const run = await runLint(["--config", config]);

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(new RegExp(`^contracts:lint: linting "platform": .*/${PLATFORM_PATH}$`, "m"));
    expect(run.stdout).not.toContain("skipped");
    expect(run.stdout).toMatch(/^contracts:lint: no errors in ota, platform\.$/m);
  });

  it("fails on an error in the platform document", { timeout: SMALL_DOCUMENT_TIMEOUT_MS }, async () => {
    const config = makeTree("platform-broken", {
      ota: smallDocument("OTA", ["getThings"]),
      platform: smallDocument("Platform", ["getTenants", "getTenants"]),
    });

    const run = await runLint(["--config", config]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(PLATFORM_PATH);
    const errors = problemsIn(run.stderr).filter((problem) => problem.severity === "error");
    expect(errors.map((problem) => problem.rule)).toEqual(["operation-operationId-unique"]);
  });

  it("fails without linting when the OTA document is missing", async () => {
    const config = makeTree("ota-missing", { platform: smallDocument("Platform", ["getTenants"]) });

    const run = await runLint(["--config", config]);

    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(new RegExp(`^contracts:lint: "ota": .*/${OTA_PATH} does not exist$`, "m"));
    expect(run.stderr).toContain('Only "platform" may be missing.');
    expect(run.stdout).not.toContain("linting");
  });

  it("refuses a Redocly ignore file next to the config", async () => {
    const config = makeTree("ignore-file", {
      ota: smallDocument("OTA", ["getThings"]),
      ignoreFile: "{}\n",
    });

    const run = await runLint(["--config", config]);

    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(
      /\.redocly\.lint-ignore\.yaml exists\. Lint problems are fixed in the document/,
    );
    expect(run.stdout).not.toContain("linting");
  });

  it("fails on a config that Redocly rejects", { timeout: SMALL_DOCUMENT_TIMEOUT_MS }, async () => {
    const misspelt = readFileSync(CONFIG, "utf8").replace(
      "operation-operationId-unique: error",
      "operation-operationId-uniqe: error",
    );
    expect(misspelt).toContain("operation-operationId-uniqe");
    const config = makeTree("bad-config", { ota: smallDocument("OTA", ["getThings"]), config: misspelt });

    const run = await runLint(["--config", config]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("Property `operation-operationId-uniqe` is not expected here.");
  });

  it("fails on a config without APIs and on an unknown option", async () => {
    const config = makeTree("no-apis", { config: "extends:\n  - recommended\n" });

    const noApis = await runLint(["--config", config]);
    const unknownOption = await runLint(["--strict"]);

    expect(noApis.code).toBe(1);
    expect(noApis.stderr).toMatch(/lists no APIs under "apis"/);
    expect(unknownOption.code).toBe(1);
    expect(unknownOption.stderr).toContain(
      "usage: node scripts/contracts-lint.mjs [--config <redocly.yaml>]",
    );
  });
});
