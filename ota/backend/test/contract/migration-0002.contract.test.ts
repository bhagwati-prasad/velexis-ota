// Tenant migration 0002 against its document (OBE-008; ota/docs/data-model-migration-0002.md §2, conventions §9,
// ota/backend/migrations/README.md). The exact SQL of `0002_add_mvp_tenant_deltas.sql` is printed in the one ```sql
// block of the document; the migration file is that block, byte for byte, with no other text. The runner stores the
// file's SHA-256 in the ledger of every tenant schema, so the file must never be reformatted, and the document and
// the file must never drift apart: this test fails on any difference, one character included. No database: the
// files themselves, as the runner reads them; test/integration/migrations/tenant-0002.int.test.ts applies them.
// The middle block checks the rules of a tenant migration that the file itself can show (no GRANT and no role, no
// search_path, no other schema, no transaction control, expand only, a COMMENT ON for every new table and column),
// and the last one that the Kysely table types generated from the migrated schema (`pnpm db:codegen`) carry every new
// table and column, at compile time (`pnpm typecheck`) and in the committed file.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Selectable, TenantDatabase } from "@velexis/db";
import { readMigrationFiles, splitSqlStatements } from "@velexis/db/migrate";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";

const REPO = resolve(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO, "ota", "backend", "migrations", "tenant");
const MIGRATION_FILE = "0002_add_mvp_tenant_deltas.sql";
const DOCUMENT = "ota/docs/data-model-migration-0002.md";
const PHASE_HEADER = "-- velexis:phase expand";
const GENERATED_TYPES = join(REPO, "packages", "db", "src", "generated", "tenant.ts");

/** The tables 0002 creates and the columns it adds to baseline tables (data-model-migration-0002.md §2). */
const CREATED_TABLES = ["storefront_assets", "storefront_pages"];
const ADDED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  checkouts: ["pricing_mode"],
  bookings: ["create_order_started_at", "reconcile_until", "reconcile_attempts", "reconcile_outcome"],
  storefront_settings: [
    "legal_name",
    "time_zone",
    "default_market",
    "markets",
    "support_details",
    "seo",
    "consent",
    "terms_version",
    "privacy_version",
    "airline_card_enabled_test",
    "airline_card_enabled_live",
    "booking_queue_number",
    "booking_queue_category",
    "ops_alert_email",
    "logo_asset_id",
    "logo_dark_asset_id",
    "logo_square_asset_id",
    "favicon_asset_id",
    "og_image_asset_id",
  ],
};

/** The content of every ```sql block of a Markdown document: the lines between the fences, each with its newline. */
function sqlBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```sql\n([\s\S]*?)^```[ \t]*$/gm)].map((match) => match[1] ?? "");
}

/** Where two texts first differ, as a 0-based offset and a 1-based line and column; `undefined` when equal. */
function firstDifference(
  actual: string,
  expected: string,
): { offset: number; line: number; column: number } | undefined {
  if (actual === expected) {
    return undefined;
  }
  let offset = 0;
  while (offset < actual.length && offset < expected.length && actual[offset] === expected[offset]) {
    offset += 1;
  }
  const before = expected.slice(0, offset).split("\n");
  return { offset, line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A statement with its string literals emptied, so keywords and names are matched outside comments and texts. */
const withoutLiterals = (statement: string): string => statement.replace(/'(?:[^']|'')*'/g, "''");

/**
 * The actions of an `ALTER TABLE <table> …` statement (literals already emptied), split at the commas outside
 * parentheses, so `ADD COLUMN a …, ADD COLUMN b … CHECK (b IN ('', ''))` gives two actions.
 */
function alterTableActions(statement: string): string[] {
  const body = /^ALTER TABLE [a-z_]+\s+([\s\S]+)$/.exec(statement)?.[1] ?? "";
  const actions: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if (char === "," && depth === 0) {
      actions.push(current.trim());
      current = "";
      continue;
    }
    depth += char === "(" ? 1 : char === ")" ? -1 : 0;
    current += char;
  }
  actions.push(current.trim());
  return actions;
}

