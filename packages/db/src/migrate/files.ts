// Migration file discovery (ADR-0005 Migrations, ADR-0021, conventions §9): numbered files NNNN_name.sql,
// repeatable files R__name.sql (platform and reference only), the `-- velexis:` header directives and the
// SHA-256 of the raw bytes. Every problem of a folder is collected and thrown at once, before any SQL runs.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { repeatableStatementProblems, splitSqlStatements, SqlSplitError } from "./repeatable.js";

/** The three migration sets: `platform` and `reference` (one schema each) and `tenant` (every tenant schema). */
export const MIGRATION_SETS = ["platform", "reference", "tenant"] as const;
export type MigrationSet = (typeof MIGRATION_SETS)[number];

/** The sets applied once per cluster by `runMigrations`, each to the schema of the same name. */
export const SHARED_MIGRATION_SETS = ["platform", "reference"] as const;
export type SharedMigrationSet = (typeof SHARED_MIGRATION_SETS)[number];

/** Phases of a numbered file, from its `-- velexis:phase` header (expand / migrate / contract rule). */
export const MIGRATION_PHASES = ["expand", "migrate", "contract"] as const;
export type MigrationPhase = (typeof MIGRATION_PHASES)[number];

/** The `phase` column of a ledger row: a numbered file's phase, or `repeatable` for an `R__` file. */
export type LedgerPhase = MigrationPhase | "repeatable";

export type MigrationKind = "numbered" | "repeatable";

/** `0001_baseline.sql`, `0002_add_tenant_flags.sql`: four digits, an underscore, a snake_case name. */
export const NUMBERED_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
/** `R__ota_read_access.sql`: idempotent GRANT / REVOKE / COMMENT ON statements (ADR-0021). */
export const REPEATABLE_FILE_PATTERN = /^R__[a-z0-9_]+\.sql$/;
/** The byte-for-byte copy of the reference DDL: no headers, phase `expand` (ADR-0005 Baselines). */
export const BASELINE_FILE = "0001_baseline.sql";

/**
 * Exit codes of `migrate.js` (ADR-0021): `0` success, `1` error, `2` checksum mismatch of an applied file,
 * `3` tenant failure ratio exceeded (tenant fan-out).
 */
export const MIGRATE_EXIT_CODES = Object.freeze({
  ok: 0,
  error: 1,
  checksumMismatch: 2,
  failureRatioExceeded: 3,
} as const);
export type MigrateExitCode = (typeof MIGRATE_EXIT_CODES)[keyof typeof MIGRATE_EXIT_CODES];

/** One migration file, read and validated. */
export interface MigrationFile {
  readonly kind: MigrationKind;
  /** The file name, e.g. `0002_add_tenant_flags.sql`. */
  readonly file: string;
  /** The ledger id: the file name without `.sql`, e.g. `0002_add_tenant_flags` or `R__ota_read_access`. */
  readonly id: string;
  /** Absolute path. */
  readonly path: string;
  /** `expand`, `migrate` or `contract` from the header (`expand` for the baseline); `repeatable` for `R__`. */
  readonly phase: LedgerPhase;
  /** True with a `-- velexis:no-transaction` header: the statements run one by one outside a transaction. */
  readonly noTransaction: boolean;
  /** The first header comment line that is not a directive, or the words of the file name. */
  readonly description: string;
  /** SHA-256 of the raw bytes, lowercase hex: what the ledger stores and verifies. */
  readonly checksum: string;
  /** The file as UTF-8 text, executed as it is (in one transaction unless `noTransaction`). */
  readonly sql: string;
  /** The statements without comments, for a `noTransaction` file (empty otherwise). */
  readonly statements: readonly string[];
}

/** The validated content of a migration folder. */
export interface MigrationFiles {
  readonly set: MigrationSet;
  /** Absolute path of the folder. */
  readonly dir: string;
  /** False when the folder does not exist: an empty set (ADR-0021), nothing to apply. */
  readonly exists: boolean;
  /** Numbered files in apply order (by name, which is by number). */
  readonly numbered: readonly MigrationFile[];
  /** Repeatable files in apply order (by name); always empty for the tenant set. */
  readonly repeatable: readonly MigrationFile[];
}

/** Base class of the runner's errors; `exitCode` is what `migrate.js` exits with. */
export class MigrationError extends Error {
  override readonly name: string = "MigrationError";
  readonly exitCode: MigrateExitCode;

  constructor(message: string, exitCode: MigrateExitCode, options?: ErrorOptions) {
    super(message, options);
    this.exitCode = exitCode;
  }
}

/** One rejected file and the reason. */
export interface MigrationFileProblem {
  readonly file: string;
  readonly reason: string;
}

/** The folder holds invalid files. Thrown before any connection is opened, so nothing has been applied. */
export class MigrationFilesError extends MigrationError {
  override readonly name = "MigrationFilesError";
  readonly set: MigrationSet;
  readonly dir: string;
  readonly problems: readonly MigrationFileProblem[];

