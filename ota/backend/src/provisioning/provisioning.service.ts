// Tenant provisioning in the OTA worker (OBE-005; OADR-0007 items 1–5, PADR-0001 item 1, tenant provisioning flow
// §1–§2). `provisionTenant` re-reads the tenant from the platform tables and acts on its current state, never on the
// message: a `provisioning` tenant gets its schema in ONE transaction as velexis_provisioner (ADR-0004, ADR-0021):
// `migrateTenantSchema({ create: true })` of @velexis/db creates the schema under the advisory lock of its name
// (lock_timeout 5 s), grants velexis_ota_app its privileges and default privileges, applies every pending file of
// `migrations/tenant` with its ledger row, and then, through its `beforeCommit` callback and still before COMMIT,
// this service seeds the defaults (OBE-004) and reads the ledger. A crash anywhere before COMMIT leaves no schema.
// The result is reported by the processor after the commit (tenant-events.producer.ts).
//
// The provisioner's DSN (DATABASE_PROVISIONER_URL) exists only in the worker's configuration (config.ts), so the API
// process cannot build the `ProvisionerDatabase` (provisioning.module.ts). Failures this task classifies are the
// non-retryable ones of the flow: an unknown tenant, a tenant that is not `provisioning` (unless its schema is
// already complete) and a schema that provisioning did not create (foreign content or owner, never dropped). Any
// other error is thrown to BullMQ, which retries it; OBE-006 classifies those (failure-classifier.ts).
import { join } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import {
  OTA_PROVISIONING_STEPS,
  TENANT_MIGRATION_PHASES,
  type OtaProvisioningStep,
  type ProvisioningStepRecord,
  type ProvisioningStepStatus,
  type TenantJobError,
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
  pendingNumberedFiles,
  readMigrationFiles,
  TenantSchemaError,
  type LedgerRow,
  type MigrateTenantSchemaResult,
  type TenantMigrationFileEvent,
} from "@velexis/db/migrate";
import { Clock } from "../common/clock";
import { APP_DIR, WORKER_APP, type WorkerConfig } from "../config";
import { PlatformReadRepository } from "../tenancy/platform-read.repository";
import type { PlatformTenant } from "../tenancy/platform-read.types";
import { seedTenant, type SeedTenantResult, type TenantSeedDb } from "./seeds";

/** The tenant migrations of this release: `migrations/tenant` of the package (`ota-backend/` on the VM). */
export const TENANT_MIGRATIONS_DIR = join(APP_DIR, "migrations", "tenant");

// ---- The provisioner's database access --------------------------------------------------------------------------

/** Injection token of the worker's `ProvisionerDatabase`. */
export const PROVISIONER_DATABASE = "PROVISIONER_DATABASE";

/**
 * Connections of the provisioner pool: one per concurrent `ota-tenant-ops` job (concurrency 2). It serves only the
 * read-only ledger check of a tenant that is no longer `provisioning`; each provisioning transaction runs on a
 * connection of its own that `migrateTenantSchema` opens and closes. The worker so holds at most 4 provisioner
 * connections (a no-transaction file adds one while it runs), well inside `max_connections = 100` of
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

/** The stable codes of the failures this service reports itself (`tenant.provision_failed`, never retried). */
export const PROVISIONING_ERROR_CODES = Object.freeze({
  /** No `platform.tenants` row has the message's tenant id. */
  tenantNotFound: "TENANT_NOT_FOUND",
  /** The tenant is not `provisioning` and its schema is not complete at the latest version. */
  tenantNotProvisioning: "TENANT_NOT_PROVISIONING",
  /** The schema has relations but no `schema_migrations` ledger: left alone, never dropped (OADR-0007). */
  foreignContent: "FOREIGN_CONTENT",
  /** The schema belongs to another role than velexis_provisioner: left alone, never dropped. */
  foreignOwner: "FOREIGN_OWNER",
} as const);

/** The outcome of `provisionTenant`: the payload of the event the processor publishes after it. */
export type ProvisionResult =
  | { readonly status: "provisioned"; readonly payload: TenantProvisionedPayload }
  | { readonly status: "failed"; readonly payload: TenantProvisionFailedPayload };

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

/** The `tenant.provisioned` payload: `schemaVersion` is the last ledger row. */
export function provisionedPayload(
  schemaName: string,
  migrations: readonly TenantMigrationRecord[],
  steps: readonly ProvisioningStepRecord[],
): TenantProvisionedPayload {
  const latest = migrations.at(-1);
  if (latest === undefined) {
    throw new TypeError(`the ledger of ${schemaName} is empty: no tenant migration was applied`);
  }
  return Object.freeze({ schemaName, schemaVersion: latest.version, migrations, steps });
}

