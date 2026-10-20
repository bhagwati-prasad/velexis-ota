// `tenants:report-migrations --report <file>` of dist/cli.js (OBE-007; OADR-0007 item 7, tenant provisioning flow
// §4, ADR-0021): the deploy step right after the tenant fan-out (`migrate.js tenants --report <file>`) and before the
// `current` switch. velexis-deploy runs it as the OTA zone user through `velexis-run ota`, with ota-backend.env and
// ota-worker.env (REDIS_URL and DATABASE_URL, the read-only velexis_ota_app role), never with the migrator DSN.
//
// It reads the fan-out's JSON report and publishes one event on `platform-tenant-events` per schema the report names
// in `applied` or `failed`, with `jobId: null` (no provisioning job asked for it):
//
// - `applied` (the schema is at the release's target, whether this run applied files or not): `tenant.migrated` with
//   the schema's full ledger, read from its `schema_migrations` in a `tenantTx`, so a repeated run re-sends a correct
//   mirror of every schema (the platform upserts it into `tenant_schema_migrations` and `tenants.schema_version`);
// - `failed` (its transaction was rolled back): `tenant.migration_failed` with the file at fault and an
//   `error {code, message}` written here from the report's SQLSTATE, line and exit code, never from PostgreSQL's text,
//   which can quote values. Deploy reports are never retried by the platform, so `retryable` is left out.
//
// `skipped` schemas (a `provisioning` tenant without a schema yet: its provisioning reports it) get no event. The
// tenant id of each schema comes from `platform.tenants` (`tenant_<key>`, read-only). A schema whose tenant no longer
// exists, and an `applied` schema that has no ledger any more (dropped after the fan-out: resolved through the
// search_path, `schema_migrations` would then name the `reference` ledger), are reported on stderr and skipped. Every
// event is built, and validated with `validateJob`, before the first is added, so a report the command cannot read in
// full publishes nothing. The events of one report are always the same: `requestId` comes from the report
// (`deploy-<sha>` for `migrate-<sha>.json`), so the platform's logs tie them to the release.
//
// Exit codes (cli.ts): 0 when every event was added (or there was nothing to report), 1 on an unreadable or invalid
// report, an invalid configuration, a database error, or when Redis refuses an event (the deploy then stops, like a
// failed migration, and running it again is harmless). Output names schemas, tenant ids, versions and error codes;
// never a DSN, a password or the report's error texts.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  JOB_CONTRACT_VERSION,
  validateJob,
  type TenantJobError,
  type TenantMigratedEvent,
  type TenantMigrationFailedEvent,
  type TenantMigrationFailedPayload,
  type TenantMigrationRecord,
} from "@velexis/api-types/jobs";
import { ConfigError, defineConfig, loadDevEnvFiles, type EnvSource } from "@velexis/config";
import { sha256Hex } from "@velexis/crypto";
import {
  createPlatformDb,
  createPool,
  createTenantDb,
  isTenantSchema,
  sql,
  tenantTx,
  type TenantDb,
} from "@velexis/db";
import { createLogger, type Logger } from "@velexis/logger";
import { Queue, type JobsOptions } from "bullmq";
import { Redis, type RedisOptions } from "ioredis";
import type { CliStreams } from "../cli";
import { Clock } from "../common/clock";
import { BULLMQ_PREFIX, DEFAULT_JOB_OPTIONS, PLATFORM_TENANT_EVENTS } from "../common/queues/queue-names";
import { settleBullmqStartup } from "../common/queues/queues.module";
import { closeRedisConnection } from "../common/redis/redis.module";
import { APP_DIR, workerConfigSchema } from "../config";
import { PlatformReadRepository } from "../tenancy/platform-read.repository";
import { classifyFailure, jobError, migrationVersion, TENANT_OPS_ERROR_CODES } from "./failure-classifier";
import { migratedPayload, toMigrationRecords, type LedgerRecordRow } from "./provisioning.service";