  constructor(set: MigrationSet, dir: string, problems: readonly MigrationFileProblem[]) {
    const count = problems.length === 1 ? "1 problem" : `${problems.length} problems`;
    super(
      [
        `Invalid ${set} migrations in ${dir} (${count}); nothing was applied:`,
        ...problems.map(({ file, reason }) => `  - ${file}: ${reason}`),
      ].join("\n"),
      MIGRATE_EXIT_CODES.error,
    );
    this.set = set;
    this.dir = dir;
    this.problems = Object.freeze(problems.map((problem) => Object.freeze({ ...problem })));
  }
}

/** True for `platform` and `reference`. */
export function isSharedMigrationSet(value: unknown): value is SharedMigrationSet {
  return (SHARED_MIGRATION_SETS as readonly unknown[]).includes(value);
}

/** SHA-256 of `bytes` as lowercase hex. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const DIRECTIVE = /^--\s*velexis:(\S*)(.*)$/;
const PHASE_ARGUMENT = /^\s+(\S+)\s*$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/**
 * Statements that start or end a transaction. In a migration file they would commit part of it outside the
 * runner's transaction and its ledger row (ADR-0005 item 4). Savepoints and `ROLLBACK TO` stay allowed.
 */
const TRANSACTION_CONTROL =
  /^(?:begin|start\s+transaction|commit|end|abort|prepare\s+transaction|rollback(?!\s+(?:work\s+|transaction\s+)?to\b))\b/i;

interface Header {
  readonly phase: MigrationPhase | undefined;
  /** True when a `-- velexis:phase` line exists, valid or not. */
  readonly hasPhaseDirective: boolean;
  readonly noTransaction: boolean;
  readonly description: string | undefined;
  readonly problems: readonly string[];
}

/**
 * The leading comment block of a file: blank lines and `--` lines up to the first other line. Directives are
 * `-- velexis:phase <expand|migrate|contract>` and `-- velexis:no-transaction`; the first other comment line
 * with a letter or digit is the description (banner lines of `=` are skipped).
 */
function parseHeader(sql: string): Header {
  let phase: MigrationPhase | undefined;
  let hasPhaseDirective = false;
  let noTransaction = false;
  let description: string | undefined;
  const problems: string[] = [];
  for (const raw of sql.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (line === "") {
      continue;
    }
    if (!line.startsWith("--")) {
      break;
    }
    const directive = DIRECTIVE.exec(line);
    if (directive === null) {
      const text = line.replace(/^--+/, "").trim();
      if (description === undefined && /[A-Za-z0-9]/.test(text)) {
        description = text;
      }
      continue;
    }
    const [, name = "", rest = ""] = directive;
    if (name === "phase") {
      hasPhaseDirective = true;
      const value = PHASE_ARGUMENT.exec(rest)?.[1];
      if (value === undefined || !(MIGRATION_PHASES as readonly string[]).includes(value)) {
        problems.push(
          `invalid phase header ${JSON.stringify(line)}: write "-- velexis:phase ${MIGRATION_PHASES.join("|")}"`,
        );
      } else if (phase !== undefined) {
        problems.push("more than one -- velexis:phase header");
      } else {
        phase = value as MigrationPhase;
      }
    } else if (name === "no-transaction" && rest.trim() === "") {
      noTransaction = true;
    } else {
      problems.push(
        `unknown directive ${JSON.stringify(line)}: only "-- velexis:phase <phase>" and "-- velexis:no-transaction" exist`,
      );
    }
  }
  return { phase, hasPhaseDirective, noTransaction, description, problems };
}

/** `0002_add_tenant_flags` → `add tenant flags`; `R__ota_read_access` → `ota read access`. */
function describeId(id: string): string {
  return (
    id
      .replace(/^(?:\d{4}_|R__)/, "")
      .replace(/_+/g, " ")
      .trim() || id
  );
}

/** The first two words of a statement, for an error message. */
function statementStart(statement: string): string {
  return statement.split(/\s+/).slice(0, 2).join(" ").slice(0, 40);
}

/**
 * Reads and validates the migration folder of `set`:
 *
 * - numbered files match `^\d{4}_[a-z0-9_]+\.sql$` and are sorted; a duplicated number fails;
 * - repeatable files match `^R__[a-z0-9_]+\.sql$` and are allowed in `platform` and `reference` only;
 *   every statement must start with GRANT, REVOKE or COMMENT ON (ADR-0021);
 * - numbered files need `-- velexis:phase expand|migrate|contract`, except `0001_baseline.sql` (a byte copy
 *   of the reference DDL without headers, phase `expand`); `-- velexis:no-transaction` is recognised;
 * - a numbered file must not contain transaction control (BEGIN, COMMIT, ...): the runner owns the transaction;
 * - any other `.sql` name, invalid UTF-8 or a byte order mark is a problem; other files are ignored.
 *
 * The checksum is the SHA-256 of the raw bytes. A folder that does not exist is an empty set
 * (`exists: false`). All problems are thrown together as `MigrationFilesError`.
 */
