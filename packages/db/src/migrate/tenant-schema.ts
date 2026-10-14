// migrateTenantSchema: applies the tenant set to one tenant schema (ADR-0005 item 4, ADR-0021, db README §3 and §4):
// one transaction per schema as velexis_provisioner, under an advisory lock on the schema name, with the
// search_path set for the transaction only. With `create: true` it is the `create_schema` + `run_migrations` step
// of OTA provisioning: the schema, its grants for velexis_ota_app and every file commit together or not at all.
// `beforeCommit` lets the OTA worker add its `seed_defaults` step to that same transaction (OADR-0007 item 2).
import { performance } from "node:perf_hooks";
import { Kysely, PostgresDialect, type PostgresPoolClient } from "kysely";
import pg from "pg";
import type { TenantDatabase } from "../generated/tenant.js";
import { assertTenantSchema } from "../tenant-schema.js";
import { createTypeParsers } from "../type-parsers.js";
import {
  MIGRATE_EXIT_CODES,
  MigrationError,
  readMigrationFiles,
  type LedgerPhase,
  type MigrationFile,
  type MigrationFiles,
  type MigrationKind,
} from "./files.js";
import {
  checksumMismatches,
  LEDGER_TABLE,
  ledgerIdsWithoutFile,
  ledgerTable,
  pendingNumberedFiles,
  readLedger,
  recordMigration,
  type LedgerRow,
  type Queryable,
} from "./ledger.js";
import {
  describeFailure,
  MIGRATION_LOCK_TIMEOUT,
  MIGRATION_STATEMENT_TIMEOUT,
  type MigrationFailure,
  type MigrationFileStatus,
} from "./run-set.js";

/**
 * The owner of every tenant schema and of every object in it (ADR-0004, ADR-0021). Each tenant transaction starts
 * with `SET LOCAL ROLE velexis_provisioner`, whether the caller connects as the provisioner (OTA worker) or as
 * `velexis_migrator` (deploy fan-out, CLI), so ownership and default privileges stay with one role.
 */
export const TENANT_OWNER_ROLE = "velexis_provisioner";
/** The application role that gets `USAGE` on the schema and DML on its tables (ADR-0004). */
export const TENANT_APP_ROLE = "velexis_ota_app";

/** What happened to one tenant file: `migrate.js tenant` and `tenants` print each event as one JSON line. */
export interface TenantMigrationFileEvent {
  readonly set: "tenant";
  /** The tenant schema, e.g. `tenant_acme`. */
  readonly schema: string;
  readonly file: string;
  readonly id: string;
  readonly kind: MigrationKind;
  readonly phase: LedgerPhase;
  readonly status: MigrationFileStatus;
  /** SHA-256 of the file. */
  readonly checksum: string;
  /** False for a `-- velexis:no-transaction` file. */
  readonly transaction: boolean;
  /** `applied`: the file's execution time, as recorded in the schema's ledger. */
  readonly executionMs?: number;
  /** `checksum_mismatch`: the checksum recorded when the file was applied. */
  readonly appliedChecksum?: string;
  /** `failed`: PostgreSQL's message and SQLSTATE, and where it failed. Never the error's detail (row values). */
  readonly error?: MigrationFailure;
}

