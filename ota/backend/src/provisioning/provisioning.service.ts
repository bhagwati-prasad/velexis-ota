// Tenant provisioning and migration in the OTA worker (OBE-005, OBE-006; OADR-0007 items 1–6, PADR-0001 item 1,
// tenant provisioning flow §1–§3 and §5). Both re-read the tenant from the platform tables and act on its current
// state, never on the message.
//
// `provisionTenant`: a `provisioning` tenant gets its schema in ONE transaction as velexis_provisioner (ADR-0004,
// ADR-0021): `migrateTenantSchema({ create: true })` of @velexis/db creates the schema under the advisory lock of its
// name (lock_timeout 5 s), grants velexis_ota_app its privileges and default privileges, applies every pending file
// of `migrations/tenant` with its ledger row, and then, through its `beforeCommit` callback and still before COMMIT,
// this service seeds the defaults (OBE-004) and reads the ledger. A crash anywhere before COMMIT leaves no schema.
//
// `migrateTenant`: the same transaction without creating the schema or seeding, applying the pending files up to the
// message's `targetVersion` (all of them without one); its `beforeCommit` checks that no applied file of the release
// was edited, also after the target, and reads the full ledger.
//
// Neither throws: every failure is classified (failure-classifier.ts) into the payload of the failure event, with
// `retryable` and the error that caused it, and the processor reports the result after the transaction ended
// (tenant-events.producer.ts). The provisioner's DSN (DATABASE_PROVISIONER_URL) exists only in the worker's
// configuration (config.ts), so the API process cannot build the `ProvisionerDatabase` (provisioning.module.ts).
import { join } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import {
  OTA_PROVISIONING_STEPS,
  TENANT_MIGRATION_PHASES,
  type OtaProvisioningStep,
  type ProvisioningStepRecord,
  type ProvisioningStepStatus,
  type TenantJobError,
  type TenantMigratedPayload,
  type TenantMigrationFailedPayload,
  type TenantMigrationPhase,
  type TenantMigrationRecord,
  type TenantProvisionedPayload,
  type TenantProvisionFailedPayload,
} from "@velexis/api-types/jobs";
import {
  createPool,
  createTenantDb,
  sql,
  tenantTx,
  type Kysely,
  type PoolLogger,
  type TenantDatabase,
  type TenantDb,
  type Transaction,
} from "@velexis/db";
import {
  checksumMismatches,
  migrateTenantSchema,
  migrateTenantSchemaFiles,
  MigrationFilesError,
  pendingNumberedFiles,
  readMigrationFiles,
  TenantChecksumMismatchError,
  type LedgerRow,
  type MigrationFiles,
  type TenantMigrationFileEvent,
} from "@velexis/db/migrate";
import { Clock } from "../common/clock";
import { APP_DIR, WORKER_APP, type WorkerConfig } from "../config";
import { PlatformReadRepository } from "../tenancy/platform-read.repository";
import type { PlatformTenant, TenantStatus } from "../tenancy/platform-read.types";
import {
  classifyFailure,
  jobError,
  TENANT_OPS_ERROR_CODES,
  type ClassifiedFailure,
} from "./failure-classifier";
import { seedTenant, type SeedTenantResult, type TenantSeedDb } from "./seeds";

/** The tenant migrations of this release: `migrations/tenant` of the package (`ota-backend/` on the VM). */
export const TENANT_MIGRATIONS_DIR = join(APP_DIR, "migrations", "tenant");

// ---- The provisioner's database access --------------------------------------------------------------------------

/** Injection token of the worker's `ProvisionerDatabase`. */
export const PROVISIONER_DATABASE = "PROVISIONER_DATABASE";

/**
 * Connections of the provisioner pool: one per concurrent `ota-tenant-ops` job (concurrency 2). It serves only the
 * read-only ledger check of a tenant that is no longer `provisioning`; each provisioning or migration transaction
 * runs on a connection of its own that `migrateTenantSchema` opens and closes. The worker so holds at most 4
 * provisioner connections (a no-transaction file adds one while it runs), well inside `max_connections = 100` of
 * deploy/postgres/velexis.conf.
 */
