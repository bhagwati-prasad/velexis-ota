// `secrets:rewrap [--tenant <key> | --all] [--dry-run] [--batch-size <n>]` of dist/cli.js (OBE-100, lead decision (15m)
// of 2026-11-11; ADR-0010 "Rotation" item 3, docs/mvp/runbooks/master-key-rotation.md steps 5 and 7): moves the data key
// of every ciphertext of every tenant schema to the current master key (the KEK of `MASTER_KEY_CURRENT`), so that an
// old KEK can be removed. Run on the VM as the OTA zone, after the platform's own command:
//
//   sudo velexis-run ota node dist/cli.js secrets:rewrap              # every tenant schema (--all, the default)
//   sudo velexis-run ota node dist/cli.js secrets:rewrap --dry-run    # the counts and what would move; writes nothing
//   sudo velexis-run ota node dist/cli.js secrets:rewrap --tenant <key>
//
// For each tenant schema (every `tenant_<key>` of the catalog, whatever its tenant's status; `--tenant` one of them) and
// each ciphertext column set of rewrap.repository.ts, `rewrapBatch` of @velexis/crypto pages through the rows not under
// the current KEK (`--batch-size`, 500 by default, at most 10 000), checks each value against the associated data its
// writer sealed it with, re-wraps its data key (the data is not re-encrypted) and writes the row with an optimistic
// check, one short `tenantTx` per page and per row. A row changed between the read and the write is skipped (the other
// writer's value stays); a value that does not authenticate at its place is left unchanged and counted as failed.
// `--dry-run` runs the same checks with an update that writes nothing, so it also tells which values would fail.
//
// It reads `APP_ENV`, `LOG_LEVEL`, `DATABASE_URL` (velexis_ota_app, which owns the tenant data: ADR-0010 "Each owner
// re-wraps its own data"), `MASTER_KEY_DIR` and `MASTER_KEY_CURRENT`, and loads every `master-v<N>.key` before it
// connects: it refuses to start when the current KEK cannot be loaded. The Amadeus token cache in Redis is flushed by
// the runbook (step 6), not re-wrapped.
//
// Output (stdout): one line per tenant schema and table with the rows re-wrapped, skipped and failed and the rows per
// KEK id not under the current KEK before and after (`remainingByKekId`), a total line and a verdict. Counts, schema and
// table names and KEK ids only: never a row id, a ciphertext, a plaintext or a document number; an error is reported
// by its class and SQLSTATE or errno code, never its message (PostgreSQL's can quote values). Log lines (stderr, at
// `warn` unless LOG_LEVEL says `debug` or `error`) carry the same counts.
//
// Exit codes: 0 when nothing is left under an old KEK (a dry run: when nothing was under one); 1 when a row failed or
// remains, a table stopped (run it again: it continues with what is left), or the configuration, the keys or the
// database cannot be used; 2 for a usage error (invalid arguments, or a `--tenant` whose schema does not exist).
import { ConfigError, defineConfig, loadDevEnvFiles, type EnvSource } from "@velexis/config";
import {
  aadFor,
  KeyProviderError,
  LocalFileKeyProvider,
  REWRAP_DEFAULT_BATCH_SIZE,
  REWRAP_MAX_BATCH_SIZE,
  rewrapBatch,
  type KeyProvider,
  type RewrapLogger,
} from "@velexis/crypto";
import { createPlatformDb, createPool, createTenantDb, isTenantSchema, type TenantSchema } from "@velexis/db";
import { createLogger, type Logger } from "@velexis/logger";
import type { CliStreams } from "../cli";
import { APP_DIR, workerConfigSchema } from "../config";
import {
  NO_KEK_ID,
  REWRAP_SOURCES,
  RewrapRepository,
  sortedCounts,
  tenantSchemas,
  type CiphertextSource,
  type RewrapStore,
} from "./rewrap.repository";

/** The command word. */
export const REWRAP_COMMAND = "secrets:rewrap";

