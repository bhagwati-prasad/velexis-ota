// Repeatable files (ADR-0021) and the SQL statement splitter behind them (X-011).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  pendingRepeatableFiles,
  repeatableStatementProblems,
  splitSqlStatements,
  SqlSplitError,
  type LedgerRow,
  type MigrationFile,
} from "./index.js";

const REFERENCE_DDL = resolve(__dirname, "..", "..", "..", "..", "docs", "velexis-sdk", "db");

describe("splitSqlStatements", () => {
  it("splits on semicolons, trims, drops empty statements and keeps a last statement without a semicolon", () => {
    expect(splitSqlStatements("SELECT 1;\n\n  SELECT 2 ;;\n;SELECT 3")).toEqual([
      "SELECT 1",
      "SELECT 2",
      "SELECT 3",
    ]);
    expect(splitSqlStatements("")).toEqual([]);
    expect(splitSqlStatements("-- only a comment\n/* and another */\n")).toEqual([]);
  });

  it("keeps semicolons inside strings, E-strings, quoted identifiers and dollar quotes", () => {
    const sql = [
      "COMMENT ON TABLE platform.t IS 'a; b ''quoted; still'' c';",
      "COMMENT ON TABLE platform.u IS E'it\\'s; escaped';",
      'GRANT SELECT ON platform."odd;name" TO velexis_ota_app;',
      "COMMENT ON TABLE platform.v IS $$dollar; quoted$$;",
      "COMMENT ON TABLE platform.w IS $body$ nested $$ still; inside $body$;",
      "DO $outer$ BEGIN PERFORM 1; END $outer$;",
    ].join("\n");
    expect(splitSqlStatements(sql)).toEqual([
      "COMMENT ON TABLE platform.t IS 'a; b ''quoted; still'' c'",
      "COMMENT ON TABLE platform.u IS E'it\\'s; escaped'",
      'GRANT SELECT ON platform."odd;name" TO velexis_ota_app',
      "COMMENT ON TABLE platform.v IS $$dollar; quoted$$",
      "COMMENT ON TABLE platform.w IS $body$ nested $$ still; inside $body$",
      "DO $outer$ BEGIN PERFORM 1; END $outer$",
    ]);
  });

  it("treats a backslash in a standard string as an ordinary character", () => {
    expect(splitSqlStatements("SELECT 'a\\'; SELECT 2;")).toEqual(["SELECT 'a\\'", "SELECT 2"]);
  });

  it("removes line and nested block comments, including the quotes and semicolons inside them", () => {
    const sql = [
      "-- a header; with 'quotes",
      "GRANT SELECT /* inline; */ ON platform.t TO velexis_ota_app; -- trailing; 'x",
      "/* outer /* nested; */ still comment; */ REVOKE ALL ON platform.t FROM PUBLIC;",
      "SELECT 1--glued",
    ].join("\n");
    expect(splitSqlStatements(sql)).toEqual([
      "GRANT SELECT   ON platform.t TO velexis_ota_app",
      "REVOKE ALL ON platform.t FROM PUBLIC",
      "SELECT 1",
    ]);
  });

  it("does not take positional parameters or identifiers with $ for dollar quotes", () => {
    expect(splitSqlStatements("SELECT $1; SELECT a$b$ FROM t; SELECT 2")).toEqual([
      "SELECT $1",
      "SELECT a$b$ FROM t",
      "SELECT 2",
    ]);
  });

  it("reads identifiers and dollar-quote tags with non-ASCII letters", () => {
    expect(splitSqlStatements("SELECT $tàg$ a; b $tàg$; SELECT café$x FROM t; SELECT 'é;'")).toEqual([
      "SELECT $tàg$ a; b $tàg$",
      "SELECT café$x FROM t",
      "SELECT 'é;'",
    ]);
  });

  it("keeps the BEGIN ATOMIC body of a SQL-standard function or procedure in one statement, as psql does", () => {
    const sql = [
      "CREATE FUNCTION platform.f(a int) RETURNS int LANGUAGE sql",
      "BEGIN ATOMIC",
      "  SELECT CASE WHEN a > 0 THEN 1 ELSE 0 END;",
      "  SELECT 2;",
      "END;",
      "CREATE OR REPLACE PROCEDURE platform.p() LANGUAGE sql BEGIN ATOMIC SELECT 1; END;",
      "SELECT CASE WHEN true THEN 1 END; SELECT 3;",
    ].join("\n");
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toMatch(/^CREATE FUNCTION platform\.f[\s\S]*SELECT 2;\nEND$/);
    expect(statements[1]).toBe(
      "CREATE OR REPLACE PROCEDURE platform.p() LANGUAGE sql BEGIN ATOMIC SELECT 1; END",
    );
    expect(statements.slice(2)).toEqual(["SELECT CASE WHEN true THEN 1 END", "SELECT 3"]);
  });

  it("throws SqlSplitError with the line of an unterminated string, identifier, dollar quote or comment", () => {
    const cases: Array<[string, RegExp]> = [
      ["SELECT 1;\nSELECT 'open;", /^unterminated string literal starting on line 2$/],
      ['SELECT "open', /^unterminated quoted identifier starting on line 1$/],
      [
        "SELECT 1;\n\nSELECT $tag$ never closed $other$;",
        /^unterminated dollar-quoted string \$tag\$ starting on line 3$/,
      ],
      ["SELECT 1; /* open /* nested */", /^unterminated \/\* comment starting on line 1$/],
      ["SELECT E'open\\';", /^unterminated string literal starting on line 1$/],
    ];
    for (const [sql, message] of cases) {
      expect(() => splitSqlStatements(sql)).toThrow(SqlSplitError);
      expect(() => splitSqlStatements(sql)).toThrow(message);
    }
  });

  it("splits the reference DDL into its CREATE and ALTER statements", () => {
    const tables = { platform: 16, reference: 7, tenant: 42 };
    for (const [name, count] of Object.entries(tables)) {
      const statements = splitSqlStatements(readFileSync(resolve(REFERENCE_DDL, `${name}.sql`), "utf8"));
      expect(statements.filter((statement) => /^CREATE TABLE /.test(statement))).toHaveLength(count);
      for (const statement of statements) {
        expect(statement).toMatch(/^(?:CREATE (?:SCHEMA|TABLE|INDEX|UNIQUE INDEX)|ALTER TABLE) /);
        expect(statement).not.toMatch(/--|;$/);
      }
    }
  });
});