export const PROVISIONER_POOL_MAX = 2;

/** The worker's access to tenant schemas as velexis_provisioner (ADR-0004): never used to serve requests. */
export interface ProvisionerDatabase {
  /** DATABASE_PROVISIONER_URL, for `migrateTenantSchema`, which connects on its own. Never logged. */
  readonly url: string;
  /** The pool of the same role; the owner ends it at shutdown (provisioning.module.ts). */
  readonly pool: ReturnType<typeof createPool>;
  /** `tenantTx` over that pool. */
  readonly tenants: TenantDb;
}

/** What `createProvisionerDatabase` reads: the worker's configuration (`WorkerConfig`), never the API's. */
export type ProvisionerConfig = Pick<WorkerConfig, "APP_ENV" | "DATABASE_PROVISIONER_URL">;

/** The process has no provisioner DSN: it is not the worker (the API never has one, config.ts). */
export class ProvisionerDsnMissingError extends Error {
  override readonly name = "ProvisionerDsnMissingError";

  constructor() {
    super(
      "DATABASE_PROVISIONER_URL is not in this process's configuration: only the OTA worker (WorkerModule, " +
        "/etc/velexis/ota-worker.env) provisions tenant schemas; the API never builds the provisioner pool",
    );
  }
}

/**
 * The provisioner pool and its DSN, from the worker's validated configuration. Refuses a configuration without
 * DATABASE_PROVISIONER_URL, such as the API's, which never has it even when the variable is set (config.ts), with
 * `ProvisionerDsnMissingError`. The pool connects on its first query.
 */
export function createProvisionerDatabase(
  config: ProvisionerConfig,
  logger: PoolLogger,
): ProvisionerDatabase {
  const url: unknown = (config as Partial<ProvisionerConfig>).DATABASE_PROVISIONER_URL;
  if (typeof url !== "string" || url === "") {
    throw new ProvisionerDsnMissingError();
  }
  const pool = createPool(url, {
    applicationName: `${WORKER_APP}-provisioner`,
    logger,
    max: PROVISIONER_POOL_MAX,
  });
  return Object.freeze({ url, pool, tenants: createTenantDb(pool, { appEnv: config.APP_ENV }) });
}

// ---- Options and results -----------------------------------------------------------------------------------------

/** Injection token of the `ProvisioningOptions`. */
export const PROVISIONING_OPTIONS = "PROVISIONING_OPTIONS";

export interface ProvisioningOptions {
  /** The tenant migrations folder. Default: `TENANT_MIGRATIONS_DIR`. */
  readonly migrationsDir: string;
  /** Folder of the notification template defaults. Default: the registry's (`notifications/templates/`). */
  readonly templatesDir?: string | undefined;
}

export const DEFAULT_PROVISIONING_OPTIONS: ProvisioningOptions = Object.freeze({
  migrationsDir: TENANT_MIGRATIONS_DIR,
});

/**
 * The statuses whose schema `tenant.migrate` migrates: those of the deploy fan-out (`migrate.js tenants`, ADR-0021).
 * Any other status answers `TENANT_NOT_MIGRATABLE`, never retried.
 */
export const MIGRATABLE_TENANT_STATUSES: readonly TenantStatus[] = Object.freeze([
  "provisioning",
  "active",
  "suspended",
]);

/**
 * The outcome of `provisionTenant`: the payload of the event the processor publishes after it. A `failed` result
 * says whether another try may succeed (`payload.retryable`) and, when the run threw, carries that error as `cause`
 * for BullMQ's retry; it is never published or logged.
 */
export type ProvisionResult =
  | { readonly status: "provisioned"; readonly payload: TenantProvisionedPayload }
  | {
      readonly status: "failed";
      readonly payload: TenantProvisionFailedPayload;
      readonly cause?: unknown;
    };

/** The `tenant.migration_failed` payload of this worker: `retryable` is always given. */
export type TenantMigrationFailure = TenantMigrationFailedPayload & { readonly retryable: boolean };

