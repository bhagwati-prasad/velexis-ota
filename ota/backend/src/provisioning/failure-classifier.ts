// How the OTA worker classifies the failures of an `ota-tenant-ops` job (OBE-006; OADR-0007 items 5–6, tenant
// provisioning flow §5, PADR-0001 item 4). Every failure becomes an `error {code, message}` for the event, whether
// another attempt may succeed (`retryable`), the migration at fault (`version`) and, for provisioning, the step it
// ended (`step`):
//
// | Failure                                                           | Code                     | Retryable |
// |-------------------------------------------------------------------|--------------------------|-----------|
// | Lock timeout (55P03), e.g. another run holds the schema's lock    | LOCK_TIMEOUT             | yes       |
// | Serialization failure (40001)                                     | SERIALIZATION_FAILURE    | yes       |
// | Deadlock (40P01)                                                  | DEADLOCK                 | yes       |
// | Connection loss (class 08, 57P01–57P03, 53300, ECONNRESET, …)     | CONNECTION_LOST          | yes       |
// | An applied file was edited (`TenantChecksumMismatchError`)        | CHECKSUM_MISMATCH        | no        |
// | Relations but no ledger, or another owner (`TenantSchemaError`)   | FOREIGN_CONTENT / _OWNER | no        |
// | No schema to migrate (`TenantSchemaError` `missing`)              | SCHEMA_MISSING           | no        |
// | Malformed `platform.tenants.schema_name`                          | INVALID_SCHEMA_NAME      | no        |
// | A file failed for another reason (`TenantMigrationFailedError`)   | MIGRATION_FAILED         | no        |
// | The release's migration folder is invalid (`MigrationFilesError`) | INVALID_MIGRATION_FILES  | no        |
// | A platform value this release does not know                       | UNEXPECTED_PLATFORM_VALUE| no        |
// | Anything else                                                     | its SQLSTATE, or         | yes       |
// |                                                                   | UNEXPECTED_ERROR         |           |
//
// The wrong tenant status (`TENANT_NOT_PROVISIONING`, `TENANT_NOT_MIGRATABLE`) and an unknown tenant or target
// version are decided by the provisioning service itself and are never retryable either. The service reports a
// release without its tenant migrations folder as a `MigrationFilesError` too (`INVALID_MIGRATION_FILES`).
//
// A retryable failure is thrown back to BullMQ, which retries it within the attempt (the platform dispatches with
// `attempts: 3`); only the last try reports `retryable: true`, and the platform re-dispatches with backoff. A
// non-retryable one is reported at once and ends the job with `UnrecoverableError`. A file that fails for another
// reason than a transient one fails the same way on every try (its transaction rolled back, nothing changed), so it
// is reported at once, like an edited file: it must be fixed forward with a new file (conventions §9). Anything this
// file does not know is retryable, as the platform's reconciler treats a job that failed without an event
// (PADR-0001 item 6), within the platform's attempt budget.
//
// The messages are written here: never PostgreSQL's message (it can quote SQL text or values), the SQL itself, its
// parameters, a DSN or a value of the tenant row. Codes, SQLSTATEs, file names (`NNNN_name.sql`, checked by the
// runner) and error class names are all they name.
import type { OtaProvisioningStep, TenantJobError } from "@velexis/api-types/jobs";
import { InvalidTenantSchemaError } from "@velexis/db";
import {
  MigrationFilesError,
  TenantChecksumMismatchError,
  TenantMigrationFailedError,
  TenantSchemaError,
} from "@velexis/db/migrate";
import { UnexpectedPlatformValueError } from "../tenancy/platform-read.types";

