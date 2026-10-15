import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LocalFileKeyProvider,
  REWRAP_DEFAULT_BATCH_SIZE,
  aadFor,
  decryptValue,
  encryptValue,
  envelopeKekId,
  rewrapBatch,
  type KeyProvider,
  type RewrapBatchOptions,
  type RewrapChange,
  type RewrapPage,
  type RewrapRow,
} from "./index.js";

const created: string[] = [];
afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A key folder with `master-v<N>.key` files of the given contents (mode 0600, as `pnpm dev:keys` writes them). */
async function keyDir(files: Record<number, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "velexis-crypto-rewrap-"));
  created.push(dir);
  await chmod(dir, 0o700);
  for (const [version, content] of Object.entries(files)) {
    const path = join(dir, `master-v${version}.key`);
    await writeFile(path, content);
    await chmod(path, 0o600);
  }
  return dir;
}

const kekFile = () => `${randomBytes(32).toString("base64")}\n`;

const SCHEMA = "platform";
const TABLE = "credential_submissions";
const SECRET = "secret_ciphertext";
const WEBHOOK = "webhook_secret_ciphertext";
const placeOf = (row: RewrapRow, column: string) => aadFor(SCHEMA, TABLE, column, row.id);

interface StoredRow {
  kekId: string;
  ciphertexts: Record<string, Buffer | null>;
}

/**
 * An in-memory row source with the semantics the SQL of a `secrets:rewrap` command has: keyset pages of rows whose
 * `encryption_key_id` is not the current KEK, and an `UPDATE … WHERE` every old value is still there.
 */
class MemoryTable {
  readonly rows = new Map<string, StoredRow>();
  readonly pages: RewrapPage[] = [];
  readonly changes: RewrapChange[] = [];

  readonly fetch = (page: RewrapPage): Promise<RewrapRow[]> => {
    this.pages.push(page);
    const ids = [...this.rows.keys()]
      .filter((id) => this.rows.get(id)?.kekId !== page.currentKekId)
      .filter((id) => page.afterId === null || id > page.afterId)
      .sort()
      .slice(0, page.limit);
    return Promise.resolve(ids.map((id) => this.snapshot(id)));
  };

  readonly update = (change: RewrapChange): Promise<boolean> => {
    this.changes.push(change);
    const row = this.rows.get(change.id);
    const same = (a: Uint8Array | null | undefined, b: Uint8Array | null | undefined) =>
      a === null || a === undefined || b === null || b === undefined ? a === b : Buffer.from(a).equals(b);
    const unchanged =
      row !== undefined &&
      row.kekId === change.previous.kekId &&
      Object.entries(change.previous.ciphertexts).every(([column, value]) =>
        same(row.ciphertexts[column], value),
      );
    if (!unchanged) {
      return Promise.resolve(false);
    }
    for (const [column, value] of Object.entries(change.ciphertexts)) {
      row.ciphertexts[column] = Buffer.from(value);
    }
    row.kekId = change.kekId;
    return Promise.resolve(true);
  };

  /** A copy, as a database driver returns it: the helper never holds the table's own Buffers. */
  snapshot(id: string): RewrapRow {
    const row = this.rows.get(id);
    if (row === undefined) {
      throw new Error(`no row ${id}`);
    }
    const ciphertexts = Object.fromEntries(
      Object.entries(row.ciphertexts).map(([column, value]) => [
        column,
        value === null ? null : Buffer.from(value),
      ]),
    );
    return { id, kekId: row.kekId, ciphertexts };
  }

  /** The whole table as bytes, to prove that a run changed nothing. */
  dump(): string {
    return JSON.stringify(
      [...this.rows].map(([id, row]) => [
        id,
        row.kekId,
        Object.entries(row.ciphertexts).map(([column, value]) => [column, value?.toString("base64") ?? null]),
      ]),
    );
  }
}

/** Encrypts the plaintexts of one row under `keys` and stores it, with `encryption_key_id` = the KEK used. */
async function insert(
  table: MemoryTable,
  id: string,
  keys: KeyProvider,
  values: { secret: string; webhook?: string },
): Promise<void> {
  const secret = await encryptValue(values.secret, { aad: aadFor(SCHEMA, TABLE, SECRET, id), keys });
  const webhook =
    values.webhook === undefined
      ? null
      : await encryptValue(values.webhook, { aad: aadFor(SCHEMA, TABLE, WEBHOOK, id), keys });
  table.rows.set(id, {
    kekId: secret.kekId,
    ciphertexts: { [SECRET]: secret.ciphertext, [WEBHOOK]: webhook?.ciphertext ?? null },
  });
}