/**
 * The outcome of `migrateTenant`: the payload of `tenant.migrated`, with the schema's name and the files this run
 * applied, or of `tenant.migration_failed`, with the error that caused it (`cause`, as in `ProvisionResult`).
 */
export type MigrateResult =
  | {
      readonly status: "migrated";
      readonly schemaName: string;
      /** The ledger ids this run applied, in order; empty when the schema was already at its target. */
      readonly applied: readonly string[];
      readonly payload: TenantMigratedPayload;
    }
  | { readonly status: "failed"; readonly payload: TenantMigrationFailure; readonly cause?: unknown };

/** When the steps of one provisioning run started and ended, and what each did. */
export interface ProvisioningTimeline {
  /** Before the provisioning connection was opened. */
  readonly startedAt: Date;
  /** When `beforeCommit` started: the schema exists and every file is applied. */
  readonly migrationsDoneAt: Date;
  /** When the seeds and the ledger read were done, right before COMMIT. */
  readonly seedsDoneAt: Date;
  /** True when this run created the schema. */
  readonly created: boolean;
  /** The files this run applied (their `executionMs`). */
  readonly applied: readonly Pick<TenantMigrationFileEvent, "executionMs">[];
  readonly seeded: SeedTenantResult;
}

/** A row of the tenant ledger as the provisioning transaction reads it. */
export interface LedgerRecordRow {
  readonly id: string;
  readonly checksum: string;
  readonly phase: string;
  readonly execution_ms: number | null;
  readonly created_at: Date;
}

// ---- Pure helpers ------------------------------------------------------------------------------------------------

function isMigrationPhase(phase: string): phase is TenantMigrationPhase {
  return (TENANT_MIGRATION_PHASES as readonly string[]).includes(phase);
}

/**
 * The ledger of the event (`migrations[]`): the applied rows in apply order (ids are `NNNN_name`), with `appliedAt`
 * as ISO 8601 UTC. A phase outside expand/migrate/contract cannot come from the runner and throws.
 */
export function toMigrationRecords(rows: readonly LedgerRecordRow[]): TenantMigrationRecord[] {
  return [...rows]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) => {
      if (!isMigrationPhase(row.phase)) {
        throw new TypeError(`ledger row ${row.id} has the phase ${JSON.stringify(row.phase)}`);
      }
      return Object.freeze({
        version: row.id,
        checksum: row.checksum,
        phase: row.phase,
        appliedAt: row.created_at.toISOString(),
        durationMs: row.execution_ms,
      });
    });
}

/** The applied rows in the form of the runner's ledger helpers (`checksumMismatches`, `pendingNumberedFiles`). */
function toLedger(rows: readonly LedgerRecordRow[]): Map<string, LedgerRow> {
  return new Map<string, LedgerRow>(
    rows.map((row) => [
      row.id,
      { id: row.id, checksum: row.checksum, phase: row.phase as LedgerRow["phase"], status: "applied" },
    ]),
  );
}

function step(
  name: OtaProvisioningStep,
  status: ProvisioningStepStatus,
  startedAt: Date,
  finishedAt: Date,
  error?: TenantJobError,
): ProvisioningStepRecord {
  return Object.freeze({
    step: name,
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    ...(error === undefined ? {} : { error }),
  });
}

/**
 * The `steps[]` of a run, in the order of `OTA_PROVISIONING_STEPS`. A step that had nothing to do is `skipped`: the
 * schema existed, no file was pending, or every seed row existed. The three ran in one transaction, so their
 * boundaries are estimated: `run_migrations` ends when `beforeCommit` starts and began the files' total execution
 * time earlier (never before the run), `create_schema` covers the time before it (connection, lock, schema and
 * grants), and `seed_defaults` runs from `beforeCommit` to just before COMMIT.
 */