/** The stable codes of the failure events of `ota-tenant-ops` jobs (`error.code`). */
export const TENANT_OPS_ERROR_CODES = Object.freeze({
  /** No `platform.tenants` row has the message's tenant id. */
  tenantNotFound: "TENANT_NOT_FOUND",
  /** `tenant.provision`: the tenant is not `provisioning` and its schema is not complete at the latest version. */
  tenantNotProvisioning: "TENANT_NOT_PROVISIONING",
  /** `tenant.migrate`: the tenant is not `provisioning`, `active` or `suspended` (the deploy fan-out's targets). */
  tenantNotMigratable: "TENANT_NOT_MIGRATABLE",
  /** `tenant.migrate`: no tenant migration of this release has the message's `targetVersion`. */
  unknownTargetVersion: "UNKNOWN_TARGET_VERSION",
  /** Waiting for a lock timed out (SQLSTATE 55P03): another run holds the schema's advisory lock, for example. */
  lockTimeout: "LOCK_TIMEOUT",
  /** SQLSTATE 40001. */
  serializationFailure: "SERIALIZATION_FAILURE",
  /** SQLSTATE 40P01. */
  deadlock: "DEADLOCK",
  /** The database connection could not be made or was lost. */
  connectionLost: "CONNECTION_LOST",
  /** An applied tenant migration file was edited: nothing was applied (exit code 2 of the CLI). */
  checksumMismatch: "CHECKSUM_MISMATCH",
  /** The schema has relations but no `schema_migrations` ledger: left alone, never dropped (OADR-0007). */
  foreignContent: "FOREIGN_CONTENT",
  /** The schema belongs to another role than velexis_provisioner: left alone, never dropped. */
  foreignOwner: "FOREIGN_OWNER",
  /** `tenant.migrate` found no schema: `tenant.provision` creates it. */
  schemaMissing: "SCHEMA_MISSING",
  /** `platform.tenants.schema_name` does not match `^tenant_[a-z][a-z0-9_]{1,39}$` (ADR-0004). */
  invalidSchemaName: "INVALID_SCHEMA_NAME",
  /** A tenant migration file failed for a reason a retry does not change; its transaction was rolled back. */
  migrationFailed: "MIGRATION_FAILED",
  /** The tenant migrations folder of this release is invalid (a duplicated number, a bad header, …). */
  invalidMigrationFiles: "INVALID_MIGRATION_FILES",
  /** A `platform.tenants` value outside the CHECK lists this release knows. */
  unexpectedPlatformValue: "UNEXPECTED_PLATFORM_VALUE",
  /** An error this file does not know, without a SQLSTATE. */
  unexpected: "UNEXPECTED_ERROR",
} as const);

/** A failure as the events report it. */
export interface ClassifiedFailure {
  /** `{code, message}` of the event: no SQL text, parameters, values or DSN. */
  readonly error: TenantJobError;
  /** True: another try may succeed (BullMQ retries within the attempt, then the event says so). */
  readonly retryable: boolean;
  /** The failing (or first changed) migration, `NNNN_name`; `null` when no file was at fault. */
  readonly version: string | null;
  /** The provisioning step the failure ended, when it is known. */
  readonly step: OtaProvisioningStep | undefined;
}

/** The SQLSTATEs of a lost or refused connection besides class 08 (connection exception). */
const CONNECTION_SQLSTATES: ReadonlySet<string> = new Set([
  "57P01", // admin_shutdown: the server terminated the session
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now: the server is starting or shutting down
  "53300", // too_many_connections
]);

/** Node's system error codes of a lost, refused or unreachable connection. */
const CONNECTION_ERRNOS: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EAI_AGAIN",
]);

/** The messages `pg` gives a lost connection, which carry no code. */
const CONNECTION_MESSAGES: readonly RegExp[] = [
  /^Connection terminated\b/,
  /connection error and is not queryable/,
  /^timeout exceeded when trying to connect$/,
];

/** The transient SQLSTATEs that are not about the connection, with their code and message. */
const TRANSIENT_SQLSTATES: Readonly<Record<string, TenantJobError>> = Object.freeze({
  "55P03": {
    code: TENANT_OPS_ERROR_CODES.lockTimeout,
    message:
      "Waiting for a lock timed out (SQLSTATE 55P03): another run may hold the tenant schema's advisory lock; " +
      "nothing was changed",
  },
  "40001": {
    code: TENANT_OPS_ERROR_CODES.serializationFailure,
    message: "A serialization failure (SQLSTATE 40001) rolled the transaction back; nothing was changed",
  },
  "40P01": {
    code: TENANT_OPS_ERROR_CODES.deadlock,
    message: "A deadlock (SQLSTATE 40P01) rolled the transaction back; nothing was changed",
  },
});