export interface MigrateTenantSchemaOptions {
  /** The tenant schema, `tenant_<key>`: checked with `assertTenantSchema` before anything else. */
  readonly schema: string;
  /** The tenant set's folder. A folder that does not exist is an empty set: nothing is done, no connection opened. */
  readonly dir: string;
  /**
   * DSN of `velexis_migrator` (CLI, deploy fan-out) or `velexis_provisioner` (OTA worker,
   * `DATABASE_PROVISIONER_URL`). Never logged.
   */
  readonly url: string;
  /**
   * Create the schema when it does not exist (`AUTHORIZATION velexis_provisioner`), and grant `velexis_ota_app`
   * `USAGE`, DML on every table and default privileges for later tables and sequences, in the same transaction
   * as the files. Without it a missing schema is an error (`TenantSchemaError`, reason `missing`); an empty
   * schema of `velexis_provisioner` without a ledger (an orphan) is completed with the same grants either way.
   */
  readonly create?: boolean | undefined;
  /** Called for every file applied, failed or changed, after its transaction committed or failed. */
  readonly onFile?: ((event: TenantMigrationFileEvent) => void) | undefined;
  /**
   * Runs in the schema's last transaction, after the grants and every pending file with its ledger row, right before
   * `COMMIT` (OADR-0007 item 2: OTA provisioning seeds the schema here). It also runs when nothing is pending, so a
   * re-run reaches it again. It gets the runner's connection as `db`, with the transaction's role, timeouts,
   * advisory lock and `search_path`. When it throws, the transaction is rolled back (a schema it was creating
   * included) and its error is rethrown as it is. Not called when the folder does not exist or the run failed before.
   */
  readonly beforeCommit?: ((context: TenantBeforeCommitContext) => Promise<void>) | undefined;
}

/** What `beforeCommit` gets: the runner's open transaction on the tenant schema. */
export interface TenantBeforeCommitContext {
  /** The tenant schema, e.g. `tenant_acme`. */
  readonly schema: string;
  /** True when this run created the schema (`create: true` on a schema that did not exist). */
  readonly created: boolean;
  /**
   * Kysely on the runner's connection, inside the transaction: tenant tables resolve unqualified through its
   * `search_path` (`schema, reference`), as in `tenantTx`, and rows are parsed as `createPool` parses them. The
   * runner owns the transaction: `transaction()`, `startTransaction()` and any `BEGIN`, `COMMIT`, `ROLLBACK` (or
   * `END`, `ABORT`, `PREPARE TRANSACTION`) are refused with a `TypeError`; savepoints are fine. `destroy()` leaves
   * the connection open.
   */
  readonly db: Kysely<TenantDatabase>;
}

export interface MigrateTenantSchemaResult {
  readonly schema: string;
  /** Absolute path of the folder. */
  readonly dir: string;
  /** False when the folder does not exist (nothing was done). */
  readonly dirExists: boolean;
  /** True when this run created the schema (`create: true` on a schema that did not exist). */
  readonly created: boolean;
  /** The files applied by this run, in order. */
  readonly applied: readonly TenantMigrationFileEvent[];
  /** Files already applied with the same checksum. */
  readonly upToDate: number;
  /** Ledger ids without a file in the folder, e.g. applied by a newer release before a rollback. */
  readonly ledgerOnly: readonly string[];
}

/** Why a schema cannot be migrated: it is missing, or it was not created by provisioning. */
export type TenantSchemaProblem = "missing" | "foreign_owner" | "foreign_content";

/**
 * The schema does not exist (without `create`), belongs to another role than `velexis_provisioner`, or has
 * relations but no `schema_migrations` ledger ("foreign content", OADR-0007). Nothing was changed (exit code 1).
 */
export class TenantSchemaError extends MigrationError {
  override readonly name = "TenantSchemaError";
  readonly schema: string;
  readonly problem: TenantSchemaProblem;

  constructor(schema: string, problem: TenantSchemaProblem, detail?: string) {
    const messages: Record<TenantSchemaProblem, string> = {
      missing: `Tenant schema ${schema} does not exist; provisioning creates it (migrate.js tenant --create)`,
      foreign_owner:
        `Tenant schema ${schema} belongs to ${detail ?? "another role"}, not ${TENANT_OWNER_ROLE}: ` +
        "it was not created by provisioning and is left alone",
      foreign_content:
        `Tenant schema ${schema} holds ${detail ?? "relations"} but no ${ledgerTable(schema)} ledger ` +
        "(foreign content): it is left alone",
    };
    super(messages[problem], MIGRATE_EXIT_CODES.error);
    this.schema = schema;
    this.problem = problem;
  }
}

