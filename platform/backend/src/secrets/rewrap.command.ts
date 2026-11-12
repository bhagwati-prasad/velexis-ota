// `secrets:rewrap [--dry-run] [--batch-size <n>]` of dist/cli.js (PBE-072, lead decision (15m) of 2026-11-11;
// ADR-0010 "Rotation" item 3, docs/mvp/runbooks/master-key-rotation.md steps 5 and 7,
// platform/docs/runbooks/platform-operations.md §8): moves the data key of every platform ciphertext to the current
// master key (the KEK of `MASTER_KEY_CURRENT`), so that an old KEK can be removed. Run on the VM as the platform zone,
// before the OTA backend's own command (OBE-100), which re-wraps the tenant schemas:
//
//   sudo velexis-run platform node dist/cli.js secrets:rewrap              # every platform ciphertext column set
//   sudo velexis-run platform node dist/cli.js secrets:rewrap --dry-run    # the counts and what would move; no write
//
// For each ciphertext column set of rewrap.repository.ts (the eight tables of platform-operations.md §8's query),
// `rewrapBatch` of @velexis/crypto pages through the rows not under the current KEK (`--batch-size`, 500 by default, at
// most 10 000), checks each value against the associated data its writer sealed it with
// (`platform.<table>.<column>:<row id>`), re-wraps its data key (the data is not re-encrypted) and writes the row with
// an optimistic check, one statement per page and per row. A row changed between the read and the write is skipped (the
// other writer's value stays); a value that does not authenticate at its place is left unchanged and counted as
// failed. `--dry-run` runs the same checks with an update that writes nothing, so it also tells which values would
// fail. The pending MFA set-ups in Redis and the OTA backend's 60-second caches of platform rows are not re-wrapped, and
// no `vx:invalidate` is published: they expire by themselves (the runbook waits for them before it removes the old key).
//
// It reads `APP_ENV`, `LOG_LEVEL`, `DATABASE_URL` (velexis_platform_app, the role with DML on the platform schema, which
// velexis_migrator owns: ADR-0004; the platform backend owns this data and re-wraps it, ADR-0010 "Rotation" item 3),
// `MASTER_KEY_DIR` and `MASTER_KEY_CURRENT`, and loads every `master-v<N>.key` before it connects: it refuses to start
// when the current KEK cannot be loaded. It needs no Redis and no Nest context.
//
// Output (stdout): one line per table with the rows re-wrapped, skipped and failed and the rows per KEK id not under the
// current KEK before and after (`remainingByKekId`), a total line and a verdict, in the format of OBE-100's command.
// Counts, table names and KEK ids only: never a row id, a ciphertext or a plaintext; an error is reported by its class
// and SQLSTATE or errno code, never its message (PostgreSQL's can quote values). Log lines (stderr, at `warn` unless
// LOG_LEVEL asks for `debug` or `trace`, as the other commands of dist/cli.js) carry the same counts.
//
// Exit codes (cli.ts's three): 0 when nothing is left under an old KEK (a dry run: when nothing was under one); 1 when
// a row failed or remains, a table stopped (run it again: it continues with what is left), or the configuration, the
// keys or the database cannot be used; 2 for a usage error (invalid arguments, never echoed).
import { ConfigError, defineConfig, loadDevEnvFiles, type EnvSource } from "@velexis/config";
import {
  KeyProviderError,
  LocalFileKeyProvider,
  REWRAP_DEFAULT_BATCH_SIZE,
  REWRAP_MAX_BATCH_SIZE,
  rewrapBatch,
  type KeyProvider,
  type RewrapLogger,
} from "@velexis/crypto";
import { createPlatformDb, createPool, type PlatformDatabase, type ReferenceDatabase } from "@velexis/db";
import type { Logger } from "@velexis/logger";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, type CliContext } from "../cli";
import { associatedData } from "../common/crypto.provider";
import { PLATFORM_CLI_POOL_MAX } from "../common/database";
import {
  APP_DIR,
  createProcessLogger,
  PLATFORM_BACKEND_CONFIG_SCHEMA,
  PLATFORM_PROCESSES,
  type PlatformBackendConfig,
} from "../config";
import {
  NO_KEK_ID,
  REWRAP_SCHEMA,
  REWRAP_SOURCES,
  RewrapRepository,
  sortedCounts,
  type CiphertextSource,
  type KekCounts,
  type RewrapStore,
} from "./rewrap.repository";