/** The command word. */
export const REPORT_MIGRATIONS_COMMAND = "tenants:report-migrations";

/** The usage line of the command. */
export const REPORT_MIGRATIONS_USAGE = `Usage: node dist/cli.js ${REPORT_MIGRATIONS_COMMAND} --report <file>`;

/** The process name of the command's log lines and of its PostgreSQL `application_name`. */
export const REPORT_MIGRATIONS_APP = "ota-cli-report-migrations";

/** The largest report the command reads: about 2 kB per schema, so ten thousand schemas fit. */
export const MAX_REPORT_BYTES = 32 * 1024 * 1024;

// ---- The fan-out report ------------------------------------------------------------------------------------------

/** A schema the fan-out migrated without error (`TenantSchemaApplied` of @velexis/db): only the name is used. */
export interface ReportedAppliedSchema {
  readonly schema: string;
}

/** A schema whose migration failed (`TenantSchemaFailure` of @velexis/db). */
export interface ReportedFailedSchema {
  readonly schema: string;
  /** The failing (or first changed) file, `NNNN_name.sql`, or `null` when no file was at fault. */
  readonly file: string | null;
  /** PostgreSQL's SQLSTATE and position; its `message` is never passed on. */
  readonly error: { readonly code?: string; readonly line?: number; readonly statement?: number };
  /** What `migrate.js tenant` would exit with: `2` for a checksum mismatch, otherwise `1`. */
  readonly exitCode: number;
}

/** What the command reads of the report `{ target, total, applied, failed, skipped }` of `migrate.js tenants`. */
export interface FanOutReport {
  readonly applied: readonly ReportedAppliedSchema[];
  readonly failed: readonly ReportedFailedSchema[];
}

/** The report cannot be read or is not a fan-out report. The message never quotes the file's content. */
export class ReportFileError extends Error {
  override readonly name = "ReportFileError";
}

const SQLSTATE = /^[0-9A-Z]{5}$/;
/** What a migration file of the report must look like before its name goes into an event (`NNNN_name.sql`). */
const MIGRATION_FILE = /^[0-9]{4,14}(_[a-z0-9_]+)?\.sql$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function schemaOf(entry: unknown, where: string): string {
  if (!isRecord(entry) || typeof entry["schema"] !== "string" || !isTenantSchema(entry["schema"])) {
    throw new ReportFileError(
      `it is not a fan-out report: an entry of ${where} has no valid tenant schema name`,
    );
  }
  return entry["schema"];
}

function failedEntry(entry: unknown): ReportedFailedSchema {
  const schema = schemaOf(entry, "failed");
  const { file, error, exitCode } = entry as Record<string, unknown>;
  const problem = (what: string): ReportFileError =>
    new ReportFileError(`it is not a fan-out report: the failed entry of ${schema} has ${what}`);
  if (file !== null && (typeof file !== "string" || !MIGRATION_FILE.test(file))) {
    throw problem("no valid file (NNNN_name.sql or null)");
  }
  if (!isRecord(error)) {
    throw problem("no error object");
  }
  const { code, line, statement } = error;
  if (code !== undefined && (typeof code !== "string" || !SQLSTATE.test(code))) {
    throw problem("an error code that is not a SQLSTATE");
  }
  if ((line !== undefined && !isCount(line)) || (statement !== undefined && !isCount(statement))) {
    throw problem("an error position that is not a number");
  }
  if (!isCount(exitCode)) {
    throw problem("no exit code");
  }
  return Object.freeze({
    schema,
    file,
    error: Object.freeze({
      ...(code === undefined ? {} : { code }),
      ...(line === undefined ? {} : { line }),
      ...(statement === undefined ? {} : { statement }),
    }),
    exitCode,
  });
}

/**
 * The report in `text` (the JSON of `migrate.js tenants --report`): `applied` and `failed` arrays of entries with a
 * valid tenant schema name (`skipped`, `target` and `total` are not needed). Throws `ReportFileError`, whose message
 * never quotes the text, for anything else.
 */