/** Applied tenant files were edited. The schema's transaction was rolled back; nothing was applied (exit code 2). */
export class TenantChecksumMismatchError extends MigrationError {
  override readonly name = "TenantChecksumMismatchError";
  readonly schema: string;
  readonly files: readonly string[];

  constructor(schema: string, files: readonly string[]) {
    super(
      `${files.length} applied tenant migration file(s) changed since they were applied to ${schema}: ` +
        `${files.join(", ")}. Nothing was applied to ${schema}. Restore the merged files and fix forward with a ` +
        "new numbered file (conventions §9).",
      MIGRATE_EXIT_CODES.checksumMismatch,
    );
    this.schema = schema;
    this.files = Object.freeze([...files]);
  }
}

/** A tenant file failed. Its transaction was rolled back and nothing of it is recorded (exit code 1). */
export class TenantMigrationFailedError extends MigrationError {
  override readonly name = "TenantMigrationFailedError";
  readonly schema: string;
  readonly file: string;
  readonly failure: MigrationFailure;

  constructor(schema: string, file: MigrationFile, failure: MigrationFailure, cause: unknown) {
    const where = [
      failure.code === undefined ? undefined : `SQLSTATE ${failure.code}`,
      failure.line === undefined ? undefined : `line ${failure.line}`,
      failure.statement === undefined ? undefined : `statement ${failure.statement}`,
    ].filter((part) => part !== undefined);
    const outcome = file.noTransaction
      ? "It ran outside a transaction: the statements before the failing one stay applied, and nothing is " +
        "recorded. Make the file idempotent (IF NOT EXISTS; drop an INVALID index left by CONCURRENTLY) and run again."
      : `The transaction of ${schema} was rolled back: nothing of it is applied or recorded (a schema it was ` +
        "creating does not exist); files committed before it stay applied.";
    super(
      `Migration tenant/${file.file} failed in ${schema}: ${failure.message}` +
        `${where.length > 0 ? ` (${where.join(", ")})` : ""}. ${outcome}`,
      MIGRATE_EXIT_CODES.error,
      { cause },
    );
    this.schema = schema;
    this.file = file.file;
    this.failure = failure;
  }
}

function event(
  schema: string,
  file: MigrationFile,
  status: MigrationFileStatus,
  extra: Partial<Pick<TenantMigrationFileEvent, "executionMs" | "appliedChecksum" | "error">> = {},
): TenantMigrationFileEvent {
  return Object.freeze({
    set: "tenant" as const,
    schema,
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

/** `ROLLBACK` that never throws: the connection may already be broken. */
async function rollback(client: Queryable): Promise<void> {
  await client.query("ROLLBACK").catch(() => undefined);
}

/**
 * Statements that would end the runner's transaction or open another: after leading comments, `BEGIN`,
 * `START TRANSACTION`, `COMMIT` (also `COMMIT PREPARED`), `END`, `ABORT`, `PREPARE TRANSACTION` and `ROLLBACK`
 * (also `ROLLBACK PREPARED`), but not `ROLLBACK [WORK | TRANSACTION] TO [SAVEPOINT]`. Inside a transaction
 * PostgreSQL only warns about a second `BEGIN`, and an early `COMMIT` or `ROLLBACK` would let the runner report files
 * that did not commit with the rest.
 */
export const TRANSACTION_CONTROL_STATEMENT =
  /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:begin|start\s+transaction|commit|end|abort|prepare\s+transaction|rollback(?!\s+(?:(?:work|transaction)\s+)?to\b))\b/i;

/**
 * Kysely on `client`, a connection already inside the runner's transaction: the pool of its dialect hands out that
 * one connection and never ends it. Every statement goes through the extended query protocol, which takes one
 * statement per query, and transaction control (`TRANSACTION_CONTROL_STATEMENT`) is refused with a `TypeError`
 * before it is sent, so the callback can neither commit, roll back nor nest the transaction.
 */
export function transactionKysely<DB>(client: Queryable): Kysely<DB> {
  const query = (text: unknown, parameters?: readonly unknown[]): Promise<pg.QueryResult> => {
    if (typeof text !== "string") {
      return Promise.reject(new TypeError("beforeCommit: streaming with a cursor is not supported"));
    }
    if (TRANSACTION_CONTROL_STATEMENT.test(text)) {
      return Promise.reject(
        new TypeError(
          "beforeCommit runs inside the migration runner's transaction: BEGIN, COMMIT, ROLLBACK and the other " +
            "transaction statements are refused (savepoints are fine)",
        ),
      );
    }
    // `queryMode` is a pg option that @types/pg does not declare.
    const config: pg.QueryConfig & { readonly queryMode: "extended" } = {
      text,
      values: [...(parameters ?? [])],
      queryMode: "extended",
    };
    return client.query(config);
  };
  const connection = { query, release: () => undefined } as unknown as PostgresPoolClient;
  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: { connect: () => Promise.resolve(connection), end: () => Promise.resolve() },
    }),
  });
}