/** The plaintexts of every row, decrypted with `keys`. */
async function plaintexts(
  table: MemoryTable,
  keys: KeyProvider,
): Promise<Record<string, Array<string | null>>> {
  const result: Record<string, Array<string | null>> = {};
  for (const [id, row] of table.rows) {
    const values: Array<string | null> = [];
    for (const column of [SECRET, WEBHOOK]) {
      const ciphertext = row.ciphertexts[column];
      values.push(
        ciphertext === null || ciphertext === undefined
          ? null
          : (await decryptValue(ciphertext, { aad: aadFor(SCHEMA, TABLE, column, id), keys })).toString(
              "utf8",
            ),
      );
    }
    result[id] = values;
  }
  return result;
}

const rowId = (n: number) => `crs_01JAAAAAAAAAAAAAAAAAAAA${String(n).padStart(3, "0")}`;

interface Logged {
  fields: Readonly<Record<string, unknown>>;
  message: string;
}

function options(
  table: MemoryTable,
  keys: KeyProvider,
  extra: Partial<RewrapBatchOptions> = {},
): RewrapBatchOptions & { logged: Logged[] } {
  const logged: Logged[] = [];
  return {
    fetch: table.fetch,
    update: table.update,
    aadFor: placeOf,
    keys,
    logger: { info: (fields, message) => logged.push({ fields, message }) },
    logged,
    ...extra,
  };
}

let v1: LocalFileKeyProvider;
let v2: LocalFileKeyProvider;
let v3: LocalFileKeyProvider;
let v3Only: LocalFileKeyProvider;
beforeAll(async () => {
  const files = { 1: kekFile(), 2: kekFile(), 3: kekFile() };
  const dir = await keyDir(files);
  v1 = await LocalFileKeyProvider.fromDir(dir, "local:v1");
  v2 = await LocalFileKeyProvider.fromDir(dir, "local:v2");
  // After the rotation: MASTER_KEY_CURRENT=local:v3, every older key file still in the folder.
  v3 = await LocalFileKeyProvider.fromDir(dir, "local:v3");
  // After the old key files are removed: the new KEK alone.
  v3Only = await LocalFileKeyProvider.fromDir(await keyDir({ 3: files[3] }), "local:v3");
});

/** 13 rows under local:v1, local:v2 and local:v3, some with one value and some with two. */
async function mixedTable(): Promise<MemoryTable> {
  const table = new MemoryTable();
  const providers = [v1, v2, v3];
  for (let n = 1; n <= 13; n += 1) {
    const keys = providers[n % 3] ?? v1;
    await insert(table, rowId(n), keys, {
      secret: `client secret ${n}`,
      ...(n % 2 === 0 ? { webhook: `whsec ${n} ✓` } : {}),
    });
  }
  return table;
}

