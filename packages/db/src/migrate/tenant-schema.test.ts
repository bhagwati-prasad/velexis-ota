// The `beforeCommit` connection of migrateTenantSchema without a database (OADR-0007 item 2): the Kysely that the
// callback gets runs each statement on the runner's own connection, with the extended query protocol, and refuses
// transaction control before anything is sent. The transaction itself is tested in
// test/integration/tenants.int.test.ts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import type pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { migrateTenantSchema } from "./index.js";
import { TRANSACTION_CONTROL_STATEMENT, transactionKysely } from "./tenant-schema.js";

/** Port 1 refuses every connection: any attempt to connect would reject. */
const NO_DATABASE = "postgres://nobody@127.0.0.1:1/none";

interface Items {
  items: { id: string; label: string };
}

/** A connection that records every query config it gets and answers with no rows. */
function recordingClient(): { client: Pick<pg.ClientBase, "query">; sent: unknown[] } {
  const sent: unknown[] = [];
  const query = vi.fn((config: unknown) => {
    sent.push(config);
    return Promise.resolve({ command: "SELECT", rowCount: 0, rows: [], fields: [], oid: 0 });
  });
  return { client: { query } as unknown as Pick<pg.ClientBase, "query">, sent };
}

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("TRANSACTION_CONTROL_STATEMENT", () => {
  it.each([
    "BEGIN",
    "begin",
    "  begin isolation level serializable",
    "START TRANSACTION",
    "start   transaction read only",
    "COMMIT",
    "commit and chain",
    "COMMIT PREPARED 'tx1'",
    "END",
    "ABORT",
    "ROLLBACK",
    "rollback;",
    "ROLLBACK WORK",
    "rollback transaction and chain",
    "ROLLBACK PREPARED 'tx1'",
    "PREPARE TRANSACTION 'tx1'",
    "-- a comment first\nCOMMIT",
    "/* a block comment */ ROLLBACK",
  ])("matches %j", (statement) => {
    expect(TRANSACTION_CONTROL_STATEMENT.test(statement)).toBe(true);
  });

  it.each([
    "SAVEPOINT seed",
    "RELEASE SAVEPOINT seed",
    "ROLLBACK TO SAVEPOINT seed",
    "rollback to seed",
    "ROLLBACK WORK TO SAVEPOINT seed",
    "rollback transaction to seed",
    'select "begin" from items',
    "INSERT INTO items (id) VALUES ($1)",
    "UPDATE endpoints SET commit_sha = $1",
    "beginning",
    "endpoint",
    "-- COMMIT in a comment only\nSELECT 1",
  ])("does not match %j", (statement) => {
    expect(TRANSACTION_CONTROL_STATEMENT.test(statement)).toBe(false);
  });
});

describe("transactionKysely", () => {
  it("sends every statement to the given connection with the extended protocol and its parameters", async () => {
    const { client, sent } = recordingClient();
    const db = transactionKysely<Items>(client);

    await db.selectFrom("items").select("label").where("id", "=", "itm_1").execute();
    await sql`SAVEPOINT seed`.execute(db);

    expect(sent).toEqual([
      {
        text: 'select "label" from "items" where "id" = $1',
        values: ["itm_1"],
        queryMode: "extended",
      },
      { text: "SAVEPOINT seed", values: [], queryMode: "extended" },
    ]);
  });

  it("refuses to begin, commit or roll back the runner's transaction, and sends nothing", async () => {
    const { client, sent } = recordingClient();
    const db = transactionKysely<Items>(client);

    await expect(db.transaction().execute(() => Promise.resolve())).rejects.toThrow(TypeError);
    await expect(db.startTransaction().execute()).rejects.toThrow(TypeError);
    await expect(sql`COMMIT`.execute(db)).rejects.toThrow(
      /runs inside the migration runner's transaction: BEGIN, COMMIT, ROLLBACK/,
    );
    await expect(sql`rollback`.execute(db)).rejects.toThrow(TypeError);

    expect(sent).toEqual([]);
  });

  it("leaves the connection open on destroy()", async () => {
    const { client, sent } = recordingClient();
    const end = vi.fn();
    Object.assign(client, { end });
    const db = transactionKysely<Items>(client);

    await db.selectFrom("items").selectAll().execute();
    await db.destroy();

    expect(sent).toHaveLength(1);
    expect(end).not.toHaveBeenCalled();
  });
});

describe("migrateTenantSchema beforeCommit", () => {
  it("is not called for a folder that does not exist, and nothing connects", async () => {
    const root = await mkdtemp(join(tmpdir(), "velexis-before-commit-"));
    roots.push(root);
    const beforeCommit = vi.fn(() => Promise.resolve());

    const result = await migrateTenantSchema({
      schema: "tenant_nowhere",
      dir: join(root, "missing"),
      url: NO_DATABASE,
      create: true,
      beforeCommit,
    });

    expect(result).toMatchObject({ dirExists: false, created: false, applied: [] });
    expect(beforeCommit).not.toHaveBeenCalled();
  });
});