export async function readMigrationFiles(dir: string, set: MigrationSet): Promise<MigrationFiles> {
  if (!(MIGRATION_SETS as readonly unknown[]).includes(set)) {
    throw new TypeError(`readMigrationFiles: unknown migration set ${JSON.stringify(set)}`);
  }
  const folder = resolve(dir);
  let names: string[];
  try {
    names = (await readdir(folder, { withFileTypes: true }))
      .filter((entry) => !entry.isDirectory() && entry.name.toLowerCase().endsWith(".sql"))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze({ set, dir: folder, exists: false, numbered: [], repeatable: [] });
    }
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") {
      throw new MigrationFilesError(set, folder, [{ file: folder, reason: "is not a folder" }]);
    }
    throw error;
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const problems: MigrationFileProblem[] = [];
  const numbered: MigrationFile[] = [];
  const repeatable: MigrationFile[] = [];
  const byNumber = new Map<string, string[]>();

  for (const name of names) {
    const kind: MigrationKind | undefined = NUMBERED_FILE_PATTERN.test(name)
      ? "numbered"
      : REPEATABLE_FILE_PATTERN.test(name)
        ? "repeatable"
        : undefined;
    if (kind === undefined) {
      problems.push({
        file: name,
        reason:
          "is not a migration file name: numbered files match ^\\d{4}_[a-z0-9_]+\\.sql$, repeatable files ^R__[a-z0-9_]+\\.sql$",
      });
      continue;
    }
    if (kind === "repeatable" && set === "tenant") {
      problems.push({
        file: name,
        reason: "repeatable files are allowed in the platform and reference sets only (ADR-0021)",
      });
      continue;
    }
    if (kind === "numbered") {
      const number = name.slice(0, 4);
      byNumber.set(number, [...(byNumber.get(number) ?? []), name]);
    }

    const path = join(folder, name);
    const bytes = await readFile(path);
    let sql: string;
    try {
      sql = UTF8.decode(bytes);
    } catch {
      problems.push({ file: name, reason: "is not valid UTF-8" });
      continue;
    }
    if (sql.startsWith("\uFEFF")) {
      problems.push({ file: name, reason: "starts with a byte order mark; save it as UTF-8 without BOM" });
      continue;
    }

    const id = name.slice(0, -".sql".length);
    const isBaseline = name === BASELINE_FILE;
    const header = parseHeader(sql);
    const fileProblems = [...header.problems];
    let phase: LedgerPhase;
    if (kind === "repeatable") {
      phase = "repeatable";
      if (header.hasPhaseDirective) {
        fileProblems.push('takes no -- velexis:phase header: the phase of a repeatable file is "repeatable"');
      }
      if (header.noTransaction) {
        fileProblems.push("a repeatable file always runs in a transaction; remove -- velexis:no-transaction");
      }
    } else if (header.phase !== undefined) {
      phase = header.phase;
    } else {
      phase = "expand";
      if (!isBaseline && !header.hasPhaseDirective) {
        fileProblems.push(
          `needs the header "-- velexis:phase ${MIGRATION_PHASES.join("|")}" (conventions §9)`,
        );
      }
    }

    let statements: string[] = [];
    try {
      statements = splitSqlStatements(sql);
    } catch (error) {
      if (!(error instanceof SqlSplitError)) {
        throw error;
      }
      fileProblems.push(`cannot be split into statements: ${error.message}`);
    }
    if (kind === "repeatable") {
      fileProblems.push(...repeatableStatementProblems(statements));
    } else {
      statements.forEach((statement, index) => {
        if (TRANSACTION_CONTROL.test(statement)) {
          fileProblems.push(
            `statement ${index + 1} (${JSON.stringify(statementStart(statement))}) is transaction control; ` +
              "the runner opens and commits each file's transaction",
          );
        }
      });
    }

    if (fileProblems.length > 0) {
      problems.push(...fileProblems.map((reason) => ({ file: name, reason })));
      continue;
    }
    const migration: MigrationFile = Object.freeze({
      kind,
      file: name,
      id,
      path,
      phase,
      noTransaction: header.noTransaction,
      description: header.description ?? describeId(id),
      checksum: sha256Hex(bytes),
      sql,
      statements: Object.freeze(header.noTransaction ? statements : []),
    });
    (kind === "numbered" ? numbered : repeatable).push(migration);
  }

  for (const [number, files] of byNumber) {
    if (files.length > 1) {
      problems.push({
        file: files.join(", "),
        reason: `duplicated number ${number}: every numbered file needs the next free number of the set`,
      });
    }
  }
  if (problems.length > 0) {
    throw new MigrationFilesError(set, folder, problems);
  }
  return Object.freeze({
    set,
    dir: folder,
    exists: true,
    numbered: Object.freeze(numbered),
    repeatable: Object.freeze(repeatable),
  });
}
