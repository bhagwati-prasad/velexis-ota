// The classification of `ota-tenant-ops` failures (OBE-006; OADR-0007 item 6, tenant provisioning flow §5) without a
// database: the errors are built as `pg`, Node and `@velexis/db` throw them. What the worker does with each class is
// tested in provisioning.service.test.ts (processor) and test/integration/provisioning/migrate.int.test.ts.
import provisionFixture from "@velexis/api-types/fixtures/jobs/tenant-provision.json";
import { validateJob } from "@velexis/api-types/jobs";
import { InvalidTenantSchemaError } from "@velexis/db";
import {
  MigrationFilesError,
  TenantChecksumMismatchError,
  TenantMigrationFailedError,
  TenantSchemaError,
  type MigrationFile,
} from "@velexis/db/migrate";
import { describe, expect, it } from "vitest";
import { UnexpectedPlatformValueError } from "../tenancy/platform-read.types";
import {
  classifyFailure,
  MAX_ERROR_MESSAGE_LENGTH,
  migrationVersion,
  TENANT_OPS_ERROR_CODES,
  type ClassifiedFailure,
} from "./failure-classifier";

/** An error as `pg` reports a server error: a `DatabaseError` (name `error`) with the SQLSTATE and a severity. */
function pgError(code: string, message: string, severity = "ERROR"): Error {
  return Object.assign(new Error(message), { name: "error", code, severity, detail: "Key (id)=(secret-1)" });
}

/** An error of Node's network stack. */
function systemError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, errno: -1, syscall: "connect" });
}

/** A tenant migration file, as `readMigrationFiles` returns it. */
function migrationFile(file: string, noTransaction = false): MigrationFile {
  const sql = "CREATE TABLE loyalty_cards (id text PRIMARY KEY, secret_note text DEFAULT 'do-not-leak');\n";
  return {
    kind: "numbered",
    file,
    id: migrationVersion(file),
    path: `/srv/velexis/releases/abc/migrations/tenant/${file}`,
    phase: "expand",
    noTransaction,
    description: "Add loyalty cards",
    checksum: "0".repeat(64),
    sql,
    statements: noTransaction ? [sql.trim()] : [],
  };
}

/** A failing file as the runner throws it: PostgreSQL's message, SQLSTATE and line, and the error as `cause`. */
function fileFailure(file: string, cause: Error, line?: number): TenantMigrationFailedError {
  const code = (cause as { code?: string }).code;
  return new TenantMigrationFailedError(
    "tenant_acme",
    migrationFile(file),
    {
      message: cause.message,
      ...(code === undefined ? {} : { code }),
      ...(line === undefined ? {} : { line }),
    },
    cause,
  );
}

/** The failure as both failure events carry it; validating them proves the code and message fit the contract. */
function expectValidEvents(failure: ClassifiedFailure): void {
  const envelope = { ...provisionFixture };
  expect(() =>
    validateJob("tenant.provision_failed", {
      ...envelope,
      name: "tenant.provision_failed",
      payload: { error: failure.error, retryable: failure.retryable, steps: [] },
    }),
  ).not.toThrow();
  expect(() =>
    validateJob("tenant.migration_failed", {
      ...envelope,
      name: "tenant.migration_failed",
      payload: { version: failure.version, error: failure.error, retryable: failure.retryable },
    }),
  ).not.toThrow();
}