const SQLSTATE = /^[0-9A-Z]{5}$/;
/** How deep `cause` (and `AggregateError.errors`) chains are followed. */
const MAX_DEPTH = 5;

function codeOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const code: unknown = (value as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : undefined;
}

/** The SQLSTATE of a PostgreSQL error (pg's `DatabaseError`: a five-character code and a `severity`). */
function sqlStateOf(value: unknown): string | undefined {
  const code = codeOf(value);
  const severity: unknown =
    typeof value === "object" && value !== null ? (value as { severity?: unknown }).severity : undefined;
  return code !== undefined && SQLSTATE.test(code) && typeof severity === "string" ? code : undefined;
}

/** `error`, then its causes and the errors of an `AggregateError`, breadth first, at most `MAX_DEPTH` levels. */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let level: unknown[] = [error];
  for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth += 1) {
    const next: unknown[] = [];
    for (const item of level) {
      if (item === undefined || item === null || chain.includes(item)) {
        continue;
      }
      chain.push(item);
      if (item instanceof AggregateError) {
        next.push(...(item.errors as unknown[]));
      }
      if (item instanceof Error && item.cause !== undefined) {
        next.push(item.cause);
      }
    }
    level = next;
  }
  return chain;
}

function isConnectionLoss(item: unknown): boolean {
  const sqlState = sqlStateOf(item);
  if (sqlState !== undefined) {
    return sqlState.startsWith("08") || CONNECTION_SQLSTATES.has(sqlState);
  }
  const code = codeOf(item);
  if (code !== undefined && CONNECTION_ERRNOS.has(code)) {
    return true;
  }
  return item instanceof Error && CONNECTION_MESSAGES.some((pattern) => pattern.test(item.message));
}

/** The transient failure somewhere in `error`'s chain, with its code and message; `undefined` when there is none. */
function transientFailure(error: unknown): TenantJobError | undefined {
  const chain = errorChain(error);
  if (chain.some(isConnectionLoss)) {
    return {
      code: TENANT_OPS_ERROR_CODES.connectionLost,
      message: "The database connection was lost or refused; the transaction was rolled back",
    };
  }
  for (const item of chain) {
    const sqlState =
      sqlStateOf(item) ?? (item instanceof TenantMigrationFailedError ? item.failure.code : undefined);
    const transient = sqlState === undefined ? undefined : TRANSIENT_SQLSTATES[sqlState];
    if (transient !== undefined) {
      return transient;
    }
  }
  return undefined;
}

/** `0001_baseline` for `0001_baseline.sql`: the ledger id of a file name, as the events name a migration. */
export function migrationVersion(file: string): string {
  return file.endsWith(".sql") ? file.slice(0, -".sql".length) : file;
}

/** The longest `error.message` the event schemas accept. */
export const MAX_ERROR_MESSAGE_LENGTH = 1000;