/** The command word. */
export const REWRAP_COMMAND = "secrets:rewrap";

/** The arguments of the command, for cli.ts's usage text. */
export const REWRAP_ARGUMENTS = "[--dry-run] [--batch-size <n>]";

/** The usage line of the command. */
export const REWRAP_USAGE = `Usage: node dist/cli.js ${REWRAP_COMMAND} ${REWRAP_ARGUMENTS}`;

/** The variables the command reads: those of platform-backend.env it needs (DATABASE_URL is velexis_platform_app). */
export const REWRAP_CONFIG_SCHEMA = {
  APP_ENV: PLATFORM_BACKEND_CONFIG_SCHEMA.APP_ENV,
  LOG_LEVEL: PLATFORM_BACKEND_CONFIG_SCHEMA.LOG_LEVEL,
  DATABASE_URL: PLATFORM_BACKEND_CONFIG_SCHEMA.DATABASE_URL,
  MASTER_KEY_DIR: PLATFORM_BACKEND_CONFIG_SCHEMA.MASTER_KEY_DIR,
  MASTER_KEY_CURRENT: PLATFORM_BACKEND_CONFIG_SCHEMA.MASTER_KEY_CURRENT,
} as const;

/** The configuration of a run. */
export type RewrapConfig = Pick<PlatformBackendConfig, keyof typeof REWRAP_CONFIG_SCHEMA>;

/** The arguments of a run. */
export interface RewrapArguments {
  /** Check and count only: nothing is written. */
  readonly dryRun: boolean;
  /** Rows per page, 1 to `REWRAP_MAX_BATCH_SIZE`. */
  readonly batchSize: number;
}

/**
 * The arguments of `secrets:rewrap` (`--dry-run`, `--batch-size <n>` or `--batch-size=<n>`), or `undefined` when one is
 * unknown, given twice or malformed.
 */
export function rewrapArgumentsOf(args: readonly string[]): RewrapArguments | undefined {
  let dryRun = false;
  let batchSize: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    // `--name=value`: the value is everything after the first `=`.
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    if (name === "--dry-run" && inline === undefined && !dryRun) {
      dryRun = true;
    } else if (name === "--batch-size" && batchSize === undefined) {
      let raw = inline;
      if (raw === undefined) {
        index += 1;
        raw = args[index];
      }
      if (raw === undefined || !/^[1-9][0-9]{0,4}$/.test(raw) || Number(raw) > REWRAP_MAX_BATCH_SIZE) {
        return undefined;
      }
      batchSize = Number(raw);
    } else {
      return undefined;
    }
  }
  return { dryRun, batchSize: batchSize ?? REWRAP_DEFAULT_BATCH_SIZE };
}

/** What one table came to. */
export type TableOutcome =
  | {
      readonly kind: "rewrapped";
      readonly table: string;
      /** The rows with a ciphertext not under the current KEK, by KEK id, before the run. */
      readonly before: KekCounts;
      readonly rewrapped: number;
      readonly skipped: number;
      readonly failed: number;
      /** rewrapBatch's `remainingByKekId` after the run. */
      readonly after: KekCounts;
    }
  | {
      readonly kind: "dry_run";
      readonly table: string;
      readonly before: KekCounts;
      /** Rows whose values authenticate and would move to the current KEK. */
      readonly wouldRewrap: number;
      /** Rows with a value that does not authenticate at its place, which a run would leave as they are. */
      readonly wouldFail: number;
    }
  | {
      readonly kind: "stopped";
      readonly table: string;
      /** The error's class and code (`failureReason`). */
      readonly reason: string;
    };

