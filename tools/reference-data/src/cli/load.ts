// load.js: the reference data loader for `pnpm db:seed:reference` and velexis-deploy (task X-018, ADR-0024).
//
//   node dist/cli/load.js --data <dir>
//
// The DSN comes from DATABASE_URL only, through @velexis/config (the dev env files are loaded outside production),
// so it never appears in a process list; on the VM it is the platform role's DSN of the root-only
// /etc/velexis/reference-loader.env. The outcome is one JSON line on stdout from @velexis/logger: `reference.loaded`
// with the counts per table, or `reference.load_failed` with the error (never the DSN). Usage and configuration
// errors go to stderr. Exit codes: 0 loaded, 1 error (nothing changed).
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import { createLogger } from "@velexis/logger";
import { loadReferenceData } from "../load.js";

export const LOAD_USAGE = `Usage: node dist/cli/load.js --data <dir>

Loads the reference datasets of <dir> (the seven CSV files and overrides.csv) into the reference schema in one
transaction: upserts in foreign-key order, overrides applied, missing codes set inactive, nothing deleted.

The DSN comes from DATABASE_URL only (role velexis_platform_app); there is no --url flag.
stdout: one JSON log line, "reference.loaded" with the counts per table or "reference.load_failed".
Exit codes: 0 loaded, 1 error (the transaction was rolled back).
`;

/** Where the CLI writes: `process.stdout` and `process.stderr`, or a test's buffers. */
export interface TextSink {
  write(chunk: string): unknown;
}

export interface LoadCliIo {
  readonly stdout?: TextSink | undefined;
  readonly stderr?: TextSink | undefined;
  /** The environment to read DATABASE_URL, APP_ENV and NODE_ENV from. Default: the process environment. */
  readonly env?: Record<string, string | undefined> | undefined;
  /** Base of a relative `--data`. Default: the current directory. */
  readonly cwd?: string | undefined;
  /** The loader (tests replace it). Default: `loadReferenceData`. */
  readonly load?: typeof loadReferenceData | undefined;
}

export const LOAD_EXIT_CODES = Object.freeze({ ok: 0, error: 1 } as const);
export type LoadExitCode = (typeof LOAD_EXIT_CODES)[keyof typeof LOAD_EXIT_CODES];

/** `tools/reference-data` (or `reference-data/` in a release folder): `dist/cli/` and `src/cli/` are two levels down. */
const PACKAGE_DIR = resolve(__dirname, "..", "..");

/** The process name of the log lines. */
const APP = "reference-loader";

const CONFIG_SCHEMA = {
  DATABASE_URL: env.url({ protocols: ["postgres:", "postgresql:"] }),
  APP_ENV: env.enum(["development", "test", "production"] as const, { optional: true }),
  // velexis-deploy sets only NODE_ENV=production for its one-off units (reference-loader.env holds the DSN alone).
  NODE_ENV: env.string({ optional: true }),
};

class UsageError extends Error {}

function parseInvocation(argv: readonly string[], cwd: string): { readonly dataDir: string } | "help" {
  if (argv.some((arg) => arg === "--url" || arg.startsWith("--url="))) {
    throw new UsageError(
      "there is no --url flag: the DSN comes from DATABASE_URL only, so it never appears in a process list",
    );
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { data: { type: "string" }, help: { type: "boolean", short: "h" } },
      allowPositionals: false,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.values.help === true) {
    return "help";
  }
  const data = parsed.values.data;
  if (data === undefined || data.trim() === "") {
    throw new UsageError("missing --data <dir>");
  }
  return { dataDir: resolve(cwd, data) };
}

function readConfig(source: Record<string, string | undefined> | undefined) {
  if (source === undefined) {
    loadDevEnvFiles({ appDir: PACKAGE_DIR });
    return defineConfig(CONFIG_SCHEMA);
  }
  loadDevEnvFiles({ appDir: PACKAGE_DIR, env: source });
  return defineConfig(CONFIG_SCHEMA, source);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs `load.js` with `argv` (without `node` and the script) and returns its exit code. It never throws. A
 * `ConfigError` names variables, never values; no message carries the DSN.
 */
export async function runLoadCli(argv: readonly string[], io: LoadCliIo = {}): Promise<LoadExitCode> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const load = io.load ?? loadReferenceData;

  let invocation: { readonly dataDir: string } | "help";
  try {
    invocation = parseInvocation(argv, io.cwd ?? process.cwd());
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`load: ${error.message}\n\n${LOAD_USAGE}`);
      return LOAD_EXIT_CODES.error;
    }
    stderr.write(`load: ${describeError(error)}\n`);
    return LOAD_EXIT_CODES.error;
  }
  if (invocation === "help") {
    stdout.write(LOAD_USAGE);
    return LOAD_EXIT_CODES.ok;
  }

  let config;
  try {
    config = readConfig(io.env);
  } catch (error) {
    stderr.write(`load: ${describeError(error)}\n`);
    return LOAD_EXIT_CODES.error;
  }

  const logger = createLogger({
    app: APP,
    env: config.APP_ENV ?? config.NODE_ENV ?? "development",
    level: "info",
    destination: stdout,
  });
  const { dataDir } = invocation;
  try {
    const result = await load({ url: config.DATABASE_URL, dataDir });
    logger.info({ dataDir, ...result }, "reference.loaded");
    return LOAD_EXIT_CODES.ok;
  } catch (error) {
    logger.error({ err: error, dataDir }, "reference.load_failed");
    return LOAD_EXIT_CODES.error;
  }
}

if (require.main === module) {
  runLoadCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`load: ${describeError(error)}\n`);
      process.exitCode = LOAD_EXIT_CODES.error;
    },
  );
}