function failed(
  code: string,
  message: string,
  steps: readonly ProvisioningStepRecord[] = [],
): ProvisionResult {
  return Object.freeze({
    status: "failed" as const,
    payload: Object.freeze({ error: Object.freeze({ code, message }), retryable: false, steps }),
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
   * - `provisioning`: the one transaction of the file header; a schema provisioning did not create is `failed`
   *   `FOREIGN_CONTENT` or `FOREIGN_OWNER` and left as it is.
   *
   * `failed` results are never retryable. Other errors (lock timeout, connection loss, a failing or changed file) are
   * thrown, after the transaction rolled back.
   */
  async provisionTenant(tenantId: string): Promise<ProvisionResult> {
    const tenant = await this.platform.tenantById(tenantId);
    if (tenant === null) {
      return failed(PROVISIONING_ERROR_CODES.tenantNotFound, "No tenant has the id of the message");
    }
    if (tenant.status !== "provisioning") {
      const migrations = await this.completeLedger(tenant.schemaName);
      if (migrations !== null) {
        return Object.freeze({
          status: "provisioned" as const,
          payload: provisionedPayload(tenant.schemaName, migrations, skippedSteps(this.clock.now())),
        });
      }
      return failed(
        PROVISIONING_ERROR_CODES.tenantNotProvisioning,
        `The tenant is ${tenant.status}, not provisioning, and its schema is not complete at the latest version`,
      );
    }
    return this.provisionSchema(tenant);
  }

  /**
   * The `seed_defaults` step inside the provisioning transaction (`db` is its connection): the settings row, the
   * default markup rule and the template defaults of OBE-004, all `ON CONFLICT DO NOTHING`.
   */
  async seedDefaults(db: TenantSeedDb, tenant: PlatformTenant): Promise<SeedTenantResult> {
    return seedTenant(
      db,
      { name: tenant.name, defaultCurrency: tenant.defaultCurrency, defaultLocale: tenant.defaultLocale },
      { now: this.clock.now(), templatesDir: this.options.templatesDir },
    );
  }

  /** The one transaction: schema, grants, files and ledger (`migrateTenantSchema`), then seeds and the ledger read. */
  private async provisionSchema(tenant: PlatformTenant): Promise<ProvisionResult> {
    const startedAt = this.clock.now();
    let inTransaction:
      | {
          readonly migrationsDoneAt: Date;
          readonly seedsDoneAt: Date;
          readonly seeded: SeedTenantResult;
          readonly ledger: readonly LedgerRecordRow[];
        }
      | undefined;
    let result: MigrateTenantSchemaResult;
    try {
      result = await migrateTenantSchema({
        schema: tenant.schemaName,
        dir: this.options.migrationsDir,
        url: this.database.url,
        create: true,
        beforeCommit: async ({ db }) => {
          const migrationsDoneAt = this.clock.now();
          const seeded = await this.seedDefaults(db, tenant);
          const ledger = await readLedgerRows(db);
          inTransaction = { migrationsDoneAt, seedsDoneAt: this.clock.now(), seeded, ledger };
        },
      });
    } catch (error) {
      if (error instanceof TenantSchemaError && error.problem !== "missing") {
        return this.foreignSchema(error, startedAt);
      }
      throw error;
    }
    if (inTransaction === undefined) {
      // migrateTenantSchema calls beforeCommit whenever the folder exists; without it, the release is broken.
      throw new Error(`the tenant migrations folder ${result.dir} does not exist`);
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

  /** A schema that provisioning did not create: reported as a failed `create_schema`, never touched. */
  private foreignSchema(error: TenantSchemaError, startedAt: Date): ProvisionResult {
    const jobError: TenantJobError =
      error.problem === "foreign_owner"
        ? {
            code: PROVISIONING_ERROR_CODES.foreignOwner,
            message: "The tenant schema belongs to another role than velexis_provisioner; it is left alone",
          }
        : {
            code: PROVISIONING_ERROR_CODES.foreignContent,
            message:
              "The tenant schema holds relations but no schema_migrations ledger (foreign content); it is left " +
              "alone and never dropped",
          };
    const [createSchema] = OTA_PROVISIONING_STEPS;
    return failed(jobError.code, jobError.message, [
      step(createSchema, "failed", startedAt, this.clock.now(), jobError),
    ]);
  }

  /**
   * The ledger of `schema` when the schema is complete at the latest version (every file of the folder applied with
   * its checksum), otherwise `null`. Read-only, in a `tenantTx` of the provisioner pool.
   */
  private async completeLedger(
    schema: PlatformTenant["schemaName"],
  ): Promise<TenantMigrationRecord[] | null> {
    const files = await readMigrationFiles(this.options.migrationsDir, "tenant");
    if (!files.exists) {
      throw new Error(`the tenant migrations folder ${files.dir} does not exist`);
    }
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
    const ledger = new Map<string, LedgerRow>(
      rows.map((row) => [
        row.id,
        { id: row.id, checksum: row.checksum, phase: row.phase as LedgerRow["phase"], status: "applied" },
      ]),
    );
    const complete =
      checksumMismatches(files.numbered, ledger).length === 0 &&
      pendingNumberedFiles(files.numbered, ledger).length === 0;
    return complete ? toMigrationRecords(rows) : null;
  }
}