/** The usage line of the command. */
export const REWRAP_USAGE = `Usage: node dist/cli.js ${REWRAP_COMMAND} [--tenant <key> | --all] [--dry-run] [--batch-size <n>]`;

/** The process name of the command's log lines and of its PostgreSQL `application_name`. */
export const REWRAP_APP = "ota-cli-secrets-rewrap";

/** The exit codes (file header); PBE-072's platform command uses the same three. */
export const REWRAP_EXIT = Object.freeze({ done: 0, remains: 1, usage: 2 } as const);

/** The variables the command reads: those of ota-backend.env (DATABASE_URL is velexis_ota_app). */
export const REWRAP_CONFIG_SCHEMA = {
  APP_ENV: workerConfigSchema.APP_ENV,
  LOG_LEVEL: workerConfigSchema.LOG_LEVEL,
  DATABASE_URL: workerConfigSchema.DATABASE_URL,
  MASTER_KEY_DIR: workerConfigSchema.MASTER_KEY_DIR,
  MASTER_KEY_CURRENT: workerConfigSchema.MASTER_KEY_CURRENT,
} as const;

/** The arguments of a run. */
export interface RewrapArguments {
  /** One tenant by its key (`platform.tenants.key`, schema `tenant_<key>`), or every tenant schema. */
  readonly target: { readonly kind: "tenant"; readonly key: string } | { readonly kind: "all" };
  /** Check and count only: nothing is written. */
  readonly dryRun: boolean;
  /** Rows per page, 1 to `REWRAP_MAX_BATCH_SIZE`. */
  readonly batchSize: number;
}

/**
 * The arguments of `secrets:rewrap` (`--tenant <key>` or `--tenant=<key>`, `--all`, `--dry-run`, `--batch-size <n>` or
 * `--batch-size=<n>`), or `undefined` when one is unknown, given twice, malformed, or `--tenant` comes with `--all`.
 * Without a target the run takes every tenant schema.
 */
export function rewrapArgumentsOf(args: readonly string[]): RewrapArguments | undefined {
  let key: string | undefined;
  let all = false;
  let dryRun = false;
  let batchSize: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    // `--name=value`: the value is everything after the first `=`.
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    const value = (): string | undefined => {
      if (inline !== undefined) {
        return inline;
      }
      index += 1;
      return args[index];
    };
    if (name === "--all" && inline === undefined && !all) {
      all = true;
    } else if (name === "--dry-run" && inline === undefined && !dryRun) {
      dryRun = true;
    } else if (name === "--tenant" && key === undefined) {
      key = value();
      // A tenant key as `platform.tenants.key` holds it: `tenant_<key>` is a tenant schema name.
      if (key === undefined || !isTenantSchema(`tenant_${key}`)) {
        return undefined;
      }
    } else if (name === "--batch-size" && batchSize === undefined) {
      const raw = value();
      if (raw === undefined || !/^[1-9][0-9]{0,4}$/.test(raw) || Number(raw) > REWRAP_MAX_BATCH_SIZE) {
        return undefined;
      }
      batchSize = Number(raw);
    } else {
      return undefined;
    }
  }
  if (all && key !== undefined) {
    return undefined;
  }
  return {
    target: key === undefined ? { kind: "all" } : { kind: "tenant", key },
    dryRun,
    batchSize: batchSize ?? REWRAP_DEFAULT_BATCH_SIZE,
  };
}

/** Counts by KEK id, as `remainingByKekId`. */
export type KekCounts = Readonly<Record<string, number>>;

/** What one table of one tenant schema came to. */
export type TableOutcome =
  | {
      readonly kind: "rewrapped";
      readonly schema: TenantSchema;
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
      readonly schema: TenantSchema;
      readonly table: string;
      readonly before: KekCounts;
      /** Rows whose values authenticate and would move to the current KEK. */
      readonly wouldRewrap: number;
      /** Rows with a value that does not authenticate at its place, which a run would leave as they are. */
      readonly wouldFail: number;
    }
  | {
      readonly kind: "stopped";
      readonly schema: TenantSchema;
      readonly table: string;
      /** The error's class and code (`failureReason`). */
      readonly reason: string;
    };

