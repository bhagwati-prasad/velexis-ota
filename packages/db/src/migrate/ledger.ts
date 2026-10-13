// The schema_migrations ledger of a schema (ADR-0005, db README §4). The tenant baseline creates its own; for
// `platform` and `reference` the runner creates it before the first file, with the columns of the tenant
// ledger in docs/velexis-sdk/db/tenant.sql plus `repeatable` as a phase (ADR-0021).
import pg from "pg";
import type { LedgerPhase, MigrationFile, SharedMigrationSet } from "./files.js";

/** The ledger table in every migrated schema. */
export const LEDGER_TABLE = "schema_migrations";

/** Anything that runs a query: a `pg.Client`, a pooled client. */
export type Queryable = Pick<pg.ClientBase, "query">;

export type LedgerStatus = "running" | "applied" | "failed";

/** The ledger columns the runner reads. */
export interface LedgerRow {
  readonly id: string;
  readonly checksum: string;
  readonly phase: LedgerPhase;
  readonly status: LedgerStatus;
}

/** `"platform".schema_migrations`: the quoted schema, so no name is ever concatenated unquoted into SQL. */
export function ledgerTable(schema: string): string {
  return `${pg.escapeIdentifier(schema)}.${LEDGER_TABLE}`;
}

/**
 * The DDL of the `platform` or `reference` ledger: the tenant ledger's columns (`id`, `description`,
 * `checksum`, `phase`, `status`, `execution_ms`, `created_at`, `updated_at`), ids of repeatable files
 * (`R__name`) and the phase `repeatable`, with a comment on the table and every column.
 */
export function sharedLedgerDdl(schema: SharedMigrationSet): string {
  const table = ledgerTable(schema);
  const comment = (column: string, text: string): string =>
    `COMMENT ON COLUMN ${table}.${column} IS ${pg.escapeLiteral(text)};`;
  return [
    `CREATE TABLE ${table} (`,
    "  id           text PRIMARY KEY CHECK (id ~ '^([0-9]{4,14}(_[a-z0-9_]+)?|R__[a-z0-9_]+)$'),",
    "  description  text NOT NULL,",
    "  checksum     text NOT NULL,",
    "  phase        text NOT NULL DEFAULT 'expand' CHECK (phase IN ('expand','migrate','contract','repeatable')),",
    "  status       text NOT NULL DEFAULT 'applied' CHECK (status IN ('running','applied','failed')),",
    "  execution_ms integer,",
    "  created_at   timestamptz NOT NULL DEFAULT now(),",
    "  updated_at   timestamptz NOT NULL DEFAULT now()",
    ");",
    `COMMENT ON TABLE ${table} IS ${pg.escapeLiteral(
      `Migration ledger of the ${schema} schema: one row per applied numbered file and per repeatable file. ` +
        "Written only by the migration runner of @velexis/db (ADR-0005, ADR-0021).",
    )};`,
    comment("id", "Migration version: the file name without .sql, e.g. 0001_baseline or R__ota_read_access."),
    comment("description", "Human-readable summary of the migration (its header comment)."),
    comment("checksum", "SHA-256 (hex) of the migration file as applied."),
    comment("phase", "Expand/contract phase of the change; repeatable for R__ files."),
    comment("status", "Outcome in this schema."),
    comment("execution_ms", "Execution time in milliseconds."),
    comment("created_at", "When the migration was first applied."),
    comment("updated_at", "Last status change, or the last re-application of a repeatable file."),
  ].join("\n");
}

/**
 * Creates `<schema>.schema_migrations` (and the schema, as the baselines would) when it does not exist yet,
 * in its own transaction. Returns true when it created the ledger. Call it while holding the set's advisory
 * lock, so two runners never race.
 */
export async function ensureSharedLedger(client: Queryable, schema: SharedMigrationSet): Promise<boolean> {
  const { rows } = await client.query<{ has_schema: boolean; has_ledger: boolean }>(
    "SELECT to_regnamespace($1) IS NOT NULL AS has_schema, to_regclass($2) IS NOT NULL AS has_ledger",
    [pg.escapeIdentifier(schema), ledgerTable(schema)],
  );
  const state = rows[0];
  if (state?.has_ledger === true) {
    return false;
  }
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    if (state?.has_schema !== true) {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${pg.escapeIdentifier(schema)}`);
    }
    await client.query(sharedLedgerDdl(schema));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  return true;
}

/** Every ledger row of `schema`, by id. */
export async function readLedger(client: Queryable, schema: string): Promise<ReadonlyMap<string, LedgerRow>> {
  const { rows } = await client.query<LedgerRow>(
    `SELECT id, checksum, phase, status FROM ${ledgerTable(schema)} ORDER BY id`,
  );
  return new Map(rows.map((row) => [row.id, Object.freeze({ ...row })]));
}

/**
 * Records `file` as applied in the ledger of `schema`: a new row, or an update of an earlier one (a repeatable
 * file applied again, or a row left `running` or `failed`). Run it in the file's own transaction, so the file
 * and its row commit together.
 */
export async function recordMigration(
  client: Queryable,
  schema: string,
  file: MigrationFile,
  executionMs: number,
): Promise<void> {
  await client.query(
    `INSERT INTO ${ledgerTable(schema)} AS ledger (id, description, checksum, phase, status, execution_ms) ` +
      "VALUES ($1, $2, $3, $4, 'applied', $5) " +
      "ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description, checksum = EXCLUDED.checksum, " +
      "phase = EXCLUDED.phase, status = 'applied', execution_ms = EXCLUDED.execution_ms, updated_at = now()",
    [file.id, file.description, file.checksum, file.phase, executionMs],
  );
}

/** An applied numbered file whose bytes changed since it was applied. */
export interface ChecksumMismatch {
  readonly file: MigrationFile;
  /** The checksum in the ledger. */
  readonly appliedChecksum: string;
}

/**
 * Applied numbered files whose checksum differs from their ledger row. A merged migration is never edited
 * (conventions §9); repeatable files are compared by `pendingRepeatableFiles` instead.
 */
export function checksumMismatches(
  files: readonly MigrationFile[],
  ledger: ReadonlyMap<string, LedgerRow>,
): ChecksumMismatch[] {
  const mismatches: ChecksumMismatch[] = [];
  for (const file of files) {
    const row = ledger.get(file.id);
    if (file.kind === "numbered" && row?.status === "applied" && row.checksum !== file.checksum) {
      mismatches.push({ file, appliedChecksum: row.checksum });
    }
  }
  return mismatches;
}

/** Numbered files without an applied ledger row, in apply order. */
export function pendingNumberedFiles(
  files: readonly MigrationFile[],
  ledger: ReadonlyMap<string, LedgerRow>,
): MigrationFile[] {
  return files.filter((file) => file.kind === "numbered" && ledger.get(file.id)?.status !== "applied");
}

/** Ledger ids without a file in the folder (applied by another release), sorted. */
export function ledgerIdsWithoutFile(
  files: readonly MigrationFile[],
  ledger: ReadonlyMap<string, LedgerRow>,
): string[] {
  const ids = new Set(files.map((file) => file.id));
  return [...ledger.keys()].filter((id) => !ids.has(id)).sort();
}