describe("rewrapBatch", () => {
  it("moves rows under mixed KEK ids to the current KEK, page by page, so that the new KEK alone decrypts them [X-040 AC1]", async () => {
    const table = await mixedTable();
    const before = await plaintexts(table, v3);
    const notCurrent = [...table.rows.values()].filter((row) => row.kekId !== "local:v3").length;
    expect(notCurrent).toBe(9);
    const run = options(table, v3, { batchSize: 4 });

    const result = await rewrapBatch(run);

    expect(result).toEqual({ rewrapped: 9, skipped: 0, failed: 0, remainingByKekId: {} });
    expect(result.remainingByKekId).not.toHaveProperty("local:v1");
    expect(result.remainingByKekId).not.toHaveProperty("local:v2");
    for (const row of table.rows.values()) {
      expect(row.kekId).toBe("local:v3");
      for (const value of Object.values(row.ciphertexts)) {
        if (value !== null) {
          expect(envelopeKekId(value)).toBe("local:v3");
        }
      }
    }
    // Every value decrypts with master-v3.key alone, to the same plaintext as before.
    expect(await plaintexts(table, v3Only)).toEqual(before);
    // Keyset pagination: pages of at most 4 rows after the last id of the previous page until a page is empty,
    // then one counting pass.
    expect(table.pages.map((page) => [page.afterId, page.limit, page.currentKekId])).toEqual([
      [null, 4, "local:v3"],
      [rowId(6), 4, "local:v3"],
      [rowId(12), 4, "local:v3"],
      [rowId(13), 4, "local:v3"],
      [null, 4, "local:v3"],
    ]);
  });

  it("keeps paging after a short page, so the rows after it are moved and counted [X-040 AC1]", async () => {
    const table = await mixedTable();
    // A purged credential submission: no ciphertext left, encryption_key_id still local:v1.
    table.rows.set(rowId(3), { kekId: "local:v1", ciphertexts: { [SECRET]: null, [WEBHOOK]: null } });
    const before = await plaintexts(table, v3);
    // A fetch that leaves out rows without ciphertext after its LIMIT, so its first page is short (3 of 4 rows).
    const shortPages = async (page: RewrapPage): Promise<RewrapRow[]> =>
      (await table.fetch(page)).filter((row) => Object.values(row.ciphertexts).some((v) => v !== null));

    const result = await rewrapBatch(options(table, v3, { batchSize: 4, fetch: shortPages }));

    expect(result).toEqual({ rewrapped: 8, skipped: 0, failed: 0, remainingByKekId: {} });
    for (const [id, row] of table.rows) {
      expect(row.kekId).toBe(id === rowId(3) ? "local:v1" : "local:v3");
    }
    expect(await plaintexts(table, v3Only)).toEqual(before);
    expect(table.pages.map((page) => page.afterId)).toEqual([null, rowId(6), rowId(12), rowId(13), null]);
  });

  it("changes nothing on a second run [X-040 AC1]", async () => {
    const table = await mixedTable();
    await rewrapBatch(options(table, v3, { batchSize: 4 }));
    const dump = table.dump();
    table.changes.length = 0;

    const second = await rewrapBatch(options(table, v3, { batchSize: 4 }));

    expect(second).toEqual({ rewrapped: 0, skipped: 0, failed: 0, remainingByKekId: {} });
    expect(table.changes).toEqual([]);
    expect(table.dump()).toBe(dump);
  });

  it("skips and counts a row changed concurrently under the current KEK, and keeps the other writer's value [X-040 AC2]", async () => {
    const table = await mixedTable();
    const target = rowId(4); // under local:v2, with two values
    expect(table.rows.get(target)?.kekId).toBe("local:v2");
    let raced = false;
    const update = async (change: RewrapChange) => {
      if (change.id === target && !raced) {
        raced = true;
        // The portal replaced the credential between the helper's read and its write.
        await insert(table, target, v3, { secret: "replaced secret", webhook: "replaced whsec" });
      }
      return table.update(change);
    };
    const run = options(table, v3, { batchSize: 5, update });

    const result = await rewrapBatch(run);

    expect(raced).toBe(true);
    expect(result).toEqual({ rewrapped: 8, skipped: 1, failed: 0, remainingByKekId: {} });
    expect((await plaintexts(table, v3Only))[target]).toEqual(["replaced secret", "replaced whsec"]);
  });

  it("skips a row changed concurrently under an old KEK and reports it as remaining until a new run moves it [X-040 AC2]", async () => {
    const table = await mixedTable();
    const target = rowId(7); // under local:v2, one value
    const update = async (change: RewrapChange) => {
      if (change.id === target) {
        // A process that still runs with MASTER_KEY_CURRENT=local:v1 writes the row meanwhile.
        await insert(table, target, v1, { secret: "written by an old process" });
      }
      return table.update(change);
    };

    const first = await rewrapBatch(options(table, v3, { update }));

    expect(first).toEqual({ rewrapped: 8, skipped: 1, failed: 0, remainingByKekId: { "local:v1": 1 } });
    expect(table.rows.get(target)?.kekId).toBe("local:v1");
    expect((await plaintexts(table, v3))[target]).toEqual(["written by an old process", null]);

    const second = await rewrapBatch(options(table, v3));

    expect(second).toEqual({ rewrapped: 1, skipped: 0, failed: 0, remainingByKekId: {} });
    expect((await plaintexts(table, v3Only))[target]).toEqual(["written by an old process", null]);
  });

  it("writes with an optimistic check on every old value and never sends a plaintext to update", async () => {
    const table = await mixedTable();
    const original = table.snapshot(rowId(6)); // under local:v1, with two values

    await rewrapBatch(options(table, v3));

    const change = table.changes.find((c) => c.id === rowId(6));
    expect(change).toBeDefined();
    expect(Object.keys(change ?? {}).sort()).toEqual(["ciphertexts", "id", "kekId", "previous"]);
    expect(change?.kekId).toBe("local:v3");
    expect(change?.previous).toEqual(original);
    expect(Object.keys(change?.ciphertexts ?? {}).sort()).toEqual([SECRET, WEBHOOK]);
    for (const value of Object.values(change?.ciphertexts ?? {})) {
      expect(value.includes(Buffer.from("client secret 6"))).toBe(false);
      expect(value.includes(Buffer.from("whsec 6"))).toBe(false);
    }
  });

  it("leaves a row whose value does not authenticate at its place unchanged and counts it as failed", async () => {
    const table = await mixedTable();
    const copied = table.rows.get(rowId(1));
    const victim = table.rows.get(rowId(4));
    if (copied === undefined || victim === undefined) {
      throw new Error("fixture rows missing");
    }
    // A ciphertext copied from another row fails its associated data check.
    victim.ciphertexts[SECRET] = copied.ciphertexts[SECRET] ?? null;
    const victimBefore = JSON.stringify(table.snapshot(rowId(4)));

    const result = await rewrapBatch(options(table, v3));

    expect(result).toEqual({ rewrapped: 8, skipped: 0, failed: 1, remainingByKekId: { "local:v2": 1 } });
    expect(JSON.stringify(table.snapshot(rowId(4)))).toBe(victimBefore);
    expect(table.changes.some((c) => c.id === rowId(4))).toBe(false);
  });

  it("logs counts only: no plaintext, ciphertext or row id", async () => {
    const table = await mixedTable();
    const run = options(table, v3, { batchSize: 4 });

    await rewrapBatch(run);

    expect(run.logged.map((entry) => entry.message)).toEqual([
      "secrets.rewrap.batch",
      "secrets.rewrap.batch",
      "secrets.rewrap.batch",
      "secrets.rewrap.done",
    ]);
    expect(run.logged.at(-1)?.fields).toEqual({ rewrapped: 9, skipped: 0, failed: 0, remainingByKekId: {} });
    for (const { fields } of run.logged.slice(0, -1)) {
      expect(Object.keys(fields).sort()).toEqual(["failed", "rewrapped", "rows", "skipped"]);
      expect(Object.values(fields).every((value) => Number.isInteger(value))).toBe(true);
    }
    const text = JSON.stringify(run.logged);
    expect(text).not.toMatch(/crs_|secret \d|whsec|[A-Za-z0-9+/]{40,}/);
  });

  it("fetches 500 rows per page by default and refuses a batch size out of range", async () => {
    const table = await mixedTable();

    await rewrapBatch({ fetch: table.fetch, update: table.update, aadFor: placeOf, keys: v3 });

    expect(table.pages[0]?.limit).toBe(REWRAP_DEFAULT_BATCH_SIZE);
    expect(REWRAP_DEFAULT_BATCH_SIZE).toBe(500);
    for (const batchSize of [0, -1, 1.5, 10_001, Number.NaN]) {
      await expect(rewrapBatch(options(table, v3, { batchSize }))).rejects.toBeInstanceOf(RangeError);
    }
  });

  it("stops instead of looping when fetch ignores the cursor or returns more rows than asked", async () => {
    const table = await mixedTable();
    const firstPage = await table.fetch({ currentKekId: "local:v3", afterId: null, limit: 2 });
    const ignoresCursor = () => Promise.resolve(firstPage);
    const noUpdate = () => Promise.resolve(false);

    await expect(
      rewrapBatch(options(table, v3, { batchSize: 2, fetch: ignoresCursor, update: noUpdate })),
    ).rejects.toThrow(/after `afterId`/);
    // A short page does not end the pass, so the same short page again is caught too.
    await expect(
      rewrapBatch(options(table, v3, { batchSize: 3, fetch: ignoresCursor, update: noUpdate })),
    ).rejects.toThrow(/after `afterId`/);
    await expect(
      rewrapBatch(options(table, v3, { batchSize: 1, fetch: ignoresCursor, update: noUpdate })),
    ).rejects.toThrow(/at most `limit` rows/);
  });

  it("refuses an update that does not resolve to a boolean, and lets operational errors through", async () => {
    const table = await mixedTable();
    const outage = new Error("database unreachable");

    await expect(
      rewrapBatch(options(table, v3, { update: () => Promise.resolve(1 as unknown as boolean) })),
    ).rejects.toThrow(TypeError);
    await expect(rewrapBatch(options(table, v3, { update: () => Promise.reject(outage) }))).rejects.toBe(
      outage,
    );
    await expect(rewrapBatch(options(table, v3, { fetch: () => Promise.reject(outage) }))).rejects.toBe(
      outage,
    );
  });

  it("imports only its own modules", async () => {
    const text = await readFile(join(__dirname, "rewrap-batch.ts"), "utf8");
    const specifiers = [...text.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)].map(
      (m) => m[1],
    );
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((specifier) => !specifier?.startsWith("./"))).toEqual([]);
  });
});
