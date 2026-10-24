// Migration 0002 against its documents (PBE-002; platform/docs/data-model-migration-0002.md "How to use it",
// conventions §9, ADR-0021). The exact SQL of `0002_add_mvp_platform_deltas.sql` is printed in three documents;
// the migration file is the concatenation of their ```sql blocks, in order and byte for byte, with no other text.
// The runner stores the file's SHA-256 in the ledger, so the file must never be reformatted, and the documents
// and the file must never drift apart: this test fails on any difference, one character included. No database:
// the files themselves, as the runner reads them; test/integration/migrations/migrate-0002.int.test.ts applies it.
// The last block checks that the Kysely table types generated from the migrated schema (`pnpm db:codegen`) carry
// the new tables and columns, at compile time (`pnpm typecheck`) and in the committed file.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PlatformDatabase, Selectable } from "@velexis/db";
import { readMigrationFiles } from "@velexis/db/migrate";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";

const REPO = resolve(__dirname, "..", "..", "..", "..");
const MIGRATIONS_DIR = join(REPO, "platform", "backend", "migrations", "platform");
const MIGRATION_FILE = "0002_add_mvp_platform_deltas.sql";
/** The numbered platform files after 0002, deltas found during implementation (migration-0003.contract.test.ts, …). */
const LATER_FILES = ["0003_add_billing_customer_attempts.sql"] as const;
/** The three documents, in the order their SQL blocks are concatenated. */
const DOCUMENTS = [
  "platform/docs/data-model-migration-0002.md",
  "platform/docs/data-model-migration-0002-part2.md",
  "platform/docs/data-model-migration-0002-part3.md",
] as const;
const PHASE_HEADER = "-- velexis:phase expand";
const GENERATED_TYPES = join(REPO, "packages", "db", "src", "generated", "platform.ts");

/** The content of every ```sql block of a Markdown document: the lines between the fences, each with its newline. */
function sqlBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```sql\n([\s\S]*?)^```[ \t]*$/gm)].map((match) => match[1] ?? "");
}

/** The expected migration: the SQL blocks of the documents, concatenated in order with nothing between them. */
function expectedMigration(documents: readonly string[]): string {
  return documents.flatMap(sqlBlocks).join("");
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

let documents: string[] = [];
let fileBytes: Buffer = Buffer.alloc(0);
let fileText = "";

beforeAll(async () => {
  documents = await Promise.all(DOCUMENTS.map((document) => readFile(join(REPO, document), "utf8")));
  fileBytes = await readFile(join(MIGRATIONS_DIR, MIGRATION_FILE));
  fileText = fileBytes.toString("utf8");
});

describe("migration 0002 and its three documents", () => {
  it("prints the SQL in exactly one ```sql block per document [PBE-002 AC1]", () => {
    expect(documents.map((document) => sqlBlocks(document).length)).toEqual([1, 1, 1]);
    // Part 1 opens the file with its header; parts 2 and 3 continue it with a section banner.
    const [part1, part2, part3] = documents.map((document) => sqlBlocks(document)[0] ?? "");
    expect(part1?.startsWith(`${PHASE_HEADER}\n`)).toBe(true);
    expect(part2?.startsWith("-- ====")).toBe(true);
    expect(part3?.startsWith("-- ====")).toBe(true);
  });

  it("is the concatenation of the three SQL blocks, in order and byte for byte [PBE-002 AC1]", () => {
    const expected = expectedMigration(documents);
    const difference = firstDifference(fileText, expected);
    expect(
      difference,
      difference === undefined
        ? undefined
        : `${MIGRATION_FILE} differs from the SQL blocks of the documents at line ${difference.line}, ` +
            `column ${difference.column}. Never edit the file by hand: copy the blocks again (never reformat).`,
    ).toBeUndefined();
    // The same bytes, not only the same characters: UTF-8 without a byte order mark.
    expect(fileBytes.equals(Buffer.from(expected, "utf8"))).toBe(true);
    expect(sha256(fileBytes)).toBe(sha256(Buffer.from(expected, "utf8")));
  });

  it("starts with -- velexis:phase expand and ends with exactly one newline [PBE-002 AC1]", () => {
    const lines = fileText.split("\n");
    expect(lines[0]).toBe(PHASE_HEADER);
    expect(lines[1]).toMatch(/^-- MVP platform deltas: /);
    expect(fileText.endsWith(";\n")).toBe(true);
    expect(fileText.endsWith("\n\n")).toBe(false);
    expect(fileText.includes("\r")).toBe(false);
    expect(fileBytes[0]).not.toBe(0xef); // no UTF-8 byte order mark
  });

  it("fails when one character of the migration changes [PBE-002 AC1]", () => {
    const expected = expectedMigration(documents);
    expect(firstDifference(fileText, expected)).toBeUndefined();
    // One character replaced at the start, in the middle and at the end, one added, one removed: each is found
    // at the offset where it happened. The middle is moved to a character that differs from the next one, so the
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

  it("is read by the runner as the second platform file: expand, one transaction, with its SHA-256 [PBE-002 AC2]", async () => {
    const files = await readMigrationFiles(MIGRATIONS_DIR, "platform");
    expect(files.numbered.map((file) => file.file)).toEqual([
      "0001_baseline.sql",
      MIGRATION_FILE,
      ...LATER_FILES,
    ]);
    const migration = files.numbered[1];
    expect(migration).toMatchObject({
      kind: "numbered",
      id: "0002_add_mvp_platform_deltas",
      phase: "expand",
      // No `-- velexis:no-transaction` header: the runner applies the whole file and its ledger row in one
      // transaction (SET LOCAL lock_timeout = '5s'), so a failing statement leaves nothing of it behind.
      noTransaction: false,
      checksum: sha256(fileBytes),
      description: expect.stringMatching(/^MVP platform deltas: /),
    });
  });
});

describe("the table types generated after 0002", () => {
  it("contain platform.amadeus_accounts, platform.email_outbox, platform.settlements and accounts.terms_version [PBE-002 AC3]", async () => {
    // Compile time: `pnpm typecheck` fails when a table or column is missing or has another type.
    expectTypeOf<PlatformDatabase>().toHaveProperty("platform.amadeus_accounts");
    expectTypeOf<PlatformDatabase>().toHaveProperty("platform.email_outbox");
    expectTypeOf<PlatformDatabase>().toHaveProperty("platform.settlements");
    expectTypeOf<Selectable<PlatformDatabase["platform.accounts"]>>()
      .toHaveProperty("terms_version")
      .toEqualTypeOf<string | null>();
    // Money is a decimal string, never a number (conventions §1).
    expectTypeOf<Selectable<PlatformDatabase["platform.settlements"]>>()
      .toHaveProperty("net_amount")
      .toEqualTypeOf<string>();

    // Run time: the committed file that `pnpm db:codegen` writes (CI fails on any diff after regenerating it).
    const generated = await readFile(GENERATED_TYPES, "utf8");
    for (const [table, row] of [
      ["amadeus_accounts", "PlatformAmadeusAccounts"],
      ["email_outbox", "PlatformEmailOutbox"],
      ["settlements", "PlatformSettlements"],
    ] as const) {
      expect(generated).toContain(`\n  "platform.${table}": ${row};\n`);
      expect(generated).toContain(`\nexport interface ${row} {\n`);
    }
    const accounts = /^export interface PlatformAccounts \{\n([\s\S]*?)^\}$/m.exec(generated)?.[1] ?? "";
    expect(accounts).toMatch(/^ {2}terms_version: string \| null;$/m);
  });
});