export function provisioningSteps(timeline: ProvisioningTimeline): ProvisioningStepRecord[] {
  const filesMs = timeline.applied.reduce((total, file) => total + (file.executionMs ?? 0), 0);
  const filesStartedAt = new Date(
    Math.max(timeline.startedAt.getTime(), timeline.migrationsDoneAt.getTime() - filesMs),
  );
  const { seeded } = timeline;
  const seededAny =
    seeded.storefrontSettings || seeded.defaultMarkupRule || seeded.notificationTemplates.length > 0;
  const [createSchema, runMigrations, seedDefaults] = OTA_PROVISIONING_STEPS;
  return [
    step(createSchema, timeline.created ? "succeeded" : "skipped", timeline.startedAt, filesStartedAt),
    step(
      runMigrations,
      timeline.applied.length > 0 ? "succeeded" : "skipped",
      filesStartedAt,
      timeline.migrationsDoneAt,
    ),
    step(seedDefaults, seededAny ? "succeeded" : "skipped", timeline.migrationsDoneAt, timeline.seedsDoneAt),
  ];
}

/** The steps of a run that found the schema complete and did nothing: all three `skipped`. */
export function skippedSteps(at: Date): ProvisioningStepRecord[] {
  return OTA_PROVISIONING_STEPS.map((name) => step(name, "skipped", at, at));
}

/** The latest applied migration of a ledger (`schemaVersion`); an empty ledger throws. */
function latestVersion(schemaName: string, migrations: readonly TenantMigrationRecord[]): string {
  const latest = migrations.at(-1);
  if (latest === undefined) {
    throw new TypeError(`the ledger of ${schemaName} is empty: no tenant migration was applied`);
  }
  return latest.version;
}

/** The `tenant.provisioned` payload: `schemaVersion` is the last ledger row. */
export function provisionedPayload(
  schemaName: string,
  migrations: readonly TenantMigrationRecord[],
  steps: readonly ProvisioningStepRecord[],
): TenantProvisionedPayload {
  return Object.freeze({
    schemaName,
    schemaVersion: latestVersion(schemaName, migrations),
    migrations,
    steps,
  });
}

/** The `tenant.migrated` payload: the schema's full ledger, `schemaVersion` its last row. */
export function migratedPayload(
  schemaName: string,
  migrations: readonly TenantMigrationRecord[],
): TenantMigratedPayload {
  return Object.freeze({ schemaVersion: latestVersion(schemaName, migrations), migrations });
}

/**
 * The files `tenant.migrate` applies: every numbered file up to and including the one `targetVersion` names (its
 * ledger id `0002_add_x`, or its number `0002`), or all of them without a target. `undefined` when no file of the
 * release has that version.
 */
export function filesUpTo(
  files: MigrationFiles,
  targetVersion: string | undefined,
): MigrationFiles | undefined {
  if (targetVersion === undefined) {
    return files;
  }
  const index = files.numbered.findIndex(
    (file) => file.id === targetVersion || file.id.split("_", 1)[0] === targetVersion,
  );
  return index < 0 ? undefined : Object.freeze({ ...files, numbered: files.numbered.slice(0, index + 1) });
}

/**
 * The tenant migrations folder of the release does not exist: the release is broken, which another attempt does not
 * change (`INVALID_MIGRATION_FILES`, not retryable), unlike an error the classifier does not know.
 */
function missingMigrationsFolder(dir: string): MigrationFilesError {
  return new MigrationFilesError("tenant", dir, [{ file: dir, reason: "does not exist" }]);
}

/** The tenant migrations of the release, read and validated; a missing folder throws `missingMigrationsFolder`. */
async function releaseMigrationFiles(dir: string): Promise<MigrationFiles> {
  const files = await readMigrationFiles(dir, "tenant");
  if (!files.exists) {
    throw missingMigrationsFolder(files.dir);
  }
  return files;
}

/**
 * A `tenant.provision_failed` result decided by this service: never retryable, no cause. The message is capped
 * like a classified one (`jobError`).
 */
function provisionFailed(
  code: string,
  message: string,
  steps: readonly ProvisioningStepRecord[] = [],
): ProvisionResult {
  return Object.freeze({
    status: "failed" as const,
    payload: Object.freeze({ error: jobError(code, message), retryable: false, steps }),
  });
}

