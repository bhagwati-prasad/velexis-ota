// Repeatable migration files R__name.sql (ADR-0021): idempotent GRANT, REVOKE and COMMENT ON statements in the
// platform and reference sets, applied after the numbered files whenever their checksum changed. Also the SQL
// statement splitter that checks them and runs `-- velexis:no-transaction` files statement by statement.
import type { MigrationFile } from "./files.js";
import type { LedgerRow } from "./ledger.js";

/** The only statements a repeatable file may contain (ADR-0021): privileges and comments, nothing else. */
const REPEATABLE_STATEMENT = /^(?:grant|revoke)\b|^comment\s+on\b/i;

/** A file that cannot be split into statements: an unterminated string, quoted identifier or comment. */
export class SqlSplitError extends Error {
  override readonly name = "SqlSplitError";
}

const IDENTIFIER = /[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/y;
const DOLLAR_QUOTE = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;

/** Line number (1-based) of `index` in `sql`, for error messages. */
function lineOf(sql: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < sql.length; i += 1) {
    if (sql.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

/** Index just after the closing `quote` of the string or identifier that opens at `start`. */
function endOfQuoted(sql: string, start: number, quote: "'" | '"', backslashEscapes: boolean): number {
  let i = start + 1;
  while (i < sql.length) {
    const char = sql[i];
    if (backslashEscapes && char === "\\") {
      i += 2;
      continue;
    }
    if (char === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  const what = quote === "'" ? "string literal" : "quoted identifier";
  throw new SqlSplitError(`unterminated ${what} starting on line ${lineOf(sql, start)}`);
}

/** Index just after the end of the (nestable) block comment that opens at `start`. */
function endOfBlockComment(sql: string, start: number): number {
  let depth = 1;
  let i = start + 2;
  while (i < sql.length && depth > 0) {
    if (sql[i] === "/" && sql[i + 1] === "*") {
      depth += 1;
      i += 2;
    } else if (sql[i] === "*" && sql[i + 1] === "/") {
      depth -= 1;
      i += 2;
    } else {
      i += 1;
    }
  }
  if (depth > 0) {
    throw new SqlSplitError(`unterminated /* comment starting on line ${lineOf(sql, start)}`);
  }
  return i;
}

/**
 * Splits SQL into statements the way psql does, without its meta-commands: a `;` ends a statement unless it
 * is inside a string (`'…'`, `E'…'` with backslash escapes), a quoted identifier, a dollar-quoted string
 * (`$$…$$`, `$tag$…$tag$`), a comment (`--` to the end of the line, or a nestable block comment),
 * parentheses, or the `BEGIN ATOMIC … END` body of `CREATE [OR REPLACE] FUNCTION|PROCEDURE` (psql's
 * heuristic). Comments are removed (a space takes their place), each statement is trimmed, and empty
 * statements are dropped.
 *
 * Throws `SqlSplitError` for an unterminated string, identifier, dollar quote or block comment.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let parenDepth = 0;
  let beginDepth = 0;
  /** The first four words of the current statement, lower case: is it CREATE [OR REPLACE] FUNCTION? */
  let head: string[] = [];

  const endStatement = (): void => {
    const statement = current.trim();
    if (statement !== "") {
      statements.push(statement);
    }
    current = "";
    parenDepth = 0;
    beginDepth = 0;
    head = [];
  };

  let i = 0;
  while (i < sql.length) {
    const char = sql[i] ?? "";
    const next = sql[i + 1];
    if (char === "-" && next === "-") {
      const newline = sql.indexOf("\n", i);
      i = newline === -1 ? sql.length : newline;
      current += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      i = endOfBlockComment(sql, i);
      current += " ";
      continue;
    }
    if (char === "'" || char === '"') {
      const end = endOfQuoted(sql, i, char, false);
      current += sql.slice(i, end);
      i = end;
      continue;
    }
    if (char === "$") {
      DOLLAR_QUOTE.lastIndex = i;
      const delimiter = DOLLAR_QUOTE.exec(sql)?.[0];
      if (delimiter !== undefined) {
        const close = sql.indexOf(delimiter, i + delimiter.length);
        if (close === -1) {
          throw new SqlSplitError(
            `unterminated dollar-quoted string ${delimiter} starting on line ${lineOf(sql, i)}`,
          );
        }
        const end = close + delimiter.length;
        current += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    IDENTIFIER.lastIndex = i;
    const word = IDENTIFIER.exec(sql)?.[0];
    if (word !== undefined) {
      current += word;
      i += word.length;
      // E'…' is a string with backslash escapes: E'it\'s' must not end at the escaped quote.
      if ((word === "E" || word === "e") && sql[i] === "'") {
        const end = endOfQuoted(sql, i, "'", true);
        current += sql.slice(i, end);
        i = end;
        continue;
      }
      const lower = word.toLowerCase();
      if (head.length < 4) {
        head.push(lower);
      }
      const createsRoutine =
        head[0] === "create" &&
        (head[1] === "function" ||
          head[1] === "procedure" ||
          (head[1] === "or" && head[2] === "replace" && (head[3] === "function" || head[3] === "procedure")));
      if (createsRoutine && parenDepth === 0) {
        if (lower === "begin") {
          beginDepth += 1;
        } else if (lower === "case" && beginDepth > 0) {
          beginDepth += 1;
        } else if (lower === "end" && beginDepth > 0) {
          beginDepth -= 1;
        }
      }
      continue;
    }
    if (char === "(") {
      parenDepth += 1;
    } else if (char === ")" && parenDepth > 0) {
      parenDepth -= 1;
    } else if (char === ";" && parenDepth === 0 && beginDepth === 0) {
      endStatement();
      i += 1;
      continue;
    }
    current += char;
    i += 1;
  }
  endStatement();
  return statements;
}

/**
 * The problems of a repeatable file's statements (from `splitSqlStatements`, comments removed): each must start
 * with `GRANT`, `REVOKE` or `COMMENT ON` (ADR-0021). Tables, columns and data change only in numbered files.
 */
export function repeatableStatementProblems(statements: readonly string[]): string[] {
  const problems: string[] = [];
  statements.forEach((statement, index) => {
    if (!REPEATABLE_STATEMENT.test(statement)) {
      const start = statement.split(/\s+/).slice(0, 2).join(" ").slice(0, 40);
      problems.push(
        `statement ${index + 1} starts with ${JSON.stringify(start)}: a repeatable file may contain only ` +
          "GRANT, REVOKE and COMMENT ON statements (ADR-0021); put other changes in a numbered file",
      );
    }
  });
  return problems;
}

/**
 * The repeatable files to apply, in name order: those without an applied ledger row, and those whose
 * checksum differs from it (the file was edited, which is allowed for repeatable files only).
 */
export function pendingRepeatableFiles(
  files: readonly MigrationFile[],
  ledger: ReadonlyMap<string, LedgerRow>,
): MigrationFile[] {
  return files.filter((file) => {
    const row = ledger.get(file.id);
    return row === undefined || row.status !== "applied" || row.checksum !== file.checksum;
  });
}