/** The column names of a `CREATE TABLE` statement: its two-space indented lines that start with a name. */
function createdColumns(statement: string): string[] {
  return [...statement.matchAll(/^ {2}([a-z][a-z0-9_]*)\s/gm)].map((match) => match[1] ?? "");
}

/** The body of `export interface <name> { … }` in the generated types. */
function interfaceBody(generated: string, name: string): string {
  const body = new RegExp(`^export interface ${name} \\{\\n([\\s\\S]*?)^\\}$`, "m").exec(generated)?.[1];
  expect(body, `the generated types have no interface ${name}`).toBeDefined();
  return body ?? "";
}

/** The member names of `export interface <name> { … }` in the generated types (their JSDoc lines skipped). */
function interfaceMembers(generated: string, name: string): string[] {
  return [...interfaceBody(generated, name).matchAll(/^ {2}([a-z_][a-z0-9_]*): /gm)].map(
    (match) => match[1] ?? "",
  );
}

let document = "";
let fileBytes: Buffer = Buffer.alloc(0);
let fileText = "";
/** The file's statements without comments (as psql would split them), with their string literals emptied. */
let statements: string[] = [];

beforeAll(async () => {
  document = await readFile(join(REPO, DOCUMENT), "utf8");
  fileBytes = await readFile(join(MIGRATIONS_DIR, MIGRATION_FILE));
  fileText = fileBytes.toString("utf8");
  statements = splitSqlStatements(fileText).map(withoutLiterals);
});

describe("tenant migration 0002 and its document", () => {
  it("prints the SQL in exactly one ```sql block, which opens with the phase header", () => {
    const blocks = sqlBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.startsWith(`${PHASE_HEADER}\n-- MVP tenant deltas: `)).toBe(true);
  });

  it("is the SQL block of the document, byte for byte", () => {
    const expected = sqlBlocks(document)[0] ?? "";
    const difference = firstDifference(fileText, expected);
    expect(
      difference,
      difference === undefined
        ? undefined
        : `${MIGRATION_FILE} differs from the SQL block of ${DOCUMENT} at line ${difference.line}, column ` +
            `${difference.column}. Never edit one without the other: copy the block again (never reformat).`,
    ).toBeUndefined();
    // The same bytes, not only the same characters: UTF-8 without a byte order mark.
    expect(fileBytes.equals(Buffer.from(expected, "utf8"))).toBe(true);
    expect(sha256(fileBytes)).toBe(sha256(Buffer.from(expected, "utf8")));
  });

  it("starts with -- velexis:phase expand and ends with exactly one newline", () => {
    const lines = fileText.split("\n");
    expect(lines[0]).toBe(PHASE_HEADER);
    expect(lines[1]).toMatch(/^-- MVP tenant deltas: /);
    expect(fileText.endsWith(";\n")).toBe(true);
    expect(fileText.endsWith("\n\n")).toBe(false);
    expect(fileText.includes("\r")).toBe(false);
    expect(fileBytes[0]).not.toBe(0xef); // no UTF-8 byte order mark
  });

  it("finds a change of one character anywhere in the file", () => {
    const expected = sqlBlocks(document)[0] ?? "";
    expect(firstDifference(fileText, expected)).toBeUndefined();
    // One character replaced at the start, in the middle and at the end, one added, one removed: each is found at
    // the offset where it happened. The middle is moved to a character that differs from the next one, so the
    // inserted and the removed character cannot line up with an identical neighbour.
    let middle = Math.floor(fileText.length / 2);
    while (fileText[middle] === fileText[middle + 1] || fileText[middle] === "#") {
      middle += 1;
    }
    const swap = (text: string, at: number): string =>
      `${text.slice(0, at)}${text[at] === "x" ? "y" : "x"}${text.slice(at + 1)}`;
    const variants: Array<{ text: string; offset: number }> = [
      { text: swap(fileText, 0), offset: 0 },
      { text: swap(fileText, middle), offset: middle },
      { text: swap(fileText, fileText.length - 2), offset: fileText.length - 2 },
      { text: `${fileText.slice(0, middle)}#${fileText.slice(middle)}`, offset: middle },
      { text: `${fileText.slice(0, middle)}${fileText.slice(middle + 1)}`, offset: middle },
      { text: fileText.slice(0, -1), offset: fileText.length - 1 },
      { text: `${fileText}\n`, offset: fileText.length },
    ];
    for (const { text, offset } of variants) {
      expect(text).not.toBe(fileText);
      expect(firstDifference(text, expected)?.offset).toBe(offset);
    }
    // A whitespace-only reformat changes the checksum the runner stores, so it is a difference too.
    expect(firstDifference(fileText.replace(/ {2}/, "\t"), expected)).toBeDefined();
  });

  it("is read by the runner as the second tenant file: expand, in one transaction, with its SHA-256", async () => {
    const files = await readMigrationFiles(MIGRATIONS_DIR, "tenant");
    expect(files.numbered.map((file) => file.file)).toEqual(["0001_baseline.sql", MIGRATION_FILE]);
    expect(files.repeatable).toEqual([]);
    expect(files.numbered[1]).toMatchObject({
      kind: "numbered",
      id: "0002_add_mvp_tenant_deltas",
      phase: "expand",
      // No `-- velexis:no-transaction` header: the runner applies the whole file and its ledger row in the schema's
      // transaction (SET LOCAL lock_timeout = '5s'), so a failing statement leaves nothing of it behind.
      noTransaction: false,
      checksum: sha256(fileBytes),
      description: expect.stringMatching(/^MVP tenant deltas: /),
    });
  });
});

