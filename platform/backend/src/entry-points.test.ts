import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestJwtKeyFile } from "../test/support/jwt-key";
import { createTestMasterKeyDir, testCryptoAndMailEnv } from "../test/support/master-key";
import { usage, CLI_COMMANDS, EXIT_OK, EXIT_USAGE } from "./cli";
import { APP_DIR } from "./config";
import { startApi } from "./main";
import { startWorker } from "./worker";

/** A pino destination that keeps the parsed lines. */
function logSink(): { readonly lines: Record<string, unknown>[]; write(line: string): void } {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    write(line: string) {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
}

/** The development PLATFORM_BFF_KEY of platform/backend/.env.example (a dummy value). */
const BFF_KEY = "dev_bff_key_change_me_0123456789abcdef";

/** A JWT signing key of mode 0600 in a temporary folder (JWT_PRIVATE_KEY_FILE must name a valid key file). */
const jwtKey = createTestJwtKeyFile();
/** A master key folder (MASTER_KEY_DIR must name an existing folder). */
const masterKeys = createTestMasterKeyDir();

afterAll(() => {
  jwtKey.remove();
  masterKeys.remove();
});

/** Everything but DATABASE_URL. */
const WITHOUT_DATABASE_URL = {
  APP_ENV: "test",
  REDIS_URL: "redis://127.0.0.1:6379/0",
  PLATFORM_BFF_KEY: BFF_KEY,
  JWT_PRIVATE_KEY_FILE: jwtKey.path,
  ...testCryptoAndMailEnv(masterKeys),
} as const;

/** The one line the entry points log when DATABASE_URL is missing. */
function configInvalidLine(app: string): unknown {
  return expect.objectContaining({
    level: 60,
    app,
    msg: "config.invalid",
    err: expect.objectContaining({
      type: "ConfigError",
      message: "Invalid configuration (1 problem):\n  - DATABASE_URL is required but missing",
    }),
  });
}

// The entry points exit with code 1 when these functions resolve to undefined (`process.exit(1)` in main.ts and
// worker.ts); nothing is created before the configuration is valid, so no connection is attempted here.
describe.each([
  ["startApi", "platform-api", startApi],
  ["startWorker", "platform-worker", startWorker],
] as const)("%s", (_name, app, start) => {
  it("[PBE-001 AC3] refuses to start without DATABASE_URL, logging the ConfigError that names it", async () => {
    const logs = logSink();

    await expect(start({ env: WITHOUT_DATABASE_URL, logDestination: logs })).resolves.toBeUndefined();

    expect(logs.lines).toEqual([configInvalidLine(app)]);
  });
});

/**
 * Compiles the sources of the build (tsconfig.build.json: src/ without the tests) to CommonJS in `outDir`, as `tsc`
 * compiles them to dist/, so the entry points run as processes without depending on an earlier build.
 */
function compileSources(outDir: string): void {
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
  const compilerOptions: ts.CompilerOptions = {
    ...parsed.options,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    sourceMap: false,
  };
  for (const file of parsed.fileNames) {
    const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions,
      fileName: file,
    });
    const target = join(outDir, relative(join(APP_DIR, "src"), file).replace(/\.ts$/, ".js"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, outputText);
  }
}

// `node dist/main.js`, `node dist/worker.js` and `node dist/cli.js` as systemd and operators run them: the
// `require.main === module` blocks turn the start functions' results into the process's exit code.
describe("the entry points as processes", () => {
  let outDir: string;

  /** Runs `<entry>.js` of the compiled sources with only `env`; packages resolve from this package's node_modules. */
  function run(
    entry: string,
    args: readonly string[],
    env: Record<string, string>,
  ): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, [join(outDir, `${entry}.js`), ...args], {
      env: { ...env, NODE_PATH: join(APP_DIR, "node_modules") },
      encoding: "utf8",
      timeout: 30_000,
    });
  }

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "velexis-platform-backend-entry-"));
    compileSources(outDir);
  });

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it.each([
    ["main", "platform-api"],
    ["worker", "platform-worker"],
  ])(
    "[PBE-001 AC3] node dist/%s.js exits 1 without DATABASE_URL, after one fatal line whose ConfigError names it",
    (entry, app) => {
      // As on the VM (APP_ENV and NODE_ENV production): no .env.local file is read.
      const result = run(entry, [], {
        APP_ENV: "production",
        NODE_ENV: "production",
        REDIS_URL: "redis://127.0.0.1:6379/0",
        PLATFORM_BFF_KEY: BFF_KEY,
        JWT_PRIVATE_KEY_FILE: jwtKey.path,
        ...testCryptoAndMailEnv(masterKeys),
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      expect(
        result.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as unknown),
      ).toEqual([configInvalidLine(app)]);
    },
  );

  it("node dist/cli.js exits 0 for help and 2 without a command, with no configuration at all", () => {
    const help = run("cli", ["help"], {});
    const none = run("cli", [], {});

    expect([help.status, help.stdout, help.stderr]).toEqual([EXIT_OK, usage(CLI_COMMANDS), ""]);
    expect([none.status, none.stdout, none.stderr]).toEqual([
      EXIT_USAGE,
      "",
      `No command given.\n\n${usage(CLI_COMMANDS)}`,
    ]);
  });
});