/** A class or error name that may be printed: an identifier, nothing taken from a message. */
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * A short reason for an error, for the report and the log: the error's class name and its SQLSTATE or errno code,
 * never its message (PostgreSQL's can quote values, a key error names a path). The class is the constructor's name
 * where it says more than `Error`: node-postgres's `DatabaseError` sets `name` to the protocol message type
 * (`error`), so its `name` alone would not say what failed.
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
  readonly schema: TenantSchema;
  readonly source: CiphertextSource;
  readonly keys: KeyProvider;
  readonly batchSize: number;
  readonly dryRun: boolean;
  /** Gets counts only (rewrapBatch's `secrets.rewrap.batch` and `secrets.rewrap.done`); bound to the schema and table. */
  readonly logger?: RewrapLogger | undefined;
}

/**
 * Re-wraps one ciphertext column set of one tenant schema (see the file header) and says what it came to. A dry run
 * walks the same rows with an update that writes nothing and reports success, so the values are checked and counted
 * and nothing changes. An error of the database or of the key provider stops this table only.
 */
export async function rewrapSource(options: RewrapSourceOptions): Promise<TableOutcome> {
  const { store, schema, source, keys } = options;
  const where = { schema, table: source.table };
  const currentKekId = keys.currentKekId();
  try {
    const before = await store.countNotUnder(schema, source, currentKekId);
    const result = await rewrapBatch({
      fetch: (page) => store.fetch(schema, source, page),
      update: options.dryRun ? () => Promise.resolve(true) : (change) => store.update(schema, source, change),
      aadFor: (row, column) => aadFor(schema, source.table, column, row.id),
      keys,
      batchSize: options.batchSize,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    if (options.dryRun) {
      return { kind: "dry_run", ...where, before, wouldRewrap: result.rewrapped, wouldFail: result.failed };
    }
    return {
      kind: "rewrapped",
      ...where,
      before,
      rewrapped: result.rewrapped,
      skipped: result.skipped,
      failed: result.failed,
      after: result.remainingByKekId,
    };
  } catch (error) {
    return { kind: "stopped", ...where, reason: failureReason(error) };
  }
}

/** `{"local:v1":3}`: counts by KEK id in KEK id order; a row without `encryption_key_id` shows as `(none)`. */
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
  const where = `${REWRAP_COMMAND}: ${outcome.schema}.${outcome.table}:`;
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
  readonly schemas: number;
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

/** Adds up the outcomes of a run over `schemas` tenant schemas. */
export function totalsOf(outcomes: readonly TableOutcome[], schemas: number): RewrapTotals {
  const counted = outcomes.filter((outcome) => outcome.kind !== "stopped");
  return {
    schemas,
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
): { readonly lines: readonly string[]; readonly code: 0 | 1 } {
  const scope = `${REWRAP_COMMAND}: total of ${totals.schemas} tenant schema(s), ${totals.tables} table(s):`;
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
          ? `${REWRAP_COMMAND}: dry run: nothing was written; nothing is under an old KEK.`
          : `${REWRAP_COMMAND}: dry run: nothing was written; ${totals.rewrapped} row(s) would move to ` +
            `${currentKekId} and ${totals.failed} would fail.`,
      ],
      code: pending === 0 && totals.stopped === 0 ? 0 : 1,
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
    code: remaining === 0 && totals.stopped === 0 ? 0 : 1,
  };
}

/** The command's configuration: `env` (tests), else the process environment and, in development, `.env.local`. */
function loadRewrapConfig(env: EnvSource | undefined) {
  if (env !== undefined) {
    return defineConfig(REWRAP_CONFIG_SCHEMA, env);
  }
  loadDevEnvFiles({ appDir: APP_DIR });
  return defineConfig(REWRAP_CONFIG_SCHEMA);
}

function cliLogger(config: { APP_ENV: string; LOG_LEVEL: string }, io: CliStreams): Logger {
  const level = config.LOG_LEVEL === "debug" ? "debug" : config.LOG_LEVEL === "error" ? "error" : "warn";
  return createLogger({
    app: REWRAP_APP,
    env: config.APP_ENV,
    level,
    destination: { write: (line: string) => void io.stderr.write(line) },
  });
}

/** What `runSecretsRewrap` gets from cli.ts. */
export interface SecretsRewrapIo extends CliStreams {
  /** The configuration variables instead of the process environment and `.env.local` files (tests). */
  readonly env?: EnvSource | undefined;
}

/** `secrets:rewrap` (see the file header). */
export async function runSecretsRewrap(args: readonly string[], io: SecretsRewrapIo): Promise<number> {
  const parsed = rewrapArgumentsOf(args);
  if (parsed === undefined) {
    io.stderr.write(
      `${REWRAP_COMMAND}: invalid arguments; nothing was re-wrapped.\n${REWRAP_USAGE}\n` +
        `  --tenant <key>    one OTA's schema tenant_<key> (default: --all, every tenant schema)\n` +
        `  --dry-run         count and check only: nothing is written\n` +
        `  --batch-size <n>  rows per page, 1 to ${REWRAP_MAX_BATCH_SIZE} (default ${REWRAP_DEFAULT_BATCH_SIZE})\n`,
    );
    return REWRAP_EXIT.usage;
  }
  let config: ReturnType<typeof loadRewrapConfig>;
  try {
    config = loadRewrapConfig(io.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr.write(`${REWRAP_COMMAND}: the configuration is invalid:\n${error.message}\n`);
      return REWRAP_EXIT.remains;
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
    io.stderr.write(
      `${REWRAP_COMMAND}: the master keys cannot be loaded (${reason}); nothing was re-wrapped.\n`,
    );
    return REWRAP_EXIT.remains;
  }
  const logger = cliLogger(config, io);
  const out = (line: string): void => void io.stdout.write(`${line}\n`);
  const pool = createPool(config.DATABASE_URL, { applicationName: REWRAP_APP, logger, max: 2 });
  const store = new RewrapRepository(createTenantDb(pool, { appEnv: config.APP_ENV }));
  try {
    let schemas: TenantSchema[];
    try {
      schemas = await tenantSchemas(createPlatformDb(pool));
    } catch (error) {
      io.stderr.write(
        `${REWRAP_COMMAND}: the tenant schemas could not be read (${failureReason(error)}); nothing was re-wrapped.\n`,
      );
      return REWRAP_EXIT.remains;
    }
    if (parsed.target.kind === "tenant") {
      const wanted = `tenant_${parsed.target.key}`;
      const schema = schemas.find((name) => name === wanted);
      if (schema === undefined) {
        io.stderr.write(
          `${REWRAP_COMMAND}: no tenant schema ${wanted} exists; nothing was re-wrapped.\n${REWRAP_USAGE}\n`,
        );
        return REWRAP_EXIT.usage;
      }
      schemas = [schema];
    }
    out(
      `${REWRAP_COMMAND}: current KEK ${keys.currentKekId()} (loaded: ${keys.kekIds().join(", ")}); ` +
        `${schemas.length} tenant schema(s)${parsed.dryRun ? "; dry run: nothing is written" : ""}.`,
    );
    const outcomes: TableOutcome[] = [];
    for (const schema of schemas) {
      for (const source of REWRAP_SOURCES) {
        const outcome = await rewrapSource({
          store,
          schema,
          source,
          keys,
          batchSize: parsed.batchSize,
          dryRun: parsed.dryRun,
          logger: logger.child({ schema, table: source.table, dryRun: parsed.dryRun }),
        });
        if (outcome.kind === "stopped") {
          logger.error({ schema, table: source.table, err: outcome.reason }, "secrets.rewrap.stopped");
        }
        outcomes.push(outcome);
        out(outcomeLine(outcome));
      }
    }
    const summary = summaryOf(totalsOf(outcomes, schemas.length), parsed.dryRun, keys.currentKekId());
    summary.lines.forEach(out);
    return summary.code;
  } finally {
    await pool.end().catch(() => undefined);
  }
}