describe("classifyFailure: retryable failures", () => {
  it("classifies a lock timeout as LOCK_TIMEOUT, retryable [OBE-006 AC1]", () => {
    const failure = classifyFailure(pgError("55P03", "canceling statement due to lock timeout"));

    expect(failure).toEqual({
      error: {
        code: "LOCK_TIMEOUT",
        message:
          "Waiting for a lock timed out (SQLSTATE 55P03): another run may hold the tenant schema's advisory lock; " +
          "nothing was changed",
      },
      retryable: true,
      version: null,
      step: undefined,
    });
    expectValidEvents(failure);
  });

  it("classifies serialization failures and deadlocks as retryable", () => {
    expect(classifyFailure(pgError("40001", "could not serialize access"))).toMatchObject({
      error: { code: "SERIALIZATION_FAILURE" },
      retryable: true,
    });
    expect(classifyFailure(pgError("40P01", "deadlock detected"))).toMatchObject({
      error: { code: "DEADLOCK" },
      retryable: true,
    });
  });

  it("classifies a lost or refused connection as CONNECTION_LOST, retryable, however it is reported", () => {
    const lost = [
      pgError("57P01", "terminating connection due to administrator command", "FATAL"),
      pgError("57P03", "the database system is starting up", "FATAL"),
      pgError("08006", "connection failure", "FATAL"),
      pgError("53300", "sorry, too many clients already", "FATAL"),
      systemError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432"),
      systemError("ECONNRESET", "read ECONNRESET"),
      new AggregateError([systemError("ECONNREFUSED", "connect ECONNREFUSED ::1:5432")], "connect failed"),
      new Error("Connection terminated unexpectedly"),
      new Error("Client has encountered a connection error and is not queryable"),
      new Error("timeout exceeded when trying to connect"),
      new Error("wrapped", { cause: new Error("Connection terminated due to connection timeout") }),
    ];

    for (const error of lost) {
      expect(classifyFailure(error)).toEqual({
        error: {
          code: "CONNECTION_LOST",
          message: "The database connection was lost or refused; the transaction was rolled back",
        },
        retryable: true,
        version: null,
        step: undefined,
      });
    }
  });

  it("keeps a transient failure inside a migration file retryable, naming the file as the version", () => {
    const failure = classifyFailure(
      fileFailure(
        "0002_add_loyalty_cards.sql",
        pgError("55P03", "canceling statement due to lock timeout"),
        3,
      ),
    );

    expect(failure).toMatchObject({
      error: { code: "LOCK_TIMEOUT" },
      retryable: true,
      version: "0002_add_loyalty_cards",
    });
    expect(
      classifyFailure(
        fileFailure("0002_add_loyalty_cards.sql", new Error("Connection terminated unexpectedly")),
      ),
    ).toMatchObject({
      error: { code: "CONNECTION_LOST" },
      retryable: true,
      version: "0002_add_loyalty_cards",
    });
  });

  it("treats an error it does not know as retryable, by its SQLSTATE or as UNEXPECTED_ERROR, without its text", () => {
    const unknownDatabaseError = classifyFailure(
      pgError("23505", 'duplicate key value violates unique constraint "x" for "secret-1"'),
    );
    const bug = classifyFailure(new TypeError("Cannot read properties of undefined (reading 'secret-2')"));
    const thrownString = classifyFailure("secret-3");

    expect(unknownDatabaseError).toEqual({
      error: {
        code: "23505",
        message: "An unexpected error (SQLSTATE 23505) ended the run; another attempt may succeed",
      },
      retryable: true,
      version: null,
      step: undefined,
    });
    expect(bug.error).toEqual({
      code: "UNEXPECTED_ERROR",
      message: "An unexpected TypeError ended the run; another attempt may succeed",
    });
    expect(bug.retryable).toBe(true);
    expect(thrownString.error.message).toBe(
      "An unexpected string ended the run; another attempt may succeed",
    );
    for (const failure of [unknownDatabaseError, bug, thrownString]) {
      expect(JSON.stringify(failure)).not.toMatch(/secret-/);
      expectValidEvents(failure);
    }
  });

  it("does not take a five-letter Node error code for a SQLSTATE", () => {
    expect(classifyFailure(systemError("EPIPE", "write EPIPE"))).toMatchObject({
      error: { code: "CONNECTION_LOST" },
    });
    expect(classifyFailure(Object.assign(new Error("x"), { code: "EPERM" }))).toMatchObject({
      error: { code: "UNEXPECTED_ERROR" },
      retryable: true,
    });
  });
});