describe("repeatableStatementProblems", () => {
  it("accepts GRANT, REVOKE and COMMENT ON in any case and layout", () => {
    const sql = [
      "-- ADR-0021: privileges only",
      "GRANT SELECT ON platform.tenants, platform.plans TO velexis_ota_app;",
      "grant select (id, email) on platform.accounts to velexis_ota_app;",
      "/* tidy */ REVOKE ALL ON platform.subscriptions FROM velexis_ota_app;",
      "Comment\n  On TABLE platform.tenants IS 'Tenants; CREATE TABLE here is only text';",
    ].join("\n");
    expect(repeatableStatementProblems(splitSqlStatements(sql))).toEqual([]);
  });

  it("rejects CREATE TABLE and every other statement [X-011 AC5]", () => {
    const sql = [
      "GRANT SELECT ON platform.tenants TO velexis_ota_app;",
      "CREATE TABLE platform.sneaky (id int);",
      "ALTER TABLE platform.tenants ADD COLUMN x int;",
      "INSERT INTO platform.plans (code) VALUES ('free');",
      "DROP TABLE platform.tenants;",
      "COMMENT IS 'no target';",
      "GRANTED;",
    ].join("\n");
    const problems = repeatableStatementProblems(splitSqlStatements(sql));
    expect(problems).toHaveLength(6);
    expect(problems[0]).toBe(
      'statement 2 starts with "CREATE TABLE": a repeatable file may contain only GRANT, REVOKE and COMMENT ON ' +
        "statements (ADR-0021); put other changes in a numbered file",
    );
    expect(problems.slice(1).map((problem) => problem.slice(0, problem.indexOf(":")))).toEqual([
      'statement 3 starts with "ALTER TABLE"',
      'statement 4 starts with "INSERT INTO"',
      'statement 5 starts with "DROP TABLE"',
      'statement 6 starts with "COMMENT IS"',
      'statement 7 starts with "GRANTED"',
    ]);
  });

  it("sees a statement hidden after a GRANT on the same line", () => {
    const problems = repeatableStatementProblems(
      splitSqlStatements(
        "GRANT SELECT ON platform.t TO velexis_ota_app; CREATE TABLE platform.x (a int); -- grant",
      ),
    );
    expect(problems).toEqual([expect.stringMatching(/^statement 2 starts with "CREATE TABLE"/)]);
  });
});

describe("pendingRepeatableFiles", () => {
  const file = (id: string, checksum: string): MigrationFile => ({
    kind: "repeatable",
    file: `${id}.sql`,
    id,
    path: `/m/${id}.sql`,
    phase: "repeatable",
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
  ): [string, LedgerRow] => [id, { id, checksum, phase: "repeatable", status }];

  it("applies a new file, re-applies an edited or failed one and skips an unchanged one [X-011 AC5]", () => {
    const files = [
      file("R__a_new", "a1"),
      file("R__b_same", "b1"),
      file("R__c_edited", "c2"),
      file("R__d_failed", "d1"),
    ];
    const ledger = new Map([
      row("R__b_same", "b1"),
      row("R__c_edited", "c1"),
      row("R__d_failed", "d1", "failed"),
    ]);
    expect(pendingRepeatableFiles(files, ledger).map(({ id }) => id)).toEqual([
      "R__a_new",
      "R__c_edited",
      "R__d_failed",
    ]);
    expect(
      pendingRepeatableFiles(
        files,
        new Map([...ledger, row("R__a_new", "a1"), row("R__c_edited", "c2"), row("R__d_failed", "d1")]),
      ),
    ).toEqual([]);
  });
});
