// migrate.js: the one migration entry point for `pnpm db:migrate`, velexis-deploy and CI (ADR-0021).
//
//   node dist/cli/migrate.js platform --dir <path>
//   node dist/cli/migrate.js reference --dir <path>
//
// The DSN comes from DATABASE_MIGRATOR_URL only, through @velexis/config (the dev env files are loaded outside
// production), so it never appears in a process list. stdout gets one JSON line per file applied, failed or
// changed; notices and errors go to stderr. Exit codes: 0 ok, 1 error, 2 checksum mismatch, 3 tenant failure
// ratio exceeded (tenant fan-out).
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import {
  isSharedMigrationSet,
  MIGRATE_EXIT_CODES,
  MigrationError,
  readMigrationFiles,
  runMigrations,
  type MigrateExitCode,
  type SharedMigrationSet,
} from "../migrate/index.js";

export const MIGRATE_USAGE = `Usage: node dist/cli/migrate.js <command> --dir <path>

Commands:
  platform --dir <path>    Apply the platform migrations (schema platform)
  reference --dir <path>   Apply the reference migrations (schema reference)

The DSN comes from DATABASE_MIGRATOR_URL only (role velexis_migrator); there is no --url flag.
A --dir that does not exist is an empty set: a notice on stderr, nothing applied, exit code 0.
stdout: one JSON line per file applied, failed or changed. Nothing when everything is up to date.
Exit codes: 0 success, 1 error, 2 checksum mismatch of an applied file, 3 tenant failure ratio exceeded.
`;

/** Where the CLI writes: `process.stdout` and `process.stderr`, or a test's buffers. */
export interface TextSink {
  write(chunk: string): unknown;
}

export interface MigrateCliIo {
  readonly stdout?: TextSink | undefined;
  readonly stderr?: TextSink | undefined;
  /** The environment to read DATABASE_MIGRATOR_URL from. Default: the process environment. */
  readonly env?: Record<string, string | undefined> | undefined;
  /** Base of a relative `--dir`. Default: the current directory. */
  readonly cwd?: string | undefined;
  /** The runner (tests replace it). Default: `runMigrations` of `@velexis/db/migrate`. */
  readonly runMigrations?: typeof runMigrations | undefined;
}

/** `packages/db` (or `db/` in a release folder): `dist/cli/` and `src/cli/` are two levels down. */
const PACKAGE_DIR = resolve(__dirname, "..", "..");

class UsageError extends Error {}

interface Invocation {
  readonly set: SharedMigrationSet;
  readonly dir: string;
}

function parseInvocation(argv: readonly string[], cwd: string): Invocation | "help" {
  if (argv.some((arg) => arg === "--url" || arg.startsWith("--url="))) {
    throw new UsageError(
      "there is no --url flag: the DSN comes from DATABASE_MIGRATOR_URL only, so it never appears in a process list (ADR-0021)",
    );
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { dir: { type: "string" }, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.values.help === true) {
    return "help";
  }
  const [command, ...extra] = parsed.positionals;
  if (command === undefined) {
    throw new UsageError("missing command");
  }
  if (!isSharedMigrationSet(command)) {
    throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  }
  if (extra.length > 0) {
    throw new UsageError(`unexpected argument ${JSON.stringify(extra[0])}`);
  }
  const dir = parsed.values.dir;
  if (dir === undefined || dir.trim() === "") {
    throw new UsageError(`${command} needs --dir <path>`);
  }
  return { set: command, dir: resolve(cwd, dir) };
}

/**
 * One line for stderr. A refused connection can be an `AggregateError` with an empty message (one error per
 * address tried), so the inner messages or the error code are used then. No error here carries the DSN.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error.message !== "") {
    return error.message;
  }
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.map(describeError).join("; ");
  }
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? `${error.name} ${code}` : error.name;
}

/** DATABASE_MIGRATOR_URL through @velexis/config; the dev env files fill it locally (never in production). */
function migratorUrl(source: Record<string, string | undefined> | undefined): string {
  const schema = { DATABASE_MIGRATOR_URL: env.url({ protocols: ["postgres:", "postgresql:"] }) };
  if (source === undefined) {
    loadDevEnvFiles({ appDir: PACKAGE_DIR });
    return defineConfig(schema).DATABASE_MIGRATOR_URL;
  }
  loadDevEnvFiles({ appDir: PACKAGE_DIR, env: source });
  return defineConfig(schema, source).DATABASE_MIGRATOR_URL;
}

/**
 * Runs `migrate.js` with `argv` (without `node` and the script) and returns its exit code. It never throws:
 * errors go to stderr as one message (a `ConfigError` names variables, never values; the DSN is never printed).
 */
export async function runMigrateCli(
  argv: readonly string[],
  io: MigrateCliIo = {},
): Promise<MigrateExitCode> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const run = io.runMigrations ?? runMigrations;
  const fail = (error: unknown): MigrateExitCode => {
    stderr.write(`migrate: ${describeError(error)}\n`);
    return error instanceof MigrationError ? error.exitCode : MIGRATE_EXIT_CODES.error;
  };

  let invocation: Invocation | "help";
  try {
    invocation = parseInvocation(argv, io.cwd ?? process.cwd());
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`migrate: ${error.message}\n\n${MIGRATE_USAGE}`);
      return MIGRATE_EXIT_CODES.error;
    }
    return fail(error);
  }
  if (invocation === "help") {
    stdout.write(MIGRATE_USAGE);
    return MIGRATE_EXIT_CODES.ok;
  }
  const { set, dir } = invocation;

  try {
    // Validate the folder before reading the configuration: a missing folder needs no database at all.
    const files = await readMigrationFiles(dir, set);
    if (!files.exists) {
      stderr.write(
        `migrate: notice: the ${set} migrations folder ${files.dir} does not exist; ` +
          "it is an empty set and nothing was applied\n",
      );
      return MIGRATE_EXIT_CODES.ok;
    }
    const url = migratorUrl(io.env);
    const result = await run({
      set,
      dir: files.dir,
      url,
      onFile: (event) => {
        stdout.write(`${JSON.stringify(event)}\n`);
      },
    });
    for (const id of result.ledgerOnly) {
      stderr.write(
        `migrate: notice: ${set}.schema_migrations has ${id}, which is not in ${result.dir} ` +
          "(applied by another release)\n",
      );
    }
    return MIGRATE_EXIT_CODES.ok;
  } catch (error) {
    return fail(error);
  }
}

if (require.main === module) {
  runMigrateCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`migrate: ${describeError(error)}\n`);
      process.exitCode = MIGRATE_EXIT_CODES.error;
    },
  );
}
