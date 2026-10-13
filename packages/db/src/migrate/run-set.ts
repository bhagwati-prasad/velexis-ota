// runMigrations: applies the platform or reference set (ADR-0005 Migrations, ADR-0021, db README §4) on one
// connection of its own, under a session advisory lock per set, with each file in its own transaction.
import { performance } from "node:perf_hooks";
import pg from "pg";
import {
  isSharedMigrationSet,
  MIGRATE_EXIT_CODES,
  MigrationError,
  readMigrationFiles,
  type LedgerPhase,
  type MigrationFile,
  type MigrationKind,
  type SharedMigrationSet,
} from "./files.js";
import {
  checksumMismatches,
  ensureSharedLedger,
  ledgerIdsWithoutFile,
  pendingNumberedFiles,
  readLedger,
  recordMigration,
  type Queryable,
} from "./ledger.js";
import { pendingRepeatableFiles } from "./repeatable.js";

/** `lock_timeout` of every migration transaction (and of no-transaction statements). */
export const MIGRATION_LOCK_TIMEOUT = "5s";
/** `statement_timeout` of every migration statement, and how long a run waits for the set's advisory lock. */
export const MIGRATION_STATEMENT_TIMEOUT = "10min";

export type MigrationFileStatus = "applied" | "failed" | "checksum_mismatch";

/** What happened to one file: `migrate.js` prints each event as one JSON line on stdout. */
export interface MigrationFileEvent {
  readonly set: SharedMigrationSet;
  readonly file: string;
  readonly id: string;
  readonly kind: MigrationKind;
  readonly phase: LedgerPhase;
  readonly status: MigrationFileStatus;
  /** SHA-256 of the file. */
  readonly checksum: string;
  /** False for a `-- velexis:no-transaction` file. */
  readonly transaction: boolean;
  /** `applied`: the file's execution time, as recorded in the ledger. */
  readonly executionMs?: number;
  /** `checksum_mismatch`: the checksum recorded when the file was applied. */
  readonly appliedChecksum?: string;
  /** `failed`: PostgreSQL's message and SQLSTATE, and where it failed. Never the error's detail (row values). */
  readonly error?: MigrationFailure;
}

export interface MigrationFailure {
  readonly message: string;
  readonly code?: string;
  /** Line in the file of PostgreSQL's error position (transactional files). */
  readonly line?: number;
  /** 1-based statement of a no-transaction file. */
  readonly statement?: number;
}

export interface RunMigrationsOptions {
  /** `platform` or `reference`: the set, and the schema of its ledger. */
  readonly set: SharedMigrationSet;
  /** The set's folder. A folder that does not exist is an empty set: nothing is applied, no connection opened. */
  readonly dir: string;
  /** DSN of `velexis_migrator` (`DATABASE_MIGRATOR_URL`). Never logged. */
  readonly url: string;
  /** Called for every file applied, failed or changed, in order (the CLI prints one JSON line each). */
  readonly onFile?: ((event: MigrationFileEvent) => void) | undefined;
}

export interface RunMigrationsResult {
  readonly set: SharedMigrationSet;
  /** Absolute path of the folder. */
  readonly dir: string;
  /** False when the folder does not exist (nothing was done). */
  readonly dirExists: boolean;
  /** The files applied by this run, in order: pending numbered files, then changed repeatable files. */
  readonly applied: readonly MigrationFileEvent[];
  /** Files already applied with the same checksum. */
  readonly upToDate: number;
  /** Ledger ids without a file in the folder, e.g. applied by a newer release before a rollback. */
  readonly ledgerOnly: readonly string[];
}

/** Applied numbered files were edited. Nothing was applied (exit code 2). */
export class ChecksumMismatchError extends MigrationError {
  override readonly name = "ChecksumMismatchError";
  readonly set: SharedMigrationSet;
  readonly files: readonly string[];

  constructor(set: SharedMigrationSet, files: readonly string[]) {
    super(
      `${files.length} applied ${set} migration file(s) changed since they were applied: ${files.join(", ")}. ` +
        "Nothing was applied. Restore the merged files and fix forward with a new numbered file (conventions §9).",
      MIGRATE_EXIT_CODES.checksumMismatch,
    );
    this.set = set;
    this.files = Object.freeze([...files]);
  }
}

