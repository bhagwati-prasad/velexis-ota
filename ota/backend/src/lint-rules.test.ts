// Logging goes through the injected pino logger and configuration through @velexis/config (conventions §1, §7). The
// root ESLint config enforces both with `no-console` and `n/no-process-env`; these tests prove the two rules are active
// for this package and that no file of it breaks or switches off either. They also prove that `fetch` and the HTTP
// clients are refused outside src/amadeus/ (OADR-0001 point 1, OBE-018).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_DIR } from "./config";

const REPO_ROOT = join(APP_DIR, "..", "..");
const RULES = ["no-console", "n/no-process-env"] as const;
/** A disable comment naming either rule. Built from parts, so this file does not match itself. */
const DISABLE_COMMENT = new RegExp(`${["eslint", "disable"].join("-")}[^\\n]*(no-console|no-process-env)`);

/** The TypeScript files of src/ and test/. */
function packageFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return walk(path);
      }
      return entry.name.endsWith(".ts") ? [path] : [];
    });
  return [...walk(join(APP_DIR, "src")), ...walk(join(APP_DIR, "test"))];
}

describe("lint rules of the OTA backend", () => {
  // Only the two rules run, and neither needs type information: parsing without the TypeScript project keeps it fast.
  // Files the root config ignores (the generated Amadeus types, OBE-017) give no result instead of an "ignored"
  // warning; the test of src/ and test/ below proves that nothing else is ignored.
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    ruleFilter: ({ ruleId }) => RULES.some((rule) => rule === ruleId),
    overrideConfig: { languageOptions: { parserOptions: { projectService: false, project: null } } },
    warnIgnored: false,
  });

  let files: string[];
  let results: ESLint.LintResult[];

  // Loading the root config with its plugins and parser is most of the work (about 1 s here, 10 s under a full
  // parallel `pnpm test`), then linting every file of the package (about 2 s here, several times that on a loaded
  // 4-CPU runner, and more with every file the package grows). Both happen once, in this hook with its own timeout,
  // as in the platform backend's package.test.ts, so the tests below measure only their own work and a loaded
  // machine cannot time them out.
  beforeAll(async () => {
    await eslint.calculateConfigForFile(join(APP_DIR, "src/main.ts"));
    files = packageFiles();
    results = await eslint.lintFiles(files);
  }, 60_000);

  it("reports console.* and process.env in this package's code", async () => {
    const [result] = await eslint.lintText(
      'console.log("x");\nexport const value = process.env["DATABASE_URL"];\n',
      { filePath: join(APP_DIR, "lint-probe.ts") },
    );

    expect(result?.messages.map((message) => message.ruleId).sort()).toEqual([
      "n/no-process-env",
      "no-console",
    ]);
  });

  it("has both rules on at error level for the sources, entry points and tests", async () => {
    for (const file of [
      "src/main.ts",
      "src/worker.ts",
      "src/cli.ts",
      "src/config.ts",
      "test/helpers/ports.ts",
    ]) {
      const config = (await eslint.calculateConfigForFile(join(APP_DIR, file))) as {
        rules: Record<string, unknown>;
      };
      for (const rule of RULES) {
        const setting = config.rules[rule];
        expect([2, "error"]).toContain(Array.isArray(setting) ? setting[0] : setting);
      }
    }
  });

  it("finds no console.* and no process.env in src/ and test/ [OBE-001 AC4]", () => {
    expect(files.map((file) => relative(APP_DIR, file))).toEqual(
      expect.arrayContaining(["src/main.ts", "src/worker.ts", "src/cli.ts", "src/config.ts"]),
    );
    // Only generated code is skipped: every hand-written file of src/ and test/ was linted.
    const linted = new Set(results.map((result) => result.filePath));
    expect(
      files
        .filter((file) => !linted.has(file))
        .map((file) => relative(APP_DIR, file))
        .filter((file) => !file.startsWith("src/amadeus/generated/")),
    ).toEqual([]);

    const problems = results.flatMap((result) =>
      result.messages.map(
        (message) => `${relative(APP_DIR, result.filePath)}:${message.line} ${message.ruleId}`,
      ),
    );
    expect(problems).toEqual([]);
  });

  it("never switches the two rules off with a disable comment", () => {
    const offenders = packageFiles().filter((file) => DISABLE_COMMENT.test(readFileSync(file, "utf8")));

    expect(offenders.map((file) => relative(APP_DIR, file))).toEqual([]);
  });
});

// Only src/amadeus/ talks to Amadeus (OADR-0001 point 1, OBE-018): the root config forbids `fetch` and the HTTP clients
// in the rest of the package's production code. `pnpm lint` checks the files; these probes prove the rules are on
// where they must be and off where the client lives.
describe("the Amadeus-only HTTP rules of the OTA backend [OBE-018]", () => {
  const AMADEUS_RULES = [
    "no-restricted-globals",
    "no-restricted-properties",
    "no-restricted-imports",
  ] as const;
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    ruleFilter: ({ ruleId }) => AMADEUS_RULES.some((rule) => rule === ruleId),
    overrideConfig: { languageOptions: { parserOptions: { projectService: false, project: null } } },
    warnIgnored: false,
  });
  const PROBE = [
    'import { createServer } from "node:http";',
    'import { request } from "node:https";',
    'import { fetch as undiciFetch } from "undici";',
    'import http from "node:http";',
    'import * as https from "node:https";',
    'export const viaGlobal = fetch("https://test.travel.api.amadeus.com/v2/shopping/flight-offers");',
    'export const viaGlobalThis = globalThis.fetch("https://test.travel.api.amadeus.com");',
    "export { createServer, request, undiciFetch, http, https };",
    "",
  ].join("\n");

  /** `line ruleId` of every message the probe gets at `path` (relative to the package). */
  async function problems(path: string): Promise<string[]> {
    const [result] = await eslint.lintText(PROBE, { filePath: join(APP_DIR, path) });
    return (result?.messages ?? []).map((message) => `${message.line} ${message.ruleId}`);
  }

  // Loading the root config with its plugins and parser takes about 1 s here and up to 10 s under a full parallel
  // `pnpm test` (as above): once, in this hook with its own timeout.
  beforeAll(async () => {
    await eslint.calculateConfigForFile(join(APP_DIR, "src/main.ts"));
  }, 60_000);

  it("refuses fetch, globalThis.fetch and HTTP client imports outside src/amadeus/, and allows an HTTP server", async () => {
    // Lines 4 and 5: the default and namespace imports of node:http(s), which reach `request` without naming it.
    const expected = [
      "2 no-restricted-imports",
      "3 no-restricted-imports",
      "4 no-restricted-imports",
      "5 no-restricted-imports",
      "6 no-restricted-globals",
      "7 no-restricted-properties",
    ];

    expect(await problems("src/bookings/lint-probe.ts")).toEqual(expected);
    expect(await problems("src/common/http/lint-probe.ts")).toEqual(expected);
  });

  it("allows them in src/amadeus/ and in unit tests", async () => {
    expect(await problems("src/amadeus/lint-probe.ts")).toEqual([]);
    expect(await problems("src/bookings/lint-probe.test.ts")).toEqual([]);
  });

  it("keeps the dependency rule of ADR-0002 next to them", async () => {
    const [result] = await eslint.lintText('export { x } from "@velexis/platform-backend";\n', {
      filePath: join(APP_DIR, "src/bookings/lint-probe.ts"),
    });

    expect(result?.messages.map((message) => message.ruleId)).toEqual(["no-restricted-imports"]);
  });
});