/**
 * Opens a tenant transaction: `SET LOCAL ROLE velexis_provisioner`, `SET LOCAL lock_timeout = '5s'`,
 * `SET LOCAL statement_timeout = '10min'`, `pg_advisory_xact_lock(hashtext(schema))`, then
 * `set_config('search_path', schema || ', reference', true)`. The schema name is a bound parameter.
 */
async function beginTenantTransaction(client: Queryable, schema: string): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL ROLE ${TENANT_OWNER_ROLE}`);
    await client.query(`SET LOCAL lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`);
    await client.query(`SET LOCAL statement_timeout = '${MIGRATION_STATEMENT_TIMEOUT}'`);
    // Waits at most lock_timeout (5 s) for another run on the same schema; a timeout fails this schema only.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [schema]);
    await client.query("SELECT set_config('search_path', $1, true)", [`${schema}, reference`]);
  } catch (error) {
    await rollback(client);
    throw error;
  }
}

/**
 * Owner, ledger and relation count of `schema`; `undefined` when the schema does not exist. Read from the catalog
 * only (no `to_regclass`), so a schema the provisioner has no `USAGE` on is reported, not a permission error.
 */
async function schemaState(
  client: Queryable,
  schema: string,
): Promise<{ owner: string; hasLedger: boolean; relations: number } | undefined> {
  const { rows } = await client.query<{ owner: string; has_ledger: boolean; relations: number }>(
    "SELECT n.nspowner::regrole::text AS owner, " +
      "EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = n.oid AND c.relname = $2 " +
      "AND c.relkind IN ('r', 'p')) AS has_ledger, " +
      "(SELECT count(*) FROM pg_catalog.pg_class c WHERE c.relnamespace = n.oid)::int AS relations " +
      "FROM pg_catalog.pg_namespace n WHERE n.nspname = $1",
    [schema, LEDGER_TABLE],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : { owner: row.owner, hasLedger: row.has_ledger, relations: row.relations };
}

/**
 * The provisioning grants (ADR-0004, db README §3): `USAGE` on the schema, default privileges of
 * `velexis_provisioner` in the schema for later tables (DML) and sequences (`USAGE, SELECT`), and the same
 * privileges on what the schema already holds. Set before the files run, so their tables get the grants as they
 * are created; all of it is idempotent.
 */
async function grantTenantAccess(client: Queryable, identifier: string): Promise<void> {
  await client.query(`GRANT USAGE ON SCHEMA ${identifier} TO ${TENANT_APP_ROLE}`);
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${TENANT_OWNER_ROLE} IN SCHEMA ${identifier} ` +
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${TENANT_APP_ROLE}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${TENANT_OWNER_ROLE} IN SCHEMA ${identifier} ` +
      `GRANT USAGE, SELECT ON SEQUENCES TO ${TENANT_APP_ROLE}`,
  );
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${identifier} TO ${TENANT_APP_ROLE}`,
  );
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${identifier} TO ${TENANT_APP_ROLE}`);
}

/** The outcome of one tenant transaction. */
interface SegmentResult {
  readonly created: boolean;
  readonly applied: readonly TenantMigrationFileEvent[];
  readonly ledger: ReadonlyMap<string, LedgerRow>;
  /** The pending numbered files when the transaction started. */
  readonly pending: readonly MigrationFile[];
  /** The `no-transaction` file the transaction stopped before, to run on a dedicated connection. */
  readonly next: MigrationFile | undefined;
}

/** The callbacks of a run and whether an earlier transaction of it created the schema. */
interface SegmentHooks {
  readonly onFile: MigrateTenantSchemaOptions["onFile"];
  readonly beforeCommit: MigrateTenantSchemaOptions["beforeCommit"];
  /** True when an earlier transaction of this run created the schema (`beforeCommit` reports it). */
  readonly createdEarlier: boolean;
}

/**
 * One tenant transaction: checks the schema (with `create`, creates it), grants `velexis_ota_app` its privileges
 * (with `create`, or on a schema without a ledger), verifies the checksums, then applies the pending numbered files
 * up to the first `no-transaction` file and records each in the schema's own ledger. The baseline creates that
 * ledger, so its row is written right after it runs. When no `no-transaction` file follows, this is the run's last
 * transaction and `beforeCommit` runs before `COMMIT`. Events are emitted after `COMMIT`, so an `applied` event
 * never names a file that was rolled back.
 */
async function runTenantTransaction(
  client: Queryable,
  files: MigrationFiles,
  schema: string,
  create: boolean,
  hooks: SegmentHooks,
): Promise<SegmentResult> {
  const { onFile, beforeCommit } = hooks;
  const identifier = pg.escapeIdentifier(schema);
  await beginTenantTransaction(client, schema);
  let created = false;
  let ledger: ReadonlyMap<string, LedgerRow>;
  let pending: MigrationFile[];
  try {
    const state = await schemaState(client, schema);
    if (state === undefined) {
      if (!create) {
        throw new TenantSchemaError(schema, "missing");
      }
      await client.query(`CREATE SCHEMA ${identifier} AUTHORIZATION ${TENANT_OWNER_ROLE}`);
      created = true;
    } else if (state.owner !== TENANT_OWNER_ROLE) {
      throw new TenantSchemaError(schema, "foreign_owner", state.owner);
    } else if (!state.hasLedger && state.relations > 0) {
      throw new TenantSchemaError(
        schema,
        "foreign_content",
        state.relations === 1 ? "1 relation" : `${state.relations} relations`,
      );
    }
    // The grants come with the schema: with `create`, and also when this transaction completes an empty orphan
    // schema without a ledger (`tenant` without --create, or the fan-out), so a schema never gets its baseline
    // without the privileges of velexis_ota_app and the default privileges for later files.
    if (create || state === undefined || !state.hasLedger) {
      await grantTenantAccess(client, identifier);
    }
    ledger = state?.hasLedger === true ? await readLedger(client, schema) : new Map<string, LedgerRow>();

    const mismatches = checksumMismatches(files.numbered, ledger);
    if (mismatches.length > 0) {
      for (const { file, appliedChecksum } of mismatches) {
        onFile?.(event(schema, file, "checksum_mismatch", { appliedChecksum }));
      }
      throw new TenantChecksumMismatchError(
        schema,
        mismatches.map(({ file }) => file.file),
      );
    }
    pending = pendingNumberedFiles(files.numbered, ledger);
  } catch (error) {
    await rollback(client);
    throw error;
  }

  const applied: TenantMigrationFileEvent[] = [];
  let next: MigrationFile | undefined;
  for (const file of pending) {
    if (file.noTransaction) {
      next = file;
      break;
    }
    const start = performance.now();
    try {
      await client.query(file.sql);
    } catch (error) {
      await rollback(client);
      const failure = describeFailure(error, file.sql);
      onFile?.(event(schema, file, "failed", { error: failure }));
      throw new TenantMigrationFailedError(schema, file, failure, error);
    }
    const executionMs = elapsedMs(start);
    try {
      await recordMigration(client, schema, file, executionMs);
    } catch (error) {
      await rollback(client);
      const failure = describeFailure(error, undefined);
      onFile?.(event(schema, file, "failed", { error: failure }));
      throw new TenantMigrationFailedError(schema, file, failure, error);
    }
    applied.push(event(schema, file, "applied", { executionMs }));
  }
  if (next === undefined && beforeCommit !== undefined) {
    try {
      await beforeCommit({
        schema,
        created: created || hooks.createdEarlier,
        db: transactionKysely<TenantDatabase>(client),
      });
    } catch (error) {
      await rollback(client);
      throw error;
    }
  }
  try {
    await client.query("COMMIT");
  } catch (error) {
    await rollback(client);
    throw error;
  }
  for (const done of applied) {
    onFile?.(done);
  }
  return { created, applied, ledger, pending, next };
}

/**
 * Runs a `-- velexis:no-transaction` tenant file on a dedicated connection that is closed afterwards: `SET ROLE
 * velexis_provisioner`, the two timeouts and a session `search_path` of `schema, reference`, under the session
 * advisory lock on the schema name. The migration runner is the only code allowed to set `search_path` at session
 * level, and only on a connection of its own (ADR-0004). Returns `undefined` when another run applied the file
 * while this one waited for the lock.
 */
async function runNoTransactionFile(
  url: string,
  schema: string,
  file: MigrationFile,
): Promise<{ executionMs: number } | undefined> {
  const dedicated = new pg.Client({ connectionString: url, application_name: "velexis-migrate-tenant" });
  dedicated.on("error", () => undefined);
  await dedicated.connect();
  try {
    try {
      await dedicated.query(`SET ROLE ${TENANT_OWNER_ROLE}`);
      await dedicated.query(`SET lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`);
      await dedicated.query(`SET statement_timeout = '${MIGRATION_STATEMENT_TIMEOUT}'`);
      await dedicated.query("SELECT pg_advisory_lock(hashtext($1::text))", [schema]);
      await dedicated.query("SELECT set_config('search_path', $1, false)", [`${schema}, reference`]);
      const row = (await readLedger(dedicated, schema)).get(file.id);
      if (row?.status === "applied") {
        return undefined;
      }
    } catch (error) {
      throw new TenantMigrationFailedError(schema, file, describeFailure(error, undefined), error);
    }
    const start = performance.now();
    for (const [index, statement] of file.statements.entries()) {
      try {
        await dedicated.query(statement);
      } catch (error) {
        throw new TenantMigrationFailedError(
          schema,
          file,
          describeFailure(error, undefined, index + 1),
          error,
        );
      }
    }
    const executionMs = elapsedMs(start);
    try {
      await recordMigration(dedicated, schema, file, executionMs);
    } catch (error) {
      throw new TenantMigrationFailedError(schema, file, describeFailure(error, undefined), error);
    }
    return { executionMs };
  } finally {
    // Closing the session drops its role, search_path and advisory lock.
    await dedicated.end().catch(() => undefined);
  }
}

/**
 * `migrateTenantSchema` with the folder already read and validated: the fan-out reads it once for every schema.
 */
export async function migrateTenantSchemaFiles(
  files: MigrationFiles,
  options: Omit<MigrateTenantSchemaOptions, "dir">,
): Promise<MigrateTenantSchemaResult> {
  const { schema, url, onFile, beforeCommit } = options;
  const create = options.create === true;
  assertTenantSchema(schema);
  if (files.set !== "tenant") {
    throw new TypeError(
      `migrateTenantSchema: the files must be the tenant set, not ${JSON.stringify(files.set)}`,
    );
  }
  if (typeof url !== "string" || url.trim() === "") {
    throw new TypeError("migrateTenantSchema: url must be a non-empty postgres:// connection string");
  }
  if (!files.exists) {
    return Object.freeze({
      schema,
      dir: files.dir,
      dirExists: false,
      created: false,
      applied: [],
      upToDate: 0,
      ledgerOnly: [],
    });
  }

  // The pools' type parsers, so `beforeCommit` reads rows as the apps do (numeric[] as strings, for example).
  const client = new pg.Client({
    connectionString: url,
    application_name: "velexis-migrate-tenant",
    types: createTypeParsers(),
  });
  // A connection dropped between queries emits 'error'; the next query rejects, so only keep it from crashing.
  client.on("error", () => undefined);
  await client.connect();
  try {
    const first = await runTenantTransaction(client, files, schema, create, {
      onFile,
      beforeCommit,
      createdEarlier: false,
    });
    const applied: TenantMigrationFileEvent[] = [...first.applied];
    let next = first.next;
    while (next !== undefined) {
      const file = next;
      let outcome: { executionMs: number } | undefined;
      try {
        outcome = await runNoTransactionFile(url, schema, file);
      } catch (error) {
        if (error instanceof TenantMigrationFailedError) {
          onFile?.(event(schema, file, "failed", { error: error.failure }));
        }
        throw error;
      }
      if (outcome !== undefined) {
        const done = event(schema, file, "applied", { executionMs: outcome.executionMs });
        applied.push(done);
        onFile?.(done);
      }
      // The files after it run in a new transaction, which finds the schema and re-reads the ledger under the
      // lock; only the first transaction creates the schema and grants.
      const segment = await runTenantTransaction(client, files, schema, false, {
        onFile,
        beforeCommit,
        createdEarlier: first.created,
      });
      applied.push(...segment.applied);
      next = segment.next;
    }
    return Object.freeze({
      schema,
      dir: files.dir,
      dirExists: true,
      created: first.created,
      applied: Object.freeze(applied),
      upToDate: files.numbered.length - first.pending.length,
      ledgerOnly: Object.freeze(ledgerIdsWithoutFile(files.numbered, first.ledger)),
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Applies the tenant migrations in `dir` to `schema`, in one transaction per schema (ADR-0005 item 4, db README
 * §4):
 *
 * 1. checks the schema name (`assertTenantSchema`), then reads and validates the folder, before connecting; a
 *    missing folder is an empty set;
 * 2. opens a connection of its own to `url` and a transaction: `SET LOCAL ROLE velexis_provisioner`,
 *    `SET LOCAL lock_timeout = '5s'`, `SET LOCAL statement_timeout = '10min'`,
 *    `pg_advisory_xact_lock(hashtext(schema))`, `set_config('search_path', schema || ', reference', true)`;
 * 3. with `create: true`, creates the schema when it is missing (`CREATE SCHEMA … AUTHORIZATION
 *    velexis_provisioner`, the identifier quoted by `pg.escapeIdentifier`) and grants `velexis_ota_app` `USAGE`,
 *    DML on every table and default privileges for later tables and sequences. An empty orphan schema of the
 *    provisioner (no ledger) gets the same grants with or without `create`, as its baseline is applied;
 * 4. verifies the checksums of the applied files (`TenantChecksumMismatchError`, exit code 2), applies the pending
 *    files and inserts their rows into the schema's own `schema_migrations`, runs `beforeCommit` when given, then
 *    commits. A failing file rolls the whole transaction back (`TenantMigrationFailedError`, exit code 1), the new
 *    schema included, and so does an error thrown by `beforeCommit` (rethrown as it is);
 * 5. a `-- velexis:no-transaction` file ends the transaction: it runs on a dedicated connection with a session
 *    `search_path`, which is closed afterwards, and the remaining files continue in a new transaction (where
 *    `beforeCommit` then runs).
 *
 * Results are not mirrored to `platform.tenant_schema_migrations`: the OTA worker publishes them (PADR-0001).
 */
export async function migrateTenantSchema(
  options: MigrateTenantSchemaOptions,
): Promise<MigrateTenantSchemaResult> {
  assertTenantSchema(options.schema);
  const files = await readMigrationFiles(options.dir, "tenant");
  return migrateTenantSchemaFiles(files, options);
}