/** `message` shortened to what the event schemas accept (a long list of changed files, for example). */
function capped(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`
    : message;
}

/**
 * The `error {code, message}` of a failure event, its message shortened to what the event schemas accept. The
 * provisioning service builds the failures it decides itself with it too: a message that quotes the job's
 * `targetVersion` (a pattern without a length limit) must still make a valid event.
 */
export function jobError(code: string, message: string): TenantJobError {
  return Object.freeze({ code, message: capped(message) });
}

function classified(
  error: TenantJobError,
  retryable: boolean,
  version: string | null = null,
  step?: OtaProvisioningStep,
): ClassifiedFailure {
  return Object.freeze({
    error: jobError(error.code, error.message),
    retryable,
    version,
    step,
  });
}

/** A file that failed for a reason a retry does not change: its name, SQLSTATE and line, never PostgreSQL's text. */
function migrationFailed(error: TenantMigrationFailedError): ClassifiedFailure {
  const { code, line, statement } = error.failure;
  const where = [
    code === undefined ? undefined : `SQLSTATE ${code}`,
    line === undefined ? undefined : `line ${line}`,
    statement === undefined ? undefined : `statement ${statement}`,
  ].filter((part) => part !== undefined);
  return classified(
    {
      code: TENANT_OPS_ERROR_CODES.migrationFailed,
      message:
        `The tenant migration ${error.file} failed${where.length > 0 ? ` (${where.join(", ")})` : ""}: its ` +
        "transaction was rolled back and nothing of it is recorded; fix it forward with a new numbered file",
    },
    false,
    migrationVersion(error.file),
    "run_migrations",
  );
}

/** The class name of an unknown error, for the message (never its own message). */
function nameOf(error: unknown): string {
  if (error instanceof Error) {
    return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
  }
  return error === null ? "null" : typeof error;
}

/**
 * Classifies a failure of a provisioning or migration run (the table of the file header). `error` is what the run
 * threw: an error of `@velexis/db`, of `pg`, of Node's network stack, or anything else.
 */
export function classifyFailure(error: unknown): ClassifiedFailure {
  const transient = transientFailure(error);
  if (transient !== undefined) {
    return classified(
      transient,
      true,
      error instanceof TenantMigrationFailedError ? migrationVersion(error.file) : null,
    );
  }
  if (error instanceof TenantChecksumMismatchError) {
    const files = error.files.join(", ");
    return classified(
      {
        code: TENANT_OPS_ERROR_CODES.checksumMismatch,
        message:
          `${error.files.length} applied tenant migration file(s) changed since they were applied: ${files}. ` +
          "Nothing was applied; restore the merged files and fix forward with a new numbered file",
      },
      false,
      error.files[0] === undefined ? null : migrationVersion(error.files[0]),
      "run_migrations",
    );
  }
  if (error instanceof TenantSchemaError) {
    switch (error.problem) {
      case "foreign_owner":
        return classified(
          {
            code: TENANT_OPS_ERROR_CODES.foreignOwner,
            message: "The tenant schema belongs to another role than velexis_provisioner; it is left alone",
          },
          false,
          null,
          "create_schema",
        );
      case "foreign_content":
        return classified(
          {
            code: TENANT_OPS_ERROR_CODES.foreignContent,
            message:
              "The tenant schema holds relations but no schema_migrations ledger (foreign content); it is left " +
              "alone and never dropped",
          },
          false,
          null,
          "create_schema",
        );
      case "missing":
        return classified(
          {
            code: TENANT_OPS_ERROR_CODES.schemaMissing,
            message: "The tenant schema does not exist; tenant.provision creates it",
          },
          false,
          null,
          "create_schema",
        );
    }
  }
  if (error instanceof InvalidTenantSchemaError) {
    return classified(
      {
        code: TENANT_OPS_ERROR_CODES.invalidSchemaName,
        message:
          "The tenant's schema_name in platform.tenants is not a valid tenant schema name " +
          "(^tenant_[a-z][a-z0-9_]{1,39}$); no tenant SQL was run",
      },
      false,
    );
  }
  if (error instanceof TenantMigrationFailedError) {
    return migrationFailed(error);
  }
  if (error instanceof MigrationFilesError) {
    return classified(
      {
        code: TENANT_OPS_ERROR_CODES.invalidMigrationFiles,
        message: `The tenant migrations folder of this release is invalid (${error.problems.length} problem(s)); nothing was applied`,
      },
      false,
    );
  }
  if (error instanceof UnexpectedPlatformValueError) {
    return classified(
      {
        code: TENANT_OPS_ERROR_CODES.unexpectedPlatformValue,
        message: `${error.column} of the tenant holds a value this release of the OTA backend does not know`,
      },
      false,
    );
  }
  const sqlState = sqlStateOf(error);
  return classified(
    {
      code: sqlState ?? TENANT_OPS_ERROR_CODES.unexpected,
      message:
        `An unexpected ${nameOf(error)}${sqlState === undefined ? "" : ` (SQLSTATE ${sqlState})`} ended the run; ` +
        "another attempt may succeed",
    },
    true,
  );
}