/** A class or error name that may be printed: an identifier, nothing taken from a message. */
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * A short reason for an error, for the report and the log: the error's class name and its SQLSTATE or errno code,
 * never its message (PostgreSQL's can quote values, a constraint violation the failing row). The class is the
 * constructor's name where it says more than `Error`: node-postgres's `DatabaseError` sets `name` to the protocol
 * message type (`error`), so its `name` alone would not say what failed (the same rule as OBE-100's command).
 */
export function failureReason(error: unknown): string {
  const className: unknown =
    error instanceof Error ? (error.constructor as { readonly name?: unknown } | undefined)?.name : undefined;
  const name =
    typeof className === "string" && className !== "Error" && ERROR_NAME.test(className)
      ? className
      : error instanceof Error && ERROR_NAME.test(error.name)
        ? error.name
        : "Error";
  const code: unknown =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z0-9][A-Z0-9_]{1,31}$/.test(code) ? `${name} ${code}` : name;
}

/** What `rewrapSource` needs. */
export interface RewrapSourceOptions {
  readonly store: RewrapStore;
  readonly source: CiphertextSource;
  readonly keys: KeyProvider;
  readonly batchSize: number;
  readonly dryRun: boolean;
  /** Gets counts only (rewrapBatch's `secrets.rewrap.batch` and `secrets.rewrap.done`); bound to the table. */
  readonly logger?: RewrapLogger | undefined;
}

/**
 * Re-wraps one ciphertext column set (see the file header) and says what it came to. A dry run walks the same rows with
 * an update that writes nothing and reports success, so the values are checked and counted and nothing changes. An
 * error of the database or of the key provider stops this table only.
 */
export async function rewrapSource(options: RewrapSourceOptions): Promise<TableOutcome> {
  const { store, source, keys } = options;
  const table = `${REWRAP_SCHEMA}.${source.table}`;
  try {
    const before = await store.countNotUnder(source, keys.currentKekId());
    const result = await rewrapBatch({
      fetch: (page) => store.fetch(source, page),
      update: options.dryRun ? () => Promise.resolve(true) : (change) => store.update(source, change),
      aadFor: (row, column) => associatedData({ table: source.table, column, rowId: row.id }),
      keys,
      batchSize: options.batchSize,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    if (options.dryRun) {
      return { kind: "dry_run", table, before, wouldRewrap: result.rewrapped, wouldFail: result.failed };
    }
    return {
      kind: "rewrapped",
      table,
      before,
      rewrapped: result.rewrapped,
      skipped: result.skipped,
      failed: result.failed,
      after: result.remainingByKekId,
    };
  } catch (error) {
    return { kind: "stopped", table, reason: failureReason(error) };
  }
}

/** `{"local:v1":3}`: counts by KEK id in KEK id order; a row without a key id shows as `(none)`. */
export function formatKekCounts(counts: KekCounts): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(sortedCounts(Object.entries(counts))).map(([kekId, rows]) => [
        kekId === NO_KEK_ID ? "(none)" : kekId,
        rows,
      ]),
    ),
  );
}

/** The report line of one table. */
export function outcomeLine(outcome: TableOutcome): string {
  const where = `${REWRAP_COMMAND}: ${outcome.table}:`;
  switch (outcome.kind) {
    case "rewrapped":
      return (
        `${where} rewrapped ${outcome.rewrapped}, skipped ${outcome.skipped}, failed ${outcome.failed}; ` +
        `remainingByKekId before ${formatKekCounts(outcome.before)} after ${formatKekCounts(outcome.after)}`
      );
    case "dry_run":
      return (
        `${where} dry run: would re-wrap ${outcome.wouldRewrap}, would fail ${outcome.wouldFail}; ` +
        `remainingByKekId before ${formatKekCounts(outcome.before)}`
      );
    case "stopped":
      return `${where} stopped (${outcome.reason}); run the command again: it continues with what is left`;
  }
}

/** The totals of a run. */
export interface RewrapTotals {
  readonly tables: number;
  readonly stopped: number;
  readonly before: KekCounts;
  readonly rewrapped: number;
  readonly skipped: number;
  readonly failed: number;
  /** After the run (a dry run: as before, since nothing was written). */
  readonly after: KekCounts;
}