/** A file failed. Its transaction was rolled back and nothing of it is recorded; the run stopped (exit code 1). */
export class MigrationFailedError extends MigrationError {
  override readonly name = "MigrationFailedError";
  readonly set: SharedMigrationSet;
  readonly file: string;
  readonly failure: MigrationFailure;

  constructor(set: SharedMigrationSet, file: MigrationFile, failure: MigrationFailure, cause: unknown) {
    const where = [
      failure.code === undefined ? undefined : `SQLSTATE ${failure.code}`,
      failure.line === undefined ? undefined : `line ${failure.line}`,
      failure.statement === undefined ? undefined : `statement ${failure.statement}`,
    ].filter((part) => part !== undefined);
    const outcome = file.noTransaction
      ? "It ran outside a transaction: the statements before the failing one stay applied, and nothing is " +
        "recorded. Make the file idempotent (IF NOT EXISTS; drop an INVALID index left by CONCURRENTLY) and run again."
      : "It was rolled back and nothing of it is recorded; the files before it stay applied.";
    super(
      `Migration ${set}/${file.file} failed: ${failure.message}` +
        `${where.length > 0 ? ` (${where.join(", ")})` : ""}. ${outcome}`,
      MIGRATE_EXIT_CODES.error,
      { cause },
    );
    this.set = set;
    this.file = file.file;
    this.failure = failure;
  }
}