export function parseFanOutReport(text: string): FanOutReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReportFileError("it is not JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["applied"]) || !Array.isArray(parsed["failed"])) {
    throw new ReportFileError("it is not a fan-out report: it has no applied and failed lists");
  }
  const applied = (parsed["applied"] as unknown[]).map((entry) =>
    Object.freeze({ schema: schemaOf(entry, "applied") }),
  );
  const failed = (parsed["failed"] as unknown[]).map(failedEntry);
  return Object.freeze({ applied: Object.freeze(applied), failed: Object.freeze(failed) });
}

/** The report file: its text and parsed content. Throws `ReportFileError` when it cannot be read or parsed. */
export async function readFanOutReport(
  path: string,
): Promise<{ readonly report: FanOutReport; readonly text: string }> {
  let text: string;
  try {
    const bytes = await readFile(path);
    if (bytes.length > MAX_REPORT_BYTES) {
      throw new ReportFileError(`it is larger than ${MAX_REPORT_BYTES} bytes`);
    }
    text = bytes.toString("utf8");
  } catch (error) {
    if (error instanceof ReportFileError) {
      throw error;
    }
    const code = (error as NodeJS.ErrnoException).code;
    throw new ReportFileError(typeof code === "string" ? `it cannot be read (${code})` : "it cannot be read");
  }
  return { report: parseFanOutReport(text), text };
}

/**
 * The `requestId` of the events of one report: `deploy-<sha>` for the deploy's `migrate-<sha>.json`, otherwise
 * `migrations-report-` and the first 16 hex characters of the report's SHA-256. Both are fixed for a report, so a
 * repeated run sends the same events.
 */
export function reportRequestId(path: string, text: string): string {
  const deploy = /^migrate-([0-9a-f]{7,40})\.json$/.exec(basename(path));
  return deploy?.[1] !== undefined
    ? `deploy-${deploy[1]}`
    : `migrations-report-${sha256Hex(text).slice(0, 16)}`;
}

// ---- The events --------------------------------------------------------------------------------------------------

