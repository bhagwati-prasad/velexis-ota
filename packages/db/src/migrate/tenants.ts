// migrateTenants: the tenant fan-out of `migrate.js tenants`, `pnpm db:migrate:tenants` and velexis-deploy
// (ADR-0005 item 4, ADR-0021, db README §4). Every tenant schema listed in platform.tenants gets the pending tenant
// files in a transaction of its own (migrateTenantSchema), a bounded number of schemas at a time. A failed schema
// does not stop the others; the run fails (exit code 3) when too many fail.
import { randomBytes } from "node:crypto";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import pg from "pg";
import { MIGRATE_EXIT_CODES, MigrationError, readMigrationFiles, type MigrateExitCode } from "./files.js";
import { describeFailure, type MigrationFailure } from "./run-set.js";
import {
  migrateTenantSchemaFiles,
  TenantChecksumMismatchError,
  TenantMigrationFailedError,
  TenantSchemaError,
  type TenantMigrationFileEvent,
} from "./tenant-schema.js";

/** The tenants whose schemas the fan-out migrates: every one that has, or is about to have, a schema in use. */
export const TENANT_TARGET_STATUSES = ["provisioning", "active", "suspended"] as const;
/** Schemas migrated at the same time by default (db README §4: 4 per cluster). */
export const DEFAULT_TENANT_CONCURRENCY = 4;
/** The default `maxFailureRatio`: more than 10 % failed schemas fail the run with exit code 3. */
export const DEFAULT_MAX_FAILURE_RATIO = 0.1;

/** A schema migrated without error: it is at the target version. `files` is empty when it already was. */
export interface TenantSchemaApplied {
  readonly schema: string;
  /** The files this run applied to the schema, in order. */
  readonly files: readonly TenantMigrationFileEvent[];
}

/** A schema that failed. Its failing transaction was rolled back; the other schemas were not affected. */
export interface TenantSchemaFailure {
  readonly schema: string;
  /** The failing (or first changed) file, e.g. `0002_add_loyalty.sql`; `null` when no file was at fault. */
  readonly file: string | null;
  /** PostgreSQL's message and SQLSTATE (never its detail), or the runner's message. */
  readonly error: MigrationFailure;
  /** What `migrate.js tenant` would exit with for this schema: `2` for a checksum mismatch, otherwise `1`. */
  readonly exitCode: MigrateExitCode;
}

/** A target left alone: a `provisioning` tenant whose schema does not exist yet (provisioning applies every file). */
export interface TenantSchemaSkipped {
  readonly schema: string;
  readonly reason: string;
}

/**
 * The report of a fan-out (`--report <file>`, ADR-0021): everything the OTA backend needs to publish the results
 * on `platform-tenant-events` (PADR-0001, OADR-0007). `applied`, `failed` and `skipped` together list every target
 * once, in `ORDER BY key` order.
 */
export interface TenantMigrationReport {
  /** The last numbered file of the set (the version every schema should reach), e.g. `0002_add_loyalty`. */
  readonly target: string | null;
  /** The number of target schemas. */
  readonly total: number;
  readonly applied: readonly TenantSchemaApplied[];
  readonly failed: readonly TenantSchemaFailure[];
  readonly skipped: readonly TenantSchemaSkipped[];
}

/** How one schema ended, for `onSchemaEnd`. */
export interface TenantSchemaOutcome {
  readonly schema: string;
  readonly status: "applied" | "failed" | "skipped";
}

export interface MigrateTenantsOptions {
  /** The tenant set's folder. A folder that does not exist is an empty set: nothing is done, no connection opened. */
  readonly dir: string;
  /** DSN of `velexis_migrator` (`DATABASE_MIGRATOR_URL`), which reads `platform.tenants`. Never logged. */
  readonly url: string;
  /** Schemas migrated at the same time, each on a connection of its own (default 4). */
  readonly concurrency?: number | undefined;
  /** The run fails with exit code 3 when `failed / total` is greater than this (default 0.1). */
  readonly maxFailureRatio?: number | undefined;
  /** A file to write the report JSON to (replaced atomically, mode 0600), for velexis-deploy and the OTA backend. */
  readonly report?: string | undefined;
  /** Called for every file applied, failed or changed, in each schema's order (the CLI prints one JSON line each). */
  readonly onFile?: ((event: TenantMigrationFileEvent) => void) | undefined;
  /** Instrumentation: called when a schema's migration starts. */
  readonly onSchemaStart?: ((schema: string) => void) | undefined;
  /** Instrumentation: called when a schema's migration has ended, whatever the outcome. */
  readonly onSchemaEnd?: ((outcome: TenantSchemaOutcome) => void) | undefined;
}

