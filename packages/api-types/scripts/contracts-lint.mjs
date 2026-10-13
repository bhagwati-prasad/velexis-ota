#!/usr/bin/env node
// contracts-lint.mjs: Redocly lint of the Velexis OpenAPI documents (ADR-0006 "Workflow" step 2, task X-007).
//
// Usage (from packages/api-types; `pnpm contracts:lint` at the repository root runs it through Turborepo):
//   node scripts/contracts-lint.mjs                      # the APIs of ../redocly.yaml
//   node scripts/contracts-lint.mjs --config <file>      # another Redocly config with the same layout (tests)
//
// Reads the `apis` of the Redocly config and lints every API whose document exists, in one Redocly run with the
// rules of that config. The platform document is skipped with a notice until the platform plan creates it in M1;
// any other missing document fails the run. Exits 1 on any lint error, on a config that Redocly rejects, and on a
// Redocly ignore file next to the config: problems are fixed in the document, never ignored (AGENTS.md §7).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse } from "yaml";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: node scripts/contracts-lint.mjs [--config <redocly.yaml>]";
const IGNORE_FILE = ".redocly.lint-ignore.yaml";

/**
 * Redocly CLI 1.x calls the network on its own: usage telemetry (sent even when `telemetry: off` cannot take effect,
 * as on a config error) and an npm registry check for a newer version. Both are switched off for every run, so a
 * lint never leaves the machine and tests stay offline (AGENTS.md §7). The variables are added to the inherited
 * environment with env(1), because only @velexis/config touches process.env (conventions §1).
 */
const ENV_COMMAND = "/usr/bin/env";
const REDOCLY_ENV = ["REDOCLY_TELEMETRY=off", "REDOCLY_SUPPRESS_UPDATE_NOTICE=true"];

/** APIs whose document may be missing, with the reason printed when it is skipped. */
const OPTIONAL_APIS = new Map([["platform", "the platform plan creates it in M1 (ADR-0006)"]]);

class LintSetupError extends Error {}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const shown = (file) => path.relative(process.cwd(), file) || ".";

function readOptions(argv) {
  try {
    const { values } = parseArgs({ args: argv, options: { config: { type: "string" } }, strict: true });
    return { config: path.resolve(values.config ?? path.join(PACKAGE_DIR, "redocly.yaml")) };
  } catch (err) {
    throw new LintSetupError(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
  }
}

/** The APIs of the config with their document paths, resolved against the config's folder as Redocly does. */
function readApis(configFile) {
  let config;
  try {
    config = parse(readFileSync(configFile, "utf8"));
  } catch (err) {
    throw new LintSetupError(
      `cannot read ${shown(configFile)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const apis = isObject(config) ? config.apis : undefined;
  if (!isObject(apis) || Object.keys(apis).length === 0) {
    throw new LintSetupError(`${shown(configFile)} lists no APIs under "apis"`);
  }
  return Object.entries(apis).map(([name, api]) => {
    if (!isObject(api) || typeof api.root !== "string" || api.root.trim() === "") {
      throw new LintSetupError(`API "${name}" in ${shown(configFile)} has no "root" document`);
    }
    return { name, document: path.resolve(path.dirname(configFile), api.root) };
  });
}

function main(argv) {
  const { config } = readOptions(argv);
  const ignoreFile = path.join(path.dirname(config), IGNORE_FILE);
  if (existsSync(ignoreFile)) {
    throw new LintSetupError(
      `${shown(ignoreFile)} exists. Lint problems are fixed in the document, never ignored (AGENTS.md §7).`,
    );
  }

  const apis = readApis(config).map((api) => ({ ...api, exists: existsSync(api.document) }));
  const missing = apis.filter((api) => !api.exists && !OPTIONAL_APIS.has(api.name));
  if (missing.length > 0) {
    throw new LintSetupError(
      missing.map((api) => `"${api.name}": ${shown(api.document)} does not exist`).join("\n") +
        `\nOnly ${[...OPTIONAL_APIS.keys()].map((name) => `"${name}"`).join(", ")} may be missing.`,
    );
  }
  for (const api of apis) {
    console.log(
      api.exists
        ? `contracts:lint: linting "${api.name}": ${shown(api.document)}`
        : `contracts:lint: skipped "${api.name}": ${shown(api.document)} does not exist yet; ` +
            `${OPTIONAL_APIS.get(api.name)}.`,
    );
  }
  const names = apis.filter((api) => api.exists).map((api) => api.name);
  if (names.length === 0) {
    throw new LintSetupError("no document to lint");
  }

  const cli = createRequire(import.meta.url).resolve("@redocly/cli/bin/cli.js");
  const result = spawnSync(
    ENV_COMMAND,
    [
      ...REDOCLY_ENV,
      process.execPath,
      cli,
      "lint",
      ...names,
      "--config",
      config,
      "--format",
      "stylish",
      "--lint-config",
      "error",
    ],
    { stdio: "inherit" },
  );
  if (result.error) {
    throw new LintSetupError(`cannot run Redocly CLI: ${result.error.message}`);
  }
  if (result.status !== 0) {
    console.error(
      `contracts:lint: failed: Redocly reported errors in ${names.join(", ")} or in ${shown(config)} (see above). ` +
        `Fix the document; ${IGNORE_FILE} is not accepted.`,
    );
    return 1;
  }
  console.log(`contracts:lint: no errors in ${names.join(", ")}.`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof LintSetupError)) {
    throw err;
  }
  console.error(`contracts:lint: ${err.message}`);
  process.exitCode = 1;
}