/** Line (1-based) of a 1-based character position, as PostgreSQL reports it. */
function lineAt(sql: string, position: number): number {
  let line = 1;
  for (let i = 0; i < position - 1 && i < sql.length; i += 1) {
    if (sql.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

/** The safe part of an error: message and SQLSTATE. The detail may quote row values, so it is left out. */
function describeFailure(error: unknown, sql: string | undefined, statement?: number): MigrationFailure {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof pg.DatabaseError && typeof error.code === "string" && error.code !== ""
      ? error.code
      : undefined;
  const position =
    error instanceof pg.DatabaseError && error.position !== undefined ? Number(error.position) : Number.NaN;
  return {
    message,
    ...(code === undefined ? {} : { code }),
    ...(sql !== undefined && Number.isInteger(position) && position > 0
      ? { line: lineAt(sql, position) }
      : {}),
    ...(statement === undefined ? {} : { statement }),
  };
}

function event(
  set: SharedMigrationSet,
  file: MigrationFile,
  status: MigrationFileStatus,
  extra: Partial<Pick<MigrationFileEvent, "executionMs" | "appliedChecksum" | "error">> = {},
): MigrationFileEvent {
  return Object.freeze({
    set,
    file: file.file,
    id: file.id,
    kind: file.kind,
    phase: file.phase,
    status,
    checksum: file.checksum,
    transaction: !file.noTransaction,
    ...extra,
  });
}

const elapsedMs = (start: number): number => Math.round(performance.now() - start);

/**
 * Applies one file and records it. A transactional file runs with its ledger row in one transaction
 * (`SET LOCAL lock_timeout = '5s'`, `SET LOCAL statement_timeout = '10min'`); a no-transaction file runs
 * statement by statement on the connection, with the same two timeouts set on the session first, then its row
 * is written.
 */
async function applyFile(
  client: Queryable,
  set: SharedMigrationSet,
  file: MigrationFile,
): Promise<{ executionMs: number } | { failure: MigrationFailure; cause: unknown }> {
  if (file.noTransaction) {
    try {
      // A plain SET in an earlier file outlives its transaction on this connection, so the session timeouts are
      // set again here: a no-transaction file gets the same limits as SET LOCAL gives every other file.
      await client.query(`SET lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`);
      await client.query(`SET statement_timeout = '${MIGRATION_STATEMENT_TIMEOUT}'`);
    } catch (error) {
      return { failure: describeFailure(error, undefined), cause: error };
    }
    const start = performance.now();
    for (const [index, statement] of file.statements.entries()) {
      try {
        await client.query(statement);
      } catch (error) {
        return { failure: describeFailure(error, undefined, index + 1), cause: error };
      }
    }
    const executionMs = elapsedMs(start);
    try {
      await recordMigration(client, set, file, executionMs);
    } catch (error) {
      return { failure: describeFailure(error, undefined), cause: error };
    }
    return { executionMs };
  }

  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`);
    await client.query(`SET LOCAL statement_timeout = '${MIGRATION_STATEMENT_TIMEOUT}'`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return { failure: describeFailure(error, undefined), cause: error };
  }
  const start = performance.now();
  try {
    await client.query(file.sql);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return { failure: describeFailure(error, file.sql), cause: error };
  }
  const executionMs = elapsedMs(start);
  try {
    await recordMigration(client, set, file, executionMs);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return { failure: describeFailure(error, undefined), cause: error };
  }
  return { executionMs };
}

/**
 * Applies the `platform` or `reference` migrations in `dir` to the schema of the same name:
 *
 * 1. reads and validates the folder (`readMigrationFiles`) before connecting; a missing folder is an empty set;
 * 2. connects to `url` with a connection of its own and takes `pg_advisory_lock(hashtext('velexis:migrate:' ||
 *    set))` for the whole run, waiting up to 10 minutes for another run of the same set;
 * 3. creates `<set>.schema_migrations` when it does not exist;
 * 4. verifies the checksums of the applied files: on a mismatch it throws `ChecksumMismatchError` (exit code
 *    2) before applying anything;
 * 5. applies each pending numbered file in its own transaction with its ledger row; a no-transaction file runs
 *    outside a transaction and is recorded afterwards. A failure rolls back and throws `MigrationFailedError`
 *    (exit code 1); the files before it stay applied;
 * 6. applies the repeatable files whose checksum changed, the same way.
 *
 * Invalid files throw `MigrationFilesError` (exit code 1) before anything runs.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const { set, dir, url, onFile } = options;
  if (!isSharedMigrationSet(set)) {
    throw new TypeError(`runMigrations: set must be "platform" or "reference", not ${JSON.stringify(set)}`);
  }
  if (typeof url !== "string" || url.trim() === "") {
    throw new TypeError("runMigrations: url must be a non-empty postgres:// connection string");
  }
  const files = await readMigrationFiles(dir, set);
  if (!files.exists) {
    return Object.freeze({ set, dir: files.dir, dirExists: false, applied: [], upToDate: 0, ledgerOnly: [] });
  }

  const client = new pg.Client({ connectionString: url, application_name: `velexis-migrate-${set}` });
  // A connection dropped between queries emits 'error'; the next query rejects, so only keep it from crashing.
  client.on("error", () => undefined);
  await client.connect();
  try {
    // Session settings of this runner-owned connection (never search_path): every statement, including the
    // wait for the advisory lock below, ends after 10 minutes.
    await client.query(`SET statement_timeout = '${MIGRATION_STATEMENT_TIMEOUT}'`);
    await client.query(`SET lock_timeout = '${MIGRATION_STATEMENT_TIMEOUT}'`);
    // Held until the connection closes: a second run of the same set waits here, then finds nothing pending.
    await client.query("SELECT pg_advisory_lock(hashtext('velexis:migrate:' || $1::text))", [set]);
    await client.query(`SET lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`);

    await ensureSharedLedger(client, set);
    const ledger = await readLedger(client, set);
    const all = [...files.numbered, ...files.repeatable];

    const mismatches = checksumMismatches(files.numbered, ledger);
    if (mismatches.length > 0) {
      for (const { file, appliedChecksum } of mismatches) {
        onFile?.(event(set, file, "checksum_mismatch", { appliedChecksum }));
      }
      throw new ChecksumMismatchError(
        set,
        mismatches.map(({ file }) => file.file),
      );
    }

    const pending = [
      ...pendingNumberedFiles(files.numbered, ledger),
      ...pendingRepeatableFiles(files.repeatable, ledger),
    ];
    const applied: MigrationFileEvent[] = [];
    for (const file of pending) {
      const outcome = await applyFile(client, set, file);
      if ("failure" in outcome) {
        onFile?.(event(set, file, "failed", { error: outcome.failure }));
        throw new MigrationFailedError(set, file, outcome.failure, outcome.cause);
      }
      const done = event(set, file, "applied", { executionMs: outcome.executionMs });
      applied.push(done);
      onFile?.(done);
    }
    return Object.freeze({
      set,
      dir: files.dir,
      dirExists: true,
      applied: Object.freeze(applied),
      upToDate: all.length - pending.length,
      ledgerOnly: Object.freeze(ledgerIdsWithoutFile(all, ledger)),
    });
  } finally {
    // Closing the session releases the advisory lock.
    await client.end().catch(() => undefined);
  }
}