export interface MigrateTenantsResult {
  /** Absolute path of the folder. */
  readonly dir: string;
  /** False when the folder does not exist: nothing was done and `report` is `null`. */
  readonly dirExists: boolean;
  readonly report: TenantMigrationReport | null;
  /** `failed / total` (0 without targets). */
  readonly failureRatio: number;
  /** `3` when `failureRatio` is greater than `maxFailureRatio`, otherwise `0`. */
  readonly exitCode: MigrateExitCode;
}

/**
 * Runs `task` for every item, at most `limit` at a time, in item order: a small worker pool, so the fan-out needs no
 * dependency. `task` should not reject; if one does, no further item starts and the first rejection is thrown once
 * the running tasks have ended.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError(`runWithConcurrency: limit must be a positive integer, not ${String(limit)}`);
  }
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const index = next;
      next += 1;
      try {
        await task(items[index] as T, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  if (failure !== undefined) {
    throw failure.error;
  }
}

/** `failed / total`, 0 when there is no target. */
export function failureRatio(failed: number, total: number): number {
  return total === 0 ? 0 : failed / total;
}

/** The exit code of a fan-out: `3` when more than `maxFailureRatio` of the schemas failed, otherwise `0`. */
export function fanOutExitCode(failed: number, total: number, maxFailureRatio: number): MigrateExitCode {
  return failureRatio(failed, total) > maxFailureRatio
    ? MIGRATE_EXIT_CODES.failureRatioExceeded
    : MIGRATE_EXIT_CODES.ok;
}

/** The message of an error that has none of its own (a refused connection is an `AggregateError` with ""). */
function messageOf(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error.message !== "") {
    return error.message;
  }
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.map(messageOf).join("; ");
  }
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? `${error.name} ${code}` : error.name;
}

/** The report entry of a schema that threw. */
function failureOf(schema: string, error: unknown): TenantSchemaFailure {
  if (error instanceof TenantMigrationFailedError) {
    return { schema, file: error.file, error: error.failure, exitCode: error.exitCode };
  }
  if (error instanceof TenantChecksumMismatchError) {
    return {
      schema,
      file: error.files[0] ?? null,
      error: { message: error.message },
      exitCode: error.exitCode,
    };
  }
  const failure = describeFailure(error, undefined);
  return {
    schema,
    file: null,
    error: { ...failure, message: messageOf(error) },
    exitCode: error instanceof MigrationError ? error.exitCode : MIGRATE_EXIT_CODES.error,
  };
}

interface Target {
  readonly schema_name: string;
  readonly status: (typeof TENANT_TARGET_STATUSES)[number];
}

