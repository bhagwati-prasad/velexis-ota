// Migration file discovery and the CLI paths that need no database (X-011).
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MIGRATE_USAGE, runMigrateCli } from "../cli/migrate.js";
import {
  BASELINE_FILE,
  checksumMismatches,
  ChecksumMismatchError,
  ledgerIdsWithoutFile,
  MIGRATE_EXIT_CODES,
  MigrationFilesError,
  pendingNumberedFiles,
  readMigrationFiles,
  runMigrations,
  type LedgerRow,
  type MigrationFile,
  type MigrationFileEvent,
  type MigrationSet,
} from "./index.js";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** A fresh folder with `files` (name → content, a string or raw bytes). */
async function folder(files: Record<string, string | Uint8Array> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "velexis-migrate-files-"));
  roots.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

const expand = (description: string, body: string): string =>
  `-- velexis:phase expand\n-- ${description}\n${body}\n`;

/** The problems of a folder that `readMigrationFiles` rejects. */
async function problemsOf(dir: string, set: MigrationSet = "platform"): Promise<string[]> {
  const error = await readMigrationFiles(dir, set).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(MigrationFilesError);
  const filesError = error as MigrationFilesError;
  expect(filesError.exitCode).toBe(MIGRATE_EXIT_CODES.error);
  return filesError.problems.map(({ file, reason }) => `${file}: ${reason}`);
}