describe("classifyFailure: failures that are not retried", () => {
  it("classifies an edited, already applied file as CHECKSUM_MISMATCH, not retryable, with the first changed file [OBE-006 AC2]", () => {
    const failure = classifyFailure(
      new TenantChecksumMismatchError("tenant_acme", ["0001_baseline.sql", "0002_add_loyalty_cards.sql"]),
    );

    expect(failure).toEqual({
      error: {
        code: "CHECKSUM_MISMATCH",
        message:
          "2 applied tenant migration file(s) changed since they were applied: 0001_baseline.sql, " +
          "0002_add_loyalty_cards.sql. Nothing was applied; restore the merged files and fix forward with a new " +
          "numbered file",
      },
      retryable: false,
      version: "0001_baseline",
      step: "run_migrations",
    });
    expectValidEvents(failure);
  });

  it("classifies foreign and missing schemas, and a malformed schema name, as not retryable", () => {
    expect(classifyFailure(new TenantSchemaError("tenant_acme", "foreign_content", "1 relation"))).toEqual({
      error: {
        code: "FOREIGN_CONTENT",
        message:
          "The tenant schema holds relations but no schema_migrations ledger (foreign content); it is left alone " +
          "and never dropped",
      },
      retryable: false,
      version: null,
      step: "create_schema",
    });
    expect(
      classifyFailure(new TenantSchemaError("tenant_acme", "foreign_owner", "velexis_migrator")),
    ).toMatchObject({ error: { code: "FOREIGN_OWNER" }, retryable: false, step: "create_schema" });
    expect(classifyFailure(new TenantSchemaError("tenant_acme", "missing"))).toMatchObject({
      error: {
        code: "SCHEMA_MISSING",
        message: "The tenant schema does not exist; tenant.provision creates it",
      },
      retryable: false,
    });

    const invalidName = classifyFailure(new InvalidTenantSchemaError("tenant_x; DROP SCHEMA platform"));
    expect(invalidName).toMatchObject({ error: { code: "INVALID_SCHEMA_NAME" }, retryable: false });
    expect(invalidName.error.message).not.toContain("DROP");
    expectValidEvents(invalidName);
  });

  it("classifies a file that fails for another reason as MIGRATION_FAILED, without PostgreSQL's text or the SQL", () => {
    const failure = classifyFailure(
      fileFailure(
        "0002_add_loyalty_cards.sql",
        pgError("42601", "syntax error at or near \"'do-not-leak'\""),
        7,
      ),
    );

    expect(failure).toEqual({
      error: {
        code: "MIGRATION_FAILED",
        message:
          "The tenant migration 0002_add_loyalty_cards.sql failed (SQLSTATE 42601, line 7): its transaction was " +
          "rolled back and nothing of it is recorded; fix it forward with a new numbered file",
      },
      retryable: false,
      version: "0002_add_loyalty_cards",
      step: "run_migrations",
    });
    expect(JSON.stringify(failure)).not.toMatch(/do-not-leak|syntax error|CREATE TABLE|Key \(id\)/);
    expectValidEvents(failure);
  });

  it("classifies an invalid migrations folder and an unknown platform value as not retryable", () => {
    expect(
      classifyFailure(
        new MigrationFilesError("tenant", "/srv/velexis/releases/abc/migrations/tenant", [
          { file: "0002_a.sql", reason: "duplicated number 0002" },
          { file: "0002_b.sql", reason: "duplicated number 0002" },
        ]),
      ),
    ).toEqual({
      error: {
        code: "INVALID_MIGRATION_FILES",
        message:
          "The tenant migrations folder of this release is invalid (2 problem(s)); nothing was applied",
      },
      retryable: false,
      version: null,
      step: undefined,
    });
    const unknownStatus = classifyFailure(
      new UnexpectedPlatformValueError("platform.tenants.status", "ten_1", "archived", ["active"]),
    );
    expect(unknownStatus).toEqual({
      error: {
        code: "UNEXPECTED_PLATFORM_VALUE",
        message:
          "platform.tenants.status of the tenant holds a value this release of the OTA backend does not know",
      },
      retryable: false,
      version: null,
      step: undefined,
    });
  });

  it("shortens a message to what the event schemas accept", () => {
    const files = Array.from(
      { length: 60 },
      (_, index) => `${String(index + 1).padStart(4, "0")}_add_feature.sql`,
    );
    const failure = classifyFailure(new TenantChecksumMismatchError("tenant_acme", files));

    expect(failure.error.message).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
    expect(failure.error.message.endsWith("…")).toBe(true);
    expectValidEvents(failure);
  });
});

describe("the error codes", () => {
  it("all fit the event contract's code pattern", () => {
    for (const code of Object.values(TENANT_OPS_ERROR_CODES)) {
      expect(code).toMatch(/^[A-Z0-9][A-Z0-9_]{1,63}$/);
    }
    expect(migrationVersion("0001_baseline.sql")).toBe("0001_baseline");
    expect(migrationVersion("0001_baseline")).toBe("0001_baseline");
  });
});
