// migrate.js: the one migration entry point for `pnpm db:migrate`, `pnpm db:migrate:tenants`, velexis-deploy and CI
// (ADR-0021).
//
//   node dist/cli/migrate.js platform --dir <path>
//   node dist/cli/migrate.js reference --dir <path>
//   node dist/cli/migrate.js tenants --dir <path> [--concurrency 4] [--max-failure-ratio 0.1] [--report <file>]
//   node dist/cli/migrate.js tenant --schema tenant_<key> --dir <path> [--create]
//
// The DSN comes from DATABASE_MIGRATOR_URL only, through @velexis/config (the dev env files are loaded outside
// production), so it never appears in a process list. stdout gets one JSON line per file applied, failed or
// changed; notices and errors go to stderr. Exit codes: 0 ok, 1 error, 2 checksum mismatch, 3 tenant failure
// ratio exceeded (tenant fan-out).
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { defineConfig, env, loadDevEnvFiles } from "@velexis/config";
import {
  DEFAULT_MAX_FAILURE_RATIO,
  DEFAULT_TENANT_CONCURRENCY,
  isSharedMigrationSet,
  MIGRATE_EXIT_CODES,
  MigrationError,
  migrateTenants,
  migrateTenantSchema,
  readMigrationFiles,
  runMigrations,
  type MigrateExitCode,
  type MigrationSet,
  type SharedMigrationSet,
} from "../migrate/index.js";
import { isTenantSchema, TENANT_SCHEMA_PATTERN } from "../tenant-schema.js";