class Buffered {
  text = "";
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

describe("readMigrationFiles", () => {
  it("sorts numbered files by number, keeps repeatable files apart and ignores other files", async () => {
    const dir = await folder({
      "0010_add_index.sql": expand("Add an index", "CREATE INDEX i ON platform.t (a);"),
      "0002_add_column.sql": "-- velexis:phase migrate\n-- Add a column\nALTER TABLE platform.t ADD b int;\n",
      [BASELINE_FILE]: "CREATE TABLE platform.t (a int);\n",
      "R__ota_read_access.sql": "-- Grants\nGRANT SELECT ON platform.t TO velexis_ota_app;\n",
      "README.md": "# not a migration\n",
      ".gitkeep": "",
    });
    const files = await readMigrationFiles(dir, "platform");
    expect(files.exists).toBe(true);
    expect(files.set).toBe("platform");
    expect(files.numbered.map((file) => file.file)).toEqual([
      "0001_baseline.sql",
      "0002_add_column.sql",
      "0010_add_index.sql",
    ]);
    expect(files.numbered.map((file) => file.id)).toEqual([
      "0001_baseline",
      "0002_add_column",
      "0010_add_index",
    ]);
    expect(files.numbered.map((file) => file.phase)).toEqual(["expand", "migrate", "expand"]);
    expect(files.numbered.every((file) => file.kind === "numbered")).toBe(true);
    expect(files.repeatable).toHaveLength(1);
    expect(files.repeatable[0]).toMatchObject({
      kind: "repeatable",
      file: "R__ota_read_access.sql",
      id: "R__ota_read_access",
      phase: "repeatable",
      noTransaction: false,
      description: "Grants",
    });
    expect(files.numbered[2]?.path).toBe(join(dir, "0010_add_index.sql"));
  });

  it("computes the SHA-256 over the raw bytes, line endings and all", async () => {
    const crlf = Buffer.from("-- velexis:phase expand\r\n-- Café\r\nSELECT 1;\r\n", "utf8");
    const lf = Buffer.from("-- velexis:phase expand\n-- Café\nSELECT 1;\n", "utf8");
    const dir = await folder({ "0001_crlf.sql": crlf, "0002_lf.sql": lf });
    const [first, second] = (await readMigrationFiles(dir, "reference")).numbered;
    expect(first?.checksum).toBe(createHash("sha256").update(crlf).digest("hex"));
    expect(second?.checksum).toBe(createHash("sha256").update(lf).digest("hex"));
    expect(first?.checksum).not.toBe(second?.checksum);
    expect(first?.description).toBe("Café");
    expect(first?.sql).toBe(crlf.toString("utf8"));
  });

  it("accepts the baseline without headers as phase expand and describes it by its first comment line", async () => {
    const baseline =
      "-- ==========\n-- Velexis OTA platform - CONTROL PLANE schema `platform`\n-- ==========\n\nCREATE SCHEMA IF NOT EXISTS platform;\n";
    const dir = await folder({ [BASELINE_FILE]: baseline });
    const [file] = (await readMigrationFiles(dir, "platform")).numbered;
    expect(file).toMatchObject({
      id: "0001_baseline",
      phase: "expand",
      noTransaction: false,
      description: "Velexis OTA platform - CONTROL PLANE schema `platform`",
    });
  });

  it("falls back to the words of the file name when a file has no description line", async () => {
    const dir = await folder({
      [BASELINE_FILE]: "CREATE TABLE platform.t (a int);\n",
      "0002_add_tenant_flags.sql": "-- velexis:phase contract\nALTER TABLE platform.t DROP COLUMN a;\n",
    });
    const files = await readMigrationFiles(dir, "platform");
    expect(files.numbered.map((file) => file.description)).toEqual(["baseline", "add tenant flags"]);
    expect(files.numbered[1]?.phase).toBe("contract");
  });

  it("requires the phase header on every numbered file except 0001_baseline.sql", async () => {
    const dir = await folder({
      "0001_create_t.sql": "-- Create t\nCREATE TABLE platform.t (a int);\n",
      "0002_add_b.sql": "ALTER TABLE platform.t ADD b int;\n",
    });
    expect(await problemsOf(dir)).toEqual([
      expect.stringMatching(
        /^0001_create_t\.sql: needs the header "-- velexis:phase expand\|migrate\|contract"/,
      ),
      expect.stringMatching(/^0002_add_b\.sql: needs the header/),
    ]);
  });

  it("rejects an unknown phase, a second phase header and an unknown directive", async () => {
    const dir = await folder({
      "0001_a.sql": "-- velexis:phase expanded\nSELECT 1;\n",
      "0002_b.sql": "-- velexis:phase expand\n-- velexis:phase contract\nSELECT 1;\n",
      "0003_c.sql": "-- velexis:phase expand\n-- velexis:no-transation\nSELECT 1;\n",
    });
    expect(await problemsOf(dir)).toEqual([
      expect.stringMatching(/^0001_a\.sql: invalid phase header "-- velexis:phase expanded"/),
      expect.stringMatching(/^0002_b\.sql: more than one -- velexis:phase header/),
      expect.stringMatching(/^0003_c\.sql: unknown directive "-- velexis:no-transation"/),
    ]);
  });

  it("recognises -- velexis:no-transaction and splits such a file into its statements", async () => {
    const dir = await folder({
      "0002_index_items.sql":
        "-- velexis:phase expand\n-- velexis:no-transaction\n-- Index the items\n" +
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS items_a ON platform.items (a);\n" +
        "-- the second one\nCREATE INDEX CONCURRENTLY IF NOT EXISTS items_b ON platform.items (b);\n",
      "0003_plain.sql": expand("Plain", "SELECT 1;"),
    });
    const [index, plain] = (await readMigrationFiles(dir, "platform")).numbered;
    expect(index).toMatchObject({ noTransaction: true, phase: "expand", description: "Index the items" });
    expect(index?.statements).toEqual([
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS items_a ON platform.items (a)",
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS items_b ON platform.items (b)",
    ]);
    expect(plain).toMatchObject({ noTransaction: false, statements: [] });
  });

  it("reads directives only in the leading comment block", async () => {
    const dir = await folder({
      "0001_a.sql": "\n-- velexis:phase expand\n\n-- A\nSELECT 1;\n-- velexis:no-transaction\n",
    });
    const [file] = (await readMigrationFiles(dir, "platform")).numbered;
    expect(file).toMatchObject({ phase: "expand", noTransaction: false, description: "A" });
  });

  it("fails on a duplicated number", async () => {
    const dir = await folder({
      "0002_add_a.sql": expand("A", "SELECT 1;"),
      "0002_add_b.sql": expand("B", "SELECT 2;"),
      "0003_add_c.sql": expand("C", "SELECT 3;"),
    });
    expect(await problemsOf(dir)).toEqual([
      expect.stringMatching(/^0002_add_a\.sql, 0002_add_b\.sql: duplicated number 0002/),
    ]);
  });

  it("rejects .sql files whose name matches neither pattern", async () => {
    const dir = await folder({
      "2_short.sql": expand("A", "SELECT 1;"),
      "0002_Upper.sql": expand("A", "SELECT 1;"),
      "0003-dash.sql": expand("A", "SELECT 1;"),
      "0004_shout.SQL": expand("A", "SELECT 1;"),
      "r__lower.sql": "GRANT SELECT ON platform.t TO velexis_ota_app;\n",
      "00005_five.sql": expand("A", "SELECT 1;"),
    });
    const problems = await problemsOf(dir);
    expect(problems).toHaveLength(6);
    for (const problem of problems) {
      expect(problem).toMatch(/: is not a migration file name: numbered files match/);
    }
  });

  it("allows repeatable files in the platform and reference sets only", async () => {
    const files = { "R__grants.sql": "GRANT SELECT ON platform.t TO velexis_ota_app;\n" };
    expect((await readMigrationFiles(await folder(files), "platform")).repeatable).toHaveLength(1);
    expect((await readMigrationFiles(await folder(files), "reference")).repeatable).toHaveLength(1);
    expect(await problemsOf(await folder(files), "tenant")).toEqual([
      "R__grants.sql: repeatable files are allowed in the platform and reference sets only (ADR-0021)",
    ]);
  });

  it("rejects a repeatable file with CREATE TABLE, a phase header or no-transaction", async () => {
    const dir = await folder({
      "R__a_table.sql":
        "-- Grants\nGRANT SELECT ON platform.t TO velexis_ota_app;\nCREATE TABLE platform.x (a int);\n",
      "R__b_phase.sql": "-- velexis:phase expand\nGRANT SELECT ON platform.t TO velexis_ota_app;\n",
      "R__c_notx.sql": "-- velexis:no-transaction\nGRANT SELECT ON platform.t TO velexis_ota_app;\n",
    });
    expect(await problemsOf(dir)).toEqual([
      expect.stringMatching(
        /^R__a_table\.sql: statement 2 starts with "CREATE TABLE": a repeatable file may contain only GRANT, REVOKE and COMMENT ON/,
      ),
      expect.stringMatching(/^R__b_phase\.sql: takes no -- velexis:phase header/),
      expect.stringMatching(/^R__c_notx\.sql: a repeatable file always runs in a transaction/),
    ]);
  });

  it("rejects transaction control in a numbered file, but allows savepoints", async () => {
    const dir = await folder({
      "0001_a.sql": expand("A", "BEGIN;\nCREATE TABLE platform.a (x int);\nCOMMIT;"),
      "0002_b.sql": expand("B", "SAVEPOINT s;\nCREATE TABLE platform.b (x int);\nROLLBACK TO SAVEPOINT s;"),
    });
    expect(await problemsOf(dir)).toEqual([
      expect.stringMatching(/^0001_a\.sql: statement 1 \("BEGIN"\) is transaction control/),
      expect.stringMatching(/^0001_a\.sql: statement 3 \("COMMIT"\) is transaction control/),
    ]);
  });

  it("rejects invalid UTF-8, a byte order mark and SQL that cannot be split", async () => {
    const dir = await folder({
      "0001_latin1.sql": Buffer.from([0x2d, 0x2d, 0x20, 0xe9, 0x0a]),
      "0002_bom.sql": `\uFEFF${expand("A", "SELECT 1;")}`,
      "0003_open.sql": expand("A", "SELECT 'unterminated;"),
    });
    expect(await problemsOf(dir)).toEqual([
      "0001_latin1.sql: is not valid UTF-8",
      "0002_bom.sql: starts with a byte order mark; save it as UTF-8 without BOM",
      expect.stringMatching(
        /^0003_open\.sql: cannot be split into statements: unterminated string literal starting on line 3/,
      ),
    ]);
  });

  it("reports every problem of the folder at once, with the folder in the message", async () => {
    const dir = await folder({
      "0001_a.sql": "SELECT 1;\n",
      "R__b.sql": "DROP TABLE platform.t;\n",
      "x.sql": "SELECT 1;\n",
    });
    const error = await readMigrationFiles(dir, "platform").catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(MigrationFilesError);
    const { message, problems } = error as MigrationFilesError;
    expect(problems.map(({ file }) => file)).toEqual(["0001_a.sql", "R__b.sql", "x.sql"]);
    expect(message).toContain(`Invalid platform migrations in ${dir} (3 problems); nothing was applied:`);
  });

  it("treats a folder that does not exist as an empty set", async () => {
    const missing = join(await folder(), "not-created-yet");
    const files = await readMigrationFiles(missing, "platform");
    expect(files).toEqual({ set: "platform", dir: missing, exists: false, numbered: [], repeatable: [] });
  });

  it("rejects a --dir that is a file", async () => {
    const dir = await folder({ "0001_a.sql": expand("A", "SELECT 1;") });
    expect(await problemsOf(join(dir, "0001_a.sql"))).toEqual([
      `${join(dir, "0001_a.sql")}: is not a folder`,
    ]);
  });

  it("treats an existing empty folder as an existing set without files", async () => {
    const files = await readMigrationFiles(await folder(), "reference");
    expect(files).toMatchObject({ exists: true, numbered: [], repeatable: [] });
  });
});

describe("ledger comparisons", () => {
  const file = (id: string, checksum: string, kind: MigrationFile["kind"] = "numbered"): MigrationFile => ({
    kind,
    file: `${id}.sql`,
    id,
    path: `/m/${id}.sql`,
    phase: kind === "numbered" ? "expand" : "repeatable",
    noTransaction: false,
    description: id,
    checksum,
    sql: "",
    statements: [],
  });
  const row = (
    id: string,
    checksum: string,
    status: LedgerRow["status"] = "applied",
  ): [string, LedgerRow] => [id, { id, checksum, phase: "expand", status }];

  it("finds applied numbered files whose checksum changed, and the pending ones", () => {
    const files = [file("0001_a", "aa"), file("0002_b", "bb"), file("0003_c", "cc"), file("0004_d", "dd")];
    const ledger = new Map([
      row("0001_a", "aa"),
      row("0002_b", "XX"),
      row("0003_c", "cc", "failed"),
      row("0099_z", "zz"),
    ]);
    expect(checksumMismatches(files, ledger)).toEqual([{ file: files[1], appliedChecksum: "XX" }]);
    expect(pendingNumberedFiles(files, ledger).map(({ id }) => id)).toEqual(["0003_c", "0004_d"]);
    expect(ledgerIdsWithoutFile(files, ledger)).toEqual(["0099_z"]);
  });

  it("never reports a repeatable file as a checksum mismatch", () => {
    const files = [file("R__grants", "new", "repeatable")];
    expect(checksumMismatches(files, new Map([row("R__grants", "old")]))).toEqual([]);
  });
});

describe("migrate.js without a database", () => {
  let stdout: Buffered;
  let stderr: Buffered;
  beforeEach(() => {
    stdout = new Buffered();
    stderr = new Buffered();
  });

  it("prints a notice on stderr, applies nothing and exits 0 for a --dir that does not exist [X-011 AC7]", async () => {
    const missing = join(await folder(), "platform");
    const run = vi.fn(runMigrations);
    // No DATABASE_MIGRATOR_URL at all: a missing folder needs neither the configuration nor a connection.
    const code = await runMigrateCli(["platform", "--dir", missing], {
      stdout,
      stderr,
      env: { APP_ENV: "production" },
      runMigrations: run,
    });
    expect(code).toBe(0);
    expect(stderr.text).toBe(
      `migrate: notice: the platform migrations folder ${missing} does not exist; it is an empty set and nothing was applied\n`,
    );
    expect(stdout.text).toBe("");
    expect(run).not.toHaveBeenCalled();
  });

  it("resolves a relative --dir against the current folder [X-011 AC7]", async () => {
    const cwd = await folder();
    const code = await runMigrateCli(["reference", "--dir", "../migrations/reference"], {
      stdout,
      stderr,
      cwd,
      env: { APP_ENV: "production" },
    });
    expect(code).toBe(0);
    expect(stderr.text).toContain(`folder ${join(cwd, "..", "migrations", "reference")} does not exist`);
    expect(stdout.text).toBe("");
  });

  it("returns from runMigrations without connecting when the folder does not exist [X-011 AC7]", async () => {
    const missing = join(await folder(), "platform");
    // Port 1 refuses every connection: any attempt to connect would reject.
    const result = await runMigrations({
      set: "platform",
      dir: missing,
      url: "postgres://nobody@127.0.0.1:1/none",
    });
    expect(result).toEqual({
      set: "platform",
      dir: missing,
      dirExists: false,
      applied: [],
      upToDate: 0,
      ledgerOnly: [],
    });
  });

  it("rejects --url: the DSN comes from DATABASE_MIGRATOR_URL only", async () => {
    for (const argv of [
      ["platform", "--dir", ".", "--url", "postgres://x@h/db"],
      ["platform", "--url=postgres://x@h/db", "--dir", "."],
    ]) {
      const err = new Buffered();
      expect(await runMigrateCli(argv, { stdout, stderr: err })).toBe(1);
      expect(err.text).toContain("there is no --url flag: the DSN comes from DATABASE_MIGRATOR_URL only");
      expect(err.text).not.toContain("postgres://");
    }
  });

  it("prints the usage and exits 1 for a missing or unknown command, a missing --dir or an unknown flag", async () => {
    const cases: Array<[string[], string]> = [
      [[], "missing command"],
      // `tenants` and `tenant` exist since X-013 (src/migrate/tenants.test.ts); `seed` is not a command.
      [["seed", "--dir", "."], 'unknown command "seed"'],
      [["platform"], "platform needs --dir <path>"],
      [["platform", "--dir", ".", "extra"], 'unexpected argument "extra"'],
      [["platform", "--dir", ".", "--force"], "Unknown option '--force'"],
    ];
    for (const [argv, message] of cases) {
      const err = new Buffered();
      expect(await runMigrateCli(argv, { stdout, stderr: err })).toBe(1);
      expect(err.text).toContain(`migrate: ${message}`);
      expect(err.text).toContain(MIGRATE_USAGE);
    }
    expect(stdout.text).toBe("");
  });

  it("prints the usage on stdout with --help and exits 0", async () => {
    expect(await runMigrateCli(["--help"], { stdout, stderr })).toBe(0);
    expect(stdout.text).toBe(MIGRATE_USAGE);
    expect(MIGRATE_USAGE).toMatch(
      /Exit codes: 0 success, 1 error, 2 checksum mismatch of an applied file, 3 tenant/,
    );
  });

  it("exits 1 before reading the configuration when the folder holds invalid files", async () => {
    const dir = await folder({ "0001_a.sql": "SELECT 1;\n" });
    const run = vi.fn(runMigrations);
    const code = await runMigrateCli(["platform", "--dir", dir], {
      stdout,
      stderr,
      env: { APP_ENV: "production" },
      runMigrations: run,
    });
    expect(code).toBe(1);
    expect(stderr.text).toContain("0001_a.sql: needs the header");
    expect(stderr.text).not.toContain("DATABASE_MIGRATOR_URL");
    expect(run).not.toHaveBeenCalled();
  });

  it("exits 1 and names DATABASE_MIGRATOR_URL when it is missing or not a postgres URL", async () => {
    const dir = await folder({ [BASELINE_FILE]: "SELECT 1;\n" });
    const run = vi.fn(runMigrations);
    for (const env of [
      { APP_ENV: "production" },
      { APP_ENV: "production", DATABASE_MIGRATOR_URL: "mysql://user:s3cret-value@host/db" },
    ]) {
      const err = new Buffered();
      expect(
        await runMigrateCli(["platform", "--dir", dir], { stdout, stderr: err, env, runMigrations: run }),
      ).toBe(1);
      expect(err.text).toContain("DATABASE_MIGRATOR_URL");
      expect(err.text).not.toContain("s3cret-value");
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("passes DATABASE_MIGRATOR_URL to the runner, prints one JSON line per file and maps the error's exit code", async () => {
    const dir = await folder({ [BASELINE_FILE]: "SELECT 1;\n" });
    const url = "postgres://velexis_migrator:dev_migrator@127.0.0.1:5432/velexis";
    const changed: MigrationFileEvent = {
      set: "platform",
      file: BASELINE_FILE,
      id: "0001_baseline",
      kind: "numbered",
      phase: "expand",
      status: "checksum_mismatch",
      checksum: "b".repeat(64),
      transaction: true,
      appliedChecksum: "a".repeat(64),
    };
    const run = vi.fn<typeof runMigrations>((options) => {
      options.onFile?.(changed);
      return Promise.reject(new ChecksumMismatchError("platform", [BASELINE_FILE]));
    });
    const code = await runMigrateCli(["platform", "--dir", dir], {
      stdout,
      stderr,
      env: { APP_ENV: "production", DATABASE_MIGRATOR_URL: url },
      runMigrations: run,
    });
    expect(code).toBe(MIGRATE_EXIT_CODES.checksumMismatch);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ set: "platform", dir, url }));
    expect(stdout.text).toBe(`${JSON.stringify(changed)}\n`);
    expect(stderr.text).toMatch(
      /^migrate: 1 applied platform migration file\(s\) changed since they were applied: 0001_baseline\.sql\./,
    );
    expect(stderr.text).not.toContain("dev_migrator");
  });

  it("exits 1 with a readable message when the database refuses the connection", async () => {
    const dir = await folder({ [BASELINE_FILE]: "SELECT 1;\n" });
    const refused = Object.assign(new AggregateError([new Error("connect ECONNREFUSED 127.0.0.1:1")], ""), {
      code: "ECONNREFUSED",
    });
    const code = await runMigrateCli(["platform", "--dir", dir], {
      stdout,
      stderr,
      env: {
        APP_ENV: "production",
        DATABASE_MIGRATOR_URL: "postgres://velexis_migrator:pw-value@127.0.0.1:1/db",
      },
      runMigrations: () => Promise.reject(refused),
    });
    expect(code).toBe(1);
    expect(stderr.text).toBe("migrate: connect ECONNREFUSED 127.0.0.1:1\n");
  });

  it("prints a notice for ledger rows without a file and exits 0", async () => {
    const dir = await folder({ [BASELINE_FILE]: "SELECT 1;\n" });
    const run = vi.fn<typeof runMigrations>(() =>
      Promise.resolve({
        set: "reference",
        dir,
        dirExists: true,
        applied: [],
        upToDate: 1,
        ledgerOnly: ["0002_newer"],
      }),
    );
    const code = await runMigrateCli(["reference", "--dir", dir], {
      stdout,
      stderr,
      env: { APP_ENV: "production", DATABASE_MIGRATOR_URL: "postgres://u@127.0.0.1/db" },
      runMigrations: run,
    });
    expect(code).toBe(0);
    expect(stdout.text).toBe("");
    expect(stderr.text).toBe(
      `migrate: notice: reference.schema_migrations has 0002_newer, which is not in ${dir} (applied by another release)\n`,
    );
  });
});
