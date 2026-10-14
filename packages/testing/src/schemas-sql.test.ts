import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCHEMAS_SQL } from "./test-database.js";

// Tests of task X-015 step 1: deploy/postgres/schemas.sql holds exactly the in-database statements of
// deploy/postgres/bootstrap.sql, so the test template database (createTemplateDatabase) is bootstrapped like the VM.
// bootstrap.sql stays whole because provision-vm.sh feeds it to psql on stdin, where `\ir schemas.sql` would not
// resolve; this check keeps the two files from drifting.

const BOOTSTRAP_SQL = join(SCHEMAS_SQL, "..", "bootstrap.sql");
const FIRST_STATEMENT = "REVOKE ALL ON SCHEMA public FROM PUBLIC;";
const CONNECT_LINE = /^\\connect :db_name[ \t]*$/m;

/**
 * Why `schemas` is not the in-database part of `bootstrap` (empty when it is):
 * - schemas.sql starts with the first in-database statement and has no psql meta-command or variable;
 * - bootstrap.sql ends with schemas.sql, byte for byte;
 * - between bootstrap.sql's `\connect :db_name` and that tail there are only blank lines and `--` comments.
 */
function schemasSqlProblems(bootstrap: string, schemas: string): string[] {
  const problems: string[] = [];
  if (!schemas.startsWith(FIRST_STATEMENT)) {
    problems.push(`schemas.sql does not start with "${FIRST_STATEMENT}"`);
  }
  const lines = schemas.split("\n");
  const metaCommand = lines.findIndex((line) => /^\s*\\/.test(line));
  if (metaCommand >= 0) {
    problems.push(`schemas.sql line ${metaCommand + 1} is a psql meta-command`);
  }
  const variable = lines.findIndex((line) => /(?<!:):['"]?[a-z_][a-z0-9_]*/i.test(line.replace(/--.*$/, "")));
  if (variable >= 0) {
    problems.push(`schemas.sql line ${variable + 1} uses a psql variable`);
  }
  if (!bootstrap.endsWith(schemas)) {
    problems.push("bootstrap.sql does not end with schemas.sql verbatim");
    return problems;
  }
  const connect = CONNECT_LINE.exec(bootstrap);
  if (connect === null) {
    problems.push("bootstrap.sql has no `\\connect :db_name` line");
    return problems;
  }
  const between = bootstrap.slice(connect.index + connect[0].length, bootstrap.length - schemas.length);
  const statement = between
    .split("\n")
    .findIndex((line) => line.trim() !== "" && !line.trim().startsWith("--"));
  if (statement >= 0) {
    problems.push("bootstrap.sql has a statement after `\\connect :db_name` that schemas.sql does not have");
  }
  return problems;
}

describe("deploy/postgres/schemas.sql", () => {
  const bootstrap = readFileSync(BOOTSTRAP_SQL, "utf8");
  const schemas = readFileSync(SCHEMAS_SQL, "utf8");

  it("is the in-database part of bootstrap.sql, verbatim [X-015 AC5]", () => {
    expect(schemasSqlProblems(bootstrap, schemas)).toEqual([]);
    // Not vacuous: the files hold the statements the template database needs.
    expect(schemas).toContain("CREATE SCHEMA IF NOT EXISTS platform AUTHORIZATION velexis_migrator;");
    expect(schemas).toContain("ALTER DEFAULT PRIVILEGES FOR ROLE velexis_migrator IN SCHEMA reference");
    expect(bootstrap.length - schemas.length).toBeGreaterThan(0);
  });

  it("fails when schemas.sql and bootstrap.sql differ [X-015 AC5]", () => {
    const grant = "GRANT USAGE ON SCHEMA reference TO velexis_ota_app;";
    expect(schemas).toContain(grant);

    // A statement changed or dropped in schemas.sql only.
    expect(
      schemasSqlProblems(bootstrap, schemas.replace(grant, "GRANT USAGE ON SCHEMA reference TO PUBLIC;")),
    ).toEqual(["bootstrap.sql does not end with schemas.sql verbatim"]);
    expect(schemasSqlProblems(bootstrap, schemas.replace(`${grant}\n`, ""))).toEqual([
      "bootstrap.sql does not end with schemas.sql verbatim",
    ]);
    // A statement added at the end of bootstrap.sql only.
    expect(schemasSqlProblems(`${bootstrap}GRANT USAGE ON SCHEMA platform TO PUBLIC;\n`, schemas)).toEqual([
      "bootstrap.sql does not end with schemas.sql verbatim",
    ]);
    // A comment or whitespace changed: verbatim means byte for byte.
    expect(
      schemasSqlProblems(bootstrap, schemas.replace("-- Tables and sequences", "-- tables and sequences")),
    ).toEqual(["bootstrap.sql does not end with schemas.sql verbatim"]);
    expect(schemasSqlProblems(bootstrap, schemas.trimEnd())).toEqual([
      "bootstrap.sql does not end with schemas.sql verbatim",
    ]);
    // A statement added to bootstrap.sql between `\connect :db_name` and the part schemas.sql copies.
    const withExtra = bootstrap.replace(
      /^\\connect :db_name\n/m,
      "\\connect :db_name\nCREATE SCHEMA extra;\n",
    );
    expect(withExtra).not.toBe(bootstrap);
    expect(schemasSqlProblems(withExtra, schemas)).toEqual([
      "bootstrap.sql has a statement after `\\connect :db_name` that schemas.sql does not have",
    ]);
    // schemas.sql may start later than the first in-database statement only if bootstrap.sql changes too.
    const tail = schemas.slice(schemas.indexOf("\n") + 1);
    expect(schemasSqlProblems(bootstrap, tail)).toEqual([
      `schemas.sql does not start with "${FIRST_STATEMENT}"`,
      "bootstrap.sql has a statement after `\\connect :db_name` that schemas.sql does not have",
    ]);
  });

  it("refuses psql meta-commands and variables, even when both files carry them", () => {
    const meta = `${schemas}\\set ON_ERROR_STOP on\n`;
    expect(schemasSqlProblems(`${bootstrap}\\set ON_ERROR_STOP on\n`, meta)).toEqual([
      `schemas.sql line ${meta.split("\n").length - 1} is a psql meta-command`,
    ]);
    const variable = `${schemas}GRANT USAGE ON SCHEMA platform TO :role;\n`;
    expect(schemasSqlProblems(`${bootstrap}GRANT USAGE ON SCHEMA platform TO :role;\n`, variable)).toEqual([
      `schemas.sql line ${variable.split("\n").length - 1} uses a psql variable`,
    ]);
    // A cast (`::jsonb`) and a comment mentioning `:'db_name'` are not variables.
    const cast = `${schemas}SELECT '{}'::jsonb; -- not :'db_name'\n`;
    expect(schemasSqlProblems(`${bootstrap}SELECT '{}'::jsonb; -- not :'db_name'\n`, cast)).toEqual([]);
  });

  it("names the missing \\connect line of bootstrap.sql", () => {
    const withoutConnect = bootstrap.replace(CONNECT_LINE, "-- (no connect)");
    expect(schemasSqlProblems(withoutConnect, schemas)).toEqual([
      "bootstrap.sql has no `\\connect :db_name` line",
    ]);
  });
});