const sumOf = (counts: KekCounts): number => Object.values(counts).reduce((sum, rows) => sum + rows, 0);

/** Adds up the outcomes of a run. */
export function totalsOf(outcomes: readonly TableOutcome[]): RewrapTotals {
  const counted = outcomes.filter((outcome) => outcome.kind !== "stopped");
  return {
    tables: outcomes.length,
    stopped: outcomes.length - counted.length,
    before: sortedCounts(counted.flatMap((outcome) => Object.entries(outcome.before))),
    rewrapped: counted.reduce(
      (sum, outcome) => sum + (outcome.kind === "rewrapped" ? outcome.rewrapped : outcome.wouldRewrap),
      0,
    ),
    skipped: counted.reduce((sum, outcome) => sum + (outcome.kind === "rewrapped" ? outcome.skipped : 0), 0),
    failed: counted.reduce(
      (sum, outcome) => sum + (outcome.kind === "rewrapped" ? outcome.failed : outcome.wouldFail),
      0,
    ),
    after: sortedCounts(
      counted.flatMap((outcome) =>
        Object.entries(outcome.kind === "rewrapped" ? outcome.after : outcome.before),
      ),
    ),
  };
}

/** The total line, the verdict and the exit code of a run (file header). */
export function summaryOf(
  totals: RewrapTotals,
  dryRun: boolean,
  currentKekId: string,
): { readonly lines: readonly string[]; readonly code: typeof EXIT_OK | typeof EXIT_FAILED } {
  const scope = `${REWRAP_COMMAND}: total of ${totals.tables} table(s):`;
  const stopped =
    totals.stopped === 0
      ? []
      : [`${REWRAP_COMMAND}: ${totals.stopped} table(s) stopped before the end: run the command again.`];
  if (dryRun) {
    const pending = sumOf(totals.before);
    return {
      lines: [
        `${scope} dry run: would re-wrap ${totals.rewrapped}, would fail ${totals.failed}; ` +
          `remainingByKekId before ${formatKekCounts(totals.before)}`,
        ...stopped,
        pending === 0
          ? totals.stopped === 0
            ? `${REWRAP_COMMAND}: dry run: nothing was written; nothing is under an old KEK.`
            : `${REWRAP_COMMAND}: dry run: nothing was written; nothing is under an old KEK in the tables that ran ` +
              "to the end."
          : `${REWRAP_COMMAND}: dry run: nothing was written; ${totals.rewrapped} row(s) would move to ` +
            `${currentKekId} and ${totals.failed} would fail.`,
      ],
      code: pending === 0 && totals.stopped === 0 ? EXIT_OK : EXIT_FAILED,
    };
  }
  const remaining = sumOf(totals.after);
  return {
    lines: [
      `${scope} rewrapped ${totals.rewrapped}, skipped ${totals.skipped}, failed ${totals.failed}; ` +
        `remainingByKekId before ${formatKekCounts(totals.before)} after ${formatKekCounts(totals.after)}`,
      ...stopped,
      remaining === 0
        ? totals.stopped === 0
          ? `${REWRAP_COMMAND}: nothing is left under an old KEK: every value is under ${currentKekId}.`
          : `${REWRAP_COMMAND}: nothing is left under an old KEK in the tables that ran to the end.`
        : `${REWRAP_COMMAND}: ${remaining} row(s) remain under an old KEK (${totals.failed} failed, ` +
          `${totals.skipped} skipped): keep the old key (master-key-rotation.md step 5).`,
    ],
    code: remaining === 0 && totals.stopped === 0 ? EXIT_OK : EXIT_FAILED,
  };
}

/** The command's configuration: `env` (tests), else the process environment and, in development, `.env.local`. */
function loadRewrapConfig(env: EnvSource | undefined): RewrapConfig {
  if (env !== undefined) {
    return defineConfig(REWRAP_CONFIG_SCHEMA, env);
  }
  loadDevEnvFiles({ appDir: APP_DIR });
  return defineConfig(REWRAP_CONFIG_SCHEMA);
}

