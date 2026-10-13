// Logging goes through the injected pino logger and configuration through @velexis/config (conventions §1, §7). The
// root ESLint config enforces both with `no-console` and `n/no-process-env`; these tests prove the two rules are active
// for this package and that no file of it breaks or switches off either.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
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
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    ruleFilter: ({ ruleId }) => RULES.some((rule) => rule === ruleId),
    overrideConfig: { languageOptions: { parserOptions: { projectService: false, project: null } } },
  });

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

  it("finds no console.* and no process.env in src/ and test/ [OBE-001 AC4]", async () => {
    const files = packageFiles();
    expect(files.map((file) => relative(APP_DIR, file))).toEqual(
      expect.arrayContaining(["src/main.ts", "src/worker.ts", "src/cli.ts", "src/config.ts"]),
    );

    const results = await eslint.lintFiles(files);

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