/** The transient codes `classifyFailure` gives a SQLSTATE: their messages hold for a fan-out schema too. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  TENANT_OPS_ERROR_CODES.lockTimeout,
  TENANT_OPS_ERROR_CODES.serializationFailure,
  TENANT_OPS_ERROR_CODES.deadlock,
  TENANT_OPS_ERROR_CODES.connectionLost,
]);

/** Where PostgreSQL stopped, for a message: `SQLSTATE 42P01, line 3`. */
function position(failure: ReportedFailedSchema): string {
  const { code, line, statement } = failure.error;
  return [
    code === undefined ? undefined : `SQLSTATE ${code}`,
    line === undefined ? undefined : `line ${line}`,
    statement === undefined ? undefined : `statement ${statement}`,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
}

/** The `error {code, message}` of a failed schema (see the file header). */
function reportedError(failure: ReportedFailedSchema): TenantJobError {
  const where = position(failure);
  const at = where === "" ? "" : ` (${where})`;
  if (failure.exitCode === 2) {
    return jobError(
      TENANT_OPS_ERROR_CODES.checksumMismatch,
      `An applied tenant migration file changed since it was applied${failure.file === null ? "" : `, ${failure.file} first`}. ` +
        "The deploy fan-out applied nothing to the schema; restore the merged files and fix forward with a new numbered file",
    );
  }
  if (failure.error.code !== undefined) {
    // classifyFailure knows the SQLSTATEs of lock timeouts, serialization failures, deadlocks and lost connections.
    const classified = classifyFailure({ code: failure.error.code, severity: "ERROR" });
    if (TRANSIENT_CODES.has(classified.error.code)) {
      return jobError(classified.error.code, `${classified.error.message} (deploy fan-out)`);
    }
  }
  if (failure.file !== null) {
    return jobError(
      TENANT_OPS_ERROR_CODES.migrationFailed,
      `The tenant migration ${failure.file} failed in the deploy fan-out${at}: its transaction was rolled back and ` +
        "nothing of it is recorded; fix it forward with a new numbered file",
    );
  }
  return jobError(
    failure.error.code ?? TENANT_OPS_ERROR_CODES.unexpected,
    `The deploy fan-out could not migrate the schema${at}; its transaction was rolled back. The fan-out report in ` +
      "/var/log/velexis has the details",
  );
}

/** The `tenant.migration_failed` payload of a failed schema of the report (no `retryable`: never retried). */
export function failedSchemaPayload(failure: ReportedFailedSchema): TenantMigrationFailedPayload {
  return Object.freeze({
    version: failure.file === null ? null : migrationVersion(failure.file),
    error: reportedError(failure),
  });
}

/** What the command reads besides the report: the platform's tenants and the tenant schemas' ledgers. */
export interface ReportSources {
  /** The id (`ten_…`) of the tenant whose schema is `schema`, or `null` when there is none. */
  tenantIdOfSchema(schema: string): Promise<string | null>;
  /**
   * The schema's full ledger (its applied `schema_migrations` rows), in apply order, or `null` when the schema has no
   * `schema_migrations` table (it was dropped after the fan-out).
   */
  ledgerOf(schema: string): Promise<TenantMigrationRecord[] | null>;
}

/** Where the events go: `platform-tenant-events` (a BullMQ `Queue`; tests pass a fake). */
export interface ReportEventQueue {
  add(name: string, data: unknown, options?: JobsOptions): Promise<unknown>;
}

export type ReportEvent = TenantMigratedEvent | TenantMigrationFailedEvent;

/** What a run published, in order, and the schemas it skipped. */
export interface ReportOutcome {
  readonly events: readonly ReportEvent[];
  /** The schema of each event, in the order of `events`. */
  readonly schemas: readonly string[];
  /** Schemas whose tenant is gone from `platform.tenants`: no event can name a tenant for them. */
  readonly unknownSchemas: readonly string[];
  /** `applied` schemas whose ledger is gone (the schema was dropped after the fan-out): no ledger to mirror. */
  readonly missingLedgers: readonly string[];
}

/** Redis refused an event: `published` of the run's events were added before it. */
export class ReportPublishError extends Error {
  override readonly name = "ReportPublishError";

  constructor(
    readonly published: number,
    readonly total: number,
    override readonly cause: unknown,
  ) {
    super(`Redis refused the event ${published + 1} of ${total}`, { cause });
  }
}

export interface PublishReportOptions {
  readonly sources: ReportSources;
  readonly queue: ReportEventQueue;
  readonly clock: Pick<Clock, "now">;
  readonly requestId: string;
}

/**
 * Builds the events of `report` (see the file header), validates each with `validateJob`, then adds them to `queue`
 * in order: the `applied` schemas, then the `failed` ones. Nothing is added when building one fails. Throws
 * `ReportPublishError` when the queue refuses an event.
 */
export async function publishReport(
  report: FanOutReport,
  options: PublishReportOptions,
): Promise<ReportOutcome> {
  const { sources, queue, clock, requestId } = options;
  const unknownSchemas: string[] = [];
  const missingLedgers: string[] = [];
  const events: ReportEvent[] = [];
  const schemas: string[] = [];
  const envelope = async (schema: string) => {
    const tenantId = await sources.tenantIdOfSchema(schema);
    if (tenantId === null) {
      unknownSchemas.push(schema);
      return undefined;
    }
    return {
      v: JOB_CONTRACT_VERSION,
      jobId: null,
      tenantId,
      requestedAt: clock.now().toISOString(),
      requestId,
    } as const;
  };
  for (const { schema } of report.applied) {
    const base = await envelope(schema);
    if (base === undefined) {
      continue;
    }
    const ledger = await sources.ledgerOf(schema);
    if (ledger === null) {
      missingLedgers.push(schema);
      continue;
    }
    const payload = migratedPayload(schema, ledger);
    events.push(validateJob("tenant.migrated", { ...base, name: "tenant.migrated", payload }));
    schemas.push(schema);
  }
  for (const failure of report.failed) {
    const base = await envelope(failure.schema);
    if (base !== undefined) {
      const payload = failedSchemaPayload(failure);
      events.push(
        validateJob("tenant.migration_failed", { ...base, name: "tenant.migration_failed", payload }),
      );
      schemas.push(failure.schema);
    }
  }
  for (const [index, event] of events.entries()) {
    try {
      await queue.add(event.name, event);
    } catch (error) {
      throw new ReportPublishError(index, events.length, error);
    }
  }
  return Object.freeze({
    events: Object.freeze(events),
    schemas: Object.freeze(schemas),
    unknownSchemas: Object.freeze(unknownSchemas),
    missingLedgers: Object.freeze(missingLedgers),
  });
}

// ---- The database and Redis --------------------------------------------------------------------------------------

/** The variables the command reads: those of ota-backend.env (DATABASE_URL is velexis_ota_app) and REDIS_URL. */
export const REPORT_MIGRATIONS_CONFIG_SCHEMA = {
  APP_ENV: workerConfigSchema.APP_ENV,
  LOG_LEVEL: workerConfigSchema.LOG_LEVEL,
  DATABASE_URL: workerConfigSchema.DATABASE_URL,
  REDIS_URL: workerConfigSchema.REDIS_URL,
} as const;

/** The tenants and ledgers as velexis_ota_app: `platform.tenants` read-only, each ledger in a `tenantTx`. */
export class DatabaseReportSources implements ReportSources {
  constructor(
    private readonly platform: Pick<PlatformReadRepository, "tenantByKey">,
    private readonly tenants: TenantDb,
  ) {}

  async tenantIdOfSchema(schema: string): Promise<string | null> {
    // `platform.tenants.schema_name` is generated as `'tenant_' || key`.
    const tenant = await this.platform.tenantByKey(schema.slice("tenant_".length));
    return tenant === null || tenant.schemaName !== schema ? null : tenant.id;
  }

  async ledgerOf(schema: string): Promise<TenantMigrationRecord[] | null> {
    const rows = await tenantTx(this.tenants, schema, async (trx) => {
      // The ledger is looked up in the catalog by the schema's name (a bound parameter) first: resolved through the
      // search_path (`<schema>, reference`), `schema_migrations` of a dropped schema would be the reference ledger.
      const { rows: exists } = await sql<{ found: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ${schema} AND c.relname = 'schema_migrations' AND c.relkind IN ('r', 'p')
        ) AS found
      `.execute(trx);
      if (exists[0]?.found !== true) {
        return null;
      }
      const { rows: found } = await sql<LedgerRecordRow>`
        SELECT id, checksum, phase, execution_ms, created_at FROM schema_migrations
        WHERE status = 'applied' ORDER BY id
      `.execute(trx);
      return found;
    });
    return rows === null ? null : toMigrationRecords(rows);
  }
}

/** How long the whole publication may take before the command gives up (a deploy must never hang on it). */
export const REPORT_PUBLISH_TIMEOUT_MS = 60_000;
/** Connection attempts to Redis before the events count as refused. */
export const REPORT_REDIS_CONNECT_ATTEMPTS = 3;

/**
 * The Redis connection of the queue: one retry per command and a few connection attempts, so an unreachable or
 * refusing Redis fails the command within seconds instead of making BullMQ wait for it.
 */
export function reportRedisOptions(): RedisOptions {
  return {
    connectionName: REPORT_MIGRATIONS_APP,
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt: number) => (attempt >= REPORT_REDIS_CONNECT_ATTEMPTS ? null : attempt * 250),
  };
}

/** A short reason for a Redis failure: an errno code or Redis's error word (`WRONGPASS`, `OOM`), never the URL. */
export function redisFailureReason(error: unknown): string {
  for (let item = error, depth = 0; item instanceof Error && depth < 5; item = item.cause, depth += 1) {
    const code = (item as NodeJS.ErrnoException).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(code)) {
      return code;
    }
    const word = /^([A-Z][A-Z0-9_]{1,31})\b/.exec(item.message)?.[1];
    if (word !== undefined) {
      return word;
    }
  }
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
    ? error.name
    : "unknown error";
}

/** The reason of a refusal: the error of `add`, or the connection's last error when `add` only names a closed one. */
function refusalReason(addError: unknown, connectionError: unknown): string {
  const reason = redisFailureReason(addError);
  return connectionError !== undefined && !/^[A-Z][A-Z0-9_]{1,31}$/.test(reason)
    ? redisFailureReason(connectionError)
    : reason;
}

/** The timeout of the whole publication. */
class ReportTimeoutError extends Error {
  override readonly name = "ReportTimeoutError";
}

/**
 * A short reason for any other failure, for stderr: our timeout's message, else the error's class name and its
 * SQLSTATE or errno code. Never the error's message: PostgreSQL's can quote values.
 */
function failureReason(error: unknown): string {
  if (error instanceof ReportTimeoutError) {
    return error.message;
  }
  const name =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
  const code: unknown =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z0-9][A-Z0-9_]{1,31}$/.test(code) ? `${name} ${code}` : name;
}

/** Rejects after `ms` with `message`, unless `promise` settles first. */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ReportTimeoutError(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- The command -------------------------------------------------------------------------------------------------

/** The `--report` file of the arguments, or `undefined` when they are not exactly `--report <file>`. */
export function reportPathOf(args: readonly string[]): string | undefined {
  const [first, second, ...rest] = args;
  if (rest.length > 0 || first === undefined) {
    return undefined;
  }
  if (first.startsWith("--report=")) {
    const path = first.slice("--report=".length);
    return second === undefined && path !== "" ? path : undefined;
  }
  return first === "--report" && second !== undefined && second !== "" ? second : undefined;
}

/** The command's configuration: `env` (tests), else the process environment and, in development, `.env.local`. */
function loadReportConfig(env: EnvSource | undefined) {
  if (env !== undefined) {
    return defineConfig(REPORT_MIGRATIONS_CONFIG_SCHEMA, env);
  }
  loadDevEnvFiles({ appDir: APP_DIR });
  return defineConfig(REPORT_MIGRATIONS_CONFIG_SCHEMA);
}

/** What `runReportMigrations` gets from cli.ts. */
export interface ReportMigrationsIo extends CliStreams {
  /** The configuration variables instead of the process environment and `.env.local` files (tests). */
  readonly env?: EnvSource | undefined;
}

function cliLogger(config: { APP_ENV: string; LOG_LEVEL: string }, io: CliStreams): Logger {
  const level = config.LOG_LEVEL === "debug" ? "debug" : config.LOG_LEVEL === "error" ? "error" : "warn";
  return createLogger({
    app: REPORT_MIGRATIONS_APP,
    env: config.APP_ENV,
    level,
    destination: { write: (line: string) => void io.stderr.write(line) },
  });
}

function eventLine(event: ReportEvent, schema: string): string {
  if (event.name === "tenant.migrated") {
    return `${event.name} ${schema} (${event.tenantId}) at ${event.payload.schemaVersion}`;
  }
  return `${event.name} ${schema} (${event.tenantId}) ${event.payload.error.code}${
    event.payload.version === null ? "" : ` at ${event.payload.version}`
  }`;
}

/** `tenants:report-migrations --report <file>` (see the file header). */
export async function runReportMigrations(args: readonly string[], io: ReportMigrationsIo): Promise<number> {
  const path = reportPathOf(args);
  if (path === undefined) {
    io.stderr.write(`${REPORT_MIGRATIONS_COMMAND}: name the fan-out report.\n${REPORT_MIGRATIONS_USAGE}\n`);
    return 1;
  }
  let report: FanOutReport;
  let requestId: string;
  try {
    const read = await readFanOutReport(path);
    report = read.report;
    requestId = reportRequestId(path, read.text);
  } catch (error) {
    if (error instanceof ReportFileError) {
      io.stderr.write(`${REPORT_MIGRATIONS_COMMAND}: the report ${path} is unusable: ${error.message}.\n`);
      return 1;
    }
    throw error;
  }
  if (report.applied.length === 0 && report.failed.length === 0) {
    io.stdout.write(
      `${REPORT_MIGRATIONS_COMMAND}: the report names no migrated or failed schema; nothing to publish.\n`,
    );
    return 0;
  }
  let config: ReturnType<typeof loadReportConfig>;
  try {
    config = loadReportConfig(io.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr.write(`${REPORT_MIGRATIONS_COMMAND}: the configuration is invalid:\n${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const logger = cliLogger(config, io);
  const pool = createPool(config.DATABASE_URL, { applicationName: REPORT_MIGRATIONS_APP, logger, max: 2 });
  const connection = new Redis(config.REDIS_URL, reportRedisOptions());
  // The last connection error says why the events were refused when `add` only learns that the connection closed.
  let connectionError: unknown;
  connection.on("error", (error: unknown) => {
    connectionError = error;
  });
  const queue = new Queue(PLATFORM_TENANT_EVENTS, {
    connection,
    prefix: BULLMQ_PREFIX,
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS },
  });
  queue.on("error", () => undefined);
  const sources = new DatabaseReportSources(
    new PlatformReadRepository(createPlatformDb(pool)),
    createTenantDb(pool, { appEnv: config.APP_ENV }),
  );
  try {
    const outcome = await withTimeout(
      publishReport(report, { sources, queue, clock: new Clock(), requestId }),
      REPORT_PUBLISH_TIMEOUT_MS,
      `the publication did not end within ${REPORT_PUBLISH_TIMEOUT_MS / 1000} s`,
    );
    for (const schema of outcome.unknownSchemas) {
      io.stderr.write(
        `${REPORT_MIGRATIONS_COMMAND}: ${schema} has no tenant in platform.tenants any more; no event for it.\n`,
      );
    }
    for (const schema of outcome.missingLedgers) {
      io.stderr.write(
        `${REPORT_MIGRATIONS_COMMAND}: ${schema} has no schema_migrations ledger any more; no event for it.\n`,
      );
    }
    const lines = outcome.events.map((event, index) => eventLine(event, outcome.schemas[index] ?? ""));
    io.stdout.write(
      `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}` +
        `${REPORT_MIGRATIONS_COMMAND}: ${outcome.events.length} event(s) published on ${PLATFORM_TENANT_EVENTS} ` +
        `(request ${requestId}).\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof ReportPublishError) {
      io.stderr.write(
        `${REPORT_MIGRATIONS_COMMAND}: Redis refused the events (${refusalReason(error.cause, connectionError)}); ` +
          `${error.published} of ${error.total} were published. Run the command again: repeating it is harmless.\n`,
      );
      return 1;
    }
    io.stderr.write(
      `${REPORT_MIGRATIONS_COMMAND}: publishing the report failed (${failureReason(error)}). Run the command ` +
        "again: repeating it is harmless.\n",
    );
    return 1;
  } finally {
    // BullMQ 5 reports a set-up interrupted by a close as an unhandled rejection: let it settle first (OBE-005).
    await settleBullmqStartup([queue]);
    await queue.close().catch(() => undefined);
    await closeRedisConnection(connection);
    await pool.end().catch(() => undefined);
  }
}