describe("the rules of a tenant migration (migrations/README.md, conventions §9)", () => {
  it("has no GRANT, REVOKE or role: velexis_ota_app gets the new tables from the default privileges of provisioning [OBE-008 AC2]", () => {
    for (const statement of statements) {
      expect(statement).not.toMatch(/\b(GRANT|REVOKE|OWNER|ROLE|AUTHORIZATION)\b/i);
      expect(statement).not.toMatch(/\bvelexis_[a-z_]+/i);
    }
  });

  it("never sets the search_path, never opens or ends a transaction and names no other schema than reference", () => {
    for (const statement of statements) {
      expect(statement).not.toMatch(/\b(search_path|set_config)\b/i);
      expect(statement).not.toMatch(
        /^(SET|RESET|BEGIN|START|COMMIT|END|ABORT|ROLLBACK|SAVEPOINT|RELEASE|PREPARE)\b/i,
      );
      // Unqualified names: `x.y` only as `<table>.<column>` of COMMENT ON COLUMN, never with a schema.
      expect(statement).not.toMatch(/\b(platform|public|pg_catalog|tenant_[a-z0-9_]*)\./i);
      expect(statement).not.toMatch(/\b[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_]/i);
      // No foreign key leaves the tenant schema: `reference` rows are referred to by value only.
      expect(statement).not.toMatch(/\bREFERENCES\s+[a-z_][a-z0-9_]*\s*\./i);
    }
  });

  it("is expand only: every statement creates, adds, replaces a CHECK or comments, on unqualified names", () => {
    // An allow-list, so a statement of another kind (UPDATE or DELETE backfills, ALTER COLUMN … TYPE, SET NOT NULL,
    // RENAME, DROP of any object, TRUNCATE, CREATE TYPE or a schema-qualified name) fails here, whatever its spelling.
    const unexpected = statements.filter(
      (statement) =>
        !/^CREATE TABLE [a-z_]+ \(/.test(statement) &&
        !/^CREATE (?:UNIQUE )?INDEX [a-z_]+ ON [a-z_]+ \(/.test(statement) &&
        !/^COMMENT ON (?:TABLE [a-z_]+|COLUMN [a-z_]+\.[a-z_][a-z0-9_]*|CONSTRAINT [a-z_]+ ON [a-z_]+) IS ''$/.test(
          statement,
        ) &&
        !/^ALTER TABLE [a-z_]+\s/.test(statement),
    );
    expect(unexpected).toEqual([]);
    const alterations = statements.filter((statement) => statement.startsWith("ALTER TABLE "));
    expect(alterations.length).toBeGreaterThan(10);
    for (const statement of alterations) {
      const actions = alterTableActions(statement);
      expect(actions.length, statement).toBeGreaterThan(0);
      for (const action of actions) {
        expect(action, statement).toMatch(
          /^(?:ADD COLUMN [a-z_][a-z0-9_]* |ADD CONSTRAINT [a-z_]+\s+(?:CHECK|UNIQUE|FOREIGN KEY)\b|(?:DROP|VALIDATE) CONSTRAINT [a-z_]+$)/,
        );
        // A NOT NULL column added to a populated table needs a constant default (PostgreSQL 16 adds it without a
        // rewrite); a nullable one may come without.
        if (action.startsWith("ADD COLUMN ") && /\bNOT NULL\b/.test(action)) {
          expect(action, statement).toMatch(/\bDEFAULT\b/);
        }
      }
    }
    // The storefront_settings statement adds its 19 columns as 19 actions, none of another kind.
    const settings = alterations.find((statement) => statement.startsWith("ALTER TABLE storefront_settings"));
    expect(settings === undefined ? [] : alterTableActions(settings)).toHaveLength(
      ADDED_COLUMNS.storefront_settings?.length ?? 0,
    );
  });

  it("is expand only: text + CHECK statuses, nothing dropped but the replaced CHECKs, every new CHECK validated", () => {
    expect(statements.filter((statement) => /\bCREATE\s+TYPE\b/i.test(statement))).toEqual([]);
    expect(statements.filter((statement) => /\bDROP\s+(TABLE|COLUMN|INDEX|TYPE)\b/i.test(statement))).toEqual(
      [],
    );
    // Each dropped baseline CHECK (named by PostgreSQL `<table>_<column>_check`) is replaced by a named `…_ck` added
    // NOT VALID before the drop and validated after it, so the list is never unchecked.
    const drops = statements.flatMap((statement, index) => {
      const match = /^ALTER TABLE ([a-z_]+) DROP CONSTRAINT ([a-z_]+)$/.exec(statement);
      return match === null ? [] : [{ index, table: match[1] ?? "", constraint: match[2] ?? "" }];
    });
    expect(drops.map(({ table, constraint }) => `${table}.${constraint}`)).toEqual([
      "payments.payments_provider_check",
      "payments.payments_method_check",
    ]);
    for (const { index, table, constraint } of drops) {
      const replacement = constraint.replace(/_check$/, "_ck");
      expect(statements[index - 1]).toMatch(
        new RegExp(`^ALTER TABLE ${table} ADD CONSTRAINT ${replacement}\\s+CHECK\\b[\\s\\S]*\\sNOT VALID$`),
      );
      expect(statements[index + 1]).toBe(`ALTER TABLE ${table} VALIDATE CONSTRAINT ${replacement}`);
    }
    // No constraint is left NOT VALID.
    for (const [index, statement] of statements.entries()) {
      const notValid = /^ALTER TABLE ([a-z_]+) ADD CONSTRAINT ([a-z_]+)\s[\s\S]*\sNOT VALID$/.exec(statement);
      if (notValid !== null) {
        expect(statements.slice(index + 1)).toContain(
          `ALTER TABLE ${notValid[1] ?? ""} VALIDATE CONSTRAINT ${notValid[2] ?? ""}`,
        );
      }
    }
  });

  it("creates the two storefront tables, adds the columns of §2 and comments every new table and column", () => {
    const created = new Map<string, string[]>();
    const added = new Map<string, string[]>();
    const tableComments = new Set<string>();
    const columnComments = new Set<string>();
    for (const statement of statements) {
      const createTable = /^CREATE TABLE ([a-z_]+) \(/.exec(statement);
      if (createTable !== null) {
        created.set(createTable[1] ?? "", createdColumns(statement));
      }
      const alterTable = /^ALTER TABLE ([a-z_]+)\s+ADD COLUMN\b/.exec(statement);
      if (alterTable !== null) {
        const columns = [...statement.matchAll(/\bADD COLUMN ([a-z_][a-z0-9_]*)/g)].map(
          (match) => match[1] ?? "",
        );
        added.set(alterTable[1] ?? "", [...(added.get(alterTable[1] ?? "") ?? []), ...columns]);
      }
      const tableComment = /^COMMENT ON TABLE ([a-z_]+) IS ''$/.exec(statement);
      if (tableComment !== null) {
        tableComments.add(tableComment[1] ?? "");
      }
      const columnComment = /^COMMENT ON COLUMN ([a-z_]+)\.([a-z_][a-z0-9_]*) IS ''$/.exec(statement);
      if (columnComment !== null) {
        columnComments.add(`${columnComment[1] ?? ""}.${columnComment[2] ?? ""}`);
      }
    }

    expect([...created.keys()]).toEqual(CREATED_TABLES);
    expect(Object.fromEntries(added)).toEqual(ADDED_COLUMNS);
    for (const [table, columns] of created) {
      expect(columns.length).toBeGreaterThan(5);
      expect(tableComments.has(table), `COMMENT ON TABLE ${table}`).toBe(true);
      for (const column of columns) {
        expect(columnComments.has(`${table}.${column}`), `COMMENT ON COLUMN ${table}.${column}`).toBe(true);
      }
    }
    for (const [table, columns] of added) {
      for (const column of columns) {
        expect(columnComments.has(`${table}.${column}`), `COMMENT ON COLUMN ${table}.${column}`).toBe(true);
      }
    }
  });
});

describe("the table types generated after 0002", () => {
  it("contain storefront_assets, storefront_pages and every column 0002 adds [OBE-008 AC3]", async () => {
    // Compile time: `pnpm typecheck` fails when a table or column is missing or has another type.
    expectTypeOf<TenantDatabase>().toHaveProperty("storefront_assets");
    expectTypeOf<TenantDatabase>().toHaveProperty("storefront_pages");
    expectTypeOf<Selectable<TenantDatabase["storefront_assets"]>>()
      .toHaveProperty("size_bytes")
      .toEqualTypeOf<number>();
    expectTypeOf<Selectable<TenantDatabase["storefront_pages"]>>()
      .toHaveProperty("published_at")
      .toEqualTypeOf<Date | null>();
    expectTypeOf<Selectable<TenantDatabase["checkouts"]>>()
      .toHaveProperty("pricing_mode")
      .toEqualTypeOf<string>();
    expectTypeOf<Selectable<TenantDatabase["bookings"]>>()
      .toHaveProperty("reconcile_until")
      .toEqualTypeOf<Date | null>();
    expectTypeOf<Selectable<TenantDatabase["bookings"]>>()
      .toHaveProperty("reconcile_attempts")
      .toEqualTypeOf<number>();
    expectTypeOf<Selectable<TenantDatabase["storefront_settings"]>>()
      .toHaveProperty("time_zone")
      .toEqualTypeOf<string>();
    expectTypeOf<Selectable<TenantDatabase["storefront_settings"]>>()
      .toHaveProperty("logo_asset_id")
      .toEqualTypeOf<string | null>();

    // Run time: the committed file that `pnpm db:codegen` writes (CI fails on any diff after regenerating it).
    const generated = await readFile(GENERATED_TYPES, "utf8");
    const tables = Object.fromEntries(
      [...interfaceBody(generated, "TenantTables").matchAll(/^ {2}([a-z_]+): ([A-Za-z]+);$/gm)].map(
        (match) => [match[1] ?? "", match[2] ?? ""],
      ),
    );
    expect(tables).toMatchObject({
      storefront_assets: "StorefrontAssets",
      storefront_pages: "StorefrontPages",
    });
    for (const statement of statements) {
      const createTable = /^CREATE TABLE ([a-z_]+) \(/.exec(statement);
      if (createTable !== null) {
        const table = createTable[1] ?? "";
        expect(interfaceMembers(generated, tables[table] ?? "").sort()).toEqual(
          createdColumns(statement).sort(),
        );
      }
    }
    for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
      expect(interfaceMembers(generated, tables[table] ?? "")).toEqual(expect.arrayContaining([...columns]));
    }
  });
});