/**
 * The CLI's log level, as for the other commands of dist/cli.js: `info` lines would only repeat what the command prints,
 * so `info` becomes `warn`; `debug` and `trace` show rewrapBatch's per-page counts.
 */
function cliLogLevel(level: RewrapConfig["LOG_LEVEL"]): RewrapConfig["LOG_LEVEL"] {
  return level === "info" ? "warn" : level;
}

/** The usage error: the problem, never the argument (it may be a secret typed in the wrong place). */
function usageError(context: CliContext): number {
  context.stderr.write(
    `${REWRAP_COMMAND}: invalid arguments; nothing was re-wrapped.\n${REWRAP_USAGE}\n` +
      `  --dry-run         count and check only: nothing is written\n` +
      `  --batch-size <n>  rows per page, 1 to ${REWRAP_MAX_BATCH_SIZE} (default ${REWRAP_DEFAULT_BATCH_SIZE})\n`,
  );
  return EXIT_USAGE;
}

/** `secrets:rewrap [--dry-run] [--batch-size <n>]` (see the file header). */
export async function runSecretsRewrap(args: readonly string[], context: CliContext): Promise<number> {
  const parsed = rewrapArgumentsOf(args);
  if (parsed === undefined) {
    return usageError(context);
  }
  let config: RewrapConfig;
  try {
    config = loadRewrapConfig(context.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      // A ConfigError names each variable and the reason, never a value.
      context.stderr.write(`${REWRAP_COMMAND}: the configuration is invalid:\n${error.message}\n`);
      return EXIT_FAILED;
    }
    throw error;
  }
  // Every master key before any connection: without the current one nothing could move (ADR-0010, step 4's refusal).
  let keys: LocalFileKeyProvider;
  try {
    keys = await LocalFileKeyProvider.fromDir(config.MASTER_KEY_DIR, config.MASTER_KEY_CURRENT);
  } catch (error) {
    // A KeyProviderError names the file and the reason, never key material.
    const reason = error instanceof KeyProviderError ? error.message : failureReason(error);
    context.stderr.write(
      `${REWRAP_COMMAND}: the master keys cannot be loaded (${reason}); nothing was re-wrapped.\n`,
    );
    return EXIT_FAILED;
  }
  const logger: Logger = createProcessLogger(
    PLATFORM_PROCESSES.cli,
    { APP_ENV: config.APP_ENV, LOG_LEVEL: cliLogLevel(config.LOG_LEVEL) },
    { write: (line: string) => void context.stderr.write(line) },
  );
  const out = (line: string): void => void context.stdout.write(`${line}\n`);
  const pool = createPool(config.DATABASE_URL, {
    applicationName: PLATFORM_PROCESSES.cli,
    logger,
    max: PLATFORM_CLI_POOL_MAX,
  });
  const store = new RewrapRepository(createPlatformDb<PlatformDatabase & ReferenceDatabase>(pool));
  try {
    out(
      `${REWRAP_COMMAND}: current KEK ${keys.currentKekId()} (loaded: ${keys.kekIds().join(", ")}); ` +
        `${REWRAP_SOURCES.length} platform table(s)${parsed.dryRun ? "; dry run: nothing is written" : ""}.`,
    );
    const outcomes: TableOutcome[] = [];
    for (const source of REWRAP_SOURCES) {
      const outcome = await rewrapSource({
        store,
        source,
        keys,
        batchSize: parsed.batchSize,
        dryRun: parsed.dryRun,
        logger: logger.child({ table: `${REWRAP_SCHEMA}.${source.table}`, dryRun: parsed.dryRun }),
      });
      if (outcome.kind === "stopped") {
        logger.error({ table: outcome.table, reason: outcome.reason }, "secrets.rewrap.stopped");
      }
      outcomes.push(outcome);
      out(outcomeLine(outcome));
    }
    const summary = summaryOf(totalsOf(outcomes), parsed.dryRun, keys.currentKekId());
    summary.lines.forEach(out);
    return summary.code;
  } finally {
    await pool.end().catch(() => undefined);
  }
}