/**
 * A `tenant.migration_failed` result: from a classified failure (with its cause) or decided by this service. The
 * message is capped like a classified one (`jobError`): `UNKNOWN_TARGET_VERSION` quotes the job's target.
 */
function migrationFailed(failure: Omit<ClassifiedFailure, "step">, cause?: unknown): MigrateResult {
  const payload: TenantMigrationFailure = Object.freeze({
    version: failure.version,
    error: jobError(failure.error.code, failure.error.message),
    retryable: failure.retryable,
  });
  return Object.freeze({
    status: "failed" as const,
    payload,
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * The applied rows of the ledger of the transaction's tenant schema, in apply order: `schema_migrations` resolves
 * unqualified through the transaction's `search_path`. Plain SQL with the generated column names, so the same
 * query runs on the provisioning connection (`beforeCommit`) and in a `tenantTx` without making the type checker
 * compare Kysely's `Transaction` and `Kysely` types, which costs the source scan of redis.keys.test.ts dearly.
 */
async function readLedgerRows(
  db: Kysely<TenantDatabase> | Transaction<TenantDatabase>,
): Promise<LedgerRecordRow[]> {
  const { rows } = await sql<LedgerRecordRow>`
    SELECT id, checksum, phase, execution_ms, created_at FROM schema_migrations
    WHERE status = 'applied' ORDER BY id
  `.execute(db);
  return rows;
}

// ---- The service -------------------------------------------------------------------------------------------------

@Injectable()
export class ProvisioningService {
  constructor(
    private readonly platform: PlatformReadRepository,
    @Inject(PROVISIONER_DATABASE) private readonly database: ProvisionerDatabase,
    @Inject(PROVISIONING_OPTIONS) private readonly options: ProvisioningOptions,
    private readonly clock: Clock,
  ) {}

  /**
   * Provisions the tenant `tenantId` (`ten_…`) as the flow §2 says and returns the payload to report. Idempotent: a
   * second run on a complete schema applies nothing, seeds nothing and answers `provisioned` again.
   *
   * - unknown tenant: `failed` `TENANT_NOT_FOUND`;
   * - tenant not `provisioning`: `provisioned` (all steps skipped) when its schema is complete at the latest version,
   *   otherwise `failed` `TENANT_NOT_PROVISIONING`;
   * - `provisioning`: the one transaction of the file header.
   *
   * Never throws: what the run throws is classified (`classifyFailure`). A lock timeout, a serialization failure, a
   * deadlock or a lost connection is `failed` with `retryable: true` and the error as `cause`; a schema provisioning
   * did not create (`FOREIGN_CONTENT`, `FOREIGN_OWNER`, left as it is), an edited applied file
   * (`CHECKSUM_MISMATCH`), a failing file or a malformed schema name is `failed` with `retryable: false`, and so are
   * the two cases above. The transaction is rolled back before any `failed` result.
   */
  async provisionTenant(tenantId: string): Promise<ProvisionResult> {
    const startedAt = this.clock.now();
    try {
      const tenant = await this.platform.tenantById(tenantId);
      if (tenant === null) {
        return provisionFailed(TENANT_OPS_ERROR_CODES.tenantNotFound, "No tenant has the id of the message");
      }
      if (tenant.status !== "provisioning") {
        const migrations = await this.completeLedger(tenant.schemaName);
        if (migrations !== null) {
          return Object.freeze({
            status: "provisioned" as const,
            payload: provisionedPayload(tenant.schemaName, migrations, skippedSteps(this.clock.now())),
          });
        }
        return provisionFailed(
          TENANT_OPS_ERROR_CODES.tenantNotProvisioning,
          `The tenant is ${tenant.status}, not provisioning, and its schema is not complete at the latest version`,
        );
      }
      return await this.provisionSchema(tenant);
    } catch (error) {
      return this.provisionFailure(classifyFailure(error), error, startedAt);
    }
  }

  /**
   * Migrates the schema of the tenant `tenantId` as the flow §3 says (`tenant.migrate`) and returns the payload to
   * report: the same transaction as provisioning without creating the schema or seeding, applying the pending files
   * up to `targetVersion` (a ledger id such as `0002_add_x` or its number `0002`; all pending files without one).
   * Idempotent: a second run applies nothing and answers `migrated` with the same ledger.
   *
   * - unknown tenant: `failed` `TENANT_NOT_FOUND`; a status other than `provisioning`, `active` or `suspended`:
   *   `failed` `TENANT_NOT_MIGRATABLE`; no file of the release has `targetVersion`: `failed`
   *   `UNKNOWN_TARGET_VERSION`; none of them retryable;
   * - otherwise one transaction: `migrated` with the schema's full ledger (also files applied by a newer release),
   *   `schemaVersion` its last row. An applied file of the release that was edited, also one after the target, rolls
   *   it back (`CHECKSUM_MISMATCH`, not retryable, `version` the first changed file).
   *
   * Never throws: what the run throws is classified (`classifyFailure`) as in `provisionTenant`; a missing schema is
   * `SCHEMA_MISSING` and a release without its tenant migrations folder `INVALID_MIGRATION_FILES` (neither
   * retryable).
   */
  async migrateTenant(tenantId: string, targetVersion?: string): Promise<MigrateResult> {
    try {
      const tenant = await this.platform.tenantById(tenantId);
      if (tenant === null) {
        return migrationFailed({
          error: {
            code: TENANT_OPS_ERROR_CODES.tenantNotFound,
            message: "No tenant has the id of the message",
          },
          retryable: false,
          version: null,
        });
      }
      if (!MIGRATABLE_TENANT_STATUSES.includes(tenant.status)) {
        return migrationFailed({
          error: {
            code: TENANT_OPS_ERROR_CODES.tenantNotMigratable,
            message: `The tenant is ${tenant.status}: only provisioning, active and suspended tenants are migrated`,
          },
          retryable: false,
          version: null,
        });
      }
      const files = await releaseMigrationFiles(this.options.migrationsDir);
      const selected = filesUpTo(files, targetVersion);
      if (selected === undefined) {
        return migrationFailed({
          error: {
            code: TENANT_OPS_ERROR_CODES.unknownTargetVersion,
            message: `No tenant migration of this release has the target version ${String(targetVersion)}`,
          },
          retryable: false,
          version: null,
        });
      }
      return await this.migrateSchema(tenant, files, selected);
    } catch (error) {
      return migrationFailed(classifyFailure(error), error);
    }
  }

  /**
   * The `seed_defaults` step inside the provisioning transaction (`db` is its connection): the settings row, the
   * default markup rule and the template defaults of OBE-004, all `ON CONFLICT DO NOTHING`. `timeZone` is the platform
   * tenant's (`tenantTimeZone`, read before the transaction): the settings' first `time_zone` when the runtime knows
   * it, else `UTC` (FIX-W35-OTA).
   */
  async seedDefaults(
    db: TenantSeedDb,
    tenant: PlatformTenant,
    timeZone?: string | null,
  ): Promise<SeedTenantResult> {
    return seedTenant(
      db,
      {
        name: tenant.name,
        defaultCurrency: tenant.defaultCurrency,
        defaultLocale: tenant.defaultLocale,
        timeZone,
      },
      { now: this.clock.now(), templatesDir: this.options.templatesDir },
    );
  }

  /** The one transaction: schema, grants, files and ledger (`migrateTenantSchema`), then seeds and the ledger read. */
  private async provisionSchema(tenant: PlatformTenant): Promise<ProvisionResult> {
    const startedAt = this.clock.now();
    // The platform's zone, read before the transaction opens (no platform read while it holds the schema's lock).
    const timeZone = await this.platform.tenantTimeZone(tenant.id);
    let inTransaction:
      | {
          readonly migrationsDoneAt: Date;
          readonly seedsDoneAt: Date;
          readonly seeded: SeedTenantResult;
          readonly ledger: readonly LedgerRecordRow[];
        }
      | undefined;
    const result = await migrateTenantSchema({
      schema: tenant.schemaName,
      dir: this.options.migrationsDir,
      url: this.database.url,
      create: true,
      beforeCommit: async ({ db }) => {
        const migrationsDoneAt = this.clock.now();
        const seeded = await this.seedDefaults(db, tenant, timeZone);
        const ledger = await readLedgerRows(db);
        inTransaction = { migrationsDoneAt, seedsDoneAt: this.clock.now(), seeded, ledger };
      },
    });
    if (inTransaction === undefined) {
      // migrateTenantSchema calls beforeCommit whenever the folder exists; without it, the release is broken.
      throw missingMigrationsFolder(result.dir);
    }
    const steps = provisioningSteps({
      startedAt,
      migrationsDoneAt: inTransaction.migrationsDoneAt,
      seedsDoneAt: inTransaction.seedsDoneAt,
      created: result.created,
      applied: result.applied,
      seeded: inTransaction.seeded,
    });
    return Object.freeze({
      status: "provisioned" as const,
      payload: provisionedPayload(tenant.schemaName, toMigrationRecords(inTransaction.ledger), steps),
    });
  }

  /**
   * The migration transaction (`migrateTenantSchemaFiles` without `create`, over the `selected` files), then, in its
   * `beforeCommit`, the checksums of every applied file of the release (`all`, also after the target) and the ledger
   * read.
   */
  private async migrateSchema(
    tenant: PlatformTenant,
    all: MigrationFiles,
    selected: MigrationFiles,
  ): Promise<MigrateResult> {
    let ledger: readonly LedgerRecordRow[] | undefined;
    const result = await migrateTenantSchemaFiles(selected, {
      schema: tenant.schemaName,
      url: this.database.url,
      beforeCommit: async ({ db, schema }) => {
        const rows = await readLedgerRows(db);
        const changed = checksumMismatches(all.numbered, toLedger(rows));
        if (changed.length > 0) {
          throw new TenantChecksumMismatchError(
            schema,
            changed.map(({ file }) => file.file),
          );
        }
        ledger = rows;
      },
    });
    if (ledger === undefined) {
      throw missingMigrationsFolder(result.dir);
    }
    return Object.freeze({
      status: "migrated" as const,
      schemaName: tenant.schemaName,
      applied: Object.freeze(result.applied.map((file) => file.id)),
      payload: migratedPayload(tenant.schemaName, toMigrationRecords(ledger)),
    });
  }

  /**
   * A classified provisioning failure: `steps` holds the step it ended, `failed`, when the classification knows it
   * (`create_schema` for a foreign schema, `run_migrations` for an edited or failing file).
   */
  private provisionFailure(failure: ClassifiedFailure, cause: unknown, startedAt: Date): ProvisionResult {
    const steps =
      failure.step === undefined
        ? []
        : [step(failure.step, "failed", startedAt, this.clock.now(), failure.error)];
    return Object.freeze({
      status: "failed" as const,
      payload: Object.freeze({ error: failure.error, retryable: failure.retryable, steps }),
      cause,
    });
  }

  /**
   * The ledger of `schema` when the schema is complete at the latest version (every file of the folder applied with
   * its checksum), otherwise `null`. Read-only, in a `tenantTx` of the provisioner pool.
   */
  private async completeLedger(
    schema: PlatformTenant["schemaName"],
  ): Promise<TenantMigrationRecord[] | null> {
    const files = await releaseMigrationFiles(this.options.migrationsDir);
    const rows = await tenantTx(this.database.tenants, schema, async (trx) => {
      // The ledger is looked up in the catalog by the schema's name (a bound parameter): resolved through the
      // search_path, `schema_migrations` of a missing schema could name another schema's ledger.
      const { rows: found } = await sql<{ found: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ${schema} AND c.relname = 'schema_migrations' AND c.relkind IN ('r', 'p')
        ) AS found
      `.execute(trx);
      return found[0]?.found === true ? readLedgerRows(trx) : null;
    });
    if (rows === null) {
      return null;
    }
    const ledger = toLedger(rows);
    const complete =
      checksumMismatches(files.numbered, ledger).length === 0 &&
      pendingNumberedFiles(files.numbered, ledger).length === 0;
    return complete ? toMigrationRecords(rows) : null;
  }
}