/** The target schemas, in `ORDER BY key` order, read on a connection of their own. */
async function readTargets(url: string): Promise<Target[]> {
  const client = new pg.Client({ connectionString: url, application_name: "velexis-migrate-tenants" });
  client.on("error", () => undefined);
  await client.connect();
  try {
    const { rows } = await client.query<Target>(
      "SELECT schema_name, status FROM platform.tenants " +
        "WHERE status IN ('provisioning','active','suspended') ORDER BY key",
    );
    return rows;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Writes `report` to `path` as JSON: a new temporary file next to it (random name, created exclusively, so an
 * existing file or link is never followed; mode 0600, as error texts can quote values), flushed and renamed over
 * it, so readers never see a part. velexis-deploy copies it to root-only files.
 */
async function writeReport(path: string, report: TenantMigrationReport): Promise<void> {
  const target = resolve(path);
  const temporary = join(dirname(target), `.${basename(target)}.${randomBytes(8).toString("hex")}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.chmod(0o600); // also when a umask narrowed the owner bits
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Applies the tenant migrations in `dir` to every tenant schema (ADR-0021, db README §4):
 *
 * 1. reads and validates the folder before connecting (`MigrationFilesError`, exit code 1); a missing folder is an
 *    empty set: nothing is done and no report is written;
 * 2. reads the targets as `url`: `SELECT schema_name FROM platform.tenants WHERE status IN
 *    ('provisioning','active','suspended') ORDER BY key`;
 * 3. migrates them with `migrateTenantSchema` (no `create`: the fan-out never creates a schema), at most
 *    `concurrency` at a time, each in its own transaction on its own connection. A failed schema is reported and
 *    the others continue. A `provisioning` tenant without a schema is skipped: its provisioning applies every file;
 * 4. writes the report `{ target, total, applied, failed, skipped }` to `report` when given;
 * 5. returns exit code 3 when `failed / total > maxFailureRatio`, otherwise 0.
 *
 * Mirroring the results into `platform.tenant_schema_migrations` is not done here: the OTA backend publishes them on
 * `platform-tenant-events` from the report (PADR-0001, OADR-0007).
 */
export async function migrateTenants(options: MigrateTenantsOptions): Promise<MigrateTenantsResult> {
  const {
    dir,
    url,
    concurrency = DEFAULT_TENANT_CONCURRENCY,
    maxFailureRatio = DEFAULT_MAX_FAILURE_RATIO,
    report: reportPath,
    onFile,
    onSchemaStart,
    onSchemaEnd,
  } = options;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError(`migrateTenants: concurrency must be a positive integer, not ${String(concurrency)}`);
  }
  if (typeof maxFailureRatio !== "number" || !(maxFailureRatio >= 0 && maxFailureRatio <= 1)) {
    throw new TypeError(
      `migrateTenants: maxFailureRatio must be a number from 0 to 1, not ${String(maxFailureRatio)}`,
    );
  }
  if (typeof url !== "string" || url.trim() === "") {
    throw new TypeError("migrateTenants: url must be a non-empty postgres:// connection string");
  }
  const files = await readMigrationFiles(dir, "tenant");
  if (!files.exists) {
    return Object.freeze({
      dir: files.dir,
      dirExists: false,
      report: null,
      failureRatio: 0,
      exitCode: MIGRATE_EXIT_CODES.ok,
    });
  }

  const targets = await readTargets(url);
  type Outcome =
    | { readonly status: "applied"; readonly entry: TenantSchemaApplied }
    | { readonly status: "failed"; readonly entry: TenantSchemaFailure }
    | { readonly status: "skipped"; readonly entry: TenantSchemaSkipped };
  const outcomes: Outcome[] = new Array<Outcome>(targets.length);

  await runWithConcurrency(targets, concurrency, async ({ schema_name: schema, status }, index) => {
    onSchemaStart?.(schema);
    let outcome: Outcome;
    try {
      const result = await migrateTenantSchemaFiles(files, { schema, url, create: false, onFile });
      outcome = { status: "applied", entry: { schema, files: result.applied } };
    } catch (error) {
      outcome =
        error instanceof TenantSchemaError && error.problem === "missing" && status === "provisioning"
          ? {
              status: "skipped",
              entry: {
                schema,
                reason:
                  "the tenant is provisioning and its schema does not exist yet; provisioning applies every file",
              },
            }
          : { status: "failed", entry: failureOf(schema, error) };
    }
    outcomes[index] = outcome;
    onSchemaEnd?.({ schema, status: outcome.status });
  });

  const applied: TenantSchemaApplied[] = [];
  const failed: TenantSchemaFailure[] = [];
  const skipped: TenantSchemaSkipped[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === "applied") {
      applied.push(outcome.entry);
    } else if (outcome.status === "failed") {
      failed.push(outcome.entry);
    } else {
      skipped.push(outcome.entry);
    }
  }
  const report: TenantMigrationReport = Object.freeze({
    target: files.numbered.at(-1)?.id ?? null,
    total: targets.length,
    applied: Object.freeze(applied),
    failed: Object.freeze(failed),
    skipped: Object.freeze(skipped),
  });
  if (reportPath !== undefined) {
    await writeReport(reportPath, report);
  }
  return Object.freeze({
    dir: files.dir,
    dirExists: true,
    report,
    failureRatio: failureRatio(failed.length, targets.length),
    exitCode: fanOutExitCode(failed.length, targets.length, maxFailureRatio),
  });
}