export const MIGRATE_USAGE = `Usage: node dist/cli/migrate.js <command> --dir <path> [options]

Commands:
  platform --dir <path>    Apply the platform migrations (schema platform)
  reference --dir <path>   Apply the reference migrations (schema reference)
  tenants --dir <path> [--concurrency ${DEFAULT_TENANT_CONCURRENCY}] [--max-failure-ratio ${DEFAULT_MAX_FAILURE_RATIO}] [--report <file>]
                           Apply the tenant migrations to every tenant schema of platform.tenants (status
                           provisioning, active or suspended), --concurrency schemas at a time, each in its own
                           transaction; a failed schema does not stop the others. --report writes the JSON report.
  tenant --schema tenant_<key> --dir <path> [--create]
                           Apply the tenant migrations to one schema; --create creates the schema and the grants
                           of velexis_ota_app in the same transaction (provisioning, tests, repairs)

The DSN comes from DATABASE_MIGRATOR_URL only (role velexis_migrator); there is no --url flag.
Tenant objects are created as velexis_provisioner (SET LOCAL ROLE), whoever connects.
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
  /** Base of a relative `--dir` or `--report`. Default: the current directory. */
  readonly cwd?: string | undefined;
  /** The runner (tests replace it). Default: `runMigrations` of `@velexis/db/migrate`. */
  readonly runMigrations?: typeof runMigrations | undefined;
  /** The tenant fan-out (tests replace it). Default: `migrateTenants`. */
  readonly migrateTenants?: typeof migrateTenants | undefined;
  /** The single-schema runner (tests replace it). Default: `migrateTenantSchema`. */
  readonly migrateTenantSchema?: typeof migrateTenantSchema | undefined;
}

/** `packages/db` (or `db/` in a release folder): `dist/cli/` and `src/cli/` are two levels down. */
const PACKAGE_DIR = resolve(__dirname, "..", "..");

class UsageError extends Error {}

type Invocation =
  | { readonly command: SharedMigrationSet; readonly dir: string }
  | {
      readonly command: "tenants";
      readonly dir: string;
      readonly concurrency: number;
      readonly maxFailureRatio: number;
      readonly report: string | undefined;
    }
  | { readonly command: "tenant"; readonly dir: string; readonly schema: string; readonly create: boolean };

const COMMANDS = ["platform", "reference", "tenants", "tenant"] as const;
type Command = (typeof COMMANDS)[number];

/** The options a command may take besides --dir; any other option is a usage error. */
const COMMAND_OPTIONS = {
  platform: [],
  reference: [],
  tenants: ["concurrency", "max-failure-ratio", "report"],
  tenant: ["schema", "create"],
} as const satisfies Record<Command, readonly string[]>;
const COMMAND_SPECIFIC_OPTIONS = ["schema", "create", "concurrency", "max-failure-ratio", "report"] as const;

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

/** `--concurrency`: a positive integer (default 4). */
function parseConcurrency(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_TENANT_CONCURRENCY;
  }
  if (!/^[1-9][0-9]{0,5}$/.test(value)) {
    throw new UsageError(`--concurrency must be a positive integer, not ${JSON.stringify(value)}`);
  }
  return Number(value);
}

/** `--max-failure-ratio`: a decimal number from 0 to 1 (default 0.1, that is 10 %). */
function parseMaxFailureRatio(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_FAILURE_RATIO;
  }
  const ratio = /^(?:[01]|[01]?\.[0-9]+)$/.test(value) ? Number(value) : Number.NaN;
  if (!(ratio >= 0 && ratio <= 1)) {
    throw new UsageError(
      `--max-failure-ratio must be a number from 0 to 1 (0.1 is 10 %), not ${JSON.stringify(value)}`,
    );
  }
  return ratio;
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
      options: {
        dir: { type: "string" },
        schema: { type: "string" },
        create: { type: "boolean" },
        concurrency: { type: "string" },
        "max-failure-ratio": { type: "string" },
        report: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values } = parsed;
  if (values.help === true) {
    return "help";
  }
  const [command, ...extra] = parsed.positionals;
  if (command === undefined) {
    throw new UsageError("missing command");
  }
  if (!isCommand(command)) {
    throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  }
  if (extra.length > 0) {
    throw new UsageError(`unexpected argument ${JSON.stringify(extra[0])}`);
  }
  const allowed: readonly string[] = COMMAND_OPTIONS[command];
  for (const option of COMMAND_SPECIFIC_OPTIONS) {
    if (values[option] !== undefined && !allowed.includes(option)) {
      throw new UsageError(`${command} does not take --${option}`);
    }
  }
  if (values.dir === undefined || values.dir.trim() === "") {
    throw new UsageError(`${command} needs --dir <path>`);
  }
  const dir = resolve(cwd, values.dir);

  if (command === "tenants") {
    const report = values.report;
    if (report !== undefined && report.trim() === "") {
      throw new UsageError("--report needs a file name");
    }
    return {
      command,
      dir,
      concurrency: parseConcurrency(values.concurrency),
      maxFailureRatio: parseMaxFailureRatio(values["max-failure-ratio"]),
      report: report === undefined ? undefined : resolve(cwd, report),
    };
  }
  if (command === "tenant") {
    const schema = values.schema;
    if (schema === undefined) {
      throw new UsageError("tenant needs --schema tenant_<key>");
    }
    // Checked before anything is read or a connection is opened.
    if (!isTenantSchema(schema)) {
      throw new UsageError(
        `--schema ${JSON.stringify(schema.slice(0, 64))} is not a tenant schema name: it must match ` +
          String(TENANT_SCHEMA_PATTERN),
      );
    }
    return { command, dir, schema, create: values.create === true };
  }
  return { command, dir };
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

/** `0.333…` → `33.3 %`. */
const percent = (ratio: number): string => `${Math.round(ratio * 1000) / 10} %`;

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
  const fail = (error: unknown): MigrateExitCode => {
    stderr.write(`migrate: ${describeError(error)}\n`);
    return error instanceof MigrationError ? error.exitCode : MIGRATE_EXIT_CODES.error;
  };
  const printEvent = (event: object): void => {
    stdout.write(`${JSON.stringify(event)}\n`);
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
  const set: MigrationSet = isSharedMigrationSet(invocation.command) ? invocation.command : "tenant";

  try {
    // Validate the folder before reading the configuration: a missing folder needs no database at all.
    const files = await readMigrationFiles(invocation.dir, set);
    if (!files.exists) {
      stderr.write(
        `migrate: notice: the ${set} migrations folder ${files.dir} does not exist; ` +
          "it is an empty set and nothing was applied\n",
      );
      return MIGRATE_EXIT_CODES.ok;
    }
    const url = migratorUrl(io.env);

    if (invocation.command === "tenants") {
      const { maxFailureRatio } = invocation;
      const result = await (io.migrateTenants ?? migrateTenants)({
        dir: files.dir,
        url,
        concurrency: invocation.concurrency,
        maxFailureRatio,
        report: invocation.report,
        onFile: printEvent,
      });
      const report = result.report;
      if (report !== null) {
        for (const { schema, reason } of report.skipped) {
          stderr.write(`migrate: notice: ${schema} skipped: ${reason}\n`);
        }
        for (const { schema, file, error } of report.failed) {
          const sqlstate = error.code === undefined ? "" : ` (SQLSTATE ${error.code})`;
          stderr.write(
            `migrate: ${schema}${file === null ? "" : ` ${file}`} failed: ${error.message}${sqlstate}\n`,
          );
        }
        if (report.failed.length > 0) {
          const verdict =
            result.exitCode === MIGRATE_EXIT_CODES.failureRatioExceeded
              ? `more than --max-failure-ratio ${maxFailureRatio} allows`
              : `within --max-failure-ratio ${maxFailureRatio}`;
          stderr.write(
            `migrate: ${report.failed.length} of ${report.total} tenant schema(s) failed ` +
              `(${percent(result.failureRatio)}), ${verdict}\n`,
          );
        }
      }
      return result.exitCode;
    }

    if (invocation.command === "tenant") {
      const { schema } = invocation;
      const result = await (io.migrateTenantSchema ?? migrateTenantSchema)({
        schema,
        dir: files.dir,
        url,
        create: invocation.create,
        onFile: printEvent,
      });
      for (const id of result.ledgerOnly) {
        stderr.write(
          `migrate: notice: ${schema}.schema_migrations has ${id}, which is not in ${result.dir} ` +
            "(applied by another release)\n",
        );
      }
      return MIGRATE_EXIT_CODES.ok;
    }

    const { command } = invocation;
    const result = await (io.runMigrations ?? runMigrations)({
      set: command,
      dir: files.dir,
      url,
      onFile: printEvent,
    });
    for (const id of result.ledgerOnly) {
      stderr.write(
        `migrate: notice: ${command}.schema_migrations has ${id}, which is not in ${result.dir} ` +
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
